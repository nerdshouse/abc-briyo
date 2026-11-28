/**
 * Flipkart orders and stock, through the Seller API (lib/flipkart.js).
 *
 * Orders — every FLIPKART_POLL_MINUTES (default 15), and on demand:
 *   open shipments (APPROVED … READY_TO_DISPATCH, all of them), plus the last `days` of dispatched / delivered and of
 *   cancelled shipments, are read and written into the same `orders` / `order_items` rows the team enters by hand:
 *   channel 'flipkart', source_order_id = Flipkart's order id (OD…), lines keyed by its order item id. So an order typed
 *   in earlier is completed, never duplicated. Rules, as for the Amazon sync:
 *     - a new order is Easy Ship (packed by us, picked up by Flipkart's courier); its value is Σ customer price + shipping;
 *     - lines resolve seller SKU → master SKU through the `flipkart` platform mapping (never guessed);
 *     - an order whose stock is reserved or has left keeps its value and lines; an order that already has products added
 *       by hand never gets Flipkart's lines too (the same units twice) — both are logged on the order instead;
 *     - a cancellation at Flipkart cancels an order with no shipment; with a shipment it is logged for a person;
 *     - Flipkart's courier and tracking id are kept (source_payload.flipkart) for the Dispatch form; no shipment, stock
 *       reservation or movement is ever made here — stock leaves when the team dispatches, as for every channel.
 *   Buyer details: the name and the delivery city / state only (no phone, no street address).
 *
 * Stock — on demand from the Flipkart page, and every poll when FLIPKART_STOCK_SYNC=true:
 *   for each Flipkart seller SKU mapped to an active, stock-tracked master SKU, available ÷ units per listing (a bundle:
 *   how many can be made), less FLIPKART_STOCK_BUFFER, is sent to the listing's location — only when it changed, or
 *   once a day. A Flipkart SKU that is not mapped is never touched.
 */
import { getPool, getSystemState, recordSystemEvent } from './db.js';
import { inTransaction, logEvent } from './orders.js';
import { ensureInventorySchema, resolveSkuIds, listSkus, audit } from './inventory.js';
import { flipkartConfigured, createFlipkartClient } from './flipkart.js';

export const CHANNEL = 'flipkart';
export const SOURCE = 'flipkart_api';
const LAST_SYNC = 'flipkart_orders_last';
const LAST_STOCK = 'flipkart_stock_last';
const PRE = ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH'];
const POST = ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'];
const CANCEL_TYPES = ['marketplaceCancellation', 'sellerCancellation', 'buyerCancellation'];
const SHIPPED_STATUSES = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto'];
const MAX_DAYS = 30;

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (v, max = 300) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : round2(Number(v)));

let shared = null;
let testClient = false;
export function sharedFlipkartClient() { if (!shared) shared = createFlipkartClient(); return shared; }
/** Tests only: a client with a fake transport (null restores the real one). */
export function _setFlipkartClientForTest(c) { shared = c; testClient = Boolean(c); }
const connected = () => testClient || flipkartConfigured();

/* ------------------------------------------------------------------ mapping */

/**
 * Flipkart shipments (+ their details: courier, tracking id, address) → one Briyo order per Flipkart order id. Pure.
 * An order item with no id, or a quantity that is not a whole number, is reported in `errors` and its order skipped.
 */
