import { getPool } from './db.js';
import { rateAt, logAffiliateEvent, bad, tx } from './affiliates.js';

/**
 * Affiliate commissions — the ledger (Phase 2A). Tables: lib/affiliate-referrals.js
 * (created with the attribution tables they reference).
 *
 *   affiliate_commissions        one per attribution (UNIQUE attribution_id). Its rate, base and amount are
 *                                fixed when it is created — a later rate change or order edit never touches
 *                                it (database trigger). Only the status moves.
 *   affiliate_commission_events  every status, including the first, with actor, reason and time. Append-only.
 *
 * When: with the attribution, in the same transaction (attributeOrder). Never for a click alone.
 * Rate: the affiliate's rate in effect when the order was placed (affiliate_rates via rateAt), stored as
 *       rate_bps with the rate row it came from.
 * Base: "Shopify net subtotal excluding recorded tax" = current_subtotal − current_total_tax on the order's
 *       latest financial snapshot at that moment, in its shop currency, computed in SQL (NUMERIC, no floats).
 *       current_subtotal is after discounts and excludes shipping. Shopify's checkout data can book the GST on
 *       shipping onto product lines, so this is not a perfectly tax-exclusive merchandise value — no tax is
 *       estimated, no rate is assumed. Amount = round(base × rate_bps / 10000, 2).
 * Not created (and logged) when the affiliate has no rate for that time, the order has no financial record, or
 * the recorded tax exceeds the subtotal (a negative base) — never a guessed or ₹0 commission. backfillAffiliateCommissions() retries those and attributions made before this ledger.
 *
 * Statuses: pending → approved → paid; pending / approved / paid → reversed (needs a reason). A reversal keeps
 * the original row and amounts; nothing is deleted or recalculated. Payout batches are a later phase.
 */

export const COMMISSION_STATUSES = ['pending', 'approved', 'paid', 'reversed'];
export const COMMISSION_TRANSITIONS = {
  pending: ['approved', 'reversed'],
  approved: ['paid', 'reversed'],
  paid: ['reversed'],
  reversed: [],
};
/** Which capability moves a commission to a status: approving and reversing is commission work; paying is payout work. */
export const COMMISSION_STATUS_CAP = { approved: 'affiliate.commissions', reversed: 'affiliate.commissions', paid: 'affiliate.payouts' };

/**
 * Creates the commission for one attribution, in the caller's transaction. Idempotent: an attribution that
 * already has one returns it unchanged (UNIQUE attribution_id guards concurrent calls too).
 */
export async function createCommissionForAttribution(client, attributionId, { actor = null } = {}) {
  const { rows: [have] } = await client.query('SELECT id FROM affiliate_commissions WHERE attribution_id = $1', [attributionId]);
  if (have) return { created: false, id: Number(have.id), reason: 'exists' };
  const { rows: [t] } = await client.query(
    `SELECT t.id, t.affiliate_id, t.order_id, t.order_placed_at, o.source_payload->'shopify'->>'name' AS order_name
     FROM affiliate_order_attributions t JOIN orders o ON o.id = t.order_id WHERE t.id = $1`, [attributionId]);
  if (!t) throw bad('No such attribution.', 404);
  const skip = async (reason) => {
    await logAffiliateEvent(client, t.affiliate_id, 'commission_not_created', actor, { order: t.order_name, skipped: reason }, 'order', t.order_name);
    return { created: false, reason };
  };
  const rate = await rateAt(client, t.affiliate_id, t.order_placed_at);
  if (!rate) return skip('no_rate');
  const { rows: [snap] } = (await client.query(`SELECT to_regclass('order_financial_snapshots') AS t`)).rows[0].t
    ? await client.query(`SELECT id, shop_currency, (current_subtotal - current_total_tax)::text AS base FROM order_financial_snapshots WHERE order_id = $1 ORDER BY sequence DESC LIMIT 1`, [t.order_id])
    : { rows: [] };
  if (!snap) return skip('no_financial_snapshot');
  if (Number(snap.base) < 0) return skip('negative_base');
  const { rows: [c] } = await client.query(
    `INSERT INTO affiliate_commissions (affiliate_id, attribution_id, order_id, snapshot_id, currency, rate_id, rate_bps, base_amount, commission_amount, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::int, $8::numeric, round($8::numeric * $7::int / 10000, 2), $9, $9)
     ON CONFLICT (attribution_id) DO NOTHING
     RETURNING id, base_amount::text, commission_amount::text`,
    [t.affiliate_id, t.id, t.order_id, snap.id, snap.shop_currency, rate.id, rate.rate_bps, snap.base, actor]);
  if (!c) return { created: false, reason: 'exists' };
  await client.query(`INSERT INTO affiliate_commission_events (commission_id, from_status, to_status, actor, reason) VALUES ($1, NULL, 'pending', $2, 'created with the attribution')`, [c.id, actor]);
  await logAffiliateEvent(client, t.affiliate_id, 'commission_created', actor, {
    order: t.order_name, currency: snap.shop_currency, commission_rate_bps: rate.rate_bps, base_amount: c.base_amount, commission_amount: c.commission_amount,
  }, 'order', t.order_name);
  return { created: true, id: Number(c.id) };
}

