import dotenv from 'dotenv';
import {
  ensureSchema, getPool, isMockMode, insertCart, listCarts, updateStatus, ping,
  matchOrderToCarts, reasonSummary, statsByCaller, staleCarts,
  renormalizeRow, DERIVED_COLUMNS,
  recordSystemEvent, getSystemState, recordWebhookFailure, webhookFailureCount,
  searchCarts, conflictingUpdate, recordLogin, recentLogins,
  listMembers, upsertMember, updateMember, deleteMember, otherActiveAdminCount,
  recordMemberChange, recentMemberChanges, changeMemberPhone,
  adminOverview, whoIsOnline, touchLastSeen, periodReport, cartsByStatus, importCarts,
  actionQueue, cartsForBucket, ACTION_BUCKETS, dailySnapshot,
  cartEvents, recentEvents, callbackAtOf,
} from '../lib/db.js';
import { createOtp, verifyOtp, checkRateLimit, normalisePhone } from '../lib/otp.js';
import { normalizePayload, redactPayload, REDACTED_KEYS } from '../lib/normalize.js';
import { GOKWIK_REAL_PAYLOAD } from './fixtures/gokwik-real.js';
import { mapShopifyCsv } from '../lib/shopify-csv.js';
import { csvCell, toCsv } from '../lib/csv.js';
import {
  ensureOrdersSchema, createOrder, createShipment, updateOrder, updateShipment, getOrder, listOrders, orderEvents,
  orderShipments, addOrderNote, removeDocument, orderDocuments, listCouriers, saveCourier,
  trackingUrlFor, purgeTestOrders, zonedToUtc, listDestinations, saveDestination, DISPATCH_TYPES,
  shipmentMembers, sharedShipmentOf, attachToShipment, detachFromShipment, attachableOrders, createShipmentForOrders,
} from '../lib/orders.js';
import { saveUploadedDocument } from '../lib/orders-routes.js';
import { planAmazon, readTable, previewAmazonImport, commitAmazonImport } from '../lib/amazon-import.js';
import { orderItems } from '../lib/orders.js';
import { DOCUMENT_FORMATS } from '../lib/orders.js';
import {
  validateDocument, storage, signV4, _resetStorage, StorageNotConfigured,
} from '../lib/storage.js';
import { canUseOrders, canUseRecovery, roleFor } from '../lib/otp.js';
import {
  isIngestSilent, buildDailySummary, shouldSendSummary, boardDay,
} from '../lib/sla-alert.js';
import { issueSession, verifySession } from '../lib/session.js';
import { rateLimit, _reset as resetRateLimit } from '../lib/rate-limit.js';
import { assertDatabaseEnvironment, assertMarkerIn } from '../lib/env-guard.js';

