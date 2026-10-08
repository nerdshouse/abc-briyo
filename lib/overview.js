import { getPool, actionQueue, dailySnapshot, whoIsOnline } from './db.js';
import { ensureOrdersSchema, LOGISTICS_VIEWS, ORDER_FROM, teamTimezone } from './orders.js';
import { inventoryDashboard } from './inventory.js';
import { ensureOrderFinancialSnapshotSchema } from './order-financial-snapshots.js';
import { ensureAffiliateSchema } from './affiliates.js';
import { ensureAffiliateReferralSchema } from './affiliate-referrals.js';
import { ensureHrSchema } from './hr.js';
import { can } from './permissions.js';
import { metaService, MetaError } from './meta-ads.js';

/**
 * Briyo OS overview: one request, each department computed only if the caller
 * may see it (lib/permissions.js). Every number is a COUNT over real rows,
 * using the same predicates as the department pages, so a number here and the
 * list it links to agree. Nothing is estimated; a section that cannot be
 * computed is reported as unavailable, never as zero.
 *
 *   logistics  logistics.view
 *   inventory  inventory.view
 *   support    support.work
 *   hr         hr.view
 *   team       admin only (the app's members — not HR)
 *   attention  the non-zero items above, by severity
 *   setup      onboarding work that blocks nothing (e.g. platform SKUs to map)
 *
 * Logistics counts the shipment work the app itself runs. Marketplace and
 * Shopify orders are often fulfilled outside the app, so an order with no
 * in-app shipment is never reported as waiting for dispatch; and a cancelled
 * order is never counted as in transit or delivered.
 */

const SEVERITY = ['critical', 'warning', 'attention'];

async function logistics(tz) {
  await ensureOrdersSchema();
  const v = LOGISTICS_VIEWS;
  const { rows: [r] } = await getPool().query(`
    SELECT count(DISTINCT o.id)::int AS total,
           count(DISTINCT o.id) FILTER (WHERE coalesce(o.order_date, o.created_at) >= (date_trunc('day', now() AT TIME ZONE $1)) AT TIME ZONE $1)::int AS today,
           count(DISTINCT o.id) FILTER (WHERE ${v.awaiting_dispatch.where})::int AS awaiting_dispatch,
           count(DISTINCT o.id) FILTER (WHERE ${v.in_transit.where} AND o.order_status <> 'cancelled')::int AS in_transit,
           count(DISTINCT o.id) FILTER (WHERE ${v.delivered.where} AND o.order_status <> 'cancelled')::int AS delivered,
           count(DISTINCT o.id) FILTER (WHERE ${v.failed.where})::int AS failed
    ${ORDER_FROM}`, [tz]);
  return r;
}

// Lightweight counts (lib/inventory.js inventoryDashboard), not the Inventory page's full calculation.
// SKU mapping is onboarding, not a blocker: historical orders are kept out of stock by the cutover.
async function inventory() {
  return inventoryDashboard();
}

/**
 * Commerce. Shopify orders are channel 'website' + source 'shopify_sync'. Money
 * comes only from Shopify's own financial record (order_financial_latest), never
 * orders.order_value; it is per shop currency, cancelled orders are excluded,
 * refunds are already inside current_total_price, and an order without a
 * snapshot is counted as unknown — never as zero. Money and sync health are
 * returned to admins only; for anyone else the fields are absent.
 */
const SHOPIFY_ORDERS = `o.channel = 'website' AND o.source = 'shopify_sync'`;
export const SHOPIFY_STALE_HOURS = 24;
const FINANCIAL_GROUPS = { PAID: 'paid', PENDING: 'pending' };

