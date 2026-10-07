import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  isMockMode, ensureSchema, insertCart, listCarts, updateStatus, ping,
  matchOrderToCarts, reasonSummary, statsByCaller, staleCarts, searchCarts, conflictingUpdate,
  recordSystemEvent, getSystemState, recordWebhookFailure, webhookFailureCount, cartCount,
  listMembers, upsertMember, updateMember, deleteMember, otherActiveAdminCount, setModuleRole, moduleRolesOf,
  recordMemberChange, recentMemberChanges, changeMemberPhone,
  adminOverview, whoIsOnline, periodReport, importCarts,
  actionQueue, cartsForBucket, cartsByStatus, ACTION_BUCKETS, dailySnapshot,
  cartEvents, recentEvents, callbackAtOf,
} from './lib/db.js';
import { getPool } from './lib/db.js';
import { assertDatabaseEnvironment } from './lib/env-guard.js';
import {
  mockInsertCart, mockListCarts, mockUpdateStatus, mockMatchOrder,
  mockReasonSummary, mockStatsByCaller, mockStaleCarts, mockSearchCarts,
} from './lib/mock.js';
import {
  normalizePayload, normalizeOrderPayload, parseLineItems, redactPayload,
} from './lib/normalize.js';
import {
  router as authRouter, requireAuth, requireAdmin, currentUserName, invalidateMembership,
  requirePermission, requirePage, requireCompleteProfile,
} from './lib/auth-routes.js';
import { getProfile, updateProfile, savePhoto, clearPhoto, photoFile, memberActivity, MAX_PHOTO_BYTES } from './lib/profile.js';
import { homeFor, MODULE_KEYS, isValidAssignment } from './lib/permissions.js';
import { careersHost } from './lib/careers.js';
import { router as hrRouter } from './lib/hr-routes.js';
import { ensureHrSchema, retryPendingRemovals } from './lib/hr.js';
import { overviewFor } from './lib/overview.js';
import { router as marketingRouter } from './lib/marketing-routes.js';
import { router as ordersRouter, courierRouter, destinationRouter } from './lib/orders-routes.js';
import { router as inventoryRouter } from './lib/inventory-routes.js';
import { ensureInventorySchema } from './lib/inventory.js';
import { activeUsers, seedAllowedUsers, normalisePhone, bootstrapAdmins, nameFor } from './lib/otp.js';
import { mapShopifyCsv } from './lib/shopify-csv.js';
import { toCsv } from './lib/csv.js';
import { driver } from './lib/whatsapp.js';
import { startKeepAlive } from './lib/keepalive.js';
import { startSlaAlerts, isIngestSilent } from './lib/sla-alert.js';
import { startShopifyPoll, pollShopifyOnce } from './lib/shopify-poll.js';
import { shopifyConfigured, authMode, apiVersionWarning, getAccessToken } from './lib/shopify.js';
import {
  SCOPES as SHOPIFY_SCOPES, normaliseShop, installUrl, verifyHmac, exchangeCode,
  storeToken, loadToken,
} from './lib/shopify-oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const app = express();
const MOCK = isMockMode();

app.set('trust proxy', 1);
// careers.briyo.xyz — the public Careers surface of this app. First, before any
// parser, session or static file: that host gets only the careers routes, or a
// 404 (lib/careers.js). Every other host continues to the app below.
app.use(careersHost);

/**
 * The webhook takes the body as raw text and parses it itself, so a malformed
 * delivery is still stored rather than being rejected by the JSON parser before
 * our handler runs. Everything else uses the normal JSON parser.
 */
app.use('/api/webhook', express.text({ type: '*/*', limit: '2mb' }));
// The CSV is posted as raw text rather than multipart — no upload dependency,
// and a Shopify export of a few thousand checkouts is well under this cap.
app.use('/api/admin/import', express.text({ type: '*/*', limit: '20mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Malformed JSON on any non-webhook route: answer in JSON, not an HTML stack trace.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'Malformed JSON body.' });
  }
  return next(err);
});

const VALID_STATUSES = new Set([
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
]);

/** Fixed vocabulary — free-text goes in notes, these are for aggregation. */
const REASON_TAGS = [
  'Price objection',
  'Shipping time',
  'Out of stock',
  'Already purchased elsewhere',
  'Not interested',
  'Changed mind',
  'Product doubt/question',
  'Other',
];

const SLA_HOURS = Number(process.env.SLA_STALE_HOURS || 6);


const db = {
  insert: (n, raw) => (MOCK ? mockInsertCart(n, raw) : insertCart(n, raw)),
  list: (opts) => (MOCK ? mockListCarts(opts) : listCarts(opts)),
  search: (q, limit) => (MOCK ? mockSearchCarts(q, limit) : searchCarts(q, limit)),
  update: (id, patch) => (MOCK ? mockUpdateStatus(id, patch) : updateStatus(id, patch)),
  matchOrder: (o) => (MOCK ? mockMatchOrder(o) : matchOrderToCarts(o)),
  reasons: (days) => (MOCK ? mockReasonSummary(days) : reasonSummary(days)),
  byCaller: (days) => (MOCK ? mockStatsByCaller(days) : statsByCaller(days)),
  stale: (hours) => (MOCK ? mockStaleCarts(hours) : staleCarts(hours)),
  noteIngest: async () => { if (!MOCK) await recordSystemEvent(LAST_INGEST_KEY); },
  lastIngest: async () => {
    if (MOCK) return null;
    return (await getSystemState(LAST_INGEST_KEY))?.updated_at ?? null;
  },
  noteFailure: async (f) => { if (!MOCK) await recordWebhookFailure(f); },
};

const LAST_INGEST_KEY = 'last_cart_webhook';

// =========================================================================
// Webhook — PUBLIC by design. GoKwik cannot send a session cookie, so this
// route sits above requireAuth and authenticates with a shared secret instead.
// =========================================================================

