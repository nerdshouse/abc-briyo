/**
 * Amazon Selling Partner API client — Orders API v2026-01-01 only (searchOrders, getOrder).
 *
 * Authentication is Login with Amazon (LWA): the seller's refresh token (from self-authorising Briyo's private app
 * in Seller Central) is exchanged at https://api.amazon.com/auth/o2/token for an access token (about an hour),
 * sent as `x-amz-access-token`. SP-API no longer needs AWS IAM or SigV4 signing (since 02-10-2023).
 *
 * Secrets: the client secret, refresh token and access token never leave this module — not in a log, an error, a
 * URL or the database. The access token lives in memory only and is refreshed shortly before it expires, or once
 * when Amazon answers 401 (or 403 for an expired/invalid access token).
 *
 * Errors carry the shared retry flags (lib/http-retry.js): 429 → throttled (with Amazon's rate-limit header as a
 * wait hint), 5xx and connection failures → transient, everything else permanent. Order mapping lives in
 * lib/amazon-orders.js; this module only speaks HTTP. `transport` is injectable: tests never reach Amazon.
 */
import { connectionFailure, markThrottled, markTransient, withRetry } from './http-retry.js';

export const ORDERS_API_VERSION = '2026-01-01';
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
/** Selling regions → SP-API endpoints. India (A21TJRUUN4KGV) is served by the EU endpoint. */
export const ENDPOINTS = Object.freeze({
  na: 'https://sellingpartnerapi-na.amazon.com',
  eu: 'https://sellingpartnerapi-eu.amazon.com',
  fe: 'https://sellingpartnerapi-fe.amazon.com',
});
const USER_AGENT = 'BriyoOS/1.0 (Language=JavaScript; Platform=Node)';
const TOKEN_SKEW_MS = 60000;                 // refresh a minute before Amazon's expiry
const TIMEOUT_MS = 30000;

const isPlaceholder = (v) => !v || /^(x+|fake.*|placeholder.*|your[-_].*|changeme)$/i.test(String(v).trim());

/** The Amazon settings from the environment. Values are never returned to a caller that might show them. */
export function amazonConfig(env = process.env) {
  const region = String(env.AMAZON_SPAPI_REGION || 'eu').trim().toLowerCase();
  return {
    clientId: env.AMAZON_LWA_CLIENT_ID || '',
    clientSecret: env.AMAZON_LWA_CLIENT_SECRET || '',
    refreshToken: env.AMAZON_SPAPI_REFRESH_TOKEN || '',
    sellerId: env.AMAZON_SELLER_ID || '',
    marketplaceId: env.AMAZON_MARKETPLACE_ID || '',
    region,
    endpoint: ENDPOINTS[region] || null,
  };
}

/** True only when every credential is set to something that is not an obvious placeholder. */
export function amazonConfigured(cfg = amazonConfig()) {
  return Boolean(cfg.endpoint) && ['clientId', 'clientSecret', 'refreshToken', 'sellerId', 'marketplaceId'].every((k) => !isPlaceholder(cfg[k]));
}

/**
 * Removes every secret this client knows, and anything shaped like an LWA token (Atza|… access, Atzr|… refresh),
 * from a string that might reach a log or an error message.
 */
export function redact(text, cfg = {}) {
  let s = String(text ?? '');
  for (const secret of [cfg.clientSecret, cfg.refreshToken, cfg.accessToken]) {
    if (secret && String(secret).length >= 6) s = s.split(String(secret)).join('[redacted]');
  }
  return s.replace(/Atz[ar]\|[A-Za-z0-9_\-+/=|.]+/g, '[redacted]')
    .replace(/(client_secret|refresh_token|access_token)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1$2[redacted]');
}

const bad = (message, status, extra = {}) => Object.assign(new Error(message), { ...(status ? { status } : {}), ...extra });

/** The default transport: fetch with a timeout. Returns { status, headers (lower-case), text }. */
async function fetchTransport({ method, url, headers, body }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    return { status: res.status, headers: Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v])), text: await res.text() };
  } finally { clearTimeout(timer); }
}