function byCurrency(rows, fn) {
  const m = new Map();
  for (const r of rows) { const cur = m.get(r.currency) || fn.init(r.currency); fn.add(cur, r); m.set(r.currency, cur); }
  return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

async function shopify({ admin }) {
  await ensureOrderFinancialSnapshotSchema();
  const sql = getPool();
  const jobs = [sql.query(`SELECT count(*) FILTER (WHERE o.order_status <> 'cancelled')::int AS active,
                                  count(*) FILTER (WHERE o.order_status = 'cancelled')::int AS cancelled
                           FROM orders o WHERE ${SHOPIFY_ORDERS}`)];
  if (admin) {
    jobs.push(sql.query(`
      SELECT f.shop_currency AS currency, f.financial_status AS status, count(*)::int AS orders,
             coalesce(sum(f.current_total_price), 0)::text AS value, coalesce(sum(f.total_refunded), 0)::text AS refunded
      FROM orders o LEFT JOIN order_financial_latest f ON f.order_id = o.id
      WHERE ${SHOPIFY_ORDERS} AND o.order_status <> 'cancelled' AND f.cancelled_at IS NULL
      GROUP BY 1, 2`));
    jobs.push(sql.query(`
      SELECT id, status, started_at, completed_at, orders_in_file, orders_created, orders_updated, conflicts, unmapped_lines, error_rows,
             (details->>'shopify_transient_retries')::int AS retries
      FROM order_imports WHERE kind = 'shopify_sync' ORDER BY id DESC LIMIT 10`));
    jobs.push(sql.query(`SELECT value FROM system_state WHERE key = 'shopify_orders_checkpoint'`));
  }
  const [{ rows: [n] }, money, runs, cp] = await Promise.all(jobs);
  const out = { scope: 'all_synced', orders: { active: n.active, cancelled: n.cancelled } };
  if (!admin) return out;

  // Sums stay as exact decimal strings from Postgres, added per currency in cents.
  const cents = (v) => Math.round(Number(v) * 100);
  const known = money.rows.filter((r) => r.currency);
  out.money = {
    by_currency: byCurrency(known, {
      init: (currency) => ({ currency, orders: 0, current_order_value: 0, paid: 0, pending: 0, other: 0, other_statuses: {}, refunded: 0 }),
      add: (c, r) => {
        const v = cents(r.value);
        c.orders += r.orders; c.current_order_value += v; c.refunded += cents(r.refunded);
        const g = FINANCIAL_GROUPS[r.status];
        if (g) c[g] += v; else { c.other += v; c.other_statuses[r.status || 'UNKNOWN'] = (c.other_statuses[r.status || 'UNKNOWN'] || 0) + v; }
      },
    }).map((c) => ({ ...c, current_order_value: c.current_order_value / 100, paid: c.paid / 100, pending: c.pending / 100, other: c.other / 100, refunded: c.refunded / 100,
      other_statuses: Object.fromEntries(Object.entries(c.other_statuses).map(([k, v]) => [k, v / 100])) })),
    // Active orders with no financial snapshot: their value is unknown, not zero.
    orders_without_snapshot: money.rows.filter((r) => !r.currency).reduce((t, r) => t + r.orders, 0),
  };

  // The checkpoint is written only by a sync that saw everything it asked for (lib/shopify-orders.js).
  const parsed = cp.rows[0]?.value ? new Date(cp.rows[0].value) : null;
  const checkpoint = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const ageHours = checkpoint ? (Date.now() - checkpoint.getTime()) / 3600000 : null;
  const last = runs.rows[0];
  out.sync = {
    status: !checkpoint ? 'never' : ageHours > SHOPIFY_STALE_HOURS ? 'stale' : 'ok',
    message: !checkpoint ? 'No successful Shopify sync' : ageHours > SHOPIFY_STALE_HOURS ? 'Shopify sync is stale' : null,
    stale_after_hours: SHOPIFY_STALE_HOURS,
    checkpoint_at: checkpoint ? checkpoint.toISOString() : null,
    polling: process.env.SHOPIFY_ORDERS_POLL_ENABLED === 'true',
    last_run: last ? { ...last, id: Number(last.id) } : null,
    recent_failed_runs: runs.rows.filter((r) => r.status === 'failed').length,
    recent_runs: runs.rows.length,
  };
  return out;
}

/**
 * Affiliate programme figures. No commission, payable or payout: those systems do
 * not exist yet. Attributed order value = Shopify's current_total_price of
 * attributed, non-cancelled orders, per currency; at most one attribution per
 * order is guaranteed by the schema (UNIQUE order_id). Admins only.
 */
async function affiliate({ admin }) {
  await ensureAffiliateSchema();
  await ensureAffiliateReferralSchema();
  await ensureOrderFinancialSnapshotSchema();
  const sql = getPool();
  const jobs = [
    sql.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active,
                      count(*) FILTER (WHERE status = 'pending_verification')::int AS pending_verification,
                      count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
                      (SELECT count(*) FROM affiliate_referral_clicks)::int AS clicks,
                      (SELECT count(*) FROM affiliate_referral_clicks WHERE clicked_at > now() - interval '30 days')::int AS clicks_30d
               FROM affiliates`),
    sql.query('SELECT attribution_method AS method, count(*)::int AS n FROM affiliate_order_attributions GROUP BY 1'),
  ];
  if (admin) {
    jobs.push(sql.query(`
      SELECT f.shop_currency AS currency,
             (o.order_status = 'cancelled' OR f.cancelled_at IS NOT NULL) AS cancelled,
             count(*)::int AS orders, coalesce(sum(f.current_total_price), 0)::text AS value
      FROM affiliate_order_attributions a JOIN orders o ON o.id = a.order_id
      LEFT JOIN order_financial_latest f ON f.order_id = a.order_id
      GROUP BY 1, 2`));
  }
  const [{ rows: [c] }, { rows: methods }, value] = await Promise.all(jobs);
  const out = {
    affiliates: { total: c.total, active: c.active, pending_verification: c.pending_verification, suspended: c.suspended },
    clicks: { total: c.clicks, last_30d: c.clicks_30d },
    attributions: { total: methods.reduce((t, m) => t + m.n, 0), by_method: Object.fromEntries(methods.map((m) => [m.method, m.n])) },
  };
  if (!admin) return out;
  const rows = value.rows;
  out.attributed_order_value = {
    by_currency: byCurrency(rows.filter((r) => r.currency && !r.cancelled), {
      init: (currency) => ({ currency, orders: 0, value: 0 }),
      add: (x, r) => { x.orders += r.orders; x.value += Math.round(Number(r.value) * 100); },
    }).map((x) => ({ ...x, value: x.value / 100 })),
    cancelled_orders: rows.filter((r) => r.cancelled).reduce((t, r) => t + r.orders, 0),
    orders_without_snapshot: rows.filter((r) => !r.currency && !r.cancelled).reduce((t, r) => t + r.orders, 0),
  };
  return out;
}

async function commerce({ caps, admin }) {
  const out = {};
  const [s, a] = await Promise.all([
    can(caps, 'logistics.view') ? shopify({ admin }) : null,
    can(caps, 'affiliate.view') ? affiliate({ admin }) : null,
  ]);
  if (s) out.shopify = s;
  if (a) out.affiliate = a;
  return out;
}

/**
 * Shipments: parcels (order_shipments rows), not orders — a shared parcel counts
 * once. Parcels of a cancelled order are left out of the operational counts and
 * reported on their own.
 */
const SHIPMENT_STATUSES = ['not_ready', 'packed', 'dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto', 'cancelled'];
async function shipments() {
  await ensureOrdersSchema();
  const { rows } = await getPool().query(`
    SELECT s.shipment_status AS status, (o.order_status = 'cancelled') AS order_cancelled, count(*)::int AS n
    FROM order_shipments s JOIN orders o ON o.id = s.order_id GROUP BY 1, 2`);
  const by = Object.fromEntries(SHIPMENT_STATUSES.map((k) => [k, 0]));
  let onCancelled = 0;
  for (const r of rows) { if (r.order_cancelled) onCancelled += r.n; else by[r.status] = (by[r.status] || 0) + r.n; }
  return {
    by_status: by,
    // Live parcels: every status except a cancelled shipment.
    active_total: Object.entries(by).filter(([k]) => k !== 'cancelled').reduce((t, [, v]) => t + v, 0),
    on_cancelled_orders: onCancelled,
  };
}

async function support({ slaHours, me, tz }) {
  const today = `(date_trunc('day', now() AT TIME ZONE $2)) AT TIME ZONE $2`;
  const [q, day, { rows: [r] }] = await Promise.all([
    actionQueue(slaHours),
    dailySnapshot(),
    getPool().query(`
      SELECT count(*) FILTER (WHERE status = 'Not called')::int AS not_called,
             count(*) FILTER (WHERE status = 'Callback scheduled')::int AS callbacks,
             count(*) FILTER (WHERE status IN ('Not called','Callback scheduled') AND assigned_to = $1)::int AS mine,
             count(*) FILTER (WHERE status IN ('Not called','Callback scheduled') AND assigned_to IS NOT NULL)::int AS assigned,
             count(*) FILTER (WHERE status = 'Called – Recovered' AND status_updated_at >= ${today})::int AS recovered_today,
             (SELECT count(DISTINCT cart_id) FROM cart_events WHERE at >= ${today})::int AS worked_today
      FROM abandoned_carts`, [me, tz]),
  ]);
  return {
    not_called: r.not_called,
    uncalled_past_sla: q.stale,
    unassigned: q.unassigned,
    assigned: r.assigned,
    callbacks: r.callbacks,
    callbacks_today: q.callbacks_today,
    callbacks_overdue: q.callbacks_overdue,
    callbacks_due: q.callbacks_today + q.callbacks_overdue,
    assigned_to_me: r.mine,
    worked_today: r.worked_today,
    recovered_today: r.recovered_today,
    today: { carts: day.today.carts, called: day.today.called, recovered: day.today.recovered, recovered_value: day.today.recovered_value },
    sla_hours: slaHours,
  };
}

async function hr() {
  await ensureHrSchema();
  const { rows: [r] } = await getPool().query(`
    SELECT (SELECT count(*) FROM hr_jobs WHERE status = 'published')::int AS open_jobs,
           (SELECT count(*) FROM hr_jobs WHERE status = 'draft')::int AS draft_jobs,
           count(*)::int AS applications,
           count(DISTINCT candidate_id)::int AS candidates,
           count(*) FILTER (WHERE status = 'applied')::int AS awaiting_review,
           count(*) FILTER (WHERE status IN ('screening','interview','offer'))::int AS in_progress,
           count(*) FILTER (WHERE status = 'hired' AND status_changed_at > now() - interval '30 days')::int AS hired_30d,
           count(*) FILTER (WHERE completed_at > now() - interval '7 days')::int AS new_7d
    FROM hr_applications WHERE completed_at IS NOT NULL`);
  return r;
}

async function team() {
  const sql = getPool();
  const [{ rows: [m] }, { rows: mods }, online] = await Promise.all([
    sql.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active,
                      count(*) FILTER (WHERE active AND is_admin)::int AS admins,
                      count(*) FILTER (WHERE active AND NOT is_admin AND NOT EXISTS (SELECT 1 FROM member_module_roles r WHERE r.phone = u.phone))::int AS no_access,
                      count(*) FILTER (WHERE active AND NOT (${profileCompleteSql('u')}))::int AS incomplete_profiles
               FROM allowed_users u`),
    sql.query(`SELECT r.module, count(*)::int AS n FROM member_module_roles r JOIN allowed_users u ON u.phone = r.phone AND u.active GROUP BY r.module`),
    whoIsOnline(Number(process.env.ONLINE_WINDOW_MINUTES || 5)),
  ]);
  return { ...m, by_department: Object.fromEntries(mods.map((x) => [x.module, x.n])), online: online.length };
}

