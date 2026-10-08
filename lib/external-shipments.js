/**
 * External fulfilments mirrored into Briyo shipments — Buy with Amazon (BWA) website orders.
 *
 * Amazon fulfils BWA orders from its own stock and reports the parcel to Shopify as a fulfilment. The Shopify
 * order sync (poll, Sync now, webhook — all through applyPage) passes each order's fulfilments here, inside the
 * same transaction and advisory lock, and an eligible one becomes a Briyo shipment so Logistics sees it without
 * anyone clicking "Create shipment".
 *
 * Eligible only when BOTH hold (narrow, configurable):
 *   - the order carries the Shopify tag BWA_ORDER_TAG (default "Buy with Amazon", exact, case-insensitive) —
 *     production orders carry either "Buy with Amazon" or "Non Buy with Amazon";
 *   - the fulfilment's tracking company is one of BWA_CARRIERS (default "Amazon Transportation Services").
 * Anything else stays reference-only in source_payload.shopify.fulfillments, as before.
 *
 * Identity: (external_source 'shopify', external_fulfillment_id = Shopify Fulfillment GID), unique — never the
 * tracking number. One order may have several. Re-syncs update the same row; nothing is duplicated.
 *
 * Never touches stock: no reservation, no movement, no deduction (lib/inventory.js refuses reserve on an external
 * shipment and dispatch returns without deducting). A Briyo-made shipment on the same order is never modified or merged:
 * the external fulfilment gets its own row beside it.
 * Courier: an existing courier partner whose name equals the carrier (case-insensitive) is used; none is ever
 * created — otherwise courier_partner_id stays empty and the carrier name is kept on the shipment.
 */
export const EXTERNAL_SOURCE = 'shopify';
export const BWA_PROVIDER = 'bwa';

