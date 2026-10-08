/**
 * Amazon orders from the Selling Partner API (Orders v2026-01-01) — incremental reconciliation into the same
 * `orders` / `order_items` rows the Seller Central file import (lib/amazon-import.js) writes.
 *
 * One order per Amazon order id: rows are matched on (channel 'amazon', source_order_id = Amazon order id) and lines
 * on (order, source_line_item_id = Amazon order item id) — exactly the file import's keys, so a file import and the
 * API converge on one order whichever comes first. A new order made here has source 'amazon_spapi'; an order the file
 * made keeps 'amazon_import'. Both write under the same advisory lock, so they never race on a new order.
 *
 * What the API writes, and what it never touches:
 *   - order: order date, currency, order value (the file's formula: Σ item price incl. tax + shipping incl. tax +
 *     item and shipping promotion discounts, negative) — never blanked by a missing value; an order whose stock is
 *     reserved or has left keeps its value (a conflict is logged instead), and a cancellation with a shipment needs a person.
 *   - lines: Amazon's values where it gives them; a value it does not give (listing id, product id, promotion id, or
 *     a tax it does not split out) keeps what the file wrote. Lines of an order whose stock is reserved or has left
 *     are history and are never changed (a conflict is logged).
 *   - source_payload.amazon_spapi: Amazon's order facts (status, fulfilled by, amounts) — a whitelist, never the
 *     raw response and no buyer data (BUYER / RECIPIENT are never requested). The file's source_payload.amazon is left as it is.
 *   - never: shipments, stock reservations or movements, affiliate attribution, financial snapshots, customer
 *     details, payment status. FBA orders (fulfilled by Amazon) are imported with no dispatch type and fulfillment
 *     'marketplace', and nothing in Briyo ships them.
 *
 * Runs use the shared runner (lib/order-sync-runner.js), kind 'amazon_sync', checkpoint `amazon_orders_checkpoint`.
 * Window: from the checkpoint less 5 minutes up to a fixed watermark 3 minutes before the start — Amazon requires
 * lastUpdatedBefore to be at least two minutes before each request; the extra minute absorbs clock skew. The
 * checkpoint moves to the watermark only when the whole window is done. A failed or partial window is continued, not
 * replaced: from its saved page token while that is fresh, otherwise from its first page (tokens expire after 24 hours).
 * Full history is not part of this phase.
 */
import { getPool, getSystemState, recordSystemEvent } from './db.js';
import { inTransaction, logEvent } from './orders.js';
import { ensureInventorySchema, resolveSkuIds } from './inventory.js';
import { amazonConfigured, createAmazonClient } from './amazon-spapi.js';
import { createSyncRunner, incrementalWindow, checkpointAfter, openRun, recordPageProgress, failRun, completeRun, STALE_RUN_MS } from './order-sync-runner.js';

export const CHANNEL = 'amazon';
export const SOURCE = 'amazon_spapi';
export const RUN_KIND = 'amazon_sync';
export const CHECKPOINT_KEY = 'amazon_orders_checkpoint';
export const OVERLAP_MS = 5 * 60000;
/** Amazon: lastUpdatedBefore must be at least 2 minutes before the request; one more minute for clock skew. */
export const WATERMARK_DELAY_MS = 3 * 60000;
/** A saved page token older than this is not used: Amazon expires them 24 hours after issue. */
export const TOKEN_MAX_AGE_MS = 23 * 3600000;
const MAX_ORDERS_PER_RUN = 2000;             // 20 pages of 100: searchOrders' burst; beyond it Amazon refills slowly
/**
 * A run's own waiting for the searchOrders allowance stays under this, so a run never sits "running" for long (the
 * shared runner treats a run older than 30 minutes as cut off). Past it the run ends "partial" and the next run of
 * the chain waits for the allowance before it opens.
 */
