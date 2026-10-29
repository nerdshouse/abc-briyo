import { getPool } from './db.js';
import { readTable } from './amazon-import.js';
import { inTransaction, logEvent, applyShipmentUpdate, listCouriers, SHIPPED } from './orders.js';
import { ensureInventorySchema, autoReserveShipmentStockTx, sellableStockBySku, expandBundles, INVENTORY_ELIGIBLE_SQL, NO_INVENTORY_LINES } from './inventory.js';
import { LINE_UNITS_SQL } from './line-units.js';
import { isBwaOrder, BWA_PROVIDER } from './external-shipments.js';
import { DV_PROVIDER } from './courier-check.js';

/**
 * Bulk dispatch — orders of one channel that are already in Briyo, one AWB each: Amazon Easy Ship orders (from the
 * order report import), or website orders (synced from Shopify, or entered by hand) sent with our own couriers.
 *
 * The file is one row per order: the order id and its AWB, with an optional courier per row (otherwise the courier
 * chosen on screen). Each order goes out in its own parcel, so one AWB is never shared by two orders.
 *
 * Website order ids are the Shopify order number, with or without its "#": a synced order keeps it in
 * source_payload.shopify.name (its source_order_id is the Shopify GID), an order entered by hand in source_order_id.
 * A Buy with Amazon order (Amazon ships it, from Amazon's stock) and an order Delta Velocity already carries are
 * refused: their parcels are mirrored from Shopify, never dispatched here.
 *
 * Preview reads only: it checks every row against the orders, their shipments and the stock, and shares the free
 * stock out in file order, so it names the rows that would run short. Dispatch then takes the checked rows a few at a
 * time; each order is its own transaction — shipment created (or the order's untouched one filled), stock reserved
 * by FEFO, marked dispatched, stock deducted — through the same rules as dispatching by hand. A row that fails
 * changes nothing and the others carry on. Running the same file again is safe: an order already dispatched with
 * that AWB is reported as such and left alone.
 */

export const MAX_ROWS = 2000;
export const MAX_COMMIT_ROWS = 25;
const SOURCE = 'bulk_dispatch';

