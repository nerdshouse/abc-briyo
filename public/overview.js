/**
 * Briyo OS overview — what is happening in the business, department by
 * department, and what needs intervention. One request (/api/overview); the
 * server returns only the departments this member may see, and this page only
 * ever renders those. A department that could not be counted says so; it never
 * shows zeros it does not have.
 *
 * Layout, top to bottom: header (date, Overview, greeting) → operating status
 * (counts by priority + department chips that jump to modules) → Marketing (the
 * executive module) → operations pairs → People → exceptions grouped by priority. Marketing context (7-day trend, campaigns today) comes from the
 * existing Marketing APIs and loads after the page; it never delays it.
 */
import { $, esc, count, money, icon, renderIcons, initShell, pageFetch, pageSignal, onLeave, relative } from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, data: null, timer: null, tick: null, mk: { trend: null, campaigns: null, loading: false, done: false } };

const api = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
};

const DEPTS = {
  marketing: { label: 'Marketing', icon: 'megaphone', href: '/marketing' },
  logistics: { label: 'Logistics', icon: 'truck', href: '/orders' },
  inventory: { label: 'Inventory', icon: 'boxes', href: '/inventory' },
  support: { label: 'Support', icon: 'headset', href: '/?mode=tocall' },
  hr: { label: 'HR', icon: 'briefcase', href: '/hr/jobs' },
  people: { label: 'People', icon: 'users', href: '/admin' },
};
// Reading order. Pairs share a row on wide screens; a lone module takes the row.
const ROWS = [['marketing'], ['logistics', 'inventory'], ['support', 'hr'], ['people']];
const SEV_LABEL = { critical: 'Critical', warning: 'Warning', attention: 'Review' };

function greeting(tz) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
const today = (tz) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

const n = (v) => count(v ?? 0);
const plural = (v, one, many) => (v === 1 ? one : many);

/**
 * One figure. Tone is meaning, applied only when the figure calls for it
 * (an exception that is non-zero); everything else stays ink.
 */
function stat(label, value, { href = '', note = '', tone = '', cls = '' } = {}) {
  const body = `<span class="ox-s-label">${esc(label)}</span><span class="ox-s-value num${tone ? ` t-${tone}` : ''}">${value}</span>${note ? `<span class="ox-s-note">${note}</span>` : ''}`;
  return href ? `<a class="ox-stat ${cls}" href="${href}">${body}</a>` : `<div class="ox-stat ${cls}">${body}</div>`;
}
/** An exception line: a label, a count, a tone only when it is non-zero. Zero reads as calm. */
function signal(label, v, { href = '', tone = 'warning', note = '' } = {}) {
  const hot = v > 0;
  const inner = `<span class="ox-sig-dot${hot ? ` d-${tone}` : ''}" aria-hidden="true"></span>
    <span class="ox-sig-label">${esc(label)}${note ? `<span class="ox-sig-note">${note}</span>` : ''}</span>
    <span class="ox-sig-value num${!hot ? ' t-quiet' : tone === 'attention' ? '' : ` t-${tone}`}">${n(v)}</span>`;
  return href ? `<a class="ox-sig" href="${href}">${inner}${icon('chevron-right', 'ox-chev')}</a>` : `<div class="ox-sig">${inner}<span></span></div>`;
}
/** A plain figure on a line: label left, value right. For secondary numbers that are not exceptions. */
function row(label, v, { href = '', tone = '', note = '' } = {}) {
  const inner = `<span class="ox-row-label">${esc(label)}${note ? `<span class="ox-sig-note">${note}</span>` : ''}</span><span class="ox-row-value num${tone ? ` t-${tone}` : ''}">${n(v)}</span>`;
  return href ? `<a class="ox-line" href="${href}">${inner}${icon('chevron-right', 'ox-chev')}</a>` : `<div class="ox-line">${inner}<span></span></div>`;
}
const group = (title, body, cls = '') => `<div class="ox-group ${cls}">${title ? `<h3 class="ox-group-title">${esc(title)}</h3>` : ''}${body}</div>`;

function deptHealth(key) {
  const items = (state.data.attention || []).filter((a) => a.dept === key);
  if (items.some((a) => a.severity === 'critical')) return ['critical', 'Critical'];
  if (items.some((a) => a.severity === 'warning')) return ['warning', 'Needs action'];
  if (items.length) return ['attention', 'Attention'];
  return ['healthy', 'Healthy'];
}