/** Same rule as lib/profile.js: name, email and a photo. Kept as SQL so People counts it in one query. */
export const profileCompleteSql = (a = 'allowed_users') => `(${a}.photo_key IS NOT NULL AND coalesce(btrim(${a}.email), '') <> '' AND coalesce(btrim(${a}.name), '') NOT IN ('', 'Team'))`;

/**
 * Marketing today, from the same Meta service and cache the Marketing page uses.
 * The Overview never waits on Meta: cached data answers at once; a fresh fetch
 * gets OVERVIEW_META_MS, after which the card says it is loading while the fetch
 * finishes in the background (and fills the cache for the next load).
 */
export const OVERVIEW_META_MS = 2000;
async function marketing({ waitMs = OVERVIEW_META_MS } = {}) {
  const svc = metaService();
  if (!svc.config.configured) return { configured: false };
  const timeout = (ms) => new Promise((resolve) => { const t = setTimeout(() => resolve({ timedOut: true }), ms); t.unref?.(); });
  const pending = Promise.all([svc.summary({ range: 'today' }), svc.account().catch(() => null)]);
  pending.catch(() => {}); // a late failure must not surface as an unhandled rejection
  let out;
  try { out = await Promise.race([pending, timeout(waitMs)]); } catch (err) {
    if (err instanceof MetaError) return { configured: true, unavailable: true, error_kind: err.kind, message: err.message };
    throw err;
  }
  if (out.timedOut) return { configured: true, pending: true, message: 'Meta Ads is taking longer than usual. The figures will appear on the next refresh.' };
  const [r, acct] = out;
  // Totals (and ROAS) come straight from the Marketing service's metricsFrom — the page's calculation.
  return { configured: true, ...r.data.totals, delivered: r.data.delivered, currency: acct?.data?.currency || null,
    timezone: acct?.data?.timezone || null, available_funds: acct?.data?.billing?.availableFunds ?? null,
    fetched_at: r.fetchedAt, stale: r.stale, stale_reason: r.error?.message || null, roas_target: svc.config.roasTarget };
}

