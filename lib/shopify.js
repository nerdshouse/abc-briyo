const NAMESPACE = 'cart_recovery_board';
const KEY = 'status_map';

export const hasCredentials = () =>
  Boolean(process.env.SHOPIFY_ACCESS_TOKEN ||
    (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET));

export const isMockMode = () => !hasCredentials() || !process.env.SHOPIFY_STORE_DOMAIN;

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
  {
    abandonedCheckouts(first: 100, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { firstName lastName email }
          billingAddress { phone }
          abandonedCheckoutUrl
          lineItems(first: 10) { edges { node { title quantity } } }
        }
      }
    }
  }
`;

export async function fetchAbandonedCheckouts() {
  const data = await graphql(ABANDONED_CHECKOUTS_QUERY);
  return (data.abandonedCheckouts?.edges ?? []).map(({ node }) => {
    const items = (node.lineItems?.edges ?? []).map((e) => e.node);
    const first = node.customer?.firstName ?? '';
    const last = node.customer?.lastName ?? '';
    return {
      id: node.id,
      createdAt: node.createdAt,
      amount: Number(node.totalPriceSet?.shopMoney?.amount ?? 0),
      currency: node.totalPriceSet?.shopMoney?.currencyCode ?? 'INR',
      name: `${first} ${last}`.trim() || null,
      email: node.customer?.email ?? null,
      // customer.phone is almost always null on abandoned checkouts; the billing
      // address is where the number actually lands.
      phone: node.billingAddress?.phone ?? null,
      checkoutUrl: node.abandonedCheckoutUrl ?? null,
      items,
      itemCount: items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    };
  });
}

// The shop GID never changes, so fetch it once per process.
let shopIdPromise = null;
export function getShopId() {
  if (!shopIdPromise) {
    shopIdPromise = graphql(`{ shop { id } }`)
      .then((d) => d.shop.id)
      .catch((err) => { shopIdPromise = null; throw err; });
  }
  return shopIdPromise;
}

export async function readStatusMap() {
  const data = await graphql(`
    { shop { metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } } }
  `);
  const raw = data.shop?.metafield?.value;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Corrupt blob shouldn't take the board down; start clean rather than 500.
    console.error('status_map metafield is not valid JSON; treating as empty');
    return {};
  }
}

export async function writeStatusMap(map) {
  const ownerId = await getShopId();
  const data = await graphql(
    `mutation SetMeta($input: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $input) {
         userErrors { field message }
       }
     }`,
    {
      input: [{
        ownerId,
        namespace: NAMESPACE,
        key: KEY,
        type: 'json',
        value: JSON.stringify(map),
      }],
    },
  );

  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    const detail = errors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ');
    throw new Error(
      `Shopify refused the metafield write — ${detail}. If this mentions access or ` +
      `permissions, the custom app needs broader scopes (see README, "Metafield write permissions").`,
    );
  }
  return map;
}

export { NAMESPACE, KEY };