// ---- where this may run ---------------------------------------------------
// db:check writes and deletes rows, so it runs only against the test database:
// TEST_DATABASE_URL, labelled "test". Never DATABASE_URL, never production.
const refuse = (why) => { console.error(`\n  db:check REFUSED: ${why}\n`); process.exit(1); };
const productionHost = () => Boolean(process.env.RENDER) || process.env.NODE_ENV === 'production';
if (productionHost()) refuse('this is a production host (Render / NODE_ENV=production).');
// Checked before .env loads: a shell that says production means it.
if (process.env.APP_ENV && process.env.APP_ENV !== 'test') refuse(`APP_ENV=${process.env.APP_ENV} is set in this shell.`);
dotenv.config();
if (productionHost()) refuse('.env sets NODE_ENV=production.');
if (!process.env.TEST_DATABASE_URL) refuse('TEST_DATABASE_URL is not set. See README → Databases.');
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) refuse('TEST_DATABASE_URL is the same as DATABASE_URL.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.APP_ENV = 'test';

/**
 * Exercises every database code path against TEST_DATABASE_URL (a database
 * labelled "test") and cleans up after itself:  npm run db:check
 */

if (isMockMode()) {
  console.error('DATABASE_URL is not set — nothing to check. Set it in .env first.');
  process.exit(1);
}

// The database itself must say "test" (or be empty, and get labelled so) before
// the first write. Anything else — above all "production" — stops here.
try { await assertDatabaseEnvironment(getPool(), 'test'); } catch (err) { refuse(err.message); }

const TEST_CART = 'DBCHECK-DELETE-ME';
// The tests bring their own members and a second cart rather than borrowing
// whatever a real database happens to hold.
const FIX_CART = 'DBCHECK-DELETE-ME-2';
const FIX_A = '919000000091';   // active caller
const FIX_B = '919000000092';   // active admin
const TEST_PHONE = normalisePhone('9000000000');
const TEST_STATE_KEY = 'dbcheck_marker';
const TEST_FAILURE_KIND = 'dbcheck-simulated';
let failures = 0;

const ok = (label, extra = '') => console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`);
const bad = (label, err) => { failures += 1; console.log(`  FAIL  ${label} — ${err.message || err}`); };

async function step(label, fn) {
  try { const r = await fn(); ok(label, typeof r === 'string' ? r : ''); }
  catch (err) { bad(label, err); }
}

console.log('\nChecking database…\n');

await step('connect', async () => {
  const info = await ping();
  return String(info.version).split(' ').slice(0, 2).join(' ');
});

await step('create schema (carts + otp_state)', () => ensureSchema());

await step('insert cart', async () => {
  const payload = {
    request_id: TEST_CART, created_at: new Date().toISOString(),
    customer: { first_name: 'DB', last_name: 'Check', phone: '9000000000', email: 'db@check.local' },
    totals: { total: 123.45 }, currency: 'INR', item_count: 2,
    items: [{ name: 'Test item', quantity: 2 }],
    abc_url: 'https://example.com/checkout/dbcheck',
  };
  const { id } = await insertCart(normalizePayload(payload), payload);
  return `row ${id}`;
});

await step('upsert same request_id does not duplicate', async () => {
  const payload = { request_id: TEST_CART, totals: { total: 123.45 }, currency: 'INR' };
  const { duplicate } = await insertCart(normalizePayload(payload), payload);
  if (!duplicate) throw new Error('expected a duplicate update, got a new row');
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  if (rows[0].n !== 1) throw new Error(`expected 1 row, found ${rows[0].n}`);
  return '1 row';
});

await step('update status', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const row = await updateStatus(rows[0].id, { status: 'Callback scheduled', notes: 'db-check' });
  if (row.status !== 'Callback scheduled') throw new Error('status did not persist');
  return row.status;
});

await step('retry preserves status', async () => {
  const payload = { request_id: TEST_CART, totals: { total: 123.45 }, currency: 'INR' };
  await insertCart(normalizePayload(payload), payload);
  const { rows } = await getPool().query('SELECT status, notes FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  if (rows[0].status !== 'Callback scheduled' || rows[0].notes !== 'db-check') {
    throw new Error(`retry clobbered the call log: ${JSON.stringify(rows[0])}`);
  }
  return 'status + notes intact';
});

await step('list carts', async () => `${(await listCarts()).length} rows`);

// ---- OTP state, the part that must work across Cloud Run instances ----------
await step('otp: create + verify', async () => {
  const code = await createOtp(TEST_PHONE);
  const wrong = await verifyOtp(TEST_PHONE, '000000');
  if (wrong.ok) throw new Error('a wrong code was accepted');
  const right = await verifyOtp(TEST_PHONE, code);
  if (!right.ok) throw new Error(`correct code rejected: ${right.reason}`);
  return 'wrong rejected, correct accepted';
});

await step('otp: single use', async () => {
  const code = await createOtp(TEST_PHONE);
  await verifyOtp(TEST_PHONE, code);
  const replay = await verifyOtp(TEST_PHONE, code);
  if (replay.ok) throw new Error('a used code was accepted a second time');
  return 'replay rejected';
});

await step('otp: resend cooldown survives a login', async () => {
  const limit = await checkRateLimit(TEST_PHONE);
  if (limit.ok) throw new Error('cooldown did not apply after a recent send');
  return `blocked for ${limit.retryAfter}s`;
});

await step('otp: attempt counter', async () => {
  await getPool().query('DELETE FROM otp_state WHERE phone = $1', [TEST_PHONE]);
  await createOtp(TEST_PHONE);
  const r1 = await verifyOtp(TEST_PHONE, '111111');
  if (!/4 attempts left/.test(r1.reason)) throw new Error(`unexpected message: ${r1.reason}`);
  return r1.reason;
});

// ---- v2 ---------------------------------------------------------------------
await step('callback_at set and cleared', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const when = new Date(Date.now() + 3600_000).toISOString();
  let row = await updateStatus(rows[0].id, { status: 'Callback scheduled', callbackAt: when });
  if (!row.callback_at) throw new Error('callback_at did not persist');
  row = await updateStatus(rows[0].id, { status: 'Called – No answer', callbackAt: null });
  if (row.callback_at !== null) throw new Error('callback_at was not cleared');
  return 'set, then cleared';
});

await step('reason_tags array round-trips', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const tags = ['Price objection', 'Shipping time'];
  const row = await updateStatus(rows[0].id, { reasonTags: tags });
  if (JSON.stringify(row.reason_tags) !== JSON.stringify(tags)) {
    throw new Error(`got ${JSON.stringify(row.reason_tags)}`);
  }
  return tags.join(' + ');
});

await step('updated_by attribution', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const row = await updateStatus(rows[0].id, { notes: 'db-check', updatedBy: 'DBCheck Bot' });
  if (row.updated_by !== 'DBCheck Bot') throw new Error('updated_by did not persist');
  return row.updated_by;
});

await step('reason summary aggregates', async () => {
  const s = await reasonSummary(3650);
  if (!s.reasons.some((r) => r.tag === 'Price objection')) throw new Error('tag missing from summary');
  return `${s.reasons.length} tag(s), ${s.taggedCarts} tagged cart(s)`;
});

await step('stats by caller', async () => {
  const rows = await statsByCaller(3650);
  const me = rows.find((r) => r.caller === 'DBCheck Bot');
  if (!me) throw new Error('caller missing from stats');
  return `${me.touched} touched, ${me.recovery_rate}% recovered`;
});

await step('stale-cart count', async () => {
  const s = await staleCarts(0);   // everything counts as stale at 0 hours
  if (typeof s.count !== 'number') throw new Error('no count returned');
  return `${s.count} at 0h threshold`;
});

await step('order match auto-recovers, and respects Declined', async () => {
  const { rows } = await getPool().query('SELECT id, phone FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  await updateStatus(rows[0].id, { status: 'Called – No answer' });

  const matched = await matchOrderToCarts({
    phone: '+91 90000 00000', email: null, orderId: 'DBCHECK-ORD', orderName: '#DBCHECK',
  });
  if (!matched.length) throw new Error('order did not match the test cart on phone');

  const { rows: after } = await getPool().query(
    'SELECT status, updated_by, recovered_order_name FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  if (after[0].status !== 'Called – Recovered') throw new Error('status was not upgraded');

  // A Declined cart must never be auto-upgraded.
  await updateStatus(rows[0].id, { status: 'Called – Declined' });
  const second = await matchOrderToCarts({ phone: '9000000000', orderId: 'DBCHECK-ORD2' });
  if (second.length) throw new Error('a Declined cart was auto-upgraded — it must not be');

  return `matched on ${matched[0].matched_on}, Declined left alone`;
});

await step('auto_recovery_log written', async () => {
  const { rows } = await getPool().query(
    "SELECT count(*)::int AS n FROM auto_recovery_log WHERE order_id LIKE 'DBCHECK-ORD%'");
  if (rows[0].n < 1) throw new Error('no audit row written');
  return `${rows[0].n} audit row(s)`;
});

// ---- v3 --------------------------------------------------------------------
await step('real GoKwik key shape maps', async () => {
  // The regression test for the rto_risk_flag / mkt_source bugs, which were
  // live for a day because no fixture used the real key names.
  const n = normalizePayload(GOKWIK_REAL_PAYLOAD);
  const required = {
    riskFlag: 'High Risk', utmSource: 'facebook', dropStage: 'Payment Page',
    utmCampaign: '120251248645910304', utmMedium: 'paid',
  };
  for (const [k, want] of Object.entries(required)) {
    if (n[k] !== want) throw new Error(`${k}: expected ${want}, got ${JSON.stringify(n[k])}`);
  }
  for (const k of ['cartId', 'customerName', 'phone', 'email', 'checkoutUrl', 'totalPrice', 'address']) {
    if (n[k] === null || n[k] === undefined) throw new Error(`${k} did not map`);
  }

  // The shipping block carries name "Free Shipping" and its own price. Both have
  // hijacked a field before — the customer's name and the cart total — so assert
  // neither leaks in.
  if (/shipping/i.test(n.customerName)) {
    throw new Error(`customerName picked up the shipping method: ${n.customerName}`);
  }
  if (n.customerName !== 'Fixture Customer') throw new Error(`wrong customer: ${n.customerName}`);
  if (n.totalPrice === 0) throw new Error('totalPrice picked up shipping.price');

  return 'risk, utm, stage and contact mapped; shipping block kept out of name and total';
});

await step('redaction cannot break derivation', async () => {
  // Proves REDACTED_KEYS only removes keys nothing derives from — the
  // invariant that lets us strip PII while keeping raw_payload as the
  // source of truth for backfill.
  const full = normalizePayload(GOKWIK_REAL_PAYLOAD);
  const after = normalizePayload(redactPayload(GOKWIK_REAL_PAYLOAD));
  if (JSON.stringify(full) !== JSON.stringify(after)) {
    throw new Error('redacting changed the derived fields');
  }
  const left = REDACTED_KEYS.filter((k) => k in redactPayload(GOKWIK_REAL_PAYLOAD));
  if (left.length) throw new Error(`not stripped: ${left.join(', ')}`);
  return `${REDACTED_KEYS.length} keys stripped, derived fields identical`;
});

await step('backfill corrects columns without touching the call log', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;

  // A human works the row, then a derived column is corrupted.
  await updateStatus(id, {
    status: 'Callback scheduled', notes: 'do not lose me',
    reasonTags: ['Price objection'], updatedBy: 'Human Caller',
  });
  await getPool().query("UPDATE abandoned_carts SET risk_flag = 'WRONG', customer_name = 'WRONG' WHERE id = $1", [id]);

  const before = (await getPool().query(
    `SELECT status, notes, reason_tags, updated_by, callback_at, received_at
     FROM abandoned_carts WHERE id = $1`, [id])).rows[0];

  const { rows: [{ raw_payload }] } = await getPool().query('SELECT raw_payload FROM abandoned_carts WHERE id = $1', [id]);
  await renormalizeRow(id, normalizePayload(raw_payload));

  const after = (await getPool().query(
    `SELECT status, notes, reason_tags, updated_by, callback_at, received_at, customer_name, risk_flag
     FROM abandoned_carts WHERE id = $1`, [id])).rows[0];

  if (after.customer_name === 'WRONG') throw new Error('derived column was not corrected');
  for (const k of ['status', 'notes', 'updated_by']) {
    if (String(before[k]) !== String(after[k])) throw new Error(`backfill changed ${k}: ${before[k]} -> ${after[k]}`);
  }
  if (JSON.stringify(before.reason_tags) !== JSON.stringify(after.reason_tags)) {
    throw new Error('backfill changed reason_tags');
  }
  if (new Date(before.received_at).getTime() !== new Date(after.received_at).getTime()) {
    throw new Error('backfill changed received_at');
  }
  return 'columns re-derived, status/notes/tags/attribution untouched';
});

await step('backfill is idempotent', async () => {
  const { rows } = await getPool().query('SELECT id, raw_payload FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const snap = async () => (await getPool().query(
    `SELECT ${DERIVED_COLUMNS.join(', ')} FROM abandoned_carts WHERE id = $1`, [rows[0].id])).rows[0];
  await renormalizeRow(rows[0].id, normalizePayload(rows[0].raw_payload));
  const first = await snap();
  await renormalizeRow(rows[0].id, normalizePayload(rows[0].raw_payload));
  if (JSON.stringify(first) !== JSON.stringify(await snap())) throw new Error('second run changed something');
  return 'running twice is a no-op';
});

await step('ingest marker round-trips', async () => {
  await recordSystemEvent(TEST_STATE_KEY, 'db-check');
  const row = await getSystemState(TEST_STATE_KEY);
  if (!row || row.value !== 'db-check') throw new Error('marker did not persist');
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (age > 60_000) throw new Error(`updated_at looks wrong (${age}ms old)`);
  return 'written and read back';
});

await step('silence detector', async () => {
  // The alarm for the one failure that hides itself: if ingestion stops, the
  // stale-cart backlog drains and every other signal goes quiet.
  const H = 3600_000;
  const cases = [
    [null, false, 'never received is not silence'],
    [new Date(Date.now() - 3.3 * H), false, 'largest real gap observed (3.3h)'],
    [new Date(Date.now() - 7.9 * H), false, 'just inside the window'],
    [new Date(Date.now() - 8.1 * H), true, 'just outside'],
    [new Date(Date.now() - 26 * H), true, 'a day of silence'],
    ['not-a-date', false, 'garbage is not silence'],
  ];
  for (const [at, want, label] of cases) {
    if (isIngestSilent(at, 8) !== want) throw new Error(`${label}: expected ${want}`);
  }
  return `${cases.length} cases correct at an 8h threshold`;
});

await step('webhook failures are recorded and counted', async () => {
  const before = await webhookFailureCount(24);
  await recordWebhookFailure({ kind: TEST_FAILURE_KIND, error: 'db-check simulated', body: '{"probe":1}' });
  const after = await webhookFailureCount(24);
  if (after !== before + 1) throw new Error(`count did not move: ${before} -> ${after}`);
  return `${after} in the last 24h`;
});

await step('ranges are calendar days, not rolling hours', async () => {
  // "Today" returning most of yesterday is what made the range buttons look
  // broken: a 24h rolling window is not the day the callers are living in.
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;

  // Yesterday, late enough that a rolling 24h window would still include it.
  // The status is pinned too: a cart in "Callback scheduled" is deliberately
  // exempt from the date window, so leaving it there would test the callback
  // rule rather than the calendar-day boundary this step exists for.
  await getPool().query(
    `UPDATE abandoned_carts SET
       status = 'Called – No answer',
       callback_at = NULL,
       received_at =
         (date_trunc('day', (now() AT TIME ZONE 'Asia/Kolkata')) - interval '2 hours') AT TIME ZONE 'Asia/Kolkata'
     WHERE id = $1`, [id]);

  const today = await listCarts({ sinceDays: 1 });
  if (today.carts.some((c) => c.cart_id === TEST_CART)) {
    throw new Error('a cart from yesterday evening appeared under "Today"');
  }
  const twoDays = await listCarts({ sinceDays: 2 });
  if (!twoDays.carts.some((c) => c.cart_id === TEST_CART)) {
    throw new Error('yesterday\'s cart is missing from a 2-day window');
  }

  await getPool().query('UPDATE abandoned_carts SET received_at = now() WHERE id = $1', [id]);
  return 'yesterday evening excluded from today, included in 2 days';
});

await step('date window is applied server-side', async () => {
  // The old code took an unconditional LIMIT 500 and silently dropped the rest.
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  // Status pinned for the same reason as the calendar-day check above.
  await getPool().query(
    `UPDATE abandoned_carts
     SET received_at = now() - interval '30 days', status = 'Called – No answer', callback_at = NULL
     WHERE id = $1`, [rows[0].id]);

  const recent = await listCarts({ sinceDays: 7 });
  const all = await listCarts({ sinceDays: 0 });
  const inRecent = recent.carts.some((c) => c.cart_id === TEST_CART);
  const inAll = all.carts.some((c) => c.cart_id === TEST_CART);
  if (inRecent) throw new Error('a 30-day-old cart leaked into the 7-day window');
  if (!inAll) throw new Error('the 30-day-old cart is missing from the unbounded query');

  await getPool().query('UPDATE abandoned_carts SET received_at = now() WHERE id = $1', [rows[0].id]);
  return `7d excluded it, all included it (${all.total} total)`;
});

await step('fixtures: two test members and a second test cart', async () => {
  await upsertMember({ phone: FIX_A, name: 'DBCheck Member A', isAdmin: false, addedBy: 'db-check' });
  await upsertMember({ phone: FIX_B, name: 'DBCheck Member B', isAdmin: true, addedBy: 'db-check' });
  const payload = { request_id: FIX_CART, created_at: new Date().toISOString(),
    customer: { first_name: 'DB', last_name: 'Check Two', phone: '9000000002' }, totals: { total: 10 }, currency: 'INR' };
  await insertCart(normalizePayload(payload), payload);
  return 'ready';
});

await step('truncation is reported, not silent', async () => {
  const capped = await listCarts({ sinceDays: 0, limit: 1 });
  if (capped.carts.length !== 1) throw new Error('limit not applied');
  if (capped.total <= 1) throw new Error('total should count beyond the limit');
  if (!capped.truncated) throw new Error('truncated flag not set — this is the silent-loss bug');
  return `1 of ${capped.total} returned, truncated=true`;
});

await step('search finds by name, phone and email', async () => {
  const byName = await searchCarts('DB Check');
  const byPhone = await searchCarts('90000 00000');   // spaced — must still match
  const byEmail = await searchCarts('db@check.local');
  for (const [label, r] of [['name', byName], ['phone', byPhone], ['email', byEmail]]) {
    if (!r.carts.some((c) => c.cart_id === TEST_CART)) throw new Error(`search by ${label} missed the test cart`);
  }
  const none = await searchCarts('zzz-no-such-cart-zzz');
  if (none.carts.length) throw new Error('search returned rows for nonsense');
  return 'name, spaced phone and email all matched';
});

await step('conflict guard catches another user, ignores your own edits', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;

  await updateStatus(id, { notes: 'first', updatedBy: 'Caller A' });
  const seenAt = (await getPool().query('SELECT status_updated_at FROM abandoned_carts WHERE id = $1', [id])).rows[0].status_updated_at;

  // Nobody has touched it since — no conflict for either user.
  if (await conflictingUpdate(id, seenAt, 'Caller B')) throw new Error('false conflict with no intervening write');

  // Caller A saves again; Caller B is now working from a stale read. The guard
  // compares to the millisecond, and a local database can land two back-to-back
  // saves in the same one — a real second save is never that close.
  await new Promise((r) => setTimeout(r, 5));
  await updateStatus(id, { notes: 'second', updatedBy: 'Caller A' });
  const clash = await conflictingUpdate(id, seenAt, 'Caller B');
  if (!clash) throw new Error('did not detect another user overwriting');
  if (clash.updated_by !== 'Caller A') throw new Error('reported the wrong user');

  // The same person continuing to edit their own row must never conflict.
  if (await conflictingUpdate(id, seenAt, 'Caller A')) throw new Error('a user conflicted with themselves');

  return `flagged ${clash.updated_by}, same-user edits pass through`;
});

await step('GoKwik outreach signals persist', async () => {
  // These exist so a caller can see the customer has already been messaged —
  // the reason this board sends nothing automatically.
  const payload = {
    request_id: TEST_CART, message_enqueued: 'true', abc_email_sent: false,
    brand_order_count: '4', total_price: '99',
  };
  await insertCart(normalizePayload(payload), payload);
  const { rows } = await getPool().query(
    `SELECT gokwik_message_queued, gokwik_email_sent, brand_order_count
     FROM abandoned_carts WHERE cart_id = $1`, [TEST_CART]);
  const r = rows[0];
  if (r.gokwik_message_queued !== true) throw new Error('string "true" did not become a boolean');
  if (r.gokwik_email_sent !== false) throw new Error('boolean false was lost');
  if (r.brand_order_count !== 4) throw new Error('brand_order_count did not persist');
  return 'message queued, email not sent, 4 prior orders';
});

await step('login attempts are audited', async () => {
  await recordLogin({ phone: TEST_PHONE, ok: false, reason: 'db-check simulated', ip: '203.0.113.1' });
  await recordLogin({ phone: TEST_PHONE, ok: true, reason: null, ip: '203.0.113.1' });
  const mine = (await recentLogins(20)).filter((l) => l.phone === TEST_PHONE);
  if (mine.length < 2) throw new Error('login attempts were not recorded');
  if (!mine.some((l) => l.ok) || !mine.some((l) => !l.ok)) throw new Error('outcome not captured');
  return 'success and failure both recorded';
});

await step('SESSION_EPOCH invalidates every token', async () => {
  // The emergency lever for stateless sessions: a deactivated teammate would
  // otherwise keep access until their token expired.
  const before = process.env.SESSION_EPOCH;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'db-check-secret-0123456789';
  process.env.SESSION_EPOCH = '1';
  const token = issueSession('919000000000');
  if (!verifySession(token)) throw new Error('a fresh token did not verify');

  process.env.SESSION_EPOCH = '2';
  if (verifySession(token)) throw new Error('token survived an epoch bump — global logout is broken');

  process.env.SESSION_EPOCH = '1';
  if (!verifySession(token)) throw new Error('token did not come back when the epoch was restored');

  if (before === undefined) delete process.env.SESSION_EPOCH; else process.env.SESSION_EPOCH = before;
  return 'valid, killed by bump, valid again';
});

await step('per-IP rate limiter', async () => {
  resetRateLimit();
  const key = 'dbcheck-ip';
  const opts = { key, limit: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i += 1) {
    if (!rateLimit(opts).ok) throw new Error(`blocked early at attempt ${i + 1}`);
  }
  const blocked = rateLimit(opts);
  if (blocked.ok) throw new Error('did not block past the limit');
  if (!(blocked.retryAfter > 0)) throw new Error('no Retry-After hint');
  // A different caller must be unaffected.
  if (!rateLimit({ ...opts, key: 'other-ip' }).ok) throw new Error('limited the wrong key');
  resetRateLimit();
  return `3 allowed, 4th blocked for ${blocked.retryAfter}s, other IPs unaffected`;
});

const TEST_MEMBER = '919000000099';

await step('assignment: set, reassign, clear, and survive a status change', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;
  const members = (await listMembers()).filter((m) => m.active && [FIX_A, FIX_B].includes(m.phone));
  if (members.length < 2) throw new Error('fixture members missing');
  const [a, b] = members;

  let row = await updateStatus(id, { assignedTo: a.phone, updatedBy: 'db-check' });
  if (row.assigned_to !== a.phone) throw new Error('assignment did not stick');
  if (row.assigned_to_name !== a.name) throw new Error('display name was not resolved from allowed_users');

  row = await updateStatus(id, { assignedTo: b.phone, updatedBy: 'db-check' });
  if (row.assigned_to !== b.phone) throw new Error('reassignment did not stick');

  // An unrelated edit must not silently drop the owner.
  row = await updateStatus(id, { status: 'Called – No answer', updatedBy: 'db-check' });
  if (row.assigned_to !== b.phone) throw new Error('a status change cleared the assignment');

  // Explicit null must clear it — the same "was it supplied" problem callback_at has.
  row = await updateStatus(id, { assignedTo: null, updatedBy: 'db-check' });
  if (row.assigned_to !== null) throw new Error('explicit null did not unassign');

  return `assigned to ${a.name}, reassigned to ${b.name}, survived a status change, cleared`;
});

await step('a rename follows through to assigned carts', async () => {
  // assigned_to stores the phone and the name is resolved at read time, so a
  // rename must not leave stale copies scattered across carts.
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const me = (await listMembers()).find((m) => m.phone === FIX_A);

  await updateStatus(rows[0].id, { assignedTo: me.phone, updatedBy: 'db-check' });
  await updateMember(me.phone, { name: 'Renamed For Check' });

  const listed = (await listCarts({ sinceDays: 0 })).carts.find((c) => c.cart_id === TEST_CART);
  if (listed.assigned_to_name !== 'Renamed For Check') {
    throw new Error(`cart still shows "${listed.assigned_to_name}" after the rename`);
  }

  await updateMember(me.phone, { name: me.name });
  await updateStatus(rows[0].id, { assignedTo: null, updatedBy: 'db-check' });
  return 'cart reflected the new name immediately';
});

await step('member lifecycle: add, update, deactivate, remove', async () => {
  await deleteMember(TEST_MEMBER);   // in case a previous run died mid-way

  const added = await upsertMember({ phone: TEST_MEMBER, name: 'Scratch', addedBy: 'db-check' });
  if (!added.active || added.is_admin) throw new Error('new members should be active, non-admin');

  // Re-adding must update in place, not duplicate — the panel calls this on
  // every "Add" and a stray duplicate would be invisible until login failed.
  await upsertMember({ phone: TEST_MEMBER, name: 'Scratch Two', addedBy: 'db-check' });
  const all = await listMembers();
  if (all.filter((m) => m.phone === TEST_MEMBER).length !== 1) throw new Error('re-adding created a duplicate');
  if (all.find((m) => m.phone === TEST_MEMBER).name !== 'Scratch Two') throw new Error('re-add did not update the name');

  const promoted = await updateMember(TEST_MEMBER, { isAdmin: true });
  if (!promoted.is_admin) throw new Error('promotion did not stick');

  const off = await updateMember(TEST_MEMBER, { active: false });
  if (off.active) throw new Error('deactivation did not stick');
  if (off.name !== 'Scratch Two') throw new Error('a partial update clobbered the name');

  if (!(await deleteMember(TEST_MEMBER))) throw new Error('delete reported nothing removed');
  if ((await listMembers()).some((m) => m.phone === TEST_MEMBER)) throw new Error('member survived deletion');
  return 'added, renamed in place, promoted, deactivated, removed';
});

await step('changing a number moves the member, keeping their details', async () => {
  const MOVED = '919000000098';
  await deleteMember(TEST_MEMBER); await deleteMember(MOVED);

  await upsertMember({ phone: TEST_MEMBER, name: 'Mover', isAdmin: true, addedBy: 'db-check' });
  const before = (await listMembers()).find((m) => m.phone === TEST_MEMBER);

  const moved = await changeMemberPhone(TEST_MEMBER, MOVED);
  if (!moved.ok) throw new Error(`move failed: ${moved.reason}`);
  if (moved.member.name !== 'Mover' || !moved.member.is_admin) throw new Error('name or role lost in the move');
  if (new Date(moved.member.added_at).getTime() !== new Date(before.added_at).getTime()) {
    throw new Error('added_at was reset by the move');
  }

  const all = await listMembers();
  if (all.some((m) => m.phone === TEST_MEMBER)) throw new Error('old number survived the move');
  if (!all.some((m) => m.phone === MOVED)) throw new Error('new number is missing');

  // Moving onto an occupied number must fail and leave both rows intact.
  await upsertMember({ phone: TEST_MEMBER, name: 'Occupier', addedBy: 'db-check' });
  const clash = await changeMemberPhone(MOVED, TEST_MEMBER);
  if (clash.ok) throw new Error('moved onto an occupied number');
  if (clash.reason !== 'taken') throw new Error(`unexpected reason: ${clash.reason}`);
  const after = await listMembers();
  if (!after.some((m) => m.phone === MOVED) || !after.some((m) => m.phone === TEST_MEMBER)) {
    throw new Error('a failed move damaged the table');
  }

  await deleteMember(MOVED); await deleteMember(TEST_MEMBER);
  return 'moved with name, role and added_at intact; collision refused cleanly';
});

await step('last-admin guard counts correctly', async () => {
  // The count that stops the panel locking everyone out of member management.
  const admins = (await listMembers()).filter((m) => m.active && m.is_admin);
  if (!admins.length) throw new Error('no active admin in the table — the panel would be unusable');

  for (const a of admins) {
    const others = await otherActiveAdminCount(a.phone);
    if (others !== admins.length - 1) {
      throw new Error(`otherActiveAdminCount(${a.phone}) = ${others}, expected ${admins.length - 1}`);
    }
  }
  return `${admins.length} active admin(s); guard would ${admins.length === 1 ? 'block' : 'allow'} a demotion`;
});

await step('member changes are audited', async () => {
  await recordMemberChange({ actor: 'db-check', action: 'add', targetPhone: TEST_MEMBER, detail: 'simulated' });
  const found = (await recentMemberChanges(20)).some(
    (l) => l.target_phone === TEST_MEMBER && l.actor === 'db-check');
  if (!found) throw new Error('member change was not recorded');
  return 'add recorded with actor and target';
});

await step('Shopify CSV: one row per line item becomes one cart', async () => {
  // The export repeats a checkout across rows, one per line item, with only the
  // first row carrying Total/Id. Getting this wrong would double-count carts.
  const csv = [
    'Name,Id,Created at,Email,Total,Subtotal,Currency,Discount Amount,Billing Name,Billing Phone,Lineitem name,Lineitem quantity,Shipping City,Source',
    '#1001,5551001,2026-09-16 11:06:32 +0530,a@b.com,900.00,900.00,INR,0.00,Asha Rao,9812345678,Whey 1kg,2,Pune,web',
    '#1001,,,a@b.com,,,,,,,Shaker,1,,',
    '#1002,5551002,2026-09-16 09:00:00 +0530,c@d.com,250.00,250.00,INR,0.00,,,"Multivitamin, 60 tabs",1,,web',
  ].join('\n');

  const { carts, totalRows } = mapShopifyCsv(csv);
  if (totalRows !== 3) throw new Error(`expected 3 rows, got ${totalRows}`);
  if (carts.length !== 2) throw new Error(`3 rows should collapse to 2 carts, got ${carts.length}`);

  const a = carts.find((c) => c.cartId === 'shopify-5551001');
  if (!a) throw new Error('cart id should be namespaced as shopify-<id>');
  if (a.items.length !== 2) throw new Error('the continuation row was dropped');
  if (a.itemCount !== 3) throw new Error(`item count should sum quantities, got ${a.itemCount}`);
  if (a.customerName !== 'Asha Rao' || a.phone !== '9812345678') throw new Error('checkout-level fields lost');
  // "+0530" must be honoured, not assumed UTC.
  if (a.abandonedAt !== '2026-09-16T05:36:32.000Z') throw new Error(`timezone mishandled: ${a.abandonedAt}`);

  const b = carts.find((c) => c.cartId === 'shopify-5551002');
  if (b.items[0].title !== 'Multivitamin, 60 tabs') throw new Error('quoted comma broke the parse');

  return '3 rows -> 2 carts, quantities summed, +0530 honoured';
});

await step('importing twice never duplicates or overwrites a call log', async () => {
  const cart = {
    cartId: TEST_CART, customerName: 'Import Check', phone: '9000000000',
    email: 'import@check.local', totalPrice: 100, currency: 'INR',
    abandonedAt: new Date().toISOString(), itemCount: 1, raw: { _source: 'db-check' },
  };
  await importCarts([cart], { source: 'shopify-csv' });
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;

  await updateStatus(id, { status: 'Called – Recovered', notes: 'keep me', updatedBy: 'A Human' });

  // Re-import the same file, as people do.
  await importCarts([{ ...cart, customerName: 'Import Check Renamed' }], { source: 'shopify-csv' });

  const { rows: after } = await getPool().query(
    'SELECT status, notes, updated_by, customer_name, source FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const { rows: count } = await getPool().query(
    'SELECT count(*)::int AS n FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);

  if (count[0].n !== 1) throw new Error(`re-import created ${count[0].n} rows`);
  if (after[0].status !== 'Called – Recovered') throw new Error('re-import reset the status');
  if (after[0].notes !== 'keep me') throw new Error('re-import wiped the notes');
  if (after[0].updated_by !== 'A Human') throw new Error('re-import overwrote the attribution');
  if (after[0].customer_name !== 'Import Check Renamed') throw new Error('cart fields were not refreshed');
  return 'one row, call log intact, cart fields refreshed';
});

await step('period report buckets day, week and month consistently', async () => {
  const [day, week, month] = await Promise.all([
    periodReport('day', 60), periodReport('week', 60), periodReport('month', 60),
  ]);
  const sum = (rows) => rows.reduce((n, r) => n + r.carts, 0);
  if (sum(day) !== sum(week) || sum(week) !== sum(month)) {
    throw new Error(`totals disagree: day ${sum(day)}, week ${sum(week)}, month ${sum(month)}`);
  }

  // Buckets are text, not timestamps: a `timestamp without time zone` returns as
  // a local Date and toISOString() then shifts every IST bucket a day earlier.
  for (const r of day) {
    if (typeof r.bucket !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.bucket)) {
      throw new Error(`bucket should be a YYYY-MM-DD string, got ${typeof r.bucket}: ${r.bucket}`);
    }
    if (r.recovered > r.worked) throw new Error('recovered exceeds worked in a bucket');
    if (r.worked > r.carts) throw new Error('worked exceeds carts in a bucket');
  }

  // Daily buckets must agree with the dashboard's own per-day rollup.
  const ov = await adminOverview(0);
  for (const d of day) {
    const match = ov.byDay.find((x) => x.day === d.bucket);
    if (match && match.carts !== d.carts) {
      throw new Error(`${d.bucket}: report says ${d.carts}, dashboard says ${match.carts}`);
    }
  }
  return `${sum(day)} carts across ${day.length} day(s), ${week.length} week(s), ${month.length} month(s)`;
});

await step('drill-down returns exactly the carts behind a number', async () => {
  const ov = await adminOverview(0);
  const recovered = await cartsByStatus('Called – Recovered', { sinceDays: 0 });
  if (recovered.length !== ov.totals.recovered) {
    throw new Error(`headline says ${ov.totals.recovered} recovered, drill-down returns ${recovered.length}`);
  }
  if (recovered.some((c) => c.status !== 'Called – Recovered')) {
    throw new Error('drill-down returned a cart with the wrong status');
  }
  return `${recovered.length} recovered cart(s), matching the headline`;
});

await step('presence: last seen is recorded and ages out', async () => {
  await upsertMember({ phone: TEST_MEMBER, name: 'Presence Test', addedBy: 'db-check' });

  await touchLastSeen(TEST_MEMBER);
  const online = await whoIsOnline(5);
  if (!online.some((o) => o.phone === TEST_MEMBER)) throw new Error('a just-seen member is not online');

  // Backdate them past the window; they must drop off rather than linger.
  await getPool().query(
    "UPDATE allowed_users SET last_seen_at = now() - interval '30 minutes' WHERE phone = $1", [TEST_MEMBER]);
  if ((await whoIsOnline(5)).some((o) => o.phone === TEST_MEMBER)) {
    throw new Error('a member seen 30 minutes ago still counts as online');
  }

  // A deactivated member must never show as online.
  await touchLastSeen(TEST_MEMBER);
  await updateMember(TEST_MEMBER, { active: false });
  if ((await whoIsOnline(5)).some((o) => o.phone === TEST_MEMBER)) {
    throw new Error('a deactivated member shows as online');
  }

  await deleteMember(TEST_MEMBER);
  return 'seen now = online, 30m ago = offline, deactivated = never';
});

await step('admin overview aggregates agree with the board', async () => {
  const o = await adminOverview(0);
  const list = await listCarts({ sinceDays: 0 });

  if (o.totals.carts !== list.total) {
    throw new Error(`overview counts ${o.totals.carts} carts, the board ${list.total}`);
  }
  if (o.totals.recovered > o.totals.worked) throw new Error('recovered exceeds worked');
  if (o.totals.worked > o.totals.carts) throw new Error('worked exceeds total carts');

  // Recovered + still open + lost must be the whole pot. If these ever drift,
  // the money panel is telling the owner something untrue.
  const parts = o.totals.recovered_value + o.totals.open_value + o.totals.declined_value;
  if (Math.abs(parts - o.totals.value) > 0.01) {
    throw new Error(`money splits sum to ${parts}, total cart value is ${o.totals.value}`);
  }

  const byDayTotal = o.byDay.reduce((n, d) => n + d.carts, 0);
  if (byDayTotal !== o.totals.carts) {
    throw new Error(`per-day rows sum to ${byDayTotal}, totals say ${o.totals.carts}`);
  }
  // `sources` was split in two: utm_source is the marketing channel, source is
  // which system sent us the cart. They were never the same thing.
  for (const key of ['stages', 'risk', 'utm', 'bySource', 'callers']) {
    if (!Array.isArray(o[key])) throw new Error(`${key} missing from the overview`);
  }
  return `${o.totals.carts} carts, ${o.totals.worked} worked, ${o.totals.recovered} recovered; per-day sums match`;
});

await step('allowlist table readable', async () => {
  const { activeUsers } = await import('../lib/otp.js');
  const m = await activeUsers();
  if (m.size === 0) throw new Error('allowed_users is empty and ALLOWED_PHONES is unset — nobody could log in');
  return `${m.size} active: ${[...m.keys()].map((p) => '...' + p.slice(-4)).join(', ')}`;
});

/**
 * The history table is only worth having if it cannot miss a write, so this
 * checks both directions: a real transition logs exactly one event, and a
 * notes-only save logs none.
 */
await step('a note edit is never counted as a call attempt', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;
  // Status events only. Note edits are logged too now, but as their own kind —
  // the thing that must never inflate is the count of call attempts.
  const countEvents = async () => (await getPool().query(
    `SELECT count(*)::int AS n FROM cart_events
     WHERE cart_id = $1 AND kind = 'status'`, [id])).rows[0].n;

  const before = await countEvents();
  await updateStatus(id, { status: 'Not called', updatedBy: 'DBCheck Bot' });
  await updateStatus(id, { status: 'Called – No answer', updatedBy: 'DBCheck Bot' });
  const afterMoves = await countEvents();

  // Same status again, only the note changes — must not look like another attempt.
  await updateStatus(id, { notes: 'db-check note only', updatedBy: 'DBCheck Bot' });
  const afterNote = await countEvents();
  if (afterNote !== afterMoves) throw new Error('a notes-only save was logged as a transition');

  const { rows: last } = await getPool().query(
    `SELECT from_status, to_status, actor, note_len FROM cart_events
     WHERE cart_id = $1 AND kind = 'status'
     ORDER BY at DESC, id DESC LIMIT 1`, [id]);
  if (last[0].to_status !== 'Called – No answer') {
    throw new Error(`last event to_status was ${last[0].to_status}`);
  }
  if (last[0].actor !== 'DBCheck Bot') throw new Error('actor not recorded');
  return `${afterMoves - before} transition(s) logged, note-only save ignored`;
});

await step('cart_events is removed with its cart', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;
  const { rows: n } = await getPool().query(
    'SELECT count(*)::int AS n FROM cart_events WHERE cart_id = $1', [id]);
  if (n[0].n === 0) throw new Error('no events to test the cascade with');
  // Proven for real in cleanup below, which deletes the cart; here we only
  // assert the constraint exists, so a future schema edit cannot drop it
  // silently and leave orphaned history behind.
  const { rows: fk } = await getPool().query(
    `SELECT confdeltype FROM pg_constraint
     WHERE conrelid = 'cart_events'::regclass AND contype = 'f'`);
  if (!fk.length || fk[0].confdeltype !== 'c') throw new Error('ON DELETE CASCADE is missing');
  return `${n[0].n} event(s), cascade constraint present`;
});

/**
 * The whole point of ACTION_BUCKETS being one shared constant: a headline count
 * and the list it opens must never disagree. This is the check that keeps them
 * honest as either query gets edited.
 */
await step('action queue counts match the carts behind them', async () => {
  const q = await actionQueue(6);
  const pairs = [
    ['unassigned', q.unassigned],
    ['callbacks_today', q.callbacks_today],
    ['callbacks_overdue', q.callbacks_overdue],
    ['stale', q.stale],
  ];
  for (const [bucket, n] of pairs) {
    const rows = await cartsForBucket(bucket, { slaHours: 6, limit: 1000 });
    if (rows.length !== n) {
      throw new Error(`${bucket}: count says ${n}, drill-down returned ${rows.length}`);
    }
  }
  if (Object.keys(ACTION_BUCKETS).length !== pairs.length) {
    throw new Error('a bucket was added without a matching check');
  }
  return pairs.map(([b, n]) => `${b}=${n}`).join(', ');
});

await step('an unknown bucket is refused, not silently empty', async () => {
  try {
    await cartsForBucket('everything');
    throw new Error('a bogus bucket returned rows instead of throwing');
  } catch (err) {
    if (!/Unknown bucket/.test(err.message)) throw err;
    return 'rejected';
  }
});

await step('the report is bounded by the buckets it displays', async () => {
  const rows = await periodReport('day', 3);
  if (rows.length > 3) throw new Error(`asked for 3 buckets, got ${rows.length}`);
  const oldest = rows.at(-1)?.bucket;
  if (oldest) {
    const ageDays = Math.round((Date.now() - new Date(oldest + 'T00:00:00Z').getTime()) / 86400000);
    if (ageDays > 4) throw new Error(`oldest bucket ${oldest} is ${ageDays}d old, window not applied`);
  }
  return `${rows.length} bucket(s), oldest ${oldest ?? 'none'}`;
});

/**
 * received_at is when the cart reached us; abandoned_at is when the customer
 * left. Conflating them made a late CSV import read as an instant SLA breach
 * against callers who had only just been given it.
 */
await step('an imported cart is received now, not when it was abandoned', async () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  await importCarts([{
    cartId: TEST_CART, customerName: 'DBCheck Import', phone: '9000000001',
    totalPrice: 10, currency: 'INR', abandonedAt: tenDaysAgo, raw: { dbcheck: true },
  }], { source: 'shopify-csv' });
  const { rows } = await getPool().query(
    `SELECT received_at, abandoned_at,
            EXTRACT(EPOCH FROM (now() - received_at))::int AS received_age_s
     FROM abandoned_carts WHERE cart_id = $1`, [TEST_CART]);
  if (rows[0].received_age_s > 120) {
    throw new Error(`received_at is ${rows[0].received_age_s}s old — it took abandoned_at`);
  }
  const abandonedAgeDays = Math.round((Date.now() - new Date(rows[0].abandoned_at).getTime()) / 86400000);
  if (abandonedAgeDays !== 10) throw new Error(`abandoned_at is ${abandonedAgeDays}d old, expected 10`);
  return 'received now, abandoned 10 days ago';
});

await step('today and yesterday are reported separately', async () => {
  const d = await dailySnapshot();
  for (const k of ['today', 'yesterday']) {
    for (const f of ['carts', 'value', 'called', 'recovered', 'recovered_value']) {
      if (d[k][f] === undefined) throw new Error(`${k}.${f} missing`);
    }
  }
  return `today ${d.today.carts} cart(s), yesterday ${d.yesterday.carts}`;
});

/**
 * The evening digest, checked without spending a WhatsApp credit — the whole
 * reason the wording and the timing were kept as pure functions.
 */
await step('daily summary says what happened and what is outstanding', async () => {
  const text = buildDailySummary({
    today: { carts: 10, value: 7016.92, called: 4, recovered: 2, recovered_value: 1840 },
    queue: { unassigned: 8, stale: 1, callbacks_overdue: 2 },
    callers: [{ caller: 'Prayag Patel', touched: 4 }, { caller: 'Idle Person', touched: 0 }],
    slaHours: 6,
  });
  for (const want of ['10 carts in', '₹7,017', '4 called', '2 recovered', '8 unassigned',
                      '1 uncalled 6h+', '2 callbacks missed', 'Prayag Patel: 4']) {
    if (!text.includes(want)) throw new Error(`summary is missing "${want}":\n${text}`);
  }
  // Somebody who did nothing today should not be listed as having done nothing.
  if (text.includes('Idle Person')) throw new Error('listed a caller with no activity');

  const quiet = buildDailySummary({
    today: { carts: 3, value: 1200, called: 3, recovered: 0, recovered_value: 0 },
    queue: { unassigned: 0, stale: 0, callbacks_overdue: 0 }, callers: [], slaHours: 6,
  });
  if (quiet.includes('Needs doing')) throw new Error('a clear queue still produced a to-do line');
  return `${text.split('\n').length} lines busy, ${quiet.split('\n').length} quiet`;
});

await step('the summary latch survives a redeploy', async () => {
  // IST is UTC+5:30, so IST h:00 is UTC (h-6):30.
  const at = (h) => new Date(Date.UTC(2026, 8, 23, h - 6, 30));
  const cases = [
    ['before the hour', shouldSendSummary(null, { hour: 20, now: at(19) }), false],
    ['after, unsent', shouldSendSummary(null, { hour: 20, now: at(21) }), true],
    // This is the one that matters: a restart re-runs the timer, and without a
    // day latch the same evening's message would go out again.
    ['already sent today', shouldSendSummary(boardDay(at(21)), { hour: 20, now: at(21) }), false],
    ['sent yesterday', shouldSendSummary('2026-09-22', { hour: 20, now: at(21) }), true],
  ];
  for (const [label, got, want] of cases) {
    if (got !== want) throw new Error(`${label}: got ${got}, expected ${want}`);
  }
  return `${cases.length} timing cases correct`;
});

/**
 * The log has to record what changed, not merely that something did — and one
 * row per changed thing, so a notes edit never reads as another call attempt.
 */
await step('every kind of change is logged, separately', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;
  await getPool().query('DELETE FROM cart_events WHERE cart_id = $1', [id]);

  const when = new Date(Date.now() + 7200_000).toISOString();
  await updateStatus(id, { status: 'Callback scheduled', callbackAt: when, updatedBy: 'DBCheck Bot' });
  await updateStatus(id, { notes: 'rang, will call at 4', updatedBy: 'DBCheck Bot' });
  await updateStatus(id, { reasonTags: ['Shipping time', 'Out of stock'], updatedBy: 'DBCheck Bot' });

  const events = await cartEvents(id);
  const kinds = events.map((e) => e.kind);
  for (const want of ['status', 'callback', 'note', 'reason']) {
    if (!kinds.includes(want)) throw new Error(`no "${want}" event logged; got ${kinds.join(', ')}`);
  }
  const note = events.find((e) => e.kind === 'note');
  if (note.detail !== 'rang, will call at 4') throw new Error(`note detail was "${note.detail}"`);
  const reason = events.find((e) => e.kind === 'reason');
  if (reason.detail !== 'Shipping time, Out of stock') throw new Error(`reason detail was "${reason.detail}"`);
  const cb = events.find((e) => e.kind === 'callback');
  if (!/\d{2} \w{3} \d{4}/.test(cb.detail)) throw new Error(`callback detail unreadable: "${cb.detail}"`);

  // Saving the same values again must add nothing at all.
  const before = events.length;
  await updateStatus(id, { notes: 'rang, will call at 4', reasonTags: ['Shipping time', 'Out of stock'], updatedBy: 'DBCheck Bot' });
  const after = (await cartEvents(id)).length;
  if (after !== before) throw new Error(`a no-op save logged ${after - before} event(s)`);

  return `${kinds.join(' + ')}; no-op save logged nothing`;
});

await step('the activity log reads across carts with context', async () => {
  const feed = await recentEvents({ limit: 20 });
  if (!feed.length) throw new Error('activity log is empty');
  const mine = feed.find((e) => e.actor === 'DBCheck Bot');
  if (!mine) throw new Error('recent change missing from the feed');
  for (const f of ['kind', 'actor', 'at', 'cart_id']) {
    if (mine[f] === undefined) throw new Error(`feed row is missing ${f}`);
  }
  if (!('customer_name' in mine)) throw new Error('feed does not join the cart it belongs to');
  return `${feed.length} entries, newest by ${feed[0].actor ?? 'unknown'}`;
});

await step('a callback time can be read back for validation', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const set = await callbackAtOf(rows[0].id);
  if (!set) throw new Error('callback time did not persist');
  const missing = await callbackAtOf(-1);
  if (missing !== undefined) throw new Error('a non-existent cart should report undefined');
  return 'present for a real cart, undefined for a missing one';
});

/**
 * P0: a promised callback outlives any date window.
 *
 * This is the regression that matters most here — 14 callbacks existed while
 * the seven-day default showed 9 and "Today" showed 5, so a caller changing
 * the range watched promised callbacks disappear.
 */
await step('callbacks survive every date range', async () => {
  const { rows } = await getPool().query('SELECT id FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  const id = rows[0].id;
  // A callback promised for today on a cart that arrived 20 days ago: outside
  // every window the board offers, and overdue.
  await getPool().query(
    `UPDATE abandoned_carts
     SET received_at = now() - interval '20 days',
         status = 'Callback scheduled',
         callback_at = now() - interval '18 minutes'
     WHERE id = $1`, [id]);

  const seen = {};
  for (const days of [1, 3, 7, 0]) {
    const r = await listCarts({ sinceDays: days });
    seen[days] = r.carts.some((c) => String(c.id) === String(id));
    if (r.callbackTotal === undefined) throw new Error('listCarts no longer reports callbackTotal');
  }
  const missing = Object.entries(seen).filter(([, v]) => !v).map(([d]) => d);
  if (missing.length) {
    throw new Error(`a 20-day-old callback vanished at days=${missing.join(',')}`);
  }

  // And a cart that is merely old, with no callback, must still be excluded —
  // otherwise the "fix" is just disabling the window.
  await getPool().query(
    `UPDATE abandoned_carts SET status = 'Called – No answer', callback_at = NULL WHERE id = $1`, [id]);
  const narrow = await listCarts({ sinceDays: 1 });
  if (narrow.carts.some((c) => String(c.id) === String(id))) {
    throw new Error('the date window stopped applying to ordinary carts');
  }
  return 'visible at 1/3/7/all days; still excluded once it is not a callback';
});

await step('CSV export neutralises formulas without mangling numbers', async () => {
  const cases = [
    ['=cmd|/c calc', "\"'=cmd|/c calc\""],
    ['+1+1', "\"'+1+1\""],
    ['@SUM(A1)', "\"'@SUM(A1)\""],
    ['-100', '"-100"'],        // a negative number must survive intact
    ['-12.5', '"-12.5"'],
    ['0', '"0"'],
    ['plain note', '"plain note"'],
    ['say "hi"', '"say ""hi"""'],
  ];
  for (const [input, want] of cases) {
    const got = csvCell(input);
    if (got !== want) throw new Error(`csvCell(${JSON.stringify(input)}) = ${got}, expected ${want}`);
  }
  const csv = toCsv([['Head', (r) => r.v]], [{ v: '=danger' }, { v: -5 }]);
  if (!csv.includes("'=danger")) throw new Error('toCsv did not guard a formula');
  if (csv.includes("'-5")) throw new Error('toCsv mangled a negative number');
  return `${cases.length} cases, formulas guarded, negatives intact`;
});


// ---- orders & logistics ----------------------------------------------------
const TEST_ORDER = 'DBCHECK-ORDER-DELETE-ME';
const ACTOR = 'db-check';
const NOW = () => new Date().toISOString();
let orderId = null;
const primary = async (id) => (await orderShipments(id))[0];

await step('orders schema, shipment table migration, sequence untouched', async () => {
  const before = (await getPool().query(`SELECT last_value FROM orders_id_seq`).catch(() => ({ rows: [{}] }))).rows[0].last_value;
  await ensureOrdersSchema();
  await purgeTestOrders(TEST_ORDER); // leftovers from an interrupted run
  const cols = (await getPool().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'`)).rows.map((r) => r.column_name);
  for (const gone of ['shipment_status', 'courier_partner_id', 'tracking_id', 'dispatch_date']) {
    if (cols.includes(gone)) throw new Error(`orders still has ${gone}`);
  }
  if (!cols.includes('fulfillment_type')) throw new Error('fulfillment_type missing');
  const after = (await getPool().query(`SELECT last_value FROM orders_id_seq`)).rows[0].last_value;
  if (before && Number(after) < Number(before)) throw new Error('sequence went backwards');
  return `orders_id_seq at ${after}`;
});
// Every test order needs a valid route now: a dispatch type the channel is
// used for and, for everything but Easy Ship, one of its destinations.
const ROUTES = {};
await step('dispatch routes: types per channel and seeded destinations', async () => {
  const dests = await listDestinations();
  for (const [ch, type] of [['website', 'easy_ship'], ['amazon', 'warehouse'], ['blinkit', 'quick_commerce'],
    ['instamart', 'quick_commerce'], ['zepto', 'quick_commerce'], ['bigbasket', 'partner'], ['retailers', 'retailer']]) {
    const d = dests.find((x) => x.channel === ch && x.dispatch_type === type);
    if (type !== 'easy_ship' && !d) throw new Error(`no ${type} destination for ${ch}`);
    ROUTES[ch] = { dispatch_type: type, destination_id: type === 'easy_ship' ? null : d.id };
  }
  const n = (t) => dests.filter((d) => d.dispatch_type === t).length;
  return `warehouse ${n('warehouse')}, quick commerce ${n('quick_commerce')}, partner ${n('partner')}, retailer ${n('retailer')}`;
});
const R = (channel) => ROUTES[channel] || {};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
/** Adds a dispatch photo (fake storage), which the dispatch rule now requires. */
const addPhoto = (orderId) => saveUploadedDocument({ orderId, filename: 'dispatch.jpg', buffer: JPEG,
  documentType: 'dispatch_product_image', actor: 'db-check',
  store: { async put() {}, async remove() {} } });

