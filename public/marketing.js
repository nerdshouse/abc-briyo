/**
 * Marketing — Meta Ads, read-only and admin-only. Every number comes from
 * /api/marketing/* (Briyo OS server → cache → Meta); the browser never talks
 * to Meta. Freshness is always visible: Live / Data delayed / Unavailable.
 * Revenue is "Meta-attributed revenue" and ROAS is "Meta ROAS" — not Briyo's
 * actual revenue.
 *
 * Views (one page, URL-driven):  /marketing                overview
 *                                 /marketing?view=campaigns campaign table
 *                                 /marketing?campaign=ID    campaign → ad sets
 *                                 /marketing?adset=ID       ad set → ads
 */
import { $, $$, esc, count, icon, renderIcons, initShell, pageFetch, pageSignal, onLeave, onQueryChange, navigate } from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7d', 'Last 7 days'], ['last_30d', 'Last 30 days'], ['this_month', 'This month'], ['custom', 'Custom']];
// Live = includes today. Meta's Last 7 / Last 30 days are complete days that exclude today: closed periods.
const LIVE_RANGES = new Set(['today', 'this_month']);
const SERIES = { spend: { label: 'Spend', color: '#2a78d6' }, revenue: { label: 'Meta-attributed revenue', color: '#eb6834' } };
const state = {
  me: null, status: null, range: 'today', since: '', until: '', view: 'overview', campaign: null, adset: null,
  data: null, fetchedAt: null, stale: false, staleReason: null, error: null, loading: false,
  sort: { key: 'spend', dir: -1 }, q: '', statusFilter: 'all', timer: null, tick: null,
};

const api = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, kind: data.kind });
  return data;
};

// ------------------------------------------------------------------ formatting

const cur = () => state.status?.account?.currency || 'INR';
const money = (v, { digits = 0 } = {}) => (v === null || v === undefined ? '—'
  : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur(), maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v));
const moneyFine = (v) => money(v, { digits: v !== null && v < 100 ? 2 : 0 });
const pct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}%`);
const roas = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}×`);
const n = (v) => (v === null || v === undefined ? '—' : count(v));
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const STATUS = {
  ACTIVE: ['info', 'Active'], PAUSED: ['neutral', 'Paused'], CAMPAIGN_PAUSED: ['neutral', 'Campaign paused'], ADSET_PAUSED: ['neutral', 'Ad set paused'],
  ARCHIVED: ['neutral', 'Archived'], DELETED: ['neutral', 'Deleted'], IN_PROCESS: ['info', 'In process'], PENDING_REVIEW: ['info', 'In review'],
  PREAPPROVED: ['info', 'Pre-approved'], DISAPPROVED: ['bad', 'Disapproved'], WITH_ISSUES: ['bad', 'With issues'], PENDING_BILLING_INFO: ['warn', 'Billing info needed'],
};
const statusTag = (s) => { const [tone, label] = STATUS[s] || ['neutral', String(s || '—').replace(/_/g, ' ').toLowerCase()]; return `<span class="status ${tone}"><span class="dot"></span>${esc(label)}</span>`; };
/** ROAS health only against an admin-set target; otherwise neutral (no invented thresholds). */
function roasHealth(m) {
  const t = state.status?.roasTarget;
  if (!t || m.roas === null || !m.spend) return '';
  return m.roas >= t ? '<span class="health healthy">On target</span>' : '<span class="health warning">Below target</span>';
}

// ------------------------------------------------------------------ URL & range

