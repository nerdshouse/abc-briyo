import { getPool, actionQueue, dailySnapshot, whoIsOnline } from './db.js';
import { ensureOrdersSchema, LOGISTICS_VIEWS, ORDER_FROM, teamTimezone } from './orders.js';
import { ensureInventorySchema, inventoryOverview } from './inventory.js';
import { ensureHrSchema } from './hr.js';
import { can } from './permissions.js';

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
 *   people     admin only
 *   attention  the non-zero items above, by severity
 */

const SEVERITY = ['critical', 'warning', 'attention'];

async function logistics(tz) {
  await ensureOrdersSchema();
  const v = LOGISTICS_VIEWS;
  const { rows: [r] } = await getPool().query(`
    SELECT count(DISTINCT o.id)::int AS total,
           count(DISTINCT o.id) FILTER (WHERE coalesce(o.order_date, o.created_at) >= (date_trunc('day', now() AT TIME ZONE $1)) AT TIME ZONE $1)::int AS today,
           count(DISTINCT o.id) FILTER (WHERE ${v.pending_dispatch.where})::int AS pending_dispatch,
           count(DISTINCT o.id) FILTER (WHERE ${v.in_transit.where})::int AS in_transit,
           count(DISTINCT o.id) FILTER (WHERE ${v.delivered.where})::int AS delivered,
           count(DISTINCT o.id) FILTER (WHERE ${v.failed.where})::int AS failed,
           count(DISTINCT o.id) FILTER (WHERE o.order_status IN ('new','confirmed') AND s.id IS NULL)::int AS without_shipment
    ${ORDER_FROM}`, [tz]);
  return r;
}

async function inventory() {
  await ensureInventorySchema();
  const [ov, { rows: [b] }] = await Promise.all([
    inventoryOverview({}),
    getPool().query('SELECT count(*)::int AS n FROM inventory_batches'),
  ]);
  const c = ov.cards;
  return {
    master_skus: c.totalSkus,
    // Before the first batch exists every SKU is "out of stock"; that is not actionable, so stock flags wait for it.
    stock_tracked: b.n > 0,
    low_stock: c.lowStock,
    out_of_stock: c.outOfStock,
    expired_batches: c.expired,
    expiring_30: c.expiring30,
    available_units: c.availableUnits,
    reserved_units: c.reservedUnits,
    unmapped_skus: (ov.unmapped || []).length,
  };
}

async function support({ slaHours, me }) {
  const [q, day, { rows: [r] }] = await Promise.all([
    actionQueue(slaHours),
    dailySnapshot(),
    getPool().query(`
      SELECT count(*) FILTER (WHERE status = 'Not called')::int AS not_called,
             count(*) FILTER (WHERE status = 'Callback scheduled')::int AS callbacks,
             count(*) FILTER (WHERE status IN ('Not called','Callback scheduled') AND assigned_to = $1)::int AS mine
      FROM abandoned_carts`, [me]),
  ]);
  return {
    not_called: r.not_called,
    uncalled_past_sla: q.stale,
    unassigned: q.unassigned,
    callbacks: r.callbacks,
    callbacks_today: q.callbacks_today,
    callbacks_overdue: q.callbacks_overdue,
    assigned_to_me: r.mine,
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
           count(*) FILTER (WHERE status = 'applied')::int AS awaiting_review,
           count(*) FILTER (WHERE status IN ('screening','interview','offer'))::int AS in_progress,
           count(*) FILTER (WHERE status = 'hired' AND status_changed_at > now() - interval '30 days')::int AS hired_30d,
           count(*) FILTER (WHERE completed_at > now() - interval '7 days')::int AS new_7d
    FROM hr_applications WHERE completed_at IS NOT NULL`);
  return r;
}

async function people() {
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
  const L = s.logistics; const I = s.inventory; const S = s.support; const H = s.hr; const P = s.people; const G = s.ingest;
  if (L?.ok) {
    add('logistics', 'critical', L.failed, L.failed === 1 ? 'failed delivery or RTO' : 'failed deliveries or RTOs', '/orders?view=failed');
    add('logistics', 'warning', L.without_shipment, L.without_shipment === 1 ? 'open order without a shipment' : 'open orders without a shipment', '/orders?view=pending_dispatch');
    add('logistics', 'attention', L.pending_dispatch, L.pending_dispatch === 1 ? 'order pending dispatch' : 'orders pending dispatch', '/orders?view=pending_dispatch');
  }
  if (I?.ok) {
    add('inventory', 'critical', I.expired_batches, I.expired_batches === 1 ? 'expired batch still holding stock' : 'expired batches still holding stock', '/inventory?expiring=expired');
    add('inventory', 'warning', I.unmapped_skus, I.unmapped_skus === 1 ? 'unmapped platform SKU blocking dispatch' : 'unmapped platform SKUs blocking dispatch', '/inventory?view=unmapped');
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
    add('people', 'warning', P.incomplete_profiles, P.incomplete_profiles === 1 ? 'member profile incomplete' : 'member profiles incomplete', '/admin?filter=incomplete');
    add('people', 'attention', P.no_access, P.no_access === 1 ? 'member with no department access' : 'members with no department access', '/admin?filter=no_access');
  }
  if (G?.ok) {
    if (G.silent) items.push({ dept: 'support', severity: 'critical', count: null, text: `No carts received from GoKwik for over ${G.silence_hours}h`, href: '/dashboard' });
    add('support', 'warning', G.webhook_failures_24h, G.webhook_failures_24h === 1 ? 'webhook delivery failed in 24h' : 'webhook deliveries failed in 24h', '/dashboard');
  }
  return items.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
}

export async function overviewFor(session, { slaHours = 6 } = {}) {
  const caps = session?.caps || [];
  const admin = Boolean(session?.isAdmin);
  const tz = teamTimezone();
  const jobs = {};
  if (can(caps, 'logistics.view')) jobs.logistics = section(() => logistics(tz));
  if (can(caps, 'inventory.view')) jobs.inventory = section(inventory);
  if (can(caps, 'support.work')) jobs.support = section(() => support({ slaHours, me: session.phone }));
  if (can(caps, 'hr.view')) jobs.hr = section(hr);
  if (admin) { jobs.people = section(people); jobs.ingest = section(ingest); }
  const keys = Object.keys(jobs);
  const values = await Promise.all(Object.values(jobs));
  const sections = Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  return { generated_at: new Date().toISOString(), timezone: tz, sections, attention: attentionItems(sections) };
}
