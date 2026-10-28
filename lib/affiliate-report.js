import { getPool } from './db.js';
import { bad } from './affiliates.js';
import { ensureAffiliatePayoutSchema } from './affiliate-payouts.js';
import { APP_TIMEZONE, istDayKey } from './timezone.js';

/**
 * Affiliate programme report — the whole programme over a period of IST calendar days, from the same records the
 * per-affiliate performance view reads (lib/affiliate-commissions.js getAffiliatePerformance). Reads only.
 *
 *   Clicks       recorded referral clicks, by clicked_at.
 *   Orders       attributions, by the order's placed time (order_placed_at); split by method (link click / coupon /
 *                the legacy GoKwik rule). Cancelled orders (in Briyo or voided in Shopify) are counted apart and never in
 *                order value.
 *   Commissions  the commission of each order in the period (so commissions and orders line up), by status. As on
 *                the affiliate page: earned = not reversed and the order not cancelled; an unreversed commission on a
 *                cancelled order is reported apart (on_cancelled_orders), never as earned.
 *   Payouts      paid: payouts marked paid with a bank date (paid_on) in the period — gross, TDS, net. Waiting: every
 *                payout still pending at the bank now, whatever its date.
 *
 * Money is shown only to those allowed to see it: commissions to affiliate.commissions, payouts to affiliate.payouts
 * (admins hold both); without them the report has clicks and orders only. Amounts are INR (the shop currency):
 * anything recorded in another currency is counted, not added, and reported as other_currency_orders. Sums are done
 * in SQL NUMERIC; nothing uses floating point for money.
 */

export const MAX_REPORT_DAYS = 366;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = APP_TIMEZONE;
const START = (p) => `((${p}::date)::timestamp AT TIME ZONE '${TZ}')`;
const END = (p) => `(((${p}::date) + 1)::timestamp AT TIME ZONE '${TZ}')`;
const METHOD_KEY = { referral_click: 'link', coupon: 'coupon', gokwik_full_url: 'gokwik' };

/** The period: IST day keys, inclusive; the last 30 days (today included) when not given. */
export function reportPeriod({ from, to } = {}, now = new Date()) {
  const today = istDayKey(now);
  const end = to ? String(to) : today;
  const start = from ? String(from) : istDayKey(new Date(now.getTime() - 29 * 86400000));
  for (const [v, label] of [[start, 'From'], [end, 'To']]) {
    if (!DAY.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) throw bad(`${label} must be a date (YYYY-MM-DD).`, 400, { field: label.toLowerCase() });
  }
  if (start > end) throw bad('From must be on or before To.', 400, { field: 'from' });
  const days = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_REPORT_DAYS) throw bad(`A report covers at most ${MAX_REPORT_DAYS} days.`, 400, { field: 'from' });
  return { from: start, to: end, days };
}

const money2 = (v) => (v === null || v === undefined ? 0 : Number(v));

