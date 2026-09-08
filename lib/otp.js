import crypto from 'node:crypto';

/**
 * OTP state lives in memory. That is deliberate for a small team on one process:
 * codes are short-lived and losing them on restart just means requesting a new one.
 * It does NOT survive multiple instances — see README before scaling out.
 */
const pending = new Map();   // phone -> { hash, expiresAt, attempts, lastSentAt }
const requestLog = new Map(); // phone -> [timestamps]

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

export function allowedPhones() {
  return new Set(
    (process.env.ALLOWED_PHONES || '')
      .split(',')
      .map((p) => normalisePhone(p))
      .filter(Boolean),
  );
}

export const isAllowed = (phone) => allowedPhones().has(phone);

function hash(phone, code) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only')
    .update(`${phone}:${code}`).digest('hex');
}

/** Throttle by phone: cooldown between sends, and a per-hour ceiling. */
export function checkRateLimit(phone) {
  const now = Date.now();
  const entry = pending.get(phone);
  if (entry && now - entry.lastSentAt < RESEND_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - entry.lastSentAt)) / 1000) };
  }
  const recent = (requestLog.get(phone) || []).filter((t) => now - t < 3600 * 1000);
  requestLog.set(phone, recent);
  if (recent.length >= MAX_REQUESTS_PER_HOUR) {
    return { ok: false, retryAfter: 3600, tooMany: true };
  }
  return { ok: true };
}

export function createOtp(phone) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  pending.set(phone, {
    hash: hash(phone, code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    lastSentAt: now,
  });
  requestLog.set(phone, [...(requestLog.get(phone) || []), now]);
  return code;
}

export function verifyOtp(phone, code) {
  const entry = pending.get(phone);
  if (!entry) return { ok: false, reason: 'No code was requested for this number. Request a new one.' };
  if (Date.now() > entry.expiresAt) {
    pending.delete(phone);
    return { ok: false, reason: 'That code has expired. Request a new one.' };
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    pending.delete(phone);
    return { ok: false, reason: 'Too many incorrect attempts. Request a new code.' };
  }

  entry.attempts += 1;

  const given = Buffer.from(hash(phone, String(code ?? '').trim()));
  const want = Buffer.from(entry.hash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    const left = MAX_ATTEMPTS - entry.attempts;
    return {
      ok: false,
      reason: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`
                       : 'Too many incorrect attempts. Request a new code.',
    };
  }

  pending.delete(phone);   // single use
  return { ok: true };
}