/**
 * Creates commissions for attributions that have none (made before this ledger, or skipped for a missing rate
 * or financial record). Idempotent; never touches an existing commission. An explicit action, not run on start.
 */
export async function backfillAffiliateCommissions({ actor } = {}) {
  const { rows } = await getPool().query(
    'SELECT t.id FROM affiliate_order_attributions t WHERE NOT EXISTS (SELECT 1 FROM affiliate_commissions c WHERE c.attribution_id = t.id) ORDER BY t.id');
  const out = { checked: rows.length, created: 0, skipped: {} };
  for (const r of rows) {
    const res = await tx((client) => createCommissionForAttribution(client, r.id, { actor }));
    if (res.created) out.created += 1;
    else out.skipped[res.reason] = (out.skipped[res.reason] || 0) + 1;
  }
  return out;
}

/** Moves a commission's status along COMMISSION_TRANSITIONS, with a reason when reversing. Amounts never change. */
export async function setCommissionStatus(publicId, commissionId, { status, reason = '', actor, version } = {}) {
  const to = String(status || '');
  if (!COMMISSION_STATUSES.includes(to)) throw bad('Unknown commission status.', 400, { field: 'status' });
  const why = String(reason ?? '').trim();
  if (to === 'reversed' && !why) throw bad('Give a reason for reversing a commission.', 400, { field: 'reason' });
  if (why.length > 500) throw bad('Keep the reason under 500 characters.', 400, { field: 'reason' });
  return tx(async (client) => {
    const { rows: [c] } = await client.query(
      `SELECT c.*, a.public_id, o.source_payload->'shopify'->>'name' AS order_name FROM affiliate_commissions c
       JOIN affiliates a ON a.id = c.affiliate_id JOIN orders o ON o.id = c.order_id WHERE c.id = $1 FOR UPDATE OF c`, [commissionId]);
    if (!c || c.public_id !== String(publicId || '').toUpperCase()) throw bad('No such commission.', 404);
    if (version !== undefined && Number(version) !== c.version) throw bad('This commission was changed by someone else. Reload and try again.', 409, { conflict: true });
    if (!COMMISSION_TRANSITIONS[c.status].includes(to)) throw bad(`A ${c.status} commission cannot become ${to}.`, 409);
    await client.query(`UPDATE affiliate_commissions SET status = $2, status_reason = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE id = $1`,
      [c.id, to, why || null, actor]);
    await client.query('INSERT INTO affiliate_commission_events (commission_id, from_status, to_status, actor, reason) VALUES ($1, $2, $3, $4, $5)', [c.id, c.status, to, actor, why || null]);
    await logAffiliateEvent(client, c.affiliate_id, `commission_${to}`, actor, { order: c.order_name, from: c.status, to, reason: why || null, commission_amount: c.commission_amount, currency: c.currency }, 'order', c.order_name);
    return { id: Number(c.id), status: to, version: c.version + 1 };
  });
}

/**
 * The affiliate's performance: clicks, attributed orders and, with `money`, each order's current value
 * (latest financial snapshot) and its commission. Without `money` the money fields are absent, not zero.
 * Current order value and commission are different things: the commission's base and rate are fixed at
 * creation; the order's value is Shopify's latest.
 */
