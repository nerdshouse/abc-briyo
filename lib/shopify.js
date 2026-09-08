const NAMESPACE = 'cart_recovery_board';
const KEY = 'status_map';

export const isMockMode = () => !process.env.SHOPIFY_ACCESS_TOKEN || !process.env.SHOPIFY_STORE_DOMAIN;

function endpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const version = process.env.SHOPIFY_API_VERSION || '2026-07';
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

/** Thin Admin GraphQL client. Throws with a useful message on transport or GraphQL errors. */
export async function graphql(query, variables = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Shopify rejected the access token (HTTP ${res.status}). Check SHOPIFY_ACCESS_TOKEN ` +
      `and that the custom app has the read_orders scope. Response: ${text.slice(0, 300)}`,
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
