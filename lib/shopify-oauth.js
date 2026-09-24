import crypto from 'node:crypto';
import { recordSystemEvent, getSystemState } from './db.js';

/**
 * Shopify OAuth — the authorization code grant.
 *
 * We started on the client credentials grant, which is far simpler: swap the
 * client ID and secret for a token, no redirects. But Shopify restricts it to
 * stores inside the app's own organization — dev stores created from the Dev
 * Dashboard. Against a real production store it answers `app_not_installed`
 * however many times you install the app, because that endpoint cannot see an
 * install outside the organization.
 *
 * So for a custom-distribution app on a live store, running outside the Shopify
 * admin as this one does, the authorization code grant is the supported route.
 * It is a one-time handshake in a browser that yields an *offline* token, which
 * does not expire. We store it and never repeat the dance unless scopes change.
 */

/** Keep in step with what lib/shopify.js actually queries. */
export const SCOPES = 'read_orders';

const TOKEN_KEY = 'shopify_oauth_token';

/** Shopify only accepts a bare *.myshopify.com host — reject anything else. */
export function normaliseShop(input) {
  const raw = String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : null;
}

export function installUrl({ shop, state, redirectUri }) {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set('client_id', process.env.SHOPIFY_CLIENT_ID || '');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  // Offline is the default, but being explicit documents the intent: a token
  // that outlives whoever happened to click the link.
  u.searchParams.set('grant_options[]', '');
  return u.toString();
}

/**
 * Shopify signs the callback query string. Verifying it is what stops anyone
 * who knows the URL from feeding us a code of their own choosing.
 */
export function verifyHmac(query, secret = process.env.SHOPIFY_CLIENT_SECRET) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || !secret) return false;
  const message = Object.keys(rest).sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest();
  const given = Buffer.from(String(hmac), 'utf8');
  const mine = Buffer.from(digest.toString('hex'), 'utf8');
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}

export async function exchangeCode({ shop, code }) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify refused the code (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`No access_token in Shopify's reply: ${text.slice(0, 200)}`);
  return json;
}

/**
 * The token lives in the database, not the environment: it is minted by a
 * browser round-trip, so there is no human present to paste it into Render, and
 * a redeploy must not lose it.
 */
export async function storeToken({ shop, token, scope }) {
  await recordSystemEvent(TOKEN_KEY, JSON.stringify({ shop, token, scope }));
}

export async function loadToken(shop) {
  const row = await getSystemState(TOKEN_KEY);
  if (!row?.value) return null;
  try {
    const saved = JSON.parse(row.value);
    // A token is bound to one store; if the domain changed, it is not ours.
    if (shop && saved.shop !== shop) return null;
    return saved;
  } catch { return null; }
}