export function mapFlipkartShipments(shipments, details = []) {
  const det = new Map(details.map((d) => [String(d.shipmentId), d]));
  const byOrder = new Map();
  const errors = [];
  for (const sh of shipments) {
    const sid = text(sh?.shipmentId, 80);
    const d = det.get(String(sid)) || {};
    const sub = Array.isArray(d.subShipments) ? d.subShipments[0] : null;
    const courier = sub?.courierDetails?.deliveryDetails || sub?.courierDetails?.pickupDetails || {};
    const addr = d.deliveryAddress || {};
    for (const it of Array.isArray(sh?.orderItems) ? sh.orderItems : []) {
      const oid = text(it?.orderId, 60);
      const lid = text(it?.orderItemId, 80);
      const qty = Number(it?.quantity);
      if (!oid || !lid || !Number.isInteger(qty) || qty < 0) { errors.push({ orderId: oid, reason: !oid || !lid ? 'an order item has no order id or item id' : `item ${lid}: quantity is not a whole number` }); if (oid) byOrder.set(oid, { error: true }); continue; }
      const o = byOrder.get(oid) || { source_order_id: oid, items: [], shipments: new Set(), statuses: new Set(), dates: [], courier: null, tracking_id: null,
        customer_name: null, city: null, state: null, dispatch_by: null };
      if (o.error) continue;
      const p = it.priceComponents || {};
      o.items.push({ source_line_item_id: lid, sku: text(it.sku, 120), quantity: qty, fsn: text(it.fsn, 40), listing_id: text(it.listingId, 60),
        item_price: num(p.customerPrice), shipping_price: num(p.shippingCharge), status: text(it.status, 30) });
      o.shipments.add(sid);
      if (it.status) o.statuses.add(String(it.status));
      if (it.orderDate) o.dates.push(new Date(it.orderDate).toISOString());
      o.courier = o.courier || text(courier.vendorName, 80);
      o.tracking_id = o.tracking_id || text(courier.trackingId, 80);
      o.customer_name = o.customer_name || text([addr.firstName, addr.lastName].filter(Boolean).join(' '), 120);
      o.city = o.city || text(addr.city, 80);
      o.state = o.state || text(addr.stateName || addr.state, 80);
      o.dispatch_by = o.dispatch_by || text(sh.dispatchByDate, 40);
      byOrder.set(oid, o);
    }
  }
  const orders = [];
  for (const o of byOrder.values()) {
    if (o.error) continue;
    const priced = o.items.length > 0 && o.items.every((x) => x.item_price !== null);
    const statuses = [...o.statuses];
    orders.push({
      source_order_id: o.source_order_id,
      order_date: o.dates.length ? o.dates.sort()[0] : null,
      currency: 'INR',
      order_value: priced ? round2(o.items.reduce((s, x) => s + x.item_price + (x.shipping_price || 0), 0)) : null,
      cancelled: statuses.length > 0 && statuses.every((s) => s === 'CANCELLED'),
      customer_name: o.customer_name,
      items: o.items,
      flipkart: {
        order_id: o.source_order_id, shipment_ids: [...o.shipments], status: statuses.sort().join(',') || null,
        courier: o.courier, tracking_id: o.tracking_id, city: o.city, state: o.state, dispatch_by: o.dispatch_by,
        items: o.items.map((x) => ({ order_item_id: x.source_line_item_id, sku: x.sku, fsn: x.fsn, listing_id: x.listing_id, status: x.status })),
      },
    });
  }
  return { orders, errors };
}

/* ------------------------------------------------------------------ orders */

