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
  orderShipments, addOrderNote, removeDocument, orderDocuments, getDocument, listCouriers, saveCourier,
  trackingUrlFor, purgeTestOrders, zonedToUtc, listDestinations, saveDestination, DISPATCH_TYPES,
  shipmentMembers, sharedShipmentOf, attachToShipment, detachFromShipment, attachableOrders, createShipmentForOrders,
} from '../lib/orders.js';
import { saveUploadedDocument } from '../lib/orders-routes.js';
import { planAmazon, readTable, previewAmazonImport, commitAmazonImport } from '../lib/amazon-import.js';
import { orderItems } from '../lib/orders.js';
import {
  ensureInventorySchema, createSku, updateSku, getSku, skuDetail, receiveInventory, adjustStock, transferStock, updateBatch,
  uploadBatchDocument, getBatchDocument, shipmentStock, reserveShipmentStock, releaseShipmentStock, dispatchShipmentStock,
  inventoryOverview, resolveSkuIds, purgeTestInventory, saveWarehouse, unmappedSkus, fefoSuggest,
  addPlatformMappings, removePlatformMapping, savePlatform, listPlatforms, splitPlatformCell, migrateLegacyAmazonSkus, mappingUsage,
} from '../lib/inventory.js';
import { planSkuSheet, previewSkuImport, commitSkuImport } from '../lib/sku-master-import.js';
import { DOCUMENT_FORMATS } from '../lib/orders.js';
import {
  validateDocument, storage, signV4, _resetStorage, StorageNotConfigured,
} from '../lib/storage.js';
import { canUseOrders, canUseRecovery, roleFor, resolveAccess } from '../lib/otp.js';
import { capabilitiesOf, CAPABILITIES, homeFor, legacyRole } from '../lib/permissions.js';
import { backfillModuleRoles, setModuleRole, moduleRolesOf } from '../lib/db.js';
import { requireAuth, requirePermission, _setMembershipLookup, router as authRouterForTest } from '../lib/auth-routes.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { ensureHrSchema, purgeTestHr, slugify, normalizePhone, removeResume, retryPendingRemovals, istDayKey, HR_TIMEZONE } from '../lib/hr.js';
import { jobPostingLd } from '../lib/careers-pages.js';
import nodeCrypto from 'node:crypto';
import { metricsFrom, rawFromRow, rangeParams, classifyMetaError, createMetaClient, createCache, MetaError, createMetaService, metaConfig, todayIn, resolvePurchaseType, _resetMetaService, billingFrom } from '../lib/meta-ads.js';
import { overviewFor } from '../lib/overview.js';
import { istDateTime, istDate, istTime, istDayKey as uiIstDayKey } from '../public/ui/ist.js';
import { issueFormToken, verifyTurnstile, normalizeHost, isCareersRequest } from '../lib/careers.js';
import net from 'node:net';
import {
  isIngestSilent, buildDailySummary, shouldSendSummary, boardDay,
} from '../lib/sla-alert.js';
import { issueSession, verifySession, COOKIE as SESSION_COOKIE } from '../lib/session.js';
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
  // A removed document stays in the record but is never served again.
  const rec = docs.find((d) => d.document_type === 'courier_receipt');
  if (await getDocument(orderId, inv.id) || !(await getDocument(orderId, rec.id))) throw new Error('removed document still served / live one not served');
  // The drawer's remove and detach buttons carry their ids (a stray quote once emptied them).
  const ui = await fsp.readFile(new URL('../public/orders.js', import.meta.url), 'utf8');
  if (/=""\$\{/.test(ui) || !/data-remove-doc="\$\{d\.id\}"/.test(ui) || !/data-detach="\$\{x\.id\}"/.test(ui)) throw new Error('orders.js button ids broken');
  return '2 stored, failed write cleaned up, invalid file never stored; removed document not served; remove/detach buttons carry ids';
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
  // The list leaves out the raw payload; the full order (as the drawer reads it) has it.
  const full = await getOrder(o.id);
  if (!full.source_payload?.amazon || 'gift-wrap-price' in full.source_payload.amazon || JSON.stringify(full.source_payload).includes('gift')) throw new Error('ignored column stored');
  if ('source_payload' in o) throw new Error('list rows still carry the raw payload');
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
await step('amazon import: promotion-only rows are recognised by content, wherever they sit', async () => {
  const promo = (o) => AMZ_HEAD.map((h) => o[h] ?? '');
  const file = amzCsv([
    // Promotion row BEFORE its item, with another order in between, carrying a real discount and id.
    promo({ 'order-id': AZ(20), 'order-item-id': 'P1', 'item-promotion-discount': '-20', 'ship-promotion-discount': '-5', 'item-promotion-id': 'PROMO-X' }),
    amzRow({ 'order-id': AZ(21), 'order-item-id': 'Q1' }),
    amzRow({ 'order-id': AZ(20), 'order-item-id': 'P1', 'item-price': '300', 'shipping-price': '80' }),
    // Amazon's usual zero-value detail row, straight after its item.
    amzRow({ 'order-id': AZ(22), 'order-item-id': 'R1' }),
    promo({ 'order-id': AZ(22), 'order-item-id': 'R1', 'item-promotion-discount': '0', 'ship-promotion-discount': '0' }),
    // Promotion row for an item id that order does not have → reported; that order held back.
    amzRow({ 'order-id': AZ(23), 'order-item-id': 'S1' }),
    promo({ 'order-id': AZ(23), 'order-item-id': 'S-MISSING', 'item-promotion-discount': '-10' }),
    // Promotion row for an order not in the file at all → reported, nothing created.
    promo({ 'order-id': AZ(24), 'order-item-id': 'T1', 'item-promotion-discount': '-10' }),
    // No item fields and no promotion fields: NOT a promotion row — an invalid row.
    promo({ 'order-id': AZ(25), 'order-item-id': 'U1' }),
  ]);
  const plan = planAmazon(readTable(file, 'promo.csv'));
  if (plan.stats.promotionRows !== 2) throw new Error(`promotion rows ${plan.stats.promotionRows}`);
  const r = await commitAmazonImport(file, 'promo.csv', { actor: IMPORTER });
  if (r.summary.ordersCreated !== 3 || r.summary.lineItemsAdded !== 3 || r.errorCount !== 3) throw new Error(`${JSON.stringify(r.summary)} ${JSON.stringify(r.errors)}`);
  const o20 = await amzOrder(20);
  const items = await orderItems(o20.id);
  // 300 + 80 − 20 − 5 = 355; one item, discount and promotion id taken from the promotion row.
  if (o20.order_value !== 355 || items.length !== 1 || items[0].promotion_discount !== -20 || items[0].promotion_id !== 'PROMO-X') throw new Error(`${o20.order_value} ${JSON.stringify(items)}`);
  if ((await orderItems((await amzOrder(22)).id)).length !== 1 || (await amzOrder(22)).order_value !== 499) throw new Error('zero promo row changed order 22');
  const byRow = Object.fromEntries(r.errors.map((e) => [e.row, e]));
  if (!/no matching line item/.test(byRow[8]?.reason) || !/no matching line item/.test(byRow[9]?.reason) || !/purchase-date/.test(byRow[10]?.reason)) throw new Error(JSON.stringify(r.errors));
  if (await amzOrder(23) || await amzOrder(24) || await amzOrder(25)) throw new Error('unmatched promotion row produced an order');
  const stray = (await getPool().query(`SELECT count(*)::int n FROM order_items WHERE source_line_item_id IN ('S-MISSING','T1','U1')`)).rows[0].n;
  if (stray) throw new Error('promotion row became an item');
  return 'matched before/after its item and across other orders; discount + id applied (₹355); unmatched ones reported, no order or item made';
});
await step('amazon import: the 14 excluded columns are never read or stored', async () => {
  const { IGNORED_COLUMNS } = await import('../lib/amazon-import.js');
  const excluded = [...IGNORED_COLUMNS];
  if (excluded.length !== 14) throw new Error(`${excluded.length} excluded`);
  const head = [...AMZ_HEAD, ...excluded.filter((c) => !AMZ_HEAD.includes(c))];
  const row = head.map((h) => (excluded.includes(h) ? `EXCLUDED-MARKER-${h}` : amzRow({ 'order-id': AZ(30), 'order-item-id': 'E1' })[AMZ_HEAD.indexOf(h)]));
  const file = Buffer.from([head, row].map((r) => r.join(',')).join('\n'));
  const r = await commitAmazonImport(file, 'excluded.csv', { actor: IMPORTER });
  if (r.summary.ordersCreated !== 1 || r.errorCount) throw new Error(JSON.stringify(r));
  const o = await amzOrder(30);
  const stored = JSON.stringify([await getOrder(o.id), await orderItems(o.id), await orderEvents(o.id),
    (await getPool().query(`SELECT * FROM order_imports WHERE filename = 'excluded.csv'`)).rows]);
  if (stored.includes('EXCLUDED-MARKER')) throw new Error('an excluded column was stored');
  // Even is-iba / already-paid style values cannot change the mapping.
  if (o.payment_status !== null || o.order_value !== 499) throw new Error(JSON.stringify(o));
  return '14 columns filled with markers; none appears in the order, items, events or import record';
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
  if (all.total !== 10 || easy.total !== 10) throw new Error(`${all.total} ${easy.total}`);
  if (await amzShipments() !== 1) throw new Error('only the one shipment made by hand should exist');
  if (all.orders.some((o) => o.channel_label !== 'Amazon')) throw new Error('label');
  return '10 imported orders listed under Amazon / Easy Ship; the only shipment is the one made by hand';
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

// ---- inventory ---------------------------------------------------------------
// Test SKUs, suppliers and warehouses start with this prefix; purgeTestInventory removes them.
const TS = 'DBCHECK-INV';
const INV = {};
const dayOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const COA_PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const rid = () => crypto.randomUUID();
const stockOf = async (id) => { const s = await getSku(id); return { on: s.on_hand, res: s.reserved, av: s.available }; };
const expectErr = async (label, fn, check) => {
  try { await fn(); } catch (err) { if (check(err)) return err; throw new Error(`${label}: wrong error ${err.message}`); }
  throw new Error(`${label}: accepted`);
};
const ledgerSum = async (skuId) => (await getPool().query('SELECT coalesce(sum(quantity),0)::int n FROM inventory_movements WHERE sku_id = $1', [skuId])).rows[0].n;

await step('inventory: schema, leftovers cleared', async () => {
  await ensureInventorySchema();
  await purgeTestInventory(TS);
  return 'skus, batches, ledger, reservations, documents, suppliers, warehouses, audit';
});
await step('inventory: create SKU; duplicate (any letter case) rejected', async () => {
  const before = (await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n;
  INV.a = (await createSku({ sku: `${TS}-D3-60`, product_name: 'Vitamin D3 2000 IU', variant_name: '60 Capsules', category: 'Vitamins',
    unit_type: 'bottle', reorder_level: 10, reorder_quantity: 200, amazon_seller_sku: `${TS}-D3-60`, asin: 'B0TESTD360' }, { actor: ACTOR })).id;
  INV.b = (await createSku({ sku: `${TS}-B12-30`, product_name: 'Vitamin B12', reorder_level: 5 }, { actor: ACTOR })).id;
  INV.c = (await createSku({ sku: `${TS}-EASEN`, product_name: 'Easen' }, { actor: ACTOR })).id;
  await expectErr('duplicate', () => createSku({ sku: `${TS}-d3-60`, product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('spaces', () => createSku({ sku: `${TS} BAD`, product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('code change', () => updateSku(INV.b, { sku: 'OTHER' }, { actor: ACTOR }), (e) => e.status === 400);
  // An Amazon seller SKU cannot point at a second SKU, nor be another SKU's code.
  await expectErr('amazon clash', () => updateSku(INV.b, { amazon_seller_sku: `${TS}-D3-60` }, { actor: ACTOR }), (e) => e.status === 409);
  const after = (await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n;
  if (after !== before + 3) throw new Error('count');
  return '3 SKUs; duplicate, spaces, code change and Amazon-code clash refused';
});
await step('inventory: add a batch of 100 → ledger +100, stock 100; COA uploaded to the batch', async () => {
  const r = await receiveInventory({ sku_id: INV.a, batch_number: 'D3260812', mfg_date: '2026-08-01', expiry_date: '2028-08',
    quantity: 100, unit_cost: '180', supplier_name: `${TS} Supplier`, po_number: 'PO-1', grn_number: 'GRN-00231',
    location: 'Rack B2', request_id: rid() }, { actor: ACTOR });
  INV.a1 = r.batchId;
  if (!r.created) throw new Error('not created');
  const d = await skuDetail(INV.a);
  const b = d.batches[0];
  if (b.expiry_date !== '2028-08-31' || b.on_hand !== 100 || b.supplier_name !== `${TS} Supplier` || b.location !== 'Rack B2') throw new Error(JSON.stringify(b));
  const m = d.movements[0];
  if (d.movements.length !== 1 || m.quantity !== 100 || m.movement_type !== 'received' || m.reference_id !== 'GRN-00231' || m.actor !== ACTOR) throw new Error(JSON.stringify(m));
  if ((await stockOf(INV.a)).on !== 100 || await ledgerSum(INV.a) !== 100) throw new Error('stock');
  const docId = await uploadBatchDocument({ batchId: INV.a1, filename: 'COA-D3260812.pdf', buffer: COA_PDF, documentType: 'coa', actor: ACTOR });
  const doc = await getBatchDocument(INV.a1, docId);
  if (!doc || doc.document_type !== 'coa' || !(await storage().get(doc.storage_path)).equals(COA_PDF)) throw new Error('coa');
  if (await getBatchDocument(INV.a1 + 999999, docId)) throw new Error('document readable through another batch');
  await expectErr('fake pdf', () => uploadBatchDocument({ batchId: INV.a1, filename: 'coa.pdf', buffer: Buffer.from('not a pdf'), documentType: 'coa', actor: ACTOR }), (e) => e.status === 400);
  return 'batch D3260812 (exp 2028-08-31, ₹180, supplier, GRN, Rack B2); +100 received by db-check; COA stored and read back';
});
await step('inventory: a repeated receive (same request id) adds stock once', async () => {
  const id = rid();
  const input = { sku_id: INV.b, batch_number: 'B12-01', expiry_date: dayOffset(400), quantity: 2, unit_cost: 90, request_id: id };
  const one = await receiveInventory(input, { actor: ACTOR });
  const two = await receiveInventory(input, { actor: ACTOR });
  INV.b1 = one.batchId;
  if (!two.repeated || two.movementId !== one.movementId || (await stockOf(INV.b)).on !== 2) throw new Error(JSON.stringify(two));
  return 'second call returned the first movement; stock 2, not 4';
});
await step('inventory: stock can never be overwritten or the ledger rewritten', async () => {
  await expectErr('direct on_hand', () => getPool().query('UPDATE inventory_batches SET on_hand = 999 WHERE id = $1', [INV.a1]), (e) => /only through inventory_movements/.test(e.message));
  await expectErr('ledger edit', () => getPool().query('UPDATE inventory_movements SET quantity = 1 WHERE sku_id = $1', [INV.a]), (e) => /append-only/.test(e.message));
  await expectErr('ledger delete', () => getPool().query('DELETE FROM inventory_movements WHERE sku_id = $1', [INV.a]), (e) => /append-only/.test(e.message));
  await expectErr('batch qty edit', () => updateBatch(INV.a1, { on_hand: 5 }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('negative', () => adjustStock({ batch_id: INV.a1, movement_type: 'adjustment_decrease', quantity: 101, reason: 'test' }, { actor: ACTOR }), (e) => e.insufficientStock);
  await expectErr('no reason', () => adjustStock({ batch_id: INV.a1, movement_type: 'damaged', quantity: 1 }, { actor: ACTOR }), (e) => e.status === 400);
  if ((await stockOf(INV.a)).on !== 100) throw new Error('changed');
  return 'direct UPDATE, ledger UPDATE/DELETE, quantity edit, going below zero, reasonless change: all refused';
});

// Orders for the stock tests come in through the Amazon importer, like real ones.
const invOrders = async (rows) => commitAmazonImport(amzCsv(rows), 'inventory.csv', { actor: IMPORTER });
await step('inventory: Amazon seller SKU resolves to the canonical SKU; unknown ones stay Unmapped and create nothing', async () => {
  const skusBefore = (await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n;
  const file = amzCsv([
    amzRow({ 'order-id': AZ(40), 'order-item-id': 'I40', sku: `${TS}-D3-60`, 'quantity-purchased': '20' }),
    amzRow({ 'order-id': AZ(41), 'order-item-id': 'I41', sku: `${TS}-AMZ-ONLY-CODE`, 'quantity-purchased': '1' }),
  ]);
  const p = await previewAmazonImport(file, 'map.csv');
  if (p.summary.unmappedSkus !== 1 || p.unmapped[0].code !== `${TS}-AMZ-ONLY-CODE`) throw new Error(JSON.stringify(p.unmapped));
  const r = await invOrders([
    amzRow({ 'order-id': AZ(40), 'order-item-id': 'I40', sku: `${TS}-D3-60`, 'quantity-purchased': '20' }),
    amzRow({ 'order-id': AZ(41), 'order-item-id': 'I41', sku: `${TS}-AMZ-ONLY-CODE`, 'quantity-purchased': '1' }),
  ]);
  if (r.summary.unmappedSkus !== 1) throw new Error(JSON.stringify(r.summary));
  const i40 = (await orderItems((await amzOrder(40)).id))[0];
  const i41 = (await orderItems((await amzOrder(41)).id))[0];
  if (i40.sku_id !== INV.a || i40.canonical_sku !== `${TS}-D3-60`) throw new Error(JSON.stringify(i40));
  if (i41.sku_id !== null || i41.sku !== `${TS}-AMZ-ONLY-CODE`) throw new Error(JSON.stringify(i41));
  if ((await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n !== skusBefore) throw new Error('a SKU was created');
  if (!(await unmappedSkus()).some((u) => u.code === `${TS}-AMZ-ONLY-CODE`)) throw new Error('not listed as unmapped');
  // Imported orders never touch stock.
  if ((await stockOf(INV.a)).on !== 100 || (await stockOf(INV.a)).res !== 0) throw new Error('import changed stock');
  // An admin maps the code to an existing SKU: the waiting line picks it up.
  const m = await updateSku(INV.c, { amazon_seller_sku: `${TS}-AMZ-ONLY-CODE` }, { actor: ACTOR });
  if (m.orderItemsMapped !== 1 || (await orderItems((await amzOrder(41)).id))[0].sku_id !== INV.c) throw new Error('not remapped');
  return 'same code → canonical SKU; unknown code imported as Unmapped, no SKU made, no stock touched; mapping later fixes the line';
});
await step('inventory: Shopify and Amazon reference the same canonical SKU', async () => {
  const c = await getPool().connect();
  try {
    const web = await resolveSkuIds(c, 'website', [`${TS}-D3-60`]);
    const amzn = await resolveSkuIds(c, 'amazon', [`${TS}-d3-60`]);
    const webAmazonCode = await resolveSkuIds(c, 'website', [`${TS}-AMZ-ONLY-CODE`]);
    if (web.get(`${TS}-d3-60`.toLowerCase()) !== INV.a || amzn.get(`${TS}-d3-60`.toLowerCase()) !== INV.a) throw new Error('not the same SKU');
    if (webAmazonCode.size) throw new Error('an Amazon-only code resolved for the website');
  } finally { c.release(); }
  return 'BRI code → one SKU id from either channel; an Amazon seller code only resolves for Amazon';
});
await step('inventory: shipment creation reserves nothing; reserve 20 → 100 / 20 / 80; release → 100', async () => {
  const o = await amzOrder(40);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  INV.s1 = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-1' }, { actor: ACTOR })).shipmentId;
  INV.s1lead = o.id;
  if (JSON.stringify(await stockOf(INV.a)) !== JSON.stringify({ on: 100, res: 0, av: 100 })) throw new Error('shipment changed stock');
  const st = await shipmentStock(INV.s1);
  if (st.state !== 'needs_reservation' || st.lines[0].required !== 20 || st.lines[0].suggestion.picks[0].batch_id !== INV.a1) throw new Error(JSON.stringify(st));
  await reserveShipmentStock(INV.s1, [{ batch_id: INV.a1, quantity: 20 }], { actor: ACTOR });
  if (JSON.stringify(await stockOf(INV.a)) !== JSON.stringify({ on: 100, res: 20, av: 80 })) throw new Error(JSON.stringify(await stockOf(INV.a)));
  if ((await shipmentStock(INV.s1)).state !== 'reserved') throw new Error('state');
  await releaseShipmentStock(INV.s1, { actor: ACTOR });
  if (JSON.stringify(await stockOf(INV.a)) !== JSON.stringify({ on: 100, res: 0, av: 100 })) throw new Error('release');
  // Reserving the wrong total, or a batch of another SKU, is refused.
  await expectErr('short', () => reserveShipmentStock(INV.s1, [{ batch_id: INV.a1, quantity: 19 }], { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('other sku', () => reserveShipmentStock(INV.s1, [{ batch_id: INV.b1, quantity: 20 }], { actor: ACTOR }), (e) => e.status === 400);
  return 'shipment made → stock untouched; reserved 20 → on hand 100, reserved 20, available 80; released → 100 available';
});
await step('inventory: second batch aggregates; FEFO suggests earliest expiry, skipping expired and quarantined', async () => {
  INV.a2 = (await receiveInventory({ sku_id: INV.a, batch_number: 'D3260511', expiry_date: dayOffset(200), quantity: 50, unit_cost: 175, request_id: rid() }, { actor: ACTOR })).batchId;
  INV.aExp = (await receiveInventory({ sku_id: INV.a, batch_number: 'D3-OLD', expiry_date: dayOffset(-1), quantity: 30, unit_cost: 170, request_id: rid() }, { actor: ACTOR })).batchId;
  INV.aQ = (await receiveInventory({ sku_id: INV.a, batch_number: 'D3-QUAR', expiry_date: dayOffset(10), quantity: 40, unit_cost: 170, request_id: rid() }, { actor: ACTOR })).batchId;
  await updateBatch(INV.aQ, { status: 'quarantined', reason: 'Awaiting lab result' }, { actor: ACTOR });
  await expectErr('status without reason', () => updateBatch(INV.aQ, { status: 'active' }, { actor: ACTOR }), (e) => e.status === 400);
  const s = await stockOf(INV.a);
  if (s.on !== 220 || s.av !== 150) throw new Error(JSON.stringify(s));
  const st = await shipmentStock(INV.s1);
  const pick = st.lines[0].suggestion.picks;
  if (pick.length !== 1 || pick[0].batch_id !== INV.a2 || pick[0].quantity !== 20) throw new Error(JSON.stringify(pick));
  await expectErr('expired', () => reserveShipmentStock(INV.s1, [{ batch_id: INV.aExp, quantity: 20 }], { actor: ACTOR }), (e) => e.unsellable);
  await expectErr('quarantined', () => reserveShipmentStock(INV.s1, [{ batch_id: INV.aQ, quantity: 20 }], { actor: ACTOR }), (e) => e.unsellable);
  // FEFO across batches when one is not enough.
  const split = fefoSuggest([{ id: 1, effective_status: 'active', available: 5 }, { id: 2, effective_status: 'active', available: 50 }], 12);
  if (split.picks.length !== 2 || split.picks[1].quantity !== 7 || split.short) throw new Error('split');
  return 'on hand 220 = 100+50+30+40; available 150 (expired + quarantined excluded); FEFO picks D3260511 (exp +200d), not the quarantined +10d or expired one';
});
await step('inventory: dispatch deducts the confirmed batch once, in the same transaction', async () => {
  // Dispatch with nothing reserved is refused and the status does not change.
  let sh = (await orderShipments(INV.s1lead))[0];
  await addPhoto(INV.s1lead);
  await expectErr('unreserved', () => updateShipment(INV.s1lead, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }), (e) => e.needsStock);
  if ((await orderShipments(INV.s1lead))[0].shipment_status !== 'packed') throw new Error('status changed');
  await reserveShipmentStock(INV.s1, [{ batch_id: INV.a2, quantity: 20 }], { actor: ACTOR });
  sh = (await orderShipments(INV.s1lead))[0];
  await updateShipment(INV.s1lead, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const d = await skuDetail(INV.a);
  const out = d.movements.filter((m) => m.shipment_id === INV.s1);
  if (out.length !== 1 || out[0].quantity !== -20 || out[0].batch_id !== INV.a2 || out[0].order_id !== INV.s1lead || out[0].movement_type !== 'shipment_dispatched') throw new Error(JSON.stringify(out));
  if (JSON.stringify(await stockOf(INV.a)) !== JSON.stringify({ on: 200, res: 0, av: 130 })) throw new Error(JSON.stringify(await stockOf(INV.a)));
  // Again: same status, a later status, and a direct repeat of the deduction — nothing more is taken.
  sh = (await orderShipments(INV.s1lead))[0];
  await updateShipment(INV.s1lead, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  sh = (await orderShipments(INV.s1lead))[0];
  await updateShipment(INV.s1lead, sh.id, { shipment_status: 'in_transit' }, { actor: ACTOR, version: sh.version });
  const c = await getPool().connect();
  try { await c.query('BEGIN'); const again = await dispatchShipmentStock(c, INV.s1, { actor: ACTOR }); await c.query('COMMIT'); if (!again.repeated) throw new Error('not idempotent'); } finally { c.release(); }
  // Two dispatch requests at the same moment (double click): one deduction.
  if (await ledgerSum(INV.a) !== 200 || (await stockOf(INV.a)).on !== 200) throw new Error('deducted twice');
  // Stock has left: the shipment cannot be moved back before dispatch.
  sh = (await orderShipments(INV.s1lead))[0];
  await expectErr('un-dispatch', () => updateShipment(INV.s1lead, sh.id, { shipment_status: 'packed' }, { actor: ACTOR, version: sh.version }), (e) => e.stockDispatched);
  return 'unreserved dispatch refused (status kept); −20 from D3260511 linked to shipment + order; repeat/in-transit/direct retry deduct nothing; un-dispatch refused';
});
await step('inventory: concurrent dispatch of one shipment deducts once', async () => {
  const o = (await invOrders([amzRow({ 'order-id': AZ(42), 'order-item-id': 'I42', sku: `${TS}-D3-60`, 'quantity-purchased': '4' })]), await amzOrder(42));
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-RACE' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: INV.a2, quantity: 4 }], { actor: ACTOR });
  await addPhoto(o.id);
  const sh = (await orderShipments(o.id))[0];
  const before = await ledgerSum(INV.a);
  // A double click / retry sends the same request (same version) several times at once.
  const race = await Promise.allSettled([1, 2, 3].map(() => updateShipment(o.id, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version })));
  if (race.filter((x) => x.status === 'fulfilled').length !== 1) throw new Error(JSON.stringify(race));
  if (await ledgerSum(INV.a) !== before - 4) throw new Error(`deducted ${before - await ledgerSum(INV.a)}`);
  return `3 simultaneous dispatches → ${race.filter((x) => x.status === 'fulfilled').length} succeeded, 4 units deducted once`;
});
await step('inventory: insufficient stock blocks reservation and dispatch', async () => {
  await invOrders([amzRow({ 'order-id': AZ(43), 'order-item-id': 'I43', sku: `${TS}-B12-30`, 'quantity-purchased': '3' })]);
  const o = await amzOrder(43);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-SHORT' }, { actor: ACTOR })).shipmentId;
  const st = await shipmentStock(sid);
  if (st.state !== 'insufficient' || st.lines[0].available !== 2 || st.lines[0].suggestion.short !== 1) throw new Error(JSON.stringify(st.lines));
  await expectErr('reserve', () => reserveShipmentStock(sid, [{ batch_id: INV.b1, quantity: 3 }], { actor: ACTOR }), (e) => e.insufficientStock);
  await addPhoto(o.id);
  const sh = (await orderShipments(o.id))[0];
  await expectErr('dispatch', () => updateShipment(o.id, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }), (e) => e.needsStock);
  if ((await stockOf(INV.b)).on !== 2 || (await orderShipments(o.id))[0].shipment_status !== 'packed') throw new Error('changed');
  INV.shortShip = { sid, order: o.id };
  return 'needs 3, has 2: shown as insufficient (short 1); reserve and dispatch refused; nothing changed';
});
await step('inventory: unmapped SKU blocks dispatch until mapped', async () => {
  await invOrders([amzRow({ 'order-id': AZ(44), 'order-item-id': 'I44', sku: `${TS}-NOT-A-SKU`, 'quantity-purchased': '1' })]);
  const o = await amzOrder(44);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-UNMAPPED' }, { actor: ACTOR })).shipmentId;
  if ((await shipmentStock(sid)).state !== 'unmapped') throw new Error('state');
  await addPhoto(o.id);
  const sh = (await orderShipments(o.id))[0];
  await expectErr('dispatch', () => updateShipment(o.id, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }), (e) => e.unmappedSkus);
  return 'shipment with an unmapped line cannot be dispatched (no guessing, no deduction)';
});
await step('inventory: several orders in one shipment add up per SKU, one movement per order and batch', async () => {
  await invOrders([
    amzRow({ 'order-id': AZ(45), 'order-item-id': 'I45', sku: `${TS}-D3-60`, 'quantity-purchased': '2' }),
    amzRow({ 'order-id': AZ(46), 'order-item-id': 'I46a', sku: `${TS}-D3-60`, 'quantity-purchased': '3' }),
    amzRow({ 'order-id': AZ(46), 'order-item-id': 'I46b', sku: `${TS}-EASEN`, 'quantity-purchased': '1' }),
  ]);
  INV.c1 = (await receiveInventory({ sku_id: INV.c, batch_number: 'EAS-1', expiry_date: dayOffset(300), quantity: 92, unit_cost: 50, request_id: rid() }, { actor: ACTOR })).batchId;
  const [y, z] = [await amzOrder(45), await amzOrder(46)];
  const stc = (await listCouriers()).find((x) => x.name === 'Shree Tirupati Courier');
  const sid = (await createShipmentForOrders([y.id, z.id], { courier_partner_id: stc.id, tracking_id: 'AWB-INV-MULTI' }, { actor: ACTOR })).shipmentId;
  const st = await shipmentStock(sid);
  const need = Object.fromEntries(st.lines.map((l) => [l.sku, l.required]));
  if (need[`${TS}-D3-60`] !== 5 || need[`${TS}-EASEN`] !== 1 || st.lines.length !== 2) throw new Error(JSON.stringify(need));
  // Reserve exactly the FEFO suggestion, as the UI does.
  await reserveShipmentStock(sid, st.lines.flatMap((l) => l.suggestion.picks), { actor: ACTOR });
  await addPhoto(y.id);
  const sh = (await orderShipments(y.id))[0];
  await updateShipment(y.id, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const { rows } = await getPool().query('SELECT order_id, sku_id, quantity FROM inventory_movements WHERE shipment_id = $1 ORDER BY order_id, sku_id', [sid]);
  const got = rows.map((r) => `${Number(r.order_id) === y.id ? 'Y' : 'Z'}:${r.sku_id === INV.a ? 'D3' : 'EASEN'}:${r.quantity}`).join(' ');
  if (got !== 'Y:D3:-2 Z:D3:-3 Z:EASEN:-1') throw new Error(got);
  return 'Y (D3×2) + Z (D3×3, Easen×1) → D3 5, Easen 1; deducted as Y −2, Z −3, Z −1';
});
await step('inventory: cancelling a shipment before dispatch releases its reservation', async () => {
  await invOrders([amzRow({ 'order-id': AZ(47), 'order-item-id': 'I47', sku: `${TS}-D3-60`, 'quantity-purchased': '6' })]);
  const o = await amzOrder(47);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-CANCEL' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: INV.a2, quantity: 6 }], { actor: ACTOR });
  const before = await stockOf(INV.a);
  const sh = (await orderShipments(o.id))[0];
  await updateShipment(o.id, sh.id, { shipment_status: 'cancelled' }, { actor: ACTOR, version: sh.version });
  const after = await stockOf(INV.a);
  if (after.res !== before.res - 6 || after.on !== before.on) throw new Error(`${JSON.stringify(before)} ${JSON.stringify(after)}`);
  return 'reserved 6 → cancelled → released; on hand unchanged';
});
await step('inventory: two shipments cannot reserve the same last units', async () => {
  // B12 has 2 units. Two shipments each try to take 2 at the same moment.
  await invOrders([
    amzRow({ 'order-id': AZ(48), 'order-item-id': 'I48', sku: `${TS}-B12-30`, 'quantity-purchased': '2' }),
    amzRow({ 'order-id': AZ(49), 'order-item-id': 'I49', sku: `${TS}-B12-30`, 'quantity-purchased': '2' }),
  ]);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const s1 = (await createShipmentForOrders([(await amzOrder(48)).id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-R1' }, { actor: ACTOR })).shipmentId;
  const s2 = (await createShipmentForOrders([(await amzOrder(49)).id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-R2' }, { actor: ACTOR })).shipmentId;
  const race = await Promise.allSettled([s1, s2].map((s) => reserveShipmentStock(s, [{ batch_id: INV.b1, quantity: 2 }], { actor: ACTOR })));
  if (race.filter((x) => x.status === 'fulfilled').length !== 1) throw new Error(JSON.stringify(race.map((x) => x.status)));
  const b = await stockOf(INV.b);
  if (b.res !== 2 || b.av !== 0) throw new Error(JSON.stringify(b));
  // The winner gives it back so later checks start clean.
  await releaseShipmentStock(s1, { actor: ACTOR }); await releaseShipmentStock(s2, { actor: ACTOR });
  return 'one reservation wins, the other is refused; never 4 reserved from 2';
});
await step('inventory: customer return, damaged stock and transfer are ledger movements', async () => {
  const before = await stockOf(INV.a);
  await expectErr('return needs ref', () => adjustStock({ batch_id: INV.a2, movement_type: 'customer_return', quantity: 1, reason: 'Returned sealed' }, { actor: ACTOR }), (e) => e.status === 400);
  await adjustStock({ batch_id: INV.a2, movement_type: 'customer_return', quantity: 1, reason: 'Returned sealed, inspected sellable', reference_id: 'RET-1', order_id: INV.s1lead }, { actor: ACTOR });
  await adjustStock({ batch_id: INV.a1, movement_type: 'damaged', quantity: 5, reason: 'Damaged', notes: '5 bottles damaged during handling' }, { actor: ACTOR });
  const wh = await saveWarehouse({ name: `${TS} 3PL` });
  const t = await transferStock({ batch_id: INV.a1, to_warehouse_id: wh.id, quantity: 10, location: 'Bay 1', request_id: rid() }, { actor: ACTOR });
  const after = await stockOf(INV.a);
  if (after.on !== before.on + 1 - 5 || await ledgerSum(INV.a) !== after.on) throw new Error(`${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const d = await skuDetail(INV.a);
  const types = d.movements.slice(0, 4).map((m) => `${m.movement_type}:${m.quantity}`).join(' ');
  if (types !== 'transfer_in:10 transfer_out:-10 damaged:-5 customer_return:1') throw new Error(types);
  if (!d.batches.some((b) => b.id === t.batchId && b.warehouse_name === `${TS} 3PL` && b.on_hand === 10 && b.location === 'Bay 1')) throw new Error('transfer batch');
  const ret = d.movements.find((m) => m.movement_type === 'customer_return');
  if (ret.reference_type !== 'return' || ret.reference_id !== 'RET-1') throw new Error('return reference');
  return 'return +1 (ref RET-1), damaged −5 with note, transfer 10 to 3PL (−10/+10); ledger sum = on hand';
});
await step('inventory: low stock, out of stock, expiry windows and value', async () => {
  // B12: 2 on hand, reorder level 5 → low. Easen: no reorder level. A fresh SKU with nothing → out of stock.
  const b = await getSku(INV.b);
  if (!b.low_stock || b.out_of_stock) throw new Error(JSON.stringify(b));
  const empty = (await createSku({ sku: `${TS}-EMPTY`, product_name: 'Nothing yet', reorder_level: 10 }, { actor: ACTOR })).id;
  if (!(await getSku(empty)).out_of_stock) throw new Error('out');
  const soon = (await receiveInventory({ sku_id: INV.c, batch_number: 'EAS-SOON', expiry_date: dayOffset(20), quantity: 3, unit_cost: 50, request_id: rid() }, { actor: ACTOR })).batchId;
  const ov = await inventoryOverview({ q: TS });
  const row = (id) => ov.rows.find((r) => r.id === id);
  if (row(soon).days_to_expiry !== 20 || row(INV.aExp).effective_status !== 'expired' || row(INV.aQ).effective_status !== 'quarantined') throw new Error('statuses');
  const e30 = await inventoryOverview({ expiring: '30', q: TS });
  if (!e30.rows.some((r) => r.id === soon) || e30.rows.some((r) => r.id === INV.a2)) throw new Error('30-day filter');
  const exp = await inventoryOverview({ expiring: 'expired', q: TS });
  if (exp.rows.length !== 1 || exp.rows[0].id !== INV.aExp) throw new Error('expired filter');
  const low = await inventoryOverview({ stock: 'low', q: TS });
  if (!low.rows.every((r) => r.sku_id === INV.b)) throw new Error('low filter');
  // Value: on hand × unit cost per batch, never the selling price.
  const d = await skuDetail(INV.a);
  const expect = d.batches.reduce((n, x) => n + x.on_hand * (x.unit_cost || 0), 0);
  if (Math.abs((await getSku(INV.a)).value - expect) > 0.001 || expect <= 0) throw new Error(`${(await getSku(INV.a)).value} vs ${expect}`);
  const a1 = d.batches.find((x) => x.id === INV.a1);
  if (a1.value !== a1.on_hand * 180) throw new Error('batch value');
  return `B12 low (2 ≤ 5); empty SKU out of stock; +20d in the 30-day window, expired/quarantined flagged; D3 value ₹${expect.toLocaleString('en-IN')} = Σ on hand × cost`;
});
await step('inventory: overview cards add up', async () => {
  const ov = await inventoryOverview({});
  const c = ov.cards;
  const sums = ov.rows.filter((r) => !r.empty);
  if (c.totalUnits !== sums.reduce((n, r) => n + r.on_hand, 0) || c.reservedUnits !== sums.reduce((n, r) => n + r.reserved, 0)) throw new Error(JSON.stringify(c));
  if (!(c.totalSkus >= 4 && c.lowStock >= 1 && c.outOfStock >= 1 && c.expired >= 1 && c.expiring30 >= 1 && c.inventoryValue > 0)) throw new Error(JSON.stringify(c));
  return `${c.totalSkus} SKUs, ${c.totalUnits} units, ${c.availableUnits} available, ${c.reservedUnits} reserved, ${c.lowStock} low, ${c.outOfStock} out, ${c.expiring90} expiring ≤90d`;
});
await step('inventory: on hand vs sellable vs reserved vs available to dispatch (1,000 / 100 expired / 20 quarantined / 50 reserved → 830)', async () => {
  const id = (await createSku({ sku: `${TS}-AVAIL`, product_name: 'Availability example' }, { actor: ACTOR })).id;
  const good = (await receiveInventory({ sku_id: id, batch_number: 'AV-GOOD', expiry_date: '12/2030', quantity: 880, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  await receiveInventory({ sku_id: id, batch_number: 'AV-EXP', expiry_date: dayOffset(-10), quantity: 100, unit_cost: 10, request_id: rid() }, { actor: ACTOR });
  const q = (await receiveInventory({ sku_id: id, batch_number: 'AV-QUAR', expiry_date: '12/2030', quantity: 20, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  await updateBatch(q, { status: 'quarantined', reason: 'Lab retest' }, { actor: ACTOR });
  await invOrders([amzRow({ 'order-id': AZ(60), 'order-item-id': 'I60', sku: `${TS}-AVAIL`, 'quantity-purchased': '50' })]);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([(await amzOrder(60)).id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-AVAIL' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: good, quantity: 50 }], { actor: ACTOR });
  const s = await getSku(id);
  const got = { on_hand: s.on_hand, sellable: s.sellable, expired: s.expired, quarantined: s.quarantined, blocked: s.blocked, reserved: s.reserved_sellable, available: s.available };
  const want = { on_hand: 1000, sellable: 880, expired: 100, quarantined: 20, blocked: 0, reserved: 50, available: 830 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got));
  if (s.on_hand !== s.sellable + s.expired + s.quarantined + s.blocked) throw new Error('buckets do not add up');
  // Blocking the good batch takes it out of available to dispatch too.
  await updateBatch(good, { status: 'blocked', reason: 'Recall check' }, { actor: ACTOR });
  const b = await getSku(id);
  if (b.available !== 0 || b.blocked !== 880 || b.sellable !== 0 || !b.out_of_stock) throw new Error(JSON.stringify(b));
  await updateBatch(good, { status: 'active', reason: 'Cleared' }, { actor: ACTOR });
  await releaseShipmentStock(sid, { actor: ACTOR });
  return 'on hand 1,000 = sellable 880 + expired 100 + quarantined 20; available to dispatch = 880 − 50 = 830; blocked batch → 0 available';
});
await step('inventory: month-only expiry is the last calendar day, stored as a date, never shifted', async () => {
  const id = (await createSku({ sku: `${TS}-EXPIRY`, product_name: 'Expiry dates' }, { actor: ACTOR })).id;
  const cases = [['08/2028', '2028-08-31'], ['2028-08', '2028-08-31'], ['02/2028', '2028-02-29'], ['02/2027', '2027-02-28'], ['31/12/2029', '2029-12-31'], ['2029-01-15', '2029-01-15']];
  for (const [i, [input, want]] of cases.entries()) {
    const r = await receiveInventory({ sku_id: id, batch_number: `EXP-${i}`, expiry_date: input, quantity: 1, request_id: rid() }, { actor: ACTOR });
    const raw = (await getPool().query('SELECT expiry_date, expiry_date::text AS t, pg_typeof(expiry_date)::text AS ty FROM inventory_batches WHERE id = $1', [r.batchId])).rows[0];
    const shown = (await skuDetail(id)).batches.find((b) => b.id === r.batchId).expiry_date;
    if (raw.t !== want || raw.ty !== 'date' || raw.expiry_date !== want || shown !== want) throw new Error(`${input} → ${raw.t} / ${raw.expiry_date} / ${shown}`);
  }
  for (const badInput of ['13/2028', '31/02/2028', 'Aug 2028']) {
    await expectErr(badInput, () => receiveInventory({ sku_id: id, batch_number: 'EXP-BAD', expiry_date: badInput, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 400);
  }
  return `${cases.length} spellings stored as exact DATEs (08/2028 → 2028-08-31, 02/2028 → 2028-02-29), read back as text in TZ=${process.env.TZ || 'system'}; bad months refused`;
});
await step('inventory: only inventory-tracked SKUs need stock at dispatch', async () => {
  const svc = (await createSku({ sku: `${TS}-GIFTCARD`, product_name: 'Gift card (not stock)', track_inventory: false }, { actor: ACTOR })).id;
  await invOrders([amzRow({ 'order-id': AZ(61), 'order-item-id': 'I61', sku: `${TS}-GIFTCARD`, 'quantity-purchased': '1' })]);
  const o = await amzOrder(61);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipmentForOrders([o.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-UNTRACKED' }, { actor: ACTOR })).shipmentId;
  const st = await shipmentStock(sid);
  if (st.state !== 'no_items' || st.untracked.length !== 1) throw new Error(JSON.stringify(st));
  await addPhoto(o.id);
  const sh = (await orderShipments(o.id))[0];
  await updateShipment(o.id, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  if ((await getPool().query('SELECT count(*)::int n FROM inventory_movements WHERE shipment_id = $1', [sid])).rows[0].n) throw new Error('stock moved');
  const g = await getSku(svc);
  if (g.out_of_stock || g.low_stock) throw new Error('untracked SKU flagged as out of stock');
  // Tracked again → the same kind of order needs stock.
  await updateSku(svc, { track_inventory: true }, { actor: ACTOR });
  await invOrders([amzRow({ 'order-id': AZ(62), 'order-item-id': 'I62', sku: `${TS}-GIFTCARD`, 'quantity-purchased': '1' })]);
  const o2 = await amzOrder(62);
  const sid2 = (await createShipmentForOrders([o2.id], { courier_partner_id: dl.id, tracking_id: 'AWB-INV-TRACKED' }, { actor: ACTOR })).shipmentId;
  if ((await shipmentStock(sid2)).state !== 'insufficient') throw new Error('tracked SKU not checked');
  return 'untracked SKU: dispatched with no reservation or movement, never "out of stock"; tracked: stock required';
});
await step('orders list: fixed number of queries whatever the page size (no N+1); each row carries its SKUs', async () => {
  const pool = getPool();
  const real = pool.query.bind(pool);
  let n = 0;
  pool.query = (...a) => { n += 1; return real(...a); };
  try {
    await listOrders({}, { limit: 1 });
    const small = n; n = 0;
    const big = await listOrders({}, { limit: 500 });
    if (n !== small || big.orders.length < 10) throw new Error(`${small} queries for 1 row, ${n} for ${big.orders.length}`);
  } finally { pool.query = real; }
  // Amazon row: seller SKU and Briyo SKU side by side; no raw payload.
  const row = (await listOrders({ q: AZ(40) })).orders.find((o) => o.source_order_id === AZ(40));
  const l = row.line_skus?.[0];
  if (!l || l.code !== `${TS}-D3-60` || l.briyo_sku !== `${TS}-D3-60` || l.sku_id !== INV.a || l.quantity !== 20 || 'source_payload' in row) throw new Error(JSON.stringify(row.line_skus));
  const unm = (await listOrders({ q: AZ(44) })).orders[0].line_skus[0];
  if (unm.code !== `${TS}-NOT-A-SKU` || unm.sku_id !== null || unm.briyo_sku !== null) throw new Error(JSON.stringify(unm));
  return `${n} queries for 1 row and for a full page; rows list each line's channel SKU + Briyo SKU`;
});

// ---- master SKU + platform SKUs ----------------------------------------------------
// Test platforms are created with a key from the test prefix so the purge removes them.
const PF = { amazon: 'amazon', blinkit: 'blinkit', zepto: 'zepto' };
const lineOn = async (channel, number, code, qty = 1) => {
  const id = await createOrder({ ...R(channel), channel, source_order_id: `${TEST_ORDER}-${number}`, order_date: NOW(), order_value: 100 }, { actor: ACTOR });
  // Resolved the way the importers do: master code, or this channel's platform SKU; else unmapped.
  const c = await getPool().connect();
  let skuId;
  try { skuId = (await resolveSkuIds(c, channel, [code])).get(code.toLowerCase()) ?? null; } finally { c.release(); }
  await getPool().query(
    `INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, sku_id)
     VALUES ($1, 'L1', $2, 'Test line', $3, 100, $4)`, [id, code, qty, skuId]);
  return id;
};
const lineOf = async (orderId) => (await getPool().query('SELECT sku, sku_id FROM order_items WHERE order_id = $1', [orderId])).rows[0];

await step('platform SKUs: one master, several platform SKUs (two Amazon, one Blinkit), listed on the master', async () => {
  INV.m = (await createSku({ sku: `${TS}-BS002E90`, product_name: 'Briyo Vitamin D3 2000 IU Capsules' }, { actor: ACTOR })).id;
  INV.m2 = (await createSku({ sku: `${TS}-BS003R90`, product_name: 'Briyo Vitamin D3 1000 IU Capsules' }, { actor: ACTOR })).id;
  const a = await addPlatformMappings(INV.m, PF.amazon, `${TS}-WF-IATY\n${TS}-ABC-123 / ${TS}-XYZ-456`, { actor: ACTOR });
  const b = await addPlatformMappings(INV.m, PF.blinkit, [`${TS}10190237`], { actor: ACTOR });
  if (a.added.length !== 3 || b.added.length !== 1) throw new Error(JSON.stringify({ a, b }));
  const again = await addPlatformMappings(INV.m, PF.amazon, [`${TS}-wf-iaty`], { actor: ACTOR });   // any letter case
  if (again.added.length || again.existing.length !== 1) throw new Error('re-adding the same mapping should be a no-op');
  const m = await getSku(INV.m);
  const got = m.platform_skus.map((x) => `${x.platform}:${x.platform_sku}`).sort().join(' ');
  if (got !== [`amazon:${TS}-ABC-123`, `amazon:${TS}-WF-IATY`, `amazon:${TS}-XYZ-456`, `blinkit:${TS}10190237`].sort().join(' ')) throw new Error(got);
  return 'multiline + "/" cell → 3 Amazon SKUs; 1 Blinkit SKU; all on the one master; re-adding is a no-op';
});
await step('platform SKUs: entry rules — trimmed, inner spaces refused, idempotent, conflicts refused', async () => {
  const t = await addPlatformMappings(INV.m, PF.zepto, [`   ${TS}-ZP-TRIM \t`.replace('\t', '')], { actor: ACTOR });
  if (t.added[0] !== `${TS}-ZP-TRIM`) throw new Error(`not trimmed: ${JSON.stringify(t)}`);
  await expectErr('inner space', () => addPlatformMappings(INV.m, PF.amazon, [`${TS}-WF-IATY- Z4SW`], { actor: ACTOR }),
    (e) => e.status === 400 && /contains a space/.test(e.message) && e.invalidPlatformSku === `${TS}-WF-IATY- Z4SW`);
  if ((await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings WHERE platform_sku LIKE $1', [`${TS}-WF-IATY-%Z4SW`])).rows[0].n) throw new Error('spaced SKU stored');
  const same = await addPlatformMappings(INV.m, PF.blinkit, [`${TS}10190237`], { actor: ACTOR });
  if (same.added.length || same.existing.length !== 1) throw new Error('same SKU on same master should be a no-op');
  const rows = (await getPool().query(`SELECT count(*)::int n FROM sku_platform_mappings WHERE platform = 'blinkit' AND lower(platform_sku) = lower($1)`, [`${TS}10190237`])).rows[0].n;
  if (rows !== 1) throw new Error('duplicate row stored');
  await expectErr('platform SKU = another master code', () => addPlatformMappings(INV.m, PF.zepto, [`${TS}-BS003R90`], { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('master code = an existing platform SKU', () => createSku({ sku: `${TS}-WF-IATY`, product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('tab inside', () => addPlatformMappings(INV.m, PF.zepto, ['3d99d620\t950d'], { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('placeholder only', () => addPlatformMappings(INV.m, PF.zepto, 'NA', { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('unknown platform', () => addPlatformMappings(INV.m, 'nope', ['X1'], { actor: ACTOR }), (e) => e.status === 400);
  // The same code on a different platform is a different identifier and is allowed.
  const z = await addPlatformMappings(INV.m2, PF.zepto, [`${TS}10190237`], { actor: ACTOR });
  if (z.added.length !== 1) throw new Error('same code on another platform refused');
  return 'leading/trailing spaces trimmed; "WF-IATY- Z4SW" refused (nothing stored); same SKU on same master is a no-op; master-code clash, tab, NA, unknown platform refused; same code on Zepto is separate';
});
await step('platform SKUs: a SKU already on another master needs confirmation and a reason; the override is stored and audited', async () => {
  const code = `${TS}10190237`;   // Blinkit, already on TS-BS002E90
  await expectErr('duplicate without confirmation', () => addPlatformMappings(INV.m2, PF.blinkit, [code], { actor: ACTOR }), (e) => e.status === 409
    && e.duplicateMapping?.duplicates[0].platform_sku === code && e.duplicateMapping.duplicates[0].mapped_to[0].sku === `${TS}-BS002E90`
    && e.duplicateMapping.target.sku === `${TS}-BS003R90` && e.duplicateMapping.platform_label === 'Blinkit');
  await expectErr('confirmed, no reason', () => addPlatformMappings(INV.m2, PF.blinkit, [code], { actor: ACTOR, confirmDuplicate: true }), (e) => e.status === 400 && e.reasonRequired);
  await expectErr('confirmed, blank reason', () => addPlatformMappings(INV.m2, PF.blinkit, [code], { actor: ACTOR, confirmDuplicate: true, reason: '   ' }), (e) => e.status === 400 && e.reasonRequired);
  const count = async () => (await getPool().query(`SELECT count(*)::int n FROM sku_platform_mappings WHERE platform = 'blinkit' AND lower(platform_sku) = lower($1)`, [code])).rows[0].n;
  if (await count() !== 1) throw new Error('a refused duplicate was stored');
  const why = 'Same Blinkit SKU temporarily used for two listings during catalog transition.';
  const r = await addPlatformMappings(INV.m2, PF.blinkit, [code], { actor: ACTOR, confirmDuplicate: true, reason: `  ${why} ` });
  if (r.added[0] !== code || r.duplicateOverrides[0] !== code || await count() !== 2) throw new Error(JSON.stringify(r));
  const stored = (await getSku(INV.m2)).platform_skus.find((x) => x.platform === 'blinkit' && x.platform_sku === code);
  if (!stored?.duplicate_override || stored.duplicate_reason !== why || stored.created_by !== ACTOR || !stored.created_at) throw new Error(JSON.stringify(stored));
  const primary = (await getSku(INV.m)).platform_skus.find((x) => x.platform === 'blinkit' && x.platform_sku === code);
  if (primary.duplicate_override) throw new Error('the original mapping changed');
  const a = (await getPool().query(`SELECT actor, metadata FROM inventory_audit WHERE action = 'platform_sku_duplicate_override' AND sku_id = $1 ORDER BY id DESC LIMIT 1`, [INV.m2])).rows[0];
  if (a?.actor !== ACTOR || a.metadata.reason !== why
    || a.metadata.message !== `Blinkit SKU ${code} was added to ${TS}-BS003R90 despite already being mapped to ${TS}-BS002E90.`) throw new Error(JSON.stringify(a));
  // The database itself refuses an override with no reason.
  await expectErr('override row without reason', () => getPool().query(
    `INSERT INTO sku_platform_mappings (sku_id, platform, platform_sku, duplicate_override) VALUES ($1, 'blinkit', $2, true)`, [INV.m, `${TS}-NOREASON`]), (e) => e.code === '23514');
  // Orders keep resolving to the first (regular) mapping.
  const c = await getPool().connect();
  try { if ((await resolveSkuIds(c, 'blinkit', [code])).get(code.toLowerCase()) !== INV.m) throw new Error('resolution moved to the duplicate'); } finally { c.release(); }
  return '409 with both masters named; no reason / blank reason refused (400), nothing stored; with a reason: added, override + reason + who/when stored, audit message exact; DB check forbids reasonless overrides; orders still resolve to the original master';
});
await step('platform SKUs: a code picked from an order keeps the platform\'s exact spelling (spaces included)', async () => {
  const spaced = `${TS}-Melatonin_60  Tablet`;
  await expectErr('typed with spaces', () => addPlatformMappings(INV.m2, PF.amazon, [spaced], { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('fromOrder but on no order', () => addPlatformMappings(INV.m2, PF.amazon, [spaced], { actor: ACTOR, fromOrder: true }), (e) => e.status === 400 && /No amazon order line/.test(e.message));
  const order = await lineOn('amazon', 'PF-MEL', spaced, 1);
  const r = await addPlatformMappings(INV.m2, PF.amazon, [spaced], { actor: ACTOR, fromOrder: true });
  const l = await lineOf(order);
  if (r.added[0] !== spaced || r.orderItemsMapped !== 1 || l.sku_id !== INV.m2 || l.sku !== spaced) throw new Error(JSON.stringify({ r, l }));
  const m = (await getSku(INV.m2)).platform_skus.find((x) => x.platform_sku === spaced);
  if (m.source !== 'unmapped') throw new Error(m.source);
  return '"Melatonin_60  Tablet" typed: refused; taken from an Amazon order line: mapped verbatim and the line resolved';
});
await step('platform SKUs: resolution — Amazon and Blinkit codes reach the same master; website uses master codes', async () => {
  const c = await getPool().connect();
  try {
    const amz = await resolveSkuIds(c, 'amazon', [`${TS}-XYZ-456`, `${TS}-wf-iaty`, `${TS}-UNKNOWN`]);
    const bl = await resolveSkuIds(c, 'blinkit', [`${TS}10190237`, `${TS}-BS002E90`]);
    const web = await resolveSkuIds(c, 'website', [`${TS}-BS002E90`, `${TS}10190237`]);
    if (amz.get(`${TS}-xyz-456`.toLowerCase()) !== INV.m || amz.get(`${TS}-wf-iaty`.toLowerCase()) !== INV.m || amz.has(`${TS}-unknown`.toLowerCase())) throw new Error('amazon');
    if (bl.get(`${TS}10190237`.toLowerCase()) !== INV.m || bl.get(`${TS}-bs002e90`.toLowerCase()) !== INV.m) throw new Error('blinkit');
    if (web.get(`${TS}-bs002e90`.toLowerCase()) !== INV.m || web.has(`${TS}10190237`.toLowerCase())) throw new Error('website');
    const z = await resolveSkuIds(c, 'zepto', [`${TS}10190237`]);
    if (z.get(`${TS}10190237`.toLowerCase()) !== INV.m2) throw new Error('platform-scoped lookup');
  } finally { c.release(); }
  return 'Amazon SKU → master; Blinkit SKU → same master; master code works on any channel; a Blinkit code means nothing on the website; Zepto code of the same digits → its own master';
});
await step('platform SKUs: unmapped lines stay unmapped (code kept, nothing created) until mapped, then resolve', async () => {
  const before = (await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n;
  INV.blOrder = await lineOn('blinkit', 'PF-BL1', `${TS}20000001`, 2);
  let l = await lineOf(INV.blOrder);
  if (l.sku_id !== null || l.sku !== `${TS}20000001`) throw new Error(JSON.stringify(l));
  if (!(await unmappedSkus()).some((u) => u.code === `${TS}20000001` && u.channel === 'blinkit' && u.platform_label === 'Blinkit' && u.mappable)) throw new Error('not listed as unmapped Blinkit SKU');
  const r = await addPlatformMappings(INV.m, PF.blinkit, [`${TS}20000001`], { actor: ACTOR });
  l = await lineOf(INV.blOrder);
  if (r.orderItemsMapped !== 1 || l.sku_id !== INV.m || l.sku !== `${TS}20000001`) throw new Error(JSON.stringify({ r, l }));
  if ((await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n !== before) throw new Error('a SKU was created');
  return 'Blinkit line kept its code, listed as unmapped, no SKU made; mapping resolved it at once (no re-import)';
});
await step('platform SKUs: Amazon and Blinkit orders draw on one stock pool', async () => {
  const b = (await receiveInventory({ sku_id: INV.m, batch_number: 'PF-POOL', expiry_date: '12/2030', quantity: 10, unit_cost: 50, request_id: rid() }, { actor: ACTOR })).batchId;
  const amzOrder2 = await lineOn('amazon', 'PF-AMZ1', `${TS}-ABC-123`, 3);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const s1 = (await createShipment({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-PF-AMZ1`, courier_partner_id: dl.id, tracking_id: 'AWB-PF-1', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true })).shipmentId;
  const s2 = (await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-PF-BL1`, courier_partner_id: dl.id, tracking_id: 'AWB-PF-2', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true })).shipmentId;
  const st1 = await shipmentStock(s1); const st2 = await shipmentStock(s2);
  if (st1.lines[0]?.sku_id !== INV.m || st2.lines[0]?.sku_id !== INV.m) throw new Error('not resolved to the master');
  await reserveShipmentStock(s1, [{ batch_id: b, quantity: 3 }], { actor: ACTOR });
  await reserveShipmentStock(s2, [{ batch_id: b, quantity: 2 }], { actor: ACTOR });
  const m = await getSku(INV.m);
  if (m.on_hand !== 10 || m.reserved !== 5 || m.available !== 5) throw new Error(JSON.stringify({ on: m.on_hand, res: m.reserved, av: m.available }));
  const third = await lineOn('amazon', 'PF-AMZ2', `${TS}-XYZ-456`, 6);
  const s3 = (await createShipment({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-PF-AMZ2`, courier_partner_id: dl.id, tracking_id: 'AWB-PF-3', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true })).shipmentId;
  await expectErr('pool exhausted', () => reserveShipmentStock(s3, [{ batch_id: b, quantity: 6 }], { actor: ACTOR }), (e) => e.insufficientStock);
  INV.pf = { s1, s2, s3, amzOrder2, third };
  return 'master stock 10: Amazon (ABC-123) reserves 3, Blinkit reserves 2 → 5 left; another Amazon code wanting 6 is refused';
});
await step('platform SKUs: removing a mapping unmaps its lines, but not while stock is reserved for them', async () => {
  const m = await getSku(INV.m);
  const xyz = m.platform_skus.find((x) => x.platform_sku === `${TS}-XYZ-456`);
  const abc = m.platform_skus.find((x) => x.platform_sku === `${TS}-ABC-123`);
  const usage = await mappingUsage(INV.m);
  if (usage[abc.id] !== 1) throw new Error(`usage ${JSON.stringify(usage)}`);
  await expectErr('reserved', () => removePlatformMapping(abc.id, { actor: ACTOR }), (e) => e.status === 409);
  const r = await removePlatformMapping(xyz.id, { actor: ACTOR });
  if (r.orderItemsUnmapped !== 1 || (await lineOf(INV.pf.third)).sku_id !== null) throw new Error(JSON.stringify(r));
  if ((await getSku(INV.m)).platform_skus.some((x) => x.platform_sku === `${TS}-XYZ-456`)) throw new Error('still listed');
  await releaseShipmentStock(INV.pf.s1, { actor: ACTOR }); await releaseShipmentStock(INV.pf.s2, { actor: ACTOR });
  return 'mapping used by a reserved line: refused; unused-by-stock mapping removed → its 1 line back to unmapped';
});
await step('platform SKUs: removing the original of a duplicated SKU moves its lines to the remaining master', async () => {
  const code = `${TS}10190237`;
  const order = await lineOn('blinkit', 'PF-DUP', code, 1);
  if ((await lineOf(order)).sku_id !== INV.m) throw new Error('line should resolve to the original mapping');
  const orig = (await getSku(INV.m)).platform_skus.find((x) => x.platform === 'blinkit' && x.platform_sku === code);
  const r = await removePlatformMapping(orig.id, { actor: ACTOR });
  const l = await lineOf(order);
  if (r.orderItemsMoved !== 1 || l.sku_id !== INV.m2 || l.sku !== code) throw new Error(JSON.stringify({ r, l }));
  return 'line on the original master; original mapping removed → line moved to the duplicate\'s master, code unchanged';
});
await step('platform SKUs: a new platform is a row, not a migration', async () => {
  const p = await savePlatform({ label: `${TS} Clinic Shop` }, { actor: ACTOR });
  if (!p.key.startsWith('dbcheck_inv') || !(await listPlatforms()).some((x) => x.key === p.key)) throw new Error(JSON.stringify(p));
  const r = await addPlatformMappings(INV.m2, p.key, ['CLIN-001'], { actor: ACTOR });
  if (r.added[0] !== 'CLIN-001') throw new Error('mapping on the new platform');
  const seeded = (await listPlatforms()).map((x) => x.key);
  for (const k of ['amazon', 'blinkit', 'zepto', 'tata_1mg', 'netmeds', 'clinikally']) if (!seeded.includes(k)) throw new Error(`missing platform ${k}`);
  return `added "${p.label}" (${p.key}) and mapped to it with no schema change; the 6 standard platforms are seeded`;
});
await step('platform SKUs: historical Amazon orders keep their master SKU through the move off the old column', async () => {
  // A master set up the old way (code in skus.amazon_seller_sku) with an order line already resolved through it.
  const legacy = (await createSku({ sku: `${TS}-LEGACY`, product_name: 'Legacy mapped' }, { actor: ACTOR })).id;
  await getPool().query('UPDATE skus SET amazon_seller_sku = $2 WHERE id = $1', [legacy, `${TS}-OLDAMZ`]);
  const oldOrder = await lineOn('amazon', 'PF-OLD', `${TS}-OLDAMZ`, 1);
  await getPool().query('UPDATE order_items SET sku_id = $2 WHERE order_id = $1', [oldOrder, legacy]);
  const waiting = await lineOn('amazon', 'PF-OLD2', `${TS}-OLDAMZ`, 1);   // arrived but not yet resolved
  const r1 = await migrateLegacyAmazonSkus(getPool());
  const r2 = await migrateLegacyAmazonSkus(getPool());   // idempotent
  const row = (await getPool().query('SELECT amazon_seller_sku FROM skus WHERE id = $1', [legacy])).rows[0];
  const maps = (await getSku(legacy)).platform_skus;
  if (r1.moved < 1 || r2.moved !== 0 || row.amazon_seller_sku !== null || maps.length !== 1 || maps[0].platform_sku !== `${TS}-OLDAMZ` || maps[0].source !== 'migrated') throw new Error(JSON.stringify({ r1, r2, row, maps }));
  if ((await lineOf(oldOrder)).sku_id !== legacy) throw new Error('historical line lost its master');
  const c = await getPool().connect();
  try { if ((await resolveSkuIds(c, 'amazon', [`${TS}-OLDAMZ`])).get(`${TS}-oldamz`.toLowerCase()) !== legacy) throw new Error('not resolvable'); } finally { c.release(); }
  const { remapOrderItems } = await import('../lib/inventory.js');
  const c2 = await getPool().connect();
  try { await remapOrderItems(c2, legacy); } finally { c2.release(); }
  if ((await lineOf(waiting)).sku_id !== legacy) throw new Error('waiting line not resolved via migrated mapping');
  return 'old column → Amazon mapping (source "migrated"), column cleared, re-run moves 0; resolved line unchanged; waiting line resolves';
});
await step('master SKU import: parser — Briyo SKU + Product Name only; platform columns ignored with a warning', async () => {
  const two = planSkuSheet([['Briyo SKU', 'Product Name'], ['A1', 'Alpha'], ['', ''], ['A2', '  Beta   capsules ']]);
  if (two.errors.length || two.warnings.length || two.masters.map((m) => `${m.sku}:${m.name}`).join('|') !== 'A1:Alpha|A2:Beta capsules') throw new Error(JSON.stringify(two));
  const wide = planSkuSheet([['PARENT BRIYO SKU CODE', 'PRODUCT NAME', 'Blinkit Sku ID', 'Zepto Sku ID', 'Amazon'],
    ['B1', 'x', '10190237', '3d99d620-2aff-4c7d- 950d-7003be9c7f1', 'B0C3R3CCNX']]);
  if (wide.errors.length || wide.masters.length !== 1 || !/Ignored columns: "Blinkit Sku ID", "Zepto Sku ID", "Amazon"/.test(wide.warnings[0]?.reason)) throw new Error(JSON.stringify(wide));
  const bad = planSkuSheet([['Briyo SKU', 'Product Name'],
    ['C1', 'one'], ['c1', 'dup'], ['', 'no code'], ['bad code!', 'x'], ['C5', ''], ['C6', '   ']]);
  const reasons = bad.errors.map((e) => `${e.row}:${e.reason}`).join(' | ');
  for (const re of [/^3:.*appears again/m, /4:Master SKU is missing for "no code"/, /5:.*not valid/, /6:Product name is missing for C5/, /7:Product name is missing for C6/]) {
    if (!re.test(reasons.replace(/ \| /g, '\n'))) throw new Error(`missing ${re}: ${reasons}`);
  }
  await expectErr('no name column', async () => planSkuSheet([['Briyo SKU', 'Amazon'], ['X', 'Y']]), (e) => e.status === 400 && /Product Name/.test(e.message));
  return 'two columns read; blank rows skipped; platform columns ignored (warning, not error) even with bad values; duplicate (any case), missing, invalid master and missing/blank name: errors';
});
await step('master SKU import: preview writes nothing; errors block all; masters with no platform SKUs import; re-import changes nothing', async () => {
  const csv = (rows) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));
  const head = ['Briyo SKU', 'Product Name'];
  const mapsBefore = (await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n;
  // One bad row blocks the whole sheet.
  const blocked = csv([head, [`${TS}-IMP1`, 'Imported one'], [`${TS}-IMP1B`, '']]);
  const p1 = await previewSkuImport(blocked, 'blocked.csv');
  if (p1.summary.errorCount !== 1 || p1.summary.mastersNew !== 1) throw new Error(JSON.stringify(p1.summary));
  await expectErr('commit with errors', () => commitSkuImport(blocked, 'blocked.csv', { actor: ACTOR }), (e) => e.status === 400 && e.importErrors?.length === 1);
  if ((await getPool().query('SELECT count(*)::int n FROM skus WHERE sku = $1', [`${TS}-IMP1`])).rows[0].n) throw new Error('blocked import wrote a master');
  // A master code that is already a platform SKU of another product is an error.
  const clash = await previewSkuImport(csv([head, [`${TS}-WF-IATY`, 'Clash']]), 'clash.csv');
  if (clash.summary.errorCount !== 1 || !/already a Amazon SKU|already an? Amazon SKU/.test(clash.errors[0].reason)) throw new Error(JSON.stringify(clash.errors));
  // Clean: two new masters (no platform SKUs at all), one existing master renamed; extra platform columns only warn.
  const clean = csv([[...head, 'Amazon', 'Blinkit Sku ID'],
    [`${TS}-IMP2`, 'Imported two', `${TS}-IGNORED-AMZ`, ''],
    [`${TS}-IMP3`, 'Imported three — no platform SKUs', '', ''],
    [`${TS}-BS002E90`, 'Briyo Vitamin D3 2000 IU Capsules (90)', '', ''],
  ]);
  const p2 = await previewSkuImport(clean, 'clean.csv');
  const s2 = p2.summary;
  if (s2.errorCount || s2.mastersNew !== 2 || s2.mastersRenamed !== 1 || s2.warningCount !== 1) throw new Error(JSON.stringify(s2));
  if ((await getPool().query('SELECT count(*)::int n FROM skus WHERE sku = $1', [`${TS}-IMP2`])).rows[0].n) throw new Error('preview wrote');
  const c1 = await commitSkuImport(clean, 'clean.csv', { actor: ACTOR });
  if (c1.summary.mastersNew !== 2 || c1.summary.mastersRenamed !== 1) throw new Error(JSON.stringify(c1.summary));
  const imp3 = (await getPool().query('SELECT id, product_name FROM skus WHERE sku = $1', [`${TS}-IMP3`])).rows[0];
  if (!imp3 || (await getSku(imp3.id)).platform_skus.length) throw new Error('product without platform SKUs');
  if ((await getSku(INV.m)).product_name !== 'Briyo Vitamin D3 2000 IU Capsules (90)') throw new Error('rename');
  if ((await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n !== mapsBefore) throw new Error('the import created or removed platform SKU mappings');
  if ((await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings WHERE platform_sku = $1', [`${TS}-IGNORED-AMZ`])).rows[0].n) throw new Error('platform column imported');
  const c2 = await commitSkuImport(clean, 'clean.csv', { actor: ACTOR });
  if (c2.summary.mastersNew || c2.summary.mastersRenamed || c2.summary.mastersUnchanged !== 3) throw new Error(`re-import: ${JSON.stringify(c2.summary)}`);
  if (!(await getPool().query(`SELECT 1 FROM inventory_audit WHERE action = 'sku_master_import' AND actor = $1`, [ACTOR])).rows.length) throw new Error('import not audited');
  return 'error row → whole sheet refused, nothing written; master = existing platform SKU refused; 2 new masters (one with no platform SKU) + 1 renamed; platform columns ignored, mappings untouched; re-import: 0 changes';
});

// ---- Phase 1 stock integrity: split shipments, cancellation, re-import after dispatch
const P1 = {};
const ezShip = (n, awb) => ({ dispatch_type: 'easy_ship', destination_id: null, channel: 'amazon', source_order_id: AZ(n), tracking_id: awb });
const shipOf = async (orderId, shipmentId) => (await orderShipments(orderId)).find((x) => x.id === shipmentId);
const dispatchShip = async (orderId, shipmentId) => {
  const sh = await shipOf(orderId, shipmentId);
  return updateShipment(orderId, shipmentId, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
};
const dispatchedFor = async (shipmentId) => (await getPool().query(
  `SELECT coalesce(-sum(quantity), 0)::int n FROM inventory_movements WHERE shipment_id = $1 AND movement_type = 'shipment_dispatched'`, [shipmentId])).rows[0].n;
await step('phase 1 setup: a stocked master SKU and an Amazon order for 10 units', async () => {
  P1.sku = (await createSku({ sku: `${TS}-SPLIT`, product_name: 'Split test' }, { actor: ACTOR })).id;
  P1.batch = (await receiveInventory({ sku_id: P1.sku, batch_number: 'SPLIT-1', expiry_date: dayOffset(400), quantity: 50, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  await invOrders([amzRow({ 'order-id': AZ(80), 'order-item-id': 'I80', sku: `${TS}-SPLIT`, 'quantity-purchased': '10' })]);
  P1.order = (await amzOrder(80)).id;
  P1.dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  return 'SKU with 50 in stock; order for 10 resolved to it';
});
await step('split shipments: an order sent in two parcels deducts its quantity once, split as packed', async () => {
  const a = (await createShipment({ ...ezShip(80, 'AWB-SPLIT-A'), courier_partner_id: P1.dl.id }, { actor: ACTOR, addToExisting: true })).shipmentId;
  const b = (await createShipment({ ...ezShip(80, 'AWB-SPLIT-B'), courier_partner_id: P1.dl.id }, { actor: ACTOR, addToExisting: true })).shipmentId;
  let st = await shipmentStock(a);
  if (!st.split || st.lines[0].required !== 10 || st.lines[0].ordered !== 10) throw new Error(JSON.stringify({ split: st.split, l: st.lines[0] }));
  // More than the order holds is refused; nothing at all is refused.
  await expectErr('over-reserve', () => reserveShipmentStock(a, [{ batch_id: P1.batch, quantity: 11 }], { actor: ACTOR }), (e) => e.status === 400);
  // Parcel A carries 6: parcel B now has only 4 left, and cannot take more.
  await reserveShipmentStock(a, [{ batch_id: P1.batch, quantity: 6 }], { actor: ACTOR });
  st = await shipmentStock(b);
  if (st.lines[0].required !== 4 || st.state !== 'needs_reservation') throw new Error(JSON.stringify({ req: st.lines[0].required, state: st.state }));
  await expectErr('B over remainder', () => reserveShipmentStock(b, [{ batch_id: P1.batch, quantity: 5 }], { actor: ACTOR }), (e) => e.status === 400 && /only 4 left/.test(e.message));
  await reserveShipmentStock(b, [{ batch_id: P1.batch, quantity: 4 }], { actor: ACTOR });
  await addPhoto(P1.order);
  await dispatchShip(P1.order, a);
  await dispatchShip(P1.order, b);
  // Repeat dispatch of both, and a direct retry: nothing more leaves.
  await dispatchShip(P1.order, a);
  await dispatchShip(P1.order, b);
  const c = await getPool().connect();
  try { await c.query('BEGIN'); const again = await dispatchShipmentStock(c, b, { actor: ACTOR }); await c.query('COMMIT'); if (!again.repeated) throw new Error('not idempotent'); } finally { c.release(); }
  const total = await dispatchedFor(a) + await dispatchedFor(b);
  if (await dispatchedFor(a) !== 6 || await dispatchedFor(b) !== 4 || total !== 10) throw new Error(`deducted ${await dispatchedFor(a)} + ${await dispatchedFor(b)}`);
  if ((await stockOf(P1.sku)).on !== 40) throw new Error(JSON.stringify(await stockOf(P1.sku)));
  // A third parcel has nothing left to carry.
  const third = (await createShipment({ ...ezShip(80, 'AWB-SPLIT-C'), courier_partner_id: P1.dl.id }, { actor: ACTOR, addToExisting: true })).shipmentId;
  if ((await shipmentStock(third)).state !== 'no_items') throw new Error('third parcel still needs stock');
  P1.splitShips = [a, b, third];
  return 'qty 10 in two parcels: reserve 6 + 4 (11, and 5 on the second, refused); dispatch twice each + direct retry → exactly 10 deducted (was 20); third parcel needs nothing';
});
await step('split shipments: a single-shipment order must still reserve its full quantity', async () => {
  await invOrders([amzRow({ 'order-id': AZ(81), 'order-item-id': 'I81', sku: `${TS}-SPLIT`, 'quantity-purchased': '3' })]);
  const o = (await amzOrder(81)).id;
  const s1 = (await createShipmentForOrders([o], { courier_partner_id: P1.dl.id, tracking_id: 'AWB-ONE-81' }, { actor: ACTOR })).shipmentId;
  const st = await shipmentStock(s1);
  if (st.split || st.lines[0].required !== 3) throw new Error(JSON.stringify(st));
  await expectErr('partial on a single shipment', () => reserveShipmentStock(s1, [{ batch_id: P1.batch, quantity: 2 }], { actor: ACTOR }), (e) => e.status === 400 && /needs 3; 2 chosen/.test(e.message));
  await releaseShipmentStock(s1, { actor: ACTOR });
  P1.single = { o, s1 };
  return 'not a split; 2 of 3 refused as before';
});
await step('split shipments: a split order\'s parcel cannot be shared, nor a shared order split', async () => {
  // Order 80 is split: another order with items cannot join one of its parcels.
  await invOrders([amzRow({ 'order-id': AZ(82), 'order-item-id': 'I82', sku: `${TS}-SPLIT`, 'quantity-purchased': '1' })]);
  const o82 = (await amzOrder(82)).id;
  await expectErr('join a split parcel', () => attachToShipment(P1.splitShips[2], { orderIds: [o82] }, { actor: ACTOR }), (e) => e.splitShipment || e.alreadyShipped);
  // An order with items in a shared parcel cannot get a second shipment of its own.
  await invOrders([amzRow({ 'order-id': AZ(83), 'order-item-id': 'I83', sku: `${TS}-SPLIT`, 'quantity-purchased': '1' })]);
  const o83 = (await amzOrder(83)).id;
  await createShipmentForOrders([o82, o83], { courier_partner_id: P1.dl.id, tracking_id: 'AWB-SHARED-8283' }, { actor: ACTOR });
  await expectErr('split a shared order', () => createShipment({ ...ezShip(83, 'AWB-SPLIT-83'), courier_partner_id: P1.dl.id }, { actor: ACTOR, addToExisting: true }), (e) => e.splitShipment);
  return 'both refused (409)';
});
await step('cancellation: cancelling an order releases its reserved stock in the same step', async () => {
  await invOrders([amzRow({ 'order-id': AZ(84), 'order-item-id': 'I84', sku: `${TS}-SPLIT`, 'quantity-purchased': '5' })]);
  const o = (await amzOrder(84)).id;
  const sid = (await createShipmentForOrders([o], { courier_partner_id: P1.dl.id, tracking_id: 'AWB-CANCEL-84' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: P1.batch, quantity: 5 }], { actor: ACTOR });
  const before = await stockOf(P1.sku);
  const ord = await getOrder(o);
  await updateOrder(o, { order_status: 'cancelled' }, { actor: ACTOR, version: ord.version });
  const after = await stockOf(P1.sku);
  if (after.res !== before.res - 5 || after.av !== before.av + 5 || after.on !== before.on) throw new Error(JSON.stringify({ before, after }));
  const active = (await getPool().query(`SELECT count(*)::int n FROM inventory_reservations WHERE shipment_id = $1 AND status = 'active'`, [sid])).rows[0].n;
  if (active) throw new Error('reservation still active');
  if (!(await orderEvents(o)).some((e) => e.event_type === 'stock_released' && e.metadata.reason === 'order cancelled')) throw new Error('not logged');
  if ((await shipmentStock(sid)).state !== 'no_items') throw new Error('shipment still shows stock');
  // Nothing left reserved, so the empty parcel can still move without touching stock.
  await addPhoto(o);
  await dispatchShip(o, sid);
  if (await dispatchedFor(sid) !== 0 || (await stockOf(P1.sku)).on !== before.on) throw new Error('stock moved for a cancelled order');
  return `5 reserved → released on cancel (reserved ${before.res}→${after.res}, available ${before.av}→${after.av}); event logged; nothing deducted afterwards`;
});
await step('cancellation: one cancelled order in a shared parcel releases the parcel for re-confirmation', async () => {
  await invOrders([
    amzRow({ 'order-id': AZ(85), 'order-item-id': 'I85', sku: `${TS}-SPLIT`, 'quantity-purchased': '2' }),
    amzRow({ 'order-id': AZ(86), 'order-item-id': 'I86', sku: `${TS}-SPLIT`, 'quantity-purchased': '3' }),
  ]);
  const o85 = (await amzOrder(85)).id; const o86 = (await amzOrder(86)).id;
  const sid = (await createShipmentForOrders([o85, o86], { courier_partner_id: P1.dl.id, tracking_id: 'AWB-SHARED-8586' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: P1.batch, quantity: 5 }], { actor: ACTOR });
  const ord = await getOrder(o86);
  await updateOrder(o86, { order_status: 'cancelled' }, { actor: ACTOR, version: ord.version });
  const st = await shipmentStock(sid);
  if (st.lines[0].required !== 2 || st.lines[0].reserved_quantity !== 0 || st.state !== 'needs_reservation') throw new Error(JSON.stringify({ l: st.lines[0], state: st.state }));
  await reserveShipmentStock(sid, [{ batch_id: P1.batch, quantity: 2 }], { actor: ACTOR });
  await releaseShipmentStock(sid, { actor: ACTOR });
  return 'cancelled member: all 5 released; parcel now needs 2 and re-reserves cleanly';
});
await step('cancellation: dispatch refuses to leave stock reserved behind a parcel nobody needs', async () => {
  // Simulates a reservation stranded before this fix (e.g. legacy data): dispatch must not keep it silently.
  await invOrders([amzRow({ 'order-id': AZ(87), 'order-item-id': 'I87', sku: `${TS}-SPLIT`, 'quantity-purchased': '1' })]);
  const o = (await amzOrder(87)).id;
  const sid = (await createShipmentForOrders([o], { courier_partner_id: P1.dl.id, tracking_id: 'AWB-STRAND-87' }, { actor: ACTOR })).shipmentId;
  await reserveShipmentStock(sid, [{ batch_id: P1.batch, quantity: 1 }], { actor: ACTOR });
  await getPool().query(`UPDATE orders SET order_status = 'cancelled' WHERE id = $1`, [o]);   // the old path: no release
  if ((await shipmentStock(sid)).state !== 'stranded') throw new Error('stranded reservation not reported');
  await addPhoto(o);
  await expectErr('dispatch with stranded stock', () => dispatchShip(o, sid), (e) => e.needsStock);
  await releaseShipmentStock(sid, { actor: ACTOR });
  await dispatchShip(o, sid);
  return 'shown as "stranded" with Release; dispatch refused until released, then fine';
});
await step('re-import: a dispatched order\'s lines are never rewritten; an undispatched one still updates', async () => {
  // Order 81 (3 units) dispatched; order 82 not dispatched.
  const { o, s1 } = P1.single;
  await reserveShipmentStock(s1, [{ batch_id: P1.batch, quantity: 3 }], { actor: ACTOR });
  await addPhoto(o);
  await dispatchShip(o, s1);
  const onBefore = (await stockOf(P1.sku)).on;
  const file = [
    amzRow({ 'order-id': AZ(81), 'order-item-id': 'I81', sku: `${TS}-SPLIT`, 'quantity-purchased': '7' }),      // changed qty
    amzRow({ 'order-id': AZ(81), 'order-item-id': 'I81b', sku: `${TS}-SPLIT`, 'quantity-purchased': '2' }),     // new line
  ];
  const p = await previewAmazonImport(amzCsv(file), 'reimport.csv');
  if (p.summary.lockedOrders !== 1 || p.summary.lockedLineItems !== 2 || p.summary.newLineItems || p.summary.changedLineItems) throw new Error(JSON.stringify(p.summary));
  const r = await invOrders(file);
  if (r.summary.lineItemsAdded || r.summary.lineItemsUpdated || r.summary.lockedLineItems !== 2) throw new Error(JSON.stringify(r.summary));
  const lines = (await getPool().query('SELECT source_line_item_id, quantity, sku_id FROM order_items WHERE order_id = $1 ORDER BY id', [o])).rows;
  if (lines.length !== 1 || lines[0].quantity !== 3 || lines[0].sku_id !== P1.sku) throw new Error(JSON.stringify(lines));
  if (await dispatchedFor(s1) !== 3 || (await stockOf(P1.sku)).on !== onBefore) throw new Error('ledger changed');
  if (!(await orderEvents(o)).some((e) => e.event_type === 'amazon_import_lines_locked' && e.metadata.lines === 2)) throw new Error('not logged');
  // The same file again: still nothing written, nothing deducted.
  await invOrders(file);
  if ((await getPool().query('SELECT count(*)::int n FROM order_items WHERE order_id = $1', [o])).rows[0].n !== 1) throw new Error('second import wrote');
  // An order that has not left still takes the new quantity.
  await invOrders([amzRow({ 'order-id': AZ(82), 'order-item-id': 'I82', sku: `${TS}-SPLIT`, 'quantity-purchased': '4' })]);
  const q82 = (await getPool().query('SELECT quantity FROM order_items WHERE order_id = (SELECT id FROM orders WHERE source_order_id = $1)', [AZ(82)])).rows[0].quantity;
  if (q82 !== 4) throw new Error(`undispatched order not updated: ${q82}`);
  return 'dispatched order: qty 3→7 and a new line both refused (preview + commit report 2 locked), lines and ledger unchanged, event logged, repeat import idem; undispatched order 1→4 applied';
});

await step('inventory: every change is attributed (user, time, reason, reference)', async () => {
  const { rows } = await getPool().query(
    `SELECT count(*) FILTER (WHERE actor IS NULL OR reason IS NULL OR at IS NULL)::int AS missing, count(*)::int AS n
     FROM inventory_movements WHERE sku_id IN (SELECT id FROM skus WHERE sku LIKE $1)`, [`${TS}%`]);
  if (rows[0].missing || rows[0].n < 10) throw new Error(JSON.stringify(rows[0]));
  const audit = (await getPool().query(`SELECT DISTINCT action FROM inventory_audit WHERE sku_id IN (SELECT id FROM skus WHERE sku LIKE $1) OR actor = $2`, [`${TS}%`, ACTOR])).rows.map((r) => r.action);
  for (const a of ['sku_created', 'sku_updated', 'batch_created', 'batch_status_changed', 'batch_document_uploaded', 'stock_reserved', 'stock_released', 'stock_dispatched']) {
    if (!audit.includes(a)) throw new Error(`no ${a}`);
  }
  return `${rows[0].n} movements all with user, time and reason; SKU, batch, document and reservation actions audited`;
});
await step('inventory: manual orders (no items) still dispatch exactly as before', async () => {
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const r = await createShipment({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-INV-MANUAL`, courier_partner_id: dl.id, tracking_id: 'AWB-INV-MAN' }, { actor: ACTOR });
  await addPhoto(r.orderId);
  const sh = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const back = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, back.id, { shipment_status: 'packed' }, { actor: ACTOR, version: back.version });
  if ((await getPool().query('SELECT count(*)::int n FROM inventory_movements WHERE shipment_id = $1', [sh.id])).rows[0].n) throw new Error('stock moved');
  return 'no items → no stock check, no movement; can still be moved back (no stock left)';
});
await step('inventory: an order with items cannot join a parcel that already left', async () => {
  await invOrders([amzRow({ 'order-id': AZ(50), 'order-item-id': 'I50', sku: `${TS}-D3-60`, 'quantity-purchased': '1' })]);
  const late = await amzOrder(50);
  await expectErr('attach', () => attachToShipment(INV.s1, { orderIds: [late.id] }, { actor: ACTOR }), (e) => e.alreadyShipped);
  return 'attach to a dispatched shipment refused for an order with items';
});

await step('new shipment cleanup', async () => {
  const { orders, paths } = await purgeTestOrders(TEST_ORDER);
  for (const p of paths) await storage().remove(p).catch(() => {});
  await getPool().query(`DELETE FROM dispatch_destinations WHERE name LIKE 'DBCHECK%'`);
  const left = await getPool().query('SELECT count(*)::int AS n FROM orders WHERE source_order_id LIKE $1', [`${TEST_ORDER}%`]);
  if (left.rows[0].n) throw new Error('orders left behind');
  return `${orders} orders removed`;
});
await step('inventory cleanup', async () => {
  const { skus, paths } = await purgeTestInventory(TS);
  for (const p of paths) await storage().remove(p).catch(() => {});
  const left = (await getPool().query('SELECT count(*)::int n FROM skus WHERE sku LIKE $1', [`${TS}%`])).rows[0].n;
  if (left) throw new Error('SKUs left behind');
  return `${skus} test SKUs and their batches, ledger, reservations and documents removed`;
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

// ---- RBAC: module roles -------------------------------------------------------
const RB = {
  log: '919000000201', call: '919000000202', multi: '919000000203', none: '919000000204',
  lview: '919000000205', invOnly: '919000000206', adm: '919000000207', env: '919000000208',
  legacyNull: '919000000209', legacyAdmin: '919000000210',
};
const RB_PHONES = Object.values(RB);
const rbClean = async () => {
  await getPool().query('DELETE FROM member_log WHERE target_phone = ANY($1)', [RB_PHONES]);
  await getPool().query('DELETE FROM allowed_users WHERE phone = ANY($1)', [RB_PHONES]);
};
// The access rules before module roles, verbatim, for the parity check.
const OLD = {
  orders: (role) => role === 'admin' || role === 'logistics',          // orders, couriers, destinations, inventory reads, reserve/release
  recovery: (role) => role === 'admin' || role === 'caller',
  adminOnly: (role) => role === 'admin',                                // inventory writes, couriers/destinations writes, members, dashboard
};
// Briyo OS profile gate: fixture members get a complete profile (name, email, photo key)
// before a real server is started, so access tests test access, not the profile step.
const completeTestProfiles = () => getPool().query(`UPDATE allowed_users SET email = coalesce(email, phone || '@example.test'),
  photo_key = coalesce(photo_key, 'test/db-check-photo.jpg'), photo_mime = coalesce(photo_mime, 'image/jpeg')
  WHERE added_by = 'db-check' AND phone NOT IN ('919000000306', '919000000307')`);

await step('rbac: capability matrix — every module role grants exactly its capabilities', async () => {
  const caps = (roles, admin = false) => capabilitiesOf({ allowed: true, admin, roles });
  const want = {
    'logistics:viewer': ['logistics.view'], 'logistics:operator': ['logistics.view', 'logistics.edit'],
    'logistics:manager': ['logistics.view', 'logistics.edit', 'logistics.setup'],
    'inventory:viewer': ['inventory.view'], 'inventory:operator': ['inventory.view', 'inventory.move'],
    'inventory:manager': ['inventory.view', 'inventory.move', 'inventory.catalog'],
    'support:agent': ['support.work'], 'support:lead': ['support.work'],
  };
  for (const [k, v] of Object.entries(want)) {
    const [m, r] = k.split(':');
    if (caps({ [m]: r }).join() !== v.join()) throw new Error(`${k}: ${caps({ [m]: r })}`);
  }
  if (caps({}, true).join() !== CAPABILITIES.join()) throw new Error('admin is not all');
  if (capabilitiesOf({ allowed: false, admin: true, roles: {} }).length) throw new Error('disallowed member has capabilities');
  if (caps({ bogus: 'manager' }).length || caps({ logistics: 'agent' }).length) throw new Error('unknown module/role granted something');
  return '8 module roles + admin + unknown/disallowed';
});
await step('rbac: migrated access equals the old role rules — nothing expanded, nothing lost', async () => {
  // What the backfill gives each old role, and what each old rule maps to.
  const migrated = { logistics: { logistics: 'operator', inventory: 'viewer' }, caller: { support: 'agent' } };
  for (const role of ['admin', 'logistics', 'caller']) {
    const access = { allowed: true, admin: role === 'admin', roles: migrated[role] || {} };
    const c = capabilitiesOf(access);
    const has = (x) => c.includes(x);
    const now = {
      orders: has('logistics.view') && has('logistics.edit') && has('inventory.view'),
      recovery: has('support.work'),
      adminOnly: has('logistics.setup') && has('inventory.move') && has('inventory.catalog'),
    };
    for (const k of Object.keys(OLD)) if (OLD[k](role) !== now[k]) throw new Error(`${role}: ${k} was ${OLD[k](role)}, now ${now[k]}`);
    // No capability beyond what the old role reached.
    const allowed = new Set([...(OLD.orders(role) ? ['logistics.view', 'logistics.edit', 'inventory.view'] : []),
      ...(OLD.recovery(role) ? ['support.work'] : []), ...(OLD.adminOnly(role) ? CAPABILITIES : [])]);
    const extra = c.filter((x) => !allowed.has(x));
    if (extra.length) throw new Error(`${role} gained ${extra}`);
    if (legacyRole(access) !== role) throw new Error(`legacy role ${legacyRole(access)} ≠ ${role}`);
  }
  return 'admin = all; logistics = orders+edit+inventory read (no setup, no stock moves, no catalog); caller = call board only';
});
await step('rbac: migration maps every old role once and is idempotent', async () => {
  await rbClean();
  for (const [phone, role, admin] of [[RB.log, 'logistics', false], [RB.call, 'caller', false], [RB.legacyNull, null, false], [RB.legacyAdmin, null, true]]) {
    await getPool().query(`INSERT INTO allowed_users (phone, name, is_admin, role, added_by) VALUES ($1, 'RBAC test', $2, $3, 'db-check')`, [phone, admin, role]);
  }
  const marker = await getPool().query(`SELECT value FROM system_state WHERE key = 'rbac_module_roles_backfill_v1'`);
  if (!marker.rows.length) throw new Error('backfill did not run at boot');
  // Re-run as on a fresh database: the marker is the only thing gating it.
  await getPool().query(`DELETE FROM system_state WHERE key = 'rbac_module_roles_backfill_v1'`);
  const first = await backfillModuleRoles();
  const got = async (p) => JSON.stringify(Object.entries(await moduleRolesOf(p)).sort());
  if (await got(RB.log) !== JSON.stringify([['inventory', 'viewer'], ['logistics', 'operator']])) throw new Error(`logistics → ${await got(RB.log)}`);
  if (await got(RB.call) !== JSON.stringify([['support', 'agent']])) throw new Error(`caller → ${await got(RB.call)}`);
  if (await got(RB.legacyNull) !== JSON.stringify([['support', 'agent']])) throw new Error(`NULL → ${await got(RB.legacyNull)}`);
  if (await got(RB.legacyAdmin) !== JSON.stringify([['support', 'agent']])) throw new Error('admin row');
  // A role removed after migration is not re-added by another run.
  await setModuleRole(RB.log, 'inventory', null, { actor: 'db-check' });
  const second = await backfillModuleRoles();
  const third = await backfillModuleRoles();
  if (!first.ran || second.ran || third.ran || second.added || await got(RB.log) !== JSON.stringify([['logistics', 'operator']])) {
    throw new Error(JSON.stringify({ first, second, third, log: await got(RB.log) }));
  }
  return `first run added ${first.added} rows (incl. any test fixtures); reruns: no-op; a removed role stays removed`;
});
await step('rbac: one member, three modules; changing one module leaves the others', async () => {
  await getPool().query(`INSERT INTO allowed_users (phone, name, added_by) VALUES ($1, 'RBAC multi', 'db-check') ON CONFLICT (phone) DO NOTHING`, [RB.multi]);
  await setModuleRole(RB.multi, 'logistics', 'operator', { actor: 'db-check' });
  await setModuleRole(RB.multi, 'inventory', 'manager', { actor: 'db-check' });
  await setModuleRole(RB.multi, 'support', 'agent', { actor: 'db-check' });
  let a = await resolveAccess(RB.multi);
  const c = capabilitiesOf(a);
  for (const x of ['logistics.view', 'logistics.edit', 'inventory.view', 'inventory.move', 'inventory.catalog', 'support.work']) if (!c.includes(x)) throw new Error(`missing ${x}`);
  if (c.includes('logistics.setup') || a.admin) throw new Error('too much');
  await setModuleRole(RB.multi, 'inventory', 'viewer', { actor: 'db-check' });
  a = await resolveAccess(RB.multi);
  if (a.roles.logistics !== 'operator' || a.roles.support !== 'agent' || a.roles.inventory !== 'viewer') throw new Error(JSON.stringify(a.roles));
  await setModuleRole(RB.multi, 'support', null, { actor: 'db-check' });
  a = await resolveAccess(RB.multi);
  if (a.roles.support || a.roles.logistics !== 'operator' || a.roles.inventory !== 'viewer') throw new Error(JSON.stringify(a.roles));
  if ((await getPool().query('SELECT role FROM allowed_users WHERE phone = $1', [RB.multi])).rows[0].role !== 'logistics') throw new Error('legacy column not kept for rollback');
  await expectErr('two roles in one module', () => getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1, 'logistics', 'viewer')`, [RB.multi]), (e) => e.code === '23505');
  await expectErr('role from another module', () => getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1, 'support', 'manager')`, [RB.multi]), (e) => e.code === '23514');
  // Changing a number carries the roles; removing the member removes them.
  await getPool().query('UPDATE allowed_users SET phone = $2 WHERE phone = $1', [RB.multi, '919000000299']);
  if ((await moduleRolesOf('919000000299')).logistics !== 'operator') throw new Error('roles lost on number change');
  await getPool().query('UPDATE allowed_users SET phone = $2 WHERE phone = $1', ['919000000299', RB.multi]);
  return 'L-operator + I-manager + S-agent → 6 capabilities, no setup/admin; I→viewer and S removed independently; one role per module; cascade on number change';
});
await step('rbac: a failed membership lookup denies access (fail closed)', async () => {
  const app = express();
  app.use(cookieParser());
  app.use('/auth', authRouterForTest);
  app.use(requireAuth);
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  app.get('/page', (_req, res) => res.send('page'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${SESSION_COOKIE}=${issueSession(RB.call)}`;
  try {
    _setMembershipLookup(async () => { throw new Error('simulated database failure'); });
    const api = await fetch(`${base}/api/x`, { headers: { cookie } });
    const page = await fetch(`${base}/page`, { headers: { cookie }, redirect: 'manual' });
    const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
    if (api.status !== 503 || page.status !== 503 || me.status !== 503) throw new Error(`api ${api.status} page ${page.status} me ${me.status}`);
    _setMembershipLookup(null);
    const ok = await fetch(`${base}/api/x`, { headers: { cookie } });
    if (ok.status !== 200) throw new Error(`after recovery ${ok.status}`);
  } finally { _setMembershipLookup(null); server.close(); }
  return 'lookup error → 503 on API, page and /auth/me (was: allowed as caller); next good lookup → 200';
});

// The real server, on the test database, with signed sessions for each member.
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
let rbServer = null; let RBASE = '';
await step('rbac: route matrix on the real server — granted only by capability', async () => {
  // Members, as the migration would leave them, plus new combinations.
  await getPool().query(`INSERT INTO allowed_users (phone, name, is_admin, added_by) VALUES
    ($1, 'RBAC none', false, 'db-check'), ($2, 'RBAC lview', false, 'db-check'), ($3, 'RBAC inv', false, 'db-check'),
    ($4, 'RBAC adm', true, 'db-check'), ($5, 'RBAC env', false, 'db-check') ON CONFLICT (phone) DO NOTHING`, [RB.none, RB.lview, RB.invOnly, RB.adm, RB.env]);
  await setModuleRole(RB.log, 'inventory', 'viewer', { actor: 'db-check' });   // back to the migrated logistics shape
  await setModuleRole(RB.multi, 'inventory', 'manager', { actor: 'db-check' });
  await setModuleRole(RB.multi, 'support', 'agent', { actor: 'db-check' });
  await setModuleRole(RB.lview, 'logistics', 'viewer', { actor: 'db-check' });
  await setModuleRole(RB.invOnly, 'inventory', 'manager', { actor: 'db-check' });
  const port = await freePort();
  await completeTestProfiles();
  rbServer = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), APP_ENV: 'test', ADMIN_PHONES: RB.env, ELEVENZA_AUTH_TOKEN: '', SHOPIFY_ACCESS_TOKEN: '',
      SHOPIFY_POLL_ENABLED: 'false', SHOPIFY_POLL_MINUTES: '0', SLA_ALERTS_ENABLED: 'false', DAILY_SUMMARY_ENABLED: 'false', KEEPALIVE_URL: '', RENDER_EXTERNAL_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; rbServer.stderr.on('data', (d) => { stderr += d; });
  RBASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${RBASE}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
    if (i === 99) throw new Error(`server did not start: ${stderr.slice(-400)}`);
  }
  const as = (who) => ({ cookie: `${SESSION_COOKIE}=${issueSession(RB[who])}`, 'content-type': 'application/json' });
  const call = async (who, method, path, body) => {
    const r = await fetch(`${RBASE}${path}`, { method, headers: as(who), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location') };
  };
  // [path, method, body, { who: expectation }]: a number is the exact status, 'ok' means not 401/403/5xx, '→x' a redirect to x.
  const M = [
    ['/', 'GET', null, { call: 'ok', multi: 'ok', adm: 'ok', log: '→/orders', invOnly: '→/inventory', none: '→/no-access', lview: '→/orders' }],
    ['/no-access', 'GET', null, { none: 'ok', log: '→/orders', call: '→/' }],
    ['/orders', 'GET', null, { log: 'ok', lview: 'ok', multi: 'ok', adm: 'ok', call: '→/', invOnly: '→/inventory', none: '→/no-access' }],
    ['/inventory', 'GET', null, { log: 'ok', invOnly: 'ok', multi: 'ok', call: '→/', lview: '→/orders', none: '→/no-access' }],
    ['/couriers', 'GET', null, { log: 'ok', lview: 'ok', call: '→/' }],
    ['/api/carts?days=1', 'GET', null, { call: 'ok', multi: 'ok', adm: 'ok', log: 403, lview: 403, invOnly: 403, none: 403 }],
    ['/api/carts.csv?days=1', 'GET', null, { call: 'ok', adm: 'ok', log: 403, none: 403 }],
    ['/api/status', 'POST', {}, { log: 403, none: 403, call: 'ok' }],
    ['/api/orders?limit=1', 'GET', null, { log: 'ok', lview: 'ok', multi: 'ok', adm: 'ok', call: 403, invOnly: 403, none: 403 }],
    ['/api/orders', 'POST', {}, { lview: 403, call: 403, invOnly: 403, log: 'ok', multi: 'ok', adm: 'ok' }],
    ['/api/orders/999999999', 'PATCH', {}, { lview: 403, log: 'ok' }],
    ['/api/couriers', 'GET', null, { lview: 'ok', log: 'ok', call: 403 }],
    ['/api/couriers', 'POST', {}, { log: 403, multi: 403, lview: 403, adm: 'ok' }],
    ['/api/destinations', 'POST', {}, { log: 403, adm: 'ok' }],
    ['/api/inventory', 'GET', null, { log: 'ok', invOnly: 'ok', multi: 'ok', adm: 'ok', lview: 403, call: 403, none: 403 }],
    ['/api/inventory/receive', 'POST', {}, { log: 403, lview: 403, call: 403, multi: 'ok', invOnly: 'ok', adm: 'ok' }],
    ['/api/inventory/skus', 'POST', {}, { log: 403, multi: 'ok', invOnly: 'ok', adm: 'ok' }],
    ['/api/inventory/platforms', 'POST', {}, { log: 403, multi: 'ok' }],
    ['/api/inventory/warehouses', 'POST', {}, { log: 403, invOnly: 'ok' }],
    ['/api/inventory/shipments/999999999', 'GET', null, { log: 'ok', lview: 'ok', invOnly: 'ok', call: 403 }],
    ['/api/inventory/shipments/999999999/reserve', 'POST', {}, { log: 'ok', multi: 'ok', adm: 'ok', invOnly: 403, lview: 403, call: 403 }],
    ['/api/inventory/shipments/999999999/release', 'POST', {}, { log: 'ok', invOnly: 403 }],
    ['/api/members', 'GET', null, { adm: 'ok', env: 'ok', log: 403, multi: 403, call: 403 }],
    ['/dashboard', 'GET', null, { adm: 'ok', multi: 403, log: 403 }],
    ['/api/admin/overview?days=1', 'GET', null, { adm: 'ok', multi: 403 }],
  ];
  let checks = 0; const bad = [];
  for (const [path, method, body, exp] of M) {
    for (const [who, want] of Object.entries(exp)) {
      const r = await call(who, method, path, body);
      const okish = r.status !== 401 && r.status !== 403 && r.status < 500 && !(r.status >= 300 && r.status < 400);
      const pass = typeof want === 'number' ? r.status === want
        : want === 'ok' ? okish
          : r.status === 302 && r.location === want.slice(1);
      checks += 1;
      if (!pass) bad.push(`${who} ${method} ${path}: ${r.status}${r.location ? ` → ${r.location}` : ''} (want ${want})`);
    }
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${checks} member × route checks: pages, APIs, writes; no redirect loops`;
});
await step('rbac: /auth/me tells the page what to show', async () => {
  const me = async (who) => (await fetch(`${RBASE}/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(RB[who])}` } })).json();
  const multi = await me('multi'); const none = await me('none'); const adm = await me('adm'); const log = await me('log');
  if (multi.isAdmin || multi.modules.logistics !== 'operator' || multi.modules.inventory !== 'manager' || multi.modules.support !== 'agent'
    || !multi.caps.includes('inventory.catalog') || multi.caps.includes('logistics.setup') || multi.home !== '/') throw new Error(JSON.stringify(multi));
  if (none.caps.length || none.home !== '/no-access' || none.canOrders || none.canRecovery) throw new Error(JSON.stringify(none));
  if (!adm.isAdmin || adm.caps.length !== CAPABILITIES.length) throw new Error('admin caps');
  if (log.role !== 'logistics' || !log.canOrders || log.canRecovery || log.home !== '/orders') throw new Error(JSON.stringify(log));
  if (!multi.moduleCatalog?.support?.roles?.some((r) => r.key === 'lead')) throw new Error('catalog');
  return 'modules, caps and home per member; legacy role/canOrders/canRecovery kept for old tabs';
});
await step('rbac: Members API — modules per member, legacy role, admin protections', async () => {
  const H = { cookie: `${SESSION_COOKIE}=${issueSession(RB.adm)}`, 'content-type': 'application/json' };
  const req = async (method, path, body) => { const r = await fetch(`${RBASE}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  // One module changes; the others stay.
  let r = await req('PATCH', `/api/members/${RB.multi}`, { modules: { inventory: null } });
  if (r.status !== 200 || r.body.member.modules.inventory || r.body.member.modules.logistics !== 'operator' || r.body.member.modules.support !== 'agent') throw new Error(JSON.stringify(r.body));
  r = await req('PATCH', `/api/members/${RB.multi}`, { modules: { inventory: 'manager' } });
  if (r.body.member.modules.inventory !== 'manager' || r.body.member.modules.support !== 'agent') throw new Error('add one module');
  // Invalid input refused.
  for (const bad of [{ modules: { logistics: 'agent' } }, { modules: { finance: 'viewer' } }, { modules: 'x' }, { role: 'boss' }]) {
    r = await req('PATCH', `/api/members/${RB.multi}`, bad);
    if (r.status !== 400) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
  // The old single role still means what it meant (an old admin tab).
  r = await req('PATCH', `/api/members/${RB.none}`, { role: 'logistics' });
  if (JSON.stringify(r.body.member.modules) !== JSON.stringify({ logistics: 'operator', inventory: 'viewer' })) throw new Error(JSON.stringify(r.body.member.modules));
  r = await req('PATCH', `/api/members/${RB.none}`, { role: 'caller' });
  if (JSON.stringify(r.body.member.modules) !== JSON.stringify({ support: 'agent' })) throw new Error(JSON.stringify(r.body.member.modules));
  r = await req('PATCH', `/api/members/${RB.none}`, { modules: { support: null } });
  if (Object.keys(r.body.member.modules).length) throw new Error('could not remove the last module');
  // Takes effect at once: the next request already sees it (membership cache invalidated).
  const g = await fetch(`${RBASE}/api/carts?days=1`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(RB.none)}` } });
  if (g.status !== 403) throw new Error(`cache not invalidated: ${g.status}`);
  // New members: default is the call board, as before; or exactly the modules chosen.
  await getPool().query('DELETE FROM allowed_users WHERE phone = $1', ['919000000211']);
  r = await req('POST', '/api/members', { phone: '9000000211', name: 'RBAC new' });
  if (JSON.stringify(r.body.member.modules) !== JSON.stringify({ support: 'agent' })) throw new Error(`default ${JSON.stringify(r.body.member.modules)}`);
  await getPool().query('DELETE FROM allowed_users WHERE phone = $1', ['919000000211']);
  r = await req('POST', '/api/members', { phone: '9000000211', name: 'RBAC new', modules: { logistics: 'viewer', inventory: 'operator' } });
  if (JSON.stringify(Object.entries(r.body.member.modules).sort()) !== JSON.stringify([['inventory', 'operator'], ['logistics', 'viewer']])) throw new Error(JSON.stringify(r.body.member.modules));
  await getPool().query('DELETE FROM allowed_users WHERE phone = $1', ['919000000211']);
  // ADMIN_PHONES: cannot be demoted, deactivated or removed in-app; is admin whatever the table says.
  if ((await req('PATCH', `/api/members/${RB.env}`, { isAdmin: false })).status !== 409) throw new Error('env admin demoted');
  if ((await req('PATCH', `/api/members/${RB.env}`, { active: false })).status !== 409) throw new Error('env admin deactivated');
  if ((await req('DELETE', `/api/members/${RB.env}`)).status !== 409) throw new Error('env admin removed');
  // Logged.
  const logged = (await getPool().query(`SELECT detail FROM member_log WHERE target_phone = $1 ORDER BY id`, [RB.multi])).rows.map((x) => x.detail).join(' | ');
  if (!/inventory=none/.test(logged) || !/inventory=manager/.test(logged)) throw new Error(logged);
  return 'one module removed/added without touching others; bad module/role/legacy refused; legacy role maps exactly; immediate effect; new-member default = Support agent; env admin protected; changes logged';
});
await step('rbac: the last admin cannot be demoted, deactivated or removed', async () => {
  // Make RB.adm the only admin in the table (test database only), then try. The
  // env admin making the request is admin through ADMIN_PHONES, not the table.
  const { rows: others } = await getPool().query('SELECT phone FROM allowed_users WHERE active AND is_admin AND phone <> $1', [RB.adm]);
  const H = { cookie: `${SESSION_COOKIE}=${issueSession(RB.env)}`, 'content-type': 'application/json' };
  const send = (method, body) => fetch(`${RBASE}/api/members/${RB.adm}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  try {
    await getPool().query('UPDATE allowed_users SET is_admin = false WHERE phone = ANY($1)', [others.map((o) => o.phone)]);
    for (const [m, body] of [['PATCH', { isAdmin: false }], ['PATCH', { active: false }], ['DELETE', null]]) {
      const r = await send(m, body);
      if (r.status !== 409) throw new Error(`${m} ${JSON.stringify(body)} → ${r.status}`);
    }
    // Module changes are not admin changes and stay allowed.
    if ((await send('PATCH', { modules: { support: 'lead' } })).status !== 200) throw new Error('module change refused');
  } finally {
    await getPool().query('UPDATE allowed_users SET is_admin = true WHERE phone = ANY($1)', [others.map((o) => o.phone)]);
  }
  const still = (await getPool().query('SELECT is_admin, active FROM allowed_users WHERE phone = $1', [RB.adm])).rows[0];
  if (!still.is_admin || !still.active) throw new Error('last admin changed');
  return `sole table admin: demote / deactivate / remove all 409 (${others.length} other admin(s) restored after)`;
});
await step('rbac cleanup', async () => {
  if (rbServer) { rbServer.kill(); await new Promise((r) => rbServer.once('exit', r)); }
  await rbClean();
  await getPool().query('DELETE FROM allowed_users WHERE phone = ANY($1)', [['919000000211', '919000000299']]);
  const left = (await getPool().query('SELECT count(*)::int n FROM member_module_roles WHERE phone = ANY($1)', [RB_PHONES])).rows[0].n;
  if (left) throw new Error('module roles left behind');
  return 'server stopped; test members and their module roles removed';
});

// ---- HR / recruitment ----------------------------------------------------------
const HRT = 'DBCHECK-HR';
const HRM = { mgr: '919000000301', multi: '919000000302', nonHr: '919000000303', adm: '919000000304', inc: '919000000306', old: '919000000307' };
const HRS = {};   // server, base, stub, dir, ids
const hrPhones = Object.values(HRM);
const hrCleanMembers = async () => {
  await getPool().query('DELETE FROM member_log WHERE target_phone = ANY($1)', [hrPhones]);
  await getPool().query('DELETE FROM allowed_users WHERE phone = ANY($1)', [hrPhones]);
};
const pdf = (n = 2000) => { const b = Buffer.alloc(n, 0x20); Buffer.from('%PDF-1.7\n').copy(b); return b; };
const docx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 0), Buffer.from('word/document.xml'), Buffer.alloc(200, 0)]);
let ipSeq = 10;
const nextIp = () => `198.51.100.${(ipSeq += 1) % 250}`;
const internal = async (who, method, path, body) => {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.cookie = `${SESSION_COOKIE}=${issueSession(HRM[who])}`;
  const r = await fetch(`${HRS.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
};
// fetch() drops a custom Host header, so the careers host is reached with http.request.
const careers = (method, p, { body, raw, headers = {}, ip = nextIp(), cookieAs } = {}) => new Promise((resolve, reject) => {
  const h = { host: 'careers.test', 'x-forwarded-for': ip, ...headers };
  if (body) h['content-type'] = 'application/json';
  if (cookieAs) h.cookie = `${SESSION_COOKIE}=${issueSession(HRM[cookieAs])}`;
  const payload = raw ?? (body ? JSON.stringify(body) : undefined);
  const u = new URL(HRS.base);
  const req = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers: h }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const hdrs = new Headers(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
      let parsed = text;
      if ((res.headers['content-type'] || '').includes('json')) { try { parsed = JSON.parse(text); } catch { /* keep text */ } }
      resolve({ status: res.statusCode, headers: hdrs, body: parsed });
    });
  });
  req.on('error', reject);
  if (payload !== undefined) req.write(payload);
  req.end();
});
const goodApplication = (pid, over = {}) => ({
  full_name: 'Test Candidate', email: 'dbcheck-hr-cand@example.test', phone: '+44 20 7946 0958', location: 'Pune',
  linkedin_url: 'linkedin.com/in/test', relevant_experience: '3 years', notice_period: '30 days', work_authorization: 'Indian citizen',
  consent: true, turnstile_token: 'pass', form_token: issueFormToken(pid, Date.now() - 5000), ...over,
});
const apply = (pid, over, opts) => careers('POST', `/jobs/${pid}/apply`, { body: goodApplication(pid, over), ...opts });
const upload = (pid, token, buf, name = 'cv.pdf', opts = {}) => careers('POST', `/jobs/${pid}/apply/resume`, {
  raw: buf, headers: { 'x-filename': encodeURIComponent(name), 'x-upload-token': token || '', 'content-type': 'application/octet-stream' }, ...opts });

await step('hr: schema is additive and idempotent; HR role pair accepted, nothing granted', async () => {
  await ensureHrSchema(); await ensureHrSchema();
  const before = (await getPool().query('SELECT count(*)::int n FROM member_module_roles')).rows[0].n;
  await hrCleanMembers();
  await getPool().query(`INSERT INTO allowed_users (phone, name, is_admin, added_by) VALUES ($1,'HR mgr',false,'db-check'),($2,'HR multi',false,'db-check'),($3,'Not HR',false,'db-check'),($4,'HR admin',true,'db-check')`, hrPhones.slice(0, 4));
  await setModuleRole(HRM.mgr, 'hr', 'manager', { actor: 'db-check' });
  for (const [m, r] of [['logistics', 'operator'], ['inventory', 'viewer'], ['hr', 'manager']]) await setModuleRole(HRM.multi, m, r, { actor: 'db-check' });
  await setModuleRole(HRM.nonHr, 'support', 'agent', { actor: 'db-check' });
  await expectErr('hr viewer is not a role', () => getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1, 'hr', 'viewer')`, [HRM.nonHr]), (e) => e.code === '23514');
  const after = (await getPool().query('SELECT count(*)::int n FROM member_module_roles WHERE phone <> ALL($1)', [hrPhones])).rows[0].n;
  if (after !== before) throw new Error('other assignments changed');
  const auto = (await getPool().query(`SELECT count(*)::int n FROM member_module_roles WHERE module = 'hr' AND phone <> ALL($1)`, [hrPhones])).rows[0].n;
  if (auto) throw new Error('HR granted automatically');
  const caps = capabilitiesOf({ allowed: true, admin: false, roles: { hr: 'manager' } });
  if (caps.join() !== 'hr.view,hr.manage' || homeFor(caps) !== '/hr/jobs') throw new Error(caps.join());
  if (normalizePhone('98765 43210') !== '+919876543210' || normalizePhone('+1 (415) 555-0100') !== '+14155550100' || normalizePhone('0044 20 7946 0958') !== '+442079460958') throw new Error('phone');
  await expectErr('phone without code', () => normalizePhone('2079460958'), (e) => e.field === 'phone');
  if (slugify('Performance Marketing Manager!') !== 'performance-marketing-manager') throw new Error('slug');
  return 'tables idempotent; (hr, manager) allowed, (hr, viewer) refused; no automatic grants; E.164 + slug helpers';
});

await step('hr: server with careers host, Turnstile stub and throwaway storage', async () => {
  HRS.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hr-docs-'));
  HRS.stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const ok = new URLSearchParams(b).get('response') === 'pass';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: ok }));
  }); }).listen(0);
  // A local Meta Graph stub: records what the server sends, answers like Meta (incl. pagination).
  HRS.meta = { mode: 'ok', calls: [] };
  HRS.metaStub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    HRS.meta.calls.push({ path: u.pathname, url: req.url, auth: req.headers.authorization, proof: u.searchParams.get('appsecret_proof') });
    res.setHeader('content-type', 'application/json');
    if (HRS.meta.mode === 'token') { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Error validating access token: secret detail', type: 'OAuthException', code: 190, fbtrace_id: 'TRACE1' } })); }
    const p = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const row = (spend, imp, clk, pur, val, extra = {}) => ({ spend: String(spend), impressions: String(imp), reach: String(Math.round(imp * 0.7)), clicks: String(clk),
      actions: [{ action_type: 'omni_purchase', value: String(pur) }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(pur) }],
      action_values: [{ action_type: 'omni_purchase', value: String(val) }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(val) }], ...extra });
    if (p === 'act_1234567890') return res.end(JSON.stringify({ name: 'Briyo Test Ads', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1, id: 'act_1234567890' }));
    if (p === 'act_1234567890/insights') {
      if (u.searchParams.get('time_increment')) return res.end(JSON.stringify({ data: [{ ...row(400, 8000, 160, 4, 1400), date_start: '2026-10-01', date_stop: '2026-10-01' }, { ...row(600.5, 12000, 240, 6, 2101.75), date_start: '2026-10-02', date_stop: '2026-10-02' }] }));
      if (u.searchParams.get('level') === 'campaign') return res.end(JSON.stringify({ data: [row(900.5, 18000, 360, 10, 3501.75, { campaign_id: '111', campaign_name: 'Prospecting' }), row(100, 2000, 40, 0, 0, { campaign_id: '999', campaign_name: 'Old Archived', actions: undefined, action_values: undefined })] }));
      return res.end(JSON.stringify({ data: [row(1000.5, 20000, 400, 10, 3501.75)] }));
    }
    if (p === 'act_1234567890/campaigns') {
      if (!u.searchParams.get('after')) return res.end(JSON.stringify({ data: [{ id: '111', name: 'Prospecting', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_SALES' }], paging: { cursors: { after: 'C2' }, next: 'https://graph.facebook.com/next?access_token=SHOULD-NOT-BE-FOLLOWED' } }));
      return res.end(JSON.stringify({ data: [{ id: '222', name: 'Retargeting', status: 'PAUSED', effective_status: 'PAUSED', objective: 'OUTCOME_SALES' }], paging: { cursors: { after: 'C3' } } }));
    }
    res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'Unknown path', code: 100 } }));
  }).listen(0);
  const port = await freePort();
  await completeTestProfiles();
  HRS.server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), APP_ENV: 'test', ADMIN_PHONES: '', ELEVENZA_AUTH_TOKEN: '', SHOPIFY_ACCESS_TOKEN: '',
      SHOPIFY_POLL_ENABLED: 'false', SHOPIFY_POLL_MINUTES: '0', SLA_ALERTS_ENABLED: 'false', DAILY_SUMMARY_ENABLED: 'false', KEEPALIVE_URL: '', RENDER_EXTERNAL_URL: '',
      CAREERS_HOST: 'careers.test', CAREERS_BASE_URL: 'https://careers.test', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_SITE_KEY: 'test-site',
      TURNSTILE_VERIFY_URL: `http://127.0.0.1:${HRS.stub.address().port}/verify`, DOCUMENT_STORAGE: 'local', DOCUMENT_STORAGE_DIR: HRS.dir, HR_IP_HASH_SALT: 'db-check',
      META_ACCESS_TOKEN: 'test-meta-token-NEVER-LEAK-9f3a', META_AD_ACCOUNT_ID: '1234567890', META_APP_SECRET: 'test-meta-app-secret', META_API_VERSION: 'v25.0',
      MARKETING_ROAS_TARGET: '2.5', META_GRAPH_BASE: `http://127.0.0.1:${HRS.metaStub.address().port}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; HRS.log = ''; HRS.server.stderr.on('data', (d) => { stderr += d; HRS.log += d; });
  HRS.base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${HRS.base}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
    if (i === 99) throw new Error(`server did not start: ${stderr.slice(-400)}`);
  }
  return `listening; careers host = careers.test`;
});

await step('hr: RBAC — HR manager, admin and multi-module reach HR; others refused; no accidental access', async () => {
  const M = [
    ['GET', '/api/hr/jobs', null, { mgr: 200, multi: 200, adm: 200, nonHr: 403, '': 401 }],
    ['GET', '/api/hr/applications', null, { mgr: 200, adm: 200, nonHr: 403, '': 401 }],
    ['POST', '/api/hr/jobs', { title: `${HRT} rbac probe` }, { nonHr: 403, '': 401, mgr: 201 }],
    ['GET', '/api/orders?limit=1', null, { mgr: 403, multi: 200 }],
    ['GET', '/api/inventory', null, { mgr: 403, multi: 200 }],
    ['POST', '/api/inventory/receive', {}, { multi: 403 }],
    ['GET', '/api/carts?days=1', null, { mgr: 403, multi: 403, nonHr: 200 }],
    ['GET', '/api/members', null, { mgr: 403, adm: 200 }],
  ];
  const bad = [];
  for (const [m, p, b, exp] of M) for (const [who, want] of Object.entries(exp)) {
    const r = await internal(who || null, m, p, b);
    if (r.status !== want) bad.push(`${who || 'anon'} ${m} ${p}: ${r.status} ≠ ${want}`);
  }
  const page = await internal('mgr', 'GET', '/');
  if (page.status !== 302 || page.headers.get('location') !== '/hr/jobs') bad.push(`HR-only home: ${page.status} ${page.headers.get('location')}`);
  // HR pages: HR managers and admins only; everyone else is sent to their own home.
  for (const [who, p, want, loc] of [['mgr', '/hr/jobs', 200], ['mgr', '/hr/candidates', 200], ['adm', '/hr/candidates', 200], ['multi', '/hr/jobs', 200],
    ['mgr', '/hr', 302, '/hr/jobs'], ['nonHr', '/hr/jobs', 302, '/'], ['nonHr', '/hr/candidates', 302, '/'], ['', '/hr/jobs', 302, '/login'],
    ['mgr', '/orders', 302, '/hr/jobs'], ['mgr', '/inventory', 302, '/hr/jobs'], ['mgr', '/admin', 403]]) {
    const r = await internal(who || null, 'GET', p);
    if (r.status !== want || (loc && r.headers.get('location') !== loc)) bad.push(`${who || 'anon'} page ${p}: ${r.status} ${r.headers.get('location') || ''}`);
    if (want === 200 && !/hr\.js/.test(r.body)) bad.push(`${who} ${p}: not the HR page`);
  }
  const meta = (await internal('mgr', 'GET', '/api/hr/meta')).body;
  if (!meta.canManage || !meta.timezone || meta.applicationStatuses.length !== 7) bad.push('meta');
  if (bad.length) throw new Error(bad.join(' | '));
  return `${M.reduce((n, x) => n + Object.keys(x[3]).length, 0) + 1} API checks + 11 HR page checks + meta`;
});

await step('hr: job lifecycle — draft, edit (version), publish, slug, close, reopen, archive, restore', async () => {
  let r = await internal('mgr', 'POST', '/api/hr/jobs', { title: `${HRT} Performance Marketing Manager`, department: 'Marketing' });
  if (r.status !== 201 || r.body.job.status !== 'draft' || r.body.job.slug !== null || r.body.job.public_url !== null) throw new Error(JSON.stringify(r.body));
  let job = r.body.job; HRS.job = job;
  const feed0 = await careers('GET', '/jobs');
  if (feed0.body.jobs.some((j) => j.public_id === job.public_id)) throw new Error('draft in feed');
  if ((await careers('GET', `/jobs/${job.public_id}`)).status !== 404) throw new Error('draft public');
  r = await internal('mgr', 'POST', `/api/hr/jobs/${job.id}/publish`, { version: job.version });
  if (r.status !== 400 || !/employment type/.test(r.body.error)) throw new Error(`incomplete publish: ${r.status} ${r.body.error}`);
  r = await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: job.version, employment_type: 'full_time', work_mode: 'hybrid', location: 'Mumbai',
    summary: 'Own our paid growth.', experience_min: 3, experience_max: 6, salary_min: 1200000, salary_max: 1800000, salary_period: 'year',
    sections: { about: 'You will run paid media.', responsibilities: '- Plan\n- Ship', bogus: 'dropped' } });
  if (r.status !== 200 || r.body.job.sections.bogus || r.body.job.sections.responsibilities !== '- Plan\n- Ship') throw new Error(JSON.stringify(r.body));
  const stale = await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: job.version, department: 'x' });
  if (stale.status !== 409) throw new Error(`stale edit ${stale.status}`);
  if ((await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: r.body.job.version, experience_min: 9 })).status !== 400) throw new Error('min > max accepted');
  job = r.body.job;
  r = await internal('mgr', 'POST', `/api/hr/jobs/${job.id}/publish`, { version: job.version });
  job = r.body.job;
  const slug = 'dbcheck-hr-performance-marketing-manager';
  if (r.status !== 200 || job.status !== 'published' || job.slug !== slug || job.public_url !== `https://careers.test/${slug}/apply`) throw new Error(JSON.stringify(job));
  const feed = await careers('GET', '/jobs');
  const pub = feed.body.jobs.find((j) => j.public_id === job.public_id);
  if (!pub || pub.public_url !== job.public_url || 'id' in pub || 'candidate_count' in pub || pub.salary.min !== 1200000) throw new Error(JSON.stringify(pub));
  // Salary policy: public only when both ends are set; a single value stays internal.
  const one = await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: job.version, salary_max: null });
  const pubOne = (await careers('GET', `/jobs/${job.public_id}`)).body.job;
  if (pubOne.salary !== null || (await careers('GET', '/jobs')).body.jobs.find((j) => j.public_id === job.public_id).salary !== null) throw new Error('single salary value shown publicly');
  if (one.body.job.salary_min !== 1200000 || one.body.job.salary_max !== null) throw new Error('internal salary fields lost');
  job = (await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: one.body.job.version, salary_max: 1800000 })).body.job;
  if ((await careers('GET', `/jobs/${job.public_id}`)).body.job.salary?.max !== 1800000) throw new Error('both salary values not shown');
  if ((await careers('GET', `/${slug}/apply`)).status !== 200) throw new Error('published page');
  // Title edits keep the URL; an explicit slug change redirects the old one.
  r = await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: job.version, title: `${HRT} Growth Marketing Manager` });
  if (r.body.job.slug !== slug || r.body.job.public_id !== job.public_id) throw new Error('slug followed the title');
  r = await internal('mgr', 'PATCH', `/api/hr/jobs/${job.id}`, { version: r.body.job.version, slug: `${HRT} growth marketing` });
  const newSlug = 'dbcheck-hr-growth-marketing';
  const old = await careers('GET', `/${slug}/apply`);
  if (r.body.job.slug !== newSlug || old.status !== 301 || old.headers.get('location') !== `/${newSlug}/apply`) throw new Error(`rename ${r.body.job.slug} ${old.status} ${old.headers.get('location')}`);
  job = r.body.job; HRS.job = job;
  // Close: public page stays (noindex), not in feed, no applications; reopen; archive; restore.
  r = await internal('mgr', 'POST', `/api/hr/jobs/${job.id}/close`, { version: job.version }); job = r.body.job;
  const closedPage = await careers('GET', `/${newSlug}/apply`);
  const closedApi = await careers('GET', `/jobs/${job.public_id}`);
  if (closedPage.status !== 200 || closedPage.headers.get('x-robots-tag') !== 'noindex' || closedApi.body.form !== null || closedApi.body.job.applications_open) throw new Error('closed page');
  if ((await careers('GET', '/jobs')).body.jobs.some((j) => j.public_id === job.public_id)) throw new Error('closed in feed');
  if ((await apply(job.public_id)).status !== 409) throw new Error('closed accepted an application');
  r = await internal('mgr', 'POST', `/api/hr/jobs/${job.id}/publish`, { version: job.version }); job = r.body.job;
  if (job.status !== 'published' || job.slug !== newSlug) throw new Error('reopen');
  // A second job, archived and restored.
  r = await internal('mgr', 'POST', '/api/hr/jobs', { title: `${HRT} Graphic Design Intern`, employment_type: 'internship', work_mode: 'remote', summary: 'Design with us.' });
  let j2 = r.body.job;
  j2 = (await internal('mgr', 'POST', `/api/hr/jobs/${j2.id}/publish`, { version: j2.version })).body.job;
  HRS.job2 = j2;
  const j3 = (await internal('mgr', 'POST', '/api/hr/jobs', { title: `${HRT} Archive Me`, employment_type: 'contract', work_mode: 'remote', summary: 'x' })).body.job;
  let a3 = (await internal('mgr', 'POST', `/api/hr/jobs/${j3.id}/publish`, { version: j3.version })).body.job;
  a3 = (await internal('mgr', 'POST', `/api/hr/jobs/${a3.id}/archive`, { version: a3.version })).body.job;
  if ((await careers('GET', `/${a3.slug}/apply`)).status !== 404 || (await careers('GET', '/jobs')).body.jobs.some((j) => j.public_id === a3.public_id)) throw new Error('archived public');
  const restored = (await internal('mgr', 'POST', `/api/hr/jobs/${a3.id}/restore`, { version: a3.version })).body.job;
  if (restored.status !== 'draft' || (await internal('mgr', 'POST', `/api/hr/jobs/${a3.id}/close`, { version: restored.version })).status !== 409) throw new Error('restore / illegal close');
  const ev = (await getPool().query('SELECT event_type FROM hr_events WHERE job_id = $1 ORDER BY id', [job.id])).rows.map((x) => x.event_type);
  for (const t of ['job_created', 'job_updated', 'job_published', 'job_slug_set', 'job_closed']) if (!ev.includes(t)) throw new Error(`no ${t}`);
  return 'draft private; incomplete publish refused; stale edit 409; publish → slug + URL; salary public only with both ends; title edit keeps URL; rename 301s; close (noindex, no form, out of feed, 409 on apply); reopen; archive 404; restore → draft; events';
});

await step('hr: applications — create, reuse candidate, pending vs complete, duplicate, other job, validation', async () => {
  const pid = HRS.job.public_id;
  for (const [over, field] of [[{ full_name: '' }, 'full_name'], [{ email: 'nope' }, 'email'], [{ phone: '12345' }, 'phone'], [{ phone: '2079460958' }, 'phone'],
    [{ linkedin_url: 'javascript:alert(1)' }, 'linkedin_url'], [{ consent: false }, 'consent'], [{ relevant_experience: ' ' }, 'relevant_experience']]) {
    const r = await apply(pid, over);
    if (r.status !== 400 || r.body.field !== field) throw new Error(`${JSON.stringify(over)} → ${r.status} ${r.body.field}`);
  }
  // Step 1 twice before a resume: one pending row, the first token dead.
  const a1 = await apply(pid);
  const a2 = await apply(pid, { email: '  DBCHECK-HR-CAND@Example.TEST ' });
  if (a1.status !== 201 || a2.status !== 201 || !a2.body.uploadToken || a2.body.jobTitle !== HRS.job.title) throw new Error(`${a1.status} ${a2.status}`);
  const pend = (await getPool().query(`SELECT count(*)::int n FROM hr_applications a JOIN hr_candidates c ON c.id = a.candidate_id WHERE c.email = 'dbcheck-hr-cand@example.test'`)).rows[0].n;
  if (pend !== 1) throw new Error(`pending rows ${pend}`);
  // Incomplete: invisible to HR, counted as incomplete.
  if ((await internal('mgr', 'GET', `/api/hr/applications?job=${HRS.job.id}`)).body.applications.length) throw new Error('incomplete listed');
  if ((await internal('mgr', 'GET', '/api/hr/jobs')).body.jobs.find((j) => j.id === HRS.job.id).incomplete_count !== 1) throw new Error('incomplete count');
  if ((await upload(pid, a1.body.uploadToken, pdf())).status !== 401) throw new Error('superseded token worked');
  const up = await upload(pid, a2.body.uploadToken, pdf(), 'Test CV.pdf');
  if (up.status !== 201 || up.body.jobTitle !== HRS.job.title) throw new Error(`upload ${up.status} ${JSON.stringify(up.body)}`);
  const list = (await internal('mgr', 'GET', `/api/hr/applications?job=${HRS.job.id}`)).body.applications;
  if (list.length !== 1 || list[0].email !== 'dbcheck-hr-cand@example.test' || !list[0].has_resume || 'resume_storage_path' in list[0] && list[0].resume_storage_path) throw new Error(JSON.stringify(list));
  HRS.app = list[0];
  if ((await apply(pid)).status !== 409 || !(await apply(pid)).body.duplicate) throw new Error('duplicate accepted');
  // Same person, another job: same candidate; a changed phone is kept in history.
  const b1 = await apply(HRS.job2.public_id, { phone: '+91 98765 43210' });
  if (b1.status !== 201 || (await upload(HRS.job2.public_id, b1.body.uploadToken, docx(), 'cv.docx')).status !== 201) throw new Error('second job');
  const cands = (await getPool().query(`SELECT id, phone FROM hr_candidates WHERE email = 'dbcheck-hr-cand@example.test'`)).rows;
  if (cands.length !== 1 || cands[0].phone !== '+919876543210') throw new Error(JSON.stringify(cands));
  const ch = (await getPool().query(`SELECT metadata FROM hr_events WHERE candidate_id = $1 AND event_type = 'candidate_profile_updated' ORDER BY id DESC LIMIT 1`, [cands[0].id])).rows[0];
  if (ch?.metadata?.changed?.phone?.from !== '+442079460958') throw new Error('previous phone not kept');
  const row = (await getPool().query('SELECT consent_at, consent_text_version, submitted_ip_hash, completed_at, upload_token_hash FROM hr_applications WHERE id = $1', [HRS.app.id])).rows[0];
  if (!row.consent_at || !row.consent_text_version || !row.submitted_ip_hash || row.submitted_ip_hash.includes('198.51') || !row.completed_at || row.upload_token_hash) throw new Error(JSON.stringify(row));
  return '7 invalid inputs refused by field; pending resubmit reuses the row and kills the old token; incomplete hidden + counted; complete → listed; duplicate 409; other job reuses candidate (case/space-insensitive email) and logs the previous phone; consent + hashed IP stored';
});

await step('hr: resumes — PDF/DOCX, 10 MB boundary, bad files, tokens, private storage, HR-only download', async () => {
  const pid = HRS.job2.public_id;
  const fresh = async (email) => (await apply(pid, { email })).body.uploadToken;
  let t = await fresh('dbcheck-hr-files@example.test');
  const tenMb = pdf(10 * 1024 * 1024);
  for (const [buf, name, why] of [[Buffer.from('not a pdf'), 'cv.pdf', 'fake PDF'], [Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]), 'cv.docx', 'plain zip'],
    [docx(), 'cv.docm', 'docm'], [Buffer.alloc(0), 'cv.pdf', 'empty'], [pdf(), 'cv.exe', 'exe']]) {
    const r = await upload(pid, t, buf, name);
    if (r.status !== 400) throw new Error(`${why}: ${r.status}`);
  }
  const big = await upload(pid, t, pdf(10 * 1024 * 1024 + 2048), 'big.pdf');
  if (big.status !== 413) throw new Error(`oversized ${big.status}`);
  const ok = await upload(pid, t, tenMb, 'exactly-10mb.pdf');   // the token survived every rejected try
  if (ok.status !== 201) throw new Error(`10 MB ${ok.status} ${JSON.stringify(ok.body)}`);
  if ((await upload(pid, t, pdf(), 'again.pdf')).status !== 401) throw new Error('token reused');
  t = await fresh('dbcheck-hr-expired@example.test');
  await getPool().query(`UPDATE hr_applications SET upload_token_expires = now() - interval '1 minute' WHERE upload_token_hash = encode(sha256($1::bytea), 'hex')`, [t]);
  if ((await upload(pid, t, pdf())).status !== 401) throw new Error('expired token worked');
  t = await fresh('dbcheck-hr-wrongjob@example.test');
  if ((await upload(HRS.job.public_id, t, pdf())).status !== 401) throw new Error('token worked for another job');
  // Stored privately, under hr/resumes, never named in any API answer.
  const key = (await getPool().query('SELECT resume_storage_path FROM hr_applications WHERE id = $1', [HRS.app.id])).rows[0].resume_storage_path;
  if (!/^hr\/resumes\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/.test(key)) throw new Error(key);
  const detail = await internal('mgr', 'GET', `/api/hr/applications/${HRS.app.id}`);
  if (JSON.stringify(detail.body).includes(key) || JSON.stringify(await internal('mgr', 'GET', '/api/hr/applications')).includes('hr/resumes')) throw new Error('storage key leaked');
  const dl = await fetch(`${HRS.base}/api/hr/applications/${HRS.app.id}/resume`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.mgr)}` } });
  const bytes = Buffer.from(await dl.arrayBuffer());
  if (dl.status !== 200 || !bytes.subarray(0, 4).equals(Buffer.from('%PDF')) || !/attachment/.test(dl.headers.get('content-disposition')) || dl.headers.get('x-content-type-options') !== 'nosniff') throw new Error(`download ${dl.status}`);
  for (const [who, want] of [['nonHr', 403], ['', 401]]) {
    const r = await internal(who || null, 'GET', `/api/hr/applications/${HRS.app.id}/resume`);
    if (r.status !== want) throw new Error(`${who || 'anon'} download ${r.status}`);
  }
  if ((await careers('GET', `/${key}`)).status !== 404 || (await careers('GET', `/api/hr/applications/${HRS.app.id}/resume`, { cookieAs: 'mgr' })).status !== 404) throw new Error('resume reachable on careers host');
  return 'fake PDF, plain ZIP, .docm, empty, .exe → 400 (token kept); 10 MB + 2 KB → 413; exactly 10 MB → 201; reuse/expired/other-job token → 401; key hr/resumes/YYYY-MM/<uuid> never in API output; download HR-only, attachment + nosniff';
});

await step('hr: status changes with history, notes, search and filters', async () => {
  const id = HRS.app.id;
  let d = (await internal('mgr', 'GET', `/api/hr/applications/${id}`)).body;
  let r = await internal('mgr', 'PATCH', `/api/hr/applications/${id}/status`, { status: 'screening', version: d.application.version, note: 'Strong CV' });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if ((await internal('mgr', 'PATCH', `/api/hr/applications/${id}/status`, { status: 'interview', version: d.application.version })).status !== 409) throw new Error('stale status');
  d = (await internal('mgr', 'GET', `/api/hr/applications/${id}`)).body;
  await internal('mgr', 'PATCH', `/api/hr/applications/${id}/status`, { status: 'interview', version: d.application.version });
  if ((await internal('mgr', 'PATCH', `/api/hr/applications/${id}/status`, { status: 'promoted', version: 99 })).status !== 400) throw new Error('bad status');
  if ((await internal('nonHr', 'PATCH', `/api/hr/applications/${id}/status`, { status: 'hired', version: 1 })).status !== 403) throw new Error('non-HR changed status');
  if ((await internal('mgr', 'POST', `/api/hr/applications/${id}/notes`, { body: 'Call on Monday' })).status !== 201) throw new Error('note');
  if ((await internal('mgr', 'POST', `/api/hr/applications/${id}/notes`, { body: '  ' })).status !== 400) throw new Error('empty note');
  d = (await internal('adm', 'GET', `/api/hr/applications/${id}`)).body;
  const h = d.history.map((x) => `${x.from_status}>${x.to_status}`).join(',');
  if (h !== 'applied>screening,screening>interview' || d.history[0].note !== 'Strong CV' || !d.history[0].actor || d.notes[0].body !== 'Call on Monday') throw new Error(JSON.stringify({ h, notes: d.notes }));
  if (d.application.status !== 'interview' || d.other_applications.length !== 1) throw new Error('detail');
  const q = async (qs) => (await internal('mgr', 'GET', `/api/hr/applications?${qs}`)).body.applications.filter((a) => a.job_title.startsWith(HRT)).length;
  const counts = [await q('q=Test%20Candidate'), await q('q=dbcheck-hr-cand'), await q('q=9876543210'), await q('status=interview'), await q(`job=${HRS.job2.id}`), await q('q=nobody-matches-this')];
  if (counts.join() !== '3,2,2,1,2,0') /* the name also matches the resume test's application */ throw new Error(counts.join());
  const ev = (await getPool().query('SELECT event_type FROM hr_events WHERE application_id = $1', [id])).rows.map((x) => x.event_type);
  for (const t of ['application_started', 'resume_uploaded', 'application_submitted', 'status_changed', 'note_added']) if (!ev.includes(t)) throw new Error(`no ${t}`);
  return 'applied→screening (note)→interview with history + actor; stale 409; unknown 400; non-HR 403; notes; search by name/email/phone; status + job filters; events';
});

await step('hr: IST — UTC instants shown and bucketed as Asia/Kolkata days and times', async () => {
  const bad = [];
  // 20:00 UTC on 6 Oct is 01:30 IST on 7 Oct.
  const t = '2026-10-06T20:00:00.000Z';
  if (istDateTime(t) !== '7 Oct 2026, 1:30 am IST') bad.push(`istDateTime ${JSON.stringify(istDateTime(t))}`);
  if (istDate(t) !== '7 Oct 2026' || istTime(t) !== '1:30 am' || uiIstDayKey(t) !== '2026-10-07' || istDayKey(t) !== '2026-10-07') bad.push('date/time/day key');
  if (istDateTime('2026-10-06T06:29:00Z') !== '6 Oct 2026, 11:59 am IST') bad.push('morning UTC');
  if (istDateTime('2026-12-31T18:30:00Z') !== '1 Jan 2027, 12:00 am IST') bad.push('year boundary');
  if (istDateTime(null) !== '—' || istDateTime('nonsense') !== '—') bad.push('empty values');
  if (HR_TIMEZONE !== 'Asia/Kolkata' || (await internal('mgr', 'GET', '/api/hr/meta')).body.timezone !== 'Asia/Kolkata') bad.push('meta timezone');
  // JobPosting datePosted is the IST day.
  if (jobPostingLd({ ...HRS.job, published_at: t, sections: {} }).datePosted !== '2026-10-07') bad.push('datePosted');
  // The applied-date filter uses IST days, not the database session's.
  const id = HRS.app.id;
  const { rows: [orig] } = await getPool().query('SELECT applied_at FROM hr_applications WHERE id = $1', [id]);
  await getPool().query('UPDATE hr_applications SET applied_at = $2 WHERE id = $1', [id, t]);
  const has = async (qs) => (await internal('mgr', 'GET', `/api/hr/applications?${qs}`)).body.applications.some((a) => a.id === id);
  const r = [await has('from=2026-10-07&to=2026-10-07'), await has('from=2026-10-06&to=2026-10-06'), await has('to=2026-10-06'), await has('from=2026-10-08')];
  await getPool().query('UPDATE hr_applications SET applied_at = $2 WHERE id = $1', [id, orig.applied_at]);
  if (r.join() !== 'true,false,false,false') bad.push(`filter ${r}`);
  // The HR page has no other time formatter.
  const src = await fsp.readFile(new URL('../public/hr.js', import.meta.url), 'utf8');
  if (/\bsetTimezone\b|[^t]dateTime\(|toLocale|toISOString\(\)\.slice/.test(src)) bad.push('hr.js formats time another way');
  if (bad.length) throw new Error(bad.join(' | '));
  return '20:00Z → "7 Oct 2026, 1:30 am IST"; 06:29Z → 11:59 am; 31 Dec 18:30Z → 1 Jan 2027; day keys, meta, datePosted in IST; applied 01:30 IST on the 7th found under 7 Oct, not 6 Oct; hr.js uses only the IST formatter';
});

await step('hr: delete job — HR manager only, typed title, never with applications; public routes and feed gone; audit kept', async () => {
  const pool = getPool();
  const snap = async () => (await pool.query(`SELECT md5(string_agg(a.id||':'||a.job_id||':'||a.candidate_id||':'||a.status||':'||coalesce(a.resume_state,''), ',' ORDER BY a.id))
    || (SELECT md5(string_agg(id||email||full_name, ',' ORDER BY id)) FROM hr_candidates)
    || (SELECT count(*) FROM hr_application_notes) || (SELECT count(*) FROM hr_application_status_history) h FROM hr_applications a`)).rows[0].h;
  const before = await snap();
  // A published job with no applications.
  let j = (await internal('mgr', 'POST', '/api/hr/jobs', { title: `${HRT} Delete Me`, employment_type: 'contract', work_mode: 'remote', summary: 'Temporary.' })).body.job;
  j = (await internal('mgr', 'POST', `/api/hr/jobs/${j.id}/publish`, { version: j.version })).body.job;
  if ((await careers('GET', `/${j.slug}/apply`)).status !== 200) throw new Error('fixture not public');
  const del = (who, body) => internal(who, 'DELETE', `/api/hr/jobs/${j.id}`, body);
  const bad = [];
  if ((await del('nonHr', { version: j.version, confirm_title: j.title })).status !== 403) bad.push('non-HR');
  if ((await del(null, { version: j.version, confirm_title: j.title })).status !== 401) bad.push('anonymous');
  const ch = await careers('DELETE', `/api/hr/jobs/${j.id}`, { cookieAs: 'adm' });
  if (ch.status !== 404) bad.push(`careers host ${ch.status} ${JSON.stringify(ch.body).slice(0, 120)}`);
  if ((await del('mgr', { version: j.version, confirm_title: 'Delete Me' })).status !== 400) bad.push('wrong title');
  if ((await del('mgr', { version: j.version - 1, confirm_title: j.title })).status !== 409) bad.push('stale version');
  // A job with applications: refused, nothing touched.
  const withApps = (await internal('mgr', 'GET', `/api/hr/jobs/${HRS.job.id}`)).body.job;
  const refused = await internal('mgr', 'DELETE', `/api/hr/jobs/${withApps.id}`, { version: withApps.version, confirm_title: withApps.title });
  if (refused.status !== 409 || !refused.body.hasApplications || refused.body.error !== 'This job cannot be permanently deleted because it has applications. Close or archive the job instead.') bad.push(`with applications: ${refused.status}`);
  if ((await internal('mgr', 'GET', `/api/hr/jobs/${withApps.id}`)).status !== 200) bad.push('job with applications gone');
  if (bad.length) throw new Error(bad.join(' | '));
  // Delete.
  const ok = await del('mgr', { version: j.version, confirm_title: `  ${j.title} ` });
  if (ok.status !== 200 || ok.body.deleted.id !== j.id || ok.body.deleted.title !== j.title || !ok.body.deleted.at) throw new Error(`delete ${ok.status} ${JSON.stringify(ok.body)}`);
  if ((await internal('mgr', 'GET', '/api/hr/jobs')).body.jobs.some((x) => x.id === j.id) || (await internal('mgr', 'GET', `/api/hr/jobs/${j.id}`)).status !== 404) bad.push('still in HR');
  for (const p of [`/${j.slug}/apply`, `/${j.slug}`, `/jobs/${j.public_id}`]) if ((await careers('GET', p)).status !== 404) bad.push(`public ${p}`);
  if ((await careers('GET', '/jobs')).body.jobs.some((x) => x.public_id === j.public_id) || (await careers('GET', '/sitemap.xml')).body.includes(j.slug) || (await careers('GET', '/')).body.includes(j.title)) bad.push('feed/sitemap/home');
  if ((await pool.query('SELECT count(*)::int n FROM hr_job_slugs WHERE slug = $1', [j.slug])).rows[0].n) bad.push('slug left');
  const ev = (await pool.query(`SELECT event_type, actor, at, job_id, metadata FROM hr_events WHERE metadata->>'job_id' = $1 ORDER BY id`, [String(j.id)])).rows;
  const d = ev.find((e) => e.event_type === 'job_deleted');
  if (!d || d.actor !== 'HR mgr' || !d.at || d.metadata.title !== j.title || d.metadata.public_id !== j.public_id || d.job_id !== null) bad.push(`audit ${JSON.stringify(d)}`);
  if (!ev.some((e) => e.event_type === 'job_created') || !ev.some((e) => e.event_type === 'job_published')) bad.push('earlier events lost');
  if ((await del('mgr', { version: j.version, confirm_title: j.title })).status !== 404) bad.push('second delete');
  if (await snap() !== before) bad.push('candidate/application data changed');
  if (bad.length) throw new Error(bad.join(' | '));
  return `non-HR 403, anon 401, careers host 404, wrong title 400, stale 409; job with applications 409 with the exact message, kept; delete → gone from HR list/detail, public page, short link, JSON, feed, sitemap, home; slug freed; job_deleted event (id, title, public id, actor, time ${istDateTime(d.at)}); earlier events kept; candidates/applications/notes/history unchanged`;
});

await step('hr: remove resume — state machine across storage + database: normal, storage failure, finalize failure + retry, idempotent', async () => {
  const pool = getPool();
  const st = async (id) => (await pool.query('SELECT resume_state, resume_storage_path, resume_filename, resume_size, resume_uploaded_at, status, candidate_id FROM hr_applications WHERE id = $1', [id])).rows[0];
  const evs = async (id) => (await pool.query('SELECT event_type, actor, at, metadata FROM hr_events WHERE application_id = $1 ORDER BY id', [id])).rows;
  const exists = (key) => fsp.access(path.join(HRS.dir, key)).then(() => true, () => false);
  const localStore = { remove: (key) => fsp.rm(path.join(HRS.dir, key), { force: true }) };
  const brokenStore = { remove: async () => { throw new Error('R2 unavailable'); } };
  const failFinalize = { beforeFinalize: async () => { throw new Error('simulated database failure'); } };
  const hasResume = async (id) => (await internal('mgr', 'GET', `/api/hr/applications/${id}`)).body.application.has_resume;
  const others = (await pool.query(`SELECT a.id FROM hr_applications a JOIN hr_candidates c ON c.id = a.candidate_id
    WHERE a.resume_state = 'present' AND c.email LIKE 'dbcheck-hr-%' AND a.id <> $1 ORDER BY a.id`, [HRS.app.id])).rows.map((r) => Number(r.id));
  if (others.length < 2) throw new Error('need two more applications with resumes');
  const [b, c] = others;

  // 2. Storage refuses on a fresh removal → back to present, metadata intact, still downloadable.
  const id = HRS.app.id;
  const before = await st(id);
  if (before.resume_state !== 'present' || !(await exists(before.resume_storage_path))) throw new Error('fixture');
  await expectErr('storage failure', () => removeResume(id, { actor: 'db-check', store: brokenStore }), (e) => e.status === 502);
  const afterFail = await st(id);
  if (afterFail.resume_state !== 'present' || afterFail.resume_storage_path !== before.resume_storage_path || afterFail.resume_filename !== before.resume_filename) throw new Error('storage failure changed metadata');
  if (!(await hasResume(id)) || (await internal('mgr', 'GET', `/api/hr/applications/${id}/resume`)).status !== 200) throw new Error('resume not available after a failed removal');
  if (!(await evs(id)).some((e) => e.event_type === 'resume_removal_failed' && e.metadata.stage === 'storage')) throw new Error('storage failure not recorded');

  // Permissions.
  for (const [who, want] of [['nonHr', 403], ['', 401]]) {
    const r = await internal(who || null, 'DELETE', `/api/hr/applications/${id}/resume`, { reason: 'x' });
    if (r.status !== want) throw new Error(`${who || 'anon'} remove ${r.status}`);
  }

  // 1. Normal removal through the API.
  const r = await internal('mgr', 'DELETE', `/api/hr/applications/${id}/resume`, { reason: 'Candidate asked' });
  if (r.status !== 200 || r.body.already) throw new Error(`remove ${r.status} ${JSON.stringify(r.body)}`);
  const done = await st(id);
  if (await exists(before.resume_storage_path)) throw new Error('file still in storage');
  if (done.resume_state !== 'removed' || done.resume_storage_path || done.resume_filename || done.resume_size || done.resume_uploaded_at) throw new Error('fields not cleared');
  if (done.status !== 'interview' || !(await pool.query('SELECT 1 FROM hr_candidates WHERE id = $1', [done.candidate_id])).rows.length) throw new Error('application or candidate changed');
  // The failed attempt above has its own started + failed events; this removal adds the last two.
  const ev = (await evs(id)).filter((e) => e.event_type === 'resume_removal_started' || e.event_type === 'resume_removed').slice(-2);
  if (ev.map((e) => e.event_type).join() !== 'resume_removal_started,resume_removed' || ev.some((e) => !e.actor || !e.at) || ev[1].metadata.reason !== 'Candidate asked' || ev[1].metadata.filename !== 'Test CV.pdf') throw new Error(JSON.stringify(ev));
  if ((await hasResume(id)) || (await internal('mgr', 'GET', `/api/hr/applications/${id}/resume`)).status !== 404) throw new Error('removed resume offered');

  // 4. Repeating is not an error and records nothing new.
  const n = (await evs(id)).length;
  const again = await internal('mgr', 'DELETE', `/api/hr/applications/${id}/resume`, {});
  if (again.status !== 200 || !again.body.already || (await evs(id)).length !== n) throw new Error(`repeat ${again.status}`);

  // 3. File deleted, database finalize fails → "removing", key kept, nothing offered; retry finishes.
  const keyB = (await st(b)).resume_storage_path;
  await expectErr('finalize failure', () => removeResume(b, { actor: 'db-check', reason: 'Retention', store: localStore, hooks: failFinalize }), (e) => e.status === 503 && e.retry);
  const mid = await st(b);
  if (mid.resume_state !== 'removing' || mid.resume_storage_path !== keyB || await exists(keyB)) throw new Error(`after finalize failure: ${JSON.stringify(mid)}`);
  const midDetail = (await internal('mgr', 'GET', `/api/hr/applications/${b}`)).body.application;
  const midList = (await internal('mgr', 'GET', '/api/hr/applications')).body.applications.find((x) => x.id === b);
  if (midDetail.has_resume || midDetail.resume_state !== 'removing' || midList.has_resume || (await internal('mgr', 'GET', `/api/hr/applications/${b}/resume`)).status !== 404) throw new Error('pending removal offered as available');
  if (!(await evs(b)).some((e) => e.event_type === 'resume_removal_failed' && e.metadata.stage === 'finalize')) throw new Error('finalize failure not recorded');
  // A retry whose storage call fails must NOT go back to "present" (the file is gone).
  await expectErr('retry, storage down', () => removeResume(b, { actor: 'db-check', store: brokenStore }), (e) => e.status === 502);
  if ((await st(b)).resume_state !== 'removing') throw new Error('retry with storage down reverted to present');
  // Retry through the API: the object is already gone, which is fine.
  const fin = await internal('mgr', 'DELETE', `/api/hr/applications/${b}/resume`, {});
  const end = await st(b);
  if (fin.status !== 200 || end.resume_state !== 'removed' || end.resume_storage_path) throw new Error(`retry ${fin.status} ${JSON.stringify(end)}`);
  if ((await evs(b)).filter((e) => e.event_type === 'resume_removal_started').length !== 1) throw new Error('retry re-started the removal');
  if ((await evs(b)).find((e) => e.event_type === 'resume_removed')?.metadata.reason !== 'Retention') throw new Error('retry lost the reason');

  // The boot-time sweep finishes an interrupted removal on its own.
  const keyC = (await st(c)).resume_storage_path;
  await expectErr('finalize failure (c)', () => removeResume(c, { actor: 'db-check', store: localStore, hooks: failFinalize }), (e) => e.status === 503);
  const sweep = await retryPendingRemovals({ store: localStore });
  if (sweep.finished < 1 || (await st(c)).resume_state !== 'removed' || await exists(keyC)) throw new Error(`sweep ${JSON.stringify(sweep)}`);
  const sysEv = (await evs(c)).find((e) => e.event_type === 'resume_removed');
  if (sysEv?.actor !== 'system: removal retry') throw new Error('sweep not attributed');

  // The database refuses an inconsistent row.
  await expectErr('removed with a key', () => pool.query(`UPDATE hr_applications SET resume_storage_path = 'x' WHERE id = $1`, [id]), (e) => e.code === '23514');
  return 'storage failure → present, metadata + download intact, event; normal → file gone, fields cleared, started+removed events with actor/time/reason, status + candidate kept; repeat → 200 already, no new events; finalize failure → removing (key kept, file gone, never offered), retry with storage down stays removing, API retry finishes, one start event; boot sweep finishes; CHECK refuses inconsistent rows';
});

await step('careers pages — home, job page, closed, draft/archived, SEO and JobPosting data', async () => {
  const bad = [];
  const home = await careers('GET', '/');
  const titles = [...home.body.matchAll(/class="job-card-title">([^<]*)</g)].map((m) => m[1]);
  if (!titles.includes(HRS.job.title) || !titles.includes(HRS.job2.title) || titles.some((t) => /Archive Me/.test(t))) bad.push(`home lists ${titles}`);
  if (!home.body.includes('<link rel="canonical" href="https://careers.test/">') || /noindex/.test(home.body)) bad.push('home canonical/index');
  const pg = await careers('GET', `/${HRS.job.slug}/apply`);
  const ldm = pg.body.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
  const ld = ldm && JSON.parse(ldm[1]);
  if (pg.status !== 200 || !pg.body.includes('id="applyForm"') || /noindex/.test(pg.body) || pg.headers.get('cache-control') !== 'no-store') bad.push('published page');
  if (!pg.body.includes(`<link rel="canonical" href="${HRS.job.public_url}">`)) bad.push('job canonical');
  if (!ld || ld['@type'] !== 'JobPosting' || ld.title !== HRS.job.title || ld.employmentType !== 'FULL_TIME' || ld.baseSalary?.value?.minValue !== 1200000 || ld.identifier.value !== HRS.job.public_id || ld.url !== HRS.job.public_url) bad.push(`ld ${JSON.stringify(ld)}`);
  if (!/<button class="submit" type="submit" id="submitBtn" disabled>/.test(pg.body) || !/method="post"/.test(pg.body)) bad.push('form must not submit without the script');
  if (!/<input id="f-website" name="website"/.test(pg.body) || !/data-form-token="\d+\.[\w-]+"/.test(pg.body) || !/data-sitekey="test-site"/.test(pg.body)) bad.push('honeypot / form token / site key');
  if (/candidate_count|incomplete|created_by|updated_by|hr\/resumes/.test(pg.body)) bad.push('internal fields on the page');
  const asset = pg.body.match(/src="(\/assets\/careers\.js\?v=\w+)"/)?.[1];
  const a = asset && await careers('GET', asset);
  if (!a || a.status !== 200 || !/immutable/.test(a.headers.get('cache-control') || '')) bad.push('versioned asset');
  // One value of salary: no salary in the page or the structured data.
  const j2 = (await internal('mgr', 'GET', `/api/hr/jobs/${HRS.job2.id}`)).body.job;
  const one = await internal('mgr', 'PATCH', `/api/hr/jobs/${j2.id}`, { version: j2.version, salary_min: 50000 });
  const p2 = await careers('GET', `/${HRS.job2.slug}/apply`);
  if (/50,000/.test(p2.body) || /baseSalary/.test(p2.body)) bad.push('single salary value shown');
  HRS.job2 = one.body.job;
  // JSON-LD cannot break out of its script tag.
  const evil = jobPostingLd({ ...HRS.job, title: '</script><script>alert(1)</script>', sections: {} });
  const evilHtml = JSON.stringify(evil).replace(/</g, '\\u003c');
  if (evilHtml.includes('</script>')) bad.push('ld escaping');
  // Closed: page stays, says so, no form, noindex, no JobPosting.
  let j3 = (await internal('mgr', 'GET', `/api/hr/jobs/${HRS.job2.id}`)).body.job;
  j3 = (await internal('mgr', 'POST', `/api/hr/jobs/${j3.id}/close`, { version: j3.version })).body.job;
  const cl = await careers('GET', `/${j3.slug}/apply`);
  if (cl.status !== 200 || !/Applications for this role are closed/.test(cl.body) || /id="applyForm"/.test(cl.body) || /application\/ld\+json/.test(cl.body)
    || !/<meta name="robots" content="noindex">/.test(cl.body) || cl.headers.get('x-robots-tag') !== 'noindex') bad.push('closed page');
  if ((await careers('GET', '/')).body.includes(j3.title) || (await careers('GET', '/sitemap.xml')).body.includes(j3.slug)) bad.push('closed job listed');
  j3 = (await internal('mgr', 'POST', `/api/hr/jobs/${j3.id}/publish`, { version: j3.version })).body.job;
  HRS.job2 = j3;
  // Draft, archived, unknown: the same 404 page. /<slug> → 301 to /<slug>/apply.
  const draft = (await internal('mgr', 'POST', '/api/hr/jobs', { title: `${HRT} Hidden Draft` })).body.job;
  for (const p of ['/dbcheck-hr-hidden-draft/apply', '/dbcheck-hr-archive-me/apply', '/no-such-role/apply', '/dbcheck-hr-archive-me']) {
    const r = await careers('GET', p);
    if (r.status !== 404 || !/Page not found/.test(r.body) || !/noindex/.test(r.body)) bad.push(`${p}: ${r.status}`);
  }
  if ((await careers('GET', `/jobs/${draft.public_id}`)).status !== 404) bad.push('draft in API');
  const short = await careers('GET', `/${HRS.job.slug}`);
  if (short.status !== 301 || short.headers.get('location') !== `/${HRS.job.slug}/apply`) bad.push(`short link ${short.status}`);
  const sm = (await careers('GET', '/sitemap.xml')).body;
  const rb = (await careers('GET', '/robots.txt')).body;
  if (!sm.includes(HRS.job.public_url) || sm.includes('hidden-draft') || sm.includes('archive-me') || !rb.includes('Sitemap: https://careers.test/sitemap.xml')) bad.push('sitemap/robots');
  // A plain form POST to the page (no script) is a 404, never a GET with the fields in the URL.
  if ((await careers('POST', `/${HRS.job.slug}/apply`, { raw: 'full_name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status !== 404) bad.push('native form post');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'home: published only, canonical; job: form, canonical, no-store, JobPosting (type, salary, id, url), button disabled until script, honeypot + signed token + site key, no internal fields, versioned immutable asset; single salary hidden; LD escaping; closed: notice, no form, noindex (meta + header), no LD, off home + sitemap; draft/archived/unknown → 404 page; /<slug> → 301; sitemap + robots';
});

await step('hr: spam layers — rate limit, Turnstile, honeypot, minimum fill time', async () => {
  const pid = HRS.job2.public_id;
  const ip = '203.0.113.77';
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await apply(pid, { email: `dbcheck-hr-rl${i}@example.test` }, { ip })).status);
  if (codes.slice(0, 3).some((c) => c !== 201) || codes.at(-1) !== 429) throw new Error(`rate limit ${codes}`);
  const tf = await apply(pid, { email: 'dbcheck-hr-ts@example.test', turnstile_token: 'fail' });
  if (tf.status !== 400 || tf.body.field !== 'turnstile') throw new Error(`turnstile ${tf.status}`);
  const tm = await apply(pid, { email: 'dbcheck-hr-ts2@example.test', turnstile_token: '' });
  if (tm.status !== 400) throw new Error('missing turnstile');
  if ((await apply(pid, { email: 'dbcheck-hr-hp@example.test', website: 'http://spam' })).status !== 400) throw new Error('honeypot');
  const fast = await apply(pid, { email: 'dbcheck-hr-fast@example.test', form_token: issueFormToken(pid, Date.now()) });
  if (fast.status !== 400 || !/fast/.test(fast.body.error)) throw new Error(`fill time ${fast.status}`);
  if ((await apply(pid, { email: 'dbcheck-hr-forged@example.test', form_token: `${Date.now() - 9000}.forged` })).status !== 400) throw new Error('forged form token');
  if ((await apply(pid, { email: 'dbcheck-hr-other@example.test', form_token: issueFormToken(HRS.job.public_id, Date.now() - 5000) })).status !== 400) throw new Error('form token from another job');
  const saved = process.env.TURNSTILE_SECRET_KEY; delete process.env.TURNSTILE_SECRET_KEY;
  const nc = await verifyTurnstile('pass', '1.2.3.4');
  if (saved) process.env.TURNSTILE_SECRET_KEY = saved;
  if (nc.ok || nc.reason !== 'not_configured') throw new Error('no keys did not fail closed');
  const malformed = await careers('POST', `/jobs/${pid}/apply`, { raw: '{bad json', headers: { 'content-type': 'application/json' } });
  if (malformed.status !== 400) throw new Error(`malformed ${malformed.status}`);
  const n = (await getPool().query(`SELECT count(*)::int n FROM hr_candidates WHERE email IN ('dbcheck-hr-ts@example.test','dbcheck-hr-hp@example.test','dbcheck-hr-fast@example.test')`)).rows[0].n;
  if (n) throw new Error('rejected submissions stored data');
  return `per-IP limit: ${codes.join(',')}; Turnstile fail/missing 400; no keys → fail closed; honeypot; < 3 s, forged and other-job form tokens refused; malformed JSON 400; nothing stored`;
});

await step('hr: public answers never leak candidate data, ids, counts or notes', async () => {
  const bodies = [await careers('GET', '/jobs'), await careers('GET', `/jobs/${HRS.job.public_id}`), await careers('GET', `/${HRS.job.slug}/apply`), await apply(HRS.job.public_id)];
  const all = bodies.map((b) => (typeof b.body === 'string' ? b.body : JSON.stringify(b.body))).join('\n');
  for (const secret of ['dbcheck-hr-cand@example.test', 'Test Candidate', '9876543210', 'Call on Monday', 'Strong CV', 'hr/resumes', '"candidate_count"', '"incomplete_count"', '"created_by"', `"id":${HRS.job.id}`]) {
    if (all.includes(secret)) throw new Error(`leaked ${secret}`);
  }
  if (bodies[3].status !== 409) throw new Error('duplicate expected');
  return 'feed, job JSON, job page and an apply answer: no email/name/phone, notes, storage keys, counts, actors or database ids';
});

await step('hr: host isolation — the careers host serves careers routes only', async () => {
  const paths = ['/login', '/dashboard', '/orders', '/inventory', '/admin', '/members', '/hr/jobs', '/no-access', '/index.html', '/orders.js', '/ui/components.js',
    '/auth/me', '/api/hr/jobs', '/api/hr/applications', '/api/orders', '/api/orders/meta', '/api/inventory', '/api/members', '/api/carts', '/api/carts.csv',
    '/api/admin/overview', '/api/config', '/api/webhook/gokwik/abandoned-cart', '/readyz'];
  const bad = [];
  for (const p of paths) for (const as of [undefined, 'adm']) {
    const r = await careers('GET', p, { cookieAs: as });
    if (r.status !== 404 || r.headers.get('set-cookie')) bad.push(`${as || 'anon'} ${p}: ${r.status}`);
  }
  for (const [m, p] of [['POST', '/api/hr/jobs'], ['POST', '/auth/request-otp'], ['POST', '/api/status'], ['PATCH', '/api/members/919000000304'], ['POST', '/api/webhook/gokwik/abandoned-cart']]) {
    const r = await careers(m, p, { body: { title: `${HRT} isolation probe`, phone: '9000000304' }, cookieAs: 'adm' });
    if (r.status !== 404) bad.push(`${m} ${p}: ${r.status}`);
  }
  const home = await careers('GET', '/', { cookieAs: 'adm' });
  if (home.status !== 200 || home.headers.get('set-cookie') || !/Careers at Briyo/.test(home.body) || /Dashboard|Call board|sidebar/.test(home.body)) bad.push('careers home');
  const ok = await careers('GET', '/jobs');
  if (ok.status !== 200 || !/default-src 'self'/.test(ok.headers.get('content-security-policy') || '') || ok.headers.get('x-frame-options') !== 'DENY') bad.push('careers headers');
  // The internal host has no careers routes.
  for (const p of ['/jobs', `/${HRS.job.slug}/apply`, `/jobs/${HRS.job.public_id}`]) {
    const r = await internal('adm', 'GET', p);
    if (r.status === 200 && (typeof r.body === 'object' ? r.body.jobs || r.body.job : /Careers at Briyo/.test(r.body))) bad.push(`internal host served ${p}`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${paths.length * 2 + 5} internal paths on the careers host (pages answer the careers 404 page) → 404 (no cookie set), with and without an admin session; careers headers; internal host serves no careers routes`;
});

await step('careers host detection behind a proxy — the Host header decides, never X-Forwarded-Host', async () => {
  const bad = [];
  // Unit: normalisation and the decision itself.
  const saved = process.env.CAREERS_HOST; process.env.CAREERS_HOST = 'Careers.Briyo.xyz';
  for (const [host, want] of [['careers.briyo.xyz', true], ['careers.briyo.xyz:443', true], ['CAREERS.BRIYO.XYZ', true], ['careers.briyo.xyz.', true],
    ['abc.briyo.xyz', false], ['abc.briyo.xyz:443', false], ['careers.briyo.xyz.evil.test', false], ['xcareers.briyo.xyz', false], ['', false], [undefined, false]]) {
    if (isCareersRequest({ headers: { host } }) !== want) bad.push(`unit ${host} ≠ ${want}`);
  }
  if (isCareersRequest({ headers: { host: 'abc.briyo.xyz', 'x-forwarded-host': 'careers.briyo.xyz' }, hostname: 'careers.briyo.xyz' })) bad.push('unit: forwarded host made abc careers');
  if (!isCareersRequest({ headers: { host: 'careers.briyo.xyz', 'x-forwarded-host': 'abc-briyo-sg.onrender.com' }, hostname: 'abc-briyo-sg.onrender.com' })) bad.push('unit: forwarded host hid careers');
  if (normalizeHost('[::1]:3000') !== '[::1]') bad.push('ipv6');
  process.env.CAREERS_HOST = ''; if (isCareersRequest({ headers: { host: '' } })) bad.push('unset host matched');
  process.env.CAREERS_HOST = saved;
  // On the real server, which trusts one proxy hop (as on Render).
  const xfh = (v) => ({ 'x-forwarded-host': v });
  for (const [label, host, headers, check] of [
    ['careers + port', 'careers.test:443', {}, (r) => r.status === 200 && /Careers at Briyo/.test(r.body)],
    ['careers, proxy says another host', 'careers.test', xfh('abc-briyo-sg.onrender.com'), (r) => r.status === 200 && /Careers at Briyo/.test(r.body)],
    ['careers /login, proxy says another host', 'careers.test', xfh('abc.briyo.xyz'), (r) => r.status === 404 && !r.headers.get('location')],
    ['careers /dashboard', 'careers.test', xfh('abc.briyo.xyz'), (r) => r.status === 404],
    ['internal, forwarded host claims careers', '127.0.0.1', xfh('careers.test'), (r) => r.status === 302 && r.headers.get('location') === '/login'],
    ['internal + port, forwarded host claims careers', `127.0.0.1:${new URL(HRS.base).port}`, xfh('careers.test'), (r) => r.status === 302],
  ]) {
    const path_ = /dashboard/.test(label) ? '/dashboard' : /login/.test(label) ? '/login' : '/';
    const r = await careers('GET', path_, { headers: { host, ...headers } });
    if (!check(r)) bad.push(`${label}: ${r.status} ${r.headers.get('location') || ''}`);
  }
  // Health check on the careers host: up, the time, nothing else, never cached.
  for (const host of ['careers.test', 'careers.test:443']) {
    const h = await careers('GET', '/healthz', { headers: { host, ...xfh('abc.briyo.xyz') } });
    if (h.status !== 200 || h.body?.ok !== true || Object.keys(h.body).join() !== 'ok,ts' || h.headers.get('cache-control') !== 'no-store' || h.headers.get('set-cookie')) bad.push(`careers healthz (${host}): ${h.status} ${JSON.stringify(h.body)}`);
  }
  for (const p of ['/login', '/dashboard', '/api/orders', '/auth/me']) {
    const r = await careers('GET', p, { headers: { host: 'careers.test' } });
    if (r.status !== 404 || r.headers.get('location')) bad.push(`careers ${p} (no session): ${r.status}`);
  }
  // Internal host: its own /healthz unchanged.
  const ih = await careers('GET', '/healthz', { headers: { host: '127.0.0.1', ...xfh('careers.test') } });
  if (ih.status !== 200 || ih.body?.ok !== true) bad.push(`internal healthz: ${ih.status}`);
  for (const p of ['/api/orders', '/api/hr/jobs', '/auth/me']) {
    const r = await careers('GET', p, { headers: { host: 'careers.test:443', ...xfh('abc.briyo.xyz') }, cookieAs: 'adm' });
    if (r.status !== 404) bad.push(`careers ${p}: ${r.status}`);
  }
  const jobs = await careers('GET', '/jobs', { headers: { host: '127.0.0.1', ...xfh('careers.test') }, cookieAs: 'adm' });
  if (jobs.status === 200 && typeof jobs.body === 'object' && jobs.body.jobs) bad.push('careers feed on the internal host via forwarded host');
  const app = await careers('GET', '/api/hr/jobs', { headers: { host: '127.0.0.1', ...xfh('careers.test') }, cookieAs: 'adm' });
  if (app.status !== 200 || !Array.isArray(app.body.jobs)) bad.push(`internal API with forwarded careers host: ${app.status}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'unit: 10 Host forms + forwarded-host both ways; careers /healthz 200 {ok,ts} no-store (with :443); careers /login /dashboard /api/orders /auth/me 404 without a session; internal /healthz unchanged; server: careers with :443 and a different forwarded host → careers (home 200, /login /dashboard 404, APIs 404 with an admin session); internal Host + forwarded careers → internal app (login redirect, API 200, no careers feed)';
});

await step('overview: each member sees only their departments; numbers match the records; signed out refused', async () => {
  const bad = [];
  const keys = async (who) => { const r = await internal(who, 'GET', '/api/overview'); return r.status === 200 ? Object.keys(r.body.sections).sort().join() : `HTTP ${r.status}`; };
  const want = { mgr: 'hr', multi: 'hr,inventory,logistics', nonHr: 'support', adm: 'hr,ingest,inventory,logistics,marketing,people,support' };
  for (const [who, k] of Object.entries(want)) { const got = await keys(who); if (got !== k) bad.push(`${who}: ${got} ≠ ${k}`); }
  if ((await internal(null, 'GET', '/api/overview')).status !== 401) bad.push('signed out not refused');
  const page = await internal(null, 'GET', '/overview');
  if (page.status !== 302 || page.headers.get('location') !== '/login') bad.push('page signed out');
  if ((await internal('mgr', 'GET', '/overview')).status !== 200) bad.push('page for HR manager');
  if ((await careers('GET', '/api/overview', { cookieAs: 'adm' })).status !== 404 || (await careers('GET', '/overview', { cookieAs: 'adm' })).status !== 404) bad.push('careers host');
  // Numbers come from the records, with the department pages' predicates.
  const ov = (await internal('adm', 'GET', '/api/overview')).body;
  const one = async (q) => (await getPool().query(q)).rows[0].n;
  const S = ov.sections; const pool = getPool();
  const cmp = [
    ['support not called', S.support.not_called, await one("SELECT count(*)::int n FROM abandoned_carts WHERE status = 'Not called'")],
    ['hr open jobs', S.hr.open_jobs, await one("SELECT count(*)::int n FROM hr_jobs WHERE status = 'published'")],
    ['hr awaiting review', S.hr.awaiting_review, await one("SELECT count(*)::int n FROM hr_applications WHERE completed_at IS NOT NULL AND status = 'applied'")],
    ['people active', S.people.active, await one('SELECT count(*)::int n FROM allowed_users WHERE active')],
    ['inventory skus', S.inventory.master_skus, await one('SELECT count(*)::int n FROM skus WHERE active')],
  ];
  const meta = (await internal('adm', 'GET', '/api/orders/meta')).body;
  for (const k of ['pending_dispatch', 'in_transit', 'delivered', 'failed']) cmp.push([`logistics ${k}`, S.logistics[k], meta.viewCounts[k]]);
  for (const [label, a, b] of cmp) if (a !== b) bad.push(`${label}: ${a} vs ${b}`);
  // Attention: only non-zero items, sorted critical → warning → attention, each with a link.
  const order = ['critical', 'warning', 'attention'];
  if (ov.attention.some((a) => a.count === 0 || !a.href)) bad.push('zero or unlinked attention item');
  if (ov.attention.some((a, i) => i && order.indexOf(a.severity) < order.indexOf(ov.attention[i - 1].severity))) bad.push('attention not sorted');
  if (ov.timezone !== (process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata')) bad.push('timezone');
  void pool;
  if (bad.length) throw new Error(bad.join(' | '));
  return `HR manager → hr; multi-module → hr, inventory, logistics; support → support; admin → all + people + ingest; signed out 401 / login; careers host 404; ${cmp.length} numbers equal their source counts; ${ov.attention.length} attention items, non-zero, sorted, linked`;
});

await step('profiles: incomplete member is held at /profile until name, email and photo are in; photos validated; admin controls', async () => {
  const bad = [];
  const pool = getPool();
  await pool.query(`INSERT INTO allowed_users (phone, name, is_admin, added_by) VALUES ($1, 'Team', false, 'db-check') ON CONFLICT (phone) DO NOTHING`, [HRM.inc]);
  await setModuleRole(HRM.inc, 'support', 'agent', { actor: 'db-check' });
  const rolesBefore = JSON.stringify(await moduleRolesOf(HRM.inc));
  const raw = (method, path_, buf, headers = {}) => fetch(`${HRS.base}${path_}`, { method, body: buf,
    headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.inc)}`, ...headers } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  // Held: pages → /profile, APIs → 403 PROFILE_INCOMPLETE; profile, /auth/me and photos open.
  for (const p of ['/', '/overview', '/orders']) {
    const r = await internal('inc', 'GET', p);
    if (r.status !== 302 || r.headers.get('location') !== '/profile') bad.push(`page ${p}: ${r.status} ${r.headers.get('location')}`);
  }
  const held = await internal('inc', 'GET', '/api/carts?days=1');
  if (held.status !== 403 || held.body.code !== 'PROFILE_INCOMPLETE') bad.push(`api: ${held.status} ${held.body.code}`);
  const me = await internal('inc', 'GET', '/auth/me');
  if (me.status !== 200 || me.body.profileComplete !== false || me.body.profile.missing.join() !== 'name,email,photo' || me.body.phone !== HRM.inc) bad.push(`auth/me ${JSON.stringify(me.body.profile)}`);
  if ((await internal('inc', 'GET', '/profile')).status !== 200 || (await internal('inc', 'GET', '/api/profile')).status !== 200) bad.push('profile not open');
  for (const p of ['/healthz']) if ((await internal(null, 'GET', p)).status !== 200) bad.push(`${p} affected`);
  // Validation: name, email, photo type and size.
  const put = (b) => internal('inc', 'PUT', '/api/profile', b);
  for (const [b, field] of [[{ name: 'Team' }, 'name'], [{ name: '  ' }, 'name'], [{ email: 'nope' }, 'email'], [{ email: '' }, 'email']]) {
    const r = await put(b);
    if (r.status !== 400 || r.body.field !== field) bad.push(`${JSON.stringify(b)} → ${r.status} ${r.body.field}`);
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 7)]);
  for (const [buf, name, want] of [[Buffer.from('not an image'), 'me.png', 400], [Buffer.from('%PDF-1.4 x'), 'cv.pdf', 400], [Buffer.alloc(0), 'me.png', 400],
    [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024 + 10)]), 'big.jpg', 413]]) {
    const r = await raw('POST', '/api/profile/photo', buf, { 'x-filename': name });
    if (r.status !== want) bad.push(`photo ${name}: ${r.status} ≠ ${want}`);
  }
  if ((await internal('inc', 'GET', '/api/profile')).body.profile.hasPhoto) bad.push('a rejected photo was stored');
  // Complete it: photo, then name + email.
  const up = await raw('POST', '/api/profile/photo', png, { 'x-filename': 'me.png' });
  if (up.status !== 201 || !up.body.profile.hasPhoto || 'photo_key' in up.body.profile) bad.push(`upload ${up.status}`);
  if ((await internal('inc', 'GET', '/api/carts?days=1')).status !== 403) bad.push('photo alone completed the profile');
  const done = await put({ name: '  Inaya   Test ', email: ' Inaya@Example.TEST ' });
  if (done.status !== 200 || !done.body.profile.complete || done.body.profile.name !== 'Inaya Test' || done.body.profile.email !== 'inaya@example.test') bad.push(`complete ${JSON.stringify(done.body)}`);
  if ((await internal('inc', 'GET', '/api/carts?days=1')).status !== 200 || (await internal('inc', 'GET', '/')).status !== 200) bad.push('still held after completing');
  if (JSON.stringify(await moduleRolesOf(HRM.inc)) !== rolesBefore) bad.push('roles changed');
  if ((await pool.query('SELECT phone FROM allowed_users WHERE phone = $1', [HRM.inc])).rows.length !== 1) bad.push('phone changed');
  // The photo is private: signed-in members only, streamed, never a storage URL.
  const url = done.body.profile.photoUrl;
  const asTeam = await fetch(`${HRS.base}${url}`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.mgr)}` } });
  if (asTeam.status !== 200 || asTeam.headers.get('x-content-type-options') !== 'nosniff' || !/^private/.test(asTeam.headers.get('cache-control'))) bad.push(`photo for teammate ${asTeam.status}`);
  if ((await fetch(`${HRS.base}${url}`)).status !== 401 || (await careers('GET', url.split('?')[0], { cookieAs: 'adm' })).status !== 404) bad.push('photo reachable signed out / on careers');
  // Admin view: profile fields, no storage key; only admins edit others.
  const list = (await internal('adm', 'GET', '/api/members')).body.members.find((m) => m.phone === HRM.inc);
  if (!list?.profile_complete || list.email !== 'inaya@example.test' || !list.photo_url || 'photo_key' in list && list.photo_key) bad.push('members list profile fields');
  if ((await internal('mgr', 'GET', '/api/members')).status !== 403 || (await internal('mgr', 'PATCH', `/api/members/${HRM.inc}`, { email: 'x@y.zz' })).status !== 403
    || (await internal('mgr', 'DELETE', `/api/members/${HRM.inc}/photo`)).status !== 403 || (await internal('mgr', 'GET', `/api/members/${HRM.inc}/activity`)).status !== 403) bad.push('non-admin reached member admin');
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.inc}`, { email: 'bad' })).status !== 400) bad.push('admin bad email');
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.inc}`, { email: 'inaya.new@example.test' })).status !== 200) bad.push('admin email edit');
  const cleared = await internal('adm', 'DELETE', `/api/members/${HRM.inc}/photo`);
  if (cleared.status !== 200 || cleared.body.profile.complete || cleared.body.profile.missing.join() !== 'photo') bad.push(`admin clear ${cleared.status}`);
  if ((await internal('inc', 'GET', '/api/carts?days=1')).status !== 403) bad.push('cleared photo did not re-hold the member');
  const act = (await internal('adm', 'GET', `/api/members/${HRM.inc}/activity`)).body;
  if (!act.changes?.some((c) => /photo removed by an admin/.test(c.detail)) || !act.changes.some((c) => /photo added/.test(c.detail))) bad.push('activity log');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'pages → /profile, APIs 403 PROFILE_INCOMPLETE, /auth/me + /profile open; placeholder/blank name, bad/empty email, fake PNG, PDF, empty, >2 MB refused and nothing stored; photo alone not enough; name+email+photo → full access, roles and phone unchanged; photo private (teammates yes, signed out 401, careers 404); admin sees profile fields (no storage key), edits email, clears photo → member held again; activity logged; non-admins refused';
});

await step('profiles: existing members keep working with an incomplete profile and are reminded; new members are held', async () => {
  const bad = [];
  const pool = getPool();
  // Migration semantics: rows that existed when the column arrived are grandfathered (false); new rows default to required.
  const { rows: [col] } = await pool.query(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'allowed_users' AND column_name = 'profile_required'`);
  if (col?.column_default !== 'true' || col.is_nullable !== 'NO') bad.push(`column default ${JSON.stringify(col)}`);
  // An existing member (as production members will be after deploy): incomplete, not required.
  await pool.query(`INSERT INTO allowed_users (phone, name, is_admin, added_by, profile_required) VALUES ($1, 'Old Timer', false, 'db-check', false) ON CONFLICT (phone) DO NOTHING`, [HRM.old]);
  await setModuleRole(HRM.old, 'support', 'agent', { actor: 'db-check' });
  const rolesBefore = JSON.stringify(await moduleRolesOf(HRM.old));
  // A. full access, reminded
  for (const [p, want] of [['/', 200], ['/overview', 200], ['/profile', 200]]) { const r = await internal('old', 'GET', p); if (r.status !== want) bad.push(`existing ${p}: ${r.status} ${r.headers.get('location') || ''}`); }
  if ((await internal('old', 'GET', '/api/carts?days=1')).status !== 200 || (await internal('old', 'GET', '/api/overview')).status !== 200) bad.push('existing member refused an API');
  const me = (await internal('old', 'GET', '/auth/me')).body;
  if (me.profileComplete !== false || me.profileRequired !== false || me.profile.missing.join() !== 'email,photo' || me.profile.required !== false) bad.push(`existing auth/me ${JSON.stringify({ c: me.profileComplete, r: me.profileRequired, m: me.profile?.missing })}`);
  // RBAC unchanged for them: support only.
  if ((await internal('old', 'GET', '/api/orders?limit=1')).status !== 403 || (await internal('old', 'GET', '/api/members')).status !== 403) bad.push('existing member RBAC changed');
  // Can complete normally.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 3)]);
  const up = await fetch(`${HRS.base}/api/profile/photo`, { method: 'POST', body: png, headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.old)}`, 'x-filename': 'me.png' } });
  const put = await internal('old', 'PUT', '/api/profile', { email: 'old.timer@example.test' });
  if (up.status !== 201 || put.status !== 200 || !put.body.profile.complete) bad.push(`existing complete ${up.status}/${put.status}`);
  // C. complete member: normal access, no reminder
  const me2 = (await internal('old', 'GET', '/auth/me')).body;
  if (me2.profileComplete !== true || (await internal('old', 'GET', '/')).status !== 200) bad.push('complete member');
  // D. admin removes the photo: incomplete again, still operational, missing photo shown
  const cl = await internal('adm', 'DELETE', `/api/members/${HRM.old}/photo`);
  if (cl.status !== 200 || cl.body.profile.missing.join() !== 'photo') bad.push(`clear ${cl.status}`);
  if ((await internal('old', 'GET', '/api/carts?days=1')).status !== 200 || (await internal('old', 'GET', '/')).status !== 200) bad.push('existing member blocked after photo removal');
  if ((await internal('old', 'GET', '/auth/me')).body.profile.missing.join() !== 'photo') bad.push('missing photo not shown');
  const listed = (await internal('adm', 'GET', '/api/members')).body.members.find((m) => m.phone === HRM.old);
  if (listed.profile_complete || listed.profile_required !== false || listed.profile_missing.join() !== 'photo') bad.push('members list for existing member');
  if (JSON.stringify(await moduleRolesOf(HRM.old)) !== rolesBefore) bad.push('roles changed');
  // B (still): a new member — the default — is held at /profile and refused by APIs.
  await pool.query(`INSERT INTO allowed_users (phone, name, added_by) VALUES ('919000000308', 'Team', 'db-check')`);
  await setModuleRole('919000000308', 'support', 'agent', { actor: 'db-check' });
  const fresh = (method, p) => fetch(`${HRS.base}${p}`, { method, redirect: 'manual', headers: { cookie: `${SESSION_COOKIE}=${issueSession('919000000308')}` } });
  const fp = await fresh('GET', '/'); const fa = await fresh('GET', '/api/carts?days=1');
  if (fp.status !== 302 || fp.headers.get('location') !== '/profile' || fa.status !== 403 || (await fa.json()).code !== 'PROFILE_INCOMPLETE') bad.push(`new member not held ${fp.status}/${fa.status}`);
  // E. Overview counts incomplete active profiles exactly.
  const ov = (await internal('adm', 'GET', '/api/overview')).body.sections.people;
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int n FROM allowed_users WHERE active AND (photo_key IS NULL OR coalesce(btrim(email), '') = '' OR coalesce(btrim(name), '') IN ('', 'Team'))`);
  if (ov.incomplete_profiles !== n) bad.push(`overview incomplete ${ov.incomplete_profiles} vs ${n}`);
  await pool.query(`DELETE FROM member_log WHERE target_phone = '919000000308'`);
  await pool.query(`DELETE FROM allowed_users WHERE phone = '919000000308'`);
  if (bad.length) throw new Error(bad.join(' | '));
  return `column defaults to required, existing rows grandfathered; existing incomplete member: pages + APIs 200, auth/me says incomplete/not required, RBAC unchanged, completes normally; complete → normal; photo removed → missing photo shown, still operational, roles kept; new member (default) → /profile + 403 PROFILE_INCOMPLETE; Overview incomplete count = ${n} = records`;
});

await step('marketing: metrics, purchases (one action type), ranges and Meta error classification', async () => {
  const bad = [];
  const m0 = metricsFrom({ spend: 0, impressions: 0, clicks: 0 });
  if (m0.roas !== null || m0.cpa !== null || m0.ctr !== null || m0.cpc !== null || m0.cpm !== null) bad.push('zero spend/impressions not null');
  const m = metricsFrom({ spend: 1000, impressions: 20000, clicks: 400, purchases: 10, value: 3500 });
  if (m.ctr !== 2 || m.cpc !== 2.5 || m.cpm !== 50 || m.cpa !== 100 || m.roas !== 3.5) bad.push(`metrics ${JSON.stringify(m)}`);
  const noBuy = metricsFrom({ spend: 500, impressions: 1000, clicks: 0, purchases: 0, value: 0 });
  if (noBuy.roas !== 0 || noBuy.cpa !== null || noBuy.cpc !== null) bad.push('no purchases with spend');
  if (Object.values(metricsFrom({ spend: 1, impressions: 0, clicks: 0 })).some((v) => typeof v === 'number' && !Number.isFinite(v))) bad.push('NaN/Infinity');
  // Purchases: omni_purchase only, never summed with the pixel type; missing actions → real 0.
  const r = rawFromRow({ spend: '10', impressions: '100', clicks: '5', actions: [{ action_type: 'omni_purchase', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }],
    action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '90' }, { action_type: 'omni_purchase', value: '90' }] });
  if (r.purchases !== 3 || r.value !== 90) bad.push(`double count ${r.purchases}/${r.value}`);
  const r2 = rawFromRow({ spend: '10', impressions: '100', clicks: '5' });
  if (r2.purchases !== 0 || r2.value !== 0) bad.push('missing actions');
  if (rawFromRow({ spend: '5', actions: [{ action_type: 'purchase', value: '2' }] }).purchases !== 2) bad.push('fallback purchase type');
  await expectErr('malformed row', () => rawFromRow(null), (e) => e.kind === 'bad_response');
  // Ranges
  const now = new Date('2026-10-07T06:00:00Z');
  if (rangeParams({ range: 'today' }, now).params.date_preset !== 'today' || !rangeParams({ range: 'today' }, now).live || rangeParams({ range: 'yesterday' }, now).live) bad.push('presets');
  for (const [inp, why] of [[{ range: 'custom', since: '2026-10-05', until: '2026-10-01' }, 'order'], [{ range: 'custom', since: '2026-01-01', until: '2026-10-01' }, '>92 days'],
    [{ range: 'custom', since: '2026-10-01', until: '2026-12-01' }, 'future'], [{ range: 'custom', since: 'x', until: 'y' }, 'format'], [{ range: 'lifetime' }, 'unknown']]) {
    try { rangeParams(inp, now); bad.push(`range ${why} accepted`); } catch (e) { if (e.status !== 400) bad.push(`range ${why} ${e.status}`); }
  }
  // Errors → kinds, never raw text
  for (const [err, kind] of [[{ code: 190 }, 'token'], [{ code: 17 }, 'rate_limit'], [{ code: 4, error_subcode: 1504022 }, 'rate_limit'], [{ code: 80004 }, 'rate_limit'],
    [{ code: 10 }, 'permission'], [{ code: 200 }, 'permission'], [{ code: 100, message: 'Unsupported get request. Object with ID act_1 does not exist' }, 'account'], [{ code: 2 }, 'temporary']]) {
    const e = classifyMetaError({ ...err, message: err.message || 'raw meta text SECRET' });
    if (e.kind !== kind || /SECRET|raw meta/.test(e.message)) bad.push(`classify ${err.code} → ${e.kind}`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'CTR/CPC/CPM/CPA/ROAS from sums; zero spend → ROAS "—"; spend without purchases → ROAS 0, CPA "—"; never NaN/Infinity; omni_purchase not summed with pixel; missing actions = 0; custom ranges validated; 8 Meta error codes mapped, no raw text';
});

await step('marketing: Meta client — Bearer header, appsecret_proof, cursor pagination, malformed, timeout, token never logged', async () => {
  const bad = []; const logs = []; const log = { error: (...a) => logs.push(a.join(' ')) };
  const TOKEN = 'unit-token-NEVER-LEAK-77'; const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fake = (handler) => async (url, opts) => { calls.push({ url, auth: opts.headers.Authorization }); return handler(new URL(url)); };
  let c = createMetaClient({ token: TOKEN, appSecret: 'sek', fetchImpl: fake((u) => (u.searchParams.get('after') ? reply(200, { data: [{ id: 2 }] }) : reply(200, { data: [{ id: 1 }], paging: { cursors: { after: 'A' }, next: 'https://x/?access_token=LEAK' } }))), log });
  const l = await c.list('act_1/campaigns', { fields: 'id' });
  const proof = nodeCrypto.createHmac('sha256', 'sek').update(TOKEN).digest('hex');
  if (l.rows.length !== 2 || l.truncated) bad.push('pagination');
  if (calls.some((x) => x.url.includes(TOKEN) || x.url.includes('LEAK')) || calls.some((x) => x.auth !== `Bearer ${TOKEN}`) || !calls.every((x) => x.url.includes(`appsecret_proof=${proof}`))) bad.push('auth/proof/url');
  if (!calls.every((x) => x.url.startsWith('https://graph.facebook.com/v25.0/'))) bad.push('version/host');
  c = createMetaClient({ token: TOKEN, fetchImpl: fake(() => reply(200, { data: 'nope' })), log });
  await expectErr('malformed list', () => c.list('act_1/campaigns'), (e) => e.kind === 'bad_response');
  c = createMetaClient({ token: TOKEN, fetchImpl: fake(() => reply(400, { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}`, fbtrace_id: 'T1' } })), log });
  await expectErr('token error', () => c.call('act_1'), (e) => e.kind === 'token' && !e.message.includes(TOKEN));
  c = createMetaClient({ token: TOKEN, fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, log });
  await expectErr('timeout', () => c.call('act_1'), (e) => e.kind === 'timeout' && e.retryable);
  c = createMetaClient({ token: TOKEN, fetchImpl: fake(() => reply(500, { error: { code: 1 } })), log });
  await expectErr('5xx', () => c.call('act_1'), (e) => e.kind === 'temporary');
  c = createMetaClient({ token: TOKEN, fetchImpl: fake(() => reply(400, { error: { code: 17, message: 'User request limit reached' } })), log });
  await expectErr('rate limit', () => c.call('act_1'), (e) => e.kind === 'rate_limit' && e.status === 503);
  if (logs.some((x) => x.includes(TOKEN) || x.includes('sek'))) bad.push('token or secret logged');
  if (!logs.some((x) => /code=190/.test(x) && /trace=T1/.test(x))) bad.push('diagnostics not logged');
  if (bad.length) throw new Error(bad.join(' | '));
  return `token only in Authorization: Bearer; appsecret_proof = HMAC(token, secret); v25.0; 2 pages via cursors (paging.next with a token never followed); malformed/190/timeout/5xx/17 classified; ${logs.length} log lines, none containing token or secret, with code and fbtrace_id`;
});

await step('marketing: cache — repeat requests cached, concurrent requests share one call, expiry, stale-if-error, refresh floor', async () => {
  const bad = []; let t = 1_000_000; const clock = () => t; let calls = 0; let fail = false;
  const cache = createCache({ now: clock });
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new MetaError('rate_limit', 'Meta is limiting requests right now.', { status: 503 }); return { v: calls }; };
  const [a, b] = await Promise.all([cache.get('k', 45000, loader), cache.get('k', 45000, loader)]);
  if (calls !== 1 || a.data.v !== 1 || b.data.v !== 1) bad.push(`in-flight sharing (${calls} calls)`);
  t += 10000; const c = await cache.get('k', 45000, loader);
  if (calls !== 1 || !c.cached || c.stale) bad.push('not served from cache');
  t += 5000; await cache.get('k', 45000, loader, { force: true });
  if (calls !== 2) bad.push('refresh after 15 s did not refetch');
  await cache.get('k', 45000, loader, { force: true });
  if (calls !== 2) bad.push('refresh within 10 s hit Meta');
  t += 46000; const d = await cache.get('k', 45000, loader);
  if (calls !== 3 || d.stale) bad.push('expiry');
  fail = true; t += 46000; const e = await cache.get('k', 45000, loader);
  if (!e.stale || e.error?.kind !== 'rate_limit' || e.data.v !== 3) bad.push(`stale-if-error ${JSON.stringify(e)}`);
  t += 25 * 3600 * 1000;
  await expectErr('too old to serve', () => cache.get('k', 45000, loader), (err) => err.kind === 'rate_limit');
  await expectErr('nothing cached', () => cache.get('other', 45000, loader), (err) => err.kind === 'rate_limit');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'two concurrent → 1 call; within TTL cached; manual refresh ignored under 10 s, honoured after; expiry refetches; Meta failure → last good data marked stale with the reason; > 24 h old or nothing cached → error';
});

await step('marketing: freshness classification and the ad account\'s "today" (IST midnight boundary)', async () => {
  const bad = [];
  const now = new Date('2026-10-06T19:00:00Z'); // 00:30 IST on 7 Oct; still 6 Oct in UTC
  const live = (inp, tz = 'Asia/Kolkata') => rangeParams(inp, now, tz).live;
  const want = [[{ range: 'today' }, true], [{ range: 'yesterday' }, false], [{ range: 'last_7d' }, false], [{ range: 'last_30d' }, false], [{ range: 'this_month' }, true],
    [{ range: 'custom', since: '2026-10-01', until: '2026-10-07' }, true], [{ range: 'custom', since: '2026-10-01', until: '2026-10-06' }, false]];
  for (const [inp, w] of want) if (live(inp) !== w) bad.push(`${inp.range}${inp.until ? ` → ${inp.until}` : ''}: live=${live(inp)}`);
  // Presets are sent unchanged.
  if (rangeParams({ range: 'last_7d' }, now).params.date_preset !== 'last_7d' || rangeParams({ range: 'last_30d' }, now).params.date_preset !== 'last_30d') bad.push('presets changed');
  // The account's date, not UTC: at 00:30 IST it is already 7 Oct in India and still 6 Oct in Los Angeles.
  if (todayIn('Asia/Kolkata', now) !== '2026-10-07' || now.toISOString().slice(0, 10) !== '2026-10-06' || todayIn('America/Los_Angeles', now) !== '2026-10-06') bad.push('todayIn');
  try { rangeParams({ range: 'custom', since: '2026-10-01', until: '2026-10-07' }, now, 'America/Los_Angeles'); bad.push('LA account accepted IST today'); } catch (e) { if (e.status !== 400) bad.push('LA future'); }
  // TTLs follow: live 45 s, closed 10 min — through the service, with a counting fake Meta.
  let calls = 0; let t = Date.parse('2026-10-06T19:00:00Z');
  const fetchImpl = async (url) => { calls += 1; const u = new URL(url);
    if (u.pathname.endsWith('act_1')) return { ok: true, status: 200, json: async () => ({ name: 'A', currency: 'INR', timezone_name: 'Asia/Kolkata' }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const svc = createMetaService({ config: metaConfig({ META_ACCESS_TOKEN: 'x', META_AD_ACCOUNT_ID: '1' }), fetchImpl, now: () => t, log: { error() {} } });
  await svc.summary({ range: 'last_7d' }); const afterFirst = calls;
  t += 5 * 60 * 1000; await svc.summary({ range: 'last_7d' });
  if (calls !== afterFirst) bad.push('closed range refetched within 10 min');
  t += 6 * 60 * 1000; await svc.summary({ range: 'last_7d' });
  if (calls === afterFirst) bad.push('closed range never expired');
  const c0 = calls; await svc.summary({ range: 'today' }); t += 50 * 1000; await svc.summary({ range: 'today' });
  if (calls - c0 !== 2) bad.push(`today TTL (calls ${calls - c0})`);
  // Custom ending the account's today is live through the service (uses the account timezone).
  const cust = await svc.summary({ range: 'custom', since: '2026-10-01', until: '2026-10-07' });
  if (!cust.data || cust.data.range !== 'custom:2026-10-01:2026-10-07') bad.push('custom ending IST today refused');
  // The page agrees: no 60 s refresh for closed ranges, and the picker uses the account's date.
  const ui = await fsp.readFile(new URL('../public/marketing.js', import.meta.url), 'utf8');
  if (!/const LIVE_RANGES = new Set\(\['today', 'this_month'\]\)/.test(ui) || !/state\.until === accountToday\(\)/.test(ui) || /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(ui)) bad.push('page live set / picker date');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Today, This month, custom ending today → live; Yesterday, Last 7, Last 30, custom ending yesterday → closed; presets unchanged; at 00:30 IST "today" is 7 Oct for an IST account (6 Oct in UTC/LA); closed cached 10 min, live 45 s; page uses the same rules and the account date';
});

await step('marketing: one purchase type for count and value; unified attribution on every Insights call', async () => {
  const bad = [];
  const row = (actions, action_values) => rawFromRow({ spend: '100', impressions: '1000', clicks: '10', actions, action_values });
  const A = (t, v) => ({ action_type: t, value: String(v) });
  let r = row([A('omni_purchase', 4), A('offsite_conversion.fb_pixel_purchase', 4)], [A('omni_purchase', 400), A('offsite_conversion.fb_pixel_purchase', 400)]);
  if (r.purchaseType !== 'omni_purchase' || r.purchases !== 4 || r.value !== 400) bad.push(`both ${JSON.stringify(r)}`);
  r = row([A('offsite_conversion.fb_pixel_purchase', 3)], [A('offsite_conversion.fb_pixel_purchase', 300)]);
  if (r.purchaseType !== 'offsite_conversion.fb_pixel_purchase' || r.purchases !== 3 || r.value !== 300) bad.push('fallback');
  // Lists differ: count has omni, value only pixel → both from omni (value 0), never mixed.
  r = row([A('omni_purchase', 2)], [A('offsite_conversion.fb_pixel_purchase', 250)]);
  if (r.purchaseType !== 'omni_purchase' || r.purchases !== 2 || r.value !== 0) bad.push(`mixed ${JSON.stringify(r)}`);
  r = row([A('purchase', 5)], [A('omni_purchase', 500), A('purchase', 480)]);
  if (r.purchaseType !== 'omni_purchase' || r.purchases !== 0 || r.value !== 500) bad.push('omni only in values');
  r = row(undefined, undefined);
  if (r.purchaseType !== null || r.purchases !== 0 || r.value !== 0) bad.push('missing');
  r = row([A('omni_purchase', 3)], [A('omni_purchase', 0)]);
  const m = metricsFrom(r);
  if (r.value !== 0 || m.roas !== 0 || m.cpa !== 100 / 3) bad.push('zero value');
  if (resolvePurchaseType([A('link_click', 9)], [A('link_click', 9)]) !== null) bad.push('non-purchase type used');
  // Attribution: every Insights request carries use_unified_attribution_setting=true.
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); const u = new URL(url);
    if (u.pathname.endsWith('act_1')) return { ok: true, status: 200, json: async () => ({ name: 'A', currency: 'INR', timezone_name: 'Asia/Kolkata' }) };
    if (u.pathname.endsWith('/111')) return { ok: true, status: 200, json: async () => ({ id: '111', name: 'C', account_id: '1' }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const svc = createMetaService({ config: metaConfig({ META_ACCESS_TOKEN: 'x', META_AD_ACCOUNT_ID: '1' }), fetchImpl, log: { error() {} } });
  await svc.summary({ range: 'last_7d' }); await svc.level('campaign', { range: 'today' }); await svc.object('campaign', '111', { range: 'last_30d' }); await svc.level('adset', { range: 'today' }, { parent: { id: '111' } });
  const ins = urls.filter((u) => new URL(u).pathname.endsWith('/insights'));
  if (ins.length < 6 || ins.some((u) => new URL(u).searchParams.get('use_unified_attribution_setting') !== 'true')) bad.push(`attribution on ${ins.filter((u) => u.includes('use_unified_attribution_setting=true')).length}/${ins.length}`);
  if (urls.filter((u) => !new URL(u).pathname.endsWith('/insights')).some((u) => u.includes('use_unified'))) bad.push('attribution sent to non-Insights calls');
  if (bad.length) throw new Error(bad.join(' | '));
  return `omni in both → omni; fallback only → fallback for both; lists differ → same type (value 0, never the other type); omni only in values → omni; missing → 0/0; zero value → ROAS 0; ${ins.length} Insights calls all with use_unified_attribution_setting=true, none on object calls`;
});

await step('marketing: failure backoff — one failure shared by all requests, no Meta calls during it, automatic recovery', async () => {
  const bad = []; let t = 5_000_000; let calls = 0; let failing = true;
  const cache = createCache({ now: () => t, backoffMs: 45000 });
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); if (failing) throw new MetaError('timeout', 'Meta did not answer in time.', { status: 503, retryable: true }); return { v: calls }; };
  // Warm one key, then let Meta fail.
  failing = false; await cache.get('a', 45000, loader); failing = true; t += 46000;
  // Concurrent requests (two keys) during the first failure: one call per key in flight, then the backoff is shared.
  const [x, y] = await Promise.all([cache.get('a', 45000, loader), cache.get('b', 45000, loader).catch((e) => e)]);
  const afterFail = calls;
  if (!x.stale || x.data.v !== 1 || !(y instanceof MetaError)) bad.push('first failure: stale for a, error for b');
  for (let i = 0; i < 10; i += 1) { await cache.get('a', 45000, loader); await cache.get('b', 45000, loader).catch(() => {}); await cache.get('c', 45000, loader, { force: true }).catch(() => {}); }
  if (calls !== afterFail) bad.push(`Meta called ${calls - afterFail}× during backoff`);
  const during = await cache.get('a', 45000, loader);
  if (!during.stale || during.error?.kind !== 'timeout') bad.push('stale data not marked delayed');
  if (!cache.backingOff()) bad.push('backoff not reported');
  // After the window: one retry; if Meta is back, everything recovers.
  t += 46000; failing = false;
  const back = await cache.get('a', 45000, loader);
  if (calls !== afterFail + 1 || back.stale || cache.backingOff()) bad.push('no recovery after backoff');
  if ((await cache.get('b', 45000, loader)).stale) bad.push('other key not recovered');
  // A bad request (our input) does not trigger a backoff.
  const c2 = createCache({ now: () => t }); let n2 = 0;
  await c2.get('k', 1, async () => { n2 += 1; throw new MetaError('bad_request', 'x', { status: 400 }); }).catch(() => {});
  await c2.get('k2', 1, async () => { n2 += 1; return 1; });
  if (n2 !== 2) bad.push('bad_request caused a backoff');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'first failure → last good data marked delayed (or the error if none); next 30 requests incl. other keys and forced refreshes → 0 Meta calls; after 45 s one retry and full recovery; input errors never back off';
});

await step('marketing: the Overview never waits for Meta (2 s budget), other departments unaffected', async () => {
  const bad = [];
  const session = { phone: '919000000304', isAdmin: true, caps: [...CAPABILITIES] };
  const slowFetch = async (url) => { await new Promise((r) => setTimeout(r, 4000)); const u = new URL(url);
    if (u.pathname.endsWith('act_1')) return { ok: true, status: 200, json: async () => ({ name: 'A', currency: 'INR', timezone_name: 'Asia/Kolkata' }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ spend: '50', impressions: '1000', clicks: '5' }] }) }; };
  const cfg = metaConfig({ META_ACCESS_TOKEN: 'x', META_AD_ACCOUNT_ID: '1' });
  try {
    _resetMetaService(createMetaService({ config: cfg, fetchImpl: slowFetch, log: { error() {} } }));
    const t0 = Date.now(); const ov = await overviewFor(session, { slaHours: 6 }); const took = Date.now() - t0;
    if (took > 3500) bad.push(`overview took ${took} ms with slow Meta`);
    if (!ov.sections.marketing?.pending) bad.push(`marketing not pending: ${JSON.stringify(ov.sections.marketing)}`);
    for (const k of ['logistics', 'inventory', 'support', 'hr', 'people']) if (!ov.sections[k]?.ok) bad.push(`${k} affected`);
    if (ov.attention.some((a) => a.dept === 'marketing')) bad.push('loading raised an alarm');
    // The slow fetch keeps going in the background and fills the cache: the next Overview is instant and complete.
    await new Promise((r) => setTimeout(r, 4500));
    const t1 = Date.now(); const ov2 = await overviewFor(session, { slaHours: 6 });
    if (Date.now() - t1 > 1500 || ov2.sections.marketing?.spend !== 50) bad.push(`second overview ${JSON.stringify(ov2.sections.marketing)}`);
    // Meta fast: the card appears normally on the first load.
    _resetMetaService(createMetaService({ config: cfg, fetchImpl: async (url) => slowFetch(url).then((r) => r) && { ok: true, status: 200, json: async () => (new URL(url).pathname.endsWith('act_1') ? { name: 'A', currency: 'INR' } : { data: [{ spend: '75', impressions: '1000', clicks: '5' }] }) }, log: { error() {} } }));
    const ov3 = await overviewFor(session, { slaHours: 6 });
    if (ov3.sections.marketing?.spend !== 75 || ov3.sections.marketing?.pending) bad.push('fast Meta not shown');
  } finally { _resetMetaService(null); }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Meta 4 s slow → Overview in < 3.5 s, Marketing "loading", logistics/inventory/support/hr/people intact, no alarm; the background fetch fills the shared cache so the next Overview is instant with the figures; fast Meta → card normally';
});

await step('marketing on the Admin Overview: same service and cache, account "today", same ROAS, every state; non-admins unchanged', async () => {
  const bad = [];
  const admin = { phone: '919000000304', isAdmin: true, caps: [...CAPABILITIES] };
  const cfg = metaConfig({ META_ACCESS_TOKEN: 'x', META_AD_ACCOUNT_ID: '1' });
  let t = Date.parse('2026-10-06T19:00:00Z'); let fail = false; const urls = [];
  const fetchImpl = async (url) => { urls.push(url); if (fail) return { ok: false, status: 500, json: async () => ({ error: { code: 2, message: 'x' } }) };
    const u = new URL(url);
    if (u.pathname.endsWith('act_1')) return { ok: true, status: 200, json: async () => ({ name: 'A', currency: 'INR', timezone_name: 'Asia/Kolkata', account_status: 1, spend_cap: '5000000', amount_spent: '1234567', balance: '99900' }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ spend: '200', impressions: '4000', clicks: '40', actions: [{ action_type: 'omni_purchase', value: '3' }], action_values: [{ action_type: 'omni_purchase', value: '700' }] }] }) }; };
  try {
    const svc = createMetaService({ config: cfg, fetchImpl, now: () => t, log: { error() {} } });
    _resetMetaService(svc);
    // The page's numbers first (warms the shared cache); the Overview then makes no Meta call of its own.
    const page = await svc.summary({ range: 'today' });
    const before = urls.length;
    const ov = (await overviewFor(admin, { slaHours: 6 })).sections.marketing;
    if (urls.length !== before + 1 || !new URL(urls.at(-1)).pathname.endsWith('act_1')) bad.push(`overview made ${urls.length - before} calls (only the cached-30-min account read allowed)`);
    // Same ROAS as the page: both are metricsFrom over the same raw sums.
    const expectRoas = metricsFrom(rawFromRow({ spend: '200', impressions: '4000', clicks: '40', actions: [{ action_type: 'omni_purchase', value: '3' }], action_values: [{ action_type: 'omni_purchase', value: '700' }] })).roas;
    if (ov.roas !== page.data.totals.roas || ov.roas !== expectRoas || ov.roas !== 3.5) bad.push(`roas ${ov.roas} vs page ${page.data.totals.roas}`);
    if (ov.spend !== 200 || ov.revenue !== 700 || ov.purchases !== 3 || ov.stale || ov.pending || !ov.fetched_at) bad.push(`card ${JSON.stringify(ov)}`);
    // "Today" is Meta's (the account's timezone): date_preset=today, never a computed UTC/IST date; the card names the zone.
    const tq = new URL(urls.find((u) => u.includes('/insights'))).searchParams;
    if (tq.get('date_preset') !== 'today' || tq.get('time_range') || ov.timezone !== 'Asia/Kolkata') bad.push('today not the account\'s');
    // Funds: never fabricated, even with spend cap, amount spent and balance present.
    if (ov.available_funds !== null) bad.push('available funds fabricated on the card');
    const acct = (await svc.account()).data.billing;
    if (acct.availableFunds !== null || acct.availableFundsSupported !== false || acct.spendCap !== 50000 || acct.amountSpent !== 12345.67 || acct.statusLabel !== 'Active') bad.push(`billing ${JSON.stringify(acct)}`);
    const af = new URL(urls.find((u) => new URL(u).pathname.endsWith('act_1'))).searchParams.get('fields');
    if (/funding_source|balance/.test(af) || !/spend_cap/.test(af) || !/amount_spent/.test(af)) bad.push(`account fields ${af}`);
    if (billingFrom({ spend_cap: '0' }, 'INR').spendCap !== null || billingFrom({ amount_spent: '500' }, 'JPY').amountSpent !== 500 || billingFrom({}, 'INR').amountSpent !== null) bad.push('billingFrom');
    const ui = await fsp.readFile(new URL('../public/marketing.js', import.meta.url), 'utf8');
    if (!ui.includes('Not available from Meta') || /spendCap\s*-\s*|-\s*b\.amountSpent/.test(ui) || !/b\.availableFundsSupported && b\.availableFunds !== null/.test(ui)) bad.push('page funds display');
    // Cached: within 45 s a second Overview is served from the cache (no insights call).
    t += 20 * 1000; const n1 = urls.length; await overviewFor(admin, { slaHours: 6 });
    if (urls.slice(n1).some((u) => u.includes('/insights'))) bad.push('cache not used');
    // Data delayed: after the TTL Meta fails → last good data, stale; header says Data delayed.
    t += 60 * 1000; fail = true;
    const st = (await overviewFor(admin, { slaHours: 6 })).sections.marketing;
    if (!st.stale || st.spend !== 200) bad.push(`delayed ${JSON.stringify(st)}`);
    // Unavailable: nothing cached and Meta failing.
    _resetMetaService(createMetaService({ config: cfg, fetchImpl, now: () => t, log: { error() {} } }));
    const un = (await overviewFor(admin, { slaHours: 6 })).sections.marketing;
    if (!un.unavailable || !un.message || un.spend !== undefined) bad.push(`unavailable ${JSON.stringify(un)}`);
    // Not connected: no Meta call at all.
    const n2 = urls.length;
    _resetMetaService(createMetaService({ config: metaConfig({}), fetchImpl, log: { error() {} } }));
    const nc = (await overviewFor(admin, { slaHours: 6 })).sections.marketing;
    if (nc.configured !== false || urls.length !== n2) bad.push('not connected');
    // Non-admins: no Marketing section, nothing else changes.
    const logi = { phone: '919000000305', isAdmin: false, caps: CAPABILITIES.filter((c) => c !== 'marketing.view') };
    const lo = await overviewFor(logi, { slaHours: 6 });
    if (lo.sections.marketing !== undefined || urls.length !== n2) bad.push('non-admin saw marketing');
    // Header word per state (page code).
    const ov2 = await fsp.readFile(new URL('../public/overview.js', import.meta.url), 'utf8');
    for (const w of ["'Not connected'", "'Loading'", "'Unavailable'", "'Data delayed'", "'Live'"]) if (!ov2.includes(w)) bad.push(`state ${w}`);
    // Reporting day = the account's zone; displayed times = IST (absolute times only via istDateTime).
    if (!ui.includes("Reporting day follows Meta's ad account timezone") || !ui.includes('Times shown in IST') || ui.includes("Days follow the ad account's timezone")) bad.push('page timezone wording');
    if (!/istDateTime\(s\.fetched_at\)/.test(ov2) || !ov2.includes("from './ui/ist.js'")) bad.push('overview card absolute time not IST');
    for (const src of [ui, ov2]) if (/toLocale(Date|Time)?String\([^)]*\)/.test(src.replace(/timeZone: 'UTC'/g, '')) && /toLocaleTimeString/.test(src)) bad.push('non-IST time formatting');
  } finally { _resetMetaService(null); }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Overview reuses the page\'s cached summary (0 extra Insights calls); ROAS 3.50× = page = metricsFrom; Meta date_preset=today, zone shown; cached within 45 s; Data delayed / Unavailable / Not connected (0 Meta calls); available funds null (no field, never cap − spend); billing = status, spend cap, amount spent; non-admins get no Marketing section';
});

await step('marketing: live server — admin only, read-only, real numbers through the stub, no secrets in responses or logs', async () => {
  const bad = []; const TOKEN = 'test-meta-token-NEVER-LEAK-9f3a';
  HRS.meta.mode = 'ok'; HRS.meta.calls = [];
  for (const [who, p, want] of [['mgr', '/api/marketing/status', 403], ['multi', '/api/marketing/summary', 403], ['nonHr', '/api/marketing/campaigns', 403], ['', '/api/marketing/status', 401],
    ['mgr', '/marketing', 302], ['adm', '/marketing', 200]]) {
    const r = await internal(who || null, 'GET', p);
    if (r.status !== want) bad.push(`${who || 'anon'} ${p}: ${r.status} ≠ ${want}`);
  }
  if ((await internal('adm', 'POST', '/api/marketing/summary', {})).status !== 405 || (await internal('adm', 'PATCH', '/api/marketing/campaigns/111', {})).status !== 405) bad.push('write accepted');
  if ((await careers('GET', '/api/marketing/status', { cookieAs: 'adm' })).status !== 404 || (await careers('GET', '/marketing', { cookieAs: 'adm' })).status !== 404) bad.push('careers host');
  const st = await internal('adm', 'GET', '/api/marketing/status');
  if (!st.body.configured || st.body.account?.name !== 'Briyo Test Ads' || st.body.version !== 'v25.0' || !st.body.signed || st.body.roasTarget !== 2.5) bad.push(`status ${JSON.stringify(st.body)}`);
  const sum = await internal('adm', 'GET', '/api/marketing/summary?range=today');
  const t = sum.body.totals;
  if (t?.purchases !== 10 || t.revenue !== 3501.75 || Math.abs(t.roas - 3501.75 / 1000.5) > 1e-9 || t.reach !== 14000 || !sum.body.fetchedAt || sum.body.stale !== false || sum.body.trend.length !== 0) bad.push(`summary ${JSON.stringify(sum.body)}`);
  const week = await internal('adm', 'GET', '/api/marketing/summary?range=last_7d');
  if (week.body.trend?.length !== 2 || week.body.trend[1].roas !== 2101.75 / 600.5) bad.push('trend');
  const camp = await internal('adm', 'GET', '/api/marketing/campaigns?range=today');
  const names = (camp.body.rows || []).map((r) => `${r.name}:${r.delivered}:${r.status}`).join(',');
  if (names !== 'Prospecting:true:ACTIVE,Old Archived:true:ARCHIVED,Retargeting:false:PAUSED' || camp.body.rows[1].roas !== 0) bad.push(`campaigns ${names}`);
  // Cached: the same request again makes no Meta call.
  const before = HRS.meta.calls.length;
  await internal('adm', 'GET', '/api/marketing/summary?range=today');
  if (HRS.meta.calls.length !== before) bad.push('repeat request reached Meta');
  // Token only in the Authorization header; proof present; never followed paging.next.
  if (HRS.meta.calls.some((c) => c.url.includes(TOKEN) || c.url.includes('SHOULD-NOT')) || HRS.meta.calls.some((c) => c.auth !== `Bearer ${TOKEN}` || !c.proof)) bad.push('token transport');
  if (HRS.meta.calls.filter((c) => c.path.endsWith('/insights')).some((c) => !c.url.includes('use_unified_attribution_setting=true'))) bad.push('insights without unified attribution');
  // Overview: Marketing card from the same cache.
  const ov = (await internal('adm', 'GET', '/api/overview')).body.sections.marketing;
  if (!ov?.configured || ov.spend !== 1000.5 || ov.purchases !== 10 || HRS.meta.calls.length !== before) bad.push(`overview ${JSON.stringify(ov)}`);
  // Meta refuses the token: actionable message, no raw Meta text, logged with code only.
  HRS.meta.mode = 'token';
  const err = await internal('adm', 'GET', '/api/marketing/summary?range=yesterday');
  if (err.status !== 502 || err.body.kind !== 'token' || /secret detail|OAuthException/.test(JSON.stringify(err.body))) bad.push(`token error ${err.status} ${JSON.stringify(err.body)}`);
  HRS.meta.mode = 'ok';
  const everything = JSON.stringify([st.body, sum.body, week.body, camp.body, ov, err.body]);
  if (everything.includes(TOKEN) || everything.includes('test-meta-app-secret')) bad.push('secret in a response');
  await new Promise((r) => setTimeout(r, 200));
  if (HRS.log.includes(TOKEN) || HRS.log.includes('test-meta-app-secret')) bad.push('secret in server log');
  if (!/Meta .*token code=190/.test(HRS.log)) bad.push('token failure not logged for diagnosis');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'non-admins 403, signed out 401, page admin-only, POST/PATCH 405, careers host 404; account + today totals (omni purchases 10, Meta ROAS 3.50×, reach), 7-day trend, campaigns incl. paginated paused one and archived delivery; repeat served from cache; Overview card from the same cache; token error → actionable 502; token and app secret in no response and no log line';
});

await step('hr cleanup', async () => {
  if (HRS.server) { HRS.server.kill(); await new Promise((r) => HRS.server.once('exit', r)); }
  if (HRS.stub) HRS.stub.close();
  if (HRS.metaStub) HRS.metaStub.close();
  const { jobs } = await purgeTestHr(HRT);
  await getPool().query(`DELETE FROM hr_candidates c WHERE email LIKE 'dbcheck-hr-%' AND NOT EXISTS (SELECT 1 FROM hr_applications a WHERE a.candidate_id = c.id)`);
  await hrCleanMembers();
  if (HRS.dir) await fsp.rm(HRS.dir, { recursive: true, force: true });
  const left = (await getPool().query(`SELECT (SELECT count(*) FROM hr_jobs WHERE title LIKE $1)::int + (SELECT count(*) FROM hr_candidates WHERE email LIKE 'dbcheck-hr-%')::int n`, [`${HRT}%`])).rows[0].n;
  if (left) throw new Error('HR test rows left');
  return `server stopped; ${jobs} test jobs and their candidates, applications, history, notes, events and files removed`;
});

console.log(failures === 0
  ? '\nAll checks passed. The database is wired up correctly.\n'
  : `\n${failures} check(s) FAILED — see above.\n`);

await getPool().end();
process.exit(failures === 0 ? 0 : 1);
