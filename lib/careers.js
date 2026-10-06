import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from './rate-limit.js';
import { MAX_DOCUMENT_BYTES } from './storage.js';
import {
  publicJobs, publicJobById, publicJobBySlug, publicJobView, startApplication, uploadResume, sha256,
  CONSENT_TEXT, SECTION_KEYS, applicationInput,
} from './hr.js';

/**
 * careers.briyo.xyz: the public Careers surface of this same application.
 *
 * Host isolation: `careersHost` is the first middleware in server.js. A request
 * for CAREERS_HOST is answered here and only here — the public routes below,
 * or a plain 404. It never reaches the session, /auth, any /api route or the
 * app's static files. (Browsers also never send the app's host-only session
 * cookie to this host.) On the internal host none of these routes exist.
 *
 * Abuse protection on submissions, in layers: per-IP rate limits, a honeypot
 * field, a signed minimum-fill-time token, and Cloudflare Turnstile (verified
 * server-side; with no keys configured, submissions are refused — fail closed).
 */

export const careersHostName = () => String(process.env.CAREERS_HOST || '').trim().toLowerCase();

const MIN_FILL_MS = 3000;
const FORM_MAX_AGE_MS = 24 * 3600 * 1000;
const LIMITS = {
  hour: { limit: 5, windowMs: 3600 * 1000 },
  day: { limit: 20, windowMs: 24 * 3600 * 1000 },
  perJob: { limit: 3, windowMs: 24 * 3600 * 1000 },
  resume: { limit: 20, windowMs: 3600 * 1000 },
};

const secret = () => `careers:${process.env.HR_FORM_SECRET || process.env.SESSION_SECRET || 'unset'}`;
const sign = (v) => crypto.createHmac('sha256', secret()).update(v).digest('base64url');

/** A form token: when the page was served, for this job, signed. */
export function issueFormToken(publicId, now = Date.now()) {
  return `${now}.${sign(`${publicId}.${now}`)}`;
}
export function checkFormToken(publicId, token, now = Date.now()) {
  const [ts, sig] = String(token || '').split('.');
  const issued = Number(ts);
  if (!issued || !sig) return 'missing';
  const expected = sign(`${publicId}.${issued}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'invalid';
  if (now - issued < MIN_FILL_MS) return 'too_fast';
  if (now - issued > FORM_MAX_AGE_MS) return 'expired';
  return null;
}

export const ipHash = (ip) => sha256(`${process.env.HR_IP_HASH_SALT || secret()}|${ip || ''}`);

/** Cloudflare Turnstile, server-side. Missing keys → refused (fail closed). */
export async function verifyTurnstile(token, ip) {
  const key = process.env.TURNSTILE_SECRET_KEY;
  if (!key) return { ok: false, reason: 'not_configured' };
  if (!token) return { ok: false, reason: 'missing' };
  const url = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: key, response: String(token).slice(0, 2048), remoteip: ip || '' }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    return data.success === true ? { ok: true } : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

const json = (res, status, body) => res.status(status).json(body);
const fail = (res, err) => {
  if (err.status && err.status < 500) {
    return json(res, err.status, { ok: false, error: err.message, field: err.field, duplicate: err.duplicate, closed: err.closed, retry: err.retry });
  }
  // Never log the request body: it is a candidate's personal data.
  console.error('Careers error:', err.code || '', err.message?.slice(0, 200));
  return json(res, 500, { ok: false, error: 'Something went wrong. Please try again.' });
};
const limited = (res, retryAfter) => {
  res.set('Retry-After', String(retryAfter));
  return json(res, 429, { ok: false, error: 'Too many applications from this connection. Please try again later.' });
};

function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; "
      + "connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
      + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
}

export const careersRouter = express.Router();
careersRouter.use(securityHeaders);

careersRouter.get('/robots.txt', (_req, res) => res.type('text').send('User-agent: *\nAllow: /\n'));

/** Public feed: published jobs only, public fields only. */
careersRouter.get('/jobs', async (_req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60');
    json(res, 200, { ok: true, jobs: await publicJobs() });
  } catch (err) { fail(res, err); }
});

/** One job's public data and a fresh form token (published or closed). */
careersRouter.get('/jobs/:publicId', async (req, res) => {
  try {
    const job = await publicJobById(req.params.publicId);
    if (!job) return json(res, 404, { ok: false, error: 'This job is not available.' });
    const sections = Object.fromEntries(SECTION_KEYS.filter((k) => job.sections?.[k]).map((k) => [k, job.sections[k]]));
    res.set('Cache-Control', 'no-store');
    if (job.status !== 'published') res.set('X-Robots-Tag', 'noindex');
    return json(res, 200, {
      ok: true,
      job: { ...publicJobView(job), sections },
      form: job.status === 'published'
        ? { token: issueFormToken(job.public_id), turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null, consentText: CONSENT_TEXT }
        : null,
    });
  } catch (err) { return fail(res, err); }
});

/**
 * /<slug>/apply. Phase 3 renders the full page; here the routing rules are in
 * place: current slug → the page, an old slug → 301, closed → noindex,
 * draft/archived/unknown → the same 404.
 */
careersRouter.get('/:slug/apply', async (req, res) => {
  try {
    const r = await publicJobBySlug(req.params.slug);
    if (!r) return res.status(404).type('text').send('Not found');
    if (r.redirect) return res.redirect(301, `/${r.redirect}/apply`);
    if (r.job.status !== 'published') res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'no-store');
    return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${String(r.job.title).replace(/[<>&"]/g, '')} — Careers at Briyo</title>`
      + `<p>${r.job.status === 'published' ? 'Applications open.' : 'Applications are closed for this role.'}</p>`);
  } catch (err) { return fail(res, err); }
});