export const RUN_WAIT_BUDGET_MS = 15 * 60000;
/** Runs in a row that Amazon throttled before a single page: then the chain stops ("failed", resumable later). */
export const MAX_THROTTLED_RUNS = 3;
const PAGE_SIZE = 100;
const INCLUDED_DATA = ['PROCEEDS', 'FULFILLMENT'];   // never BUYER or RECIPIENT: no personal data is requested
const MAX_REPORTED = 200;
const FIRST_RUN_MAX_DAYS = 90;
const SHIPPED_STATUSES = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto'];

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (v, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ mapping */

/**
 * One Amazon order → the Briyo shape, or { error } when it cannot be imported safely (mixed currencies, an amount
 * that is not a number, a line without an id). `priced` is false while Amazon has no prices yet (pending orders):
 * such an order is not created, and on an existing order its value and line amounts are left alone.
 */
export function mapAmazonOrder(o) {
  const id = text(o?.orderId, 40);
  if (!id || !/^[0-9A-Za-z-]+$/.test(id)) return { error: 'Missing or malformed orderId' };
  const currencies = new Set();
  let badAmount = false;
  const money = (m) => {
    if (!m || m.amount === undefined || m.amount === null || m.amount === '') return null;
    const n = Number(m.amount);
    if (!Number.isFinite(n)) { badAmount = true; return null; }
    if (m.currencyCode) currencies.add(String(m.currencyCode).trim().toUpperCase());
    return round2(n);
  };
  const add = (a, b) => (a === null ? b : b === null ? a : round2(a + b));
  const items = [];
  const problems = [];
  for (const it of Array.isArray(o.orderItems) ? o.orderItems : []) {
    const lineId = text(it?.orderItemId, 80);
    if (!lineId) { problems.push('an order item has no orderItemId'); continue; }
    const qty = Number(it.quantityOrdered);
    if (!Number.isInteger(qty) || qty < 0) { problems.push(`item ${lineId}: quantityOrdered is not a whole number`); continue; }
    const bd = Array.isArray(it.proceeds?.breakdowns) ? it.proceeds.breakdowns : [];
    const of = (type) => bd.filter((b) => b?.type === type);
    const sum = (type) => of(type).reduce((s, b) => add(s, money(b.subtotal)), null);
    const detail = (type, subtype) => of(type).flatMap((b) => (Array.isArray(b.detailedBreakdowns) ? b.detailedBreakdowns : []))
      .filter((d) => d?.subtype === subtype).reduce((s, d) => add(s, money(d.value)), null);
    const hasDetail = (type) => of(type).some((b) => Array.isArray(b.detailedBreakdowns) && b.detailedBreakdowns.length);
    // Amazon: the ITEM amount excludes tax when tax is shown separately. The file's item-price includes it.
    const taxShown = of('TAX').length > 0;
    const itemTax = taxShown ? (hasDetail('TAX') ? detail('TAX', 'ITEM') : sum('TAX')) : null;
    const shipTax = taxShown && hasDetail('TAX') ? detail('TAX', 'SHIPPING') : null;
    const base = sum('ITEM');
    const ship = sum('SHIPPING');
    const neg = (v) => (v === null ? null : -Math.abs(v));       // the file writes discounts as negative numbers
    const itemDiscount = neg(hasDetail('DISCOUNT') ? detail('DISCOUNT', 'ITEM') : sum('DISCOUNT'));
    const shipDiscount = neg(hasDetail('DISCOUNT') ? detail('DISCOUNT', 'SHIPPING') : null);
    money(it.product?.price?.unitPrice);                          // currency check only
    items.push({
      source_line_item_id: lineId, sku: text(it.product?.sellerSku, 120), title: text(it.product?.title, 500), quantity: qty,
      asin: text(it.product?.asin, 40),
      item_price: base === null ? null : taxShown ? add(base, itemTax ?? 0) : base,
      price_excl_tax: taxShown ? base : null,
      item_tax: itemTax,
      shipping_price: ship === null ? null : taxShown ? add(ship, shipTax ?? 0) : ship,
      shipping_tax: shipTax,
      promotion_discount: itemDiscount,
      ship_discount: shipDiscount,
      breakdowns: bd.map((b) => ({ type: text(b?.type, 30), amount: text(b?.subtotal?.amount, 30), currency: text(b?.subtotal?.currencyCode, 3),
        details: Array.isArray(b?.detailedBreakdowns) ? b.detailedBreakdowns.map((d) => ({ subtype: text(d?.subtype, 30), amount: text(d?.value?.amount, 30) })) : undefined })),
    });
  }
  const grand = money(o.proceeds?.grandTotal);
  if (badAmount) problems.push('an amount is not a number');
  if (currencies.size > 1) problems.push(`mixed currencies (${[...currencies].sort().join(', ')}) cannot be represented in one order`);
  if (problems.length) return { error: problems.join('; '), source_order_id: id };
  const priced = items.length > 0 && items.every((it) => it.item_price !== null);
  const value = priced ? round2(items.reduce((s, it) => s + it.item_price + (it.shipping_price || 0) + (it.promotion_discount || 0) + (it.ship_discount || 0), 0)) : null;
  if (value !== null && value < 0) return { error: `order value ${value} is negative`, source_order_id: id };
  const status = text(o.fulfillment?.fulfillmentStatus, 30);
  const fulfilledBy = text(o.fulfillment?.fulfilledBy, 20);
  return {
    source_order_id: id,
    order_date: o.createdTime ? new Date(o.createdTime).toISOString() : null,
    currency: currencies.size ? [...currencies][0] : null,
    order_value: value,
    priced,
    cancelled: status === 'CANCELLED',
    fulfilled_by: fulfilledBy,
    items: items.map(({ breakdowns, ...it }) => it),
    amazon_spapi: {
      order_id: id, marketplace_id: text(o.salesChannel?.marketplaceId, 20), channel_name: text(o.salesChannel?.channelName, 20),
      fulfillment_status: status, fulfilled_by: fulfilledBy,
      created_time: text(o.createdTime, 40), last_updated_time: text(o.lastUpdatedTime, 40),
      grand_total: grand === null ? null : { amount: grand, currency: text(o.proceeds?.grandTotal?.currencyCode, 3) },
      items: items.map((it) => ({ order_item_id: it.source_line_item_id, asin: it.asin, seller_sku: it.sku, quantity: it.quantity, breakdowns: it.breakdowns })),
    },
  };
}

/* ------------------------------------------------------------------ compare */

const ORDER_FIELDS = ['order_date', 'currency', 'order_value'];
// Line fields Amazon's API gives. promotion_id, amazon_listing_id and amazon_product_id come only from the file.
const ITEM_FIELDS = ['sku', 'title', 'quantity', 'item_price', 'item_tax', 'price_excl_tax', 'promotion_discount', 'shipping_price', 'shipping_tax', 'asin'];
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

/** What applying these orders would do, against what is stored now. Reads only. */
async function diff(client, orders) {
  const ids = orders.map((o) => o.source_order_id);
  const { rows: existing } = ids.length ? await client.query(
    `SELECT id, source_order_id, order_status, ${ORDER_FIELDS.join(', ')}, source_payload FROM orders
     WHERE channel = $1 AND source_order_id = ANY($2)`, [CHANNEL, ids]) : { rows: [] };
  const byId = new Map(existing.map((r) => [r.source_order_id, r]));
  const eids = existing.map((r) => Number(r.id));
  const { rows: items } = eids.length ? await client.query(
    `SELECT order_id, source_line_item_id, ${ITEM_FIELDS.join(', ')} FROM order_items WHERE order_id = ANY($1)`, [eids]) : { rows: [] };
  const itemsByKey = new Map(items.map((r) => [`${r.order_id}|${r.source_line_item_id}`, r]));
  // Locked: stock has left (dispatch movement, or a parcel past dispatch) or is reserved for a parcel — the same
  // rule the Shopify sync uses. Active: any shipment that is not cancelled.
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

  const out = { create: [], update: [], unchanged: [], conflicts: [], unpriced: [], lines: new Set(items.map((r) => `${r.order_id}|${r.source_line_item_id}`)) };
  for (const o of orders) {
    const cur = byId.get(o.source_order_id);
    if (!cur) {
      if (!o.priced) { out.unpriced.push(o.source_order_id); continue; }    // pending at Amazon: created once it has prices
      out.create.push(o); continue;
    }
    const id = Number(cur.id);
    const op = opsById.get(id) || {};
    const changes = {};
    const conflicts = [];
    for (const f of ORDER_FIELDS) {
      if (o[f] === null || o[f] === undefined) continue;                 // never wipe
      if (!sameValue(cur[f], o[f])) changes[f] = { from: cur[f] instanceof Date ? cur[f].toISOString() : cur[f], to: o[f] };
    }
    if (op.locked && changes.order_value) {
      conflicts.push({ kind: 'value_locked', from: changes.order_value.from, to: changes.order_value.to,
        detail: `Amazon's order value changed from ${changes.order_value.from} to ${changes.order_value.to} after stock was reserved or dispatched. Briyo keeps ${changes.order_value.from}.` });
      delete changes.order_value;
    }
    if (o.cancelled && cur.order_status !== 'cancelled') {
      if (op.active || op.locked) conflicts.push({ kind: 'cancelled_with_shipment', detail: 'Cancelled at Amazon, but this order has a shipment in Briyo. Not cancelled automatically.' });
      else changes.order_status = { from: cur.order_status, to: 'cancelled' };
    }
    let added = 0; let changedItems = 0;
    for (const it of o.items) {
      const ex = itemsByKey.get(`${id}|${it.source_line_item_id}`);
      if (!ex) { if (it.item_price !== null) added += 1; continue; }       // an unpriced new line waits for its price
      if (ITEM_FIELDS.some((f) => it[f] !== null && it[f] !== undefined && !sameValue(ex[f], it[f]))) changedItems += 1;
    }
    if (op.locked && (added || changedItems)) {
      conflicts.push({ kind: 'lines_locked', lines: added + changedItems,
        detail: `${added + changedItems} line${added + changedItems > 1 ? 's' : ''} changed at Amazon after stock was reserved or dispatched. Not applied.` });
      added = 0; changedItems = 0;
    }
    // Compared as stored (a JSON round trip drops undefined keys).
    const payloadChanged = stable(cur.source_payload?.amazon_spapi ?? null) !== stable(JSON.parse(JSON.stringify(o.amazon_spapi)));
    const entry = { o, id, changes, payloadChanged, added, changedItems, locked: Boolean(op.locked), conflicts };
    if (conflicts.length) out.conflicts.push({ id, amazonOrderId: o.source_order_id, conflicts });
    if (Object.keys(changes).length || payloadChanged || added || changedItems) out.update.push(entry);
    else out.unchanged.push(entry);
  }
  return out;
}

/** Adds one page's unmatched order lines to the run's summary (code → lines, units), as the file import reports them. */
async function accumulateUnmapped(db, orders, acc) {
  const items = orders.flatMap((o) => o.items);
  if (!items.length) return;
  const known = await resolveSkuIds(db, CHANNEL, items.map((it) => it.sku));
  for (const it of items) {
    const code = String(it.sku || '').trim();
    if (code && known.has(code.toLowerCase())) continue;
    const k = code.toLowerCase();
    const u = acc.get(k) || { code: code || null, title: it.title, asin: it.asin, lines: 0, units: 0 };
    u.lines += 1; u.units += it.quantity;
    acc.set(k, u);
  }
}

/* ------------------------------------------------------------------ apply */

/** Writes one page of mapped orders in the caller's transaction, under the Amazon file import's lock. Returns counts. */
async function applyPage(client, orders, { actor, runId }) {
  // The same lock as lib/amazon-import.js: a file import and an API page never interleave on the same orders.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('orders:amazon-import'))`);
  const d = await diff(client, orders);
  const ids = new Map([...d.update, ...d.unchanged].map((u) => [u.o.source_order_id, u.id]));

  if (d.create.length) {
    const c = d.create;
    const { rows } = await client.query(
      `INSERT INTO orders (channel, dispatch_type, fulfillment_type, source, order_status, source_order_id, order_date, currency, order_value,
                           source_payload, created_by, updated_by)
       SELECT $1, x.dt_type, x.ft, $2, x.status, x.sid, x.dt, x.cur, x.val, x.pl, $3, $3 FROM unnest(
         $4::text[], $5::timestamptz[], $6::text[], $7::numeric[], $8::jsonb[], $9::text[], $10::text[], $11::text[])
         AS x(sid, dt, cur, val, pl, status, dt_type, ft)
       ON CONFLICT (channel, source_order_id) DO NOTHING
       RETURNING id, source_order_id`,
      [CHANNEL, SOURCE, actor, c.map((o) => o.source_order_id), c.map((o) => o.order_date), c.map((o) => o.currency),
        c.map((o) => o.order_value), c.map((o) => JSON.stringify({ amazon_spapi: o.amazon_spapi })),
        c.map((o) => (o.cancelled ? 'cancelled' : 'new')),
        // Fulfilled by Amazon (FBA): nothing for Briyo to dispatch. Merchant-fulfilled: Easy Ship, as the file import.
        c.map((o) => (o.fulfilled_by === 'AMAZON' ? null : 'easy_ship')),
        c.map((o) => (o.fulfilled_by === 'AMAZON' ? 'marketplace' : o.fulfilled_by === 'MERCHANT' ? 'merchant' : null))]);
    if (rows.length !== c.length) throw bad('Another import added some of these orders at the same moment. Run the sync again.', 409);
    for (const r of rows) ids.set(r.source_order_id, Number(r.id));
    const byId = new Map(c.map((o) => [o.source_order_id, o]));
    await client.query(
      `INSERT INTO order_events (order_id, event_type, actor, metadata) SELECT unnest($1::bigint[]), 'order_created', $3, unnest($2::jsonb[])`,
      [rows.map((r) => Number(r.id)), rows.map((r) => {
        const o = byId.get(r.source_order_id);
        return JSON.stringify({ source: SOURCE, channel: CHANNEL, source_order_id: o.source_order_id, order_value: o.order_value,
          items: o.items.length, fulfilled_by: o.fulfilled_by || undefined, run: runId || undefined, cancelled: o.cancelled || undefined });
      }), actor]);
  }

  for (const u of d.update) {
    const keys = Object.keys(u.changes);
    if (keys.length || u.payloadChanged) {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`);
      await client.query(
        `UPDATE orders SET ${[...sets, `source_payload = coalesce(source_payload, '{}'::jsonb) || $${keys.length + 3}::jsonb`].join(', ')},
           version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
        [u.id, actor, ...keys.map((k) => u.changes[k].to), JSON.stringify({ amazon_spapi: u.o.amazon_spapi })]);
    }
    if (keys.length || u.added || u.changedItems) {
      await logEvent(client, u.id, 'amazon_sync_updated', actor, {
        run: runId || undefined, changes: u.changes, items_added: u.added || undefined, items_updated: u.changedItems || undefined,
      });
    }
  }
  // A conflict is logged on the order once per kind, and again only when Amazon has changed the order since.
  const withConflicts = [...d.update, ...d.unchanged].filter((u) => u.conflicts.length);
  if (withConflicts.length) {
    const { rows: seen } = await client.query(
      `SELECT DISTINCT order_id, metadata->>'kind' AS kind FROM order_events WHERE event_type = 'amazon_sync_conflict' AND order_id = ANY($1)`,
      [withConflicts.map((u) => u.id)]);
    const logged = new Set(seen.map((r) => `${r.order_id}|${r.kind}`));
    for (const u of withConflicts) {
      for (const c of u.conflicts) {
        if (!u.payloadChanged && logged.has(`${u.id}|${c.kind}`)) continue;
        await logEvent(client, u.id, 'amazon_sync_conflict', actor, { run: runId || undefined, kind: c.kind, detail: c.detail, lines: c.lines, from: c.from, to: c.to });
      }
    }
  }

  // Lines: never for a locked order, never an unpriced new line. A value Amazon does not give keeps what is stored.
  const lockedIds = new Set([...d.update, ...d.unchanged].filter((u) => u.locked).map((u) => u.id));
  const all = d.create.concat(d.update.map((u) => u.o), d.unchanged.map((u) => u.o))
    .flatMap((o) => o.items.map((it) => ({ ...it, order_id: ids.get(o.source_order_id) })))
    .filter((x) => x.order_id && !lockedIds.has(x.order_id) && (x.item_price !== null || d.lines.has(`${x.order_id}|${x.source_line_item_id}`)));
  // seller SKU → master SKU: exact master code first, then the `amazon` platform mapping. Never guessed or created.
  const skuIds = await resolveSkuIds(client, CHANNEL, all.map((x) => x.sku));
  const skuIdOf = (x) => (x.sku ? skuIds.get(String(x.sku).trim().toLowerCase()) ?? null : null);
  let added = 0; let updated = 0;
  if (all.length) {
    const cols = ['sku', 'title', 'quantity', 'item_price', 'item_tax', 'price_excl_tax', 'promotion_discount', 'shipping_price', 'shipping_tax', 'asin'];
    const merged = (c) => `coalesce(EXCLUDED.${c}, order_items.${c})`;
    const { rows } = await client.query(
      `INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, item_tax, price_excl_tax,
                                promotion_discount, shipping_price, shipping_tax, asin, sku_id)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::numeric[],
                            $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::int[])
       ON CONFLICT (order_id, source_line_item_id) DO UPDATE SET
         ${cols.map((c) => `${c} = ${merged(c)}`).join(', ')},
         sku_id = CASE WHEN lower(order_items.sku) IS NOT DISTINCT FROM lower(coalesce(EXCLUDED.sku, order_items.sku))
                       THEN coalesce(EXCLUDED.sku_id, order_items.sku_id) ELSE EXCLUDED.sku_id END,
         updated_at = now()
       WHERE (${cols.map((c) => `order_items.${c}`).join(', ')}) IS DISTINCT FROM (${cols.map(merged).join(', ')})
       RETURNING (xmax = 0) AS inserted`,
      [all.map((x) => x.order_id), all.map((x) => x.source_line_item_id), all.map((x) => x.sku), all.map((x) => x.title),
        all.map((x) => x.quantity), all.map((x) => x.item_price), all.map((x) => x.item_tax), all.map((x) => x.price_excl_tax),
        all.map((x) => x.promotion_discount), all.map((x) => x.shipping_price), all.map((x) => x.shipping_tax), all.map((x) => x.asin),
        all.map(skuIdOf)]);
    added = rows.filter((r) => r.inserted).length;
    updated = rows.length - added;
    // Unchanged lines whose SKU has since been mapped (a master code, or an amazon platform SKU).
    await client.query(
      `UPDATE order_items oi SET sku_id = r.sku_id, updated_at = now() FROM (
         SELECT oi2.id, coalesce(
           (SELECT s.id FROM skus s WHERE lower(s.sku) = lower(oi2.sku)),
           (SELECT m.sku_id FROM sku_platform_mappings m WHERE m.platform = $2 AND lower(m.platform_sku) = lower(oi2.sku)
            ORDER BY m.duplicate_override, m.created_at, m.id LIMIT 1)) AS sku_id
         FROM order_items oi2 WHERE oi2.order_id = ANY($1) AND oi2.sku_id IS NULL AND oi2.sku IS NOT NULL) r
       WHERE oi.id = r.id AND r.sku_id IS NOT NULL`, [[...new Set(all.map((x) => x.order_id))], CHANNEL]);
  }
  return { created: d.create.length, updated: d.update.length, unchanged: d.unchanged.length, itemsCreated: added, itemsUpdated: updated,
    conflicts: d.conflicts, unpriced: d.unpriced };
}

