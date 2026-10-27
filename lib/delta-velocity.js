/**
 * Delta Velocity parcels, mirrored from Shopify into Briyo shipments.
 *
 * Delta Velocity (the shipping aggregator for website orders) books a parcel and writes it to the Shopify order as a
 * fulfilment: the courier (e.g. "delhivery"), the AWB, a tracking link on deltavelocity.in, and later the courier's
 * progress — in transit, out for delivery, delivery attempted, delivered. The Shopify order sync (poll, Sync now,
 * webhook: all runShopifySync) hands each saved page's orders here.
 *
 * Unlike Buy with Amazon (lib/external-shipments.js), these parcels leave Briyo's own warehouse, so they are ordinary
 * Briyo shipments in the stock flow:
 *   - a fulfilment takes over the order's own Briyo shipment when it is the same parcel — the same AWB, or the order's
 *     only shipment, not yet sent and with no AWB — otherwise it becomes a new shipment, Packed;
 *   - the courier's progress moves the shipment forward through applyShipmentUpdate, the rules a person saving it
 *     follows: stock leaves only from reserved batches. When the parcel first leaves (picked up, in transit, out for
 *     delivery, delivered) and its batches are not confirmed, they are reserved for it by FEFO first
 *     (autoReserveShipmentStockTx, as bulk dispatch does; a bundle reserves each product inside it); batches a person
 *     already confirmed are kept while they still fit. When that cannot be done (an unmapped line, not enough stock,
 *     no inventory lines, no courier) nothing is reserved, the status stays where it is and the shipment is listed
 *     under "Courier updates to check";
 *   - delivery attempted / failed, and a booking Delta Velocity cancelled, are flags only: never a status change;
 *   - forward only, and never over a person's Delivery failed / RTO / Cancelled.
 * Anything this cannot place (the order rides in another order's parcel, already has a different parcel, is
 * cancelled) is reported in the sync's skipped list and left alone.
 *
 * Each order is its own transaction, run after the sync page is saved, locked as every shipment path is: the order,
 * then its shipments, then stock — the FEFO reservation's batch locks (lib/orders.js lockOrders). The page's line locks are released by then, so this never
 * waits on a line while holding an order.
 * Identity: (external_source 'shopify', external_fulfillment_id = the Shopify Fulfillment GID), as for Buy with Amazon.
 */
import { inTransaction, logEvent, lockOrders, applyShipmentUpdate, SHIPPED } from './orders.js';
import { isBwaOrder, EXTERNAL_SOURCE } from './external-shipments.js';
import { DV_PROVIDER, courierCheckReason } from './courier-check.js';
import { autoReserveShipmentStockTx } from './inventory.js';

export { DV_PROVIDER, courierCheckReason };

const list = (v, fallback) => String(v ?? fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** Tracking-link hosts that mark a fulfilment as Delta Velocity's (the host itself or any subdomain). */
export const dvHosts = () => list(process.env.DELTA_VELOCITY_TRACKING_HOSTS, 'deltavelocity.in');
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; } };
export const isDvTrackingUrl = (url) => { const h = hostOf(url); return Boolean(h) && dvHosts().some((d) => h === d || h.endsWith(`.${d}`)); };

const GID = /^gid:\/\/shopify\/Fulfillment\/\d+$/;
const up = (s) => (s ? String(s).trim().toUpperCase() : null);

/** Shopify display status → Briyo shipment status. Anything else moves nothing. */
const MOVES = { PICKED_UP: 'in_transit', IN_TRANSIT: 'in_transit', OUT_FOR_DELIVERY: 'out_for_delivery', DELIVERED: 'delivered' };
const RANK = { not_ready: 0, packed: 0, dispatched: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };
const HELD = new Set(['delivery_failed', 'rto', 'cancelled']);
const cancelledInShopify = (f) => up(f.status) === 'CANCELLED' || up(f.display_status) === 'CANCELED';

/** An order's Delta Velocity fulfilments: never a Buy with Amazon order; a Fulfillment GID; a deltavelocity.in link. */
export function dvFulfillments(shopify) {
  if (!shopify || isBwaOrder(shopify)) return [];
  return (shopify.fulfillments || []).filter((f) => GID.test(String(f.id || '')) && (f.tracking || []).some((t) => isDvTrackingUrl(t.url)));
}

const SHIP_SQL = 'SELECT *, expected_delivery_date::text AS expected_delivery_date FROM order_shipments';

