import { getPool, getSystemState, recordSystemEvent } from './db.js';
import { inTransaction, logEvent } from './orders.js';
import { ensureInventorySchema, resolveSkuIds } from './inventory.js';
import { graphql, shopifyConfigured, authMode } from './shopify.js';

/**
 * Shopify ORDERS → Briyo OS orders (channel `website`).
 *
 * Not to be confused with lib/shopify-poll.js, which pulls *abandoned
 * checkouts* into Support's cart board. A completed Shopify order is a sales
 * order: it lands in Orders & Logistics with its line items, and nothing else.
 *
 * What a sync does, and does not do:
 *   - creates or updates the commercial order (customer, value, payment) and its
 *     line items, keyed on Shopify's stable GIDs, so re-running is a no-op;
 *   - resolves each line to a master SKU exactly as the Amazon import does (master
 *     code, then the `website` platform mapping) and leaves unknown codes unmapped;
 *   - NEVER creates a shipment, reserves or deducts stock, or writes a stock
 *     movement. Shopify's own fulfilment data is kept in source_payload for
 *     reference only: Briyo Logistics stays the source of truth for parcels.
 *
 * Identity: source_order_id is the order GID ("gid://shopify/Order/…"), not the
 * "#1001" name, which is shop-configurable and can collide with manually typed
 * website order numbers. The name is kept in source_payload.shopify.name.
 *
 * Re-sync safety mirrors the Amazon import (lib/amazon-import.js):
 *   - an empty Shopify value never wipes a recorded one;
 *   - payment method/status follow Shopify only while the team has not changed
 *     them since the last sync (a COD marked paid by the team stays paid);
 *   - an order whose stock has left, or is reserved for a parcel, is LOCKED:
 *     its lines are history and are not changed — a difference is recorded as a
 *     sync conflict instead;
 *   - a Shopify cancellation cancels a Briyo order only when it has no active
 *     shipment; otherwise it is a conflict for a person to resolve;
 *   - Briyo's order status, shipments, documents, notes and routing are never
 *     touched by a sync.
 */

export const CHANNEL = 'website';
export const SOURCE = 'shopify_sync';
const SHIPPED_STATUSES = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto'];
const CHECKPOINT_KEY = 'shopify_orders_checkpoint';
const PAGE_SIZE = 50;
const MAX_ORDERS_PER_RUN = 2500;
const MAX_LINES = 100;          // per order, per Shopify page; an order with more is held back whole
const MAX_REPORTED = 200;
// Shopify only returns orders from the last 60 days unless the app holds read_all_orders.
export const maxWindowDays = () => (process.env.SHOPIFY_READ_ALL_ORDERS === 'true' ? 365 : 60);

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/* ------------------------------------------------------------------ mapping */

/**
 * displayFinancialStatus → payment_status. Only what Shopify actually states:
 * AUTHORIZED is money held, not captured, so it is still pending; EXPIRED (an
 * authorization that lapsed) has no honest equivalent and stays unknown.
 */
const FINANCIAL = {
  PENDING: 'pending', AUTHORIZED: 'pending', PAID: 'paid', PARTIALLY_PAID: 'partially_paid',
  REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded', VOIDED: 'voided',
};
export const shopifyPaymentStatus = (s) => FINANCIAL[String(s || '').toUpperCase()] ?? null;

/**
 * paymentGatewayNames → payment_method.
 *   any gateway that is cash on delivery          → cod
 *   only recognised online/prepaid gateways       → prepaid
 *   anything else (manual, gift card, unknown, mixed with an unknown) → other
 *   no gateway at all                              → null (not known)
 * GoKwik runs both prepaid and COD checkouts, so "gokwik" alone is not enough to say prepaid.
 */
const COD_GATEWAY = /cash[\s_-]*on[\s_-]*delivery|\bcod\b/i;
const PREPAID_GATEWAYS = /^(shopify[\s_-]*payments|razorpay.*|payu.*|cashfree.*|phonepe.*|paytm.*|stripe|paypal.*|ccavenue.*|easebuzz.*|juspay.*|upi|bogus)$/i;
export function shopifyPaymentMethod(gateways) {
  const g = (Array.isArray(gateways) ? gateways : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!g.length) return null;
  if (g.some((x) => COD_GATEWAY.test(x))) return 'cod';
  if (g.every((x) => PREPAID_GATEWAYS.test(x))) return 'prepaid';
  return 'other';
}