const list = (v, fallback) => String(v ?? fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const bwaOrderTag = () => list(process.env.BWA_ORDER_TAG, 'Buy with Amazon')[0];
export const bwaCarriers = () => list(process.env.BWA_CARRIERS, 'Amazon Transportation Services');

/** Shopify displayStatus → Briyo shipment status; only these three are mapped. */
const DISPLAY = { IN_TRANSIT: 'in_transit', OUT_FOR_DELIVERY: 'out_for_delivery', DELIVERED: 'delivered' };
/** Forward-only progress: a later poll with an older state never moves a shipment back. */
const RANK = { dispatched: 1, in_transit: 2, out_for_delivery: 3, delivered: 4 };
/** States a person set (or a return) that a fulfilment update never overrides. */
const HELD = new Set(['delivery_failed', 'rto']);

export function isBwaOrder(shopify) {
  const tag = bwaOrderTag();
  return Boolean(tag) && (shopify?.tags || []).some((t) => String(t).trim().toLowerCase() === tag);
}

/** The eligible fulfilments of an order: BWA order, Amazon carrier, a Shopify fulfilment GID. */
export function eligibleFulfillments(shopify) {
  if (!isBwaOrder(shopify)) return [];
  const carriers = bwaCarriers();
  return (shopify.fulfillments || []).filter((f) => /^gid:\/\/shopify\/Fulfillment\/\d+$/.test(String(f.id || ''))
    && (f.tracking || []).some((t) => carriers.includes(String(t.company || '').trim().toLowerCase())));
}

/** The Briyo status a fulfilment implies, or null when it says nothing a shipment can use. */
export function mappedStatus(f) {
  if (String(f.status || '').toUpperCase() === 'CANCELLED') return 'cancelled';
  return DISPLAY[String(f.display_status || '').toUpperCase()] || null;
}

/**
 * Mirrors one order's eligible fulfilments. Runs in the caller's transaction (applyPage holds the sync lock).
 * Returns { created, updated, cancelled, skipped: [{ fulfillment, reason }] }.
 */
export async function mirrorExternalFulfillments(client, orderId, shopify, { actor, logEvent }) {
  const out = { created: 0, updated: 0, cancelled: 0, skipped: [] };
  const eligible = eligibleFulfillments(shopify);
  if (!eligible.length) return out;
  const carriers = bwaCarriers();
  // A shipment someone made in Briyo is never read or changed here: each Shopify fulfilment is its own external
  // row beside it, matched only by its fulfilment GID — never merged into a manual shipment of the same order.
  for (const f of eligible) {
    const t = (f.tracking || []).find((x) => carriers.includes(String(x.company || '').trim().toLowerCase()));
    const carrier = t.company.trim();
    const number = t.number ? String(t.number).trim() : null;   // never invented
    const url = t.url ? String(t.url).trim() : null;
    const wanted = mappedStatus(f);
    const { rows: [cp] } = await client.query('SELECT id FROM courier_partners WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [carrier]);
    const ext = { status: f.status || null, display: f.display_status || null, updated: f.updated_at || f.created_at || null };
    const { rows: [cur] } = await client.query(
      `SELECT id, shipment_status, tracking_id, tracking_url, courier_partner_id, external_status FROM order_shipments
       WHERE external_source = $1 AND external_fulfillment_id = $2 FOR UPDATE`, [EXTERNAL_SOURCE, f.id]);
    if (!cur) {
      if (wanted === 'cancelled') { out.skipped.push({ fulfillment: f.id, reason: 'cancelled in Shopify before it was mirrored' }); continue; }
      const status = wanted || 'dispatched';                   // a fulfilment with a carrier has left the building
      const { rows: [s] } = await client.query(
        `INSERT INTO order_shipments (order_id, courier_partner_id, tracking_id, tracking_url, shipment_status, dispatch_date, delivered_at,
           external_source, external_provider, external_fulfillment_id, external_carrier, external_status, external_display_status, external_updated_at,
           created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)
         ON CONFLICT (external_source, external_fulfillment_id) WHERE external_fulfillment_id IS NOT NULL DO NOTHING RETURNING id`,
        [orderId, cp?.id ?? null, number, url, status, f.in_transit_at || f.created_at || null, status === 'delivered' ? (f.delivered_at || null) : null,
          EXTERNAL_SOURCE, BWA_PROVIDER, f.id, carrier, ext.status, ext.display, ext.updated, actor]);
      if (!s) continue;                                        // the same fulfilment, mirrored a moment ago
      out.created += 1;
      await logEvent(client, orderId, 'external_shipment_mirrored', actor, {
        provider: BWA_PROVIDER, fulfillment: f.id, fulfillment_name: f.name || null, carrier, tracking_id: number, status, shipment_id: Number(s.id) });
      continue;
    }
    // Existing mirror: tracking follows Shopify (a value is never blanked); status moves forward only.
    let next = cur.shipment_status;
    if (wanted === 'cancelled') next = 'cancelled';
    else if (cur.shipment_status === 'cancelled') {
      // Only a cancellation that came from Shopify is undone by Shopify; a person's cancellation stands.
      if (String(cur.external_status || '').toUpperCase() === 'CANCELLED') next = wanted || 'dispatched';
    } else if (wanted && !HELD.has(cur.shipment_status) && (RANK[wanted] || 0) > (RANK[cur.shipment_status] || 0)) next = wanted;
    const tracking = number || cur.tracking_id;
    const trackingUrl = url || cur.tracking_url;
    const courier = cur.courier_partner_id ?? cp?.id ?? null;
    const changed = next !== cur.shipment_status || tracking !== cur.tracking_id || trackingUrl !== cur.tracking_url || courier !== cur.courier_partner_id;
    await client.query(
      `UPDATE order_shipments SET shipment_status = $2, tracking_id = $3, tracking_url = $4, courier_partner_id = $5,
         delivered_at = CASE WHEN $2 = 'delivered' THEN coalesce(delivered_at, $6::timestamptz, now()) ELSE delivered_at END,
         external_status = $7, external_display_status = $8, external_updated_at = $9,
         version = version + CASE WHEN $10 THEN 1 ELSE 0 END, updated_at = CASE WHEN $10 THEN now() ELSE updated_at END,
         updated_by = CASE WHEN $10 THEN $11 ELSE updated_by END
       WHERE id = $1`,
      [cur.id, next, tracking, trackingUrl, courier, f.delivered_at || null, ext.status, ext.display, ext.updated, changed, actor]);
    if (!changed) continue;
    if (next === 'cancelled' && cur.shipment_status !== 'cancelled') out.cancelled += 1; else out.updated += 1;
    await logEvent(client, orderId, next === 'cancelled' && cur.shipment_status !== 'cancelled' ? 'external_shipment_cancelled' : 'external_shipment_updated', actor, {
      provider: BWA_PROVIDER, fulfillment: f.id, shipment_id: Number(cur.id),
      changes: Object.fromEntries([['shipment_status', [cur.shipment_status, next]], ['tracking_id', [cur.tracking_id, tracking]], ['tracking_url', [cur.tracking_url, trackingUrl]]]
        .filter(([, [a, b]]) => a !== b).map(([k, [from, to]]) => [k, { from, to }])),
    });
  }
  return out;
}
