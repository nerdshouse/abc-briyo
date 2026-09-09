import express from 'express';
import {
  normalisePhone, isAllowed, activeUsers, nameFor, checkRateLimit, createOtp, verifyOtp,
  isAdminPhone,
} from './otp.js';
import { sendOtp, driver } from './whatsapp.js';
import { issueSession, setSessionCookie, clearSessionCookie, verifySession, COOKIE } from './session.js';
import { ensureSchema, recordLogin } from './db.js';
import { rateLimit } from './rate-limit.js';

export const router = express.Router();

/**
 * Deliberately generic response. Telling a caller whether a number is on the
 * allowlist would let anyone enumerate who works here, so an unknown number gets
 * the same reply as a known one — it just never receives a message.
 */
const GENERIC = 'If that number is authorised, a code has been sent to it on WhatsApp.';

const OTP_IP_LIMIT = Number(process.env.OTP_IP_LIMIT || 10);
const OTP_IP_WINDOW_MS = 3600 * 1000;

const clientIp = (req) => (req.ip || req.socket?.remoteAddress || 'unknown');

/** Best-effort audit; a logging failure must never block a login. */
const audit = (entry) => recordLogin(entry).catch((e) => console.error('login_log write failed:', e.message));

router.post('/request-otp', async (req, res) => {
  // Per-IP, on top of the per-phone limit — otherwise rotating numbers burns
  // 11za credits and risks the WhatsApp sender being flagged.
  const limitIp = rateLimit({ key: `otp:${clientIp(req)}`, limit: OTP_IP_LIMIT, windowMs: OTP_IP_WINDOW_MS });
  if (!limitIp.ok) {
    console.warn(`OTP rate limit hit from ${clientIp(req)}`);
    res.set('Retry-After', String(limitIp.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
  }

  const phone = normalisePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit Indian mobile number.' });
  }

  // Identical response shape to the success path, so the two are indistinguishable.
  if (!(await isAllowed(phone))) {
    // Include what IS loaded, so the log says why rather than just that it failed.
    const loaded = [...(await activeUsers()).keys()].map((p) => '...' + p.slice(-4));
    console.warn(
      `Login attempt from non-allowlisted number: +${phone}. ` +
      `Allowlist currently holds ${loaded.length}: [${loaded.join(', ')}]`);
    audit({ phone, ok: false, reason: 'not allowlisted', ip: clientIp(req) });
    return res.json({ ok: true, message: GENERIC, consoleMode: driver() === 'console' });
  }

  try {
    await ensureSchema();
  } catch (err) {
    console.error('Cannot reach the database for OTP state:', err.message);
    return res.status(503).json({ ok: false, error: 'Login is temporarily unavailable. Try again shortly.' });
  }

  const limit = await checkRateLimit(phone);
  if (!limit.ok) {
    return res.status(429).json({
      ok: false,
      error: limit.tooMany
        ? 'Too many code requests for this number. Try again in an hour.'
        : `Please wait ${limit.retryAfter}s before requesting another code.`,
    });
  }

  const code = await createOtp(phone);
  try {
    const result = await sendOtp(phone, code, await nameFor(phone));
    return res.json({
      ok: true,
      message: GENERIC,
      // Only ever true in console mode; never leaks the code itself.
      consoleMode: driver() === 'console',
    });
  } catch (err) {
    console.error('OTP send failed:', err);
    return res.status(502).json({ ok: false, error: `Could not send the code: ${err.message}` });
  }
});

router.post('/verify-otp', async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter a valid mobile number.' });

  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'Enter the 6-digit code.' });

  // Re-check the allowlist: it may have changed since the code was issued.
  if (!(await isAllowed(phone))) {
    return res.status(403).json({ ok: false, error: 'That number is not authorised.' });
  }

  let result;
  try {
    await ensureSchema();
    result = await verifyOtp(phone, code);
  } catch (err) {
    console.error('OTP verification failed:', err.message);
    return res.status(503).json({ ok: false, error: 'Login is temporarily unavailable. Try again shortly.' });
  }
  if (!result.ok) {
    audit({ phone, ok: false, reason: result.reason, ip: clientIp(req) });
    return res.status(401).json({ ok: false, error: result.reason });
  }

  setSessionCookie(res, issueSession(phone));
  console.log(`Login succeeded for +${phone}`);
  audit({ phone, ok: true, reason: null, ip: clientIp(req) });
  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const session = verifySession(req.cookies?.[COOKIE]);
  res.json({
    ok: true,
    authenticated: Boolean(session),
    phone: session?.phone ?? null,
    isAdmin: session ? await isAdminPhone(session.phone) : false,
    driver: driver(),
    allowlistConfigured: (await activeUsers()).size > 0,
  });
});

/**
 * Gate for everything that exposes customer data. Also attaches the session to
 * the request so routes can attribute changes to whoever is signed in, without
 * asking them to pick a name.
 */
/**
 * Membership is re-checked on each request, cached briefly.
 *
 * Sessions are stateless, so without this a removed member would keep working
 * until their token expired — which makes "Remove" in the admin panel a lie.
 * The cache keeps it to roughly one query per member per minute rather than one
 * per request; SESSION_EPOCH remains the instant, global lever.
 */
const MEMBERSHIP_TTL_MS = 60_000;
const membershipCache = new Map();

async function membership(phone) {
  const hit = membershipCache.get(phone);
  if (hit && Date.now() < hit.expires) return hit.value;
  const value = { allowed: await isAllowed(phone), admin: await isAdminPhone(phone) };
  membershipCache.set(phone, { value, expires: Date.now() + MEMBERSHIP_TTL_MS });
  return value;
}

/** Called after a member change so the panel's effect is immediate. */
export function invalidateMembership(phone) {
  if (phone) membershipCache.delete(phone); else membershipCache.clear();
}

export async function currentUserName(req) {
  const phone = req.session?.phone;
  if (!phone) return null;
  try {
    return await nameFor(phone);
  } catch {
    return `+${phone}`;   // never block a save just because the lookup failed
  }
}

/**
 * Gate for member management. Everyone allowlisted can work the board; only
 * admins can change who has access to it — otherwise the allowlist stops being
 * a boundary, since any caller could add anyone.
 */
export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(403).json({ ok: false, error: 'Admins only.' });
}

export async function requireAuth(req, res, next) {
  const session = verifySession(req.cookies?.[COOKIE]);
  if (session) {
    const { allowed, admin } = await membership(session.phone).catch(() => ({ allowed: true, admin: false }));
    if (!allowed) {
      // Removed or deactivated since the token was issued.
      clearSessionCookie(res);
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ ok: false, error: 'Your access has been removed.' });
      }
      return res.redirect('/login');
    }
    req.session = { ...session, isAdmin: admin };
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  return res.redirect('/login');
}