const amount = (set) => {
  const v = set?.shopMoney?.amount;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const text = (v, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const gidTail = (gid) => String(gid || '').split('/').pop();

/** One Shopify order node → the order shape, or { error }. Pure. */
export function mapShopifyOrder(node) {
  const id = text(node?.id, 200);
  if (!id || !/^gid:\/\/shopify\/Order\/\d+$/.test(id)) return { error: 'Missing or malformed order id' };
  const problems = [];
  const created = node.createdAt ? new Date(node.createdAt) : null;
  if (!created || Number.isNaN(created.getTime())) problems.push('createdAt is missing or not a date');
  const value = amount(node.currentTotalPriceSet);
  if (Number.isNaN(value) || (value !== null && value < 0)) problems.push('currentTotalPrice is not a valid amount');
  const currency = String(node.currentTotalPriceSet?.shopMoney?.currencyCode || node.currencyCode || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) problems.push('currency is not valid');
  const lines = node.lineItems?.nodes || [];
  if (node.lineItems?.pageInfo?.hasNextPage) problems.push(`more than ${MAX_LINES} line items; held back so it is never half-imported`);

  const items = [];
  for (const li of lines) {
    const lid = text(li?.id, 200);
    if (!lid) { problems.push('a line item has no id'); continue; }
    const qty = Number.isInteger(li.currentQuantity) ? li.currentQuantity : Number.isInteger(li.quantity) ? li.quantity : NaN;
    const total = amount(li.originalTotalSet);
    const discount = amount(li.totalDiscountSet);
    const tax = (li.taxLines || []).reduce((s, t) => { const a = amount(t.priceSet); return Number.isNaN(a) || s === null ? NaN : s + (a || 0); }, 0);
    if (!Number.isInteger(qty) || qty < 0) problems.push(`line ${gidTail(lid)} quantity is not a whole number`);
    if ([total, discount, tax].some((x) => Number.isNaN(x))) problems.push(`line ${gidTail(lid)} has an invalid amount`);
    items.push({
      source_line_item_id: lid,
      // Shopify's own SKU only. A variant without one stays NULL — a title is never a SKU.
      sku: text(li.sku, 120),
      title: text([li.title || li.name, li.variantTitle].filter(Boolean).join(' — '), 500),
      quantity: qty,
      // Line total before discounts (Shopify prices are tax-inclusive or not per shop setting; tax is separate).
      item_price: total,
      item_tax: (li.taxLines || []).length ? Math.round(tax * 100) / 100 : null,
      price_excl_tax: null,
      // Negative, the same convention as the Amazon import.
      promotion_discount: discount ? -Math.abs(discount) : null,
      promotion_id: null,
      // Shopify charges shipping per order, not per line: kept on the order, never spread over lines.
      shipping_price: null,
      shipping_tax: null,
    });
  }
  if (problems.length) return { error: problems.join('; '), id, name: text(node.name, 40) };

  const first = node.customer?.firstName ?? ''; const last = node.customer?.lastName ?? '';
  const ship = node.shippingAddress || null;
  const shopify = {
    id, name: text(node.name, 40), legacy_id: gidTail(id),
    created_at: node.createdAt || null, updated_at: node.updatedAt || null, processed_at: node.processedAt || null,
    cancelled_at: node.cancelledAt || null, cancel_reason: text(node.cancelReason, 60), closed_at: node.closedAt || null,
    financial_status: text(node.displayFinancialStatus, 40), fulfillment_status: text(node.displayFulfillmentStatus, 40),
    gateways: (node.paymentGatewayNames || []).map((g) => text(g, 80)).filter(Boolean),
    tags: (node.tags || []).map((t) => text(t, 80)).filter(Boolean),
    note: text(node.note, 1000),
    // Shopify's latest total, kept even when Briyo keeps its own value on a locked order.
    current_total: value, total_price_original: amount(node.totalPriceSet), total_tax: amount(node.currentTotalTaxSet),
    total_discounts: amount(node.currentTotalDiscountsSet), total_shipping: amount(node.totalShippingPriceSet),
    shipping_lines: (node.shippingLines?.nodes || []).map((s) => ({ title: text(s.title, 120), code: text(s.code, 120), price: amount(s.originalPriceSet) })),
    // Shopify's record of its fulfilments — reference only, never turned into a Briyo shipment.
    fulfillments: (node.fulfillments || []).map((f) => ({
      status: text(f.status, 40), created_at: f.createdAt || null,
      tracking: (f.trackingInfo || []).map((t) => ({ company: text(t.company, 80), number: text(t.number, 80), url: text(t.url, 500) })),
    })),
    ship_to: ship ? {
      name: text(ship.name, 120), address_1: text(ship.address1), address_2: text(ship.address2), city: text(ship.city, 120),
      state: text(ship.province, 120), postal_code: text(ship.zip, 20), country: text(ship.countryCodeV2, 4), phone: text(ship.phone, 20),
    } : null,
  };
  const payment_method = shopifyPaymentMethod(node.paymentGatewayNames);
  const payment_status = shopifyPaymentStatus(node.displayFinancialStatus);
  // What this sync set, so the next one can tell a team edit from Shopify's last word.
  shopify.synced = { payment_method, payment_status };
  return {
    source_order_id: id,
    order_date: created.toISOString(),
    customer_name: text(`${first} ${last}`.trim() || ship?.name, 120),
    customer_email: text(node.customer?.email || node.email, 160),
    customer_phone: text(node.customer?.phone || node.phone || ship?.phone, 20),
    order_value: value,
    currency,
    payment_method,
    payment_status,
    cancelled: Boolean(node.cancelledAt),
    test: Boolean(node.test),
    shopify,
    items,
  };
}

/* ------------------------------------------------------------------ fetching */

const ORDER_FIELDS_GQL = (pii) => `
  id name createdAt updatedAt processedAt cancelledAt cancelReason closedAt test
  displayFinancialStatus displayFulfillmentStatus paymentGatewayNames currencyCode tags note
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  totalPriceSet { shopMoney { amount currencyCode } }
  currentTotalTaxSet { shopMoney { amount } }
  currentTotalDiscountsSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  shippingLines(first: 5) { nodes { title code originalPriceSet { shopMoney { amount } } } }
  fulfillments(first: 10) { status createdAt trackingInfo { company number url } }
  ${pii ? `email phone customer { firstName lastName email phone }
  shippingAddress { name phone address1 address2 city province zip countryCodeV2 }` : ''}
  lineItems(first: ${MAX_LINES}) {
    pageInfo { hasNextPage }
    nodes {
      id sku name title variantTitle quantity currentQuantity
      originalTotalSet { shopMoney { amount } }
      totalDiscountSet { shopMoney { amount } }
      taxLines { priceSet { shopMoney { amount } } }
    }
  }`;
const ordersQuery = (pii) => `
  query Orders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS_GQL(pii)} }
    }
  }`;
// Shopify gates customer name/email/phone/address behind "protected customer data"
// approval; without it these fields error. The sync then carries on without them.
const PII_DENIED = /protected customer data|access denied for (customer|email|phone|shippingAddress)|not approved to access/i;

/** Shopify search syntax for the run. Pure. */
export function searchQuery({ mode, from, to, since }) {
  if (mode === 'incremental') return `updated_at:>='${since}'`;
  return `created_at:>='${from}' AND created_at:<='${to}'`;
}

/**
 * One page of orders. `gql` is injectable for tests; the default is the shared
 * Admin GraphQL client (token server-side, never in a URL or a log).
 */
async function fetchPage({ gql, query, after, pii }) {
  try {
    const data = await gql(ordersQuery(pii), { first: PAGE_SIZE, after: after || null, query });
    return { conn: data?.orders, pii };
  } catch (err) {
    if (pii && PII_DENIED.test(String(err.message))) return fetchPage({ gql, query, after, pii: false });
    throw err;
  }
}

/* ------------------------------------------------------------------ compare */

const ORDER_FIELDS = ['order_date', 'currency', 'order_value', 'customer_name', 'customer_email', 'customer_phone', 'payment_method', 'payment_status'];
const ITEM_FIELDS = ['sku', 'title', 'quantity', 'item_price', 'item_tax', 'promotion_discount'];
const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : JSON.stringify(v ?? null));
const sameValue = (a, b) => {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) || /^\d{4}-\d{2}-\d{2}T/.test(String(b))) return new Date(a).getTime() === new Date(b).getTime();
  if (typeof a === 'number' || typeof b === 'number' || /^-?\d+(\.\d+)?$/.test(String(a))) return Number(a) === Number(b);
  return String(a) === String(b);
};
// The payload minus the bookkeeping that changes on every touch.
const payloadKey = (s) => stable({ ...(s || {}), updated_at: null });

