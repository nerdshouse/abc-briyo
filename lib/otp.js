import crypto from 'node:crypto';
import { isMockMode, getPool } from './db.js';

/**
 * OTP state is stored in Postgres, not memory.
 *
 * The app runs on Cloud Run (via Firebase App Hosting), which means several
 * instances may serve requests and all of them may be shut down between
 * requests. In-memory codes would break both ways: a code issued by one instance
 * would be unverifiable on another, and scaling to zero would drop pending codes
 * mid-login. Shared storage is the only correct place for this.
 *
 * In mock mode (no DATABASE_URL) it falls back to in-memory maps so the login
 * flow still works locally with no database.
 */
const memPending = new Map();
const memRequests = new Map();

export const OTP_TTL_MS = 5 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 5;

/** Normalise an Indian number to 91XXXXXXXXXX. Returns null if implausible. */
export function normalisePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return null;
}

/**
 * Parses ALLOWED_PHONES into phone -> display name.
 * Entries may be bare numbers or "Name:number", e.g.
 *   ALLOWED_PHONES=Asha:9812345678,9820011223
 */
export function allowedPhones() {
  const map = new Map();
  for (const entry of (process.env.ALLOWED_PHONES || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    const name = idx === -1 ? '' : trimmed.slice(0, idx).trim();
    const phone = normalisePhone(idx === -1 ? trimmed : trimmed.slice(idx + 1));
    if (phone) map.set(phone, name || 'Team');
  }
  return map;
}

/**
 * The live allowlist. Reads the allowed_users table so the team can be changed
 * with a SQL statement instead of an env var edit and a redeploy.
 *
 * ALLOWED_PHONES stays as a bootstrap fallback: it seeds the table on first boot
 * and is used if the table is empty or unreachable, so a database problem or an
 * empty table can never lock everyone out.
 */
export async function activeUsers() {
  if (isMockMode()) return allowedPhones();
  try {
    const { rows } = await getPool().query(
      'SELECT phone, name FROM allowed_users WHERE active ORDER BY added_at');
    if (rows.length === 0) return allowedPhones();
    return new Map(rows.map((r) => [r.phone, r.name || 'Team']));
  } catch (err) {
    console.error('allowed_users unreadable, falling back to ALLOWED_PHONES:', err.message);
    return allowedPhones();
  }
}

/** Copies ALLOWED_PHONES into the table the first time it's empty. */
export async function seedAllowedUsers() {
  if (isMockMode()) return { seeded: 0, source: 'env (mock mode)' };
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM allowed_users');
  if (rows[0].n > 0) return { seeded: 0, source: 'allowed_users table' };

  const fromEnv = allowedPhones();
  for (const [phone, name] of fromEnv) {
    await getPool().query(
      `INSERT INTO allowed_users (phone, name) VALUES ($1, $2)
       ON CONFLICT (phone) DO NOTHING`, [phone, name]);
  }
  return { seeded: fromEnv.size, source: fromEnv.size ? 'seeded from ALLOWED_PHONES' : 'empty' };
}

export const isAllowed = async (phone) => (await activeUsers()).has(phone);
export const nameFor = async (phone) => (await activeUsers()).get(phone) || 'Team';

function hash(phone, code) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only')
    .update(`${phone}:${code}`).digest('hex');
}