/** Constant-time compare so the secret isn't leaked by response timing. */
function secretMatches(candidate, expected) {
  if (!candidate || !expected || candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

app.post('/api/webhook/gokwik/abandoned-cart', async (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    console.error('WEBHOOK_SECRET is not set; rejecting webhook');
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }

  const provided = req.get('x-webhook-secret') || req.query.secret;
  if (!secretMatches(typeof provided === 'string' ? provided : '', expected)) {
    console.warn('Webhook rejected: bad or missing secret');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Body arrives as text; parse defensively so nothing is ever dropped.
  let payload;
  try {
    payload = JSON.parse(req.body || '{}');
    if (!payload || typeof payload !== 'object') payload = { _unparsed_body: req.body };
  } catch {
    console.warn('Webhook body was not valid JSON; storing it raw.');
    payload = { _unparsed_body: String(req.body ?? '') };
  }
  // Normalise from the full payload, store the redacted one.
  const normalized = normalizePayload(payload);
  const stored = redactPayload(payload);

  try {
    if (!MOCK) await ensureSchema();
    const { id, duplicate } = await db.insert(normalized, stored);
    await db.noteIngest();
    console.log(`Cart ${duplicate ? 'updated' : 'received'}: ${normalized.cartId || '(no id)'} -> row ${id}`);
    return res.status(200).json({ ok: true, id, duplicate });
  } catch (err) {
    // Still 200: GoKwik retries on non-2xx and a retry storm is worse. But the
    // failure is persisted rather than left in Render's rotating logs, so it can
    // be counted on /readyz and replayed once the cause is fixed.
    console.error('Failed to store cart:', err.message, JSON.stringify(payload).slice(0, 600));
    await db.noteFailure({ kind: 'abandoned-cart', error: err.message, body: req.body })
      .catch((e) => console.error('Could not even record the failure:', e.message));
    return res.status(200).json({ ok: true, stored: false });
  }
});

/**
 * Public, dependency-free liveness endpoint.
 * Free hosting tiers sleep after ~15 minutes idle and take up to a minute to
 * wake, which is long enough for a webhook delivery to time out. Point a free
 * uptime pinger at this every 10 minutes to keep the instance warm. It touches
 * no database and reveals nothing.
 */
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

/**
 * Diagnostics. Deliberately separate from /healthz, which must stay
 * dependency-free — the keep-alive pinger hits that one, and a database blip
 * must never be able to make the instance look unhealthy and stop being pinged.
 *
 * This is the endpoint to open when someone asks "is the board broken?".
 * Secret-gated with the webhook secret since it reports operational detail.
 */
/**
 * Shopify's side of /readyz. The live token check is opt-in (?shopify=1) so the
 * routine diagnostic stays free of an outbound call — but it is the only way to
 * tell "credentials present" from "credentials work".
 */
async function shopifyStatus(probe) {
  const out = {
    configured: shopifyConfigured(),
    mode: authMode(),
    lastPoll: MOCK ? null
      : (await getSystemState('last_shopify_poll').catch(() => null))?.updated_at ?? null,
  };
  const oauth = await loadToken(process.env.SHOPIFY_STORE_DOMAIN).catch(() => null);
  out.oauthConnected = Boolean(oauth?.token);
  if (oauth?.scope) out.grantedScopes = oauth.scope;
  out.neededScopes = SHOPIFY_SCOPES;
  const warn = apiVersionWarning();
  if (warn) out.apiVersionWarning = warn;
  if (!probe || !out.configured) return out;
  try {
    await getAccessToken({ force: true });
    out.tokenOk = true;
  } catch (err) {
    out.tokenOk = false;
    out.tokenError = err.message;
  }
  return out;
}

/**
 * Connecting Shopify — the one-time OAuth handshake.
 *
 * Admin-only, because it grants this app read access to the store's orders.
 * The `state` nonce lives in a short cookie and is compared on the way back, so
 * a callback we did not initiate is rejected even if it carries a valid HMAC.
 */
const OAUTH_STATE_COOKIE = 'shopify_oauth_state';

const callbackUrl = (req) =>
  `${process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`}/auth/shopify/callback`;

// requireAuth explicitly: this route sits above the global app.use(requireAuth),
// so without it req.session is never populated and requireAdmin refuses even a
// signed-in admin. It also gives a signed-out browser a redirect to /login
// rather than a page of JSON.
app.get('/auth/shopify/install', requireAuth, requireAdmin, (req, res) => {
  const shop = normaliseShop(req.query.shop || process.env.SHOPIFY_STORE_DOMAIN);
  if (!shop) {
    return res.status(400).send('Set SHOPIFY_STORE_DOMAIN to your <store>.myshopify.com domain first.');
  }
  if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(400).send('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', maxAge: 10 * 60_000,
    secure: process.env.COOKIE_SECURE !== 'false',
  });
  return res.redirect(installUrl({ shop, state, redirectUri: callbackUrl(req) }));
});

app.get('/auth/shopify/callback', async (req, res) => {
  const shop = normaliseShop(req.query.shop);
  const expected = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE);

  if (!shop) return res.status(400).send('Shopify sent an unrecognised shop domain.');
  if (!expected || expected !== req.query.state) {
    return res.status(403).send('This link did not come from here. Start again from /admin.');
  }
  if (!verifyHmac(req.query)) {
    return res.status(403).send('Shopify signature check failed.');
  }

  try {
    const { access_token: token, scope } = await exchangeCode({ shop, code: req.query.code });
    await storeToken({ shop, token, scope });
    console.log(`Shopify connected to ${shop}. Scopes: ${scope || '(none reported)'}`);
    // Pull straight away rather than making someone wait out the poll interval.
    pollShopifyOnce({ assignedTo: normalisePhone(process.env.IMPORT_DEFAULT_CALLER || '') || null })
      .catch((err) => console.error('First Shopify pull failed:', err.message));
    return res.redirect('/import?shopify=connected');
  } catch (err) {
    console.error('Shopify OAuth failed:', err.message);
    return res.status(502).send(`Could not complete the Shopify connection: ${err.message}`);
  }
});

app.get('/readyz', async (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  const provided = req.get('x-webhook-secret') || req.query.secret;
  if (!expected || !secretMatches(typeof provided === 'string' ? provided : '', expected)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const out = {
    ok: true, mock: MOCK, ts: new Date().toISOString(),
    slaHours: SLA_HOURS, silenceHours: Number(process.env.INGEST_SILENCE_HOURS || 8),
  };
  if (MOCK) return res.json({ ...out, storage: 'mock' });

  try {
    const [info, last, carts, stale, failures] = await Promise.all([
      ping(), db.lastIngest(), cartCount(), db.stale(SLA_HOURS), webhookFailureCount(24),
    ]);
    const ageHours = last ? (Date.now() - new Date(last).getTime()) / 3600000 : null;
    const silent = isIngestSilent(last, out.silenceHours);
    return res.json({
      ...out,
      storage: 'postgres',
      database: String(info.version).split(',')[0],
      carts,
      lastCartWebhook: last,
      lastCartWebhookAgeHours: ageHours === null ? null : Math.round(ageHours * 100) / 100,
      ingestSilent: silent,
      staleCarts: stale.count,
      webhookFailures24h: failures,
      shopify: await shopifyStatus(req.query.shopify === '1'),
      // The one field to look at first — false here means something is wrong.
      healthy: !silent && failures === 0,
    });
  } catch (err) {
    return res.status(503).json({ ...out, ok: false, error: err.message });
  }
});

// Lets you confirm the URL is live before handing it to GoKwik.
app.get('/api/webhook/gokwik/abandoned-cart', (_req, res) =>
  res.json({ ok: true, message: 'GoKwik abandoned-cart webhook receiver. POST here.' }));

/**
 * Order-completed / payment-confirmed events from GoKwik.
 *
 * NOT YET CONFIRMED with GoKwik — the event name and payload shape are unknown,
 * and this endpoint will receive nothing until they enable it. It is written to
 * store whatever arrives and warn about missing fields rather than fail, so the
 * first real delivery is diagnosable from raw_payload.
 */
app.post('/api/webhook/gokwik/order-completed', async (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    console.error('WEBHOOK_SECRET is not set; rejecting order webhook');
    return res.status(500).json({ ok: false, error: 'server_not_configured' });
  }
  const provided = req.get('x-webhook-secret') || req.query.secret;
  if (!secretMatches(typeof provided === 'string' ? provided : '', expected)) {
    console.warn('Order webhook rejected: bad or missing secret');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body || '{}');
    if (!payload || typeof payload !== 'object') payload = { _unparsed_body: req.body };
  } catch {
    console.warn('Order webhook body was not valid JSON; storing it raw.');
    payload = { _unparsed_body: String(req.body ?? '') };
  }

  const order = normalizeOrderPayload(payload);

  // Warn, never throw — an unmatched or unparseable order must not 500.
  const missing = ['orderId', 'phone', 'email'].filter((k) => !order[k]);
  if (missing.length) {
    console.warn(
      `Order webhook: missing ${missing.join(', ')}. Payload keys: [${Object.keys(payload).join(', ')}]`);
  }
  if (!order.phone && !order.email) {
    console.warn('Order webhook: no phone or email, cannot match any cart. Full payload:',
      JSON.stringify(payload).slice(0, 600));
    return res.status(200).json({ ok: true, matched: 0, reason: 'no phone or email in payload' });
  }

  try {
    if (!MOCK) await ensureSchema();
    const matched = await db.matchOrder({
      phone: order.phone,
      email: order.email,
      orderId: order.orderId,
      orderName: order.orderName,
      updatedBy: 'Auto (GoKwik order match)',
    });
    if (matched.length) {
      console.log(`Order ${order.orderName || order.orderId}: auto-recovered ${matched.length} cart(s) — ` +
        matched.map((m) => `${m.cart_id} via ${m.matched_on}`).join(', '));
    } else {
      console.log(`Order ${order.orderName || order.orderId}: no open cart matched`);
    }
    return res.status(200).json({ ok: true, matched: matched.length });
  } catch (err) {
    console.error('Order webhook failed:', err.message, JSON.stringify(payload).slice(0, 600));
    await db.noteFailure({ kind: 'order-completed', error: err.message, body: req.body })
      .catch((e) => console.error('Could not even record the failure:', e.message));
    return res.status(200).json({ ok: true, matched: 0, stored: false });
  }
});

app.get('/api/webhook/gokwik/order-completed', (_req, res) =>
  res.json({ ok: true, message: 'GoKwik order-completed receiver. POST here to auto-mark carts recovered.' }));

// --- public: login page and its assets --------------------------------------
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.use('/login.js', express.static(path.join(PUBLIC, 'login.js')));
app.use('/styles.css', express.static(path.join(PUBLIC, 'styles.css')));
app.use('/auth', authRouter);

// --- everything below requires a session ------------------------------------
app.use(requireAuth);

// ---------------------------------------------------------------------------
// Member profile (Briyo OS). Before the profile gate: these are exactly the
// routes a member with an incomplete profile may use.
// ---------------------------------------------------------------------------
const profileError = (res, err) => (err.status && err.status < 500
  ? res.status(err.status).json({ ok: false, error: err.message, field: err.field, conflict: err.conflict })
  : fail(res, err));
app.get('/profile', (_req, res) => res.sendFile(path.join(PUBLIC, 'profile.html')));
app.get('/api/profile', async (req, res) => {
  try { res.json({ ok: true, profile: await getProfile(req.session.phone), home: homeFor(req.session.caps || []) }); }
  catch (err) { profileError(res, err); }
});
app.put('/api/profile', async (req, res) => {
  try {
    const { name, email } = req.body ?? {};
    const profile = await updateProfile(req.session.phone, { name, email }, { actor: await currentUserName(req) });
    invalidateMembership(req.session.phone);
    res.json({ ok: true, profile });
  } catch (err) { profileError(res, err); }
});
app.post('/api/profile/photo', express.raw({ type: () => true, limit: MAX_PHOTO_BYTES + 1024 }), async (req, res) => {
  try {
    let filename = '';
    try { filename = decodeURIComponent(String(req.get('x-filename') || 'photo')); } catch { filename = 'photo'; }
    const profile = await savePhoto(req.session.phone, { filename, buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) },
      { actor: await currentUserName(req) });
    invalidateMembership(req.session.phone);
    res.status(201).json({ ok: true, profile });
  } catch (err) {
    if (err.name === 'StorageNotConfigured') return res.status(503).json({ ok: false, error: 'Photo storage is not configured.' });
    profileError(res, err);
  }
});
// A photo over the limit is stopped by the body parser: answer like the route would.
// eslint-disable-next-line no-unused-vars
app.use('/api/profile/photo', (err, _req, res, _next) => (err.type === 'entity.too.large'
  ? res.status(413).json({ ok: false, field: 'photo', error: 'That photo is larger than 2 MB. Please choose a smaller one.' })
  : fail(res, err)));
// Any signed-in member may see a teammate's photo (avatars). Streamed, never a storage URL.
app.get('/api/members/:phone/photo', async (req, res) => {
  try {
    const f = await photoFile(normalisePhone(req.params.phone) || '');
    if (req.get('if-none-match') === f.etag) return res.status(304).end();
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400', ETag: f.etag });
    res.send(f.buffer);
  } catch (err) { res.status(err.status || 500).type('text').send(err.status ? 'Not found' : 'Error'); }
});
app.use(requireCompleteProfile);

// Module access: every area checks a capability (lib/permissions.js), never a
// role name. Pages a member cannot use send them to one they can, or to the
// "No module access yet" page; APIs answer 403.
app.get(['/', '/index.html'], requirePage('support.work'));
app.use(['/api/carts', '/api/status', '/api/reasons'], requirePermission('support.work'));
app.get('/no-access', (req, res) => {
  if ((req.session?.caps || []).length) return res.redirect(homeFor(req.session.caps));
  return res.sendFile(path.join(PUBLIC, 'no-access.html'));
});
const ORDER_PAGES = { '/orders': 'orders.html', '/couriers': 'couriers.html', '/destinations': 'destinations.html', '/inventory': 'inventory.html' };
const PAGE_CAP = { '/orders': 'logistics.view', '/couriers': 'logistics.view', '/destinations': 'logistics.view', '/inventory': 'inventory.view' };
app.get(['/orders', '/orders.html', '/couriers', '/couriers.html', '/destinations', '/destinations.html', '/inventory', '/inventory.html'],
  (req, res, next) => requirePage(PAGE_CAP[req.path.replace(/\.html$/, '')])(req, res, next),
  (req, res) => res.sendFile(path.join(PUBLIC, ORDER_PAGES[req.path.replace(/\.html$/, '')])));
app.use('/api/orders', requirePermission('logistics.view'), ordersRouter);
app.use('/api/couriers', requirePermission('logistics.view'), courierRouter);
app.use('/api/destinations', requirePermission('logistics.view'), destinationRouter);
// Inventory serves both modules: its own pages, and the stock panel of a shipment.
app.use('/api/inventory', requirePermission(['inventory.view', 'logistics.view']), inventoryRouter);
app.use('/api/hr', requirePermission('hr.view'), hrRouter);
// Marketing (Meta Ads): admins only in V1, read-only (lib/marketing-routes.js).
app.use('/api/marketing', requirePermission('marketing.view'), marketingRouter);
app.get('/marketing', requirePage('marketing.view'), (_req, res) => res.sendFile(path.join(PUBLIC, 'marketing.html')));
// Briyo OS overview: every signed-in member with a department. The API returns
// only the departments the caller may see (lib/overview.js); nothing else.
app.get('/overview', (req, res) => ((req.session?.caps || []).length
  ? res.sendFile(path.join(PUBLIC, 'overview.html')) : res.redirect('/no-access')));
app.get('/api/overview', async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...(await overviewFor(req.session, { slaHours: SLA_HOURS })) });
  } catch (err) {
    console.error('Overview failed:', err.message?.slice(0, 200));
    res.status(500).json({ ok: false, error: 'The overview could not be loaded. Try again in a moment.' });
  }
});

// HR pages: one page, two views (jobs, candidates). The careers host never gets here.
app.get('/hr', requirePage('hr.view'), (_req, res) => res.redirect('/hr/jobs'));
app.get(['/hr/jobs', '/hr/candidates'], requirePage('hr.view'), (_req, res) => res.sendFile(path.join(PUBLIC, 'hr.html')));

app.use(express.static(PUBLIC));

function fail(res, err, code = 500) {
  console.error(err);
  res.status(code).json({ ok: false, error: err.message || String(err) });
}

app.get('/api/config', async (req, res) => {
  // The team list is needed by every caller for the assignee dropdown, so it
  // lives here rather than behind the admin-only /api/members.
  let team = [];
  try {
    team = [...(await activeUsers()).entries()].map(([phone, name]) => ({ phone, name }));
  } catch (err) {
    console.error('Could not load the team list:', err.message);
  }
  res.json({
    mock: MOCK,
    statuses: [...VALID_STATUSES],
    reasonTags: REASON_TAGS,
    slaHours: SLA_HOURS,
    team,
    importDefaultCaller: normalisePhone(process.env.IMPORT_DEFAULT_CALLER || '') || null,
    // The board formats callback times in the team's timezone, not the
    // browser's, so a caller travelling or a laptop set to UTC still reads the
    // same "today 6:30 pm" the SLA and the reports mean.
    boardTimezone: process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata',
    // Two distinct states: credentials present, and the store actually authorised.
    shopifyConnected: shopifyConfigured(),
    shopifyAuthorized: shopifyConfigured()
      && Boolean((await loadToken(process.env.SHOPIFY_STORE_DOMAIN).catch(() => null))?.token),
    me: req.session?.phone ?? null,
    isAdmin: Boolean(req.session?.isAdmin),
  });
});

app.get('/api/carts', async (req, res) => {
  try {
    if (!MOCK) await ensureSchema();

    // `q` searches the whole history; otherwise the date range the UI already
    // has bounds the query server-side. Either way the client receives a small
    // enough array to keep filtering and sorting locally.
    const q = String(req.query.q ?? '').trim();
    const sinceDays = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);
    const result = q ? await db.search(q, 50) : await db.list({ sinceDays });

    const carts = result.carts.map((c) => {
      // Line items live in raw_payload, in either array or "#Name(Variant)*1"
      // form. Parse server-side so the browser gets one consistent shape.
      const raw = c.raw_payload || {};
      const source = raw.line_items ?? raw['Line items'] ?? raw.items ?? raw.products;
      const { raw_payload, ...rest } = c;
      return { ...rest, items: parseLineItems(source) };
    });
    res.json({
      ok: true, mock: MOCK, carts,
      total: result.total, truncated: result.truncated,
      query: q || null, days: q ? null : sinceDays,
      stale: await db.stale(SLA_HOURS), slaHours: SLA_HOURS,
    });
  } catch (err) { fail(res, err); }
});

app.post('/api/status', async (req, res) => {
  try {
    const { id, status, notes, callbackAt, reasonTags, assignedTo } = req.body ?? {};
    if (id === undefined || id === null) {
      return res.status(400).json({ ok: false, error: 'Missing cart id.' });
    }
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: `Unknown status: ${status}` });
    }

    let tags;
    if (reasonTags !== undefined) {
      if (!Array.isArray(reasonTags)) {
        return res.status(400).json({ ok: false, error: 'reasonTags must be an array.' });
      }
      const unknown = reasonTags.filter((t) => !REASON_TAGS.includes(t));
      if (unknown.length) {
        return res.status(400).json({ ok: false, error: `Unknown reason tag: ${unknown[0]}` });
      }
      tags = [...new Set(reasonTags)];
    }

    // A callback time only means anything while the status is "Callback
    // scheduled"; moving to any other status clears it rather than leaving a
    // stale reminder that would keep showing as overdue.
    let cb;
    if (callbackAt !== undefined) {
      cb = callbackAt ? new Date(callbackAt) : null;
      if (cb && Number.isNaN(cb.getTime())) {
        return res.status(400).json({ ok: false, error: 'Invalid callback date.' });
      }
      cb = cb ? cb.toISOString() : null;
    } else if (status !== undefined && status !== 'Callback scheduled') {
      cb = null;
    }

    /*
     * A callback with no time is not a callback.
     *
     * Every one of the first ten carts to reach this status had a null
     * callback_at, because the time was optional and easy to skip — which made
     * the status decorative: nothing could be sorted by when it was due and
     * "overdue" could never be true. The time is now required whenever the cart
     * ends up in that status, whether it is being set now or was already there.
     */
    if (status === 'Callback scheduled') {
      const settled = cb !== undefined ? cb : await callbackAtOf(id);
      if (!settled) {
        return res.status(400).json({
          ok: false, needsCallbackTime: true,
          error: 'Pick the date and time you promised to call back.',
        });
      }
    }

    // null unassigns; anything else must be a current, active member, so a cart
    // can never be assigned to someone who cannot sign in to see it.
    let assignee;
    if (assignedTo !== undefined) {
      if (assignedTo === null || assignedTo === '') {
        assignee = null;
      } else {
        const phone = normalisePhone(assignedTo);
        if (!phone || !(await activeUsers()).has(phone)) {
          return res.status(400).json({ ok: false, error: 'That person is not an active member.' });
        }
        assignee = phone;
      }
    }

    const updatedBy = await currentUserName(req);

    // If someone else saved this row since the client last read it, stop rather
    // than clobbering their notes. Only guards against *other* people.
    if (!MOCK && req.body?.seenAt) {
      const clash = await conflictingUpdate(id, req.body.seenAt, updatedBy);
      if (clash) {
        return res.status(409).json({
          ok: false, conflict: true,
          error: `${clash.updated_by || 'Someone'} changed this row while you were editing.`,
          current: clash,
        });
      }
    }

    const row = await db.update(id, {
      status, notes, callbackAt: cb, reasonTags: tags, updatedBy,
      ...(assignedTo !== undefined ? { assignedTo: assignee } : {}),
    });
    if (!row) return res.status(404).json({ ok: false, error: 'No such cart.' });
    return res.json({ ok: true, entry: row });
  } catch (err) { return fail(res, err); }
});

/**
 * CSV of the current view, for the "can I get a report" ask.
 *
 * Deliberately excludes raw_payload and exposes nothing the board doesn't
 * already show on screen. Exports are logged — this is the app's largest
 * data-egress path and it carries customer PII.
 */
/** One cart's history. Shared board, shared history — any member can read it. */
app.get('/api/carts/:id/events', async (req, res) => {
  try {
    if (MOCK) return res.json({ ok: true, events: [] });
    return res.json({ ok: true, events: await cartEvents(req.params.id) });
  } catch (err) { return fail(res, err); }
});

/** The whole board's activity. Admin-only: it is everyone's work in one list. */
app.get('/api/admin/events', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.json({ ok: true, events: [] });
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit ?? '60', 10) || 60));
    return res.json({ ok: true, events: await recentEvents({ limit }) });
  } catch (err) { return fail(res, err); }
});

// Cart export: customer data from the call board, so Support only (before
// module roles this sat outside the /api/carts gate and any member could reach it).
app.get('/api/carts.csv', requirePermission('support.work'), async (req, res) => {
  try {
    if (!MOCK) await ensureSchema();
    const q = String(req.query.q ?? '').trim();
    const sinceDays = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);
    const result = q ? await db.search(q, 1000) : await db.list({ sinceDays });

    const who = await currentUserName(req);
    console.log(`CSV export by ${who}: ${result.carts.length} row(s), ${q ? `q="${q}"` : `${sinceDays}d`}`);

    const COLUMNS = [
      ['Abandoned at', (c) => c.received_at],
      ['Cart ID', (c) => c.cart_id],
      ['Customer', (c) => c.customer_name],
      ['Phone', (c) => c.phone],
      ['Email', (c) => c.email],
      ['Value', (c) => c.total_price],
      ['Currency', (c) => c.currency],
      ['Items', (c) => c.item_count],
      ['Drop stage', (c) => c.drop_stage],
      ['Risk', (c) => c.risk_flag],
      ['Source', (c) => c.utm_source],
      ['Status', (c) => c.status],
      ['Notes', (c) => c.notes],
      ['Reasons', (c) => (c.reason_tags || []).join('; ')],
      ['Callback at', (c) => c.callback_at],
      ['Updated by', (c) => c.updated_by],
      ['Updated at', (c) => c.status_updated_at],
      ['Checkout URL', (c) => c.checkout_url],
    ];

    const body = toCsv(COLUMNS, result.carts);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="abandoned-carts-${stamp}.csv"`);
    // BOM so Excel opens UTF-8 correctly — customer names contain non-ASCII.
    return res.send('\uFEFF' + body);
  } catch (err) { return fail(res, err); }
});

