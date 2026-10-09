/**
 * Recovery verification — do carts marked Recovered on the call board line up with real Shopify orders, and what
 * were those orders worth? Read-only over existing data: abandoned_carts (+ cart_events for when a cart was marked
 * Recovered and by whom), the Shopify orders the existing sync imported (orders, channel 'website') and Shopify's own
 * financial record of them (order_financial_latest). It never calls Shopify, never changes a cart's status and never
 * touches orders, stock or attribution. The only thing it stores is a person's decision on a proposed match.
 *
 * Matching is recomputed on every request from the local database (deterministic; nothing to drift or double count):
 *   1. A shared identifier: the order the GoKwik order-completed event recorded on the cart (recovered_order_id /
 *      recovered_order_name) equals a Shopify order's id or name.
 *   2. Same phone (normalised: India +91 / leading 0 → the 10-digit mobile) + an order in the window + product overlap
 *      (same SKU, or — carts carry no SKUs — the same product name, exactly, once normalised).
 *   3. Same phone + an order in the window, when either side has no product information.
 *   The window runs from the cart's creation to the time it was marked Recovered + windowHours (default 48). With no
 *   recorded "marked Recovered" time, the window ends at the cart's creation + windowHours and the result can be a
 *   POSSIBLE MATCH at most. A name is never a match on its own; "the latest order" is never assumed.
 *   An order claimed by more than one recovered cart is NEEDS REVIEW for all of them (never silently given to one);
 *   several plausible orders for one cart are NEEDS REVIEW unless exactly one shares a product.
 *
 * Statuses: verified_paid, verified_placed, possible, no_match, cancelled_refunded, needs_review — kept apart from the
 * cart's own status (Recovered/Lost…) and from the payment status (paid/pending/…).
 */
import { getPool } from './db.js';
import { ensureOrdersSchema } from './orders.js';
import { ensureOrderFinancialSnapshotSchema } from './order-financial-snapshots.js';
import { normalizePayload } from './normalize.js';

