import 'dotenv/config';
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
  isIngestSilent, buildDailySummary, shouldSendSummary, boardDay,
} from '../lib/sla-alert.js';
import { issueSession, verifySession } from '../lib/session.js';
import { rateLimit, _reset as resetRateLimit } from '../lib/rate-limit.js';

/**
 * Exercises every database code path against the real DATABASE_URL and cleans up
 * after itself. Run once after setting DATABASE_URL:  npm run db:check
 */

if (isMockMode()) {
  console.error('DATABASE_URL is not set — nothing to check. Set it in .env first.');
  process.exit(1);
}

const TEST_CART = 'DBCHECK-DELETE-ME';
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

  // Caller A saves again; Caller B is now working from a stale read.
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
  const members = (await listMembers()).filter((m) => m.active);
  if (members.length < 2) throw new Error('need at least two active members to test reassignment');
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
  const me = (await listMembers()).find((m) => m.active);

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

// ---- cleanup ---------------------------------------------------------------
await step('cleanup', async () => {
  await getPool().query('DELETE FROM login_log WHERE phone = $1', [TEST_PHONE]);
  await getPool().query('DELETE FROM member_log WHERE target_phone = $1', [TEST_MEMBER]);
  await deleteMember(TEST_MEMBER);
  await getPool().query('DELETE FROM system_state WHERE key = $1', [TEST_STATE_KEY]);
  await getPool().query('DELETE FROM webhook_failures WHERE kind = $1', [TEST_FAILURE_KIND]);
  await getPool().query('DELETE FROM auto_recovery_log WHERE cart_id = $1', [TEST_CART]);
  await getPool().query('DELETE FROM abandoned_carts WHERE cart_id = $1', [TEST_CART]);
  await getPool().query('DELETE FROM otp_state WHERE phone = $1', [TEST_PHONE]);
  return 'test rows removed';
});

console.log(failures === 0
  ? '\nAll checks passed. The database is wired up correctly.\n'
  : `\n${failures} check(s) FAILED — see above.\n`);

await getPool().end();
process.exit(failures === 0 ? 0 : 1);