async function ingest() {
  const hours = Number(process.env.INGEST_SILENCE_HOURS || 8);
  const { rows: [r] } = await getPool().query(`
    SELECT (SELECT max(received_at) FROM abandoned_carts) AS last,
           (SELECT count(*) FROM webhook_failures WHERE received_at > now() - interval '24 hours')::int AS failures`);
  const age = r.last ? (Date.now() - new Date(r.last).getTime()) / 3600000 : null;
  return { last_received_at: r.last, silent: age !== null && age > hours, silence_hours: hours, webhook_failures_24h: r.failures };
}

/** Run one section; a failure marks it unavailable instead of failing the page or showing zeros. */
async function section(fn) {
  try { return { ok: true, ...(await fn()) }; } catch (err) {
    console.error('Overview section failed:', err.message?.slice(0, 200));
    return { ok: false, unavailable: true };
  }
}

function attentionItems(s) {
  const items = [];
  const add = (dept, severity, n, text, href) => { if (n > 0) items.push({ dept, severity, count: n, text, href }); };
  const L = s.logistics; const I = s.inventory; const S = s.support; const H = s.hr; const P = s.team; const G = s.ingest;
  if (L?.ok) {
    add('logistics', 'critical', L.failed, L.failed === 1 ? 'failed delivery or RTO' : 'failed deliveries or RTOs', '/orders?view=failed');
    add('logistics', 'attention', L.awaiting_dispatch, L.awaiting_dispatch === 1 ? 'shipment awaiting dispatch' : 'shipments awaiting dispatch', '/orders?view=awaiting_dispatch');
  }
  if (I?.ok) {
    add('inventory', 'critical', I.expired_batches, I.expired_batches === 1 ? 'expired batch still holding stock' : 'expired batches still holding stock', '/inventory?expiring=expired');
    if (I.stock_tracked) {
      add('inventory', 'warning', I.out_of_stock, I.out_of_stock === 1 ? 'product out of stock' : 'products out of stock', '/inventory?stock=out');
      add('inventory', 'attention', I.low_stock, I.low_stock === 1 ? 'product low on stock' : 'products low on stock', '/inventory?stock=low');
    }
    add('inventory', 'attention', I.expiring_30, I.expiring_30 === 1 ? 'batch expiring within 30 days' : 'batches expiring within 30 days', '/inventory?expiring=30');
  }
  if (S?.ok) {
    add('support', 'critical', S.callbacks_overdue, S.callbacks_overdue === 1 ? 'callback overdue' : 'callbacks overdue', '/?mode=callbacks');
    add('support', 'warning', S.uncalled_past_sla, `uncalled past the ${S.sla_hours}h SLA`, '/?mode=tocall');
    add('support', 'attention', S.callbacks_today, S.callbacks_today === 1 ? 'callback due today' : 'callbacks due today', '/?mode=callbacks');
    add('support', 'attention', S.unassigned, S.unassigned === 1 ? 'uncalled cart not assigned' : 'uncalled carts not assigned', '/?mode=tocall');
  }
  if (H?.ok) add('hr', 'attention', H.awaiting_review, H.awaiting_review === 1 ? 'application awaiting review' : 'applications awaiting review', '/hr/candidates?status=applied');
  if (P?.ok) {
    add('team', 'warning', P.incomplete_profiles, P.incomplete_profiles === 1 ? 'member profile incomplete' : 'member profiles incomplete', '/admin?filter=incomplete');
    add('team', 'attention', P.no_access, P.no_access === 1 ? 'member with no department access' : 'members with no department access', '/admin?filter=no_access');
  }
  const M = s.marketing;
  if (M?.ok && M.configured) {
    if (M.pending) { /* still loading: no alarm */ } else if (M.unavailable) items.push({ dept: 'marketing', severity: M.error_kind === 'token' || M.error_kind === 'permission' ? 'critical' : 'warning', count: null, text: `Meta Ads data unavailable — ${M.message}`, href: '/marketing' });
    else if (M.stale) items.push({ dept: 'marketing', severity: 'warning', count: null, text: 'Meta Ads data delayed — showing the last successful update', href: '/marketing' });
    else if (M.roas_target && M.spend > 0 && M.roas !== null && M.roas < M.roas_target) items.push({ dept: 'marketing', severity: 'warning', count: null, text: `Meta ROAS today ${M.roas.toFixed(2)}× is below the ${M.roas_target}× target`, href: '/marketing' });
  }
  if (G?.ok) {
    if (G.silent) items.push({ dept: 'support', severity: 'critical', count: null, text: `No carts received from GoKwik for over ${G.silence_hours}h`, href: '/dashboard' });
    add('support', 'warning', G.webhook_failures_24h, G.webhook_failures_24h === 1 ? 'webhook delivery failed in 24h' : 'webhook deliveries failed in 24h', '/dashboard');
  }
  return items.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
}

