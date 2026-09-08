/**
 * Sample data so the board is fully usable before a live Shopify token exists.
 * Active whenever SHOPIFY_ACCESS_TOKEN / SHOPIFY_STORE_DOMAIN are unset.
 * The status map lives in memory here and resets on restart — the real one is
 * a Shopify shop metafield.
 */

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

export const mockCarts = [
  {
    id: 'gid://shopify/AbandonedCheckout/1001',
    createdAt: hoursAgo(2),
    amount: 2499, currency: 'INR',
    name: 'Asha Rao', email: 'asha@example.com', phone: '9812345678',
    checkoutUrl: 'https://example.myshopify.com/checkout/1001',
    items: [{ title: 'Whey Protein 1kg', quantity: 1 }, { title: 'Shaker Bottle', quantity: 1 }],
    itemCount: 2,
  },
  {
    id: 'gid://shopify/AbandonedCheckout/1002',
    createdAt: hoursAgo(9),
    amount: 1299, currency: 'INR',
    name: 'Ravi Kulkarni', email: 'ravi.k@example.com', phone: '+91 98200 11223',
    checkoutUrl: 'https://example.myshopify.com/checkout/1002',
    items: [{ title: 'Creatine Monohydrate 250g', quantity: 1 }],
    itemCount: 1,
  },
  {
    id: 'gid://shopify/AbandonedCheckout/1003',
    createdAt: hoursAgo(30),
    amount: 4780, currency: 'INR',
    name: 'Meera Nair', email: 'meera.nair@example.com', phone: '9004567890',
    checkoutUrl: 'https://example.myshopify.com/checkout/1003',
    items: [
      { title: 'Mass Gainer 3kg', quantity: 1 },
      { title: 'Multivitamin 60 tabs', quantity: 2 },
    ],
    itemCount: 3,
  },
  {
    id: 'gid://shopify/AbandonedCheckout/1004',
    createdAt: hoursAgo(74),
    amount: 899, currency: 'INR',
    name: null, email: 'guest-checkout@example.com', phone: null,
    checkoutUrl: 'https://example.myshopify.com/checkout/1004',
    items: [{ title: 'BCAA 200g', quantity: 1 }],
    itemCount: 1,
  },
  {
    id: 'gid://shopify/AbandonedCheckout/1005',
    createdAt: hoursAgo(150),
    amount: 6250, currency: 'INR',
    name: 'Sandeep Iyer', email: 'sandeep@example.com', phone: '9876501234',
    checkoutUrl: 'https://example.myshopify.com/checkout/1005',
    items: [
      { title: 'Whey Isolate 2kg', quantity: 1 },
      { title: 'Omega-3 90 caps', quantity: 1 },
      { title: 'Pre-Workout 300g', quantity: 1 },
    ],
    itemCount: 3,
  },
];

let store = {
  'gid://shopify/AbandonedCheckout/1002': {
    status: 'Called – No answer',
    notes: 'Rang twice, no pickup. Try evening.',
    updatedAt: hoursAgo(4),
  },
  'gid://shopify/AbandonedCheckout/1005': {
    status: 'Called – Recovered',
    notes: 'Paid via UPI link.',
    updatedAt: hoursAgo(100),
  },
};

export const readMockStatusMap = async () => structuredClone(store);
export const writeMockStatusMap = async (map) => { store = structuredClone(map); return store; };