/** The channels a file can be for, and how their orders are named in reasons. */
const CHANNELS = {
  amazon: { name: 'Amazon', missing: 'No Amazon order with this number. Import the order report first.' },
  website: { name: 'website', missing: 'No website order with this number. Sync the Shopify orders first, or check the number.' },
};
export const DEFAULT_CHANNEL = 'amazon';
/** The key an order id is matched on: a website number with or without its "#" is the same order. */
const orderKey = (channel, id) => (channel === 'website' ? cell(id).replace(/^#+/, '').trim().toLowerCase() : cell(id));

/** The chosen channel, checked against the sales channels. */
async function resolveChannel(key) {
  const k = cell(key).toLowerCase() || DEFAULT_CHANNEL;
  if (!CHANNELS[k]) throw bad(`Bulk dispatch is for ${Object.values(CHANNELS).map((c) => c.name).join(' or ')} orders.`);
  const { rows: [ch] } = await getPool().query('SELECT key, label FROM sales_channels WHERE key = $1', [k]);
  if (!ch) throw bad(`Unknown sales channel "${k}".`);
  return { key: k, label: ch.label, ...CHANNELS[k] };
}

const COLUMNS = {
  order: ['order-id', 'amazon-order-id', 'order-number', 'order-no', 'order-name', 'order'],
  awb: ['awb', 'awb-number', 'awb-no', 'tracking-id', 'tracking-number', 'tracking-no', 'tracking'],
  courier: ['courier', 'courier-partner', 'courier-name', 'carrier', 'carrier-name'],
};
const headerKey = (h) => String(h ?? '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_]+/g, '-');
const cell = (v) => String(v ?? '').trim();
const lower = (v) => cell(v).toLowerCase();
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** The rows of the file, checked on their own and against each other. Pure: no database. */
export function planSheet(table, couriers, defaultCourierId, { channel = DEFAULT_CHANNEL } = {}) {
  const start = table.findIndex((r) => r.some((v) => cell(v)));
  if (start < 0) throw bad('The file is empty.');
  const headers = table[start].map(headerKey);
  const col = (names) => headers.findIndex((h) => names.includes(h));
  const at = { order: col(COLUMNS.order), awb: col(COLUMNS.awb), courier: col(COLUMNS.courier) };
  if (at.order < 0 || at.awb < 0) {
    throw bad('The file needs an "order-id" column and an "awb" column (tracking-id also works). Download the template to see the layout.');
  }
  const byName = new Map(couriers.map((c) => [lower(c.name), c]));
  const fallback = couriers.find((c) => c.id === Number(defaultCourierId)) || null;

  const rows = [];
  for (let i = start + 1; i < table.length; i++) {
    const r = table[i];
    if (!r.some((v) => cell(v))) continue;
    const row = { row: i + 1, orderId: cell(r[at.order]), awb: cell(r[at.awb]), courierName: at.courier >= 0 ? cell(r[at.courier]) : '' };
    const fail = (reason) => { row.status = 'error'; row.reason = reason; };
    const courier = row.courierName ? byName.get(lower(row.courierName)) : fallback;
    row.courierId = courier?.id ?? null;
    row.courier = courier?.name ?? (row.courierName || null);
    if (!orderKey(channel, row.orderId)) fail('No order id.');
    else if (!row.awb) fail('No AWB.');
    else if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(row.awb)) fail(`The AWB "${row.awb}" was turned into a number by Excel. Format the column as text and export again.`);
    else if (row.awb.length > 80) fail('The AWB is longer than 80 characters.');
    else if (row.courierName && !courier) fail(`Unknown courier "${row.courierName}". Use one of: ${couriers.map((c) => c.name).join(', ')}.`);
    else if (!courier) fail('Choose the courier (on screen, or in a courier column).');
    rows.push(row);
  }
  if (!rows.length) throw bad('The file has a header but no rows.');
  if (rows.length > MAX_ROWS) throw bad(`The file has ${rows.length} rows; up to ${MAX_ROWS} can be dispatched at once. Split it into smaller files.`);

  // Against each other: the same order and AWB twice is one parcel listed twice (the repeat is skipped); one order
  // with two AWBs, or one AWB on two orders, cannot be told apart from a typo, so every such row is refused.
  const ok = rows.filter((r) => !r.status);
  const seen = new Map();
  for (const r of ok) {
    const key = `${lower(orderKey(channel, r.orderId))}|${lower(r.awb)}`;
    if (seen.has(key)) { r.status = 'duplicate'; r.reason = `Repeats row ${seen.get(key)}.`; } else seen.set(key, r.row);
  }
  const live = ok.filter((r) => !r.status);
  const group = (key) => {
    const m = new Map();
    for (const r of live) m.set(key(r), [...(m.get(key(r)) || []), r]);
    return [...m.values()].filter((g) => g.length > 1);
  };
  for (const g of group((r) => lower(orderKey(channel, r.orderId)))) {
    for (const r of g) { r.status = 'error'; r.reason = `This order is in the file more than once with different AWBs (rows ${g.map((x) => x.row).join(', ')}).`; }
  }
  for (const g of group((r) => `${r.courierId}|${lower(r.awb)}`)) {
    for (const r of g) if (!r.status) { r.status = 'error'; r.reason = `AWB ${r.awb} is on more than one order in the file (rows ${g.map((x) => x.row).join(', ')}). Each order needs its own AWB.`; }
  }
  return rows;
}

/** The checks one order must pass, shared by the preview (read only) and the dispatch (rows locked). */
function shipmentProblem(order, own, shared, r, channel) {
  if (!order) return { reason: channel.missing };
  if (order.ambiguous) return { reason: `More than one ${channel.name} order has this number (${order.ambiguous.join(', ')}). Dispatch it from the order.` };
  if (order.order_status === 'cancelled') return { reason: 'This order is cancelled.' };
  if (isBwaOrder({ tags: Array.isArray(order.shopify_tags) ? order.shopify_tags : [] }) || own.some((s) => s.external_provider === BWA_PROVIDER)) {
    return { reason: 'This is a Buy with Amazon order: Amazon ships it from its own stock, and its parcel comes from Shopify.' };
  }
  const dv = own.find((s) => s.external_provider === DV_PROVIDER);
  if (dv) return { reason: `Delta Velocity already carries this order${dv.tracking_id ? ` (AWB ${dv.tracking_id})` : ''}; its parcel comes from Shopify. Check it on the order.` };
  if (shared) {
    if (lower(shared.tracking_id) === lower(r.awb) && SHIPPED.has(shared.shipment_status)) return { already: true };
    return { reason: `This order travels in a shared parcel${shared.tracking_id ? ` (AWB ${shared.tracking_id})` : ''}. Dispatch it from the order.` };
  }
  const same = own.find((s) => lower(s.tracking_id) === lower(r.awb));
  if (same && SHIPPED.has(same.shipment_status)) return { already: true, shipment: same };
  const blank = own.find((s) => !s.courier_partner_id && !cell(s.tracking_id) && s.shipment_status === 'not_ready');
  const other = own.find((s) => s !== same && s !== blank);
  if (other) {
    return { reason: `This order already has a shipment with ${other.tracking_id ? `AWB ${other.tracking_id}` : 'no AWB'} (${other.shipment_status.replace(/_/g, ' ')}). Correct that shipment on the order instead.` };
  }
  if (same && same.courier_partner_id && Number(same.courier_partner_id) !== Number(r.courierId)) {
    return { reason: `This order's shipment with AWB ${r.awb} has another courier. Correct it on the order, or fix the courier in the file.` };
  }
  return { shipment: same || blank || null };
}

const ORDER_SQL = `SELECT o.id, o.source_order_id, o.order_status, ${INVENTORY_ELIGIBLE_SQL('o')} AS eligible,
  o.source_payload->'shopify'->>'name' AS shopify_name, o.source_payload->'shopify'->'tags' AS shopify_tags FROM orders o`;
/** The orders a list of keys (orderKey) can mean, in this channel. $1 is the channel, $2 the keys. */
const MATCH_SQL = (channel) => (channel === 'website'
  ? `o.channel = $1 AND (lower(ltrim(o.source_order_id, '#')) = ANY($2) OR lower(ltrim(o.source_payload->'shopify'->>'name', '#')) = ANY($2))`
  : 'o.channel = $1 AND o.source_order_id = ANY($2)');
/** How an order is named to people: its Shopify number when it has one. */
const NUMBER_SQL = `coalesce(o.source_payload->'shopify'->>'name', o.source_order_id)`;
const numberOf = (o) => o.shopify_name || o.source_order_id;

/** The matching orders by key; a key two orders share stands for neither (the row is refused). */
function ordersByKey(channel, orders) {
  const m = new Map();
  for (const o of orders) {
    const keys = new Set([orderKey(channel, o.source_order_id), ...(o.shopify_name ? [orderKey(channel, o.shopify_name)] : [])]);
    for (const k of keys) m.set(k, [...(m.get(k) || []), o]);
  }
  return (key) => {
    const list = m.get(key) || [];
    return list.length > 1 ? { ambiguous: list.map(numberOf) } : list[0] || null;
  };
}
const SHIPMENTS_SQL = `SELECT s.*, s.expected_delivery_date::text AS expected_delivery_date FROM order_shipments s`;
const SHARED_SQL = `SELECT m.order_id, s.id, s.tracking_id, s.shipment_status FROM shipment_orders m JOIN order_shipments s ON s.id = m.shipment_id
  WHERE m.detached_at IS NULL AND s.shipment_status <> 'cancelled'`;

/**
 * Preview: what dispatching the file would do, row by row. Writes nothing and locks nothing. Free stock is shared
 * out in file order, so when a SKU runs short the rows that would miss out are named.
 */
export async function previewBulkDispatch(buffer, filename, { courierId, channel: channelKey } = {}) {
  await ensureInventorySchema();
  const channel = await resolveChannel(channelKey);
  const couriers = await listCouriers();
  const rows = planSheet(readTable(buffer, filename), couriers, courierId, { channel: channel.key });
  const live = rows.filter((r) => !r.status);
  const db = getPool();
  const keys = [...new Set(live.map((r) => orderKey(channel.key, r.orderId)))];
  const { rows: orders } = await db.query(`${ORDER_SQL} WHERE ${MATCH_SQL(channel.key)}`, [channel.key, keys]);
  const orderOf = ordersByKey(channel.key, orders);
  const ids = orders.map((o) => o.id);
  const [{ rows: ships }, { rows: shared }, { rows: rawLines }, { rows: taken }] = [
    await db.query(`${SHIPMENTS_SQL} WHERE s.order_id = ANY($1) AND s.shipment_status <> 'cancelled' ORDER BY s.id`, [ids]),
    await db.query(`${SHARED_SQL} AND m.order_id = ANY($1)`, [ids]),
    await db.query(
      `SELECT oi.order_id, oi.sku_id, oi.sku AS code, oi.quantity * ${LINE_UNITS_SQL} AS units, s.sku, s.track_inventory
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN skus s ON s.id = oi.sku_id
       WHERE oi.order_id = ANY($1) AND oi.quantity > 0`, [ids]),
    // AWBs already on another order's live shipment, at the courier the file gives them.
    await db.query(
      `SELECT s.order_id, s.courier_partner_id, lower(s.tracking_id) AS awb, ${NUMBER_SQL} AS source_order_id FROM order_shipments s JOIN orders o ON o.id = s.order_id
       WHERE s.shipment_status <> 'cancelled' AND lower(s.tracking_id) = ANY($1)`, [[...new Set(live.map((r) => lower(r.awb)))]]),
  ];
  // A bundle line needs its contents (as at dispatch), each in master-SKU units.
  const lines = await expandBundles(db, rawLines.map((l) => ({ ...l, units: Number(l.units) })));
  // Stock a matching packed shipment already holds counts towards its own order.
  const holdIds = ships.map((s) => s.id);
  const { rows: held } = await db.query(
    `SELECT shipment_id, sku_id, sum(quantity)::int AS q FROM inventory_reservations WHERE status = 'active' AND shipment_id = ANY($1) GROUP BY shipment_id, sku_id`, [holdIds]);
  const free = await sellableStockBySku(db, lines.filter((l) => l.sku_id).map((l) => l.sku_id));
  const freeAtStart = new Map(free);
  const skuTotals = new Map();

  for (const r of live) {
    const order = orderOf(orderKey(channel.key, r.orderId));
    const own = order?.id ? ships.filter((s) => s.order_id === order.id) : [];
    const sh = order?.id ? shared.find((s) => s.order_id === order.id) : null;
    const check = shipmentProblem(order, own, sh, r, channel);
    if (check.already) { r.status = 'already'; r.reason = 'Already dispatched with this AWB.'; continue; }
    if (check.reason) { r.status = 'error'; r.reason = check.reason; continue; }
    const dup = taken.find((t) => t.order_id !== order.id && Number(t.courier_partner_id) === Number(r.courierId) && t.awb === lower(r.awb));
    if (dup) { r.status = 'error'; r.reason = `AWB ${r.awb} is already used by order ${dup.source_order_id}'s shipment with this courier.`; continue; }

    r.units = 0;
    if (!order.eligible) { r.status = 'ready'; r.note = 'Before the stock cutover: no stock is deducted.'; continue; }
    const mine = lines.filter((l) => l.order_id === order.id);
    const unmapped = mine.filter((l) => !l.sku_id && cell(l.code));
    if (unmapped.length) { r.status = 'error'; r.reason = `${channel.label} SKU ${unmapped.map((l) => l.code).join(', ')} is not mapped to a Briyo SKU. Map it in Inventory → Unmapped SKUs.`; continue; }
    const stocked = mine.filter((l) => l.sku_id && l.track_inventory !== false);
    if (!mine.some((l) => l.sku_id)) { r.status = 'error'; r.reason = NO_INVENTORY_LINES; continue; }
    const need = new Map();
    for (const l of stocked) need.set(l.sku_id, { sku: l.sku, units: (need.get(l.sku_id)?.units || 0) + Number(l.units) });
    const hold = check.shipment ? held.filter((h) => h.shipment_id === check.shipment.id) : [];
    const short = [];
    for (const [skuId, n] of need) {
      const fromHold = Math.min(hold.find((h) => h.sku_id === skuId)?.q || 0, n.units);
      if (n.units - fromHold > (free.get(skuId) || 0)) short.push(`${n.sku} (needs ${n.units - fromHold}, ${free.get(skuId) || 0} left)`);
    }
    for (const [skuId, n] of need) {
      const t = skuTotals.get(skuId) || { sku: n.sku, needed: 0, available: (freeAtStart.get(skuId) || 0) + held.filter((h) => h.sku_id === skuId).reduce((s, h) => s + h.q, 0), short: 0 };
      t.needed += n.units;
      if (short.length) t.short += n.units;
      skuTotals.set(skuId, t);
    }
    if (short.length) { r.status = 'error'; r.reason = `Not enough stock: ${short.join('; ')}.`; continue; }
    for (const [skuId, n] of need) {
      const fromHold = Math.min(hold.find((h) => h.sku_id === skuId)?.q || 0, n.units);
      free.set(skuId, (free.get(skuId) || 0) - (n.units - fromHold));
    }
    r.units = [...need.values()].reduce((s, n) => s + n.units, 0);
    r.status = 'ready';
  }

  const by = (s) => rows.filter((r) => r.status === s);
  return {
    filename: filename || null,
    channel: channel.key,
    summary: {
      rows: rows.length, ready: by('ready').length, already: by('already').length,
      duplicates: by('duplicate').length, errors: by('error').length,
      units: by('ready').reduce((s, r) => s + (r.units || 0), 0),
    },
    stock: [...skuTotals.values()].sort((a, b) => b.short - a.short || a.sku.localeCompare(b.sku)),
    rows: rows.map(({ row, orderId, awb, courierId, courier, status, reason, note, units }) => ({ row, orderId, awb, courierId, courier, status, reason: reason || null, note: note || null, units: units ?? null })),
  };
}

/** One order: shipment, FEFO reservation, dispatch and deduction, in the caller's transaction. */
async function dispatchRowTx(client, r, { actor, filename, channel }) {
  // Lock order (see lockOrders in orders.js): the order, its shipment rows, the stock rows, then the AWB lock.
  const key = orderKey(channel.key, r.orderId);
  const { rows: found } = await client.query(`${ORDER_SQL} WHERE ${MATCH_SQL(channel.key)} ORDER BY o.id FOR UPDATE OF o`, [channel.key, [key]]);
  const order = ordersByKey(channel.key, found)(key);
  return dispatchLockedOrderTx(client, order, r, { actor, channel, event: { source: SOURCE, file: filename || null } });
}

/**
 * The shared step of bulk dispatch and the order's own Dispatch button: `order` is already locked (or null when it
 * was not found). Same refusals, same FEFO reservation, same AWB rule, same dispatch.
 */
async function dispatchLockedOrderTx(client, order, r, { actor, channel, event }) {
  const own = order?.id ? (await client.query(`${SHIPMENTS_SQL} WHERE s.order_id = $1 AND s.shipment_status <> 'cancelled' ORDER BY s.id FOR UPDATE OF s`, [order.id])).rows : [];
  const shared = order?.id ? (await client.query(`${SHARED_SQL} AND m.order_id = $1 LIMIT 1`, [order.id])).rows[0] : null;
  const check = shipmentProblem(order, own, shared, r, channel);
  if (check.already) return { status: 'already', orderDbId: Number(order.id), shipmentId: check.shipment ? Number(check.shipment.id) : null };
  if (check.reason) throw bad(check.reason, 409);

  let ship = check.shipment;
  if (!ship) {
    const { rows } = await client.query(
      `INSERT INTO order_shipments (order_id, created_by, updated_by) VALUES ($1, $2, $2)
       RETURNING *, expected_delivery_date::text AS expected_delivery_date`, [order.id, actor]);
    ship = rows[0];
    await logEvent(client, order.id, 'shipment_created', actor, { shipment_id: Number(ship.id), ...event });
  }
  await autoReserveShipmentStockTx(client, ship.id, { actor });

  // One AWB is one parcel at its courier — the same check, under the same lock, as Edit shipment.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('order_shipments:awb'), hashtext($1::text || ':' || lower($2)))`, [String(r.courierId), r.awb]);
  const { rows: [dup] } = await client.query(
    `SELECT ${NUMBER_SQL} AS source_order_id FROM order_shipments s JOIN orders o ON o.id = s.order_id
     WHERE s.id <> $1 AND s.courier_partner_id = $2 AND lower(s.tracking_id) = lower($3) AND s.shipment_status <> 'cancelled' LIMIT 1`,
    [ship.id, r.courierId, r.awb]);
  if (dup) throw bad(`AWB ${r.awb} is already used by order ${dup.source_order_id}'s shipment with this courier.`, 409, { duplicateAwb: true });

  const next = { courier_partner_id: Number(r.courierId), tracking_id: r.awb, shipment_status: 'dispatched' };
  const { stock } = await applyShipmentUpdate(client, order.id, ship, next, {}, actor);
  return { status: 'dispatched', orderDbId: Number(order.id), shipmentId: Number(ship.id), units: stock?.deducted || 0 };
}

/**
 * Dispatch: a few rows from the preview (the browser sends them in turn, so no request runs long). Every row is
 * checked again, inside its own transaction; a refusal rolls back that row only.
 */
export async function commitBulkDispatch(input, { actor } = {}) {
  const list = Array.isArray(input?.rows) ? input.rows : [];
  if (!list.length) throw bad('No rows to dispatch.');
  if (list.length > MAX_COMMIT_ROWS) throw bad(`Send at most ${MAX_COMMIT_ROWS} rows at a time.`);
  const filename = cell(input.filename).slice(0, 200) || null;
  await ensureInventorySchema();
  const channel = await resolveChannel(input.channel);
  const couriers = new Set((await listCouriers()).map((c) => Number(c.id)));
  const results = [];
  for (const x of list) {
    const r = { row: Number(x?.row) || null, orderId: cell(x?.orderId).slice(0, 100), awb: cell(x?.awb).slice(0, 80), courierId: Number(x?.courierId) };
    try {
      if (!r.orderId || !r.awb) throw bad('No order id or AWB.');
      if (!couriers.has(r.courierId)) throw bad('Unknown courier.');
      const out = await inTransaction((client) => dispatchRowTx(client, r, { actor, filename, channel }));
      results.push({ ...r, ...out });
    } catch (err) {
      if (!err.status || err.status >= 500) console.error(`Bulk dispatch row ${r.row} (${r.orderId}):`, err);
      results.push({ ...r, status: 'error', reason: err.status && err.status < 500 ? err.message : 'Something went wrong with this row. Nothing was saved for it.' });
    }
  }
  return { results };
}

/**
 * The order's own Dispatch button: one order, its courier and AWB — shipment created, stock reserved by FEFO,
 * marked dispatched and deducted, in one transaction. The same rules as a bulk dispatch row (dispatchLockedOrderTx):
 * Buy with Amazon and Delta Velocity orders, cancelled orders, orders already shipped another way, unmapped
 * products and short stock are refused, and nothing changes.
 */
export async function dispatchOrder(orderId, input = {}, { actor } = {}) {
  const id = /^\d+$/.test(String(orderId ?? '')) ? Number(orderId) : null;
  if (!id) throw bad('No such order.', 404);
  const awb = cell(input.tracking_id);
  if (!awb) throw bad('Enter the AWB / tracking ID.', 400, { field: 'tracking_id' });
  if (awb.length > 80) throw bad('The AWB is longer than 80 characters.', 400, { field: 'tracking_id' });
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(awb)) throw bad('That AWB looks like a number Excel rounded. Copy it from the courier again.', 400, { field: 'tracking_id' });
  const courierId = Number(input.courier_partner_id);
  await ensureInventorySchema();
  if (!(await listCouriers()).some((c) => Number(c.id) === courierId)) throw bad('Choose the courier.', 400, { field: 'courier_partner_id' });
  return inTransaction(async (client) => {
    const { rows: [order] } = await client.query(`${ORDER_SQL} WHERE o.id = $1 FOR UPDATE OF o`, [id]);
    if (!order) throw bad('No such order.', 404);
    const { rows: [ch] } = await client.query('SELECT s.key, s.label FROM orders o JOIN sales_channels s ON s.key = o.channel WHERE o.id = $1', [id]);
    const channel = { key: ch?.key, name: ch?.label || 'this', missing: 'No such order.' };
    const out = await dispatchLockedOrderTx(client, order, { orderId: numberOf(order), awb, courierId }, { actor, channel, event: { source: 'order_dispatch' } });
    if (out.status === 'already') throw bad('This order has already been dispatched with that AWB.', 409);
    return out;
  });
}