/* ------------------------------------------------------------------ runs */

async function checkpoint() {
  const row = await getSystemState(CHECKPOINT_KEY).catch(() => null);
  return row?.value || null;
}

/** The run a new run continues: its window, and its saved page token if any. Refuses another source's runs. */
async function continuedRun(db, runId) {
  const { rows: [prev] } = await db.query(`SELECT id, details FROM order_imports WHERE id = $1 AND kind = $2 AND channel = $3`, [runId, RUN_KIND, CHANNEL]);
  if (!prev?.details?.window?.since || !prev.details.window.until) throw bad('That sync cannot be continued.');
  return { id: Number(prev.id), window: prev.details.window, cursor: prev.details.cursor || null, throttleStreak: Number(prev.details.throttle_streak) || 0 };
}

/**
 * One run over one bounded window, page by page, each page in its own transaction. Stops after `maxOrders` as
 * "partial" with the page token saved; the next run of the chain continues from it. `client` is the SP-API client
 * (tests pass one with a fake transport). `startFrom` is only for the very first run, when no checkpoint exists yet.
 */
export async function runAmazonSync({ window: w = { mode: 'incremental' }, actor = null, client = null, resumeRunId = null,
  maxOrders = MAX_ORDERS_PER_RUN, now = new Date(), startFrom = null, freshAttempt = false } = {}) {
  await ensureInventorySchema();
  const db = getPool();
  const api = client || sharedAmazonClient();
  let win;
  let token = null;
  let resumed = null;
  let restarted = null;
  let cursor = null;
  let throttleStreak = 0;
  if (resumeRunId) {
    const prev = await continuedRun(db, resumeRunId);
    win = prev.window; resumed = prev.id;
    // A chained run carries the no-progress throttle count on; a person's new start begins it again at 0.
    throttleStreak = freshAttempt ? 0 : prev.throttleStreak;
    if (prev.cursor?.token && now - new Date(prev.cursor.issuedAt).getTime() < TOKEN_MAX_AGE_MS) { token = prev.cursor.token; cursor = prev.cursor; }
    else if (prev.cursor?.token) restarted = 'page token too old';
  } else {
    if (w.mode !== 'incremental') throw bad('Only incremental Amazon sync exists so far. Full history is not available yet.', 400);
    let since = await checkpoint();
    if (!since) {
      const from = startFrom ? new Date(startFrom) : null;
      if (!from || Number.isNaN(from.getTime()) || from > new Date(now.getTime() - WATERMARK_DELAY_MS) || now - from > FIRST_RUN_MAX_DAYS * 86400000) {
        throw bad(`Amazon has not been synced yet. The first sync needs a start date within the last ${FIRST_RUN_MAX_DAYS} days.`, 409);
      }
      since = new Date(from.getTime() + OVERLAP_MS).toISOString();       // the start date itself, after the overlap below
    }
    win = incrementalWindow(since, new Date(now.getTime() - WATERMARK_DELAY_MS), OVERLAP_MS);
  }
  // Wait for the searchOrders allowance before the run opens: the waiting is not counted against a "running" row.
  await api.waitForSearchAllowance();
  const runClock = api.now();
  const startedAt = new Date();
  const runId = await openRun(db, { channel: CHANNEL, kind: RUN_KIND, actor, filename: 'Amazon incremental sync', window: win,
    resumedFrom: resumed, cursor });             // a resumed token keeps Amazon's issue time, so its age keeps counting

  const t = { fetched: 0, created: 0, updated: 0, unchanged: 0, itemsCreated: 0, itemsUpdated: 0, requests: 0, transientRetries: 0, restarts: restarted ? 1 : 0 };
  const errors = [];
  const conflicts = [];
  const unpriced = [];
  const unmappedAcc = new Map();
  let hasMore = true;
  let pageRestarted = false;
  let pages = 0;
  let endedBy = null;
  try {
    while (hasMore) {
      // Bounded run: once this run would wait past its budget for the next page, it ends partial (cursor saved) and
      // the next run of the chain waits for the allowance before opening.
      const ahead = api.searchWaitMs();
      if (pages > 0 && ahead > 0 && api.now() - runClock + ahead > RUN_WAIT_BUDGET_MS) { endedBy = 'allowance'; break; }
      let page;
      try {
        t.requests += 1;
        page = await api.searchOrders({ lastUpdatedAfter: win.since, lastUpdatedBefore: win.until, maxResultsPerPage: PAGE_SIZE,
          includedData: INCLUDED_DATA, paginationToken: token || undefined }, { onTransientRetry: () => { t.transientRetries += 1; } });
      } catch (err) {
        // A page token Amazon no longer accepts: the same window again from its first page (idempotent), once per run.
        if (err.paginationTokenRejected && token && !pageRestarted) { pageRestarted = true; token = null; t.restarts += 1; restarted = 'page token rejected'; continue; }
        // Still throttled after the client's waits: end this run partial (its saved cursor and window stand) and let the
        // chain continue after the allowance refills — unless Amazon has refused every page several runs in a row.
        if (err.throttled) {
          // Only runs that ended throttled without a single page count; a run that processed a page resets it.
          throttleStreak = pages ? 0 : throttleStreak + 1;
          if (throttleStreak >= MAX_THROTTLED_RUNS) {
            throw Object.assign(new Error(`Amazon kept throttling searchOrders (${throttleStreak} runs in a row without a page). Try again later; the sync continues where it stopped.`), { throttled: true });
          }
          endedBy = 'throttled';
          break;
        }
        throw err;
      }
      pages += 1;
      throttleStreak = 0;
      const mapped = [];
      for (const raw of Array.isArray(page?.orders) ? page.orders : []) {
        const m = mapAmazonOrder(raw);
        if (m.error) errors.push({ amazonOrderId: m.source_order_id || null, reason: m.error });
        else mapped.push(m);
      }
      t.fetched += (page?.orders || []).length;
      if (mapped.length) {
        const r = await inTransaction((c) => applyPage(c, mapped, { actor, runId }));
        t.created += r.created; t.updated += r.updated; t.unchanged += r.unchanged;
        t.itemsCreated += r.itemsCreated; t.itemsUpdated += r.itemsUpdated;
        conflicts.push(...r.conflicts); unpriced.push(...r.unpriced);
        await accumulateUnmapped(db, mapped.filter((o) => !r.unpriced.includes(o.source_order_id)), unmappedAcc);
      }
      const next = text(page?.pagination?.nextToken, 4000);
      hasMore = Boolean(next);
      token = next;
      await recordPageProgress(db, runId, { cursor: hasMore ? { token: next, issuedAt: new Date().toISOString() } : null, fetched: t.fetched });
      if (!hasMore || t.fetched >= maxOrders) break;
    }
  } catch (err) {
    await failRun(db, runId, { fetched: t.fetched, created: t.created, updated: t.updated, unchanged: t.unchanged,
      itemsCreated: t.itemsCreated, itemsUpdated: t.itemsUpdated, errorRows: errors.length + 1,
      reportedErrors: [...errors, { reason: String(err.message).slice(0, 300) }].slice(0, MAX_REPORTED),
      details: { failure: String(err.message).slice(0, 300), amazon_requests: t.requests, amazon_transient_retries: t.transientRetries, restarted,
        throttle_streak: throttleStreak } });
    throw err;
  }
  const partial = hasMore;
  const unmapped = [...unmappedAcc.values()].sort((a, b) => b.lines - a.lines);
  const summary = {
    partial, fetched: t.fetched, created: t.created, updated: t.updated, unchanged: t.unchanged, itemsCreated: t.itemsCreated, itemsUpdated: t.itemsUpdated,
    errors: errors.length, conflicts: conflicts.length, unpriced: unpriced.length, unmappedLines: unmapped.reduce((n, u) => n + u.lines, 0),
    restarts: t.restarts, endedBy,
  };
  await completeRun(db, runId, {
    partial, fetched: t.fetched, created: t.created, updated: t.updated, unchanged: t.unchanged, itemsCreated: t.itemsCreated, itemsUpdated: t.itemsUpdated,
    errors: errors.length, reportedErrors: errors.slice(0, MAX_REPORTED), conflicts: conflicts.length, unmappedLines: summary.unmappedLines,
    details: { conflicts: conflicts.slice(0, MAX_REPORTED), unpriced: unpriced.slice(0, MAX_REPORTED), unmapped: unmapped.slice(0, 50),
      amazon_requests: t.requests, amazon_transient_retries: t.transientRetries, restarted, ended_by: endedBy, throttle_streak: endedBy === 'throttled' ? throttleStreak : 0 },
  });
  const next = checkpointAfter(win, { partial, startedAt });
  if (next) await recordSystemEvent(CHECKPOINT_KEY, next);
  return { runId, summary, window: win, errors: errors.slice(0, MAX_REPORTED), conflicts: conflicts.slice(0, MAX_REPORTED), unmapped: unmapped.slice(0, 50) };
}