// =========================================================================
// Member management — admins only
// =========================================================================

app.get('/admin', requireAdminPage, (_req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

function requireAdminPage(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(403).send(
    '<p style="font:14px system-ui;padding:40px">Admins only. ' +
    `<a href="${homeFor(req.session?.caps || [])}">Back</a></p>`);
}

app.get('/dashboard', requireAdminPage, (_req, res) => res.sendFile(path.join(PUBLIC, 'dashboard.html')));

/** Everything the overview needs, in one round trip. Admin-only: it aggregates
 *  every caller's performance, which is not the whole team's business. */
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'The dashboard needs a database.' });
    const days = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);
    const [overview, queue, daily, online, lastIngest, failures, stale, members] = await Promise.all([
      adminOverview(days),
      actionQueue(SLA_HOURS),
      dailySnapshot(),
      whoIsOnline(Number(process.env.ONLINE_WINDOW_MINUTES || 5)),
      db.lastIngest(),
      webhookFailureCount(24),
      db.stale(SLA_HOURS),
      listMembers(),
    ]);

    const lastIngestAgeMin = lastIngest
      ? Math.round((Date.now() - new Date(lastIngest).getTime()) / 60000) : null;

    return res.json({
      ok: true,
      days,
      ...overview,
      // Deliberately not windowed by `days` — see ACTION_BUCKETS. A callback
      // overdue since last month is the most urgent thing on the page, and a
      // 7-day filter would be precisely what hides it.
      queue,
      daily,
      online,
      team: members.filter((m) => m.active).length,
      health: {
        lastIngest,
        lastIngestAgeMinutes: lastIngestAgeMin,
        ingestSilent: isIngestSilent(lastIngest, Number(process.env.INGEST_SILENCE_HOURS || 8)),
        webhookFailures24h: failures,
        staleCarts: stale.count,
        staleValue: stale.value,
        slaHours: SLA_HOURS,
      },
    });
  } catch (err) { return fail(res, err); }
});

