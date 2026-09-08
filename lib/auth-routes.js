import express from 'express';
import {
  normalisePhone, isAllowed, allowedPhones, checkRateLimit, createOtp, verifyOtp,
} from './otp.js';
import { sendOtp, driver } from './whatsapp.js';
import { issueSession, setSessionCookie, clearSessionCookie, verifySession, COOKIE } from './session.js';

export const router = express.Router();

/**
 * Deliberately generic response. Telling a caller whether a number is on the
 * allowlist would let anyone enumerate who works here, so an unknown number gets
 * the same reply as a known one — it just never receives a message.
 */
const GENERIC = 'If that number is authorised, a code has been sent to it on WhatsApp.';

router.post('/request-otp', async (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit Indian mobile number.' });
  }

  // Identical response shape to the success path, so the two are indistinguishable.
  if (!isAllowed(phone)) {
    console.warn(`Login attempt from non-allowlisted number: +${phone}`);
    return res.json({ ok: true, message: GENERIC, consoleMode: driver() === 'console' });
  }

  const limit = checkRateLimit(phone);
  if (!limit.ok) {
    return res.status(429).json({
      ok: false,
      error: limit.tooMany
        ? 'Too many code requests for this number. Try again in an hour.'
        : `Please wait ${limit.retryAfter}s before requesting another code.`,
    });
  }

  const code = createOtp(phone);
  try {
    const result = await sendOtp(phone, code);
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

router.post('/verify-otp', (req, res) => {
  const phone = normalisePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter a valid mobile number.' });

  const code = String(req.body?.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'Enter the 6-digit code.' });

  // Re-check the allowlist: it may have changed since the code was issued.
  if (!isAllowed(phone)) return res.status(403).json({ ok: false, error: 'That number is not authorised.' });

  const result = verifyOtp(phone, code);
  if (!result.ok) return res.status(401).json({ ok: false, error: result.reason });

  setSessionCookie(res, issueSession(phone));
  console.log(`Login succeeded for +${phone}`);
  return res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const session = verifySession(req.cookies?.[COOKIE]);
  res.json({
    ok: true,
    authenticated: Boolean(session),
    phone: session?.phone ?? null,
    driver: driver(),
    allowlistConfigured: allowedPhones().size > 0,
  });
});

/** Gate for everything that exposes customer data. */
export function requireAuth(req, res, next) {
  if (verifySession(req.cookies?.[COOKIE])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Not signed in.' });
  }
  return res.redirect('/login');
}