await step('create order: one empty shipment, numbering continues', async () => {
  orderId = await createOrder({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-1`,
    order_date: NOW(), order_value: '1,299.50' }, { actor: ACTOR });
  const o = await getOrder(orderId);
  if (!/^ORD-\d{6}$/.test(o.internal_order_id)) throw new Error(`bad internal id ${o.internal_order_id}`);
  if (o.order_value !== 1299.5 || o.order_status !== 'new' || o.shipment_status !== 'not_ready') throw new Error('defaults wrong');
  if (o.payment_method !== null || o.payment_status !== null || o.fulfillment_type !== null) throw new Error('nullable fields not null');
  if ((await orderShipments(orderId)).length !== 1) throw new Error('no shipment created');
  return o.internal_order_id;
});
await step('manual entry: only channel + order number required; value/date optional; note saved', async () => {
  const id = await createOrder({ ...R('instamart'), channel: 'instamart', source_order_id: `${TEST_ORDER}-min`, note: 'Box damaged at pickup' }, { actor: ACTOR });
  const o = await getOrder(id);
  if (o.order_value !== null || o.order_date !== null || o.currency !== 'INR') throw new Error('optional fields not empty');
  const ev = await orderEvents(id);
  if (!ev.some((e) => e.event_type === 'note_added' && e.metadata.note === 'Box damaged at pickup')) throw new Error('note not logged');
  // Undated orders sort and filter by when they were entered (today, IST).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const r = await listOrders({ q: `${TEST_ORDER}-min`, from: today, to: today });
  if (r.total !== 1 || r.withoutValue !== 1) throw new Error(`filter total=${r.total} withoutValue=${r.withoutValue}`);
  // Value can be added later, then cleared again.
  await updateOrder(id, { order_value: '850' }, { actor: ACTOR, version: o.version });
  const o2 = await getOrder(id);
  await updateOrder(id, { order_value: '' }, { actor: ACTOR, version: o2.version });
  if ((await getOrder(id)).order_value !== null) throw new Error('value not cleared');
  return 'value/date null, note on timeline, undated order filed under entry day';
});
await step('create rejects missing required fields and unknown channel', async () => {
  for (const bad of [{}, { channel: 'amazon' }, { channel: 'nope', source_order_id: 'x', order_date: NOW(), order_value: 1 },
    { channel: 'amazon', source_order_id: `${TEST_ORDER}-x`, order_date: NOW(), order_value: -1 },
    { channel: 'amazon', source_order_id: `${TEST_ORDER}-x`, order_date: '24/09/2026', order_value: 1 }]) {
    try { await createOrder(bad, { actor: ACTOR }); throw new Error(`accepted ${JSON.stringify(bad)}`); }
    catch (err) { if (err.status !== 400) throw err; }
  }
  return 'refused with 400';
});
await step('duplicate channel + source order ID is refused and points at the original', async () => {
  try {
    await createOrder({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-1`, order_date: NOW(), order_value: 1 }, { actor: ACTOR });
    throw new Error('duplicate accepted');
  } catch (err) {
    if (err.status !== 409 || err.existingId !== orderId) throw err;
  }
  await createOrder({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-1`, order_date: NOW(), order_value: 10 }, { actor: ACTOR });
  return '409 with existing id; other channel allowed';
});
await step('channel filtering and tab counts', async () => {
  const r = await listOrders({ channel: 'amazon', q: TEST_ORDER });
  if (r.orders.some((o) => o.channel !== 'amazon')) throw new Error('filter leaked');
  if (r.channelCounts.amazon !== 1 || r.channelCounts.blinkit !== 1) throw new Error(`counts ${JSON.stringify(r.channelCounts)}`);
  return 'amazon 1, blinkit 1';
});
await step('payment model: allowed values, nullable, others refused', async () => {
  let o = await getOrder(orderId);
  await updateOrder(orderId, { payment_method: 'cod', payment_status: 'partially_refunded' }, { actor: ACTOR, version: o.version });
  o = await getOrder(orderId);
  if (o.payment_method !== 'cod' || o.payment_status !== 'partially_refunded') throw new Error('not saved');
  for (const bad of [{ payment_method: 'UPI' }, { payment_status: 'cod' }]) {
    try { await updateOrder(orderId, bad, { actor: ACTOR, version: o.version }); throw new Error(`accepted ${JSON.stringify(bad)}`); }
    catch (err) { if (err.status !== 400) throw err; }
  }
  try { await getPool().query(`UPDATE orders SET payment_method = 'upi' WHERE id = $1`, [orderId]); throw new Error('db accepted upi'); }
  catch (err) { if (err.code !== '23514') throw err; }
  await updateOrder(orderId, { payment_method: null, payment_status: null }, { actor: ACTOR, version: o.version });
  o = await getOrder(orderId);
  if (o.payment_method !== null) throw new Error('could not clear');
  return '4 methods / 7 statuses; DB check constraint enforced';
});
await step('fulfillment type is independent of channel', async () => {
  let o = await getOrder(orderId); // amazon
  await updateOrder(orderId, { fulfillment_type: 'merchant' }, { actor: ACTOR, version: o.version });
  const w = await createOrder({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-w`, order_date: NOW(), order_value: 5,
    fulfillment_type: 'third_party' }, { actor: ACTOR });
  if ((await getOrder(orderId)).fulfillment_type !== 'merchant' || (await getOrder(w)).fulfillment_type !== 'third_party') {
    throw new Error('not stored as given');
  }
  try { await createOrder({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-z`, order_date: NOW(), order_value: 5, fulfillment_type: 'dropship' }, { actor: ACTOR }); throw new Error('accepted dropship'); }
  catch (err) { if (err.status !== 400) throw err; }
  return 'amazon+merchant, website+third_party accepted';
});
await step('edit order details writes an order_edited event', async () => {
  const o = await getOrder(orderId);
  await updateOrder(orderId, { customer_name: 'DB Check', order_value: 1400 }, { actor: ACTOR, version: o.version });
  const ev = (await orderEvents(orderId)).find((e) => e.event_type === 'order_edited' && e.metadata.changes.order_value);
  if (!ev || ev.metadata.changes.order_value.to !== 1400) throw new Error('edit not logged');
  return 'logged with from/to';
});
await step('stale version is refused — order and shipment each guarded', async () => {
  const o = await getOrder(orderId);
  await updateOrder(orderId, { customer_phone: '9000000001' }, { actor: 'tab-a', version: o.version });
  try { await updateOrder(orderId, { customer_phone: '9000000002' }, { actor: 'tab-b', version: o.version }); throw new Error('stale order write accepted'); }
  catch (err) { if (err.status !== 409) throw err; }
  if ((await getOrder(orderId)).customer_phone !== '9000000001') throw new Error('first write lost');
  const s = await primary(orderId);
  await updateShipment(orderId, s.id, { expected_delivery_date: '2026-10-01' }, { actor: 'tab-a', version: s.version });
  try { await updateShipment(orderId, s.id, { expected_delivery_date: '2026-10-05' }, { actor: 'tab-b', version: s.version }); throw new Error('stale shipment write accepted'); }
  catch (err) { if (err.status !== 409) throw err; }
  if ((await primary(orderId)).expected_delivery_date !== '2026-10-01') throw new Error('shipment first write lost');
  return 'both second writers got 409';
});
await step('order and shipment lifecycles are independent; cancellation leaves the shipment alone', async () => {
  let s = await primary(orderId);
  await updateShipment(orderId, s.id, { shipment_status: 'packed' }, { actor: ACTOR, version: s.version });
  let o = await getOrder(orderId);
  if (o.order_status !== 'new') throw new Error('shipment touched order status');
  await updateOrder(orderId, { order_status: 'cancelled' }, { actor: ACTOR, version: o.version });
  if ((await primary(orderId)).shipment_status !== 'packed') throw new Error('cancellation changed the shipment');
  o = await getOrder(orderId);
  try { await updateOrder(orderId, { shipment_status: 'cancelled' }, { actor: ACTOR, version: o.version }); throw new Error('order edit moved a shipment'); }
  catch (err) { if (err.status !== 400) throw err; }
  await updateOrder(orderId, { order_status: 'confirmed' }, { actor: ACTOR, version: o.version });
  return 'cancelled order kept a packed shipment';
});
await step('dispatch needs courier and AWB', async () => {
  const s = await primary(orderId);
  try { await updateShipment(orderId, s.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: s.version }); throw new Error('dispatched without AWB'); }
  catch (err) { if (err.status !== 400) throw err; }
  return 'refused';
});
await step('courier + AWB generate the tracking URL; switching courier drops it', async () => {
  const couriers = await listCouriers();
  const delhivery = couriers.find((c) => c.name === 'Delhivery');
  const porter = couriers.find((c) => c.name === 'Porter');
  await addPhoto(orderId);
  let s = await primary(orderId);
  await updateShipment(orderId, s.id, { courier_partner_id: delhivery.id, tracking_id: 'AWB 123/9', shipment_status: 'dispatched' },
    { actor: ACTOR, version: s.version });
  s = await primary(orderId);
  const want = trackingUrlFor(delhivery.tracking_url_template, 'AWB 123/9');
  if (s.tracking_url !== want || !want.endsWith('AWB%20123%2F9')) throw new Error(`url ${s.tracking_url}`);
  if (!s.dispatch_date) throw new Error('dispatch_date not stamped');
  await updateShipment(orderId, s.id, { courier_partner_id: porter.id }, { actor: ACTOR, version: s.version });
  s = await primary(orderId);
  if (s.tracking_url) throw new Error('stale Delhivery link kept');
  await updateShipment(orderId, s.id, { courier_partner_id: delhivery.id }, { actor: ACTOR, version: s.version });
  return 'encoded AWB, dispatch stamped';
});
await step('courier patterns start unverified; changing a pattern clears verification', async () => {
  const seeded = (await listCouriers()).filter((c) => c.tracking_url_template);
  if (seeded.some((c) => c.template_verified_at && c.name === 'Other')) throw new Error('unexpected');
  const c = await saveCourier({ name: 'DBCheck Courier', template: 'https://example.com/t/{awb}' }, { actor: ACTOR });
  if (c.template_verified_at) throw new Error('new courier born verified');
  let v = await saveCourier({ id: c.id, verified: true }, { actor: ACTOR });
  if (!v.template_verified_at || v.template_verified_by !== ACTOR) throw new Error('verify not recorded');
  v = await saveCourier({ id: c.id, template: 'https://example.com/track/{awb}' }, { actor: ACTOR });
  if (v.template_verified_at) throw new Error('changed pattern stayed verified');
  await getPool().query('DELETE FROM courier_partners WHERE id = $1', [c.id]);
  return `${seeded.filter((x) => !x.template_verified_at).length} seeded patterns unverified`;
});
await step('schema supports several shipments per order; the first stays primary', async () => {
  await getPool().query(`INSERT INTO order_shipments (order_id, created_by) VALUES ($1, $2)`, [orderId, ACTOR]);
  const o = await getOrder(orderId);
  const all = await orderShipments(orderId);
  if (all.length !== 2 || o.shipment_count !== 2 || o.shipment_id !== all[0].id) throw new Error('primary shipment wrong');
  if (o.shipment_status !== 'dispatched') throw new Error('list shows the wrong shipment');
  return '2 shipments, list shows the first';
});
await step('delivered stamps delivered_at; logistics views follow the shipment', async () => {
  let s = await primary(orderId);
  let r = await listOrders({ view: 'in_transit', q: `${TEST_ORDER}-1`, channel: 'amazon' });
  if (r.total !== 1) throw new Error('not in In transit');
  await updateShipment(orderId, s.id, { shipment_status: 'delivered' }, { actor: ACTOR, version: s.version });
  s = await primary(orderId);
  if (!s.delivered_at) throw new Error('delivered_at missing');
  r = await listOrders({ view: 'delivered', q: `${TEST_ORDER}-1`, channel: 'amazon' });
  if (r.total !== 1) throw new Error('not in Delivered');
  return 'in transit → delivered';
});
await step('timezone: wall-clock input is IST, stored UTC, day filters use IST boundaries', async () => {
  if (zonedToUtc('2026-09-24T11:30', 'Asia/Kolkata') !== '2026-09-24T06:00:00.000Z') throw new Error('IST conversion');
  if (zonedToUtc('2026-07-01T12:00', 'America/New_York') !== '2026-07-01T16:00:00.000Z') throw new Error('other-zone conversion');
  // 00:15 IST on the 24th is still the 23rd in UTC.
  const id = await createOrder({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-tz`, order_date: '2026-09-24T00:15', order_value: 1 }, { actor: ACTOR });
  const o = await getOrder(id);
  if (o.order_date.toISOString() !== '2026-09-23T18:45:00.000Z') throw new Error(`stored ${o.order_date.toISOString()}`);
  const on24 = await listOrders({ q: `${TEST_ORDER}-tz`, from: '2026-09-24', to: '2026-09-24' });
  const on23 = await listOrders({ q: `${TEST_ORDER}-tz`, from: '2026-09-23', to: '2026-09-23' });
  if (on24.total !== 1 || on23.total !== 0) throw new Error(`24th=${on24.total} 23rd=${on23.total}`);
  const explicit = await createOrder({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-tz2`, order_date: '2026-09-24T00:15:00Z', order_value: 1 }, { actor: ACTOR });
  if ((await getOrder(explicit)).order_date.toISOString() !== '2026-09-24T00:15:00.000Z') throw new Error('explicit UTC shifted');
  return '00:15 IST → 18:45Z the day before, filed on the IST day';
});
await step('document validation (type, signature, size)', async () => {
  const pdf = Buffer.from('%PDF-1.4\n%test\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const cases = [
    [validateDocument('a.pdf', pdf).ok, true], [validateDocument('a.PNG', png).ok, true],
    [validateDocument('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ok, true],
    [validateDocument('a.exe', pdf).ok, false], [validateDocument('a.pdf', png).ok, false],
    [validateDocument('a.pdf', Buffer.alloc(0)).ok, false],
    [validateDocument('a.pdf', Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024)])).ok, false],
  ];
  cases.forEach(([got, want], i) => { if (got !== want) throw new Error(`case ${i}`); });
  return `${cases.length} cases`;
});
await step('upload flow: multiple documents, soft removal, object deleted if the DB write fails', async () => {
  const calls = [];
  const objects = new Map();
  const fake = {
    async put(k, b) { calls.push(['put', k]); objects.set(k, b); },
    async get(k) { return objects.get(k); },
    async remove(k) { calls.push(['remove', k]); objects.delete(k); },
  };
  const pdf = Buffer.from('%PDF-1.4 dbcheck');
  for (const [type, name] of [['tax_invoice', 'invoice.pdf'], ['courier_receipt', 'receipt.pdf']]) {
    await saveUploadedDocument({ orderId, filename: name, buffer: pdf, documentType: type, actor: ACTOR, store: fake });
  }
  // This order also carries a dispatch photo (added for the dispatch rule); count papers only.
  const papers = async () => (await orderDocuments(orderId)).filter((d) => d.document_type !== 'dispatch_product_image');
  let docs = await papers();
  if (docs.length !== 2 || objects.size !== 2) throw new Error(`${docs.length} rows, ${objects.size} objects`);
  if (!(await getOrder(orderId)).has_invoice) throw new Error('has_invoice false');
  // DB write fails (order does not exist): the stored object must be removed.
  try { await saveUploadedDocument({ orderId: 999999999, filename: 'x.pdf', buffer: pdf, documentType: 'other', actor: ACTOR, store: fake }); throw new Error('accepted'); }
  catch (err) { if (err.status !== 404) throw err; }
  const last = calls.slice(-2);
  if (last[0][0] !== 'put' || last[1][0] !== 'remove' || last[0][1] !== last[1][1] || objects.size !== 2) throw new Error('orphan left behind');
  // Invalid files never reach storage.
  const before = calls.length;
  try { await saveUploadedDocument({ orderId, filename: 'x.exe', buffer: pdf, documentType: 'other', actor: ACTOR, store: fake }); } catch { /* expected */ }
  if (calls.length !== before) throw new Error('invalid file was stored');
  const inv = docs.find((d) => d.document_type === 'tax_invoice');
  await removeDocument(orderId, inv.id, { actor: ACTOR });
  docs = await papers();
  if (docs.length !== 2 || !docs.find((d) => d.id === inv.id).removed_at) throw new Error('removal was not soft');
  if ((await getOrder(orderId)).has_invoice) throw new Error('removed invoice still counted');
  return '2 stored, failed write cleaned up, invalid file never stored';
});
await step('storage: R2 request signing matches the AWS reference example', async () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "GET Object"
  const auth = signV4({
    method: 'GET', path: '/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', amzDate: '20130524T000000Z',
  });
  if (!auth.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')) throw new Error(auth);
  return 'signature identical';
});
await step('storage: production refuses local disk; R2 needs credentials', async () => {
  const saved = { ...process.env };
  const restore = () => { for (const k of ['RENDER', 'NODE_ENV', 'DOCUMENT_STORAGE', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  } _resetStorage(); };
  try {
    const expectRefused = (label) => { _resetStorage(); try { storage(); throw new Error(`${label}: allowed`); } catch (e) { if (!(e instanceof StorageNotConfigured)) throw e; } };
    process.env.RENDER = 'true'; process.env.DOCUMENT_STORAGE = 'local'; expectRefused('local on Render');
    delete process.env.DOCUMENT_STORAGE; for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) delete process.env[k];
    expectRefused('R2 without credentials');
    Object.assign(process.env, { R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' });
    _resetStorage();
    if (storage().name !== 'r2' || !storage().durable) throw new Error('did not default to R2 in production');
  } finally { restore(); }
  return 'local refused, R2 default, missing credentials refused';
});
await step('audit log is complete and append-only', async () => {
  await addOrderNote(orderId, 'db-check note', { actor: ACTOR });
  const events = await orderEvents(orderId);
  const types = new Set(events.map((e) => e.event_type));
  for (const t of ['order_created', 'order_edited', 'order_status_changed', 'shipment_status_changed',
    'courier_changed', 'tracking_changed', 'shipment_dates_changed', 'document_uploaded', 'document_removed', 'note_added']) {
    if (!types.has(t)) throw new Error(`missing ${t}`);
  }
  if (!events.filter((e) => e.event_type === 'shipment_status_changed').every((e) => e.metadata.shipment_id)) {
    throw new Error('shipment event without shipment_id');
  }
  for (const q of ['UPDATE order_events SET actor = $2 WHERE order_id = $1', 'DELETE FROM order_events WHERE order_id = $1']) {
    try {
      await getPool().query(q, q.startsWith('UPDATE') ? [orderId, 'tamper'] : [orderId]);
      throw new Error(`allowed: ${q.split(' ')[0]}`);
    } catch (err) { if (!/append-only/.test(err.message)) throw err; }
  }
  try { await getPool().query('DELETE FROM orders WHERE id = $1', [orderId]); throw new Error('order with history deleted'); }
  catch (err) { if (err.code !== '23503') throw err; }
  return `${types.size} event types; UPDATE/DELETE refused`;
});
await step('permissions: roles map to areas; existing callers unchanged', async () => {
  const table = [['admin', true, true], ['caller', false, true], ['logistics', true, false], [undefined, false, false]];
  for (const [role, orders, recovery] of table) {
    if (canUseOrders(role) !== orders || canUseRecovery(role) !== recovery) throw new Error(`role ${role}`);
  }
  await upsertMember({ phone: TEST_MEMBER, name: 'DB Check', isAdmin: false, addedBy: 'db-check' });
  if (await roleFor(TEST_MEMBER) !== 'caller') throw new Error('new member not a caller by default');
  await getPool().query(`UPDATE allowed_users SET role = 'logistics' WHERE phone = $1`, [TEST_MEMBER]);
  if (await roleFor(TEST_MEMBER) !== 'logistics') throw new Error('logistics role not read');
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM allowed_users WHERE role IS NOT NULL AND phone <> $1`, [TEST_MEMBER]);
  return `matrix ok; ${rows[0].n} real members have a role set`;
});
await step('orders cleanup (sequence left as is)', async () => {
  const { orders } = await purgeTestOrders(TEST_ORDER);
  const left = await getPool().query('SELECT count(*)::int AS n FROM orders WHERE source_order_id LIKE $1', [`${TEST_ORDER}%`]);
  if (left.rows[0].n) throw new Error('orders left behind');
  return `${orders} orders removed`;
});

// ---- new shipment (shipment-first entry) -------------------------------------
await step('new shipment: creates order + shipment in one step; Packed by default, never Dispatched', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const r = await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-S1`, courier_partner_id: dl.id,
    tracking_id: 'AWB-S1-a', note: 'first box' }, { actor: ACTOR });
  if (!r.createdOrder) throw new Error('order not created');
  const o = await getOrder(r.orderId);
  const ships = await orderShipments(r.orderId);
  if (ships.length !== 1 || ships[0].id !== r.shipmentId) throw new Error(`${ships.length} shipments`);
  if (o.shipment_status !== 'packed' || o.dispatch_date) throw new Error(`status ${o.shipment_status}, dispatched ${o.dispatch_date}`);
  if (o.tracking_url !== trackingUrlFor(dl.tracking_url_template, 'AWB-S1-a')) throw new Error(`url ${o.tracking_url}`);
  const types = (await orderEvents(r.orderId)).map((e) => e.event_type);
  for (const t of ['order_created', 'courier_changed', 'tracking_changed', 'shipment_status_changed', 'note_added']) {
    if (!types.includes(t)) throw new Error(`missing ${t}`);
  }
  return `1 order, 1 shipment, packed, link built, ${types.length} events`;
});
await step('new shipment: required fields; explicit Dispatched is honoured and stamped', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  for (const bad of [{ channel: 'zepto', source_order_id: `${TEST_ORDER}-S2`, tracking_id: 'X' },
    { channel: 'zepto', source_order_id: `${TEST_ORDER}-S2`, courier_partner_id: dl.id },
    { channel: 'zepto', courier_partner_id: dl.id, tracking_id: 'X' }]) {
    try { await createShipment(bad, { actor: ACTOR }); throw new Error(`accepted ${JSON.stringify(bad)}`); }
    catch (err) { if (err.status !== 400) throw err; }
  }
  if ((await listOrders({ q: `${TEST_ORDER}-S2` })).total !== 0) throw new Error('a refused shipment left an order behind');
  // Dispatched straight away is refused for a brand-new order: there is no photo yet.
  try {
    await createShipment({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-S2`, courier_partner_id: dl.id,
      tracking_id: 'AWB-S2', shipment_status: 'dispatched' }, { actor: ACTOR });
    throw new Error('dispatched without a photo');
  } catch (err) { if (err.status !== 400 || !err.needsPhoto) throw err; }
  if ((await listOrders({ q: `${TEST_ORDER}-S2` })).total !== 0) throw new Error('refused create left an order behind');
  // The screen's way: saved as Packed, photo added, then Dispatched.
  const r = await createShipment({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-S2`, courier_partner_id: dl.id,
    tracking_id: 'AWB-S2' }, { actor: ACTOR });
  await addPhoto(r.orderId);
  const sh = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const o = await getOrder(r.orderId);
  if (o.shipment_status !== 'dispatched' || !o.dispatch_date) throw new Error('dispatch not stamped');
  return 'missing fields refused; Dispatched without a photo refused (nothing saved); with a photo, stamped';
});
await step('new shipment on an existing order: no duplicate order; offers the order instead', async () => {
  const bd = (await listCouriers()).find((c) => c.name === 'Blue Dart');
  try {
    await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-S1`, courier_partner_id: bd.id, tracking_id: 'AWB-S1-b' }, { actor: ACTOR });
    throw new Error('second order accepted');
  } catch (err) {
    if (err.status !== 409 || !err.orderExists || err.shipments?.length !== 1 || err.shipments[0].awb !== 'AWB-S1-a') throw err;
  }
  const n = (await listOrders({ q: `${TEST_ORDER}-S1`, channel: 'blinkit' })).total;
  if (n !== 1) throw new Error(`${n} orders`);
  // Same number on another channel is a different order.
  const other = await createShipment({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-S1`, courier_partner_id: bd.id, tracking_id: 'AWB-S1-a' }, { actor: ACTOR });
  if (!other.createdOrder) throw new Error('other channel treated as the same order');
  return '409 with the existing shipment listed; still one Blinkit order';
});
await step('new shipment: add another shipment to an existing order; duplicate AWB refused', async () => {
  const bd = (await listCouriers()).find((c) => c.name === 'Blue Dart');
  const r = await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-S1`, courier_partner_id: bd.id,
    tracking_id: 'AWB-S1-b' }, { actor: ACTOR, addToExisting: true });
  if (r.createdOrder) throw new Error('made a new order');
  const ships = await orderShipments(r.orderId);
  if (ships.length !== 2 || ships[1].tracking_id !== 'AWB-S1-b') throw new Error(`${ships.length} shipments`);
  if (!(await orderEvents(r.orderId)).some((e) => e.event_type === 'shipment_added' && e.metadata.shipment_id === r.shipmentId)) {
    throw new Error('shipment_added not logged');
  }
  // The list still shows the first shipment; the second is counted.
  const o = await getOrder(r.orderId);
  if (o.tracking_id !== 'AWB-S1-a' || o.shipment_count !== 2) throw new Error('list row changed');
  for (const awb of ['AWB-S1-b', ' awb-s1-A ']) {
    try { await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-S1`, courier_partner_id: bd.id, tracking_id: awb }, { actor: ACTOR, addToExisting: true }); throw new Error(`duplicate ${awb} accepted`); }
    catch (err) { if (err.status !== 409 || !err.duplicateAwb) throw err; }
  }
  if ((await orderShipments(r.orderId)).length !== 2) throw new Error('duplicate created a shipment');
  return '2 shipments; repeated AWB (any case/spacing) refused';
});
await step('new shipment fills an order\'s untouched shipment instead of adding an empty one', async () => {
  const id = await createOrder({ ...R('instamart'), channel: 'instamart', source_order_id: `${TEST_ORDER}-S3` }, { actor: ACTOR });
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  try { await createShipment({ ...R('instamart'), channel: 'instamart', source_order_id: `${TEST_ORDER}-S3`, courier_partner_id: dl.id, tracking_id: 'AWB-S3' }, { actor: ACTOR }); throw new Error('no confirmation asked'); }
  catch (err) { if (err.status !== 409 || !err.canFillShipment || err.shipments.length !== 0) throw err; }
  const r = await createShipment({ ...R('instamart'), channel: 'instamart', source_order_id: `${TEST_ORDER}-S3`, courier_partner_id: dl.id,
    tracking_id: 'AWB-S3' }, { actor: ACTOR, addToExisting: true });
  const ships = await orderShipments(id);
  if (ships.length !== 1 || ships[0].tracking_id !== 'AWB-S3' || r.orderId !== id) throw new Error('did not fill the blank shipment');
  return 'blank shipment filled, still one';
});
await step('new shipment: concurrent entries cannot duplicate an order or an AWB', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const base = { channel: 'website', source_order_id: `${TEST_ORDER}-S4`, courier_partner_id: dl.id };
  const race = await Promise.allSettled([1, 2, 3].map((i) => createShipment({ ...R(base.channel), ...base, tracking_id: `AWB-S4-${i}` }, { actor: `tab-${i}` })));
  const won = race.filter((x) => x.status === 'fulfilled');
  const lost = race.filter((x) => x.status === 'rejected');
  if (won.length !== 1 || lost.some((x) => !x.reason.orderExists)) throw new Error(`won ${won.length}; ${lost.map((x) => x.reason.message)}`);
  if ((await listOrders({ q: `${TEST_ORDER}-S4` })).total !== 1) throw new Error('duplicate order');
  const id = won[0].value.orderId;
  const race2 = await Promise.allSettled([1, 2].map((i) => createShipment({ ...R(base.channel), ...base, tracking_id: 'AWB-S4-SAME' }, { actor: `tab-${i}`, addToExisting: true })));
  const won2 = race2.filter((x) => x.status === 'fulfilled').length;
  if (won2 !== 1 || !race2.find((x) => x.status === 'rejected')?.reason.duplicateAwb) throw new Error(`won ${won2}`);
  if ((await orderShipments(id)).filter((x) => x.tracking_id === 'AWB-S4-SAME').length !== 1) throw new Error('AWB duplicated');
  return '3 simultaneous creates → 1 order; 2 simultaneous same-AWB adds → 1 shipment';
});
await step('new shipment: invoice and receipt attach to the order', async () => {
  const id = (await listOrders({ q: `${TEST_ORDER}-S1`, channel: 'blinkit' })).orders[0].id;
  const objects = new Map();
  const fake = { async put(k, b) { objects.set(k, b); }, async remove(k) { objects.delete(k); } };
  await saveUploadedDocument({ orderId: id, filename: 'inv.pdf', buffer: Buffer.from('%PDF-1.4 i'), documentType: 'tax_invoice', actor: ACTOR, store: fake });
  await saveUploadedDocument({ orderId: id, filename: 'rcpt.png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), documentType: 'courier_receipt', actor: ACTOR, store: fake });
  const docs = await orderDocuments(id);
  if (!docs.some((d) => d.document_type === 'tax_invoice') || !docs.some((d) => d.document_type === 'courier_receipt')) throw new Error('missing a document');
  if (!(await getOrder(id)).has_invoice || objects.size !== 2) throw new Error('invoice flag / storage');
  return 'tax invoice + courier receipt stored';
});

// ---- dispatch product images -------------------------------------------------
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.4 x');
await step('dispatch image formats: JPG, JPEG, PNG, WEBP accepted; others and fakes refused', async () => {
  const img = DOCUMENT_FORMATS.dispatch_product_image;
  const cases = [
    ['a.jpg', JPG, true], ['a.JPEG', JPG, true], ['a.png', PNG, true], ['a.webp', WEBP, true],
    ['a.pdf', PDF, false],                                         // photos only
    ['a.jpg', Buffer.from('MZ\x90\x00 not an image'), false],        // executable renamed .jpg
    ['a.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]), false], // RIFF but not WEBP
    ['a.png', JPG, false],                                         // extension and bytes disagree
    ['a.gif', Buffer.from('GIF89a'), false], ['a.webp', Buffer.alloc(0), false],
  ];
  cases.forEach(([name, buf, want], i) => {
    const got = validateDocument(name, buf, img).ok;
    if (got !== want) throw new Error(`case ${i} (${name}) → ${got}`);
  });
  // Every other type keeps exactly its old formats: PDF yes, WEBP no.
  if (!validateDocument('inv.pdf', PDF).ok || validateDocument('inv.webp', WEBP).ok) throw new Error('invoice formats changed');
  return `${cases.length} cases; invoice/receipt formats unchanged`;
});
let proofOrder = null;
await step('multiple dispatch images per shipment, stored in document storage, no receipt needed', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const r = await createShipment({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-IMG`, courier_partner_id: dl.id, tracking_id: 'AWB-IMG' }, { actor: ACTOR });
  proofOrder = r.orderId;
  const store = storage();
  const ids = [];
  for (const [name, buf] of [['carton-1.jpg', JPG], ['label.png', PNG], ['package.webp', WEBP]]) {
    ids.push(await saveUploadedDocument({ orderId: proofOrder, filename: name, buffer: buf, documentType: 'dispatch_product_image', actor: ACTOR, store }));
  }
  const docs = (await orderDocuments(proofOrder)).filter((d) => d.document_type === 'dispatch_product_image');
  if (docs.length !== 3) throw new Error(`${docs.length} images`);
  const mimes = docs.map((d) => d.mime_type).sort().join(',');
  if (mimes !== 'image/jpeg,image/png,image/webp') throw new Error(mimes);
  const rows = (await getPool().query('SELECT storage_path FROM order_documents WHERE id = ANY($1)', [ids])).rows;
  for (const { storage_path: key } of rows) {
    if (!/^orders\/\d{4}-\d{2}\/\d+-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) throw new Error(`key ${key}`);
    if (!(await store.get(key)).length) throw new Error('object missing');
  }
  const o = await getOrder(proofOrder);
  if (o.dispatch_image_count !== 3 || o.has_invoice) throw new Error(`count ${o.dispatch_image_count}`);
  // No courier receipt anywhere, and the shipment still moves on.
  const s = (await orderShipments(proofOrder))[0];
  await updateShipment(proofOrder, s.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: s.version });
  if ((await getOrder(proofOrder)).shipment_status !== 'dispatched') throw new Error('dispatch blocked');
  return `3 images (jpg/png/webp) under random keys; dispatched with no receipt (${store.name} storage)`;
});
await step('dispatch images: failed DB write removes the stored image; audit events written', async () => {
  const calls = [];
  const fake = { async put(k) { calls.push(['put', k]); }, async remove(k) { calls.push(['remove', k]); } };
  try { await saveUploadedDocument({ orderId: 999999999, filename: 'x.jpg', buffer: JPG, documentType: 'dispatch_product_image', actor: ACTOR, store: fake }); throw new Error('accepted'); }
  catch (err) { if (err.status !== 404) throw err; }
  if (calls.length !== 2 || calls[1][0] !== 'remove' || calls[0][1] !== calls[1][1]) throw new Error('orphan left: ' + JSON.stringify(calls));
  const img = (await orderDocuments(proofOrder)).find((d) => d.original_filename === 'label.png');
  await removeDocument(proofOrder, img.id, { actor: ACTOR });
  const ev = await orderEvents(proofOrder);
  const up = ev.filter((e) => e.event_type === 'document_uploaded' && e.metadata.document_type === 'dispatch_product_image');
  const rm = ev.find((e) => e.event_type === 'document_removed' && e.metadata.document_id === img.id);
  if (up.length !== 3 || !up.every((e) => e.actor === ACTOR && e.metadata.filename && e.metadata.document_id && e.at)) throw new Error('upload events');
  if (!rm || rm.metadata.document_type !== 'dispatch_product_image') throw new Error('removal event');
  if (JSON.stringify(ev).includes('RIFF') || JSON.stringify(ev).includes('storage_path')) throw new Error('bytes or keys in the log');
  if ((await getOrder(proofOrder)).dispatch_image_count !== 2) throw new Error('count after removal');
  return '3 uploaded + 1 removed logged with filename, actor, time, id; no bytes or keys';
});
await step('existing tax invoice / courier receipt behaviour unchanged', async () => {
  const objects = new Map();
  const fake = { async put(k, b) { objects.set(k, b); }, async remove(k) { objects.delete(k); } };
  await saveUploadedDocument({ orderId: proofOrder, filename: 'inv.pdf', buffer: PDF, documentType: 'tax_invoice', actor: ACTOR, store: fake });
  await saveUploadedDocument({ orderId: proofOrder, filename: 'rcpt.jpg', buffer: JPG, documentType: 'courier_receipt', actor: ACTOR, store: fake });
  for (const [t, name, buf] of [['tax_invoice', 'x.webp', WEBP], ['courier_receipt', 'x.webp', WEBP]]) {
    try { await saveUploadedDocument({ orderId: proofOrder, filename: name, buffer: buf, documentType: t, actor: ACTOR, store: fake }); throw new Error(`${t} accepted webp`); }
    catch (err) { if (err.status !== 400) throw err; }
  }
  if (!(await getOrder(proofOrder)).has_invoice) throw new Error('invoice flag');
  return 'PDF invoice + JPG receipt accepted as before; their formats did not widen';
});