/** Marketing's header word is its freshness state; a ROAS warning still shows as Needs action. */
function marketingHealth(s) {
  if (!s.configured) return ['neutral', 'Not connected'];
  if (s.pending) return ['neutral', 'Loading'];
  if (s.unavailable) return ['critical', 'Unavailable'];
  if (s.stale) return ['warning', 'Data delayed'];
  const [tone, word] = deptHealth('marketing');
  return tone === 'healthy' ? ['healthy', 'Live'] : [tone, word];
}
const healthOf = (k, s) => (!s.ok ? ['critical', 'Unavailable'] : k === 'marketing' ? marketingHealth(s) : deptHealth(k));

// ------------------------------------------------------------------ Marketing

const mkMoney = (s, v, digits = 0) => (v === null || v === undefined ? '—'
  : new Intl.NumberFormat('en-IN', { style: 'currency', currency: s.currency || 'INR', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v));

/**
 * Spend vs Meta-attributed revenue, last 7 complete days: one shared currency
 * axis, two lines, legend always shown. Each day is a hover column with its values.
 */
function sparkline(s, trend) {
  if (!trend?.length) return '';
  const W = 700; const H = 72; const P = 4;
  const max = Math.max(1, ...trend.map((d) => Math.max(d.spend || 0, d.revenue || 0)));
  const step = trend.length === 1 ? 0 : (W - 2 * P) / (trend.length - 1);
  const x = (i) => (trend.length === 1 ? W / 2 : P + i * step);
  const y = (v) => H - P - ((v || 0) / max) * (H - 2 * P);
  const line = (k) => trend.map((d, i) => `${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(' ');
  const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const cols = trend.map((d, i) => {
    const w = trend.length === 1 ? W : step; const x0 = Math.max(0, x(i) - w / 2);
    return `<rect class="ox-spark-col" x="${x0.toFixed(1)}" y="0" width="${Math.min(w, W - x0).toFixed(1)}" height="${H}"><title>${esc(day(d.date))} · Spend ${esc(mkMoney(s, d.spend))} · Meta-attributed revenue ${esc(mkMoney(s, d.revenue))}</title></rect>`;
  }).join('');
  return `<svg class="ox-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Spend and Meta-attributed revenue by day, ${esc(day(trend[0].date))} to ${esc(day(trend.at(-1).date))}">
      <line class="ox-spark-base" x1="0" y1="${H - P}" x2="${W}" y2="${H - P}" />
      <polyline class="ox-spark-rev" points="${line('revenue')}" /><polyline class="ox-spark-spend" points="${line('spend')}" />${cols}
    </svg>
    <div class="ox-spark-axis"><span>${esc(day(trend[0].date))}</span><span>${esc(day(trend.at(-1).date))}</span></div>`;
}

const skel = (rows) => `<div class="ox-aside-block" aria-hidden="true">${rows}</div>`;

/** Last 7 complete days, under the KPIs: the context for today's numbers. */
function mkTrend(s) {
  const M = state.mk; const T = M.trend;
  if (!T && !M.done) return skel('<span class="sk w30"></span><span class="sk lg" style="width:100%;height:60px"></span>');
  if (!T?.trend?.length) return '';
  const t = T.totals;
  return `<div class="ox-aside-block ox-trend">
      <div class="ox-aside-head"><h3>Last 7 days</h3><span class="ox-aside-meta">complete days, excluding today</span>
        <span class="ox-aside-figs"><span><b class="num">${esc(mkMoney(s, t.spend))}</b> spend</span><span><b class="num">${esc(mkMoney(s, t.revenue))}</b> revenue</span><span><b class="num">${t.roas === null ? '—' : `${t.roas.toFixed(2)}×`}</b> ROAS</span></span></div>
      ${sparkline(s, T.trend)}
      <div class="ox-legend"><span class="ox-key k-spend">Spend</span><span class="ox-key k-rev">Meta-attributed revenue</span></div>
    </div>`;
}

/** Campaigns delivering today, beside the KPIs. */
function mkCampaigns(s) {
  const M = state.mk; const C = M.campaigns;
  if (!C && !M.done) return skel('<span class="sk w30"></span><span class="sk w90"></span><span class="sk w70"></span><span class="sk w90"></span>');
  if (!C) return '<p class="ox-aside-note">Campaign detail is on the Marketing page.</p>';
  const rows = C.rows || [];
  const delivering = rows.filter((r) => r.delivered && r.spend > 0);
  const active = rows.filter((r) => r.status === 'ACTIVE').length;
  const top = delivering.slice(0, 5); // already sorted by spend, server-side
  return `<div class="ox-aside-block">
      <div class="ox-aside-head"><h3>Campaigns today</h3><a class="ox-aside-link" href="/marketing?view=campaigns">All campaigns ${icon('arrow-right')}</a></div>
      <p class="ox-aside-figs"><span><b class="num">${n(delivering.length)}</b> spending</span><span><b class="num">${n(active)}</b> active</span><span><b class="num">${n(rows.length)}</b> total</span></p>
      ${top.length ? `<div class="ox-camps" role="group" aria-label="Top campaigns by spend today">
          <div class="ox-camp-th" aria-hidden="true"><span>Campaign</span><span>Spend</span><span>ROAS</span></div>
          ${top.map((r) => `<a href="/marketing?campaign=${encodeURIComponent(r.id)}">
          <span class="ox-camp-name">${esc(r.name)}</span>
          <span class="ox-camp-spend num"><span class="sr-only">, spend </span>${esc(mkMoney(s, r.spend))}</span>
          <span class="ox-camp-roas num"><span class="sr-only">, ROAS </span>${r.roas === null ? '—' : `${r.roas.toFixed(2)}×`}</span></a>`).join('')}</div>`
        : '<p class="ox-aside-note" style="padding:4px 0 0">No campaign has spent yet today.</p>'}
    </div>`;
}

function marketingBody(s) {
  const panel = (tone, title, text, extra = '') => `<div class="ox-panel p-${tone}"><b>${title}</b><span>${text}</span>${extra}</div>`;
  if (!s.configured) return panel('neutral', 'Meta Ads is not connected.', 'No marketing numbers are shown until it is.', '<a class="ox-panel-link" href="/marketing">Set up Meta Ads →</a>');
  if (s.unavailable) return panel('critical', 'Meta Ads data unavailable', esc(s.message), '<a class="ox-panel-link" href="/marketing">Open Marketing →</a>');
  if (s.pending) {
    return `<div class="ox-mk-grid"><div class="ox-mk-main">${panel('neutral', 'Loading Meta Ads…', esc(s.message))}
      <div class="ox-skel-grid" aria-hidden="true"><span class="sk lg"></span><span class="sk lg"></span><span class="sk lg"></span><span class="sk lg"></span></div></div></div>`;
  }
  const has = s.delivered || s.spend;
  const roasNote = s.roas_target ? `Target ${esc(s.roas_target)}×` : 'Revenue ÷ spend';
  const roasTone = s.roas_target && s.spend > 0 && s.roas !== null ? (s.roas >= s.roas_target ? 'healthy' : 'warning') : '';
  const delayed = s.stale ? `<p class="ox-delayed">${icon('triangle-alert')}<span><b>Data delayed.</b> ${esc(s.stale_reason || 'Meta did not answer the latest request.')} Showing the last successful update from ${esc(istDateTime(s.fetched_at))}.</span></p>` : '';
  const fresh = s.stale ? '<span class="health warning">Data delayed</span>' : '<span class="health healthy">Live</span>';
  return `${delayed}<div class="ox-mk-grid">
    <div class="ox-mk-main">
      <div class="ox-hero">
        ${stat('Spend', has ? mkMoney(s, s.spend) : '—', { href: '/marketing', cls: 'hero' })}
        ${stat('Meta-attributed revenue', has ? mkMoney(s, s.revenue) : '—', { href: '/marketing', note: 'Not Briyo\'s actual revenue', cls: 'hero' })}
        ${stat('Meta ROAS', s.roas === null ? '—' : `${s.roas.toFixed(2)}×`, { href: '/marketing', note: roasNote, tone: roasTone, cls: 'hero' })}
        ${stat('Purchases', has ? n(s.purchases) : '—', { href: '/marketing', cls: 'hero' })}
      </div>
      <div class="ox-eff" role="group" aria-label="Efficiency">
        ${stat('Cost / purchase', mkMoney(s, s.cpa), { cls: 'eff' })}
        ${stat('CTR', s.ctr === null || s.ctr === undefined ? '—' : `${s.ctr.toFixed(2)}%`, { cls: 'eff' })}
        ${stat('CPC', mkMoney(s, s.cpc, 2), { cls: 'eff' })}
        ${stat('CPM', mkMoney(s, s.cpm, 2), { cls: 'eff' })}
      </div>
      <div id="ovMkTrend">${mkTrend(s)}</div>
    </div>
    <aside class="ox-mk-aside" id="ovMkCamps" aria-label="Campaigns today">${mkCampaigns(s)}</aside>
  </div>
  <p class="ov-foot ox-foot">${fresh} · Meta Ads today · reporting day follows the ad account timezone${s.timezone ? ` (${esc(s.timezone)})` : ''} · <span title="${esc(istDateTime(s.fetched_at))}">updated ${esc(relative(s.fetched_at))}</span></p>`;
}

/** Trend and campaigns come from the Marketing page's own APIs (shared server cache); they fill in after the page. */
async function loadMarketingContext() {
  const s = state.data?.sections?.marketing;
  if (!s?.ok || !s.configured || s.unavailable || s.pending || state.mk.loading) return;
  state.mk.loading = true;
  const [trend, camps] = await Promise.allSettled([api('/api/marketing/summary?range=last_7d'), api('/api/marketing/campaigns?range=today')]);
  state.mk.loading = false;
  state.mk.trend = trend.status === 'fulfilled' ? trend.value : null;
  state.mk.campaigns = camps.status === 'fulfilled' ? camps.value : null;
  state.mk.done = true;
  // A refresh may have re-rendered meanwhile: fill whatever Marketing module is on the page now.
  const cur = state.data?.sections?.marketing;
  const t = document.getElementById('ovMkTrend'); const c = document.getElementById('ovMkCamps');
  if (!cur?.ok) return;
  if (t) t.innerHTML = mkTrend(cur);
  if (c) c.innerHTML = mkCampaigns(cur);
  renderIcons();
}

// ------------------------------------------------------------------ Departments

const BODIES = {
  marketing: marketingBody,

  // Flow first (where orders are), then the two exceptions that need a person.
  logistics: (s) => `
    <ol class="ox-flow" aria-label="Order flow">
      <li>${stat('Orders today', n(s.today), { href: '/orders' })}</li>
      <li>${stat('Pending dispatch', n(s.pending_dispatch), { href: '/orders?view=pending_dispatch' })}</li>
      <li>${stat('In transit', n(s.in_transit), { href: '/orders?view=in_transit' })}</li>
      <li>${stat('Delivered', n(s.delivered), { href: '/orders?view=delivered' })}</li>
    </ol>
    ${group('Exceptions', `${signal('Failed / RTO', s.failed, { href: '/orders?view=failed', tone: 'critical' })}
      ${signal('Open orders without a shipment', s.without_shipment, { href: '/orders?view=pending_dispatch', tone: 'warning' })}`)}`,

  // Catalogue and units on top; the stock and batch signals below, each calm at zero.
  inventory: (s) => {
    const tracked = s.stock_tracked;
    const waiting = 'Starts with the first batch';
    return `<div class="ox-stats c4">
        ${stat('Master SKUs', n(s.master_skus), { href: '/inventory' })}
        ${stat('In stock', tracked ? n(s.in_stock) : '—', { href: tracked ? '/inventory' : '', note: tracked ? 'SKUs with stock to dispatch' : waiting })}
        ${stat('Available units', n(s.available_units), { href: '/inventory' })}
        ${stat('Reserved units', n(s.reserved_units), { href: '/inventory', note: 'Held for shipments' })}
      </div>
      <div class="ox-split">
        ${group('Stock', tracked ? `${signal('Out of stock', s.out_of_stock, { href: '/inventory?stock=out', tone: 'warning' })}
          ${signal('Low stock', s.low_stock, { href: '/inventory?stock=low', tone: 'attention' })}
          ${signal('Unmapped platform SKUs', s.unmapped_skus, { href: '/inventory?view=unmapped', tone: 'warning' })}`
          : `<p class="ox-quiet">${waiting}.</p>${signal('Unmapped platform SKUs', s.unmapped_skus, { href: '/inventory?view=unmapped', tone: 'warning' })}`)}
        ${group('Batches', `${signal('Expired, still holding stock', s.expired_batches, { href: '/inventory?expiring=expired', tone: 'critical' })}
          ${signal('Expiring within 30 days', s.expiring_30, { href: '/inventory?expiring=30', tone: 'attention' })}`)}
      </div>`;
  },

  // The queue is the job: what is waiting, what is late, who owns it, what got done.
  support: (s) => `
    <div class="ox-stats c4">
      ${stat('Uncalled', n(s.not_called), { href: '/?mode=tocall' })}
      ${stat(`Past ${s.sla_hours}h SLA`, n(s.uncalled_past_sla), { href: '/?mode=tocall', tone: s.uncalled_past_sla > 0 ? 'warning' : '' })}
      ${stat('Callbacks due', n(s.callbacks_due), { href: '/?mode=callbacks', note: 'Today and overdue' })}
      ${stat('Callbacks overdue', n(s.callbacks_overdue), { href: '/?mode=callbacks', tone: s.callbacks_overdue > 0 ? 'critical' : '' })}
    </div>
    <div class="ox-split">
      ${group('Ownership', `${row('Unassigned', s.unassigned, { href: '/?mode=tocall', note: 'Uncalled, no owner' })}
        ${row('Assigned', s.assigned, { href: '/?mode=all', note: 'Open, with an owner' })}
        ${row('Assigned to you', s.assigned_to_me, { href: '/?mode=mine' })}`)}
      ${group('Today', `${row('Received', s.today.carts, { note: `${n(s.today.called)} called · ${n(s.today.recovered)} recovered${s.today.recovered_value ? ` (${money(s.today.recovered_value)})` : ''}` })}
        ${row('Worked', s.worked_today, { href: '/?mode=all', note: 'Carts updated today' })}
        ${row('Recovered', s.recovered_today, { href: '/?mode=all', tone: s.recovered_today > 0 ? 'healthy' : '' })}`)}
    </div>`,

  // Hiring as a pipeline: review → in progress → hired, with openings alongside.
  hr: (s) => `
    <ol class="ox-flow f3" aria-label="Hiring pipeline">
      <li>${stat('Awaiting review', n(s.awaiting_review), { href: '/hr/candidates?status=applied', tone: '' })}</li>
      <li>${stat('In progress', n(s.in_progress), { href: '/hr/candidates', note: 'Screening · interview · offer' })}</li>
      <li>${stat('Hired, 30 days', n(s.hired_30d), { href: '/hr/candidates?status=hired', tone: s.hired_30d > 0 ? 'healthy' : '' })}</li>
    </ol>
    ${group('', `<div class="ox-kv c4">
      <a href="/hr/jobs?status=published"><span class="ox-k">Open jobs</span><span class="ox-v num">${n(s.open_jobs)}</span></a>
      <a href="/hr/jobs?status=draft"><span class="ox-k">Drafts</span><span class="ox-v num">${n(s.draft_jobs)}</span></a>
      <a href="/hr/candidates"><span class="ox-k">Applications</span><span class="ox-v num">${n(s.applications)}<small>${n(s.candidates)} ${plural(s.candidates, 'candidate', 'candidates')}</small></span></a>
      <a href="/hr/candidates"><span class="ox-k">New this week</span><span class="ox-v num">${n(s.new_7d)}</span></a></div>`)}`,

  // A supporting strip: the team at a glance, with the two things an admin can fix.
  people: (s) => {
    const cat = state.me?.moduleCatalog || {};
    const depts = Object.entries(s.by_department || {}).map(([k, v]) => `<span class="ox-chipn">${esc(cat[k]?.label || k)} <b class="num">${n(v)}</b></span>`).join('');
    return `<div class="ox-people">
      <div class="ox-kv ox-strip">
        <a href="/admin"><span class="ox-k">Members</span><span class="ox-v num">${n(s.total)}</span></a>
        <a href="/admin"><span class="ox-k">Active</span><span class="ox-v num">${n(s.active)}${s.total !== s.active ? `<small>${n(s.total - s.active)} deactivated</small>` : ''}</span></a>
        <a href="/admin"><span class="ox-k">Admins</span><span class="ox-v num">${n(s.admins)}</span></a>
        <a href="/admin"><span class="ox-k">Online now</span><span class="ox-v num">${s.online > 0 ? '<span class="ox-live" aria-hidden="true"></span>' : ''}${n(s.online)}</span></a>
        <a href="/admin?filter=incomplete"><span class="ox-k">Incomplete profiles</span><span class="ox-v num${s.incomplete_profiles > 0 ? ' t-warning' : ''}">${n(s.incomplete_profiles)}</span></a>
        <a href="/admin?filter=no_access"><span class="ox-k">No department</span><span class="ox-v num">${n(s.no_access)}</span></a>
      </div>
      ${depts ? `<div class="ox-chips" aria-label="Members by department"><span class="ox-chips-label">By department</span>${depts}</div>` : ''}
    </div>`;
  },
};

function moduleHtml(k, s) {
  const dept = DEPTS[k];
  const [tone, word] = healthOf(k, s);
  const head = `<header class="ox-mod-head">
      <h2 id="ov-${k}"><a href="${dept.href}">${icon(dept.icon)}${esc(dept.label)}</a></h2>
      ${k === 'marketing' ? '<span class="ox-mod-sub">Meta Ads · today</span>' : ''}
      <span class="health ${tone}">${word}</span>
      <a class="ox-open" href="${dept.href}" aria-label="Open ${esc(dept.label)}">Open ${icon('arrow-right')}</a>
    </header>`;
  const body = s.ok ? BODIES[k](s)
    : '<div class="ox-panel p-critical"><b>Unavailable right now</b><span>This department could not be counted. Refresh to try again.</span></div>';
  return `<section class="ox-mod m-${k} tone-${tone}" id="mod-${k}" aria-labelledby="ov-${k}">${head}<div class="ox-mod-body">${body}</div></section>`;
}

// ------------------------------------------------------------------ Page

/** Operating status: counts by priority, quiet when healthy. Business context stays in the header. */
function pulse(d) {
  const items = d.attention || [];
  const by = (sev) => items.filter((a) => a.severity === sev).length;
  if (!items.length) return `<span class="ox-op-ok">${icon('circle-check')}Operating normally</span><span class="ox-op-quiet">Nothing needs intervention ${state.me?.isAdmin ? 'in any department' : 'in your departments'}.</span>`;
  const [c, w, r] = [by('critical'), by('warning'), by('attention')];
  const parts = [c && `<span class="ox-op-n sev-critical"><b class="num">${c}</b> critical</span>`, w && `<span class="ox-op-n sev-warning"><b class="num">${w}</b> ${plural(w, 'warning', 'warnings')}</span>`,
    r && `<span class="ox-op-n sev-attention"><b class="num">${r}</b> to review</span>`].filter(Boolean).join('');
  return `${parts}<a class="ox-pulse-link" href="#ox-attention">Review exceptions ${icon('arrow-down')}</a>`;
}

const SEV_GROUP = { critical: 'Critical', warning: 'Warnings', attention: 'To review' };

/** Exceptions, grouped by priority: critical first and loudest; items to review compact and quiet. */
function renderAttention(d) {
  const items = d.attention || [];
  const by = (sev) => items.filter((a) => a.severity === sev);
  $('#ovAttnMeta').textContent = items.length ? `${items.length} open ${plural(items.length, 'item', 'items')}` : '';
  const line = (a) => `<a class="ox-exc-row sev-${a.severity}" href="${a.href}">
      <span class="ox-exc-dept">${icon(DEPTS[a.dept]?.icon || 'circle')}${esc(DEPTS[a.dept]?.label || a.dept)}</span>
      <span class="ox-exc-text"><span class="sr-only">${SEV_LABEL[a.severity]}: </span>${a.count !== null ? `<b class="num">${n(a.count)}</b> ` : ''}${esc(a.text)}</span>
      <span class="ox-exc-go" aria-hidden="true">${icon('arrow-right')}</span></a>`;
  $('#ovAttention').innerHTML = items.length
    ? ['critical', 'warning', 'attention'].filter((sv) => by(sv).length).map((sv) => `
      <div class="ox-exc-group g-${sv}" role="group" aria-label="${SEV_GROUP[sv]}: ${by(sv).length}">
        <h3 class="ox-exc-gh"><span class="health ${sv}">${SEV_GROUP[sv]}</span><span class="num">${by(sv).length}</span></h3>
        <div class="ox-exc-list">${by(sv).map(line).join('')}</div>
      </div>`).join('')
    : `<p class="ox-clear">${icon('circle-check')}<span><b>All clear.</b> Nothing needs intervention right now — every department ${state.me?.isAdmin ? '' : 'you can see '}is up to date.</span></p>`;
}

function render() {
  const d = state.data;
  const tz = d.timezone || 'Asia/Kolkata';
  const first = String(state.me?.name || '').split(/\s+/)[0];
  $('#ovDate').textContent = `${today(tz)} · IST`;
  $('#ovHello').textContent = `${greeting(tz)}${first && first !== 'Team' ? `, ${first}` : ''}. ${state.me?.isAdmin ? 'The state of Briyo, department by department.' : 'Your departments at a glance.'}`;
  $('#ovSub').innerHTML = pulse(d);
  updated();

  const keys = Object.keys(d.sections).filter((k) => DEPTS[k]);
  // Status strip: one line per visible department; each jumps to its module.
  $('#ovStatus').innerHTML = keys.length > 1 ? ROWS.flat().filter((k) => keys.includes(k)).map((k) => {
    const [tone, word] = healthOf(k, d.sections[k]);
    return `<a class="ox-chip tone-${tone}" href="#mod-${k}" aria-label="${esc(DEPTS[k].label)}: ${esc(word)}"><span class="ox-chip-dot" aria-hidden="true"></span><span class="ox-chip-name">${esc(DEPTS[k].label)}</span><span class="ox-chip-word">${esc(word)}</span></a>`;
  }).join('') : '';

  const body = $('#ovDepts');
  body.innerHTML = ROWS.map((row) => row.filter((k) => keys.includes(k)))
    .filter((row) => row.length)
    .map((row) => (row.length === 1 && (row[0] === 'marketing' || row[0] === 'people')
      ? moduleHtml(row[0], d.sections[row[0]])
      : `<div class="ox-row${row.length === 1 ? ' solo' : ''}">${row.map((k) => moduleHtml(k, d.sections[k])).join('')}</div>`))
    .join('');
  body.removeAttribute('aria-busy');
  renderAttention(d);
  renderIcons();
  loadMarketingContext();
}

function updated() {
  if (state.data) $('#ovUpdated').innerHTML = `<span title="${esc(istDateTime(state.data.generated_at))}">Updated ${esc(relative(state.data.generated_at))}</span>`;
}

async function load() {
  const btn = $('#ovRefresh');
  btn.disabled = true; btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true');
  try {
    state.data = await api('/api/overview');
    render();
  } catch (err) {
    $('#ovDepts').innerHTML = `<div class="ox-panel p-critical"><b>The overview could not be loaded.</b><span>${esc(err.message)}</span><button class="btn" type="button" data-retry>Try again</button></div>`;
    $('#ovDepts').removeAttribute('aria-busy');
    $('#ovSub').textContent = '';
    renderIcons();
  } finally { btn.disabled = false; btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); }
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    $('#ovRefresh').addEventListener('click', load);
    $('#ovDepts').addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) load(); });
    // In-page jumps (status chips, "Review exceptions"): scroll and move focus here, without a hash change —
    // a hash change would reach the shell router's popstate handler and re-render the page at the top.
    document.querySelector('main').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      const target = a && document.getElementById(a.getAttribute('href').slice(1));
      if (!target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }, { signal: pageSignal() });
    await load();
    // Refresh quietly every two minutes while the page is open and visible; keep "Updated" honest in between.
    state.timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120000);
    state.tick = setInterval(updated, 30000);
    onLeave(() => { clearInterval(state.timer); clearInterval(state.tick); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.data && Date.now() - new Date(state.data.generated_at) > 120000) load(); }, { signal: pageSignal() });
  } catch (err) {
    $('#ovSub').textContent = '';
    $('#ovDepts').innerHTML = `<div class="ox-panel p-critical"><b>Briyo OS could not load.</b><span>${esc(err.message)}</span></div>`;
  }
}());