/* ------------------------------------------------------------------ one at a time, chains */

// One SP-API client per process: its in-memory access token and its searchOrders allowance carry across the runs
// of a chain (and across chains), so run 2 knows run 1 used the burst and waits before page 21.
let shared = null;
let testClient = false;
export function sharedAmazonClient() {
  if (!shared) shared = createAmazonClient();
  return shared;
}
/** Tests only: put a client with a fake transport in place of the process client (null restores the real one). */
export function _setSharedAmazonClientForTest(client) { shared = client; testClient = Boolean(client); }

/**
 * The first sync's start date, checked before anything runs: an ISO timestamp, at least WATERMARK_DELAY_MS in the
 * past and no more than FIRST_RUN_MAX_DAYS back. Returns the ISO string, or throws 400.
 */
export function validInitialSince(value, now = new Date()) {
  const s = String(value ?? '').trim();
  const d = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) ? new Date(s) : null;
  if (!d || Number.isNaN(d.getTime())) throw bad('initial_since must be an ISO timestamp with a time zone, e.g. 2026-09-01T00:00:00+05:30.', 400);
  if (d > new Date(now.getTime() - WATERMARK_DELAY_MS)) throw bad('initial_since must be in the past (at least a few minutes ago).', 400);
  if (now - d > FIRST_RUN_MAX_DAYS * 86400000) throw bad(`initial_since can go back at most ${FIRST_RUN_MAX_DAYS} days.`, 400);
  return d.toISOString();
}

