
/**
 * A left-over placeholder counts as "not configured".
 *
 * `.env.example` ships `shpat_xxxx…`, and a copied-but-unfilled value otherwise
 * makes the app believe Shopify is connected and answer every question with an
 * opaque 401. Silence is a better failure than a wrong explanation.
 */
const isPlaceholder = (v) => !v || /^(shpat_)?x+$/i.test(String(v).trim())
  || /^(replace|your[-_]?|paste|<)/i.test(String(v).trim());

export const hasCredentials = () =>
  Boolean((process.env.SHOPIFY_ACCESS_TOKEN && !isPlaceholder(process.env.SHOPIFY_ACCESS_TOKEN))
    || (process.env.SHOPIFY_CLIENT_ID && !isPlaceholder(process.env.SHOPIFY_CLIENT_ID)
        && process.env.SHOPIFY_CLIENT_SECRET && !isPlaceholder(process.env.SHOPIFY_CLIENT_SECRET)));

/** Shopify retires API versions after ~12 months; a dead one 404s confusingly. */
export function apiVersionWarning() {
  const v = process.env.SHOPIFY_API_VERSION;
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})$/);
  if (!m) return `SHOPIFY_API_VERSION="${v}" is not a valid version (expected YYYY-MM).`;
  const age = (Date.now() - new Date(`${m[1]}-${m[2]}-01T00:00:00Z`).getTime()) / 86400000;
  return age > 400
    ? `SHOPIFY_API_VERSION=${v} is past Shopify's ~12-month support window and will start 404ing. Bump it.`
    : null;
}

/** Shopify is optional: the board runs on GoKwik alone if this is unset. */
export const shopifyConfigured = () => hasCredentials() && Boolean(process.env.SHOPIFY_STORE_DOMAIN);

export const authMode = () =>
  process.env.SHOPIFY_ACCESS_TOKEN ? 'static token (legacy custom app)' : 'client credentials (Dev Dashboard app)';

/**
 * Token acquisition.
 *
 * Legacy custom apps (created in the store admin before 1 Jan 2026) hand out a
 * permanent shpat_ token — if SHOPIFY_ACCESS_TOKEN is set we just use it.
 *
 * Apps created in the Dev Dashboard have no permanent token. They use the client
 * credentials grant, which returns a token valid for ~24h, so we fetch on demand
 * and cache it until shortly before it expires. This only works when the app and
 * the store are in the same Shopify organization.
 */
let cachedToken = null;   // { value, expiresAt }

async function fetchClientCredentialsToken() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Could not get a Shopify token (HTTP ${res.status}): ${text.slice(0, 300)}. ` +
      `Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET, and that the app and store ` +
      `are in the same Shopify organization.`,
    );
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Shopify token endpoint returned non-JSON: ${text.slice(0, 200)}`); }

  if (!json.access_token) throw new Error(`No access_token in Shopify's response: ${text.slice(0, 200)}`);

  // Refresh a minute early so a long-running request never uses an expiring token.
  const ttl = (Number(json.expires_in) || 86399) * 1000;
  cachedToken = { value: json.access_token, expiresAt: Date.now() + ttl - 60_000 };
  console.log(`Shopify token acquired, valid ~${Math.round(ttl / 3600000)}h. Scopes: ${json.scope || '(none reported)'}`);
  return cachedToken.value;
}

export async function getAccessToken({ force = false } = {}) {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  cachedToken = null;
  return fetchClientCredentialsToken();
}

function endpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

/** Thin Admin GraphQL client. Throws with a useful message on transport or GraphQL errors. */
export async function graphql(query, variables = {}, { isRetry = false } = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getAccessToken({ force: isRetry }),
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    // A cached client-credentials token can be revoked before it expires; get a
    // fresh one and try once more before giving up.
    if (!isRetry && !process.env.SHOPIFY_ACCESS_TOKEN) {
      return graphql(query, variables, { isRetry: true });
    }
    throw new Error(
      `Shopify rejected the access token (HTTP ${res.status}). Check your credentials ` +
      `and that the app has the read_orders scope. Response: ${text.slice(0, 300)}`,
    );
  }
  if (res.status === 429) {
    throw new Error('Shopify rate limit hit (HTTP 429). Wait a moment and refresh.');
  }
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    // The most common cause by far is a missing scope on the custom app.
    throw new Error(`Shopify GraphQL error: ${msg}`);
  }
  return json.data;
}

const ABANDONED_CHECKOUTS_QUERY = `
  query Abandoned($cursor: String) {
    abandonedCheckouts(first: 50, sortKey: CREATED_AT, reverse: true, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          abandonedCheckoutUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
          customer { firstName lastName email phone numberOfOrders }
          billingAddress { phone address1 city province zip }
          shippingAddress { phone address1 city province zip }
          lineItems(first: 25) { edges { node { title quantity } } }
        }
      }
    }
  }
`;

const money = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const addressLine = (a) => {
  if (!a) return null;
  const parts = [a.address1, a.city, a.province, a.zip].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
};

/**
 * Pulls abandoned checkouts, newest first, in the shape importCarts expects.
 *
 * Shopify has no abandoned-checkout webhook — only checkouts/create|update, and
 * abandonment is decided by elapsed time — so this is polled rather than pushed.
 *
 * Unlike the CSV export, the API does return `abandonedCheckoutUrl`, so carts
 * that arrive this way have a working recovery link.
 */
export async function fetchAbandonedCheckouts({ maxPages = 4 } = {}) {
  const carts = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphql(ABANDONED_CHECKOUTS_QUERY, { cursor });
    const conn = data.abandonedCheckouts;
    if (!conn) break;

    for (const { node } of conn.edges ?? []) {
      const items = (node.lineItems?.edges ?? []).map((e) => ({
        title: e.node.title,
        quantity: Number(e.node.quantity) || 1,
      }));
      const first = node.customer?.firstName ?? '';
      const last = node.customer?.lastName ?? '';
      // gid://shopify/AbandonedCheckout/12345 -> 12345, so an API-sourced cart
      // and the same checkout from a CSV export share one cart_id.
      const numericId = String(node.id).split('/').pop();

      carts.push({
        cartId: `shopify-${numericId}`,
        customerName: `${first} ${last}`.trim() || null,
        // customer.phone is usually null on abandoned checkouts; the address is
        // where the number actually lands.
        phone: node.customer?.phone || node.billingAddress?.phone || node.shippingAddress?.phone || null,
        email: node.customer?.email ?? null,
        totalPrice: money(node.totalPriceSet?.shopMoney?.amount),
        subtotal: money(node.subtotalPriceSet?.shopMoney?.amount),
        discountTotal: money(node.totalDiscountSet?.shopMoney?.amount),
        mrpTotal: null,
        currency: node.totalPriceSet?.shopMoney?.currencyCode ?? 'INR',
        checkoutUrl: node.abandonedCheckoutUrl ?? null,
        itemCount: items.reduce((n, i) => n + i.quantity, 0) || null,
        abandonedAt: node.createdAt ?? null,
        dropStage: null,
        dropReason: null,
        riskFlag: null,
        utmSource: null,
        utmCampaign: null,
        utmMedium: null,
        address: addressLine(node.shippingAddress) || addressLine(node.billingAddress),
        gokwikEmailSent: null,
        gokwikMessageQueued: null,
        brandOrderCount: Number.isFinite(Number(node.customer?.numberOfOrders))
          ? Number(node.customer.numberOfOrders) : null,
        items,
        raw: { _source: 'shopify-api', checkout: node },
      });
    }

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return carts;
}

// The shop GID never changes, so fetch it once per process.