function readUrl() {
  const u = new URLSearchParams(window.location.search);
  state.range = RANGES.some(([k]) => k === u.get('range')) ? u.get('range') : 'today';
  state.since = u.get('since') || ''; state.until = u.get('until') || '';
  state.campaign = /^\d+$/.test(u.get('campaign') || '') ? u.get('campaign') : null;
  state.adset = /^\d+$/.test(u.get('adset') || '') ? u.get('adset') : null;
  state.view = state.adset ? 'adset' : state.campaign ? 'campaign' : u.get('view') === 'campaigns' ? 'campaigns' : 'overview';
}
const rangeQuery = () => {
  const u = new URLSearchParams({ range: state.range });
  if (state.range === 'custom') { u.set('since', state.since); u.set('until', state.until); }
  return u.toString();
};
function linkTo(extra = {}) {
  const u = new URLSearchParams();
  if (state.range !== 'today') u.set('range', state.range);
  if (state.range === 'custom') { u.set('since', state.since); u.set('until', state.until); }
  for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
  return `/marketing${u.toString() ? `?${u}` : ''}`;
}
/** Today in the ad account's timezone (what Meta means by "today"), not UTC and not the browser's. */
function accountToday(now = new Date()) {
  const tz = state.status?.account?.timezone;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
}
const shiftDay = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isLive = () => LIVE_RANGES.has(state.range) || (state.range === 'custom' && state.until === accountToday());

function renderRange() {
  const today = accountToday();
  $('#rangeBar').innerHTML = `<div class="seg">${RANGES.map(([k, l]) => `<button type="button" data-range="${k}" class="${state.range === k ? 'active' : ''}" aria-pressed="${state.range === k}">${l}</button>`).join('')}</div>
    ${state.range === 'custom' ? `<span class="mk-custom"><label class="date-pick">From <input class="input" type="date" id="since" value="${esc(state.since)}" max="${today}" /></label>
      <label class="date-pick">to <input class="input" type="date" id="until" value="${esc(state.until)}" max="${today}" /></label>
      <button class="btn" type="button" id="applyCustom">Apply</button></span>` : ''}
    ${state.status?.account?.timezone ? `<span class="mk-tz">Days follow the ad account's timezone (${esc(state.status.account.timezone)})${state.range === 'last_7d' || state.range === 'last_30d' ? ' · complete days, excluding today' : ''}</span>` : ''}`;
}

// ------------------------------------------------------------------ freshness

function renderFresh() {
  const el = $('#fresh');
  if (state.error && !state.data) { el.innerHTML = '<span class="health critical">Unavailable</span>'; return; }
  if (!state.fetchedAt) { el.textContent = ''; return; }
  if (state.stale) { el.innerHTML = `<span class="health warning">Data delayed</span><span class="soft">Last successful update ${ago(state.fetchedAt)}</span>`; return; }
  el.innerHTML = isLive()
    ? `<span class="health healthy">Live</span><span class="soft" title="${esc(istDateTime(state.fetchedAt))}">Updated ${ago(state.fetchedAt)}</span>`
    : `<span class="health attention">Closed period</span><span class="soft" title="${esc(istDateTime(state.fetchedAt))}">Fetched ${ago(state.fetchedAt)}</span>`;
}

// ------------------------------------------------------------------ pieces

function kpis(t, { delivered = true } = {}) {
  const tile = (label, value, note = '') => `<div class="ov-metric mk-kpi"><span class="ov-m-label">${label}</span><span class="ov-m-value num">${value}</span>${note ? `<span class="ov-m-note">${note}</span>` : ''}</div>`;
  const d = (v) => (delivered ? v : '—');
  return `<section class="card mk-kpis" aria-label="Key metrics">
    ${tile('Spend', d(money(t.spend)))}
    ${tile('Meta-attributed revenue', d(money(t.revenue)), 'Purchase value Meta attributes to ads')}
    ${tile('Meta ROAS', d(roas(t.roas)), roasHealth(t) || (t.spend ? 'Revenue ÷ spend' : ''))}
    ${tile('Purchases', d(n(t.purchases)))}
    ${tile('Cost / purchase', d(moneyFine(t.cpa)))}
    ${tile('CTR', d(pct(t.ctr)), 'All clicks ÷ impressions')}
    ${tile('CPC', d(moneyFine(t.cpc)))}
    ${tile('CPM', d(moneyFine(t.cpm)))}
  </section>`;
}