// ---- dispatch types, destinations, dispatch photo rule ------------------------
await step('routes: dispatch type must fit the channel; destination must fit both', async () => {
  const dests = await listDestinations();
  const of = (ch, t) => dests.find((d) => d.channel === ch && d.dispatch_type === t).id;
  const base = { order_date: NOW(), order_value: 1 };
  const refuse = async (label, input) => {
    try { await createOrder({ ...base, ...input }, { actor: ACTOR }); throw new Error(`accepted: ${label}`); }
    catch (err) { if (err.status !== 400) throw err; }
  };
  await refuse('Amazon with no type (it has two)', { channel: 'amazon', source_order_id: `${TEST_ORDER}-RT1` });
  await refuse('Amazon warehouse with no destination', { channel: 'amazon', dispatch_type: 'warehouse', source_order_id: `${TEST_ORDER}-RT1` });
  await refuse('Blinkit with a Zepto hub', { channel: 'blinkit', dispatch_type: 'quick_commerce', destination_id: of('zepto', 'quick_commerce'), source_order_id: `${TEST_ORDER}-RT1` });
  await refuse('Flipkart as a warehouse', { channel: 'flipkart', dispatch_type: 'warehouse', source_order_id: `${TEST_ORDER}-RT1` });
  await refuse('Amazon FBA code used for Tata 1mg', { channel: 'tata_1mg', dispatch_type: 'warehouse', destination_id: of('amazon', 'warehouse'), source_order_id: `${TEST_ORDER}-RT1` });
  // A one-type channel takes its type by default; Easy Ship drops any destination.
  const a = await createOrder({ ...base, channel: 'blinkit', destination_id: of('blinkit', 'quick_commerce'), source_order_id: `${TEST_ORDER}-RT2` }, { actor: ACTOR });
  const b = await createOrder({ ...base, channel: 'amazon', dispatch_type: 'easy_ship', destination_id: of('amazon', 'warehouse'), source_order_id: `${TEST_ORDER}-RT3` }, { actor: ACTOR });
  const oa = await getOrder(a); const ob = await getOrder(b);
  if (oa.dispatch_type !== 'quick_commerce' || !/BLINK COMMERCE/.test(oa.destination_name)) throw new Error(`blinkit ${oa.dispatch_type} ${oa.destination_name}`);
  if (ob.dispatch_type !== 'easy_ship' || ob.destination_id !== null) throw new Error('easy ship kept a destination');
  // Changing the destination later is checked the same way and logged.
  await updateOrder(a, { destination_id: of('blinkit', 'quick_commerce') + 1 }, { actor: ACTOR, version: oa.version });
  const ev = (await orderEvents(a)).find((e) => e.event_type === 'order_edited' && e.metadata.changes.destination_id);
  if (!ev) throw new Error('destination change not logged');
  try { await updateOrder(a, { destination_id: of('zepto', 'quick_commerce') }, { actor: ACTOR, version: oa.version + 1 }); throw new Error('wrong hub accepted'); }
  catch (err) { if (err.status !== 400) throw err; }
  return '5 wrong routes refused; one-type channel defaulted; Easy Ship has no destination; change logged';
});
await step('dispatch photo is required to leave, not to move between later stages', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const r = await createShipment({ ...R('bigbasket'), channel: 'bigbasket', source_order_id: `${TEST_ORDER}-PH`, courier_partner_id: dl.id, tracking_id: 'AWB-PH' }, { actor: ACTOR });
  let sh = (await orderShipments(r.orderId))[0];
  for (const to of ['dispatched', 'in_transit', 'delivered', 'rto']) {
    try { await updateShipment(r.orderId, sh.id, { shipment_status: to }, { actor: ACTOR, version: sh.version }); throw new Error(`${to} without photo`); }
    catch (err) { if (!err.needsPhoto) throw err; }
  }
  // Courier receipt is still not needed; only the photo.
  const docId = await addPhoto(r.orderId);
  await updateShipment(r.orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  // Removing the photo afterwards does not freeze the shipment in transit.
  await removeDocument(r.orderId, docId, { actor: ACTOR });
  sh = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, sh.id, { shipment_status: 'in_transit' }, { actor: ACTOR, version: sh.version });
  if ((await getOrder(r.orderId)).shipment_status !== 'in_transit') throw new Error('stuck');
  return 'dispatched/in transit/delivered/RTO refused with no photo; allowed with one; later stages not re-checked';
});
await step('destinations: admins add, rename and switch off; mismatches refused', async () => {
  const d = await saveDestination({ channel: 'retailers', dispatch_type: 'retailer', name: 'DBCHECK Retailer' });
  const renamed = await saveDestination({ id: d.id, name: 'DBCHECK Retailer Renamed' });
  const off = await saveDestination({ id: d.id, active: false });
  if (renamed.name !== 'DBCHECK Retailer Renamed' || off.active) throw new Error('edit not saved');
  if ((await listDestinations()).some((x) => x.id === d.id)) throw new Error('inactive listed for selection');
  try { await createOrder({ channel: 'retailers', dispatch_type: 'retailer', destination_id: d.id, source_order_id: `${TEST_ORDER}-OFF` }, { actor: ACTOR }); throw new Error('inactive destination accepted'); }
  catch (err) { if (err.status !== 400) throw err; }
  for (const bad of [{ channel: 'flipkart', dispatch_type: 'warehouse', name: 'DBCHECK X' }, { channel: 'retailers', dispatch_type: 'easy_ship', name: 'DBCHECK Y' },
    { channel: 'retailers', dispatch_type: 'retailer', name: '  ' }]) {
    try { await saveDestination(bad); throw new Error(`accepted ${JSON.stringify(bad)}`); } catch (err) { if (err.status !== 400) throw err; }
  }
  try { await saveDestination({ channel: 'retailers', dispatch_type: 'retailer', name: 'DBCHECK Retailer Renamed' }); throw new Error('duplicate accepted'); }
  catch (err) { if (err.code !== '23505') throw err; }
  return 'added, renamed, switched off (and then unusable); wrong type, Easy Ship, blank and duplicate refused';
});
await step('list: dispatch-type tabs and destination filter', async () => {
  const r = await listOrders({ q: TEST_ORDER });
  const qc = await listOrders({ q: TEST_ORDER, type: 'quick_commerce' });
  if (qc.orders.some((o) => o.dispatch_type !== 'quick_commerce')) throw new Error('type filter leaked');
  if (r.typeCounts.quick_commerce !== qc.total) throw new Error(`tab count ${r.typeCounts.quick_commerce} vs ${qc.total}`);
  const one = qc.orders.find((o) => o.destination_id);
  const byDest = await listOrders({ q: TEST_ORDER, destination: one.destination_id });
  if (!byDest.total || byDest.orders.some((o) => o.destination_id !== one.destination_id)) throw new Error('destination filter');
  return `tabs ${JSON.stringify(r.typeCounts)}`;
});