/** Writes mapped orders in one transaction under the Flipkart lock. Returns counts and what was held back. */
async function applyOrders(client, orders, { actor }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('orders:flipkart'))`);
  const r = { created: 0, updated: 0, unchanged: 0, itemsAdded: 0, itemsUpdated: 0, conflicts: [] };
  const ids = orders.map((o) => o.source_order_id);
  const { rows: existing } = ids.length ? await client.query(
    `SELECT o.id, o.source_order_id, o.order_status, o.order_value, o.customer_name, o.source_payload,
       (EXISTS (SELECT 1 FROM inventory_movements m WHERE m.order_id = o.id AND m.movement_type = 'shipment_dispatched')
        OR EXISTS (SELECT 1 FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_status = ANY($3))
        OR EXISTS (SELECT 1 FROM inventory_reservations rr JOIN order_shipments s ON s.id = rr.shipment_id WHERE rr.status = 'active' AND s.order_id = o.id)) AS locked,
       EXISTS (SELECT 1 FROM order_shipments s WHERE s.order_id = o.id AND s.shipment_status <> 'cancelled'
               AND (s.courier_partner_id IS NOT NULL OR coalesce(s.tracking_id, '') <> '' OR s.shipment_status <> 'not_ready')) AS active,
       EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.source_line_item_id LIKE 'manual:%') AS hand_lines
     FROM orders o WHERE o.channel = $1 AND o.source_order_id = ANY($2) FOR UPDATE OF o`, [CHANNEL, ids, SHIPPED_STATUSES]) : { rows: [] };
  const byId = new Map(existing.map((e) => [e.source_order_id, e]));
  const skuIds = await resolveSkuIds(client, CHANNEL, orders.flatMap((o) => o.items.map((x) => x.sku)));
  const skuIdOf = (x) => (x.sku ? skuIds.get(x.sku.toLowerCase()) ?? null : null);
  const conflict = async (orderId, kind, detail) => {
    const seen = await client.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND event_type = 'flipkart_sync_conflict' AND metadata->>'kind' = $2 LIMIT 1`, [orderId, kind]);
    if (!seen.rows.length) await logEvent(client, orderId, 'flipkart_sync_conflict', actor, { kind, detail });
    r.conflicts.push({ order: orderId, kind });
  };
  for (const o of orders) {
    let cur = byId.get(o.source_order_id);
    let orderId;
    if (!cur) {
      if (o.order_value === null && !o.cancelled) continue;            // no prices yet: created on a later sync
      const { rows: [n] } = await client.query(
        `INSERT INTO orders (channel, dispatch_type, fulfillment_type, source, order_status, source_order_id, order_date, currency, order_value,
                             customer_name, source_payload, created_by, updated_by)
         VALUES ($1, 'easy_ship', 'merchant', $2, $3, $4, $5, 'INR', $6, $7, $8, $9, $9) ON CONFLICT (channel, source_order_id) DO NOTHING RETURNING id`,
        [CHANNEL, SOURCE, o.cancelled ? 'cancelled' : 'new', o.source_order_id, o.order_date, o.order_value, o.customer_name, JSON.stringify({ flipkart: o.flipkart }), actor]);
      if (!n) continue;
      orderId = Number(n.id);
      await logEvent(client, orderId, 'order_created', actor, { source: SOURCE, channel: CHANNEL, source_order_id: o.source_order_id, order_value: o.order_value, items: o.items.length, cancelled: o.cancelled || undefined });
      r.created += 1;
      cur = { id: orderId, locked: false, active: false, hand_lines: false, order_status: o.cancelled ? 'cancelled' : 'new' };
    } else {
      orderId = Number(cur.id);
      const changes = {};
      if (o.order_value !== null && Number(cur.order_value) !== o.order_value) {
        if (cur.locked) await conflict(orderId, 'value_locked', `Flipkart's order value is ${o.order_value}; Briyo keeps ${cur.order_value} because stock was reserved or dispatched.`);
        else changes.order_value = o.order_value;
      }
      if (o.cancelled && cur.order_status !== 'cancelled') {
        if (cur.active || cur.locked) await conflict(orderId, 'cancelled_with_shipment', 'Cancelled at Flipkart, but this order has a shipment in Briyo. Not cancelled automatically.');
        else changes.order_status = 'cancelled';
      }
      if (!cur.customer_name && o.customer_name) changes.customer_name = o.customer_name;
      const payloadChanged = JSON.stringify(cur.source_payload?.flipkart ?? null) !== JSON.stringify(o.flipkart);
      const keys = Object.keys(changes);
      if (keys.length || payloadChanged) {
        await client.query(
          `UPDATE orders SET ${[...keys.map((k, i) => `${k} = $${i + 3}`), `source_payload = coalesce(source_payload, '{}'::jsonb) || $${keys.length + 3}::jsonb`].join(', ')},
             version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
          [orderId, actor, ...keys.map((k) => changes[k]), JSON.stringify({ flipkart: o.flipkart })]);
        if (keys.length) await logEvent(client, orderId, 'flipkart_sync_updated', actor, { changes });
        r.updated += 1;
      } else r.unchanged += 1;
    }
    // Lines: never on an order whose stock is reserved or gone, and never over products someone added by hand.
    if (cur.locked || cur.hand_lines) {
      const { rows: have } = await client.query('SELECT source_line_item_id FROM order_items WHERE order_id = $1', [orderId]);
      const known = new Set(have.map((x) => x.source_line_item_id));
      if (o.items.some((x) => !known.has(x.source_line_item_id))) {
        await conflict(orderId, cur.hand_lines ? 'hand_lines' : 'lines_locked', cur.hand_lines
          ? 'This order already has products added by hand, so Flipkart\'s lines were not added (they would count the same units twice).'
          : 'Flipkart lines changed after stock was reserved or dispatched. Not applied.');
      }
      continue;
    }
    for (const x of o.items) {
      const { rows: [w] } = await client.query(
        `INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, shipping_price, sku_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (order_id, source_line_item_id) DO UPDATE SET sku = EXCLUDED.sku, quantity = EXCLUDED.quantity,
           item_price = coalesce(EXCLUDED.item_price, order_items.item_price), shipping_price = coalesce(EXCLUDED.shipping_price, order_items.shipping_price),
           sku_id = coalesce(EXCLUDED.sku_id, order_items.sku_id), updated_at = now()
         WHERE (order_items.sku, order_items.quantity, order_items.item_price, order_items.shipping_price, order_items.sku_id)
               IS DISTINCT FROM (EXCLUDED.sku, EXCLUDED.quantity, coalesce(EXCLUDED.item_price, order_items.item_price),
                                 coalesce(EXCLUDED.shipping_price, order_items.shipping_price), coalesce(EXCLUDED.sku_id, order_items.sku_id))
         RETURNING (xmax = 0) AS inserted`,
        [orderId, x.source_line_item_id, x.sku, x.sku ? `Flipkart ${x.sku}` : 'Flipkart item', x.quantity, x.item_price, x.shipping_price, skuIdOf(x)]);
      if (w?.inserted) r.itemsAdded += 1; else if (w) r.itemsUpdated += 1;
    }
  }
  return r;
}

let running = false;
export const flipkartSyncBusy = () => running;

/**
 * One orders sync: open shipments, and the last `days` (1–30) of dispatched and cancelled ones. Refused while one
 * runs. The result (counts, unmapped Flipkart SKUs, errors) is kept for the Flipkart page.
 */
export async function syncFlipkartOrders({ days = Number(process.env.FLIPKART_SYNC_DAYS) || 7, actor = 'flipkart-sync', client = null, now = new Date() } = {}) {
  await ensureInventorySchema();
  if (!client && !connected()) throw bad('Flipkart is not connected: FLIPKART_APP_ID and FLIPKART_APP_SECRET are not set.', 400);
  const d = Math.min(Math.max(Math.round(Number(days)) || 7, 1), MAX_DAYS);
  if (running) throw bad('A Flipkart sync is already running. Check back in a minute.', 409);
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const api = client || sharedFlipkartClient();
    const range = { from: new Date(now.getTime() - d * 86400000).toISOString(), to: now.toISOString() };
    const shipments = new Map();
    const add = (list) => { for (const s of list) if (s?.shipmentId) shipments.set(String(s.shipmentId), s); };
    add(await api.searchShipments({ type: 'preDispatch', states: PRE }));
    for (const t of ['NORMAL', 'SELF']) add(await api.searchShipments({ type: 'postDispatch', states: POST, shipmentTypes: [t], orderDate: range }));
    for (const ct of CANCEL_TYPES) add(await api.searchShipments({ type: 'cancelled', states: ['CANCELLED'], cancellationType: ct, cancellationDate: range }));
    const list = [...shipments.values()];
    const details = list.length ? await api.shipmentDetails(list.map((s) => String(s.shipmentId))) : [];
    const { orders, errors } = mapFlipkartShipments(list, details);
    const r = orders.length ? await inTransaction((c) => applyOrders(c, orders, { actor })) : { created: 0, updated: 0, unchanged: 0, itemsAdded: 0, itemsUpdated: 0, conflicts: [] };
    const known = await resolveSkuIds(getPool(), CHANNEL, orders.flatMap((o) => o.items.map((x) => x.sku)));
    const unmapped = new Map();
    for (const x of orders.flatMap((o) => o.items)) {
      const k = String(x.sku || '').toLowerCase();
      if (k && known.has(k)) continue;
      const u = unmapped.get(k) || { code: x.sku, lines: 0 };
      u.lines += 1; unmapped.set(k, u);
    }
    const result = { ok: true, started_at: startedAt, finished_at: new Date().toISOString(), days: d, shipments: list.length, orders: orders.length,
      created: r.created, updated: r.updated, unchanged: r.unchanged, items_added: r.itemsAdded, items_updated: r.itemsUpdated,
      conflicts: r.conflicts.length, errors: errors.slice(0, 50), unmapped: [...unmapped.values()].sort((a, b) => b.lines - a.lines).slice(0, 50) };
    await recordSystemEvent(LAST_SYNC, JSON.stringify(result));
    return result;
  } catch (err) {
    await recordSystemEvent(LAST_SYNC, JSON.stringify({ ok: false, started_at: startedAt, finished_at: new Date().toISOString(), failure: String(err.message).slice(0, 300) })).catch(() => {});
    throw err;
  } finally { running = false; }
}

/* ------------------------------------------------------------------ stock */

let listingSchema = null;
async function ensureListings() {
  await ensureInventorySchema();
  if (!listingSchema) {
    listingSchema = getPool().query(`
      CREATE TABLE IF NOT EXISTS flipkart_listings (
        sku            TEXT PRIMARY KEY,
        product_id     TEXT,
        location_id    TEXT,
        listed_stock   INTEGER,
        checked_at     TIMESTAMPTZ,
        last_qty       INTEGER,
        last_pushed_at TIMESTAMPTZ,
        last_status    TEXT,
        last_error     TEXT
      )`).catch((err) => { listingSchema = null; throw err; });
  }
  return listingSchema;
}

/**
 * What each mapped Flipkart SKU should show: master available (a bundle: how many can be made) ÷ units per listing,
 * less the buffer, never below 0. A SKU mapped to two masters uses the regular mapping (the first one). Reads only.
 */
export async function flipkartStockPlan() {
  await ensureListings();
  const buffer = Math.max(Number(process.env.FLIPKART_STOCK_BUFFER) || 0, 0);
  const { rows: maps } = await getPool().query(
    `SELECT DISTINCT ON (lower(m.platform_sku)) m.platform_sku, m.units_per_listing, m.sku_id
       FROM sku_platform_mappings m WHERE m.platform = $1 ORDER BY lower(m.platform_sku), m.duplicate_override, m.created_at, m.id`, [CHANNEL]);
  const skus = new Map((await listSkus({ includeInactive: false })).map((s) => [s.id, s]));
  const { rows: cached } = await getPool().query('SELECT * FROM flipkart_listings');
  const cache = new Map(cached.map((c) => [c.sku.toLowerCase(), c]));
  return maps.map((m) => {
    const s = skus.get(Number(m.sku_id));
    const c = cache.get(m.platform_sku.toLowerCase()) || {};
    const units = Math.max(Number(m.units_per_listing) || 1, 1);
    const tracked = s && s.track_inventory !== false;
    const avail = !s ? null : s.is_bundle ? s.can_make : s.available;
    const qty = !tracked || avail === null ? null : Math.max(Math.floor(Math.max(avail - buffer, 0) / units), 0);
    return {
      flipkart_sku: m.platform_sku, sku_id: Number(m.sku_id), sku: s?.sku || null, product_name: s?.product_name || null,
      units_per_listing: units, available: avail, qty,
      skip: !s ? 'master SKU inactive' : !tracked ? 'master SKU not stock-tracked' : avail === null ? 'bundle with no tracked contents' : null,
      product_id: c.product_id || null, location_id: c.location_id || null, listed_stock: c.listed_stock ?? null, checked_at: c.checked_at || null,
      last_qty: c.last_qty ?? null, last_pushed_at: c.last_pushed_at || null, last_status: c.last_status || null, last_error: c.last_error || null,
    };
  }).sort((a, b) => a.flipkart_sku.localeCompare(b.flipkart_sku));
}

/**
 * Sends stock to Flipkart for the plan's SKUs: listing details (product id, location) are looked up when missing or a
 * week old; a SKU is sent when its quantity changed since the last send, or the last send is a day old (`force`:
 * every SKU). Per-SKU outcome is kept. Returns counts.
 */
export async function pushFlipkartStock({ client = null, actor = 'flipkart-sync', force = false } = {}) {
  if (!client && !connected()) throw bad('Flipkart is not connected: FLIPKART_APP_ID and FLIPKART_APP_SECRET are not set.', 400);
  const api = client || sharedFlipkartClient();
  const plan = (await flipkartStockPlan()).filter((p) => !p.skip);
  const db = getPool();
  const stale = plan.filter((p) => !p.product_id || !p.location_id || !p.checked_at || Date.now() - new Date(p.checked_at).getTime() > 7 * 86400000);
  if (stale.length) {
    const want = process.env.FLIPKART_LOCATION_ID || null;
    const { available, invalid } = await api.listings(stale.map((p) => p.flipkart_sku));
    const byLower = new Map(Object.entries(available).map(([k, v]) => [k.toLowerCase(), v]));
    for (const p of stale) {
      const l = byLower.get(p.flipkart_sku.toLowerCase());
      const locs = Array.isArray(l?.locations) ? l.locations : [];
      const loc = (want && locs.find((x) => String(x.id) === want)) || locs.find((x) => /enable|active/i.test(String(x.status || ''))) || locs[0] || null;
      p.product_id = text(l?.product_id, 60);
      p.location_id = loc ? text(loc.id, 80) : null;
      const err = !l ? (invalid.some((x) => x.toLowerCase() === p.flipkart_sku.toLowerCase()) ? 'Flipkart has no listing with this SKU' : 'not returned by Flipkart')
        : !p.location_id ? 'the listing has no location' : null;
      await db.query(
        `INSERT INTO flipkart_listings (sku, product_id, location_id, listed_stock, checked_at, last_error) VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (sku) DO UPDATE SET product_id = EXCLUDED.product_id, location_id = EXCLUDED.location_id, listed_stock = EXCLUDED.listed_stock,
           checked_at = now(), last_error = coalesce(EXCLUDED.last_error, flipkart_listings.last_error)`,
        [p.flipkart_sku, p.product_id, p.location_id, loc && Number.isFinite(Number(loc.inventory)) ? Number(loc.inventory) : null, err]);
      if (err) p.lookup_error = err;
    }
  }
  const due = plan.filter((p) => p.product_id && p.location_id && !p.lookup_error
    && (force || p.last_qty !== p.qty || !p.last_pushed_at || Date.now() - new Date(p.last_pushed_at).getTime() > 86400000));
  let sent = 0; let failed = 0;
  if (due.length) {
    const results = await api.updateInventory(Object.fromEntries(due.map((p) => [p.flipkart_sku, { product_id: p.product_id, locations: [{ id: p.location_id, inventory: p.qty }] }])));
    const byLower = new Map(Object.entries(results).map(([k, v]) => [k.toLowerCase(), v]));
    for (const p of due) {
      const res = byLower.get(p.flipkart_sku.toLowerCase());
      const ok = res && String(res.status).toLowerCase() !== 'failure';
      const err = ok ? null : (res?.errors?.[0]?.description || res?.attribute_errors?.[0]?.description || 'No result from Flipkart for this SKU').slice(0, 300);
      if (ok) sent += 1; else failed += 1;
      await db.query(
        `UPDATE flipkart_listings SET last_status = $2, last_error = $3, ${ok ? 'last_qty = $4, last_pushed_at = now(), listed_stock = $4' : 'last_qty = last_qty'} WHERE sku = $1`,
        ok ? [p.flipkart_sku, String(res.status || 'success').toLowerCase(), null, p.qty] : [p.flipkart_sku, 'failure', err]);
    }
  }
  const result = { ok: true, at: new Date().toISOString(), mapped: plan.length, due: due.length, sent, failed, lookup_errors: plan.filter((p) => p.lookup_error).length };
  await recordSystemEvent(LAST_STOCK, JSON.stringify(result));
  if (sent || failed) await inTransaction((c) => audit(c, 'flipkart_stock_sent', { actor, metadata: result }));
  return result;
}

/* ------------------------------------------------------------------ status and timer */

const parse = (row) => { try { return row?.value ? JSON.parse(row.value) : null; } catch { return null; } };

export async function flipkartStatus() {
  await ensureListings();
  return {
    connected: connected(), running, stock_auto: process.env.FLIPKART_STOCK_SYNC === 'true', poll_minutes: pollMinutes(),
    buffer: Math.max(Number(process.env.FLIPKART_STOCK_BUFFER) || 0, 0),
    last_sync: parse(await getSystemState(LAST_SYNC)), last_stock: parse(await getSystemState(LAST_STOCK)),
  };
}

const pollMinutes = () => Math.max(10, Number(process.env.FLIPKART_POLL_MINUTES) || 15);

/** The timer: orders every poll; stock too when FLIPKART_STOCK_SYNC=true. Off when FLIPKART_SYNC_ENABLED=false or not connected. */
export function startFlipkartSync() {
  if (process.env.FLIPKART_SYNC_ENABLED === 'false') { console.log('Flipkart sync: off (FLIPKART_SYNC_ENABLED=false)'); return null; }
  if (!flipkartConfigured()) { console.log('Flipkart sync: off (Flipkart is not connected)'); return null; }
  const tick = async () => {
    try {
      if (running) return;
      const r = await syncFlipkartOrders({ actor: 'flipkart-poll' });
      if (r.created || r.updated || r.conflicts) console.log(`Flipkart orders: ${r.created} new, ${r.updated} changed, ${r.conflicts} conflict(s)`);
      if (process.env.FLIPKART_STOCK_SYNC === 'true') {
        const s = await pushFlipkartStock({ actor: 'flipkart-poll' });
        if (s.sent || s.failed) console.log(`Flipkart stock: ${s.sent} sent, ${s.failed} failed`);
      }
    } catch (err) { console.error('Flipkart sync failed:', String(err.message).slice(0, 200)); }
  };
  const timer = setInterval(tick, pollMinutes() * 60000);
  timer.unref?.();
  setTimeout(tick, 90000).unref?.();
  console.log(`Flipkart sync: orders every ${pollMinutes()} min${process.env.FLIPKART_STOCK_SYNC === 'true' ? ', stock too' : ' (stock: on demand)'}`);
  return timer;
}