/**
 * The rows behind a headline number.
 *
 * `bucket` is either an action-queue name (all-time, by definition) or a status
 * value (windowed, like the rest of the page). Both paths reuse the queries the
 * counts themselves come from, so a number can never open a list that disagrees
 * with it.
 */
app.get('/api/admin/carts', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'This needs a database.' });
    const bucket = String(req.query.bucket || '');
    const days = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);

    if (bucket in ACTION_BUCKETS) {
      const carts = await cartsForBucket(bucket, { slaHours: SLA_HOURS });
      return res.json({ ok: true, bucket, windowed: false, carts });
    }
    if (VALID_STATUSES.has(bucket)) {
      const carts = await cartsByStatus(bucket, { sinceDays: days });
      return res.json({ ok: true, bucket, windowed: true, days, carts });
    }
    return res.status(400).json({ ok: false, error: `Unknown bucket: ${bucket}` });
  } catch (err) { return fail(res, err); }
});

app.get('/import', requireAdminPage, (_req, res) => res.sendFile(path.join(PUBLIC, 'import.html')));

/**
 * Import a Shopify abandoned-checkout CSV export.
 *
 * Dry run by default — the same discipline as scripts/renormalize.js, because
 * this writes customer rows in bulk and people will paste the wrong file.
 */