// ---- shared shipments: several orders under one AWB ---------------------------
let sharedShip = null;
const amz = { dispatch_type: 'easy_ship', channel: 'amazon' };
await step('shared shipment: one AWB, three independent Amazon orders (created together)', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const r = await createShipment({ ...amz, source_order_id: `${TEST_ORDER}-AZ-A`, order_date: '2026-09-28T10:00', order_value: 1200,
    courier_partner_id: dl.id, tracking_id: 'AWB-SHARED-1',
    extra_orders: [{ source_order_id: `${TEST_ORDER}-AZ-B`, order_date: '2026-09-28T12:00', order_value: 800 },
      { source_order_id: `${TEST_ORDER}-AZ-C`, order_date: '2026-09-29T09:00', order_value: 1500 }] }, { actor: ACTOR });
  sharedShip = r.shipmentId;
  const members = await shipmentMembers(sharedShip);
  if (members.length !== 3 || members[0].role !== 'lead' || members[0].id !== r.orderId) throw new Error(JSON.stringify(members.map((m) => m.role)));
  const total = members.reduce((a, m) => a + m.order_value, 0);
  if (total !== 3500) throw new Error(`total ${total}`);
  // Each keeps its own date and value; all show the shared AWB and status in the list.
  const list = await listOrders({ q: 'AWB-SHARED-1' });
  if (list.total !== 3 || list.orders.some((o) => o.tracking_id !== 'AWB-SHARED-1' || o.orders_in_shipment !== 3 || o.shipment_status !== 'packed')) {
    throw new Error(`list ${list.total}`);
  }
  const b = list.orders.find((o) => o.source_order_id.endsWith('AZ-B'));
  if (!b.in_shared_shipment || b.order_value !== 800) throw new Error('member order not independent');
  if ((await sharedShipmentOf(b.id)).id !== sharedShip) throw new Error('order does not know its shipment');
  const ev = await orderEvents(r.orderId);
  if (ev.filter((e) => e.event_type === 'shipment_order_attached').length !== 2) throw new Error('lead events');
  if (!(await orderEvents(b.id)).some((e) => e.event_type === 'attached_to_shipment' && e.metadata.tracking_id === 'AWB-SHARED-1')) throw new Error('member event');
  return '3 orders, ₹3,500, different dates, one AWB; each order finds its shipment';
});
await step('shared shipment: an existing order is attached, never duplicated', async () => {
  const d = await createOrder({ ...amz, source_order_id: `${TEST_ORDER}-AZ-D`, order_value: 450 }, { actor: ACTOR });
  // By id…
  const cand = await attachableOrders(sharedShip);
  if (!cand.some((x) => x.id === d)) throw new Error('not offered');
  await attachToShipment(sharedShip, { orderIds: [d] }, { actor: ACTOR });
  // …and typing an existing number while adding new orders attaches that order too.
  const e = await createOrder({ ...amz, source_order_id: `${TEST_ORDER}-AZ-E`, order_value: 90 }, { actor: ACTOR });
  await attachToShipment(sharedShip, { newOrders: [{ source_order_id: `${TEST_ORDER}-AZ-E`, order_value: 1 }] }, { actor: ACTOR });
  const n = (await getPool().query('SELECT count(*)::int n FROM orders WHERE source_order_id = $1', [`${TEST_ORDER}-AZ-E`])).rows[0].n;
  if (n !== 1 || (await getOrder(e)).order_value !== 90) throw new Error('duplicated or overwritten');
  if ((await shipmentMembers(sharedShip)).length !== 5) throw new Error('members');
  return 'attached by id and by number; one row each, values untouched';
});
await step('shared shipment: no order in two shipments; wrong channel/type/destination refused', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const other = await createShipment({ ...amz, source_order_id: `${TEST_ORDER}-AZ-X`, courier_partner_id: dl.id, tracking_id: 'AWB-SHARED-2' }, { actor: ACTOR });
  const b = (await listOrders({ q: `${TEST_ORDER}-AZ-B` })).orders[0].id;
  const expect = async (label, fn, check) => { try { await fn(); throw new Error(`accepted: ${label}`); } catch (err) { if (!check(err)) throw err; } };
  await expect('order already in a shared shipment', () => attachToShipment(other.shipmentId, { orderIds: [b] }, { actor: ACTOR }), (e) => e.alreadyShipped);
  await expect('lead of a shipment with its own AWB', () => attachToShipment(sharedShip, { orderIds: [other.orderId] }, { actor: ACTOR }), (e) => e.alreadyShipped);
  const lead = (await shipmentMembers(sharedShip))[0].id;
  await expect('lead into its own shipment', () => attachToShipment(sharedShip, { orderIds: [lead] }, { actor: ACTOR }), (e) => e.status === 400);
  const web = await createOrder({ channel: 'website', source_order_id: `${TEST_ORDER}-AZ-W` }, { actor: ACTOR });
  await expect('another channel', () => attachToShipment(sharedShip, { orderIds: [web] }, { actor: ACTOR }), (e) => e.status === 400);
  const fba = await createOrder({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-AZ-F` }, { actor: ACTOR });
  await expect('Amazon FBA into an Easy Ship parcel', () => attachToShipment(sharedShip, { orderIds: [fba] }, { actor: ACTOR }), (e) => e.status === 400);
  // Two people add the same order to two shipments at once: one wins.
  const g = await createOrder({ ...amz, source_order_id: `${TEST_ORDER}-AZ-G` }, { actor: ACTOR });
  const race = await Promise.allSettled([attachToShipment(sharedShip, { orderIds: [g] }, { actor: 'tab-1' }), attachToShipment(other.shipmentId, { orderIds: [g] }, { actor: 'tab-2' })]);
  if (race.filter((x) => x.status === 'fulfilled').length !== 1) throw new Error('race: both or neither won');
  // All-or-nothing: one bad order in a batch leaves nothing attached.
  const h = await createOrder({ ...amz, source_order_id: `${TEST_ORDER}-AZ-H` }, { actor: ACTOR });
  const before = (await shipmentMembers(other.shipmentId)).length;
  await expect('batch with a bad order', () => attachToShipment(other.shipmentId, { orderIds: [h, web] }, { actor: ACTOR }), (e) => e.status === 400);
  if ((await shipmentMembers(other.shipmentId)).length !== before || (await sharedShipmentOf(h))) throw new Error('partial batch kept');
  return 'already-shipped, self, other channel, other dispatch type refused; race → 1 winner; batches all-or-nothing';
});
await step('shared shipment: one photo rule and one status for all; take an order out', async () => {
  const lead = (await shipmentMembers(sharedShip))[0].id;
  let sh = (await orderShipments(lead))[0];
  try { await updateShipment(lead, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }); throw new Error('no photo'); }
  catch (err) { if (!err.needsPhoto) throw err; }
  await addPhoto(lead);
  await updateShipment(lead, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const list = await listOrders({ q: 'AWB-SHARED-1' });
  if (list.orders.some((o) => o.shipment_status !== 'dispatched' || o.dispatch_image_count !== 1)) throw new Error('members did not follow the shipment');
  const b = list.orders.find((o) => o.source_order_id.endsWith('AZ-B')).id;
  await detachFromShipment(sharedShip, b, { actor: ACTOR });
  const ob = await getOrder(b);
  if (ob.in_shared_shipment || ob.shipment_status !== 'not_ready' || ob.tracking_id) throw new Error('detached order still shows the shared shipment');
  if ((await shipmentMembers(sharedShip)).some((m) => m.id === b)) throw new Error('still a member');
  if (!(await orderEvents(b)).some((e) => e.event_type === 'detached_from_shipment')) throw new Error('detach not logged');
  const hist = (await getPool().query('SELECT detached_at FROM shipment_orders WHERE order_id = $1', [b])).rows;
  if (hist.length !== 1 || !hist[0].detached_at) throw new Error('history row lost');
  return 'photo needed once for the parcel; members show dispatched; detached order back on its own, history kept';
});
await step('courier list includes Shree Tirupati Courier and it can be used', async () => {
  const c = (await listCouriers()).find((x) => x.name === 'Shree Tirupati Courier');
  if (!c || !c.active || c.tracking_url_template) throw new Error(JSON.stringify(c));
  const r = await createShipment({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-STC`, courier_partner_id: c.id, tracking_id: 'STC123' }, { actor: ACTOR });
  const o = await getOrder(r.orderId);
  if (o.courier_name !== 'Shree Tirupati Courier' || o.tracking_url !== null) throw new Error('not used');
  return 'active, no tracking pattern (link pasted by hand), usable on a shipment';
});

