/**
 * In-memory stand-in for Postgres, active when DATABASE_URL is unset, so the
 * board, the login flow and the webhook are all usable before Neon is set up.
 * Resets on restart.
 */
import { normalizePayload } from './normalize.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

let nextId = 1;
const rows = [];

function seed(payload, status = 'Not called', notes = '', ago = 1) {
  const n = normalizePayload(payload);
  rows.push({
    id: nextId++, cart_id: n.cartId, customer_name: n.customerName, phone: n.phone,
    email: n.email, total_price: n.totalPrice, currency: n.currency,
    checkout_url: n.checkoutUrl, item_count: n.itemCount, abandoned_at: n.abandonedAt,
    mrp_total: n.mrpTotal, discount_total: n.discountTotal, drop_stage: n.dropStage,
    drop_reason: n.dropReason, risk_flag: n.riskFlag, utm_source: n.utmSource,
    address: n.address,
    raw_payload: payload, status, notes,
    status_updated_at: status === 'Not called' ? null : hoursAgo(ago),
    received_at: n.abandonedAt || hoursAgo(ago),
  });
}

// Shaped like GoKwik's documented abandoned-cart payload.
seed({
  ID: '768427136', 'Created At': hoursAgo(2), 'Customer Name': 'Prakash Nanda',
  'Phone Number': '9440502362', 'Email ID': 'ppraw@gmail.com',
  'Line items': '#BriyoMin B12 Capsules(BriyoMin B12 Capsules - Pack of 1)*1',
  'Abandoned Cart Link': 'https://www.briyosupplements.com?mrid=0e64af15',
  Amount: '215.00', 'MRP Total': '275.00', 'Drop Stage': 'Login OTP Page',
  'Utm Source': 'facebook', Platform: 'Shopify',
});
seed({
  request_id: 'GK-1002', created_at: hoursAgo(9),
  customer: { first_name: 'Ravi', last_name: 'Kulkarni', phone: '+91 98200 11223', email: 'ravi.k@example.com' },
  totals: { total: 1029 }, currency: 'INR',
  'Line items': '#All Around Gut Guardian (Box) - Probiotics, Prebiotics &amp; Enzymes for Gut Health(All Around Gut Guardian (Box) - Probiotics, Prebiotics &amp; Enzymes for Gut Health - Pack of 3)*1',
  'Drop Stage': 'Payment Page', 'Risk Flag': 'Medium Risk', 'Utm Source': 'facebook',
  abc_url: 'https://www.briyosupplements.com?mrid=ec5b7528',
}, 'Called – No answer', 'Rang twice, no pickup. Try evening.', 4);
seed({
  request_id: 'GK-1003', created_at: hoursAgo(30),
  customer: { first_name: 'Meera', last_name: 'Nair', phone: '9004567890', email: 'meera.nair@example.com' },
  'Drop Stage': 'Pincode Addition Page', 'Risk Flag': 'Low Risk',
  totals: { total: 4780 }, currency: 'INR', item_count: 3,
  items: [{ name: 'Mass Gainer 3kg', quantity: 1 }, { name: 'Multivitamin 60 tabs', quantity: 2 }],
  abc_url: 'https://www.briyosupplements.com/checkout/gk1003',
});
seed({
  request_id: 'GK-1004', created_at: hoursAgo(74),
  customer: { email: 'guest-checkout@example.com' },
  totals: { total: 899 }, currency: 'INR', item_count: 1,
  items: [{ name: 'BCAA 200g', quantity: 1 }],
  abc_url: 'https://www.briyosupplements.com/checkout/gk1004',
});
seed({
  request_id: 'GK-1005', created_at: hoursAgo(150),
  customer: { first_name: 'Sandeep', last_name: 'Iyer', phone: '9876501234', email: 'sandeep@example.com' },
  'Drop Stage': 'Payment Page', 'Risk Flag': 'High Risk',
  totals: { total: 6250 }, currency: 'INR', item_count: 3,
  items: [{ name: 'Whey Isolate 2kg', quantity: 1 }, { name: 'Omega-3 90 caps', quantity: 1 }, { name: 'Pre-Workout 300g', quantity: 1 }],
  abc_url: 'https://www.briyosupplements.com/checkout/gk1005',
}, 'Called – Recovered', 'Paid via UPI link.', 100);

export async function mockInsertCart(n, raw) {
  const existing = n.cartId && rows.find((r) => r.cart_id === n.cartId);
  if (existing) {
    Object.assign(existing, {
      customer_name: n.customerName ?? existing.customer_name,
      phone: n.phone ?? existing.phone,
      email: n.email ?? existing.email,
      total_price: n.totalPrice ?? existing.total_price,
      checkout_url: n.checkoutUrl ?? existing.checkout_url,
      item_count: n.itemCount ?? existing.item_count,
      raw_payload: raw,
    });
    return { id: existing.id, duplicate: true };
  }
  const row = {
    id: nextId++, cart_id: n.cartId, customer_name: n.customerName, phone: n.phone,
    email: n.email, total_price: n.totalPrice, currency: n.currency,
    checkout_url: n.checkoutUrl, item_count: n.itemCount, abandoned_at: n.abandonedAt,
    mrp_total: n.mrpTotal, discount_total: n.discountTotal, drop_stage: n.dropStage,
    drop_reason: n.dropReason, risk_flag: n.riskFlag, utm_source: n.utmSource,
    address: n.address,
    raw_payload: raw, status: 'Not called', notes: '', status_updated_at: null,
    received_at: new Date().toISOString(),
  };
  rows.unshift(row);
  return { id: row.id, duplicate: false };
}

export async function mockListCarts() {
  return [...rows].sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
}

export async function mockUpdateStatus(id, { status, notes }) {
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return null;
  if (status !== undefined && status !== null) row.status = status;
  if (notes !== undefined && notes !== null) row.notes = notes;
  row.status_updated_at = new Date().toISOString();
  return { id: row.id, status: row.status, notes: row.notes, status_updated_at: row.status_updated_at };
}