app.post('/api/admin/import', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Importing needs a database.' });
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'The file was empty.' });

    let mapped;
    try {
      mapped = mapShopifyCsv(text);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (!mapped.carts.length) {
      return res.status(400).json({ ok: false, error: 'No checkouts found in that file.' });
    }

    // Who the carts land with. Defaults to IMPORT_DEFAULT_CALLER.
    const wanted = String(req.query.assignTo ?? process.env.IMPORT_DEFAULT_CALLER ?? '').trim();
    let assignedTo = null;
    if (wanted) {
      const phone = normalisePhone(wanted);
      if (!phone || !(await activeUsers()).has(phone)) {
        return res.status(400).json({ ok: false, error: `${wanted} is not an active member.` });
      }
      assignedTo = phone;
    }

    const preview = {
      ok: true,
      rows: mapped.totalRows,
      checkouts: mapped.carts.length,
      skipped: mapped.skipped,
      assignedTo,
      assignedToName: assignedTo ? await nameFor(assignedTo) : null,
      sample: mapped.carts.slice(0, 5).map((c) => ({
        cartId: c.cartId, customerName: c.customerName, phone: c.phone,
        email: c.email, totalPrice: c.totalPrice, itemCount: c.itemCount,
        abandonedAt: c.abandonedAt,
      })),
      missing: {
        customerName: mapped.carts.filter((c) => !c.customerName).length,
        phone: mapped.carts.filter((c) => !c.phone).length,
        checkoutUrl: mapped.carts.filter((c) => !c.checkoutUrl).length,
      },
    };

    if (String(req.query.apply) !== 'true') {
      return res.json({ ...preview, applied: false });
    }

    await ensureSchema();
    const result = await importCarts(mapped.carts, { source: 'shopify-csv', assignedTo });
    console.log(`CSV import by ${await currentUserName(req)}: ` +
      `${result.inserted} new, ${result.updated} updated, assigned to ${preview.assignedToName || 'nobody'}`);
    return res.json({ ...preview, applied: true, ...result });
  } catch (err) { return fail(res, err); }
});

