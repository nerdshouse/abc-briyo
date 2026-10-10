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
  addManualOrderLine, updateManualOrderLine, removeManualOrderLine, manualLineSkuOptions, matchManualOrderLine,
} from '../lib/orders.js';
import { saveUploadedDocument, router as ordersRouterForTest, destinationRouter as destinationRouterForTest } from '../lib/orders-routes.js';
import { planAmazon, readTable, previewAmazonImport, commitAmazonImport } from '../lib/amazon-import.js';
import { orderItems } from '../lib/orders.js';
import {
  ensureInventorySchema, createSku, updateSku, getSku, skuDetail, receiveInventory, adjustStock, transferStock, updateBatch,
  uploadBatchDocument, getBatchDocument, shipmentStock, reserveShipmentStock, releaseShipmentStock, dispatchShipmentStock,
  inventoryOverview, resolveSkuIds, purgeTestInventory, saveWarehouse, unmappedSkus, unmappedLinesWithoutCode, fefoSuggest,
  addPlatformMappings, removePlatformMapping, savePlatform, listPlatforms, splitPlatformCell, migrateLegacyAmazonSkus, mappingUsage,
  updateMappingUnits, unitsPerListingOf, getInventoryCutover, setInventoryCutover, isInventoryEligible,
} from '../lib/inventory.js';
import { planSkuSheet, previewSkuImport, commitSkuImport } from '../lib/sku-master-import.js';
import { createOutward, updateOutward, cancelOutward, issueOutward, recordOutwardReturn, closeOutward, listOutwards, getOutward, outwardReport, outwardStockOptions } from '../lib/stock-outward.js';
import { router as inventoryRouterForTest } from '../lib/inventory-routes.js';
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
import crypto from 'node:crypto';
import http from 'node:http';
import { ensureHrSchema, purgeTestHr, slugify, normalizePhone, removeResume, retryPendingRemovals, istDayKey, HR_TIMEZONE } from '../lib/hr.js';
import { jobPostingLd } from '../lib/careers-pages.js';
import nodeCrypto from 'node:crypto';
import { metricsFrom, rawFromRow, rangeParams, classifyMetaError, createMetaClient, createCache, MetaError, createMetaService, metaConfig, todayIn, resolvePurchaseType, _resetMetaService, billingFrom } from '../lib/meta-ads.js';
import { overviewFor, profileCompleteSql as profileCompleteSqlForTest } from '../lib/overview.js';
import { phone10, paymentOf, matchRecoveries, summarise, ensureRecoverySchema } from '../lib/recovery-verification.js';
import { ensureAffiliateSchema, newAffiliatePublicId, rateAt, getAffiliateSetting, setAffiliateSetting, purgeTestAffiliates, _resetAffiliateSchemaForTest, createAffiliate } from '../lib/affiliates.js';
import { receiveOrdersCreate, processWebhookDelivery, processPendingWebhooks, verifyWebhookHmac, ensureShopifyWebhookSchema } from '../lib/shopify-webhooks.js';
import { startIncrementalSync, shopifySyncStatus, cancelShopifySync, syncBusy, startFullHistorySync, fullHistoryStatus, grantedAccessScopes, hasReadAllOrders, _resetScopeCache, assertNoSyncRunning } from '../lib/shopify-orders.js';
import { createAmazonClient, amazonConfig, amazonConfigured, redact, ENDPOINTS, ORDERS_API_VERSION, LWA_TOKEN_URL, SEARCH_ORDERS_RATE } from '../lib/amazon-spapi.js';
import { mapAmazonOrder, runAmazonSync, startAmazonIncrementalSync, amazonSyncStatus, amazonSyncBusy, assertNoAmazonSyncRunning, sharedAmazonClient, _setSharedAmazonClientForTest } from '../lib/amazon-orders.js';
import { runShopifySync, mapShopifyOrder, shopifyPaymentMethod, shopifyPaymentStatus, shopifyOrdersStatus, pollShopifyOrdersOnce, ordersPollMinutes } from '../lib/shopify-orders.js';
import { ensureOrderFinancialSnapshotSchema, financialSnapshotFrom, recordFinancialSnapshot, addAmounts, FINANCIAL_TABLES } from '../lib/order-financial-snapshots.js';
import { SHOPIFY_MAX_QUERY_COST, SHOPIFY_ORDER_QUERIES, LIMITS as SHOPIFY_LIMITS, shopifyOrderQuery, estimateShopifyOrderQueryCost } from '../lib/shopify-order-queries.js';
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
  // Dispatched straight away, with no photo: accepted and stamped (photos are optional).
  const r0 = await createShipment({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-S2N`, courier_partner_id: dl.id,
    tracking_id: 'AWB-S2N', shipment_status: 'dispatched' }, { actor: ACTOR });
  const o0 = await getOrder(r0.orderId);
  if (o0.shipment_status !== 'dispatched' || !o0.dispatch_date) throw new Error('direct dispatch without a photo not stamped');
  if ((await orderDocuments(r0.orderId)).length) throw new Error('a document row was created without an upload');
  // The screen's way: saved as Packed, photo added, then Dispatched.
  const r = await createShipment({ ...R('zepto'), channel: 'zepto', source_order_id: `${TEST_ORDER}-S2`, courier_partner_id: dl.id,
    tracking_id: 'AWB-S2' }, { actor: ACTOR });
  await addPhoto(r.orderId);
  const sh = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const o = await getOrder(r.orderId);
  if (o.shipment_status !== 'dispatched' || !o.dispatch_date) throw new Error('dispatch not stamped');
  return 'missing fields refused; Dispatched without a photo accepted and stamped, no document row; with a photo, stamped';
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
await step('dispatch photo is optional: no image dispatches, image still works, no placeholder rows', async () => {
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  // No image: Packed → Dispatched → In transit → Delivered, same transitions as before.
  const n = await createShipment({ ...R('bigbasket'), channel: 'bigbasket', source_order_id: `${TEST_ORDER}-NP`, courier_partner_id: dl.id, tracking_id: 'AWB-NP' }, { actor: ACTOR });
  for (const to of ['dispatched', 'in_transit', 'delivered']) {
    const s0 = (await orderShipments(n.orderId))[0];
    await updateShipment(n.orderId, s0.id, { shipment_status: to }, { actor: ACTOR, version: s0.version });
  }
  const on = await getOrder(n.orderId);
  if (on.shipment_status !== 'delivered' || !on.dispatch_date || !on.delivered_at) throw new Error(`no-photo flow: ${on.shipment_status}`);
  if ((await orderDocuments(n.orderId)).length) throw new Error('placeholder document created');
  const np = (await listOrders({ q: 'AWB-NP' })).orders[0];
  if (np.dispatch_image_count !== 0) throw new Error('image count not 0');
  if (!(await orderEvents(n.orderId)).some((e) => e.event_type === 'shipment_status_changed')) throw new Error('status change not logged');
  // With an image: unchanged.
  const r = await createShipment({ ...R('bigbasket'), channel: 'bigbasket', source_order_id: `${TEST_ORDER}-PH`, courier_partner_id: dl.id, tracking_id: 'AWB-PH' }, { actor: ACTOR });
  let sh = (await orderShipments(r.orderId))[0];
  const docId = await addPhoto(r.orderId);
  await updateShipment(r.orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  // Removing the photo afterwards does not freeze the shipment in transit.
  await removeDocument(r.orderId, docId, { actor: ACTOR });
  sh = (await orderShipments(r.orderId))[0];
  await updateShipment(r.orderId, sh.id, { shipment_status: 'in_transit' }, { actor: ACTOR, version: sh.version });
  if ((await getOrder(r.orderId)).shipment_status !== 'in_transit') throw new Error('stuck');
  return 'no image → dispatched/in transit/delivered, stamped, logged, 0 document rows, image count 0, with an image → dispatched as before; removing it later blocks nothing';
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
await step('shared shipment: one status for all members; take an order out', async () => {
  const lead = (await shipmentMembers(sharedShip))[0].id;
  let sh = (await orderShipments(lead))[0];
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
  return 'one photo for the parcel; members show dispatched; detached order back on its own, history kept';
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
  // With no in-app shipment they are listed under "No shipment yet", not as Awaiting dispatch
  // (a marketplace order may have been fulfilled elsewhere).
  const waiting = await listOrders({ view: 'awaiting_dispatch', q: `${TEST_ORDER}-AMZ` });
  const none = await listOrders({ shipment: 'none', q: `${TEST_ORDER}-AMZ` });
  for (const o of [a, b, c]) {
    if (waiting.orders.some((x) => x.id === o.id) || !none.orders.some((x) => x.id === o.id)) throw new Error('no-shipment order listed as awaiting dispatch');
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
// The team's calendar day (IST), as the app decides expiry — the UTC day differs between 00:00 and 05:30 IST.
const dayOffset = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 86400000));
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
  // Single spaces are allowed (FORME COLLAGEN SINGLE SACHET); a double space, a tab or a stray symbol is not.
  for (const bad of [`${TS}  BAD`, `${TS}\tBAD`, `${TS} BAD!`]) await expectErr(`invalid code ${JSON.stringify(bad)}`, () => createSku({ sku: bad, product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('code change', () => updateSku(INV.b, { sku: 'OTHER' }, { actor: ACTOR }), (e) => e.status === 400);
  // An Amazon seller SKU cannot point at a second SKU, nor be another SKU's code.
  await expectErr('amazon clash', () => updateSku(INV.b, { amazon_seller_sku: `${TS}-D3-60` }, { actor: ACTOR }), (e) => e.status === 409);
  const after = (await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n;
  if (after !== before + 3) throw new Error('count');
  return '3 SKUs; duplicate, double space / tab / symbol, code change and Amazon-code clash refused';
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
  const mapsBefore = (await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n;
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
  // Manual-only mapping: an import never writes a mapping, whatever the title looks like.
  if ((await getPool().query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n !== mapsBefore) throw new Error('an import created a mapping');
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
  // No dispatch photo: stock rules are unchanged without one.
  let sh = (await orderShipments(INV.s1lead))[0];
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
await step('inventory: SKU codes with spaces (FORME COLLAGEN SINGLE SACHET) — trimmed, single spaces only, case-insensitive duplicates refused, searchable, import accepts them; existing codes unchanged', async () => {
  const bad = [];
  const code = `${TS} FORME COLLAGEN SINGLE SACHET`;
  const id = (await createSku({ sku: `  ${code}  `, product_name: 'Forme Collagen — single sachet', unit_type: 'sachet' }, { actor: ACTOR })).id;
  const s = await getSku(id);
  if (s.sku !== code || s.unit_type !== 'sachet') bad.push(`stored as ${JSON.stringify(s.sku)}`);
  await expectErr('double space', () => createSku({ sku: `${TS} H2LYTE  SINGLE SACHET`, product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 400 && /single spaces/.test(e.message));
  await expectErr('case-insensitive duplicate', () => createSku({ sku: code.toLowerCase(), product_name: 'x' }, { actor: ACTOR }), (e) => e.status === 409);
  for (const c of [`${TS} H2LYTE SINGLE SACHET`, `${TS} EASEN SINGLE SACHET`, `${TS} OPTIITAL OPAQUE 60 CAPSULES`]) {
    if (!(await createSku({ sku: c, product_name: c, unit_type: 'sachet' }, { actor: ACTOR })).id) bad.push(`not created ${c}`);
  }
  const ov = await inventoryOverview({ q: 'collagen single' });
  if (!ov.rows.some((r) => r.sku_id === id)) bad.push('search with a space does not find it');
  let plan; try { plan = planSkuSheet([['Briyo SKU', 'Product Name'], [`${TS} EASEN SINGLE SACHET X`, 'Easen sachet x']]); } catch (e) { plan = { err: e.message }; }
  if (plan.err || (plan.errors || []).some((e) => /not valid/.test(e.reason))) bad.push(`import refuses spaces ${JSON.stringify(plan).slice(0, 160)}`);
  // The code never changes on edit (no silent rename): asking to is refused, and nothing changes.
  await expectErr('rename', () => updateSku(id, { sku: 'RENAMED' }, { actor: ACTOR, version: s.version }), (e) => e.status === 400);
  if ((await getSku(id)).sku !== code) bad.push('code changed on edit');
  if (bad.length) throw new Error(bad.join(' | '));
  return `"${code}" stored trimmed as typed, unit sachet; double space 400; lower-case duplicate 409; three more sachet/capsule codes; "collagen single" finds it; import accepts spaces; rename refused, code unchanged`;
});

await step('inventory: nil stock and independent variants — 0 stays a number (out of stock), alternatives are links only (each keeps its own stock), shown for an out-of-stock SKU, self/duplicate links refused, no movement written', async () => {
  const bad = [];
  const db = getPool();
  const opaque = (await createSku({ sku: `${TS}-OPQ60`, product_name: 'Optiital', variant_name: 'Opaque — 60 capsules', unit_type: 'bottle' }, { actor: ACTOR })).id;
  const clear = (await createSku({ sku: `${TS}-TRN90`, product_name: 'Optiital', variant_name: 'Transparent — 90 capsules', unit_type: 'bottle' }, { actor: ACTOR })).id;
  await receiveInventory({ sku_id: clear, batch_number: 'TRN-1', expiry_date: dayOffset(400), quantity: 150, request_id: rid() }, { actor: ACTOR });
  const IB = await import('../lib/inventory-inbound.js');
  const mv0 = (await db.query('SELECT count(*)::int n FROM inventory_movements')).rows[0].n;
  await IB.addAlternative(opaque, { alternative_sku_id: clear, note: 'Same formula, larger pack' }, { actor: ACTOR });
  await expectErr('self link', () => IB.addAlternative(opaque, { alternative_sku_id: opaque }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('duplicate link', () => IB.addAlternative(opaque, { alternative_sku_id: clear }, { actor: ACTOR }), (e) => e.status === 409);
  if ((await db.query('SELECT count(*)::int n FROM inventory_movements')).rows[0].n !== mv0) bad.push('a link wrote a movement');
  const o = await getSku(opaque); const c = await getSku(clear);
  if (o.available !== 0 || typeof o.available !== 'number' || !o.out_of_stock || c.available !== 150 || c.out_of_stock) bad.push(`stock ${o.available}/${c.available}`);
  const ov = await inventoryOverview({ q: `${TS}-OPQ60` });
  const row = ov.rows.find((r) => r.sku_id === opaque);
  if (!row?.empty || row.sku_available !== 0 || row.alternatives?.[0]?.sku_id !== clear || row.alternatives[0].available !== 150) bad.push(`overview ${JSON.stringify(row).slice(0, 200)}`);
  const d = await skuDetail(opaque);
  if (d.alternatives.length !== 1 || d.alternatives[0].available !== 150 || d.alternatives[0].note !== 'Same formula, larger pack') bad.push('detail alternatives');
  const ovc = await inventoryOverview({ q: `${TS}-TRN90` });
  if (ovc.rows.some((r) => r.alternatives?.length)) bad.push('in-stock SKU shows alternatives');
  await IB.removeAlternative(d.alternatives[0].id, { actor: ACTOR });
  if ((await skuDetail(opaque)).alternatives.length) bad.push('not removed');
  INV.opaque = opaque; INV.clear = clear;
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Opaque 60: available 0 (number), out of stock; Transparent 90: 150, in stock — never shared; link Opaque → Transparent shown on the out-of-stock row with 150 available, not on the in-stock one; self 400, duplicate 409; no movement; removable (audited)';
});

await step('inventory: returns — sellable into its batch (available +n), damaged/quarantined into a held batch (on hand +n, available unchanged), expired batch refused for sellable, same reference needs a reason, retries are no-ops, append-only', async () => {
  const bad = [];
  const db = getPool();
  const IB = await import('../lib/inventory-inbound.js');
  const sku = (await createSku({ sku: `${TS}-RET`, product_name: 'Return test', unit_type: 'bottle' }, { actor: ACTOR })).id;
  const good = (await receiveInventory({ sku_id: sku, batch_number: 'RET-A', expiry_date: dayOffset(300), quantity: 20, request_id: rid() }, { actor: ACTOR })).batchId;
  const old = (await receiveInventory({ sku_id: sku, batch_number: 'RET-OLD', expiry_date: dayOffset(30), quantity: 5, request_id: rid() }, { actor: ACTOR })).batchId;
  const st = async () => { const s = await getSku(sku); return { on: s.on_hand, av: s.available, q: s.quarantined, b: s.blocked }; };
  const base = { sku_id: sku, source: 'customer', returned_by: 'Riya S.', reason: 'Wrong flavour ordered' };
  const s0 = await st();
  const req = rid();
  const r1 = await IB.recordReturn({ ...base, quantity: 3, condition: 'sellable', batch_id: good, reference: 'ORD-1001', request_id: req, remarks: 'Seal intact' }, { actor: ACTOR });
  const again = await IB.recordReturn({ ...base, quantity: 3, condition: 'sellable', batch_id: good, reference: 'ORD-1001', request_id: req }, { actor: ACTOR });
  const s1 = await st();
  if (s1.on !== s0.on + 3 || s1.av !== s0.av + 3 || !again.repeated || again.returnId !== r1.returnId) bad.push(`sellable ${JSON.stringify([s0, s1, again])}`);
  await expectErr('same reference without confirming', () => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: good, reference: 'ord-1001', request_id: rid() }, { actor: ACTOR }), (e) => e.status === 409 && e.duplicate);
  await expectErr('confirmed without a reason', () => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: good, reference: 'ORD-1001', confirm_duplicate: true, request_id: rid() }, { actor: ACTOR }), (e) => e.status === 400);
  await IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: good, reference: 'ORD-1001', confirm_duplicate: true, duplicate_reason: 'Second parcel from the same order', request_id: rid() }, { actor: ACTOR });
  const s2 = await st();
  const dmg = await IB.recordReturn({ ...base, quantity: 2, condition: 'damaged', batch_id: good, source: 'courier_rto', returned_by: 'Delhivery', reason: 'Crushed in transit', request_id: rid() }, { actor: ACTOR });
  const qr = await IB.recordReturn({ ...base, quantity: 4, condition: 'quarantined', source: 'retailer', returned_by: 'Medkart Vadodara', reason: 'Storage temperature unknown', request_id: rid() }, { actor: ACTOR });
  const s3 = await st();
  if (s3.on !== s2.on + 6 || s3.av !== s2.av || s3.b !== s2.b + 2 || s3.q !== s2.q + 4) bad.push(`held ${JSON.stringify([s2, s3])}`);
  const hb = (await db.query(`SELECT batch_number, status, expiry_date::text e FROM inventory_batches WHERE id = ANY($1) ORDER BY id`, [[dmg.batchId, qr.batchId]])).rows;
  if (hb[0].status !== 'blocked' || !hb[0].batch_number.startsWith('RET-A-RET') || hb[0].e !== dayOffset(300) || hb[1].status !== 'quarantined' || !hb[1].batch_number.startsWith('UNKNOWN-RET') || hb[1].e !== null) bad.push(`held batches ${JSON.stringify(hb)}`);
  // An expired batch never takes sellable units back.
  await db.query(`UPDATE inventory_batches SET expiry_date = $2 WHERE id = $1`, [old, dayOffset(-1)]);
  await expectErr('sellable into an expired batch', () => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: old, request_id: rid() }, { actor: ACTOR }), (e) => e.status === 409 && e.unsellable);
  await expectErr('another SKU\'s batch', () => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: INV.a1, request_id: rid() }, { actor: ACTOR }), (e) => e.status === 400);
  for (const [label, patch] of [['no returned_by', { returned_by: '' }], ['no reason', { reason: ' ' }], ['bad condition', { condition: 'fine' }], ['no batch for sellable', { batch_id: null }], ['zero', { quantity: 0 }], ['future date', { return_date: dayOffset(2) }]]) {
    await expectErr(label, () => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: good, request_id: rid(), ...patch }, { actor: ACTOR }), (e) => e.status === 400);
  }
  // Concurrent retries of one request: one return, one movement.
  const same = rid();
  const both = await Promise.allSettled([1, 2].map(() => IB.recordReturn({ ...base, quantity: 1, condition: 'sellable', batch_id: good, request_id: same }, { actor: ACTOR })));
  const n = (await db.query(`SELECT count(*)::int n FROM stock_returns WHERE request_key = $1`, [`return:${same}`])).rows[0].n;
  const m = (await db.query(`SELECT count(*)::int n FROM inventory_movements WHERE idempotency_key = $1`, [`return:${same}`])).rows[0].n;
  if (n !== 1 || m !== 1 || !both.some((x) => x.status === 'fulfilled')) bad.push(`concurrent retry: ${n} returns, ${m} movements`);
  await expectErr('append-only', () => db.query('UPDATE stock_returns SET quantity = 99 WHERE id = $1', [r1.returnId]), () => true);
  const list = await IB.listReturns({ skuId: sku });
  const types = (await db.query(`SELECT DISTINCT movement_type FROM inventory_movements WHERE reference_type = 'stock_return' AND sku_id = $1`, [sku])).rows.map((r) => r.movement_type);
  if (list.length !== 5 || JSON.stringify(types) !== '["customer_return"]' || !list.some((r) => r.remarks === 'Seal intact' && r.returned_by === 'Riya S.' && r.source === 'customer')) bad.push(`list ${list.length} ${types}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'sellable 3 → on hand +3, available +3; retry → same return; same reference 409 until confirmed with a reason; damaged 2 → blocked batch RET-A-RET<id> (dates copied), quarantined 4 (unknown source) → quarantined batch UNKNOWN-RET<id> (expiry unknown): on hand +6, available unchanged; expired batch / other SKU / missing fields / future date refused; two concurrent retries → 1 return, 1 movement; append-only; every return is one customer_return ledger row';
});

await step('inventory: expiry by batch — near expiry (≤ 90 days, configurable) orange, expired red, unknown expiry never guessed, boundaries on the IST day; expired never available', async () => {
  const bad = [];
  const sku = (await createSku({ sku: `${TS}-EXPST`, product_name: 'Expiry states' }, { actor: ACTOR })).id;
  const mk = async (bn, exp) => (await receiveInventory({ sku_id: sku, batch_number: bn, expiry_date: exp, quantity: 2, request_id: rid() }, { actor: ACTOR })).batchId;
  const ids = { d0: await mk('E-0', dayOffset(0)), d90: await mk('E-90', dayOffset(90)), d91: await mk('E-91', dayOffset(91)), past: await mk('E-PAST', dayOffset(400)), none: await mk('E-NONE', null) };
  await getPool().query('UPDATE inventory_batches SET expiry_date = $2 WHERE id = $1', [ids.past, dayOffset(-1)]);
  const states = async () => Object.fromEntries((await skuDetail(sku)).batches.map((b) => [b.batch_number, [b.expiry_state, b.available]]));
  let st = await states();
  const want = { 'E-0': 'near_expiry', 'E-90': 'near_expiry', 'E-91': 'ok', 'E-PAST': 'expired', 'E-NONE': 'unknown_expiry' };
  for (const [k, v] of Object.entries(want)) if (st[k][0] !== v) bad.push(`${k} ${st[k][0]} (want ${v})`);
  if (st['E-PAST'][1] !== 0 || st['E-0'][1] !== 2 || st['E-NONE'][1] !== 2) bad.push(`availability ${JSON.stringify(st)}`);
  const ov = await inventoryOverview({ q: `${TS}-EXPST` });
  if ((await inventoryOverview({ q: `${TS}-EXPST`, expiring: 'near' })).rows.length !== 2 || (await inventoryOverview({ q: `${TS}-EXPST`, expiring: 'unknown' })).rows.length !== 1 || !(ov.cards.nearExpiry >= 2) || ov.cards.nearExpiryDays !== 90) bad.push('filters/cards');
  process.env.INVENTORY_NEAR_EXPIRY_DAYS = '30';
  try { st = await states(); if (st['E-90'][0] !== 'ok' || st['E-0'][0] !== 'near_expiry') bad.push('threshold not configurable'); } finally { delete process.env.INVENTORY_NEAR_EXPIRY_DAYS; }
  process.env.INVENTORY_NEAR_EXPIRY_DAYS = 'banana';
  try { if ((await skuDetail(sku)).nearExpiryDays !== 90) bad.push('bad setting not ignored'); } finally { delete process.env.INVENTORY_NEAR_EXPIRY_DAYS; }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'IST today and +90 → near expiry, +91 → ok, yesterday → expired (0 available), no expiry → unknown (never guessed, still available); near/unknown filters and cards; INVENTORY_NEAR_EXPIRY_DAYS=30 moves +90 to ok; an invalid setting falls back to 90';
});

await step('inventory: incoming stock — expected never available, partial receipts wait for acceptance, accept/reject through the ledger once, status follows receipts, cancel only when nothing is pending, concurrent accepts write one movement', async () => {
  const bad = [];
  const db = getPool();
  const IB = await import('../lib/inventory-inbound.js');
  const sku = (await createSku({ sku: `${TS} H2LYTE INCOMING SACHET`, product_name: 'H2Lyte sachet', unit_type: 'sachet' }, { actor: ACTOR })).id;
  const av = async () => (await getSku(sku)).available;
  const inc = async (id) => IB.getIncoming(id);
  const one = (await IB.createIncoming({ sku_id: sku, expected_quantity: 100, expected_date: dayOffset(7), status: 'ordered', supplier_name: `${TS}-SUP`, reference: 'PO-77' }, { actor: ACTOR })).id;
  let ov = await inventoryOverview({ q: 'H2LYTE INCOMING' });
  if ((await av()) !== 0 || ov.rows[0]?.sku_incoming !== 100 || !ov.rows[0]?.out_of_stock || (await inventoryOverview({ q: 'H2LYTE INCOMING', stock: 'incoming' })).rows.length !== 1) bad.push(`expected counted as stock / not shown ${JSON.stringify(ov.rows[0]).slice(0, 160)}`);
  if (!ov.cards.unitTotals.sachet || ov.cards.unitTotals.sachet.incoming < 100) bad.push('sachet totals not kept apart');
  await IB.updateIncoming(one, { status: 'in_transit' }, { actor: ACTOR });
  const rq = rid();
  const rc1 = (await IB.recordReceipt(one, { quantity: 40, batch_number: 'H2-A', expiry_date: dayOffset(500), request_id: rq }, { actor: ACTOR })).receiptId;
  if ((await IB.recordReceipt(one, { quantity: 40, batch_number: 'H2-A', request_id: rq }, { actor: ACTOR })).receiptId !== rc1) bad.push('duplicate receipt');
  let i = await inc(one);
  if (i.status !== 'partially_received' || (await av()) !== 0 || i.receipts.length !== 1 || i.outstanding !== 100) bad.push(`after receipt: ${i.status} ${await av()} ${i.outstanding}`);
  await expectErr('stage change after arrival', () => IB.updateIncoming(one, { status: 'planned' }, { actor: ACTOR }), (e) => e.status === 409);
  const concurrent = await Promise.allSettled([1, 2].map(() => IB.decideReceipt(rc1, { decision: 'accept' }, { actor: ACTOR })));
  const mv = (await db.query(`SELECT count(*)::int n FROM inventory_movements WHERE idempotency_key = $1`, [`incoming-receipt:${rc1}`])).rows[0].n;
  i = await inc(one);
  if (mv !== 1 || (await av()) !== 40 || i.status !== 'partially_received' || i.outstanding !== 60 || !concurrent.every((x) => x.status === 'fulfilled')) bad.push(`accept: ${mv} movements, available ${await av()}, ${i.status}, outstanding ${i.outstanding}`);
  const rc2 = (await IB.recordReceipt(one, { quantity: 60, batch_number: 'H2-B', request_id: rid() }, { actor: ACTOR })).receiptId;
  if ((await inc(one)).status !== 'received_pending_acceptance' || (await av()) !== 40) bad.push('pending acceptance');
  await expectErr('partial accept without a reason', () => IB.decideReceipt(rc2, { decision: 'accept', accepted_quantity: 50 }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('accept more than arrived', () => IB.decideReceipt(rc2, { decision: 'accept', accepted_quantity: 61, note: 'x' }, { actor: ACTOR }), (e) => e.status === 400);
  await IB.decideReceipt(rc2, { decision: 'accept', accepted_quantity: 50, note: '10 sachets torn' }, { actor: ACTOR });
  i = await inc(one);
  const b = (await skuDetail(sku)).batches.find((x) => x.batch_number === 'H2-B');
  if (i.status !== 'accepted' || i.outstanding !== 0 || i.accepted_quantity !== 90 || i.rejected_quantity !== 10 || (await av()) !== 90 || b.expiry_state !== 'unknown_expiry' || i.open) bad.push(`final ${i.status} ${i.accepted_quantity}/${i.rejected_quantity} available ${await av()} ${b?.expiry_state}`);
  const again = await IB.decideReceipt(rc2, { decision: 'reject', note: 'late change of mind' }, { actor: ACTOR });
  if (!again.repeated || again.status !== 'accepted' || (await av()) !== 90) bad.push('decided twice');
  await expectErr('receipt on an accepted expectation', () => IB.recordReceipt(one, { quantity: 1, batch_number: 'H2-C' }, { actor: ACTOR }), (e) => e.status === 409);
  // Cancel: refused while a receipt waits; a rejection needs a reason; then cancelled, nothing in stock from it.
  const two = (await IB.createIncoming({ sku_id: sku, expected_quantity: 30 }, { actor: ACTOR })).id;
  const rc3 = (await IB.recordReceipt(two, { quantity: 30, batch_number: 'H2-D' }, { actor: ACTOR })).receiptId;
  await expectErr('cancel with a pending receipt', () => IB.cancelIncoming(two, { reason: 'supplier issue' }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('reject without a reason', () => IB.decideReceipt(rc3, { decision: 'reject' }, { actor: ACTOR }), (e) => e.status === 400);
  await IB.decideReceipt(rc3, { decision: 'reject', note: 'Wrong product delivered' }, { actor: ACTOR });
  const i2 = await inc(two);
  if (i2.status !== 'partially_received' && i2.status !== 'accepted') bad.push(`after reject ${i2.status}`);
  const three = (await IB.createIncoming({ sku_id: sku, expected_quantity: 25 }, { actor: ACTOR })).id;
  await IB.cancelIncoming(three, { reason: 'Order withdrawn' }, { actor: ACTOR });
  if ((await inc(three)).status !== 'cancelled' || (await inc(three)).outstanding !== 0 || (await av()) !== 90) bad.push('cancel');
  if ((await IB.cancelIncoming(three, { reason: 'again' }, { actor: ACTOR })).repeated !== true) bad.push('cancel not idempotent');
  for (const [label, input] of [['no SKU', { expected_quantity: 1 }], ['zero', { sku_id: sku, expected_quantity: 0 }], ['received stage', { sku_id: sku, expected_quantity: 1, status: 'accepted' }]]) {
    await expectErr(label, () => IB.createIncoming(input, { actor: ACTOR }), (e) => e.status === 400);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'expected 100 (ordered → in transit): available 0, shown as incoming 100 on an out-of-stock row (filter, sachet totals apart); receipt 40 → partially received, still 0 available; retry → same receipt; two concurrent accepts → 1 movement, 40 available, 60 outstanding; receipt 60 → pending acceptance; accept 50 (reason for the 10) → accepted, 90 available, unknown expiry kept unknown; deciding again → first decision; cancel refused while pending, rejection needs a reason, cancel idempotent';
});

await step('inventory: returns, incoming and alternatives keep the existing permissions (view reads; move records stock; catalog links variants) and the page shows Nil, expiry states as text, incoming apart, units never summed across types', async () => {
  const bad = [];
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use(express.json());
  app.use('/api/inventory', inventoryRouterForTest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/inventory`;
  const call = (method, path, caps, body) => fetch(`${base}${path}`, { method, headers: { 'x-test-session': JSON.stringify({ caps }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
  try {
    const V = ['inventory.view']; const M = ['inventory.view', 'inventory.move']; const C = ['inventory.view', 'inventory.catalog'];
    for (const p of ['/returns', '/incoming', '/incoming?open=1&receipts=1']) if (await call('GET', p, V) !== 200) bad.push(`viewer cannot read ${p}`);
    if (await call('GET', '/returns', ['logistics.view']) !== 403) bad.push('logistics-only reads returns');
    for (const [m, p] of [['POST', '/returns'], ['POST', '/incoming'], ['PATCH', '/incoming/1'], ['POST', '/incoming/1/cancel'], ['POST', '/incoming/1/receipts'], ['POST', '/incoming/receipts/1/decision'], ['POST', `/skus/${INV.opaque}/alternatives`], ['DELETE', '/alternatives/1']]) {
      if (await call(m, p, V, {}) !== 403) bad.push(`viewer ${m} ${p}`);
    }
    if (await call('POST', `/skus/${INV.opaque}/alternatives`, M, { alternative_sku_id: INV.clear }) !== 403) bad.push('an operator links variants (catalog only)');
    if (await call('POST', '/returns', C, {}) !== 403) bad.push('a catalog-only manager records stock');
    if (await call('POST', '/returns', M, {}) !== 400) bad.push('operator cannot reach returns');
  } finally { server.close(); }
  const js = await fsp.readFile(new URL('../public/inventory.js', import.meta.url), 'utf8');
  const html = await fsp.readFile(new URL('../public/inventory.html', import.meta.url), 'utf8');
  for (const t of ["const nil = (n) => (Number(n) === 0 ? '<span class=\"nil\">Nil</span>'", 'Near expiry · ', 'Unknown expiry', '>Expired</span>', '+${count(n)} incoming', 'Alternatives: ',
    'Units of different types are never added together.', "kind === 'stock-return'", "kind === 'incoming-new'", "kind === 'receipt'", "kind === 'decide'", "'/api/inventory/returns'", 'data-act="stock-return"'])
    if (!js.includes(t)) bad.push(`page missing ${t}`);
  if (/b\.days_to_expiry <= 90/.test(js)) bad.push('expiry threshold hard-coded in the page');
  for (const id of ['id="returnStock" type="button" data-cap="inventory.move"', 'id="incomingBtn" type="button" data-cap="inventory.move"', '<option value="near">Near expiry</option>', '<option value="unknown">Unknown expiry</option>', '<option value="incoming">Incoming</option>'])
    if (!html.includes(id)) bad.push(`html missing ${id}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'viewer reads returns/incoming, never writes (8 routes 403); logistics-only 403; operator records returns but cannot link variants; catalog-only cannot record stock; page: Nil for 0, near/expired/unknown labels, +N incoming, alternatives line, per-unit totals note, four new forms, buttons gated by inventory.move, near/unknown/incoming filters';
});

await step('design system and shell: documented tokens (weights, heights, focus, motion, module identity), module colours only on nav markers/icons/breadcrumbs, centred logo, honest presence (this session + browser online state, no heartbeat), reduced motion', async () => {
  const bad = [];
  const css = await fsp.readFile(new URL('../public/ui.css', import.meta.url), 'utf8');
  const comp = await fsp.readFile(new URL('../public/ui/components.js', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
  for (const t of ['--fw-medium', '--lh-body', '--h-control', '--h-row', '--drawer-w', '--focus-ring', '--dur', '--ease', '--mod-overview', '--mod-logistics', '--mod-inventory', '--mod-support', '--mod-marketing', '--mod-affiliates', '--mod-hr', '--mod-admin']) if (!root.includes(`${t}:`)) bad.push(`token ${t} missing`);
  for (const m of ['overview', 'logistics', 'inventory', 'support', 'marketing', 'affiliates', 'hr', 'admin']) if (!new RegExp(`\\[data-module="${m}"\\][^{]*\\{ --mod: var\\(--mod-${m}\\); \\}`).test(css)) bad.push(`module ${m} not mapped`);
  // Module colour never paints backgrounds, buttons or status.
  for (const m of css.matchAll(/([^{}]+)\{([^}]*var\(--mod\)[^}]*)\}/g)) {
    const sel = m[1].trim();
    // Allowed: nav items/markers, department icons, the breadcrumb icon. Never buttons, status, table rows, cards.
    if (/\.btn|\.status|\btr\b|tbody|\.card|\.badge/.test(sel) || (/background/.test(m[2]) && !/::before/.test(sel))) bad.push(`module colour used beyond markers: ${sel.slice(0, 60)}`);
  }
  if (!/\.sidebar \.brand \{[^}]*align-items: center/.test(css)) bad.push('logo not centred');
  if (!/function syncPresence\(\)/.test(comp) || !/'Active session' : 'Offline'/.test(comp) || !/addEventListener\('online', syncPresence\)/.test(comp)) bad.push('presence not honest');
  const presence = comp.slice(comp.indexOf('function syncPresence()'), comp.indexOf('function enhanceDrawers'));
  if (/setInterval|setTimeout|fetch\(|api\(/.test(presence)) bad.push('presence polls or calls the server');
  if (!/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation-duration: 0\.01ms/.test(css)) bad.push('no global reduced-motion rule');
  for (const [k, ico] of [['logistics', "'Logistics', 'truck'"], ['inventory', "'Inventory', 'boxes'"]]) if (!comp.includes(`'${k}') : ''}`)) bad.push(`ops nav ${k} has no module`);
  if (!(await fsp.readFile(new URL('../public/inventory.html', import.meta.url), 'utf8')).includes('data-section="inventory"')) bad.push('inventory page not in the inventory module');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'tokens for weights, leading, control/row heights, drawer widths, focus, motion and 8 module colours documented in :root; data-module / data-section map each module; colour only on the active marker, department icons and breadcrumb icon; logo centred; presence = "Active session" / "Offline" from this browser (no heartbeat); reduced motion collapses all motion';
});

await step('consistency and accessibility pass: no undefined CSS variables on shell pages, hard-coded tone/hover/focus colours tokenised, one focus ring for rows and menus, named inputs and icon links, Space opens rows, overdue counts in words, sign-out failure handled, loading rows that never stick, sync timers cleared on leave', async () => {
  const bad = [];
  const read = (f) => fsp.readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const ui = await read('ui.css'); const ord = await read('orders.css'); const ov = await read('overview.css');
  const defined = new Set([ui, ord, ov].flatMap((css) => [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
  for (const [f, css] of [['ui.css', ui], ['orders.css', ord], ['overview.css', ov]]) {
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) if (!defined.has(m[1]) && !/^--(ox|mk|bar|w)\b/.test(m[1])) bad.push(`${f}: var(${m[1]}) is not defined`);
    for (const hex of ['#FECDCA', '#FEDF89', '#ABEFC6', '#FCFCFD', '#C5CBD5']) {
      const n = (css.match(new RegExp(hex, 'gi')) || []).length - (f === 'ui.css' ? 1 : 0);
      if (n > 0) bad.push(`${f}: ${hex} hard-coded ${n}×`);
    }
  }
  if (/focus-visible \{ outline: 2px solid rgba\(32, 43, 60, \.25\)/.test(ui + ord)) bad.push('grey row focus ring left');
  if (!/\.popover button:focus-visible \{ box-shadow: inset 0 0 0 2px var\(--focus\); \}/.test(ui)) bad.push('menu items have no focus ring');
  const inv = await read('inventory.js'); const ojs = await read('orders.js'); const dash = await read('dashboard.js'); const comp = await read('ui/components.js');
  for (const id of ['altNote', 'newWh', 'newSup', 'newSupRef']) if (!new RegExp(`id="${id}"[^>]*aria-label=`).test(inv)) bad.push(`inventory #${id} unnamed`);
  for (const id of ['dAttachQ', 'dNewNum', 'dNewValue', 'dNote']) if (!new RegExp(`id="${id}"[^>]*aria-label=`).test(ojs)) bad.push(`orders #${id} unnamed`);
  if ((dash.match(/class="icon-btn[^"]*" href=[^>]*title="[^"]*"(?![^>]*aria-label)/g) || []).length) bad.push('dashboard icon link without aria-label');
  for (const f of ['inventory.js', 'orders.js', 'recovery.js', 'stock-outward.js', 'hr.js']) if (!/e\.key === 'Enter' \|\| \(e\.key === ' '/.test(await read(f))) bad.push(`${f}: rows open with Enter only`);
  if (!/`\$\{count\(n\)\} overdue`/.test(comp)) bad.push('overdue count is colour only');
  if (!/Could not sign out/.test(comp)) bad.push('sign-out failure unhandled');
  for (const [f, id] of [['recovery.html', 'rows'], ['stock-outward.html', 'rows'], ['couriers.html', 'cpRows']]) {
    if (!new RegExp(`<tbody id="${id}"><tr><td colspan="\\d+"><div class="empty-note" role="status">Loading…</div>`).test(await read(f))) bad.push(`${f}: no loading row`);
  }
  for (const f of ['recovery.js', 'stock-outward.js', 'couriers.js']) if (!/Could not load\. See the message above\./.test(await read(f))) bad.push(`${f}: loading row can stick after an error`);
  if (!/onLeave\(\(\) => \{ clearTimeout\(shopifyTimer\); clearTimeout\(amazonTimer\); \}\)/.test(ojs) || !/amazonTimer = setTimeout\(followAmazonSync, 2500\)/.test(ojs)) bad.push('sync loops not cleared on leave');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'every var() on shell CSS resolves (legacy --r-sm/--muted/--border-strong/--warn/--warn-border now aliases); 5 hard-coded colours tokenised (37 uses); rows and menus share the --focus ring; 8 placeholder-only inputs and 3 icon links named; Space opens rows on 5 pages; overdue counts say "N overdue"; sign-out failure shows a message; Recovery, Stock outward and Couriers show a loading row that turns into "Could not load" on error; Shopify/Amazon status loops cleared on leaving Orders';
});

await step('shell navigation: the top bar title is the incoming page\'s element (id included) — arriving at Inventory from Stock outward or Recovery no longer throws "Cannot set properties of null (setting \'textContent\')"', async () => {
  const bad = [];
  const nav = await fsp.readFile(new URL('../public/ui/nav.js', import.meta.url), 'utf8');
  if (!/shownTitle\.replaceWith\(document\.importNode\(topTitle, true\)\)/.test(nav) || /\.topbar-title'\)\.textContent = topTitle\.textContent/.test(nav)) bad.push('nav.js copies text instead of swapping the title element');
  const dir = new URL('../public/', import.meta.url);
  for (const f of (await fsp.readdir(dir)).filter((x) => x.endsWith('.html'))) {
    const html = await fsp.readFile(new URL(f, dir), 'utf8');
    for (const m of html.matchAll(/<span class="topbar-title"[^>]*>/g)) if (!/id="topTitle"/.test(m[0])) bad.push(`${f}: top bar title without id="topTitle"`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'nav.js replaces the shown .topbar-title with the incoming page\'s (id kept); every page\'s top bar title carries id="topTitle" (stock-outward and recovery were missing it)';
});

await step('inventory forms: native date pickers (date-only text, month-only expiry), whole-number quantities, two-decimal amounts, the field is pointed at before anything is sent; the server still refuses malformed input and writes nothing', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/inventory.js', import.meta.url), 'utf8');
  const form = (kind) => js.slice(js.indexOf(`} else if (kind === '${kind}') {`), js.indexOf('} else if', js.indexOf(`} else if (kind === '${kind}') {`) + 10));
  const recv = form('receive');
  for (const t of ["intField('quantity', 'Quantity')", "dateField('mfg_date'", "dateField('expiry_date', 'Expiry', { monthOption: true", "dateField('received_date', 'Received date', { value: istToday(), notFuture: true })"]) if (!recv.includes(t)) bad.push(`receive: ${t}`);
  for (const n of ['unit_cost', 'selling_price', 'mrp']) if (!recv.includes(`name="${n}" inputmode="decimal" \${MONEY_ATTRS}`)) bad.push(`receive: ${n} not numeric`);
  if (!/type="\$\{monthOnly \? 'month' : 'date'\}"/.test(js) || !/data-month-for/.test(js)) bad.push('no date / month picker');
  if (/new Date\([^)]*expiry/.test(js)) bad.push('an expiry passes through a JS Date');
  if (!/const problem = checkFields\(f\);\s*formError\(problem\);\s*if \(problem\) return;/.test(js)) bad.push('no check before sending');
  if (/name="(quantity|expected_quantity|accepted_quantity)" inputmode="numeric" required/.test(js)) bad.push('a text quantity input remains');
  if (!/\.fld \.opt \{/.test(await fsp.readFile(new URL('../public/orders.css', import.meta.url), 'utf8')) || /<em>optional<\/em>/i.test(js)) bad.push('optional shown in the required style');
  // Server: malformed quantities are refused and nothing reaches the ledger; dates are stored exactly as sent.
  const sku = (await createSku({ sku: `${TS} FORME COLLAGEN FORM TEST`, product_name: 'Form test', unit_type: 'sachet' }, { actor: ACTOR })).id;
  const ledger0 = await ledgerSum(sku);
  for (const q of ['abc', '1.5', '-3', '0', 'Infinity', 'NaN', '1e3', ' ', '', '10000001', '12abc']) {
    await expectErr(`quantity ${JSON.stringify(q)}`, () => receiveInventory({ sku_id: sku, batch_number: 'FT-1', quantity: q, request_id: rid() }, { actor: ACTOR }), (e) => e.status === 400);
  }
  for (const [label, patch] of [['unit cost text', { unit_cost: 'abc' }], ['unit cost 3 decimals', { unit_cost: '1.555' }], ['bad date', { expiry_date: '2028-02-30' }], ['bad month', { expiry_date: '2028-13' }]]) {
    await expectErr(label, () => receiveInventory({ sku_id: sku, batch_number: 'FT-1', quantity: '5', request_id: rid(), ...patch }, { actor: ACTOR }), (e) => e.status === 400);
  }
  if ((await ledgerSum(sku)) !== ledger0 || (await getPool().query('SELECT count(*)::int n FROM inventory_batches WHERE sku_id = $1', [sku])).rows[0].n !== 0) bad.push('a refused receipt wrote something');
  const r1 = await receiveInventory({ sku_id: sku, batch_number: 'FT-1', quantity: '5', mfg_date: '2026-08-01', expiry_date: '2028-08', received_date: dayOffset(0), unit_cost: '180.50', request_id: rid() }, { actor: ACTOR });
  const b = (await getPool().query(`SELECT mfg_date::text m, expiry_date::text e, received_date::text r, unit_cost::text c FROM inventory_batches WHERE id = $1`, [r1.batchId])).rows[0];
  if (b.m !== '2026-08-01' || b.e !== '2028-08-31' || b.r !== dayOffset(0) || b.c !== '180.50') bad.push(`stored ${JSON.stringify(b)}`);
  // A SKU code with spaces moves stock like any other: receive, adjust, overview search.
  await adjustStock({ movement_type: 'damaged', batch_id: r1.batchId, quantity: '2', reason: 'Torn sachets', request_id: rid() }, { actor: ACTOR });
  if ((await getSku(sku)).available !== 3 || !(await inventoryOverview({ q: 'collagen form test' })).rows.some((r) => r.sku_id === sku)) bad.push('space SKU movement/search');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'receive form: number quantity, date pickers (mfg, expiry with month-only switch, received ≤ today IST), numeric CP/SP/MRP; checked before sending; server refuses abc / 1.5 / −3 / 0 / Infinity / NaN / 1e3 / blank / > 10M / 12abc, text and 3-decimal costs, 30 Feb and month 13 — no batch, no ledger row; 2026-08-01 and 2028-08 stored as 2026-08-01 / 2028-08-31, ₹180.50 kept; a spaced SKU code receives, adjusts (5 − 2 = 3) and is found by search';
});

await step('money display: two decimals everywhere the shared formatter is used (₹180.50 never ₹181), foreign currency kept, stored values and CSVs untouched', async () => {
  const bad = [];
  const { money, moneyIn } = await import('../public/ui/format.js');
  const cases = [[180.5, '₹180.50'], ['180.50', '₹180.50'], [249, '₹249.00'], [0.1 + 0.2, '₹0.30'], [3258575, '₹32,58,575.00'], [null, '₹0.00'], ['21.675', '₹21.68']];
  for (const [v, want] of cases) if (money(v) !== want) bad.push(`money(${JSON.stringify(v)}) = ${money(v)}, want ${want}`);
  if (moneyIn('USD', 20) !== '$20.00' || moneyIn('INR', 1.5) !== '₹1.50' || !/1\.50/.test(moneyIn('XYZ', 1.5))) bad.push('moneyIn');
  const read = (f) => fsp.readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const comp = await read('ui/components.js');
  if (!/export \{ money, moneyIn \} from '\.\/format\.js';/.test(comp) || /maximumFractionDigits: 0 \}\);\s*export const money/.test(comp)) bad.push('components still rounds money');
  if (!/minimumFractionDigits: 2, maximumFractionDigits: 2/.test(await read('import.js'))) bad.push('import page rounds money');
  if (!/moneyIn\(cur, v\)/.test(await read('recovery.js'))) bad.push('recovery foreign currency');
  // The stored value is what was entered: a batch at ₹180.50 reads back as 180.50 and values to the paisa.
  const sku = (await createSku({ sku: `${TS}-MONEY`, product_name: 'Money display' }, { actor: ACTOR })).id;
  await receiveInventory({ sku_id: sku, batch_number: 'M-1', quantity: '3', unit_cost: '180.50', selling_price: '249', mrp: '299.99', request_id: rid() }, { actor: ACTOR });
  const d = await skuDetail(sku);
  if (d.batches[0].unit_cost !== 180.5 || d.batches[0].value !== 541.5 || d.batches[0].mrp !== 299.99 || money(d.batches[0].unit_cost) !== '₹180.50' || money(d.batches[0].value) !== '₹541.50') bad.push(`stored/display ${JSON.stringify(d.batches[0]).slice(0, 160)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return '₹180.50, ₹249.00, ₹0.30, ₹32,58,575.00, ₹21.68 (display rounding only); USD/INR/unknown codes keep two decimals; components, import and recovery use it; a ₹180.50 batch stores 180.5 and values 3 × 180.50 = ₹541.50';
});

await step('shared UI patterns: one outlined label (tag / xtag / mini-tag) on tokens, unknown expiry distinct from near expiry, no duplicate .btn.danger / .status.none, table standard (row tokens, numeric columns, focusable selectable rows, keyboard sorting with aria-sort, scroll cue), stateBlock with roles used for loading/error, inventory forms: no prompts, confirm dialogs, unsaved-change guard, single submit, SKU list fetched once per change', async () => {
  const bad = [];
  const read = (f) => fsp.readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const ui = await read('ui.css'); const ord = await read('orders.css');
  if (!/\.tag, \.xtag, \.mini-tag \{[^}]*font-size: var\(--fs-label\)/.test(ui)) bad.push('labels not consolidated');
  if (/^\.xtag \{|^\.tag \{ font-size|^\.mini-tag \{\s*display: inline-block/m.test(ui + ord)) bad.push('old label definitions remain');
  if (!/\.xtag\.unknown \{[^}]*border-style: dashed/.test(ui)) bad.push('unknown expiry looks like near expiry');
  if ((ui + ord).match(/^\.btn\.danger \{/gm)?.length !== 1 || (ui + ord).match(/^\.status\.none \{/gm)?.length !== 1) bad.push('duplicate component rules');
  for (const t of ['--h-table-row:', '--table-head:', '--selected:', '.table tbody tr[tabindex]:focus-visible', '.table th.sortable:focus-visible', 'no-repeat local']) if (!ui.includes(t)) bad.push(`table standard: ${t}`);
  for (const f of ['index.html', 'dashboard.html']) if ((await read(f)).match(/<th class="sortable[^"]*" tabindex="0" aria-sort="none"/g)?.length !== 7) bad.push(`${f}: sortable headers not focusable`);
  for (const f of ['app.js', 'dashboard.js']) if (!/setAttribute\('aria-sort'/.test(await read(f))) bad.push(`${f}: aria-sort not updated`);
  const comp = await read('ui/components.js');
  if (!/th\.sortable\[tabindex\]/.test(comp) || !/role="alert"' : kind === 'loading' \? ' role="status" aria-busy="true"'/.test(comp)) bad.push('keyboard sort / stateBlock roles');
  for (const f of ['hr.js', 'inventory.js', 'affiliates.js']) if (!/stateBlock\('loading'/.test(await read(f))) bad.push(`${f}: hand-rolled loading`);
  const inv = await read('inventory.js');
  if (/window\.prompt\('(Stage|Why is the rest)/.test(inv) || !/kind === 'incoming-stage'/.test(inv) || !/kind === 'incoming-cancel'/.test(inv)) bad.push('incoming prompts remain');
  if (/window\.confirm\(`Remove platform SKU|window\.confirm\('Remove this document/.test(inv)) bad.push('destructive actions use window.confirm');
  if (!/if \(state\.submitting\) return;/.test(inv) || !/state\.form\.dirty = true/.test(inv) || !/if \(!force && state\.form\?\.dirty/.test(inv)) bad.push('submit/dirty guards');
  if (!/const needSkus = !state\.skus \|\| state\.skusStale;/.test(inv)) bad.push('SKU list refetched on every filter');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'labels: one outlined pattern at 11px on tokens (5 tones), unknown expiry dashed; duplicates removed; tables share row/head tokens, tabular numerics, focusable/selected rows, keyboard sort with aria-sort on the call board and Analytics, a scroll edge cue; stateBlock announces loading/errors and replaces hand-rolled loading in HR, Inventory, Affiliates; inventory: labelled stage/cancel forms, confirm dialogs, unsaved-change guard, one submit at a time, SKU list fetched once (5 filter changes: 10 → 5 requests)';
});

await step('orders & logistics UI: eight-column table (shipment = status + courier · AWB, Amount kept on screen to tablet width), grouped filters with a counted "More filters", drawer facts first and items/details before proof, one save at a time, cancel confirmed, loading/error never shown as "no orders", stale answers ignored, couriers stacked on phones', async () => {
  const bad = [];
  const read = (f) => fsp.readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const html = await read('orders.html'); const js = await read('orders.js'); const css = await read('orders.css');
  // Every filter and control the page already had is still there, by id (their handlers and query semantics are unchanged).
  for (const id of ['q', 'fchannel', 'fdest', 'fstatus', 'fshipment', 'fcourier', 'finvoice', 'ftracking', 'ffrom', 'fto', 'fclear', 'refresh', 'shopifyOrders', 'amazonOrders', 'importOrders', 'newShipment', 'selBar', 'rows', 'clist', 'more'])
    if (!html.includes(`id="${id}"`)) bad.push(`#${id} missing`);
  const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  if ((thead.match(/<th[\s>]/g) || []).length !== 8 || !/<th class="r col-amt">Amount<\/th>/.test(thead) || !/Shipment <span class="th-sub">courier · AWB<\/span>/.test(thead)) bad.push('table head');
  if (/@media \(max-width: 1360px\)[^}]*col-amt/.test(css) || /\.col-amt[^{]*\{[^}]*display: none/.test(css)) bad.push('Amount hidden on laptops again');
  if (!/<td class="r num col-amt">\$\{o\.order_value === null \|\| o\.order_value === undefined \? '<span class="muted-cell" title="No value entered">—<\/span>' : esc\(amount\(o\.order_value\)\)\}/.test(js)) bad.push('amount cell (shared money formatter, no value never ₹0)');
  if (!/const payText = \(o\) => \[o\.payment_method && label\(o\.payment_method\), o\.payment_status && label\(o\.payment_status\)\]/.test(js) || !/pay-sub/.test(js)) bad.push('payment not shown under the amount');
  // A method with no recorded status never reads as settled: the tooltip and the drawer say the status is not known.
  if (!/const payTitle = \(o\) => `Payment: \$\{payText\(o\)\}\$\{o\.payment_method && !o\.payment_status \? ' \(payment status not recorded\)' : ''\}`;/.test(js)
    || !/class="cell-sub pay-sub" title="\$\{esc\(payTitle\(o\)\)\}"/.test(js) || !/o\.payment_method && !o\.payment_status \? ' · status not recorded' : ''/.test(js)) bad.push('payment status not recorded is not said');
  if (!/aria-controls="moreFilters"/.test(html) || !/const MORE_FILTERS = \['destination', 'status', 'courier', 'invoice', 'tracking'\];/.test(js) || !/\$\('#filtersCount'\)\.textContent/.test(js)) bad.push('More filters toggle / count');
  if (!/function orderFacts\(o\)/.test(js) || (js.match(/\$\{orderFacts\(o\)\}/g) || []).length !== 2) bad.push('drawer facts');
  const common = js.slice(js.indexOf('function drawerCommon('), js.indexOf('function orderDetailsSection('));
  if (!(common.indexOf('itemsSection(') < common.indexOf('orderDetailsSection(') && common.indexOf('orderDetailsSection(') < common.indexOf('Dispatch Proof'))) bad.push('drawer order');
  if (!/if \(patching\) return false;/.test(js) || !/drawerActions\(\)\.forEach\(\(b\) => \{ b\.disabled = true; \}\)/.test(js)) bad.push('single save');
  // Cancelling asks first, with buttons that cannot be confused ("Keep order" / "Cancel order"); the shared dialog's
  // dismiss label defaults to "Cancel", so every other caller is unchanged.
  const comp = await read('ui/components.js');
  if (!/e\.target\.value === 'cancelled' && !\(await confirmDialog\(/.test(js) || !/confirmLabel: 'Cancel order', cancelLabel: 'Keep order', danger: true/.test(js)
    || !/export function confirmDialog\(\{ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel',/.test(comp) || !/data-x="0">\$\{esc\(cancelLabel\)\}<\/button>/.test(comp)) bad.push('cancel not confirmed');
  // A status change that was not saved puts the select back to what is stored.
  if (!/if \(!\(await patchOrder\(\{ order_status: sel\.value \}, 'Order status saved'\)\) && sel\.isConnected\) sel\.value = state\.detail\.order\.order_status;/.test(js)) bad.push('failed status change left on screen');
  if (!/const seq = append \? loadSeq : \+\+loadSeq;/.test(js) || (js.match(/if \(seq !== loadSeq\) return;/g) || []).length !== 2) bad.push('stale answers not ignored');
  // "Show more" is one request at a time, never while a reload is out (its offset would mix two result sets), and says it is loading.
  if (!/if \(append && \(appendPending \|\| reloadPending\)\) return;/.test(js) || !/\$\('#moreBtn'\)\.textContent = 'Loading…';/.test(js) || !/\$\('#moreBtn'\)\.textContent = 'Show more';/.test(js)) bad.push('Show more guard');
  // These override the shared cell rule at the same specificity, so they must come after it — before it, the customer
  // showed twice on laptops and the payment line was cut off instead of wrapping.
  const cellRule = css.indexOf('.ord-table .cell-main, .ord-table .cell-sub {');
  if (!(cellRule > -1 && css.indexOf('.ord-table .cust-inline { display: none; }') > cellRule && css.indexOf('.ord-table .pay-sub {') > cellRule && css.indexOf('.ord-table .ord-no {') > cellRule)) bad.push('cell overrides placed before the rule they override');
  // A cancelled order's tag is never cut off with the number: the number is shortened on its own, the tag wraps under it.
  if (!/<span class="cell-main mono ord-no" title="\$\{esc\(orderNo\(o\)\)\}">\$\{pickBox\(o\)\}<span class="ord-num">\$\{esc\(orderNo\(o\)\)\}<\/span>\$\{cancelledTag\(o\)\}<\/span>/.test(js)
    || !/\.ord-table \.ord-no \{ display: flex; flex-wrap: wrap;/.test(css) || !/\.ord-table \.ord-no > \.mini-tag \{ flex: none;/.test(css)) bad.push('Cancelled tag can be cut off');
  if (!/stateBlock\('loading', 'Loading orders…'/.test(js) || !/stateBlock\('error', 'Could not load orders\.'/.test(js)) bad.push('loading / error states');
  if (!/@media \(max-width: 760px\) \{\s*\.cp-table, \.cp-table tbody, \.cp-table tr, \.cp-table td \{ display: block/.test(css)) bad.push('couriers not stacked on phones');
  // Sync controls: unchanged wiring, nothing started on load.
  if (/startShopifySync\(\);\s*\}\)\(\)|startAmazonSync\(\);\s*\}\)\(\)/.test(js) || !/api\('\/api\/orders\/shopify\/sync-updates'\)\.then\(\(st\) => \{ if \(st\.state === 'running' \|\| st\.state === 'interrupted'\) followShopifySync\(\); \}\)/.test(js)) bad.push('sync on load changed');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'all 20 page controls kept by id; 8 columns (Order · Customer · Channel · Shipment[courier · AWB] · Proof · Date · Amount · open), Amount never hidden by width, no value shows —; search/channel/shipment/dates + "More filters" (destination, order status, courier, invoice, tracking) with a count; drawer: value/payment/customer/status strip, then shipment, items, details, proof, notes, activity; customer shown once (column or under the number), the Cancelled tag never cut off; one save at a time, a failed status change put back; cancelling asks first (Keep order / Cancel order); payment with no recorded status says so; stale responses dropped, Show more one at a time and never during a reload; loading and error states in the table; couriers stacked on phones; sync status only read on load';
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
  // Staff see when the code was first and last ordered; listing it maps nothing.
  const listed = (await unmappedSkus()).find((u) => u.code === `${TS}20000001`);
  if (!listed.first_seen || !listed.last_seen || new Date(listed.first_seen) > new Date(listed.last_seen) || listed.orders !== 1 || listed.units !== 2) throw new Error(JSON.stringify(listed));
  if ((await lineOf(INV.blOrder)).sku_id !== null) throw new Error('listing as unmapped changed the line');
  const r = await addPlatformMappings(INV.m, PF.blinkit, [`${TS}20000001`], { actor: ACTOR });
  l = await lineOf(INV.blOrder);
  if (r.orderItemsMapped !== 1 || l.sku_id !== INV.m || l.sku !== `${TS}20000001`) throw new Error(JSON.stringify({ r, l }));
  if ((await getPool().query('SELECT count(*)::int n FROM skus')).rows[0].n !== before) throw new Error('a SKU was created');
  return 'Blinkit line kept its code, listed as unmapped, no SKU made; mapping resolved it at once (no re-import)';
});
await step('SKU mapping worklist: unmapped lines listed with their orders; mapping is explicit, idempotent and never touches stock', async () => {
  const code = `${TS}-WL-AMZ`;
  const stockState = async () => (await getPool().query(`SELECT
      (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
      (SELECT count(*) FROM inventory_batches)::int bt, (SELECT coalesce(sum(on_hand), 0) FROM inventory_batches)::int qty,
      (SELECT count(*) FROM skus)::int skus, (SELECT count(*) FROM sku_platform_mappings)::int maps,
      (SELECT count(*) FROM order_shipments)::int ships, (SELECT string_agg(shipment_status, ',' ORDER BY id) FROM order_shipments) ship_states`)).rows[0];
  const cut = await getInventoryCutover();
  const o1 = await lineOn('amazon', 'WL-1', code, 2);
  const o2 = await lineOn('amazon', 'WL-2', code, 1);
  // A line with no SKU code at all: listed, never mappable through a platform SKU.
  const o3 = await createOrder({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-WL-3`, order_date: NOW(), order_value: 100 }, { actor: ACTOR });
  await getPool().query(`INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price) VALUES ($1, 'L-NOCODE', NULL, 'No code line', 1, 100)`, [o3]);
  const before = await stockState();
  // Listed: one row for the code, both lines and both orders; listing twice maps nothing.
  const row = (await unmappedSkus()).find((u) => u.code === code);
  if (!row || row.lines !== 2 || row.orders !== 2 || row.units !== 3 || !row.mappable
    || !row.order_refs.includes(`${TEST_ORDER}-WL-1`) || !row.order_refs.includes(`${TEST_ORDER}-WL-2`)) throw new Error(JSON.stringify(row));
  const nc = (await unmappedLinesWithoutCode()).find((l) => Number(l.order_id) === o3);
  if (!nc || nc.order_ref !== `${TEST_ORDER}-WL-3` || nc.source_line_item_id !== 'L-NOCODE' || nc.quantity !== 1) throw new Error(JSON.stringify(nc));
  await unmappedSkus(); await unmappedLinesWithoutCode();
  if ((await lineOf(o1)).sku_id !== null || (await lineOf(o2)).sku_id !== null) throw new Error('listing mapped a line');
  if (JSON.stringify(await stockState()) !== JSON.stringify(before)) throw new Error('listing changed state');
  // Explicit mapping to the SKU a person chose: both lines resolve, the code is kept.
  const r = await addPlatformMappings(INV.m2, PF.amazon, [code], { actor: ACTOR, fromOrder: true });
  if (r.added[0] !== code || r.orderItemsMapped !== 2 || (await lineOf(o1)).sku_id !== INV.m2 || (await lineOf(o2)).sku_id !== INV.m2 || (await lineOf(o1)).sku !== code) throw new Error(JSON.stringify(r));
  // Repeated: a no-op.
  const again = await addPlatformMappings(INV.m2, PF.amazon, [code], { actor: ACTOR, fromOrder: true });
  if (again.added.length || again.existing[0] !== code || again.orderItemsMapped !== 0) throw new Error(JSON.stringify(again));
  const after = await stockState();
  if (after.maps !== before.maps + 1) throw new Error(`mappings ${before.maps} → ${after.maps}`);
  for (const k of ['mv', 'rs', 'bt', 'qty', 'skus', 'ships', 'ship_states']) if (after[k] !== before[k]) throw new Error(`${k} changed: ${before[k]} → ${after[k]}`);
  const cut2 = await getInventoryCutover();
  if (String(cut2.cutover_at) !== String(cut.cutover_at) || cut2.version !== cut.version) throw new Error('cutover changed');
  if ((await unmappedSkus()).some((u) => u.code === code)) throw new Error('still listed after mapping');
  // The code-less line is untouched by any mapping.
  if (!(await unmappedLinesWithoutCode()).some((l) => Number(l.order_id) === o3)) throw new Error('code-less line vanished');
  if ((await getPool().query('SELECT sku_id FROM order_items WHERE order_id = $1', [o3])).rows[0].sku_id !== null) throw new Error('code-less line was mapped');
  return '2 Amazon lines on 2 orders listed as one code with their order refs; a code-less line listed separately; listing changed nothing; explicit map resolved both lines; repeat = no-op; 0 movements, 0 reservations, stock, SKUs, shipments and cutover unchanged';
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
// ---- units per listing: a channel listing can be several master-SKU units -----------
const upShip = async (channel, number, tracking) => {
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  return (await createShipment({ ...R(channel), channel, source_order_id: `${TEST_ORDER}-${number}`, courier_partner_id: dl.id, tracking_id: tracking, shipment_status: 'packed' },
    { actor: ACTOR, addToExisting: true })).shipmentId;
};
const upLine = async (orderId, lineId, code, qty) => {
  const c = await getPool().connect();
  let skuId;
  try { skuId = (await resolveSkuIds(c, 'amazon', [code])).get(code.toLowerCase()) ?? null; } finally { c.release(); }
  await getPool().query(`INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, sku_id) VALUES ($1, $2, $3, 'Test line', $4, 100, $5)`,
    [orderId, lineId, code, qty, skuId]);
};
const upMap = async (code) => (await getSku(INV.up)).platform_skus.find((x) => x.platform_sku === code);

await step('units per listing: new mapping defaults to 1; explicit 1, 2 and 3 are stored', async () => {
  INV.up = (await createSku({ sku: `${TS}-UP-SINGLE`, product_name: 'Single pack (units per listing)' }, { actor: ACTOR })).id;
  await addPlatformMappings(INV.up, PF.amazon, [`${TS}-UP-DEFAULT`], { actor: ACTOR });
  await addPlatformMappings(INV.up, PF.amazon, [`${TS}-UP-ONE`], { actor: ACTOR, unitsPerListing: 1 });
  await addPlatformMappings(INV.up, PF.amazon, [`${TS}-UP-PACK2`], { actor: ACTOR, unitsPerListing: 2 });
  await addPlatformMappings(INV.up, PF.amazon, [`${TS}-UP-PACK3`], { actor: ACTOR, unitsPerListing: '3' });
  const got = ['DEFAULT', 'ONE', 'PACK2', 'PACK3'].map(async (k) => (await upMap(`${TS}-UP-${k}`)).units_per_listing);
  const v = await Promise.all(got);
  if (v.join() !== '1,1,2,3') throw new Error(v.join());
  // A row written without the column (as existing rows were) is 1.
  await getPool().query(`INSERT INTO sku_platform_mappings (sku_id, platform, platform_sku) VALUES ($1, 'zepto', $2)`, [INV.up, `${TS}-UP-RAW`]);
  if ((await upMap(`${TS}-UP-RAW`)).units_per_listing !== 1) throw new Error('raw row');
  // A Blinkit mapping made the way production's 10190237 → BS002E90 was (no multiplier given) is 1.
  await addPlatformMappings(INV.up, PF.blinkit, [`${TS}-UP-10190237`], { actor: ACTOR });
  if ((await upMap(`${TS}-UP-10190237`)).units_per_listing !== 1) throw new Error('blinkit');
  return 'omitted → 1, 1 → 1, 2 → 2, "3" → 3; rows without the column → 1; Blinkit 10190237-style mapping stays 1';
});
await step('units per listing: 0, negative, decimal, null and empty refused (API and database)', async () => {
  const oneId = (await upMap(`${TS}-UP-ONE`)).id;
  for (const bad of [0, -1, 1.5, '2.5', '0', '-2', null, '', '  ', 'two', true]) {
    await expectErr(`add ${JSON.stringify(bad)}`, () => addPlatformMappings(INV.up, PF.amazon, [`${TS}-UP-BAD`], { actor: ACTOR, unitsPerListing: bad }), (e) => e.status === 400);
    await expectErr(`edit ${JSON.stringify(bad)}`, () => updateMappingUnits(oneId, bad, { actor: ACTOR }), (e) => e.status === 400);
  }
  await expectErr('edit omitted', () => updateMappingUnits(oneId, undefined, { actor: ACTOR }), (e) => e.status === 400);
  if (await upMap(`${TS}-UP-BAD`)) throw new Error('a refused mapping was saved');
  if ((await upMap(`${TS}-UP-ONE`)).units_per_listing !== 1) throw new Error('a refused edit changed the mapping');
  if (unitsPerListingOf(undefined) !== 1) throw new Error('omitted');
  await expectErr('db check', () => getPool().query('UPDATE sku_platform_mappings SET units_per_listing = 0 WHERE platform_sku = $1', [`${TS}-UP-ONE`]), (e) => e.code === '23514');
  await expectErr('db not null', () => getPool().query('UPDATE sku_platform_mappings SET units_per_listing = NULL WHERE platform_sku = $1', [`${TS}-UP-ONE`]), (e) => e.code === '23502');
  return '11 bad values refused on add and edit, nothing saved; the column itself refuses 0 and NULL';
});
await step('units per listing: 3 × pack of 2 = 6 units — FEFO, availability, reservation, release, dispatch; order line keeps 3', async () => {
  INV.upB1 = (await receiveInventory({ sku_id: INV.up, batch_number: 'UP-LATE', expiry_date: dayOffset(400), quantity: 50, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  INV.upB2 = (await receiveInventory({ sku_id: INV.up, batch_number: 'UP-EARLY', expiry_date: dayOffset(100), quantity: 4, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  const order = await lineOn('amazon', 'UP-1', `${TS}-UP-PACK2`, 3);
  const sid = await upShip('amazon', 'UP-1', 'AWB-UP-1');
  let st = await shipmentStock(sid);
  const l = st.lines[0];
  if (st.state !== 'needs_reservation' || l.required !== 6 || l.ordered !== 6 || !l.enough) throw new Error(JSON.stringify(l));
  // FEFO: the 4 earliest-expiring units first, then 2 from the later batch.
  const picks = l.suggestion.picks.map((p) => `${p.batch_id}:${p.quantity}`).join();
  if (picks !== `${INV.upB2}:4,${INV.upB1}:2`) throw new Error(picks);
  // Reservation must cover 6 units, not the channel quantity 3.
  await expectErr('reserve 3', () => reserveShipmentStock(sid, [{ batch_id: INV.upB1, quantity: 3 }], { actor: ACTOR }), (e) => e.status === 400);
  await reserveShipmentStock(sid, l.suggestion.picks, { actor: ACTOR });
  if (JSON.stringify(await stockOf(INV.up)) !== JSON.stringify({ on: 54, res: 6, av: 48 })) throw new Error(JSON.stringify(await stockOf(INV.up)));
  await releaseShipmentStock(sid, { actor: ACTOR });
  if (JSON.stringify(await stockOf(INV.up)) !== JSON.stringify({ on: 54, res: 0, av: 54 })) throw new Error('release');
  await reserveShipmentStock(sid, [{ batch_id: INV.upB1, quantity: 6 }], { actor: ACTOR });
  const sh = (await orderShipments(order))[0];
  await updateShipment(order, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
  const out = (await skuDetail(INV.up)).movements.filter((m) => m.shipment_id === sid);
  if (out.length !== 1 || out[0].quantity !== -6) throw new Error(JSON.stringify(out));
  // Repeating the deduction takes nothing more.
  const c = await getPool().connect();
  try { await c.query('BEGIN'); const again = await dispatchShipmentStock(c, sid, { actor: ACTOR }); await c.query('COMMIT'); if (!again.repeated) throw new Error('not idempotent'); } finally { c.release(); }
  if (await ledgerSum(INV.up) !== 48 || (await stockOf(INV.up)).on !== 48) throw new Error('deducted twice');
  const q = (await getPool().query('SELECT quantity FROM order_items WHERE order_id = $1', [order])).rows[0].quantity;
  if (q !== 3) throw new Error(`commercial quantity changed to ${q}`);
  if ((await skuDetail(INV.up)).orderLines.units !== 6) throw new Error('sku detail units');
  return 'required 6; FEFO 4 (early) + 2 (late); reserving 3 refused; reserved 6 → 54/6/48; released → 54; dispatched −6 once (retry repeated); order line still 3';
});
await step('units per listing: availability check uses inventory units (3 × pack of 3 = 9 > 8 available → insufficient)', async () => {
  const sku = (await createSku({ sku: `${TS}-UP-SHORT`, product_name: 'Short (units per listing)' }, { actor: ACTOR })).id;
  await addPlatformMappings(sku, PF.amazon, [`${TS}-UP-SHORT-P3`], { actor: ACTOR, unitsPerListing: 3 });
  const b = (await receiveInventory({ sku_id: sku, batch_number: 'UPS-1', expiry_date: dayOffset(200), quantity: 8, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  await lineOn('amazon', 'UP-2', `${TS}-UP-SHORT-P3`, 3);
  const sid = await upShip('amazon', 'UP-2', 'AWB-UP-2');
  const st = await shipmentStock(sid);
  if (st.state !== 'insufficient' || st.lines[0].required !== 9 || st.lines[0].available !== 8 || st.lines[0].suggestion.short !== 1) throw new Error(JSON.stringify(st.lines));
  await expectErr('reserve 9', () => reserveShipmentStock(sid, [{ batch_id: b, quantity: 9 }], { actor: ACTOR }), (e) => e.insufficientStock);
  return 'needs 9 master units, 8 on hand: insufficient (short 1), reservation refused';
});
await step('units per listing: mixed shipment (×1, ×2, unmapped) — units add up per SKU; the unmapped line still blocks', async () => {
  const order = await lineOn('amazon', 'UP-3', `${TS}-UP-ONE`, 2);
  await upLine(order, 'L2', `${TS}-UP-PACK2`, 2);
  await upLine(order, 'L3', `${TS}-UP-NOT-MAPPED`, 1);
  const sid = await upShip('amazon', 'UP-3', 'AWB-UP-3');
  const st = await shipmentStock(sid);
  if (st.state !== 'unmapped' || st.lines.length !== 1 || st.lines[0].required !== 6) throw new Error(JSON.stringify({ state: st.state, lines: st.lines.map((x) => x.required) }));
  const before = await ledgerSum(INV.up);
  const resBefore = (await stockOf(INV.up)).res;
  // Existing rule: no reservation and no dispatch while any line is unmapped.
  await expectErr('reserve', () => reserveShipmentStock(sid, [{ batch_id: INV.upB1, quantity: 6 }], { actor: ACTOR }), (e) => e.unmappedSkus);
  if ((await stockOf(INV.up)).res !== resBefore) throw new Error('reserved');
  const sh = (await orderShipments(order))[0];
  await expectErr('dispatch', () => updateShipment(order, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }), (e) => e.unmappedSkus);
  if (await ledgerSum(INV.up) !== before || (await orderShipments(order))[0].shipment_status !== 'packed') throw new Error('changed');
  return '2 × 1 + 2 × 2 = 6 units of one master; the unmapped line keeps the shipment "unmapped"; reservation and dispatch refused, nothing changed';
});
await step('units per listing: changing it is refused while stock is reserved for its orders, then allowed and audited', async () => {
  // The dispatched shipment (UP-1) blocks PACK2: its stock has left.
  const pack2 = (await upMap(`${TS}-UP-PACK2`)).id;
  await expectErr('dispatched', () => updateMappingUnits(pack2, 4, { actor: ACTOR }), (e) => e.status === 409);
  // A reservation blocks PACK3 until it is released.
  await lineOn('amazon', 'UP-4', `${TS}-UP-PACK3`, 1);
  const sid = await upShip('amazon', 'UP-4', 'AWB-UP-4');
  await reserveShipmentStock(sid, [{ batch_id: INV.upB1, quantity: 3 }], { actor: ACTOR });
  const free = await upMap(`${TS}-UP-PACK3`);
  await expectErr('reserved', () => updateMappingUnits(free.id, 6, { actor: ACTOR }), (e) => e.status === 409);
  await releaseShipmentStock(sid, { actor: ACTOR });
  const r = await updateMappingUnits(free.id, 6, { actor: ACTOR });
  if ((await shipmentStock(sid)).lines[0].required !== 6) throw new Error('new units not used');
  if (!r.changed || (await upMap(`${TS}-UP-PACK3`)).units_per_listing !== 6) throw new Error(JSON.stringify(r));
  const same = await updateMappingUnits(free.id, 6, { actor: ACTOR });
  if (same.changed) throw new Error('same value counted as a change');
  const a = (await getPool().query(`SELECT metadata FROM inventory_audit WHERE action = 'platform_sku_units_changed' AND sku_id = $1`, [INV.up])).rows;
  if (a.length !== 1 || a[0].metadata.from !== 3 || a[0].metadata.to !== 6) throw new Error(JSON.stringify(a));
  return 'refused after dispatch and while reserved; released → 3 → 6, the shipment now needs 6, audited once; same value is a no-op';
});
// ---- stock cutover: orders before it are historical and never touch stock ----------
const CUT_AT = '2026-01-15T00:00:00+05:30';
const setCut = async (v) => setInventoryCutover(v, { actor: ACTOR, confirm: true, version: (await getInventoryCutover()).version });
const orderAt = async (number, code, qty, offset) => {
  const id = await lineOn('amazon', number, code, qty);
  // The stored timestamptz itself, relative to the cutover instant.
  await getPool().query('UPDATE orders SET order_date = $2::timestamptz + $3::interval WHERE id = $1', [id, CUT_AT, offset]);
  return id;
};
const movementsFor = async (sid) => (await getPool().query('SELECT count(*)::int n FROM inventory_movements WHERE shipment_id = $1', [sid])).rows[0].n;

await step('stock cutover: unset by default; saving needs confirmation and the current version, and is audited', async () => {
  const cur = await getInventoryCutover();
  if (cur.cutover_at !== null) throw new Error('cutover should start unset');
  INV.cutSku = (await createSku({ sku: `${TS}-CUT`, product_name: 'Cutover test' }, { actor: ACTOR })).id;
  await addPlatformMappings(INV.cutSku, PF.amazon, [`${TS}-CUT-AMZ`], { actor: ACTOR });
  INV.cutB = (await receiveInventory({ sku_id: INV.cutSku, batch_number: 'CUT-1', expiry_date: dayOffset(300), quantity: 50, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  INV.cutOld = await orderAt('CUT-OLD', `${TS}-CUT-AMZ`, 1, '-365 days');
  const c = await getPool().connect();
  try { if (!(await isInventoryEligible(c, INV.cutOld))) throw new Error('unset cutover must keep every order eligible'); } finally { c.release(); }
  await expectErr('no confirm', () => setInventoryCutover(CUT_AT, { actor: ACTOR, version: cur.version }), (e) => e.status === 400 && e.confirmRequired);
  for (const v of ['2026-01-15', '2026-01-15T00:00', 'yesterday', '', 12345]) {
    await expectErr(`format ${v}`, () => setInventoryCutover(v, { actor: ACTOR, confirm: true, version: cur.version }), (e) => e.status === 400);
  }
  await expectErr('stale version', () => setInventoryCutover(CUT_AT, { actor: ACTOR, confirm: true, version: cur.version - 1 }), (e) => e.status === 409);
  if ((await getInventoryCutover()).cutover_at !== null) throw new Error('a refused save changed the cutover');
  const r = await setCut(CUT_AT);
  const saved = await getInventoryCutover();
  if (!r.changed || saved.cutover_at.toISOString() !== '2026-01-14T18:30:00.000Z' || saved.updated_by !== ACTOR) throw new Error(JSON.stringify(saved));
  // A stale screen cannot overwrite the cutover now that it exists.
  await expectErr('stale overwrite', () => setInventoryCutover('2026-02-01T00:00:00+05:30', { actor: ACTOR, confirm: true, version: cur.version }), (e) => e.status === 409);
  if ((await setCut(CUT_AT)).changed) throw new Error('same value counted as a change');
  const a = (await getPool().query(`SELECT actor, metadata FROM inventory_audit WHERE action = 'inventory_cutover_set' ORDER BY id DESC LIMIT 1`)).rows[0];
  if (a.metadata.from !== null || a.metadata.to !== '2026-01-14T18:30:00.000Z' || a.actor !== ACTOR) throw new Error(JSON.stringify(a));
  return 'unset → every order eligible; no confirm, bad formats, stale version refused; set 15 Jan 00:00 IST (18:30Z), audited from null; stale overwrite refused; same value no-op';
});
await step('stock cutover: boundary on the stored timestamp — 1 µs before excluded, exactly at and after included', async () => {
  INV.cutBefore = await orderAt('CUT-B', `${TS}-CUT-AMZ`, 1, '-1 microsecond');
  INV.cutAt = await orderAt('CUT-AT', `${TS}-CUT-AMZ`, 2, '0 seconds');
  INV.cutAfter = await orderAt('CUT-AF', `${TS}-CUT-AMZ`, 3, '1 hour');
  const c = await getPool().connect();
  try {
    const got = [await isInventoryEligible(c, INV.cutBefore), await isInventoryEligible(c, INV.cutAt), await isInventoryEligible(c, INV.cutAfter), await isInventoryEligible(c, INV.cutOld)];
    if (got.join() !== 'false,true,true,false') throw new Error(got.join());
  } finally { c.release(); }
  return 'cutover − 1 µs → historical; = cutover → eligible; + 1 h → eligible; a year before → historical';
});
await step('stock cutover: a historical order can be mapped, but never reserves, consumes or releases stock', async () => {
  // Mapping is not blocked by the cutover: a new code on a historical order resolves.
  const hist = await orderAt('CUT-H', `${TS}-CUT-LATER`, 2, '-2 days');
  if ((await lineOf(hist)).sku_id !== null) throw new Error('should start unmapped');
  const m = await addPlatformMappings(INV.cutSku, PF.amazon, [`${TS}-CUT-LATER`], { actor: ACTOR });
  if (m.orderItemsMapped !== 1 || (await lineOf(hist)).sku_id !== INV.cutSku) throw new Error('historical line not mapped');
  const before = { ledger: await ledgerSum(INV.cutSku), stock: await stockOf(INV.cutSku) };
  const sid = await upShip('amazon', 'CUT-H', 'AWB-CUT-H');
  const st = await shipmentStock(sid);
  if (st.lines.length) throw new Error(`historical order needs stock: ${JSON.stringify(st.lines)}`);
  await expectErr('reserve', () => reserveShipmentStock(sid, [{ batch_id: INV.cutB, quantity: 2 }], { actor: ACTOR }), (e) => e.status === 400);
  // An unmapped historical line does not block either: the order takes no part in stock.
  const histUnmapped = await orderAt('CUT-HU', `${TS}-CUT-NEVER-MAPPED`, 1, '-3 days');
  const sidU = await upShip('amazon', 'CUT-HU', 'AWB-CUT-HU');
  for (const [order, s2] of [[hist, sid], [histUnmapped, sidU]]) {
    const sh = (await orderShipments(order))[0];
    await updateShipment(order, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
    if (await movementsFor(s2)) throw new Error('historical dispatch consumed stock');
  }
  // Cancelling a historical shipment releases nothing and writes nothing.
  const histC = await orderAt('CUT-HC', `${TS}-CUT-AMZ`, 4, '-1 day');
  const sidC = await upShip('amazon', 'CUT-HC', 'AWB-CUT-HC');
  const shC = (await orderShipments(histC))[0];
  await updateShipment(histC, shC.id, { shipment_status: 'cancelled' }, { actor: ACTOR, version: shC.version });
  const resRows = (await getPool().query('SELECT count(*)::int n FROM inventory_reservations WHERE shipment_id = ANY($1)', [[sid, sidU, sidC]])).rows[0].n;
  if (resRows || await movementsFor(sidC)) throw new Error('reservation or movement written for a historical order');
  const after = { ledger: await ledgerSum(INV.cutSku), stock: await stockOf(INV.cutSku) };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  return 'historical line mapped (sku_id set); needs no stock; reserve refused; mapped and unmapped historical orders dispatch with 0 movements; cancel writes nothing; stock 50/0/50 unchanged';
});
await step('stock cutover: orders at and after the cutover reserve and dispatch normally', async () => {
  for (const [order, number, qty] of [[INV.cutAt, 'CUT-AT', 2], [INV.cutAfter, 'CUT-AF', 3]]) {
    const sid = await upShip('amazon', number, `AWB-${number}`);
    const st = await shipmentStock(sid);
    if (st.lines[0]?.required !== qty) throw new Error(`${number}: ${JSON.stringify(st.lines)}`);
    await reserveShipmentStock(sid, [{ batch_id: INV.cutB, quantity: qty }], { actor: ACTOR });
    const sh = (await orderShipments(order))[0];
    await updateShipment(order, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
    const out = (await getPool().query('SELECT sum(quantity)::int q FROM inventory_movements WHERE shipment_id = $1', [sid])).rows[0].q;
    if (out !== -qty) throw new Error(`${number} deducted ${out}`);
  }
  if ((await stockOf(INV.cutSku)).on !== 45) throw new Error(JSON.stringify(await stockOf(INV.cutSku)));
  return 'exactly-at order: needs 2, reserved, dispatched −2; after order: needs 3, reserved, dispatched −3; on hand 50 → 45';
});
await step('stock cutover: a change that would move orders holding stock is refused; clearing restores the old behaviour', async () => {
  // A later cutover would make the dispatched at/after orders historical: refused.
  await expectErr('move dispatched', () => setCut('2026-01-15T02:00:00+05:30'), (e) => e.status === 409);
  // An earlier cutover would bring a historical order with a reservation… none has one; but a live reservation also blocks.
  const late = await orderAt('CUT-RES', `${TS}-CUT-AMZ`, 1, '30 days');
  const sid = await upShip('amazon', 'CUT-RES', 'AWB-CUT-RES');
  await reserveShipmentStock(sid, [{ batch_id: INV.cutB, quantity: 1 }], { actor: ACTOR });
  await expectErr('move reserved', () => setCut('2026-03-01T00:00:00+05:30'), (e) => e.status === 409);
  await releaseShipmentStock(sid, { actor: ACTOR });
  if ((await getInventoryCutover()).cutover_at.toISOString() !== '2026-01-14T18:30:00.000Z') throw new Error('refused change saved');
  // Clearing only re-admits orders with no stock against them, so it is allowed.
  const r = await setCut(null);
  const c = await getPool().connect();
  try { if (!r.changed || !(await isInventoryEligible(c, INV.cutOld)) || !(await isInventoryEligible(c, late))) throw new Error('clear'); } finally { c.release(); }
  const a = (await getPool().query(`SELECT metadata FROM inventory_audit WHERE action = 'inventory_cutover_set' ORDER BY id DESC LIMIT 1`)).rows[0];
  if (a.metadata.to !== null) throw new Error(JSON.stringify(a));
  return 'later cutover over dispatched orders refused; cutover over a reserved order refused; after release, clearing allowed and audited; all orders eligible again';
});
await step('stock cutover: editing an order date across the cutover is refused only when the order holds stock', async () => {
  const edit = async (id, offset) => {
    const at = (await getPool().query(`SELECT ($1::timestamptz + $2::interval) AS t`, [CUT_AT, offset])).rows[0].t.toISOString();
    return updateOrder(id, { order_date: at }, { actor: ACTOR, version: (await getOrder(id)).version });
  };
  const sideOf = async (id) => { const c = await getPool().connect(); try { return await isInventoryEligible(c, id); } finally { c.release(); } };
  const dateOf2 = async (id) => (await getPool().query('SELECT order_date FROM orders WHERE id = $1', [id])).rows[0].order_date.toISOString();
  // Cutover unset: dates move freely (existing behaviour), whatever stock exists.
  if ((await getInventoryCutover()).cutover_at !== null) throw new Error('expected unset');
  await edit(INV.cutAt, '-10 days'); await edit(INV.cutAt, '0 seconds');   // CUT-AT has dispatched stock
  await setCut(CUT_AT);
  // No inventory state: both directions allowed, and the boundary is exact.
  const free = await orderAt('CUT-FREE', `${TS}-CUT-AMZ`, 1, '-1 day');
  await edit(free, '0 seconds');
  if (!(await sideOf(free))) throw new Error('moved to exactly the cutover → should be eligible');
  await edit(free, '-1 microsecond');
  if (await sideOf(free)) throw new Error('1 µs before → should be historical');
  await edit(free, '2 days');
  await edit(free, '-2 days');
  // Current → historical after dispatch: refused, date unchanged.
  const atBefore = await dateOf2(INV.cutAt);
  await expectErr('dispatched → historical', () => edit(INV.cutAt, '-1 microsecond'), (e) => e.status === 409 && e.inventoryCutover);
  if (await dateOf2(INV.cutAt) !== atBefore) throw new Error('date changed');
  // Moving within the same side is still fine even with stock.
  await edit(INV.cutAfter, '2 hours');
  // Current → historical with a live reservation: refused; after release, allowed.
  const cur = await orderAt('CUT-CUR', `${TS}-CUT-AMZ`, 1, '5 days');
  const sid = await upShip('amazon', 'CUT-CUR', 'AWB-CUT-CUR');
  await reserveShipmentStock(sid, [{ batch_id: INV.cutB, quantity: 1 }], { actor: ACTOR });
  await expectErr('reserved → historical', () => edit(cur, '-5 days'), (e) => e.status === 409 && e.inventoryCutover);
  await releaseShipmentStock(sid, { actor: ACTOR });
  await edit(cur, '-5 days');
  // Historical → current with a reservation (one left from before the cutover existed): refused.
  const hist = await orderAt('CUT-HRES', `${TS}-CUT-AMZ`, 1, '-5 days');
  const sidH = await upShip('amazon', 'CUT-HRES', 'AWB-CUT-HRES');
  const rid2 = (await getPool().query(`INSERT INTO inventory_reservations (shipment_id, sku_id, batch_id, quantity, created_by) VALUES ($1, $2, $3, 1, $4) RETURNING id`,
    [sidH, INV.cutSku, INV.cutB, ACTOR])).rows[0].id;
  await expectErr('reserved historical → current', () => edit(hist, '1 day'), (e) => e.status === 409 && e.inventoryCutover);
  await getPool().query(`UPDATE inventory_reservations SET status = 'released', closed_at = now(), close_reason = 'test' WHERE id = $1`, [rid2]);
  await edit(hist, '1 day');
  // Any other writer (e.g. a re-import) is held to the same rule by the database.
  await expectErr('direct update', () => getPool().query(`UPDATE orders SET order_date = $2::timestamptz - interval '1 day' WHERE id = $1`, [INV.cutAfter, CUT_AT]), (e) => e.hint === 'inventory_cutover');
  await getPool().query('UPDATE inventory_settings SET cutover_at = NULL WHERE id');
  await getPool().query(`UPDATE orders SET order_date = $2::timestamptz - interval '1 day' WHERE id = $1`, [INV.cutAfter, CUT_AT]);   // unset → allowed
  await getPool().query(`UPDATE orders SET order_date = $2::timestamptz + interval '1 hour' WHERE id = $1`, [INV.cutAfter, CUT_AT]);
  return 'unset → free; no stock → both directions allowed, exact boundary kept; dispatched → historical, reserved → historical, reserved historical → current refused (409, date kept); same-side move allowed; release → allowed; direct DB update held too';
});
await step('stock cutover: test cutover cleared', async () => {
  await getPool().query('UPDATE inventory_settings SET cutover_at = NULL WHERE id');
  return 'cutover NULL for the rest of the suite';
});
// ---- manual order lines + the post-cutover dispatch guard ----------------------------
const ML = {};
const mlOrder = async (number, { channel = 'blinkit', at = null } = {}) => createOrder({ ...R(channel), channel, source_order_id: `${TEST_ORDER}-ML-${number}`,
  order_date: at, order_value: 100 }, { actor: ACTOR });
const mlShip = async (number, { channel = 'blinkit', status = 'packed' } = {}) => {
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  return createShipment({ ...R(channel), channel, source_order_id: `${TEST_ORDER}-ML-${number}`, courier_partner_id: dl.id, tracking_id: `AWB-ML-${number}`, shipment_status: status },
    { actor: ACTOR, addToExisting: true });
};
const mlDispatch = async (orderId) => {
  const sh = (await orderShipments(orderId))[0];
  return updateShipment(orderId, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
};
await step('manual order lines: a master SKU and a whole quantity; one line per product; only hand-entered, non-Amazon orders', async () => {
  ML.a = (await createSku({ sku: `${TS}-ML-A`, product_name: 'Manual line A', variant_name: '60 caps' }, { actor: ACTOR })).id;
  ML.b = (await createSku({ sku: `${TS}-ML-B`, product_name: 'Manual line B' }, { actor: ACTOR })).id;
  ML.off = (await createSku({ sku: `${TS}-ML-OFF`, product_name: 'Manual line inactive' }, { actor: ACTOR })).id;
  await updateSku(ML.off, { active: false }, { actor: ACTOR, version: (await getSku(ML.off)).version });
  const opts = await manualLineSkuOptions();
  if (!opts.some((k) => k.id === ML.a) || opts.some((k) => k.id === ML.off)) throw new Error('options must list active SKUs only');
  const o = await mlOrder('1');
  const r = await addManualOrderLine(o, { sku_id: ML.a, quantity: '2' }, { actor: ACTOR });
  let items = await orderItems(o);
  if (items.length !== 1 || items[0].sku_id !== ML.a || items[0].quantity !== 2 || items[0].sku !== `${TS}-ML-A` || items[0].title !== 'Manual line A — 60 caps') throw new Error(JSON.stringify(items));
  for (const q of [0, -1, '1.5', 'abc', '', null, 100001]) await expectErr(`qty ${q}`, () => addManualOrderLine(o, { sku_id: ML.b, quantity: q }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('inactive', () => addManualOrderLine(o, { sku_id: ML.off, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 400 && /inactive/.test(e.message));
  await expectErr('unknown', () => addManualOrderLine(o, { sku_id: 99999999, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 404);
  await expectErr('no sku', () => addManualOrderLine(o, { quantity: 1 }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('duplicate', () => addManualOrderLine(o, { sku_id: ML.a, quantity: 5 }, { actor: ACTOR }), (e) => e.status === 409 && /already on this order/.test(e.message));
  if ((await orderItems(o)).length !== 1 || (await orderItems(o))[0].quantity !== 2) throw new Error('a refused add changed the order');
  await updateManualOrderLine(o, r.itemId, { quantity: 3 }, { actor: ACTOR });
  await expectErr('update qty 0', () => updateManualOrderLine(o, r.itemId, { quantity: 0 }, { actor: ACTOR }), (e) => e.status === 400);
  const b = await addManualOrderLine(o, { sku_id: ML.b, quantity: 1 }, { actor: ACTOR });
  await removeManualOrderLine(o, b.itemId, { actor: ACTOR });
  items = await orderItems(o);
  if (items.length !== 1 || items[0].quantity !== 3) throw new Error(JSON.stringify(items));
  const ev = (await orderEvents(o)).map((e) => e.event_type);
  for (const t of ['item_added', 'item_quantity_changed', 'item_removed']) if (!ev.includes(t)) throw new Error(`no ${t} event`);
  // Not on Amazon (its report adds the real lines) nor on imported orders; import lines cannot be edited here.
  const amz = await mlOrder('AMZ', { channel: 'amazon' });
  await expectErr('amazon', () => addManualOrderLine(amz, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 409 && /Amazon/.test(e.message));
  const imp = await mlOrder('IMP', { channel: 'website' });
  await getPool().query(`UPDATE orders SET source = 'shopify_sync' WHERE id = $1`, [imp]);
  await expectErr('imported', () => addManualOrderLine(imp, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  const web = await mlOrder('WEB', { channel: 'website' });
  await addManualOrderLine(web, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR });   // allowed: the Shopify sync never adds lines to a hand-entered order
  const other = await lineOn('blinkit', 'ML-IMPLINE', `${TS}-ML-IMPCODE`, 1);
  const impLine = (await orderItems(other))[0];
  await expectErr('import line', () => updateManualOrderLine(other, impLine.id, { quantity: 2 }, { actor: ACTOR }), (e) => e.status === 409);
  ML.o1 = o;
  return 'line = master code + title, quantity 2; 0/−1/1.5/abc/blank/null/too large refused; inactive, unknown, missing SKU refused; same SKU twice refused (no merge); quantity edit and remove audited; Amazon and imported orders refused; hand-entered website order allowed; import lines not editable';
});
await step('manual order lines: master units directly — no platform multiplier, even when the SKU has a ×3 listing on the channel', async () => {
  await addPlatformMappings(ML.a, PF.blinkit, [`${TS}-ML-A-PACK3`], { actor: ACTOR, unitsPerListing: 3 });
  const { shipmentId } = await mlShip('1');
  ML.s1 = shipmentId;
  const st = await shipmentStock(shipmentId);
  if (st.lines.length !== 1 || st.lines[0].sku_id !== ML.a || st.lines[0].required !== 3) throw new Error(JSON.stringify(st.lines));
  // The ×3 listing still multiplies its own lines (existing behaviour).
  const plat = await lineOn('blinkit', 'ML-PACK3', `${TS}-ML-A-PACK3`, 2);
  const { shipmentId: ps } = await createShipment({ ...R('blinkit'), channel: 'blinkit', source_order_id: `${TEST_ORDER}-ML-PACK3`, courier_partner_id: (await listCouriers()).find((x) => x.name === 'Delhivery').id, tracking_id: 'AWB-ML-PACK3', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true });
  const pst = await shipmentStock(ps);
  if (pst.lines[0].required !== 6) throw new Error(`platform line ${pst.lines[0].required}`);
  if (!plat) throw new Error('setup');
  return 'manual line of 3 needs 3 (not 9) though the SKU has a ×3 Blinkit listing; that listing\'s own line of 2 still needs 6';
});
await step('post-cutover dispatch: a manual order with products reserves and deducts exactly its quantity; insufficient stock and line edits under reservation refused', async () => {
  await setCut(CUT_AT);
  ML.bA = (await receiveInventory({ sku_id: ML.a, batch_number: 'ML-1', expiry_date: dayOffset(400), quantity: 10, unit_cost: 5, request_id: rid() }, { actor: ACTOR })).batchId;
  const before = await ledgerSum(ML.a);
  await expectErr('insufficient', () => reserveShipmentStock(ML.s1, [{ batch_id: ML.bA, quantity: 11 }], { actor: ACTOR }), (e) => e.status === 409 || e.status === 400);
  await reserveShipmentStock(ML.s1, [{ batch_id: ML.bA, quantity: 3 }], { actor: ACTOR });
  const line = (await orderItems(ML.o1))[0];
  await expectErr('edit while reserved', () => updateManualOrderLine(ML.o1, line.id, { quantity: 4 }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('add while reserved', () => addManualOrderLine(ML.o1, { sku_id: ML.b, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  await mlDispatch(ML.o1);
  if (await ledgerSum(ML.a) !== before - 3) throw new Error(`deducted ${before - (await ledgerSum(ML.a))}`);
  if ((await stockOf(ML.a)).on !== 7 || (await stockOf(ML.a)).res !== 0) throw new Error(JSON.stringify(await stockOf(ML.a)));
  await expectErr('edit after dispatch', () => updateManualOrderLine(ML.o1, line.id, { quantity: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  // Two products on one order: each deducted by its own quantity.
  ML.bB = (await receiveInventory({ sku_id: ML.b, batch_number: 'ML-B1', expiry_date: dayOffset(400), quantity: 5, unit_cost: 5, request_id: rid() }, { actor: ACTOR })).batchId;
  const o2 = await mlOrder('2');
  await addManualOrderLine(o2, { sku_id: ML.a, quantity: 2 }, { actor: ACTOR });
  await addManualOrderLine(o2, { sku_id: ML.b, quantity: 4 }, { actor: ACTOR });
  const { shipmentId: s2 } = await mlShip('2');
  await reserveShipmentStock(s2, [{ batch_id: ML.bA, quantity: 2 }, { batch_id: ML.bB, quantity: 4 }], { actor: ACTOR });
  await mlDispatch(o2);
  if ((await stockOf(ML.a)).on !== 5 || (await stockOf(ML.b)).on !== 1) throw new Error(JSON.stringify([await stockOf(ML.a), await stockOf(ML.b)]));
  // Cancelling the shipment releases what was reserved for it.
  const o3 = await mlOrder('3');
  await addManualOrderLine(o3, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR });
  const { shipmentId: s3 } = await mlShip('3');
  await reserveShipmentStock(s3, [{ batch_id: ML.bA, quantity: 1 }], { actor: ACTOR });
  if ((await stockOf(ML.a)).res !== 1) throw new Error('not reserved');
  const sh3 = (await orderShipments(o3))[0];
  await updateShipment(o3, sh3.id, { shipment_status: 'cancelled' }, { actor: ACTOR, version: sh3.version });
  if ((await stockOf(ML.a)).res !== 0 || (await stockOf(ML.a)).on !== 5) throw new Error(JSON.stringify(await stockOf(ML.a)));
  return 'qty 3 reserved and dispatched → on hand 10 → 7 (−3, not −9); reserving 11 of 10 refused; lines locked while reserved and after dispatch; A×2 + B×4 → −2 and −4; cancelled shipment released its 1';
});
await step('post-cutover dispatch guard: no lines (or only code-less ones) → refused with a clear message; before the cutover and historical orders unchanged', async () => {
  const MSG = 'Cannot dispatch — this order has no inventory lines. Add the products and quantities before dispatching.';
  // B. A current order with no products: dispatch refused, nothing changes.
  const none = await mlOrder('NONE');
  await mlShip('NONE');
  const mv = (await getPool().query('SELECT count(*)::int n FROM inventory_movements')).rows[0].n;
  await expectErr('no lines', () => mlDispatch(none), (e) => e.status === 409 && e.message === MSG && e.noInventoryLines);
  if ((await orderShipments(none))[0].shipment_status !== 'packed') throw new Error('status changed');
  // Created directly as dispatched: refused too, and nothing is created (all or nothing).
  await expectErr('created dispatched', () => mlShip('NONE-DIRECT', { status: 'dispatched' }), (e) => e.message === MSG);
  if ((await getPool().query(`SELECT 1 FROM orders WHERE source_order_id = $1`, [`${TEST_ORDER}-ML-NONE-DIRECT`])).rows.length) throw new Error('order created despite the refusal');
  // Lines that resolve to nothing (no SKU code at all) do not count either.
  const blank = await mlOrder('BLANK');
  await getPool().query(`INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity) VALUES ($1, 'L-BLANK', NULL, 'Sample sachet', 1)`, [blank]);
  await mlShip('BLANK');
  await expectErr('code-less only', () => mlDispatch(blank), (e) => e.message === MSG);
  // Riding along in a parcel that has already left: refused.
  const lead = await mlOrder('LEAD');
  await addManualOrderLine(lead, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR });
  const { shipmentId: ls } = await mlShip('LEAD');
  await reserveShipmentStock(ls, [{ batch_id: ML.bA, quantity: 1 }], { actor: ACTOR });
  await mlDispatch(lead);
  const rider = await mlOrder('RIDER');
  await expectErr('attach to shipped', () => attachToShipment(ls, { orderIds: [rider] }, { actor: ACTOR }), (e) => e.message === MSG);
  if ((await getPool().query('SELECT count(*)::int n FROM inventory_movements')).rows[0].n !== mv + 1) throw new Error('unexpected movements');
  // A. Historical (before the cutover): dispatches as before, deducting nothing.
  const old = await mlOrder('OLD', { at: '2026-01-01T10:00:00+05:30' });
  const { shipmentId: os } = await mlShip('OLD');
  const r = await mlDispatch(old);
  if ((await orderShipments(old))[0].shipment_status !== 'dispatched' || await movementsFor(os) !== 0 || !r) throw new Error('historical dispatch changed');
  // Cutover unset: the existing behaviour — a line-less shipment dispatches with nothing deducted.
  await getPool().query('UPDATE inventory_settings SET cutover_at = NULL WHERE id');
  await mlDispatch(none);
  const { shipmentId: ns } = await mlShip('NONE-PRE');
  if ((await orderShipments(none))[0].shipment_status !== 'dispatched' || await movementsFor(ns) !== 0) throw new Error('pre-cutover behaviour changed');
  const plain = await mlOrder('PLAIN', { channel: 'hyugalife' });
  if (!plain) throw new Error('a non-website manual order could not be created');
  return `after cutover: no-lines dispatch refused ("${MSG.slice(0, 40)}…"), direct-dispatched create refused and rolled back, code-less-only refused, line-less order cannot join a dispatched parcel; historical order and no-cutover dispatch unchanged (0 movements); non-website manual orders unaffected`;
});
await step('manual order lines: channel and order number are fixed while the order has manual products (no route onto an Amazon order)', async () => {
  const MSG = 'Cannot change channel or order number while this order has manual products. Remove the products first.';
  const o = await mlOrder('MOVE');
  const add = await addManualOrderLine(o, { sku_id: ML.a, quantity: 2 }, { actor: ACTOR });
  const before = JSON.stringify(await orderItems(o));
  const v = async () => (await getOrder(o)).version;
  await expectErr('channel', async () => updateOrder(o, { channel: 'zepto', ...R('zepto') }, { actor: ACTOR, version: await v() }), (e) => e.status === 409 && e.message === MSG);
  await expectErr('number', async () => updateOrder(o, { source_order_id: `${TEST_ORDER}-ML-MOVED` }, { actor: ACTOR, version: await v() }), (e) => e.status === 409 && e.message === MSG);
  // D. Not onto Amazon either, under a real-looking Amazon order ID.
  await expectErr('to amazon', async () => updateOrder(o, { channel: 'amazon', ...R('amazon'), source_order_id: AZ('ML-MOVE') }, { actor: ACTOR, version: await v() }), (e) => e.status === 409 && e.message === MSG);
  const cur = await getOrder(o);
  if (cur.channel !== 'blinkit' || cur.source_order_id !== `${TEST_ORDER}-ML-MOVE` || JSON.stringify(await orderItems(o)) !== before) throw new Error('order or lines changed');
  // Other edits still work; once the products are removed, the order can move again.
  await updateOrder(o, { order_value: 250 }, { actor: ACTOR, version: await v() });
  await removeManualOrderLine(o, add.itemId, { actor: ACTOR });
  await updateOrder(o, { source_order_id: `${TEST_ORDER}-ML-MOVED` }, { actor: ACTOR, version: await v() });
  // B. No manual products: channel and number change as before.
  const free = await mlOrder('FREE');
  await updateOrder(free, { channel: 'zepto', ...R('zepto') }, { actor: ACTOR, version: (await getOrder(free)).version });
  await updateOrder(free, { source_order_id: `${TEST_ORDER}-ML-FREE2` }, { actor: ACTOR, version: (await getOrder(free)).version });
  const f = await getOrder(free);
  if (f.channel !== 'zepto' || f.source_order_id !== `${TEST_ORDER}-ML-FREE2`) throw new Error(JSON.stringify(f));
  return 'with a manual product: channel, number and a move onto an Amazon order ID refused (409, order and line unchanged); value edit fine; products removed → number changes; no products → channel and number change as before';
});
await step('manual order lines: a hand-entered Amazon order (no manual products possible) gets its Amazon lines from the import exactly once', async () => {
  const id = await createOrder({ ...R('amazon'), channel: 'amazon', source_order_id: AZ('ML-HAND'), order_value: 1 }, { actor: ACTOR });
  await expectErr('manual line', () => addManualOrderLine(id, { sku_id: ML.a, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  const file = amzCsv([amzRow({ 'order-id': AZ('ML-HAND'), 'order-item-id': 'MLH-1', sku: 'SKU-MLH', 'quantity-purchased': '2' })]);
  const r = await commitAmazonImport(file, 'ml-hand.csv', { actor: IMPORTER });
  let items = await orderItems(id);
  if (r.summary.ordersUpdated !== 1 || items.length !== 1 || items[0].source_line_item_id !== 'MLH-1' || items[0].quantity !== 2 || items[0].sku !== 'SKU-MLH') throw new Error(JSON.stringify({ s: r.summary, items }));
  const again = await commitAmazonImport(file, 'ml-hand.csv', { actor: IMPORTER });
  items = await orderItems(id);
  if (items.length !== 1 || again.summary.lineItemsAdded) throw new Error(`rerun: ${items.length} lines, added ${again.summary.lineItemsAdded}`);
  if ((await getOrder(id)).source !== 'manual') throw new Error('source changed');
  return 'manual line refused on the Amazon order; import matched it and added its 1 Amazon line (qty 2, Amazon code); rerun added nothing; order stays hand-entered';
});
await step('manual order lines: test cutover cleared', async () => {
  await getPool().query('UPDATE inventory_settings SET cutover_at = NULL WHERE id');
  return 'cutover NULL for the rest of the suite';
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
/* ------------------------------------------------------------------ Shopify orders */
// Shopify order GIDs for this run share a numeric prefix, so purgeTestOrders can remove them.
const SH_NUM = `77${String(Date.now()).slice(-9)}`;
const SH_PREFIX = `gid://shopify/Order/${SH_NUM}`;
const SH_ACTOR = 'db-check-shopify';
const SH = {};
const shDays = (n) => new Date(Date.now() - n * 86400000).toISOString();
/** A MoneyBag in INR (shop and presentment), amounts as Shopify's strings. */
const shM = (a) => ({ shopMoney: { amount: String(a), currencyCode: 'INR' }, presentmentMoney: { amount: String(a), currencyCode: 'INR' } });
const shLineGid = (n, i) => `gid://shopify/LineItem/${SH_NUM}${String(n).padStart(4, '0')}${String(i).padStart(2, '0')}`;
/**
 * A complete Shopify Admin GraphQL order node — the page fields and the detail
 * fields together; the fake below serves each query only the part it asks for.
 * o.refunds: [{ lines: [{ i, qty, subtotal, tax }], shipping: '49.00' }]
 */
const shOrder = (n, o = {}) => {
  const id = `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const specs = o.moreLines ? Array.from({ length: 51 }, () => ({ sku: `${TS}-SH-D3`, qty: 1 })) : (o.lines || [{ sku: `${TS}-SH-D3`, qty: 1 }]);
  const refunds = (o.refunds || []).map((r, k) => ({
    id: `gid://shopify/Refund/${SH_NUM}${String(n).padStart(4, '0')}${k}`, createdAt: shDays(0.1), note: null,
    totalRefundedSet: shM(r.total ?? '0.00'),
    refundLineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (r.lines || []).map((l, j) => ({
      id: `gid://shopify/RefundLineItem/${SH_NUM}${n}${k}${j}`, quantity: l.qty, restockType: 'RETURN', restocked: true,
      lineItem: { id: shLineGid(n, l.i) }, priceSet: shM(l.price ?? '649.50'), subtotalSet: shM(l.subtotal), totalTaxSet: shM(l.tax ?? '0.00') })) },
    refundShippingLines: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: r.shipping ? [{ id: `gid://shopify/RefundShippingLine/${SH_NUM}${n}${k}`,
      shippingLine: { title: 'Standard', code: 'STD' }, subtotalAmountSet: shM(r.shipping), taxAmountSet: shM('0.00') }] : [] },
  }));
  const refundedQty = (i) => (o.refunds || []).flatMap((r) => r.lines || []).filter((l) => l.i === i).reduce((s, l) => s + l.qty, 0);
  return {
    id, name: o.name || `#SH${SH_NUM.slice(-5)}-${n}`,
    createdAt: o.created || shDays(2), updatedAt: o.updated || o.created || shDays(2), processedAt: o.created || shDays(2),
    cancelledAt: o.cancelled ? shDays(0) : null, cancelReason: o.cancelled ? 'CUSTOMER' : null, closedAt: null, test: Boolean(o.test),
    displayFinancialStatus: o.fin || 'PAID', displayFulfillmentStatus: o.ful || 'UNFULFILLED', paymentGatewayNames: o.gw || ['razorpay'],
    currencyCode: 'INR', presentmentCurrencyCode: 'INR', taxesIncluded: o.taxesIncluded ?? true, tags: [], note: null,
    discountCodes: o.codes || [], customAttributes: o.attributes || [],
    currentTotalPriceSet: shM(o.total ?? 1299), totalPriceSet: shM(o.total ?? 1299), currentSubtotalPriceSet: shM(o.subtotal ?? 1250),
    currentTotalTaxSet: shM('198.15'), currentTotalDiscountsSet: shM(o.discounts ?? '0'), currentShippingPriceSet: shM('49'),
    totalShippingPriceSet: shM('49'), totalRefundedSet: shM(o.refunded ?? '0.00'), totalRefundedShippingSet: shM(o.refundedShipping ?? '0.00'),
    email: 'email' in o ? o.email : 'buyer@example.test', phone: 'phone' in o ? o.phone : null,
    customer: { id: `gid://shopify/Customer/${SH_NUM}`, firstName: o.first || 'Asha', lastName: 'K', email: 'buyer@example.test', phone: '+919800000001' },
    shippingAddress: 'ship' in o ? o.ship : { name: `${o.first || 'Asha'} K`, phone: '+919800000001', address1: '12 MG Road', address2: null, city: 'Pune', province: 'MH', zip: '411001', countryCodeV2: 'IN' },
    billingAddress: 'bill' in o ? o.bill : { name: `${o.first || 'Asha'} K`, phone: '+919800000002', address1: '4 FC Road', address2: 'Flat 2', city: 'Pune', province: 'MH', zip: '411004', countryCodeV2: 'IN' },
    // Detail-query fields.
    shippingLines: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ title: 'Standard', code: 'STD', originalPriceSet: shM('49') }] },
    fulfillments: o.ful === 'FULFILLED' ? [{ status: 'SUCCESS', createdAt: shDays(1), trackingInfo: [{ company: 'Delhivery', number: 'SHOPIFY-AWB-1', url: null }] }] : [],
    discountApplications: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (o.codes || []).map((code, i) => ({
      allocationMethod: 'ACROSS', index: i, targetSelection: 'ALL', targetType: 'LINE_ITEM', value: { percentage: 10 }, code })) },
    refunds,
    lineItems: { nodes: specs.map((l, i) => {
      const price = l.price ?? 649.5 * l.qty;
      return {
        id: shLineGid(n, i), sku: l.sku ?? null, name: l.title || 'Vitamin D3', title: l.title || 'Vitamin D3', variantTitle: '60 caps',
        quantity: l.qty, currentQuantity: l.qty - refundedQty(i), refundableQuantity: l.qty - refundedQty(i), taxable: true, isGiftCard: false, requiresShipping: true,
        originalUnitPriceSet: shM('649.50'), discountedUnitPriceAfterAllDiscountsSet: shM('649.50'),
        originalTotalSet: shM(price), discountedTotalSet: shM(price - (l.discount ?? 0)), totalDiscountSet: shM(l.discount ?? 0),
        taxLines: [{ title: 'IGST', rate: 0.18, ratePercentage: 18, channelLiable: false, priceSet: shM('99.07') }],
        discountAllocations: l.discount ? [{ allocatedAmountSet: shM(l.discount), discountApplication: { index: 0 } }] : [],
      };
    }) },
  };
};
const SH_DETAIL = ['shippingLines', 'fulfillments', 'discountApplications', 'refunds', 'lineItems'];
const shPage = (conn, first, after) => {
  const start = after ? Number(after) : 0;
  return { pageInfo: { hasNextPage: start + first < conn.length, endCursor: String(start + Math.min(first, conn.length - start)) }, nodes: conn.slice(start, start + first) };
};
/**
 * A fake Admin GraphQL serving the four sync queries: the orders page (filtered by
 * the created_at / updated_at bounds, sorted by updatedAt, paged by cursor), the
 * per-order detail, follow-up line pages, and refund detail. Page sizes come
 * from the query text, so the test checks what is actually sent.
 */
const shFake = (store, { denyPii = false, calls = [], scopes = ['read_orders'] } = {}) => async (query, vars) => {
  const kind = (query.match(/^query (\w+)/) || [])[1];
  if (kind === 'BriyoAccessScopes') { calls.push({ kind }); return { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } }; }
  const first = Number((query.match(/(?:orders|lineItems)\(first: (\d+)/) || [])[1]);
  calls.push({ kind, first, after: vars.after, q: vars.query, pii: /shippingAddress \{/.test(query) });
  const find = (id) => store().find((x) => x.id === id);
  const lineConn = (order, after) => structuredClone(shPage(order.lineItems.nodes, first, after));
  if (kind === 'BriyoOrderDetail') {
    const o = find(vars.id); if (!o) return { order: null };
    return structuredClone({ order: { id: o.id, shippingLines: o.shippingLines, fulfillments: o.fulfillments, discountApplications: o.discountApplications,
      refunds: o.refunds.map(({ id, createdAt, note, totalRefundedSet }) => ({ id, createdAt, note, totalRefundedSet })), lineItems: lineConn(o, null) } });
  }
  if (kind === 'BriyoOrderLines') { const o = find(vars.id); return { order: o ? { id: o.id, lineItems: lineConn(o, vars.after) } : null }; }
  if (kind === 'BriyoRefundDetail') {
    const r = store().flatMap((o) => o.refunds).find((x) => x.id === vars.id);
    return structuredClone({ node: r ? { id: r.id, refundLineItems: r.refundLineItems, refundShippingLines: r.refundShippingLines } : null });
  }
  if (kind !== 'BriyoOrdersPage') throw new Error(`unexpected query ${kind}`);
  // A store that has not approved protected customer data: Shopify refuses the contact fields themselves.
  if (denyPii && /shippingAddress \{/.test(query)) throw new Error('Shopify GraphQL error: This app is not approved to access protected customer data (shippingAddress).');
  const q = vars.query || '';
  const ge = (field) => (q.match(new RegExp(`${field}:>='([^']+)'`)) || [])[1];
  const le = (field) => (q.match(new RegExp(`${field}:<='([^']+)'`)) || [])[1];
  const idq = (q.match(/(?:^|\s)id:(\d+)/) || [])[1];   // a single order by its numeric id, as Shopify's search does
  const rows = store().filter((x) => (!idq || x.id.split('/').pop() === idq) && (!ge('created_at') || x.createdAt >= ge('created_at')) && (!le('created_at') || x.createdAt <= le('created_at'))
    && (!ge('updated_at') || x.updatedAt >= ge('updated_at')) && (!le('updated_at') || x.updatedAt <= le('updated_at'))).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const page = shPage(rows, first, vars.after);
  // Like Shopify: fields that were not asked for are not returned (detail fields come from their own query).
  const shaped = page.nodes.map((x) => {
    const out = Object.fromEntries(Object.entries(x).filter(([k]) => !SH_DETAIL.includes(k)));
    if (!/customer \{/.test(query)) delete out.customer;
    if (!/shippingAddress \{/.test(query)) { delete out.shippingAddress; delete out.billingAddress; delete out.email; delete out.phone; }
    return structuredClone(out);
  });
  return { orders: { pageInfo: page.pageInfo, nodes: shaped } };
};
const shOrders = async () => (await getPool().query(`SELECT * FROM orders WHERE source_order_id LIKE $1 ORDER BY source_order_id`, [`${SH_PREFIX}%`])).rows;
const shItems = async () => (await getPool().query(`SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.source_order_id LIKE $1 ORDER BY i.source_line_item_id`, [`${SH_PREFIX}%`])).rows;
const shOps = async () => (await getPool().query(
  `SELECT (SELECT count(*) FROM inventory_movements m JOIN orders o ON o.id = m.order_id WHERE o.source_order_id LIKE $1)::int AS movements,
          (SELECT count(*) FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1)::int AS shipments,
          (SELECT count(*) FROM inventory_reservations r JOIN order_shipments s ON s.id = r.shipment_id JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1)::int AS reservations`,
  [`${SH_PREFIX}%`])).rows[0];
const byGid = (rows, n) => rows.find((r) => r.source_order_id === `${SH_PREFIX}${String(n).padStart(4, '0')}`);

await step('shopify orders: mapping — payment method/status, cancellation, SKUs never invented, test and oversized orders held back', async () => {
  const bad = [];
  const pm = [[['Cash on Delivery (COD)'], 'cod'], [['cash_on_delivery'], 'cod'], [['razorpay'], 'prepaid'], [['Razorpay Secure'], 'prepaid'], [['shopify_payments'], 'prepaid'],
    [['manual'], 'other'], [['gokwik'], 'other'], [['razorpay', 'gift_card'], 'other'], [['razorpay', 'Cash on Delivery (COD)'], 'cod'], [[], null]];
  for (const [g, want] of pm) if (shopifyPaymentMethod(g) !== want) bad.push(`method ${g} → ${shopifyPaymentMethod(g)}`);
  const ps = [['PENDING', 'pending'], ['AUTHORIZED', 'pending'], ['PAID', 'paid'], ['PARTIALLY_PAID', 'partially_paid'], ['REFUNDED', 'refunded'],
    ['PARTIALLY_REFUNDED', 'partially_refunded'], ['VOIDED', 'voided'], ['EXPIRED', null], ['', null]];
  for (const [s, want] of ps) if (shopifyPaymentStatus(s) !== want) bad.push(`status ${s} → ${shopifyPaymentStatus(s)}`);
  const m = mapShopifyOrder(shOrder(1, { lines: [{ sku: null, qty: 2, title: 'Gift box' }, { sku: 'ABC', qty: 1, discount: 50 }], gw: ['Cash on Delivery (COD)'], fin: 'PENDING' }));
  if (m.error || m.items[0].sku !== null || m.items[0].title !== 'Gift box — 60 caps' || m.items[1].promotion_discount !== -50 || m.items[0].shipping_price !== null) bad.push(`lines ${JSON.stringify(m.items)}`);
  if (m.payment_method !== 'cod' || m.payment_status !== 'pending' || m.customer_name !== 'Asha K' || m.order_value !== 1299 || m.source_order_id !== `${SH_PREFIX}0001`) bad.push('order fields');
  if (m.shopify.name !== shOrder(1).name || m.shopify.ship_to?.city !== 'Pune' || JSON.stringify(m.shopify).match(/shpat_|token|secret/i)) bad.push('payload');
  if (!mapShopifyOrder({ ...shOrder(2), lineItems: { pageInfo: { hasNextPage: true }, nodes: shOrder(2).lineItems.nodes } }).error) bad.push('order with more lines than fetched accepted');
  if (!mapShopifyOrder({ ...shOrder(5), incomplete: ['10 or more refunds; held back'] }).error) bad.push('incomplete order accepted');
  if (!mapShopifyOrder({ ...shOrder(3), id: '1001' }).error) bad.push('non-GID id accepted');
  if (!mapShopifyOrder(shOrder(4, { cancelled: true })).cancelled) bad.push('cancel flag');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'COD/prepaid/other/unknown and 7 financial statuses mapped without guessing; no SKU stays NULL (title never used); discounts negative; shipping kept on the order; non-GID ids, orders with unfetched lines and incompletely fetched orders refused';
});

await step('shopify orders: window, pagination, dry run writes nothing; import is idempotent; 60-day limit enforced', async () => {
  const bad = [];
  const store = [];
  for (let i = 1; i <= 120; i += 1) store.push(shOrder(i, { created: shDays(1 + (i % 19)), lines: [{ sku: `${TS}-SH-D3`, qty: 1 + (i % 3) }, { sku: 'SHOP-MAG-90', qty: 1 }] }));
  for (let i = 121; i <= 123; i += 1) store.push(shOrder(i, { created: shDays(45) }));
  store.push(shOrder(124, { test: true }));
  store.push(shOrder(125, { moreLines: true }));
  SH.store = store;
  const calls = [];
  const gql = shFake(() => SH.store, { calls });
  await expectErr('90 days', () => runShopifySync({ window: { days: 90 }, gql }), (e) => e.status === 400 && /60 days/.test(e.message));
  const imports0 = (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n;
  const p = await runShopifySync({ window: { days: 30 }, dryRun: true, gql });
  if (p.summary.found !== 122 || p.summary.newOrders !== 120 || p.summary.skippedTest !== 1 || p.summary.errors !== 1) bad.push(`preview ${JSON.stringify(p.summary)}`);
  const pages = calls.filter((c) => c.kind === 'BriyoOrdersPage');
  if (pages.length !== 13 || pages.some((c) => c.first !== 10)) bad.push(`pages ${pages.length}`);
  // Order 125 has 51 lines: fetched 6 + 8 + … up to the 50-line cap, then held back whole.
  const linePages = calls.filter((c) => c.kind === 'BriyoOrderLines');
  if (linePages.length !== 6 || linePages.some((c) => c.first !== 8) || calls.filter((c) => c.kind === 'BriyoOrderDetail').some((c) => c.first !== 6)) bad.push(`line pages ${linePages.length}`);
  if ((await shOrders()).length || (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n !== imports0) bad.push('dry run wrote');
  // Bounded runs: 50 at a time, then continue from the stored cursor.
  const r1 = await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR, maxOrders: 50 });
  if (!r1.summary.partial || r1.summary.ordersCreated !== 50) bad.push(`partial ${JSON.stringify(r1.summary)}`);
  const r2 = await runShopifySync({ dryRun: false, gql, actor: SH_ACTOR, resumeRunId: r1.runId });
  if (r2.summary.partial || r2.summary.ordersCreated !== 73) bad.push(`resume ${JSON.stringify(r2.summary)}`);
  const orders = await shOrders(); const items = await shItems();
  if (orders.length !== 123 || items.length !== 243) bad.push(`counts ${orders.length}/${items.length}`);
  const again = await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR });
  if (again.summary.ordersCreated !== 0 || again.summary.unchanged !== 123 || (await shOrders()).length !== 123 || (await shItems()).length !== 243) bad.push(`re-run ${JSON.stringify(again.summary)}`);
  const o = byGid(orders, 7);
  if (o.channel !== 'website' || o.source !== 'shopify_sync' || o.fulfillment_type !== 'merchant' || o.dispatch_type !== 'easy_ship' || o.order_status !== 'new'
    || o.payment_method !== 'prepaid' || o.payment_status !== 'paid' || o.source_payload.shopify.name !== shOrder(7).name) bad.push(`order ${JSON.stringify(o).slice(0, 300)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return '90-day window refused (read_orders = 60); 30-day preview: 122 found, 120 new, 1 test skipped, 1 oversized (51 lines) held back after 50 fetched, 13 pages of 10, 0 writes; import in bounded runs (50 + resume 73); re-run creates 0 orders and 0 lines';
});

await step('shopify orders: SKU resolution — master code, website mapping, unknown stays unmapped and resolves after mapping without re-import', async () => {
  const bad = [];
  SH.d3 = (await createSku({ sku: `${TS}-SH-D3`, product_name: 'Vitamin D3 (Shopify test)' }, { actor: ACTOR })).id;
  SH.mag = (await createSku({ sku: `${TS}-SH-MAG`, product_name: 'Magnesium (Shopify test)' }, { actor: ACTOR })).id;
  // Lines imported before the SKUs existed resolve on the next sync (unchanged lines included).
  SH.store.push(shOrder(130, { lines: [{ sku: `${TS}-SH-D3`, qty: 2 }, { sku: 'SHOP-MAG-90', qty: 1 }, { sku: 'SHOP-UNKNOWN-1', qty: 1, title: 'Zinc' }, { sku: null, qty: 1, title: 'Free shaker' }] }));
  const gql = shFake(() => SH.store);
  const pre = await runShopifySync({ window: { days: 60 }, dryRun: true, gql });
  if (pre.summary.unmappedSkus < 3) bad.push(`preview unmapped ${pre.summary.unmappedSkus}`);
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR });
  let items = (await shItems()).filter((i) => i.source_line_item_id.includes(`${SH_NUM}0130`));
  const at = (sku) => items.find((i) => i.sku === sku);
  if (at(`${TS}-SH-D3`)?.sku_id !== SH.d3) bad.push('exact master code not resolved');
  if (at('SHOP-MAG-90')?.sku_id !== null) bad.push('unmapped platform code resolved without a mapping');
  if (items.find((i) => i.sku === null)?.sku_id !== null) bad.push('blank SKU resolved');
  // An admin maps the Shopify SKU to the master: existing lines resolve, no re-import.
  await addPlatformMappings(SH.mag, 'website', ['SHOP-MAG-90'], { actor: ACTOR });
  items = (await shItems()).filter((i) => i.sku === 'SHOP-MAG-90');
  if (!items.length || items.some((i) => i.sku_id !== SH.mag)) bad.push(`mapping did not resolve existing lines (${items.filter((i) => i.sku_id !== SH.mag).length} left)`);
  if ((await shItems()).find((i) => i.sku === 'SHOP-UNKNOWN-1')?.sku_id !== null) bad.push('unknown code guessed');
  if ((await getPool().query(`SELECT count(*)::int n FROM skus WHERE sku ILIKE 'SHOP-%'`)).rows[0].n) bad.push('a SKU was created');
  const um = (await unmappedSkus()).find((u) => u.code === 'SHOP-UNKNOWN-1');
  if (!um || um.channel !== 'website' || !um.mappable) bad.push(`unmapped list ${JSON.stringify(um)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'master code → resolved; website platform SKU → resolved once mapped (existing lines updated, no re-import); unknown and blank stay unmapped and appear in Unmapped SKUs as mappable; no SKU created';
});

await step('shopify orders: import touches no stock, reservation or shipment; carts untouched', async () => {
  const ops = await shOps();
  const carts = (await getPool().query('SELECT count(*)::int n FROM abandoned_carts')).rows[0].n;
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store), actor: SH_ACTOR });
  const after = await shOps();
  if (ops.movements || ops.shipments || ops.reservations || after.movements || after.shipments || after.reservations) throw new Error(JSON.stringify({ ops, after }));
  if ((await getPool().query('SELECT count(*)::int n FROM abandoned_carts')).rows[0].n !== carts) throw new Error('cart board changed');
  return '0 stock movements, 0 reservations, 0 shipments after import and re-import; abandoned-cart table unchanged';
});

await step('shopify orders: changes — safe commercial updates, team payment kept, locked lines and shipped cancellations become conflicts', async () => {
  const bad = [];
  const gql = shFake(() => SH.store);
  const ix = (n) => SH.store.findIndex((x) => x.id === `${SH_PREFIX}${String(n).padStart(4, '0')}`);
  // Order 10: COD pending; the team marks it paid; Shopify still says pending.
  SH.store[ix(10)] = shOrder(10, { created: SH.store[ix(10)].createdAt, gw: ['Cash on Delivery (COD)'], fin: 'PENDING', updated: shDays(0.5) });
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR });
  let o10 = byGid(await shOrders(), 10);
  await updateOrder(o10.id, { payment_status: 'paid' }, { actor: ACTOR, version: o10.version });
  // Order 30: dispatched in Briyo. Order 31: stock reserved, not dispatched. Order 32: no shipment.
  const batch = (await receiveInventory({ sku_id: SH.d3, batch_number: 'SH-D3-01', expiry_date: dayOffset(400), quantity: 50, unit_cost: 100, request_id: rid() }, { actor: ACTOR })).batchId;
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  const lines = [{ sku: `${TS}-SH-D3`, qty: 2 }];
  for (const n of [121, 122, 123]) SH.store[ix(n)] = shOrder(n, { created: SH.store[ix(n)].createdAt, lines, updated: shDays(0.4) });
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR });
  let rows = await shOrders();
  for (const n of [121, 122]) {
    const o = byGid(rows, n);
    const r = await createShipmentForOrders([Number(o.id)], { courier_partner_id: dl.id, tracking_id: `AWB-SH-${n}-${SH_NUM}` }, { actor: ACTOR });
    await reserveShipmentStock(r.shipmentId, [{ batch_id: batch, quantity: 2 }], { actor: ACTOR });
    if (n === 121) {
      await addPhoto(Number(o.id));
      const sh = (await orderShipments(Number(o.id)))[0];
      await updateShipment(Number(o.id), sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
    }
  }
  const moves = (await shOps()).movements;
  // Shopify changes: 10 name + value; 30 qty + cancelled; 31 qty; 32 cancelled; also checkpoint-driven incremental mode.
  const now = new Date().toISOString();
  SH.store[ix(10)] = { ...shOrder(10, { created: SH.store[ix(10)].createdAt, gw: ['Cash on Delivery (COD)'], fin: 'PENDING', first: 'Ashwini', total: 1499 }), updatedAt: now };
  SH.store[ix(121)] = { ...shOrder(121, { created: SH.store[ix(121)].createdAt, lines: [{ sku: `${TS}-SH-D3`, qty: 5 }], cancelled: true }), updatedAt: now };
  SH.store[ix(122)] = { ...shOrder(122, { created: SH.store[ix(122)].createdAt, lines: [{ sku: `${TS}-SH-D3`, qty: 4 }] }), updatedAt: now };
  SH.store[ix(123)] = { ...shOrder(123, { created: SH.store[ix(123)].createdAt, lines, cancelled: true }), updatedAt: now };
  const pre = await runShopifySync({ window: { mode: 'incremental' }, dryRun: true, gql });
  if (pre.summary.conflicts !== 2) bad.push(`preview conflicts ${pre.summary.conflicts}`);
  const r = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  if (r.summary.found !== 4 || r.summary.conflicts !== 2) bad.push(`incremental ${JSON.stringify(r.summary)}`);
  rows = await shOrders(); const items = await shItems();
  o10 = byGid(rows, 10);
  if (o10.customer_name !== 'Ashwini K' || Number(o10.order_value) !== 1499 || o10.payment_status !== 'paid') bad.push(`order 10 ${o10.customer_name}/${o10.order_value}/${o10.payment_status}`);
  const qty = (n) => items.find((i) => i.order_id === byGid(rows, n).id).quantity;
  if (qty(121) !== 2 || qty(122) !== 2) bad.push(`locked lines changed ${qty(121)}/${qty(122)}`);
  if (byGid(rows, 121).order_status === 'cancelled') bad.push('dispatched order cancelled');
  if (byGid(rows, 123).order_status !== 'cancelled') bad.push('unshipped cancellation not applied');
  if ((await shOps()).movements !== moves) bad.push('stock moved');
  const ev = async (n) => (await getPool().query(`SELECT metadata->>'kind' k FROM order_events WHERE order_id = $1 AND event_type = 'shopify_sync_conflict'`, [byGid(rows, n).id])).rows.map((x) => x.k).sort();
  if ((await ev(121)).join() !== 'cancelled_with_shipment,lines_locked' || (await ev(122)).join() !== 'lines_locked') bad.push(`conflict events ${await ev(121)} / ${await ev(122)}`);
  // The same conflict is not re-logged on every sync.
  await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  if ((await ev(121)).length !== 2) bad.push('conflict re-logged');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'name/value updated; team-marked "paid" kept over Shopify "pending"; reserved (31) and dispatched (30) lines unchanged → lines_locked; Shopify cancel of dispatched 30 → conflict, of unshipped 32 → cancelled; no stock moved; conflicts logged once';
});

await step('shopify orders: locked order keeps its value — Shopify total change is one value_locked conflict, never duplicated by later polls', async () => {
  const bad = [];
  const gql = shFake(() => SH.store);
  const ix = (n) => SH.store.findIndex((x) => x.id === `${SH_PREFIX}${String(n).padStart(4, '0')}`);
  const lines = [{ sku: `${TS}-SH-D3`, qty: 1 }];
  // 1. Imported at ₹1,299 (two orders: one to reserve, one to dispatch).
  for (const n of [160, 161]) SH.store.push({ ...shOrder(n, { lines, total: 1299, created: shDays(0.3) }), updatedAt: new Date().toISOString() });
  await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  let rows = await shOrders();
  if ([160, 161].some((n) => Number(byGid(rows, n)?.order_value) !== 1299)) bad.push('not imported at 1299');
  // 2. Stock reserved (160) and dispatched (161).
  const batch = (await receiveInventory({ sku_id: SH.d3, batch_number: 'SH-D3-VAL', expiry_date: dayOffset(400), quantity: 10, unit_cost: 100, request_id: rid() }, { actor: ACTOR })).batchId;
  const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
  for (const n of [160, 161]) {
    const o = byGid(rows, n);
    const r = await createShipmentForOrders([Number(o.id)], { courier_partner_id: dl.id, tracking_id: `AWB-SHV-${n}-${SH_NUM}` }, { actor: ACTOR });
    await reserveShipmentStock(r.shipmentId, [{ batch_id: batch, quantity: 1 }], { actor: ACTOR });
    if (n === 161) {
      await addPhoto(Number(o.id));
      const sh = (await orderShipments(Number(o.id)))[0];
      await updateShipment(Number(o.id), sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version });
    }
  }
  // 3. Shopify total changes to ₹1,899 (lines unchanged).
  const now = new Date().toISOString();
  for (const n of [160, 161]) SH.store[ix(n)] = { ...shOrder(n, { created: SH.store[ix(n)].createdAt, lines, total: 1899 }), updatedAt: now };
  const pre = await runShopifySync({ window: { mode: 'incremental' }, dryRun: true, gql });
  if (pre.summary.conflicts < 2 || !(pre.conflicts || []).some((c) => c.conflicts.some((x) => x.kind === 'value_locked' && x.to === 1899))) bad.push(`preview ${JSON.stringify(pre.conflicts).slice(0, 200)}`);
  const run = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  // 4. Briyo keeps ₹1,299; Shopify's ₹1,899 is kept for reference.
  rows = await shOrders();
  for (const n of [160, 161]) {
    const o = byGid(rows, n);
    if (Number(o.order_value) !== 1299) bad.push(`${n} value overwritten → ${o.order_value}`);
    if (o.source_payload?.shopify?.current_total !== 1899) bad.push(`${n} latest Shopify total not kept`);
  }
  const audit = (await getPool().query(`SELECT conflicts, details FROM order_imports WHERE id = $1`, [run.runId])).rows[0];
  if (!(audit.conflicts >= 2 && (audit.details.conflicts || []).some((c) => c.conflicts.some((x) => x.kind === 'value_locked')))) bad.push('not in sync history');
  // 5–6. Recorded once; later polls with no Shopify change add nothing.
  const events = async () => (await getPool().query(
    `SELECT order_id, metadata FROM order_events WHERE event_type = 'shopify_sync_conflict' AND metadata->>'kind' = 'value_locked' AND order_id = ANY($1)`,
    [[160, 161].map((n) => Number(byGid(rows, n).id))])).rows;
  let ev = await events();
  if (ev.length !== 2 || ev.some((e) => Number(e.metadata.from) !== 1299 || Number(e.metadata.to) !== 1899 || !/Briyo keeps ₹1,299/.test(e.metadata.detail))) bad.push(`events ${JSON.stringify(ev.map((e) => e.metadata))}`);
  for (let i = 0; i < 3; i += 1) await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  ev = await events();
  if (ev.length !== 2) bad.push(`duplicated by polls: ${ev.length}`);
  if (Number(byGid(await shOrders(), 160).order_value) !== 1299) bad.push('value overwritten by a later poll');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'imported ₹1,299 → reserved (160) / dispatched (161) → Shopify ₹1,899: Briyo keeps ₹1,299, Shopify ₹1,899 kept in source_payload; one value_locked conflict per order, shown in run details; 3 more polls → still one each';
});

await step('shopify orders: manual duplicates held back; customer-data denial tolerated; audit rows; no credential anywhere', async () => {
  const bad = [];
  // A website order typed in by hand as "#SH-DUP" — the Shopify order with that name is not imported.
  const dupName = `#SHDUP${SH_NUM.slice(-4)}`;
  await createOrder({ channel: 'website', source_order_id: dupName.slice(1), dispatch_type: 'easy_ship' }, { actor: ACTOR });
  SH.store.push(shOrder(140, { name: dupName }));
  const r = await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store), actor: SH_ACTOR });
  if (r.summary.possibleDuplicates !== 1 || byGid(await shOrders(), 140)) bad.push('manual duplicate imported');
  // Protected customer data not approved: the sync carries on without it.
  SH.store.push(shOrder(141));
  const calls = [];
  const r2 = await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store, { denyPii: true, calls }), actor: SH_ACTOR });
  const o141 = byGid(await shOrders(), 141);
  if (r2.summary.customerDataAvailable !== false || !o141 || o141.customer_name !== null || calls.filter((c) => !c.pii).length < 1) bad.push('pii fallback');
  // Audit: every run is an order_imports row.
  const runs = (await getPool().query(`SELECT status, imported_by, orders_in_file, orders_created, conflicts, started_at, completed_at, details
    FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = $1 ORDER BY id`, [SH_ACTOR])).rows;
  if (runs.length < 8 || runs.some((x) => !x.started_at || !x.completed_at || !['completed', 'partial'].includes(x.status)) || !runs.some((x) => x.conflicts === 2)) bad.push(`audit ${runs.length}`);
  // The real client: token in a header to a stub, never in a URL, a result, a payload or the console.
  const secret = 'shpat_SHOULDNEVERLEAK0123456789';
  const seen = [];
  const stubFake = shFake(() => [shOrder(150)]);
  const stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    seen.push({ url: req.url, token: req.headers['x-shopify-access-token'], body: b });
    const { query, variables } = JSON.parse(b);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: await stubFake(query, variables || {}), extensions: { cost: { requestedQueryCost: 123, actualQueryCost: 50 } } }));
  }); });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  const keep = { ...process.env };
  const logs = []; const orig = { log: console.log, error: console.error, warn: console.warn };
  try {
    Object.assign(process.env, { APP_ENV: 'test', SHOPIFY_GRAPHQL_BASE: `http://127.0.0.1:${stub.address().port}`, SHOPIFY_STORE_DOMAIN: 'briyo-test.myshopify.com', SHOPIFY_ACCESS_TOKEN: secret });
    for (const k of ['log', 'error', 'warn']) console[k] = (...a) => logs.push(a.join(' '));
    const out = await runShopifySync({ window: { days: 60 }, dryRun: false, actor: SH_ACTOR });
    if (seen[0]?.token !== secret || seen.some((s) => s.token !== secret || s.url.includes(secret) || s.body.includes(secret))) bad.push('token transport');
    if (out.summary.maxRequestedQueryCost !== 123 || out.summary.shopifyRequests < 2) bad.push(`cost not captured ${out.summary.maxRequestedQueryCost}`);
    const o150 = byGid(await shOrders(), 150);
    const audit = (await getPool().query(`SELECT * FROM order_imports WHERE id = $1`, [out.runId])).rows[0];
    if ([JSON.stringify(out), JSON.stringify(o150), JSON.stringify(audit), logs.join('\n')].some((x) => x.includes(secret))) bad.push('token leaked');
    const status = await shopifyOrdersStatus();
    if (JSON.stringify(status).includes(secret) || !status.configured || status.ordersSynced < 120) bad.push(`status ${JSON.stringify(status).slice(0, 200)}`);
  } finally {
    for (const k of ['log', 'error', 'warn']) console[k] = orig[k];
    for (const k of ['APP_ENV', 'SHOPIFY_GRAPHQL_BASE', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ACCESS_TOKEN']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    stub.close();
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'hand-entered duplicate held back; protected customer data refused → imported without PII; every run audited (who, when, counts, conflicts); token only in the request header — not in URL, body, results, payloads, audit, status or logs';
});

/* ------------------------------------------------------------------ order financial snapshots (Phase 1B) */
const fsOrder = async (n) => (await getPool().query(`SELECT id, order_value FROM orders WHERE source_order_id = $1`, [`${SH_PREFIX}${String(n).padStart(4, '0')}`])).rows[0];
const fsSnaps = async (orderId) => (await getPool().query(`SELECT * FROM order_financial_snapshots WHERE order_id = $1 ORDER BY sequence`, [orderId])).rows;

await step('financial snapshots: every Shopify query stays under the 1,000-point cost limit at the approved page sizes', async () => {
  const bad = [];
  const want = { ordersPerPage: 10, linesPerOrder: 50, refundsPerOrder: 10, refundLines: 50, refundShippingLines: 5, discountApplications: 10 };
  for (const [k, v] of Object.entries(want)) if (SHOPIFY_LIMITS[k] !== v) bad.push(`${k} = ${SHOPIFY_LIMITS[k]}`);
  const out = [];
  for (const name of SHOPIFY_ORDER_QUERIES) {
    for (const pii of name === 'ordersPage' ? [true, false] : [true]) {
      const cost = estimateShopifyOrderQueryCost(name, { pii });
      if (!(cost > 0) || cost > SHOPIFY_MAX_QUERY_COST * 0.8) bad.push(`${name} costs ${cost} (needs ≥ 20% margin under ${SHOPIFY_MAX_QUERY_COST})`);
      out.push(`${name}${pii ? '' : ' (no PII)'} ${cost} (margin ${SHOPIFY_MAX_QUERY_COST - cost})`);
    }
  }
  // The text sent is the text costed: the sizes appear in it.
  const page = shopifyOrderQuery('ordersPage'); const detail = shopifyOrderQuery('orderDetail'); const refund = shopifyOrderQuery('refundDetail');
  if (!/orders\(first: 10,/.test(page) || !/refunds\(first: 10\)/.test(detail) || !/discountApplications\(first: 10\)/.test(detail)
    || !/refundLineItems\(first: 50\)/.test(refund) || !/refundShippingLines\(first: 5\)/.test(refund)) bad.push('sizes not in query text');
  for (const f of ['taxesIncluded', 'presentmentCurrencyCode', 'totalRefundedSet', 'totalRefundedShippingSet', 'discountCodes', 'customAttributes', 'currentSubtotalPriceSet', 'currentShippingPriceSet'])
    if (!page.includes(f)) bad.push(`page query lacks ${f}`);
  for (const f of ['originalUnitPriceSet', 'discountAllocations', 'taxLines', 'refunds']) if (!detail.includes(f)) bad.push(`detail query lacks ${f}`);
  // variant / product need read_products, which the app does not hold: never requested.
  for (const q of [detail, shopifyOrderQuery('orderLines')]) if (/\b(variant|product) \{/.test(q)) bad.push('a line query requests variant or product');
  if (bad.length) throw new Error(bad.join(' | '));
  return `limit ${SHOPIFY_MAX_QUERY_COST}: ${out.join('; ')}`;
});

await step('financial snapshots: schema is additive and idempotent; FK RESTRICT; NUMERIC(14,2); append-only', async () => {
  const bad = [];
  await ensureOrderFinancialSnapshotSchema(); await ensureOrderFinancialSnapshotSchema();
  const { rows: cols } = await getPool().query(`SELECT table_name, column_name, numeric_precision, numeric_scale FROM information_schema.columns
    WHERE table_name = ANY($1) AND data_type = 'numeric'`, [FINANCIAL_TABLES]);
  if (cols.length < 20 || cols.some((c) => c.numeric_precision !== 14 || c.numeric_scale !== 2)) bad.push(`money columns ${cols.length}`);
  const { rows: [fk] } = await getPool().query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'order_financial_snapshots'::regclass AND contype = 'f'`);
  if (fk?.confdeltype !== 'r') bad.push(`order FK on delete = ${fk?.confdeltype}`);
  const o = await fsOrder(7); const [snap] = await fsSnaps(o.id); const held = (await fsSnaps(o.id)).length;
  if (!snap) throw new Error('order 7 has no snapshot');
  await expectErr('update', () => getPool().query(`UPDATE order_financial_snapshots SET current_total_price = 0 WHERE id = $1`, [snap.id]), (e) => /append-only/.test(e.message));
  await expectErr('delete', () => getPool().query(`DELETE FROM order_financial_snapshot_lines WHERE snapshot_id = $1`, [snap.id]), (e) => /append-only/.test(e.message));
  await expectErr('order delete', () => getPool().query(`DELETE FROM orders WHERE id = $1`, [o.id]), (e) => ['23503', '23001'].includes(e.code) || /append-only|violates/.test(e.message));
  if ((await fsSnaps(o.id)).length !== held || (await fsSnaps(o.id))[0].current_total_price !== snap.current_total_price) bad.push('snapshot changed');
  if (bad.length) throw new Error(bad.join(' | '));
  return `5 tables; ${cols.length} money columns all NUMERIC(14,2); orders FK ON DELETE RESTRICT; UPDATE / DELETE refused by trigger; order delete blocked`;
});

await step('financial snapshots: exact amounts, lines, discounts, attributes and refunds captured as Shopify states them', async () => {
  const bad = [];
  // Order 170: two lines, a code discount, Briyo attribution attributes, one partial refund with shipping.
  SH.store.push({ ...shOrder(170, { lines: [{ sku: `${TS}-SH-D3`, qty: 2, discount: 129.9 }, { sku: 'SHOP-MAG-90', qty: 1 }], codes: ['BRIYO10'],
    attributes: [{ key: '_briyo_ref', value: 'AFF-123' }, { key: '_briyo_click', value: 'clk_9' }], total: '1818.60', subtotal: '1818.60', discounts: '129.90',
    refunded: '698.50', refundedShipping: '49.00', fin: 'PARTIALLY_REFUNDED',
    refunds: [{ total: '698.50', lines: [{ i: 1, qty: 1, subtotal: '649.50', tax: '99.07' }], shipping: '49.00' }] }), updatedAt: new Date().toISOString() });
  const r = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql: shFake(() => SH.store), actor: SH_ACTOR });
  if (r.summary.financialSnapshotsRecorded < 1 || typeof r.summary.shopifyRequests !== 'number') bad.push(`summary ${JSON.stringify(r.summary)}`);
  const o = await fsOrder(170); const [s] = await fsSnaps(o.id);
  if (!s || s.sequence !== 1 || s.current_total_price !== '1818.60' || s.total_refunded !== '698.50' || s.total_refunded_shipping !== '49.00'
    || s.current_total_discounts !== '129.90' || s.taxes_included !== true || s.shop_currency !== 'INR' || s.presentment_currency !== 'INR') bad.push(`header ${JSON.stringify(s).slice(0, 300)}`);
  if (s.money.current_total_price.shop.amount !== '1818.60' || s.money.current_total_price.presentment.currency !== 'INR') bad.push('money strings');
  if (s.discount_codes.join() !== 'BRIYO10' || s.discount_applications[0]?.code !== 'BRIYO10' || s.discount_applications[0]?.value?.percentage !== '10') bad.push(`discounts ${JSON.stringify(s.discount_applications)}`);
  if (!s.custom_attributes.some((a) => a.key === '_briyo_ref' && a.value === 'AFF-123') || !s.custom_attributes.some((a) => a.key === '_briyo_click')) bad.push('attributes');
  // The order's customer object needs read_customers and is no longer requested: the customer id stays empty.
  if (s.shopify_customer_gid !== null) bad.push('customer gid');
  const lines = (await getPool().query(`SELECT * FROM order_financial_snapshot_lines WHERE snapshot_id = $1 ORDER BY position`, [s.id])).rows;
  if (lines.length !== 2 || lines[0].original_unit_price !== '649.50' || lines[0].total_discount !== '129.90' || lines[0].discounted_total !== '1169.10'
    || lines[0].tax_amount !== '99.07' || lines[0].discount_allocations[0]?.application_index !== 0 || lines[0].shopify_variant_gid !== null || lines[0].shopify_product_gid !== null
    || lines[1].current_quantity !== 0 || lines[1].quantity !== 1) bad.push(`lines ${JSON.stringify(lines.map((l) => [l.original_unit_price, l.total_discount, l.discounted_total, l.current_quantity]))}`);
  const refunds = (await getPool().query(`SELECT * FROM order_financial_snapshot_refunds WHERE snapshot_id = $1`, [s.id])).rows;
  const rl = refunds[0] && (await getPool().query(`SELECT * FROM order_financial_snapshot_refund_lines WHERE refund_id = $1`, [refunds[0].id])).rows;
  const rs = refunds[0] && (await getPool().query(`SELECT * FROM order_financial_snapshot_refund_shipping WHERE refund_id = $1`, [refunds[0].id])).rows;
  if (refunds.length !== 1 || refunds[0].total_refunded !== '698.50' || !refunds[0].refunded_at || rl?.length !== 1 || rl[0].quantity !== 1 || rl[0].subtotal !== '649.50'
    || rl[0].total_tax !== '99.07' || rl[0].shopify_line_gid !== lines[1].shopify_line_gid || rs?.length !== 1 || rs[0].subtotal !== '49.00') bad.push('refunds');
  // Exact arithmetic and refusal to round.
  if (addAmounts(['0.10', '0.20']) !== '0.30' || addAmounts(['1299', '-0.01']) !== '1298.99') bad.push('addAmounts');
  const thin = shOrder(171); thin.currentTotalPriceSet = shM('10.005');
  await expectErr('3 decimals', async () => financialSnapshotFrom(thin), (e) => /more than 2 decimal/.test(e.message));
  if (!mapShopifyOrder({ ...shOrder(172), taxesIncluded: undefined }).error) bad.push('order without taxesIncluded accepted');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'totals, refunded and refunded shipping as exact NUMERIC + verbatim strings; BRIYO10 code + application; _briyo_ref/_briyo_click kept; 2 lines with unit price, discount allocation, tax, variant/product; 1 refund with its line and shipping; 0.1 + 0.2 = 0.30; 3-decimal amount refused; missing taxesIncluded held back';
});

await step('financial snapshots: idempotent — unchanged or tags-only re-syncs add nothing; a refund adds sequence 2 and keeps sequence 1', async () => {
  const bad = [];
  const gql = shFake(() => SH.store);
  const ix = (n) => SH.store.findIndex((x) => x.id === `${SH_PREFIX}${String(n).padStart(4, '0')}`);
  const count = async () => (await getPool().query(`SELECT count(*)::int n FROM order_financial_snapshots s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1`, [`${SH_PREFIX}%`])).rows[0].n;
  const before = await count();
  const again = await runShopifySync({ window: { days: 60 }, dryRun: false, gql, actor: SH_ACTOR });
  if (again.summary.financialSnapshotsRecorded !== 0 || (await count()) !== before) bad.push(`re-sync recorded ${again.summary.financialSnapshotsRecorded}`);
  // Shopify touches the order (a tag), nothing financial: no new snapshot.
  SH.store[ix(7)] = { ...SH.store[ix(7)], tags: ['vip'], updatedAt: new Date().toISOString() };
  const touched = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  if (touched.summary.financialSnapshotsRecorded !== 0) bad.push('tag change recorded a snapshot');
  // Order 7 is refunded in full: preview counts it without writing; commit records sequence 2.
  const o7 = await fsOrder(7); const [first] = await fsSnaps(o7.id);
  SH.store[ix(7)] = { ...shOrder(7, { created: SH.store[ix(7)].createdAt, lines: SH.store[ix(7)].lineItems.nodes.map((l) => ({ sku: l.sku, qty: l.quantity })),
    fin: 'REFUNDED', refunded: '1299.00', total: '0.00', refunds: [{ total: '1299.00', lines: [{ i: 0, qty: SH.store[ix(7)].lineItems.nodes[0].quantity, subtotal: '1299.00' }] }] }),
  updatedAt: new Date().toISOString() };
  const pre = await runShopifySync({ window: { mode: 'incremental' }, dryRun: true, gql });
  if (pre.summary.newFinancialSnapshots !== 1 || (await fsSnaps(o7.id)).length !== 1) bad.push(`preview ${pre.summary.newFinancialSnapshots}`);
  const r = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  const snaps = await fsSnaps(o7.id);
  if (r.summary.financialSnapshotsRecorded !== 1 || snaps.length !== 2 || snaps[1].sequence !== 2 || snaps[1].total_refunded !== '1299.00' || snaps[1].sync_run_id !== String(r.runId)
    || snaps[0].id !== first.id || snaps[0].total_refunded !== first.total_refunded || snaps[0].content_hash === snaps[1].content_hash) bad.push(`evolution ${JSON.stringify(snaps.map((x) => [x.sequence, x.total_refunded]))}`);
  const latest = (await getPool().query(`SELECT sequence FROM order_financial_latest WHERE order_id = $1`, [o7.id])).rows[0];
  if (latest?.sequence !== 2) bad.push('latest view');
  if (bad.length) throw new Error(bad.join(' | '));
  return `full re-sync → 0 new; tags-only update → 0 new; full refund → preview 1 (0 written), commit sequence 2 with ₹1,299.00 refunded; sequence 1 unchanged; latest view = 2`;
});

await step('financial snapshots: locked orders still get snapshots, without touching order value, lines or stock', async () => {
  const bad = [];
  const ops = await shOps();
  for (const n of [160, 161]) {
    const o = await fsOrder(n); const snaps = await fsSnaps(o.id);
    if (Number(o.order_value) !== 1299) bad.push(`${n} value ${o.order_value}`);
    if (!snaps.length || snaps.at(-1).current_total_price !== '1899.00') bad.push(`${n} latest snapshot ${snaps.at(-1)?.current_total_price}`);
    const items = (await getPool().query(`SELECT quantity FROM order_items WHERE order_id = $1`, [o.id])).rows;
    if (items.length !== 1 || items[0].quantity !== 1) bad.push(`${n} items`);
  }
  const after = await shOps();
  if (JSON.stringify(ops) !== JSON.stringify(after)) bad.push('stock touched');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'reserved (160) and dispatched (161): Briyo keeps ₹1,299 and its lines; the snapshot records Shopify ₹1,899.00; no stock, reservation or shipment change';
});

await step('financial snapshots: incomplete Shopify data holds the order back; a failed snapshot write rolls the page back', async () => {
  const bad = [];
  const gql = shFake(() => SH.store);
  const now = () => new Date().toISOString();
  // 10 refunds (the list could be cut off) and a refund whose lines page on: both held back whole.
  const many = Array.from({ length: 10 }, () => ({ total: '1.00', lines: [] }));
  SH.store.push({ ...shOrder(180, { refunds: many }), updatedAt: now() });
  const paged = shOrder(181, { refunds: [{ total: '1.00', lines: [] }] }); paged.refunds[0].refundLineItems.pageInfo.hasNextPage = true;
  SH.store.push({ ...paged, updatedAt: now() });
  const r = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  const reasons = r.errors.map((e) => e.reason).join(' | ');
  if (await fsOrder(180) || await fsOrder(181) || !/10 or more refunds/.test(reasons) || !/more than 50 lines/.test(reasons)) bad.push(`hold-back ${reasons}`);
  // A snapshot write that fails takes its whole page with it: no order, no line, no snapshot.
  await getPool().query(`CREATE OR REPLACE FUNCTION dbcheck_fail_snapshot() RETURNS trigger AS $$ BEGIN
    IF NEW.shopify_order_gid = '${SH_PREFIX}0190' THEN RAISE EXCEPTION 'simulated snapshot failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await getPool().query(`CREATE TRIGGER dbcheck_fail_snapshot BEFORE INSERT ON order_financial_snapshots FOR EACH ROW EXECUTE FUNCTION dbcheck_fail_snapshot()`);
  try {
    SH.store.push({ ...shOrder(190), updatedAt: now() }, { ...shOrder(191), updatedAt: now() });
    await expectErr('sync', () => runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR }), (e) => /simulated snapshot failure/.test(e.message));
    if (await fsOrder(190) || await fsOrder(191)) bad.push('page not rolled back');
  } finally {
    await getPool().query(`DROP TRIGGER IF EXISTS dbcheck_fail_snapshot ON order_financial_snapshots; DROP FUNCTION IF EXISTS dbcheck_fail_snapshot()`);
  }
  const ok = await runShopifySync({ window: { mode: 'incremental' }, dryRun: false, gql, actor: SH_ACTOR });
  if (!(await fsOrder(190)) || !(await fsSnaps((await fsOrder(191)).id)).length || ok.summary.financialSnapshotsRecorded < 2) bad.push('retry did not import');
  if (bad.length) throw new Error(bad.join(' | '));
  return '10 refunds → held back; refund lines beyond 50 → held back; snapshot failure → page rolled back (0 orders, 0 snapshots); next run imports both with snapshots';
});

await step('financial snapshots: paging and hold-back boundaries — every line once up to 50; refunds, refund lines, refund shipping, discounts and tax lines at their limits', async () => {
  const bad = [];
  const at = new Date().toISOString();
  const M = (a) => shM(a);
  // A Shopify that honours every size in the query text, as the real API does: connections page by cursor,
  // plain lists (refunds, taxLines) return at most `first`.
  const conn = (all, first, after) => { const s = after ? Number(after) : 0; const nodes = all.slice(s, s + first);
    return { pageInfo: { hasNextPage: s + first < all.length, endCursor: String(s + nodes.length) }, nodes }; };
  const build = (n, { lines = 1, refunds = 0, refundLines = 0, refundShip = 0, discounts = 0, tax = 1 } = {}) => {
    const key = `${SH_NUM}${String(n).padStart(4, '0')}`;
    const L = Array.from({ length: lines }, (_, i) => ({ id: `gid://shopify/LineItem/${key}${String(i).padStart(3, '0')}`, sku: `${TS}-BND-${i}`, name: `Line ${i}`, title: `Line ${i}`,
      variantTitle: null, quantity: 1, currentQuantity: 1, refundableQuantity: 1, taxable: true, isGiftCard: false, requiresShipping: true,
      variant: { id: 'gid://shopify/ProductVariant/1' }, product: { id: 'gid://shopify/Product/1' },
      originalUnitPriceSet: M('10.00'), discountedUnitPriceAfterAllDiscountsSet: M('10.00'), originalTotalSet: M('10.00'), discountedTotalSet: M('10.00'), totalDiscountSet: M('0.00'),
      taxLines: Array.from({ length: tax }, (_, k) => ({ title: `T${k}`, rate: 0.01, ratePercentage: 1, channelLiable: false, priceSet: M('0.10') })), discountAllocations: [] }));
    const RF = Array.from({ length: refunds }, (_, k) => ({ id: `gid://shopify/Refund/${key}${k}`, createdAt: at, note: null, totalRefundedSet: M('1.00'),
      lines: Array.from({ length: refundLines }, (_, j) => ({ id: `gid://shopify/RefundLineItem/${key}${k}${j}`, quantity: 0, restockType: 'NO_RESTOCK', restocked: false,
        lineItem: { id: L[0].id }, priceSet: M('0.00'), subtotalSet: M('0.00'), totalTaxSet: M('0.00') })),
      ship: Array.from({ length: refundShip }, (_, j) => ({ id: `gid://shopify/RefundShippingLine/${key}${k}${j}`, shippingLine: { title: 'Standard', code: 'STD' },
        subtotalAmountSet: M('0.00'), taxAmountSet: M('0.00') })) }));
    const DA = Array.from({ length: discounts }, (_, i) => ({ allocationMethod: 'ACROSS', index: i, targetSelection: 'ALL', targetType: 'LINE_ITEM', value: { percentage: 1 }, code: `C${i}` }));
    const { lineItems: _l, refunds: _r, discountApplications: _d, shippingLines: _s, fulfillments: _f, ...head } = shOrder(n, { created: at, updated: at });
    return { head, L, RF, DA };
  };
  const cases = [
    ['lines', 50, { lines: 50 }, true], ['lines', 51, { lines: 51 }, false],
    ['refunds', 9, { refunds: 9 }, true], ['refunds', 10, { refunds: 10 }, false],
    ['refund lines', 50, { refunds: 1, refundLines: 50 }, true], ['refund lines', 51, { refunds: 1, refundLines: 51 }, false],
    ['refund shipping lines', 5, { refunds: 1, refundShip: 5 }, true], ['refund shipping lines', 6, { refunds: 1, refundShip: 6 }, false],
    ['discount applications', 10, { discounts: 10 }, true], ['discount applications', 11, { discounts: 11 }, false],
    ['tax lines', 4, { tax: 4 }, true], ['tax lines', 5, { tax: 5 }, false],
    ['lines', 14, { lines: 14 }, true],
  ];
  const store = cases.map((c, i) => build(200 + i, c[2]));
  const served = new Map();
  const size = (q, re) => Number((q.match(re) || [])[1]);
  const gql = async (q, v) => {
    const kind = q.match(/^query (\w+)/)[1];
    const find = (id) => store.find((o) => o.head.id === id);
    const lines = (o, after) => { const c = conn(o.L, size(q, /lineItems\(first: (\d+)/), after);
      served.set(o.head.id, [...(served.get(o.head.id) || []), ...c.nodes.map((x) => x.id)]);
      return structuredClone({ ...c, nodes: c.nodes.map((x) => ({ ...x, taxLines: x.taxLines.slice(0, size(q, /taxLines\(first: (\d+)\)/)) })) }); };
    if (kind === 'BriyoOrdersPage') { const c = conn(store, size(q, /orders\(first: (\d+)/), v.after); return { orders: { ...c, nodes: c.nodes.map((o) => structuredClone(o.head)) } }; }
    if (kind === 'BriyoOrderDetail') { const o = find(v.id); return { order: structuredClone({ id: o.head.id, shippingLines: conn([], 5), fulfillments: [],
      discountApplications: conn(o.DA, size(q, /discountApplications\(first: (\d+)\)/)),
      refunds: o.RF.slice(0, size(q, /refunds\(first: (\d+)\)/)).map(({ id, createdAt, note, totalRefundedSet }) => ({ id, createdAt, note, totalRefundedSet })),
      lineItems: lines(o, null) }) }; }
    if (kind === 'BriyoOrderLines') { const o = find(v.id); return { order: { id: o.head.id, lineItems: lines(o, v.after) } }; }
    if (kind === 'BriyoRefundDetail') { const r = store.flatMap((o) => o.RF).find((x) => x.id === v.id);
      return { node: structuredClone({ id: r.id, refundLineItems: conn(r.lines, size(q, /refundLineItems\(first: (\d+)\)/)),
        refundShippingLines: conn(r.ship, size(q, /refundShippingLines\(first: (\d+)\)/)) }) }; }
    throw new Error(`unexpected query ${kind}`);
  };
  const r = await runShopifySync({ window: { days: 1 }, dryRun: false, gql, actor: SH_ACTOR, backoffMs: 1 });
  const out = [];
  for (const [i, [what, n, , accept]] of cases.entries()) {
    const o = store[i]; const row = await fsOrder(200 + i);
    if (Boolean(row) !== accept) bad.push(`${what} ${n}: ${row ? 'accepted' : `held back (${(r.errors.find((e) => e.shopifyId === o.head.id) || {}).reason})`}`);
    if (!row && !(r.errors.find((e) => e.shopifyId === o.head.id)?.reason)) bad.push(`${what} ${n}: held back without a reason`);
    if (what === 'lines') {
      const sv = served.get(o.head.id) || [];
      if (sv.length !== new Set(sv).size) bad.push(`${what} ${n}: a line was fetched twice`);
      if (row) {
        const want = o.L.map((x) => x.id);
        const snap = (await getPool().query(`SELECT l.shopify_line_gid FROM order_financial_snapshot_lines l JOIN order_financial_snapshots s ON s.id = l.snapshot_id
          WHERE s.order_id = $1 ORDER BY l.position`, [row.id])).rows.map((x) => x.shopify_line_gid);
        const items = (await getPool().query(`SELECT source_line_item_id FROM order_items WHERE order_id = $1`, [row.id])).rows.map((x) => x.source_line_item_id);
        if (snap.join() !== want.join()) bad.push(`${what} ${n}: snapshot lines ${snap.length}, not exactly the ${want.length} lines in order`);
        if (items.length !== want.length || items.slice().sort().join() !== want.slice().sort().join()) bad.push(`${what} ${n}: order items ${items.length}`);
      }
    }
    out.push(`${what} ${n} ${row ? 'accepted' : 'held'}`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return `${out.join('; ')}; 14- and 50-line orders: every line exactly once in order (6 + 8 + … paging)`;
});

await step('shopify orders: contact and addresses come from the order itself (read_orders); a missing customer object never drops them', async () => {
  const bad = [];
  // The page query no longer asks for `customer` (read_customers); it asks for the order's own contact fields.
  const page = shopifyOrderQuery('ordersPage');
  if (/customer \{/.test(page) || !/\bemail\b/.test(page) || !/\bphone\b/.test(page) || !/shippingAddress \{/.test(page) || !/billingAddress \{/.test(page)) bad.push('page query fields');
  if (estimateShopifyOrderQueryCost('ordersPage') > 600) bad.push('page query cost');
  const noCustomer = (n, o) => { const x = shOrder(n, o); delete x.customer; return x; };
  // A. complete contact, shipping and billing.
  const a = mapShopifyOrder(noCustomer(601, { first: 'Meera' }));
  if (a.customer_name !== 'Meera K' || a.customer_email !== 'buyer@example.test' || a.customer_phone !== '+919800000001'
    || a.shopify.ship_to?.address_1 !== '12 MG Road' || a.shopify.ship_to.postal_code !== '411001' || a.shopify.ship_to.country !== 'IN'
    || a.shopify.bill_to?.address_1 !== '4 FC Road' || a.shopify.bill_to.address_2 !== 'Flat 2' || a.shopify.bill_to.postal_code !== '411004') bad.push(`A complete ${JSON.stringify([a.customer_name, a.customer_email, a.customer_phone, a.shopify.ship_to, a.shopify.bill_to])}`);
  // B. customer object null, order-level contact present (what Shopify returns now).
  const b = mapShopifyOrder({ ...shOrder(602, { phone: '+919811111111' }), customer: null });
  if (b.customer_email !== 'buyer@example.test' || b.customer_phone !== '+919811111111' || b.customer_name !== 'Asha K' || !b.shopify.ship_to) bad.push('B customer null');
  // C. partial / null address.
  const c = mapShopifyOrder(noCustomer(603, { ship: { name: null, phone: null, address1: '9 Hill Rd', address2: null, city: null, province: null, zip: '400050', countryCodeV2: null }, bill: null }));
  if (c.error || c.shopify.ship_to?.address_1 !== '9 Hill Rd' || c.shopify.ship_to.city !== null || c.shopify.ship_to.postal_code !== '400050' || 'bill_to' in c.shopify
    || c.customer_name !== null || c.customer_phone !== null) bad.push(`C partial ${JSON.stringify([c.error, c.shopify?.ship_to, c.customer_name, c.customer_phone])}`);
  // Billing name / phone fill in when the shipping address has none.
  const c2 = mapShopifyOrder(noCustomer(604, { phone: null, ship: null }));
  if (c2.customer_name !== 'Asha K' || c2.customer_phone !== '+919800000002' || c2.shopify.ship_to !== null) bad.push('billing fallback');
  // D. missing phone everywhere.
  const d = mapShopifyOrder(noCustomer(605, { phone: null, ship: { name: 'Ravi S', phone: null, address1: 'x', city: 'Goa', zip: '403001', countryCodeV2: 'IN' }, bill: null }));
  if (d.customer_phone !== null || d.customer_email !== 'buyer@example.test' || d.customer_name !== 'Ravi S') bad.push('D no phone');
  // E. missing email.
  const e = mapShopifyOrder(noCustomer(606, { email: null }));
  if (e.customer_email !== null || e.customer_phone !== '+919800000001' || !e.shopify.ship_to) bad.push('E no email');
  // F. nothing at all.
  const f = mapShopifyOrder(noCustomer(607, { email: null, phone: null, ship: null, bill: null }));
  if (f.error || f.customer_name !== null || f.customer_email !== null || f.customer_phone !== null || f.shopify.ship_to !== null || 'bill_to' in f.shopify) bad.push('F nothing');
  // G + H. GoKwik attributes and the referral payload are untouched; the financial snapshot keeps every attribute.
  const gkAttrs = [{ key: 'gokwik_cid', value: 'abc' }, { key: 'full_url', value: 'https://briyo-supp.myshopify.com/r/B7K4P9?utm_source=affiliate' },
    { key: '__briyo_ref', value: 'B7K4P9' }, { key: '__briyo_click', value: 'abcDEF123_-xyzXYZ98765' }];
  const g = mapShopifyOrder(noCustomer(608, { attributes: gkAttrs }));
  if (g.shopify.referral?.ref !== 'B7K4P9' || g.shopify.referral.click !== 'abcDEF123_-xyzXYZ98765' || g.financial.custom_attributes.length !== 4
    || g.financial.shopify_customer_gid !== null || g.customer_email !== 'buyer@example.test') bad.push('G/H attributes or referral');
  // Through the real sync: an order imported without contact data (store refusing protected data) gets it on a later normal sync —
  // same order, no new snapshot, nothing else touched.
  SH.store.push({ ...shOrder(609, { first: 'Kiran', created: shDays(0.2) }), updatedAt: new Date().toISOString() });
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store, { denyPii: true }), actor: SH_ACTOR });
  const before = (await getPool().query(`SELECT id, customer_name, customer_email, customer_phone, order_value, source_payload FROM orders WHERE source_order_id = $1`, [`${SH_PREFIX}0609`])).rows[0];
  if (!before || before.customer_name !== null || before.source_payload.shopify.ship_to !== null) bad.push('setup: imported without contact');
  const snaps0 = (await getPool().query('SELECT count(*)::int n FROM order_financial_snapshots WHERE order_id = $1', [before?.id])).rows[0].n;
  const pre = await runShopifySync({ window: { days: 60 }, dryRun: true, gql: shFake(() => SH.store) });
  const r = await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store), actor: SH_ACTOR });
  const after = (await getPool().query(`SELECT id, customer_name, customer_email, customer_phone, order_value, source_payload FROM orders WHERE source_order_id = $1`, [`${SH_PREFIX}0609`])).rows[0];
  if (r.summary.customerDataAvailable !== true || pre.summary.newOrders !== 0 || r.summary.ordersCreated !== 0) bad.push(`re-sync summary ${JSON.stringify([pre.summary.newOrders, r.summary.ordersCreated, r.summary.customerDataAvailable])}`);
  if (after.id !== before.id || after.customer_name !== 'Kiran K' || after.customer_email !== 'buyer@example.test' || after.customer_phone !== '+919800000001'
    || after.source_payload.shopify.ship_to?.city !== 'Pune' || after.source_payload.shopify.bill_to?.postal_code !== '411004' || Number(after.order_value) !== Number(before.order_value)) bad.push(`re-sync fill ${JSON.stringify([after.customer_name, after.customer_email, after.source_payload.shopify.ship_to])}`);
  if ((await getPool().query('SELECT count(*)::int n FROM order_financial_snapshots WHERE order_id = $1', [after.id])).rows[0].n !== snaps0) bad.push('contact change created a financial snapshot');
  // A later sync where Shopify returns no contact never wipes what is recorded.
  await runShopifySync({ window: { days: 60 }, dryRun: false, gql: shFake(() => SH.store, { denyPii: true }), actor: SH_ACTOR });
  const kept = (await getPool().query(`SELECT customer_name, customer_email FROM orders WHERE id = $1`, [after.id])).rows[0];
  if (kept.customer_name !== 'Kiran K' || kept.customer_email !== 'buyer@example.test') bad.push('contact wiped by a sync without contact data');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'query asks for email, phone, shipping and billing address, not customer; complete / customer-null / partial address / billing fallback / no phone / no email / nothing all map without error and nulls stay null; GoKwik attributes and referral untouched; an order imported without contact data is filled by a later sync (same order, no new snapshot) and never wiped by one without it';
});

await step('shared order-sync runner and HTTP retry (lib/order-sync-runner.js, lib/http-retry.js): windows, checkpoint rule, lifecycle, chains, one at a time, retry policy', async () => {
  const bad = [];
  const R = await import('../lib/order-sync-runner.js');
  const H = await import('../lib/http-retry.js');
  // Windows: overlap below the checkpoint, fixed watermark at `now`.
  const now = new Date('2026-10-09T10:00:00.000Z');
  const w = R.incrementalWindow('2026-10-09T09:00:00.000Z', now, 5 * 60000);
  if (w.mode !== 'incremental' || w.since !== '2026-10-09T08:55:00.000Z' || w.until !== '2026-10-09T10:00:00.000Z') bad.push(`window ${JSON.stringify(w)}`);
  // Checkpoint rule: never on partial or single-order; watermark, chain start or run start otherwise.
  const st = new Date('2026-10-09T10:00:05.000Z');
  const cases = [[w, false, '2026-10-09T10:00:00.000Z'], [w, true, null], [{ mode: 'order' }, false, null],
    [{ mode: 'all', chain_started_at: '2026-10-01T00:00:00.000Z' }, false, '2026-10-01T00:00:00.000Z'], [{ mode: 'window' }, false, st.toISOString()]];
  for (const [win, partial, want] of cases) if (R.checkpointAfter(win, { partial, startedAt: st }) !== want) bad.push(`checkpoint ${JSON.stringify(win)} ${partial}`);
  // Lifecycle on a test kind: open (resumed run keeps its cursor), progress, fail, complete; resume rules.
  const db = getPool();
  const KIND = 'dbcheck_runner_sync';
  try {
    const id1 = await R.openRun(db, { channel: 'website', kind: KIND, actor: 'dbcheck-runner', filename: 'runner test', window: w });
    await R.recordPageProgress(db, id1, { cursor: 'C2', fetched: 10 });
    await R.completeRun(db, id1, { partial: true, fetched: 10, created: 4, updated: 1, unchanged: 5, itemsCreated: 4, itemsUpdated: 0, errors: 0, reportedErrors: [], conflicts: 0, unmappedLines: 2, details: { note: 'p1' } });
    const prev = await R.resumableRun(db, KIND, id1);
    if (prev.cursor !== 'C2' || prev.window.until !== w.until) bad.push('resumableRun');
    const id2 = await R.openRun(db, { channel: 'website', kind: KIND, actor: 'dbcheck-runner', filename: 'runner test', window: prev.window, resumedFrom: id1, cursor: prev.cursor });
    await R.failRun(db, id2, { fetched: 0, created: 0, updated: 0, unchanged: 0, itemsCreated: 0, itemsUpdated: 0, errorRows: 1, reportedErrors: [{ reason: 'boom' }], details: { failure: 'boom' } });
    const r2 = (await db.query('SELECT status, error_rows, details FROM order_imports WHERE id = $1', [id2])).rows[0];
    if (r2.status !== 'failed' || r2.error_rows !== 1 || r2.details.cursor !== 'C2' || r2.details.resumed_from !== id1 || r2.details.failure !== 'boom') bad.push(`failed run ${JSON.stringify(r2)}`);
    await expectErr('wrong kind', () => R.resumableRun(db, 'shopify_sync', id2), (e) => /cannot be continued/.test(e.message));
    // Runner: chain of resumed runs, resumable tail, status totals, one at a time, background busy.
    let bg = false;
    const runner = R.createSyncRunner({ kind: KIND, label: 'Runner test', isBusy: () => bg, runningIgnoredActors: ['dbcheck-ignored'], chainIgnoredActors: ['dbcheck-ignored'], busyMessage: 'busy test' });
    const chain = await runner.chain(db, ['incremental']);
    if (chain.map((r) => Number(r.id)).join() !== `${id1},${id2}` || runner.resumableTail(chain) !== id2) bad.push('chain/resumable');
    const s1 = await runner.status(['incremental']);
    if (s1.state !== 'failed' || s1.runs !== 2 || s1.created !== 4 || s1.unmappedLines !== 2 || s1.failure !== 'boom') bad.push(`status ${JSON.stringify(s1)}`);
    bg = true;
    await expectErr('background busy', () => runner.assertNoRunning(db), (e) => e.status === 409 && e.syncRunning && e.message === 'busy test');
    bg = false;
    const idR = await R.openRun(db, { channel: 'website', kind: KIND, actor: 'someone', filename: 'running elsewhere', window: w });
    await expectErr('running row elsewhere', () => runner.assertNoRunning(db), (e) => e.status === 409);
    await db.query(`UPDATE order_imports SET started_at = now() - interval '31 minutes' WHERE id = $1`, [idR]);
    await runner.assertNoRunning(db);                         // a stale 'running' row no longer blocks
    await db.query(`UPDATE order_imports SET imported_by = 'dbcheck-ignored', started_at = now() WHERE id = $1`, [idR]);
    await runner.assertNoRunning(db);                         // an ignored actor's running row never blocks
    await db.query(`UPDATE order_imports SET status = 'completed' WHERE id = $1`, [idR]);
    // launch: partial runs chain on until one is not partial; busy while it runs; failure logged and cleared.
    const seen = [];
    let n = 0;
    const done = runner.launch({ failLabel: 'test', runOnce: async ({ resumeRunId }) => { seen.push(resumeRunId); n += 1; await new Promise((r) => setTimeout(r, 10)); return { runId: 100 + n, summary: { partial: n < 3 } }; } });
    if (!runner.busy()) bad.push('not busy while launched');
    await expectErr('second start while running', () => runner.assertNoRunning(db), (e) => e.status === 409);
    await done;
    await new Promise((r) => setTimeout(r, 5));               // busy clears in the chain's finally, a tick later
    if (seen.join() !== ',101,102' || runner.busy()) bad.push(`chain loop ${seen} busy=${runner.busy()}`);
    const err = console.error; console.error = () => {};
    const failing = runner.launch({ failLabel: 'test', runOnce: async () => { throw new Error('nope'); } });
    await failing.then(() => bad.push('failure swallowed'), () => {});
    await new Promise((r) => setTimeout(r, 5));
    console.error = err;
    if (runner.busy()) bad.push('busy after a failed chain');
  } finally {
    await db.query(`DELETE FROM order_imports WHERE kind = $1`, [KIND]);
  }
  // Retry: classification, flags, connection failure text, policy and timings.
  if (H.classifyStatus(429) !== 'throttled' || H.classifyStatus(503) !== 'transient' || H.classifyStatus(504) !== 'transient' || H.classifyStatus(400) !== 'permanent' || H.classifyStatus(401) !== 'permanent') bad.push('classifyStatus');
  const cf = H.connectionFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }), 'Shopify');
  if (cf.message !== 'Shopify could not be reached: ECONNRESET' || cf.transient !== true || 'status' in cf) bad.push(`connectionFailure ${cf.message}`);
  const run = async (plan, opts = {}) => { const waits = []; let calls = 0; const retries = [];
    try { const v = await H.withRetry(async () => { const e = plan[calls++]; if (e) throw e; return 'ok'; }, { backoffMs: 10, wait: async (ms) => { waits.push(ms); }, onTransientRetry: (k, max) => retries.push(`${k}/${max}`), ...opts }); return { v, calls, waits, retries }; }
    catch (e) { return { err: e, calls, waits, retries }; } };
  const T = () => H.markThrottled(new Error('429'));
  const X = () => H.markTransient(new Error('503'));
  const P = () => new Error('400');
  let r = await run([T(), T(), T(), T()]);                    // throttled: attempts 0..3 retried, the 5th try succeeds
  if (r.v !== 'ok' || r.calls !== 5 || r.waits.join() !== '10,20,40,80') bad.push(`throttle ${JSON.stringify(r)}`);
  r = await run([T(), T(), T(), T(), T()]);                   // the 5th throttle is thrown
  if (!r.err?.throttled || r.calls !== 5) bad.push('throttle bound');
  r = await run([X(), X()]);                                  // transient: 3 tries in all, waits ×1, ×2
  if (r.v !== 'ok' || r.calls !== 3 || r.waits.join() !== '10,20' || r.retries.join() !== '1/2,2/2') bad.push(`transient ${JSON.stringify(r)}`);
  r = await run([X(), X(), X()]);
  if (!r.err?.transient || r.calls !== 3) bad.push('transient bound');
  r = await run([P()]);                                       // permanent: never retried
  if (!r.err || r.calls !== 1 || r.waits.length) bad.push('permanent retried');
  r = await run([X(), T()]);                                  // attempt counts every try: a throttle after a transient waits ×2
  if (r.v !== 'ok' || r.waits.join() !== '10,20') bad.push(`mixed ${JSON.stringify(r.waits)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'incremental window (overlap + fixed watermark); checkpoint only on full success (watermark / chain start / run start; never partial or single-order); open/progress/fail/complete lifecycle, a resumed run keeps its cursor, resume refused across kinds; chain walk, resumable tail, status totals; 409 when busy here, in the background or by a fresh running row elsewhere (stale and ignored actors don\'t block); partial runs chain until done, busy cleared after success and failure; retry: 429 ×4 then thrown, 5xx/connection 3 tries, 4xx never, backoff ×2 per attempt, same as Shopify';
});
await step('shopify orders: transient Shopify failures (503, connection reset) are retried, bounded; permanent errors are not; 429 unchanged; idempotent', async () => {
  const bad = [];
  const store = Array.from({ length: 12 }, (_, i) => ({ ...shOrder(701 + i, { created: shDays(0.1) }), updatedAt: new Date(Date.now() - (12 - i) * 1000).toISOString() }));
  const fake = shFake(() => store);
  // plan(kind, isNextPage, nth) → 'ok' | '503' | 'reset' | '400' | 'gqlerr' | '429'
  let plan = () => 'ok'; const hits = {};
  const stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    const { query, variables } = JSON.parse(b);
    const kind = (query.match(/^query (\w+)/) || [])[1];
    const key = `${kind}${variables?.after ? ':next' : ''}`;
    hits[key] = (hits[key] || 0) + 1;
    const act = plan(kind, Boolean(variables?.after), hits[key]);
    if (act === 'reset') { req.socket.destroy(); return; }
    res.setHeader('content-type', act === '503' ? 'text/plain' : 'application/json');
    if (act === '503') { res.statusCode = 503; return res.end('upstream connect error or disconnect/reset before headers. reset reason: remote connection failure'); }
    if (act === '400') { res.statusCode = 400; return res.end(JSON.stringify({ errors: 'Bad request' })); }
    if (act === '429') { res.statusCode = 429; return res.end(JSON.stringify({ errors: 'Throttled' })); }
    if (act === 'gqlerr') return res.end(JSON.stringify({ errors: [{ message: 'Field does not exist', extensions: { code: 'undefinedField' } }] }));
    return res.end(JSON.stringify({ data: await fake(query, variables || {}) }));
  }); });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  const keep = { ...process.env };
  const warn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a.join(' '));
  const reset = (p) => { plan = p; for (const k of Object.keys(hits)) delete hits[k]; };
  const run = (dryRun) => runShopifySync({ window: { days: 3 }, dryRun, actor: SH_ACTOR, backoffMs: 1 });
  const created = async () => (await getPool().query(`SELECT count(*)::int n FROM orders WHERE source_order_id = ANY($1)`, [store.map((o) => o.id)])).rows[0].n;
  const snaps = async () => (await getPool().query(`SELECT count(*)::int n FROM order_financial_snapshots s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = ANY($1)`, [store.map((o) => o.id)])).rows[0].n;
  try {
    Object.assign(process.env, { APP_ENV: 'test', SHOPIFY_GRAPHQL_BASE: `http://127.0.0.1:${stub.address().port}`, SHOPIFY_STORE_DOMAIN: 'briyo-test.myshopify.com', SHOPIFY_ACCESS_TOKEN: 'shpat_DBCHECK_RETRY_TOKEN_000000' });
    // 1. 503 once → retried → success.
    reset((k, next, n) => (k === 'BriyoOrdersPage' && !next && n === 1 ? '503' : 'ok'));
    const r1 = await run(true);
    if (r1.summary.found !== 12 || r1.summary.shopifyTransientRetries !== 1 || hits.BriyoOrdersPage !== 2) bad.push(`1 503→ok ${JSON.stringify([r1.summary.found, r1.summary.shopifyTransientRetries, hits])}`);
    // 2. connection reset once → retried → success.
    reset((k, next, n) => (k === 'BriyoOrderDetail' && n === 1 ? 'reset' : 'ok'));
    const r2 = await run(true);
    if (r2.summary.found !== 12 || r2.summary.shopifyTransientRetries !== 1 || r2.summary.errors !== 0) bad.push(`2 reset→ok ${JSON.stringify([r2.summary.found, r2.summary.shopifyTransientRetries])}`);
    // 3. 503 three times → fails after exactly 3 attempts.
    reset((k) => (k === 'BriyoOrdersPage' ? '503' : 'ok'));
    await expectErr('503 x3', () => run(true), (e) => /Shopify HTTP 503/.test(e.message));
    if (hits.BriyoOrdersPage !== 3) bad.push(`3 attempts ${hits.BriyoOrdersPage}`);
    // 4. permanent 4xx → no retry.
    reset((k) => (k === 'BriyoOrdersPage' ? '400' : 'ok'));
    await expectErr('400', () => run(true), (e) => /Shopify HTTP 400/.test(e.message));
    if (hits.BriyoOrdersPage !== 1) bad.push(`4 retried a 400 (${hits.BriyoOrdersPage})`);
    // 5. GraphQL errors in a successful response → no retry.
    reset((k) => (k === 'BriyoOrdersPage' ? 'gqlerr' : 'ok'));
    await expectErr('graphql error', () => run(true), (e) => /GraphQL error/.test(e.message));
    if (hits.BriyoOrdersPage !== 1) bad.push(`5 retried a GraphQL error (${hits.BriyoOrdersPage})`);
    // 6. 429 keeps its own policy (retried, not counted as transient).
    reset((k, next, n) => (k === 'BriyoOrdersPage' && !next && n <= 2 ? '429' : 'ok'));
    const r6 = await run(true);
    if (r6.summary.found !== 12 || hits.BriyoOrdersPage !== 3 || r6.summary.shopifyTransientRetries !== 0) bad.push(`6 429 ${JSON.stringify([r6.summary.found, hits.BriyoOrdersPage, r6.summary.shopifyTransientRetries])}`);
    // 7. a commit whose second page keeps failing: the first page is applied whole, the second not at all.
    reset((k, next) => (k === 'BriyoOrdersPage' && next ? '503' : 'ok'));
    await expectErr('page 2 down', () => run(false), (e) => /Shopify HTTP 503/.test(e.message));
    if ((await created()) !== 10 || (await snaps()) !== 10 || hits['BriyoOrdersPage:next'] !== 3) bad.push(`7 partial ${await created()}/${await snaps()}/${hits['BriyoOrdersPage:next']}`);
    // 8. pagination with one 503 on the second page → retried; the rest arrive; no duplicates.
    reset((k, next, n) => (k === 'BriyoOrdersPage' && next && n === 1 ? '503' : 'ok'));
    const r8 = await run(false);
    if (r8.summary.ordersCreated !== 2 || r8.summary.unchanged !== 10 || r8.summary.shopifyTransientRetries !== 1 || (await created()) !== 12 || (await snaps()) !== 12) bad.push(`8 resume ${JSON.stringify([r8.summary.ordersCreated, r8.summary.unchanged, r8.summary.shopifyTransientRetries, await created(), await snaps()])}`);
    // ...and once more, with a 503 on the first page: still idempotent.
    reset((k, next, n) => (k === 'BriyoOrdersPage' && !next && n === 1 ? '503' : 'ok'));
    const r9 = await run(false);
    if (r9.summary.ordersCreated !== 0 || r9.summary.unchanged !== 12 || (await created()) !== 12 || (await snaps()) !== 12) bad.push(`9 idempotent ${JSON.stringify([r9.summary.ordersCreated, r9.summary.unchanged])}`);
    // The retry count survives on each run record (order_imports.details).
    const kept = async (r) => (await getPool().query('SELECT details FROM order_imports WHERE id = $1', [r.runId])).rows[0]?.details?.shopify_transient_retries;
    if ((await kept(r8)) !== 1 || (await kept(r9)) !== 1) bad.push(`retries not persisted ${await kept(r8)}/${await kept(r9)}`);
    if (!warnings.some((w) => /transient failure, retry 1 of 2/.test(w)) || warnings.some((w) => w.includes('shpat_DBCHECK'))) bad.push('retry logging');
  } finally {
    console.warn = warn;
    for (const k of ['APP_ENV', 'SHOPIFY_GRAPHQL_BASE', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ACCESS_TOKEN']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
    stub.close();
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return '503 → retry → ok; reset → retry → ok; 503 ×3 → fails after 3 attempts; 400 and GraphQL errors not retried; 429 still on its own policy; a failing page leaves earlier pages applied whole and itself unapplied; a retried page completes the import with no duplicate orders or snapshots; a further run is idempotent; retries logged without the token';
});

await step('shopify orders: automatic poll — the existing incremental sync on a timer; no overlap, checkpoint only on success, duplicates held, SKUs unchanged, no stock side effects', async () => {
  const bad = [];
  const CK = 'shopify_orders_checkpoint';
  const ckNow = async () => (await getPool().query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value || null;
  const setCk = async (v) => (v === null ? getPool().query('DELETE FROM system_state WHERE key = $1', [CK])
    : getPool().query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [CK, v]));
  const savedCk = await ckNow();
  // A master, a website listing of it (×2), and five Shopify orders updated in the last minutes.
  const mPoll = (await createSku({ sku: `${TS}-POLL-M`, product_name: 'Poll test master' }, { actor: ACTOR })).id;
  await addPlatformMappings(mPoll, 'website', [`${TS}-POLL-WEB`], { actor: ACTOR, unitsPerListing: 2 });
  const recent = (s) => new Date(Date.now() - s * 1000).toISOString();
  const store = [
    { ...shOrder(951, { created: recent(300), lines: [{ sku: `${TS}-POLL-M`, qty: 1 }] }), updatedAt: recent(300) },
    { ...shOrder(952, { created: recent(250), lines: [{ sku: `${TS}-POLL-WEB`, qty: 1 }] }), updatedAt: recent(250) },
    { ...shOrder(953, { created: recent(200), lines: [{ sku: `${TS}-POLL-UNKNOWN`, qty: 1 }] }), updatedAt: recent(200) },
    { ...shOrder(954, { created: recent(150), lines: [{ sku: null, title: 'Sample sachet', qty: 1 }] }), updatedAt: recent(150) },
    { ...shOrder(955, { created: recent(100), name: `${TEST_ORDER}-POLLDUP` }), updatedAt: recent(100) },
  ];
  // A website order typed in by hand under 955's Shopify number: the poll must hold 955 back.
  const manualDup = await createOrder({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-POLLDUP` }, { actor: ACTOR });
  const gql = shFake(() => store);
  const ids = store.map((o) => o.id);
  const ours = async () => (await getPool().query(`SELECT count(*)::int n FROM orders WHERE source_order_id = ANY($1)`, [ids])).rows[0].n;
  const sideFx = async () => (await getPool().query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = ANY($1))::int sh, (SELECT count(*) FROM abandoned_carts)::int carts,
    (SELECT value FROM system_state WHERE key = 'last_shopify_poll') cartpoll`, [ids])).rows[0];
  const fx0 = await sideFx();
  try {
    // No checkpoint (no initial import): skipped, nothing recorded.
    await setCk(null);
    const runs0 = (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n;
    const s0 = await pollShopifyOrdersOnce({ gql });
    if (s0.skipped !== 'no checkpoint' || (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n !== runs0) bad.push('ran without a checkpoint');
    // 1. Runs the existing sync from the checkpoint; recorded in the normal history as shopify-poll.
    const ck1 = new Date(Date.now() - 3600000).toISOString();
    await setCk(ck1);
    // 2. Overlap: a second poll while one is running is skipped.
    const [r1, r2] = await Promise.all([pollShopifyOrdersOnce({ gql }), pollShopifyOrdersOnce({ gql })]);
    const ran = [r1, r2].find((r) => r.runId); const skipped = [r1, r2].find((r) => r.skipped);
    if (!ran || skipped?.skipped !== 'already running') bad.push(`overlap ${JSON.stringify([r1.skipped || r1.runId, r2.skipped || r2.runId])}`);
    const run = (await getPool().query('SELECT imported_by, status, orders_created, unmapped_lines, details FROM order_imports WHERE id = $1', [ran.runId])).rows[0];
    if (run.imported_by !== 'shopify-poll' || run.status !== 'completed' || run.orders_created !== 4) bad.push(`run ${JSON.stringify({ by: run.imported_by, st: run.status, n: run.orders_created })}`);
    if (ran.summary.mode !== 'incremental' || ran.summary.possibleDuplicates !== 1 || (run.details.duplicates || [])[0]?.existingId !== Number(manualDup)) bad.push(`dup ${JSON.stringify(ran.summary)}`);
    // 3. Success advances the checkpoint (to the run's start).
    const ck2 = await ckNow();
    if (!(new Date(ck2) > new Date(ck1))) bad.push(`checkpoint ${ck1} → ${ck2}`);
    // 6. The manual website order is untouched and the Shopify copy not created.
    if ((await ours()) !== 4 || (await getOrder(manualDup)).source !== 'manual') bad.push('manual duplicate not held back');
    // 8–10. SKUs resolve exactly as a manual sync: master code; website mapping (×2); unknown and code-less stay unmapped.
    const line = async (n) => (await getPool().query(`SELECT oi.sku, oi.sku_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.source_order_id = $1`, [store.find((x) => x.id.endsWith(String(n).padStart(4, '0'))).id])).rows[0];
    const [l1, l2, l3, l4] = [await line(951), await line(952), await line(953), await line(954)];
    if (Number(l1.sku_id) !== mPoll || Number(l2.sku_id) !== mPoll || l3.sku_id !== null || l3.sku !== `${TS}-POLL-UNKNOWN` || l4.sku_id !== null || l4.sku) bad.push(`skus ${JSON.stringify([l1, l2, l3, l4])}`);
    if ((await getSku(mPoll)).platform_skus.length !== 1) bad.push('a mapping was created');
    // 7. Polling again changes nothing.
    const r3 = await pollShopifyOrdersOnce({ gql });
    if (r3.summary.ordersCreated !== 0 || r3.summary.changedLineItems !== 0 || (await ours()) !== 4) bad.push(`repeat ${JSON.stringify(r3.summary)}`);
    // 4. A failed run records the failure and leaves the checkpoint where it was; the next poll still runs.
    const ckBefore = await ckNow();
    const broken = async (q, v) => { if (/^query BriyoOrdersPage/.test(q)) throw Object.assign(new Error('Shopify HTTP 400: Bad request'), { status: 400 }); return gql(q, v); };
    let failed = false;
    try { await pollShopifyOrdersOnce({ gql: broken, backoffMs: 1 }); } catch { failed = true; }
    const lastRun = (await getPool().query(`SELECT imported_by, status FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT 1`)).rows[0];
    if (!failed || lastRun.status !== 'failed' || lastRun.imported_by !== 'shopify-poll' || (await ckNow()) !== ckBefore) bad.push(`failure ${JSON.stringify(lastRun)} ck ${await ckNow()}`);
    if ((await pollShopifyOrdersOnce({ gql })).skipped) bad.push('guard not released after a failure');
    // 11–12. No shipments, reservations or movements; the cart poll and carts untouched.
    const fx1 = await sideFx();
    if (JSON.stringify(fx1) !== JSON.stringify(fx0)) bad.push(`side effects ${JSON.stringify([fx0, fx1])}`);
    // Status reports the schedule.
    const keep = process.env.SHOPIFY_ORDERS_POLL_ENABLED;
    process.env.SHOPIFY_ORDERS_POLL_ENABLED = 'true';
    const st = await shopifyOrdersStatus();
    if (!st.pollEnabled || st.pollMinutes !== ordersPollMinutes() || ordersPollMinutes() < 5) bad.push(`status ${st.pollEnabled}/${st.pollMinutes}`);
    if (keep === undefined) delete process.env.SHOPIFY_ORDERS_POLL_ENABLED; else process.env.SHOPIFY_ORDERS_POLL_ENABLED = keep;
  } finally {
    await setCk(savedCk);
    // The poll records its runs as 'shopify-poll' (the production name); this test's runs are removed here.
    await getPool().query(`DELETE FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = 'shopify-poll' AND started_at > now() - interval '1 hour'`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'no checkpoint → skipped; poll = incremental sync recorded as shopify-poll; concurrent poll skipped; 4 created, manual #POLLDUP held back; checkpoint advanced; master, ×2 website mapping, unknown and code-less lines resolved as usual (nothing auto-mapped); repeat poll idempotent; failed poll recorded, checkpoint kept, guard released; 0 shipments/reservations/movements, carts and cart poll untouched; status shows the interval';
});
await step('shopify orders: Buy with Amazon fulfilments mirrored as external shipments — tag + Amazon carrier only, one per fulfilment GID, forward-only status, never stock', async () => {
  const bad = [];
  const ATS = 'Amazon Transportation Services';
  const FGID = (n, k = 1) => `gid://shopify/Fulfillment/${SH_NUM}${n}${k}`;
  const ful = (n, k, o = {}) => ({ id: FGID(n, k), name: `#${n}-F${k}`, status: o.status || 'SUCCESS', displayStatus: o.display ?? 'IN_TRANSIT',
    createdAt: o.at || new Date(Date.now() - 3600000).toISOString(), updatedAt: new Date().toISOString(), inTransitAt: o.inTransit || new Date(Date.now() - 1800000).toISOString(),
    deliveredAt: o.deliveredAt || null, estimatedDeliveryAt: null,
    trackingInfo: o.noTracking ? [] : [{ company: o.carrier || ATS, number: 'number' in o ? o.number : `37414676${n}${k}`, url: 'url' in o ? o.url : `https://www.swiship.co.uk/track?id=37414676${n}${k}` }] });
  const recent = () => new Date(Date.now() - 7200000).toISOString();
  const order = (n, tags, fulfillments, extra = {}) => ({ ...shOrder(n, { created: recent(), ...extra }), tags, fulfillments, updatedAt: new Date().toISOString() });
  const BWA = ['Buy with Amazon', 'COD', 'GoKwik'];
  const store = [
    order(981, BWA, [ful(981, 1)]),                                                                // one fulfilment
    order(982, ['Non Buy with Amazon', 'GoKwik'], [ful(982, 1)]),                                  // not BWA, even with the Amazon carrier
    order(983, BWA, [ful(983, 1), ful(983, 2, { display: 'DELIVERED', deliveredAt: new Date().toISOString() })]), // two fulfilments
    order(985, BWA, [ful(985, 1, { number: null, url: null })]),                                   // no tracking number
    order(986, BWA, [ful(986, 1)], { lines: [{ sku: `${TS}-BWA-UNMAPPED`, qty: 1 }] }),            // unmapped SKU
    order(987, BWA, [ful(987, 1, { carrier: 'Delhivery' })]),                                      // BWA tag, other carrier
    order(988, BWA, [ful(988, 1)]),                                                                // cancelled later
    order(989, BWA, []),                                                                           // manual shipment first
  ];
  const gql = shFake(() => store);
  const sync = (actor = SH_ACTOR) => runShopifySync({ window: { days: 1 }, dryRun: false, gql, actor });
  const gid = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const ships = async (n) => (await getPool().query(`SELECT s.* FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = $1 ORDER BY s.id`, [gid(n)])).rows;
  const fx = async () => (await getPool().query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM courier_partners)::int couriers, (SELECT coalesce(sum(on_hand), 0) FROM inventory_batches)::int on_hand`)).rows[0];
  const keep = { tag: process.env.BWA_ORDER_TAG, carriers: process.env.BWA_CARRIERS };
  delete process.env.BWA_ORDER_TAG; delete process.env.BWA_CARRIERS;
  try {
    if ((await listCouriers()).some((c) => c.name.toLowerCase() === ATS.toLowerCase())) bad.push('test assumes no ATS courier row');
    const fx0 = await fx();
    // Preview counts what a sync would mirror, and writes nothing.
    const pre = await runShopifySync({ window: { days: 1 }, dryRun: true, gql });
    if (pre.summary.newExternalShipments !== 6) bad.push(`preview ${pre.summary.newExternalShipments}`);
    // 989: a person ships it from Briyo first; then Amazon's fulfilment appears.
    const r1 = await sync();
    const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
    const manual = await createShipment({ ...R('website'), channel: 'website', source_order_id: gid(989), courier_partner_id: dl.id, tracking_id: 'BRIYO-AWB-989', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true });
    const manualBefore = (await getPool().query('SELECT version FROM order_shipments WHERE id = $1', [manual.shipmentId])).rows[0];
    store.find((o) => o.id === gid(989)).fulfillments = [ful(989, 1)];
    store.find((o) => o.id === gid(989)).updatedAt = new Date(Date.now() + 500).toISOString();
    // 1, 4. One BWA fulfilment → exactly one shipment, in_transit, Shopify's tracking and URL, provider bwa, no courier row made.
    const s981 = await ships(981);
    if (r1.summary.externalShipmentsCreated !== 6 || s981.length !== 1) bad.push(`created ${r1.summary.externalShipmentsCreated}, 981 has ${s981.length}`);
    const a = s981[0];
    if (a?.shipment_status !== 'in_transit' || a.tracking_id !== '374146769811' || a.tracking_url !== 'https://www.swiship.co.uk/track?id=374146769811'
      || a.external_source !== 'shopify' || a.external_provider !== 'bwa' || a.external_fulfillment_id !== FGID(981, 1) || a.external_carrier !== ATS
      || a.courier_partner_id !== null || a.external_display_status !== 'IN_TRANSIT' || !a.dispatch_date) bad.push(`981 ${JSON.stringify(a)}`);
    // 8. Not BWA (tag), and BWA with another carrier: no shipment.
    if ((await ships(982)).length || (await ships(987)).length) bad.push('non-eligible fulfilment mirrored');
    // 13. Two fulfilments → two shipments, each its own status.
    const s983 = await ships(983);
    if (s983.length !== 2 || s983.map((x) => x.shipment_status).sort().join() !== 'delivered,in_transit' || new Set(s983.map((x) => x.external_fulfillment_id)).size !== 2
      || !s983.find((x) => x.shipment_status === 'delivered').delivered_at) bad.push(`983 ${JSON.stringify(s983.map((x) => [x.external_fulfillment_id, x.shipment_status]))}`);
    // 15. No tracking number: none invented.
    const s985 = await ships(985);
    if (s985.length !== 1 || s985[0].tracking_id !== null || s985[0].tracking_url !== null) bad.push(`985 ${JSON.stringify(s985)}`);
    // An unmapped SKU does not stop the mirror.
    if ((await ships(986)).length !== 1) bad.push('unmapped SKU blocked the mirror');
    // 2. Sync again: nothing new, nothing changed.
    const r2 = await sync();
    const total = async () => (await getPool().query(`SELECT count(*)::int n FROM order_shipments WHERE external_fulfillment_id LIKE $1`, [`gid://shopify/Fulfillment/${SH_NUM}%`])).rows[0].n;
    if (r2.summary.externalShipmentsCreated !== 1 || r2.summary.externalShipmentsUpdated !== 0 || await total() !== 7) bad.push(`resync ${JSON.stringify([r2.summary.externalShipmentsCreated, r2.summary.externalShipmentsUpdated, await total()])}`);
    // 9. Manual shipment + BWA fulfilment → both exist; the manual one untouched (same row, AWB, status, version).
    const s989 = await ships(989);
    const man = s989.find((x) => x.id === String(manual.shipmentId)); const ext989 = s989.find((x) => x.external_fulfillment_id === FGID(989, 1));
    if (s989.length !== 2 || !man || man.tracking_id !== 'BRIYO-AWB-989' || man.shipment_status !== 'packed' || man.external_fulfillment_id !== null || man.version !== manualBefore.version
      || ext989?.shipment_status !== 'in_transit' || ext989.tracking_id !== '374146769891') bad.push(`manual + BWA ${JSON.stringify(s989.map((x) => [x.tracking_id, x.shipment_status, x.external_fulfillment_id]))}`);
    // Two BWA fulfilments + an existing manual shipment → three records; repeated syncs keep three.
    const o989 = store.find((o) => o.id === gid(989));
    o989.fulfillments.push(ful(989, 2)); o989.updatedAt = new Date(Date.now() + 1000).toISOString();
    await sync(); await sync(); await Promise.all([sync(), sync('shopify-poll')]);
    const s989b = await ships(989);
    if (s989b.length !== 3 || s989b.filter((x) => x.external_fulfillment_id).length !== 2 || (s989b.find((x) => x.id === String(manual.shipmentId))?.version) !== manualBefore.version)
      bad.push(`two BWA + manual ${JSON.stringify(s989b.map((x) => [x.tracking_id, x.external_fulfillment_id]))}`);
    // 3, 7, 5, 6. Same fulfilment, updated: tracking follows; DELAYED keeps the status; OUT_FOR_DELIVERY, DELIVERED move forward; an older state never moves it back.
    const f981 = store.find((o) => o.id === gid(981)).fulfillments[0];
    const step = async (patch) => { Object.assign(f981, patch, { updatedAt: new Date(Date.now() + 1000).toISOString() }); store.find((o) => o.id === gid(981)).updatedAt = new Date().toISOString(); await sync(); return (await ships(981))[0]; };
    let x = await step({ trackingInfo: [{ company: ATS, number: '374146769999', url: 'https://www.swiship.co.uk/track?id=374146769999' }] });
    if (x.tracking_id !== '374146769999' || x.tracking_url !== 'https://www.swiship.co.uk/track?id=374146769999' || (await ships(981)).length !== 1) bad.push(`tracking update ${x.tracking_id}`);
    x = await step({ displayStatus: 'DELAYED' });
    if (x.shipment_status !== 'in_transit' || x.external_display_status !== 'DELAYED') bad.push(`DELAYED → ${x.shipment_status}`);
    x = await step({ displayStatus: 'OUT_FOR_DELIVERY' });
    if (x.shipment_status !== 'out_for_delivery') bad.push(`OUT_FOR_DELIVERY → ${x.shipment_status}`);
    x = await step({ displayStatus: 'DELIVERED', deliveredAt: new Date().toISOString() });
    if (x.shipment_status !== 'delivered' || !x.delivered_at) bad.push(`DELIVERED → ${x.shipment_status}`);
    x = await step({ displayStatus: 'IN_TRANSIT' });
    if (x.shipment_status !== 'delivered') bad.push(`moved back to ${x.shipment_status}`);
    if ((await orderEvents(Number((await getPool().query('SELECT id FROM orders WHERE source_order_id = $1', [gid(981)])).rows[0].id))).filter((e) => e.event_type === 'external_shipment_mirrored').length !== 1) bad.push('mirror event count');
    // 17. Cancelled in Shopify: the shipment is cancelled, its history kept; a replacement fulfilment is a new shipment; a later SUCCESS restores it.
    const o988 = store.find((o) => o.id === gid(988));
    o988.fulfillments[0] = { ...o988.fulfillments[0], status: 'CANCELLED', updatedAt: new Date(Date.now() + 2000).toISOString() };
    o988.updatedAt = new Date().toISOString();
    const rc = await sync();
    let s988 = await ships(988);
    if (rc.summary.externalShipmentsCancelled !== 1 || s988.length !== 1 || s988[0].shipment_status !== 'cancelled' || s988[0].tracking_id !== '374146769881') bad.push(`cancel ${JSON.stringify(s988.map((y) => y.shipment_status))}`);
    o988.fulfillments.push(ful(988, 2));
    o988.updatedAt = new Date(Date.now() + 1000).toISOString();
    await sync();
    s988 = await ships(988);
    if (s988.length !== 2 || s988.map((y) => `${y.external_fulfillment_id === FGID(988, 1) ? 'F1' : 'F2'}:${y.shipment_status}`).sort().join() !== 'F1:cancelled,F2:in_transit') bad.push(`replacement ${JSON.stringify(s988.map((y) => [y.external_fulfillment_id, y.shipment_status]))}`);
    // 14. Two syncs at once (poll + Sync now share this path, as the webhook does): no duplicates.
    store.push(order(984, BWA, [ful(984, 1)]));
    await Promise.all([sync(), sync('shopify-poll')]);
    if ((await ships(984)).length !== 1) bad.push(`concurrent ${(await ships(984)).length}`);
    // 10–12, 16. No reservation possible, no movement, no stock change, no courier row created.
    await expectErr('reserve external', () => reserveShipmentStock(Number(a.id), [{ batch_id: 1, quantity: 1 }], { actor: ACTOR }), (e) => e.status === 409 && e.externalShipment);
    const c = await getPool().connect();
    try { const d = await dispatchShipmentStock(c, Number(a.id), { actor: ACTOR }); if (d.deducted !== 0 || !d.external) bad.push(`dispatch ${JSON.stringify(d)}`); } finally { c.release(); }
    const o982 = Number((await getPool().query('SELECT id FROM orders WHERE source_order_id = $1', [gid(982)])).rows[0].id);
    await expectErr('attach to external', () => attachToShipment(Number(a.id), { orderIds: [o982] }, { actor: ACTOR }), (e) => e.status === 409);
    const fx1 = await fx();
    if (JSON.stringify(fx1) !== JSON.stringify(fx0)) bad.push(`stock or couriers changed ${JSON.stringify([fx0, fx1])}`);
    // The tag and carriers are configurable; a different tag mirrors nothing new.
    process.env.BWA_ORDER_TAG = 'Some Other Tag';
    store.push(order(990, BWA, [ful(990, 1)]));
    await sync();
    if ((await ships(990)).length) bad.push('mirrored without the configured tag');
  } finally {
    for (const [k, v] of [['BWA_ORDER_TAG', keep.tag], ['BWA_CARRIERS', keep.carriers]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await getPool().query(`DELETE FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = 'shopify-poll' AND started_at > now() - interval '1 hour'`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'BWA tag + Amazon carrier → 1 shipment per fulfilment GID (in_transit, Shopify tracking + URL, provider bwa, no courier row made); non-BWA tag and other carrier → none; 2 fulfilments → 2 shipments; no tracking → none invented; unmapped SKU no obstacle; re-sync and concurrent syncs → no duplicates; manual shipment + BWA fulfilment → both (manual untouched), + a second BWA fulfilment → 3 records, repeated/concurrent syncs keep 3; tracking update applied; DELAYED keeps in_transit; OUT_FOR_DELIVERY, DELIVERED forward, never back; cancelled in Shopify → cancelled (kept), replacement → new shipment; reserve refused, dispatch deducts nothing, no other order can join; no movements, reservations, stock or courier changes; tag configurable';
});
await step('shopify orders: one-click full history — needs read_all_orders as Shopify reports it, pages and resumes, one at a time, BWA mirrored once, #2823 unattributed, no stock', async () => {
  const bad = [];
  const CK = 'shopify_orders_checkpoint';
  const savedCk = (await getPool().query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const keepEnv = process.env.SHOPIFY_READ_ALL_ORDERS; delete process.env.SHOPIFY_READ_ALL_ORDERS;
  const gidOf = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const ATS = 'Amazon Transportation Services';
  // 130 orders back to 2023 (3 pages of 50 at most; runs of 50 so the chain resumes), one BWA, one #2823 pattern.
  const store = [];
  for (let i = 0; i < 130; i += 1) {
    const n = 2001 + i;
    const at = new Date(Date.UTC(2023, 1, 2) + i * 6 * 86400000).toISOString();
    store.push({ ...shOrder(n, { created: at, lines: [{ sku: `${TS}-FULL-UNMAPPED`, qty: 1 }] }), updatedAt: at });
  }
  const bwa = store[5];
  bwa.tags = ['Buy with Amazon', 'COD'];
  bwa.fulfillments = [{ id: `gid://shopify/Fulfillment/${SH_NUM}9001`, name: '#B-F1', status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: bwa.createdAt, updatedAt: bwa.updatedAt,
    inTransitAt: bwa.createdAt, deliveredAt: bwa.updatedAt, estimatedDeliveryAt: null, trackingInfo: [{ company: ATS, number: '374100000001', url: 'https://www.swiship.co.uk/track?id=374100000001' }] }];
  const amb = store[7];   // #2823: stale /r/X path beside another affiliate's UTMs, no click id
  amb.customAttributes = [{ key: 'full_url', value: 'https://briyo-supp.myshopify.com/r/B7K4P9?utm_source=affiliate&utm_campaign=C8M5Q2&utm_medium=referral' },
    { key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: 'C8M5Q2' }];
  const granted = shFake(() => store, { scopes: ['read_orders', 'read_all_orders'] });
  const notGranted = shFake(() => store, { scopes: ['read_orders', 'write_online_store_navigation'] });
  const ours = async () => (await getPool().query(`SELECT count(*)::int n FROM orders WHERE source_order_id = ANY($1)`, [store.map((o) => o.id)])).rows[0].n;
  const fx = async () => (await getPool().query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs`)).rows[0];
  try {
    const fx0 = await fx();
    // 7. Shopify's live scopes, not the stored string; cached; the env override still forces it.
    _resetScopeCache();
    if (!(await grantedAccessScopes({ gql: granted })).includes('read_all_orders') || !(await hasReadAllOrders({ gql: granted }))) bad.push('granted scope not detected');
    _resetScopeCache();
    if (await hasReadAllOrders({ gql: notGranted })) bad.push('absent scope reported as granted');
    process.env.SHOPIFY_READ_ALL_ORDERS = 'true';
    if (!(await hasReadAllOrders({ gql: notGranted }))) bad.push('override ignored');
    delete process.env.SHOPIFY_READ_ALL_ORDERS;
    // 5–6. Without read_all_orders: full history refused (409, nothing recorded); windows over 60 days refused as before.
    _resetScopeCache();
    const runs0 = (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n;
    await expectErr('full history without scope', () => startFullHistorySync({ actor: SH_ACTOR, gql: notGranted }), (e) => e.status === 409 && e.readAllOrders === false && /read_all_orders/.test(e.message));
    await expectErr('direct all without scope', () => runShopifySync({ window: { mode: 'all' }, dryRun: true, gql: notGranted }), (e) => e.status === 409);
    await expectErr('90 days without scope', () => runShopifySync({ window: { days: 90 }, dryRun: true, gql: notGranted }), (e) => e.status === 400 && /60 days/.test(e.message));
    if ((await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n !== runs0) bad.push('a refused sync recorded a run');
    // 4. With it, a long window is allowed (preview, nothing written).
    _resetScopeCache();
    const p90 = await runShopifySync({ window: { days: 900 }, dryRun: true, gql: granted });
    if (p90.runId !== null || p90.summary.window.mode !== 'window') bad.push('long window refused with the scope');
    // 9. A chain that fails part-way, then 8. a click that resumes it and pages to the end (runs of 50 → 3 runs).
    let calls = 0;
    const flaky = async (q, v) => { if (/^query BriyoOrdersPage/.test(q) && v.after && (calls += 1) === 5) throw Object.assign(new Error('Shopify HTTP 400: Bad request'), { status: 400 }); return granted(q, v); };
    const first = await startFullHistorySync({ actor: SH_ACTOR, gql: flaky, maxOrders: 50, backoffMs: 1 });
    await first.done.then(() => bad.push('the flaky chain did not fail'), () => {});
    const st1 = await fullHistoryStatus();
    if (st1.state !== 'failed' || (await ours()) !== 50) bad.push(`after failure ${st1.state} ${await ours()}`);
    if ((await getPool().query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value !== savedCk) bad.push('a failed chain moved the checkpoint');
    // 11. One at a time: a second click, Sync now and the poll are refused or skipped while it runs.
    const second = await startFullHistorySync({ actor: SH_ACTOR, gql: granted, maxOrders: 50, backoffMs: 1 });
    if (!second.resumedFrom) bad.push('did not resume the failed chain');
    await expectErr('second click', () => startFullHistorySync({ actor: SH_ACTOR, gql: granted }), (e) => e.status === 409 && e.syncRunning);
    await expectErr('Sync now meanwhile', () => assertNoSyncRunning(), (e) => e.status === 409 && e.syncRunning);
    if (!(await pollShopifyOrdersOnce({ gql: granted })).skipped) bad.push('poll ran during a full sync');
    await second.done;
    const st2 = await fullHistoryStatus();
    if (st2.state !== 'completed' || (await ours()) !== 130 || st2.runs < 3) bad.push(`complete ${JSON.stringify({ state: st2.state, runs: st2.runs, n: await ours() })}`);
    if (st2.fetched < 130 || st2.created !== 130 || st2.externalCreated !== 1 || !st2.durationMs && st2.durationMs !== 0) bad.push(`totals ${JSON.stringify(st2)}`);
    const chainStart = (await getPool().query(`SELECT details->'window'->>'chain_started_at' t FROM order_imports WHERE kind = 'shopify_sync' AND details->'window'->>'mode' = 'all' ORDER BY id LIMIT 1`)).rows[0].t;
    if ((await getPool().query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value !== chainStart) bad.push('checkpoint not at the chain start');
    // 10. Running summary: unmapped lines counted across all pages without holding the orders.
    if (st2.unmappedLines !== 130) bad.push(`unmapped across pages ${st2.unmappedLines}`);
    // 12–14, 16. BWA mirrored once; a second full history duplicates nothing; manual shipment untouched; no stock.
    const dl = (await listCouriers()).find((c) => c.name === 'Delhivery');
    const man = await createShipment({ ...R('website'), channel: 'website', source_order_id: bwa.id, courier_partner_id: dl.id, tracking_id: 'MAN-FULL-1', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true });
    const manV = (await getPool().query('SELECT version FROM order_shipments WHERE id = $1', [man.shipmentId])).rows[0].version;
    const again = await startFullHistorySync({ actor: SH_ACTOR, gql: granted, maxOrders: 50, backoffMs: 1 });
    await again.done;
    const sh = (await getPool().query(`SELECT s.id, s.external_fulfillment_id, s.shipment_status, s.version FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = $1 ORDER BY s.id`, [bwa.id])).rows;
    if (sh.length !== 2 || sh.filter((x) => x.external_fulfillment_id).length !== 1 || sh.find((x) => x.external_fulfillment_id)?.shipment_status !== 'delivered'
      || sh.find((x) => x.id === String(man.shipmentId))?.version !== manV) bad.push(`BWA ${JSON.stringify(sh)}`);
    if ((await ours()) !== 130) bad.push('re-run duplicated orders');
    const fx1 = await fx();
    if (fx1.mv !== fx0.mv || fx1.rs !== fx0.rs) bad.push(`stock touched ${JSON.stringify([fx0, fx1])}`);
    // 15. #2823 pattern in history: imported, unattributed, no commission, conflict kept.
    const a = (await getPool().query(`SELECT o.source_payload->'shopify'->'referral' r, (SELECT count(*) FROM affiliate_order_attributions t WHERE t.order_id = o.id)::int n FROM orders o WHERE o.source_order_id = $1`, [amb.id])).rows[0];
    if (a?.n !== 0 || a.r?.conflict !== true || a.r.commission !== false) bad.push(`#2823 pattern ${JSON.stringify(a)}`);
  } finally {
    if (keepEnv === undefined) delete process.env.SHOPIFY_READ_ALL_ORDERS; else process.env.SHOPIFY_READ_ALL_ORDERS = keepEnv;
    _resetScopeCache();
    if (savedCk === null) await getPool().query('DELETE FROM system_state WHERE key = $1', [CK]);
    else await getPool().query(`UPDATE system_state SET value = $2 WHERE key = $1`, [CK, savedCk]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'live scopes read from Shopify (cached; override honoured); without read_all_orders full history and >60-day windows refused, nothing recorded; with it a long window is allowed; a chain failing part-way leaves the checkpoint, the next click resumes and pages to 130 orders over ≥3 runs; second click / Sync now 409 and the poll skipped while it runs; checkpoint set to the chain start; unmapped lines summed across pages; BWA fulfilment mirrored once (delivered), manual shipment untouched on a re-run, no orders duplicated; no movements or reservations; #2823 pattern unattributed, no commission';
});
await step('shopify orders: the Shopify button syncs incrementally — checkpoint to a fixed watermark, only after success, idempotent, BWA updates mirrored, one at a time', async () => {
  const bad = [];
  const CK = 'shopify_orders_checkpoint';
  const ckNow = async () => (await getPool().query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const setCk = (v) => getPool().query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [CK, v]);
  const savedCk = await ckNow();
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const ATS = 'Amazon Transportation Services';
  const store = [
    { ...shOrder(3001, { created: iso(86400000) }), updatedAt: iso(86400000) },        // changed before the checkpoint: not fetched
    { ...shOrder(3002, { created: iso(1800000) }), updatedAt: iso(1800000) },           // new since the checkpoint
  ];
  const bwaF = { id: `gid://shopify/Fulfillment/${SH_NUM}9301`, name: '#3003-F1', status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: iso(1200000), updatedAt: iso(1200000),
    inTransitAt: iso(1200000), deliveredAt: null, estimatedDeliveryAt: null, trackingInfo: [{ company: ATS, number: '374199999901', url: 'https://www.swiship.co.uk/track?id=374199999901' }] };
  store.push({ ...shOrder(3003, { created: iso(1500000) }), tags: ['Buy with Amazon'], fulfillments: [bwaF], updatedAt: iso(1200000) });
  let late = null;   // an order Shopify changes while the run is paging through
  const gql = shFake(() => store);
  const watching = async (q, v) => {
    if (/^query BriyoOrdersPage/.test(q) && !late) {
      late = { ...shOrder(3004, { created: new Date(Date.now() + 100).toISOString() }), updatedAt: new Date(Date.now() + 100).toISOString() };
      store.push(late);
    }
    return gql(q, v);
  };
  const gidOf = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const has = async (n) => (await getPool().query('SELECT 1 FROM orders WHERE source_order_id = $1', [gidOf(n)])).rows.length === 1;
  const fx = async () => (await getPool().query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs`)).rows[0];
  const lastRun = async () => (await getPool().query(`SELECT id, status, details FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT 1`)).rows[0];
  try {
    const fx0 = await fx();
    // a, f. From the last successful checkpoint: the order changed since is imported, the older one is not.
    await setCk(iso(3600000));
    const r1 = await startIncrementalSync({ actor: SH_ACTOR, gql: watching, backoffMs: 1 });
    await r1.done;
    const run1 = await lastRun();
    if (r1.mode !== 'incremental' || run1.details.window.mode !== 'incremental' || !run1.details.window.until) bad.push(`run ${JSON.stringify(run1.details.window)}`);
    if (!(await has(3002)) || !(await has(3003)) || await has(3001)) bad.push(`window ${[await has(3001), await has(3002), await has(3003)]}`);
    // b. The order changed mid-run (after the watermark) was not fetched by this run...
    if (await has(3004)) bad.push('a change after the watermark was taken by the same run');
    // c. ...and the checkpoint moved to the watermark, only now that the run completed.
    if (await ckNow() !== run1.details.window.until || run1.status !== 'completed') bad.push(`checkpoint ${await ckNow()} vs until ${run1.details.window.until}`);
    const st = await shopifySyncStatus();
    if (st.state !== 'completed' || st.mode !== 'incremental' || st.created !== 2 || st.externalCreated !== 1) bad.push(`status ${JSON.stringify(st)}`);
    // b (cont.). The next run starts at the watermark (less the overlap) and picks the mid-run change up.
    await new Promise((r) => setTimeout(r, 250));
    const r2 = await startIncrementalSync({ actor: SH_ACTOR, gql, backoffMs: 1 });
    await r2.done;
    if (!(await has(3004))) bad.push('the mid-run change was skipped');
    // e. Repeated with nothing new: nothing created, nothing duplicated.
    const r3 = await startIncrementalSync({ actor: SH_ACTOR, gql, backoffMs: 1 });
    const res3 = await r3.done;
    if (res3.summary.ordersCreated !== 0 || res3.summary.externalShipmentsCreated !== 0) bad.push(`repeat ${JSON.stringify(res3.summary)}`);
    // g, h. An updated order and a BWA fulfilment that moved on: updated, the shipment advanced (still one).
    const o3 = store.find((o) => o.id === gidOf(3003));
    o3.fulfillments = [{ ...bwaF, displayStatus: 'DELIVERED', deliveredAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    o3.note = 'changed in Shopify';
    o3.updatedAt = new Date().toISOString();
    const r4 = await startIncrementalSync({ actor: SH_ACTOR, gql, backoffMs: 1 });
    const res4 = await r4.done;
    const sh = (await getPool().query(`SELECT s.shipment_status FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = $1`, [gidOf(3003)])).rows;
    if (res4.summary.changed < 1 || res4.summary.externalShipmentsUpdated !== 1 || sh.length !== 1 || sh[0].shipment_status !== 'delivered') bad.push(`update ${JSON.stringify({ s: res4.summary, sh })}`);
    // d. A run that fails leaves the checkpoint; the next run re-covers the same window.
    const before = await ckNow();
    store.push({ ...shOrder(3005, { created: new Date().toISOString() }), updatedAt: new Date().toISOString() });
    const broken = async (q, v) => { if (/^query BriyoOrdersPage/.test(q)) throw Object.assign(new Error('Shopify HTTP 400: Bad request'), { status: 400 }); return gql(q, v); };
    const r5 = await startIncrementalSync({ actor: SH_ACTOR, gql: broken, backoffMs: 1 });
    await r5.done.then(() => bad.push('broken run succeeded'), () => {});
    if (await ckNow() !== before || (await lastRun()).status !== 'failed' || await has(3005)) bad.push('a failed run moved the checkpoint or imported');
    const r6 = await startIncrementalSync({ actor: SH_ACTOR, gql, backoffMs: 1 });
    await r6.done;
    if (!(await has(3005)) || await ckNow() === before) bad.push('the retry did not cover the window');
    // j. One at a time.
    const r7 = await startIncrementalSync({ actor: SH_ACTOR, gql, backoffMs: 1 });
    await expectErr('second click', () => startIncrementalSync({ actor: SH_ACTOR, gql }), (e) => e.status === 409 && e.syncRunning);
    await expectErr('full history meanwhile', () => startFullHistorySync({ actor: SH_ACTOR, gql }), (e) => e.status === 409 && e.syncRunning);
    await r7.done;
    // i. No stock side effects.
    const fx1 = await fx();
    if (fx1.mv !== fx0.mv || fx1.rs !== fx0.rs) bad.push(`stock ${JSON.stringify([fx0, fx1])}`);
  } finally {
    if (savedCk === null) await getPool().query('DELETE FROM system_state WHERE key = $1', [CK]); else await setCk(savedCk);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'from the last successful checkpoint only (older change not fetched); a change made mid-run falls after the fixed watermark and is taken by the next run; checkpoint = the watermark, set only on success; repeat run creates nothing; changed order updated and its BWA fulfilment advanced to delivered (one shipment); a failed run leaves the checkpoint and the next re-covers the window; second click and a full-history start refused while running; no movements or reservations';
});
await step('orders page: Refresh only reloads, Shopify starts the full sync (no panel), the Shopify logo has no dark tile', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/orders.js', import.meta.url), 'utf8');
  const html = await fsp.readFile(new URL('../public/orders.html', import.meta.url), 'utf8');
  const css = await fsp.readFile(new URL('../public/orders.css', import.meta.url), 'utf8');
  const refresh = js.match(/\$\('#refresh'\)\.addEventListener\('click', ([^\n]+)\);/)?.[1] || '';
  if (!refresh || /shopify|sync/i.test(refresh)) bad.push(`refresh handler: ${refresh}`);
  if (!/\$\('#shopifyOrders'\)\.addEventListener\('click', onShopifyClick\)/.test(js) || !/: startShopifySync\(\)\)/.test(js) || /\$\('#shopifyOrders'\)\.addEventListener\('click', openShopify\)/.test(js)) bad.push('Shopify button not wired to the direct sync');
  if (!/api\('\/api\/orders\/shopify\/sync-updates', \{ method: 'POST' \}\)/.test(js)) bad.push('incremental sync not called');
  // k. The normal button never runs full history: the page never calls the recovery route.
  if (/shopify\/sync-all/.test(js)) bad.push('the page calls the full-history route');
  if (/class="brand-mark" src="\/brand\/shopify-bag\.svg"/.test(html) || (html.match(/class="shopify-mark"/g) || []).length !== 1) bad.push('logo still uses the dark brand-mark tile class');
  // The old sync drawer is gone, with its code: nothing left that could open it.
  if (/id="shopifyDrawer"/.test(html) || /openShopify|closeShopify|sfRun|#shopifyDrawer|#sf[A-Z]/.test(js)) bad.push('old Shopify drawer or its code still present');
  if (!/\.shopify-mark \{[^}]*background: none/.test(css)) bad.push('logo background not cleared');
  if (/\.shopify-mark \{[^}]*var\(--ink\)/.test(css)) bad.push('logo has an ink background');
  const svg = await fsp.readFile(new URL('../public/brand/shopify-bag.svg', import.meta.url), 'utf8');
  if (/<rect/.test(svg)) bad.push('the logo file has a background rectangle');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Refresh handler only reloads (no Shopify call); Shopify button → POST /api/orders/shopify/sync-updates (never sync-all), the old drawer and its code removed; logo uses .shopify-mark with no background (not the sidebar dark .brand-mark tile); the official SVG has no background shape';
});
// ---- Amazon SP-API (Phase 2b): client, mapping, incremental sync — offline, fake transport only ------------
const AZS = (n) => `${TEST_ORDER}-AZSP-${n}`;
const AZ_ACTOR = `${TEST_ORDER}-azsync`;
const AZ_SECRETS = { clientId: 'amzn1.application-oa2-client.dbcheck0001', clientSecret: 'dbcheck-lwa-secret-7f3a9c', refreshToken: 'Atzr|dbcheck-refresh-0b1c2d3e',
  sellerId: 'A1DBCHECKSELLER', marketplaceId: 'A21TJRUUN4KGV', region: 'eu', endpoint: 'https://sellingpartnerapi-eu.amazon.com' };
const azMoney = (amount, currencyCode = 'INR') => ({ amount: String(amount), currencyCode });
/** An Amazon order item as Orders v2026-01-01 returns it with includedData=PROCEEDS (tax shown separately). */
const azItem = (id, { sku = 'SKU-1', qty = 1, item = '422.88', tax = '76.12', ship = null, disc = null, cur = 'INR', taxCur = cur } = {}) => ({
  orderItemId: id, quantityOrdered: qty,
  product: { sellerSku: sku, title: 'Test product', asin: 'B0DBCHECK1', ...(item === null ? {} : { price: { unitPrice: azMoney(item, cur) } }) },
  proceeds: { breakdowns: [
    ...(item === null ? [] : [{ type: 'ITEM', subtotal: azMoney(item, cur) }]),
    ...(tax === null ? [] : [{ type: 'TAX', subtotal: azMoney(tax, taxCur), detailedBreakdowns: [{ subtype: 'ITEM', value: azMoney(tax, taxCur) }] }]),
    ...(ship === null ? [] : [{ type: 'SHIPPING', subtotal: azMoney(ship, cur) }]),
    ...(disc === null ? [] : [{ type: 'DISCOUNT', subtotal: azMoney(disc, cur), detailedBreakdowns: [{ subtype: 'ITEM', value: azMoney(disc, cur) }] }]),
  ] },
});
const azOrder = (n, items, { status = 'UNSHIPPED', by = 'MERCHANT', updated = '2026-10-08T10:00:00Z' } = {}) => ({
  orderId: AZS(n), createdTime: '2026-09-20T10:15:00Z', lastUpdatedTime: updated,
  salesChannel: { marketplaceId: 'A21TJRUUN4KGV', channelName: 'AMAZON' },
  fulfillment: { fulfillmentStatus: status, fulfilledBy: by },
  proceeds: { grandTotal: azMoney('499.00') },
  // What a buyer section would look like — never requested, and never stored if Amazon sent it anyway.
  ...(n === 1 ? { buyer: { buyerEmail: 'dbcheck-buyer@example.invalid', buyerName: 'Dbcheck Buyer' }, recipient: { deliveryAddress: { addressLine1: 'DBCHECK STREET 1', phone: '9000000077' } } } : {}),
  orderItems: items,
});
/** A fake Amazon: LWA + Orders API. `pages[token]` = { orders, next }; `script` = responses to return first, in order. */
function fakeAmazon() {
  const s = { issued: 0, lwa: 0, lwaBodies: [], calls: [], pages: { '': { orders: [] } }, script: [], lwaScript: [], expired: new Set(), hold: null };
  s.transport = async (req) => {
    if (req.url === LWA_TOKEN_URL) {
      s.lwa += 1; s.lwaBodies.push(req.body);
      const f = s.lwaScript.shift();
      if (f) return f;
      s.issued += 1;
      return { status: 200, headers: {}, text: JSON.stringify({ access_token: `Atza|dbcheck-access-${s.issued}`, token_type: 'bearer', expires_in: 3600, refresh_token: AZ_SECRETS.refreshToken }) };
    }
    s.calls.push(req);
    if (s.hold) await s.hold;
    const f = s.script.shift();
    if (f instanceof Error) throw f;
    if (f) return f;
    if (req.headers['x-amz-access-token'] !== `Atza|dbcheck-access-${s.issued}`) return { status: 401, headers: {}, text: JSON.stringify({ errors: [{ code: 'Unauthorized', message: 'The access token you provided has expired.' }] }) };
    const u = new URL(req.url);
    const one = u.pathname.match(/^\/orders\/2026-01-01\/orders\/(.+)$/);
    if (one) return { status: 200, headers: {}, text: JSON.stringify({ order: { orderId: decodeURIComponent(one[1]) } }) };
    const tok = u.searchParams.get('paginationToken') || '';
    if (s.expired.has(tok)) return { status: 400, headers: {}, text: JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'Invalid paginationToken: expired' }] }) };
    const p = s.pages[tok];
    if (!p) return { status: 400, headers: {}, text: JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'Invalid Input' }] }) };
    return { status: 200, headers: { 'x-amzn-ratelimit-limit': '0.0056' }, text: JSON.stringify({ orders: p.orders, ...(p.next ? { pagination: { nextToken: p.next } } : {}) }) };
  };
  return s;
}
const azClient = (s, extra = {}) => createAmazonClient({ config: AZ_SECRETS, transport: s.transport, backoffMs: 10, wait: async () => {}, ...extra });
const azRow = async (n) => (await getPool().query(`SELECT * FROM orders WHERE channel = 'amazon' AND source_order_id = $1`, [AZS(n)])).rows[0];
const azItems = async (n) => (await getPool().query(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.channel = 'amazon' AND o.source_order_id = $1 ORDER BY oi.source_line_item_id`, [AZS(n)])).rows;

await step('amazon sp-api client: LWA exchange, in-memory token cache, 401 refresh once, India endpoint, request shapes, retry classes, secrets never shown', async () => {
  const bad = [];
  // Config and the India endpoint.
  const env = amazonConfig({ AMAZON_SPAPI_REGION: 'eu', AMAZON_MARKETPLACE_ID: 'A21TJRUUN4KGV' });
  if (env.endpoint !== 'https://sellingpartnerapi-eu.amazon.com' || amazonConfig({}).endpoint !== env.endpoint) bad.push('India/EU endpoint');
  if (ENDPOINTS.na !== 'https://sellingpartnerapi-na.amazon.com' || ORDERS_API_VERSION !== '2026-01-01' || LWA_TOKEN_URL !== 'https://api.amazon.com/auth/o2/token') bad.push('constants');
  if (amazonConfigured(amazonConfig({ AMAZON_LWA_CLIENT_ID: 'fake-lwa-client-id', AMAZON_LWA_CLIENT_SECRET: 'fake-lwa-client-secret', AMAZON_SPAPI_REFRESH_TOKEN: 'fake-refresh-token',
    AMAZON_SELLER_ID: 'fake-seller-id', AMAZON_MARKETPLACE_ID: 'A21TJRUUN4KGV' }))) bad.push('.env.example placeholders count as configured');
  if (!amazonConfigured(AZ_SECRETS)) bad.push('test config not configured');
  const example = await fsp.readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const k of ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_SPAPI_REFRESH_TOKEN', 'AMAZON_SELLER_ID', 'AMAZON_MARKETPLACE_ID', 'AMAZON_SPAPI_REGION=eu']) if (!example.includes(k)) bad.push(`.env.example lacks ${k}`);
  // Capture everything the client prints.
  const printed = [];
  const [w0, e0, l0] = [console.warn, console.error, console.log];
  console.warn = (...a) => printed.push(a.join(' ')); console.error = (...a) => printed.push(a.join(' '));
  const thrown = [];
  const catchMsg = async (p) => { try { await p; return null; } catch (e) { thrown.push(e.message); return e; } };
  try {
    // 1, 2. Exchange once; cached until near expiry; then exchanged again.
    let clock = Date.now();
    const s = fakeAmazon();
    s.pages[''] = { orders: [] };
    const c = azClient(s, { now: () => clock });
    await c.searchOrders({ lastUpdatedAfter: '2026-10-08T00:00:00.000Z', lastUpdatedBefore: '2026-10-08T01:00:00.000Z', includedData: ['PROCEEDS', 'FULFILLMENT'] });
    await c.searchOrders({ lastUpdatedAfter: '2026-10-08T00:00:00.000Z', lastUpdatedBefore: '2026-10-08T01:00:00.000Z' });
    if (s.lwa !== 1 || !c.hasCachedToken()) bad.push(`cache: ${s.lwa} exchanges`);
    const body = new URLSearchParams(s.lwaBodies[0]);
    if (body.get('grant_type') !== 'refresh_token' || body.get('refresh_token') !== AZ_SECRETS.refreshToken || body.get('client_id') !== AZ_SECRETS.clientId || body.get('client_secret') !== AZ_SECRETS.clientSecret) bad.push('LWA body');
    clock += 3600 * 1000;                                       // past expiry (less the minute of skew)
    await c.searchOrders({ lastUpdatedAfter: '2026-10-08T00:00:00.000Z', lastUpdatedBefore: '2026-10-08T01:00:00.000Z' });
    if (s.lwa !== 2) bad.push('not refreshed at expiry');
    // 5. searchOrders request.
    const q = new URL(s.calls[0].url);
    const h = s.calls[0].headers;
    if (s.calls[0].method !== 'GET' || q.origin !== 'https://sellingpartnerapi-eu.amazon.com' || q.pathname !== '/orders/2026-01-01/orders'
      || q.searchParams.get('marketplaceIds') !== 'A21TJRUUN4KGV' || q.searchParams.get('lastUpdatedAfter') !== '2026-10-08T00:00:00.000Z'
      || q.searchParams.get('lastUpdatedBefore') !== '2026-10-08T01:00:00.000Z' || q.searchParams.get('maxResultsPerPage') !== '100'
      || q.searchParams.get('includedData') !== 'PROCEEDS,FULFILLMENT' || q.searchParams.has('paginationToken') || q.searchParams.has('createdAfter')) bad.push(`search url ${q}`);
    if (h['x-amz-access-token'] !== 'Atza|dbcheck-access-1' || !/^\d{8}T\d{6}Z$/.test(h['x-amz-date']) || !h['user-agent'] || h.authorization) bad.push(`headers ${Object.keys(h)}`);
    await c.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B', fulfillmentStatuses: ['UNSHIPPED', 'SHIPPED'], fulfilledBy: ['MERCHANT'], maxResultsPerPage: 50, paginationToken: 'TOK' })
      .catch(() => {});
    const q2 = new URL(s.calls[s.calls.length - 1].url);
    if (q2.searchParams.get('fulfillmentStatuses') !== 'UNSHIPPED,SHIPPED' || q2.searchParams.get('fulfilledBy') !== 'MERCHANT'
      || q2.searchParams.get('maxResultsPerPage') !== '50' || q2.searchParams.get('paginationToken') !== 'TOK') bad.push(`search url 2 ${q2}`);
    // 6. getOrder.
    const g = await c.getOrder('403-1234567-7654321', { includedData: ['PROCEEDS'] });
    const gq = new URL(s.calls[s.calls.length - 1].url);
    if (g.order?.orderId !== '403-1234567-7654321' || gq.pathname !== '/orders/2026-01-01/orders/403-1234567-7654321' || gq.searchParams.get('includedData') !== 'PROCEEDS') bad.push(`getOrder ${gq}`);
    const n0 = s.calls.length;
    if (!(await catchMsg(c.getOrder('../x'))) || s.calls.length !== n0) bad.push('bad order id sent');
    // 3, 28. A 401 refreshes once and retries; a second 401 stands.
    s.issued += 1;                                              // Amazon no longer accepts the cached token
    const before = s.lwa;
    await c.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' });
    if (s.lwa !== before + 1) bad.push('401 did not refresh');
    s.script.push({ status: 401, headers: {}, text: '{}' }, { status: 401, headers: {}, text: '{}' });
    const l1 = s.lwa; const c1 = s.calls.length;
    const e401 = await catchMsg(c.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    if (!e401?.amazonAuth || s.lwa !== l1 + 1 || s.calls.length !== c1 + 2) bad.push(`second 401: lwa ${s.lwa - l1}, calls ${s.calls.length - c1}`);
    // 24. 429 → throttled; waits one refill at the known rate (header or remembered, else documented), 2 retries.
    const waits = [];
    let vclock = Date.now();
    let ct = azClient(s, { wait: async (ms) => { waits.push(ms); vclock += ms; }, now: () => vclock });
    s.script.push({ status: 429, headers: { 'x-amzn-ratelimit-limit': '0.0056' }, text: '{"errors":[{"code":"QuotaExceeded","message":"You exceeded your quota"}]}' },
      { status: 429, headers: {}, text: '{}' });
    await ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' });
    if (waits.join() !== '178572,178572') bad.push(`429 waits ${waits}`);
    for (let i = 0; i < 3; i += 1) s.script.push({ status: 429, headers: {}, text: '{}' });
    const e429 = await catchMsg(ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    if (!e429?.throttled || s.script.length) bad.push('429 bound');
    // 25, 26. 5xx and connection failures: 3 tries in all (a fresh client: a full allowance, so only retry waits show).
    waits.length = 0;
    vclock = Date.now();
    ct = azClient(s, { wait: async (ms) => { waits.push(ms); vclock += ms; }, now: () => vclock });
    s.script.push({ status: 500, headers: {}, text: '{}' }, { status: 503, headers: {}, text: '{}' });
    await ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' });
    if (waits.join() !== '10,20') bad.push(`5xx waits ${waits}`);
    s.script.push(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), { status: 502, headers: {}, text: '{}' }, { status: 504, headers: {}, text: '{}' });
    const eConn = await catchMsg(ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    if (!eConn?.transient || s.script.length) bad.push('transient bound');
    s.script.push(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    await ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' });
    // 27. Permanent 4xx: one try.
    for (const [st, code] of [[400, 'InvalidInput'], [403, 'AccessDenied'], [404, 'NotFound']]) {
      const c0 = s.calls.length;
      s.script.push({ status: st, headers: {}, text: JSON.stringify({ errors: [{ code, message: 'no' }] }) });
      const e = await catchMsg(ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
      if (!e || e.throttled || e.transient || s.calls.length !== c0 + 1) bad.push(`${st} retried`);
    }
    // 4. Secrets: a failing LWA answer that echoes them, an error body with a token — nothing reaches a message or a log.
    const s2 = fakeAmazon();
    s2.lwaScript.push({ status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_grant', error_description: `bad ${AZ_SECRETS.refreshToken} / ${AZ_SECRETS.clientSecret}` }) });
    const eL = await catchMsg(azClient(s2).searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    if (!/invalid_grant/.test(eL?.message || '')) bad.push(`LWA error ${eL?.message}`);
    s.script.push({ status: 400, headers: {}, text: JSON.stringify({ errors: [{ code: 'InvalidInput', message: `token Atza|dbcheck-access-${s.issued} rejected; secret ${AZ_SECRETS.clientSecret}` }] }) });
    await catchMsg(ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    s.script.push(Object.assign(new Error(`socket closed for ${AZ_SECRETS.refreshToken}`), { cause: { message: `Atza|dbcheck-access-${s.issued}` } }),
      Object.assign(new Error('x'), { cause: { message: `Atza|dbcheck-access-${s.issued}` } }), Object.assign(new Error('x'), { cause: { message: `${AZ_SECRETS.clientSecret}` } }));
    await catchMsg(ct.searchOrders({ lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' }));
    const all = [...printed, ...thrown].join('\n');
    for (const secret of [AZ_SECRETS.clientSecret, AZ_SECRETS.refreshToken, 'Atza|', 'dbcheck-refresh']) if (all.includes(secret)) bad.push(`secret shown: ${secret.slice(0, 8)}…`);
    if (!thrown.length || !printed.some((p) => /transient failure/.test(p))) bad.push('nothing captured to check');
    if (redact(`a ${AZ_SECRETS.clientSecret} Atza|abc.def Atzr|x1 refresh_token=zzz`, AZ_SECRETS) !== 'a [redacted] [redacted] [redacted] refresh_token=[redacted]') bad.push('redact()');
  } finally { console.warn = w0; console.error = e0; console.log = l0; }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'LWA refresh_token exchange (form body), token cached in memory until a minute before expiry; 401 → one refresh + retry, a second 401 stands; EU endpoint for India; searchOrders/getOrder URLs, form-style arrays, x-amz-access-token/x-amz-date/user-agent, no signing; 429 waits one refill (~178.6 s at 0.0056/s), 2 retries, then thrown; 500/502/503/504/connection 3 tries; 400/403/404 once; no secret or token in any message or log';
});

await step('amazon orders: mapping — file-import value formula, tax/shipping/discount, FBA, pending, mixed currency refused, no buyer data', async () => {
  const bad = [];
  const m = mapAmazonOrder(azOrder(1, [azItem('I1', { ship: '40', disc: '-50' })]));
  const it = m.items?.[0] || {};
  if (m.error || m.source_order_id !== AZS(1) || m.currency !== 'INR' || m.order_value !== 489 || !m.priced || m.cancelled) bad.push(`order ${JSON.stringify(m).slice(0, 200)}`);
  if (it.source_line_item_id !== 'I1' || it.item_price !== 499 || it.price_excl_tax !== 422.88 || it.item_tax !== 76.12 || it.shipping_price !== 40
    || it.promotion_discount !== -50 || it.sku !== 'SKU-1' || it.asin !== 'B0DBCHECK1' || it.quantity !== 1) bad.push(`item ${JSON.stringify(it)}`);
  const pj = JSON.stringify(m.amazon_spapi);
  if (/buyer|recipient|dbcheck-buyer|DBCHECK STREET|9000000077/i.test(pj)) bad.push('buyer data stored');
  const noTax = mapAmazonOrder(azOrder(2, [azItem('I1', { item: '499.00', tax: null })]));
  if (noTax.items[0].item_price !== 499 || noTax.items[0].item_tax !== null || noTax.items[0].price_excl_tax !== null) bad.push('tax-inclusive item');
  const fba = mapAmazonOrder(azOrder(3, [azItem('I1')], { by: 'AMAZON', status: 'SHIPPED' }));
  if (fba.fulfilled_by !== 'AMAZON' || fba.amazon_spapi.fulfilled_by !== 'AMAZON') bad.push('fba');
  const pend = mapAmazonOrder(azOrder(4, [azItem('I1', { item: null, tax: null })], { status: 'PENDING' }));
  if (pend.priced || pend.order_value !== null || pend.error) bad.push('pending');
  const mixed = mapAmazonOrder(azOrder(5, [azItem('I1', { taxCur: 'USD' })]));
  if (!/mixed currencies \(INR, USD\)/.test(mixed.error || '')) bad.push(`mixed ${mixed.error}`);
  if (!mapAmazonOrder(azOrder(6, [azItem('I1', { item: 'abc' })])).error || !mapAmazonOrder({ orderId: '' }).error) bad.push('bad amounts/ids accepted');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'value = Σ item incl. tax + shipping + discounts (negative), as the file import; ITEM excl. tax + TAX → item price incl. tax; FBA kept; pending = unpriced; mixed currency / bad amount → refused; buyer/recipient never stored';
});

await step('amazon orders: incremental sync — window, watermark, paging, checkpoint only on success, idempotent, FBA, SKUs, no stock/attribution/shipments, continuing failed and partial windows, expired page tokens, one at a time, CSV convergence', async () => {
  const bad = [];
  const db = getPool();
  const CK = 'amazon_orders_checkpoint';
  const saved = (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const ck = async () => (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const fx = async () => (await db.query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1)::int sh,
    (SELECT count(*) FROM affiliate_order_attributions a JOIN orders o ON o.id = a.order_id WHERE o.source_order_id LIKE $1)::int at`, [`${TEST_ORDER}-AZSP-%`])).rows[0];
  const sku = await createSku({ sku: `${TS}-AZSP`, product_name: 'Amazon SP-API test' }, { actor: ACTOR });
  await addPlatformMappings(sku.id, 'amazon', [`${TS}-AZSP-SELLER`], { actor: ACTOR });
  try {
    await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    const s = fakeAmazon();
    const client = azClient(s);
    const fx0 = await fx();
    // 37. Full history is not part of this phase; no checkpoint and no start date → refused.
    await expectErr('full history', () => runAmazonSync({ window: { mode: 'all' }, client, actor: AZ_ACTOR }), (e) => e.status === 400 && /Full history/.test(e.message));
    await expectErr('no checkpoint', () => runAmazonSync({ client, actor: AZ_ACTOR }), (e) => e.status === 409);
    await expectErr('not configured', () => startAmazonIncrementalSync({ actor: AZ_ACTOR }), (e) => e.status === 400 && /not connected/.test(e.message));
    // 16, 21, 22, 23, 36, 8, 12. First run from a start date: two pages.
    s.pages[''] = { orders: [azOrder(1, [azItem('I1', { sku: `${TS}-AZSP-SELLER` })]), azOrder(2, [azItem('I1', { sku: `${TS}-AZSP-UNMAPPED` })]),
      azOrder(3, [azItem('I1', { sku: `${TS}-AZSP-SELLER` })], { by: 'AMAZON', status: 'SHIPPED' }), azOrder(4, [azItem('I1', { item: null, tax: null })], { status: 'PENDING' }),
      azOrder(5, [azItem('I1', { taxCur: 'USD' })])], next: 'P2' };
    s.pages.P2 = { orders: [azOrder(6, [azItem('I1')], { status: 'CANCELLED' })] };   // SKU-1: unmapped too
    const now1 = new Date();
    const from = new Date(now1.getTime() - 2 * 86400000).toISOString();
    const r1 = await runAmazonSync({ client, actor: AZ_ACTOR, startFrom: from, now: now1 });
    const until1 = new Date(now1.getTime() - 3 * 60000).toISOString();
    const [q1, q2] = s.calls.slice(-2).map((c) => new URL(c.url).searchParams);
    if (r1.window.since !== from || r1.window.until !== until1) bad.push(`first window ${JSON.stringify(r1.window)}`);
    if (q1.get('lastUpdatedAfter') !== from || q1.get('lastUpdatedBefore') !== until1 || q1.has('paginationToken')
      || q2.get('paginationToken') !== 'P2' || q2.get('lastUpdatedAfter') !== from || q2.get('lastUpdatedBefore') !== until1 || /BUYER|RECIPIENT/.test(q1.get('includedData'))) bad.push('page requests');
    if (r1.summary.created !== 4 || r1.summary.unpriced !== 1 || r1.summary.errors !== 1 || r1.summary.unmappedLines !== 2 || r1.summary.partial) bad.push(`run1 ${JSON.stringify(r1.summary)}`);
    if (!/mixed currencies/.test(r1.errors[0]?.reason || '') || r1.errors[0]?.amazonOrderId !== AZS(5)) bad.push('mixed-currency order not refused by name');
    if ((await ck()) !== until1) bad.push(`checkpoint ${await ck()} ≠ watermark`);
    const o1 = await azRow(1); const o3 = await azRow(3); const o6 = await azRow(6);
    if (o1.source !== 'amazon_spapi' || Number(o1.order_value) !== 499 || o1.currency !== 'INR' || o1.dispatch_type !== 'easy_ship' || o1.fulfillment_type !== 'merchant' || o1.order_status !== 'new') bad.push(`o1 ${JSON.stringify(o1).slice(0, 200)}`);
    if (o1.customer_name || o1.customer_email || o1.customer_phone || /dbcheck-buyer|DBCHECK STREET|9000000077/.test(JSON.stringify(o1.source_payload))) bad.push('buyer data stored');
    if (o3.dispatch_type !== null || o3.fulfillment_type !== 'marketplace' || o3.source_payload.amazon_spapi.fulfilled_by !== 'AMAZON') bad.push('FBA order');
    if (o6.order_status !== 'cancelled' || await azRow(4) || await azRow(5)) bad.push('cancelled / pending / refused');
    if ((await azItems(1))[0].sku_id !== sku.id || (await azItems(2))[0].sku_id !== null) bad.push('sku mapping');
    const run1 = (await db.query('SELECT channel, status, details FROM order_imports WHERE id = $1', [r1.runId])).rows[0];
    if (run1.channel !== 'amazon' || run1.status !== 'completed' || run1.details.window.mode !== 'incremental' || run1.details.cursor !== null) bad.push(`run row ${JSON.stringify(run1).slice(0, 200)}`);
    // 15, 11, 10. Same orders again: nothing changes; the window starts 5 minutes before the checkpoint.
    s.pages[''] = { orders: s.pages[''].orders, next: 'P2' };
    const now2 = new Date(now1.getTime() + 60000);
    const r2 = await runAmazonSync({ client, actor: AZ_ACTOR, now: now2 });
    if (r2.window.since !== new Date(new Date(until1).getTime() - 5 * 60000).toISOString() || r2.window.until !== new Date(now2.getTime() - 3 * 60000).toISOString()) bad.push(`overlap ${JSON.stringify(r2.window)}`);
    if (r2.summary.created || r2.summary.updated || r2.summary.itemsCreated || r2.summary.itemsUpdated || r2.summary.unchanged !== 4) bad.push(`repeat ${JSON.stringify(r2.summary)}`);
    if ((await ck()) !== r2.window.until) bad.push('checkpoint after repeat');
    // 17. Changed at Amazon: a new price; the pending order now has prices; the FBA one changes nothing in Briyo's dispatch.
    s.pages[''] = { orders: [azOrder(1, [azItem('I1', { sku: `${TS}-AZSP-SELLER`, item: '440.00', tax: '79.20' })], { updated: '2026-10-08T11:00:00Z' }),
      azOrder(4, [azItem('I1', { sku: `${TS}-AZSP-SELLER` })], { updated: '2026-10-08T11:00:00Z' })] };
    const r3 = await runAmazonSync({ client, actor: AZ_ACTOR, now: new Date(now2.getTime() + 60000) });
    if (r3.summary.updated !== 1 || r3.summary.created !== 1 || Number((await azRow(1)).order_value) !== 519.2 || Number((await azItems(1))[0].item_price) !== 519.2) bad.push(`update ${JSON.stringify(r3.summary)}`);
    const ev = (await db.query(`SELECT event_type FROM order_events WHERE order_id = $1 ORDER BY id`, [(await azRow(1)).id])).rows.map((r) => r.event_type);
    if (ev.join() !== 'order_created,amazon_sync_updated') bad.push(`events ${ev}`);
    // 13, 14. A failed run leaves the checkpoint; the next start continues that same window and then moves it.
    const ck3 = await ck();
    s.script.push({ status: 400, headers: {}, text: JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'Invalid Input' }] }) });
    const nowF = new Date(now2.getTime() + 120000);
    const fail = await runAmazonSync({ client, actor: AZ_ACTOR, now: nowF }).then(() => null, (e) => e);
    if (!fail || (await ck()) !== ck3) bad.push('failed run moved the checkpoint');
    const failedRow = (await db.query(`SELECT id, status, details FROM order_imports WHERE kind = 'amazon_sync' ORDER BY id DESC LIMIT 1`)).rows[0];
    if (failedRow.status !== 'failed') bad.push('failed run not recorded');
    s.pages[''] = { orders: [] };
    const st = await startAmazonIncrementalSync({ client, actor: AZ_ACTOR });
    const rC = await st.done;
    if (st.resumedFrom !== Number(failedRow.id) || rC.window.since !== failedRow.details.window.since || rC.window.until !== failedRow.details.window.until) bad.push('failed window not continued');
    if ((await ck()) !== failedRow.details.window.until) bad.push('checkpoint after the continued window');
    // 9. Partial run: the page token is saved with its issue time; a fresh one is used to continue; checkpoint waits for the end.
    s.pages[''] = { orders: [azOrder(7, [azItem('I1')])], next: 'T1' };
    s.pages.T1 = { orders: [azOrder(8, [azItem('I1')])], next: 'T2' };
    s.pages.T2 = { orders: [azOrder(9, [azItem('I1')])] };
    const ck4 = await ck();
    const p1 = await runAmazonSync({ client, actor: AZ_ACTOR, maxOrders: 1 });
    const pRow = (await db.query('SELECT status, details FROM order_imports WHERE id = $1', [p1.runId])).rows[0];
    if (!p1.summary.partial || pRow.status !== 'partial' || pRow.details.cursor?.token !== 'T1' || !pRow.details.cursor.issuedAt || (await ck()) !== ck4) bad.push(`partial ${JSON.stringify(pRow.details.cursor)}`);
    const p2 = await runAmazonSync({ client, actor: AZ_ACTOR, maxOrders: 1, resumeRunId: p1.runId });
    if (new URL(s.calls[s.calls.length - 1].url).searchParams.get('paginationToken') !== 'T1' || p2.window.until !== p1.window.until || (await ck()) !== ck4) bad.push('fresh token not used');
    // A token older than 23 hours is not used: the same window again from its first page (idempotent).
    await db.query(`UPDATE order_imports SET details = jsonb_set(details, '{cursor,issuedAt}', to_jsonb((now() - interval '25 hours')::text)) WHERE id = $1`, [p2.runId]);
    const c0 = s.calls.length;
    const p3 = await runAmazonSync({ client, actor: AZ_ACTOR, maxOrders: 1, resumeRunId: p2.runId });
    const p3Row = (await db.query('SELECT details FROM order_imports WHERE id = $1', [p3.runId])).rows[0];
    if (new URL(s.calls[c0].url).searchParams.has('paginationToken') || p3Row.details.restarted !== 'page token too old' || p3.summary.created !== 0 || p3.window.until !== p1.window.until) bad.push(`stale token ${JSON.stringify(p3Row.details).slice(0, 200)}`);
    // Amazon rejects a token (expired early): restart the same window once, finish, checkpoint moves.
    s.script.push({ status: 400, headers: {}, text: JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'Invalid paginationToken: expired' }] }) });
    const c1 = s.calls.length;
    const p4 = await runAmazonSync({ client, actor: AZ_ACTOR, resumeRunId: p3.runId });
    const used = s.calls.slice(c1).map((c) => new URL(c.url).searchParams.get('paginationToken') || '-');
    if (used.join() !== 'T1,-,T1,T2' || p4.summary.restarts !== 1 || p4.summary.partial || (await ck()) !== p1.window.until || !(await azRow(9))) bad.push(`rejected token: ${used} restarts ${p4.summary.restarts} ck ${await ck()}`);
    // Rejected again within the same run: the run fails (no endless loop) and the checkpoint stays.
    s.pages[''] = { orders: [], next: 'T1' };
    s.expired.add('T1');
    const ck5 = await ck();
    const p5 = await runAmazonSync({ client, actor: AZ_ACTOR }).then(() => null, (e) => e);
    s.expired.clear();
    const p5Row = (await db.query(`SELECT status, details FROM order_imports WHERE kind = 'amazon_sync' ORDER BY id DESC LIMIT 1`)).rows[0];
    if (!p5 || p5Row.status !== 'failed' || (await ck()) !== ck5) bad.push('a token rejected twice did not fail the run');
    s.pages[''] = { orders: [] };
    await (await startAmazonIncrementalSync({ client, actor: AZ_ACTOR })).done;   // that failed window, continued and completed
    // 29, 30, 31. One Amazon chain at a time; Amazon and Shopify never block each other; never resume a Shopify run.
    s.pages[''] = { orders: [] };
    let release;
    s.hold = new Promise((r) => { release = r; });
    const live = await startAmazonIncrementalSync({ client, actor: AZ_ACTOR });
    await expectErr('second amazon start', () => startAmazonIncrementalSync({ client, actor: AZ_ACTOR }), (e) => e.status === 409 && e.syncRunning);
    await assertNoSyncRunning(db);                              // Shopify: not blocked by the Amazon chain
    if (!amazonSyncBusy()) bad.push('amazon not busy');
    release(); s.hold = null;
    await live.done;
    const { rows: [shRun] } = await db.query(`INSERT INTO order_imports (channel, kind, status, started_at, imported_by, filename, rows_processed, orders_in_file, orders_created,
       orders_updated, orders_unchanged, items_created, items_updated, promotion_rows, duplicate_rows, error_rows, details)
       VALUES ('website', 'shopify_sync', 'running', now(), $1, 'dbcheck', 0,0,0,0,0,0,0,0,0,0, $2) RETURNING id`,
      [AZ_ACTOR, JSON.stringify({ window: { mode: 'incremental', since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' }, cursor: { token: 'X', issuedAt: new Date().toISOString() } })]);
    try {
      await assertNoAmazonSyncRunning(db);                      // Amazon: not blocked by a running Shopify sync
      await expectErr('shopify blocked by its own run', () => assertNoSyncRunning(db), (e) => e.status === 409);
      await expectErr('amazon resumes a shopify run', () => runAmazonSync({ client, actor: AZ_ACTOR, resumeRunId: Number(shRun.id) }), (e) => /cannot be continued/.test(e.message));
    } finally { await db.query('DELETE FROM order_imports WHERE id = $1', [shRun.id]); }
    const status = await amazonSyncStatus();
    if (status.state !== 'completed' || status.mode !== 'incremental') bad.push(`status ${JSON.stringify(status)}`);
    // 18, 20. File first, then the API: one order; the file's extra fields and payload stay; a locked order's lines don't move.
    await commitAmazonImport(amzCsv([amzRow({ 'order-id': AZS(20), 'order-item-id': 'I1', 'item-promotion-id': 'PROMO-1', 'ship-city': 'PUNE' }),
      amzRow({ 'order-id': AZS(21), 'order-item-id': 'I1' })]), 'azsp.csv', { actor: IMPORTER });
    const o21 = await azRow(21);
    await db.query(`INSERT INTO order_shipments (order_id, shipment_status, created_by) VALUES ($1, 'dispatched', $2)`, [o21.id, ACTOR]);
    s.pages[''] = { orders: [azOrder(20, [azItem('I1'), azItem('I2', { sku: `${TS}-AZSP-SELLER`, item: '100.00', tax: '18.00' })]),
      azOrder(21, [azItem('I1', { item: '300.00', tax: '54.00' })], { status: 'SHIPPED' })] };
    const fx1a = await fx();
    const rv = await runAmazonSync({ client, actor: AZ_ACTOR });
    const o20 = await azRow(20); const it20 = await azItems(20); const it21 = await azItems(21);
    if ((await db.query(`SELECT count(*)::int n FROM orders WHERE channel = 'amazon' AND source_order_id = ANY($1)`, [[AZS(20), AZS(21)]])).rows[0].n !== 2) bad.push('duplicate order');
    if (o20.source !== 'amazon_import' || Number(o20.order_value) !== 617 || it20.length !== 2 || it20[0].promotion_id !== 'PROMO-1' || it20[1].sku_id !== sku.id) bad.push(`csv→api ${o20.source} ${o20.order_value} ${JSON.stringify(it20.map((i) => [i.source_line_item_id, i.promotion_id, i.item_price]))}`);
    if (o20.source_payload?.amazon?.ship_to?.city !== 'PUNE' || o20.source_payload?.amazon_spapi?.order_id !== AZS(20)) bad.push('file payload replaced');
    if (Number(it21[0].item_price) !== 499 || Number((await azRow(21)).order_value) !== 499 || rv.summary.conflicts !== 1) bad.push(`locked order changed ${it21[0].item_price}`);
    const ce = (await db.query(`SELECT metadata->>'kind' k FROM order_events WHERE order_id = $1 AND event_type = 'amazon_sync_conflict' ORDER BY k`, [o21.id])).rows.map((r) => r.k);
    if (ce.join() !== 'lines_locked,value_locked') bad.push(`conflicts ${ce}`);
    // 19. API first, then the file: still one order; the file fills what the API never asked for.
    s.pages[''] = { orders: [azOrder(22, [azItem('I1')])] };
    await runAmazonSync({ client, actor: AZ_ACTOR });
    await commitAmazonImport(amzCsv([amzRow({ 'order-id': AZS(22), 'order-item-id': 'I1' })]), 'azsp2.csv', { actor: IMPORTER });
    const o22 = await azRow(22);
    if ((await db.query(`SELECT count(*)::int n FROM orders WHERE channel = 'amazon' AND source_order_id = $1`, [AZS(22)])).rows[0].n !== 1
      || o22.source !== 'amazon_spapi' || (await azItems(22)).length !== 1 || o22.customer_name !== 'Test Buyer' || !o22.source_payload.amazon_spapi) bad.push('api→csv');
    // 32–35. Never stock, never shipments (beyond the one this test made), never attribution.
    const fx1 = await fx();
    if (fx1.mv !== fx0.mv || fx1.rs !== fx0.rs || fx1.sh !== 1 || fx1.at !== 0 || fx1a.sh !== 1) bad.push(`side effects ${JSON.stringify([fx0, fx1])}`);
    const src = await fsp.readFile(new URL('../lib/amazon-orders.js', import.meta.url), 'utf8');
    if (/attributeOrder|affiliate|reserveShipmentStock|dispatchShipmentStock|mirrorExternalFulfillments|recordFinancialSnapshot|INSERT INTO order_shipments/.test(src.replace(/^\s*(\*|\/\/).*$/gm, ''))) bad.push('amazon sync code reaches attribution/stock/shipments');
    // No run row carries a secret or token.
    const runs = JSON.stringify((await db.query(`SELECT errors, details FROM order_imports WHERE kind = 'amazon_sync' AND imported_by = $1`, [AZ_ACTOR])).rows);
    if (runs.includes('Atza|') || runs.includes(AZ_SECRETS.clientSecret) || runs.includes(AZ_SECRETS.refreshToken)) bad.push('secret in run rows');
  } finally {
    if (saved === null) await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    else await db.query('UPDATE system_state SET value = $2 WHERE key = $1', [CK, saved]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'first window from a start date to now − 3 min (Amazon: ≥ 2 min before the request); later windows checkpoint − 5 min; same parameters + paginationToken per page; checkpoint = watermark only after a complete window; repeat run changes nothing; price change updates order + line; pending created once priced; FBA → no dispatch type, fulfillment marketplace; mapped/unmapped SKUs; mixed currency refused by name; failed window continued as the same window; partial → token saved + used; >23 h token or Amazon-rejected token → same window from page 1; 409 for a second Amazon start; Amazon/Shopify independent; no Shopify resume; CSV→API and API→CSV converge on one order, file-only fields kept, locked lines/value kept with conflicts; no stock, shipments, attribution or secrets';
});

await step('amazon sp-api pacing: burst of 20 then one request per refill, remembered rate, 429 without a header waits a refill (not ~30 s)', async () => {
  const bad = [];
  const vc = () => { const c = { t: Date.parse('2026-10-09T00:00:00Z'), waits: [] }; c.wait = async (ms) => { c.waits.push(ms); c.t += ms; }; c.now = () => c.t; return c; };
  const q = { lastUpdatedAfter: 'A', lastUpdatedBefore: 'B' };
  // The burst: 20 requests at once, then the 21st waits one refill at the documented rate.
  let c = vc(); let s = fakeAmazon(); s.pages[''] = { orders: [] };
  const plain = { status: 200, headers: {}, text: JSON.stringify({ orders: [] }) };   // no rate-limit header
  let cl = azClient(s, { wait: c.wait, now: c.now });
  for (let i = 0; i < 20; i += 1) { s.script.push(plain); await cl.searchOrders(q); }
  if (c.waits.length || cl.searchRate() !== SEARCH_ORDERS_RATE || cl.searchWaitMs() !== 178572) bad.push(`burst: waits ${c.waits} next ${cl.searchWaitMs()}`);
  s.script.push(plain); await cl.searchOrders(q);
  if (c.waits.join() !== '178572') bad.push(`21st waits ${c.waits}`);
  // Never deliberately over the limit: 5 more requests take 5 refills, and not one 429 was provoked.
  for (let i = 0; i < 5; i += 1) { s.script.push(plain); await cl.searchOrders(q); }
  if (c.waits.length !== 6 || c.waits.some((w) => w < 178000)) bad.push(`paced waits ${c.waits}`);
  // A reported rate is remembered and used for the following requests.
  s.script.push({ status: 200, headers: { 'x-amzn-ratelimit-limit': '0.5' }, text: JSON.stringify({ orders: [] }) });
  await cl.searchOrders(q);
  if (cl.searchRate() !== 0.5) bad.push('rate not remembered');
  c.waits.length = 0;
  s.script.push(plain); await cl.searchOrders(q);
  if (c.waits.join() !== '2000') bad.push(`remembered-rate wait ${c.waits}`);
  // 429 with no header: the wait is one refill at the remembered rate (2 s here), then at the documented one on a fresh client.
  c = vc(); s = fakeAmazon(); cl = azClient(s, { wait: c.wait, now: c.now });
  s.script.push({ status: 429, headers: {}, text: '{}' }, plain);
  await cl.searchOrders(q);
  if (c.waits.join() !== '178572' || s.calls.length !== 2) bad.push(`429 no header: waits ${c.waits}, calls ${s.calls.length}`);
  // Throttled throughout: 3 tries, two refills of waiting (~6 min), then a throttled error — not a ~30 s failure, no loop.
  c = vc(); s = fakeAmazon(); cl = azClient(s, { wait: c.wait, now: c.now });
  for (let i = 0; i < 3; i += 1) s.script.push({ status: 429, headers: {}, text: '{}' });
  const e = await cl.searchOrders(q).then(() => null, (x) => x);
  if (!e?.throttled || s.calls.length !== 3 || c.waits.join() !== '178572,178572' || c.waits.some((w) => w > 200000)) bad.push(`429 exhausted: waits ${c.waits} calls ${s.calls.length}`);
  // The process keeps one client: the same instance every time.
  if (sharedAmazonClient() !== sharedAmazonClient()) bad.push('shared client not shared');
  if (bad.length) throw new Error(bad.join(' | '));
  return '20 requests without waiting, the 21st waits 178.6 s (0.0056/s), later ones one refill each, no 429 provoked; x-amzn-RateLimit-Limit 0.5 remembered → 2 s; 429 without a header waits one refill (178.6 s), not 2–16 s; still throttled → 3 tries, ≤ 200 s each, then a throttled error; one shared client per process';
});

await step('amazon sync catch-up: 2,050 orders across chained runs on one window, page 21 after a refill, allowance kept between runs, run budget, throttled runs end partial, checkpoint only at the end', async () => {
  const bad = [];
  const db = getPool();
  const CK = 'amazon_orders_checkpoint';
  const saved = (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const ck = async () => (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const vc = { t: Date.now(), waits: [] };
  const wait = async (ms) => { vc.waits.push(ms); vc.t += ms; };
  const now = () => vc.t;
  const runRows = async (since) => (await db.query(`SELECT id, status, rows_processed, details FROM order_imports WHERE kind = 'amazon_sync' AND id > $1 ORDER BY id`, [since])).rows;
  const lastId = async () => Number((await db.query(`SELECT coalesce(max(id), 0) id FROM order_imports`)).rows[0].id);
  try {
    await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    // 21 pages: 20 × 100 + 50 = 2,050 orders, one fixed window.
    const s = fakeAmazon();
    const big = (n) => azOrder(1000 + n, [azItem('I1')]);
    for (let p = 0; p < 21; p += 1) {
      s.pages[p ? `G${p}` : ''] = { orders: Array.from({ length: p < 20 ? 100 : 50 }, (_, i) => big(p * 100 + i)), ...(p < 20 ? { next: `G${p + 1}` } : {}) };
    }
    const client = azClient(s, { wait, now });
    const from = new Date(Date.now() - 86400000).toISOString();
    const id0 = await lastId();
    // Run 1: pages 1–20 inside the burst, no waiting; partial with the page-21 token; checkpoint unchanged (none yet).
    const r1 = await runAmazonSync({ client, actor: AZ_ACTOR, startFrom: from });
    if (!r1.summary.partial || r1.summary.fetched !== 2000 || vc.waits.length || (await ck()) !== null) bad.push(`run 1 ${JSON.stringify(r1.summary)} waits ${vc.waits}`);
    const [row1] = await runRows(id0);
    if (row1.details.cursor?.token !== 'G20' || row1.details.window.until !== r1.window.until) bad.push(`run 1 cursor ${JSON.stringify(row1.details.cursor)}`);
    // The chain continues with the same client: it knows the burst is spent and waits one refill before page 21.
    const st = await startAmazonIncrementalSync({ client, actor: AZ_ACTOR });
    const r2 = await st.done;
    const rows = await runRows(id0);
    const page21 = s.calls.findIndex((c) => new URL(c.url).searchParams.get('paginationToken') === 'G20');
    if (st.resumedFrom !== Number(row1.id) || rows.length !== 2 || rows[1].status !== 'completed' || r2.window.until !== r1.window.until || r2.window.since !== r1.window.since) bad.push(`chain ${rows.map((r) => r.status)}`);
    if (vc.waits.join() !== '178572' || page21 < 0) bad.push(`page 21 waits ${vc.waits}`);
    if ((await ck()) !== r1.window.until) bad.push('checkpoint not the window\'s end after the last page');
    const n = (await db.query(`SELECT count(*)::int n FROM orders WHERE channel = 'amazon' AND source_order_id = ANY($1)`, [Array.from({ length: 2050 }, (_, i) => AZS(1000 + i))])).rows[0].n;
    if (n !== 2050) bad.push(`${n} orders imported`);
    // A fresh client (a restarted process) assumes a full burst; the shared one would have waited — the allowance lives in the client.
    // Run budget: with the allowance spent, a run takes pages while its waiting stays under 15 minutes, then ends partial.
    await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    const s2 = fakeAmazon();
    for (let p = 0; p < 30; p += 1) s2.pages[p ? `H${p}` : ''] = { orders: [azOrder(5000 + p, [azItem('I1')])], ...(p < 29 ? { next: `H${p + 1}` } : {}) };
    vc.waits.length = 0;
    const c2 = azClient(s2, { wait, now });
    const t0 = vc.t;
    const b1 = await runAmazonSync({ client: c2, actor: AZ_ACTOR, startFrom: from });
    const runMs = vc.t - t0;
    if (!b1.summary.partial || b1.summary.endedBy !== 'allowance' || b1.summary.fetched !== 25 || runMs > 15 * 60000 || (await ck()) !== null) bad.push(`budget ${JSON.stringify(b1.summary)} ${runMs}`);
    // A run that processes a page and is then throttled ends partial with the no-progress count at 0.
    const thr = { status: 429, headers: {}, text: '{}' };
    const idT = await lastId();
    s2.script.push(null, thr, thr, thr);                        // null: the page is served normally, then 429s
    const pr = await runAmazonSync({ client: c2, actor: AZ_ACTOR, resumeRunId: b1.runId });
    const [prRow] = (await runRows(idT)).slice(-1);
    if (prRow.status !== 'partial' || pr.summary.endedBy !== 'throttled' || pr.summary.fetched !== 1 || prRow.details.throttle_streak !== 0 || prRow.details.cursor?.token !== 'H26') bad.push(`progress then throttled: ${prRow.status} ${JSON.stringify(prRow.details.cursor)} streak ${prRow.details.throttle_streak}`);
    // Then throttled before a page, run after run: 1, 2 → partial; the third no-progress run in a row fails. Cursor and window kept.
    let prevRun = pr.runId;
    for (let i = 1; i <= 3; i += 1) {
      for (let k = 0; k < 3; k += 1) s2.script.push(thr);
      const res = await runAmazonSync({ client: c2, actor: AZ_ACTOR, resumeRunId: prevRun }).then((x) => x, (e) => e);
      const [row] = (await runRows(idT)).slice(-1);
      prevRun = Number(row.id);
      const want = i < 3 ? 'partial' : 'failed';
      if (row.status !== want || row.details.throttle_streak !== i || row.details.cursor?.token !== 'H26' || row.details.window.until !== b1.window.until
        || (i < 3 && res.summary?.endedBy !== 'throttled') || (i === 3 && !/3 runs in a row without a page/.test(res.message || ''))) bad.push(`throttled run ${i}: ${row.status} streak ${row.details.throttle_streak} ${JSON.stringify(row.details.cursor)}`);
    }
    if ((await ck()) !== null) bad.push('checkpoint moved by throttled runs');
    // A person starts it again: the count starts at 0, so one more throttled run is partial (not an instant failure) and the
    // chain carries on from the saved cursor and window, finishes it, and only then moves the checkpoint.
    for (let k = 0; k < 3; k += 1) s2.script.push(thr);
    const idM = await lastId();
    const manual = await startAmazonIncrementalSync({ client: c2, actor: AZ_ACTOR });
    const done = await manual.done;
    const mRows = await runRows(idM);
    if (manual.resumedFrom !== prevRun || mRows[0].status !== 'partial' || mRows[0].details.throttle_streak !== 1 || mRows[0].details.cursor?.token !== 'H26'
      || mRows[0].details.window.since !== b1.window.since || mRows[mRows.length - 1].status !== 'completed') bad.push(`manual retry: ${mRows.map((r) => `${r.status}/${r.details.throttle_streak}`)}`);
    if (done.window.until !== b1.window.until || (await ck()) !== b1.window.until) bad.push('throttled window not completed');
    const total = (await db.query(`SELECT count(*)::int n FROM orders WHERE channel = 'amazon' AND source_order_id = ANY($1)`, [Array.from({ length: 30 }, (_, i) => AZS(5000 + i))])).rows[0].n;
    if (total !== 30) bad.push(`${total} of 30 budget-test orders`);
  } finally {
    if (saved === null) await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    else await db.query('UPDATE system_state SET value = $2 WHERE key = $1', [CK, saved]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return '2,050 orders: run 1 = 20 pages in the burst → partial with the page-21 token, no checkpoint; the chain reuses the client, waits one refill (178.6 s) before page 21 and completes the same window; checkpoint = window end only then; a run stops taking paced pages before 15 min of waiting (partial); a run that processed a page then hit 429s → partial, no-progress count 0; then 429s before a page: runs 1, 2 partial, the 3rd in a row fails (cursor and window kept, checkpoint untouched); a person\'s retry starts the count at 0 (partial, not an instant failure), the chain resumes the same cursor/window and completes, then the checkpoint moves';
});

await step('amazon admin API: POST /api/orders/amazon/sync + status — admin only, 409 while running, first-sync start date only before a checkpoint, no browser window, import/update/converge/idempotent, FBA no shipment/stock, no attribution or snapshots, no secrets', async () => {
  const bad = [];
  const db = getPool();
  const CK = 'amazon_orders_checkpoint';
  const saved = (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const ck = async () => (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const firstRun = Number((await db.query('SELECT coalesce(max(id), 0) id FROM order_imports')).rows[0].id);
  const s = fakeAmazon();
  _setSharedAmazonClientForTest(azClient(s));
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use('/api/orders', ordersRouterForTest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/orders`;
  const ADMIN = { isAdmin: true, caps: ['logistics.view', 'logistics.edit'] };
  const OPERATOR = { isAdmin: false, caps: ['logistics.view', 'logistics.edit'] };
  const call = async (method, path, who, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'x-test-session': JSON.stringify(who), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (/Atza\||Atzr\||dbcheck-lwa-secret/.test(text)) bad.push(`secret in ${method} ${path}`);
    return { status: r.status, body: JSON.parse(text) };
  };
  const settle = async () => { for (let i = 0; i < 200; i += 1) { const st = await amazonSyncStatus(); if (st.state !== 'running') return st; await new Promise((ok) => setTimeout(ok, 25)); } return null; };
  const fxq = async () => (await db.query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id LIKE $1)::int sh,
    (SELECT count(*) FROM affiliate_order_attributions a JOIN orders o ON o.id = a.order_id WHERE o.source_order_id LIKE $1)::int at,
    (SELECT count(*) FROM order_financial_snapshots f JOIN orders o ON o.id = f.order_id WHERE o.source_order_id LIKE $1)::int fs`, [`${TEST_ORDER}-AZSP-4%`])).rows[0];
  try {
    await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    const fx0 = await fxq();
    // Admin only.
    if ((await call('POST', '/amazon/sync', OPERATOR, {})).status !== 403 || (await call('GET', '/amazon/sync/status', OPERATOR)).status !== 403) bad.push('non-admin not 403');
    if ((await call('POST', '/amazon/sync', { isAdmin: false, caps: ['logistics.view'] }, {})).status !== 403) bad.push('viewer not 403');
    // The browser never sets the window.
    for (const b of [{ since: '2026-10-01T00:00:00Z' }, { until: '2026-10-02T00:00:00Z' }, { initial_since: new Date(Date.now() - 86400000).toISOString(), until: 'x' }, { mode: 'all' }, { from: '2026-01-01' }]) {
      const r = await call('POST', '/amazon/sync', ADMIN, b);
      if (r.status !== 400) bad.push(`accepted ${JSON.stringify(b)} → ${r.status}`);
    }
    // No checkpoint: a start date is required, and must be a valid ISO time within 90 days and in the past.
    const none = await call('POST', '/amazon/sync', ADMIN, {});
    if (none.status !== 409 || !none.body.needsInitialSince) bad.push(`no start date → ${none.status}`);
    for (const v of [new Date(Date.now() - 91 * 86400000).toISOString(), new Date(Date.now() + 3600000).toISOString(), '2026-09-01', 'yesterday', 123]) {
      const r = await call('POST', '/amazon/sync', ADMIN, { initial_since: v });
      if (r.status !== 400) bad.push(`initial_since ${v} → ${r.status}`);
    }
    if (!(await call('GET', '/amazon/sync/status', ADMIN)).body.needsInitialSince) bad.push('status does not say a start date is needed');
    if ((await db.query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'amazon_sync' AND id > $1`, [firstRun])).rows[0].n) bad.push('a refused request recorded a run');
    // First sync: a merchant order and an FBA order. While it runs, a second start is 409 and status says running.
    s.pages[''] = { orders: [azOrder(40, [azItem('I1')]), azOrder(41, [azItem('I1')], { by: 'AMAZON', status: 'SHIPPED' })] };
    let release; s.hold = new Promise((ok) => { release = ok; });
    const initial = new Date(Date.now() - 2 * 86400000).toISOString();
    const started = await call('POST', '/amazon/sync', ADMIN, { initial_since: initial });
    if (started.status !== 202 || !started.body.started || started.body.status?.state !== 'running') bad.push(`start ${started.status} ${JSON.stringify(started.body).slice(0, 160)}`);
    const again = await call('POST', '/amazon/sync', ADMIN, {});
    if (again.status !== 409 || !again.body.syncRunning) bad.push(`second start ${again.status}`);
    if ((await call('GET', '/amazon/sync/status', ADMIN)).body.state !== 'running') bad.push('status not running');
    release(); s.hold = null;
    const st1 = await settle();
    const status = (await call('GET', '/amazon/sync/status', ADMIN)).body;
    if (st1?.state !== 'completed' || status.state !== 'completed' || status.created !== 2 || status.fetched !== 2 || !status.connected || status.needsInitialSince || !status.checkpoint) bad.push(`status ${JSON.stringify(status).slice(0, 200)}`);
    const w1 = (await db.query(`SELECT details FROM order_imports WHERE kind = 'amazon_sync' ORDER BY id DESC LIMIT 1`)).rows[0].details.window;
    if (w1.since !== new Date(initial).toISOString() || (await ck()) !== w1.until) bad.push('first window/checkpoint');
    const o40 = await azRow(40); const o41 = await azRow(41);
    if (o40.source !== 'amazon_spapi' || o40.channel !== 'amazon' || o40.source_order_id !== AZS(40) || o41.fulfillment_type !== 'marketplace' || o41.dispatch_type !== null) bad.push('imported order fields');
    // After a checkpoint exists, initial_since is ignored: the window starts 5 minutes before the checkpoint.
    s.pages[''] = { orders: [azOrder(40, [azItem('I1', { item: '450.00', tax: '81.00' })], { updated: '2026-10-08T12:00:00Z' })] };
    const later = await call('POST', '/amazon/sync', ADMIN, { initial_since: new Date(Date.now() - 80 * 86400000).toISOString() });
    await settle();
    const w2 = (await db.query(`SELECT details FROM order_imports WHERE kind = 'amazon_sync' ORDER BY id DESC LIMIT 1`)).rows[0].details.window;
    if (later.status !== 202 || w2.since !== new Date(new Date(w1.until).getTime() - 5 * 60000).toISOString()) bad.push(`initial_since not ignored: ${w2.since}`);
    if (Number((await azRow(40)).order_value) !== 531 || (await amazonSyncStatus()).updated !== 1) bad.push('update not applied');
    // Repeat: nothing changes.
    await call('POST', '/amazon/sync', ADMIN, {});
    const rep = await settle();
    if (rep.created || rep.updated || rep.unchanged !== 1) bad.push(`repeat ${JSON.stringify(rep).slice(0, 160)}`);
    // CSV first, then the button: one order, still the file's.
    await commitAmazonImport(amzCsv([amzRow({ 'order-id': AZS(42), 'order-item-id': 'I1' })]), 'azapi.csv', { actor: IMPORTER });
    s.pages[''] = { orders: [azOrder(42, [azItem('I1')], { updated: '2026-10-08T13:00:00Z' })] };
    await call('POST', '/amazon/sync', ADMIN, {});
    await settle();
    const n42 = (await db.query(`SELECT count(*)::int n, min(source) src FROM orders WHERE channel = 'amazon' AND source_order_id = $1`, [AZS(42)])).rows[0];
    if (n42.n !== 1 || n42.src !== 'amazon_import' || !(await azRow(42)).source_payload.amazon_spapi) bad.push(`csv→api ${JSON.stringify(n42)}`);
    // FBA and everything else: no shipment, reservation, movement, attribution or financial snapshot.
    const fx1 = await fxq();
    if (JSON.stringify(fx1) !== JSON.stringify(fx0)) bad.push(`side effects ${JSON.stringify([fx0, fx1])}`);
    if (/dbcheck-buyer|DBCHECK STREET|9000000077/.test(JSON.stringify((await azRow(40)).source_payload))) bad.push('buyer data stored');
  } finally {
    server.close();
    _setSharedAmazonClientForTest(null);
    if (saved === null) await db.query('DELETE FROM system_state WHERE key = $1', [CK]);
    else await db.query('UPDATE system_state SET value = $2 WHERE key = $1', [CK, saved]);
    await db.query(`DELETE FROM order_imports WHERE kind = 'amazon_sync' AND id > $1`, [firstRun]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'operator/viewer 403; since/until/mode/from or any other field 400; no checkpoint → 409 needsInitialSince; initial_since >90 days, future, date-only, junk → 400, nothing recorded; valid → 202 running, second start 409, status running → completed (2 new, FBA marketplace, no dispatch type); checkpoint = window end; later initial_since ignored (checkpoint − 5 min); price update applied; repeat unchanged; CSV order converged (still amazon_import); no shipment, reservation, movement, attribution or snapshot; no secret in any response';
});

await step('orders page: Amazon button — admin only, one POST per click (disabled while busy), polls status, running/continuing/up-to-date/paused/stopped/throttled states, first-sync date only, no window from the page, mobile wrap', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/orders.js', import.meta.url), 'utf8');
  const html = await fsp.readFile(new URL('../public/orders.html', import.meta.url), 'utf8');
  const css = await fsp.readFile(new URL('../public/orders.css', import.meta.url), 'utf8');
  const order = ['id="refresh"', 'id="shopifyOrders"', 'id="amazonOrders"', 'id="importOrders"', 'id="newShipment"'].map((k) => html.indexOf(k));
  if (order.some((i) => i < 0) || order.some((v, i) => i && v < order[i - 1])) bad.push(`button order ${order}`);
  if (!/id="amazonOrders" type="button" hidden/.test(html) || !/\$\('#amazonOrders'\)\.hidden = !me\.isAdmin/.test(js)) bad.push('not admin-only in the page');
  if (!/\$\('#amazonOrders'\)\.addEventListener\('click', \(\) => startAmazonSync\(\)\)/.test(js)) bad.push('click not wired');
  const start = js.slice(js.indexOf('async function startAmazonSync'), js.indexOf('function askAmazonStart'));
  if ((start.match(/api\('\/api\/orders\/amazon\/sync'/g) || []).length !== 1 || !/if \(\$\('#amazonOrders'\)\.disabled\) return;\s*amazonBusy\(true\)/.test(start)) bad.push('not exactly one POST per click / not guarded');
  if (/since|until/.test(start.replace(/initialSince|initial_since/g, ''))) bad.push('the page sends a window');
  const follow = js.slice(js.indexOf('async function followAmazonSync'), js.indexOf('function bind()'));
  if (!/api\('\/api\/orders\/amazon\/sync\/status'\)/.test(follow) || !/setTimeout\(followAmazonSync, 2500\)/.test(follow)) bad.push('no polling');
  for (const t of ['Amazon Syncing…', 'Amazon sync continuing…', 'Amazon orders up to date', 'Amazon sync paused part-way', 'Amazon sync stopped', 'Amazon kept limiting requests', 'fetched', 'new', 'updated', 'conflict', 'unmapped line', 'runs']) if (!js.includes(t)) bad.push(`missing state text: ${t}`);
  if (!/\.page-actions \{ flex-wrap: wrap; \}/.test(css) || !/\.amazon-start \{[^}]*flex-wrap: wrap/.test(css)) bad.push('mobile wrap');
  if (/sync-all|amazon\/.*history/i.test(follow + start)) bad.push('full history reachable from the page');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Refresh · Shopify · Amazon · Import · New shipment; hidden unless admin; one POST per click, button disabled while busy; polls /amazon/sync/status every 2.5 s; running / continuing (multi-run) / up to date (fetched, new, updated, conflicts, unmapped, runs, duration) / paused / stopped / throttled texts; only initial_since ever sent; actions and the start-date row wrap on mobile';
});

await step('shopify orders: Stop Shopify Sync — admin only, 409 when idle, stops after the page in progress, interrupts a backoff, checkpoint kept, resumes with no gap or duplicate, BWA once, no stock, Amazon untouched', async () => {
  const bad = [];
  const db = getPool();
  const CK = 'shopify_orders_checkpoint';
  const ckNow = async () => (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const setCk = (v) => db.query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [CK, v]);
  const savedCk = await ckNow();
  const AZCK = 'amazon_orders_checkpoint';
  const savedAz = (await db.query('SELECT value FROM system_state WHERE key = $1', [AZCK])).rows[0]?.value ?? null;
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const gidOf = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  // 25 orders changed since the checkpoint: 3 pages of 10. One is a BWA order with an Amazon fulfilment.
  const store = Array.from({ length: 25 }, (_, i) => ({ ...shOrder(4001 + i, { created: iso(3000000 - i * 1000) }), updatedAt: iso(3000000 - i * 1000) }));
  const bwa = store[3];
  bwa.tags = ['Buy with Amazon'];
  bwa.fulfillments = [{ id: `gid://shopify/Fulfillment/${SH_NUM}9401`, name: '#4004-F1', status: 'SUCCESS', displayStatus: 'IN_TRANSIT', createdAt: iso(2900000), updatedAt: iso(2900000),
    inTransitAt: iso(2900000), deliveredAt: null, estimatedDeliveryAt: null, trackingInfo: [{ company: 'Amazon Transportation Services', number: '374199999941', url: null }] }];
  const base = shFake(() => store);
  const pages = [];
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use('/api/orders', ordersRouterForTest);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/orders/shopify/sync/cancel`;
  const ADMIN = { isAdmin: true, caps: ['logistics.view', 'logistics.edit'] };
  const cancel = async (who = ADMIN) => { const r = await fetch(url, { method: 'POST', headers: { 'x-test-session': JSON.stringify(who) } }); return { status: r.status, body: await r.json() }; };
  const has = async (n) => (await db.query('SELECT count(*)::int n FROM orders WHERE source_order_id = $1', [gidOf(n)])).rows[0].n;
  const fx = async () => (await db.query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM affiliate_order_attributions a JOIN orders o ON o.id = a.order_id WHERE o.source_order_id LIKE $1)::int at`, [`${SH_PREFIX}%`])).rows[0];
  const ships = async () => (await db.query(`SELECT count(*)::int n FROM order_shipments WHERE external_fulfillment_id = $1`, [bwa.fulfillments[0].id])).rows[0].n;
  const lastRun = async () => (await db.query(`SELECT id, status, rows_processed, details FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT 1`)).rows[0];
  try {
    const fx0 = await fx();
    await setCk(iso(3600000));
    const ck0 = await ckNow();
    // Admin only; nothing running → 409.
    if ((await cancel({ isAdmin: false, caps: ['logistics.view', 'logistics.edit'] })).status !== 403) bad.push('non-admin not 403');
    const idle = await cancel();
    if (idle.status !== 409 || idle.body.syncRunning !== false) bad.push(`idle → ${idle.status}`);
    // Stop requested while page 2 is being fetched: page 2 finishes and is applied; page 3 is never requested.
    const stopping = async (q, v) => {
      if (/^query BriyoOrdersPage/.test(q)) {
        pages.push(v.after || '-');
        if (pages.length === 2) {
          const c = await cancel();
          if (c.status !== 202 || !c.body.stopping || c.body.status?.state !== 'running' || !c.body.status?.stopping) bad.push(`cancel → ${c.status} ${JSON.stringify(c.body).slice(0, 160)}`);
          if ((await cancel()).status !== 202) bad.push('second stop request not accepted (idempotent)');
        }
      }
      return base(q, v);
    };
    const r1 = await startIncrementalSync({ actor: SH_ACTOR, gql: stopping, backoffMs: 1 });
    const res1 = await r1.done;
    const run1 = await lastRun();
    let first20 = 0; for (let n = 4001; n <= 4020; n += 1) first20 += await has(n);
    let last5 = 0; for (let n = 4021; n <= 4025; n += 1) last5 += await has(n);
    if (pages.length !== 2 || first20 !== 20 || last5 !== 0) bad.push(`pages ${pages.length}, applied ${first20}/20, beyond ${last5}`);
    if (run1.status !== 'partial' || run1.rows_processed !== 20 || !run1.details.stopped_at || !res1.summary.stopped || !res1.summary.partial) bad.push(`run ${run1.status} ${run1.rows_processed} ${JSON.stringify(run1.details.stopped_at)}`);
    if ((await ckNow()) !== ck0) bad.push('checkpoint moved by a stopped run');
    const st = await shopifySyncStatus();
    if (st.state !== 'partial' || !st.stopped || st.stopping || st.fetched !== 20 || st.created !== 20) bad.push(`status ${JSON.stringify(st).slice(0, 200)}`);
    if (syncBusy()) bad.push('still busy after stopping');
    if ((await ships()) !== 1) bad.push('BWA shipment not mirrored once');
    // A stop during a backoff wait ends at once (does not sit out the wait); that page is not applied or counted.
    let n429 = 0;
    const throttled = async (q, v) => {
      if (/^query BriyoOrdersPage/.test(q)) { n429 += 1; if (n429 === 1) setTimeout(() => { cancelShopifySync({ actor: SH_ACTOR }); }, 300); throw Object.assign(new Error('Shopify rate limit hit (HTTP 429).'), { throttled: true }); }
      return base(q, v);
    };
    const t0 = Date.now();
    const r2 = await startIncrementalSync({ actor: SH_ACTOR, gql: throttled, backoffMs: 20000 });
    const res2 = await r2.done;
    const run2 = await lastRun();
    if (Date.now() - t0 > 5000 || !res2.summary.stopped || run2.status !== 'partial' || run2.rows_processed !== 0 || (await ckNow()) !== ck0) bad.push(`backoff stop: ${Date.now() - t0} ms, ${run2.status}, ${run2.rows_processed}`);
    // Click Shopify again: from the unchanged checkpoint, every order once, the checkpoint moves only now.
    const r3 = await startIncrementalSync({ actor: SH_ACTOR, gql: base, backoffMs: 1 });
    await r3.done;
    const run3 = await lastRun();
    let all = 0; let dup = 0; for (let n = 4001; n <= 4025; n += 1) { const c = await has(n); all += c > 0 ? 1 : 0; dup += c > 1 ? 1 : 0; }
    if (all !== 25 || dup || run3.status !== 'completed' || (await ckNow()) !== run3.details.window.until || run3.details.window.since !== new Date(new Date(ck0).getTime() - 5 * 60000).toISOString()) bad.push(`resume: ${all}/25, dup ${dup}, ${run3.status}`);
    if ((await ships()) !== 1) bad.push('BWA shipment duplicated on resume');
    const fx1 = await fx();
    if (JSON.stringify(fx1) !== JSON.stringify(fx0)) bad.push(`stock/attribution changed ${JSON.stringify([fx0, fx1])}`);
    // Amazon is separate: stopping Shopify never reaches a running Amazon sync.
    await db.query('DELETE FROM system_state WHERE key = $1', [AZCK]);
    const s = fakeAmazon(); s.pages[''] = { orders: [] };
    let release; s.hold = new Promise((ok) => { release = ok; });
    const az = await startAmazonIncrementalSync({ client: azClient(s), actor: AZ_ACTOR, startFrom: iso(86400000) });
    const c = await cancel();
    if (c.status !== 409 || !amazonSyncBusy()) bad.push('Shopify stop touched Amazon');
    release(); s.hold = null;
    const azr = await az.done;
    if (azr.summary.partial || azr.summary.stopped) bad.push('Amazon run did not finish normally');
  } finally {
    server.close();
    if (savedCk === null) await db.query('DELETE FROM system_state WHERE key = $1', [CK]); else await setCk(savedCk);
    if (savedAz === null) await db.query('DELETE FROM system_state WHERE key = $1', [AZCK]); else await db.query('UPDATE system_state SET value = $2 WHERE key = $1', [AZCK, savedAz]);
    await db.query(`DELETE FROM order_imports WHERE kind = 'amazon_sync' AND imported_by = $1`, [AZ_ACTOR]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'operator 403; nothing running → 409; stop while page 2 is fetched → page 2 applied, page 3 never requested, run partial + stopped_at, checkpoint unchanged, status "stopped" (20 fetched, 20 new), not busy; stop during a 20 s backoff → ends within ~0.3 s, that page not applied, checkpoint unchanged; next click → all 25 once from checkpoint − 5 min, checkpoint = new watermark; BWA shipment once; no movements, reservations or attributions; a Shopify stop never touches a running Amazon sync';
});

await step('shopify sync lifecycle: a run cut off by a restart shows as interrupted (never "running" for ever), Stop reaches any process by run id, bounded requests, no cursor loops, a failed page keeps the checkpoint, heartbeat and live counts', async () => {
  const bad = [];
  const db = getPool();
  const R = await import('../lib/order-sync-runner.js');
  const SO = await import('../lib/shopify-orders.js');
  const SH = await import('../lib/shopify.js');
  const CK = 'shopify_orders_checkpoint';
  const ckNow = async () => (await db.query('SELECT value FROM system_state WHERE key = $1', [CK])).rows[0]?.value ?? null;
  const setCk = (v) => db.query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [CK, v]);
  const savedCk = await ckNow();
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const gidOf = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const count = async (lo, hi) => { let all = 0; let dup = 0; for (let n = lo; n <= hi; n += 1) { const c = (await db.query('SELECT count(*)::int n FROM orders WHERE source_order_id = $1', [gidOf(n)])).rows[0].n; all += c ? 1 : 0; dup += c > 1 ? 1 : 0; } return { all, dup }; };
  const row = async (id) => (await db.query('SELECT id, status, rows_processed, orders_created, details FROM order_imports WHERE id = $1', [id])).rows[0];
  const lastRun = async () => (await db.query(`SELECT id, status, rows_processed, orders_created, details FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = $1 ORDER BY id DESC LIMIT 1`, [SH_ACTOR])).rows[0];
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use('/api/orders', ordersRouterForTest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/orders/shopify`;
  const ADMIN = { isAdmin: true, caps: ['logistics.view', 'logistics.edit'] };
  const cancel = async (runId) => { const r = await fetch(`${base}/sync/cancel`, { method: 'POST', headers: { 'x-test-session': JSON.stringify(ADMIN), 'Content-Type': 'application/json' }, body: JSON.stringify(runId === undefined ? {} : { runId }) }); return { status: r.status, body: await r.json() }; };
  const statusApi = async () => (await (await fetch(`${base}/sync-updates`, { headers: { 'x-test-session': JSON.stringify(ADMIN) } })).json());
  // A 'running' row as another (or a dead) process leaves it: a full-history run with a cursor, its last heartbeat `beatAgoMs` ago.
  const fakeRunning = async (beatAgoMs, { startedAgoMs = beatAgoMs + 60000, actor = SH_ACTOR } = {}) => {
    const { rows: [r] } = await db.query(
      `INSERT INTO order_imports (channel, kind, status, started_at, imported_by, filename, rows_processed, orders_in_file, orders_created, orders_updated, orders_unchanged,
         items_created, items_updated, promotion_rows, duplicate_rows, error_rows, details)
       VALUES ('website', 'shopify_sync', 'running', now() - ($1 || ' milliseconds')::interval, $2, 'Shopify full history', 930, 930, 0, 0, 0, 0, 0, 0, 0, 0,
         jsonb_build_object('window', jsonb_build_object('mode', 'all'), 'cursor', 'dbcheck-cursor', 'heartbeat_at', now() - ($3 || ' milliseconds')::interval)) RETURNING id`,
      [String(startedAgoMs), actor, String(beatAgoMs)]);
    return Number(r.id);
  };
  const realFetch = globalThis.fetch;
  const savedToken = process.env.SHOPIFY_ACCESS_TOKEN; const savedDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const made = [];
  try {
    await setCk(iso(3600000));
    const ck0 = await ckNow();

    // 1. The production symptom: a run cut off mid-way (heartbeat 25 min ago, nothing advancing it) is "interrupted",
    //    not "running": the page offers Shopify again, it never blocks a new sync, and Stop marks it interrupted.
    const dead = await fakeRunning(25 * 60000); made.push(dead);
    let st = await statusApi();
    if (st.state !== 'interrupted' || st.runId !== dead || st.fetched !== 930 || !st.lastProgressAt) bad.push(`dead run status ${JSON.stringify(st).slice(0, 220)}`);
    await SO.assertNoSyncRunning(db);                                           // never blocks
    const wrong = await cancel(dead - 1);
    if (wrong.status !== 409 || (await row(dead)).status !== 'running') bad.push(`stop for another run id → ${wrong.status}`);
    const c1 = await cancel(dead);
    const after1 = await row(dead);
    if (c1.status !== 202 || !c1.body.interrupted || after1.status !== 'failed' || !after1.details.interrupted || !('interrupted_by' in after1.details)
      || !after1.details.last_progress_at || !/Interrupted: no progress since/.test(after1.details.failure || '') || after1.details.cursor !== 'dbcheck-cursor') bad.push(`stop on a dead run ${c1.status} ${JSON.stringify(after1.details).slice(0, 240)}`);
    const c2 = await cancel(dead);
    if (c2.status !== 409) bad.push(`repeated stop → ${c2.status}`);
    st = await statusApi();
    if (st.state !== 'interrupted' || !/Interrupted/.test(st.failure || '')) bad.push(`after marking: ${st.state}`);
    if ((await ckNow()) !== ck0) bad.push('checkpoint moved by an interrupted run');

    // 2. A run alive in another process (heartbeat 20 s ago): running, blocks a second sync, and Stop is recorded on its row
    //    (that process sees it at its next heartbeat) — never marked interrupted.
    const alive = await fakeRunning(20000, { startedAgoMs: 45 * 60000 }); made.push(alive);
    st = await statusApi();
    if (st.state !== 'running' || st.runId !== alive) bad.push(`live run status ${st.state}`);
    await expectErr('second sync while another process runs', () => SO.assertNoSyncRunning(db), (e) => e.status === 409);
    if ((await R.createSyncRunner({ kind: 'shopify_sync', label: 't', staleMs: SO.SYNC_STALE_MS }).markInterrupted(db, { actor: SH_ACTOR })).includes(alive)) bad.push('live run marked interrupted');
    const c3 = await cancel(alive);
    const a3 = await row(alive);
    if (c3.status !== 202 || !c3.body.stopping || a3.status !== 'running' || !a3.details.cancel_requested) bad.push(`stop for a run in another process ${c3.status} ${JSON.stringify(a3.details).slice(0, 200)}`);
    if (!(await statusApi()).stopping) bad.push('status does not show the stop request');
    const hb = await R.heartbeat(db, alive, { phase: 'fetching' });
    if (!hb.cancel || hb.lost) bad.push(`heartbeat does not carry the stop ${JSON.stringify(hb)}`);
    // Starting a sync marks a dead run interrupted (with who started it) but leaves a live one.
    await db.query(`UPDATE order_imports SET details = details || jsonb_build_object('heartbeat_at', now() - interval '11 minutes') WHERE id = $1`, [alive]);
    const hb2 = await R.heartbeat(db, alive, {});                                 // it beats again: alive
    if (hb2.lost) bad.push('a live run reported lost');
    await db.query(`UPDATE order_imports SET status = 'failed', completed_at = now() WHERE id = $1`, [alive]);
    const lost = await R.heartbeat(db, alive, {});
    if (!lost.lost) bad.push('a closed run not reported lost to its process');

    // 3. A real chain: heartbeat, phase and live counts while it runs; a stop asked through the row (as another process
    //    would) ends it after the page in progress; the checkpoint stays; the next click continues with no duplicate.
    const store = Array.from({ length: 25 }, (_, i) => ({ ...shOrder(4101 + i, { created: iso(3000000 - i * 1000) }), updatedAt: iso(3000000 - i * 1000) }));
    const fake = shFake(() => store);
    let seen = null; let pagesSeen = 0;
    const viaRow = async (q, v) => {
      if (/^query BriyoOrdersPage/.test(q)) {
        pagesSeen += 1;
        if (pagesSeen === 2) {
          const r = await lastRun();
          seen = { st: await statusApi(), row: r };
          await R.requestCancel(db, r.id, { actor: 'Other Process Admin' });
        }
      }
      return fake(q, v);
    };
    const r1 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: viaRow, backoffMs: 1 });
    const res1 = await r1.done;
    const run1 = await lastRun();
    if (!seen || seen.st.state !== 'running' || !seen.st.lastProgressAt || !seen.st.phase || seen.st.pages !== 1 || seen.row.orders_created !== 10 || !seen.row.details.heartbeat_at) bad.push(`progress while running ${JSON.stringify(seen && { st: seen.st, created: seen.row.orders_created }).slice(0, 260)}`);
    if (!res1.summary.stopped || run1.status !== 'partial' || run1.rows_processed !== 20 || run1.details.stopped_by !== 'Other Process Admin' || (await ckNow()) !== ck0) bad.push(`stop through the row: ${run1.status} ${run1.rows_processed} ${run1.details.stopped_by}`);
    if (SO.syncBusy()) bad.push('busy after a stop');
    const r2 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: fake, backoffMs: 1 });
    await r2.done;
    const c25 = await count(4101, 4125);
    if (c25.all !== 25 || c25.dup || (await lastRun()).status !== 'completed') bad.push(`continue after stop: ${JSON.stringify(c25)}`);
    await setCk(ck0);

    // 4. Pagination that does not move: a cursor Shopify already gave, or "more" with no cursor, fails the run — no loop,
    //    no completion, checkpoint unchanged, the pages already saved stay saved once.
    for (const [label, pageInfo] of [['repeated cursor', (pi) => ({ hasNextPage: true, endCursor: 'SAME' })], ['no cursor', () => ({ hasNextPage: true, endCursor: null })]]) {
      let calls = 0;
      const looping = async (q, v) => {
        const out = await fake(q, v);
        if (/^query BriyoOrdersPage/.test(q)) { calls += 1; out.orders.pageInfo = pageInfo(out.orders.pageInfo); }
        return out;
      };
      const r = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: looping, backoffMs: 1 });
      const err = await r.done.then(() => null, (e) => e);
      const run = await lastRun();
      if (!err || run.status !== 'failed' || calls > 2 || (await ckNow()) !== ck0 || !/cursor/.test(run.details.failure || '')) bad.push(`${label}: ${run.status} after ${calls} pages ${String(err?.message).slice(0, 80)}`);
      if (SO.syncBusy()) bad.push(`${label}: still busy`);
    }
    // An empty last page (no orders, no next page) simply ends the run.
    const emptyStore = [];
    const r3 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: shFake(() => emptyStore), backoffMs: 1 });
    await r3.done;
    if ((await lastRun()).status !== 'completed') bad.push('empty page did not complete');
    await setCk(ck0);

    // 5. A page whose write fails: that page rolls back, the run fails with the reason, the cursor stays at the last
    //    saved page, the checkpoint stays; the next sync writes every order once.
    const more = Array.from({ length: 15 }, (_, i) => ({ ...shOrder(4201 + i, { created: iso(2000000 - i * 1000) }), updatedAt: iso(2000000 - i * 1000) }));
    const fake2 = shFake(() => more);
    await db.query(`CREATE OR REPLACE FUNCTION dbcheck_fail_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.source_order_id = '${gidOf(4213)}' THEN RAISE EXCEPTION 'dbcheck: simulated write failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER dbcheck_fail_order BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION dbcheck_fail_order()`);
    try {
      const r4 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: fake2, backoffMs: 1 });
      const e4 = await r4.done.then(() => null, (e) => e);
      const run4 = await lastRun();
      const c = await count(4201, 4215);
      if (!e4 || run4.status !== 'failed' || !/simulated write failure/.test(run4.details.failure || '') || c.all !== 10 || run4.orders_created !== 10 || !run4.details.cursor || (await ckNow()) !== ck0) bad.push(`page write failure: ${run4.status} saved ${c.all} created ${run4.orders_created} ck ${(await ckNow()) === ck0}`);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS dbcheck_fail_order ON orders');
      await db.query('DROP FUNCTION IF EXISTS dbcheck_fail_order()');
    }
    const r5 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: fake2, backoffMs: 1 });
    await r5.done;
    const c15 = await count(4201, 4215);
    if (c15.all !== 15 || c15.dup || (await ckNow()) === ck0) bad.push(`after a failed page: ${JSON.stringify(c15)}`);
    await setCk(ck0);

    // 6. Retry exhaustion: a gateway error on every attempt fails the run clearly (3 tries), never loops, lock released.
    let tries = 0;
    const down = async (q, v) => { if (/^query BriyoOrdersPage/.test(q)) { tries += 1; throw Object.assign(new Error('Shopify HTTP 503: upstream'), { transient: true }); } return fake(q, v); };
    const r6 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: down, backoffMs: 1 });
    await r6.done.catch(() => {});
    const run6 = await lastRun();
    if (tries !== 3 || run6.status !== 'failed' || !/503/.test(run6.details.failure || '') || SO.syncBusy() || (await ckNow()) !== ck0) bad.push(`retry exhaustion: ${tries} tries, ${run6.status}`);
    // Rate-limit waits are shown as waiting (with until when) and counted as retries.
    let thr = 0; let waitingSeen = null;
    const slow = async (q, v) => {
      if (/^query BriyoOrdersPage/.test(q) && thr < 2) { thr += 1; throw Object.assign(new Error('Shopify rate limit hit (HTTP 429).'), { throttled: true }); }
      if (/^query BriyoOrdersPage/.test(q) && !waitingSeen) { const r = await lastRun(); waitingSeen = r.details.progress; }
      return fake(q, v);
    };
    const r7 = await SO.startIncrementalSync({ actor: SH_ACTOR, gql: slow, backoffMs: 1 });
    await r7.done;
    if (!waitingSeen || !(waitingSeen.retries >= 2) || (await lastRun()).status !== 'completed') bad.push(`rate-limit wait not visible ${JSON.stringify(waitingSeen)}`);
    await setCk(ck0);

    // 7. Every Shopify request carries a timeout; a timed-out request is a transient failure with a plain message.
    process.env.SHOPIFY_ACCESS_TOKEN = 'dbcheck-not-a-real-token'; process.env.SHOPIFY_STORE_DOMAIN = 'dbcheck.invalid';
    let signal = null;
    globalThis.fetch = async (_u, opts) => { signal = opts?.signal; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    const te = await SH.graphql('query { shop { name } }').then(() => null, (e) => e);
    globalThis.fetch = realFetch;
    if (!(signal instanceof AbortSignal) || !te?.transient || !/did not answer within 60 s/.test(te.message) || SH.SHOPIFY_REQUEST_TIMEOUT_MS !== 60000) bad.push(`request timeout: ${String(te?.message).slice(0, 100)} transient=${te?.transient}`);
    if (SO.SYNC_STALE_MS < 5 * SH.SHOPIFY_REQUEST_TIMEOUT_MS) bad.push('stale window not well above the request timeout');
  } finally {
    globalThis.fetch = realFetch;
    if (savedToken === undefined) delete process.env.SHOPIFY_ACCESS_TOKEN; else process.env.SHOPIFY_ACCESS_TOKEN = savedToken;
    if (savedDomain === undefined) delete process.env.SHOPIFY_STORE_DOMAIN; else process.env.SHOPIFY_STORE_DOMAIN = savedDomain;
    server.close();
    if (savedCk === null) await db.query('DELETE FROM system_state WHERE key = $1', [CK]); else await setCk(savedCk);
    if (made.length) await db.query('DELETE FROM order_imports WHERE id = ANY($1)', [made]);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'cut-off run (heartbeat 25 min ago) → "interrupted" with its 930 fetched, never blocks; Stop with another run id → 409, with its id → marked failed+interrupted (who, last progress, cursor kept), again → 409, checkpoint unchanged; live run elsewhere (beat 20 s ago) → running, blocks, never marked, Stop recorded on its row and read by its heartbeat, closed row → lost; real chain shows phase, last progress, pages and live created count; stop via the row ends it after the page (partial, stopped_by), next click 25/25 once; repeated cursor / "more" with no cursor → failed in ≤2 pages, no loop, checkpoint kept; empty page completes; failed page write → that page rolled back, 10 saved, cursor kept, checkpoint kept, next sync 15/15 once; 503 ×3 → failed, unlocked; rate-limit waits visible as retries; every request has a 60 s timeout → transient "did not answer"';
});

await step('orders page: Shopify status is factual — interrupted banner and idle button for a cut-off run, last progress / phase / pages while running, Stop sends the run id and waits for the server, one polling loop, status errors never fake an end', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/orders.js', import.meta.url), 'utf8');
  const stop = js.slice(js.indexOf('async function stopShopifySync'), js.indexOf('const onShopifyClick'));
  const follow = js.slice(js.indexOf('let shopifyFollowing'), js.indexOf('/* ------------------------------------------------------------------ Amazon button'));
  if (!/body: JSON\.stringify\(\{ runId: Number\(b\.dataset\.runId\) \|\| null \}\)/.test(stop)) bad.push('stop does not send the run id');
  if (!/followShopifySync\(\);\s*\}$/.test(stop.trim())) bad.push('stop does not ask the server how it ended');
  if (/shopifyBusy\(false\)/.test(stop)) bad.push('stop resets the button on its own');
  if (!/s\.state === 'interrupted'/.test(follow) || !/Shopify sync interrupted/.test(follow) || !/Click Shopify to continue\./.test(follow)) bad.push('no interrupted state');
  if (!/shopifyBusy\(false\);\s*if \(s\.state === 'interrupted'\)/.test(follow)) bad.push('interrupted run keeps the Stop button');
  if (!/last progress/.test(follow) || !/rate limit/.test(follow) || !/saving a page/.test(follow) || !/page\$\{s\.pages === 1/.test(follow)) bad.push('running facts');
  if (!/clearTimeout\(shopifyTimer\)/.test(follow) || !/if \(shopifyFollowing\) return;/.test(follow)) bad.push('more than one polling loop possible');
  const errBranch = follow.slice(follow.indexOf('} catch (err) {'), follow.indexOf('shopifyFollowing = false;\n  if (s.runId)'));
  if (/shopifyBusy\(false\)/.test(errBranch) || !/Checking again/.test(errBranch)) bad.push('a failed status request ends the sync in the page');
  if (/%|percent|progress-bar/i.test(follow)) bad.push('invented percentage');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'interrupted → idle Shopify button + "Shopify sync interrupted — no progress since <IST> after N fetched … Click Shopify to continue."; running → fetched · pages saved · fetching / saving a page / waiting for Shopify’s rate limit · last progress Ns ago (no percentages); Stop sends {runId}, keeps "Stopping…" and asks the server; one polling loop; a failed status request says so and retries instead of ending the sync';
});

await step('orders page: Shopify button turns into a red "Stop Shopify Sync" while syncing — one cancel request, Stopping…, stopped summary, resumes on the next click, mobile wrap', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/orders.js', import.meta.url), 'utf8');
  const css = await fsp.readFile(new URL('../public/orders.css', import.meta.url), 'utf8');
  const ui = await fsp.readFile(new URL('../public/ui.css', import.meta.url), 'utf8');
  const busy = js.slice(js.indexOf('const shopifyBusy'), js.indexOf('const duration'));
  if (!/classList\.toggle\('danger', stop\)/.test(busy) || !/'Stop Shopify Sync'/.test(busy) || !/'Stopping…'/.test(busy) || !/: 'Shopify'/.test(busy)) bad.push('button states');
  if (!/\.btn\.danger \{[^}]*var\(--error\)/.test(ui)) bad.push('no red danger style');
  const stop = js.slice(js.indexOf('async function stopShopifySync'), js.indexOf('const onShopifyClick'));
  if ((stop.match(/api\('\/api\/orders\/shopify\/sync\/cancel'/g) || []).length !== 1 || !/if \(b\.dataset\.mode !== 'running' \|\| b\.disabled\) return;\s*shopifyBusy\(true, 'stopping'\)/.test(stop)) bad.push('not exactly one guarded cancel request');
  if (!/const onShopifyClick = \(\) => \(\$\('#shopifyOrders'\)\.dataset\.mode === 'running' \? stopShopifySync\(\) : startShopifySync\(\)\)/.test(js) || !/\$\('#shopifyOrders'\)\.addEventListener\('click', onShopifyClick\)/.test(js)) bad.push('click not routed');
  const follow = js.slice(js.indexOf('async function followShopifySync'), js.indexOf('/* ------------------------------------------------------------------ Amazon button'));
  if (!/s\.stopping/.test(follow) || !/Shopify sync stopped/.test(follow) || !/Click Shopify to continue\./.test(follow) || !/fetched<\/span><span>\$\{count\(s\.created\)\} new<\/span><span>\$\{count\(s\.updated\)\} updated/.test(follow)) bad.push('stopped/stopping banner');
  if (!/setTimeout\(followShopifySync, 2500\)/.test(follow)) bad.push('polling');
  if (!/\.stop-facts \{[^}]*flex-wrap: wrap/.test(css) || !/\.page-actions \{ flex-wrap: wrap; \}/.test(css)) bad.push('mobile wrap');
  if (/amazon/i.test(stop + busy)) bad.push('touches Amazon');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'idle "Shopify"; running → red .btn.danger "Stop Shopify Sync" (logo hidden); one click → exactly one POST /shopify/sync/cancel, then disabled "Stopping…"; polling shows "Stopping…" then "Shopify sync stopped · N fetched · N new · N updated · Click Shopify to continue."; next click starts normally; wraps on mobile; Amazon button untouched';
});

await step('amazon sp-api cleanup', async () => {
  await purgeTestOrders(`${TEST_ORDER}-AZSP`);
  await getPool().query(`DELETE FROM order_imports WHERE kind = 'amazon_sync' AND imported_by = $1`, [AZ_ACTOR]);
  return 'test orders and sync runs removed (test SKU goes with inventory cleanup)';
});

await step('shopify orders cleanup', async () => {
  await purgeTestOrders(SH_PREFIX);
  await getPool().query(`DELETE FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = $1`, [SH_ACTOR]);
  const dup = `SHDUP${SH_NUM.slice(-4)}`;
  const { rows } = await getPool().query(`SELECT id FROM orders WHERE channel = 'website' AND source_order_id = $1`, [dup]);
  if (rows.length) await purgeTestOrders(dup);
  return 'test orders, items, shipments, stock and sync runs removed';
});

await step('inventory prices: Cost Price (CP = the existing unit cost), Selling Price (SP) and MRP per batch — saved, read back, edited one at a time, blanks stay blank, validated; value from CP only; stock untouched by price edits', async () => {
  const bad = [];
  const db = getPool();
  const sku = (await createSku({ sku: `${TS}-PRICES`, product_name: 'Price test' }, { actor: ACTOR })).id;
  const batchOf = async (id) => (await skuDetail(sku)).batches.find((b) => b.id === id);
  const ledger = async () => (await db.query('SELECT count(*)::int n, coalesce(sum(quantity),0)::int q FROM inventory_movements WHERE sku_id = $1', [sku])).rows[0];
  // Schema: two new nullable columns beside unit_cost; nothing renamed or dropped.
  const cols = (await db.query(`SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'inventory_batches' AND column_name IN ('unit_cost','selling_price','mrp') ORDER BY column_name`)).rows;
  if (cols.map((c) => `${c.column_name}:${c.is_nullable}:${c.data_type}`).join() !== 'mrp:YES:numeric,selling_price:YES:numeric,unit_cost:YES:numeric') bad.push(`columns ${JSON.stringify(cols)}`);
  // B. All three saved and read back (decimals; ₹ and commas as typed are fine).
  const r1 = await receiveInventory({ sku_id: sku, batch_number: 'PR-1', quantity: 10, unit_cost: '180.50', selling_price: '₹249', mrp: '1,299.00' }, { actor: ACTOR });
  let b = await batchOf(r1.batchId);
  if (b.unit_cost !== 180.5 || b.selling_price !== 249 || b.mrp !== 1299 || b.on_hand !== 10) bad.push(`saved ${JSON.stringify([b.unit_cost, b.selling_price, b.mrp, b.on_hand])}`);
  // Value comes from CP only.
  if (b.value !== 1805 || (await getSku(sku)).value !== 1805) bad.push(`value ${b.value}`);
  // Blank SP and MRP stay blank (null), never derived from CP; zero is a valid price.
  const r2 = await receiveInventory({ sku_id: sku, batch_number: 'PR-2', quantity: 4, unit_cost: '0', selling_price: '', mrp: null }, { actor: ACTOR });
  b = await batchOf(r2.batchId);
  if (b.unit_cost !== 0 || b.selling_price !== null || b.mrp !== null) bad.push(`blanks ${JSON.stringify([b.unit_cost, b.selling_price, b.mrp])}`);
  const r3 = await receiveInventory({ sku_id: sku, batch_number: 'PR-3', quantity: 2 }, { actor: ACTOR });   // an old client sending no prices
  b = await batchOf(r3.batchId);
  if (b.unit_cost !== null || b.selling_price !== null || b.mrp !== null) bad.push('a receipt without prices got some');
  // A second delivery of the same batch keeps its CP, and only fills SP/MRP where still blank.
  await receiveInventory({ sku_id: sku, batch_number: 'PR-1', quantity: 5, unit_cost: '999', selling_price: '1', mrp: '1' }, { actor: ACTOR });
  await receiveInventory({ sku_id: sku, batch_number: 'PR-2', quantity: 1, selling_price: '199', mrp: '249' }, { actor: ACTOR });
  b = await batchOf(r1.batchId);
  const b2 = await batchOf(r2.batchId);
  if (b.unit_cost !== 180.5 || b.selling_price !== 249 || b.mrp !== 1299 || b.on_hand !== 15) bad.push(`redelivery changed prices ${JSON.stringify([b.unit_cost, b.selling_price, b.mrp])}`);
  if (b2.selling_price !== 199 || b2.mrp !== 249 || b2.unit_cost !== 0) bad.push('blank SP/MRP not filled by a later delivery');
  // Update one price without touching the other two — or the stock.
  const l0 = await ledger();
  const onHand0 = (await getSku(sku)).on_hand;
  let v = (await batchOf(r1.batchId)).version;
  await updateBatch(r1.batchId, { selling_price: '259.99' }, { actor: ACTOR, version: v });
  b = await batchOf(r1.batchId);
  if (b.selling_price !== 259.99 || b.unit_cost !== 180.5 || b.mrp !== 1299) bad.push(`SP edit ${JSON.stringify([b.unit_cost, b.selling_price, b.mrp])}`);
  await updateBatch(r1.batchId, { mrp: '' }, { actor: ACTOR, version: b.version });     // cleared: blank, not zero
  b = await batchOf(r1.batchId);
  if (b.mrp !== null || b.selling_price !== 259.99 || b.unit_cost !== 180.5) bad.push('MRP clear touched others');
  await updateBatch(r1.batchId, { unit_cost: '175' }, { actor: ACTOR, version: b.version });
  b = await batchOf(r1.batchId);
  if (b.unit_cost !== 175 || b.selling_price !== 259.99 || b.value !== 175 * 15) bad.push(`CP edit / value ${b.unit_cost} ${b.value}`);
  // SP and MRP never reach stock value; a price-only edit moves no stock.
  await updateBatch(r1.batchId, { selling_price: '100000', mrp: '200000' }, { actor: ACTOR, version: b.version });
  const s1 = await getSku(sku);
  if (s1.value !== 175 * 15 + 0 * 5 || (await batchOf(r1.batchId)).value !== 175 * 15) bad.push(`value used SP/MRP: ${s1.value}`);
  const l1 = await ledger();
  if (l1.n !== l0.n || l1.q !== l0.q || s1.on_hand !== onHand0) bad.push('a price edit moved stock');
  const aud = (await db.query(`SELECT metadata FROM inventory_audit WHERE batch_id = $1 AND action = 'batch_updated' ORDER BY id`, [r1.batchId])).rows.map((r) => Object.keys(r.metadata.changes).sort().join('+'));
  if (aud.join() !== 'selling_price,mrp,unit_cost,mrp+selling_price') bad.push(`audit ${aud}`);
  // C. Validation: negative, NaN, Infinity, exponents, 3 decimals, text, too large — refused; nothing written.
  for (const [field, value] of [['unit_cost', '-1'], ['selling_price', 'NaN'], ['mrp', 'Infinity'], ['selling_price', '1e3'], ['mrp', '12.345'], ['unit_cost', 'abc'],
    ['mrp', -5], ['selling_price', Number.NaN], ['unit_cost', Number.POSITIVE_INFINITY], ['mrp', '12345678901'], ['selling_price', { x: 1 }]]) {
    await expectErr(`receive ${field}=${String(value)}`, () => receiveInventory({ sku_id: sku, batch_number: 'PR-BAD', quantity: 1, [field]: value }, { actor: ACTOR }), (e) => e.status === 400);
    const cur = await batchOf(r1.batchId);
    await expectErr(`edit ${field}=${String(value)}`, () => updateBatch(r1.batchId, { [field]: value }, { actor: ACTOR, version: cur.version }), (e) => e.status === 400);
  }
  if ((await db.query(`SELECT count(*)::int n FROM inventory_batches WHERE sku_id = $1 AND batch_number = 'PR-BAD'`, [sku])).rows[0].n) bad.push('a refused receipt made a batch');
  // Transfers carry all three prices to the batch in the other warehouse.
  const wh2 = (await db.query(`SELECT id FROM warehouses WHERE active AND id <> (SELECT warehouse_id FROM inventory_batches WHERE id = $1) ORDER BY id LIMIT 1`, [r1.batchId])).rows[0]?.id;
  if (wh2) {
    const t = await transferStock({ batch_id: r1.batchId, to_warehouse_id: wh2, quantity: 1 }, { actor: ACTOR });
    const moved = (await skuDetail(sku)).batches.find((x) => x.id === t.batchId);
    if (moved.unit_cost !== 175 || moved.selling_price !== 100000 || moved.mrp !== 200000) bad.push('transfer dropped prices');
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'unit_cost kept as CP; selling_price and mrp added (nullable NUMERIC(12,2) ≥ 0); saved/read with ₹ and commas; blanks and old clients → null (never derived); zero allowed; redelivery keeps CP, fills blank SP/MRP only; one price edited at a time, cleared to blank; value = on hand × CP only (SP/MRP 100000/200000 changed nothing); price edits move no stock, audited per field; negative/NaN/Infinity/1e3/3 decimals/text/too large/object refused on receipt and edit; transfer carries all three';
});

await step('inventory page: Add inventory and batch forms show CP, SP and MRP as three separate boxes (no price-type dropdown), one row on desktop, stacked on a phone; other receipt fields unchanged', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/inventory.js', import.meta.url), 'utf8');
  const css = await fsp.readFile(new URL('../public/orders.css', import.meta.url), 'utf8');
  const form = (kind) => js.slice(js.indexOf(`} else if (kind === '${kind}') {`), js.indexOf('} else if', js.indexOf(`} else if (kind === '${kind}') {`) + 10));
  for (const kind of ['receive', 'batch']) {
    const f = form(kind);
    const labels = ['Cost Price (CP) ₹', 'Selling Price (SP) ₹', 'Maximum Retail Price (MRP) ₹'];
    const helps = ['Purchase cost per unit paid by Briyo.', 'Selling price per unit charged to customers.', 'Maximum retail price printed on the product packaging.'];
    const names = ['unit_cost', 'selling_price', 'mrp'];
    if (!/<div class="price-row wide">/.test(f)) bad.push(`${kind}: no price row`);
    labels.forEach((l, i) => { if (!f.includes(`<span>${l}</span><input class="input" name="${names[i]}" inputmode="decimal"`) || !f.includes(helps[i])) bad.push(`${kind}: ${l}`); });
    if (/Unit cost/.test(f) || /<select[^>]*name="(price_type|price_kind)"/.test(f)) bad.push(`${kind}: old field or a dropdown`);
  }
  const recv = form('receive');
  for (const n of ['sku_id', 'batch_number', 'quantity', 'mfg_date', 'expiry_date', 'received_date', 'supplier_name', 'po_number', 'grn_number', 'warehouse_id', 'location', 'coa', 'notes']) if (!recv.includes(`name="${n}"`) && !new RegExp(`(intField|dateField)\\('${n}'`).test(recv)) bad.push(`receive lost ${n}`);
  if (!/\.price-row \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(css) || !/@media \(max-width: 760px\) \{ \.price-row \{ grid-template-columns: 1fr; \}/.test(css)) bad.push('layout');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'both forms: three labelled inputs (unit_cost/selling_price/mrp, decimal keypad) with their helper texts, no dropdown, no "Unit cost"; receipt keeps SKU, batch, quantity, dates, received date, supplier, PO, GRN, warehouse, location, COA, notes; 3 columns on desktop, 1 below 760 px';
});

// ---- Stock Outward + retailer lines without Briyo SKUs ------------------------------------------------
const SO = {};
const soBase = () => ({ movement_date: dayOffset(0), purpose: 'free_sample', sku_id: SO.sku, quantity: 4, requested_by: FIX_A, issued_by: FIX_B, recipient_name: 'Dbcheck Recipient' });
const soOnHand = async (batchId) => (await getPool().query('SELECT on_hand FROM inventory_batches WHERE id = $1', [batchId])).rows[0].on_hand;
const soLedger = async (id) => (await getPool().query(`SELECT movement_type, quantity, batch_id FROM inventory_movements WHERE reference_type = 'stock_outward' AND reference_id = (SELECT reference FROM stock_outwards WHERE id = $1) ORDER BY id`, [id])).rows;

await step('stock outward: drafts take no stock; issue deducts exactly once through the ledger (retries and double clicks too); insufficient or quarantined stock refused; nothing oversold under concurrency', async () => {
  const bad = [];
  const db = getPool();
  SO.sku = (await createSku({ sku: `${TS}-SO`, product_name: 'Outward test', variant_name: '30 caps' }, { actor: ACTOR })).id;
  SO.b1 = (await receiveInventory({ sku_id: SO.sku, batch_number: 'SO-1', expiry_date: dayOffset(300), quantity: 10, unit_cost: '120', selling_price: '299', mrp: '399', request_id: rid() }, { actor: ACTOR })).batchId;
  SO.b2 = (await receiveInventory({ sku_id: SO.sku, batch_number: 'SO-2', expiry_date: dayOffset(500), quantity: 5, unit_cost: '100', request_id: rid() }, { actor: ACTOR })).batchId;
  const prices0 = (await db.query('SELECT id, unit_cost, selling_price, mrp FROM inventory_batches WHERE sku_id = $1 ORDER BY id', [SO.sku])).rows;
  // 1. A draft moves nothing.
  const d1 = await createOutward(soBase(), { actor: ACTOR });
  if ((await soOnHand(SO.b1)) !== 10 || (await soLedger(d1.id)).length || (await getOutward(d1.id)).status !== 'draft') bad.push('draft moved stock');
  // Validation and people: names come from the team record, never from the request.
  for (const [k, v] of [['quantity', 0], ['quantity', 'x'], ['purpose', 'party'], ['requested_by', '919999999999'], ['issued_by', ''], ['recipient_name', ' '], ['sku_id', 99999999], ['movement_date', 'tomorrow']]) {
    await expectErr(`create ${k}=${v}`, () => createOutward({ ...soBase(), [k]: v }, { actor: ACTOR }), (e) => [400, 404].includes(e.status));
  }
  const o1 = await getOutward(d1.id);
  const names = (await db.query('SELECT phone, name FROM allowed_users WHERE phone = ANY($1)', [[FIX_A, FIX_B]])).rows;
  if (o1.requested_by_name !== names.find((n) => n.phone === FIX_A).name || o1.issued_by_name !== names.find((n) => n.phone === FIX_B).name || o1.created_by !== ACTOR) bad.push('people not from team records');
  // 3. Insufficient: allocations must add up and the batch must have it free; nothing written on refusal.
  await expectErr('wrong total', () => issueOutward(d1.id, { allocations: [{ batch_id: SO.b1, quantity: 3 }] }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('no batches', () => issueOutward(d1.id, {}, { actor: ACTOR }), (e) => e.status === 400);
  const big = await createOutward({ ...soBase(), quantity: 11 }, { actor: ACTOR });
  await expectErr('more than the batch', () => issueOutward(big.id, { allocations: [{ batch_id: SO.b1, quantity: 11 }] }, { actor: ACTOR }), (e) => e.status === 409 && e.insufficientStock);
  if ((await soOnHand(SO.b1)) !== 10 || (await getOutward(big.id)).status !== 'draft' || (await soLedger(big.id)).length) bad.push('a refused issue changed something');
  const other = (await createSku({ sku: `${TS}-SO-OTHER`, product_name: 'Other' }, { actor: ACTOR })).id;
  const ob = (await receiveInventory({ sku_id: other, batch_number: 'SO-X', quantity: 9, request_id: rid() }, { actor: ACTOR })).batchId;
  await expectErr('another product\'s batch', () => issueOutward(d1.id, { allocations: [{ batch_id: ob, quantity: 4 }] }, { actor: ACTOR }), (e) => e.status === 400);
  const qb = (await receiveInventory({ sku_id: SO.sku, batch_number: 'SO-Q', expiry_date: dayOffset(300), quantity: 9, request_id: rid() }, { actor: ACTOR })).batchId;
  await updateBatch(qb, { status: 'quarantined', reason: 'test' }, { actor: ACTOR, version: (await skuDetail(SO.sku)).batches.find((b) => b.id === qb).version });
  await expectErr('quarantined', () => issueOutward(d1.id, { allocations: [{ batch_id: qb, quantity: 4 }] }, { actor: ACTOR }), (e) => e.status === 409 && e.unsellable);
  // The issue panel's options: sellable batches only (not the quarantined one), earliest expiry suggested first.
  const opts = await outwardStockOptions(SO.sku, 12);
  if (opts.batches.map((b) => b.batch_number).join() !== 'SO-1,SO-2' || opts.available !== 15
    || JSON.stringify(opts.suggestion) !== JSON.stringify([{ batch_id: SO.b1, quantity: 10 }, { batch_id: SO.b2, quantity: 2 }]) || opts.short !== 0) bad.push(`stock options ${JSON.stringify(opts)}`);
  // 2, 5. Issue: 4 from SO-1, once; a retry and a second click change nothing.
  const r1 = await issueOutward(d1.id, { allocations: [{ batch_id: SO.b1, quantity: 4 }] }, { actor: ACTOR });
  const again = await issueOutward(d1.id, { allocations: [{ batch_id: SO.b1, quantity: 4 }] }, { actor: ACTOR });
  const [c1, c2] = await Promise.all([issueOutward(d1.id, { allocations: [{ batch_id: SO.b1, quantity: 4 }] }, { actor: ACTOR }), issueOutward(d1.id, { allocations: [{ batch_id: SO.b1, quantity: 4 }] }, { actor: ACTOR })]);
  const led = await soLedger(d1.id);
  if (!r1.issued || !again.repeated || !c1.repeated || !c2.repeated || led.length !== 1 || led[0].quantity !== -4 || led[0].movement_type !== 'outward_issued' || (await soOnHand(SO.b1)) !== 6) bad.push(`issue once: ${JSON.stringify(led)} on hand ${await soOnHand(SO.b1)}`);
  const i1 = await getOutward(d1.id);
  if (i1.status !== 'issued' || i1.cost_value !== 480 || i1.batches[0].unit_cost !== 120 || !i1.issue_actor || i1.outstanding !== 4) bad.push(`issued row ${JSON.stringify([i1.status, i1.cost_value, i1.outstanding])}`);
  // Stock fields are fixed once issued; a draft can be cancelled, an issued movement cannot.
  await expectErr('edit qty after issue', () => updateOutward(d1.id, { quantity: 9 }, { actor: ACTOR }), (e) => e.status === 409);
  await updateOutward(d1.id, { notes: 'handed over at the studio', campaign: 'Diwali shoot' }, { actor: ACTOR });
  if ((await soOnHand(SO.b1)) !== 6 || (await soLedger(d1.id)).length !== 1) bad.push('an edit moved stock');
  await expectErr('cancel issued', () => cancelOutward(d1.id, { actor: ACTOR }), (e) => e.status === 409);
  await cancelOutward(big.id, { actor: ACTOR });
  await expectErr('issue cancelled', () => issueOutward(big.id, { allocations: [{ batch_id: SO.b1, quantity: 6 }] }, { actor: ACTOR }), (e) => e.status === 409);
  // 4. Concurrency: two drafts of 5 against 6 free in SO-1 — exactly one issues; never below zero.
  const x = await createOutward({ ...soBase(), quantity: 5 }, { actor: ACTOR });
  const y = await createOutward({ ...soBase(), quantity: 5 }, { actor: ACTOR });
  const res = await Promise.allSettled([x, y].map((d) => issueOutward(d.id, { allocations: [{ batch_id: SO.b1, quantity: 5 }] }, { actor: ACTOR })));
  const okN = res.filter((r) => r.status === 'fulfilled').length;
  const failN = res.filter((r) => r.status === 'rejected' && r.reason.insufficientStock).length;
  if (okN !== 1 || failN !== 1 || (await soOnHand(SO.b1)) !== 1) bad.push(`concurrent: ${okN} issued, ${failN} refused, on hand ${await soOnHand(SO.b1)}`);
  SO.loser = res[0].status === 'rejected' ? x.id : y.id;
  if ((await getOutward(SO.loser)).status !== 'draft') bad.push('the refused draft changed');
  // Only 1 unit of SO-1 is left free now: 2 are refused.
  const z = await createOutward({ ...soBase(), quantity: 2 }, { actor: ACTOR });
  await expectErr('more than free', () => issueOutward(z.id, { allocations: [{ batch_id: SO.b1, quantity: 2 }] }, { actor: ACTOR }), (e) => e.insufficientStock);
  // 11. Prices unchanged by any of it; CP is the cost.
  const prices1 = (await db.query('SELECT id, unit_cost, selling_price, mrp FROM inventory_batches WHERE sku_id = $1 AND id = ANY($2) ORDER BY id', [SO.sku, prices0.map((p) => p.id)])).rows;
  if (JSON.stringify(prices0) !== JSON.stringify(prices1)) bad.push('batch prices changed');
  SO.d1 = d1.id;
  if (bad.length) throw new Error(bad.join(' | '));
  return 'draft: no movement; bad quantity/purpose/people/recipient/product/date refused; people named from team records, creator = signed-in actor; wrong total, no batches, 11 of 10, another product\'s batch, quarantined → refused with nothing written; issue 4 → one outward_issued −4 (on hand 10→6), cost 4 × CP ₹120 = ₹480; retry, repeat and two simultaneous clicks → no second deduction; stock fields fixed after issue (details editable, no stock moved); issued not cancellable, draft cancellable, cancelled not issuable; two drafts of 5 against 6 free → exactly one issued, other refused and still a draft, on hand 1; CP/SP/MRP unchanged';
});

await step('stock outward: returns — partial, only verified saleable units restocked to their batch, non-saleable never; quantities reconcile; cannot close with units outstanding; closes when all accounted for; history append-only', async () => {
  const bad = [];
  const db = getPool();
  const id = SO.d1;   // 4 issued from SO-1
  const before = await soOnHand(SO.b1);
  await expectErr('nothing entered', () => recordOutwardReturn(id, {}, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('not verified', () => recordOutwardReturn(id, { returned_saleable: 1 }, { actor: ACTOR }), (e) => e.status === 400 && e.confirmRequired);
  await expectErr('more than issued', () => recordOutwardReturn(id, { consumed: 5 }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('negative', () => recordOutwardReturn(id, { consumed: -1 }, { actor: ACTOR }), (e) => e.status === 400);
  // 9. Close with units outstanding: refused.
  await expectErr('close early', () => closeOutward(id, { actor: ACTOR }), (e) => e.status === 409 && e.outstanding === 4);
  // 6, 7. One saleable (verified) back, one damaged: only the saleable unit returns to stock; retry does nothing.
  const key = rid();
  const r = await recordOutwardReturn(id, { returned_saleable: 1, returned_non_saleable: 1, saleable_verified: true, request_id: key, notes: 'one seal broken' }, { actor: ACTOR });
  const again = await recordOutwardReturn(id, { returned_saleable: 1, returned_non_saleable: 1, saleable_verified: true, request_id: key }, { actor: ACTOR });
  let o = await getOutward(id);
  if (r.status !== 'partially_returned' || r.outstanding !== 2 || !again.repeated || o.returned_saleable !== 1 || o.returned_non_saleable !== 1 || o.batches[0].restocked !== 1) bad.push(`partial ${JSON.stringify([r, o.returned_saleable, o.returned_non_saleable])}`);
  if ((await soOnHand(SO.b1)) !== before + 1) bad.push(`restocked ${(await soOnHand(SO.b1)) - before}, want 1`);
  const back = (await soLedger(id)).filter((m) => m.movement_type === 'outward_returned');
  if (back.length !== 1 || back[0].quantity !== 1 || Number(back[0].batch_id) !== SO.b1) bad.push(`return ledger ${JSON.stringify(back)}`);
  // 8. Reconciliation: 4 = 1 + 1 + consumed + retained + outstanding; over-recording refused.
  await expectErr('over', () => recordOutwardReturn(id, { consumed: 2, retained: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  const r2 = await recordOutwardReturn(id, { consumed: 1, retained: 1 }, { actor: ACTOR });
  o = await getOutward(id);
  if (r2.status !== 'closed' || o.outstanding !== 0 || o.status !== 'closed' || !o.closed_at
    || o.quantity !== o.returned_saleable + o.returned_non_saleable + o.consumed + o.retained) bad.push(`close ${JSON.stringify(r2)}`);
  if ((await soOnHand(SO.b1)) !== before + 1) bad.push('consumed/retained/damaged were restocked');
  await expectErr('after close', () => recordOutwardReturn(id, { consumed: 1 }, { actor: ACTOR }), (e) => e.status === 409);
  if ((await closeOutward(id, { actor: ACTOR })).changed !== false) bad.push('close not idempotent');
  // The database itself refuses an unreconciled total or a closed row with units outstanding.
  await expectErr('db over', () => db.query('UPDATE stock_outwards SET consumed = consumed + 5 WHERE id = $1', [id]), (e) => e.code === '23514');
  // 10. History: every step, append-only; ledger rows stay.
  o = await getOutward(id);
  if (o.events.map((e) => e.event_type).join() !== 'created,issued,edited,returned,returned,closed') bad.push(`history ${o.events.map((e) => e.event_type)}`);
  await expectErr('event edit', () => db.query('UPDATE stock_outward_events SET notes = $2 WHERE outward_id = $1', [id, 'x']), (e) => /append-only/.test(e.message));
  await expectErr('event delete', () => db.query('DELETE FROM stock_outward_events WHERE outward_id = $1', [id]), (e) => /append-only/.test(e.message));
  await expectErr('ledger edit', () => db.query(`UPDATE inventory_movements SET quantity = -1 WHERE reference_type = 'stock_outward'`), (e) => /append-only/.test(e.message));
  // Multi-batch issue: saleable returns name their batch; never more back to a batch than came from it.
  await receiveInventory({ sku_id: SO.sku, batch_number: 'SO-1', quantity: 5, request_id: rid() }, { actor: ACTOR });
  const m = await createOutward({ ...soBase(), quantity: 6, purpose: 'event', recipient_org: 'Dbcheck Expo' }, { actor: ACTOR });
  await issueOutward(m.id, { allocations: [{ batch_id: SO.b1, quantity: 3 }, { batch_id: SO.b2, quantity: 3 }] }, { actor: ACTOR });
  await expectErr('no batch named', () => recordOutwardReturn(m.id, { returned_saleable: 2, saleable_verified: true }, { actor: ACTOR }), (e) => e.status === 400);
  await expectErr('too many to a batch', () => recordOutwardReturn(m.id, { returned_saleable: [{ batch_id: SO.b2, quantity: 4 }], saleable_verified: true }, { actor: ACTOR }), (e) => e.status === 409);
  await expectErr('foreign batch', () => recordOutwardReturn(m.id, { returned_saleable: [{ batch_id: SO.loser, quantity: 1 }], saleable_verified: true }, { actor: ACTOR }), (e) => e.status === 400);
  const b2before = await soOnHand(SO.b2);
  await recordOutwardReturn(m.id, { returned_saleable: [{ batch_id: SO.b2, quantity: 2 }], saleable_verified: true }, { actor: ACTOR });
  if ((await soOnHand(SO.b2)) !== b2before + 2 || (await getOutward(m.id)).cost_value !== 3 * 120 + 3 * 100) bad.push('multi-batch return/cost');
  SO.m = m.id;
  if (bad.length) throw new Error(bad.join(' | '));
  return 'empty, unverified saleable, over-issue and negative refused; close with 4 outstanding refused; 1 saleable (verified) + 1 damaged → +1 to SO-1 only (one outward_returned), retry no-op, partially returned, 2 outstanding; over-record refused; 1 consumed + 1 kept → reconciled 4 = 1+1+1+1, closed; nothing else restocked; closed refuses more; DB check refuses an over-total; history created/issued/edited/returned/returned/closed append-only, ledger append-only; multi-batch: saleable must name its batch, ≤ what came from it, from this issue only; cost = Σ batch qty × its CP';
});

await step('stock outward: reports (by purpose, product, people, recipient; outstanding; dispositions; cost at CP never SP/MRP), list search and filters, API permissions', async () => {
  const bad = [];
  const rep = await outwardReport({ from: dayOffset(-1), to: dayOffset(1) });
  const mine = (rows, key) => rows.find(key);
  const prod = mine(rep.byProduct, (x) => x.sku === `${TS}-SO`);
  // d1 4 (1 saleable, 1 non-saleable, 1 consumed, 1 kept), the concurrent winner 5, m 6 (2 saleable back) — drafts and cancelled excluded.
  if (!prod || prod.issued !== 15 || prod.returned_saleable !== 3 || prod.returned_non_saleable !== 1 || prod.consumed !== 1 || prod.retained !== 1 || prod.outstanding !== 9 || prod.movements !== 3) bad.push(`by product ${JSON.stringify(prod)}`);
  if (!mine(rep.byPurpose, (x) => x.purpose === 'event' && x.issued >= 6) || !mine(rep.byRecipient, (x) => x.recipient === 'Dbcheck Expo')) bad.push('by purpose/recipient');
  if (!rep.byRequester.length || !rep.byIssuer.length || !rep.outstanding.some((x) => x.id === SO.m && x.outstanding === 4)) bad.push('people/outstanding');
  // Cost: issued at each batch's CP when issued, less restocked at the same CP; SP 299 / MRP 399 never used.
  const { rows: [c] } = await getPool().query(`SELECT sum(ob.quantity * ob.unit_cost)::numeric iv, sum(ob.restocked * ob.unit_cost)::numeric rv FROM stock_outward_batches ob JOIN stock_outwards o ON o.id = ob.outward_id WHERE o.sku_id = $1`, [SO.sku]);
  if (Number(c.iv) !== 4 * 120 + 5 * 120 + 3 * 120 + 3 * 100 || Number(c.rv) !== 1 * 120 + 2 * 100) bad.push(`cost ${c.iv} ${c.rv}`);
  if (rep.cost.issuedValue < Number(c.iv) || rep.cost.netValue !== Math.round((rep.cost.issuedValue - rep.cost.restockedValue) * 100) / 100) bad.push('report cost');
  // List: search by product, recipient org, reference; filters by purpose, status, employee, product.
  const ref = (await getOutward(SO.m)).reference;
  for (const [f, want] of [[{ q: `${TS}-SO` }, (l) => l.length >= 4], [{ q: 'Dbcheck Expo' }, (l) => l.length === 1 && l[0].id === SO.m], [{ q: ref }, (l) => l.length === 1],
    [{ purpose: 'event', sku_id: SO.sku }, (l) => l.every((x) => x.purpose === 'event')], [{ status: 'closed', sku_id: SO.sku }, (l) => l.length === 1 && l[0].id === SO.d1],
    [{ status: 'outstanding', sku_id: SO.sku }, (l) => l.every((x) => ['issued', 'partially_returned'].includes(x.status))], [{ employee: FIX_B, sku_id: SO.sku }, (l) => l.length >= 4],
    [{ from: dayOffset(2) }, (l) => !l.some((x) => x.sku_id === SO.sku)]]) {
    if (!want(await listOutwards(f))) bad.push(`list ${JSON.stringify(f)}`);
  }
  // 17. API: viewers read; only inventory.move changes anything; logistics-only cannot read.
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use(express.json());
  app.use('/api/inventory', inventoryRouterForTest);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/inventory/outward`;
  const call = (method, path, caps, body) => fetch(`${base}${path}`, { method, headers: { 'x-test-session': JSON.stringify({ caps }), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
  try {
    const draft = await createOutward({ ...soBase(), quantity: 1 }, { actor: ACTOR });
    const before = await soOnHand(SO.b1);
    if (await call('GET', '', ['inventory.view']) !== 200 || await call('GET', `/${SO.m}`, ['inventory.view']) !== 200 || await call('GET', '/report', ['inventory.view']) !== 200) bad.push('viewer cannot read');
    if (await call('GET', '', ['logistics.view']) !== 403) bad.push('logistics-only can read outward');
    for (const [m, p, b] of [['POST', '', soBase()], ['PATCH', `/${draft.id}`, { notes: 'x' }], ['POST', `/${draft.id}/issue`, { allocations: [{ batch_id: SO.b1, quantity: 1 }] }],
      ['POST', `/${SO.m}/return`, { consumed: 1 }], ['POST', `/${SO.m}/close`, {}], ['POST', `/${draft.id}/cancel`, {}]]) {
      const st = await call(m, p, ['inventory.view'], b);
      if (st !== 403) bad.push(`viewer ${m} ${p} → ${st}`);
    }
    if ((await soOnHand(SO.b1)) !== before || (await getOutward(draft.id)).status !== 'draft' || (await getOutward(SO.m)).consumed !== 0) bad.push('a refused request changed something');
    if (await call('POST', `/${draft.id}/issue`, ['inventory.view', 'inventory.move'], { allocations: [{ batch_id: SO.b1, quantity: 1 }] }) !== 200 || (await soOnHand(SO.b1)) !== before - 1) bad.push('operator could not issue');
  } finally { server.close(); }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'report: 15 issued / 3 back / 1 non-saleable / 1 consumed / 1 kept / 9 outstanding over 3 movements (drafts, cancelled excluded); by purpose, recipient, requester, issuer, outstanding list; cost = Σ qty × batch CP at issue (₹1,740) less restocked (₹320), SP/MRP unused; search by product/organisation/reference, filters by purpose/status/outstanding/employee/date; API: viewer reads, every change 403 for a viewer and changes nothing, logistics-only cannot read, operator issues';
});

await step('stock outward: "Other" requester — typed name required, trimmed, never the word "Other", kept apart from team members; team members unchanged; switching clears the typed name; issue/ledger/report/search work', async () => {
  const bad = [];
  const db = getPool();
  const fixA = (await db.query('SELECT name FROM allowed_users WHERE phone = $1', [FIX_A])).rows[0].name;
  const before = JSON.stringify((await db.query('SELECT id, requested_by_phone, requested_by_name FROM stock_outwards WHERE sku_id = $1 ORDER BY id', [SO.sku])).rows);
  // A team member: exactly as before (phone + name from the record).
  const m = await createOutward({ ...soBase(), quantity: 1 }, { actor: ACTOR });
  let o = await getOutward(m.id);
  if (o.requested_by_phone !== FIX_A || o.requested_by_name !== fixA || o.requested_by_external) bad.push('team member requester changed');
  // "Other" with no name, whitespace, too long, control characters, or the word itself: refused (field named), nothing saved.
  const count0 = (await db.query('SELECT count(*)::int n FROM stock_outwards')).rows[0].n;
  for (const name of [undefined, '', '   ', '\t \n', 'x'.repeat(61), 'Ravi\u0007', 'Other', ' other ']) {
    await expectErr(`other name ${JSON.stringify(name)}`, () => createOutward({ ...soBase(), requested_by: 'other', requested_by_name: name }, { actor: ACTOR }),
      (e) => e.status === 400 && e.field === 'requested_by_name');
  }
  // A typed name with a team member is an invalid combination (refused, not silently dropped); a blank one is fine.
  await expectErr('member + typed name', () => createOutward({ ...soBase(), requested_by: FIX_A, requested_by_name: 'Somebody Else' }, { actor: ACTOR }), (e) => e.status === 400 && e.field === 'requested_by_name');
  await createOutward({ ...soBase(), quantity: 1, requested_by: FIX_A, requested_by_name: '  ' }, { actor: ACTOR });
  if ((await db.query('SELECT count(*)::int n FROM stock_outwards')).rows[0].n !== count0 + 1) bad.push('a refused requester was saved');
  // A valid typed name: trimmed, inner spaces collapsed; no phone; flagged as not a team member.
  const x = await createOutward({ ...soBase(), quantity: 2, requested_by: 'other', requested_by_name: '  Ravi   Kumar  ' }, { actor: ACTOR });
  o = await getOutward(x.id);
  if (o.requested_by_name !== 'Ravi Kumar' || o.requested_by_phone !== null || !o.requested_by_external || /other/i.test(o.requested_by_name)) bad.push(`typed requester ${JSON.stringify([o.requested_by_name, o.requested_by_phone])}`);
  // Editing the draft: other fields keep the typed name; Other → team member replaces it (no stale name); back to Other needs a name.
  await updateOutward(x.id, { notes: 'shoot kit', version: o.version }, { actor: ACTOR });
  o = await getOutward(x.id);
  if (o.requested_by_name !== 'Ravi Kumar' || o.requested_by_phone !== null) bad.push('a draft edit lost the typed name');
  await updateOutward(x.id, { requested_by: FIX_A, version: o.version }, { actor: ACTOR });
  o = await getOutward(x.id);
  if (o.requested_by_phone !== FIX_A || o.requested_by_name !== fixA || o.requested_by_external) bad.push(`switch to member ${JSON.stringify([o.requested_by_phone, o.requested_by_name])}`);
  await expectErr('back to Other without a name', () => updateOutward(x.id, { requested_by: 'other', version: o.version }, { actor: ACTOR }), (e) => e.status === 400);
  await updateOutward(x.id, { requested_by: 'other', requested_by_name: fixA, version: o.version }, { actor: ACTOR });   // same name as a team member, typed
  o = await getOutward(x.id);
  if (o.requested_by_phone !== null || o.requested_by_name !== fixA) bad.push('typed requester with a member\'s name');
  // Issue and return as usual: ledger, cost, audit unchanged by who requested it.
  const b1 = await soOnHand(SO.b1);
  const free = (await outwardStockOptions(SO.sku, 2)).suggestion;
  await issueOutward(x.id, { allocations: free }, { actor: ACTOR });
  if ((await soLedger(x.id)).reduce((n, mv) => n + mv.quantity, 0) !== -2 || (await getOutward(x.id)).status !== 'issued') bad.push('issue with a typed requester');
  if (!free.some((f) => f.batch_id === SO.b1) || (await soOnHand(SO.b1)) > b1) bad.push('stock not taken');
  await expectErr('requester fixed after issue', () => updateOutward(x.id, { requested_by_name: 'Changed' }, { actor: ACTOR }), (e) => e.status === 409);
  await recordOutwardReturn(x.id, { consumed: 2 }, { actor: ACTOR });
  o = await getOutward(x.id);
  if (o.status !== 'closed' || !o.events.some((e) => e.event_type === 'edited' && e.metadata.changes?.requested_by_phone)) bad.push('history');
  // Reports keep the typed requester apart from the team member of the same name; search finds typed names.
  const rep = await outwardReport({ from: dayOffset(-1), to: dayOffset(1) });
  const rows = rep.byRequester.filter((r) => r.name === fixA);
  if (rows.length !== 2 || !rows.some((r) => r.external === true && r.issued >= 2) || !rows.some((r) => r.external === false)) bad.push(`report ${JSON.stringify(rows)}`);
  const y = await createOutward({ ...soBase(), quantity: 1, requested_by: 'other', requested_by_name: 'Meera Studio Lead' }, { actor: ACTOR });
  if (!(await listOutwards({ q: 'Meera Studio' })).some((r) => r.id === y.id && r.requested_by_external)) bad.push('search by typed requester');
  // Through the API: the same rules (no frontend needed to enforce them).
  const app = express();
  app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
  app.use(express.json());
  app.use('/api/inventory', inventoryRouterForTest);
  const server = app.listen(0);
  try {
    const post = (body, caps = ['inventory.view', 'inventory.move']) => fetch(`http://127.0.0.1:${server.address().port}/api/inventory/outward`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-session': JSON.stringify({ caps }) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const r1 = await post({ ...soBase(), requested_by: 'other', requested_by_name: '   ' });
    const r2 = await post({ ...soBase(), requested_by: 'other' });
    const r3 = await post({ ...soBase(), requested_by: FIX_A, requested_by_name: 'Sneaky' });
    const r4 = await post({ ...soBase(), requested_by: 'other', requested_by_name: 'Api Person' }, ['inventory.view']);
    const r5 = await post({ ...soBase(), requested_by: 'other', requested_by_name: ' Api  Person ' });
    if (r1.status !== 400 || r1.body.field !== 'requested_by_name' || r2.status !== 400 || r3.status !== 400 || r4.status !== 403 || r5.status !== 201) bad.push(`api ${[r1.status, r2.status, r3.status, r4.status, r5.status]}`);
    if ((await getOutward(r5.body.id)).requested_by_name !== 'Api Person') bad.push('api trim');
  } finally { server.close(); }
  // The 2 units consumed above are received back into SO-1, so the next steps see the stock they expect.
  await receiveInventory({ sku_id: SO.sku, batch_number: 'SO-1', quantity: 2, request_id: rid() }, { actor: ACTOR });
  // Existing records: untouched.
  const after = JSON.stringify((await db.query('SELECT id, requested_by_phone, requested_by_name FROM stock_outwards WHERE id = ANY($1) ORDER BY id', [JSON.parse(before).map((r) => r.id)])).rows);
  if (after !== before) bad.push('existing records changed');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'team member as before; Other + none/blank/whitespace/61 chars/control char/"Other" → 400 on requested_by_name, nothing saved; member + typed name refused, member + blank fine; "  Ravi   Kumar  " → "Ravi Kumar", no phone, flagged; draft edits keep it, Other→member replaces it, back to Other needs a name; issue/ledger/return/history as usual, requester fixed after issue; report keeps a typed requester apart from a same-named member; search finds typed names; API enforces the same (400/403/201, trimmed); existing records unchanged';
});

await step('stock outward page: "Other" in Requested by reveals "Enter Requester\'s Name" right under it; switching back hides and clears it; required only with Other; inline message; shown as not a team member', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/stock-outward.js', import.meta.url), 'utf8');
  const form = js.slice(js.indexOf('function formHtml'), js.indexOf('const formValues'));
  const reqAt = form.indexOf('name="requested_by"'); const otherAt = form.indexOf('name="requested_by_name"'); const issuedAt = form.indexOf('name="issued_by"');
  if (!(reqAt > 0 && otherAt > reqAt && otherAt < issuedAt)) bad.push('the name box is not right under Requested by');
  if (!form.includes("opt('other', 'Other'") || !form.includes("Enter Requester's Name") || !form.includes('placeholder="Enter full name"') || !form.includes('maxlength="60"') || !/id="soOtherWrap"\$\{[^}]*' hidden'\}/.test(form)) bad.push('option/label/placeholder/hidden');
  const fv = js.slice(js.indexOf('const formValues'), js.indexOf('function wireRequester'));
  if (!/if \(v\.requested_by !== 'other'\) \{ delete v\.requested_by_name; return v; \}/.test(fv) || !/Enter the requester\\'s name\./.test(fv) || !/replace\(\/\\s\+\/g, ' '\)\.trim\(\)/.test(fv)) bad.push('form values / validation');
  const wire = js.slice(js.indexOf('function wireRequester'), js.indexOf('function showAvailable'));
  if (!/\$\('#soOtherWrap'\)\.hidden = !other;/.test(wire) || !/input\.required = other;/.test(wire) || !/if \(!other\) input\.value = '';/.test(wire)) bad.push('reveal/clear on switch');
  if ((js.match(/wireRequester\(\);/g) || []).length !== 2) bad.push('not wired on both the new and the draft form');
  if (!/requested_by_external \? ' <span class="muted">\(not a team member\)<\/span>'/.test(js) || !/x\.external \? ' \(not a team member\)'/.test(js)) bad.push('detail/report labels');
  if (!/err\.data\?\.field === 'requested_by_name'/.test(js)) bad.push('server message not shown inline');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'Other option after the team; name box between Requested by and Issued by, hidden until Other, required only then, cleared when switching back; trimmed, empty refused with an inline message (server message shown too); detail and report say "not a team member"';
});

await step('retailer orders without Briyo SKUs (e.g. Medkart): retailer name/code kept beside the Briyo product, code optional; an unmatched line is flagged and blocks stock until a person matches it; then deducted exactly once', async () => {
  const bad = [];
  const db = getPool();
  const cut0 = (await getInventoryCutover()).cutover_at;
  await setCut(CUT_AT);
  try {
    const ret = await createOrder({ ...R('retailers'), channel: 'retailers', source_order_id: `${TEST_ORDER}-MEDKART-1`, customer_name: 'Medkart', order_value: 1500 }, { actor: ACTOR });
    // 12. A matched line with the retailer's name and no code; a price as the line amount.
    const a = await addManualOrderLine(ret, { sku_id: SO.sku, quantity: 2, item_price: '598', retailer_product_name: 'BRIYO OUTWARD TST 30S', retailer_product_code: '' }, { actor: ACTOR });
    // 13, 14. An unmatched line: kept by the retailer's name/code, no SKU, flagged.
    const u = await addManualOrderLine(ret, { unmatched: true, quantity: 3, item_price: '900', retailer_product_name: 'Briyo Magnesium 60', retailer_product_code: 'MK-4471' }, { actor: ACTOR });
    await expectErr('unmatched without a name', () => addManualOrderLine(ret, { unmatched: true, quantity: 1 }, { actor: ACTOR }), (e) => e.status === 400);
    await expectErr('bad amount', () => addManualOrderLine(ret, { unmatched: true, quantity: 1, retailer_product_name: 'x', item_price: '-5' }, { actor: ACTOR }), (e) => e.status === 400);
    let items = await orderItems(ret);
    const la = items.find((i) => i.id === a.itemId); const lu = items.find((i) => i.id === u.itemId);
    if (la.sku_id !== SO.sku || la.sku !== `${TS}-SO` || la.retailer_product_name !== 'BRIYO OUTWARD TST 30S' || la.retailer_product_code !== null || la.item_price !== 598 || la.needs_review) bad.push(`matched line ${JSON.stringify(la)}`);
    if (lu.sku_id !== null || lu.sku !== null || !lu.needs_review || lu.retailer_product_code !== 'MK-4471' || !u.needsReview) bad.push(`unmatched line ${JSON.stringify(lu)}`);
    if ((await db.query(`SELECT count(*)::int n FROM skus WHERE sku ILIKE '%MK-4471%' OR product_name = 'Briyo Magnesium 60'`)).rows[0].n) bad.push('a SKU was created for the retailer product');
    // The shipment cannot reserve or dispatch while a line is unmatched.
    const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
    const { shipmentId } = await createShipment({ ...R('retailers'), channel: 'retailers', source_order_id: `${TEST_ORDER}-MEDKART-1`, courier_partner_id: dl.id, tracking_id: 'AWB-MEDKART-1', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true });
    const st = await shipmentStock(shipmentId);
    if (st.state !== 'unmapped' || !st.unmapped.some((x) => x.title === 'Briyo Magnesium 60')) bad.push(`stock state ${st.state}`);
    const onHand0 = await soOnHand(SO.b1);
    const sh = (await orderShipments(ret))[0];
    await expectErr('dispatch unmatched', () => updateShipment(ret, sh.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh.version }), (e) => e.status === 409);
    if ((await soOnHand(SO.b1)) !== onHand0) bad.push('stock taken with an unmatched line');
    // A person matches it (another product), then reserves; dispatch deducts exactly once.
    const prodB = (await createSku({ sku: `${TS}-SO-MG`, product_name: 'Magnesium', variant_name: '60' }, { actor: ACTOR })).id;
    const bMg = (await receiveInventory({ sku_id: prodB, batch_number: 'MG-1', expiry_date: dayOffset(400), quantity: 10, unit_cost: '50', request_id: rid() }, { actor: ACTOR })).batchId;
    await expectErr('match to a product already on the order', () => matchManualOrderLine(ret, u.itemId, { sku_id: SO.sku }, { actor: ACTOR }), (e) => e.status === 409);
    await expectErr('match a matched line', () => matchManualOrderLine(ret, a.itemId, { sku_id: prodB }, { actor: ACTOR }), (e) => e.status === 409);
    await matchManualOrderLine(ret, u.itemId, { sku_id: prodB }, { actor: ACTOR });
    items = await orderItems(ret);
    const m = items.find((i) => i.id === u.itemId);
    if (m.sku_id !== prodB || m.needs_review || m.retailer_product_name !== 'Briyo Magnesium 60' || m.retailer_product_code !== 'MK-4471') bad.push('match did not keep the retailer fields');
    if (!(await orderEvents(ret)).some((e) => e.event_type === 'item_matched' && e.metadata.retailer_code === 'MK-4471')) bad.push('match not audited');
    await reserveShipmentStock(shipmentId, [{ batch_id: SO.b1, quantity: 2 }, { batch_id: bMg, quantity: 3 }], { actor: ACTOR });
    const sh2 = (await orderShipments(ret))[0];
    await updateShipment(ret, sh2.id, { shipment_status: 'dispatched' }, { actor: ACTOR, version: sh2.version });
    const sh3 = (await orderShipments(ret))[0];
    await updateShipment(ret, sh3.id, { shipment_status: 'in_transit' }, { actor: ACTOR, version: sh3.version });   // a later status change: no second deduction
    const moved = (await db.query(`SELECT sku_id, sum(quantity)::int q, count(*)::int n FROM inventory_movements WHERE order_id = $1 GROUP BY sku_id ORDER BY sku_id`, [ret])).rows;
    if (moved.length !== 2 || moved.find((x) => x.sku_id === SO.sku).q !== -2 || moved.find((x) => x.sku_id === prodB).q !== -3 || (await soOnHand(SO.b1)) !== onHand0 - 2 || (await soOnHand(bMg)) !== 7) bad.push(`deducted ${JSON.stringify(moved)}`);
    await expectErr('line change after dispatch', () => updateManualOrderLine(ret, u.itemId, { quantity: 9 }, { actor: ACTOR }), (e) => e.status === 409);
    // No attribution, snapshots or marketplace sync for a hand-entered retailer order.
    const fx = (await db.query(`SELECT (SELECT count(*) FROM affiliate_order_attributions WHERE order_id = $1)::int a, (SELECT count(*) FROM order_financial_snapshots WHERE order_id = $1)::int f`, [ret])).rows[0];
    if (fx.a || fx.f) bad.push('attribution/snapshot on a retailer order');
    // Line edits: amount and retailer fields separately; an unmatched line keeps its name.
    const ret2 = await createOrder({ ...R('retailers'), channel: 'retailers', source_order_id: `${TEST_ORDER}-MEDKART-2` }, { actor: ACTOR });
    const u2 = await addManualOrderLine(ret2, { unmatched: true, quantity: 1, retailer_product_name: 'Medkart item' }, { actor: ACTOR });
    await updateManualOrderLine(ret2, u2.itemId, { item_price: '120.50' }, { actor: ACTOR });
    await expectErr('clear name of unmatched', () => updateManualOrderLine(ret2, u2.itemId, { retailer_product_name: '' }, { actor: ACTOR }), (e) => e.status === 400);
    await expectErr('sku via update', () => updateManualOrderLine(ret2, u2.itemId, { sku_id: SO.sku }, { actor: ACTOR }), (e) => e.status === 400);
    const l2 = (await orderItems(ret2))[0];
    if (l2.item_price !== 120.5 || l2.quantity !== 1 || l2.retailer_product_name !== 'Medkart item' || !l2.needs_review) bad.push('line edit');
  } finally { await setCut(cut0); }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'matched line: Briyo SKU + retailer name, blank code, line amount ₹598; unmatched line: retailer name + code MK-4471, no SKU, flagged; name required, bad amount refused; no SKU created; shipment state "unmapped" and dispatch refused with no stock taken; matching refuses a product already on the order and an already-matched line, keeps the retailer fields, audited; after matching: reserve + dispatch → −2 and −3 exactly once (a later status change adds nothing); lines locked after dispatch; no attribution or snapshot; amount edit alone; unmatched keeps its name; SKU only via Match';
});

await step('retailer product matches (e.g. Medkart): saved only when a person confirms; reused by exact code, or by exact name only when there is no code; never by a similar name; ambiguous never used; retailer fields kept; unresolved lines take no stock', async () => {
  const bad = [];
  const db = getPool();
  const pf = await savePlatform({ key: `${TS}_medkart`.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: `${TS} Medkart` }, { actor: ACTOR });
  const dest = await saveDestination({ channel: 'retailers', dispatch_type: 'retailer', name: `${TS} Medkart` });
  const plain = await saveDestination({ channel: 'retailers', dispatch_type: 'retailer', name: `${TS} Plain retailer` });
  try {
    // Destinations: only a retailer one takes a product-code list, and only a known one.
    await expectErr('non-retailer destination', () => saveDestination({ id: R('blinkit').destination_id, sku_platform: pf.key }), (e) => e.status === 400);
    await expectErr('unknown list', () => saveDestination({ id: dest.id, sku_platform: 'no_such_platform' }), (e) => e.status === 400);
    const linked = await saveDestination({ id: dest.id, sku_platform: pf.key });
    if (linked.sku_platform !== pf.key || (await listDestinations()).find((d) => d.id === dest.id)?.sku_platform !== pf.key) bad.push('destination not linked');
    const zinc = (await createSku({ sku: `${TS}-MK-ZINC`, product_name: 'Zinc', variant_name: '30' }, { actor: ACTOR })).id;
    let n = 0;
    const order = async (d = dest.id) => createOrder({ channel: 'retailers', dispatch_type: 'retailer', destination_id: d, source_order_id: `${TEST_ORDER}-MKMAP-${++n}`, customer_name: 'Medkart' }, { actor: ACTOR });
    const line = async (o, id) => (await orderItems(o)).find((i) => i.id === id);
    const maps = async () => (await db.query('SELECT platform_sku, sku_id, source, created_by FROM sku_platform_mappings WHERE platform = $1 ORDER BY id', [pf.key])).rows;
    // 1. Nothing saved: a new retailer line is not matched (no guess), and matching it without "remember" saves nothing.
    const o1 = await order();
    const a = await addManualOrderLine(o1, { unmatched: true, quantity: 2, retailer_product_name: 'BRIYO D3 60S', retailer_product_code: 'MK-1' }, { actor: ACTOR });
    if (!a.needsReview || a.savedMatch) bad.push('matched without a saved match');
    await matchManualOrderLine(o1, a.itemId, { sku_id: SO.sku }, { actor: ACTOR });
    if ((await maps()).length) bad.push('a match without "remember" was saved');
    // 2. Confirmed with "remember": saved under the retailer's code, for this retailer only.
    const b = await addManualOrderLine(o1, { unmatched: true, quantity: 1, retailer_product_name: 'BRIYO ZINC 30', retailer_product_code: 'MK-2' }, { actor: ACTOR });
    const rem = await matchManualOrderLine(o1, b.itemId, { sku_id: zinc, remember: true }, { actor: ACTOR });
    let m = await maps();
    if (!rem.remembered?.added || m.length !== 1 || m[0].platform_sku !== 'MK-2' || m[0].sku_id !== zinc || m[0].source !== 'retailer_order' || m[0].created_by !== ACTOR) bad.push(`saved ${JSON.stringify(m)}`);
    // 3. Reused on the next Medkart order by the exact code (any letter case); the retailer's own name/code are kept.
    const o2 = await order();
    const c = await addManualOrderLine(o2, { unmatched: true, quantity: 4, item_price: '480', retailer_product_name: 'Zinc tabs (renamed by Medkart)', retailer_product_code: 'mk-2' }, { actor: ACTOR });
    const lc = await line(o2, c.itemId);
    if (c.needsReview || c.savedMatch !== `${TS}-MK-ZINC` || lc.sku_id !== zinc || lc.needs_review || lc.retailer_product_name !== 'Zinc tabs (renamed by Medkart)' || lc.retailer_product_code !== 'mk-2' || lc.item_price !== 480) bad.push(`reuse by code ${JSON.stringify(lc)}`);
    if (!(await orderEvents(o2)).some((e) => e.event_type === 'item_added' && e.metadata.saved_match === 'MK-2')) bad.push('reuse not audited');
    // A code is never matched through the name, and an unknown code stays unmatched.
    const d2 = await addManualOrderLine(o2, { unmatched: true, quantity: 1, retailer_product_name: 'BRIYO ZINC 30', retailer_product_code: 'MK-999' }, { actor: ACTOR });
    if (!d2.needsReview) bad.push('an unknown code matched');
    // 4. No code: a name match is saved only when confirmed, then reused only for the exact name (spaces/case aside).
    const o3 = await order();
    const e1 = await addManualOrderLine(o3, { unmatched: true, quantity: 1, retailer_product_name: 'Briyo  Magnesium 60' }, { actor: ACTOR });
    await matchManualOrderLine(o3, e1.itemId, { sku_id: SO.sku, remember: true }, { actor: ACTOR });
    m = await maps();
    if (!m.some((x) => x.platform_sku === 'name:briyo magnesium 60' && x.sku_id === SO.sku)) bad.push(`name key ${JSON.stringify(m)}`);
    const o4 = await order();
    const exact = await addManualOrderLine(o4, { unmatched: true, quantity: 1, retailer_product_name: ' BRIYO magnesium   60 ' }, { actor: ACTOR });
    const similar = await addManualOrderLine(o4, { unmatched: true, quantity: 1, retailer_product_name: 'Briyo Magnesium 60s' }, { actor: ACTOR });
    const withCode = await addManualOrderLine((await order()), { unmatched: true, quantity: 1, retailer_product_name: 'Briyo Magnesium 60', retailer_product_code: 'MK-NEW' }, { actor: ACTOR });
    if (exact.needsReview || exact.savedMatch !== `${TS}-SO` || !similar.needsReview || !withCode.needsReview) bad.push(`name reuse exact=${exact.savedMatch} similar=${similar.needsReview} withCode=${withCode.needsReview}`);
    // 5. Ambiguous (the same key deliberately mapped to two products): never used.
    await addPlatformMappings(SO.sku, pf.key, ['MK-2'], { actor: ACTOR, confirmDuplicate: true, reason: 'dbcheck: ambiguity test' });
    const amb = await addManualOrderLine((await order()), { unmatched: true, quantity: 1, retailer_product_name: 'x', retailer_product_code: 'MK-2' }, { actor: ACTOR });
    if (!amb.needsReview || !amb.ambiguous) bad.push('an ambiguous match was used');
    // 6. Remember refused when the key already means another product (never made ambiguous silently) — and the line stays unmatched.
    const o7 = await order();
    const f = await addManualOrderLine(o7, { unmatched: true, quantity: 1, retailer_product_name: 'Briyo Magnesium 60s', retailer_product_code: '' }, { actor: ACTOR });
    await matchManualOrderLine(o7, f.itemId, { sku_id: zinc, remember: true }, { actor: ACTOR });
    const g = await addManualOrderLine((await order()), { unmatched: true, quantity: 1, retailer_product_name: 'briyo magnesium 60s' }, { actor: ACTOR });
    const og = (await db.query('SELECT order_id FROM order_items WHERE id = $1', [g.itemId])).rows[0].order_id;
    // ('briyo magnesium 60s' is now saved to Zinc, so it matched; a fresh order line for the same name pointed at another product:)
    const h = await addManualOrderLine((await order()), { unmatched: true, quantity: 1, retailer_product_name: 'Unsaved product' }, { actor: ACTOR });
    const oh = (await db.query('SELECT order_id FROM order_items WHERE id = $1', [h.itemId])).rows[0].order_id;
    await getPool().query(`UPDATE order_items SET retailer_product_name = 'briyo magnesium 60s' WHERE id = $1`, [h.itemId]);
    await expectErr('remember onto a key of another product', () => matchManualOrderLine(oh, h.itemId, { sku_id: SO.sku, remember: true }, { actor: ACTOR }), (e) => e.status === 409);
    if (!(await line(oh, h.itemId)).needs_review) bad.push('a refused remember still matched the line');
    if (g.needsReview || Number(og) <= 0) bad.push('saved name not reused');
    // 7. A destination without a list: matching works, remembering is refused with a clear message.
    const o8 = await order(plain.id);
    const k = await addManualOrderLine(o8, { unmatched: true, quantity: 1, retailer_product_name: 'Anything', retailer_product_code: 'MK-2' }, { actor: ACTOR });
    if (!k.needsReview) bad.push('a destination without a list used Medkart\'s matches');
    await expectErr('remember without a list', () => matchManualOrderLine(o8, k.itemId, { sku_id: zinc, remember: true }, { actor: ACTOR }), (e) => e.status === 400 && /Destinations/.test(e.message));
    // 8. An unresolved line holds the shipment's stock; the matched-from-saved line counts like any matched line.
    const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
    const { shipmentId } = await createShipment({ channel: 'retailers', dispatch_type: 'retailer', destination_id: dest.id, source_order_id: `${TEST_ORDER}-MKMAP-2`, courier_partner_id: dl.id, tracking_id: 'AWB-MKMAP-2', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true });
    const st = await shipmentStock(shipmentId);
    if (st.state !== 'unmapped' || !st.lines.some((l) => l.sku_id === zinc && l.required === 4) || st.unmapped.length !== 1) bad.push(`stock panel ${st.state} ${JSON.stringify(st.unmapped)}`);
    // 9. Matching a line needs logistics.edit (orders API).
    const app = express();
    app.use((req, _res, next) => { req.session = JSON.parse(req.get('x-test-session') || '{}'); next(); });
    app.use('/api/orders', ordersRouterForTest);
    const server = app.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/${o2}/items/${d2.itemId}/match`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-session': JSON.stringify({ caps: ['logistics.view'] }) }, body: JSON.stringify({ sku_id: zinc, remember: true }) });
      if (r.status !== 403 || !(await line(o2, d2.itemId)).needs_review) bad.push(`viewer match → ${r.status}`);
    } finally { server.close(); }
    // 10. Isolation. A retailer cannot use a sales channel's list, nor share another destination's — checked by the server.
    for (const ch of ['amazon', 'website', 'blinkit']) await expectErr(`link to ${ch}`, () => saveDestination({ id: plain.id, sku_platform: ch }), (e) => e.status === 400);
    await expectErr('share a list', () => saveDestination({ id: plain.id, sku_platform: pf.key }), (e) => e.status === 409);
    const dApp = express();
    dApp.use((req, _r, next) => { req.session = { caps: ['logistics.view'] }; next(); });
    dApp.use('/d', destinationRouterForTest);
    const dServer = dApp.listen(0);
    let listed;
    try { listed = await (await fetch(`http://127.0.0.1:${dServer.address().port}/d`)).json(); } finally { dServer.close(); }
    if (listed.platforms.some((p) => ['amazon', 'website', 'blinkit', 'zepto', 'tata_1mg', 'netmeds'].includes(p.key)) || !listed.platforms.some((p) => p.key === pf.key)) bad.push('destination page offers channel lists');
    // Medkart's matches live only on its own list: Amazon's (and every other) mappings are untouched and unaffected.
    const others = (await db.query(`SELECT platform, count(*)::int n FROM sku_platform_mappings WHERE platform <> $1 AND (lower(platform_sku) IN ('mk-2','mk-1') OR platform_sku LIKE 'name:%') GROUP BY platform`, [pf.key])).rows;
    if (others.length || (await resolveSkuIds(db, 'amazon', ['MK-2'])).size || (await resolveSkuIds(db, 'retailers', ['MK-2'])).size) bad.push(`leaked ${JSON.stringify(others)}`);
    // Even if a channel's list were attached behind the server's back, it is never used for retailer matching.
    await db.query('UPDATE dispatch_destinations SET sku_platform = $2 WHERE id = $1', [plain.id, 'amazon']);
    const sneak = await addManualOrderLine((await order(plain.id)), { unmatched: true, quantity: 1, retailer_product_name: 'x', retailer_product_code: 'MK-2' }, { actor: ACTOR });
    await db.query('UPDATE dispatch_destinations SET sku_platform = $2 WHERE id = $1', [plain.id, pf.key]);   // and a shared list: ignored for both
    const shared = await addManualOrderLine((await order()), { unmatched: true, quantity: 1, retailer_product_name: 'x', retailer_product_code: 'MK-2' }, { actor: ACTOR });
    await db.query('UPDATE dispatch_destinations SET sku_platform = NULL WHERE id = $1', [plain.id]);
    if (!sneak.needsReview || !shared.needsReview) bad.push('a channel or shared list was used for matching');
    // Changing the destination's list never remaps existing lines (matched stay as they are; unmatched stay unmatched).
    const before = (await db.query('SELECT id, sku_id FROM order_items WHERE order_id = ANY($1) ORDER BY id', [[o1, o2, o3, o4]])).rows;
    await saveDestination({ id: dest.id, sku_platform: '' });
    await saveDestination({ id: dest.id, sku_platform: pf.key });
    await addPlatformMappings(zinc, pf.key, ['MK-999'], { actor: ACTOR });   // a new mapping for d2's code, added on the SKU page
    const after = (await db.query('SELECT id, sku_id FROM order_items WHERE order_id = ANY($1) ORDER BY id', [[o1, o2, o3, o4]])).rows;
    if (JSON.stringify(before) !== JSON.stringify(after) || !(await line(o2, d2.itemId)).needs_review) bad.push('existing lines remapped');
  } finally {
    await saveDestination({ id: dest.id, sku_platform: '' });   // unlinked, so the test platform can be removed with the test SKUs
    await saveDestination({ id: dest.id, active: false });
    await saveDestination({ id: plain.id, active: false });
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'destination ↔ product-code list (retailer only, known list); no saved match → not matched; match without "remember" saves nothing; with it → mapping MK-2 → Zinc (source retailer_order, by the signed-in user); next order: code mk-2 → Zinc, retailer name/code/total kept, audited; unknown code never falls back to the name; no code: exact name (case/spaces aside) reused, "…60s" not; a key on two products → never used; remember onto a key of another product refused, line stays unmatched; no list → no reuse, remember refused; shipment: unresolved line keeps it "unmapped", the saved-match line needs its 4 units; match needs logistics.edit';
});

await step('inventory cleanup', async () => {
  const { skus, paths } = await purgeTestInventory(TS);
  for (const p of paths) await storage().remove(p).catch(() => {});
  const left = (await getPool().query('SELECT count(*)::int n FROM skus WHERE sku LIKE $1', [`${TS}%`])).rows[0].n;
  if (left) throw new Error('SKUs left behind');
  return `${skus} test SKUs and their batches, ledger, reservations and documents removed`;
});

// ---- environment guard ------------------------------------------------------
/* ------------------------------------------------------------------ affiliates (Phase 1A) */
const AFF_ACTOR = 'db-check-affiliate';
const AFF = {};
const affPool = () => getPool();
const affInsert = (o = {}) => affPool().query(
  `INSERT INTO affiliates (public_id, category, display_name, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
  [o.public_id ?? newAffiliatePublicId(), o.category ?? 'nutritionist', o.display_name ?? 'DB Check Partner', o.status ?? 'draft', AFF_ACTOR]);

await step('affiliates: schema runs twice; categories and settings seeded once; categories enforced', async () => {
  await ensureAffiliateSchema();
  // A second, independent run of the same DDL (as a fresh process would) must be harmless.
  await affPool().query("UPDATE affiliate_categories SET label = label WHERE key = 'nutritionist'");
  const before = (await affPool().query('SELECT count(*)::int n FROM affiliate_categories')).rows[0].n;
  _resetAffiliateSchemaForTest(); await ensureAffiliateSchema(); _resetAffiliateSchemaForTest(); await ensureAffiliateSchema();
  const cats = (await affPool().query('SELECT key, label, requires_verification FROM affiliate_categories ORDER BY sort')).rows;
  const want = ['nutritionist', 'dietitian', 'doctor', 'dentist', 'other_professional', 'influencer', 'creator', 'customer'];
  if (cats.length !== before || want.some((k) => cats.filter((c) => c.key === k).length !== 1)) throw new Error(`categories ${JSON.stringify(cats.map((c) => c.key))}`);
  if (cats.find((c) => c.key === 'other_professional').label !== 'Other Professional' || !cats.find((c) => c.key === 'doctor').requires_verification
    || cats.find((c) => c.key === 'customer').requires_verification) throw new Error('labels / verification flags');
  const settings = Object.fromEntries((await affPool().query('SELECT key, value FROM affiliate_settings')).rows.map((r) => [r.key, r.value]));
  if (settings.attribution_window_days !== 30 || settings.attribution_rule_version !== 'v1') throw new Error(`settings ${JSON.stringify(settings)}`);
  // Valid and invalid categories.
  AFF.a = (await affInsert()).rows[0];
  await expectErr('unknown category', () => affInsert({ category: 'astrologer' }), (e) => e.code === '23503');
  // A category in use cannot be deleted or re-keyed (RESTRICT: 23001 restrict_violation).
  await expectErr('delete category in use', () => affPool().query("DELETE FROM affiliate_categories WHERE key = 'nutritionist'"), (e) => ['23001', '23503'].includes(e.code));
  await expectErr('rekey category in use', () => affPool().query("UPDATE affiliate_categories SET key = 'nutri' WHERE key = 'nutritionist'"), (e) => ['23001', '23503'].includes(e.code));
  return `${cats.length} categories (each once after 3 schema runs); window 30 days, rule v1; unknown category refused; category in use cannot be deleted or re-keyed`;
});

await step('affiliates: public id — opaque, unique, immutable; status values enforced', async () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newAffiliatePublicId()));
  if ([...ids].some((x) => !/^[A-HJKMNP-Z2-9]{6}$/.test(x)) || ids.size < 1995) throw new Error('id format / spread');
  if (!/^[A-HJKMNP-Z2-9]{6}$/.test(AFF.a.public_id) || String(AFF.a.public_id) === String(AFF.a.id)) throw new Error('stored id');
  await expectErr('duplicate public id', () => affInsert({ public_id: AFF.a.public_id }), (e) => e.code === '23505');
  await expectErr('malformed public id', () => affInsert({ public_id: 'ab0O1l' }), (e) => e.code === '23514');
  await expectErr('change public id', () => affPool().query('UPDATE affiliates SET public_id = $2 WHERE id = $1', [AFF.a.id, newAffiliatePublicId()]), (e) => /immutable/.test(e.message));
  // Other fields still update normally.
  await affPool().query("UPDATE affiliates SET display_name = 'DB Check Partner (renamed)', version = version + 1 WHERE id = $1", [AFF.a.id]);
  for (const s of ['draft', 'pending_verification', 'approved', 'active', 'suspended', 'closed']) {
    const r = (await affInsert({ status: s })).rows[0];
    if (r.status !== s) throw new Error(s);
  }
  await expectErr('bad status', () => affInsert({ status: 'paused' }), (e) => e.code === '23514');
  await expectErr('blank name', () => affInsert({ display_name: '  ' }), (e) => e.code === '23514');
  return '2000 ids: 6 chars, no look-alikes, no collisions to speak of; duplicate / malformed refused; public_id cannot change, other fields can; 6 statuses accepted, others refused';
});

await step('affiliates: rate history — basis points, deterministic rate on a date, append-only', async () => {
  const id = AFF.a.id;
  const add = (bps, from) => affPool().query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by, reason) VALUES ($1, $2, $3, $4, 'db-check') RETURNING id`, [id, bps, from, AFF_ACTOR]);
  await add(1500, '2026-01-01T00:00:00+05:30');
  await add(2000, '2026-03-01T00:00:00+05:30');
  for (const bad of [-1, 10001]) await expectErr(`rate ${bad}`, () => add(bad, '2026-05-01T00:00:00Z'), (e) => e.code === '23514');
  await add(0, '2026-06-01T00:00:00Z'); await add(10000, '2026-07-01T00:00:00Z');
  await expectErr('same effective_from twice', () => add(1800, '2026-03-01T00:00:00+05:30'), (e) => e.code === '23505');
  const at = async (d) => (await rateAt(affPool(), id, d))?.rate_bps ?? null;
  const got = [await at('2025-12-31T00:00:00Z'), await at('2026-02-15T00:00:00Z'), await at('2026-03-01T00:00:00+05:30'), await at('2026-04-10T00:00:00Z'), await at('2026-06-15T00:00:00Z')];
  if (JSON.stringify(got) !== JSON.stringify([null, 1500, 2000, 2000, 0])) throw new Error(`rateAt ${JSON.stringify(got)}`);
  await expectErr('update rate', () => affPool().query('UPDATE affiliate_rates SET rate_bps = 2500 WHERE affiliate_id = $1', [id]), (e) => /append-only/.test(e.message));
  await expectErr('delete rate', () => affPool().query('DELETE FROM affiliate_rates WHERE affiliate_id = $1', [id]), (e) => /append-only/.test(e.message));
  await expectErr('delete affiliate with history', () => affPool().query('DELETE FROM affiliates WHERE id = $1', [id]), (e) => ['23001', '23503'].includes(e.code));
  const cols = (await affPool().query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'affiliates'`)).rows.map((r) => r.column_name);
  if (cols.some((c) => /rate/.test(c))) throw new Error('a mutable rate column exists on affiliates');
  return '15% from 1 Jan, 20% from 1 Mar: before → none, Feb → 1500, 1 Mar → 2000, Apr → 2000; 0 and 10000 allowed, -1 / 10001 refused; duplicate date refused; UPDATE/DELETE refused; no rate column on affiliates';
});

await step('affiliates: events append-only; settings read and upsert with a version', async () => {
  const ev = (await affPool().query(`INSERT INTO affiliate_events (actor, action, affiliate_id, entity, entity_id, metadata)
    VALUES ($1, 'affiliate_created', $2, 'affiliate', $3, $4) RETURNING id`, [AFF_ACTOR, AFF.a.id, String(AFF.a.id), JSON.stringify({ source: 'db-check' })])).rows[0];
  await affPool().query(`INSERT INTO affiliate_events (actor, action, metadata) VALUES ($1, 'settings_updated', '{}')`, [AFF_ACTOR]);
  await expectErr('bad action name', () => affPool().query(`INSERT INTO affiliate_events (actor, action) VALUES ($1, 'Not An Action')`, [AFF_ACTOR]), (e) => e.code === '23514');
  await expectErr('update event', () => affPool().query("UPDATE affiliate_events SET action = 'affiliate_updated' WHERE id = $1", [ev.id]), (e) => /append-only/.test(e.message));
  await expectErr('delete event', () => affPool().query('DELETE FROM affiliate_events WHERE id = $1', [ev.id]), (e) => /append-only/.test(e.message));
  // Settings: read, upsert (version bumps), new key, fallback for a missing key.
  const KEY = 'dbcheck_probe_setting';
  if ((await getAffiliateSetting('attribution_window_days')) !== 30) throw new Error('read');
  if ((await getAffiliateSetting('no_such_setting', 'fallback')) !== 'fallback') throw new Error('fallback');
  const v1 = await setAffiliateSetting(KEY, { days: 14 }, { actor: AFF_ACTOR });
  const v2 = await setAffiliateSetting(KEY, { days: 21 }, { actor: AFF_ACTOR });
  if (v1 !== 1 || v2 !== 2 || (await getAffiliateSetting(KEY)).days !== 21) throw new Error(`upsert ${v1}/${v2}`);
  // Re-running the schema never overwrites a changed seeded setting.
  await affPool().query(`UPDATE affiliate_settings SET value = '45'::jsonb WHERE key = 'attribution_window_days'`);
  _resetAffiliateSchemaForTest(); await ensureAffiliateSchema();
  const kept = await getAffiliateSetting('attribution_window_days');
  await affPool().query(`UPDATE affiliate_settings SET value = '30'::jsonb WHERE key = 'attribution_window_days'`);
  await affPool().query('DELETE FROM affiliate_settings WHERE key = $1', [KEY]);
  if (kept !== 45) throw new Error('seed overwrote an edited setting');
  return 'events insert; UPDATE/DELETE refused; action names checked; settings read with fallback, upsert bumps version (1 → 2), edited seed kept on re-run';
});

await step('affiliates: RBAC — viewer / manager / finance grants; admins unchanged; module role stored', async () => {
  const caps = (role) => capabilitiesOf({ allowed: true, admin: false, roles: { affiliate: role } });
  const A = ['affiliate.view', 'affiliate.manage', 'affiliate.verify', 'affiliate.commissions', 'affiliate.payouts'];
  const has = (c) => A.filter((x) => c.includes(x)).join(',');
  const want = { viewer: 'affiliate.view', manager: 'affiliate.view,affiliate.manage,affiliate.verify', finance: 'affiliate.view,affiliate.commissions,affiliate.payouts' };
  for (const [role, w] of Object.entries(want)) if (has(caps(role)) !== w) throw new Error(`${role}: ${has(caps(role))}`);
  // The negatives, spelled out.
  const no = [['viewer', 'affiliate.manage'], ['viewer', 'affiliate.verify'], ['viewer', 'affiliate.commissions'], ['viewer', 'affiliate.payouts'],
    ['manager', 'affiliate.commissions'], ['manager', 'affiliate.payouts'], ['finance', 'affiliate.manage'], ['finance', 'affiliate.verify']];
  for (const [r, c] of no) if (caps(r).includes(c)) throw new Error(`${r} has ${c}`);
  if (caps('operator').some((c) => c.startsWith('affiliate.'))) throw new Error('unknown role grants');
  // Admins: every capability (affiliate ones included); members without the module: none.
  const admin = capabilitiesOf({ allowed: true, admin: true, roles: {} });
  if (!A.every((c) => admin.includes(c)) || admin.length !== CAPABILITIES.length) throw new Error('admin');
  for (const roles of [{}, { logistics: 'manager' }, { inventory: 'manager', support: 'lead', hr: 'manager' }]) {
    if (capabilitiesOf({ allowed: true, admin: false, roles }).some((c) => c.startsWith('affiliate.'))) throw new Error(`granted without the module: ${JSON.stringify(roles)}`);
  }
  // The stored module/role pairs: affiliate roles accepted, others refused.
  const PHONE = '919000000990';
  await getPool().query(`INSERT INTO allowed_users (phone, name, added_by) VALUES ($1, 'DB Check Affiliate RBAC', $2) ON CONFLICT (phone) DO NOTHING`, [PHONE, AFF_ACTOR]);
  try {
    for (const r of ['viewer', 'manager', 'finance']) await getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1, 'affiliate', $2) ON CONFLICT (phone, module) DO UPDATE SET role = EXCLUDED.role`, [PHONE, r]);
    await expectErr('affiliate operator', () => getPool().query(`UPDATE member_module_roles SET role = 'operator' WHERE phone = $1 AND module = 'affiliate'`, [PHONE]), (e) => e.code === '23514');
    await expectErr('logistics finance', () => getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1, 'logistics', 'finance')`, [PHONE]), (e) => e.code === '23514');
  } finally {
    await getPool().query('DELETE FROM member_module_roles WHERE phone = $1', [PHONE]);
    await getPool().query('DELETE FROM allowed_users WHERE phone = $1', [PHONE]);
  }
  return 'viewer → view; manager → view/manage/verify; finance → view/commissions/payouts; 8 negative checks; admins get all 5 (and all others); no grant without the module; DB accepts affiliate viewer/manager/finance and refuses other pairs';
});

await step('affiliates cleanup', async () => {
  const r = await purgeTestAffiliates(AFF_ACTOR);
  const left = (await getPool().query('SELECT count(*)::int n FROM affiliates WHERE created_by = $1', [AFF_ACTOR])).rows[0].n;
  if (left) throw new Error('left behind');
  return `${r.affiliates} test affiliates (with their rates and events) removed`;
});

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
// (A photo key under members/photos/ with an image type, as savePhoto stores them; no file behind it is needed here.)
const completeTestProfiles = () => getPool().query(`UPDATE allowed_users SET email = coalesce(email, phone || '@example.test'),
  photo_key = CASE WHEN photo_key LIKE 'members/photos/%' THEN photo_key ELSE 'members/photos/db-check/test-photo.jpg' END,
  photo_mime = CASE WHEN photo_mime IN ('image/jpeg','image/png','image/webp') THEN photo_mime ELSE 'image/jpeg' END
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
    ['/api/inventory/cutover', 'GET', null, { log: 'ok', invOnly: 'ok', lview: 403, call: 403 }],
    ['/api/inventory/cutover', 'PUT', {}, { log: 403, lview: 403, call: 403, none: 403, invOnly: 'ok', multi: 'ok', adm: 'ok' }],
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
      MARKETING_ROAS_TARGET: '2.5', META_GRAPH_BASE: `http://127.0.0.1:${HRS.metaStub.address().port}`,
      AFFILIATE_CLICK_HOST: 'go.test', AFFILIATE_STOREFRONT_URL: 'https://store.test', AFFILIATE_HASH_SALT: 'db-check-affiliate-salt' },
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

await step('shopify oauth: APP_BASE_URL pins the callback; connecting stores the token and pulls nothing; state and HMAC checks intact', async () => {
  const bad = [];
  const TOKEN = 'shpat_oauth_TEST_NEVER_LOG_7c1e';
  const SECRET = 'test-shopify-client-secret';
  const SHOP = 'briyo-test.myshopify.com';
  const calls = { token: 0, graphql: [] };
  const stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/oauth/access_token') { calls.token += 1; return res.end(JSON.stringify({ access_token: TOKEN, scope: 'read_orders' })); }
    calls.graphql.push(b.slice(0, 120));
    return res.end(JSON.stringify({ data: { abandonedCheckouts: { pageInfo: { hasNextPage: false }, edges: [] }, orders: { pageInfo: { hasNextPage: false }, nodes: [] } } }));
  }); });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  const port = await freePort();
  let log = '';
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), APP_ENV: 'test', ADMIN_PHONES: '', ELEVENZA_AUTH_TOKEN: '', SHOPIFY_ACCESS_TOKEN: '',
      SLA_ALERTS_ENABLED: 'false', DAILY_SUMMARY_ENABLED: 'false', KEEPALIVE_URL: '', RENDER_EXTERNAL_URL: '', CAREERS_HOST: 'careers.test',
      DOCUMENT_STORAGE: 'local', DOCUMENT_STORAGE_DIR: HRS.dir, META_ACCESS_TOKEN: '', SHOPIFY_ORDERS_POLL_ENABLED: '',
      SHOPIFY_POLL_ENABLED: 'false', SHOPIFY_POLL_MINUTES: '0', SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_CLIENT_ID: 'test-client-id', SHOPIFY_CLIENT_SECRET: SECRET,
      APP_BASE_URL: 'https://abc.briyo.xyz', SHOPIFY_OAUTH_BASE: stubBase, SHOPIFY_GRAPHQL_BASE: stubBase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 150));
      if (i === 99) throw new Error(`server did not start: ${log.slice(-300)}`);
    }
    const admin = `${SESSION_COOKIE}=${issueSession(HRM.adm)}`;
    // The install redirect, requested under the Render host: APP_BASE_URL still decides the callback.
    const install = await new Promise((ok, no) => http.get({ host: '127.0.0.1', port, path: '/auth/shopify/install',
      headers: { cookie: admin, host: 'abc-briyo-sg.onrender.com', 'x-forwarded-proto': 'https' } }, (r) => { r.resume(); ok(r); }).on('error', no));
    const loc = new URL(install.headers.location || 'http://x/');
    const state = (install.headers['set-cookie'] || []).join(';').match(/shopify_oauth_state=([0-9a-f]+)/)?.[1];
    if (install.statusCode !== 302 || loc.host !== SHOP || loc.pathname !== '/admin/oauth/authorize') bad.push(`install ${install.statusCode} ${loc}`);
    if (loc.searchParams.get('redirect_uri') !== 'https://abc.briyo.xyz/auth/shopify/callback') bad.push(`redirect_uri ${loc.searchParams.get('redirect_uri')}`);
    if (loc.searchParams.get('scope') !== 'read_online_store_navigation,write_online_store_navigation,read_orders' || !state) bad.push(`scope/state ${loc.searchParams.get('scope')}`);
    // Non-admins cannot start it.
    const nonAdmin = await fetch(`${base}/auth/shopify/install`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.nonHr)}` }, redirect: 'manual' });
    if (nonAdmin.status === 302 && /myshopify/.test(nonAdmin.headers.get('location') || '')) bad.push('non-admin reached Shopify');
    // A signed callback: the HMAC Shopify would send.
    const signed = (q) => {
      const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&');
      return new URLSearchParams({ ...q, hmac: nodeCrypto.createHmac('sha256', SECRET).update(msg).digest('hex') });
    };
    const q = { code: 'test-auth-code', shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const cb = (params, cookie) => fetch(`${base}/auth/shopify/callback?${params}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    const carts = (await getPool().query('SELECT count(*)::int n FROM abandoned_carts')).rows[0].n;
    // Security checks still refuse: no state cookie, wrong state, bad signature.
    if ((await cb(signed(q))).status !== 403) bad.push('missing state accepted');
    if ((await cb(signed({ ...q, state: 'f'.repeat(32) }), `shopify_oauth_state=${state}`)).status !== 403) bad.push('wrong state accepted');
    const tampered = signed(q); tampered.set('code', 'other-code');
    if ((await cb(tampered, `shopify_oauth_state=${state}`)).status !== 403) bad.push('bad hmac accepted');
    if (calls.token !== 0) bad.push('token exchanged before checks passed');
    // The real thing: connects, stores the token, redirects — and pulls nothing.
    const ok = await cb(signed(q), `shopify_oauth_state=${state}`);
    if (ok.status !== 302 || ok.headers.get('location') !== '/import?shopify=connected') bad.push(`callback ${ok.status} ${ok.headers.get('location')}`);
    const stored = await getSystemState('shopify_oauth_token');
    if (!stored || JSON.parse(stored.value).token !== TOKEN || JSON.parse(stored.value).shop !== SHOP || calls.token !== 1) bad.push('token not stored');
    await new Promise((r) => setTimeout(r, 2500));
    if (calls.graphql.length) bad.push(`Shopify was queried after connecting: ${calls.graphql.length} call(s)`);
    if ((await getPool().query('SELECT count(*)::int n FROM abandoned_carts')).rows[0].n !== carts) bad.push('carts changed');
    if ((await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE kind = 'shopify_sync'`)).rows[0].n) bad.push('an order sync ran');
    if (/First Shopify pull|Shopify poll: every|Shopify orders poll: every/.test(log)) bad.push('a pull or poll started');
    if (log.includes(TOKEN) || log.includes(SECRET)) bad.push('token or secret in the server log');
    // The Import page reads this to hide "Pull from Shopify now" while the abandoned-checkout poll is off.
    const cfg = await (await fetch(`${base}/api/config`, { headers: { cookie: admin } })).json();
    if (!cfg.shopifyAuthorized || cfg.shopifyPollEnabled !== false) bad.push(`config authorized=${cfg.shopifyAuthorized} pollEnabled=${cfg.shopifyPollEnabled}`);
    // The orders/create webhook over real HTTP: the signature is checked against the exact body bytes
    // (non-ASCII included), a forged one is refused, a good one is stored and acknowledged.
    const whBody = JSON.stringify({ id: 990001, admin_graphql_api_id: 'gid://shopify/Order/990001', name: '#WH₹-1', note: 'ünïcødé' });
    const whPost = (sig, id) => fetch(`${base}/api/webhook/shopify/orders-create`, { method: 'POST', body: whBody, headers: { 'content-type': 'application/json',
      'x-shopify-hmac-sha256': sig, 'x-shopify-shop-domain': SHOP, 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': id } });
    const goodSig = nodeCrypto.createHmac('sha256', SECRET).update(Buffer.from(whBody, 'utf8')).digest('base64');
    const forgedWh = await whPost(nodeCrypto.createHmac('sha256', 'wrong').update(whBody).digest('base64'), 'dbcheck-wh-http-forged');
    const goodWh = await whPost(goodSig, 'dbcheck-wh-http-1');
    const again = await (await whPost(goodSig, 'dbcheck-wh-http-1')).json();
    const row = (await getPool().query(`SELECT order_gid FROM shopify_webhook_deliveries WHERE webhook_id = 'dbcheck-wh-http-1'`)).rows[0];
    if (forgedWh.status !== 401 || goodWh.status !== 200 || !again.duplicate || row?.order_gid !== 'gid://shopify/Order/990001') bad.push(`webhook http ${forgedWh.status}/${goodWh.status}/${JSON.stringify(again)}/${row?.order_gid}`);
    if ((await getPool().query(`SELECT 1 FROM shopify_webhook_deliveries WHERE webhook_id = 'dbcheck-wh-http-forged'`)).rows.length) bad.push('forged webhook stored');
    if (log.includes('ünïcødé') || log.includes('#WH₹-1')) bad.push('webhook body in the server log');
  } finally {
    srv.kill(); stub.close();
    await getPool().query(`DELETE FROM shopify_webhook_deliveries WHERE webhook_id LIKE 'dbcheck-wh-http-%'`).catch(() => {});
    await getPool().query(`DELETE FROM order_imports WHERE imported_by = 'shopify-webhook'`).catch(() => {});
    await getPool().query(`DELETE FROM system_state WHERE key = 'shopify_oauth_token'`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'install from the Render host → redirect_uri https://abc.briyo.xyz/auth/shopify/callback (APP_BASE_URL); non-admin refused; missing/wrong state and tampered HMAC → 403 with no token exchange; valid callback stores the token and redirects; then 0 Shopify queries, 0 carts, 0 order syncs, no poll started, no token in logs; /api/config reports polling off';
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
    // SKU mapping is an Inventory catalog decision: no one else can map (refused before anything is read).
    ['POST', '/api/inventory/skus/1/platform-skus', { platform: 'amazon', platform_skus: ['RBAC-PROBE'], from_order: true }, { mgr: 403, nonHr: 403, '': 401 }],
    ['GET', '/api/inventory/unmapped', null, { mgr: 403, '': 401 }],
    // Products on a hand-entered order: Logistics editors only (refused before anything is read).
    ['POST', '/api/orders/1/items', { sku_id: 1, quantity: 1 }, { mgr: 403, nonHr: 403, '': 401 }],
    ['GET', '/api/orders/line-skus', null, { mgr: 403, '': 401 }],
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

await step('timezone: Asia/Kolkata is the one business timezone and DD-MM-YYYY the one display format, whatever the machine timezone', async () => {
  const bad = [];
  const tz = await import('../lib/timezone.js');
  const ui = await import('../public/ui/ist.js');
  const { teamTimezone: tt, zonedToUtc: z } = await import('../lib/orders.js');
  const { resolveWindow } = await import('../lib/shopify-orders.js');
  const { dateOf } = await import('../lib/inventory.js');
  const { csvCell } = await import('../lib/csv.js');
  // 1. One source; the legacy variables never override it.
  const keep = { a: process.env.BOARD_TIMEZONE, b: process.env.BOARD_TZ };
  try {
    process.env.BOARD_TIMEZONE = 'UTC'; process.env.BOARD_TZ = 'America/New_York';
    if (tz.APP_TIMEZONE !== 'Asia/Kolkata' || ui.APP_TIMEZONE !== 'Asia/Kolkata' || tt() !== 'Asia/Kolkata') bad.push('APP_TIMEZONE');
    const w = tz.legacyTimezoneWarning();
    if (!w || !/BOARD_TIMEZONE=UTC/.test(w) || !/BOARD_TZ=America\/New_York/.test(w) || !/always uses Asia\/Kolkata/.test(w)) bad.push(`warning ${w}`);
    if (tz.legacyTimezoneWarning({ BOARD_TIMEZONE: 'Asia/Kolkata' }) !== null || tz.legacyTimezoneWarning({}) !== null) bad.push('IST or unset should be silent');
  } finally {
    if (keep.a === undefined) delete process.env.BOARD_TIMEZONE; else process.env.BOARD_TIMEZONE = keep.a;
    if (keep.b === undefined) delete process.env.BOARD_TZ; else process.env.BOARD_TZ = keep.b;
  }
  // 2. A UTC instant shows in IST, DD-MM-YYYY, h:mm AM/PM IST — server and page agree.
  const t = '2026-10-08T05:05:00Z';   // 10:35 IST
  if (tz.formatDateTime(t) !== '08-10-2026, 10:35 AM IST' || ui.istDateTime(t) !== '08-10-2026, 10:35 AM IST') bad.push(`timestamp ${tz.formatDateTime(t)} / ${ui.istDateTime(t)}`);
  if (tz.formatDate(t) !== '08-10-2026' || ui.istDate(t) !== '08-10-2026') bad.push('date');
  if (ui.istDateTime('2026-10-08T18:29:00Z') !== '08-10-2026, 11:59 PM IST' || ui.istDateTime('2026-10-08T18:30:00Z') !== '09-10-2026, 12:00 AM IST') bad.push('midnight display');
  // 3. Midnight business boundary: 08-10-2026 is 07-10 18:30Z → 08-10 18:30Z.
  if (tz.istDayStart('2026-10-08').toISOString() !== '2026-10-07T18:30:00.000Z' || tz.istDayEnd('2026-10-08').toISOString() !== '2026-10-08T18:30:00.000Z') bad.push('day bounds');
  // 4. "Today" is the IST day, not the UTC/server one: 19:00Z on 07-10 is already 08-10 in IST.
  if (tz.istDayKey('2026-10-07T19:00:00Z') !== '2026-10-08' || ui.istDayKey('2026-10-07T19:00:00Z') !== '2026-10-08') bad.push('today');
  // 5. "Last 30 days" = 30 IST calendar days, today included, from 00:00 IST.
  const { rows: [w30] } = await getPool().query(`SELECT ${tz.lastIstDaysSql(30)} AS since, (now() AT TIME ZONE 'Asia/Kolkata')::date AS today`);
  const expect = tz.istDayStart(new Date(Date.UTC(...w30.today.split('-').map((v, i) => (i === 1 ? v - 1 : Number(v)))) - 29 * 86400000).toISOString().slice(0, 10));
  if (new Date(w30.since).toISOString() !== expect.toISOString()) bad.push(`last 30 days ${new Date(w30.since).toISOString()} vs ${expect.toISOString()}`);
  // 6. Order date filters are IST days: 18:45Z on 07-10 is 08-10 IST; 18:15Z is still 07-10.
  const mk = async (tag, at) => createOrder({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-TZ-${tag}`, order_date: at, order_value: 1 }, { actor: ACTOR });
  const inDay = await mk('IN', '2026-10-07T18:45:00Z'); const before = await mk('BEFORE', '2026-10-07T18:15:00Z');
  const got = (await listOrders({ from: '2026-10-08', to: '2026-10-08', q: `${TEST_ORDER}-TZ-` })).orders.map((o) => o.id);
  if (!got.includes(inDay) || got.includes(before)) bad.push(`order filter ${JSON.stringify(got)}`);
  if (z('2026-10-08T10:35', 'Asia/Kolkata') !== '2026-10-08T05:05:00.000Z') bad.push('zonedToUtc');
  // 7. Affiliate clicks "last 30 days" uses the same IST window (lastIstDaysSql) — checked by source and by the SQL above.
  const refSrc = await fsp.readFile(new URL('../lib/affiliate-referrals.js', import.meta.url), 'utf8');
  const ovSrc = await fsp.readFile(new URL('../lib/overview.js', import.meta.url), 'utf8');
  if (!/clicked_at >= \$\{lastIstDaysSql\(30\)\}/.test(refSrc) || !/clicked_at >= \$\{lastIstDaysSql\(30\)\}/.test(ovSrc) || /clicked_at > now\(\) - interval '30 days'/.test(refSrc + ovSrc)) bad.push('affiliate 30-day window');
  // 8. Shopify: the checkpoint shows in IST; a picked day is the whole IST day (never past now).
  if (ui.istDateTime('2026-10-07T19:03:57.433Z') !== '08-10-2026, 12:33 AM IST') bad.push('checkpoint display');
  const win = resolveWindow({ from: '2026-10-07', to: '2026-10-07' }, new Date('2026-10-09T00:00:00Z'));
  if (win.from !== '2026-10-06T18:30:00.000Z' || win.to !== '2026-10-07T18:30:00.000Z') bad.push(`shopify window ${JSON.stringify(win)}`);
  const winToday = resolveWindow({ from: '2026-10-08', to: '2026-10-08' }, new Date('2026-10-08T06:00:00Z'));
  if (winToday.to !== '2026-10-08T06:00:00.000Z') bad.push('window capped at now');
  // 9–10. Date-only values never shift: inventory expiry typed DD-MM-YYYY or MM-YYYY → the same calendar day.
  if (dateOf('31-08-2028') !== '2028-08-31' || dateOf('08-2028') !== '2028-08-31' || dateOf('2028-08-31') !== '2028-08-31') bad.push('inventory dateOf');
  if (tz.formatDayKey('2028-08-31') !== '31-08-2028' || ui.formatDayKey('2028-02-29') !== '29-02-2028') bad.push('date-only display');
  // 11. The exact strings, and the parser.
  if (ui.formatDayKey('2026-10-08') !== '08-10-2026' || tz.formatDayKey('2026-10-08') !== '08-10-2026') bad.push('08-10-2026');
  if (ui.parseDisplayDate('08-10-2026') !== '2026-10-08' || tz.parseDisplayDate('8-10-2026') !== '2026-10-08' || ui.parseDisplayDate('31-02-2026') !== null || ui.parseDisplayDate('2026-10-08') !== null) bad.push('parseDisplayDate');
  // Inputs: IST wall clock ↔ instant, regardless of the browser zone.
  if (ui.istInputValue('2026-10-08T05:05:00Z') !== '2026-10-08T10:35' || ui.fromIstInput('2026-10-08T10:35') !== '2026-10-08T05:05:00.000Z') bad.push('datetime input');
  // CSV: timestamps for people, in IST.
  if (csvCell(new Date(t)) !== '"08-10-2026, 10:35 AM IST"') bad.push(`csv ${csvCell(new Date(t))}`);
  // No page formats dates on its own any more (one formatter: public/ui/ist.js).
  for (const f of ['orders', 'inventory', 'overview', 'marketing', 'dashboard', 'affiliates', 'hr', 'members', 'app']) {
    const src = await fsp.readFile(new URL(`../public/${f}.js`, import.meta.url), 'utf8');
    if (/toLocaleDateString\('en-IN', \{ (day|month)|DAY_FMT|SEEN_FMT|month: 'short', year|month: 'long', year/.test(src)) bad.push(`${f}.js has its own date format`);
  }
  await purgeTestOrders(`${TEST_ORDER}-TZ-`);
  if (bad.length) throw new Error(bad.join(' | '));
  return `process TZ=${process.env.TZ || '(unset)'} · Intl ${Intl.DateTimeFormat().resolvedOptions().timeZone}: APP_TIMEZONE Asia/Kolkata (BOARD_* ignored with a warning); 05:05Z → "08-10-2026, 10:35 AM IST"; 08-10-2026 = 07-10 18:30Z…08-10 18:30Z; today/last-30-days/order filter/Shopify window in IST; expiry 31-08-2028 unshifted; "08-10-2026" exact; parser, inputs and CSV in IST`;
});

await step('hr: IST — UTC instants shown and bucketed as Asia/Kolkata days and times', async () => {
  const bad = [];
  // 20:00 UTC on 6 Oct is 01:30 IST on 7 Oct.
  const t = '2026-10-06T20:00:00.000Z';
  if (istDateTime(t) !== '07-10-2026, 1:30 AM IST') bad.push(`istDateTime ${JSON.stringify(istDateTime(t))}`);
  if (istDate(t) !== '07-10-2026' || istTime(t) !== '1:30 AM' || uiIstDayKey(t) !== '2026-10-07' || istDayKey(t) !== '2026-10-07') bad.push('date/time/day key');
  if (istDateTime('2026-10-06T06:29:00Z') !== '06-10-2026, 11:59 AM IST') bad.push('morning UTC');
  if (istDateTime('2026-12-31T18:30:00Z') !== '01-01-2027, 12:00 AM IST') bad.push('year boundary');
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
  const want = { mgr: 'hr', multi: 'commerce,hr,inventory,logistics,shipments', nonHr: 'support', adm: 'commerce,hr,ingest,inventory,logistics,marketing,shipments,support,team' };
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
    ['team active', S.team.active, await one('SELECT count(*)::int n FROM allowed_users WHERE active')],
    ['inventory skus', S.inventory.master_skus, await one('SELECT count(*)::int n FROM skus WHERE active')],
  ];
  const meta = (await internal('adm', 'GET', '/api/orders/meta')).body;
  // Failed equals the Orders view; the others are app shipment work only (see the next step).
  cmp.push(['logistics failed', S.logistics.failed, meta.viewCounts.failed]);
  cmp.push(['logistics awaiting dispatch', S.logistics.awaiting_dispatch, meta.viewCounts.awaiting_dispatch]);
  for (const k of ['in_transit', 'delivered']) if (!(S.logistics[k] <= meta.viewCounts[k])) bad.push(`logistics ${k} above its Orders view`);
  if ('without_shipment' in S.logistics || 'pending_dispatch' in S.logistics) bad.push('old logistics keys still returned');
  for (const [label, a, b] of cmp) if (a !== b) bad.push(`${label}: ${a} vs ${b}`);
  // Attention: only non-zero items, sorted critical → warning → attention, each with a link.
  const order = ['critical', 'warning', 'attention'];
  if (ov.attention.some((a) => a.count === 0 || !a.href)) bad.push('zero or unlinked attention item');
  if (ov.attention.some((a, i) => i && order.indexOf(a.severity) < order.indexOf(ov.attention[i - 1].severity))) bad.push('attention not sorted');
  if (ov.timezone !== (process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata')) bad.push('timezone');
  void pool;
  if (bad.length) throw new Error(bad.join(' | '));
  return `HR manager → hr; multi-module → hr, inventory, logistics; support → support; admin → all + team + ingest; signed out 401 / login; careers host 404; ${cmp.length} numbers equal their source counts; ${ov.attention.length} attention items, non-zero, sorted, linked`;
});

await step('overview: app shipment work only — no-shipment orders never "awaiting dispatch", cancelled orders never in transit or delivered; SKU mapping is setup, not a blocker; Team is admin-only', async () => {
  const bad = [];
  const pool = getPool();
  const admin = { phone: RB.adm, isAdmin: true, caps: CAPABILITIES };
  const L = async () => (await overviewFor(admin, { slaHours: 6 })).sections.logistics;
  const before = await L();
  const mk = async (tag, status, shipment) => {
    const id = await createOrder({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-OVX-${tag}`, order_date: NOW(), order_value: 100 }, { actor: ACTOR });
    if (status !== 'new') await pool.query('UPDATE orders SET order_status = $2 WHERE id = $1', [id, status]);
    // createOrder may open a shipment of its own: set it to the state under test, or remove it for "no shipment".
    const { rows: own } = await pool.query('SELECT id FROM order_shipments WHERE order_id = $1 ORDER BY id', [id]);
    if (!shipment) await pool.query('DELETE FROM order_shipments WHERE order_id = $1', [id]);
    else if (own.length) await pool.query('UPDATE order_shipments SET shipment_status = $2 WHERE id = $1', [own[0].id, shipment]);
    else await pool.query('INSERT INTO order_shipments (order_id, shipment_status, created_by) VALUES ($1, $2, $3)', [id, shipment, ACTOR]);
    return id;
  };
  const noShip = await mk('NOSHIP', 'new', null);  // e.g. fulfilled outside the app: not shipment work
  // A line with a code no master SKU knows, so there is a platform SKU to map.
  await pool.query(`INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price) VALUES ($1, 'L1', $2, 'Overview test line', 1, 100)`, [noShip, `${TS}-OVX-UNMAPPED`]);
  const packed = await mk('PACKED', 'new', 'packed');   // awaiting dispatch
  const unready = await mk('UNREADY', 'new', 'not_ready'); // awaiting dispatch
  await mk('TRANSIT', 'new', 'in_transit');
  await mk('DELIV', 'new', 'delivered');
  await mk('XTRANSIT', 'cancelled', 'in_transit'); // cancelled: never in transit
  await mk('XDELIV', 'cancelled', 'delivered');    // cancelled: never delivered
  const after = await L();
  const d = (k) => after[k] - before[k];
  if (d('awaiting_dispatch') !== 2) bad.push(`awaiting dispatch +${d('awaiting_dispatch')} (want +2: not ready + packed, not the no-shipment order)`);
  if (d('in_transit') !== 1) bad.push(`in transit +${d('in_transit')} (want +1: cancelled excluded)`);
  if (d('delivered') !== 1) bad.push(`delivered +${d('delivered')} (want +1: cancelled excluded)`);
  if (d('today') !== 7) bad.push(`orders today +${d('today')} (want +7, unchanged meaning)`);
  // One definition: the Orders view lists exactly the Overview's population, old link name included.
  const view = await listOrders({ view: 'awaiting_dispatch' }, { limit: 500 });
  const legacy = await listOrders({ view: 'pending_dispatch' }, { limit: 1 });
  if (view.total !== after.awaiting_dispatch || legacy.total !== view.total || view.viewCounts.awaiting_dispatch !== view.total) bad.push(`Orders ${view.total} / legacy ${legacy.total} vs Overview ${after.awaiting_dispatch}`);
  const ids = new Set(view.orders.map((o) => o.id));
  if (!ids.has(packed) || !ids.has(unready) || ids.has(noShip)) bad.push('Orders view population');
  const ovPage = await fsp.readFile(new URL('../public/overview.js', import.meta.url), 'utf8');
  const ovApi = await fsp.readFile(new URL('../lib/overview.js', import.meta.url), 'utf8');
  if (!ovPage.includes("href: '/orders?view=awaiting_dispatch'") || !ovApi.includes("'/orders?view=awaiting_dispatch'") || /view=pending_dispatch/.test(ovPage + ovApi)) bad.push('Overview links');
  const om = (await internal('adm', 'GET', '/api/orders/meta')).body;
  if (om.views.awaiting_dispatch !== 'Awaiting dispatch' || 'pending_dispatch' in om.views) bad.push(`Orders view label ${JSON.stringify(om.views)}`);
  const linked = await internal('adm', 'GET', '/api/orders?view=awaiting_dispatch&limit=1');
  if (linked.body.total !== after.awaiting_dispatch) bad.push(`linked view ${linked.body.total}`);
  // The Orders page views are untouched: they still list every order the way they did.
  const meta = await internal('adm', 'GET', '/api/orders/meta');
  if (meta.body.viewCounts.delivered < after.delivered + 1) bad.push('Orders delivered view changed');
  const ov = await overviewFor(admin, { slaHours: 6 });
  // No "without a shipment" or "pending dispatch" alarm.
  if (ov.attention.some((a) => /without a shipment|pending dispatch/.test(a.text))) bad.push('misleading logistics wording in attention');
  // Platform SKUs to map: a setup item with a count, never an attention item or "blocking".
  const I = ov.sections.inventory;
  if (!(I.platform_skus_to_map > 0) || 'unmapped_skus' in I) bad.push(`inventory keys ${JSON.stringify(Object.keys(I))}`);
  if (ov.attention.some((a) => /unmapped|mapping|blocking/i.test(a.text))) bad.push('SKU mapping still in attention');
  const su = ov.setup.find((x) => x.dept === 'inventory' && x.count !== null);
  // Inventory cutover: a setup item while unset, never an alarm; gone once set.
  const cutItem = (o) => o.setup.find((x) => x.text === 'Inventory cutover · Not set');
  if ((await getInventoryCutover()).cutover_at !== null || !cutItem(ov) || ov.attention.some((a) => /cutover/i.test(a.text))) bad.push('cutover setup item while unset');
  await setInventoryCutover('2026-01-01T00:00:00+05:30', { actor: ACTOR, confirm: true, version: (await getInventoryCutover()).version });
  const withCut = await overviewFor(admin, { slaHours: 6 });
  await getPool().query('UPDATE inventory_settings SET cutover_at = NULL WHERE id');
  if (cutItem(withCut) || withCut.attention.some((a) => /cutover/i.test(a.text))) bad.push('cutover item shown after it was set');
  if (!su || su.count !== I.platform_skus_to_map || su.text !== (su.count === 1 ? 'platform SKU needs mapping' : 'platform SKUs need mapping') || /block/i.test(su.text)) bad.push(`setup ${JSON.stringify(ov.setup)}`);
  // Team: admins only; nobody else gets the section or its attention items.
  const nonAdmin = await overviewFor({ phone: RB.multi, isAdmin: false, caps: CAPABILITIES.filter((c) => c !== 'marketing.view') }, { slaHours: 6 });
  if (!ov.sections.team?.ok || 'people' in ov.sections) bad.push('admin Team section');
  if (nonAdmin.sections.team || nonAdmin.sections.people || nonAdmin.attention.some((a) => a.dept === 'team')) bad.push('non-admin saw Team');
  const page = await fsp.readFile(new URL('../public/overview.js', import.meta.url), 'utf8');
  if (!page.includes("team: { label: 'Team'") || /Pending dispatch|without a shipment|Unmapped platform SKUs/.test(page)) bad.push('page wording');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'no-shipment order not counted; not ready + packed → +2 awaiting dispatch; Orders view (and old pending_dispatch link) = Overview, same orders; cancelled in-transit/delivered excluded; orders today +7; SKU mapping and unset cutover are setup items, never attention; cutover set → item gone; Team admin-only';
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
  // Pages go to /profile with the page asked for kept as ?next= (a same-site path only).
  for (const p of ['/', '/overview', '/orders?view=in_transit', '/inventory', '/stock-outward', '/hr', '/members', '/affiliates', '/marketing']) {
    const r = await internal('inc', 'GET', p);
    if (r.status !== 302 || r.headers.get('location') !== `/profile?next=${encodeURIComponent(p)}`) bad.push(`page ${p}: ${r.status} ${r.headers.get('location')}`);
  }
  // Every module API: 403 PROFILE_INCOMPLETE (Inventory, Stock Outward, Orders, Shopify/Amazon tools, affiliates, HR, members…).
  for (const [m, p] of [['GET', '/api/inventory'], ['GET', '/api/inventory/outward'], ['POST', '/api/inventory/outward'], ['GET', '/api/orders?limit=1'],
    ['POST', '/api/orders/shopify/sync-updates'], ['POST', '/api/orders/amazon/sync'], ['GET', '/api/affiliates'], ['GET', '/api/hr/jobs'], ['GET', '/api/members'], ['GET', '/api/overview'], ['GET', '/api/marketing/summary']]) {
    const r = await internal('inc', m, p, m === 'POST' ? {} : undefined);
    if (r.status !== 403 || r.body.code !== 'PROFILE_INCOMPLETE') bad.push(`${m} ${p}: ${r.status} ${r.body.code}`);
  }
  // No loop: the profile page, its API, /auth/me and sign-out stay open; a POST to a page does not get a ?next.
  if ((await internal('inc', 'GET', '/profile?next=%2Forders')).status !== 200) bad.push('profile page with next not open');
  const post = await internal('inc', 'POST', '/orders', {});
  if (post.status === 302 && post.headers.get('location') !== '/profile' && !/^\/profile$/.test(post.headers.get('location'))) bad.push(`non-GET page redirect ${post.headers.get('location')}`);
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
  // A member edits only their own profile, and only name and email: no role, admin flag, phone or another member.
  const rowOf = async () => (await pool.query('SELECT phone, is_admin, role, active, profile_required FROM allowed_users WHERE phone = $1', [HRM.inc])).rows[0];
  const before = await rowOf();
  const sneaky = await put({ name: 'Inaya Test', is_admin: true, role: 'logistics', phone: '919999999999', roles: { inventory: 'manager' }, profile_required: false, active: false });
  if (sneaky.status !== 200 || JSON.stringify(await rowOf()) !== JSON.stringify(before) || JSON.stringify(await moduleRolesOf(HRM.inc)) !== rolesBefore) bad.push(`profile form changed role/admin ${JSON.stringify([before, await rowOf()])}`);
  if ((await pool.query('SELECT 1 FROM allowed_users WHERE phone = $1', ['919999999999'])).rows.length) bad.push('profile form changed the phone');
  const other = (await pool.query('SELECT name, email FROM allowed_users WHERE phone = $1', [HRM.mgr])).rows[0];
  await put({ phone: HRM.mgr, name: 'Hijacked' });
  const other2 = (await pool.query('SELECT name, email FROM allowed_users WHERE phone = $1', [HRM.mgr])).rows[0];
  if (JSON.stringify(other) !== JSON.stringify(other2)) bad.push('profile form changed another member');
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
  return 'pages → /profile?next=<page>, every module API 403 PROFILE_INCOMPLETE (inventory, stock outward, orders, Shopify/Amazon, affiliates, HR, members, overview, marketing), /auth/me + /profile open, no loop; own name/email only — role, admin, phone and other members untouched; placeholder/blank name, bad/empty email, fake PNG, PDF, empty, >2 MB refused and nothing stored; photo alone not enough; name+email+photo → full access, roles and phone unchanged; photo private (teammates yes, signed out 401, careers 404); admin sees profile fields (no storage key), edits email, clears photo → member held again; activity logged; non-admins refused';
});

await step('profiles: every member is held until complete — existing members too (profile_required no longer exempts); whitespace/invalid values never count; admin edits re-hold; disabled stays blocked; public routes open', async () => {
  const bad = [];
  const pool = getPool();
  // An existing member (marked not-required when profiles first arrived): incomplete → now held like everyone.
  await pool.query(`INSERT INTO allowed_users (phone, name, is_admin, added_by, profile_required) VALUES ($1, 'Old Timer', false, 'db-check', false) ON CONFLICT (phone) DO NOTHING`, [HRM.old]);
  await setModuleRole(HRM.old, 'support', 'agent', { actor: 'db-check' });
  const rolesBefore = JSON.stringify(await moduleRolesOf(HRM.old));
  const r1 = await internal('old', 'GET', '/overview');
  if (r1.status !== 302 || r1.headers.get('location') !== '/profile?next=%2Foverview') bad.push(`existing member page ${r1.status} ${r1.headers.get('location')}`);
  if ((await internal('old', 'GET', '/api/carts?days=1')).status !== 403) bad.push('existing member API not held');
  const me = (await internal('old', 'GET', '/auth/me')).body;
  if (me.profileComplete !== false || me.profileRequired !== true || me.profile.missing.join() !== 'email,photo' || me.profile.required !== true) bad.push(`auth/me ${JSON.stringify({ c: me.profileComplete, r: me.profileRequired, m: me.profile?.missing })}`);
  if ((await pool.query('SELECT profile_required FROM allowed_users WHERE phone = $1', [HRM.old])).rows[0].profile_required !== false) bad.push('a member row was changed to gate them');
  // Whitespace and invalid saved values never count as complete (e.g. written before validation, or directly).
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 3)]);
  const up = await fetch(`${HRS.base}/api/profile/photo`, { method: 'POST', body: png, headers: { cookie: `${SESSION_COOKIE}=${issueSession(HRM.old)}`, 'x-filename': 'me.png' } });
  if (up.status !== 201) bad.push(`photo ${up.status}`);
  // (Judged from the saved row by resolveAccess — the same function every request's access check uses, uncached here.)
  const okRow = (await pool.query('SELECT name, email, photo_key, photo_mime FROM allowed_users WHERE phone = $1', [HRM.old])).rows[0];
  for (const [set, field] of [[`email = '   '`, 'email'], [`email = 'not-an-email'`, 'email'], [`name = '   '`, 'name'], [`name = ' team '`, 'name'],
    [`photo_mime = 'application/pdf'`, 'photo'], [`photo_key = 'https://example.com/me.jpg'`, 'photo'], [`photo_key = NULL`, 'photo']]) {
    await pool.query(`UPDATE allowed_users SET name = 'Old Timer', email = 'old.timer@example.test', photo_key = $2, photo_mime = $3 WHERE phone = $1`, [HRM.old, okRow.photo_key, okRow.photo_mime]);
    if (!(await resolveAccess(HRM.old)).profileComplete) bad.push('baseline not complete');
    await pool.query(`UPDATE allowed_users SET ${set} WHERE phone = $1`, [HRM.old]);
    const a = await resolveAccess(HRM.old);
    if (a.profileComplete !== false || !a.profileMissing.includes(field)) bad.push(`${set} counted as complete`);
  }
  await pool.query('UPDATE allowed_users SET name = $2, email = NULL, photo_key = $3, photo_mime = $4 WHERE phone = $1', [HRM.old, okRow.name, okRow.photo_key, okRow.photo_mime]);
  // Through the API, whitespace-only and invalid values are refused and nothing is saved.
  for (const b of [{ name: '   ' }, { name: ' TEAM ' }, { email: '   ' }, { email: 'a@b' }]) {
    const rr = await internal('old', 'PUT', '/api/profile', b);
    if (rr.status !== 400) bad.push(`PUT ${JSON.stringify(b)} → ${rr.status}`);
  }
  // Completing it (server-side, from the database) opens everything again; RBAC unchanged.
  const put = await internal('old', 'PUT', '/api/profile', { email: 'old.timer@example.test' });
  if (put.status !== 200 || !put.body.profile.complete || (await internal('old', 'GET', '/')).status !== 200 || (await internal('old', 'GET', '/api/carts?days=1')).status !== 200) bad.push('completed member still held');
  if ((await internal('old', 'GET', '/api/orders?limit=1')).status !== 403 || (await internal('old', 'GET', '/api/members')).status !== 403 || JSON.stringify(await moduleRolesOf(HRM.old)) !== rolesBefore) bad.push('RBAC changed');
  // An admin's edit that empties a field holds them on their next request.
  const cl = await internal('adm', 'DELETE', `/api/members/${HRM.old}/photo`);
  if (cl.status !== 200 || (await internal('old', 'GET', '/api/carts?days=1')).status !== 403 || (await internal('old', 'GET', '/')).headers.get('location') !== '/profile?next=%2F') bad.push('admin photo removal did not re-hold');
  // Disabled (by an admin): signed out (401 / login), not the profile page — disabling wins.
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.old}`, { active: false })).status !== 200) bad.push('could not deactivate');
  const dApi = await internal('old', 'GET', '/api/carts?days=1'); const dPage = await internal('old', 'GET', '/profile');
  if (dApi.status !== 401 || dPage.status !== 302 || dPage.headers.get('location') !== '/login') bad.push(`disabled ${dApi.status} ${dPage.status} ${dPage.headers.get('location')}`);
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.old}`, { active: true })).status !== 200) bad.push('could not reactivate');
  // Routes registered before the global gate apply it themselves: an incomplete admin cannot start the Shopify install.
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.old}`, { isAdmin: true })).status !== 200) bad.push('could not make admin');
  const inst = await internal('old', 'GET', '/auth/shopify/install');
  if (inst.status !== 302 || inst.headers.get('location') !== '/profile') bad.push(`incomplete admin reached Shopify install: ${inst.status} ${inst.headers.get('location')}`);
  if ((await internal('old', 'GET', '/api/members')).status !== 403) bad.push('incomplete admin reached the members API');
  if ((await internal('adm', 'PATCH', `/api/members/${HRM.old}`, { isAdmin: false })).status !== 200) bad.push('could not remove admin');
  // New members (the default) are held the same way.
  await pool.query(`INSERT INTO allowed_users (phone, name, added_by) VALUES ('919000000308', 'Team', 'db-check')`);
  await setModuleRole('919000000308', 'support', 'agent', { actor: 'db-check' });
  const fresh = (method, p) => fetch(`${HRS.base}${p}`, { method, redirect: 'manual', headers: { cookie: `${SESSION_COOKIE}=${issueSession('919000000308')}` } });
  const fp = await fresh('GET', '/'); const fa = await fresh('GET', '/api/carts?days=1');
  if (fp.status !== 302 || fp.headers.get('location') !== '/profile?next=%2F' || fa.status !== 403 || (await fa.json()).code !== 'PROFILE_INCOMPLETE') bad.push(`new member not held ${fp.status}/${fa.status}`);
  // Public routes are not behind the gate: health, sign-in, careers.
  if ((await internal(null, 'GET', '/healthz')).status !== 200 || (await fresh('GET', '/login')).status !== 200) bad.push('public route held');
  if ((await careers('GET', '/', {})).status !== 200) bad.push('careers held');
  // Overview counts incomplete active profiles with the same rule.
  const ov = (await internal('adm', 'GET', '/api/overview')).body.sections.team;
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int n FROM allowed_users WHERE active AND NOT ${profileCompleteSqlForTest('allowed_users')}`);
  if (ov.incomplete_profiles !== n) bad.push(`overview incomplete ${ov.incomplete_profiles} vs ${n}`);
  await pool.query(`DELETE FROM member_log WHERE target_phone = '919000000308'`);
  await pool.query(`DELETE FROM allowed_users WHERE phone = '919000000308'`);
  if (bad.length) throw new Error(bad.join(' | '));
  return `existing (not-required) incomplete member → /profile?next= + 403, row untouched; whitespace/placeholder name, blank/invalid email, non-image type or non-stored photo key → incomplete; completing opens access, RBAC unchanged; admin photo removal re-holds; disabled → signed out (401, /login) not the profile page; new member held; healthz, login, careers open; Overview incomplete = ${n} by the same rule`;
});

// ---- Recovery verification (Support) ---------------------------------------------------------------------
await step('recovery verification: matching rules (pure) — phone normalisation, identifier, phone+SKU/product+time, phone+time, window, missing time, shared and multiple orders, name never enough, payment states, revenue per currency, each order once', async () => {
  const bad = [];
  for (const [v, want] of [['+91 98765 43210', '9876543210'], ['919876543210', '9876543210'], ['09876543210', '9876543210'], ['9876543210', '9876543210'],
    ['+91-98765-43210', '9876543210'], ['12345', null], ['5876543210', null], ['', null], [null, null], ['+1 415 555 0100', null]]) if (phone10(v) !== want) bad.push(`phone10(${v}) = ${phone10(v)}`);
  for (const [o, want] of [[{ financial_status: 'PAID' }, 'paid'], [{ financial_status: 'PARTIALLY_REFUNDED' }, 'paid'], [{ financial_status: 'PENDING' }, 'pending'],
    [{ financial_status: 'PARTIALLY_PAID' }, 'pending'], [{ financial_status: 'AUTHORIZED' }, 'pending'], [{ financial_status: 'REFUNDED' }, 'refunded'],
    [{ financial_status: 'VOIDED' }, 'cancelled'], [{ financial_status: 'PAID', cancelled_at: '2026-10-01' }, 'cancelled'], [{}, 'unknown'], [{ order_status: 'cancelled' }, 'cancelled']]) {
    if (paymentOf(o) !== want) bad.push(`payment ${JSON.stringify(o)} → ${paymentOf(o)}`);
  }
  const T = Date.parse('2026-10-05T10:00:00Z');
  const at = (h) => new Date(T + h * 3600000).toISOString();
  const cart = (id, o = {}) => ({ id, cart_id: `C${id}`, customer_name: o.name || `Cust ${id}`, phone: o.phone ?? `98765000${String(id).padStart(2, '0')}`, abandoned_at: at(-5), received_at: at(-5),
    marked_at: 'marked' in o ? o.marked : at(0), recovered_at: null, recovered_order_id: o.oid || null, recovered_order_name: o.oname || null, items: o.items || [] });
  const order = (id, o = {}) => ({ id, shopify_name: o.name || `#${id}`, legacy_id: String(id), customer_phone: o.phone ?? null, customer_name: o.cname || null,
    order_date: o.date || at(2), financial_status: 'fin' in o ? o.fin : 'PAID', cancelled_at: o.cancelled || null, current_total_price: 'value' in o ? o.value : 1000,
    shop_currency: o.cur || 'INR', currency: o.cur || 'INR', lines: o.lines || [] });
  const run = (carts, orders, dec = [], wh = 48) => Object.fromEntries(matchRecoveries(carts, orders, dec, { windowHours: wh }).map((r) => [r.cart.id, r]));
  let r = run([cart(1, { oname: '#RV-1', phone: '' })], [order(101, { name: '#RV-1' })]);
  if (r[1].status !== 'verified_paid' || r[1].tier !== 'identifier') bad.push(`identifier ${r[1].status}`);
  r = run([cart(2, { items: [{ title: 'Whey 1kg (Pack of 2)', sku: 'SKU-W' }] })], [order(102, { phone: '+91 98765 00002', date: at(5), lines: [{ sku: 'sku-w', title: 'Other name' }] })]);
  if (r[2].status !== 'verified_paid' || r[2].tier !== 'phone+product' || r[2].confidence !== 'high') bad.push(`phone+sku ${r[2].status} ${r[2].tier}`);
  r = run([cart(3, { items: [{ title: 'Whey 1kg (Pack of 2)' }] })], [order(103, { phone: '919876500003', fin: 'PENDING', lines: [{ title: 'Whey 1kg' }] })]);
  if (r[3].status !== 'verified_placed' || r[3].tier !== 'phone+product') bad.push(`phone+product name ${r[3].status} ${r[3].tier}`);
  r = run([cart(4)], [order(104, { phone: '9876500004' })]);
  if (r[4].status !== 'verified_paid' || r[4].tier !== 'phone+time' || r[4].confidence !== 'medium') bad.push(`phone+time ${r[4].status}`);
  r = run([cart(5)], [order(105, { phone: '9876500005', date: at(49) })]);
  if (r[5].status !== 'no_match') bad.push('outside 48 h matched');
  if (run([cart(5)], [order(105, { phone: '9876500005', date: at(49) })], [], 72)[5].status !== 'verified_paid') bad.push('window not configurable');
  if (run([cart(6)], [order(106, { phone: '9876500006', date: at(-6) })])[6].status !== 'no_match') bad.push('order before the cart matched');
  r = run([cart(7, { marked: null })], [order(107, { phone: '9876500007', date: at(-3) })]);
  if (r[7].status !== 'possible' || !r[7].lowConfidence || r[7].matchedOrder) bad.push(`missing time ${r[7].status}`);
  r = run([cart(8, { phone: '9876500088' }), cart(9, { phone: '+919876500088' })], [order(108, { phone: '9876500088' })]);
  if (r[8].status !== 'needs_review' || r[9].status !== 'needs_review') bad.push('one order for two carts not flagged');
  r = run([cart(10, { items: [{ title: 'Zinc' }] })], [order(110, { phone: '9876500010', date: at(1), lines: [{ title: 'Omega' }] }), order(111, { phone: '9876500010', date: at(3), lines: [{ title: 'Iron' }] })]);
  if (r[10].status !== 'needs_review' || r[10].candidates.length !== 2) bad.push('two orders not flagged');
  r = run([cart(11, { items: [{ title: 'Zinc' }] })], [order(112, { phone: '9876500011', date: at(1), lines: [{ title: 'Omega' }] }), order(113, { phone: '9876500011', date: at(3), lines: [{ title: 'Zinc' }] })]);
  if (r[11].status !== 'verified_paid' || Number(r[11].matchedOrder.id) !== 113) bad.push('the order with the product not chosen');
  r = run([cart(12, { items: [{ title: 'Zinc' }] })], [order(114, { phone: '9876500012', lines: [{ title: 'Omega' }] })]);
  if (r[12].status !== 'possible') bad.push('product conflict not "possible"');
  r = run([cart(13, { name: 'Ravi Kumar' })], [order(115, { phone: '9000000099', cname: 'Ravi Kumar' })]);
  if (r[13].status !== 'no_match') bad.push('matched on name alone');
  for (const [fin, extra, want] of [['REFUNDED', {}, 'cancelled_refunded'], ['PAID', { cancelled: at(3) }, 'cancelled_refunded'], [null, { value: null }, 'verified_placed']]) {
    r = run([cart(14)], [order(116, { phone: '9876500014', fin, ...extra })]);
    if (r[14].status !== want) bad.push(`${fin} → ${r[14].status}`);
  }
  // Decisions: a confirmation stands and takes the order away from other carts; a rejection removes that candidate.
  r = run([cart(8, { phone: '9876500088' }), cart(9, { phone: '9876500088' })], [order(108, { phone: '9876500088' })], [{ decision: 'confirmed', cart_id: 8, order_id: 108 }]);
  if (r[8].status !== 'verified_paid' || r[8].tier !== 'manual' || r[9].status !== 'no_match') bad.push('confirmation not applied');
  r = run([cart(10, { items: [{ title: 'Zinc' }] })], [order(110, { phone: '9876500010', lines: [{ title: 'Omega' }] }), order(111, { phone: '9876500010', date: at(3), lines: [{ title: 'Iron' }] })], [{ decision: 'rejected', cart_id: 10, order_id: 110 }]);
  if (r[10].candidates.length !== 1 || Number(r[10].candidates[0].order.id) !== 111) bad.push('rejection not applied');
  // Summary: each order once, paid only, per currency; missing values never ₹0.
  const res = [{ matchedOrder: order(1, { value: 1000 }), status: 'verified_paid' }, { matchedOrder: order(1, { value: 1000 }), status: 'verified_paid' },
    { matchedOrder: order(2, { value: 500, fin: 'PENDING' }), status: 'verified_placed' }, { matchedOrder: order(3, { value: 20, cur: 'USD' }), status: 'verified_paid' },
    { matchedOrder: order(4, { value: null }), status: 'verified_paid' }, { matchedOrder: order(5, { value: 700, fin: 'REFUNDED' }), status: 'cancelled_refunded' },
    { matchedOrder: null, status: 'no_match' }, { matchedOrder: null, status: 'needs_review' }, { matchedOrder: null, status: 'possible' }];
  const s = summarise(res);
  const inr = s.revenue.find((x) => x.currency === 'INR'); const usd = s.revenue.find((x) => x.currency === 'USD');
  if (s.recovered !== 9 || s.verifiedOrders !== 5 || s.paidOrders !== 3 || s.pendingOrders !== 1 || s.unmatched !== 1 || s.ambiguous !== 2 || s.paidWithoutValue !== 1) bad.push(`summary ${JSON.stringify(s)}`);
  if (inr?.amount !== 1000 || inr.paidOrders !== 1 || inr.averagePaidOrder !== 1000 || inr.perRecoveredCart !== 111.11 || usd?.amount !== 20) bad.push(`revenue ${JSON.stringify(s.revenue)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return '+91/0/spaces normalised, non-Indian or short refused; PAID/PARTIALLY_REFUNDED paid, PENDING/PARTIALLY_PAID/AUTHORIZED pending, REFUNDED, VOIDED/cancelled, no record → unknown (never paid); identifier → verified; phone+SKU and phone+product name → high; phone+time → medium; after 48 h / before the cart → none (72 h configurable); no recovery time → possible; one order for two carts and two orders for one cart → needs review (unless exactly one shares a product); product conflict → possible; same name, other phone → none; refunded/cancelled; confirm/reject applied; revenue: each order once, paid only, per currency, null value excluded (not ₹0)';
});

await step('recovery verification: end to end on the database and the real server — imported Shopify orders with financial records, statuses, refresh without double counting, decisions audited and exclusive, admin only; carts, orders and stock untouched', async () => {
  const bad = [];
  const db = getPool();
  const RV_NUM = `66${String(Date.now()).slice(-8)}`;
  const gidOf = (n) => `gid://shopify/Order/${RV_NUM}${String(n).padStart(3, '0')}`;
  const P = (n) => `98761${RV_NUM.slice(-3)}${String(n).padStart(2, '0')}`;      // test-only mobiles, unique to this run
  const now = Date.now(); const at = (h) => new Date(now + h * 3600000).toISOString();
  const cartIds = {};
  const mkCart = async (n, { phone = P(n), marked = at(-30), items = [], name = `RV Test ${n}`, oname = null } = {}) => {
    const { rows: [c] } = await db.query(`INSERT INTO abandoned_carts (cart_id, customer_name, phone, total_price, currency, abandoned_at, raw_payload, status, assigned_to, recovered_order_name, updated_by)
      VALUES ($1, $2, $3, 1299, 'INR', $4, $5, 'Called – Recovered', $6, $7, $6) RETURNING id`,
      [`DBCHECK-RV-${RV_NUM}-${n}`, name, phone, at(-40), JSON.stringify({ line_items: items }), 'RV Agent', oname]);
    if (marked) await db.query(`INSERT INTO cart_events (cart_id, kind, from_status, to_status, actor, at) VALUES ($1, 'status', 'Not called', 'Called – Recovered', 'RV Agent', $2)`, [c.id, marked]);
    cartIds[n] = Number(c.id);
    return Number(c.id);
  };
  const mkOrder = async (n, { phone = P(n), date = at(-28), fin = 'PAID', cancelled = false, total = 1299, sku = `${TS}-RV`, title = 'Vitamin D3', snapshot = true, name = `#RV${RV_NUM.slice(-4)}${n}` } = {}) => {
    const { rows: [o] } = await db.query(`INSERT INTO orders (channel, source, source_order_id, order_date, customer_name, customer_phone, order_value, currency, order_status, source_payload)
      VALUES ('website', 'shopify_sync', $1, $2, 'Buyer', $3, $4, 'INR', $5, $6) RETURNING id`,
      [gidOf(n), date, phone, total, cancelled ? 'cancelled' : 'new', JSON.stringify({ shopify: { name, legacy_id: `${RV_NUM}${String(n).padStart(3, '0')}` } })]);
    await db.query(`INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity) VALUES ($1, $2, $3, $4, 1)`, [o.id, `L${n}`, sku, title]);
    if (snapshot) {
      const node = { ...shOrder(900 + n, { fin, cancelled, total }), id: gidOf(n), name };
      await recordFinancialSnapshot(db, Number(o.id), financialSnapshotFrom(node));
    }
    return Number(o.id);
  };
  const fx = async () => (await db.query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs, (SELECT count(*) FROM order_shipments)::int sh,
    (SELECT count(*) FROM affiliate_order_attributions)::int at, (SELECT count(*) FROM orders)::int orders`)).rows[0];
  try {
    // Carts and orders (orders imported as the Shopify sync stores them, each with Shopify's financial record).
    await mkCart(1, { phone: '', oname: `#RV${RV_NUM.slice(-4)}1` }); const o1 = await mkOrder(1, { phone: '9000000001' });   // identifier
    await mkCart(2, { phone: `+91 ${P(2).slice(0, 5)} ${P(2).slice(5)}`, items: [{ title: 'Vitamin D3', quantity: 1, sku: `${TS}-RV` }] }); const o2 = await mkOrder(2);   // phone (+91) + SKU
    await mkCart(3); const o3 = await mkOrder(3, { fin: 'PENDING' });                        // phone + time, payment pending
    await mkCart(4); await mkOrder(4, { date: at(30) });                                    // after the window (marked −30 h + 48 h = +18 h)
    await mkCart(5, { marked: null }); await mkOrder(5, { date: at(-35) });                 // no recovery time
    await mkCart(6, { phone: P(6) }); await mkCart(7, { phone: P(6) }); const o6 = await mkOrder(6);   // two carts, one order
    await mkCart(8); await mkOrder(8, { date: at(-29) }); await mkOrder(81, { phone: P(8), date: at(-27), title: 'Omega' });   // two orders
    await mkCart(10); await mkOrder(10, { cancelled: true });                               // cancelled
    await mkCart(11); await mkOrder(11, { fin: 'REFUNDED' });                               // refunded
    await mkCart(12); const o12 = await mkOrder(12, { snapshot: false });                   // no financial record
    const fx0 = await fx();
    const report = async (q = {}) => {
      const r = await internal('adm', 'GET', `/api/recovery-verification?${new URLSearchParams(q)}`);
      if (r.status !== 200) throw new Error(`report ${r.status} ${JSON.stringify(r.body)}`);
      return { ...r.body, mine: Object.fromEntries(r.body.results.filter((x) => Object.values(cartIds).includes(x.cartId)).map((x) => [Object.keys(cartIds).find((k) => cartIds[k] === x.cartId), x])) };
    };
    let rep = await report();
    const st = (n) => rep.mine[n]?.status;
    const want = { 1: 'verified_paid', 2: 'verified_paid', 3: 'verified_placed', 4: 'no_match', 5: 'possible', 6: 'needs_review', 7: 'needs_review', 8: 'needs_review', 10: 'cancelled_refunded', 11: 'cancelled_refunded', 12: 'verified_placed' };
    for (const [n, w] of Object.entries(want)) if (st(n) !== w) bad.push(`cart ${n}: ${st(n)} ≠ ${w} (${rep.mine[n]?.reason})`);
    if (rep.mine[2]?.order?.id !== o2 || rep.mine[2].tier !== 'phone+product' || rep.mine[1]?.order?.id !== o1 || rep.mine[1].tier !== 'identifier') bad.push('matched orders');
    if (rep.mine[12]?.order?.payment !== 'unknown' || rep.mine[3]?.order?.payment !== 'pending' || rep.mine[5]?.recoveryTimeRecorded !== false) bad.push('payment / time flags');
    if (rep.mine[2].products?.[0]?.sku !== `${TS}-RV` || rep.mine[2].agent !== 'RV Agent' || rep.mine[2].cartValue !== 1299 || !rep.mine[2].recoveredAt) bad.push('cart fields');
    // Refresh: the same answer, nothing stored, nothing doubled.
    const again = await report();
    if (JSON.stringify(again.summary) !== JSON.stringify(rep.summary) || again.results.length !== rep.results.length) bad.push('refresh changed the report');
    // Summary over this run's carts (filter by this agent): orders 1 and 2 paid at Shopify's current total, each once.
    const mineSum = summarise(Object.values(rep.mine).map((x) => ({ status: x.status, matchedOrder: x.order ? { id: x.order.id, current_total_price: x.order.value, shop_currency: x.order.currency } : null })));
    if (mineSum.paidOrders !== 2 || mineSum.revenue[0]?.amount !== 2598 || mineSum.pendingOrders !== 2) bad.push(`summary ${JSON.stringify(mineSum)}`);
    const agentRep = await report({ agent: 'RV Agent' });
    if (agentRep.results.some((x) => x.agent !== 'RV Agent') || agentRep.summary.recovered < 11) bad.push('agent filter');
    const day = new Date(now + 5.5 * 3600000).toISOString().slice(0, 10);
    const ranged = await report({ from: day, to: day });
    if (ranged.mine[5] || !ranged.summary.excludedNoRecoveryTime) bad.push('a cart without a recovery time was put in a date range');
    // Decisions: confirm order 6 for cart 6 → cart 7 loses it; the same order for cart 7 refused; a non-candidate refused; revert restores.
    const dec = (body, who = 'adm') => internal(who, 'POST', '/api/recovery-verification/decisions', body);
    const c1 = await dec({ cart_id: cartIds[6], order_id: o6, decision: 'confirmed', note: 'customer confirmed on the phone' });
    rep = await report();
    if (c1.status !== 201 || rep.mine[6].status !== 'verified_paid' || rep.mine[6].tier !== 'manual' || rep.mine[7].status !== 'no_match') bad.push(`confirm ${c1.status} ${rep.mine[6]?.status} ${rep.mine[7]?.status}`);
    const mineTotals = (rp) => summarise(Object.values(rp.mine).map((x) => ({ status: x.status, tier: x.tier, matchedOrder: x.order ? { id: x.order.id, current_total_price: x.order.value, shop_currency: x.order.currency } : null })));
    const afterConfirm = mineTotals(rep);
    if (afterConfirm.paidOrders !== 3 || afterConfirm.revenue[0].amount !== 3897 || afterConfirm.basis.paidConfirmed !== 1 || afterConfirm.basis.paidAutomatic !== 2) bad.push(`revenue after confirm ${JSON.stringify(afterConfirm)}`);
    if ((await dec({ cart_id: cartIds[7], order_id: o6, decision: 'confirmed' })).status !== 409) bad.push('the same order confirmed for a second cart');
    if ((await dec({ cart_id: cartIds[3], order_id: o12, decision: 'confirmed' })).status !== 409) bad.push('a non-candidate confirmed');
    const { rows: [d] } = await db.query('SELECT id, auto_result, decided_by FROM recovery_match_decisions WHERE cart_id = $1 AND reverted_at IS NULL', [cartIds[6]]);
    if (d.auto_result.status !== 'needs_review' || !d.decided_by) bad.push('original automatic result not kept');
    await expectErr('decision edit', () => db.query(`UPDATE recovery_match_decisions SET note = 'x' WHERE id = $1`, [d.id]), (e) => /reverted/.test(e.message));
    await expectErr('decision delete', () => db.query('DELETE FROM recovery_match_decisions WHERE id = $1', [d.id]), (e) => /append-only/.test(e.message));
    if ((await internal('adm', 'POST', `/api/recovery-verification/decisions/${d.id}/revert`, {})).status !== 200) bad.push('revert');
    if ((await internal('adm', 'POST', `/api/recovery-verification/decisions/${d.id}/revert`, {})).status !== 404) bad.push('reverted twice');
    rep = await report();
    if (rep.mine[6].status !== 'needs_review') bad.push('revert did not restore the automatic result');
    const afterRevert = mineTotals(rep);
    if (afterRevert.paidOrders !== 2 || afterRevert.revenue[0].amount !== 2598 || afterRevert.basis.paidConfirmed !== 0) bad.push(`revenue after revert ${JSON.stringify(afterRevert)}`);
    const hist = (await internal('adm', 'GET', `/api/recovery-verification/carts/${cartIds[6]}/decisions`)).body.decisions;
    if (hist.length !== 1 || !hist[0].reverted_at || !hist[0].reverted_by) bad.push('history lost the reverted decision');
    // Reject one of cart 8's two orders → one candidate left, with no shared product → a possible match only.
    const r8 = (await report()).mine[8].candidates.find((x) => x.order.products[0]?.title === 'Omega');
    await dec({ cart_id: cartIds[8], order_id: r8.order.id, decision: 'rejected', note: 'different product' });
    if ((await report()).mine[8].status === 'needs_review') bad.push('rejection not applied');
    // Admin only: page, report and decisions; agents and others refused.
    for (const who of ['mgr', 'multi', 'nonHr']) {
      if ((await internal(who, 'GET', '/api/recovery-verification')).status !== 403 || (await dec({ cart_id: cartIds[3], order_id: o3, decision: 'confirmed' }, who)).status !== 403) bad.push(`${who} reached the report or decisions`);
      const pg = await internal(who, 'GET', '/recovery-verification');
      if (pg.status === 200) bad.push(`${who} opened the page`);
    }
    // Nothing else changed: cart statuses, orders, stock, shipments, attribution.
    const { rows: carts } = await db.query('SELECT status FROM abandoned_carts WHERE id = ANY($1)', [Object.values(cartIds)]);
    if (carts.some((c) => c.status !== 'Called – Recovered')) bad.push('a cart status changed');
    if (JSON.stringify(await fx()) !== JSON.stringify(fx0)) bad.push(`side effects ${JSON.stringify([fx0, await fx()])}`);
  } finally {
    const c = await db.connect();
    try {
      await c.query('BEGIN'); await c.query(`SET LOCAL app.purge_recovery = 'on'`);
      await c.query('DELETE FROM recovery_match_decisions WHERE cart_id = ANY($1)', [Object.values(cartIds)]);
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
    await db.query('DELETE FROM abandoned_carts WHERE id = ANY($1)', [Object.values(cartIds)]);
    await purgeTestOrders(`gid://shopify/Order/${RV_NUM}`);
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'identifier → paid; +91 phone + SKU → paid; pending; after the window → none; no recovery time → possible (and left out of a date range); one order for two carts and two orders for one cart → needs review; cancelled and refunded; no financial record → order placed, payment unknown, no revenue; refresh identical; paid revenue each order once at Shopify\'s current total; agent filter; confirm takes the order from the other cart, a second confirmation and a non-candidate refused, original automatic result kept, decisions not editable/deletable, revert once restores it, history keeps it; rejection applied; non-admins refused (API, decisions, page); cart statuses, orders, stock, shipments, attribution unchanged';
});

await step('recovery verification: decisions and revenue — confirmed and automatic matches counted once each and reported apart; an order confirmed for one cart is never another cart\'s (identifier included); reject/revert move revenue exactly; possible/needs-review never counted', async () => {
  const bad = [];
  const T = Date.parse('2026-10-05T10:00:00Z'); const at = (h) => new Date(T + h * 3600000).toISOString();
  const cart = (id, o = {}) => ({ id, phone: o.phone ?? `98765100${String(id).padStart(2, '0')}`, abandoned_at: at(-5), received_at: at(-5), marked_at: at(0), items: [], recovered_order_name: o.oname || null });
  const order = (id, o = {}) => ({ id, shopify_name: o.name || `#${id}`, legacy_id: String(id), customer_phone: o.phone ?? null, order_date: at(2), financial_status: o.fin || 'PAID', current_total_price: o.value ?? 1000, shop_currency: 'INR', lines: [] });
  const sum = (carts, orders, dec = []) => { const res = matchRecoveries(carts, orders, dec); return { res: Object.fromEntries(res.map((r) => [r.cart.id, r])), s: summarise(res) }; };
  // Cart 1 has GoKwik's order #X on it; a person confirmed #X for cart 2 → cart 1 is not also verified for it.
  let { res, s } = sum([cart(1, { phone: '', oname: '#X' }), cart(2)], [order(500, { name: '#X', phone: '9876510002' })], [{ decision: 'confirmed', cart_id: 2, order_id: 500 }]);
  if (res[2].status !== 'verified_paid' || res[2].tier !== 'manual' || res[1].status !== 'needs_review' || res[1].matchedOrder) bad.push(`identifier vs confirmation ${res[1].status}`);
  if (s.paidOrders !== 1 || s.revenue[0].amount !== 1000 || s.basis.paidConfirmed !== 1 || s.basis.paidAutomatic !== 0) bad.push(`once ${JSON.stringify(s)}`);
  // Automatic + confirmed together: reported apart, each order once.
  ({ res, s } = sum([cart(3), cart(4)], [order(501, { phone: '9876510003', value: 700 }), order(502, { phone: '9876510004', value: 300, fin: 'PENDING' })], [{ decision: 'confirmed', cart_id: 4, order_id: 502 }]));
  if (s.verifiedOrders !== 2 || s.basis.verifiedAutomatic !== 1 || s.basis.verifiedConfirmed !== 1 || s.paidOrders !== 1 || s.revenue[0].amount !== 700 || s.pendingOrders !== 1) bad.push(`basis ${JSON.stringify(s)}`);
  // Never counted: possible and needs review (even when they have candidate orders).
  ({ res, s } = sum([cart(5, { phone: '9876510055' }), cart(6, { phone: '9876510055' }), { ...cart(7), marked_at: null }], [order(503, { phone: '9876510055' }), order(504, { phone: '9876510007', value: 900 })]));
  if (res[5].status !== 'needs_review' || res[7].status !== 'possible' || s.verifiedOrders !== 0 || s.revenue.length) bad.push(`uncounted ${JSON.stringify(s)}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'an order confirmed for one cart is never also another cart\'s (the identifier path too) → that cart needs review; one paid order = one count and ₹1,000 once; automatic and confirmed orders counted apart (verified 1+1, paid 1 automatic); possible and needs-review orders never in any total';
});

await step('recovery verification: schema at start-up — the phone index exists once, valid, created only when missing; repeat and concurrent setup are no-ops; the page labels orders placed before / after the cart was marked Recovered and never presents a confirmation as proof', async () => {
  const bad = [];
  await Promise.all([ensureRecoverySchema(), ensureRecoverySchema()]);
  const { rows } = await getPool().query(`SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'orders_website_phone10_idx'`);
  if (rows.length !== 1 || !rows[0].indisvalid || !/WHERE \(channel = 'website'::text\)/.test(rows[0].def)) bad.push(`index ${JSON.stringify(rows)}`);
  const lib = await fsp.readFile(new URL('../lib/recovery-verification.js', import.meta.url), 'utf8');
  if (!/FROM pg_indexes WHERE schemaname = current_schema\(\) AND indexname = 'orders_website_phone10_idx'/.test(lib) || !/\['42P07', '23505'\]\.includes\(err\.code\)/.test(lib)) bad.push('index not created only-when-missing / race-tolerant');
  const server = await fsp.readFile(new URL('../server.js', import.meta.url), 'utf8');
  if (!/ensureRecoverySchema\(\)\s*\.then\(\(\) => console\.log\('Recovery verification schema ready'\)\)/.test(server)) bad.push('not set up at start-up');
  const js = await fsp.readFile(new URL('../public/recovery.js', import.meta.url), 'utf8');
  for (const t of ['Ordered before marked Recovered', 'Ordered after marked Recovered', 'Recovery time not recorded', 'Confirmed by a person',
    'It does not show that the call caused the purchase.', 'not that the call caused the sale', 'confirmed by a person (paid:', 'Possible matches and those needing review are never counted.']) if (!js.includes(t)) bad.push(`page text: ${t}`);
  if ((js.match(/timing\(/g) || []).length < 3) bad.push('timing not shown in the table and the candidates');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'one valid partial index (channel = website); setup checks pg_indexes first and tolerates a concurrent creator; run at start-up in the background (requests wait on the same promise); page: before/after/not-recorded labels in the table and on every candidate; confirmation worded as recording the match, not causation; the summary says which orders were rule-matched vs confirmed';
});

await step('call board: Recovered tab green, Lost tab red (text, count, selected); other tabs unchanged; Recovery verification linked for admins only', async () => {
  const bad = [];
  const js = await fsp.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = await fsp.readFile(new URL('../public/ui.css', import.meta.url), 'utf8');
  const html = await fsp.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const nav = await fsp.readFile(new URL('../public/ui/components.js', import.meta.url), 'utf8');
  if (!/const outcome = key === 'recovered' \? ' tab-recovered' : key === 'lost' \? ' tab-lost' : '';/.test(js) || !/class="tab\$\{outcome\}/.test(js)) bad.push('outcome classes not limited to Recovered / Lost');
  for (const [cls, tone] of [['tab-recovered', 'success'], ['tab-lost', 'error']]) {
    if (!new RegExp(`\\.tab\\.${cls} \\{ color: var\\(--${tone}-text\\); \\}`).test(css)) bad.push(`${cls} text`);
    if (!new RegExp(`\\.tab\\.${cls}\\.active \\{ background: var\\(--${tone}-soft\\);[^}]*color: var\\(--${tone}-text\\); \\}`).test(css)) bad.push(`${cls} selected`);
    if (!new RegExp(`\\.tab\\.${cls} \\.tab-count[^{]*\\{[^}]*color: var\\(--${tone}-text\\); background: var\\(--${tone}-soft\\)`).test(css)) bad.push(`${cls} count`);
  }
  if (/\.tab\.active \{[^}]*success|\.tab \{[^}]*(success|error)/.test(css)) bad.push('the base tab style changed');
  if (!/<a class="verify-link" id="verifyLink" href="\/recovery-verification" hidden>/.test(html) || !/verify\.hidden = !\(IS_ADMIN && state\.view === 'recovered' && !state\.query\)/.test(js)) bad.push('verification link');
  if (!/admin \? navLink\('\/recovery-verification', 'Recovery verification'\) : ''/.test(nav)) bad.push('nav link not admin-only');
  const page = await fsp.readFile(new URL('../public/recovery.js', import.meta.url), 'utf8');
  for (const t of ['Carts marked Recovered', 'Verified Shopify orders', 'Verified paid orders', 'Pending-payment orders', 'Unmatched carts', 'Ambiguous matches', 'Paid order revenue', 'Average paid order', 'Revenue per recovered cart']) if (!page.includes(t)) bad.push(`summary label ${t}`);
  const pageHtml = await fsp.readFile(new URL('../public/recovery.html', import.meta.url), 'utf8');
  if (!/revenue <b>associated with<\/b> recovered carts — not proof that support caused it/.test(pageHtml)) bad.push('revenue caveat');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'only Recovered (green: text, count pill, selected background) and Lost (red) get outcome classes; base tab style untouched; "Verify against Shopify orders" shown on the Recovered tab to admins; sidebar link admin-only; page summary labels and the "associated with, not caused by" caveat present';
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
    for (const k of ['logistics', 'inventory', 'support', 'hr', 'team']) if (!ov.sections[k]?.ok) bad.push(`${k} affected`);
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

/* ------------------------------------------------------------------ affiliates admin (Phase 1C) */
// Members holding only an affiliate role (or none), on the running test server; HRM.adm is an admin.
const AFP = { viewer: '919000000401', manager: '919000000402', finance: '919000000403', none: '919000000404' };
const AFN = { viewer: 'DBCHECK-AF viewer', manager: 'DBCHECK-AF manager', finance: 'DBCHECK-AF finance', none: 'DBCHECK-AF none' };
const AFC = {};
const af = async (who, method, p, body) => {
  const headers = { 'content-type': 'application/json' };
  const phone = who === 'adm' ? HRM.adm : AFP[who];
  if (phone) headers.cookie = `${SESSION_COOKIE}=${issueSession(phone)}`;
  const r = await fetch(`${HRS.base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
};
const afEvents = async (pid) => (await getPool().query(
  `SELECT e.action, e.actor, e.metadata FROM affiliate_events e JOIN affiliates a ON a.id = e.affiliate_id WHERE a.public_id = $1 ORDER BY e.id`, [pid])).rows;

await step('affiliates admin: RBAC — viewer and finance read only, manager and admin manage, others refused (API and pages)', async () => {
  const bad = [];
  // These members are about affiliate access, not the profile gate (tested elsewhere): given complete profiles below.
  await getPool().query(`INSERT INTO allowed_users (phone, name, is_admin, added_by, profile_required) VALUES ($1,$5,false,'db-check',false),($2,$6,false,'db-check',false),
    ($3,$7,false,'db-check',false),($4,$8,false,'db-check',false) ON CONFLICT (phone) DO NOTHING`, [...Object.values(AFP), ...Object.values(AFN)]);
  await completeTestProfiles();   // every member is held until complete now; these test affiliate access, not the profile step
  await getPool().query(`INSERT INTO member_module_roles (phone, module, role) VALUES ($1,'affiliate','viewer'),($2,'affiliate','manager'),($3,'affiliate','finance'),($4,'logistics','viewer')
    ON CONFLICT (phone, module) DO UPDATE SET role = EXCLUDED.role`, Object.values(AFP));
  const made = await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF RBAC partner', category: 'influencer' });
  if (made.status !== 201) throw new Error(`manager create ${made.status} ${JSON.stringify(made.body)}`);
  AFC.rbac = made.body.affiliate.public_id;
  const P = AFC.rbac;
  const M = [
    ['GET', '/api/affiliates', null, { viewer: 200, manager: 200, finance: 200, adm: 200, none: 403, '': 401 }],
    ['GET', `/api/affiliates/${P}`, null, { viewer: 200, finance: 200, adm: 200, none: 403, '': 401 }],
    ['GET', `/api/affiliates/${P}/events`, null, { viewer: 200, none: 403 }],
    ['GET', '/api/affiliates/meta', null, { viewer: 200, none: 403 }],
    ['POST', '/api/affiliates', { display_name: 'DBCHECK-AF refused', category: 'creator' }, { viewer: 403, finance: 403, none: 403, '': 401 }],
    ['PATCH', `/api/affiliates/${P}`, { display_name: 'DBCHECK-AF hijack' }, { viewer: 403, finance: 403, none: 403, '': 401 }],
    ['POST', `/api/affiliates/${P}/status`, { action: 'activate' }, { viewer: 403, finance: 403, none: 403 }],
    ['POST', `/api/affiliates/${P}/rates`, { rate_percent: '10', reason: 'probe' }, { viewer: 403, finance: 403, none: 403 }],
    ['POST', '/api/affiliates', { display_name: 'DBCHECK-AF by admin', category: 'creator' }, { adm: 201 }],
    ['PATCH', `/api/affiliates/${P}`, { display_name: 'DBCHECK-AF RBAC partner (edited)' }, { manager: 200 }],
  ];
  for (const [m, p, b, exp] of M) for (const [who, want] of Object.entries(exp)) {
    const r = await af(who || null, m, p, b);
    if (r.status !== want) bad.push(`${who || 'anon'} ${m} ${p}: ${r.status} ≠ ${want}`);
    if (r.status === 403 && r.body?.ok !== false) bad.push(`${who} ${m} ${p}: 403 without the standard error body`);
  }
  if ((await af('viewer', 'GET', `/api/affiliates/${P}`)).body.affiliate.display_name !== 'DBCHECK-AF RBAC partner (edited)') bad.push('refused edit was applied');
  if ((await af('viewer', 'GET', '/api/affiliates/meta')).body.canManage !== false || (await af('manager', 'GET', '/api/affiliates/meta')).body.canManage !== true
    || (await af('finance', 'GET', '/api/affiliates/meta')).body.canManage !== false || (await af('adm', 'GET', '/api/affiliates/meta')).body.canManage !== true) bad.push('meta canManage');
  // Pages: affiliate.view only; an affiliate-only member's home is /affiliates (no redirect loop via /no-access).
  for (const [who, p, want, loc] of [['viewer', '/affiliates', 200], ['viewer', `/affiliates/${P}`, 200], ['finance', '/affiliates', 200], ['adm', '/affiliates', 200],
    ['none', '/affiliates', 302, '/orders'], ['', '/affiliates', 302, '/login'], ['viewer', '/', 302, '/affiliates'], ['viewer', '/no-access', 302, '/affiliates'],
    ['viewer', '/orders', 302, '/affiliates'], ['viewer', '/hr/jobs', 302, '/affiliates']]) {
    const r = await af(who || null, 'GET', p);
    if (r.status !== want || (loc && r.headers.get('location') !== loc)) bad.push(`${who || 'anon'} page ${p}: ${r.status} ${r.headers.get('location') || ''}`);
    if (want === 200 && !/affiliates\.js/.test(r.body)) bad.push(`${who} ${p}: not the affiliates page`);
  }
  const me = (await af('viewer', 'GET', '/auth/me')).body;
  if (!me.caps.includes('affiliate.view') || me.caps.includes('affiliate.manage')) bad.push(`viewer caps ${me.caps}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return `${M.reduce((n, x) => n + Object.keys(x[3]).length, 0)} API checks (viewer/finance read only; manager/admin manage; logistics-only 403; signed out 401) + 10 page checks; refused edit not applied`;
});

await step('affiliates admin: create and edit — server public ID, initial status by category, validation, no ID or status changes through edit', async () => {
  const bad = [];
  const mk = (body) => af('manager', 'POST', '/api/affiliates', body);
  const a = await mk({ display_name: '  DBCHECK-AF Riya   Sharma ', category: 'influencer', contact_email: 'Riya.DBCHECK@Example.test', contact_phone: '98765 43210', rate_percent: '12.5', public_id: 'AAAAAA' });
  const x = a.body.affiliate;
  if (a.status !== 201 || !/^[A-HJKMNP-Z2-9]{6}$/.test(x.public_id) || x.public_id === 'AAAAAA' || x.display_name !== 'DBCHECK-AF Riya Sharma'
    || x.contact_email !== 'riya.dbcheck@example.test' || x.contact_phone !== '+919876543210' || x.status !== 'draft' || x.current_rate_bps !== 1250) bad.push(`create ${JSON.stringify(x)}`);
  AFC.riya = x.public_id;
  const d = await mk({ display_name: 'DBCHECK-AF Dr. Anil', category: 'doctor' });
  if (d.body.affiliate?.status !== 'pending_verification' || d.body.affiliate.current_rate_bps !== null || d.body.rates.length) bad.push(`professional ${d.body.affiliate?.status}`);
  AFC.doc = d.body.affiliate.public_id;
  if (JSON.stringify([a.body, d.body]).match(/"id":|"affiliate_id"/)) bad.push('internal id exposed');
  const refused = [
    [{ category: 'creator' }, 'display_name'], [{ display_name: 'X', category: 'no_such' }, 'category'], [{ display_name: 'X' }, 'category'],
    [{ display_name: 'X', category: 'creator', contact_email: 'not-an-email' }, 'contact_email'], [{ display_name: 'X', category: 'creator', contact_phone: '12' }, 'contact_phone'],
    [{ display_name: 'X'.repeat(121), category: 'creator' }, 'display_name'],
    ...['100.01', '-1', 'abc', '1.234', '101'].map((r) => [{ display_name: 'X', category: 'creator', rate_percent: r }, 'rate']),
    [{ display_name: 'X', category: 'creator', rate_bps: 10001 }, 'rate'],
  ];
  for (const [body, field] of refused) {
    const r = await mk(body);
    if (r.status !== 400 || r.body.field !== field) bad.push(`${JSON.stringify(body).slice(0, 60)} → ${r.status} ${r.body.field}`);
  }
  await getPool().query(`UPDATE affiliate_categories SET active = false WHERE key = 'dentist'`);
  try { if ((await mk({ display_name: 'X', category: 'dentist' })).status !== 400) bad.push('inactive category accepted'); }
  finally { await getPool().query(`UPDATE affiliate_categories SET active = true WHERE key = 'dentist'`); }
  if ((await mk({ display_name: 'DBCHECK-AF zero', category: 'customer', rate_percent: '0' })).body.affiliate?.current_rate_bps !== 0) bad.push('0% refused');
  if ((await mk({ display_name: 'DBCHECK-AF full', category: 'customer', rate_percent: '100' })).body.affiliate?.current_rate_bps !== 10000) bad.push('100% refused');
  // Edit: profile fields only, with the version.
  const v = x.version;
  const e = await af('manager', 'PATCH', `/api/affiliates/${AFC.riya}`, { display_name: 'DBCHECK-AF Riya S.', contact_email: '', contact_phone: '+44 20 7946 0958', version: v });
  if (e.status !== 200 || e.body.affiliate.display_name !== 'DBCHECK-AF Riya S.' || e.body.affiliate.contact_email !== null || e.body.affiliate.contact_phone !== '+442079460958'
    || e.body.affiliate.version !== v + 1 || e.body.affiliate.public_id !== AFC.riya) bad.push(`edit ${e.status} ${JSON.stringify(e.body).slice(0, 200)}`);
  if ((await af('manager', 'PATCH', `/api/affiliates/${AFC.riya}`, { display_name: 'stale', version: v })).status !== 409) bad.push('stale version accepted');
  for (const body of [{ public_id: 'BBBBBB' }, { status: 'active' }, { rate_bps: 500 }]) {
    const r = await af('manager', 'PATCH', `/api/affiliates/${AFC.riya}`, body);
    if (r.status !== 400) bad.push(`edit ${Object.keys(body)[0]} → ${r.status}`);
  }
  const after = (await af('viewer', 'GET', `/api/affiliates/${AFC.riya}`)).body.affiliate;
  if (after.public_id !== AFC.riya || after.status !== 'draft' || after.current_rate_bps !== 1250) bad.push('edit changed id, status or rate');
  if ((await af('manager', 'PATCH', '/api/affiliates/ZZZZZZ', { display_name: 'x' })).status !== 404) bad.push('unknown public id');
  if (bad.length) throw new Error(bad.join(' | '));
  return `public ID issued by the server (client value ignored); influencer → draft, doctor → pending verification; ${refused.length + 1} invalid inputs refused with their field; 0% and 100% accepted; edit with version (stale → 409); public ID / status / rate not editable; no internal ids in responses`;
});

await step('affiliates admin: lifecycle — activate, suspend with reason, reactivate, close; invalid transitions refused; category change never verifies', async () => {
  const bad = [];
  const st = (pid, action, extra = {}) => af('manager', 'POST', `/api/affiliates/${pid}/status`, { action, ...extra });
  const R = AFC.riya;
  const act = await st(R, 'activate');
  if (act.status !== 200 || act.body.affiliate.status !== 'active' || !act.body.affiliate.activated_at) bad.push(`activate ${act.status}`);
  if ((await st(AFC.doc, 'activate')).status !== 409) bad.push('professional activated without verification');
  if ((await st(R, 'activate')).status !== 409) bad.push('active → activate accepted');
  if ((await st(R, 'reactivate')).status !== 409) bad.push('active → reactivate accepted');
  if ((await st(R, 'approve')).status !== 400) bad.push('unknown action accepted');
  const noReason = await st(R, 'suspend');
  if (noReason.status !== 400 || noReason.body.field !== 'reason') bad.push(`suspend without reason ${noReason.status}`);
  if ((await st(R, 'suspend', { reason: 'x'.repeat(301) })).status !== 400) bad.push('long reason accepted');
  const sus = await st(R, 'suspend', { reason: 'Content agreement under review' });
  const s = sus.body.affiliate;
  if (s?.status !== 'suspended' || s.suspension_reason !== 'Content agreement under review' || s.suspended_by !== AFN.manager || !s.suspended_at) bad.push(`suspend ${JSON.stringify(s).slice(0, 200)}`);
  if ((await st(R, 'suspend', { reason: 'again' })).status !== 409) bad.push('suspended → suspend accepted');
  if ((await af('viewer', 'GET', `/api/affiliates/${R}`)).body.affiliate.suspension_reason !== 'Content agreement under review') bad.push('reason not shown');
  const re = await st(R, 'reactivate');
  if (re.body.affiliate?.status !== 'active' || re.body.affiliate.suspension_reason !== null) bad.push(`reactivate → ${re.body.affiliate?.status}`);
  // Category: influencer (active) → doctor goes back to pending verification, never stays active; → creator returns to draft.
  const toDoc = await af('manager', 'PATCH', `/api/affiliates/${R}`, { category: 'doctor' });
  if (toDoc.body.affiliate?.status !== 'pending_verification' || !toDoc.body.affiliate.requires_verification) bad.push(`to professional → ${toDoc.body.affiliate?.status}`);
  if ((await st(R, 'activate')).status !== 409) bad.push('activated after a move to a professional category');
  const toCreator = await af('manager', 'PATCH', `/api/affiliates/${R}`, { category: 'creator' });
  if (toCreator.body.affiliate?.status !== 'draft') bad.push(`back to non-professional → ${toCreator.body.affiliate?.status}`);
  // A suspended professional is reactivated to pending verification at most.
  await st(R, 'activate'); await st(R, 'suspend', { reason: 'pause' });
  await af('manager', 'PATCH', `/api/affiliates/${R}`, { category: 'nutritionist' });
  const re2 = await st(R, 'reactivate');
  if (re2.body.affiliate?.status !== 'pending_verification') bad.push(`suspended professional reactivated to ${re2.body.affiliate?.status}`);
  // Close: reason required, final; nothing deleted.
  if ((await st(AFC.doc, 'close')).status !== 400) bad.push('close without reason');
  const cl = await st(AFC.doc, 'close', { reason: 'No longer practising' });
  if (cl.body.affiliate?.status !== 'closed' || cl.body.affiliate.transitions.length) bad.push(`close ${cl.body.affiliate?.status}`);
  for (const a of ['activate', 'reactivate', 'suspend', 'close']) if ((await st(AFC.doc, a, { reason: 'r' })).status !== 409) bad.push(`closed → ${a} accepted`);
  if ((await af('manager', 'PATCH', `/api/affiliates/${AFC.doc}`, { display_name: 'x' })).status !== 409) bad.push('closed affiliate edited');
  if ((await getPool().query('SELECT count(*)::int n FROM affiliates WHERE public_id = $1', [AFC.doc])).rows[0].n !== 1) bad.push('closed affiliate deleted');
  // Events, in order, with actor and reason.
  const ev = (await afEvents(R)).map((e) => e.action);
  for (const want of ['affiliate_created', 'affiliate_rate_added', 'affiliate_updated', 'affiliate_status_changed', 'affiliate_suspended', 'affiliate_reactivated']) if (!ev.includes(want)) bad.push(`no ${want}`);
  const susEv = (await afEvents(R)).find((e) => e.action === 'affiliate_suspended');
  if (susEv.actor !== AFN.manager || susEv.metadata.reason !== 'Content agreement under review' || susEv.metadata.from !== 'active' || susEv.metadata.to !== 'suspended') bad.push('suspend event');
  if (!(await afEvents(AFC.doc)).some((e) => e.action === 'affiliate_closed' && e.metadata.reason === 'No longer practising')) bad.push('close event');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'draft → active (activated_at); professional cannot activate; suspend needs a reason (recorded with actor and time), reactivate restores the previous state; active influencer → doctor = pending verification; suspended professional → pending at most; close needs a reason, is final, deletes nothing; 9 invalid transitions refused; events recorded';
});

await step('affiliates admin: rates — initial, added, scheduled; old rates kept; duplicate, past, out-of-range and reasonless refused', async () => {
  const bad = [];
  const R = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF rates', category: 'creator', rate_percent: '10' })).body.affiliate.public_id;
  AFC.rates = R;
  const add = (body) => af('manager', 'POST', `/api/affiliates/${R}/rates`, body);
  const first = (await getPool().query('SELECT r.* FROM affiliate_rates r JOIN affiliates a ON a.id = r.affiliate_id WHERE a.public_id = $1', [R])).rows;
  if (first.length !== 1 || first[0].rate_bps !== 1000 || first[0].reason !== 'Initial rate') bad.push('initial rate');
  const now = await add({ rate_percent: '12.75', reason: 'Renegotiated' });
  if (now.status !== 201 || now.body.affiliate.current_rate_bps !== 1275 || now.body.rates.length !== 2) bad.push(`add ${now.status} ${now.body.affiliate?.current_rate_bps}`);
  const future = new Date(Date.now() + 10 * 86400000); future.setUTCMilliseconds(0);
  const sch = await add({ rate_percent: '15', reason: 'From next campaign', effective_from: future.toISOString() });
  if (sch.status !== 201 || sch.body.affiliate.current_rate_bps !== 1275 || sch.body.rates.find((r) => r.rate_bps === 1500)?.state !== 'scheduled') bad.push('scheduled rate');
  const dup = await add({ rate_percent: '16', reason: 'dup', effective_from: future.toISOString() });
  if (dup.status !== 409 || dup.body.field !== 'effective_from') bad.push(`duplicate effective date ${dup.status}`);
  const refused = [[{ rate_percent: '20', reason: 'past', effective_from: new Date(Date.now() - 86400000).toISOString() }, 'effective_from'],
    [{ rate_percent: '20', reason: 'far', effective_from: new Date(Date.now() + 400 * 86400000).toISOString() }, 'effective_from'],
    [{ rate_percent: '20', reason: 'bad date', effective_from: 'tomorrow' }, 'effective_from'],
    [{ rate_percent: '100.5', reason: 'r' }, 'rate'], [{ rate_bps: -1, reason: 'r' }, 'rate'], [{ rate_bps: 10001, reason: 'r' }, 'rate'], [{ reason: 'r' }, 'rate'],
    [{ rate_percent: '20' }, 'reason'], [{ rate_percent: '20', reason: 'x'.repeat(301) }, 'reason']];
  for (const [body, field] of refused) {
    const r = await add(body);
    if (r.status !== 400 || r.body.field !== field) bad.push(`${JSON.stringify(body).slice(0, 50)} → ${r.status} ${r.body.field}`);
  }
  // Earlier rows unchanged (same ids and values); history only grows; never on the affiliate row.
  const all = (await getPool().query('SELECT r.* FROM affiliate_rates r JOIN affiliates a ON a.id = r.affiliate_id WHERE a.public_id = $1 ORDER BY r.effective_from', [R])).rows;
  if (all.length !== 3 || all[0].id !== first[0].id || all[0].rate_bps !== 1000 || String(all[0].effective_from) !== String(first[0].effective_from)) bad.push(`history ${all.map((r) => r.rate_bps)}`);
  if (all[1].created_by !== AFN.manager || all[1].reason !== 'Renegotiated') bad.push('actor / reason');
  const ev = (await afEvents(R)).filter((e) => e.action === 'affiliate_rate_added').map((e) => e.metadata.rate_bps);
  if (ev.join() !== '1000,1275,1500') bad.push(`rate events ${ev}`);
  if ((await af('viewer', 'GET', '/api/affiliates?q=DBCHECK-AF rates')).body.affiliates[0]?.current_rate_bps !== 1275) bad.push('list current rate');
  // Closed: no new rate.
  await af('manager', 'POST', `/api/affiliates/${R}/status`, { action: 'close', reason: 'done' });
  if ((await add({ rate_percent: '5', reason: 'after close' })).status !== 409) bad.push('rate added to a closed affiliate');
  if (bad.length) throw new Error(bad.join(' | '));
  return `10% initial → 12.75% now → 15% scheduled (current stays 12.75%); earlier rows unchanged; duplicate start 409; ${refused.length} invalid rates/dates/reasons refused; one event per rate; closed affiliate gets no rate`;
});

await step('affiliates admin: search, filters, whitelisted sort and paging', async () => {
  const bad = [];
  for (let i = 1; i <= 55; i += 1) {
    await createAffiliate({ display_name: `DBCHECK-AF bulk ${String(i).padStart(2, '0')}`, category: i % 2 ? 'customer' : 'creator',
      contact_email: `bulk${i}.dbcheck@example.test`, contact_phone: `+9198000${String(10000 + i).slice(-5)}` }, { actor: AFN.manager });
  }
  const list = async (qs) => (await af('viewer', 'GET', `/api/affiliates?${qs}`)).body;
  const names = (r) => r.affiliates.map((a) => a.display_name);
  const riya = (await af('viewer', 'GET', `/api/affiliates/${AFC.riya}`)).body.affiliate;
  const checks = [
    ['q=DBCHECK-AF bulk 07', (r) => r.total === 1 && names(r)[0] === 'DBCHECK-AF bulk 07'],
    ['q=bulk12.dbcheck@example', (r) => r.total === 1 && names(r)[0] === 'DBCHECK-AF bulk 12'],
    ['q=9800010033', (r) => r.total === 1 && names(r)[0] === 'DBCHECK-AF bulk 33'],
    ['q=98000-10033', (r) => r.total === 1],
    [`q=${riya.public_id.toLowerCase()}`, (r) => r.total === 1 && r.affiliates[0].public_id === riya.public_id],
    ['q=%25', (r) => r.total === 0],
    ['q=DBCHECK-AF bulk&category=creator', (r) => r.total === 27 && r.affiliates.every((a) => a.category === 'creator')],
    ['q=DBCHECK-AF&status=closed', (r) => r.total >= 2 && r.affiliates.every((a) => a.status === 'closed')],
    ['q=DBCHECK-AF bulk&status=draft&category=customer', (r) => r.total === 28],
    ['q=DBCHECK-AF bulk&sort=name&dir=asc', (r) => r.total === 55 && r.affiliates.length === 50 && names(r)[0] === 'DBCHECK-AF bulk 01' && names(r)[49] === 'DBCHECK-AF bulk 50'],
    ['q=DBCHECK-AF bulk&sort=name&dir=asc&offset=50', (r) => r.affiliates.length === 5 && names(r)[4] === 'DBCHECK-AF bulk 55'],
    ['q=DBCHECK-AF bulk&sort=name&dir=desc&limit=3', (r) => names(r).join() === 'DBCHECK-AF bulk 55,DBCHECK-AF bulk 54,DBCHECK-AF bulk 53'],
    ['q=DBCHECK-AF bulk&limit=1000', (r) => r.limit === 100 && r.affiliates.length === 55],
    ['q=DBCHECK-AF bulk&sort=display_name;DROP TABLE affiliates&dir=sideways', (r) => r.total === 55],
    ['q=DBCHECK-AF bulk&sort=__proto__', (r) => r.total === 55],
    ['q=zzzz-no-such-partner', (r) => r.total === 0 && r.affiliates.length === 0 && r.kpis.total >= 55],
  ];
  for (const [qs, ok] of checks) {
    const r = await list(qs);
    try { if (!ok(r)) bad.push(`${qs}: total ${r.total}, first ${names(r)[0]}`); } catch (err) { bad.push(`${qs}: ${err.message}`); }
  }
  if ((await af('viewer', 'GET', '/api/affiliates?status=verified')).status !== 400) bad.push('unknown status accepted');
  const k = (await list('limit=1')).kpis;
  const counts = Object.fromEntries((await getPool().query('SELECT status, count(*)::int n FROM affiliates GROUP BY status')).rows.map((r) => [r.status, r.n]));
  if (k.total !== Object.values(counts).reduce((a, b) => a + b, 0) || k.active !== (counts.active || 0) || k.suspended !== (counts.suspended || 0)
    || k.pending_verification !== (counts.pending_verification || 0)) bad.push(`kpis ${JSON.stringify(k)}`);
  if ((await getPool().query('SELECT count(*)::int n FROM affiliates')).rows[0].n < 55) bad.push('bulk not created');
  if (bad.length) throw new Error(bad.join(' | '));
  return `55 partners: search by name, email, phone (any punctuation) and public ID; LIKE wildcards literal; category / status filters combine; pages of 50 (50 + 5), limit capped at 100; sort whitelisted (injection and __proto__ fall back); unknown status 400; KPIs match the table`;
});

await step('affiliates admin: events — every change audited, append-only, readable, no personal data or secrets', async () => {
  const bad = [];
  const { rows } = await getPool().query(`SELECT e.* FROM affiliate_events e JOIN affiliates a ON a.id = e.affiliate_id WHERE a.display_name LIKE 'DBCHECK-AF%'`);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['affiliate_created', 'affiliate_updated', 'affiliate_status_changed', 'affiliate_suspended', 'affiliate_reactivated', 'affiliate_rate_added', 'affiliate_closed']) if (!actions.has(a)) bad.push(`missing ${a}`);
  if (rows.some((r) => !r.actor || !r.at)) bad.push('event without actor or time');
  const meta = JSON.stringify(rows.map((r) => r.metadata));
  if (/@example\.test|\+?9198|\+4420|9876543210|crb_session|session|token|password|otp|secret/i.test(meta)) bad.push('personal data or secret in event metadata');
  const one = rows.find((r) => r.action === 'affiliate_updated');
  await expectErr('update event', () => getPool().query('UPDATE affiliate_events SET metadata = $2 WHERE id = $1', [one.id, '{}']), (e) => /append-only/.test(e.message));
  await expectErr('delete event', () => getPool().query('DELETE FROM affiliate_events WHERE id = $1', [one.id]), (e) => /append-only/.test(e.message));
  // The API gives readable summaries, never raw metadata.
  const ev = (await af('viewer', 'GET', `/api/affiliates/${AFC.riya}/events`)).body.events;
  if (!ev.length || ev.some((e) => 'metadata' in e || !e.label || typeof e.summary !== 'string')) bad.push('events API shape');
  if (!ev.some((e) => /Active → Suspended · Reason: Content agreement under review/.test(e.summary))) bad.push(`summary ${ev.map((e) => e.summary).join(' / ')}`);
  if (!ev.some((e) => e.action === 'affiliate_updated' && /Changed .*email/.test(e.summary))) bad.push('update summary');
  if (bad.length) throw new Error(bad.join(' | '));
  return `${rows.length} events across ${actions.size} actions, each with actor and time; contact values never logged (field names only); UPDATE/DELETE refused; API returns summaries, not raw JSON`;
});

/* ------------------------------------------------------------------ professional verification (Phase 1D) */
const PV = {};
const pvUpload = (who, pid, buf, name, q = 'type=certificate') => (async () => {
  const headers = { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) };
  const phone = who === 'adm' ? HRM.adm : AFP[who];
  if (phone) headers.cookie = `${SESSION_COOKIE}=${issueSession(phone)}`;
  const r = await fetch(`${HRS.base}/api/affiliates/${pid}/verification/documents?${q}`, { method: 'POST', headers, body: buf });
  return { status: r.status, body: await r.json().catch(() => ({})) };
})();
const pvAct = (who, pid, action, body = {}) => af(who, 'POST', `/api/affiliates/${pid}/verification/${action}`, body);
const pvGet = async (pid) => (await af('viewer', 'GET', `/api/affiliates/${pid}/verification`)).body.verification;
const pvPdf = (tag = '') => Buffer.concat([Buffer.from(`%PDF-1.7\n% DBCHECK ${tag}\n`), Buffer.alloc(1500, 0x20)]);
const pvPng = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 1)]);
const PROFILE = { full_name: 'DBCHECK-AF Dr Meera Iyer', profession: 'Clinical Nutritionist', registration_number: 'IDA-12345', registration_authority: 'Indian Dietetic Association' };

await step('verification: schema — three tables, constraints, restrictive keys, one-open-application index, history triggers; idempotent; nothing seeded', async () => {
  const bad = [];
  const { ensureAffiliateVerificationSchema: ensureV } = await import('../lib/affiliate-verification.js');
  await ensureV(); await ensureV();
  const q = async (sql, p = []) => (await getPool().query(sql, p)).rows;
  for (const t of ['professional_profiles', 'verification_applications', 'professional_documents']) {
    if (!(await q('SELECT to_regclass($1) AS t', [t]))[0].t) bad.push(`${t} missing`);
  }
  const fks = await q(`SELECT conrelid::regclass::text AS t, confrelid::regclass::text AS ref, confdeltype FROM pg_constraint
    WHERE contype = 'f' AND conrelid::regclass::text IN ('professional_profiles', 'verification_applications', 'professional_documents')`);
  const want = [['professional_profiles', 'affiliates'], ['verification_applications', 'affiliates'], ['verification_applications', 'professional_profiles'],
    ['verification_applications', 'verification_applications'], ['professional_documents', 'verification_applications']];
  for (const [t, ref] of want) if (!fks.some((f) => f.t === t && f.ref === ref && (f.confdeltype === 'r' || (t === ref && f.confdeltype === 'a')))) bad.push(`FK ${t} → ${ref} restrictive`);
  const cons = (await q(`SELECT conname FROM pg_constraint WHERE conrelid::regclass::text IN ('professional_profiles', 'verification_applications', 'professional_documents')`)).map((r) => r.conname);
  for (const c of ['professional_profiles_affiliate_key', 'verification_applications_status_check', 'verification_applications_rejection_reason', 'verification_applications_decided',
    'verification_applications_submitted', 'professional_documents_storage_key_key', 'professional_documents_type_check', 'professional_documents_dates', 'verification_applications_public_id_key']) {
    if (!cons.includes(c)) bad.push(`constraint ${c}`);
  }
  const idx = await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'verification_applications_one_active'`);
  if (!/UNIQUE/.test(idx[0]?.indexdef || '') || !/WHERE/.test(idx[0]?.indexdef || '')) bad.push('partial unique index');
  const trig = (await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%_guard'`)).map((r) => r.tgname);
  for (const t of ['professional_profiles_guard', 'verification_applications_guard', 'professional_documents_guard']) if (!trig.includes(t)) bad.push(`trigger ${t}`);
  const cols = (await q(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name = 'professional_documents'`));
  if (cols.some((c) => c.data_type === 'bytea')) bad.push('document bytes column');
  if (!cols.some((c) => c.column_name === 'expires_at' && c.data_type === 'date')) bad.push('expires_at is not a date');
  const before = (await q(`SELECT (SELECT count(*) FROM professional_profiles) + (SELECT count(*) FROM verification_applications) + (SELECT count(*) FROM professional_documents) AS n`))[0].n;
  await ensureV();
  if ((await q(`SELECT (SELECT count(*) FROM professional_profiles) + (SELECT count(*) FROM verification_applications) + (SELECT count(*) FROM professional_documents) AS n`))[0].n !== before) bad.push('schema run wrote rows');
  if (bad.length) throw new Error(bad.join(' | '));
  return '3 tables; 5 RESTRICT foreign keys; 9 named constraints; partial unique index (one open application); 3 history triggers; no byte column; expires_at DATE; re-run writes no rows';
});

await step('verification: RBAC — view for viewer/finance, profile and documents for managers, decisions and document access for verifiers only', async () => {
  const bad = [];
  PV.pid = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Dr Meera', category: 'nutritionist' })).body.affiliate.public_id;
  const P = PV.pid;
  const matrix = [
    ['GET', `/api/affiliates/${P}/verification`, null, { viewer: 200, finance: 200, manager: 200, adm: 200, none: 403, '': 401 }],
    ['GET', `/api/affiliates/${P}/professional`, null, { viewer: 200, finance: 200, none: 403, '': 401 }],
    ['POST', `/api/affiliates/${P}/professional`, PROFILE, { viewer: 403, finance: 403, none: 403, '': 401 }],
  ];
  for (const [m, p, b, exp] of matrix) for (const [who, w] of Object.entries(exp)) {
    const r = await af(who || null, m, p, b);
    if (r.status !== w) bad.push(`${who || 'anon'} ${m} ${p.split('/').slice(-1)}: ${r.status} ≠ ${w}`);
  }
  if ((await af('manager', 'POST', `/api/affiliates/${P}/professional`, PROFILE)).status !== 201) bad.push('manager create profile');
  for (const who of ['viewer', 'finance', 'none']) if ((await pvUpload(who, P, pvPdf(), 'cert.pdf')).status !== 403) bad.push(`${who} upload`);
  if ((await pvUpload('', P, pvPdf(), 'cert.pdf')).status !== 401) bad.push('anon upload');
  const up = await pvUpload('manager', P, pvPdf('rbac'), 'meera-certificate.pdf', 'type=certificate&expires_at=2030-01-01');
  if (up.status !== 201) bad.push(`manager upload ${up.status} ${JSON.stringify(up.body)}`);
  for (const a of ['submit', 'review', 'approve', 'reject', 'resubmit', 'start']) {
    for (const who of ['viewer', 'finance', 'none']) { const r = await pvAct(who, P, a, { reason: 'x' }); if (r.status !== 403) bad.push(`${who} ${a}: ${r.status}`); }
    if ((await pvAct('', P, a)).status !== 401) bad.push(`anon ${a}`);
  }
  const v = await pvGet(P);
  const url = `/api/affiliates/${P}/verification/${v.current.ref}/documents/${v.current.documents[0].ref}`;
  for (const [who, w] of [['viewer', 403], ['finance', 403], ['none', 403], ['', 401], ['manager', 200], ['adm', 200]]) {
    const r = await af(who || null, 'GET', url);
    if (r.status !== w) bad.push(`${who || 'anon'} open document: ${r.status} ≠ ${w}`);
  }
  const caps = (await af('finance', 'GET', `/api/affiliates/${P}/verification`)).body;
  if (caps.canVerify !== false || caps.canManage !== false) bad.push('finance flags');
  const mcaps = (await af('manager', 'GET', `/api/affiliates/${P}/verification`)).body;
  if (mcaps.canVerify !== true || mcaps.canManage !== true) bad.push('manager flags');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'read: viewer/finance/manager/admin 200, logistics-only 403, signed out 401; profile + upload: manager/admin only; submit/review/approve/reject/resubmit/start: 403 for viewer, finance, others, 401 signed out; document open: manager/admin 200, viewer/finance 403';
});

await step('verification: professional profile — create, update with version, validation, non-professional and closed refused', async () => {
  const bad = [];
  const P = PV.pid;
  const v0 = await pvGet(P);
  if (v0.profile.full_name !== PROFILE.full_name || v0.profile.version !== 1 || v0.current?.status !== 'draft') bad.push('created + draft application');
  if ((await af('manager', 'POST', `/api/affiliates/${P}/professional`, PROFILE)).status !== 409) bad.push('second profile');
  const upd = await af('manager', 'PATCH', `/api/affiliates/${P}/professional`, { specialization: 'Sports nutrition', city: 'Pune', version: 1 });
  if (upd.status !== 200 || upd.body.verification.profile.specialization !== 'Sports nutrition' || upd.body.verification.profile.version !== 2) bad.push(`update ${upd.status}`);
  if ((await af('manager', 'PATCH', `/api/affiliates/${P}/professional`, { city: 'Mumbai', version: 1 })).status !== 409) bad.push('stale profile version');
  const invalid = [[{ ...PROFILE, full_name: '' }, 'full_name'], [{ ...PROFILE, profession: '  ' }, 'profession'], [{ ...PROFILE, registration_number: 'x'.repeat(81) }, 'registration_number'],
    [{ ...PROFILE, profile_notes: 'x'.repeat(1001) }, 'profile_notes']];
  const other = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Dr Two', category: 'dentist' })).body.affiliate.public_id;
  for (const [body, field] of invalid) { const r = await af('manager', 'POST', `/api/affiliates/${other}/professional`, body); if (r.status !== 400 || r.body.field !== field) bad.push(`${field}: ${r.status} ${r.body.field}`); }
  const inf = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF influencer', category: 'influencer' })).body.affiliate.public_id;
  if ((await af('manager', 'POST', `/api/affiliates/${inf}/professional`, PROFILE)).status !== 409) bad.push('profile on a non-professional');
  const infV = await pvGet(inf);
  if (infV.required !== false || infV.profile !== null || infV.current !== null || infV.applications.length) bad.push('non-professional has verification data');
  if ((await af('manager', 'POST', '/api/affiliates/ZZZZZZ/professional', PROFILE)).status !== 404) bad.push('unknown affiliate');
  await af('manager', 'POST', `/api/affiliates/${other}/status`, { action: 'close', reason: 'db-check' });
  if ((await af('manager', 'POST', `/api/affiliates/${other}/professional`, PROFILE)).status !== 409) bad.push('profile on a closed affiliate');
  const ev = (await afEvents(P)).map((e) => e.action);
  for (const e of ['professional_profile_created', 'verification_application_created', 'professional_profile_updated']) if (!ev.includes(e)) bad.push(`event ${e}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'create opens a draft application; update bumps the version, stale → 409; 4 invalid inputs refused with their field; non-professional and closed → 409, unknown → 404; no verification data for an influencer; events recorded';
});

await step('verification: documents — content-checked types, size limit, safe names, private opaque keys, metadata, authenticated audited reads', async () => {
  const bad = [];
  const P = PV.pid;
  const cases = [
    [pvPng(), 'scan.png', 'type=registration&label=Council%20card&issued_at=2024-01-01&expires_at=2026-12-31', 201],
    [Buffer.from('MZ fake'), 'cert.pdf', 'type=certificate', 415],
    [pvPdf(), 'cert.exe', 'type=certificate', 415],
    [pvPdf(), 'cert.docx', 'type=certificate', 415],
    [Buffer.alloc(0), 'cert.pdf', 'type=certificate', 400],
    [Buffer.concat([pvPdf(), Buffer.alloc(10 * 1024 * 1024)]), 'big.pdf', 'type=certificate', 413],
    [pvPdf(), 'cert.pdf', 'type=passport', 400],
    [pvPdf(), 'cert.pdf', 'type=certificate&issued_at=2025-05-01&expires_at=2025-01-01', 400],
    [pvPdf(), 'cert.pdf', 'type=certificate&expires_at=2025-02-30', 400],
    [pvPdf('traversal'), '../../../etc/passwd.pdf', 'type=certificate', 201],
  ];
  for (const [buf, name, q, want] of cases) {
    const r = await pvUpload('manager', P, buf, name, q);
    if (r.status !== want) bad.push(`${name} ${q}: ${r.status} ≠ ${want} ${r.body.error || ''}`);
  }
  const rows = (await getPool().query(`SELECT d.*, d.issued_at::text AS i, d.expires_at::text AS e FROM professional_documents d JOIN verification_applications v ON v.id = d.verification_application_id
    JOIN affiliates a ON a.id = v.affiliate_id WHERE a.public_id = $1 ORDER BY d.id`, [P])).rows;
  if (rows.length !== 3) bad.push(`documents stored ${rows.length}`);
  for (const d of rows) {
    if (!/^affiliates\/verification\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(pdf|png)$/.test(d.storage_key)) bad.push(`key ${d.storage_key}`);
    if (/passwd|cert|scan|meera/i.test(d.storage_key)) bad.push('filename in key');
    const bytes = await fsp.readFile(path.join(HRS.dir, d.storage_key)).catch(() => null);
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== d.sha256 || bytes.length !== Number(d.byte_size)) bad.push(`stored bytes ${d.public_id}`);
  }
  const png = rows.find((d) => d.content_type === 'image/png');
  if (png?.document_type !== 'registration' || png.document_label !== 'Council card' || png.i !== '2024-01-01' || png.e !== '2026-12-31' || png.uploaded_by !== AFN.manager) bad.push('metadata');
  const trav = rows.find((d) => /passwd/.test(d.original_filename));
  if (trav?.original_filename !== '.._.._.._etc_passwd.pdf') bad.push(`filename kept as ${trav?.original_filename}`);
  const v = await pvGet(P);
  const out = JSON.stringify(v);
  if (/storage_key|affiliates\/verification|"id":|sha256/.test(out)) bad.push('key, hash or id in API response');
  const doc = v.current.documents.find((d) => d.content_type === 'application/pdf');
  const before = (await afEvents(P)).filter((e) => e.action === 'professional_document_viewed').length;
  const r = await fetch(`${HRS.base}/api/affiliates/${P}/verification/${v.current.ref}/documents/${doc.ref}`, { headers: { cookie: `${SESSION_COOKIE}=${issueSession(AFP.manager)}` } });
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200 || r.headers.get('content-type') !== 'application/pdf' || r.headers.get('cache-control') !== 'private, no-store' || r.headers.get('x-content-type-options') !== 'nosniff'
    || !body.subarray(0, 4).equals(Buffer.from('%PDF'))) bad.push(`open ${r.status} ${r.headers.get('content-type')}`);
  const viewed = (await afEvents(P)).filter((e) => e.action === 'professional_document_viewed');
  if (viewed.length !== before + 1 || viewed.at(-1).actor !== AFN.manager || viewed.at(-1).metadata.document !== doc.ref || viewed.at(-1).metadata.application !== v.current.ref) bad.push('view not audited');
  if (JSON.stringify(viewed.map((e) => e.metadata)).match(/storage|affiliates\/verification|http|PDF/)) bad.push('audit holds a key, URL or content');
  // A document is only reachable through its own affiliate and application.
  const other = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Dr Three', category: 'doctor' })).body.affiliate.public_id;
  for (const u of [`/api/affiliates/${other}/verification/${v.current.ref}/documents/${doc.ref}`, `/api/affiliates/${P}/verification/AAAAAAAAAA/documents/${doc.ref}`,
    `/api/affiliates/${P}/verification/${v.current.ref}/documents/1`, `/api/affiliates/${P}/verification/${v.current.ref}/documents/../../x`]) {
    const x = await af('manager', 'GET', u);
    if (![404].includes(x.status)) bad.push(`cross lookup ${u.split('/').slice(-3).join('/')}: ${x.status}`);
  }
  const ev = (await afEvents(P)).filter((e) => e.action === 'professional_document_uploaded');
  if (ev.length !== 3 || ev.some((e) => !e.metadata.document || e.metadata.filename || JSON.stringify(e.metadata).includes('passwd'))) bad.push('upload events');
  const expiry = (await import('../lib/affiliate-verification.js')).expiryState;
  if (expiry('2026-10-06', '2026-10-07') !== 'expired' || expiry('2026-10-20', '2026-10-07') !== 'expiring_soon' || expiry('2027-01-01', '2026-10-07') !== 'valid' || expiry(null) !== null) bad.push('expiry states');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'PNG + PDF stored; fake PDF, .exe, .docx → 415, empty / bad type / bad dates → 400, >10 MB → 413; ../ names neutralised and kept as metadata only; keys opaque (affiliates/verification/YYYY-MM/uuid); bytes and sha256 match; no key, hash or id in responses; open streams no-store + nosniff and is audited; cross-affiliate / wrong application / numeric ids → 404; expiry expired / soon / valid';
});

await step('verification: lifecycle — submit, review, reject with reason, new application, approve; invalid transitions 409; affiliate approved but never auto-activated', async () => {
  const bad = [];
  const P = PV.pid;
  const s = (who, a, body) => pvAct(who, P, a, body);
  const empty = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Dr Empty', category: 'dentist' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${empty}/professional`, PROFILE);
  if ((await pvAct('manager', empty, 'submit')).status !== 409) bad.push('submit without a certificate');
  for (const a of ['review', 'approve', 'reject']) if ((await s('manager', a, { reason: 'r' })).status !== 409) bad.push(`draft → ${a}`);
  if ((await s('manager', 'resubmit')).status !== 409) bad.push('resubmit a draft');
  const sub = await s('manager', 'submit');
  const first = sub.body.verification?.current;
  if (sub.status !== 200 || first.status !== 'submitted' || first.profile_snapshot?.full_name !== PROFILE.full_name || first.submitted_by !== AFN.manager) bad.push(`submit ${sub.status}`);
  if ((await pvUpload('manager', P, pvPdf('late'), 'late.pdf')).status !== 409) bad.push('upload after submit');
  if ((await s('manager', 'approve')).status !== 409) bad.push('submitted → approve');
  if ((await s('manager', 'submit')).status !== 409) bad.push('submit twice');
  if ((await s('manager', 'review')).body.verification?.current.status !== 'under_review') bad.push('review');
  const noReason = await s('manager', 'reject', { reason: '  ' });
  if (noReason.status !== 400 || noReason.body.field !== 'reason') bad.push(`reject without reason ${noReason.status}`);
  if ((await s('manager', 'reject', { reason: 'x'.repeat(1001) })).status !== 400) bad.push('long reason');
  const rej = await s('manager', 'reject', { reason: 'Registration number does not match the certificate', notes: 'Checked IDA list' });
  PV.rejected = rej.body.verification?.current;
  if (PV.rejected?.status !== 'rejected' || PV.rejected.rejection_reason !== 'Registration number does not match the certificate' || PV.rejected.reviewed_by !== AFN.manager) bad.push('reject');
  if ((await af('viewer', 'GET', `/api/affiliates/${P}`)).body.affiliate.status !== 'pending_verification') bad.push('rejection changed the affiliate');
  if ((await s('manager', 'review')).status !== 409 || (await s('manager', 'approve')).status !== 409) bad.push('decided application moved');
  const re = await s('manager', 'resubmit', { version: PV.rejected.version });
  const v = re.body.verification;
  if (re.status !== 201 || v.current.status !== 'draft' || v.current.previous_ref !== PV.rejected.ref || v.applications.length !== 2 || v.current.documents.length) bad.push('resubmit');
  const kept = v.applications.find((x) => x.ref === PV.rejected.ref);
  if (JSON.stringify(kept) !== JSON.stringify(PV.rejected)) bad.push('rejected application changed by resubmission');
  if ((await s('manager', 'resubmit')).status !== 409) bad.push('second resubmit');
  if ((await pvUpload('manager', P, pvPdf('second'), 'meera-cert-v2.pdf', 'type=certificate&expires_at=2031-01-01')).status !== 201) bad.push('upload to the new draft');
  await s('manager', 'submit'); await s('manager', 'review');
  const ap = await s('adm', 'approve', { notes: 'Matched the IDA register' });
  const aff = (await af('viewer', 'GET', `/api/affiliates/${P}`)).body.affiliate;
  if (ap.status !== 200 || ap.body.verification.current.status !== 'approved' || ap.body.verification.current.review_notes !== 'Matched the IDA register'
    || ap.body.verification.current.reviewed_by !== 'HR admin') bad.push(`approve ${ap.status}`);
  if (aff.status !== 'approved' || aff.activated_at || !aff.transitions.includes('activate')) bad.push(`affiliate after approval: ${aff.status}`);
  if ((await getPool().query('SELECT count(*)::int n FROM affiliate_rates r JOIN affiliates a ON a.id = r.affiliate_id WHERE a.public_id = $1', [P])).rows[0].n) bad.push('a rate was created');
  if ((await s('manager', 'reject', { reason: 'late' })).status !== 409 || (await s('manager', 'start')).status !== 409) bad.push('approved application moved / restarted');
  // Activation stays the separate Phase 1C action.
  if ((await af('manager', 'POST', `/api/affiliates/${P}/status`, { action: 'activate' })).body.affiliate?.status !== 'active') bad.push('activate after approval');
  // An approved professional who is suspended comes back active, not pending.
  await af('manager', 'POST', `/api/affiliates/${P}/status`, { action: 'suspend', reason: 'pause' });
  if ((await af('manager', 'POST', `/api/affiliates/${P}/status`, { action: 'reactivate' })).body.affiliate?.status !== 'active') bad.push('approved professional not reactivated to active');
  const ev = (await afEvents(P)).map((e) => e.action);
  for (const e of ['verification_submitted', 'verification_under_review', 'verification_rejected', 'verification_resubmitted', 'verification_approved', 'affiliate_status_changed']) if (!ev.includes(e)) bad.push(`event ${e}`);
  const rejEv = (await afEvents(P)).find((e) => e.action === 'verification_rejected');
  if (rejEv.metadata.from !== 'under_review' || rejEv.metadata.to !== 'rejected' || rejEv.metadata.reason !== 'Registration number does not match the certificate' || rejEv.actor !== AFN.manager) bad.push('reject event');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'certificate required to submit; profile copied at submit; upload locked after submit; 10 invalid transitions → 409; reason required to reject; rejection leaves the affiliate pending; new application links the rejected one, which stays byte-for-byte; approval → affiliate approved (not active, no rate), Activate is separate; approved professional reactivates to active; events with from/to/actor/reason';
});

await step('verification: history and concurrency — no deletes or edits of decisions/documents, one open application, stale versions and double decisions refused', async () => {
  const bad = [];
  const P = PV.pid;
  const q = (sql, p) => getPool().query(sql, p);
  const appId = (await q('SELECT id FROM verification_applications WHERE public_id = $1', [PV.rejected.ref])).rows[0].id;
  const docId = (await q('SELECT id FROM professional_documents WHERE verification_application_id = $1 LIMIT 1', [appId])).rows[0].id;
  await expectErr('edit decided', () => q(`UPDATE verification_applications SET rejection_reason = 'changed' WHERE id = $1`, [appId]), (e) => /final/.test(e.message));
  await expectErr('delete application', () => q('DELETE FROM verification_applications WHERE id = $1', [appId]), (e) => /never deleted/.test(e.message));
  await expectErr('edit document', () => q(`UPDATE professional_documents SET original_filename = 'x.pdf' WHERE id = $1`, [docId]), (e) => /append-only/.test(e.message));
  await expectErr('delete document', () => q('DELETE FROM professional_documents WHERE id = $1', [docId]), (e) => /never deleted/.test(e.message));
  await expectErr('delete profile', () => q(`DELETE FROM professional_profiles p USING affiliates a WHERE a.id = p.affiliate_id AND a.public_id = $1`, [P]), (e) => /never deleted/.test(e.message));
  await expectErr('delete affiliate with profile', () => q('DELETE FROM affiliates WHERE public_id = $1', [P]), (e) => ['23001', '23503'].includes(e.code) || /append-only|never/.test(e.message));
  // One open application, enforced by the database itself.
  const C = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Dr Race', category: 'doctor' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${C}/professional`, PROFILE);
  const row = (await q(`SELECT v.affiliate_id, v.professional_profile_id FROM verification_applications v JOIN affiliates a ON a.id = v.affiliate_id WHERE a.public_id = $1`, [C])).rows[0];
  await expectErr('second open application', () => q(`INSERT INTO verification_applications (public_id, affiliate_id, professional_profile_id) VALUES ('ZZZZZZZZZZ', $1, $2)`,
    [row.affiliate_id, row.professional_profile_id]), (e) => e.code === '23505');
  if ((await pvAct('manager', C, 'start')).status !== 409) bad.push('start while open');
  // Stale version and simultaneous decisions.
  await pvUpload('manager', C, pvPdf('race'), 'race.pdf');
  const sub = (await pvAct('manager', C, 'submit')).body.verification.current;
  if ((await pvAct('manager', C, 'review', { version: sub.version - 1 })).status !== 409) bad.push('stale version accepted');
  const rev = (await pvAct('manager', C, 'review', { version: sub.version })).body.verification.current;
  const results = await Promise.all([pvAct('manager', C, 'approve', { version: rev.version }), pvAct('adm', C, 'reject', { version: rev.version, reason: 'race' }),
    pvAct('manager', C, 'approve', {}), pvAct('adm', C, 'reject', { reason: 'race 2' })]);
  const okCount = results.filter((r) => r.status === 200).length;
  if (okCount !== 1 || results.some((r) => r.status !== 200 && r.status !== 409)) bad.push(`concurrent decisions: ${results.map((r) => r.status)}`);
  const decided = (await q(`SELECT count(*)::int n FROM affiliate_events e JOIN affiliates a ON a.id = e.affiliate_id WHERE a.public_id = $1 AND e.action IN ('verification_approved', 'verification_rejected')`, [C])).rows[0].n;
  if (decided !== 1) bad.push(`${decided} decision events`);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'decided application, documents and profiles cannot be edited or deleted; a second open application is refused by the unique index; stale version → 409; four simultaneous approve/reject requests → exactly one succeeds (one decision event)';
});

/* ------------------------------------------------------------------ referral assets and attribution (Phase 1E) */
const RF = {};
/** A request to the click host (go.test) of the running test server, as a browser would send it. */
const goReq = (p, { method = 'GET', cookie, ip = '203.0.113.7', ua = 'DBCHECK-UA/1.0' } = {}) => new Promise((resolve, reject) => {
  const u = new URL(HRS.base);
  const headers = { host: 'go.test', 'x-forwarded-for': ip, 'user-agent': ua };
  if (cookie) headers.cookie = cookie;
  const req = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, setCookie: res.headers['set-cookie'] || [], headers: res.headers, body: b }));
  });
  req.on('error', reject); req.end();
});
const visitorOf = (r) => (r.setCookie.find((c) => c.startsWith('bv=')) || '').split(';')[0];
const clickOf = (r) => (r.location ? new URL(r.location).searchParams.get('bclid') : null);
const refGet = async (pid, who = 'viewer') => (await af(who, 'GET', `/api/affiliates/${pid}/referral`)).body;
/** An active, eligible influencer (non-professional), with its referral link. */
const eligibleAffiliate = async (name) => {
  const pid = (await af('manager', 'POST', '/api/affiliates', { display_name: `DBCHECK-AF ${name}`, category: 'influencer' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${pid}/status`, { action: 'activate' });
  await af('manager', 'POST', `/api/affiliates/${pid}/referral`, {});
  return pid;
};

await step('referral: schema — three tables, keys, one active link, append-only clicks and attributions, immutable asset identity', async () => {
  const bad = [];
  const q = async (sql, p = []) => (await getPool().query(sql, p)).rows;
  for (const t of ['affiliate_referral_assets', 'affiliate_referral_clicks', 'affiliate_order_attributions']) if (!(await q('SELECT to_regclass($1) t', [t]))[0].t) bad.push(`${t} missing`);
  const fks = await q(`SELECT conrelid::regclass::text t, confrelid::regclass::text ref, confdeltype d FROM pg_constraint WHERE contype = 'f'
    AND conrelid::regclass::text IN ('affiliate_referral_assets', 'affiliate_referral_clicks', 'affiliate_order_attributions')`);
  for (const [t, ref] of [['affiliate_referral_assets', 'affiliates'], ['affiliate_referral_clicks', 'affiliates'], ['affiliate_referral_clicks', 'affiliate_referral_assets'],
    ['affiliate_order_attributions', 'orders'], ['affiliate_order_attributions', 'affiliates'], ['affiliate_order_attributions', 'affiliate_referral_assets']]) {
    if (!fks.some((f) => f.t === t && f.ref === ref && f.d === 'r')) bad.push(`FK ${t} → ${ref}`);
  }
  const idx = (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('affiliate_referral_assets', 'affiliate_referral_clicks', 'affiliate_order_attributions')`));
  if (!/UNIQUE.*WHERE/.test(idx.find((i) => i.indexname === 'affiliate_referral_assets_one_active_link')?.indexdef || '')) bad.push('one active link index');
  const cons = (await q(`SELECT conname FROM pg_constraint WHERE conrelid::regclass::text IN ('affiliate_referral_assets', 'affiliate_referral_clicks', 'affiliate_order_attributions')`)).map((r) => r.conname);
  for (const c of ['affiliate_order_attributions_order_key', 'affiliate_referral_clicks_public_id_key', 'affiliate_referral_assets_public_id_key', 'affiliate_order_attributions_method_check']) if (!cons.includes(c)) bad.push(`constraint ${c}`);
  const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'affiliate_referral_clicks'`)).map((r) => r.column_name);
  if (cols.some((c) => /^(ip|ip_address|email|phone|user_agent|name)$/.test(c))) bad.push(`raw-data column: ${cols}`);
  if (bad.length) throw new Error(bad.join(' | '));
  return '3 tables; 6 RESTRICT foreign keys; one active link per affiliate (partial unique index); unique order attribution and click id; no raw IP, user-agent or PII columns';
});

await step('referral: eligibility and assets — only active (and verified) affiliates; one live link; disable with reason; RBAC; no internal ids', async () => {
  const bad = [];
  const mk = async (name, category) => (await af('manager', 'POST', '/api/affiliates', { display_name: `DBCHECK-AF ${name}`, category })).body.affiliate.public_id;
  const create = (pid, who = 'manager') => af(who, 'POST', `/api/affiliates/${pid}/referral`, {});
  const inf = await mk('Ref influencer', 'influencer');
  const reasonOf = async (pid) => (await refGet(pid)).referral.eligibility.reason;
  if ((await reasonOf(inf)) !== 'not_active' || (await create(inf)).status !== 409) bad.push('draft influencer eligible');
  await af('manager', 'POST', `/api/affiliates/${inf}/status`, { action: 'activate' });
  for (const who of ['viewer', 'finance', 'none']) if ((await create(inf, who)).status !== 403) bad.push(`${who} created a link`);
  if ((await af('', 'POST', `/api/affiliates/${inf}/referral`, {})).status !== 401) bad.push('anon create');
  const made = await create(inf);
  const R = made.body.referral;
  if (made.status !== 201 || !R.usable || R.public_url !== `https://briyosupplements.com/r/${inf}` || !/^[A-HJKMNP-Z2-9]{10}$/.test(R.link.ref) || R.link.ref === inf) bad.push(`create ${made.status} ${JSON.stringify(R).slice(0, 160)}`);
  if (JSON.stringify(made.body).match(/"id":|affiliate_id|visitor|ip_hash/)) bad.push('internal fields in response');
  if ((await create(inf)).status !== 409) bad.push('second active link');
  for (const who of ['viewer', 'finance']) if ((await af(who, 'GET', `/api/affiliates/${inf}/referral`)).status !== 200) bad.push(`${who} cannot view`);
  if ((await af('none', 'GET', `/api/affiliates/${inf}/referral`)).status !== 403 || (await af('', 'GET', `/api/affiliates/${inf}/referral`)).status !== 401) bad.push('view gate');
  // Professionals: not before an approved verification AND activation.
  const pro = await mk('Ref doctor', 'doctor');
  if ((await reasonOf(pro)) !== 'verification_not_approved' || (await create(pro)).status !== 409) bad.push('unverified professional');
  await af('manager', 'POST', `/api/affiliates/${pro}/professional`, PROFILE);
  await pvUpload('manager', pro, pvPdf('ref'), 'c.pdf');
  for (const a of ['submit', 'review', 'approve']) await pvAct('manager', pro, a);
  if ((await reasonOf(pro)) !== 'not_activated' || (await create(pro)).status !== 409) bad.push('approved but not active');
  await af('manager', 'POST', `/api/affiliates/${pro}/status`, { action: 'activate' });
  if ((await create(pro)).status !== 201) bad.push('verified active professional refused');
  RF.pro = pro;
  // Suspended / closed: not eligible; the link stays but is unusable, and comes back on reactivation (no new asset).
  await af('manager', 'POST', `/api/affiliates/${inf}/status`, { action: 'suspend', reason: 'db-check' });
  const sus = (await refGet(inf)).referral;
  if (sus.usable || sus.eligibility.reason !== 'suspended' || !sus.link) bad.push('suspended link usable');
  await af('manager', 'POST', `/api/affiliates/${inf}/status`, { action: 'reactivate' });
  const back = (await refGet(inf)).referral;
  if (!back.usable || back.link.ref !== R.link.ref) bad.push('reactivation created a new asset or stayed unusable');
  const cl = await mk('Ref closed', 'creator');
  await af('manager', 'POST', `/api/affiliates/${cl}/status`, { action: 'close', reason: 'db-check' });
  if ((await reasonOf(cl)) !== 'closed' || (await create(cl)).status !== 409) bad.push('closed affiliate');
  // Disable: reason required; final; a new link may follow with the same public URL.
  if ((await af('manager', 'POST', `/api/affiliates/${inf}/referral/disable`, {})).status !== 400) bad.push('disable without reason');
  if ((await af('finance', 'POST', `/api/affiliates/${inf}/referral/disable`, { reason: 'x' })).status !== 403) bad.push('finance disabled');
  const dis = await af('manager', 'POST', `/api/affiliates/${inf}/referral/disable`, { reason: 'Partner asked to pause' });
  if (dis.body.referral?.link !== null || dis.body.referral.history[0]?.disable_reason !== 'Partner asked to pause') bad.push('disable');
  const again = await create(inf);
  if (again.status !== 201 || again.body.referral.public_url !== R.public_url || again.body.referral.link.ref === R.link.ref) bad.push('new link after disable');
  RF.inf = inf; RF.disabledAsset = R.link.ref;
  // Identity is immutable and a disabled asset stays disabled — in the database itself.
  const id = (await getPool().query('SELECT id FROM affiliate_referral_assets WHERE public_id = $1', [R.link.ref])).rows[0].id;
  await expectErr('change public id', () => getPool().query(`UPDATE affiliate_referral_assets SET public_id = 'ZZZZZZZZZZ' WHERE id = $1`, [id]), (e) => /immutable/.test(e.message));
  await expectErr('re-enable', () => getPool().query(`UPDATE affiliate_referral_assets SET status = 'active' WHERE id = $1`, [id]), (e) => /stays disabled|one_active/.test(e.message));
  await expectErr('delete asset', () => getPool().query('DELETE FROM affiliate_referral_assets WHERE id = $1', [id]), (e) => /never deleted/.test(e.message));
  // The storefront redirect is an explicit action; without the click host / Shopify it reports, never guesses.
  const sr = await af('manager', 'POST', `/api/affiliates/${inf}/referral/storefront-redirect`, {});
  if (![409, 502].includes(sr.status) || sr.body.ok !== false) bad.push(`storefront redirect ${sr.status}`);
  if ((await af('finance', 'POST', `/api/affiliates/${inf}/referral/storefront-redirect`, {})).status !== 403) bad.push('finance storefront redirect');
  const ev = (await afEvents(inf)).map((e) => e.action);
  if (!ev.includes('referral_asset_created') || !ev.includes('referral_asset_disabled')) bad.push('events');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'draft / unverified / approved-not-active / closed → no link (409); active influencer and verified active doctor → link; one live link; viewer+finance read only, others 403/401; suspension makes the link unusable and reactivation restores the same asset; disable needs a reason, is final, a new link keeps the public URL; identity immutable in the DB; storefront redirect explicit and refused safely without Shopify';
});

await step('referral: storefront redirect action — finds or creates the Shopify URL redirect, refuses a conflicting one, reports a missing scope', async () => {
  const bad = [];
  const { syncStorefrontRedirect } = await import('../lib/affiliate-referrals.js');
  const keep = process.env.AFFILIATE_CLICK_HOST;
  process.env.AFFILIATE_CLICK_HOST = 'go.test';
  try {
    const calls = [];
    const fake = (existing, opts = {}) => async (query, vars) => {
      calls.push({ query: query.split('(')[0], vars });
      if (opts.deny) throw new Error('Shopify GraphQL error: Access denied for urlRedirects field. Required access: `read_online_store_navigation` access scope.');
      if (/urlRedirects/.test(query)) return { urlRedirects: { nodes: existing } };
      return { urlRedirectCreate: { urlRedirect: { id: 'gid://shopify/UrlRedirect/1' }, userErrors: [] } };
    };
    const made = await syncStorefrontRedirect(RF.pro, { actor: 'db-check', gql: fake([]) });
    const create = calls.find((c) => /mutation/.test(c.query));
    if (!made.link.storefront_redirect_set || create?.vars.r.path !== `/r/${RF.pro}` || create.vars.r.target !== `https://go.test/r/${RF.pro}`) bad.push(`create ${JSON.stringify(create?.vars)}`);
    calls.length = 0;
    await syncStorefrontRedirect(RF.pro, { actor: 'db-check', gql: fake([{ id: 'gid://shopify/UrlRedirect/1', path: `/r/${RF.pro}`, target: `https://go.test/r/${RF.pro}` }]) });
    if (calls.some((c) => /mutation/.test(c.query))) bad.push('re-created an existing redirect');
    await expectErr('conflicting redirect', () => syncStorefrontRedirect(RF.pro, { actor: 'db-check', gql: fake([{ id: 'x', path: `/r/${RF.pro}`, target: 'https://elsewhere.example/' }]) }), (e) => e.status === 409);
    await expectErr('missing scope', () => syncStorefrontRedirect(RF.pro, { actor: 'db-check', gql: fake([], { deny: true }) }), (e) => e.status === 409 && e.scope && /write_online_store_navigation/.test(e.message));
    delete process.env.AFFILIATE_CLICK_HOST;
    await expectErr('no click host', () => syncStorefrontRedirect(RF.pro, { gql: fake([]) }), (e) => e.status === 409 && /AFFILIATE_CLICK_HOST/.test(e.message));
  } finally { if (keep === undefined) delete process.env.AFFILIATE_CLICK_HOST; else process.env.AFFILIATE_CLICK_HOST = keep; }
  if (bad.length) throw new Error(bad.join(' | '));
  return '/r/{id} → https://{click host}/r/{id} created once; an identical existing redirect is reused; a conflicting one is refused (409); a missing navigation scope is reported with the exact scopes; no click host → 409';
});

await step('referral: creating a link sets up the Shopify storefront redirect automatically — success, adopt (case-insensitive), conflict kept, missing permission never undoes the link, retry, fixed target', async () => {
  const bad = [];
  const { createReferralLink, syncStorefrontRedirect } = await import('../lib/affiliate-referrals.js');
  const keep = process.env.AFFILIATE_CLICK_HOST;
  process.env.AFFILIATE_CLICK_HOST = 'go.test';
  const newAff = async (name) => {
    const pid = (await af('manager', 'POST', '/api/affiliates', { display_name: `DBCHECK-AF ${name}`, category: 'influencer' })).body.affiliate.public_id;
    await af('manager', 'POST', `/api/affiliates/${pid}/status`, { action: 'activate' });
    return pid;
  };
  const calls = [];
  const fake = (existing, opts = {}) => async (query, vars) => {
    calls.push({ query: query.split('(')[0], vars });
    if (opts.deny) throw new Error('Shopify GraphQL error: Access denied for urlRedirects field. Required access: `read_online_store_navigation` access scope.');
    if (/urlRedirects/.test(query)) return { urlRedirects: { nodes: existing } };
    return { urlRedirectCreate: { urlRedirect: { id: 'gid://shopify/UrlRedirect/77' }, userErrors: [] } };
  };
  const mutations = () => calls.filter((c) => /mutation/.test(c.query));
  const asset = async (pid) => (await getPool().query(`SELECT r.status, r.storefront_redirect_gid, r.storefront_redirect_at FROM affiliate_referral_assets r JOIN affiliates a ON a.id = r.affiliate_id WHERE a.public_id = $1 AND r.type = 'link'`, [pid])).rows[0];
  try {
    // 1–3, 9. Success: the link and the redirect, /r/{id} → https://{click host}/r/{same id}, state stored.
    const A = await newAff('Auto redirect ok');
    calls.length = 0;
    const r1 = await createReferralLink(A, { actor: 'db-check', gql: fake([]) });
    const m1 = mutations();
    if (!r1.link || r1.storefront_setup?.ok !== true || !r1.link.storefront_redirect_set || m1.length !== 1
      || m1[0].vars.r.path !== `/r/${A}` || m1[0].vars.r.target !== `https://go.test/r/${A}`) bad.push(`success ${JSON.stringify([r1.storefront_setup, m1.map((c) => c.vars)])}`);
    if ((await asset(A))?.storefront_redirect_gid !== 'gid://shopify/UrlRedirect/77') bad.push('redirect state not stored');
    // 7. Re-running setup is idempotent: the existing redirect is found, nothing is created.
    calls.length = 0;
    await syncStorefrontRedirect(A, { actor: 'db-check', gql: fake([{ id: 'gid://shopify/UrlRedirect/77', path: `/r/${A}`, target: `https://go.test/r/${A}` }]) });
    if (mutations().length) bad.push('re-run created a duplicate');
    // 4, 8. Missing Shopify permission: the link is still created and usable; the setup status says why; logged; the retry action then works.
    const B = await newAff('Auto redirect no scope');
    calls.length = 0;
    const r2 = await createReferralLink(B, { actor: 'db-check', gql: fake([], { deny: true }) });
    if (!r2.link || r2.link.status !== 'active' || r2.link.storefront_redirect_set || r2.storefront_setup?.ok !== false || r2.storefront_setup.reason !== 'missing_scope') bad.push(`missing scope ${JSON.stringify([r2.link, r2.storefront_setup])}`);
    if ((await asset(B))?.status !== 'active') bad.push('link rolled back');
    const logged = (await getPool().query(`SELECT e.metadata FROM affiliate_events e JOIN affiliates a ON a.id = e.affiliate_id WHERE a.public_id = $1 AND e.action = 'storefront_redirect_failed'`, [B])).rows;
    if (logged.length !== 1 || !/navigation permission/.test(logged[0].metadata.reason)) bad.push(`failure not logged ${JSON.stringify(logged)}`);
    const retried = await syncStorefrontRedirect(B, { actor: 'db-check', gql: fake([]) });
    if (!retried.link.storefront_redirect_set) bad.push('retry action');
    // 5. An existing correct redirect — stored by Shopify in lowercase — is adopted, never duplicated.
    const C = await newAff('Auto redirect adopt');
    calls.length = 0;
    const r3 = await createReferralLink(C, { actor: 'db-check', gql: fake([{ id: 'gid://shopify/UrlRedirect/88', path: `/r/${C.toLowerCase()}`, target: `https://go.test/r/${C.toLowerCase()}` }]) });
    if (mutations().length || r3.storefront_setup?.ok !== true || (await asset(C))?.storefront_redirect_gid !== 'gid://shopify/UrlRedirect/88') bad.push(`adopt ${JSON.stringify([r3.storefront_setup, mutations().length])}`);
    // 6. A redirect to somewhere else is a conflict: not overwritten, link still created.
    const D = await newAff('Auto redirect conflict');
    calls.length = 0;
    const r4 = await createReferralLink(D, { actor: 'db-check', gql: fake([{ id: 'x', path: `/r/${D}`, target: 'https://elsewhere.example/' }]) });
    if (mutations().length || r4.storefront_setup?.reason !== 'conflict' || !r4.link || r4.link.storefront_redirect_set) bad.push(`conflict ${JSON.stringify(r4.storefront_setup)}`);
    // An existing redirect to /R/{id} (capital R) is broken — the click host serves only lowercase /r/ — so it is a
    // conflict: never adopted as configured, never overwritten.
    const F = await newAff('Auto redirect capital R');
    calls.length = 0;
    const r6 = await createReferralLink(F, { actor: 'db-check', gql: fake([{ id: 'gid://shopify/UrlRedirect/99', path: `/r/${F}`, target: `https://go.test/R/${F}` }]) });
    if (mutations().length || r6.storefront_setup?.reason !== 'conflict' || r6.link?.storefront_redirect_set || (await asset(F))?.storefront_redirect_gid) bad.push(`/R/ adopted ${JSON.stringify([r6.storefront_setup, (await asset(F))?.storefront_redirect_gid])}`);
    // Only the id ignores case: the matching rule itself, for the forms that must and must not be adopted.
    const { isClickTarget } = await import('../lib/affiliate-referrals.js');
    const adopt = ['https://go.briyo.xyz/r/GPJ92U', 'https://go.briyo.xyz/r/gpj92u', 'https://go.briyo.xyz/r/GpJ92u', 'https://GO.briyo.xyz/r/GPJ92U', 'https://go.briyo.xyz/r/GPJ92U/'];
    const refuse = ['https://go.briyo.xyz/R/GPJ92U', 'https://go.briyo.xyz/ref/GPJ92U', 'https://other.example/r/GPJ92U', 'http://go.briyo.xyz/r/GPJ92U',
      'https://go.briyo.xyz/r/OTHER1', 'https://go.briyo.xyz:8443/r/GPJ92U', 'https://go.briyo.xyz/r/GPJ92U?next=https://evil.example', 'https://go.briyo.xyz.evil.example/r/GPJ92U',
      'https://user@go.briyo.xyz/r/GPJ92U', '/r/GPJ92U', ''];
    for (const u of adopt) if (!isClickTarget(u, 'go.briyo.xyz', 'GPJ92U')) bad.push(`should adopt ${u}`);
    for (const u of refuse) if (isClickTarget(u, 'go.briyo.xyz', 'GPJ92U')) bad.push(`should refuse ${u}`);
    // 10. No caller can choose the destination: extra options are ignored; the target is always the click host + the same id.
    calls.length = 0;
    await syncStorefrontRedirect(D, { actor: 'db-check', target: 'https://evil.example/', path: '/x', gql: fake([]) });
    const m5 = mutations();
    if (m5.length !== 1 || m5[0].vars.r.target !== `https://go.test/r/${D}` || m5[0].vars.r.path !== `/r/${D}`) bad.push(`fixed target ${JSON.stringify(m5.map((c) => c.vars))}`);
    // Through the API (the running server talks to no Shopify): link creation still succeeds (201) and reports the setup state.
    const E = await newAff('Auto redirect api');
    const api = await af('manager', 'POST', `/api/affiliates/${E}/referral`, { target: 'https://evil.example/' });
    if (api.status !== 201 || !api.body.referral?.link || api.body.referral.link.storefront_redirect_set || api.body.referral.storefront_setup?.ok !== false) bad.push(`api create ${api.status} ${JSON.stringify(api.body.referral?.storefront_setup)}`);
    // No click recorded by any of this.
    const clicks = (await getPool().query(`SELECT count(*)::int n FROM affiliate_referral_clicks c JOIN affiliates a ON a.id = c.affiliate_id WHERE a.public_id = ANY($1)`, [[A, B, C, D, E, F]])).rows[0].n;
    if (clicks) bad.push(`${clicks} clicks recorded`);
  } finally { if (keep === undefined) delete process.env.AFFILIATE_CLICK_HOST; else process.env.AFFILIATE_CLICK_HOST = keep; }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'create link → redirect /r/{id} → https://go.test/r/{id} created and stored; re-run creates nothing; missing permission → link kept (active), status missing_scope, logged, retry works; lowercase existing redirect adopted; /R/ (broken) and other targets are conflicts, never adopted or overwritten; caller cannot pick the target; API create 201 with setup status; no clicks';
});

await step('referral: public redirect — 302 to the fixed storefront, opaque click and visitor ids, UTM allow-list, no open redirect, safe failures, isolated host', async () => {
  const bad = [];
  const P = RF.inf;
  const count = async () => (await getPool().query(`SELECT count(*)::int n FROM affiliate_referral_clicks k JOIN affiliates a ON a.id = k.affiliate_id WHERE a.public_id = $1`, [P])).rows[0].n;
  const c0 = await count();
  const r = await goReq(`/r/${P}?utm_campaign=summer%20sale&utm_source=ig&utm_evil=1&next=https://evil.example&bref=HACKED&redirect=//evil.example&utm_content=%3Cscript%3E`);
  const u = r.location && new URL(r.location);
  if (r.status !== 302 || u.origin !== 'https://store.test' || u.pathname !== '/') bad.push(`redirect ${r.status} ${r.location}`);
  const keys = u ? [...u.searchParams.keys()].sort().join(',') : '';
  if (keys !== 'bclid,bref,utm_campaign,utm_medium,utm_source') bad.push(`forwarded params: ${keys}`);
  if (u?.searchParams.get('bref') !== P || u.searchParams.get('utm_campaign') !== 'summer sale' || u.searchParams.get('utm_source') !== 'ig' || u.searchParams.get('utm_medium') !== 'referral') bad.push('params');
  const click = clickOf(r); const visitor = visitorOf(r);
  if (!/^[A-Za-z0-9_-]{22}$/.test(click || '') || click === P) bad.push(`click id ${click}`);
  if (!/^bv=[A-Za-z0-9_-]{22}$/.test(visitor) || !/HttpOnly/i.test(r.setCookie.join(';')) || !/SameSite=Lax/i.test(r.setCookie.join(';'))) bad.push(`visitor cookie ${r.setCookie}`);
  if (!/no-store/.test(r.headers['cache-control'] || '') || r.headers['referrer-policy'] !== 'no-referrer') bad.push('headers');
  if (await count() !== c0 + 1) bad.push('click not recorded');
  const row = (await getPool().query('SELECT * FROM affiliate_referral_clicks WHERE public_id = $1', [click])).rows[0];
  if (!row || !/^[0-9a-f]{64}$/.test(row.ip_hash || '') || !/^[0-9a-f]{64}$/.test(row.user_agent_hash || '') || row.utm_content !== null || row.visitor_id !== visitor.slice(3)) bad.push(`click row ${JSON.stringify(row).slice(0, 200)}`);
  if (JSON.stringify(row).includes('203.0.113.7') || JSON.stringify(row).includes('DBCHECK-UA')) bad.push('raw IP or user agent stored');
  // A retry by the same browser reuses the click; another browser gets its own.
  const again = await goReq(`/r/${P}`, { cookie: visitor });
  if (clickOf(again) !== click || await count() !== c0 + 1) bad.push('retry made a second click');
  const other = await goReq(`/r/${P}`);
  if (clickOf(other) === click || await count() !== c0 + 2) bad.push('second browser');
  if (visitorOf(await goReq(`/r/${P}`, { cookie: 'bv=<script>alert(1)</script>' })) === 'bv=<script>alert(1)</script>') bad.push('forged visitor id kept');
  // Lower case resolves; anything malformed or unusable lands on the plain home page, with no click and no hint.
  if (new URL((await goReq(`/r/${P.toLowerCase()}`)).location).searchParams.get('bref') !== P) bad.push('lower case');
  const before = await getPool().query('SELECT count(*)::int n FROM affiliate_referral_clicks');
  const home = 'https://store.test/';
  const sus = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Ref suspended', category: 'creator' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${sus}/status`, { action: 'activate' });
  await af('manager', 'POST', `/api/affiliates/${sus}/referral`, {});
  await af('manager', 'POST', `/api/affiliates/${sus}/status`, { action: 'suspend', reason: 'db-check' });
  const clo = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Ref closing', category: 'creator' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${clo}/status`, { action: 'activate' });
  await af('manager', 'POST', `/api/affiliates/${clo}/referral`, {});
  await af('manager', 'POST', `/api/affiliates/${clo}/status`, { action: 'close', reason: 'db-check' });
  const noLink = (await af('manager', 'POST', '/api/affiliates', { display_name: 'DBCHECK-AF Ref no link', category: 'creator' })).body.affiliate.public_id;
  await af('manager', 'POST', `/api/affiliates/${noLink}/status`, { action: 'activate' });
  for (const p of ['/r/ZZZZZZ', '/r/%2F%2Fevil.example', '/r/..%2F..%2Fapi%2Faffiliates', '/r/AB', `/r/${P}%27%3BDROP%20TABLE%20affiliates`, `/r/${sus}`, `/r/${clo}`, `/r/${noLink}`, '/r/', '/']) {
    const x = await goReq(p);
    if (x.status !== 302 || x.location !== home) bad.push(`${p}: ${x.status} ${x.location}`);
    if (x.body && /affiliate|suspend|closed|error/i.test(x.body)) bad.push(`${p} leaks: ${x.body.slice(0, 60)}`);
  }
  if ((await getPool().query('SELECT count(*)::int n FROM affiliate_referral_clicks')).rows[0].n !== before.rows[0].n) bad.push('click recorded for an unusable link');
  // The disabled asset's link is not usable either (the affiliate's new link is).
  // Host isolation: the click host serves nothing else; the internal host has no /r.
  for (const [m, p, want] of [['GET', '/api/affiliates', 404], ['GET', '/login', 404], ['GET', '/affiliates', 404], ['POST', `/r/${P}`, 404], ['GET', '/healthz', 200]]) {
    const x = await goReq(p, { method: m });
    if (x.status !== want) bad.push(`click host ${m} ${p}: ${x.status}`);
  }
  if ((await af('', 'GET', `/r/${P}`)).status === 302 && (await af('', 'GET', `/r/${P}`)).headers.get('location')?.includes('store.test')) bad.push('redirect served on the internal host');
  if (bad.length) throw new Error(bad.join(' | '));
  return '302 to https://store.test/ with bref, bclid and allow-listed UTMs only (next/redirect/bref overrides/unknown utm dropped, unsafe utm value dropped); 22-char random click and visitor ids; HttpOnly SameSite cookie; salted hashes only (no raw IP/UA); retry reuses the click; invalid, malicious, unknown, suspended, closed and link-less ids → plain home, no click, no hint; click host serves only /r and /healthz';
});

await step('referral: attribution through the existing Shopify sync — last eligible click in the window, coupon first, idempotent, totals untouched', async () => {
  const bad = [];
  const A = RF.inf;
  const B = await eligibleAffiliate('Ref second');
  const C = await eligibleAffiliate('Ref coupon');
  // Visitor 1: clicks A, then B (B is the last click).
  const a1 = await goReq(`/r/${A}`, { ip: '203.0.113.21' });
  const v1 = visitorOf(a1);
  await new Promise((r) => setTimeout(r, 20));
  const b1 = await goReq(`/r/${B}`, { cookie: v1, ip: '203.0.113.21' });
  await new Promise((r) => setTimeout(r, 20));
  // Orders placed just after the clicks (the sync window ends "now", so never in the future).
  const placed = () => new Date().toISOString();
  const att = (ref, click) => [{ key: '__briyo_ref', value: ref }, { key: '__briyo_click', value: click }, { key: 'gift_note', value: 'Happy birthday' }];
  // A coupon asset (the reserved coupon path): only the database can hold one in this phase. It is dated explicitly,
  // an hour before the orders below. A coupon counts only if it existed when the order was placed (created_at <=
  // order time); left to the database default, now() (microseconds) could fall in the same millisecond as order
  // 905's time (milliseconds, so rounded down), read as newer than the order, and B's click won now and then.
  const cid = (await getPool().query(`SELECT id FROM affiliates WHERE public_id = $1`, [C])).rows[0].id;
  const couponCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
  await getPool().query(`INSERT INTO affiliate_referral_assets (public_id, affiliate_id, type, code, created_by, created_at) VALUES ('CPNDBCHECK', $1, 'coupon', 'DBCHECKCPN10', 'db-check', $2)`, [cid, couponCreatedAt]);
  SH.store = [
    shOrder(901, { created: placed(), attributes: att(B, clickOf(b1)), total: 1499 }),                            // last click → B
    shOrder(902, { created: placed(), attributes: att(A, clickOf(a1)) }),                                       // A's click, but visitor's last click is B → B
    shOrder(903, { created: placed(), attributes: att(A, clickOf(b1)) }),                                       // bref does not match the click → nobody
    shOrder(904, { created: placed(), attributes: att(B, 'AAAAAAAAAAAAAAAAAAAAAA') }),                           // unknown click → nobody
    shOrder(905, { created: placed(), attributes: att(B, clickOf(b1)), codes: ['dbcheckcpn10'] }),              // affiliate coupon wins over the click → C
    shOrder(906, { created: placed(), attributes: att(B, clickOf(b1)), codes: ['WELCOME10'] }),                 // non-affiliate coupon → click → B
    shOrder(907, { created: placed() }),                                                                         // nothing → nobody
    shOrder(908, { created: shDays(1), attributes: att(B, clickOf(b1)) }),                                       // ordered before the click → nobody
    shOrder(909, { created: placed(), attributes: [{ key: '_briyo_ref', value: B }, { key: '_briyo_click', value: clickOf(b1) }] }), // single-underscore keys → B
  ];
  const gql = shFake(() => SH.store);
  const pre = await runShopifySync({ window: { days: 3 }, dryRun: true, gql });
  if (pre.summary.newAffiliateAttributions !== 5) bad.push(`preview ${pre.summary.newAffiliateAttributions}`);
  const r = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  const who = async (n) => (await getPool().query(`SELECT t.attribution_method m, t.rule_version v, t.window_days w, t.click_id, a.public_id aff FROM affiliate_order_attributions t
    JOIN orders o ON o.id = t.order_id JOIN affiliates a ON a.id = t.affiliate_id WHERE o.source_order_id = $1`, [`${SH_PREFIX}${String(n).padStart(4, '0')}`])).rows[0] || null;
  const want = { 901: [B, 'referral_click'], 902: [B, 'referral_click'], 903: null, 904: null, 905: [C, 'coupon'], 906: [B, 'referral_click'], 907: null, 908: null, 909: [B, 'referral_click'] };
  for (const [n, w] of Object.entries(want)) {
    const got = await who(n);
    if (w === null ? got !== null : (got?.aff !== w[0] || got.m !== w[1] || got.v !== 'v1' || got.w !== 30)) bad.push(`order ${n}: ${got ? `${got.aff}/${got.m}/${got.v}/${got.w}` : 'none'}`);
  }
  if ((await who(902))?.click_id !== clickOf(b1)) bad.push('last click not the one recorded');
  // The coupon's time rule at its boundary (read-only, fixed times): an order placed 1 ms before the coupon existed
  // does not get it; 1 ms after, it does.
  const { resolveOrderAttribution } = await import('../lib/affiliate-referrals.js');
  const couponFor = (ms) => resolveOrderAttribution(getPool(), { orderedAt: new Date(couponCreatedAt.getTime() + ms).toISOString(), discountCodes: ['dbcheckcpn10'] });
  if (await couponFor(-1) !== null) bad.push('coupon counted for an order placed before it existed');
  const after = await couponFor(1);
  if (after?.method !== 'coupon' || String(after.affiliateId) !== String(cid)) bad.push(`coupon not counted 1 ms after it existed: ${JSON.stringify(after)}`);
  if (r.summary.affiliateAttributionsRecorded !== 5) bad.push(`recorded ${r.summary.affiliateAttributionsRecorded}`);
  // Idempotent: another sync changes nothing, even after the affiliate is suspended.
  await af('manager', 'POST', `/api/affiliates/${B}/status`, { action: 'suspend', reason: 'db-check' });
  const again = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  if (again.summary.affiliateAttributionsRecorded !== 0 || (await who(901))?.aff !== B) bad.push('re-sync changed attribution');
  // Eligibility is checked at attribution time: B suspended → a new order falls back to the visitor's previous eligible click (A).
  SH.store.push(shOrder(910, { created: placed(), attributes: att(B, clickOf(b1)) }));
  await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  if ((await who(910))?.aff !== A) bad.push(`suspended last click → ${(await who(910))?.aff}`);
  // The window comes from affiliate_settings: an old click (40 days) is ignored at 30 days, counted at 60.
  const aid = (await getPool().query(`SELECT a.id, r.id rid FROM affiliates a JOIN affiliate_referral_assets r ON r.affiliate_id = a.id AND r.status = 'active' AND r.type = 'link' WHERE a.public_id = $1`, [A])).rows[0];
  const oldVisitor = 'OLDVISITOR_DBCHECK_0001'.slice(0, 22);
  await getPool().query(`INSERT INTO affiliate_referral_clicks (public_id, affiliate_id, referral_asset_id, visitor_id, clicked_at) VALUES ('OLDCLICK_DBCHECK_00001', $1, $2, $3, now() - interval '40 days')`, [aid.id, aid.rid, oldVisitor]);
  SH.store.push(shOrder(911, { created: placed(), attributes: att(A, 'OLDCLICK_DBCHECK_00001') }));
  await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  if (await who(911)) bad.push('click outside the window attributed');
  await getPool().query(`UPDATE affiliate_settings SET value = '60'::jsonb WHERE key = 'attribution_window_days'`);
  try {
    SH.store.push(shOrder(912, { created: placed(), attributes: att(A, 'OLDCLICK_DBCHECK_00001') }));
    await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
    const w = await who(912);
    if (w?.aff !== A || w.w !== 60) bad.push(`60-day window not read from settings: ${JSON.stringify(w)}`);
    if (await who(911)) bad.push('existing (non-)attribution rewritten');
  } finally { await getPool().query(`UPDATE affiliate_settings SET value = '30'::jsonb WHERE key = 'attribution_window_days'`); }
  // Totals, items, snapshots and stock: exactly as without attribution.
  const orderRow = async (n) => (await getPool().query('SELECT * FROM orders WHERE source_order_id = $1', [`${SH_PREFIX}${String(n).padStart(4, '0')}`])).rows[0];
  const o901 = await orderRow(901);
  if (!o901 || Number(o901.order_value) !== 1499 || o901.source_payload.shopify.referral?.ref !== B) bad.push(`order value or referral payload: ${o901?.order_value} ${JSON.stringify(o901?.source_payload?.shopify?.referral)}`);
  if ((await orderRow(907))?.source_payload.shopify.referral !== undefined) bad.push('referral key on an order without referral');
  const snap = (await getPool().query(`SELECT s.custom_attributes FROM order_financial_snapshots s WHERE s.order_id = $1 ORDER BY s.sequence DESC LIMIT 1`, [o901?.id])).rows[0];
  if (!snap?.custom_attributes.some((x) => x.key === '__briyo_ref' && x.value === B) || !snap.custom_attributes.some((x) => x.key === 'gift_note')) bad.push('snapshot custom attributes');
  if ((await shOps()).movements || (await shOps()).shipments || (await shOps()).reservations) bad.push('stock or shipments touched');
  // One attribution per order, and none for an order that does not exist — in the database itself.
  if (!o901) throw new Error(`order 901 missing; ${bad.join(' | ')}`);
  const oid = o901.id;
  await expectErr('second attribution', () => getPool().query(`INSERT INTO affiliate_order_attributions (order_id, affiliate_id, attribution_method, order_placed_at, rule_version) VALUES ($1, $2, 'coupon', now(), 'v1')`, [oid, cid]), (e) => e.code === '23505');
  await expectErr('nonexistent order', () => getPool().query(`INSERT INTO affiliate_order_attributions (order_id, affiliate_id, attribution_method, order_placed_at, rule_version) VALUES (-1, $1, 'coupon', now(), 'v1')`, [cid]), (e) => e.code === '23503');
  await expectErr('edit attribution', () => getPool().query(`UPDATE affiliate_order_attributions SET rule_version = 'v2' WHERE order_id = $1`, [oid]), (e) => /append-only/.test(e.message));
  await expectErr('edit click', () => getPool().query(`UPDATE affiliate_referral_clicks SET utm_source = 'x' WHERE public_id = $1`, [clickOf(b1)]), (e) => /append-only/.test(e.message));
  // The admin view shows the summary without personal data.
  const view = (await refGet(A)).referral;
  if (view.attributions.total < 2 || JSON.stringify(view).match(/Asha|buyer@|\+91|gift|visitor|ip_hash|"id":/)) bad.push('admin summary');
  if (process.env.SHOPIFY_ORDERS_POLL_ENABLED === 'true') bad.push('polling enabled');
  if (bad.length) throw new Error(bad.join(' | '));
  return '9 orders: last click (incl. across affiliates) wins, bref/click mismatch and unknown click ignored, affiliate coupon beats the click (only once it exists: 1 ms before → no, 1 ms after → yes), a non-affiliate coupon does not, ordered-before-click ignored, legacy keys read; preview = commit (5); re-sync idempotent; suspended affiliate loses new orders to the previous eligible click; 30 → 60-day window read from settings; rule v1 stored; totals, snapshots and stock untouched; DB refuses a second or orphan attribution and edits';
});

await step('affiliate commissions through the real Shopify sync: snapshot → attribution → one commission (rate, base, amount), a re-run sync adds nothing', async () => {
  const bad = [];
  const pool = getPool();
  // An eligible affiliate WITH a rate (12.5%, effective before the click), a real click on its link, and a new order carrying it.
  const D = await eligibleAffiliate('Ref commission');
  const { rows: [d] } = await pool.query('SELECT id FROM affiliates WHERE public_id = $1', [D]);
  await pool.query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by, reason) VALUES ($1, 1250, now() - interval '1 day', 'db-check', 'commission sync test')`, [d.id]);
  const click = await goReq(`/r/${D}`, { ip: '203.0.113.77' });
  const att = [{ key: '__briyo_ref', value: D }, { key: '__briyo_click', value: clickOf(click) }];
  const store = [shOrder(950, { created: new Date().toISOString(), attributes: att, total: 1299, subtotal: 1250 })];
  const gql = shFake(() => store);
  const source = `${SH_PREFIX}0950`;
  const state = async () => (await pool.query(`
    SELECT o.id AS order_id,
           (SELECT count(*)::int FROM order_financial_snapshots s WHERE s.order_id = o.id) AS snapshots,
           (SELECT count(*)::int FROM affiliate_order_attributions t WHERE t.order_id = o.id) AS attributions,
           (SELECT count(*)::int FROM affiliate_commissions c WHERE c.order_id = o.id) AS commissions
    FROM orders o WHERE o.source_order_id = $1`, [source])).rows[0];
  const r1 = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  const s1 = await state();
  if (!s1 || s1.snapshots !== 1 || s1.attributions !== 1 || s1.commissions !== 1 || r1.summary.affiliateAttributionsRecorded !== 1) bad.push(`first sync ${JSON.stringify([s1, r1.summary.affiliateAttributionsRecorded])}`);
  const { rows: [c] } = await pool.query(`SELECT c.*, a.public_id, s.current_subtotal::text AS sub, s.current_total_tax::text AS tax, (s.current_subtotal - s.current_total_tax)::text AS want_base,
      round((s.current_subtotal - s.current_total_tax) * 1250 / 10000, 2)::text AS want_amount, t.id AS attribution
    FROM affiliate_commissions c JOIN affiliates a ON a.id = c.affiliate_id JOIN order_financial_snapshots s ON s.id = c.snapshot_id
    JOIN affiliate_order_attributions t ON t.id = c.attribution_id WHERE c.order_id = $1`, [s1?.order_id]);
  // Shopify reports subtotal 1250.00 and tax 198.15 for this order → base 1051.85, 12.5% → 131.48 (from the stored fields).
  if (!c || c.public_id !== D || c.rate_bps !== 1250 || c.status !== 'pending' || c.currency !== 'INR'
    || c.base_amount !== c.want_base || c.commission_amount !== c.want_amount || c.want_base !== '1051.85' || c.want_amount !== '131.48') bad.push(`commission ${JSON.stringify(c)}`);
  // The same sync again: no second attribution or commission; the commission is untouched.
  const r2 = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
  const s2 = await state();
  const { rows: [c2] } = await pool.query('SELECT * FROM affiliate_commissions WHERE order_id = $1', [s1?.order_id]);
  if (s2.attributions !== 1 || s2.commissions !== 1 || r2.summary.affiliateAttributionsRecorded !== 0) bad.push(`re-sync ${JSON.stringify([s2, r2.summary.affiliateAttributionsRecorded])}`);
  if (JSON.stringify(c2) !== JSON.stringify((({ public_id, sub, tax, want_base, want_amount, attribution, ...rest }) => rest)(c))) bad.push('re-sync changed the commission');
  if (bad.length) throw new Error(bad.join(' | '));
  return `runShopifySync: snapshot 1, attribution 1, commission 1 at 12.5% on ${c.sub} − ${c.tax} = ${c.base_amount} → ${c.commission_amount} INR (pending); re-run: attributions 1, commissions 1, commission unchanged`;
});

await step('referral: GoKwik full_url never attributes (evidence only, #2823 conflict flagged); UTMs never; v1 click-id attribution unchanged', async () => {
  const bad = [];
  const keepShop = process.env.SHOPIFY_STORE_DOMAIN;
  process.env.SHOPIFY_STORE_DOMAIN = 'briyo-supp.myshopify.com';
  try {
    const gk = (id, extra = []) => [
      { key: 'gk_order_confirmation_url', value: 'https://briyo-supplements.addons.gokwik.co/thank-you?token=x' }, { key: 'gokwik_cid', value: 'a322d27a-cc3f-48a0-9be6-ea9ea3a3e32d' },
      { key: 'cart_token', value: 'hWNGjsufWe8Q7IA6bbNdHyU5?key=35feb1f451bd7db98c1881ff9714d7bc' },
      ...(id ? [{ key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${id}?utm_source=affiliate&utm_campaign=${id}&utm_medium=referral` }] : []),
      { key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: id || 'NOPE22' }, { key: 'utm_medium', value: 'referral' },
      { key: 'Payment_Method', value: 'Cash on Delivery' }, ...extra];
    const X = await eligibleAffiliate('GK main');     // the #2809 replica
    const Y = await eligibleAffiliate('GK no click');
    const Z = await eligibleAffiliate('GK late click');
    const W = await eligibleAffiliate('GK old click');
    const S = await eligibleAffiliate('GK suspended');
    const M = await eligibleAffiliate('GK multi');
    const V = await eligibleAffiliate('GK v1 direct');
    const zOrderTime = new Date(Date.now() - 60000).toISOString();   // placed before Z's click below
    const xClick = clickOf(await goReq(`/r/${X}`, { ip: '203.0.113.31' }));
    await goReq(`/r/${Z}`, { ip: '203.0.113.32' });
    await goReq(`/r/${S}`, { ip: '203.0.113.33' });
    const m1 = clickOf(await goReq(`/r/${M}`, { ip: '203.0.113.34' }));
    await new Promise((r) => setTimeout(r, 30));
    const m2 = clickOf(await goReq(`/r/${M}`, { ip: '203.0.113.35' }));
    const vClick = clickOf(await goReq(`/r/${V}`, { ip: '203.0.113.36' }));
    const w = (await getPool().query(`SELECT a.id, r.id rid FROM affiliates a JOIN affiliate_referral_assets r ON r.affiliate_id = a.id AND r.status = 'active' WHERE a.public_id = $1`, [W])).rows[0];
    await getPool().query(`INSERT INTO affiliate_referral_clicks (public_id, affiliate_id, referral_asset_id, visitor_id, clicked_at) VALUES ('GKOLDCLICK_DBCHECK_001', $1, $2, 'GKOLDVISITOR_DBCHECK_0', now() - interval '40 days')`, [w.id, w.rid]);
    await new Promise((r) => setTimeout(r, 30));
    await af('manager', 'POST', `/api/affiliates/${S}/status`, { action: 'suspend', reason: 'db-check' });
    const now = () => new Date().toISOString();
    const cases = {
      921: [{ created: now(), attributes: gk(X) }, null],                                                                             // #2809 replica: full_url alone → nobody
      922: [{ created: now(), attributes: gk(null) }, null],                                                                          // UTMs only
      923: [{ created: now(), attributes: gk(null, [{ key: 'full_url', value: `https://briyo-supp.myshopify.com/?utm_campaign=${X}` }]) }, null], // full_url without /r/
      924: [{ created: now(), attributes: gk(null, [{ key: 'full_url', value: `https://evil.example/r/${X}` }]) }, null],             // foreign host
      925: [{ created: now(), attributes: gk(Y) }, null],                                                                             // /r/ but no recorded click
      926: [{ created: zOrderTime, attributes: gk(Z) }, null],                                                                        // click after the order
      927: [{ created: now(), attributes: gk(W) }, null],                                                                             // click outside 30 days
      928: [{ created: now(), attributes: gk('ZZZZZZ') }, null],                                                                     // unknown affiliate
      929: [{ created: now(), attributes: gk(S) }, null],                                                                             // suspended at import
      930: [{ created: now(), attributes: gk(M) }, null],                                                                             // a recorded click is still not enough
      // #2823 exactly: GPJ92U's UTMs beside a stale /r/5TAZW4 path from the same browser's earlier visit.
      935: [{ created: now(), attributes: gk(null, [{ key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${X}?utm_source=affiliate&utm_campaign=${M}&utm_medium=referral` }]).map((a) => (a.key === 'utm_campaign' ? { ...a, value: M } : a)) }, null],
      // ...and the same order carrying our own click id: v1 decides, the stale path is irrelevant.
      936: [{ created: now(), attributes: [{ key: '__briyo_ref', value: V }, { key: '__briyo_click', value: vClick }, { key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${X}?utm_source=affiliate&utm_campaign=${V}&utm_medium=referral` }, { key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: V }] }, { aff: V, m: 'referral_click', v: 'v1', click: vClick }],
      931: [{ created: now(), attributes: [{ key: '__briyo_ref', value: V }, { key: '__briyo_click', value: vClick }, ...gk(X)] }, { aff: V, m: 'referral_click', v: 'v1', click: vClick }], // v1 decides
      932: [{ created: now(), attributes: [{ key: '__briyo_ref', value: X }, { key: '__briyo_click', value: vClick }, ...gk(X)] }, null], // v1 mismatch: no fallback override
      933: [{ created: now() }, null],                                                                                                // plain order
      934: [{ created: now(), attributes: gk(null, [{ key: 'full_url', value: `http://briyo-supp.myshopify.com/r/${X}` }]) }, null],  // not https
    };
    for (const [n, [o]] of Object.entries(cases)) SH.store.push(shOrder(Number(n), o));
    const gql = shFake(() => SH.store);
    const pre = await runShopifySync({ window: { days: 3 }, dryRun: true, gql });
    const r = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
    const who = async (n) => (await getPool().query(`SELECT t.attribution_method m, t.rule_version v, t.click_id, t.metadata, a.public_id aff FROM affiliate_order_attributions t
      JOIN orders o ON o.id = t.order_id JOIN affiliates a ON a.id = t.affiliate_id WHERE o.source_order_id = $1`, [`${SH_PREFIX}${String(n).padStart(4, '0')}`])).rows[0] || null;
    for (const [n, [, want]] of Object.entries(cases)) {
      const got = await who(n);
      if (want === null ? got !== null : (got?.aff !== want.aff || got.m !== want.m || got.v !== want.v || got.click_id !== want.click)) {
        bad.push(`order ${n}: ${got ? `${got.aff}/${got.m}/${got.v}/${got.click_id === m1 ? 'older click' : got.click_id}` : 'none'}`);
      }
    }
    if (pre.summary.newAffiliateAttributions !== 2 || r.summary.affiliateAttributionsRecorded !== 2) bad.push(`preview ${pre.summary.newAffiliateAttributions} / recorded ${r.summary.affiliateAttributionsRecorded}`);
    const ref = async (n) => (await getPool().query('SELECT source_payload FROM orders WHERE source_order_id = $1', [`${SH_PREFIX}${String(n).padStart(4, '0')}`])).rows[0]?.source_payload.shopify.referral;
    const r921 = await ref(921); const r935 = await ref(935);
    if (r921?.landing_ref !== X || r921.source !== 'gokwik_full_url' || r921.attributed !== false || r921.conflict !== false) bad.push(`921 evidence ${JSON.stringify(r921)}`);
    if (r935?.landing_ref !== X || r935.utm_campaign !== M || r935.conflict !== true || r935.attributed !== false || r935.commission !== false
      || r935.trusted_click_id !== null || !/^conflict:/.test(r935.reason || '')) bad.push(`935 evidence ${JSON.stringify(r935)}`);
    if (r921.trusted_click_id !== null || r921.commission !== false || !/no trusted click id/.test(r921.reason || '')) bad.push(`921 reason ${JSON.stringify(r921)}`);
    // No commission for any full_url-only order.
    const comm = (await getPool().query(`SELECT count(*)::int n FROM affiliate_commissions c JOIN affiliate_order_attributions t ON t.id = c.attribution_id JOIN orders o ON o.id = t.order_id
      WHERE o.source_order_id = ANY($1)`, [[921, 930, 935].map((n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`)])).rows[0].n;
    if (comm) bad.push(`${comm} commission(s) on full_url-only orders`);
    // referralEvidence on its own: conflict only when utm_source=affiliate names someone else; agreeing UTMs are not proof.
    const { referralEvidence } = await import('../lib/affiliate-referrals.js');
    const evc = referralEvidence([{ key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${X}` }, { key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: X }]);
    if (!evc || evc.conflict || evc.utm_campaign !== X) bad.push(`agreeing ${JSON.stringify(evc)}`);
    const evf = referralEvidence([{ key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${X}` }, { key: 'utm_source', value: 'facebook' }, { key: 'utm_campaign', value: M }]);
    if (!evf || evf.conflict || evf.utm_campaign !== null) bad.push(`non-affiliate utm ${JSON.stringify(evf)}`);
    if (referralEvidence([{ key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: X }]) !== null) bad.push('evidence without full_url');
    // No synthetic clicks, no click changes; idempotent.
    const clicks = (await getPool().query(`SELECT count(*)::int n FROM affiliate_referral_clicks k JOIN affiliates a ON a.id = k.affiliate_id WHERE a.public_id = ANY($1)`, [[X, Y, Z, W, S, M, V]])).rows[0].n;
    if (clicks !== 7) bad.push(`clicks ${clicks}`);
    const again = await runShopifySync({ window: { days: 3 }, dryRun: false, gql, actor: SH_ACTOR });
    if (again.summary.affiliateAttributionsRecorded !== 0) bad.push('re-sync attributed again');
    // landingReferral on its own.
    const { landingReferral } = await import('../lib/affiliate-referrals.js');
    const lr = (u) => landingReferral([{ key: 'full_url', value: u }]);
    if (lr(`https://briyo-supp.myshopify.com/r/${X.toLowerCase()}?a=1`) !== X || lr(`https://www.briyosupplements.com/r/${X}`) !== X || lr(`https://briyosupplements.com/r/${X}/`) !== X
      || lr(`https://briyo-supp.myshopify.com/r/${X}/extra`) !== null || lr('not a url') !== null || lr(`https://briyosupplements.com.evil.example/r/${X}`) !== null
      || landingReferral([{ key: 'utm_campaign', value: X }]) !== null) bad.push('landingReferral parsing');
  } finally { if (keepShop === undefined) delete process.env.SHOPIFY_STORE_DOMAIN; else process.env.SHOPIFY_STORE_DOMAIN = keepShop; }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'full_url-only orders (#2809 replica, with a recorded click, unknown, suspended, old, late, foreign, http) → nobody, no commission; #2823 pattern (stale /r/X path + utm_campaign Y) → nobody, conflict flagged on the order; same order with __briyo_click → v1 to its click; __briyo mismatch not overridden; preview = commit (2); no clicks created; idempotent';
});
// The webhook test sets and restores the order checkpoint around its poll race.
let savedCkForWebhookTest;
async function setCkForWebhookTest(v, restore = false) {
  const K = 'shopify_orders_checkpoint';
  if (!restore && savedCkForWebhookTest === undefined) savedCkForWebhookTest = (await getPool().query('SELECT value FROM system_state WHERE key = $1', [K])).rows[0]?.value ?? null;
  const val = restore ? savedCkForWebhookTest : v;
  if (restore && savedCkForWebhookTest === undefined) return;
  if (val === null) await getPool().query('DELETE FROM system_state WHERE key = $1', [K]);
  else await getPool().query(`INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [K, val]);
}
await step('shopify orders/create webhook: HMAC, idempotent deliveries, the existing import path (attribution, commission once), races with poll and Sync, no stock side effects', async () => {
  const bad = [];
  const SECRET = 'dbcheck-webhook-secret-0123456789';
  const keep = { secret: process.env.SHOPIFY_CLIENT_SECRET, shop: process.env.SHOPIFY_STORE_DOMAIN };
  Object.assign(process.env, { SHOPIFY_CLIENT_SECRET: SECRET, SHOPIFY_STORE_DOMAIN: 'briyo-supp.myshopify.com' });
  const gid = (n) => `${SH_PREFIX}${String(n).padStart(4, '0')}`;
  const sign = (body, secret = SECRET) => nodeCrypto.createHmac('sha256', secret).update(body).digest('base64');
  let seq = 0;
  const deliver = async (n, { id, secret, topic = 'orders/create', shop = 'briyo-supp.myshopify.com', body } = {}) => {
    const raw = body ?? JSON.stringify({ id: Number(gid(n).split('/').pop()), admin_graphql_api_id: gid(n), name: `#WH${n}`, email: 'buyer@example.test' });
    const wid = id || `dbcheck-wh-${SH_NUM}-${n}-${seq += 1}`;
    const r = await receiveOrdersCreate({ rawBody: raw, headers: { 'x-shopify-hmac-sha256': sign(raw, secret), 'x-shopify-shop-domain': shop, 'x-shopify-topic': topic, 'x-shopify-webhook-id': wid } });
    return { ...r, wid };
  };
  const count = async (sql, n) => (await getPool().query(sql, [gid(n)])).rows[0].n;
  const ordersOf = (n) => count('SELECT count(*)::int n FROM orders WHERE source_order_id = $1', n);
  const snapsOf = (n) => count('SELECT count(*)::int n FROM order_financial_snapshots s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = $1', n);
  const attrsOf = (n) => count('SELECT count(*)::int n FROM affiliate_order_attributions t JOIN orders o ON o.id = t.order_id WHERE o.source_order_id = $1', n);
  const commOf = (n) => count(`SELECT count(*)::int n FROM affiliate_commissions c JOIN affiliate_order_attributions t ON t.id = c.attribution_id JOIN orders o ON o.id = t.order_id WHERE o.source_order_id = $1`, n);
  const linesOf = (n) => count('SELECT count(*)::int n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.source_order_id = $1', n);
  const once = async (n, label) => {
    const got = [await ordersOf(n), await linesOf(n), await snapsOf(n)];
    if (got.join() !== '1,1,1') bad.push(`${label}: orders/lines/snapshots ${got.join('/')}`);
  };
  const keyFx = async () => (await getPool().query(`SELECT (SELECT count(*) FROM inventory_movements)::int mv, (SELECT count(*) FROM inventory_reservations)::int rs,
    (SELECT count(*) FROM abandoned_carts)::int carts, (SELECT value FROM system_state WHERE key = 'shopify_orders_checkpoint') ck`)).rows[0];
  try {
    const fx0 = await keyFx();
    // An affiliate with a 10% rate and a real click; its order carries our click id.
    const A = await eligibleAffiliate('WH direct');
    await af('manager', 'POST', `/api/affiliates/${A}/rates`, { rate_percent: '10', reason: 'db-check webhook' });
    const aClick = clickOf(await goReq(`/r/${A}`, { ip: '203.0.113.61' }));
    const B = await eligibleAffiliate('WH stale path');
    await goReq(`/r/${B}`, { ip: '203.0.113.62' });
    const now = () => new Date().toISOString();
    const direct = [{ key: '__briyo_ref', value: A }, { key: '__briyo_click', value: aClick }];
    SH.store.push(shOrder(961, { created: now(), attributes: direct }));
    SH.store.push(shOrder(962, { created: now() }));
    SH.store.push(shOrder(963, { created: now() }));
    // #2823 exactly: B's stale /r/ path beside A's affiliate UTMs, no click id.
    SH.store.push(shOrder(964, { created: now(), attributes: [{ key: 'full_url', value: `https://briyo-supp.myshopify.com/r/${B}?utm_source=affiliate&utm_campaign=${A}&utm_medium=referral` },
      { key: 'utm_source', value: 'affiliate' }, { key: 'utm_campaign', value: A }, { key: 'utm_medium', value: 'referral' }] }));
    SH.store.push(shOrder(965, { created: now() }));
    const gql = shFake(() => SH.store);
    // 2. Bad signature, other shop, missing id: refused, nothing stored.
    await ensureShopifyWebhookSchema();
    const stored = async () => (await getPool().query('SELECT count(*)::int n FROM shopify_webhook_deliveries')).rows[0].n;
    const before = await stored();
    const forged = await deliver(961, { secret: 'not-the-secret' });
    const other = await deliver(961, { shop: 'someone-else.myshopify.com' });
    if (forged.status !== 401 || other.status !== 403 || await stored() !== before) bad.push(`refusals ${forged.status}/${other.status}, stored ${await stored() - before}`);
    if (!verifyWebhookHmac('x', sign('x')) || verifyWebhookHmac('x', '') || verifyWebhookHmac('x', sign('y'))) bad.push('hmac helper');
    // 1, 6, 10. A valid delivery imports the order through the existing path: lines, snapshot, attribution, commission.
    const d1 = await deliver(961);
    if (d1.status !== 200 || !d1.deliveryId) bad.push(`valid ${d1.status}`);
    const p1 = await processWebhookDelivery(d1.deliveryId, { gql });
    await once(961, 'webhook');
    const t = (await getPool().query(`SELECT t.attribution_method m, a.public_id aff, t.click_id FROM affiliate_order_attributions t JOIN affiliates a ON a.id = t.affiliate_id JOIN orders o ON o.id = t.order_id WHERE o.source_order_id = $1`, [gid(961)])).rows[0];
    if (t?.aff !== A || t.m !== 'referral_click' || t.click_id !== aClick || await commOf(961) !== 1) bad.push(`attribution ${JSON.stringify(t)} commissions ${await commOf(961)}`);
    const run = (await getPool().query('SELECT imported_by, filename, status FROM order_imports WHERE id = $1', [p1.runId])).rows[0];
    if (run?.imported_by !== 'shopify-webhook' || run.status !== 'completed' || run.filename !== 'Shopify webhook order') bad.push(`run ${JSON.stringify(run)}`);
    // 3. The same delivery again: acknowledged, not re-processed. 9. A new delivery for the same order: nothing duplicated.
    const dup = await deliver(961, { id: d1.wid });
    if (dup.status !== 200 || !dup.body.duplicate || dup.deliveryId) bad.push('duplicate delivery processed');
    if (!(await processWebhookDelivery(d1.wid, { gql })).skipped) bad.push('processed delivery re-run');
    const d1b = await deliver(961);
    await processWebhookDelivery(d1b.deliveryId, { gql });
    await once(961, 'second delivery');
    if (await attrsOf(961) !== 1 || await commOf(961) !== 1) bad.push(`after redelivery: attributions ${await attrsOf(961)}, commissions ${await commOf(961)}`);
    // 4. Webhook racing the poll. 5. Webhook racing a manual Sync.
    const d2 = await deliver(962);
    await setCkForWebhookTest(new Date(Date.now() - 3600000).toISOString());
    await Promise.all([processWebhookDelivery(d2.deliveryId, { gql }), pollShopifyOrdersOnce({ gql })]);
    await once(962, 'webhook + poll');
    const d3 = await deliver(963);
    await Promise.all([processWebhookDelivery(d3.deliveryId, { gql }), runShopifySync({ window: { days: 1 }, dryRun: false, gql, actor: SH_ACTOR })]);
    await once(963, 'webhook + Sync');
    await once(961, 'after Sync');
    if (await attrsOf(961) !== 1 || await commOf(961) !== 1) bad.push('race duplicated attribution/commission');
    // 7. #2823 via webhook: imported, not attributed, conflict kept as evidence. 8. Plain order: none.
    const d4 = await deliver(964); await processWebhookDelivery(d4.deliveryId, { gql });
    const r4 = (await getPool().query('SELECT source_payload FROM orders WHERE source_order_id = $1', [gid(964)])).rows[0]?.source_payload.shopify.referral;
    if (await attrsOf(964) !== 0 || await commOf(964) !== 0 || await ordersOf(964) !== 1 || r4?.conflict !== true || r4.landing_ref !== B || r4.utm_campaign !== A
      || r4.trusted_click_id !== null || r4.attributed !== false || r4.commission !== false) bad.push(`#2823 pattern ${await attrsOf(964)} ${JSON.stringify(r4)}`);
    const d5 = await deliver(965); await processWebhookDelivery(d5.deliveryId, { gql });
    if (await ordersOf(965) !== 1 || await attrsOf(965) !== 0) bad.push('plain order');
    // Created after the Sync race above, so only the webhook can bring them in.
    SH.store.push(shOrder(966, { created: now(), name: `${TEST_ORDER}-WHDUP` }));
    SH.store.push(shOrder(967, { created: now() }));
    // A hand-entered website order with the Shopify number still holds the webhook's order back.
    const manual = await createOrder({ ...R('website'), channel: 'website', source_order_id: `${TEST_ORDER}-WHDUP` }, { actor: ACTOR });
    const d6 = await deliver(966); const p6 = await processWebhookDelivery(d6.deliveryId, { gql });
    if (await ordersOf(966) !== 0 || p6.summary.possibleDuplicates !== 1 || (await getOrder(manual)).source !== 'manual') bad.push('manual duplicate not held back');
    // Not an orders/create delivery: stored as ignored, never processed.
    const ign = await deliver(967, { topic: 'orders/updated' });
    const ir = (await getPool().query('SELECT status FROM shopify_webhook_deliveries WHERE webhook_id = $1', [ign.wid])).rows[0];
    if (ign.status !== 200 || ign.deliveryId || ir?.status !== 'ignored') bad.push(`ignored topic ${JSON.stringify(ir)}`);
    // A failed import stays pending and the sweep retries it (a restart after the 200 is the same case).
    const d7 = await deliver(967);
    const broken = async (q, v) => { if (/^query BriyoOrdersPage/.test(q)) throw Object.assign(new Error('Shopify HTTP 400: Bad request'), { status: 400 }); return gql(q, v); };
    await processWebhookDelivery(d7.deliveryId, { gql: broken, backoffMs: 1 }).then(() => bad.push('broken import succeeded'), () => {});
    const f7 = (await getPool().query('SELECT status, attempts FROM shopify_webhook_deliveries WHERE webhook_id = $1', [d7.wid])).rows[0];
    if (f7.status !== 'failed' || f7.attempts !== 1 || await ordersOf(967) !== 0) bad.push(`failure ${JSON.stringify(f7)}`);
    const sweep = await processPendingWebhooks({ gql, olderThanMs: 0 });
    if (sweep.processed < 1 || await ordersOf(967) !== 1) bad.push(`sweep ${JSON.stringify(sweep)}`);
    // Crash after the durable row, before processing: the delivery is pending and is imported exactly once,
    // even by two sweeps at once; a claim left by a dead process goes stale and is picked up.
    SH.store.push(shOrder(968, { created: now(), attributes: direct }));
    SH.store.push(shOrder(969, { created: now() }));
    const d8 = await deliver(968);                       // stored and acknowledged; never processed (the "crash")
    const d9 = await deliver(969);
    await getPool().query(`UPDATE shopify_webhook_deliveries SET status = 'processing', attempts = 1, claimed_at = now() - interval '11 minutes' WHERE webhook_id = $1`, [d9.wid]);
    const [s1, s2] = await Promise.all([processPendingWebhooks({ gql, olderThanMs: 0 }), processPendingWebhooks({ gql, olderThanMs: 0 })]);
    await once(968, 'after restart'); await once(969, 'stale claim');
    const st8 = (await getPool().query('SELECT status, attempts FROM shopify_webhook_deliveries WHERE webhook_id = ANY($1) ORDER BY webhook_id', [[d8.wid, d9.wid]])).rows;
    if (st8.some((x) => x.status !== 'processed') || s1.processed + s2.processed !== 2) bad.push(`restart ${JSON.stringify({ st8, s1, s2 })}`);
    const s3 = await processPendingWebhooks({ gql, olderThanMs: 0 });
    if (s3.pending !== 0) bad.push(`processed deliveries swept again ${JSON.stringify(s3)}`);
    // A live claim (not stale) is never taken by a second worker.
    SH.store.push(shOrder(970, { created: now() }));
    const d10 = await deliver(970);
    await getPool().query(`UPDATE shopify_webhook_deliveries SET status = 'processing', attempts = 1, claimed_at = now() WHERE webhook_id = $1`, [d10.wid]);
    if (!(await processWebhookDelivery(d10.wid, { gql })).skipped || await ordersOf(970) !== 0) bad.push('a live claim was taken twice');
    // Wrong topic: stored as ignored and never processed, even by the sweep.
    const ignRow = (await getPool().query('SELECT status, attempts FROM shopify_webhook_deliveries WHERE webhook_id = $1', [ign.wid])).rows[0];
    if (ignRow.status !== 'ignored' || ignRow.attempts !== 0) bad.push(`ignored delivery processed ${JSON.stringify(ignRow)}`);
    // 11. No shipments, reservations, movements; carts untouched. Webhook runs never move the checkpoint.
    const ships = (await getPool().query(`SELECT count(*)::int n FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.source_order_id = ANY($1)`, [[961, 962, 963, 964, 965, 967, 968, 969].map(gid)])).rows[0].n;
    const fx1 = await keyFx();
    if (ships || fx1.mv !== fx0.mv || fx1.rs !== fx0.rs || fx1.carts !== fx0.carts) bad.push(`side effects ${JSON.stringify({ ships, fx0, fx1 })}`);
    const ckRuns = (await getPool().query(`SELECT count(*)::int n FROM order_imports WHERE imported_by = 'shopify-webhook' AND details->'window'->>'mode' <> 'order'`)).rows[0].n;
    if (ckRuns) bad.push('a webhook run was not single-order');
    // 13. The abandoned-checkout poll flag is untouched by all of this.
    if (process.env.SHOPIFY_POLL_ENABLED === 'true') bad.push('SHOPIFY_POLL_ENABLED changed');
    if (before === undefined) bad.push('setup');
  } finally {
    await setCkForWebhookTest(null, true);
    await getPool().query(`DELETE FROM order_imports WHERE kind = 'shopify_sync' AND imported_by IN ('shopify-webhook', 'shopify-poll', $1) AND started_at > now() - interval '1 hour'`, [SH_ACTOR]);
    await getPool().query(`DELETE FROM shopify_webhook_deliveries WHERE webhook_id LIKE 'dbcheck-wh-%'`);
    for (const [k, v] of [['SHOPIFY_CLIENT_SECRET', keep.secret], ['SHOPIFY_STORE_DOMAIN', keep.shop]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  if (bad.length) throw new Error(bad.join(' | '));
  return 'forged signature 401, other shop 403; valid delivery → 1 order, 1 line, 1 snapshot, referral_click to its click, 1 commission, run "shopify-webhook"; same delivery id ignored; redelivery, webhook+poll and webhook+Sync races → still 1 of each, 1 attribution, 1 commission; #2823 pattern imported unattributed with the conflict kept; plain order unattributed; manual website duplicate held back; other topics stored as ignored; a failed import is retried by the sweep; a delivery stored but never processed (crash) and a stale claim are each imported exactly once by two concurrent sweeps, a live claim is never taken twice; no shipments, reservations, movements; carts and SHOPIFY_POLL_ENABLED untouched';
});

await step('referral: storefront snippet — stores bref/bclid, writes private cart attributes once, ignores bad input, never throws', async () => {
  const bad = [];
  const src = (await fsp.readFile(new URL('../storefront/briyo-referral.liquid', import.meta.url), 'utf8'));
  const code = src.match(/<script>([\s\S]*?)<\/script>/)[1];
  const vm = await import('node:vm');
  const run = async (search, { cart = {}, storage = true, failFetch = false, cookie = '' } = {}) => {
    const calls = []; const store = new Map(); let jar = cookie;
    const ctx = {
      window: { location: { search, protocol: 'https:' }, Shopify: { routes: { root: '/' } } },
      location: { protocol: 'https:' }, URLSearchParams, JSON, Date, Number, String, RegExp,
      document: { get cookie() { return jar; }, set cookie(v) { jar = v.split(';')[0]; } },
    };
    if (storage) ctx.window.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    else Object.defineProperty(ctx.window, 'localStorage', { get() { throw new Error('blocked'); } });
    ctx.window.fetch = async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      if (failFetch) throw new Error('offline');
      return { json: async () => ({ attributes: cart }) };
    };
    vm.runInNewContext(code, ctx);
    await new Promise((r) => setTimeout(r, 20));
    return { calls, store, jar };
  };
  const CLICK = 'abcDEF123_-xyzXYZ98765';
  const ok = await run(`?bref=b7k4p9&bclid=${CLICK}&utm_source=x`);
  const upd = ok.calls.find((c) => c.url === '/cart/update.js');
  if (!upd || JSON.stringify(upd.body) !== JSON.stringify({ attributes: { __briyo_ref: 'B7K4P9', __briyo_click: CLICK } })) bad.push(`cart write ${JSON.stringify(upd?.body)}`);
  if (!ok.store.get('briyo_ref_v1')?.includes('B7K4P9') || !/^briyo_ref=B7K4P9\./.test(ok.jar)) bad.push('not stored');
  const same = await run(`?bref=B7K4P9&bclid=${CLICK}`, { cart: { __briyo_ref: 'B7K4P9', __briyo_click: CLICK } });
  if (same.calls.some((c) => c.url === '/cart/update.js')) bad.push('rewrote identical attributes');
  for (const qs of ['?bref=B7K4P9', `?bclid=${CLICK}`, '?bref=<x>&bclid=<y>', `?bref=B0K4P9&bclid=${CLICK}`, '?bref=B7K4P9&bclid=short', '']) {
    const x = await run(qs);
    if (x.calls.length) bad.push(`acted on "${qs}"`);
  }
  const blocked = await run(`?bref=B7K4P9&bclid=${CLICK}`, { storage: false });
  if (!blocked.calls.some((c) => c.url === '/cart/update.js')) bad.push('no cookie fallback when storage is blocked');
  const later = await run('', { cookie: `briyo_ref=B7K4P9.${CLICK}.${Date.now()}` , storage: false });
  if (!later.calls.some((c) => c.url === '/cart/update.js')) bad.push('stored pair not reapplied on a later page');
  const expired = await run('', { cookie: `briyo_ref=B7K4P9.${CLICK}.${Date.now() - 31 * 86400000}`, storage: false });
  if (expired.calls.length) bad.push('expired pair used');
  try { await run(`?bref=B7K4P9&bclid=${CLICK}`, { failFetch: true }); } catch (err) { bad.push(`threw: ${err.message}`); }
  if (/price|discount|checkout|email|phone|alert\(/i.test(code.replace(/\/\/.*$/gm, ''))) bad.push('snippet touches pricing, checkout or PII');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'valid bref/bclid → stored (localStorage + cookie) and written once as __briyo_ref/__briyo_click; identical cart not rewritten; 6 malformed inputs ignored; storage blocked → cookie fallback; later page reapplies; 30-day expiry; network failure swallowed; no pricing, checkout or PII code';
});

await step('overview commerce: Shopify counts and money (per currency, cancelled out, unknown ≠ 0), sync health, affiliate programme and attributed value, shipments as parcels, light inventory — money and sync admin-only', async () => {
  const bad = [];
  const pool = getPool();
  const P = `${TEST_ORDER}-CMX`;
  const ACT = 'db-check-overview-commerce';
  const admin = { phone: RB.adm, isAdmin: true, caps: CAPABILITIES };
  const logi = { phone: RB.log, isAdmin: false, caps: ['logistics.view', 'logistics.edit', 'affiliate.view', 'inventory.view'] };
  const ov = async (who = admin) => overviewFor(who, { slaHours: 6 });
  // Leftovers from an interrupted run.
  await pool.query('DELETE FROM order_shipments WHERE created_by = $1', [ACT]);
  await purgeTestOrders(P);
  await purgeTestAffiliates(ACT);
  const cur = (o, c) => o.sections.commerce.shopify.money?.by_currency.find((x) => x.currency === c) || { orders: 0, current_order_value: 0, paid: 0, pending: 0, other: 0, other_statuses: {}, refunded: 0 };
  const av = (o, c) => o.sections.commerce.affiliate.attributed_order_value?.by_currency.find((x) => x.currency === c) || { orders: 0, value: 0 };
  const before = await ov();
  const shipBefore = before.sections.shipments;
  // Shopify orders, written directly (no Shopify call): each with the snapshot under test.
  let gid = 990000100;
  const order = async (tag, { cancelled = false, snap = null } = {}) => {
    const { rows: [o] } = await pool.query(`INSERT INTO orders (channel, source_order_id, source, order_status, order_date, created_by)
      VALUES ('website', $1, 'shopify_sync', $2, now(), $3) RETURNING id`, [`${P}-${tag}`, cancelled ? 'cancelled' : 'new', ACT]);
    if (snap) {
      gid += 1;
      await pool.query(`INSERT INTO order_financial_snapshots (order_id, shopify_order_gid, sequence, content_hash, shop_currency, presentment_currency, taxes_included,
          financial_status, cancelled_at, current_subtotal, current_total_tax, current_shipping, current_total_discounts, current_total_price, total_price, total_refunded, total_refunded_shipping, money)
        VALUES ($1, $2, 1, $3, $4, $4, true, $5, $6, $7, 0, 0, 0, $7, $8, $9, 0, '{}')`,
      [o.id, `gid://shopify/Order/${gid}`, crypto.createHash('sha256').update(tag).digest('hex'), snap.cur || 'INR', snap.status, cancelled ? new Date() : null,
        snap.value, snap.original ?? snap.value, snap.refunded || 0]);
      // A second, older-looking snapshot must not be counted twice: only the latest sequence is.
      if (snap.history) {
        await pool.query(`INSERT INTO order_financial_snapshots (order_id, shopify_order_gid, sequence, content_hash, shop_currency, presentment_currency, taxes_included,
            financial_status, current_subtotal, current_total_tax, current_shipping, current_total_discounts, current_total_price, total_price, total_refunded, total_refunded_shipping, money)
          VALUES ($1, $2, 0 + 2, $3, 'INR', 'INR', true, 'PAID', 1, 0, 0, 0, 1, 1, 0, 0, '{}')`, [o.id, `gid://shopify/Order/${gid}`, crypto.createHash('sha256').update(`${tag}-2`).digest('hex')]);
      }
    }
    return o.id;
  };
  const paid = await order('PAID', { snap: { status: 'PAID', value: '100.00' } });
  const pending = await order('PEND', { snap: { status: 'PENDING', value: '50.50' } });
  await order('PART', { snap: { status: 'PARTIALLY_REFUNDED', value: '30.00', original: '40.00', refunded: '10.00' } });
  await order('USD', { snap: { status: 'PAID', value: '20.00', cur: 'USD' } });
  const hist = await order('HIST', { snap: { status: 'PENDING', value: '5.00', history: true } });   // latest = sequence 2, PAID 1.00
  const voided = await order('VOID', { cancelled: true, snap: { status: 'VOIDED', value: '0.00', original: '99.00' } });
  const nosnap = await order('NOSNAP');
  // Affiliate: one attributed order per case — paid INR, cancelled, no snapshot, USD.
  const { rows: [cat] } = await pool.query('SELECT key FROM affiliate_categories ORDER BY sort LIMIT 1');
  const { rows: [aff] } = await pool.query(`INSERT INTO affiliates (public_id, category, display_name, status, created_by) VALUES ('CMXQVR', $1, 'DBCHECK-AF overview commerce', 'active', $2) RETURNING id`, [cat.key, ACT]);
  for (const o of [paid, voided, nosnap, (await pool.query(`SELECT id FROM orders WHERE source_order_id = $1`, [`${P}-USD`])).rows[0].id]) {
    await pool.query(`INSERT INTO affiliate_order_attributions (order_id, affiliate_id, attribution_method, order_placed_at, rule_version) VALUES ($1, $2, 'coupon', now(), 'v1')`, [o, aff.id]);
  }
  const { rows: [asset] } = await pool.query(`INSERT INTO affiliate_referral_assets (public_id, affiliate_id, type, created_by) VALUES ('CMXQVRAB23', $1, 'link', $2) RETURNING id`, [aff.id, ACT]);
  await pool.query(`INSERT INTO affiliate_referral_clicks (public_id, affiliate_id, referral_asset_id, visitor_id, landing_url) VALUES ('cmxOverviewClick000001', $1, $2, 'cmxOverviewVisitor0001', '/')`, [aff.id, asset.id]);
  // Shipments: two parcels on one live order, one on the cancelled order, one cancelled parcel.
  for (const st of ['packed', 'dispatched']) await pool.query('INSERT INTO order_shipments (order_id, shipment_status, created_by) VALUES ($1, $2, $3)', [pending, st, ACT]);
  await pool.query('INSERT INTO order_shipments (order_id, shipment_status, created_by) VALUES ($1, $2, $3)', [voided, 'in_transit', ACT]);
  await pool.query('INSERT INTO order_shipments (order_id, shipment_status, created_by) VALUES ($1, $2, $3)', [hist, 'cancelled', ACT]);
  const after = await ov();
  const S = after.sections.commerce.shopify; const S0 = before.sections.commerce.shopify;
  const d = (k) => +(cur(after, 'INR')[k] - cur(before, 'INR')[k]).toFixed(2);
  if (S.scope !== 'all_synced' || S.orders.active - S0.orders.active !== 6 || S.orders.cancelled - S0.orders.cancelled !== 1) bad.push(`counts ${JSON.stringify([S.orders, S0.orders])}`);
  // INR: 100 paid + 50.50 pending + 30 partially refunded + 1.00 (latest of HIST, PAID); the voided order and USD are not in INR.
  if (d('current_order_value') !== 181.5 || d('paid') !== 101 || d('pending') !== 50.5 || d('other') !== 30 || d('refunded') !== 10 || d('orders') !== 4) bad.push(`INR ${JSON.stringify(['current_order_value', 'paid', 'pending', 'other', 'refunded', 'orders'].map(d))}`);
  if (+(cur(after, 'INR').other_statuses.PARTIALLY_REFUNDED - (cur(before, 'INR').other_statuses.PARTIALLY_REFUNDED || 0)).toFixed(2) !== 30) bad.push('other status kept by name');
  if (+(cur(after, 'USD').paid - cur(before, 'USD').paid).toFixed(2) !== 20) bad.push('USD kept separate');
  if (S.money.orders_without_snapshot - S0.money.orders_without_snapshot !== 1) bad.push('missing snapshot not counted as unknown');
  if (JSON.stringify(S).match(/revenue/i)) bad.push('"revenue" wording');
  // Sync health.
  if (!S.sync || !['ok', 'stale', 'never'].includes(S.sync.status) || S.sync.stale_after_hours !== 24) bad.push(`sync ${JSON.stringify(S.sync)}`);
  const keepCp = (await pool.query(`SELECT value FROM system_state WHERE key = 'shopify_orders_checkpoint'`)).rows[0];
  const setCp = (v) => pool.query(`INSERT INTO system_state (key, value, updated_at) VALUES ('shopify_orders_checkpoint', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
  try {
    await setCp(new Date(Date.now() - 25 * 3600000).toISOString());
    const st = (await ov()).sections.commerce.shopify.sync;
    if (st.status !== 'stale' || st.message !== 'Shopify sync is stale') bad.push(`25h ${JSON.stringify(st)}`);
    await setCp(new Date(Date.now() - 2 * 3600000).toISOString());
    const ok = (await ov()).sections.commerce.shopify.sync;
    if (ok.status !== 'ok' || ok.message !== null) bad.push(`2h ${JSON.stringify(ok)}`);
    await pool.query(`DELETE FROM system_state WHERE key = 'shopify_orders_checkpoint'`);
    const nv = (await ov()).sections.commerce.shopify.sync;
    if (nv.status !== 'never' || nv.message !== 'No successful Shopify sync') bad.push(`never ${JSON.stringify(nv)}`);
  } finally {
    if (keepCp) await pool.query(`INSERT INTO system_state (key, value, updated_at) VALUES ('shopify_orders_checkpoint', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [keepCp.value]);
    else await pool.query(`DELETE FROM system_state WHERE key = 'shopify_orders_checkpoint'`);
  }
  // Affiliate.
  const A = after.sections.commerce.affiliate; const A0 = before.sections.commerce.affiliate;
  if (A.affiliates.total - A0.affiliates.total !== 1 || A.affiliates.active - A0.affiliates.active !== 1 || A.clicks.total - A0.clicks.total !== 1 || A.clicks.last_30d - A0.clicks.last_30d !== 1) bad.push(`affiliate counts ${JSON.stringify([A.affiliates, A.clicks])}`);
  if (A.attributions.total - A0.attributions.total !== 4 || (A.attributions.by_method.coupon || 0) - (A0.attributions.by_method.coupon || 0) !== 4) bad.push('attributions');
  const V = A.attributed_order_value; const V0 = A0.attributed_order_value;
  if (+(av(after, 'INR').value - av(before, 'INR').value).toFixed(2) !== 100 || +(av(after, 'USD').value - av(before, 'USD').value).toFixed(2) !== 20
    || V.cancelled_orders - V0.cancelled_orders !== 1 || V.orders_without_snapshot - V0.orders_without_snapshot !== 1) bad.push(`attributed value ${JSON.stringify([V, V0])}`);
  if (/commission|payable|payout|approved|revenue/i.test(JSON.stringify(A))) bad.push('commission/revenue fields present');
  // Shipments: parcels, cancelled orders' parcels apart, cancelled parcels apart from the operational total.
  const sh = after.sections.shipments; const dS = (k) => sh.by_status[k] - shipBefore.by_status[k];
  if (dS('packed') !== 1 || dS('dispatched') !== 1 || dS('in_transit') !== 0 || dS('cancelled') !== 1 || sh.on_cancelled_orders - shipBefore.on_cancelled_orders !== 1
    || sh.active_total - shipBefore.active_total !== 2) bad.push(`shipments ${JSON.stringify([sh, shipBefore])}`);
  const direct = (await pool.query(`SELECT count(*)::int n FROM order_shipments s JOIN orders o ON o.id = s.order_id WHERE o.order_status <> 'cancelled' AND s.shipment_status <> 'cancelled'`)).rows[0].n;
  if (sh.active_total !== direct) bad.push(`active parcels ${sh.active_total} vs ${direct}`);
  // Inventory: lightweight counts equal direct counts; cutover untouched; nothing written by reading.
  const I = after.sections.inventory;
  const one = async (q) => (await pool.query(q)).rows[0].n;
  const want = {
    master_skus: await one('SELECT count(*)::int n FROM skus WHERE active'), mappings: await one('SELECT count(*)::int n FROM sku_platform_mappings'),
    batches: await one('SELECT count(*)::int n FROM inventory_batches'), movements: await one('SELECT count(*)::int n FROM inventory_movements'),
    active_reservations: await one(`SELECT count(*)::int n FROM inventory_reservations WHERE status = 'active'`),
    platform_skus_to_map: (await unmappedSkus()).length,
  };
  for (const [k, v] of Object.entries(want)) if (I[k] !== v) bad.push(`inventory ${k} ${I[k]} vs ${v}`);
  if (I.cutover_at !== null || (await getInventoryCutover()).cutover_at !== null) bad.push('cutover changed');
  const full = (await inventoryOverview({})).cards;
  if (I.low_stock !== full.lowStock || I.out_of_stock !== full.outOfStock || I.expired_batches !== full.expired || I.expiring_30 !== full.expiring30
    || I.available_units !== full.availableUnits || I.reserved_units !== full.reservedUnits || I.master_skus !== full.totalSkus) bad.push(`stock flags differ from the Inventory page ${JSON.stringify([I, full])}`);
  const counts = async () => JSON.stringify((await pool.query(`SELECT (SELECT count(*) FROM inventory_batches) b, (SELECT count(*) FROM inventory_movements) m, (SELECT count(*) FROM inventory_reservations) r, (SELECT count(*) FROM sku_platform_mappings) p, (SELECT count(*) FROM order_items WHERE sku_id IS NOT NULL) i`)).rows[0]);
  const c0 = await counts(); await ov(); await ov(logi); if ((await counts()) !== c0) bad.push('reading the overview changed data');
  // Permissions: non-admins get counts, never money or sync health — the fields are absent, not zero.
  const L = await ov(logi);
  const LS = L.sections.commerce?.shopify; const LA = L.sections.commerce?.affiliate;
  if (!LS || 'money' in LS || 'sync' in LS || !LA || 'attributed_order_value' in LA || !L.sections.shipments || !L.sections.inventory) bad.push(`non-admin ${JSON.stringify(L.sections.commerce)}`);
  if (LS && LS.orders.active !== S.orders.active) bad.push('non-admin counts differ');
  const noLog = await ov({ phone: RB.invOnly, isAdmin: false, caps: ['inventory.view'] });
  if (noLog.sections.commerce || noLog.sections.shipments) bad.push('inventory-only member saw commerce/shipments');
  const affOnly = await ov({ phone: RB.invOnly, isAdmin: false, caps: ['affiliate.view'] });
  if (affOnly.sections.commerce?.shopify || !affOnly.sections.commerce?.affiliate || 'attributed_order_value' in affOnly.sections.commerce.affiliate) bad.push('affiliate-only member');
  // Clean up the fixtures.
  await pool.query('DELETE FROM order_shipments WHERE created_by = $1', [ACT]);
  await purgeTestOrders(P);
  await purgeTestAffiliates(ACT);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'active/cancelled counts; INR value 181.50 = paid 101 + pending 50.50 + other 30 (PARTIALLY_REFUNDED), refunded 10, latest snapshot only; USD separate; no-snapshot order unknown; stale >24h / ok / never; affiliate counts, clicks, 4 attributions, value INR 100 + USD 20, cancelled and no-snapshot apart, no commission fields; parcels by status, cancelled-order parcel apart; inventory counts = DB and = Inventory page flags, cutover NULL, no writes; non-admins: no money or sync fields';
});

await step('units per listing through the Inventory API and page: create (default 1, 2, 10), reject 0 / −1 / 1.5, show and edit, managers only, nothing automatic', async () => {
  const bad = [];
  const pool = getPool();
  const sku = (await createSku({ sku: `${TS}-UIU`, product_name: 'Units UI test' }, { actor: ACTOR })).id;
  const maps0 = (await pool.query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n;
  const add = (code, units) => internal('adm', 'POST', `/api/inventory/skus/${sku}/platform-skus`, { platform: 'amazon', platform_skus: [code], ...(units === undefined ? {} : { units_per_listing: units }) });
  for (const [code, units, want] of [[`${TS}-UIU-D`, undefined, 1], [`${TS}-UIU-2`, '2', 2], [`${TS}-UIU-10`, '10', 10]]) {
    const r = await add(code, units);
    if (r.status !== 201) bad.push(`${code}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (const v of ['0', '-1', '1.5', '', 0, -3]) {
    const r = await add(`${TS}-UIU-BAD`, v);
    if (r.status !== 400 || !/whole number/.test(r.body.error || '')) bad.push(`accepted ${JSON.stringify(v)}: ${r.status}`);
  }
  const shown = async () => Object.fromEntries((await internal('adm', 'GET', `/api/inventory/skus/${sku}`)).body.sku.platform_skus.map((m) => [m.platform_sku, m]));
  let m = await shown();
  if (m[`${TS}-UIU-D`]?.units_per_listing !== 1 || m[`${TS}-UIU-2`]?.units_per_listing !== 2 || m[`${TS}-UIU-10`]?.units_per_listing !== 10 || m[`${TS}-UIU-BAD`]) bad.push(`stored ${JSON.stringify(Object.values(m).map((x) => [x.platform_sku, x.units_per_listing]))}`);
  // Edit (PATCH, the same endpoint the page's Edit units form uses).
  const e = await internal('adm', 'PATCH', `/api/inventory/platform-skus/${m[`${TS}-UIU-2`].id}`, { units_per_listing: '3' });
  if (e.status !== 200 || (await shown())[`${TS}-UIU-2`].units_per_listing !== 3) bad.push(`edit ${e.status}`);
  const e0 = await internal('adm', 'PATCH', `/api/inventory/platform-skus/${m[`${TS}-UIU-2`].id}`, { units_per_listing: '0' });
  if (e0.status !== 400) bad.push(`edit to 0: ${e0.status}`);
  // Locked while an order using it has stock reserved: 3 ordered × 3 per listing = 9 inventory units; the order line stays 3.
  const b = (await receiveInventory({ sku_id: sku, batch_number: 'UIU-1', expiry_date: dayOffset(300), quantity: 20, unit_cost: 10, request_id: rid() }, { actor: ACTOR })).batchId;
  const order = await lineOn('amazon', 'UIU-1', `${TS}-UIU-2`, 3);
  const dl = (await listCouriers()).find((x) => x.name === 'Delhivery');
  const sid = (await createShipment({ ...R('amazon'), channel: 'amazon', source_order_id: `${TEST_ORDER}-UIU-1`, courier_partner_id: dl.id, tracking_id: 'AWB-UIU-1', shipment_status: 'packed' }, { actor: ACTOR, addToExisting: true })).shipmentId;
  if ((await shipmentStock(sid)).lines[0]?.required !== 9) bad.push('3 × 3 should need 9 inventory units');
  await reserveShipmentStock(sid, [{ batch_id: b, quantity: 9 }], { actor: ACTOR });
  const locked = await internal('adm', 'PATCH', `/api/inventory/platform-skus/${m[`${TS}-UIU-2`].id}`, { units_per_listing: '4' });
  if (locked.status !== 409) bad.push(`edit while reserved: ${locked.status}`);
  if ((await pool.query('SELECT quantity FROM order_items WHERE order_id = $1', [order])).rows[0].quantity !== 3) bad.push('order quantity changed');
  await releaseShipmentStock(sid, { actor: ACTOR });
  // Audited; no member without Inventory access can create or edit; nothing was mapped automatically.
  const audits = (await pool.query(`SELECT action FROM inventory_audit WHERE sku_id = $1 AND action IN ('platform_skus_added', 'platform_sku_units_changed')`, [sku])).rows.map((r) => r.action);
  if (audits.filter((a) => a === 'platform_skus_added').length !== 3 || !audits.includes('platform_sku_units_changed')) bad.push(`audit ${audits.join(',')}`);
  const deny = await internal('mgr', 'POST', `/api/inventory/skus/${sku}/platform-skus`, { platform: 'amazon', platform_skus: [`${TS}-UIU-X`], units_per_listing: '2' });
  const denyEdit = await internal('mgr', 'PATCH', `/api/inventory/platform-skus/${m[`${TS}-UIU-10`].id}`, { units_per_listing: '2' });
  if (deny.status !== 403 || denyEdit.status !== 403) bad.push(`non-inventory member ${deny.status}/${denyEdit.status}`);
  if ((await pool.query('SELECT count(*)::int n FROM sku_platform_mappings')).rows[0].n !== maps0 + 3) bad.push('a mapping was created that nobody asked for');
  // The page: the field, its helper, the label on each mapping, and an edit form (not a browser prompt).
  const page = await fsp.readFile(new URL('../public/inventory.js', import.meta.url), 'utf8');
  for (const t of ['Units per listing', 'How many inventory units are represented by one platform listing.', 'Units/listing: ', "openForm('units'", 'units_per_listing']) if (!page.includes(t)) bad.push(`page missing ${t}`);
  if (/window\.prompt\(`Units per listing/.test(page)) bad.push('still a prompt');
  if (bad.length) throw new Error(bad.join(' | '));
  return 'API: omitted → 1, 2, 10 stored; 0 / −1 / 1.5 / empty refused (400); shown on the master; edited 2 → 3; 0 refused; locked (409) while reserved; 3 ordered × 3 = 9 inventory units, order line still 3; audited; non-Inventory member 403; only the 3 asked-for mappings exist; page has the field, helper, "Units/listing" label and an edit form';
});

await step('affiliate commissions: one per attribution, rate and base fixed at creation (net subtotal excl. recorded tax: ₹215 − ₹41.64 = ₹173.36 × 12.5% = ₹21.67), idempotent, currency kept, cancelled / missing record / no rate handled, status changes audited, money gated', async () => {
  const bad = [];
  const pool = getPool();
  const { attributeOrder } = await import('../lib/affiliate-referrals.js');
  const { getAffiliatePerformance, setCommissionStatus, backfillAffiliateCommissions } = await import('../lib/affiliate-commissions.js');
  const { tx: aTx } = await import('../lib/affiliates.js');
  const ACT = 'db-check-commissions';
  const P = `${TEST_ORDER}-CM`;
  await purgeTestOrders(P); await purgeTestAffiliates(ACT);
  const { rows: [cat] } = await pool.query(`SELECT key FROM affiliate_categories WHERE NOT requires_verification ORDER BY sort LIMIT 1`);
  const mkAff = async (pid, rateBps) => {
    const { rows: [a] } = await pool.query(`INSERT INTO affiliates (public_id, category, display_name, status, activated_at, created_by) VALUES ($1, $2, $3, 'active', now(), $4) RETURNING id`, [pid, cat.key, `DBCHECK-AF ${pid}`, ACT]);
    if (rateBps !== null) await pool.query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by) VALUES ($1, $2, now() - interval '2 days', $3)`, [a.id, rateBps, ACT]);
    await pool.query(`INSERT INTO affiliate_referral_assets (public_id, affiliate_id, type, code, created_by, created_at) VALUES ($1, $2, 'coupon', $3, $4, now() - interval '1 day')`, [`${pid}CPN2`.slice(0, 10).padEnd(10, '2'), a.id, `CM-${pid}`, ACT]);
    return Number(a.id);
  };
  const A = await mkAff('CMAXQT', 1250);
  const N = await mkAff('CMNRQT', null);   // no rate
  let gid = 991000200;
  // value = current_total_price; sub / tax / ship = current_subtotal / current_total_tax / current_shipping.
  const order = async (tag, { value = null, sub = value, tax = '0', ship = '0', cur = 'INR', cancelled = false } = {}) => {
    const { rows: [o] } = await pool.query(`INSERT INTO orders (channel, source_order_id, source, order_status, order_date, created_by, source_payload)
      VALUES ('website', $1, 'shopify_sync', $2, now() - interval '1 hour', $3, $4) RETURNING id`,
    [`${P}-${tag}`, cancelled ? 'cancelled' : 'new', ACT, JSON.stringify({ shopify: { name: `#CM${tag}` } })]);
    if (value !== null) {
      gid += 1;
      await pool.query(`INSERT INTO order_financial_snapshots (order_id, shopify_order_gid, sequence, content_hash, shop_currency, presentment_currency, taxes_included,
          financial_status, cancelled_at, current_subtotal, current_total_tax, current_shipping, current_total_discounts, current_total_price, total_price, total_refunded, total_refunded_shipping, money)
        VALUES ($1, $2, 1, $3, $4, $4, true, 'PENDING', $5, $7, $8, $9, 0, $6, $6, 0, 0, '{}')`,
      [o.id, `gid://shopify/Order/${gid}`, crypto.createHash('sha256').update(`cm-${tag}`).digest('hex'), cur, cancelled ? new Date() : null, value, sub, tax, ship]);
    }
    return Number(o.id);
  };
  const attribute = (orderId, code) => aTx((client) => attributeOrder(client, orderId, { orderedAt: new Date(Date.now() - 3600000).toISOString(), discountCodes: [code], customAttributes: [] }, { actor: ACT }));
  const commissionsOf = async (orderId) => (await pool.query('SELECT * FROM affiliate_commissions WHERE order_id = $1', [orderId])).rows;
  // 1. A #2806-style order: subtotal ₹215.00, recorded tax ₹41.64, shipping ₹58.00, total ₹273.00.
  //    Base = Shopify net subtotal excluding recorded tax, computed from the stored fields → one commission at 12.5%.
  const o1 = await order('2809', { value: '273.00', sub: '215.00', tax: '41.64', ship: '58.00' });
  const r1 = await attribute(o1, 'CM-CMAXQT');
  let c1 = await commissionsOf(o1);
  if (!c1.length) throw new Error(`no commission for the ₹273 order: ${JSON.stringify(r1)} ${JSON.stringify((await pool.query(`SELECT action, metadata FROM affiliate_events WHERE affiliate_id = $1`, [A])).rows)}`);
  const { rows: [want1] } = await pool.query(`SELECT (current_subtotal - current_total_tax)::text AS base, round((current_subtotal - current_total_tax) * 1250 / 10000, 2)::text AS amount FROM order_financial_snapshots WHERE order_id = $1`, [o1]);
  if (want1.base !== '173.36' || want1.amount !== '21.67') bad.push(`fixture arithmetic ${JSON.stringify(want1)}`);
  if (!r1?.recorded || r1.commission !== true || c1.length !== 1 || c1[0].rate_bps !== 1250 || c1[0].base_amount !== want1.base || c1[0].commission_amount !== want1.amount || c1[0].currency !== 'INR' || c1[0].status !== 'pending') bad.push(`base commission ${JSON.stringify([r1, c1[0]])}`);
  if (c1[0].base_amount === '273.00' || c1[0].base_amount === '215.00') bad.push('base still includes tax or shipping');
  // 2. Re-attribution / re-sync and a direct retry: still one.
  const r1b = await attribute(o1, 'CM-CMAXQT');
  const { createCommissionForAttribution } = await import('../lib/affiliate-commissions.js');
  const retry = await aTx((client) => createCommissionForAttribution(client, c1[0].attribution_id, { actor: ACT }));
  if (r1b?.recorded !== false || retry.created || (await commissionsOf(o1)).length !== 1) bad.push('duplicate commission');
  // 3. A new rate does not change the recorded commission; the row's rate and amounts cannot be edited.
  await pool.query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by) VALUES ($1, 1000, now(), $2)`, [A, ACT]);
  c1 = await commissionsOf(o1);
  if (c1[0].rate_bps !== 1250 || c1[0].commission_amount !== '21.67' || c1[0].base_amount !== '173.36') bad.push('rate change touched the commission');
  await expectErr('edit amount', () => pool.query('UPDATE affiliate_commissions SET commission_amount = 1 WHERE id = $1', [c1[0].id]), (e) => /fixed when it is created/.test(e.message));
  await expectErr('delete', () => pool.query('DELETE FROM affiliate_commissions WHERE id = $1', [c1[0].id]), (e) => /never deleted/.test(e.message));
  // 4. Currency kept: a USD order → its own commission in USD, at the rate in effect when ITS attribution was
  //    created — after the new 10% rate — while the earlier commission keeps 12.5%.
  const oUsd = await order('USD', { value: '20.00', cur: 'USD' });
  await attribute(oUsd, 'CM-CMAXQT');
  const cu = (await commissionsOf(oUsd))[0];
  if (!cu || cu.currency !== 'USD' || cu.commission_amount !== '2.00' || cu.rate_bps !== 1000) bad.push(`USD ${JSON.stringify(cu)}`);
  if ((await commissionsOf(o1))[0].rate_bps !== 1250) bad.push('earlier commission lost its rate');
  // 4b. An order already cancelled / voided when attributed → no commission, logged.
  const oVoid = await order('VOIDED', { value: '300.00', sub: '300.00', cancelled: true });
  await attribute(oVoid, 'CM-CMAXQT');
  if ((await commissionsOf(oVoid)).length) bad.push('commission on a cancelled order');
  // 5. No financial record → no commission (never ₹0), logged; created later by the backfill once the record exists.
  const oNone = await order('NOREC');
  await attribute(oNone, 'CM-CMAXQT');
  if ((await commissionsOf(oNone)).length) bad.push('commission without a financial record');
  // 6. No rate in effect → no commission, logged.
  const oNoRate = await order('NORATE', { value: '100.00' });
  await attribute(oNoRate, 'CM-CMNRQT');
  if ((await commissionsOf(oNoRate)).length) bad.push('commission without a rate');
  const skipped = (await pool.query(`SELECT metadata->>'skipped' AS s FROM affiliate_events WHERE action = 'commission_not_created' AND affiliate_id = ANY($1) ORDER BY id`, [[A, N]])).rows.map((r) => r.s);
  if (skipped.join() !== 'order_cancelled,no_financial_snapshot,no_rate') bad.push(`skip log ${skipped.join()}`);
  gid += 1;
  await pool.query(`INSERT INTO order_financial_snapshots (order_id, shopify_order_gid, sequence, content_hash, shop_currency, presentment_currency, taxes_included,
      financial_status, current_subtotal, current_total_tax, current_shipping, current_total_discounts, current_total_price, total_price, total_refunded, total_refunded_shipping, money)
    VALUES ($1, $2, 1, $3, 'INR', 'INR', true, 'PAID', 80, 0, 0, 0, 80, 80, 0, 0, '{}')`, [oNone, `gid://shopify/Order/${gid}`, crypto.createHash('sha256').update('cm-late').digest('hex')]);
  // A #2809-like attribution made before the ledger existed (no commission_not_created log) is never backfilled,
  // even with a financial record; nor is the voided one (still cancelled).
  const oPre = await order('PRELEDGER', { value: '273.00', sub: '215.00', tax: '41.64', ship: '58.00' });
  await pool.query(`INSERT INTO affiliate_order_attributions (order_id, affiliate_id, attribution_method, order_placed_at, rule_version, attributed_at) VALUES ($1, $2, 'gokwik_full_url', now() - interval '1 hour', 'v2', now() - interval '1 hour')`, [oPre, A]);
  const bf = await backfillAffiliateCommissions({ actor: ACT });
  const bf2 = await backfillAffiliateCommissions({ actor: ACT });
  const late = (await commissionsOf(oNone))[0];
  if (!late || late.commission_amount !== '8.00' || bf.created !== 1 || bf2.created !== 0) bad.push(`backfill ${JSON.stringify([bf, bf2, late?.commission_amount])}`);
  if ((await commissionsOf(oPre)).length || (await commissionsOf(oVoid)).length) bad.push('pre-ledger or voided attribution backfilled');
  // 7. Cancelled after the commission: kept, flagged, not counted as earned; finance staff reverse it (reason required), amounts kept.
  const oCan = await order('CANCEL', { value: '400.00' });
  await attribute(oCan, 'CM-CMAXQT');
  await pool.query(`UPDATE orders SET order_status = 'cancelled' WHERE id = $1`, [oCan]);
  let perf = await getAffiliatePerformance('CMAXQT', { money: true });
  const inr = perf.totals.by_currency.find((x) => x.currency === 'INR');
  // INR earned: 21.67 (12.5%) + 8.00 (10% on ₹80); the cancelled order's 40.00 apart; order value 273 + 80 + 273 (pre-ledger, no commission).
  if (inr.commission_earned !== 29.67 || inr.on_cancelled_orders !== 40 || inr.order_value !== 626 || !perf.orders.find((o) => o.order === '#CMCANCEL').cancelled) bad.push(`INR totals ${JSON.stringify(inr)}`);
  if (perf.totals.by_currency.find((x) => x.currency === 'USD').commission_earned !== 2) bad.push('USD totals');
  // The earned breakdown reconciles: pending + approved + paid = commission earned, per currency; the cancelled
  // order's 40.00 is only in on_cancelled_orders (not in pending).
  for (const x of perf.totals.by_currency) {
    const sum = Math.round((x.by_status.pending + x.by_status.approved + x.by_status.paid) * 100) / 100;
    if (sum !== x.commission_earned) bad.push(`${x.currency} breakdown ${sum} ≠ earned ${x.commission_earned}`);
  }
  if (inr.by_status.pending !== 29.67 || inr.on_cancelled_orders !== 40) bad.push(`cancelled commission in the pending breakdown ${JSON.stringify(inr.by_status)}`);
  const afSrc = await fsp.readFile(new URL('../public/affiliates.js', import.meta.url), 'utf8');
  if (!/on_cancelled_orders \? `\$\{esc\(cash\(c\.currency, c\.on_cancelled_orders\)\)\} on cancelled orders, not counted`/.test(afSrc)) bad.push('cancelled commission no longer shown apart on the page');
  // With no commission at all, the earned caption reads "No commission yet" (not a second "—").
  if (!afSrc.includes("!anyCommission ? 'No commission yet'")) bad.push('empty commission caption');
  const cc = (await commissionsOf(oCan))[0];
  await expectErr('reverse without reason', () => setCommissionStatus('CMAXQT', Number(cc.id), { status: 'reversed', actor: ACT }), (e) => e.status === 400);
  await setCommissionStatus('CMAXQT', Number(cc.id), { status: 'reversed', reason: 'Order cancelled', actor: ACT });
  const ccAfter = (await commissionsOf(oCan))[0];
  if (ccAfter.status !== 'reversed' || ccAfter.commission_amount !== '40.00' || ccAfter.rate_bps !== 1000 || ccAfter.base_amount !== '400.00' || ccAfter.status_reason !== 'Order cancelled') bad.push('reversal');
  // 8. Status path pending → approved → paid; illegal moves refused; every move in the history and the activity log.
  await expectErr('pending → paid', () => setCommissionStatus('CMAXQT', Number(c1[0].id), { status: 'paid', actor: ACT }), (e) => e.status === 409);
  await setCommissionStatus('CMAXQT', Number(c1[0].id), { status: 'approved', actor: ACT });
  await setCommissionStatus('CMAXQT', Number(c1[0].id), { status: 'paid', actor: ACT });
  await expectErr('reversed → approved', () => setCommissionStatus('CMAXQT', Number(cc.id), { status: 'approved', actor: ACT }), (e) => e.status === 409);
  const hist = (await pool.query('SELECT from_status, to_status FROM affiliate_commission_events WHERE commission_id = $1 ORDER BY id', [c1[0].id])).rows.map((r) => `${r.from_status}>${r.to_status}`).join(',');
  if (hist !== 'null>pending,pending>approved,approved>paid') bad.push(`history ${hist}`);
  await expectErr('history edit', () => pool.query('UPDATE affiliate_commission_events SET reason = $2 WHERE commission_id = $1', [c1[0].id, 'x']), (e) => /append-only/.test(e.message));
  // The same rules hold in the database itself, not just in the application (raw SQL around setCommissionStatus).
  await expectErr('db: delete history', () => pool.query('DELETE FROM affiliate_commission_events WHERE commission_id = $1', [c1[0].id]), (e) => /never deleted/.test(e.message));
  await expectErr('db: reversed → approved', () => pool.query(`UPDATE affiliate_commissions SET status = 'approved' WHERE id = $1`, [cc.id]), (e) => /reversed commission cannot become approved/.test(e.message));
  await expectErr('db: paid → pending', () => pool.query(`UPDATE affiliate_commissions SET status = 'pending' WHERE id = $1`, [c1[0].id]), (e) => /paid commission cannot become pending/.test(e.message));
  const { rows: [pend] } = await pool.query(`SELECT id FROM affiliate_commissions WHERE order_id = $1`, [oUsd]);
  await expectErr('db: pending → paid', () => pool.query(`UPDATE affiliate_commissions SET status = 'paid' WHERE id = $1`, [pend.id]), (e) => /pending commission cannot become paid/.test(e.message));
  await expectErr('db: reverse without reason', () => pool.query(`UPDATE affiliate_commissions SET status = 'reversed', status_reason = NULL WHERE id = $1`, [pend.id]), (e) => /affiliate_commissions_reversal_reason/.test(e.message));
  await expectErr('db: reverse with blank reason', () => pool.query(`UPDATE affiliate_commissions SET status = 'reversed', status_reason = '  ' WHERE id = $1`, [pend.id]), (e) => /affiliate_commissions_reversal_reason/.test(e.message));
  await expectErr('db: second commission for one attribution', () => pool.query(
    `INSERT INTO affiliate_commissions (affiliate_id, attribution_id, order_id, currency, rate_bps, base_amount, commission_amount) SELECT affiliate_id, attribution_id, order_id, currency, rate_bps, base_amount, commission_amount FROM affiliate_commissions WHERE id = $1`, [pend.id]),
  (e) => /affiliate_commissions_attribution_key/.test(e.message));
  await expectErr('db: created as paid', () => pool.query(
    `INSERT INTO affiliate_commissions (affiliate_id, attribution_id, order_id, currency, rate_bps, base_amount, commission_amount, status) SELECT affiliate_id, attribution_id, order_id, currency, rate_bps, base_amount, commission_amount, 'paid' FROM affiliate_commissions WHERE id = $1`, [pend.id]),
  (e) => /created as pending/.test(e.message));
  if ((await pool.query('SELECT status FROM affiliate_commissions WHERE id = $1', [pend.id])).rows[0].status !== 'pending') bad.push('a refused raw update changed the status');
  const logged = (await pool.query(`SELECT action FROM affiliate_events WHERE affiliate_id = $1 AND action LIKE 'commission_%' ORDER BY id`, [A])).rows.map((r) => r.action);
  for (const want of ['commission_created', 'commission_not_created', 'commission_reversed', 'commission_approved', 'commission_paid']) if (!logged.includes(want)) bad.push(`audit ${want}`);
  // 9. API: admins and finance staff see money; a viewer sees orders without money fields (absent, not zero); viewers cannot move statuses.
  const adm = await af('adm', 'GET', '/api/affiliates/CMAXQT/performance');
  const fin = await af('finance', 'GET', '/api/affiliates/CMAXQT/performance');
  const vw = await af('viewer', 'GET', '/api/affiliates/CMAXQT/performance');
  const o2809 = (r) => r.body.performance?.orders.find((o) => o.order === '#CM2809');
  if (adm.status !== 200 || !adm.body.money || o2809(adm)?.order_value !== 273 || o2809(adm)?.commission?.amount !== 21.67 || o2809(adm)?.commission?.base_amount !== 173.36 || o2809(adm)?.commission?.rate_bps !== 1250 || o2809(adm)?.commission?.status !== 'paid') bad.push(`admin view ${JSON.stringify(o2809(adm))}`);
  if (fin.status !== 200 || !fin.body.money || !fin.body.canApprove || !fin.body.canPay) bad.push('finance view');
  const v = o2809(vw);
  if (vw.status !== 200 || vw.body.money || !v || 'order_value' in v || 'commission' in v || 'currency' in v || 'totals' in vw.body.performance) bad.push(`viewer saw money ${JSON.stringify(vw.body.performance)}`);
  if (vw.body.performance?.clicks?.total === undefined || vw.body.performance.attributions.total !== 6) bad.push('viewer counts');
  const vMove = await af('viewer', 'POST', `/api/affiliates/CMAXQT/commissions/${late.id}/status`, { status: 'approved' });
  const mMove = await af('manager', 'POST', `/api/affiliates/CMAXQT/commissions/${late.id}/status`, { status: 'approved' });
  const fMove = await af('finance', 'POST', `/api/affiliates/CMAXQT/commissions/${late.id}/status`, { status: 'approved' });
  if (vMove.status !== 403 || mMove.status !== 403 || fMove.status !== 200) bad.push(`status moves ${vMove.status}/${mMove.status}/${fMove.status}`);
  // Only mapped statuses can be requested — pending or an unknown status is refused before the commission is read,
  // for every role (the database lifecycle is not the authorization boundary), and the answer reveals nothing.
  for (const who of ['manager', 'finance', 'adm']) {
    for (const status of ['pending', 'bogus', '', 'constructor', '__proto__']) {
      const r = await af(who, 'POST', `/api/affiliates/CMAXQT/commissions/${late.id}/status`, { status });
      if (r.status !== 403 || r.body.error !== 'That status cannot be set.') bad.push(`${who} ${JSON.stringify(status)} → ${r.status} ${r.body.error}`);
    }
  }
  if ((await commissionsOf(oNone))[0].status !== 'approved') bad.push('a refused request changed the commission');
  // The activity log never shows amounts.
  const ev = await af('viewer', 'GET', '/api/affiliates/CMAXQT');
  if (/21\.67|173\.36|₹|commission_amount/.test(JSON.stringify(ev.body.events || ev.body))) bad.push('amounts in the activity log');
  // "Clicks in the last 30 days" = the last 30 IST calendar days, today included: a click at 00:00 IST 29 days
  // ago counts; one a second earlier does not (a rolling 30×24h window would count both or neither).
  const { rows: [b30] } = await pool.query(`SELECT ((((now() AT TIME ZONE 'Asia/Kolkata')::date - 29)::timestamp) AT TIME ZONE 'Asia/Kolkata') AS since`);
  const { rows: [asset] } = await pool.query(`SELECT id FROM affiliate_referral_assets WHERE affiliate_id = $1 LIMIT 1`, [A]);
  const c30 = async () => (await getAffiliatePerformance('CMAXQT')).clicks;
  const before30 = await c30();
  await pool.query(`INSERT INTO affiliate_referral_clicks (public_id, affiliate_id, referral_asset_id, visitor_id, clicked_at) VALUES
    ('cmIstBoundaryClick0001', $1, $2, 'cmIstBoundaryVisitor01', $3), ('cmIstBoundaryClick0002', $1, $2, 'cmIstBoundaryVisitor02', $3::timestamptz - interval '1 second')`, [A, asset.id, b30.since]);
  const after30 = await c30();
  if (after30.total - before30.total !== 2 || after30.last_30_days - before30.last_30_days !== 1) bad.push(`IST 30-day window ${JSON.stringify([before30, after30])}`);
  if (new Date(b30.since).getUTCHours() !== 18 || new Date(b30.since).getUTCMinutes() !== 30) bad.push(`window does not start at 00:00 IST: ${new Date(b30.since).toISOString()}`);
  // The New affiliate drawer keeps its fixes: padded form, scrolling body, in-drawer discard (no native confirm).
  const afPage = await fsp.readFile(new URL('../public/affiliates.js', import.meta.url), 'utf8');
  const afHtml = await fsp.readFile(new URL('../public/affiliates.html', import.meta.url), 'utf8');
  const uiCss = await fsp.readFile(new URL('../public/ui.css', import.meta.url), 'utf8');
  if (/window\.confirm\('Discard your unsaved changes\?'\)/.test(afPage) || !/state\.discardAsked/.test(afPage) || !afHtml.includes('id="dDiscard"') || !afHtml.includes('Keep editing')
    || !afHtml.includes('class="drawer af-drawer"') || !/\.af-drawer \.drawer-body > form \{ padding/.test(uiCss) || !/\.drawer-body \{ overflow-y: auto; flex: 1; min-height: 0; \}/.test(uiCss)
    || !/\$\('#dClose'\)\.addEventListener\('click'/.test(afPage) || !/drawerScrim'\)\.addEventListener\('click'/.test(afPage) || !/e\.key === 'Escape'\) closeDrawer\(\)/.test(afPage)) bad.push('drawer fixes');
  // Recorded tax larger than the subtotal → no commission (negative base), logged; never a guessed amount.
  const oNeg = await order('NEG', { value: '10.00', sub: '10.00', tax: '12.00' });
  await attribute(oNeg, 'CM-CMAXQT');
  if ((await commissionsOf(oNeg)).length) bad.push('commission on a negative base');
  await purgeTestOrders(P); await purgeTestAffiliates(ACT);
  if (bad.length) throw new Error(bad.join(' | '));
  return 'base = subtotal ₹215.00 − recorded tax ₹41.64 = ₹173.36 (shipping ₹58 and tax excluded) × 12.5% → one ₹21.67 commission (rate 1250 kept after a new 10% rate; amounts and history immutable); negative base → none; USD kept as USD ₹→$2.50; no record / no rate / voided → none, logged; retried by the backfill only when skipped-and-logged (pre-ledger #2809-like never); cancelled order flagged, not earned, reversed with a reason; pending→approved→paid audited, illegal moves 409; admin/finance see money, viewer gets no money fields and cannot move statuses; activity shows no amounts';
});

await step('affiliates admin cleanup', async () => {
  let n = 0;
  for (const actor of [...Object.values(AFN), 'HR admin', 'db-check-overview-commerce', 'db-check-commissions']) {
    const r = await purgeTestAffiliates(actor);
    n += r.affiliates;
    // Verification documents written by these tests (the throwaway local store).
    for (const k of r.paths || []) await fsp.rm(path.join(HRS.dir, k), { force: true }).catch(() => {});
  }
  // Orders made by the Phase 1E attribution test (their attributions go with them).
  await purgeTestOrders(SH_PREFIX);
  await getPool().query(`DELETE FROM order_imports WHERE kind = 'shopify_sync' AND imported_by = $1`, [SH_ACTOR]);
  await getPool().query('DELETE FROM member_module_roles WHERE phone = ANY($1)', [Object.values(AFP)]);
  await getPool().query('DELETE FROM member_log WHERE target_phone = ANY($1)', [Object.values(AFP)]);
  await getPool().query('DELETE FROM allowed_users WHERE phone = ANY($1)', [Object.values(AFP)]);
  const left = (await getPool().query(`SELECT count(*)::int n FROM affiliates WHERE display_name LIKE 'DBCHECK-AF%'`)).rows[0].n;
  if (left) throw new Error(`${left} test affiliates left`);
  return `${n} test affiliates (with rates and events) and 4 test members removed`;
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