/** What applying these orders would do, against what is stored now. Reads only. */
async function diff(client, orders) {
  const ids = orders.map((o) => o.source_order_id);
  const names = orders.map((o) => o.shopify.name).filter(Boolean);
  const { rows: existing } = ids.length ? await client.query(
    `SELECT id, source_order_id, order_status, ${ORDER_FIELDS.join(', ')}, source_payload FROM orders
     WHERE channel = $1 AND source_order_id = ANY($2)`, [CHANNEL, ids]) : { rows: [] };
  const byId = new Map(existing.map((r) => [r.source_order_id, r]));
  // A website order typed in by hand under the Shopify number ("#1001" or "1001"):
  // importing would ship it twice, so it is held back for a person to reconcile.
  const plain = names.flatMap((n) => [n, n.replace(/^#/, '')]);
  const { rows: manual } = plain.length ? await client.query(
    `SELECT id, source_order_id FROM orders WHERE channel = $1 AND source <> $2 AND source_order_id = ANY($3)`,
    [CHANNEL, SOURCE, plain]) : { rows: [] };
  const manualByNumber = new Map(manual.map((r) => [r.source_order_id.replace(/^#/, ''), r]));
  const { rows: items } = existing.length ? await client.query(
    `SELECT order_id, source_line_item_id, ${ITEM_FIELDS.join(', ')} FROM order_items WHERE order_id = ANY($1)`,
    [existing.map((r) => r.id)]) : { rows: [] };
  const itemsByKey = new Map(items.map((r) => [`${r.order_id}|${r.source_line_item_id}`, r]));
  // Locked: stock has left (dispatch movement, or a parcel past dispatch) or is
  // reserved for a parcel. Its lines must keep matching what Inventory recorded.
  // Active: any shipment that is not cancelled — a cancellation then needs a person.
  const eids = existing.map((r) => Number(r.id));
  const { rows: ops } = eids.length ? await client.query(
    `SELECT o.id,
       (EXISTS (SELECT 1 FROM inventory_movements m WHERE m.order_id = o.id AND m.movement_type = 'shipment_dispatched')
        OR EXISTS (SELECT 1 FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_status = ANY($2))
        OR EXISTS (SELECT 1 FROM shipment_orders so JOIN order_shipments s ON s.id = so.shipment_id
                   WHERE so.order_id = o.id AND so.detached_at IS NULL AND s.shipment_status = ANY($2))
        OR EXISTS (SELECT 1 FROM inventory_reservations r JOIN order_shipments s ON s.id = r.shipment_id
                   WHERE r.status = 'active' AND (s.order_id = o.id OR EXISTS (
                     SELECT 1 FROM shipment_orders so WHERE so.shipment_id = s.id AND so.order_id = o.id AND so.detached_at IS NULL)))) AS locked,
       (EXISTS (SELECT 1 FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_status <> 'cancelled')
        OR EXISTS (SELECT 1 FROM shipment_orders so JOIN order_shipments s ON s.id = so.shipment_id
                   WHERE so.order_id = o.id AND so.detached_at IS NULL AND s.shipment_status <> 'cancelled')) AS active
     FROM orders o WHERE o.id = ANY($1)`, [eids, SHIPPED_STATUSES]) : { rows: [] };
  const opsById = new Map(ops.map((r) => [Number(r.id), r]));

  const out = { create: [], update: [], unchanged: [], conflicts: [], duplicates: [], newItems: 0, changedItems: 0 };
  for (const o of orders) {
    const cur = byId.get(o.source_order_id);
    if (!cur) {
      const dup = o.shopify.name && manualByNumber.get(o.shopify.name.replace(/^#/, ''));
      if (dup) { out.duplicates.push({ name: o.shopify.name, shopifyId: o.source_order_id, existingId: Number(dup.id), existingNumber: dup.source_order_id }); continue; }
      out.create.push(o); out.newItems += o.items.length; continue;
    }
    const id = Number(cur.id);
    const op = opsById.get(id) || {};
    const prevSynced = cur.source_payload?.shopify?.synced || {};
    const changes = {};
    const conflicts = [];
    for (const f of ORDER_FIELDS) {
      if (o[f] === null && cur[f] !== null) continue;                       // never wipe
      if ((f === 'payment_status' || f === 'payment_method') && cur[f] !== null && !sameValue(cur[f], prevSynced[f])) continue; // the team's value stands
      if (!sameValue(cur[f], o[f])) changes[f] = { from: cur[f] instanceof Date ? cur[f].toISOString() : cur[f], to: o[f] };
    }
    // Once stock is reserved or has left, the order's value is what Logistics and the stock
    // ledger were working to: a later Shopify total is a conflict, not an overwrite.
    if (op.locked && changes.order_value) {
      const fmt = (v) => (v === null || v === undefined ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
      conflicts.push({ kind: 'value_locked', from: changes.order_value.from, to: changes.order_value.to,
        detail: `Shopify total changed from ${fmt(changes.order_value.from)} to ${fmt(changes.order_value.to)} after stock was reserved or dispatched. Briyo keeps ${fmt(changes.order_value.from)}.` });
      delete changes.order_value;
    }
    if (o.cancelled && cur.order_status !== 'cancelled') {
      if (op.active || op.locked) conflicts.push({ kind: 'cancelled_with_shipment', detail: 'Cancelled in Shopify, but this order has a shipment in Briyo. Not cancelled automatically.' });
      else changes.order_status = { from: cur.order_status, to: 'cancelled' };
    }
    let added = 0; let changedItems = 0;
    for (const it of o.items) {
      const ex = itemsByKey.get(`${id}|${it.source_line_item_id}`);
      if (!ex) added += 1;
      else if (ITEM_FIELDS.some((f) => !sameValue(ex[f], it[f]))) changedItems += 1;
    }
    if (op.locked && (added || changedItems)) {
      conflicts.push({ kind: 'lines_locked', detail: `${added + changedItems} line${added + changedItems > 1 ? 's' : ''} changed in Shopify after stock was reserved or dispatched. Not applied.`, lines: added + changedItems });
      added = 0; changedItems = 0;
    }
    const payloadChanged = payloadKey(cur.source_payload?.shopify) !== payloadKey(o.shopify);
    const entry = { o, id, changes, payloadChanged, added, changedItems, locked: Boolean(op.locked), conflicts };
    out.newItems += added; out.changedItems += changedItems;
    if (conflicts.length) out.conflicts.push({ id, name: o.shopify.name, shopifyId: o.source_order_id, conflicts });
    if (Object.keys(changes).length || payloadChanged || added || changedItems) out.update.push(entry);
    else out.unchanged.push(entry);
  }
  return out;
}

async function unmappedLines(db, orders) {
  const items = orders.flatMap((o) => o.items);
  const known = await resolveSkuIds(db, CHANNEL, items.map((it) => it.sku));
  const out = new Map();
  for (const it of items) {
    const code = String(it.sku || '').trim();
    if (code && known.has(code.toLowerCase())) continue;
    const k = code.toLowerCase();
    const u = out.get(k) || { code: code || null, title: it.title, lines: 0, units: 0 };
    u.lines += 1; u.units += it.quantity;
    out.set(k, u);
  }
  return [...out.values()].sort((a, b) => b.lines - a.lines);
}

/* ------------------------------------------------------------------ apply */

/** Writes one page of planned orders, in the caller's transaction. Returns counts. */
async function applyPage(client, orders, { actor, runId }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('orders:shopify-sync'))`);
  const d = await diff(client, orders);
  const ids = new Map([...d.update, ...d.unchanged].map((u) => [u.o.source_order_id, u.id]));

  if (d.create.length) {
    const c = d.create;
    const { rows } = await client.query(
      `INSERT INTO orders (channel, dispatch_type, fulfillment_type, source, order_status, source_order_id, order_date, currency, order_value,
                           customer_name, customer_email, customer_phone, payment_method, payment_status, source_payload, created_by, updated_by)
       SELECT $1, 'easy_ship', 'merchant', $2, x.status, x.sid, x.dt, x.cur, x.val, x.cn, x.ce, x.cp, x.pm, x.ps, x.pl, $3, $3 FROM unnest(
         $4::text[], $5::timestamptz[], $6::text[], $7::numeric[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::jsonb[], $14::text[])
         AS x(sid, dt, cur, val, cn, ce, cp, pm, ps, pl, status)
       ON CONFLICT (channel, source_order_id) DO NOTHING
       RETURNING id, source_order_id`,
      [CHANNEL, SOURCE, actor, c.map((o) => o.source_order_id), c.map((o) => o.order_date), c.map((o) => o.currency),
        c.map((o) => o.order_value), c.map((o) => o.customer_name), c.map((o) => o.customer_email), c.map((o) => o.customer_phone),
        c.map((o) => o.payment_method), c.map((o) => o.payment_status), c.map((o) => JSON.stringify({ shopify: o.shopify })),
        // A new order is "new"; cancelled in Shopify before Briyo ever saw it → cancelled. Never "completed".
        c.map((o) => (o.cancelled ? 'cancelled' : 'new'))]);
    if (rows.length !== c.length) throw bad('Another sync added some of these orders at the same moment. Run the sync again.', 409);
    for (const r of rows) ids.set(r.source_order_id, Number(r.id));
    const byId = new Map(c.map((o) => [o.source_order_id, o]));
    await client.query(
      `INSERT INTO order_events (order_id, event_type, actor, metadata) SELECT unnest($1::bigint[]), 'order_created', $3, unnest($2::jsonb[])`,
      [rows.map((r) => Number(r.id)), rows.map((r) => {
        const o = byId.get(r.source_order_id);
        return JSON.stringify({ source: SOURCE, channel: CHANNEL, shopify_name: o.shopify.name, source_order_id: o.source_order_id,
          order_value: o.order_value, items: o.items.length, run: runId || undefined, cancelled: o.cancelled || undefined });
      }), actor]);
  }

  for (const u of d.update) {
    const keys = Object.keys(u.changes);
    if (keys.length || u.payloadChanged) {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`);
      await client.query(
        `UPDATE orders SET ${[...sets, `source_payload = coalesce(source_payload, '{}'::jsonb) || $${keys.length + 3}::jsonb`].join(', ')},
           version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
        [u.id, actor, ...keys.map((k) => u.changes[k].to), JSON.stringify({ shopify: u.o.shopify })]);
    }
    if (keys.length || u.added || u.changedItems) {
      await logEvent(client, u.id, 'shopify_sync_updated', actor, {
        run: runId || undefined, changes: u.changes, items_added: u.added || undefined, items_updated: u.changedItems || undefined,
      });
    }
  }
  // A conflict is recorded on the order once, and again only when Shopify has changed the order since —
  // never on every poll.
  const withConflicts = [...d.update, ...d.unchanged].filter((u) => u.conflicts.length);
  if (withConflicts.length) {
    const { rows: seen } = await client.query(
      `SELECT DISTINCT order_id, metadata->>'kind' AS kind FROM order_events WHERE event_type = 'shopify_sync_conflict' AND order_id = ANY($1)`,
      [withConflicts.map((u) => u.id)]);
    const logged = new Set(seen.map((r) => `${r.order_id}|${r.kind}`));
    for (const u of withConflicts) {
      for (const c of u.conflicts) {
        if (!u.payloadChanged && logged.has(`${u.id}|${c.kind}`)) continue;
        await logEvent(client, u.id, 'shopify_sync_conflict', actor, { run: runId || undefined, kind: c.kind, detail: c.detail, lines: c.lines, from: c.from, to: c.to });
      }
    }
  }

  const lockedIds = new Set([...d.update, ...d.unchanged].filter((u) => u.locked).map((u) => u.id));
  const all = d.create.concat(d.update.map((u) => u.o), d.unchanged.map((u) => u.o))
    .flatMap((o) => o.items.map((it) => ({ ...it, order_id: ids.get(o.source_order_id) })))
    .filter((x) => x.order_id && !lockedIds.has(x.order_id));
  // Shopify SKU → master SKU: exact master code first, then the `website` platform mapping. Never guessed.
  const skuIds = await resolveSkuIds(client, CHANNEL, all.map((x) => x.sku));
  const skuIdOf = (x) => (x.sku ? skuIds.get(String(x.sku).trim().toLowerCase()) ?? null : null);
  let added = 0; let updated = 0;
  if (all.length) {
    const { rows } = await client.query(
      `INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, item_tax, price_excl_tax,
                                promotion_discount, promotion_id, shipping_price, shipping_tax, sku_id)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::numeric[],
                            $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::numeric[], $13::int[])
       ON CONFLICT (order_id, source_line_item_id) DO UPDATE SET
         sku = EXCLUDED.sku, title = EXCLUDED.title, quantity = EXCLUDED.quantity, item_price = EXCLUDED.item_price,
         item_tax = EXCLUDED.item_tax, promotion_discount = EXCLUDED.promotion_discount,
         sku_id = CASE WHEN lower(order_items.sku) IS NOT DISTINCT FROM lower(EXCLUDED.sku)
                       THEN coalesce(EXCLUDED.sku_id, order_items.sku_id) ELSE EXCLUDED.sku_id END,
         updated_at = now()
       WHERE (order_items.sku, order_items.title, order_items.quantity, order_items.item_price, order_items.item_tax, order_items.promotion_discount)
         IS DISTINCT FROM (EXCLUDED.sku, EXCLUDED.title, EXCLUDED.quantity, EXCLUDED.item_price, EXCLUDED.item_tax, EXCLUDED.promotion_discount)
       RETURNING (xmax = 0) AS inserted`,
      [all.map((x) => x.order_id), all.map((x) => x.source_line_item_id), all.map((x) => x.sku), all.map((x) => x.title),
        all.map((x) => x.quantity), all.map((x) => x.item_price), all.map((x) => x.item_tax), all.map((x) => x.price_excl_tax),
        all.map((x) => x.promotion_discount), all.map((x) => x.promotion_id), all.map((x) => x.shipping_price),
        all.map((x) => x.shipping_tax), all.map(skuIdOf)]);
    added = rows.filter((r) => r.inserted).length;
    updated = rows.length - added;
    // Unchanged lines whose SKU has since been mapped (a master code, or a website platform SKU).
    await client.query(
      `UPDATE order_items oi SET sku_id = r.sku_id, updated_at = now() FROM (
         SELECT oi2.id, coalesce(
           (SELECT s.id FROM skus s WHERE lower(s.sku) = lower(oi2.sku)),
           (SELECT m.sku_id FROM sku_platform_mappings m WHERE m.platform = $2 AND lower(m.platform_sku) = lower(oi2.sku)
            ORDER BY m.duplicate_override, m.created_at, m.id LIMIT 1)) AS sku_id
         FROM order_items oi2 WHERE oi2.order_id = ANY($1) AND oi2.sku_id IS NULL AND oi2.sku IS NOT NULL) r
       WHERE oi.id = r.id AND r.sku_id IS NOT NULL`, [[...new Set(all.map((x) => x.order_id))], CHANNEL]);
  }
  return {
    created: d.create.length, updated: d.update.length, unchanged: d.unchanged.length,
    itemsCreated: added, itemsUpdated: updated, conflicts: d.conflicts, duplicates: d.duplicates,
  };
}

/* ------------------------------------------------------------------ runs */

/** Validates the requested window. Shopify returns at most the last 60 days without read_all_orders. */
export function resolveWindow({ mode = 'window', days, from, to } = {}, now = new Date()) {
  if (mode === 'incremental') return { mode };
  const max = maxWindowDays();
  const end = to ? new Date(to) : now;
  let start;
  if (days !== undefined && days !== null && days !== '') {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) throw bad('Choose how many days to import.');
    start = new Date(end.getTime() - n * 86400000);
  } else start = from ? new Date(from) : null;
  if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw bad('Choose a valid date window.');
  if (start > end) throw bad('The window starts after it ends.');
  if (end > new Date(now.getTime() + 60000)) throw bad('The window cannot end in the future.');
  if ((now - start) / 86400000 > max + 0.01) {
    throw bad(max === 60
      ? 'Shopify only returns orders from the last 60 days with the current access (read_orders). Older orders need the read_all_orders scope.'
      : `The window can go back at most ${max} days.`);
  }
  return { mode: 'window', from: start.toISOString(), to: end.toISOString() };
}

async function checkpoint() {
  const row = await getSystemState(CHECKPOINT_KEY).catch(() => null);
  return row?.value || null;
}

/**
 * Fetches the run's orders page by page and either previews (no writes at all)
 * or applies each page in its own transaction. Bounded: at most
 * MAX_ORDERS_PER_RUN per run; a longer window ends "partial" with a cursor so
 * the next run continues from it. Idempotent, so a repeated or resumed run only
 * finds the remaining work.
 */
export async function runShopifySync({ window: w = {}, dryRun = true, actor = null, gql = graphql, resumeRunId = null, maxOrders = MAX_ORDERS_PER_RUN, now = new Date() } = {}) {
  await ensureInventorySchema();
  const db = getPool();
  let win;
  let after = null;
  let resumed = null;
  if (resumeRunId) {
    const { rows: [prev] } = await db.query(`SELECT id, details FROM order_imports WHERE id = $1 AND kind = 'shopify_sync'`, [resumeRunId]);
    if (!prev?.details?.cursor || !prev.details.window) throw bad('That sync cannot be continued.');
    win = prev.details.window; after = prev.details.cursor; resumed = Number(prev.id);
  } else {
    win = resolveWindow(w, now);
    if (win.mode === 'incremental') {
      const since = await checkpoint();
      if (!since) throw bad('Run an initial import first; incremental sync continues from the last completed one.');
      // Five minutes of overlap: Shopify's updated_at index can lag a write slightly.
      win.since = new Date(new Date(since).getTime() - 5 * 60000).toISOString();
    }
  }
  const query = searchQuery(win);
  const startedAt = new Date();

  let runId = null;
  if (!dryRun) {
    const { rows: [r] } = await db.query(
      `INSERT INTO order_imports (channel, kind, status, started_at, imported_by, filename, rows_processed, orders_in_file, orders_created,
         orders_updated, orders_unchanged, items_created, items_updated, promotion_rows, duplicate_rows, error_rows, details)
       VALUES ($1, 'shopify_sync', 'running', now(), $2, $3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $4) RETURNING id`,
      [CHANNEL, actor, `Shopify ${win.mode === 'incremental' ? 'incremental sync' : 'import'}`, JSON.stringify({ window: win, resumed_from: resumed })]);
    runId = Number(r.id);
  }

  const t = { fetched: 0, created: 0, updated: 0, unchanged: 0, itemsCreated: 0, itemsUpdated: 0, skippedTest: 0, newItems: 0, changedItems: 0 };
  const conflicts = []; const duplicates = []; const errors = []; const allOrders = [];
  let pii = true; let hasMore = false; let maxUpdated = null;
  try {
    for (;;) {
      const page = await fetchPage({ gql, query, after, pii });
      pii = page.pii;
      const conn = page.conn;
      if (!conn) throw bad('Shopify returned no orders connection.', 502);
      const mapped = [];
      for (const node of conn.nodes || []) {
        t.fetched += 1;
        if (node.updatedAt && (!maxUpdated || node.updatedAt > maxUpdated)) maxUpdated = node.updatedAt;
        const m = mapShopifyOrder(node);
        if (m.error) { errors.push({ shopifyId: m.id || node?.id || null, name: m.name || node?.name || null, reason: m.error }); continue; }
        if (m.test) { t.skippedTest += 1; continue; }        // Shopify test orders never reach Logistics
        mapped.push(m);
      }
      if (dryRun) {
        const d = await diff(db, mapped);
        t.created += d.create.length; t.updated += d.update.length; t.unchanged += d.unchanged.length;
        t.newItems += d.newItems; t.changedItems += d.changedItems;
        conflicts.push(...d.conflicts); duplicates.push(...d.duplicates);
      } else if (mapped.length) {
        const r = await inTransaction((client) => applyPage(client, mapped, { actor, runId }));
        for (const k of ['created', 'updated', 'unchanged', 'itemsCreated', 'itemsUpdated']) t[k] += r[k];
        conflicts.push(...r.conflicts); duplicates.push(...r.duplicates);
      }
      allOrders.push(...mapped);
      after = conn.pageInfo?.endCursor || null;
      hasMore = Boolean(conn.pageInfo?.hasNextPage && after);
      if (runId) await db.query(`UPDATE order_imports SET details = details || $2::jsonb WHERE id = $1`, [runId, JSON.stringify({ cursor: hasMore ? after : null })]);
      if (!hasMore || t.fetched >= maxOrders) break;
    }
  } catch (err) {
    if (runId) {
      await db.query(`UPDATE order_imports SET status = 'failed', completed_at = now(), rows_processed = $2, orders_in_file = $2,
          orders_created = $3, orders_updated = $4, orders_unchanged = $5, items_created = $6, items_updated = $7,
          error_rows = $8, errors = $9, details = details || $10::jsonb WHERE id = $1`,
        [runId, t.fetched, t.created, t.updated, t.unchanged, t.itemsCreated, t.itemsUpdated, errors.length + 1,
          JSON.stringify([...errors, { reason: String(err.message).slice(0, 300) }].slice(0, MAX_REPORTED)), JSON.stringify({ failure: String(err.message).slice(0, 300) })]).catch(() => {});
    }
    throw err;
  }

  const unmapped = await unmappedLines(db, allOrders);
  const partial = hasMore;
  const summary = {
    mode: win.mode, window: win, found: t.fetched, skippedTest: t.skippedTest, errors: errors.length,
    newOrders: dryRun ? t.created : undefined, ordersCreated: dryRun ? undefined : t.created,
    changed: t.updated, unchanged: t.unchanged,
    newLineItems: dryRun ? t.newItems : t.itemsCreated, changedLineItems: dryRun ? t.changedItems : t.itemsUpdated,
    unmappedSkus: unmapped.length, unmappedLines: unmapped.reduce((n, u) => n + u.lines, 0),
    conflicts: conflicts.length, possibleDuplicates: duplicates.length, partial, customerDataAvailable: pii,
  };
  if (runId) {
    await db.query(
      `UPDATE order_imports SET status = $2, completed_at = now(), rows_processed = $3, orders_in_file = $3, orders_created = $4,
         orders_updated = $5, orders_unchanged = $6, items_created = $7, items_updated = $8, error_rows = $9, errors = $10,
         conflicts = $11, unmapped_lines = $12, details = details || $13::jsonb WHERE id = $1`,
      [runId, partial ? 'partial' : 'completed', t.fetched, t.created, t.updated, t.unchanged, t.itemsCreated, t.itemsUpdated, errors.length,
        JSON.stringify(errors.slice(0, MAX_REPORTED)), conflicts.length, summary.unmappedLines,
        JSON.stringify({ conflicts: conflicts.slice(0, MAX_REPORTED), duplicates: duplicates.slice(0, MAX_REPORTED), skipped_test: t.skippedTest,
          unmapped: unmapped.slice(0, 50), customer_data: pii, max_updated_at: maxUpdated })]);
    // The checkpoint moves only when a run has seen everything it asked for: the
    // start of this run, so anything updated while it ran is caught next time.
    if (!partial) await recordSystemEvent(CHECKPOINT_KEY, startedAt.toISOString());
  }
  return {
    runId, dryRun, summary, unmapped: unmapped.slice(0, 50), conflicts: conflicts.slice(0, MAX_REPORTED),
    duplicates: duplicates.slice(0, MAX_REPORTED), errors: errors.slice(0, MAX_REPORTED),
  };
}

/** Connection state for the admin card. Never includes a token or secret. */
export async function shopifyOrdersStatus() {
  await ensureInventorySchema();
  const db = getPool();
  const [{ rows: [last] }, { rows: [count] }, since] = await Promise.all([
    db.query(`SELECT id, status, started_at, completed_at, imported_by, orders_in_file, orders_created, orders_updated, conflicts, unmapped_lines, error_rows
              FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT 1`),
    db.query(`SELECT count(*)::int AS n FROM orders WHERE channel = $1 AND source = $2`, [CHANNEL, SOURCE]),
    checkpoint(),
  ]);
  return {
    configured: shopifyConfigured(),
    store: process.env.SHOPIFY_STORE_DOMAIN || null,
    auth: shopifyConfigured() ? authMode() : null,
    pollEnabled: process.env.SHOPIFY_ORDERS_POLL_ENABLED === 'true',
    maxWindowDays: maxWindowDays(),
    ordersSynced: count.n,
    checkpoint: since,
    lastRun: last ? { ...last, id: Number(last.id) } : null,
  };
}

export async function shopifySyncHistory(limit = 10) {
  const { rows } = await getPool().query(
    `SELECT id, status, started_at, completed_at, imported_by, filename, orders_in_file, orders_created, orders_updated,
            orders_unchanged, items_created, items_updated, conflicts, unmapped_lines, error_rows,
            (details->>'cursor') IS NOT NULL AS resumable
     FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/* ------------------------------------------------------------------ polling */

let polling = false;
/**
 * Incremental sync on a timer — opt-in only (SHOPIFY_ORDERS_POLL_ENABLED=true),
 * and only after an initial import has set a checkpoint. Separate from the
 * abandoned-checkout poll, which has its own flag and does not touch orders.
 */
export function startShopifyOrdersPoll() {
  if (process.env.SHOPIFY_ORDERS_POLL_ENABLED !== 'true') return null;
  if (!shopifyConfigured()) { console.log('Shopify orders poll: off (Shopify is not configured)'); return null; }
  const minutes = Math.max(5, Number(process.env.SHOPIFY_ORDERS_POLL_MINUTES) || 15);
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      if (!(await checkpoint())) return;                 // no initial import yet: never a surprise backfill
      const r = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, actor: 'shopify-poll' });
      if (r.summary.ordersCreated || r.summary.changed || r.summary.conflicts) {
        console.log(`Shopify orders poll: ${r.summary.ordersCreated} new, ${r.summary.changed} changed, ${r.summary.conflicts} conflict(s)`);
      }
    } catch (err) {
      console.error('Shopify orders poll failed:', String(err.message).slice(0, 200));
    } finally { polling = false; }
  };
  const timer = setInterval(tick, minutes * 60000);
  timer.unref?.();
  console.log(`Shopify orders poll: every ${minutes} min (incremental)`);
  return timer;
}