/** One fulfilment of a locked order. Adds to `out`. */
async function mirrorOne(client, orderId, f, { actor, out, order }) {
  const t = f.tracking.find((x) => isDvTrackingUrl(x.url));
  const number = t.number ? String(t.number).trim() : null;   // never invented
  const url = String(t.url).trim();
  const carrier = t.company ? String(t.company).trim() : null;
  const skip = (reason) => out.skipped.push({ fulfillment: f.id, order, reason });

  let { rows: [cur] } = await client.query(`${SHIP_SQL} WHERE external_source = $1 AND external_fulfillment_id = $2 FOR UPDATE`, [EXTERNAL_SOURCE, f.id]);
  if (cur && Number(cur.order_id) !== Number(orderId)) return skip('this fulfilment is already a shipment of another order');
  const before = cur ? { status: cur.external_status, display: cur.external_display_status } : { status: null, display: null };

  if (!cur) {
    if (cancelledInShopify(f)) return;   // a booking cancelled before it was mirrored (often already rebooked): nothing to do
    const { rows: [o] } = await client.query('SELECT order_status FROM orders WHERE id = $1', [orderId]);
    if (o.order_status === 'cancelled') return skip('the order is cancelled in Briyo');
    const { rows: rides } = await client.query('SELECT 1 FROM shipment_orders WHERE order_id = $1 AND detached_at IS NULL LIMIT 1', [orderId]);
    if (rides.length) return skip('the order travels in another order\'s parcel');
    const { rows: own } = await client.query(
      `${SHIP_SQL} WHERE order_id = $1 AND shipment_status <> 'cancelled' AND coalesce(external_provider, '') <> 'bwa' ORDER BY id FOR UPDATE`, [orderId]);
    const members = async (id) => (await client.query('SELECT 1 FROM shipment_orders WHERE shipment_id = $1 AND detached_at IS NULL LIMIT 1', [id])).rows.length > 0;
    const sameAwb = (s) => number && String(s.tracking_id || '').trim().toLowerCase() === number.toLowerCase();
    // A booking Delta Velocity cancelled and then rebooked: the new fulfilment takes over the same shipment.
    const rebooked = own.find((s) => s.external_provider === DV_PROVIDER && up(s.external_status) === 'CANCELLED' && !SHIPPED.has(s.shipment_status));
    const mine = own.filter((s) => !s.external_fulfillment_id);
    let take = rebooked || mine.find(sameAwb)
      || (own.length === 1 && mine.length === 1 && !mine[0].tracking_id && !SHIPPED.has(mine[0].shipment_status) ? mine[0] : null);
    if (!take && own.some((s) => s.external_provider === DV_PROVIDER)) return skip('the order already has a Delta Velocity parcel');
    if (!take && own.length) return skip(`the order already has a shipment${own[0].tracking_id ? ` with AWB ${own[0].tracking_id}` : ''}; link it by hand`);
    if (take && await members(take.id)) return skip('the matching shipment is shared with other orders');
    if (take) {
      const { rows: [s] } = await client.query(
        `UPDATE order_shipments SET external_source = $2, external_provider = $3, external_fulfillment_id = $4, external_carrier = $5,
           external_status = NULL, external_display_status = NULL, external_updated_at = NULL
         WHERE id = $1 RETURNING *, expected_delivery_date::text AS expected_delivery_date`,
        [take.id, EXTERNAL_SOURCE, DV_PROVIDER, f.id, carrier]);
      cur = s;
      out.linked += 1;
      await logEvent(client, orderId, 'external_shipment_linked', actor, {
        provider: DV_PROVIDER, fulfillment: f.id, fulfillment_name: f.name || null, carrier, tracking_id: number, shipment_id: Number(s.id),
        ...(rebooked ? { rebooked_from: take.external_fulfillment_id } : {}) });
    } else {
      const { rows: [s] } = await client.query(
        `INSERT INTO order_shipments (order_id, shipment_status, external_source, external_provider, external_fulfillment_id, external_carrier, created_by, updated_by)
         VALUES ($1, 'packed', $2, $3, $4, $5, $6, $6)
         ON CONFLICT (external_source, external_fulfillment_id) WHERE external_fulfillment_id IS NOT NULL DO NOTHING
         RETURNING *, expected_delivery_date::text AS expected_delivery_date`,
        [orderId, EXTERNAL_SOURCE, DV_PROVIDER, f.id, carrier, actor]);
      if (!s) return skip('mirrored a moment ago by another sync');
      cur = s;
      out.created += 1;
      await logEvent(client, orderId, 'external_shipment_mirrored', actor, {
        provider: DV_PROVIDER, fulfillment: f.id, fulfillment_name: f.name || null, carrier, tracking_id: number, status: 'packed', shipment_id: Number(s.id) });
    }
  }

  // The courier, AWB and link follow Delta Velocity (a value is never blanked; a courier someone chose is kept).
  const ident = {};
  if (number && number !== cur.tracking_id) ident.tracking_id = number;
  if (url !== cur.tracking_url) ident.tracking_url = url;
  if (!cur.courier_partner_id && carrier) {
    const { rows: [cp] } = await client.query('SELECT id FROM courier_partners WHERE lower(name) = lower($1) ORDER BY active DESC, id LIMIT 1', [carrier]);
    if (cp) ident.courier_partner_id = cp.id;
  }
  let moved = false;
  if (Object.keys(ident).length) {
    moved = (await applyShipmentUpdate(client, orderId, cur, ident, {}, actor)).changed || moved;
    ({ rows: [cur] } = await client.query(`${SHIP_SQL} WHERE id = $1`, [cur.id]));
  }

  // Progress: forward only, through the same rules (and stock) as a person saving the status. A parcel leaving with no
  // confirmed batches has them reserved by FEFO first; a refusal (short, unmapped, no lines) undoes both.
  let held = null;
  const want = cancelledInShopify(f) ? null : MOVES[up(f.display_status)];
  if (want && !HELD.has(cur.shipment_status) && RANK[want] > (RANK[cur.shipment_status] ?? 99)) {
    const next = { shipment_status: want };
    if (!cur.dispatch_date && (f.in_transit_at || f.created_at)) next.dispatch_date = f.in_transit_at || f.created_at;
    const input = want === 'delivered' && f.delivered_at ? { delivered_at: f.delivered_at } : {};
    if (input.delivered_at) next.delivered_at = input.delivered_at;
    await client.query('SAVEPOINT dv_status');
    try {
      if (SHIPPED.has(want) && !SHIPPED.has(cur.shipment_status) && cur.courier_partner_id && cur.tracking_id) {
        await autoReserveShipmentStockTx(client, cur.id, { actor, source: 'delta_velocity' });
      }
      moved = (await applyShipmentUpdate(client, orderId, cur, next, input, actor)).changed || moved;
      await client.query('RELEASE SAVEPOINT dv_status');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      await client.query('ROLLBACK TO SAVEPOINT dv_status');
      held = err.message;
    }
    ({ rows: [cur] } = await client.query(`${SHIP_SQL} WHERE id = $1`, [cur.id]));
  }

  const ext = { status: up(f.status), display: up(f.display_status), updated: f.updated_at || f.created_at || null };
  if (ext.status !== cur.external_status || ext.display !== cur.external_display_status || carrier !== cur.external_carrier) {
    ({ rows: [cur] } = await client.query(
      `UPDATE order_shipments SET external_carrier = $2, external_status = $3, external_display_status = $4, external_updated_at = $5
       WHERE id = $1 RETURNING *, expected_delivery_date::text AS expected_delivery_date`, [cur.id, carrier, ext.status, ext.display, ext.updated]));
  }
  if (moved) out.updated += 1;
  // A person is needed: recorded once per change of Delta Velocity's state, not on every poll.
  const reason = courierCheckReason(cur);
  if (reason && (before.status !== ext.status || before.display !== ext.display)) {
    out.flagged += 1;
    await logEvent(client, orderId, 'courier_update_to_check', actor, {
      provider: DV_PROVIDER, fulfillment: f.id, shipment_id: Number(cur.id), reason, courier_status: ext.display, shipment_status: cur.shipment_status,
      ...(held ? { not_applied: held } : {}) });
  }
}

/**
 * Mirrors the Delta Velocity fulfilments of a saved sync page: entries are { orderId, shopify }.
 * Returns { created, linked, updated, flagged, skipped: [{ fulfillment, order, reason }] }.
 */
export async function mirrorDeltaVelocity(entries, { actor }) {
  const out = { created: 0, linked: 0, updated: 0, flagged: 0, skipped: [] };
  for (const { orderId, shopify } of entries) {
    const fs = dvFulfillments(shopify);
    if (!fs.length) continue;
    try {
      await inTransaction(async (client) => {
        await lockOrders(client, [orderId]);   // order, then its shipments, then stock — as every shipment path
        for (const f of fs) await mirrorOne(client, orderId, f, { actor, out, order: shopify.name || null });
      });
    } catch (err) {
      // One order's failure never stops the page: it is reported, and the next sync tries again.
      out.skipped.push({ fulfillment: null, order: shopify.name || null, reason: `error: ${String(err.message).slice(0, 200)}` });
      console.error(`Delta Velocity mirror failed for ${shopify.name || orderId}:`, String(err.message).slice(0, 200));
    }
  }
  return out;
}
