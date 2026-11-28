/**
 * Flipkart Marketplace Seller API v3 — the client (self access: one seller, our own account).
 *
 *   FLIPKART_APP_ID       the Self Access application id ("Briyo OS", domain abc.briyo.xyz) — Seller Hub → Manage
 *   FLIPKART_APP_SECRET   Profile → Developer Access. Never the FinanceOS application's: that one is the finance system's.
 *   FLIPKART_API_BASE     optional, default https://api.flipkart.net
 *
 * Token: client credentials (GET /oauth-service/oauth/token, Basic app id:secret, scope Seller_Api), kept in memory
 * until shortly before it expires. Calls used:
 *   POST /sellers/v3/shipments/filter/          search shipments (pages of 20, then GET nextPageUrl)
 *   GET  /sellers/v3/shipments/{shipmentIds}    courier, tracking id and delivery address (up to 100 ids)
 *   GET  /sellers/listings/v3/{skuIds}          a listing's product id and locations (up to 10 SKUs)
 *   POST /sellers/listings/v3/update/inventory  stock per listing location (up to 10 SKUs)
 * 429 and 5xx are retried (lib/http-retry.js); nothing here logs a token, the secret or a buyer's details.
 */
import { withRetry, markThrottled, markTransient, connectionFailure, classifyStatus } from './http-retry.js';

export const flipkartConfigured = () => Boolean(process.env.FLIPKART_APP_ID && process.env.FLIPKART_APP_SECRET);
const base = () => String(process.env.FLIPKART_API_BASE || 'https://api.flipkart.net').replace(/\/+$/, '');
const bad = (message, status = 502, extra = {}) => Object.assign(new Error(message), { status, ...extra });
/** Flipkart gives nextPageUrl relative to /sellers (e.g. "/v3/shipments/filter/?..."), or as a full URL. */
export const nextPath = (next) => (/^https?:\/\//.test(next) ? next : next.startsWith('/sellers/') ? next : `/sellers${next.startsWith('/') ? '' : '/'}${next}`);

/**
 * `transport(url, init)` is fetch by default; tests pass a fake. `now` is injectable. Returns the API functions.
 */
export function createFlipkartClient({ transport = (url, init) => fetch(url, init), appId = process.env.FLIPKART_APP_ID,
  appSecret = process.env.FLIPKART_APP_SECRET, apiBase = base(), now = () => Date.now(), wait } = {}) {
  let token = null;
  let tokenUntil = 0;

  async function call(url, init, label) {
    let res;
    try { res = await transport(url, { ...init, signal: AbortSignal.timeout(30000) }); } catch (err) { throw connectionFailure(err, 'Flipkart'); }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const why = String(json?.error_description || json?.message || json?.errors?.[0]?.description || json?.error || text || '').replace(/\s+/g, ' ').slice(0, 200);
      const err = bad(`Flipkart ${label} failed (HTTP ${res.status})${why ? `: ${why}` : ''}`, 502, { httpStatus: res.status });
      const kind = classifyStatus(res.status);
      if (kind === 'throttled') markThrottled(err); else if (kind === 'transient' || res.status >= 500) markTransient(err);
      if (res.status === 401) err.unauthorized = true;
      throw err;
    }
    return json;
  }

  async function accessToken() {
    if (token && now() < tokenUntil) return token;
    if (!appId || !appSecret) throw bad('Flipkart is not connected: FLIPKART_APP_ID and FLIPKART_APP_SECRET are not set.', 400);
    const basic = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const json = await withRetry(() => call(`${apiBase}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`,
      { method: 'GET', headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } }, 'sign-in'), wait ? { wait } : {});
    if (!json?.access_token) throw bad('Flipkart sign-in returned no access token. Check FLIPKART_APP_ID and FLIPKART_APP_SECRET.');
    token = json.access_token;
    // Renew a day early (tokens last weeks), and never trust a missing expiry for more than an hour.
    const life = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3600000;
    tokenUntil = now() + Math.max(life - 86400000, Math.min(life, 3600000) / 2);
    return token;
  }

  /** A signed call; a 401 drops the token and tries once more with a new one. */
  async function api(path, { method = 'GET', body, label }) {
    const url = /^https?:\/\//.test(path) ? path : `${apiBase}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const t = await accessToken();
      try {
        return await withRetry(() => call(url, {
          method, headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }, label), wait ? { wait } : {});
      } catch (err) {
        if (err.unauthorized && attempt === 0) { token = null; continue; }
        throw err;
      }
    }
  }

  return {
    /** Every shipment matching `filter` (Flipkart's filter object), following nextPageUrl. At most `max` shipments. */
    async searchShipments(filter, { max = 5000 } = {}) {
      const out = [];
      let page = await api('/sellers/v3/shipments/filter/', { method: 'POST', body: { filter, pagination: { pageSize: 20 } }, label: 'shipment search' });
      for (;;) {
        out.push(...(Array.isArray(page?.shipments) ? page.shipments : []));
        if (!page?.hasMore || !page?.nextPageUrl || out.length >= max) break;
        page = await api(nextPath(String(page.nextPageUrl)), { method: 'GET', label: 'shipment search (next page)' });
      }
      return out;
    },
    /** Courier, tracking id and delivery address for up to 100 shipment ids at a time. */
    async shipmentDetails(ids) {
      const out = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const json = await api(`/sellers/v3/shipments/${chunk.map(encodeURIComponent).join(',')}`, { label: 'shipment details' });
        out.push(...(Array.isArray(json?.shipments) ? json.shipments : []));
      }
      return out;
    },
    /** Listing details (product id, locations with id, status and stock) for up to 10 seller SKUs at a time. */
    async listings(skus) {
      const available = {}; const invalid = [];
      for (let i = 0; i < skus.length; i += 10) {
        const chunk = skus.slice(i, i + 10);
        const json = await api(`/sellers/listings/v3/${chunk.map(encodeURIComponent).join(',')}`, { label: 'listing lookup' });
        Object.assign(available, json?.available || {});
        invalid.push(...Object.keys(json?.invalid || {}), ...Object.keys(json?.unavailable || {}));
      }
      return { available, invalid };
    },
    /** Sets stock: `{ sku: { product_id, locations: [{ id, inventory }] } }`, sent 10 SKUs at a time. Per-SKU results. */
    async updateInventory(bySku) {
      const entries = Object.entries(bySku);
      const results = {};
      for (let i = 0; i < entries.length; i += 10) {
        const json = await api('/sellers/listings/v3/update/inventory', { method: 'POST', body: Object.fromEntries(entries.slice(i, i + 10)), label: 'stock update' });
        Object.assign(results, json || {});
      }
      return results;
    },
  };
}
