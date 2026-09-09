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
    address: n.address, gokwik_email_sent: n.gokwikEmailSent,
    gokwik_message_queued: n.gokwikMessageQueued, brand_order_count: n.brandOrderCount,
    raw_payload: payload, status, notes,
    callback_at: null, reason_tags: [], updated_by: status === 'Not called' ? null : 'Asha',
    recovered_order_id: null, recovered_order_name: null, recovered_at: null,
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
  message_enqueued: true, brand_order_count: 2,
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
  message_enqueued: true, abc_email_sent: true,
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
    address: n.address, gokwik_email_sent: n.gokwikEmailSent,
    gokwik_message_queued: n.gokwikMessageQueued, brand_order_count: n.brandOrderCount,
    raw_payload: raw, status: 'Not called', notes: '', status_updated_at: null,
    callback_at: null, reason_tags: [], updated_by: null,
    recovered_order_id: null, recovered_order_name: null, recovered_at: null,
    received_at: new Date().toISOString(),
  };
  rows.unshift(row);
  return { id: row.id, duplicate: false };
}

export async function mockListCarts({ sinceDays = 7, limit = 5000 } = {}) {
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;
  const all = [...rows]
    .filter((r) => new Date(r.received_at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  return { carts: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export async function mockSearchCarts(query, limit = 50) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return { carts: [], total: 0, truncated: false };
  const digits = q.replace(/\D/g, '');
  const hits = rows.filter((r) => {
    const text = [r.customer_name, r.email, r.cart_id].filter(Boolean).join(' ').toLowerCase();
    if (text.includes(q)) return true;
    return digits !== '' && String(r.phone ?? '').replace(/\D/g, '').includes(digits);
  }).sort((a, b) => new Date(b.received_at) - new Date(a.received_at)).slice(0, limit);
  return { carts: hits, total: hits.length, truncated: hits.length === limit };
}

export async function mockUpdateStatus(id, {
  status, notes, callbackAt, reasonTags, updatedBy, assignedTo,
}) {
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return null;
  if (status !== undefined && status !== null) row.status = status;
  if (notes !== undefined && notes !== null) row.notes = notes;
  if (callbackAt !== undefined) row.callback_at = callbackAt;
  if (reasonTags !== undefined && reasonTags !== null) row.reason_tags = reasonTags;
  if (updatedBy) row.updated_by = updatedBy;
  if (assignedTo !== undefined) row.assigned_to = assignedTo;
  row.status_updated_at = new Date().toISOString();
  return {
    id: row.id, status: row.status, notes: row.notes, callback_at: row.callback_at,
    reason_tags: row.reason_tags, updated_by: row.updated_by,
    assigned_to: row.assigned_to ?? null, assigned_to_name: row.assigned_to ?? null,
    status_updated_at: row.status_updated_at,
  };
}

const AUTO_UPGRADABLE = ['Not called', 'Called – No answer', 'Callback scheduled', 'Auto-nudged'];
const last10 = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };

export async function mockMatchOrder({ phone, email, orderId, orderName, updatedBy }) {
  const p = last10(phone);
  const mail = email ? String(email).toLowerCase() : null;
  const hits = rows.filter((r) => AUTO_UPGRADABLE.includes(r.status) && (
    (p && last10(r.phone) === p) || (mail && String(r.email || '').toLowerCase() === mail)
  ));
  for (const r of hits) {
    r.status = 'Called – Recovered';
    r.updated_by = updatedBy || 'Auto (GoKwik order match)';
    r.recovered_order_id = orderId ?? null;
    r.recovered_order_name = orderName ?? null;
    r.recovered_at = new Date().toISOString();
    r.status_updated_at = r.recovered_at;
  }
  return hits.map((r) => ({
    id: r.id, cart_id: r.cart_id,
    matched_on: p && last10(r.phone) === p ? 'phone' : 'email',
  }));
}

const withinWindow = (r, days) =>
  days <= 0 || new Date(r.received_at).getTime() > Date.now() - days * 86400000;

export async function mockReasonSummary(days = 7) {
  const counts = new Map();
  let tagged = 0;
  for (const r of rows.filter((x) => withinWindow(x, days))) {
    const tags = r.reason_tags || [];
    if (tags.length) tagged += 1;
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return {
    reasons: [...counts.entries()].map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    taggedCarts: tagged,
  };
}

export async function mockStatsByCaller(days = 7) {
  const by = new Map();
  for (const r of rows.filter((x) => withinWindow(x, days) && x.updated_by)) {
    const e = by.get(r.updated_by) || { caller: r.updated_by, touched: 0, recovered: 0, recovered_value: 0 };
    e.touched += 1;
    if (r.status === 'Called – Recovered') {
      e.recovered += 1;
      e.recovered_value += Number(r.total_price || 0);
    }
    by.set(r.updated_by, e);
  }
  return [...by.values()]
    .map((e) => ({ ...e, recovery_rate: e.touched ? Math.round((e.recovered / e.touched) * 100) : 0 }))
    .sort((a, b) => b.touched - a.touched);
}

export async function mockStaleCarts(hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const stale = rows.filter((r) => r.status === 'Not called' && new Date(r.received_at).getTime() < cutoff);
  return {
    count: stale.length,
    oldest: stale.length ? stale.map((r) => r.received_at).sort()[0] : null,
    value: stale.reduce((s, r) => s + Number(r.total_price || 0), 0),
  };
}
