import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isMockMode, ensureSchema, insertCart, listCarts, updateStatus, ping,
} from './lib/db.js';
import { mockInsertCart, mockListCarts, mockUpdateStatus } from './lib/mock.js';
import { normalizePayload, parseLineItems } from './lib/normalize.js';
import { router as authRouter, requireAuth } from './lib/auth-routes.js';
import { activeUsers, seedAllowedUsers } from './lib/otp.js';
import { driver } from './lib/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const app = express();
const MOCK = isMockMode();

app.set('trust proxy', 1);

/**
 * The webhook takes the body as raw text and parses it itself, so a malformed
 * delivery is still stored rather than being rejected by the JSON parser before
 * our handler runs. Everything else uses the normal JSON parser.
 */
app.use('/api/webhook', express.text({ type: '*/*', limit: '2mb' }));
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

const db = {
  insert: (n, raw) => (MOCK ? mockInsertCart(n, raw) : insertCart(n, raw)),
  list: () => (MOCK ? mockListCarts() : listCarts()),
  update: (id, patch) => (MOCK ? mockUpdateStatus(id, patch) : updateStatus(id, patch)),
};

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
  const normalized = normalizePayload(payload);

  try {
    if (!MOCK) await ensureSchema();
    const { id, duplicate } = await db.insert(normalized, payload);
    console.log(`Cart ${duplicate ? 'updated' : 'received'}: ${normalized.cartId || '(no id)'} -> row ${id}`);
    return res.status(200).json({ ok: true, id, duplicate });
  } catch (err) {
    // Log loudly but still 200: GoKwik retries on non-2xx, and a retry storm is
    // worse than a log dive. The full payload is in the log to replay from.
    console.error('Failed to store cart:', err.message, JSON.stringify(payload));
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

// Lets you confirm the URL is live before handing it to GoKwik.
app.get('/api/webhook/gokwik/abandoned-cart', (_req, res) =>
  res.json({ ok: true, message: 'GoKwik abandoned-cart webhook receiver. POST here.' }));

// --- public: login page and its assets --------------------------------------
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.use('/login.js', express.static(path.join(PUBLIC, 'login.js')));
app.use('/styles.css', express.static(path.join(PUBLIC, 'styles.css')));
app.use('/auth', authRouter);

// --- everything below requires a session ------------------------------------
app.use(requireAuth);
app.use(express.static(PUBLIC));

function fail(res, err, code = 500) {
  console.error(err);
  res.status(code).json({ ok: false, error: err.message || String(err) });
}

app.get('/api/config', (_req, res) => res.json({ mock: MOCK, statuses: [...VALID_STATUSES] }));

app.get('/api/carts', async (_req, res) => {
  try {
    if (!MOCK) await ensureSchema();
    const carts = (await db.list()).map((c) => {
      // Line items live in raw_payload, in either array or "#Name(Variant)*1"
      // form. Parse server-side so the browser gets one consistent shape.
      const raw = c.raw_payload || {};
      const source = raw.line_items ?? raw['Line items'] ?? raw.items ?? raw.products;
      const { raw_payload, ...rest } = c;
      return { ...rest, items: parseLineItems(source) };
    });
    res.json({ ok: true, mock: MOCK, carts });
  } catch (err) { fail(res, err); }
});

app.post('/api/status', async (req, res) => {
  try {
    const { id, status, notes } = req.body ?? {};
    if (id === undefined || id === null) {
      return res.status(400).json({ ok: false, error: 'Missing cart id.' });
    }
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: `Unknown status: ${status}` });
    }
    const row = await db.update(id, { status, notes });
    if (!row) return res.status(404).json({ ok: false, error: 'No such cart.' });
    return res.json({ ok: true, entry: row });
  } catch (err) { return fail(res, err); }
});

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`Recovery Board on http://localhost:${port}`);
  console.log(`Storage: ${MOCK ? 'MOCK (in-memory, resets on restart)' : 'Postgres'}`);
  console.log(`OTP delivery: ${driver() === 'console' ? 'CONSOLE (codes printed here)' : '11za WhatsApp'}`);

  if (!MOCK) {
    try {
      await ensureSchema();
      const info = await ping();
      console.log(`Postgres connected: ${String(info.version).split(',')[0]}`);
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
});