/** Pull from Shopify now, rather than waiting for the next scheduled poll. */
app.post('/api/admin/shopify/pull', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Pulling needs a database.' });
    if (!shopifyConfigured()) {
      return res.status(400).json({
        ok: false,
        error: 'Shopify is not connected. Set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.',
      });
    }
    const assignedTo = normalisePhone(process.env.IMPORT_DEFAULT_CALLER || '') || null;
    const r = await pollShopifyOnce({ assignedTo });
    console.log(`Manual Shopify pull by ${await currentUserName(req)}: ${JSON.stringify(r)}`);
    return res.json({ ok: true, ...r });
  } catch (err) { return fail(res, err); }
});

const PERIODS = new Set(['day', 'week', 'month']);

app.get('/api/admin/report', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Reports need a database.' });
    const period = String(req.query.period ?? 'day');
    if (!PERIODS.has(period)) return res.status(400).json({ ok: false, error: `Unknown period: ${period}` });
    const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit ?? '12', 10) || 12));
    return res.json({ ok: true, period, rows: await periodReport(period, limit) });
  } catch (err) { return fail(res, err); }
});

app.get('/api/admin/report.csv', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Reports need a database.' });
    const period = String(req.query.period ?? 'day');
    if (!PERIODS.has(period)) return res.status(400).json({ ok: false, error: `Unknown period: ${period}` });
    const rows = await periodReport(period, 60);

    const cols = [
      [period === 'day' ? 'Date' : period === 'week' ? 'Week starting' : 'Month', (r) => r.bucket],
      ['Carts', (r) => r.carts],
      ['Cart value', (r) => r.cart_value],
      ['Called', (r) => r.worked],
      ['Contact rate %', (r) => r.contact_rate],
      ['Recovered', (r) => r.recovered],
      ['Recovery rate %', (r) => r.recovery_rate],
      ['Recovered value', (r) => r.recovered_value],
      ['Declined', (r) => r.declined],
      ['Never called', (r) => r.never_called],
    ];
    const body = toCsv(cols, rows);

    console.log(`Report CSV (${period}) exported by ${await currentUserName(req)}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="recovery-${period}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send('\uFEFF' + body);
  } catch (err) { return fail(res, err); }
});

app.get('/api/members/:phone/activity', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await memberActivity(normalisePhone(req.params.phone) || '')) }); } catch (err) { fail(res, err); }
});
app.delete('/api/members/:phone/photo', requireAdmin, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone) || '';
    const profile = await clearPhoto(phone, { actor: await currentUserName(req) });
    invalidateMembership(phone);
    res.json({ ok: true, profile });
  } catch (err) { profileError(res, err); }
});
app.get('/api/members', requireAdmin, async (_req, res) => {
  try {
    if (MOCK) return res.json({ ok: true, mock: true, members: [], log: [] });
    const [members, log] = await Promise.all([listMembers(), recentMemberChanges(20)]);
    return res.json({
      ok: true,
      members,
      log,
      bootstrapAdmins: [...bootstrapAdmins()],
    });
  } catch (err) { return fail(res, err); }
});

/**
 * Module role changes from the Members panel: { module: role | null }, where
 * null removes that module. Only the modules named change. Returns the parsed
 * changes, or an error message.
 */
function parseModuleChanges(body) {
  const out = {};
  if (body?.modules !== undefined) {
    if (!body.modules || typeof body.modules !== 'object' || Array.isArray(body.modules)) return { error: 'modules must be an object.' };
    for (const [module, role] of Object.entries(body.modules)) {
      if (!MODULE_KEYS.includes(module)) return { error: `Unknown module "${module}".` };
      if (role !== null && role !== '' && !isValidAssignment(module, role)) return { error: `"${role}" is not a ${module} role.` };
      out[module] = role || null;
    }
  }
  // The old single role (one release): the same exclusive access it always meant.
  if (body?.role !== undefined) {
    if (!['caller', 'logistics'].includes(body.role)) return { error: 'Role must be caller or logistics.' };
    Object.assign(out, body.role === 'logistics'
      ? { logistics: 'operator', inventory: 'viewer', support: null }
      : { support: 'agent', logistics: null, inventory: null });
  }
  return { changes: out };
}

async function applyModuleChanges(phone, changes, actor) {
  let roles = null;
  for (const [module, role] of Object.entries(changes)) roles = await setModuleRole(phone, module, role, { actor });
  return roles ?? moduleRolesOf(phone);
}
const describeModules = (changes) => Object.entries(changes).map(([m, r]) => `${m}=${r || 'none'}`).join(', ');

app.post('/api/members', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Member management needs a database.' });
    const phone = normalisePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit Indian mobile number.' });

    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'Team';
    const isAdmin = Boolean(req.body?.isAdmin);
    const parsed = parseModuleChanges(req.body);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const actor = await currentUserName(req);

    const member = await upsertMember({ phone, name, isAdmin, addedBy: actor });
    // With no modules chosen a new member gets what a new member always got:
    // the call board (Support agent).
    let changes = parsed.changes;
    if (!Object.keys(changes).length && !Object.keys(await moduleRolesOf(phone)).length) changes = { support: 'agent' };
    member.modules = await applyModuleChanges(phone, changes, actor);
    invalidateMembership(phone);
    await recordMemberChange({
      actor, action: 'add', targetPhone: phone,
      detail: `${name}${isAdmin ? ' (admin)' : ''}${Object.keys(changes).length ? ` · ${describeModules(changes)}` : ''}`,
    });
    console.log(`Member added by ${actor}: +${phone} (${name})${isAdmin ? ' [admin]' : ''}`);
    return res.json({ ok: true, member });
  } catch (err) { return fail(res, err); }
});

app.patch('/api/members/:phone', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Member management needs a database.' });
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'Invalid number.' });

    const actor = await currentUserName(req);
    const { name, active, isAdmin, email } = req.body ?? {};
    const parsed = parseModuleChanges(req.body);
    if (email !== undefined) {
      try { await updateProfile(phone, { email }, { actor }); } catch (err) { return profileError(res, err); }
    }
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const losingAdmin = active === false || isAdmin === false;

    // A number in ADMIN_PHONES keeps admin rights no matter what this table
    // says, so demoting or deactivating it here produces a half-state: still an
    // admin, no longer able to sign in. Refuse it and point at the env var.
    if (losingAdmin && bootstrapAdmins().has(phone)) {
      return res.status(409).json({
        ok: false,
        error: 'That number is set in ADMIN_PHONES and always has admin access. Change the environment variable instead.',
      });
    }

    // Refuse the one change that cannot be undone from inside the app: leaving
    // nobody able to manage members.
    if (losingAdmin && (await otherActiveAdminCount(phone)) === 0) {
      return res.status(409).json({
        ok: false,
        error: 'That would leave no active admins. Promote someone else first.',
      });
    }

    // Changing the number is a move, not an update — phone is the primary key.
    if (req.body?.newPhone !== undefined) {
      const newPhone = normalisePhone(req.body.newPhone);
      if (!newPhone) return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit Indian mobile number.' });

      if (newPhone !== phone) {
        // An env admin's rights are pinned to their number, so moving them here
        // would leave admin on a number that no longer exists in the table.
        if (bootstrapAdmins().has(phone)) {
          return res.status(409).json({
            ok: false,
            error: 'That number is set in ADMIN_PHONES. Update the environment variable to change it.',
          });
        }
        const moved = await changeMemberPhone(phone, newPhone);
        if (!moved.ok) {
          return res.status(moved.reason === 'taken' ? 409 : 404).json({
            ok: false,
            error: moved.reason === 'taken'
              ? 'Another member already uses that number.'
              : 'No such member.',
          });
        }
        invalidateMembership(phone);
        invalidateMembership(newPhone);
        await recordMemberChange({
          actor, action: 'change-number', targetPhone: newPhone,
          detail: `moved from +${phone}`,
        });
        console.log(`Member number changed by ${actor}: +${phone} -> +${newPhone}`);
        return res.json({ ok: true, member: moved.member });
      }
    }

    const member = await updateMember(phone, {
      name: name === undefined ? null : String(name).trim().slice(0, 60),
      active: active === undefined ? null : Boolean(active),
      isAdmin: isAdmin === undefined ? null : Boolean(isAdmin),
    });
    if (!member) return res.status(404).json({ ok: false, error: 'No such member.' });
    const changes = parsed.changes;
    member.modules = await applyModuleChanges(phone, changes, actor);

    invalidateMembership(phone);
    const what = [
      name !== undefined ? `name="${member.name}"` : null,
      active !== undefined ? (active ? 'reactivated' : 'deactivated') : null,
      isAdmin !== undefined ? (isAdmin ? 'promoted to admin' : 'demoted') : null,
      Object.keys(changes).length ? describeModules(changes) : null,
    ].filter(Boolean).join(', ');
    await recordMemberChange({ actor, action: 'update', targetPhone: phone, detail: what });
    console.log(`Member updated by ${actor}: +${phone} — ${what}`);
    return res.json({ ok: true, member });
  } catch (err) { return fail(res, err); }
});

app.delete('/api/members/:phone', requireAdmin, async (req, res) => {
  try {
    if (MOCK) return res.status(400).json({ ok: false, error: 'Member management needs a database.' });
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ ok: false, error: 'Invalid number.' });

    if (bootstrapAdmins().has(phone)) {
      return res.status(409).json({
        ok: false,
        error: 'That number is set in ADMIN_PHONES. Removing it here would leave them with admin rights but no way to sign in — change the environment variable instead.',
      });
    }
    if ((await otherActiveAdminCount(phone)) === 0) {
      return res.status(409).json({
        ok: false,
        error: 'That would leave no active admins. Promote someone else first.',
      });
    }

    const actor = await currentUserName(req);
    const gone = await deleteMember(phone);
    if (!gone) return res.status(404).json({ ok: false, error: 'No such member.' });

    invalidateMembership(phone);
    await recordMemberChange({ actor, action: 'remove', targetPhone: phone, detail: null });
    console.log(`Member removed by ${actor}: +${phone}`);
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
});

app.get('/api/reasons/summary', async (req, res) => {
  try {
    const days = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);
    res.json({ ok: true, days, ...(await db.reasons(days)) });
  } catch (err) { fail(res, err); }
});

/**
 * Admin-only: this is individual performance. /api/reasons/summary above is
 * deliberately left open — it aggregates *why customers abandon*, with no
 * person attached, and the callers are the ones who tag it. Taking that away
 * would remove the only feedback they get from their own data entry.
 */
app.get('/api/stats/by-caller', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(0, Number.parseInt(req.query.days ?? '7', 10) || 0);
    res.json({ ok: true, days, callers: await db.byCaller(days) });
  } catch (err) { fail(res, err); }
});

const port = process.env.PORT || 3000;
// Refuse to serve at all — not even a health check — if this process and its
// database disagree about which environment they are. On Render a failed
// health check keeps the previous deploy live.
if (!MOCK) {
  try {
    const env = await assertDatabaseEnvironment(getPool());
    console.log(`Environment: ${env} (APP_ENV and database label agree)`);
  } catch (err) {
    console.error(`\n  REFUSING TO START: ${err.message}\n`);
    process.exit(1);
  }
}

app.listen(port, async () => {
  console.log(`Briyo OS on http://localhost:${port}`);
  if (process.env.BOARD_TZ && !process.env.BOARD_TIMEZONE) {
    console.warn('BOARD_TZ is deprecated — rename it to BOARD_TIMEZONE. '
      + 'It is still honoured, but only BOARD_TIMEZONE is documented.');
  }
  console.log(`Storage: ${MOCK ? 'MOCK (in-memory, resets on restart)' : 'Postgres'}`);
  console.log(`OTP delivery: ${driver() === 'console' ? 'CONSOLE (codes printed here)' : '11za WhatsApp'}`);

  if (!MOCK) {
    try {
      await ensureSchema();
      const info = await ping();
      console.log(`Postgres connected: ${String(info.version).split(',')[0]}`);
      // Orders and inventory tables are prepared now, in the background, rather
      // than inside the first visitor's request. Requests that arrive meanwhile
      // wait on this same promise; a failure is logged and retried by them.
      ensureInventorySchema()
        .then(() => console.log('Orders & inventory schema ready'))
        .catch((e) => console.error('Orders & inventory schema setup failed (will retry on first request):', e.message));
      ensureHrSchema()
        .then(() => console.log('HR schema ready'))
        // Resume removals interrupted after the file was deleted are finished here.
        .then(() => retryPendingRemovals()
          .then((r) => { if (r.pending) console.log(`Resume removals: ${r.finished} of ${r.pending} pending finished`); })
          .catch((e) => console.error('Pending resume removals not retried:', e.message)))
        .catch((e) => console.error('HR schema setup failed (will retry on first request):', e.message));
      console.log(process.env.CAREERS_HOST ? `Careers host: ${process.env.CAREERS_HOST} (public careers routes only)` : 'Careers host: not configured');
    } catch (err) {
      console.error(`\n  Postgres connection FAILED: ${err.message}\n  Check DATABASE_URL.\n`);
    }
  }
  if (!process.env.WEBHOOK_SECRET) {
    console.warn('\n  WARNING: WEBHOOK_SECRET is unset — the webhook will reject every delivery.\n');
  }
  // Report the live allowlist, masked. Without this a mistyped or unsaved value
  // looks identical to a WhatsApp delivery failure from the logs alone.
  try {
    const seed = await seedAllowedUsers();
    if (seed.seeded) console.log(`Seeded allowed_users with ${seed.seeded} number(s) from ALLOWED_PHONES`);
    const allowed = await activeUsers();
    if (allowed.size === 0) {
      console.warn(
        '\n  WARNING: nobody can log in — allowed_users is empty and ALLOWED_PHONES is unset.\n' +
        `  ALLOWED_PHONES raw length: ${(process.env.ALLOWED_PHONES || '').length} chars\n` +
        "  Add someone:  INSERT INTO allowed_users (phone, name) VALUES ('91XXXXXXXXXX', 'Name');\n");
    } else {
      const masked = [...allowed.entries()]
        .map(([phone, name]) => `${name}:...${phone.slice(-4)}`).join(', ');
      console.log(`Allowed logins (${seed.source}): ${allowed.size} — ${masked}`);
    }
  } catch (err) {
    console.error('Could not read the allowlist:', err.message);
  }

  startKeepAlive();
  startSlaAlerts({
    getStale: (h) => db.stale(h),
    slaHours: SLA_HOURS,
    getLastIngest: () => db.lastIngest(),
    // Same numbers the owner view shows, so the evening message and the page
    // can never tell two different stories about the same day.
    getDailyStats: MOCK ? null : async () => {
      const [daily, queue, callers] = await Promise.all([
        dailySnapshot(), actionQueue(SLA_HOURS), statsByCaller(1),
      ]);
      return { today: daily.today, queue, callers };
    },
  });
  if (!MOCK) startShopifyPoll();
});