// ---- Amazon order import ------------------------------------------------------
// Fixtures follow Seller Central's order report: one row per line item, plus the
// promotion-detail row Amazon writes after a discounted item.
const AMZ_HEAD = ['order-id', 'order-item-id', 'purchase-date', 'payments-date', 'buyer-email', 'buyer-name', 'buyer-phone-number',
  'sku', 'product-name', 'quantity-purchased', 'currency', 'item-price', 'item-tax', 'shipping-price', 'shipping-tax',
  'gift-wrap-price', 'ship-service-level', 'recipient-name', 'ship-city', 'ship-state', 'ship-postal-code', 'ship-country',
  'item-promotion-discount', 'item-promotion-id', 'ship-promotion-discount', 'ship-promotion-id', 'payment-method',
  'cod-collectible-amount', 'is-business-order', 'purchase-order-number', 'is-prime', 'fulfilled-by', 'is-iba'];
const AZ = (n) => `${TEST_ORDER}-AMZ-${n}`;
// Imports are recorded under this name, so the test purge also removes their history rows.
const IMPORTER = `${TEST_ORDER}-importer`;
const amzShipments = async () => (await getPool().query(
  `SELECT count(*)::int n FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1`, [`${TEST_ORDER}-AMZ-%`])).rows[0].n;