export async function affiliateProgrammeReport(period, { commissions = false, payouts = false } = {}) {
  await ensureAffiliatePayoutSchema();
  const db = getPool();
  const p = [period.from, period.to];
  // One query after another on the pool is fine; these are independent reads.
  const [aff, clicks, orders, series, paid, waiting] = await Promise.all([
    db.query(`SELECT a.id, a.public_id, a.display_name, a.category, a.status FROM affiliates a`),
    db.query(`SELECT affiliate_id, count(*)::int AS n FROM affiliate_referral_clicks
              WHERE clicked_at >= ${START('$1')} AND clicked_at < ${END('$2')} GROUP BY affiliate_id`, p),
    db.query(`
      SELECT t.affiliate_id, t.attribution_method AS method,
             (o.order_status = 'cancelled' OR f.cancelled_at IS NOT NULL) AS cancelled,
             f.shop_currency AS currency, f.current_total_price AS order_value,
             c.currency AS c_currency, c.status AS c_status, c.commission_amount AS c_amount
      FROM affiliate_order_attributions t JOIN orders o ON o.id = t.order_id
      LEFT JOIN order_financial_latest f ON f.order_id = t.order_id
      LEFT JOIN affiliate_commissions c ON c.attribution_id = t.id
      WHERE t.order_placed_at >= ${START('$1')} AND t.order_placed_at < ${END('$2')}`, p),
    db.query(`
      SELECT d::date::text AS day,
             (SELECT count(*) FROM affiliate_referral_clicks k
               WHERE k.clicked_at >= (d::timestamp AT TIME ZONE '${TZ}') AND k.clicked_at < ((d + interval '1 day')::timestamp AT TIME ZONE '${TZ}'))::int AS clicks,
             (SELECT count(*) FROM affiliate_order_attributions t
               WHERE t.order_placed_at >= (d::timestamp AT TIME ZONE '${TZ}') AND t.order_placed_at < ((d + interval '1 day')::timestamp AT TIME ZONE '${TZ}'))::int AS orders
      FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY d`, p),
    payouts ? db.query(`SELECT affiliate_id, count(*)::int AS n, sum(gross_amount) AS gross, sum(tds_amount) AS tds, sum(net_amount) AS net
                        FROM affiliate_payouts WHERE status = 'paid' AND currency = 'INR' AND paid_on BETWEEN $1::date AND $2::date
                        GROUP BY affiliate_id`, p) : { rows: [] },
    payouts ? db.query(`SELECT count(*)::int AS n, coalesce(sum(net_amount), 0) AS net, coalesce(sum(gross_amount), 0) AS gross
                        FROM affiliate_payouts WHERE status = 'pending' AND currency = 'INR'`) : { rows: [{ n: 0, net: 0, gross: 0 }] },
  ]);

  // Per affiliate, in paise (integers) while adding up.
  const rows = new Map(aff.rows.map((a) => [Number(a.id), {
    public_id: a.public_id, name: a.display_name, category: a.category, status: a.status,
    clicks: 0, orders: 0, cancelled: 0, by_method: { link: 0, coupon: 0, gokwik: 0 }, order_value: 0,
    earned: 0, paid_net: 0, paid_tds: 0,
  }]));
  const row = (id) => rows.get(Number(id));
  const totals = {
    clicks: 0, orders: 0, cancelled: 0, by_method: { link: 0, coupon: 0, gokwik: 0 }, order_value: 0, other_currency_orders: 0,
    commissions: { earned: 0, by_status: { pending: 0, approved: 0, paid: 0, reversed: 0 }, on_cancelled_orders: 0, orders_without_commission: 0 },
  };
  const paise = (v) => Math.round(money2(v) * 100);

  for (const c of clicks.rows) { const r = row(c.affiliate_id); if (r) r.clicks += c.n; totals.clicks += c.n; }
  for (const o of orders.rows) {
    const r = row(o.affiliate_id);
    const m = METHOD_KEY[o.method] || 'link';
    totals.orders += 1; totals.by_method[m] += 1;
    if (r) { r.orders += 1; r.by_method[m] += 1; }
    if (o.cancelled) { totals.cancelled += 1; if (r) r.cancelled += 1; }
    else if (o.currency === 'INR') { totals.order_value += paise(o.order_value); if (r) r.order_value += paise(o.order_value); }
    else if (o.currency) totals.other_currency_orders += 1;
    if (!o.c_status) { totals.commissions.orders_without_commission += 1; continue; }
    if (o.c_currency !== 'INR') continue;
    const amt = paise(o.c_amount);
    if (o.c_status !== 'reversed' && o.cancelled) { totals.commissions.on_cancelled_orders += amt; continue; }
    totals.commissions.by_status[o.c_status] += amt;
    if (o.c_status !== 'reversed') { totals.commissions.earned += amt; if (r) r.earned += amt; }
  }
  const paidTotals = { payouts: 0, gross: 0, tds: 0, net: 0 };
  for (const x of paid.rows) {
    const r = row(x.affiliate_id);
    paidTotals.payouts += x.n; paidTotals.gross += paise(x.gross); paidTotals.tds += paise(x.tds); paidTotals.net += paise(x.net);
    if (r) { r.paid_net += paise(x.net); r.paid_tds += paise(x.tds); }
  }

  const rupees = (v) => v / 100;
  const byStatus = aff.rows.reduce((m, a) => (m[a.status] = (m[a.status] || 0) + 1, m), {});
  const list = [...rows.values()]
    .filter((r) => r.clicks || r.orders || r.paid_net || r.status === 'active')
    .map((r) => ({
      public_id: r.public_id, name: r.name, category: r.category, status: r.status, clicks: r.clicks, orders: r.orders,
      cancelled: r.cancelled, by_method: r.by_method, conversion: r.clicks ? Math.round((r.by_method.link / r.clicks) * 1000) / 10 : null,
      order_value: rupees(r.order_value),
      ...(commissions ? { commission_earned: rupees(r.earned) } : {}),
      ...(payouts ? { paid_net: rupees(r.paid_net), paid_tds: rupees(r.paid_tds) } : {}),
    }))
    .sort((a, b) => b.orders - a.orders || b.order_value - a.order_value || b.clicks - a.clicks || a.name.localeCompare(b.name));

  return {
    period, currency: 'INR', money: { commissions, payouts },
    affiliates: { total: aff.rows.length, by_status: byStatus },
    totals: {
      clicks: totals.clicks, orders: totals.orders, cancelled: totals.cancelled, by_method: totals.by_method,
      // Conversion: orders credited through a link click per recorded click (coupon orders need no click).
      conversion: totals.clicks ? Math.round((totals.by_method.link / totals.clicks) * 1000) / 10 : null,
      order_value: rupees(totals.order_value), other_currency_orders: totals.other_currency_orders,
      average_order_value: totals.orders - totals.cancelled ? Math.round(totals.order_value / (totals.orders - totals.cancelled)) / 100 : null,
      ...(commissions ? { commissions: {
        earned: rupees(totals.commissions.earned), on_cancelled_orders: rupees(totals.commissions.on_cancelled_orders),
        orders_without_commission: totals.commissions.orders_without_commission,
        by_status: Object.fromEntries(Object.entries(totals.commissions.by_status).map(([k, v]) => [k, rupees(v)])),
      } } : {}),
      ...(payouts ? { payouts: {
        paid: { payouts: paidTotals.payouts, gross: rupees(paidTotals.gross), tds: rupees(paidTotals.tds), net: rupees(paidTotals.net) },
        waiting: { payouts: waiting.rows[0].n, gross: money2(waiting.rows[0].gross), net: money2(waiting.rows[0].net) },
      } } : {}),
    },
    series: series.rows,
    rows: list,
  };
}