/** Setup work: worth doing, blocks nothing, so never an alarm. */
function setupItems(s) {
  const I = s.inventory;
  if (!I?.ok) return [];
  const items = [];
  const n = I.platform_skus_to_map;
  if (n > 0) items.push({ dept: 'inventory', count: n, text: n === 1 ? 'platform SKU needs mapping' : 'platform SKUs need mapping', href: '/inventory?view=unmapped' });
  if (!I.cutover_at) items.push({ dept: 'inventory', count: null, text: 'Inventory cutover · Not set', href: '/inventory' });
  return items;
}

export async function overviewFor(session, { slaHours = 6, ...opts } = {}) {
  const caps = session?.caps || [];
  const admin = Boolean(session?.isAdmin);
  const tz = teamTimezone();
  const jobs = {};
  if (can(caps, 'logistics.view')) jobs.logistics = section(() => logistics(tz));
  if (can(caps, 'inventory.view')) jobs.inventory = section(inventory);
  if (can(caps, 'logistics.view') || can(caps, 'affiliate.view')) jobs.commerce = section(() => commerce({ caps, admin }));
  if (can(caps, 'logistics.view')) jobs.shipments = section(shipments);
  if (can(caps, 'support.work')) jobs.support = section(() => support({ slaHours, me: session.phone, tz }));
  if (can(caps, 'hr.view')) jobs.hr = section(hr);
  if (admin) { jobs.team = section(team); jobs.ingest = section(ingest); }
  if (can(caps, 'marketing.view')) jobs.marketing = section(() => marketing(opts));
  const keys = Object.keys(jobs);
  const values = await Promise.all(Object.values(jobs));
  const sections = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  return { generated_at: new Date().toISOString(), timezone: tz, sections, attention: attentionItems(sections), setup: setupItems(sections) };
}