/** Store rows are tiny and short-lived; created alongside the carts table. */
export async function ensureOtpSchema() {
  if (isMockMode()) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS otp_state (
      phone        TEXT PRIMARY KEY,
      code_hash    TEXT,
      expires_at   TIMESTAMPTZ,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ,
      recent_requests TIMESTAMPTZ[] NOT NULL DEFAULT '{}'
    )`);
}

async function readState(phone) {
  if (isMockMode()) {
    return memPending.get(phone) || null;
  }
  const { rows } = await getPool().query('SELECT * FROM otp_state WHERE phone = $1', [phone]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    hash: r.code_hash,
    expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : 0,
    attempts: r.attempts,
    lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).getTime() : 0,
    recentRequests: (r.recent_requests || []).map((t) => new Date(t).getTime()),
  };
}

/** Throttle by phone: cooldown between sends, and a per-hour ceiling. */
export async function checkRateLimit(phone) {
  const now = Date.now();
  const state = await readState(phone);

  if (state?.lastSentAt && now - state.lastSentAt < RESEND_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - state.lastSentAt)) / 1000) };
  }

  const recent = (isMockMode() ? (memRequests.get(phone) || []) : (state?.recentRequests || []))
    .filter((t) => now - t < 3600 * 1000);
  if (isMockMode()) memRequests.set(phone, recent);

  if (recent.length >= MAX_REQUESTS_PER_HOUR) {
    return { ok: false, retryAfter: 3600, tooMany: true };
  }
  return { ok: true };
}

export async function createOtp(phone) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();

  if (isMockMode()) {
    memPending.set(phone, { hash: hash(phone, code), expiresAt: now + OTP_TTL_MS, attempts: 0, lastSentAt: now });
    memRequests.set(phone, [...(memRequests.get(phone) || []), now]);
    return code;
  }

  await getPool().query(
    `INSERT INTO otp_state (phone, code_hash, expires_at, attempts, last_sent_at, recent_requests)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, 0, now(), ARRAY[now()])
     ON CONFLICT (phone) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       last_sent_at = now(),
       -- keep only the last hour of request timestamps
       recent_requests = ARRAY(
         SELECT t FROM unnest(otp_state.recent_requests) AS t
         WHERE t > now() - interval '1 hour'
       ) || now()`,
    [phone, hash(phone, code), String(OTP_TTL_MS)]);
  return code;
}

/** Increments the attempt counter atomically and returns the row as it was. */
async function consumeAttempt(phone) {
  if (isMockMode()) {
    const e = memPending.get(phone);
    if (e) e.attempts += 1;
    return e ? { ...e } : null;
  }
  const { rows } = await getPool().query(
    `UPDATE otp_state SET attempts = attempts + 1 WHERE phone = $1
     RETURNING code_hash, expires_at, attempts`, [phone]);
  if (!rows[0]) return null;
  return {
    hash: rows[0].code_hash,
    expiresAt: new Date(rows[0].expires_at).getTime(),
    attempts: rows[0].attempts,
  };
}

async function clearOtp(phone) {
  // Clear the code but keep lastSentAt, so consuming a code doesn't reset the
  // resend cooldown. Matches what the SQL below does.
  if (isMockMode()) {
    const e = memPending.get(phone);
    if (e) { e.hash = null; e.expiresAt = 0; e.attempts = 0; }
    return;
  }
  await getPool().query(
    'UPDATE otp_state SET code_hash = NULL, expires_at = NULL, attempts = 0 WHERE phone = $1', [phone]);
}

export async function verifyOtp(phone, code) {
  const entry = await readState(phone);
  if (!entry || !entry.hash) {
    return { ok: false, reason: 'No code was requested for this number. Request a new one.' };
  }
  if (Date.now() > entry.expiresAt) {
    await clearOtp(phone);
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    await clearOtp(phone);
    return { ok: false, reason: 'Too many incorrect attempts. Request a new code.' };
  }

  // Count the attempt before comparing, so a crash mid-verify can't grant a free guess.
  const after = await consumeAttempt(phone);
  if (!after || !after.hash) {
    return { ok: false, reason: 'No code was requested for this number. Request a new one.' };
  }

  const given = Buffer.from(hash(phone, String(code ?? '').trim()));
  const want = Buffer.from(after.hash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const left = MAX_ATTEMPTS - after.attempts;
    if (left <= 0) await clearOtp(phone);
    return {
      ok: false,
      reason: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`
                       : 'Too many incorrect attempts. Request a new code.',
    };
  }

  await clearOtp(phone);   // single use
  return { ok: true };
}