export async function getAffiliatePerformance(publicId, { money = false } = {}) {
  const db = getPool();
  const { rows: [a] } = await db.query('SELECT id FROM affiliates WHERE public_id = $1', [String(publicId || '').toUpperCase()]);
  if (!a) return null;
  const [{ rows: [clicks] }, { rows }] = await Promise.all([
    db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE clicked_at > now() - interval '30 days')::int AS last_30_days FROM affiliate_referral_clicks WHERE affiliate_id = $1`, [a.id]),
    db.query(`
      SELECT t.id AS attribution_id, t.attribution_method AS method, t.attributed_at, t.order_placed_at,
             o.source_payload->'shopify'->>'name' AS order_name, o.order_status,
             f.shop_currency AS currency, f.current_total_price::text AS order_value, f.cancelled_at IS NOT NULL AS shopify_cancelled,
             c.id AS commission_id, c.currency AS commission_currency, c.rate_bps, c.base_amount::text, c.commission_amount::text,
             c.status AS commission_status, c.status_reason, c.version AS commission_version, c.created_at AS commission_created_at
      FROM affiliate_order_attributions t JOIN orders o ON o.id = t.order_id
      LEFT JOIN order_financial_latest f ON f.order_id = t.order_id
      LEFT JOIN affiliate_commissions c ON c.attribution_id = t.id
      WHERE t.affiliate_id = $1 ORDER BY t.attributed_at DESC, t.id DESC`, [a.id]),
  ]);
  const orders = rows.map((r) => {
    const o = {
      order: r.order_name, method: r.method, attributed_at: r.attributed_at, order_placed_at: r.order_placed_at,
      cancelled: r.order_status === 'cancelled' || r.shopify_cancelled, has_financial_record: r.currency !== null, has_commission: r.commission_id !== null,
    };
    if (!money) return o;
    return {
      ...o,
      currency: r.currency, order_value: r.order_value === null ? null : Number(r.order_value),
      commission: r.commission_id === null ? null : {
        id: Number(r.commission_id), currency: r.commission_currency, rate_bps: r.rate_bps, base_amount: Number(r.base_amount),
        amount: Number(r.commission_amount), status: r.commission_status, reason: r.status_reason, version: r.commission_version, created_at: r.commission_created_at,
      },
    };
  });
  const out = { clicks, attributions: { total: rows.length, cancelled: orders.filter((o) => o.cancelled).length }, orders };
  if (!money) return out;
  // Totals per currency, in paise: order value of non-cancelled orders; commission earned = not reversed and the
  // order not cancelled. A commission on a cancelled order stays on record (to be reversed by finance staff) and is
  // reported apart as on_cancelled_orders — never silently dropped or counted as earned.
  const per = new Map();
  const cur = (k) => { if (!per.has(k)) per.set(k, { currency: k, order_value: 0, orders: 0, commission_earned: 0, on_cancelled_orders: 0, by_status: { pending: 0, approved: 0, paid: 0, reversed: 0 } }); return per.get(k); };
  const p = (v) => Math.round(v * 100);
  for (const o of orders) {
    if (o.currency && !o.cancelled) { const x = cur(o.currency); x.order_value += p(o.order_value); x.orders += 1; }
    if (o.commission) {
      const x = cur(o.commission.currency);
      x.by_status[o.commission.status] += p(o.commission.amount);
      if (o.commission.status !== 'reversed') {
        if (o.cancelled) x.on_cancelled_orders += p(o.commission.amount); else x.commission_earned += p(o.commission.amount);
      }
    }
  }
  out.totals = {
    by_currency: [...per.values()].sort((x, y) => x.currency.localeCompare(y.currency)).map((x) => ({
      ...x, order_value: x.order_value / 100, commission_earned: x.commission_earned / 100, on_cancelled_orders: x.on_cancelled_orders / 100,
      by_status: Object.fromEntries(Object.entries(x.by_status).map(([k, v]) => [k, v / 100])),
    })),
    orders_without_financial_record: orders.filter((o) => !o.has_financial_record && !o.cancelled).length,
    orders_without_commission: orders.filter((o) => !o.has_commission).length,
  };
  return out;
}