/** Amazon's error list as one short line ("InvalidInput: Invalid Input"), redacted. Never the raw body. */
function amazonErrors(text, cfg) {
  try {
    const list = JSON.parse(text)?.errors;
    if (Array.isArray(list) && list.length) {
      return redact(list.slice(0, 3).map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; '), cfg).slice(0, 300);
    }
  } catch { /* not JSON */ }
  return 'no error details';
}

/** The wait Amazon's rate-limit header suggests (one request's worth of its token bucket), or undefined. */
function rateLimitWaitMs(headers) {
  const perSecond = Number(headers?.['x-amzn-ratelimit-limit']);
  return Number.isFinite(perSecond) && perSecond > 0 ? Math.ceil(1000 / perSecond) : undefined;
}

/**
 * A client bound to one set of credentials. Options are for tests: `config` (else the environment), `transport`,
 * `backoffMs`, `wait`, `now`.
 */
export function createAmazonClient({ config = amazonConfig(), transport = fetchTransport, backoffMs = 2000, wait, now = () => Date.now() } = {}) {
  const cfg = { ...config };
  let cached = null;                         // { token, expiresAt } — memory only
  let inflight = null;
  const scrub = (s) => redact(s, { ...cfg, accessToken: cached?.token });
  // A transport error, reduced to what connectionFailure reads, with every part scrubbed.
  const scrubbed = (err) => ({ message: scrub(err?.message), cause: { code: err?.cause?.code ? scrub(err.cause.code) : undefined, message: err?.cause?.message ? scrub(err.cause.message) : undefined } });

  async function exchange() {
    if (!amazonConfigured(cfg)) throw bad('Amazon is not connected: the SP-API credentials are not set.', 400);
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString();
    let res;
    try {
      res = await transport({ method: 'POST', url: LWA_TOKEN_URL, headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': USER_AGENT }, body });
    } catch (err) { throw connectionFailure(scrubbed(err), 'Amazon login (LWA)'); }
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* handled below */ }
    if (res.status === 429) throw Object.assign(markThrottled(new Error('Amazon login (LWA) rate limit hit (HTTP 429).')), { retryAfterMs: rateLimitWaitMs(res.headers) });
    if (res.status >= 500) throw markTransient(new Error(`Amazon login (LWA) HTTP ${res.status}.`));
    if (res.status !== 200 || !json?.access_token) {
      // LWA's own error code (invalid_grant, invalid_client, …) says what is wrong; its description and the body never leave.
      const code = typeof json?.error === 'string' ? json.error.replace(/[^a-z_]/gi, '').slice(0, 40) : 'no access token';
      throw bad(`Amazon login (LWA) failed: HTTP ${res.status} (${code}). Check the LWA client and the refresh token.`, 502, { amazonAuth: true });
    }
    const ttl = Math.max(60, Number(json.expires_in) || 3600) * 1000;
    cached = { token: json.access_token, expiresAt: now() + ttl - TOKEN_SKEW_MS };
    return cached.token;
  }

  /** The current access token, exchanged again when missing, about to expire, or `force`d. Concurrent callers share one exchange. */
  async function accessToken({ force = false } = {}) {
    if (!force && cached && now() < cached.expiresAt) return cached.token;
    if (force) cached = null;
    if (!inflight) inflight = withRetry(exchange, { backoffMs, wait, transientAttempts: 3 }).finally(() => { inflight = null; });
    return inflight;
  }

  /** One SP-API call: auth header, one token refresh on 401/expired-403, retry flags on the error. */
  async function call(op, path, query = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));   // arrays: form style, not exploded (a,b,c)
    }
    const url = `${cfg.endpoint}${path}${qs.size ? `?${qs}` : ''}`;
    const send = async (token) => {
      try {
        return await transport({ method: 'GET', url, headers: { 'x-amz-access-token': token, 'x-amz-date': new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, ''), 'user-agent': USER_AGENT, accept: 'application/json' } });
      } catch (err) { throw connectionFailure(scrubbed(err), 'Amazon'); }
    };
    let res = await send(await accessToken());
    const authExpired = (r) => r.status === 401 || (r.status === 403 && /expired|invalid.*(access )?token|unauthori[sz]ed/i.test(amazonErrors(r.text, cfg)));
    if (authExpired(res)) res = await send(await accessToken({ force: true }));   // once: a fresh token, then the answer stands
    if (res.status >= 200 && res.status < 300) {
      try { return JSON.parse(res.text); } catch { throw markTransient(new Error(`Amazon ${op}: the response was not JSON.`)); }
    }
    const detail = amazonErrors(res.text, cfg);
    const err = new Error(`Amazon ${op} HTTP ${res.status}: ${detail}`);
    if (res.status === 429) return Promise.reject(Object.assign(markThrottled(err), { retryAfterMs: rateLimitWaitMs(res.headers) }));
    if (res.status >= 500) return Promise.reject(markTransient(err));
    // 400 on a page request whose token Amazon no longer accepts (expired after 24 hours, or invalid).
    if (res.status === 400 && query.paginationToken && /token/i.test(detail)) err.paginationTokenRejected = true;
    if (res.status === 401 || res.status === 403) err.amazonAuth = true;
    return Promise.reject(err);
  }

  const retried = (op, fn, onTransientRetry) => withRetry(fn, {
    backoffMs, wait, throttleAttempts: 4, transientAttempts: 3,
    onTransientRetry: (n, max, err) => {
      if (onTransientRetry) onTransientRetry(n, max, err);
      console.warn(`Amazon ${op}: transient failure, retry ${n} of ${max} (${scrub(err.message).slice(0, 120)})`);
    },
  });

  return {
    /**
     * One page of searchOrders. Pass `paginationToken` for the next page with the SAME other parameters
     * (Amazon requires it; only maxResultsPerPage and includedData may change).
     */
    searchOrders({ lastUpdatedAfter, lastUpdatedBefore, createdAfter, createdBefore, fulfillmentStatuses, fulfilledBy,
      maxResultsPerPage = 100, includedData, paginationToken, marketplaceIds = [cfg.marketplaceId] } = {}, { onTransientRetry } = {}) {
      return retried('searchOrders', () => call('searchOrders', `/orders/${ORDERS_API_VERSION}/orders`, {
        marketplaceIds, createdAfter, createdBefore, lastUpdatedAfter, lastUpdatedBefore, fulfillmentStatuses, fulfilledBy,
        maxResultsPerPage, includedData, paginationToken,
      }), onTransientRetry);
    },
    /** One order with its items (always included), plus any `includedData` sections. */
    getOrder(orderId, { includedData } = {}, { onTransientRetry } = {}) {
      if (!/^[0-9A-Za-z-]{1,40}$/.test(String(orderId || ''))) return Promise.reject(bad('Not an Amazon order id.', 400));
      return retried('getOrder', () => call('getOrder', `/orders/${ORDERS_API_VERSION}/orders/${encodeURIComponent(orderId)}`, { includedData }), onTransientRetry);
    },
    /** For tests: whether an access token is cached (never the token). */
    hasCachedToken: () => Boolean(cached),
    marketplaceId: cfg.marketplaceId,
  };
}