const amzRow = (o) => {
  const v = { 'purchase-date': '2026-09-20T10:15:00+00:00', 'payments-date': '2026-09-20T10:16:00+00:00', 'buyer-name': 'Test Buyer',
    sku: 'SKU-1', 'product-name': 'Test product', 'quantity-purchased': '1', currency: 'INR', 'item-price': '499.00', 'item-tax': '76.12',
    'shipping-price': '0', 'shipping-tax': '0', 'ship-service-level': 'Standard', 'ship-city': 'PUNE', 'ship-country': 'IN',
    'is-prime': 'false', 'is-business-order': 'false', 'fulfilled-by': 'Easy Ship', 'gift-wrap-price': '9', 'is-iba': 'false', ...o };
  return AMZ_HEAD.map((h) => v[h] ?? '');
};
const amzCsv = (rows) => Buffer.from([AMZ_HEAD, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'));
const amzCount = async () => (await getPool().query(`SELECT count(*)::int n FROM orders WHERE channel = 'amazon' AND source_order_id LIKE $1`, [`${TEST_ORDER}-AMZ-%`])).rows[0].n;
const amzOrder = async (n) => (await listOrders({ q: AZ(n), channel: 'amazon' })).orders.find((o) => o.source_order_id === AZ(n));

await step('amazon import: one order, one item', async () => {
  const file = amzCsv([amzRow({ 'order-id': AZ(1), 'order-item-id': 'I1' })]);
  const p = await previewAmazonImport(file, 'one.csv');
  if (p.summary.newOrders !== 1 || p.summary.lineItems !== 1 || p.errorCount || await amzCount()) throw new Error(`preview ${JSON.stringify(p.summary)}`);
  const r = await commitAmazonImport(file, 'one.csv', { actor: IMPORTER });
  if (r.summary.ordersCreated !== 1 || r.summary.lineItemsAdded !== 1) throw new Error(JSON.stringify(r.summary));
  const o = await amzOrder(1);
  const items = await orderItems(o.id);
  if (o.dispatch_type !== 'easy_ship' || o.order_value !== 499 || o.source !== 'amazon_import') throw new Error(JSON.stringify(o));
  if (o.shipment_id !== null || o.shipment_status !== null || (await orderShipments(o.id)).length) throw new Error('import created a shipment');
  if (items.length !== 1 || items[0].source_line_item_id !== 'I1' || items[0].item_tax !== 76.12) throw new Error(JSON.stringify(items));
  if ('gift-wrap-price' in (o.source_payload.amazon || {}) || JSON.stringify(o.source_payload).includes('gift')) throw new Error('ignored column stored');
  return 'preview wrote nothing; import made 1 order (Easy Ship, ₹499) + 1 item and no shipment; ignored columns not stored';
});
await step('amazon import: one order with two items; several orders in one file', async () => {
  const file = amzCsv([
    amzRow({ 'order-id': AZ(2), 'order-item-id': 'I1', 'item-price': '100', 'shipping-price': '80' }),
    amzRow({ 'order-id': AZ(2), 'order-item-id': 'I2', sku: 'SKU-2', 'quantity-purchased': '3', 'item-price': '300' }),
    amzRow({ 'order-id': AZ(3), 'order-item-id': 'I1', 'payment-method': 'COD' }),
    amzRow({ 'order-id': AZ(4), 'order-item-id': 'I1' }),
  ]);
  const r = await commitAmazonImport(file, 'multi.csv', { actor: IMPORTER });
  if (r.summary.ordersCreated !== 3 || r.summary.lineItemsAdded !== 4) throw new Error(JSON.stringify(r.summary));
  const o2 = await amzOrder(2);
  const items = await orderItems(o2.id);
  if (items.length !== 2 || items[1].quantity !== 3 || o2.order_value !== 480) throw new Error(`${o2.order_value} ${JSON.stringify(items)}`);
  const o3 = await amzOrder(3);
  if (o3.payment_method !== 'cod' || o3.payment_status !== 'pending') throw new Error('COD not mapped');
  // Blank payment-method: marketplace, status not known — a payments-date alone is not "paid".
  if (o2.payment_method !== 'marketplace' || o2.payment_status !== null) throw new Error(`blank payment mapped to ${o2.payment_method}/${o2.payment_status}`);
  if (await amzShipments()) throw new Error('import created shipments');
  return '3 orders, 4 items, 0 shipments; value = items + shipping (₹480); COD → cod/pending, blank → marketplace/not known';
});
await step('amazon import: the same file twice changes nothing', async () => {
  const file = amzCsv([amzRow({ 'order-id': AZ(1), 'order-item-id': 'I1' })]);
  const before = (await orderEvents((await amzOrder(1)).id)).length;
  const v = (await amzOrder(1)).version;
  const r = await commitAmazonImport(file, 'one.csv', { actor: IMPORTER });
  const s = r.summary;
  if (s.ordersCreated || s.ordersUpdated || s.lineItemsAdded || s.lineItemsUpdated || s.ordersUnchanged !== 1) throw new Error(JSON.stringify(s));
  if ((await amzCount()) !== 4 || (await amzOrder(1)).version !== v || (await orderEvents((await amzOrder(1)).id)).length !== before) throw new Error('something was written');
  return 'no new orders, items, versions or events';
});
await step('amazon import: an existing order gets a new line item and updated fields', async () => {
  const file = amzCsv([
    amzRow({ 'order-id': AZ(1), 'order-item-id': 'I1', 'item-tax': '80.00' }),
    amzRow({ 'order-id': AZ(1), 'order-item-id': 'I9', sku: 'SKU-9', 'item-price': '250' }),
  ]);
  const p = await previewAmazonImport(file, 'grow.csv');
  if (p.summary.existingOrders !== 1 || p.summary.newLineItems !== 1 || p.summary.changedLineItems !== 1) throw new Error(JSON.stringify(p.summary));
  const o = await amzOrder(1);
  // Hand-entered shipment details survive the re-import.
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-AMZ-1' }, { actor: ACTOR });
  await addOrderNote(o.id, 'Packed with care', { actor: ACTOR });
  await updateOrder(o.id, { payment_status: 'refunded' }, { actor: ACTOR, version: (await getOrder(o.id)).version });
  const r = await commitAmazonImport(file, 'grow.csv', { actor: IMPORTER });
  if (r.summary.ordersUpdated !== 1 || r.summary.lineItemsAdded !== 1 || r.summary.lineItemsUpdated !== 1) throw new Error(JSON.stringify(r.summary));
  const after = await amzOrder(1);
  if (after.order_value !== 749 || after.tracking_id !== 'AWB-AMZ-1' || after.shipment_status !== 'packed' || after.courier_name !== 'Delhivery') throw new Error(JSON.stringify(after));
  if (after.payment_status !== 'refunded') throw new Error('re-import overwrote the payment status the team set');
  if ((await orderShipments(o.id)).length !== 1 || !(await orderEvents(o.id)).some((e) => e.metadata?.note === 'Packed with care')) throw new Error('shipment or note changed');
  if ((await orderItems(o.id)).length !== 2) throw new Error('items');
  const ev = (await orderEvents(o.id)).find((e) => e.event_type === 'amazon_import_updated');
  if (!ev || ev.metadata.items_added !== 1 || ev.metadata.changes.order_value?.to !== 749) throw new Error(JSON.stringify(ev));
  return 'item added, tax updated, value ₹499 → ₹749 logged; shipment, courier, AWB, status, note and payment status untouched';
});
await step('amazon import: duplicate rows, promotion rows, bad rows and missing order-id', async () => {
  const file = amzCsv([
    amzRow({ 'order-id': AZ(5), 'order-item-id': 'I1', 'item-promotion-discount': '-50', 'item-promotion-id': 'PROMO' }),
    AMZ_HEAD.map((h) => ({ 'order-id': AZ(5), 'order-item-id': 'I1', 'item-promotion-discount': '0', 'ship-promotion-discount': '0', 'ship-promotion-id': 'SHIPPROMO' }[h] ?? '')),
    amzRow({ 'order-id': AZ(6), 'order-item-id': 'I1' }),
    amzRow({ 'order-id': AZ(6), 'order-item-id': 'I1' }),                         // exact repeat
    amzRow({ 'order-id': AZ(7), 'order-item-id': 'I1' }),
    amzRow({ 'order-id': AZ(7), 'order-item-id': 'I2', 'quantity-purchased': 'two' }), // bad → whole order out
    amzRow({ 'order-id': AZ(8), 'order-item-id': 'I1', 'purchase-date': 'yesterday' }),
    amzRow({ 'order-id': AZ(9), 'order-item-id': 'I1', 'item-price': '4,99.x' }),
    amzRow({ 'order-id': '', 'order-item-id': 'I1' }),
    amzRow({ 'order-id': AZ(10), 'order-item-id': '' }),
    amzRow({ 'order-id': AZ(11), 'order-item-id': 'I1', 'fulfilled-by': 'Amazon' }),
  ]);
  const r = await commitAmazonImport(file, 'mixed.csv', { actor: IMPORTER });
  const s = r.summary;
  if (s.rows !== 11 || s.promotionRows !== 1 || s.duplicateRows !== 1 || s.ordersCreated !== 2 || r.errorCount !== 6) throw new Error(`${JSON.stringify(s)} ${JSON.stringify(r.errors)}`);
  const rowsOf = Object.fromEntries(r.errors.map((e) => [e.row, e]));
  if (!/quantity/.test(rowsOf[7].reason) || !/purchase-date/.test(rowsOf[8].reason) || !/item-price/.test(rowsOf[9].reason)
    || rowsOf[10].reason !== 'Missing order-id' || rowsOf[10].orderId !== null || !/order-item-id/.test(rowsOf[11].reason) || !/Easy Ship/.test(rowsOf[12].reason)) throw new Error(JSON.stringify(r.errors));
  if (await amzOrder(7) || await amzOrder(8) || await amzOrder(11)) throw new Error('a bad order was imported');
  if ((await orderItems((await amzOrder(6)).id)).length !== 1) throw new Error('duplicate row became an item');
  const o5 = await amzOrder(5);
  if (o5.order_value !== 449 || (await orderItems(o5.id))[0].promotion_discount !== -50) throw new Error(`promo ${o5.order_value}`);
  return '2 good orders in; duplicate + promotion rows folded; 6 bad rows reported with row number, order and reason';
});
await step('amazon import: numbers and dates parse; xlsx and tab-separated files read', async () => {
  const plan = planAmazon(readTable(amzCsv([amzRow({ 'order-id': 'X', 'order-item-id': 'I', 'item-price': '₹1,299.50', 'quantity-purchased': '12',
    'purchase-date': '2026-09-21T23:30:00+05:30' })]), 'x.csv'));
  const o = plan.orders[0];
  if (o.items[0].item_price !== 1299.5 || o.items[0].quantity !== 12 || o.order_date !== '2026-09-21T18:00:00.000Z') throw new Error(JSON.stringify(o));
  const tsv = Buffer.from([AMZ_HEAD, amzRow({ 'order-id': 'T', 'order-item-id': 'I', 'product-name': 'Tea, green' })].map((r) => r.join('\t')).join('\r\n'));
  const t = planAmazon(readTable(tsv, 'report.txt'));
  if (t.orders[0].items[0].title !== 'Tea, green') throw new Error('tab file');
  // A minimal .xlsx: shared strings, a numeric cell and an Excel date serial.
  const { xlsxFixture } = await import('./fixtures/amazon-xlsx.js');
  const x = planAmazon(readTable(xlsxFixture(), 'orders.xlsx'));
  if (x.errors.length || x.orders.length !== 1 || x.orders[0].items[0].quantity !== 2 || x.orders[0].order_value !== 250
    || !x.orders[0].order_date.startsWith('2026-09-20')) throw new Error(JSON.stringify(x));
  try { planAmazon(readTable(Buffer.from('a,b\n1,2'), 'x.csv')); throw new Error('accepted'); } catch (err) { if (!/missing column/.test(err.message)) throw err; }
  return '₹1,299.50 → 1299.5, IST date → UTC, tab file with a comma inside, xlsx with date serial; wrong file refused';
});
await step('amazon import: orders show in the Orders list and filters', async () => {
  const all = await listOrders({ channel: 'amazon', q: `${TEST_ORDER}-AMZ` });
  const easy = await listOrders({ channel: 'amazon', type: 'easy_ship', q: `${TEST_ORDER}-AMZ` });
  if (all.total !== 6 || easy.total !== 6) throw new Error(`${all.total} ${easy.total}`);
  if (await amzShipments() !== 1) throw new Error('only the one shipment made by hand should exist');
  if (all.orders.some((o) => o.channel_label !== 'Amazon')) throw new Error('label');
  return '6 imported orders listed under Amazon / Easy Ship; the only shipment is the one made by hand';
});
await step('amazon import → no shipments → pick 3 orders → one Shree Tirupati shipment', async () => {
  const [a, b, c] = await Promise.all([amzOrder(2), amzOrder(3), amzOrder(4)]);
  if ([a, b, c].some((o) => o.shipment_id !== null)) throw new Error('imported orders already have shipments');
  // They wait in Pending dispatch and under "No shipment yet".
  const waiting = await listOrders({ view: 'pending_dispatch', q: `${TEST_ORDER}-AMZ` });
  const none = await listOrders({ shipment: 'none', q: `${TEST_ORDER}-AMZ` });
  for (const o of [a, b, c]) {
    if (!waiting.orders.some((x) => x.id === o.id) || !none.orders.some((x) => x.id === o.id)) throw new Error('not listed as waiting');
  }
  const stc = (await listCouriers()).find((x) => x.name === 'Shree Tirupati Courier');
  const r = await createShipmentForOrders([a.id, b.id, c.id], { courier_partner_id: stc.id, tracking_id: 'AWB-AMZ-STC' }, { actor: ACTOR });
  if (r.orderId !== a.id) throw new Error('first order is not the main one');
  const members = await shipmentMembers(r.shipmentId);
  if (members.length !== 3 || members[0].id !== a.id) throw new Error(`members ${JSON.stringify(members)}`);
  // One shipment row in total for the three orders.
  const n = (await getPool().query(`SELECT count(*)::int n FROM order_shipments WHERE order_id = ANY($1)`, [[a.id, b.id, c.id]])).rows[0].n;
  if (n !== 1) throw new Error(`${n} shipment rows`);
  // Each order is still its own row in the list, all showing the one AWB and courier.
  const list = await listOrders({ q: 'AWB-AMZ-STC' });
  if (list.total !== 3 || list.orders.some((o) => o.shipment_id !== r.shipmentId || o.courier_name !== 'Shree Tirupati Courier'
    || o.shipment_status !== 'packed' || o.orders_in_shipment !== 3)) throw new Error(JSON.stringify(list.orders));
  // Opening any of them shows the shared shipment and its three orders.
  for (const o of [b, c]) {
    const shared = await sharedShipmentOf(o.id);
    if (!shared || shared.id !== r.shipmentId || (await shipmentMembers(shared.id)).length !== 3) throw new Error('drawer would not show the shipment');
  }
  // Re-importing a member updates its Amazon fields and leaves the shipment alone.
  await commitAmazonImport(amzCsv([amzRow({ 'order-id': AZ(3), 'order-item-id': 'I1', 'payment-method': 'COD', 'item-price': '520' })]), 'again.csv', { actor: IMPORTER });
  const b2 = await amzOrder(3);
  if (!b2.in_shared_shipment || b2.tracking_id !== 'AWB-AMZ-STC' || b2.order_value !== 520) throw new Error(JSON.stringify(b2));
  if ((await shipmentMembers(r.shipmentId)).length !== 3) throw new Error('membership changed');
  return '3 imported orders → 1 shipment (Shree Tirupati, one AWB); 3 rows in the list; drawer shows all 3; re-import kept it';
});
await step('create shipment from orders: refusals are all-or-nothing', async () => {
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const shipped = await amzOrder(2);
  const free = await amzOrder(5);
  const web = await createOrder({ channel: 'website', source_order_id: `${TEST_ORDER}-AMZ-WEB` }, { actor: ACTOR });
  const before = (await getPool().query('SELECT count(*)::int n FROM order_shipments')).rows[0].n;
  const refused = async (ids, input, check) => {
    try { await createShipmentForOrders(ids, input, { actor: ACTOR }); throw new Error('accepted'); } catch (err) { if (!check(err)) throw err; }
  };
  await refused([free.id, shipped.id], { courier_partner_id: dl.id, tracking_id: 'X1' }, (e) => e.alreadyShipped);
  await refused([shipped.id, free.id], { courier_partner_id: dl.id, tracking_id: 'X2' }, (e) => e.alreadyShipped);
  await refused([free.id, web], { courier_partner_id: dl.id, tracking_id: 'X3' }, (e) => e.status === 400);
  await refused([free.id], { tracking_id: 'X4' }, (e) => /courier/.test(e.message));
  await refused([free.id], { courier_partner_id: dl.id }, (e) => /AWB/.test(e.message));
  await refused([], { courier_partner_id: dl.id, tracking_id: 'X5' }, (e) => e.status === 400);
  const after = (await getPool().query('SELECT count(*)::int n FROM order_shipments')).rows[0].n;
  if (after !== before || (await amzOrder(5)).shipment_id !== null) throw new Error('a refused request left a shipment');
  return 'already-shipped order, other channel, no courier, no AWB, no orders → refused, nothing written';
});
await step('amazon import history is recorded', async () => {
  const { rows } = await getPool().query(`SELECT * FROM order_imports WHERE imported_by = $1 ORDER BY id`, [IMPORTER]);
  const mixed = rows.find((x) => x.filename === 'mixed.csv');
  if (!mixed || mixed.channel !== 'amazon' || mixed.rows_processed !== 11 || mixed.orders_created !== 2 || mixed.duplicate_rows !== 1
    || mixed.error_rows !== 6 || mixed.errors.length !== 6 || mixed.promotion_rows !== 1 || !/^[0-9a-f]{64}$/.test(mixed.file_sha256)) throw new Error(JSON.stringify(mixed));
  const grow = rows.find((x) => x.filename === 'grow.csv');
  if (grow.orders_updated !== 1 || grow.items_created !== 1 || grow.items_updated !== 1) throw new Error(JSON.stringify(grow));
  if (!rows.every((x) => x.imported_at instanceof Date)) throw new Error('no time');
  return `${rows.length} imports recorded with time, person, file, rows, created/updated, items, duplicates, errors`;
});
await step('new shipment cleanup', async () => {
  const { orders, paths } = await purgeTestOrders(TEST_ORDER);
  for (const p of paths) await storage().remove(p).catch(() => {});
  await getPool().query(`DELETE FROM dispatch_destinations WHERE name LIKE 'DBCHECK%'`);
  const left = await getPool().query('SELECT count(*)::int AS n FROM orders WHERE source_order_id LIKE $1', [`${TEST_ORDER}%`]);
  if (left.rows[0].n) throw new Error('orders left behind');
  return `${orders} orders removed`;
});

// ---- environment guard ------------------------------------------------------
await step('environment guard: labels and APP_ENV must agree; production is never touched', async () => {
  const { appEnv, EnvironmentError: EnvErr } = await import('../lib/env-guard.js');
  const fake = (env) => ({ async query(q) {
    if (/to_regclass/.test(q)) return { rows: [{ t: env === undefined ? null : 'app_environment' }] };
    return { rows: env ? [{ env }] : [] };
  } });
  const refused = async (fn) => { try { await fn(); return false; } catch (e) { if (e instanceof EnvErr) return true; throw e; } };
  if (!(await refused(() => assertMarkerIn(fake('production'), ['test', 'development'], 'purge')))) throw new Error('purge allowed on production');
  if (!(await refused(() => assertMarkerIn(fake(undefined), ['test'], 'cleanup')))) throw new Error('cleanup allowed on unlabelled db');
  if (await refused(() => assertMarkerIn(fake('test'), ['test'], 'cleanup'))) throw new Error('cleanup refused on test');
  // The real test database says "test".
  const c = await getPool().connect();
  try { await assertMarkerIn(c, ['test'], 'check'); } finally { c.release(); }
  const saved = { APP_ENV: process.env.APP_ENV, RENDER: process.env.RENDER };
  try {
    delete process.env.APP_ENV; if (!(await refused(() => appEnv()))) throw new Error('missing APP_ENV accepted');
    process.env.APP_ENV = 'staging'; if (!(await refused(() => appEnv()))) throw new Error('unknown APP_ENV accepted');
    process.env.APP_ENV = 'development'; process.env.RENDER = 'true';
    if (!(await refused(() => appEnv()))) throw new Error('development accepted on Render');
  } finally {
    process.env.APP_ENV = saved.APP_ENV;
    if (saved.RENDER === undefined) delete process.env.RENDER; else process.env.RENDER = saved.RENDER;
  }
  return 'production/unlabelled refused, test allowed, APP_ENV validated';
});

// ---- cleanup ---------------------------------------------------------------
await step('cleanup', async () => {
  // One transaction, and the label is re-read inside it before any DELETE.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await assertMarkerIn(client, ['test'], 'db:check cleanup');
    await client.query('DELETE FROM login_log WHERE phone = $1', [TEST_PHONE]);
    await client.query('DELETE FROM allowed_users WHERE phone = ANY($1)', [[FIX_A, FIX_B]]);
    await client.query('DELETE FROM abandoned_carts WHERE cart_id = $1', [FIX_CART]);
    await client.query('DELETE FROM member_log WHERE target_phone = $1', [TEST_MEMBER]);
    await client.query('DELETE FROM allowed_users WHERE phone = $1', [TEST_MEMBER]);
    await client.query('DELETE FROM system_state WHERE key = $1', [TEST_STATE_KEY]);
    await client.query('DELETE FROM webhook_failures WHERE kind = $1', [TEST_FAILURE_KIND]);
    await client.query('DELETE FROM auto_recovery_log WHERE cart_id = $1', [TEST_CART]);
    await client.query('DELETE FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
    await client.query('DELETE FROM otp_state WHERE phone = $1', [TEST_PHONE]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return 'test rows removed';
});

console.log(failures === 0
  ? '\nAll checks passed. The database is wired up correctly.\n'
  : `\n${failures} check(s) FAILED — see above.\n`);

await getPool().end();
process.exit(failures === 0 ? 0 : 1);
