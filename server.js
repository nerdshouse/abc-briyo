import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isMockMode, fetchAbandonedCheckouts, readStatusMap, writeStatusMap,
} from './lib/shopify.js';
import { mockCarts, readMockStatusMap, writeMockStatusMap } from './lib/mock.js';
import { router as authRouter, requireAuth } from './lib/auth-routes.js';
import { allowedPhones } from './lib/otp.js';
import { driver } from './lib/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const app = express();
const MOCK = isMockMode();

app.set('trust proxy', 1);   // so secure cookies work behind Render/Railway/nginx
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// --- public assets: only the login page and its own JS/CSS -------------------
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));
app.use('/login.js', express.static(path.join(PUBLIC, 'login.js')));
app.use('/styles.css', express.static(path.join(PUBLIC, 'styles.css')));

app.use('/auth', authRouter);

// --- everything below requires a session ------------------------------------
app.use(requireAuth);
app.use(express.static(PUBLIC));

const getCarts = () => (MOCK ? Promise.resolve(mockCarts) : fetchAbandonedCheckouts());
const getStatus = () => (MOCK ? readMockStatusMap() : readStatusMap());
const putStatus = (map) => (MOCK ? writeMockStatusMap(map) : writeStatusMap(map));

const VALID_STATUSES = new Set([
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
]);

function fail(res, err, code = 502) {
  console.error(err);
  res.status(code).json({ ok: false, error: err.message || String(err) });
}

app.get('/api/config', (_req, res) => res.json({ mock: MOCK, statuses: [...VALID_STATUSES] }));

app.get('/api/carts', async (_req, res) => {
  try {
    res.json({ ok: true, mock: MOCK, carts: await getCarts() });
  } catch (err) { fail(res, err); }
});

app.get('/api/status', async (_req, res) => {
  try {
    res.json({ ok: true, statusMap: await getStatus() });
  } catch (err) { fail(res, err); }
});

/**
 * Accepts either a single patch `{ id, status, notes }` or a full `{ statusMap }`.
 * A patch does read-merge-write so one person's save doesn't clobber rows they
 * never touched. Still last-write-wins per row — see README.
 */
app.post('/api/status', async (req, res) => {
  try {
    const { id, status, notes, statusMap } = req.body ?? {};

    if (statusMap && typeof statusMap === 'object') {
      return res.json({ ok: true, statusMap: await putStatus(statusMap) });
    }
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ ok: false, error: 'Provide either {id, status, notes} or {statusMap}.' });
    }
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, error: `Unknown status: ${status}` });
    }

    const current = await getStatus();
    const existing = current[id] ?? {};
    current[id] = {
      status: status ?? existing.status ?? 'Not called',
      notes: notes ?? existing.notes ?? '',
      updatedAt: new Date().toISOString(),
    };
    const saved = await putStatus(current);
    return res.json({ ok: true, statusMap: saved, entry: saved[id] });
  } catch (err) {
    return fail(res, err);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Recovery Board on http://localhost:${port}`);
  console.log(MOCK
    ? 'Shopify: MOCK MODE — no token set, serving sample data.'
    : `Shopify: live (${process.env.SHOPIFY_STORE_DOMAIN}, API ${process.env.SHOPIFY_API_VERSION || '2024-10'})`);
  console.log(`OTP delivery: ${driver() === 'console' ? 'CONSOLE (codes printed here, no WhatsApp sent)' : '11za WhatsApp'}`);

  const allowed = allowedPhones();
  if (allowed.size === 0) {
    console.warn(
      '\n  WARNING: ALLOWED_PHONES is empty, so nobody can log in.\n' +
      '  Add your team\'s numbers, comma-separated, e.g. ALLOWED_PHONES=9812345678,9820011223\n',
    );
  } else {
    console.log(`Allowed logins: ${allowed.size} number(s)`);
  }
});
