/**
 * When a Delta Velocity shipment needs a person — shared by the mirror (lib/delta-velocity.js), the order API
 * (each shipment's courier_check) and, as SQL, the "Courier updates to check" queue (lib/orders.js LOGISTICS_VIEWS).
 * A leaf module: it imports nothing, so lib/orders.js can use it without an import cycle.
 */
export const DV_PROVIDER = 'deltavelocity';
/** Shopify display statuses that mean the parcel has left the warehouse. */
export const DV_LEFT = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'ATTEMPTED_DELIVERY', 'FAILURE', 'NOT_DELIVERED'];
/** Delivery tried and not done: a flag, never a status. */
export const DV_ATTEMPTED = ['ATTEMPTED_DELIVERY', 'FAILURE', 'NOT_DELIVERED'];
const SENT = new Set(['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto']);
const up = (s) => (s ? String(s).trim().toUpperCase() : null);

/**
 * 'booking_cancelled' — Delta Velocity cancelled the booking (rebooked, or the parcel is not going);
 * 'left_not_dispatched' — the courier has it, but its stock has not left here: the batches could not be reserved for
 *   it by FEFO (an unmapped line, not enough stock, no inventory lines) or it has no courier: fix that, confirm the
 *   batches, then set the status;
 * 'delivery_attempted' — delivery tried and not done;
 * null — nothing to do.
 */
export function courierCheckReason(ship) {
  if (!ship || ship.external_provider !== DV_PROVIDER || ship.shipment_status === 'cancelled') return null;
  const display = up(ship.external_display_status);
  if (up(ship.external_status) === 'CANCELLED' || display === 'CANCELED') return 'booking_cancelled';
  if (DV_LEFT.includes(display) && !SENT.has(ship.shipment_status)) return 'left_not_dispatched';
  if (DV_ATTEMPTED.includes(display) && !['delivered', 'delivery_failed', 'rto'].includes(ship.shipment_status)) return 'delivery_attempted';
  return null;
}