/** Spend vs Meta-attributed revenue by day: one ₹ axis, two lines, crosshair tooltip, legend, table view. */
function trendChart(trend, title = 'Spend vs Meta-attributed revenue') {
  if (!trend || trend.length < 2) {
    return `<section class="card mk-trend"><header class="card-head"><h2 class="card-title">${icon('chart-line')}${esc(title)}</h2></header>
      <div class="state"><b>No daily trend for a single day.</b><span>Choose Last 7 days, Last 30 days or This month to see the trend.</span></div></section>`;
  }
  // Drawn at the width it is shown, so axis text stays 11 px on phones too.
  const W = Math.round(Math.max(300, Math.min(1200, (document.querySelector('#view')?.clientWidth || 760) - 26))); const H = 220; const P = { l: 56, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...trend.map((d) => Math.max(d.spend || 0, d.revenue || 0)));
  const step = 10 ** Math.floor(Math.log10(max)); const top = Math.ceil(max / step) * step;
  const x = (i) => P.l + (i * (W - P.l - P.r)) / (trend.length - 1);
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const path = (k) => trend.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k] || 0).toFixed(1)}`).join('');
  const ticks = [0, 0.5, 1].map((f) => top * f);
  const short = (v) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1, style: 'currency', currency: cur() }).format(v);
  const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const every = Math.ceil(trend.length / Math.max(3, Math.floor(W / 95)));
  const last = trend[trend.length - 1];
  return `<section class="card mk-trend" aria-labelledby="trendTitle">
    <header class="card-head"><h2 class="card-title" id="trendTitle">${icon('chart-line')}${esc(title)}</h2>
      <span class="mk-legend">${Object.values(SERIES).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</span></header>
    <div class="mk-chart" data-chart>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)} by day">
        ${ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" class="mk-grid"/><text x="${P.l - 8}" y="${y(v) + 4}" class="mk-axis" text-anchor="end">${esc(short(v))}</text>`).join('')}
        ${trend.map((d, i) => ((i % every === 0 && trend.length - 1 - i >= every / 2) || i === trend.length - 1 ? `<text x="${x(i)}" y="${H - 6}" class="mk-axis" text-anchor="${i === trend.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}">${esc(dayLabel(d.date))}</text>` : '')).join('')}
        <path d="${path('spend')}" fill="none" stroke="${SERIES.spend.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <path d="${path('revenue')}" fill="none" stroke="${SERIES.revenue.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
        <line class="mk-cross" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" hidden/>
        <circle class="mk-dot" r="4" fill="${SERIES.spend.color}" stroke="#fff" stroke-width="2" hidden data-k="spend"/>
        <circle class="mk-dot" r="4" fill="${SERIES.revenue.color}" stroke="#fff" stroke-width="2" hidden data-k="revenue"/>
        <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" class="mk-hit" tabindex="0" aria-label="Move across to read each day"/>
      </svg>
      <p class="mk-direct">Last day (${esc(dayLabel(last.date))}): spend <b>${money(last.spend)}</b> · Meta-attributed revenue <b>${money(last.revenue)}</b></p>
    </div>
    <details class="mk-table-view"><summary>Show as table</summary>
      <div class="table-wrap"><table class="table compact"><thead><tr><th>Day</th><th class="r">Spend</th><th class="r">Meta-attributed revenue</th><th class="r">Meta ROAS</th><th class="r">Purchases</th></tr></thead>
      <tbody>${trend.map((d) => `<tr><td>${esc(dayLabel(d.date))}</td><td class="r num">${money(d.spend)}</td><td class="r num">${money(d.revenue)}</td><td class="r num">${roas(d.roas)}</td><td class="r num">${n(d.purchases)}</td></tr>`).join('')}</tbody></table></div>
    </details>
  </section>`;
}

function bindChart(trend) {
  const box = document.querySelector('[data-chart]');
  if (!box || !trend || trend.length < 2) return;
  const svg = box.querySelector('svg'); const hit = svg.querySelector('.mk-hit'); const tip = $('#tip');
  const cross = svg.querySelector('.mk-cross'); const dots = [...svg.querySelectorAll('.mk-dot')];
  const vb = svg.viewBox.baseVal; const P = { l: 56, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...trend.map((d) => Math.max(d.spend || 0, d.revenue || 0)));
  const step = 10 ** Math.floor(Math.log10(max)); const top = Math.ceil(max / step) * step;
  const show = (i, clientX, clientY) => {
    const d = trend[i]; const xi = P.l + (i * (vb.width - P.l - P.r)) / (trend.length - 1);
    cross.setAttribute('x1', xi); cross.setAttribute('x2', xi); cross.hidden = false;
    for (const dot of dots) { dot.setAttribute('cx', xi); dot.setAttribute('cy', P.t + (vb.height - P.t - P.b) * (1 - (d[dot.dataset.k] || 0) / top)); dot.hidden = false; }
    tip.replaceChildren();
    const h = document.createElement('b'); h.textContent = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); tip.appendChild(h);
    for (const [k, s] of Object.entries(SERIES)) {
      const row = document.createElement('div'); const key = document.createElement('i'); key.style.background = s.color;
      const v = document.createElement('strong'); v.textContent = money(d[k]); const l = document.createElement('span'); l.textContent = s.label;
      row.append(key, v, l); tip.appendChild(row);
    }
    const extra = document.createElement('div'); extra.className = 'soft'; extra.textContent = `Meta ROAS ${roas(d.roas)} · ${n(d.purchases)} purchases`; tip.appendChild(extra);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, clientX + 12)}px`; tip.style.top = `${Math.max(8, clientY - r.height - 12)}px`;
  };
  const hide = () => { cross.hidden = true; dots.forEach((d) => { d.hidden = true; }); tip.hidden = true; };
  const idxAt = (clientX) => {
    const b = svg.getBoundingClientRect(); const xv = ((clientX - b.left) / b.width) * vb.width;
    return Math.max(0, Math.min(trend.length - 1, Math.round(((xv - P.l) / (vb.width - P.l - P.r)) * (trend.length - 1))));
  };
  hit.addEventListener('pointermove', (e) => show(idxAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', hide);
  let ki = trend.length - 1;
  hit.addEventListener('focus', () => { const b = hit.getBoundingClientRect(); show(ki, b.right - 20, b.top + 20); });
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); ki = Math.max(0, Math.min(trend.length - 1, ki + (e.key === 'ArrowRight' ? 1 : -1)));
    const b = hit.getBoundingClientRect(); show(ki, b.left + (ki / (trend.length - 1)) * b.width, b.top + 20);
  });
}