/** Step 1: the application. Returns a single-use resume upload token. */
careersRouter.post('/jobs/:publicId/apply', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const ip = req.ip;
    const pid = String(req.params.publicId || '');
    for (const [k, l] of [['hour', LIMITS.hour], ['day', LIMITS.day], [`job:${pid}`, LIMITS.perJob]]) {
      const r = rateLimit({ key: `careers:apply:${k}:${ip}`, ...l });
      if (!r.ok) return limited(res, r.retryAfter);
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return json(res, 400, { ok: false, error: 'Malformed request.' });
    // Honeypot: a field people never see. Anything in it is a bot.
    if (String(body.website ?? '').trim()) return json(res, 400, { ok: false, error: 'The application could not be submitted.' });
    const form = checkFormToken(pid, body.form_token);
    if (form === 'too_fast') return json(res, 400, { ok: false, error: 'That was very fast. Please review your application and submit again.' });
    if (form) return json(res, 400, { ok: false, error: 'This form has expired. Please reload the page and try again.', reload: true });
    const job = await publicJobById(pid);
    if (!job) return json(res, 404, { ok: false, error: 'This job is not available.' });
    if (job.status !== 'published') return json(res, 409, { ok: false, error: 'Applications for this job are closed.', closed: true });
    // Validate before spending the Turnstile token, so a typo does not cost a new challenge.
    applicationInput(body);
    const ts = await verifyTurnstile(body.turnstile_token, ip);
    if (!ts.ok) {
      return ts.reason === 'not_configured' || ts.reason === 'unreachable'
        ? json(res, 503, { ok: false, error: 'Applications are briefly unavailable. Please try again shortly.' })
        : json(res, 400, { ok: false, error: 'Please complete the verification and try again.', field: 'turnstile' });
    }
    const out = await startApplication(pid, body, { ipHash: ipHash(ip) });
    return json(res, 201, { ok: true, uploadToken: out.uploadToken, jobTitle: out.jobTitle, expiresInMinutes: out.expiresInMinutes });
  } catch (err) { return fail(res, err); }
});

/** Step 2: the resume (raw body, X-Filename, X-Upload-Token). */
careersRouter.post('/jobs/:publicId/apply/resume', express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 }), async (req, res) => {
  try {
    const r = rateLimit({ key: `careers:resume:${req.ip}`, ...LIMITS.resume });
    if (!r.ok) return limited(res, r.retryAfter);
    let filename = '';
    try { filename = decodeURIComponent(String(req.get('x-filename') || '')); } catch { return json(res, 400, { ok: false, error: 'Malformed file name.' }); }
    const out = await uploadResume(req.params.publicId, req.get('x-upload-token'), {
      filename, buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    return json(res, 201, out);
  } catch (err) { return fail(res, err); }
});

// Too-large bodies (raw/json limits) and malformed JSON: a clean answer, not a stack trace.
// eslint-disable-next-line no-unused-vars
careersRouter.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return json(res, 413, { ok: false, error: 'That file is larger than 10 MB.' });
  if (err.type === 'entity.parse.failed') return json(res, 400, { ok: false, error: 'Malformed request.' });
  return fail(res, err);
});

const notFound = (res) => res.status(404).type('text').send('Not found');

/** First middleware of the app: the careers host gets only careersRouter. */
export function careersHost(req, res, next) {
  const host = careersHostName();
  if (!host || String(req.hostname || '').toLowerCase() !== host) return next();
  return careersRouter(req, res, () => notFound(res));
}