// Amazon's own runner: its own kind, so an Amazon sync never blocks a Shopify one, or the other way round.
const runner = createSyncRunner({
  kind: RUN_KIND, label: 'Amazon',
  busyMessage: 'An Amazon sync is already running. It will finish on its own; check back in a minute.',
});
export const amazonSyncBusy = () => runner.busy();
export const assertNoAmazonSyncRunning = (db = getPool()) => runner.assertNoRunning(db);

/**
 * Starts an incremental chain in the background: a window left partial, failed or cut off is continued (same
 * window); otherwise a new window from the checkpoint. Returns at once; `done` settles when the chain ends.
 */
export async function startAmazonIncrementalSync({ actor = null, client = null, startFrom = null, maxOrders = MAX_ORDERS_PER_RUN, now } = {}) {
  await ensureInventorySchema();
  const db = getPool();
  if (!client && !testClient && !amazonConfigured()) throw bad('Amazon is not connected: the SP-API credentials are not set.', 400);
  await runner.assertNoRunning(db);
  const chain = await runner.chain(db, ['incremental']);
  const tail = chain[chain.length - 1];
  const resumable = tail && (['partial', 'failed'].includes(tail.status)
    || (tail.status === 'running' && Date.now() - new Date(tail.started_at).getTime() > STALE_RUN_MS)) ? Number(tail.id) : null;
  // The start date only ever opens the very first window: once a checkpoint exists, or a window is being
  // continued, it is ignored and the stored window/checkpoint decide everything.
  if (resumable || (await checkpoint())) startFrom = null;
  else if (!startFrom) throw bad(`Amazon has not been synced yet. The first sync needs a start date within the last ${FIRST_RUN_MAX_DAYS} days.`, 409, { needsInitialSince: true });
  else startFrom = validInitialSince(startFrom, now ? new Date(now) : new Date());
  const opts = { actor, client, maxOrders, startFrom, ...(now ? { now } : {}) };
  let first = true;
  const done = runner.launch({
    resumeRunId: resumable, failLabel: 'incremental sync',
    // The chain's first run is this person's start: it gets the full throttle allowance; later runs carry the count on.
    runOnce: ({ resumeRunId }) => { const freshAttempt = first; first = false; return runAmazonSync({ ...opts, resumeRunId, freshAttempt }); },
  });
  return { started: true, mode: 'incremental', resumedFrom: resumable, done };
}

/**
 * The latest incremental chain, for the Orders page Amazon button (polled while running). Never a credential:
 * `connected` is a yes/no, and the last run's ending is given as a word ('throttled', 'allowance', or null).
 */
export async function amazonSyncStatus() {
  await ensureInventorySchema();
  const st = await runner.status(['incremental']);
  const { rows: [last] } = await getPool().query(
    `SELECT status, details->>'ended_by' AS ended_by FROM order_imports WHERE kind = $1 AND channel = $2 ORDER BY id DESC LIMIT 1`, [RUN_KIND, CHANNEL]);
  const ck = await checkpoint();
  return {
    ...st,
    connected: testClient || amazonConfigured(),
    checkpoint: ck,
    needsInitialSince: !ck && !(last && ['partial', 'failed', 'running'].includes(last.status)),
    endedBy: last?.ended_by || null,
    throttled: last?.ended_by === 'throttled' || /throttl/i.test(st.failure || ''),
  };
}