const COLS = [
  ['name', 'Name', false], ['status', 'Status', false], ['spend', 'Spend', true], ['purchases', 'Purchases', true], ['revenue', 'Meta revenue', true],
  ['roas', 'Meta ROAS', true], ['cpa', 'CPA', true], ['ctr', 'CTR', true], ['cpc', 'CPC', true], ['cpm', 'CPM', true],
];
function perfTable(rows, { kind, link, empty }) {
  const q = state.q.toLowerCase();
  const filtered = rows.filter((r) => (!q || r.name.toLowerCase().includes(q))
    && (state.statusFilter === 'all' || (state.statusFilter === 'active' ? r.status === 'ACTIVE' : state.statusFilter === 'delivered' ? r.delivered : r.status !== 'ACTIVE')));
  const { key, dir } = state.sort;
  const sorted = [...filtered].sort((a, b) => {
    const av = a[key]; const bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') return dir * String(av ?? '').localeCompare(String(bv ?? ''));
    if (av === null || av === undefined) return 1; if (bv === null || bv === undefined) return -1;
    return dir * (av - bv);
  });
  const cell = (r, k) => {
    if (!r.delivered && ['spend', 'purchases', 'revenue', 'roas', 'cpa', 'ctr', 'cpc', 'cpm'].includes(k)) return '<span class="muted-cell">—</span>';
    return { spend: money(r.spend), purchases: n(r.purchases), revenue: money(r.revenue), roas: `${roas(r.roas)} ${roasHealth(r)}`, cpa: moneyFine(r.cpa), ctr: pct(r.ctr), cpc: moneyFine(r.cpc), cpm: moneyFine(r.cpm) }[k];
  };
  const label = { campaign: 'campaigns', adset: 'ad sets', ad: 'ads' }[kind];
  const body = sorted.length ? sorted.map((r) => `<tr class="${link ? 'orow' : ''}" ${link ? `data-href="${esc(link(r))}" tabindex="0"` : ''}>
      <td><span class="cell-main" style="font-weight:500">${esc(r.name)}</span>${r.objective ? `<span class="cell-sub muted">${esc(r.objective.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase())}</span>` : ''}</td>
      <td>${statusTag(r.status)}</td>
      ${COLS.slice(2).map(([k]) => `<td class="r num">${cell(r, k)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${COLS.length}"><div class="state">${icon('search-x')}<b>${rows.length ? 'Nothing matches.' : esc(empty)}</b>${rows.length ? '<span>Clear the search or filter.</span>' : ''}</div></td></tr>`;
  return `<div class="board-filters">
      <label class="search">${icon('search')}<input class="input" id="tq" type="search" placeholder="Search ${label}" aria-label="Search ${label}" value="${esc(state.q)}" autocomplete="off" /></label>
      <select class="select" id="tstatus" aria-label="Filter by status">
        ${[['all', 'All statuses'], ['active', 'Active'], ['delivered', 'Delivered in range'], ['inactive', 'Not active']].map(([v, l]) => `<option value="${v}"${state.statusFilter === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="board-meta">${count(sorted.length)} of ${count(rows.length)} ${label}${rows.some((r) => !r.delivered) ? ' · "—" means no delivery in this range' : ''}</div>
    <div class="table-wrap"><table class="table mk-table">
      <thead><tr>${COLS.map(([k, l, numeric]) => `<th class="${numeric ? 'r' : ''}" aria-sort="${state.sort.key === k ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="mk-sort" data-sort="${k}">${l}${state.sort.key === k ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

// ------------------------------------------------------------------ views

function notConnected() {
  return `<section class="card"><div class="state">${icon('plug-zap')}<b>Meta Ads is not connected yet.</b>
    <span>An admin adds the Meta system-user token and ad account in Render. Until then, no numbers are shown here — nothing is estimated.</span></div>
    <div class="pane mk-setup"><h3 class="dsec-title">Setup</h3><ol>
      <li>Meta Business Settings › System users: create a system user (Employee).</li>
      <li>Assign the Briyo ad account to it with view-performance access only.</li>
      <li>Create a Business app with the Marketing API product; turn on Require App Secret.</li>
      <li>Generate a system-user token with <b>ads_read</b> only.</li>
      <li>In Render (abc-briyo-sg) set META_ACCESS_TOKEN, META_AD_ACCOUNT_ID and META_APP_SECRET.</li>
    </ol></div></section>`;
}
function unavailable(msg) {
  return `<section class="card"><div class="state error">${icon('cloud-off')}<b>Meta Ads data unavailable</b><span>${esc(msg)}</span>
    ${state.fetchedAt ? `<span>Last successful update: ${esc(istDateTime(state.fetchedAt))}</span>` : ''}
    <button class="btn" type="button" data-retry>Try again</button></div></section>`;
}

function render() {
  renderRange(); renderFresh();
  const acct = state.status?.account;
  $('#pageSub').innerHTML = acct ? `Meta Ads · ${esc(acct.name)} · ${esc(acct.currency)}` : 'Meta Ads';
  $('#foot').textContent = 'Read-only. Figures come from Meta, which refreshes insights about every 15 minutes; recent conversions can still change for several days. "Meta-attributed revenue" is the purchase value Meta credits to ads — not Briyo\'s actual revenue.';
  if (!state.status?.configured) { $('#view').innerHTML = notConnected(); renderIcons(); return; }
  if (state.error && !state.data) { $('#view').innerHTML = unavailable(state.error); renderIcons(); return; }
  if (!state.data) { $('#view').innerHTML = '<div class="state loading" aria-busy="true"><b>Loading Meta Ads…</b></div>'; return; }
  const d = state.data;
  const delayed = state.stale ? `<div class="alert warn">${icon('triangle-alert')}<span><b>Data delayed.</b> ${esc(state.staleReason?.message || 'Meta did not answer the latest request.')} Showing the last successful update from ${esc(istDateTime(state.fetchedAt))}.</span></div>` : '';
  const back = (href, label) => `<a class="mk-back" href="${href}">${icon('arrow-left')}${esc(label)}</a>`;
  let html = delayed;
  if (state.view === 'overview') {
    $('#pageTitle').textContent = 'Marketing'; $('#crumbHere').textContent = 'Marketing';
    html += kpis(d.summary.totals, { delivered: d.summary.delivered || d.summary.totals.spend > 0 });
    html += trendChart(d.summary.trend);
    html += `<section class="card"><header class="card-head"><h2 class="card-title">${icon('megaphone')}Campaigns</h2><a class="ov-open" href="${linkTo({ view: 'campaigns' })}">All campaigns ${icon('arrow-right')}</a></header>
      <div class="pane">${perfTable(d.campaigns.rows, { kind: 'campaign', link: (r) => linkTo({ campaign: r.id }), empty: 'No campaigns in this ad account.' })}</div></section>`;
  } else if (state.view === 'campaigns') {
    $('#pageTitle').textContent = 'Campaigns'; $('#crumbHere').textContent = 'Campaigns';
    html += `<section class="card"><div class="pane">${perfTable(d.campaigns.rows, { kind: 'campaign', link: (r) => linkTo({ campaign: r.id }), empty: 'No campaigns in this ad account.' })}</div></section>`;
  } else if (state.view === 'campaign') {
    $('#pageTitle').textContent = d.name; $('#crumbHere').textContent = 'Campaign';
    html += `${back(linkTo({ view: 'campaigns' }), 'All campaigns')}<p class="mk-meta">${statusTag(d.status)}${d.objective ? ` · ${esc(d.objective.replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase())}` : ''}</p>`;
    html += kpis(d.totals, { delivered: d.delivered });
    html += trendChart(d.trend);
    html += `<section class="card"><header class="card-head"><h2 class="card-title">${icon('layers')}Ad sets</h2></header><div class="pane">${perfTable(d.adsets, { kind: 'adset', link: (r) => linkTo({ adset: r.id }), empty: 'No ad sets in this campaign.' })}</div></section>`;
  } else {
    $('#pageTitle').textContent = d.name; $('#crumbHere').textContent = 'Ad set';
    html += `${back(d.campaignId ? linkTo({ campaign: d.campaignId }) : linkTo({ view: 'campaigns' }), 'Back to campaign')}<p class="mk-meta">${statusTag(d.status)}</p>`;
    html += kpis(d.totals, { delivered: d.delivered });
    html += trendChart(d.trend);
    html += `<section class="card"><header class="card-head"><h2 class="card-title">${icon('image')}Ads</h2></header><div class="pane">${perfTable(d.ads, { kind: 'ad', empty: 'No ads in this ad set.' })}</div></section>`;
  }
  $('#view').innerHTML = html;
  document.title = state.view === 'overview' ? 'Marketing — Briyo OS' : `${$('#pageTitle').textContent} — Marketing — Briyo OS`;
  bindChart(state.view === 'overview' ? d.summary.trend : d.trend);
  renderIcons();
}

// ------------------------------------------------------------------ data

async function load({ refresh = false } = {}) {
  if (!state.status?.configured) { render(); return; }
  if (state.range === 'custom' && (!state.since || !state.until)) { state.data = null; state.error = null; render(); $('#view').innerHTML = '<div class="state"><b>Choose a start and end date.</b><span>Custom ranges can cover up to 92 days.</span></div>'; return; }
  state.loading = true; $('#refresh').disabled = true;
  const q = `${rangeQuery()}${refresh ? '&refresh=1' : ''}`;
  try {
    let data;
    if (state.view === 'campaign') data = await api(`/api/marketing/campaigns/${state.campaign}?${q}`);
    else if (state.view === 'adset') data = await api(`/api/marketing/adsets/${state.adset}?${q}`);
    else {
      const [summary, campaigns] = await Promise.all([api(`/api/marketing/summary?${q}`), api(`/api/marketing/campaigns?${q}`)]);
      data = { summary, campaigns, fetchedAt: summary.fetchedAt < campaigns.fetchedAt ? summary.fetchedAt : campaigns.fetchedAt, stale: summary.stale || campaigns.stale, staleReason: summary.staleReason || campaigns.staleReason };
    }
    state.data = data; state.fetchedAt = data.fetchedAt; state.stale = Boolean(data.stale); state.staleReason = data.staleReason || null; state.error = null;
  } catch (err) {
    state.error = err.message;
    if (err.kind === 'bad_request') state.data = null;
    // What is on screen is no longer current: say so, never keep calling it live.
    else if (state.data) { state.stale = true; state.staleReason = { message: err.message }; }
  } finally { state.loading = false; $('#refresh').disabled = false; }
  render();
}

function schedule() {
  clearInterval(state.timer); clearInterval(state.tick);
  // Live ranges re-read every 60 s while visible (the server cache keeps Meta calls to one per ~45 s for everyone).
  state.timer = setInterval(() => { if (document.visibilityState === 'visible' && isLive() && !state.loading) load(); }, 60000);
  state.tick = setInterval(renderFresh, 5000);
}

function bind() {
  const sig = { signal: pageSignal() };
  $('#refresh').addEventListener('click', () => load({ refresh: true }));
  $('#rangeBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) {
      state.range = b.dataset.range;
      if (state.range === 'custom' && !state.since) { state.until = accountToday(); state.since = shiftDay(state.until, -6); }
      history.replaceState(history.state, '', linkTo(state.view === 'campaign' ? { campaign: state.campaign } : state.view === 'adset' ? { adset: state.adset } : state.view === 'campaigns' ? { view: 'campaigns' } : {}));
      state.data = null; render(); load(); return;
    }
    if (e.target.id === 'applyCustom') {
      state.since = $('#since').value; state.until = $('#until').value;
      history.replaceState(history.state, '', linkTo(state.view === 'campaign' ? { campaign: state.campaign } : state.view === 'adset' ? { adset: state.adset } : {}));
      state.data = null; load();
    }
  });
  $('#view').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) { load({ refresh: true }); return; }
    const s = e.target.closest('[data-sort]');
    if (s) { const k = s.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'name' || k === 'status' ? 1 : -1) }; render(); return; }
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button')) navigate(row.dataset.href);
  });
  $('#view').addEventListener('keydown', (e) => { const row = e.target.closest('tr[data-href]'); if (row && e.key === 'Enter') navigate(row.dataset.href); });
  $('#view').addEventListener('input', (e) => { if (e.target.id === 'tq') { state.q = e.target.value; const pos = e.target.selectionStart; render(); const i = $('#tq'); i.focus(); i.setSelectionRange(pos, pos); } });
  $('#view').addEventListener('change', (e) => { if (e.target.id === 'tstatus') { state.statusFilter = e.target.value; render(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isLive() && state.fetchedAt && Date.now() - new Date(state.fetchedAt) > 60000) load(); }, sig);
  onQueryChange(async () => { readUrl(); state.data = null; state.q = ''; state.statusFilter = 'all'; render(); await load(); });
  onLeave(() => { clearInterval(state.timer); clearInterval(state.tick); $('#tip')?.setAttribute('hidden', ''); });
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    readUrl();
    state.status = await api('/api/marketing/status');
    if (state.status.connectionError) state.error = state.status.connectionError.message;
    bind(); render(); schedule();
    await load();
  } catch (err) {
    $('#view').innerHTML = `<div class="state error"><b>Marketing could not load.</b><span>${esc(err.message)}</span></div>`;
  }
}());