export const RECOVERED_STATUS = 'Called – Recovered';
export const DEFAULT_WINDOW_HOURS = () => {
  const n = Number(process.env.RECOVERY_MATCH_WINDOW_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 720 ? n : 48;
};
export const STATUS_LABELS = {
  verified_paid: 'Verified — paid', verified_placed: 'Verified — order placed', possible: 'Possible match',
  no_match: 'No matching order', cancelled_refunded: 'Cancelled / refunded', needs_review: 'Needs review',
};
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/* ------------------------------------------------------------------ schema */

let schema = null;
/** Decisions on proposed matches (append-only but for reverting), and an index for phone lookups on orders. */
export function ensureRecoverySchema() {
  if (!schema) {
    schema = (async () => {
      await ensureOrdersSchema();
      await ensureOrderFinancialSnapshotSchema();
      const sql = getPool();
      await sql.query(`
        CREATE TABLE IF NOT EXISTS recovery_match_decisions (
          id           BIGSERIAL PRIMARY KEY,
          cart_id      BIGINT NOT NULL REFERENCES abandoned_carts(id) ON DELETE RESTRICT,
          order_id     BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
          decision     TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
          auto_result  JSONB NOT NULL,
          note         TEXT,
          decided_by   TEXT,
          decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          reverted_at  TIMESTAMPTZ,
          reverted_by  TEXT
        )`);
      // One live decision per cart/order pair; an order confirmed for at most one cart; a cart confirmed to one order.
      await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS recovery_decisions_pair_key ON recovery_match_decisions (cart_id, order_id) WHERE reverted_at IS NULL`);
      await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS recovery_decisions_order_key ON recovery_match_decisions (order_id) WHERE reverted_at IS NULL AND decision = 'confirmed'`);
      await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS recovery_decisions_cart_key ON recovery_match_decisions (cart_id) WHERE reverted_at IS NULL AND decision = 'confirmed'`);
      // Audit: never deleted (except the test suite's purge); only the revert fields may be set, once.
      await sql.query(`
        CREATE OR REPLACE FUNCTION recovery_decisions_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.purge_recovery', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'recovery_match_decisions is append-only';
          END IF;
          IF OLD.reverted_at IS NOT NULL OR NEW.reverted_at IS NULL
             OR (NEW.cart_id, NEW.order_id, NEW.decision, NEW.auto_result, NEW.note, NEW.decided_by, NEW.decided_at)
                IS DISTINCT FROM (OLD.cart_id, OLD.order_id, OLD.decision, OLD.auto_result, OLD.note, OLD.decided_by, OLD.decided_at) THEN
            RAISE EXCEPTION 'a recovery decision can only be reverted, once';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await sql.query('DROP TRIGGER IF EXISTS recovery_decisions_guard ON recovery_match_decisions');
      await sql.query(`CREATE TRIGGER recovery_decisions_guard BEFORE UPDATE OR DELETE ON recovery_match_decisions
                       FOR EACH ROW EXECUTE FUNCTION recovery_decisions_guard()`);
      // The phone index on orders: created once, only when missing — a plain existence check first, so later starts
      // never take a lock on orders for it — and a second process creating it at the same moment is not an error.
      const { rows: idx } = await sql.query(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'orders_website_phone10_idx'`);
      if (!idx.length) {
        await sql.query(`CREATE INDEX IF NOT EXISTS orders_website_phone10_idx ON orders (right(regexp_replace(coalesce(customer_phone, ''), '\\D', '', 'g'), 10))
                         WHERE channel = 'website'`).catch((err) => { if (!['42P07', '23505'].includes(err.code)) throw err; });
      }
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

/* ------------------------------------------------------------------ pure helpers (tested directly) */

/** An Indian mobile as its 10 digits: "+91 98765 43210", "919876543210", "09876543210" → "9876543210"; else null. */
export function phone10(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
/** A product name compared exactly once normalised: lower case, variant in brackets dropped, punctuation folded. */
export const productKey = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Payment, from Shopify's current financial record only; an order without one is "unknown", never paid. */
export function paymentOf(o) {
  if (!o.financial_status && !o.cancelled_at) return o.order_status === 'cancelled' ? 'cancelled' : 'unknown';
  if (o.cancelled_at || o.order_status === 'cancelled' || o.financial_status === 'VOIDED') return 'cancelled';
  if (o.financial_status === 'REFUNDED') return 'refunded';
  if (['PAID', 'PARTIALLY_REFUNDED'].includes(o.financial_status)) return 'paid';
  return 'pending';                                     // PENDING, AUTHORIZED, PARTIALLY_PAID, EXPIRED, …
}
const verifiedStatus = (payment) => (payment === 'paid' ? 'verified_paid' : ['cancelled', 'refunded'].includes(payment) ? 'cancelled_refunded' : 'verified_placed');

/**
 * The matching itself — pure and deterministic. `carts` and `orders` are plain rows (see loadData); `decisions` the
 * live manual decisions. Returns one result per cart.
 */
export function matchRecoveries(carts, orders, decisions = [], { windowHours = 48 } = {}) {
  const H = windowHours * 3600000;
  const byPhone = new Map();
  for (const o of orders) {
    const p = phone10(o.customer_phone);
    if (!p) continue;
    if (!byPhone.has(p)) byPhone.set(p, []);
    byPhone.get(p).push(o);
  }
  const byId = new Map(orders.map((o) => [String(o.id), o]));
  const confirmed = new Map(decisions.filter((d) => d.decision === 'confirmed').map((d) => [String(d.cart_id), d]));
  const confirmedOrders = new Set(decisions.filter((d) => d.decision === 'confirmed').map((d) => String(d.order_id)));
  const rejected = new Set(decisions.filter((d) => d.decision === 'rejected').map((d) => `${d.cart_id}|${d.order_id}`));

  // Pass 1: each cart's own candidates and its proposed order.
  const prelim = carts.map((c) => {
    const recoveredAt = c.marked_at || c.recovered_at || null;
    const createdAt = c.abandoned_at || c.received_at;
    const start = new Date(createdAt).getTime();
    const end = (recoveredAt ? new Date(recoveredAt).getTime() : start) + H;
    const items = (c.items || []).filter((i) => i && (i.sku || i.title));
    const cartSkus = new Set(items.map((i) => String(i.sku || '').trim().toLowerCase()).filter(Boolean));
    const cartNames = new Set(items.map((i) => productKey(i.title)).filter(Boolean));
    const p = phone10(c.phone);
    const base = { cart: c, recoveredAt, lowConfidence: !recoveredAt, window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() } };

    // A person's confirmation stands (and is never re-decided automatically).
    const conf = confirmed.get(String(c.id));
    if (conf && byId.get(String(conf.order_id))) return { ...base, tier: 'manual', order: byId.get(String(conf.order_id)), candidates: [], decision: conf };

    // 1. Shared identifier recorded on the cart by the GoKwik order-completed event.
    const ids = [c.recovered_order_id, c.recovered_order_name].filter(Boolean).map((v) => String(v).replace(/^#/, ''));
    if (ids.length) {
      const all = orders.filter((o) => ids.includes(String(o.legacy_id || '')) || ids.includes(String(o.shopify_name || '').replace(/^#/, '')));
      // An order a person confirmed for another cart is never also this cart's (each order belongs to one cart).
      const exact = all.filter((o) => !confirmedOrders.has(String(o.id)) && !rejected.has(`${c.id}|${o.id}`));
      if (all.length && !exact.length) return { ...base, tier: 'identifier', order: null, candidates: [], ambiguous: 'the order recorded on this cart was confirmed for another cart, or rejected for this one' };
      if (exact.length === 1) return { ...base, tier: 'identifier', order: exact[0], candidates: [{ order: exact[0], reasons: ['order recorded on the cart by GoKwik'], conflicts: [] }] };
      if (exact.length > 1) return { ...base, tier: 'identifier', order: null, candidates: exact.map((o) => ({ order: o, reasons: ['order recorded on the cart'], conflicts: ['several orders share it'] })), ambiguous: 'the identifier on the cart matches more than one order' };
    }
    if (!p) return { ...base, tier: null, order: null, candidates: [], reason: c.phone ? 'the cart\'s phone is not a valid Indian mobile, so no order can be matched' : 'the cart has no phone' };

    const cands = (byPhone.get(p) || [])
      .filter((o) => !rejected.has(`${c.id}|${o.id}`) && !confirmedOrders.has(String(o.id)))
      .filter((o) => { const t = new Date(o.order_date || o.created_at).getTime(); return t >= start && t <= end; })
      .map((o) => {
        const skus = new Set((o.lines || []).map((l) => String(l.sku || '').trim().toLowerCase()).filter(Boolean));
        const names = new Set((o.lines || []).map((l) => productKey(l.title)).filter(Boolean));
        const skuHit = [...cartSkus].some((s) => skus.has(s));
        const nameHit = [...cartNames].some((n) => names.has(n));
        const productData = (cartSkus.size || cartNames.size) && (skus.size || names.size);
        const reasons = ['same phone', `ordered ${recoveredAt ? 'within the window after the cart' : 'within the window after the cart (no recorded recovery time)'}`];
        const conflicts = [];
        if (skuHit) reasons.push('same SKU'); else if (nameHit) reasons.push('same product');
        else if (productData) conflicts.push('no product in common');
        else reasons.push('no product details to compare');
        if (o.customer_name && c.customer_name && productKey(o.customer_name) !== productKey(c.customer_name)) conflicts.push('different customer name');
        return { order: o, reasons, conflicts, overlap: skuHit || nameHit, productData: Boolean(productData) };
      })
      .sort((a, b) => new Date(a.order.order_date) - new Date(b.order.order_date) || Number(a.order.id) - Number(b.order.id));

    if (!cands.length) return { ...base, tier: null, order: null, candidates: [], reason: `no Shopify order from this phone between ${base.window.from} and ${base.window.to}` };
    if (cands.length > 1) {
      const withOverlap = cands.filter((x) => x.overlap);
      if (withOverlap.length === 1) return { ...base, tier: 'phone+product', order: withOverlap[0].order, candidates: cands };
      return { ...base, tier: null, order: null, candidates: cands, ambiguous: `${cands.length} orders from this phone in the window${withOverlap.length ? ` (${withOverlap.length} share a product)` : ''}` };
    }
    const only = cands[0];
    if (only.overlap) return { ...base, tier: 'phone+product', order: only.order, candidates: cands };
    if (!only.productData) return { ...base, tier: 'phone+time', order: only.order, candidates: cands };
    return { ...base, tier: 'phone+time', order: only.order, candidates: cands, weak: 'the order has none of the cart\'s products' };
  });

  // Pass 2: an order proposed for more than one cart is never given to one of them silently.
  const claims = new Map();
  for (const r of prelim) if (r.order && r.tier !== 'manual') claims.set(String(r.order.id), (claims.get(String(r.order.id)) || 0) + 1);

  return prelim.map((r) => {
    const out = { ...r, matchedOrder: null };
    const paymentFor = (o) => paymentOf(o);
    if (r.tier === 'manual') {
      // A confirmation says which order belongs to the cart; it is not evidence that the call caused the purchase.
      out.status = verifiedStatus(paymentFor(r.order)); out.matchedOrder = r.order; out.reason = 'match confirmed by a person'; out.confidence = 'confirmed';
    } else if (r.ambiguous) {
      out.status = 'needs_review'; out.reason = r.ambiguous; out.confidence = 'ambiguous';
    } else if (!r.order) {
      out.status = 'no_match'; out.reason = r.reason; out.confidence = null;
    } else if (claims.get(String(r.order.id)) > 1) {
      out.status = 'needs_review'; out.reason = `order ${r.order.shopify_name || r.order.id} is the likely match for ${claims.get(String(r.order.id))} recovered carts`; out.confidence = 'ambiguous';
    } else if (r.lowConfidence || r.weak) {
      out.status = 'possible'; out.reason = r.weak || 'no recorded time the cart was marked Recovered, so the timing cannot be confirmed'; out.confidence = 'low';
    } else {
      out.status = verifiedStatus(paymentFor(r.order)); out.matchedOrder = r.order;
      out.reason = r.tier === 'identifier' ? 'order recorded on the cart' : r.tier === 'phone+product' ? 'same phone, ordered in the window, same product' : 'same phone, ordered in the window (no product details to compare)';
      out.confidence = r.tier === 'identifier' ? 'high' : r.tier === 'phone+product' ? 'high' : 'medium';
    }
    out.payment = out.matchedOrder ? paymentFor(out.matchedOrder) : null;
    return out;
  });
}

/**
 * The summary over results: each Shopify order counted once; revenue only from confidently matched orders whose
 * current Shopify record says paid, summed per currency (never mixed), at Shopify's current total.
 */
export function summarise(results) {
  // Only confident matches carry matchedOrder (automatic: identifier, phone+product, phone+time; or confirmed by a
  // person). Possible and needs-review results never do, so they never reach a total. Keyed by order: once each.
  const verified = new Map(); const paid = new Map(); const pending = new Set(); const confirmedIds = new Set();
  for (const r of results) {
    if (!r.matchedOrder) continue;
    const id = String(r.matchedOrder.id);
    verified.set(id, r.matchedOrder);
    if (r.status === 'verified_paid') paid.set(id, r.matchedOrder);
    if (r.status === 'verified_placed') pending.add(id);
    if (r.tier === 'manual') confirmedIds.add(id);
  }
  const revenue = {}; const paidCount = {}; const unknownValue = [];
  for (const o of paid.values()) {
    const cur = o.shop_currency || o.currency;
    if (o.current_total_price === null || o.current_total_price === undefined) { unknownValue.push(o.id); continue; }
    revenue[cur] = Math.round(((revenue[cur] || 0) + Number(o.current_total_price)) * 100) / 100;
    paidCount[cur] = (paidCount[cur] || 0) + 1;
  }
  const recovered = results.length;
  return {
    recovered, verifiedOrders: verified.size, paidOrders: paid.size, pendingOrders: pending.size,
    unmatched: results.filter((r) => r.status === 'no_match').length,
    ambiguous: results.filter((r) => r.status === 'needs_review' || r.status === 'possible').length,
    cancelledRefunded: results.filter((r) => r.status === 'cancelled_refunded').length,
    withoutRecoveryTime: results.filter((r) => !r.recoveredAt).length,
    revenue: Object.entries(revenue).map(([currency, amount]) => ({
      currency, amount, paidOrders: paidCount[currency],
      averagePaidOrder: Math.round((amount / paidCount[currency]) * 100) / 100,
      perRecoveredCart: recovered ? Math.round((amount / recovered) * 100) / 100 : null,
    })),
    paidWithoutValue: unknownValue.length,
    // How the counted orders were matched: by the rules, or confirmed by a person.
    basis: {
      verifiedAutomatic: [...verified.keys()].filter((id) => !confirmedIds.has(id)).length, verifiedConfirmed: [...verified.keys()].filter((id) => confirmedIds.has(id)).length,
      paidAutomatic: [...paid.keys()].filter((id) => !confirmedIds.has(id)).length, paidConfirmed: [...paid.keys()].filter((id) => confirmedIds.has(id)).length,
    },
  };
}

/* ------------------------------------------------------------------ data */

async function loadData(db = getPool()) {
  const { rows: carts } = await db.query(
    `SELECT c.id, c.cart_id, c.customer_name, c.phone, c.total_price, c.currency, c.abandoned_at, c.received_at, c.status_updated_at,
            c.assigned_to, c.recovered_order_id, c.recovered_order_name, c.recovered_at, c.updated_by, c.raw_payload,
            ev.at AS marked_at, ev.actor AS marked_by
     FROM abandoned_carts c
     LEFT JOIN LATERAL (SELECT e.at, e.actor FROM cart_events e WHERE e.cart_id = c.id AND e.kind = 'status' AND e.to_status = $1
                        ORDER BY e.at DESC, e.id DESC LIMIT 1) ev ON true
     WHERE c.status = $1 ORDER BY coalesce(ev.at, c.recovered_at, c.received_at) DESC, c.id DESC`, [RECOVERED_STATUS]);
  for (const c of carts) {
    let items = [];
    try {
      items = (normalizePayload(c.raw_payload || {}).items || []).map((i) => ({ title: i.title, quantity: i.quantity, sku: null }));
      // The cart parser keeps names and quantities only; a SKU, when the payload's line items carry one, is read
      // from the same list (same order), so a SKU match is possible without touching cart ingest.
      const raw = c.raw_payload || {};
      const list = ['line_items', 'items', 'products', 'cart_items'].map((k) => raw[k]).find(Array.isArray) || [];
      if (list.length === items.length) items.forEach((it, k) => { const sku = String(list[k]?.sku ?? '').trim(); if (sku) it.sku = sku.slice(0, 120); });
    } catch { items = []; }
    c.items = items;
    c.method = c.recovered_order_id || c.recovered_order_name ? 'GoKwik order event' : c.marked_by ? 'Marked on the call board' : null;
    delete c.raw_payload;
  }
  const phones = [...new Set(carts.map((c) => phone10(c.phone)).filter(Boolean))];
  const ids = [...new Set(carts.flatMap((c) => [c.recovered_order_id, c.recovered_order_name]).filter(Boolean).map((v) => String(v).replace(/^#/, '')))];
  const { rows: orders } = phones.length || ids.length ? await db.query(
    `SELECT o.id, o.source_order_id, o.order_date, o.created_at, o.customer_name, o.customer_phone, o.order_value, o.currency, o.order_status,
            o.source_payload->'shopify'->>'name' AS shopify_name, o.source_payload->'shopify'->>'legacy_id' AS legacy_id,
            f.financial_status, f.cancelled_at, f.current_total_price, f.total_refunded, f.shop_currency,
            coalesce((SELECT json_agg(json_build_object('sku', i.sku, 'title', i.title, 'quantity', i.quantity) ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id), '[]') AS lines
     FROM orders o LEFT JOIN order_financial_latest f ON f.order_id = o.id
     WHERE o.channel = 'website' AND (right(regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g'), 10) = ANY($1)
       OR o.source_payload->'shopify'->>'legacy_id' = ANY($2) OR ltrim(o.source_payload->'shopify'->>'name', '#') = ANY($2))`, [phones, ids]) : { rows: [] };
  for (const o of orders) {
    o.current_total_price = o.current_total_price === null ? null : Number(o.current_total_price);
    o.total_refunded = o.total_refunded === null ? null : Number(o.total_refunded);
    o.order_value = o.order_value === null ? null : Number(o.order_value);
  }
  const { rows: decisions } = await db.query(
    'SELECT id, cart_id, order_id, decision, auto_result, note, decided_by, decided_at FROM recovery_match_decisions WHERE reverted_at IS NULL ORDER BY id');
  return { carts, orders, decisions };
}

const orderView = (o) => (o ? {
  id: Number(o.id), name: o.shopify_name, date: o.order_date, value: o.current_total_price, currency: o.shop_currency || o.currency,
  payment: paymentOf(o), financialStatus: o.financial_status || null, refunded: o.total_refunded, cancelled: Boolean(o.cancelled_at || o.order_status === 'cancelled'),
  products: (o.lines || []).map((l) => ({ title: l.title, sku: l.sku, quantity: l.quantity })),
} : null);
const resultView = (r) => ({
  cartId: Number(r.cart.id), cartRef: r.cart.cart_id, customerName: r.cart.customer_name, phone: r.cart.phone,
  cartCreatedAt: r.cart.abandoned_at || r.cart.received_at, cartUpdatedAt: r.cart.status_updated_at,
  recoveredAt: r.recoveredAt, recoveryTimeRecorded: Boolean(r.recoveredAt), agent: r.cart.marked_by || r.cart.assigned_to || null,
  assignedTo: r.cart.assigned_to, products: r.cart.items, cartValue: r.cart.total_price === null ? null : Number(r.cart.total_price), cartCurrency: r.cart.currency,
  method: r.cart.method, status: r.status, statusLabel: STATUS_LABELS[r.status], reason: r.reason, confidence: r.confidence, tier: r.tier,
  order: orderView(r.matchedOrder), payment: r.payment, window: r.window,
  candidates: (r.candidates || []).map((x) => ({ order: orderView(x.order), reasons: x.reasons, conflicts: x.conflicts })),
  decision: r.decision ? { id: Number(r.decision.id), by: r.decision.decided_by, at: r.decision.decided_at, note: r.decision.note } : null,
});

/** Everything, matched; then filtered to the period (by the recovery time) and agent for display and the summary. */
export async function recoveryReport({ from, to, agent, windowHours } = {}) {
  await ensureRecoverySchema();
  const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) >= 1 && Number(windowHours) <= 720 ? Number(windowHours) : DEFAULT_WINDOW_HOURS();
  const { carts, orders, decisions } = await loadData();
  const all = matchRecoveries(carts, orders, decisions, { windowHours: hours });
  const fromT = from ? new Date(`${from}T00:00:00+05:30`).getTime() : null;
  const toT = to ? new Date(`${to}T23:59:59.999+05:30`).getTime() : null;
  let excludedNoTime = 0;
  const shown = all.filter((r) => {
    if (agent && (r.cart.marked_by || r.cart.assigned_to) !== agent) return false;
    if (fromT === null && toT === null) return true;
    if (!r.recoveredAt) { excludedNoTime += 1; return false; }   // no recovery time: cannot be placed in a period
    const t = new Date(r.recoveredAt).getTime();
    return (fromT === null || t >= fromT) && (toT === null || t <= toT);
  });
  return {
    windowHours: hours, summary: { ...summarise(shown), excludedNoRecoveryTime: excludedNoTime },
    results: shown.map(resultView),
    agents: [...new Set(all.map((r) => r.cart.marked_by || r.cart.assigned_to).filter(Boolean))].sort(),
  };
}

/* ------------------------------------------------------------------ decisions */

/**
 * A person confirms or rejects a proposed order for a recovered cart. Only an order the matching currently offers
 * for that cart may be decided on; the automatic result at that moment is kept with the decision. An order can be
 * confirmed for one cart only, and a cart confirmed to one order (database-enforced).
 */
export async function decideMatch({ cartId, orderId, decision, note }, { actor }) {
  await ensureRecoverySchema();
  if (!['confirmed', 'rejected'].includes(decision)) throw bad('Choose confirm or reject.');
  const cid = Number(cartId); const oid = Number(orderId);
  if (!Number.isInteger(cid) || !Number.isInteger(oid)) throw bad('Choose the cart and the order.');
  const db = getPool();
  const { carts, orders, decisions } = await loadData(db);
  const results = matchRecoveries(carts, orders, decisions, { windowHours: DEFAULT_WINDOW_HOURS() });
  const r = results.find((x) => Number(x.cart.id) === cid);
  if (!r) throw bad('That cart is not marked Recovered.', 404);
  const offered = r.candidates.some((x) => Number(x.order.id) === oid) || (r.matchedOrder && Number(r.matchedOrder.id) === oid);
  if (!offered) throw bad('That order is not a proposed match for this cart.', 409);
  try {
    const { rows } = await db.query(
      `INSERT INTO recovery_match_decisions (cart_id, order_id, decision, auto_result, note, decided_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [cid, oid, decision, JSON.stringify({ status: r.status, reason: r.reason, tier: r.tier, confidence: r.confidence,
        order: r.matchedOrder ? Number(r.matchedOrder.id) : null, candidates: r.candidates.map((x) => Number(x.order.id)) }),
      String(note ?? '').trim().slice(0, 500) || null, actor]);
    return { id: Number(rows[0].id) };
  } catch (err) {
    if (err.code === '23505') throw bad(decision === 'confirmed' ? 'That order is already confirmed for a recovered cart, or this cart already has a confirmed order. Revert that decision first.' : 'This match has already been decided. Revert that decision first.', 409);
    throw err;
  }
}

/** Reverts a decision (kept, marked reverted by whom and when); the automatic matching then applies again. */
export async function revertDecision(id, { actor }) {
  await ensureRecoverySchema();
  const { rows } = await getPool().query(
    'UPDATE recovery_match_decisions SET reverted_at = now(), reverted_by = $2 WHERE id = $1 AND reverted_at IS NULL RETURNING id', [Number(id), actor]);
  if (!rows.length) throw bad('No such live decision.', 404);
  return { reverted: true };
}

/** The full decision history for a cart (reverted ones included), for the review panel. */
export async function decisionHistory(cartId) {
  await ensureRecoverySchema();
  const { rows } = await getPool().query(
    `SELECT d.id, d.order_id, o.source_payload->'shopify'->>'name' AS order_name, d.decision, d.auto_result, d.note, d.decided_by, d.decided_at, d.reverted_at, d.reverted_by
     FROM recovery_match_decisions d JOIN orders o ON o.id = d.order_id WHERE d.cart_id = $1 ORDER BY d.id`, [Number(cartId)]);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_id: Number(r.order_id) }));
}
