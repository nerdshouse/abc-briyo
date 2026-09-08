import crypto from 'node:crypto';

const COOKIE = 'crb_session';
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

let warned = false;
function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (!warned) {
    warned = true;
    console.warn(
      '\n  WARNING: SESSION_SECRET is unset or too short. Using a random per-process secret,\n' +
      '  which logs everyone out on every restart and breaks multi-instance deploys.\n' +
      '  Set SESSION_SECRET before deploying: openssl rand -hex 32\n',
    );
  }
  return (globalThis.__crbEphemeralSecret ??= crypto.randomBytes(32).toString('hex'));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

/** Stateless signed token: <payload>.<hmac>. No server-side session store needed. */
export function issueSession(phone) {
  const payload = b64url(JSON.stringify({
    phone,
    exp: Date.now() + TTL_HOURS * 3600 * 1000,
  }));
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;

  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: TTL_HOURS * 3600 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export { COOKIE };
