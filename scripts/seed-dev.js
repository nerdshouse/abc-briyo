import dotenv from 'dotenv';
import {
  getPool, ensureSchema, insertCart, isMockMode, updateStatus,
} from '../lib/db.js';
import { normalizePayload } from '../lib/normalize.js';
import { assertMarkerIn, EnvironmentError } from '../lib/env-guard.js';
import {
  ensureOrdersSchema, createOrder, updateShipment, orderShipments, listCouriers,
} from '../lib/orders.js';

/**
 * Fills the DEVELOPMENT database with obviously fake carts and orders, so the
 * board and /orders have something to show. Nothing here is real: names say
 * "Sample", phones are in the unallocated 90000 00xxx range, emails end in
 * .invalid, and order numbers start DEV-.
 *
 *   npm run db:seed-dev
 *
 * Runs only when every signal says development. Safe to run again: carts
 * upsert on their id and existing orders are skipped.
 */

const refuse = (why) => { console.error(`\n  db:seed-dev REFUSED: ${why}\n`); process.exit(1); };
const productionHost = () => Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
if (productionHost()) refuse('this is a production host (Render / NODE_ENV=production).');
if (process.env.APP_ENV && process.env.APP_ENV !== 'development') refuse(`APP_ENV=${process.env.APP_ENV} is set in this shell.`);
dotenv.config();
if (productionHost()) refuse('.env sets NODE_ENV=production.');
if (process.env.APP_ENV !== 'development') refuse(`APP_ENV must be "development" (it is "${process.env.APP_ENV || 'unset'}").`);
if (isMockMode()) refuse('DATABASE_URL is not set.');
if (process.env.DATABASE_URL === process.env.TEST_DATABASE_URL) refuse('DATABASE_URL is the test database.');

try {
  await ensureSchema();            // verifies APP_ENV=development against the label
  await ensureOrdersSchema();
} catch (err) {
  refuse(err.message);
}

// Checked again inside a transaction right before writing, in case the label
// changed between the check above and now.
{
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await assertMarkerIn(client, ['development'], 'db:seed-dev');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    refuse(err instanceof EnvironmentError ? err.message : `could not verify the database: ${err.message}`);
  } finally {
    client.release();
  }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ACTOR = 'seed-dev';

// ---- carts ------------------------------------------------------------------
const CARTS = [
  ['Sample Customer 01', 1499, 2, 'Not called'],
  ['Sample Customer 02', 899, 1, 'Called – No answer'],
  ['Sample Customer 03', 2599, 3, 'Callback scheduled'],
  ['Sample Customer 04', 649, 1, 'Called – Recovered'],
  ['Sample Customer 05', 3199, 4, 'Called – Declined'],
  ['Sample Customer 06', 1199, 2, 'Not called'],
  ['Sample Customer 07', 499, 1, 'Not called'],
  ['Sample Customer 08', 1799, 2, 'Called – No answer'],
];
let carts = 0;
for (const [i, [name, total, items, status]] of CARTS.entries()) {
  const n = String(i + 1).padStart(2, '0');
  const [first, ...rest] = name.split(' ');
  const payload = {
    request_id: `DEV-CART-${n}`,
    created_at: hoursAgo(2 + i * 5),
    customer: { first_name: first, last_name: rest.join(' '), phone: `90000000${n}`, email: `sample${n}@example.invalid` },
    totals: { total }, currency: 'INR', item_count: items,
    items: [{ name: 'Sample Product (dev)', quantity: items }],
    abc_url: `https://example.invalid/checkout/dev-${n}`,
  };
  const { id } = await insertCart(normalizePayload(payload), payload);
  if (status !== 'Not called') {
    await updateStatus(id, {
      status, notes: 'Seeded for development',
      callbackAt: status === 'Callback scheduled' ? hoursAgo(-20) : undefined, updatedBy: ACTOR,
    }).catch((err) => console.warn(`  cart ${n} status not set: ${err.message}`));
  }
  carts += 1;
}

// ---- orders -----------------------------------------------------------------
const couriers = await listCouriers();
const courier = (name) => couriers.find((c) => c.name === name)?.id;
const ORDERS = [
  { channel: 'website', n: 'DEV-1001', value: 1499, name: 'Sample Customer 11', ship: null },
  { channel: 'website', n: 'DEV-1002', value: null, name: null, ship: null },
  { channel: 'amazon', n: 'DEV-1001', value: 2199, name: 'Sample Customer 12', ship: { c: 'Amazon Shipping', awb: 'DEVAMZ0001', to: ['packed'] } },
  { channel: 'blinkit', n: 'DEV-2001', value: 612, name: null, ship: { c: 'Porter', awb: 'DEVPRT01', to: ['packed', 'dispatched', 'in_transit'] } },
  { channel: 'instamart', n: 'DEV-3001', value: 980, name: 'Sample Customer 13', ship: { c: 'Delhivery', awb: 'DEVDLV0001', to: ['packed', 'dispatched', 'in_transit', 'delivered'] } },
  { channel: 'zepto', n: 'DEV-4001', value: 450, name: 'Sample Customer 14', ship: { c: 'Blue Dart', awb: 'DEVBD0001', to: ['packed', 'dispatched', 'out_for_delivery', 'delivery_failed', 'rto'] } },
];
let created = 0; let skipped = 0;
for (const [i, o] of ORDERS.entries()) {
  let id;
  try {
    id = await createOrder({
      channel: o.channel, source_order_id: o.n, order_value: o.value, customer_name: o.name,
      order_date: hoursAgo(6 + i * 9), note: 'Sample order for development',
    }, { actor: ACTOR });
    created += 1;
  } catch (err) {
    if (err.status === 409) { skipped += 1; continue; }
    throw err;
  }
  if (!o.ship) continue;
  for (const [step, status] of o.ship.to.entries()) {
    const s = (await orderShipments(id))[0];
    await updateShipment(id, s.id, {
      ...(step === 0 ? { courier_partner_id: courier(o.ship.c), tracking_id: o.ship.awb } : {}),
      shipment_status: status,
    }, { actor: ACTOR, version: s.version });
  }
}

console.log(`\n  Development database seeded: ${carts} sample carts, ${created} orders created, ${skipped} already there.\n`);
await getPool().end();
