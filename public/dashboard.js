/**
 * Admin dashboard: operations first, recovery below.
 *
 * Reads only existing endpoints — /api/orders, /api/inventory for the
 * operational view; /api/admin/overview, /api/admin/report, /api/admin/events,
 * /api/admin/carts, /api/carts, /api/reasons/summary for recovery — so it
 * changes nothing about the API or the data. Every panel loads and fails
 * independently: one slow or broken endpoint never blanks the page.
 */
import {
  $, $$, esc, money, count, pct, icon, renderIcons, setTimezone, dayKey, lastDays,
  clock, dateShort, dateTime, relative, duration, delta, metricCard, barChart, keyLabel,
  statusOf, statusIndicator, followUp, hbars, initials, initShell, setNavCount, STATUS_LABELS,
  pageSignal, onLeave, pageFetch,
} from './ui/components.js';

// Requests belong to this page: cancelled, and never rendered, once it is left.
const fetch = pageFetch();

const state = {
  days: 7,
  overview: null,
  daily: new Map(),        // YYYY-MM-DD -> daily report row
  carts: [],
  callbackTotal: 0,
  events: [],
  tab: 'today',
  actQ: '',
  metric: 'carts',
  filters: { q: '', status: '', owner: '', reason: '' },
  sort: { key: 'received_at', dir: -1 },
  shown: 12,
  period: 'day',
  ops: null,               // { orders, total, viewCounts, todayTotal, complete }
  inv: null,               // /api/inventory: cards + unmapped
  allCarts: null,          // all-time cart count (overview with days=0)
};

const SOURCE_NAME = { gokwik: 'GoKwik', shopify: 'Shopify (live)', 'shopify-csv': 'Shopify (CSV)' };

/* ------------------------------------------------------------------ fetch */

async function getJSON(url) {
  const res = await fetch(url);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Signed out'); }
  if (res.status === 403) throw new Error('Admins only.');
  const d = await res.json();
  if ('ok' in d && !d.ok) throw new Error(d.error || 'Request failed');
  return d;
}

/* ------------------------------------------------------------------ periods */

/** "vs yesterday" / "vs previous 7 days" — what the comparison is against. */
const compareLabel = () => (state.days === 1 ? 'vs yesterday'
  : state.days ? `vs prior ${state.days} days` : 'All time');

/**
 * Sum the daily report over `n` days ending `offset` days ago. The report is
 * bucketed by abandonment date in the board's timezone, and days with no carts
 * are absent from it, so every day in the window is filled explicitly.
 */
function windowOf(n, offset = 0) {
  const keys = lastDays(n, offset);
  const f = ['carts', 'worked', 'recovered', 'recovered_value'];
  const sum = Object.fromEntries(f.map((k) => [k, 0]));
  const series = Object.fromEntries(f.map((k) => [k, []]));
  for (const key of keys) {
    const row = state.daily.get(key) || {};
    for (const k of f) {
      const v = Number(row[k] || 0);
      sum[k] += v;
      series[k].push(v);
    }
  }
  return { keys, sum, series };
}

/* ------------------------------------------------------------------ header + alerts */

function greet(me) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = String(me?.name || '').split(' ')[0];
  $('#hello').textContent = first ? `${part}, ${first}` : 'Dashboard';
  $('#helloSub').textContent = 'Here’s what needs attention today.';
}

/**
 * Only the failures nothing else on the page shows. Uncalled carts used to be
 * repeated here; they now live in Needs attention, one place instead of two.
 */
function renderAlerts(h) {
  const items = [];
  if (h.ingestSilent) {
    items.push(['error', `No carts received for ${Math.round(h.lastIngestAgeMinutes / 60)}h — check the GoKwik webhook.`]);
  }
  if (h.webhookFailures24h) {
    items.push(['error', `${h.webhookFailures24h} webhook delivery failure${h.webhookFailures24h === 1 ? '' : 's'} in the last 24 hours.`]);
  }
  $('#alerts').innerHTML = items.map(([tone, text]) => `
    <div class="alert${tone === 'warn' ? ' warn' : ''}" role="alert">${icon('triangle-alert')}<p>${esc(text)}</p></div>`).join('');
}

/* ------------------------------------------------------------------ operations
   Order numbers here are the channel's own (#2753), never the internal ID.
   Totals that need every order (lines, shipments, documents, "no shipment
   yet") are shown only when the list fetched really is every order. */

const ORDER_LIST_MAX = 500;
const LABELS = { rto: 'RTO', not_ready: 'Not ready', out_for_delivery: 'Out for delivery', delivery_failed: 'Delivery failed', in_transit: 'In transit' };
const labelOf = (v) => (v ? LABELS[v] || (v[0].toUpperCase() + v.slice(1)).replaceAll('_', ' ') : '—');
// Same dot palette as the Orders page.
const DOT = {
  new: 'new', confirmed: 'callback', completed: 'recovered', cancelled: 'lost',
  not_ready: 'new', packed: 'noresp', dispatched: 'callback', in_transit: 'callback',
  out_for_delivery: 'callback', delivered: 'recovered', delivery_failed: 'lost', rto: 'lost',
};
const dot = (v) => `<span class="status ${DOT[v] || ''}"><span class="dot"></span>${esc(labelOf(v))}</span>`;
const orderDay = (o) => dayKey(o.order_date || o.created_at);

async function loadOps() {
  const today = dayKey(new Date());
  const [list, todays, inv, all] = await Promise.allSettled([
    getJSON(`/api/orders?limit=${ORDER_LIST_MAX}`),
    getJSON(`/api/orders?from=${today}&to=${today}&limit=1`),
    getJSON('/api/inventory'),
    state.days === 0 ? Promise.resolve(null) : getJSON('/api/admin/overview?days=0'),
  ]);
  if (list.status === 'fulfilled') {
    const d = list.value;
    state.ops = {
      orders: d.orders, total: d.total, viewCounts: d.viewCounts,
      todayTotal: todays.status === 'fulfilled' ? todays.value.total : null,
      complete: d.orders.length === d.total,
    };
  } else {
    state.ops = { error: list.reason.message };
  }
  state.inv = inv.status === 'fulfilled' ? inv.value : null;
  if (all.status === 'fulfilled' && all.value) state.allCarts = all.value.totals.carts;
  renderOps2();
}

function renderOps2() {
  renderOpsKpis();
  renderWorklist();
  renderQuickStatus();
  renderRecentOrders();
  renderOrdersChart();
  renderStagesOps();
  renderIcons();
}

function renderOpsKpis() {
  const o = state.ops;
  const v = o?.viewCounts;
  const todayCarts = Number(state.daily.get(dayKey(new Date()))?.carts || 0);
  const kpi = (label, value, sub, href, tip = '') => `<a class="okpi" href="${href}" title="${esc(tip)}">
      <span class="okpi-label">${esc(label)}</span>
      <span class="okpi-value">${value}</span>
      <span class="okpi-sub">${sub || '&nbsp;'}</span></a>`;
  const noOrders = (label) => `<div class="okpi is-off"><span class="okpi-label">${esc(label)}</span><span class="okpi-value">—</span><span class="okpi-sub">${esc(o?.error || 'Loading…')}</span></div>`;
  const noShipment = o?.complete
    ? o.orders.filter((x) => !x.shipment_id && ['new', 'confirmed'].includes(x.order_status)).length : null;
  const rangeLabel = state.days === 1 ? 'today' : state.days ? `last ${state.days} days` : 'all time';
  $('#okpis').innerHTML = [
    v ? kpi('Orders', count(o.total), o.todayTotal !== null ? `${count(o.todayTotal)} today` : '', '/orders', 'Every order, all channels.') : noOrders('Orders'),
    v ? kpi('Pending dispatch', count(v.pending_dispatch), noShipment !== null ? `${count(noShipment)} without a shipment yet` : '', '/orders?view=pending_dispatch',
      'New or confirmed orders whose shipment is not ready or packed, or that have no shipment yet.') : noOrders('Pending dispatch'),
    v ? kpi('In transit', count(v.in_transit), `${count(v.delivered)} delivered`, '/orders?view=in_transit', 'Dispatched, in transit or out for delivery.') : noOrders('In transit'),
    state.overview ? kpi('Carts', count(state.overview.totals.carts), `${rangeLabel}${state.days !== 1 ? ` · ${count(todayCarts)} today` : ''}`, '/?mode=all',
      'Abandoned carts received in the selected range.') : noOrders('Carts'),
  ].join('');
}

function renderWorklist() {
  const rows = [];
  const v = state.ops?.viewCounts;
  const c = state.inv?.cards;
  const q = state.overview?.queue;
  const add = (n, tone, title, sub, target) => { if (n !== undefined && n !== null) rows.push({ n: Number(n), tone, title, sub, target }); };
  if (v) {
    add(v.failed, 'error', 'Failed / RTO', 'Delivery failed or returned to origin', { href: '/orders?view=failed' });
    add(v.pending_dispatch, 'warn', 'Pending dispatch', 'Orders waiting to be packed or dispatched', { href: '/orders?view=pending_dispatch' });
  }
  if (q) {
    const sla = state.overview.health.slaHours;
    add(q.callbacks_overdue, 'error', 'Callbacks missed', 'Promised call time has passed', { bucket: 'callbacks_overdue', label: 'Callbacks missed' });
    add(q.stale, 'error', `Carts uncalled ${sla}h+`, `${money(q.stale_value)} waiting`, { bucket: 'stale', label: `Uncalled ${sla}h+` });
    add(q.callbacks_today, 'warn', 'Callbacks today', 'Promised for today', { bucket: 'callbacks_today', label: 'Callbacks today' });
    add(q.unassigned, 'warn', 'Unassigned carts', `${money(q.unassigned_value)} with no owner`, { bucket: 'unassigned', label: 'Unassigned' });
  }
  if (state.inv) {
    add(state.inv.unmapped?.length, 'warn', 'Unmapped platform SKUs', 'Marketplace SKUs on orders with no Master SKU', { href: '/inventory?view=unmapped' });
    add(c.expired, 'error', 'Expired batches with stock', 'Still on hand past expiry', { href: '/inventory?expiring=expired' });
    add(c.outOfStock, 'warn', 'Out of stock', 'Active Master SKUs with nothing available to dispatch', { href: '/inventory?stock=out' });
    add(c.lowStock, 'warn', 'Low stock', 'At or under the reorder level', { href: '/inventory?stock=low' });
  }
  if (!rows.length) {
    $('#worklist').innerHTML = `<li class="wl-empty">${esc(state.ops?.error || 'Nothing to show yet.')}</li>`;
    return;
  }
  // Work first, most severe first. Anything at zero is listed once, quietly, so
  // the reader can see it was checked without it taking a row.
  const open = rows.filter((r) => r.n).sort((a, b) => (a.tone === 'error' ? 0 : 1) - (b.tone === 'error' ? 0 : 1));
  const clear = rows.filter((r) => !r.n);
  $('#worklist').innerHTML = open.map((r) => {
    const inner = `<span class="wl-dot ${r.tone}"></span>
      <span class="wl-n">${count(r.n)}</span>
      <span class="wl-text"><b>${esc(r.title)}</b><span>${esc(r.sub)}</span></span>
      ${icon('chevron-right')}`;
    return `<li>${r.target.href
      ? `<a class="wl-row" href="${r.target.href}">${inner}</a>`
      : `<button type="button" class="wl-row" data-bucket="${r.target.bucket}" data-label="${esc(r.target.label)}">${inner}</button>`}</li>`;
  }).join('') + (clear.length ? `<li class="wl-clear">${icon('circle-check')}<span>${open.length ? 'Also clear' : 'All clear'}: ${clear.map((r) => esc(r.title)).join(' · ')}</span></li>` : '');
}

function renderQuickStatus() {
  const o = state.ops;
  const all = o?.complete ? o.orders : null;
  const sum = (f) => all.reduce((n, x) => n + f(x), 0);
  const carts = state.days === 0 ? state.overview?.totals.carts : state.allCarts;
  const row = (label, value, tip = '') => (value === null || value === undefined ? ''
    : `<div title="${esc(tip)}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`);
  const html = [
    row('Orders', o?.viewCounts ? count(o.total) : null),
    row('Order lines', all ? count(sum((x) => (x.line_skus || []).length)) : null, 'Product lines across every order.'),
    row('Shipments', all ? count(sum((x) => x.shipment_count || 0)) : null, 'Every shipment record, including several on one order.'),
    row('Documents', all ? count(sum((x) => x.document_count || 0)) : null, 'Documents attached to orders. Removed documents are not counted.'),
    row('Master SKUs', state.inv ? count(state.inv.cards.totalSkus) : null, 'Active master SKUs.'),
    row('Carts', carts !== null && carts !== undefined ? count(carts) : null, 'Every abandoned cart received.'),
    row('Team', state.overview ? `${count(state.overview.team)} member${state.overview.team === 1 ? '' : 's'} · ${count(state.overview.online.length)} online` : null),
  ].join('');
  $('#qstat').innerHTML = html || '<div class="wl-empty">Nothing to show yet.</div>';
}

function renderRecentOrders() {
  const o = state.ops;
  if (!o?.orders) {
    $('#recentOrders').innerHTML = `<div class="empty-note">${esc(o?.error || 'Loading…')}</div>`;
    return;
  }
  const list = o.orders.slice(0, 8);
  if (!list.length) { $('#recentOrders').innerHTML = '<div class="empty-note"><b>No orders yet</b>New orders appear here.</div>'; return; }
  $('#recentOrders').innerHTML = `<div class="rorders" role="table" aria-label="Recent orders">
    <div class="ro-row ro-head" role="row"><span role="columnheader">Order</span><span role="columnheader">Customer</span><span role="columnheader" class="r">Value</span>
      <span role="columnheader">Status</span><span role="columnheader">Shipment</span><span role="columnheader" class="r">Updated</span></div>
    ${list.map((x) => `<a class="ro-row" role="row" href="/orders?open=${x.id}">
      <span class="ro-order"><b class="mono">${x.source_order_id ? `#${esc(String(x.source_order_id).replace(/^#/, ''))}` : '—'}</b><span class="soft">${esc(x.channel_label || x.channel || '')}</span></span>
      <span class="ro-cust">${esc(x.customer_name || '—')}</span>
      <span class="ro-val r num">${x.order_value === null ? '<span class="muted">—</span>' : money(x.order_value)}</span>
      <span class="ro-status">${dot(x.order_status)}</span>
      <span class="ro-ship">${x.shipment_id ? dot(x.shipment_status) : '<span class="status none"><span class="dot"></span>No shipment yet</span>'}</span>
      <span class="ro-when r soft" title="${esc(dateTime(x.updated_at))}">${esc(relative(x.updated_at))}</span>
    </a>`).join('')}</div>`;
}

function renderOrdersChart() {
  const o = state.ops;
  const n = state.days === 1 ? 14 : state.days || 60;
  $('#ordersChartMeta').textContent = `last ${n} days · by order date`;
  if (!o?.orders) { $('#ordersChart').innerHTML = `<div class="empty-note">${esc(o?.error || 'Loading…')}</div>`; return; }
  const keys = lastDays(n);
  const by = new Map(keys.map((k) => [k, 0]));
  for (const x of o.orders) { const k = orderDay(x); if (by.has(k)) by.set(k, by.get(k) + 1); }
  // If the list was capped, only trust it back to the oldest order it holds.
  const oldest = o.orders.length ? orderDay(o.orders[o.orders.length - 1]) : null;
  const partial = !o.complete && oldest && oldest > keys[0];
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  $('#ordersChartTotal').textContent = count(total);
  $('#ordersChartNote').className = 'delta';
  $('#ordersChartNote').textContent = partial ? `complete from ${keyLabel(oldest)} only` : `orders in ${n} days`;
  barChart($('#ordersChart'), { points: keys.map((key) => ({ key, value: by.get(key) })), format: (v) => count(Math.round(v)), labelStyle: n <= 7 ? 'weekday' : 'short' });
}

function renderStagesOps() {
  const v = state.ops?.viewCounts;
  if (!v) { $('#stagesOps').innerHTML = `<div class="empty-note">${esc(state.ops?.error || 'Loading…')}</div>`; return; }
  $('#stagesOps').innerHTML = hbars([
    { label: 'Pending dispatch', n: v.pending_dispatch },
    { label: 'In transit', n: v.in_transit },
    { label: 'Delivered', n: v.delivered },
    { label: 'Failed / RTO', n: v.failed },
  ], { ink: true }) + '<p class="hint">Each order counted by its shipment’s current stage. Cancelled and completed orders without a shipment stage are not shown.</p>';
}

/* ------------------------------------------------------------------ needs attention */

function renderAttention(q, slaHours) {
  const tile = (bucket, label, n, sub, tone) => `
    <button type="button" class="att ${n ? tone : ''}" data-bucket="${bucket}" title="See these carts">
      <span class="att-label"><span class="dot"></span>${esc(label)}</span>
      <div class="att-value">${count(n)}</div>
      <div class="att-sub">${sub}</div>
    </button>`;
  $('#attention').innerHTML = [
    tile('stale', `Uncalled ${slaHours}h+`, q.stale, `${money(q.stale_value)} waiting`, 'is-error'),
    tile('callbacks_overdue', 'Callbacks missed', q.callbacks_overdue, 'promised time has passed', 'is-error'),
    tile('callbacks_today', 'Callbacks today', q.callbacks_today, 'promised for today', 'is-warn'),
    tile('unassigned', 'Unassigned', q.unassigned, `${money(q.unassigned_value)} with no owner`, 'is-warn'),
  ].join('');
}

/* ------------------------------------------------------------------ KPIs */

function renderKpis() {
  const t = state.overview.totals;
  const n = state.days;
  const cur = n ? windowOf(n) : null;
  const prev = n ? windowOf(n, n) : null;
  // A previous period with no carts is not a comparison — the board simply
  // did not exist yet. Saying "+100%" there would be a fabricated trend.
  const comparable = prev && prev.sum.carts > 0;
  const trend = windowOf(n === 1 ? 7 : n || 60);
  const rate = (s) => (s.worked ? (s.recovered / s.worked) * 100 : 0);
  const cmp = comparable ? compareLabel() : (n ? 'no earlier data to compare' : 'all time');

  $('#kpis').innerHTML = [
    metricCard({
      label: 'Abandoned carts', value: count(t.carts), compare: cmp,
      change: comparable ? delta(cur.sum.carts, prev.sum.carts, { goodWhenUp: null }) : null,
      series: trend.series.carts,
      tip: 'Carts that reached the board in this period. The comparison and trend line use the date each cart was abandoned.',
    }),
    metricCard({
      label: 'Recovered carts', value: count(t.recovered), compare: cmp,
      change: comparable ? delta(cur.sum.recovered, prev.sum.recovered) : null,
      series: trend.series.recovered,
      tip: 'Carts marked recovered. Recovery is recorded by hand — nothing yet checks it against a real order.',
    }),
    metricCard({
      label: 'Recovery rate', value: `${pct(t.recovered, t.worked)}%`, compare: cmp,
      change: comparable ? delta(rate(cur.sum), rate(prev.sum), { mode: 'pts' }) : null,
      series: trend.keys.map((_, i) => {
        const w = trend.series.worked[i];
        return w ? (trend.series.recovered[i] / w) * 100 : 0;
      }),
      tip: 'Recovered ÷ carts called. A cart nobody rang is not counted as a failed call.',
    }),
    metricCard({
      label: 'Recovered cart value', value: money(t.recovered_value), compare: cmp,
      change: comparable ? delta(cur.sum.recovered_value, prev.sum.recovered_value) : null,
      series: trend.series.recovered_value,
      tip: 'Recovered cart value is the abandoned cart value at the time of abandonment. It is not verified order revenue.',
    }),
  ].join('');
}

function renderOps() {
  const t = state.overview.totals;
  const op = (label, value, tip) => `<div class="op" title="${esc(tip)}">
    <div class="op-label">${esc(label)}${icon('info')}</div><div class="op-value">${value}</div></div>`;
  $('#ops').innerHTML = [
    op('Contact rate', `${pct(t.worked, t.carts)}%`, 'Carts called ÷ carts received in this period.'),
    op('Median first call', duration(state.overview.medianSecondsToFirstTouch), 'From the cart reaching us to someone first changing its status.'),
    op('Callbacks pending', count(state.callbackTotal), 'Every cart in "Callback scheduled", whatever the date range.'),
    op('Still open', money(t.open_value), 'Neither recovered nor declined — including carts nobody has called yet.'),
    op('Lost', money(t.declined_value), 'Cart value where the customer actually said no. Uncalled carts are not counted here.'),
  ].join('');
  $('#opsMeta').textContent = state.days ? `last ${state.days === 1 ? 'day' : `${state.days} days`}` : 'all time';
}

/* ------------------------------------------------------------------ chart */

const shortMoney = (v) => (v >= 100000 ? `₹${(v / 100000).toFixed(1)}L`
  : v >= 1000 ? `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `₹${Math.round(v)}`);

function renderChart() {
  const n = state.days === 1 ? 14 : state.days || 60;
  const cur = windowOf(n);
  const prev = windowOf(n, n);
  const m = state.metric;
  const isMoney = m === 'recovered_value';
  const fmt = isMoney ? shortMoney : (v) => count(Math.round(v));

  $('#chartTotal').textContent = isMoney ? money(cur.sum[m]) : count(cur.sum[m]);
  const d = prev.sum.carts > 0 ? delta(cur.sum[m], prev.sum[m], { goodWhenUp: m === 'carts' ? null : true }) : null;
  $('#chartDelta').className = `delta ${d ? d.tone : ''}`;
  $('#chartDelta').innerHTML = d ? `<b>${esc(d.text)}</b>vs prior ${n} days` : 'no earlier period to compare';
  $('#chartMeta').textContent = `last ${n} days`;

  barChart($('#chart'), {
    points: cur.keys.map((key, i) => ({ key, value: cur.series[m][i] })),
    format: fmt,
    labelStyle: n <= 7 ? 'weekday' : 'short',
  });
}

/* ------------------------------------------------------------------ activity */

/** Only the kinds cart_events records. Nothing here is invented. */
function describe(e) {
  const actor = esc(e.actor || 'System');
  const who = esc(e.customer_name || `cart ${e.cart_id}`);
  if (e.kind === 'status' || (!e.kind && e.to_status)) {
    const s = statusOf(e.to_status);
    const map = {
      recovered: ['circle-check', 'good', 'Cart recovered'],
      lost: ['circle-x', 'bad', 'Marked lost'],
      noresp: ['phone-missed', 'warn', 'No response'],
      callback: ['calendar-clock', 'info', 'Callback scheduled'],
      new: ['rotate-ccw', '', 'Moved back to new'],
    };
    const [ico, tone, title] = map[s.cls] || ['activity', '', 'Status changed'];
    return { ico, tone, title, meta: `<b>${actor}</b> · ${who}` };
  }
  if (e.kind === 'note') {
    return { ico: 'sticky-note', tone: '', title: e.detail ? 'Note added' : 'Note cleared', meta: e.detail ? `<b>${actor}</b> · “${esc(e.detail)}”` : `<b>${actor}</b> · ${who}` };
  }
  if (e.kind === 'callback') {
    return { ico: 'alarm-clock', tone: 'info', title: e.detail === 'cleared' ? 'Callback cleared' : 'Callback time set', meta: e.detail === 'cleared' ? `<b>${actor}</b> · ${who}` : `<b>${actor}</b> · ${who} · ${esc(e.detail)}` };
  }
  if (e.kind === 'reason') {
    return { ico: 'tag', tone: '', title: e.detail === 'cleared' ? 'Reason cleared' : 'Reason recorded', meta: `<b>${actor}</b> · ${esc(e.detail === 'cleared' ? e.customer_name || '' : e.detail)}` };
  }
  if (e.kind === 'assign') {
    return { ico: 'user-plus', tone: '', title: e.detail === 'unassigned' ? 'Unassigned' : `Assigned to ${esc(e.detail)}`, meta: `<b>${actor}</b> · ${who}` };
  }
  return { ico: 'activity', tone: '', title: 'Changed', meta: `<b>${actor}</b> · ${who}` };
}

function renderActivity() {
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86400000));
  const week = new Set(lastDays(7));
  const inTab = (e) => {
    const k = dayKey(e.at);
    return state.tab === 'today' ? k === today : state.tab === 'yesterday' ? k === yesterday : week.has(k);
  };
  const q = state.actQ.toLowerCase();
  const list = state.events.filter(inTab).filter((e) => !q
    || [e.actor, e.customer_name, e.detail, e.to_status, e.kind].some((v) => String(v || '').toLowerCase().includes(q)));

  const noun = list.length === 1 ? 'activity' : 'activities';
  $('#actCount').innerHTML = `<b>${count(list.length)}</b>${state.tab === 'today' ? `new ${noun} today`
    : state.tab === 'yesterday' ? `${noun} yesterday` : `${noun} this week`}`;

  $('#activity').innerHTML = list.length
    ? list.slice(0, 60).map((e) => {
        const d = describe(e);
        const when = state.tab === 'week' ? `${dateShort(e.at)}, ${clock(e.at)}` : clock(e.at);
        return `<div class="act">
          <span class="act-ico ${d.tone}">${icon(d.ico)}</span>
          <div style="min-width:0"><div class="act-title">${d.title}</div><div class="act-meta">${d.meta}</div></div>
          <span class="act-time">${esc(when)}</span>
        </div>`;
      }).join('')
    : `<div class="empty-note"><b>${q ? 'Nothing matches that search' : 'Quiet so far'}</b>${q ? 'Try a name or a status.' : 'Changes to carts appear here as the team works.'}</div>`;
  renderIcons();
}

/* ------------------------------------------------------------------ carts table */

const ownerOf = (c) => c.assigned_to_name || '';
const tagsOf = (c) => c.reason_tags || [];

function filteredCarts() {
  const { q, status, owner, reason } = state.filters;
  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, '');
  const list = state.carts.filter((c) => {
    if (needle && !(String(c.customer_name || '').toLowerCase().includes(needle)
      || String(c.email || '').toLowerCase().includes(needle)
      || (digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(digits)))) return false;
    if (status && statusOf(c.status).label !== status) return false;
    if (owner === '__none' ? ownerOf(c) : owner && ownerOf(c) !== owner) return false;
    if (reason === '__none' ? tagsOf(c).length : reason && !tagsOf(c).includes(reason)) return false;
    return true;
  });
  const { key, dir } = state.sort;
  const val = (c) => {
    if (key === 'status') return statusOf(c.status).label;
    if (key === 'total_price') return Number(c.total_price || 0);
    if (key === 'callback_at') return c.status === 'Callback scheduled' && c.callback_at ? new Date(c.callback_at).getTime() : null;
    if (key.endsWith('_at')) return c[key] ? new Date(c[key]).getTime() : null;
    return String(c[key] || '').toLowerCase();
  };
  return list.sort((a, b) => {
    const x = val(a); const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;           // empties last, whichever way you sort
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function syncFilterOptions() {
  const keep = (sel, html) => { const el = $(sel); const v = el.value; el.innerHTML = html; el.value = v; };
  keep('#fstatus', '<option value="">Status</option>'
    + STATUS_LABELS.map((s) => `<option>${esc(s)}</option>`).join(''));
  const owners = [...new Set(state.carts.map(ownerOf).filter(Boolean))].sort();
  keep('#fowner', '<option value="">Owner</option>'
    + owners.map((o) => `<option>${esc(o)}</option>`).join('')
    + '<option value="__none">Unassigned</option>');
  const reasons = [...new Set(state.carts.flatMap(tagsOf))].sort();
  keep('#freason', '<option value="">Reason</option>'
    + reasons.map((r) => `<option>${esc(r)}</option>`).join('')
    + '<option value="__none">No reason recorded</option>');
}

function renderTable() {
  const rows = filteredCarts();
  const f = state.filters;
  const filtered = f.q || f.status || f.owner || f.reason;
  for (const [id, key] of [['#fstatus', 'status'], ['#fowner', 'owner'], ['#freason', 'reason']]) {
    $(id).classList.toggle('on', Boolean(f[key]));
  }
  $('#fclear').hidden = !filtered;

  const outside = state.carts.filter((c) => c.status === 'Callback scheduled'
    && state.days && new Date(c.received_at) < new Date(Date.now() - state.days * 86400000)).length;
  $('#tableMeta').textContent = `${count(rows.length)}${filtered ? ` of ${count(state.carts.length)}` : ''}`
    + (outside ? ` · includes ${outside} older callback${outside === 1 ? '' : 's'}` : '');

  $$('#cartTable th.sortable').forEach((th) => {
    th.querySelector('.sort').textContent = th.dataset.sort === state.sort.key ? (state.sort.dir > 0 ? '↑' : '↓') : '↕';
  });

  if (!rows.length) {
    $('#cartRows').innerHTML = `<tr><td colspan="10"><div class="empty-note">
      <b>${filtered ? 'No carts match these filters.' : 'No carts in this period.'}</b>
      ${filtered ? 'Try adjusting the status or date range.' : 'Widen the date range, or wait for the next cart from GoKwik.'}</div></td></tr>`;
    $('#tableMore').hidden = true;
    return;
  }

  $('#cartRows').innerHTML = rows.slice(0, state.shown).map((c) => {
    const board = `/?q=${encodeURIComponent(c.phone || c.customer_name || '')}`;
    return `<tr>
      <td><div class="cell-main" title="${esc(c.customer_name || 'Guest')}">${esc(c.customer_name || 'Guest')}</div>
          <div class="cell-sub" title="${esc(c.email || '')}">${esc(c.email || '—')}</div></td>
      <td class="r num">${money(c.total_price)}</td>
      <td class="num soft">${esc(c.phone || '—')}</td>
      <td>${statusIndicator(c.status)}</td>
      <td>${ownerOf(c) ? esc(ownerOf(c)) : '<span class="muted">Unassigned</span>'}</td>
      <td>${c.status_updated_at
        ? `<div>${esc(c.updated_by || '—')}</div><div class="cell-sub">${esc(relative(c.status_updated_at))}</div>`
        : '<span class="muted">—</span>'}</td>
      <td>${followUp(c)}</td>
      <td>${tagsOf(c).length ? esc(tagsOf(c).join(', ')) : '<span class="muted">—</span>'}</td>
      <td class="num soft">${esc(dateTime(c.received_at))}</td>
      <td><div class="cell-actions">
        ${c.phone ? `<a class="icon-btn bare" href="tel:${esc(String(c.phone).replace(/\s/g, ''))}" title="Call">${icon('phone')}</a>` : ''}
        <a class="icon-btn bare" href="${board}" title="Open on the call board">${icon('arrow-up-right')}</a>
      </div></td>
    </tr>`;
  }).join('');
  $('#tableMore').hidden = rows.length <= state.shown;
  $('#showMore').textContent = `Show ${Math.min(25, rows.length - state.shown)} more`;
  renderIcons();
}

function tableSkeleton() {
  $('#cartRows').innerHTML = Array.from({ length: 6 }, () => `<tr>
    <td><span class="sk w70"></span></td><td><span class="sk w50"></span></td><td><span class="sk w70"></span></td>
    <td><span class="sk w50"></span></td><td><span class="sk w70"></span></td><td><span class="sk w70"></span></td>
    <td><span class="sk w50"></span></td><td><span class="sk w50"></span></td><td><span class="sk w70"></span></td><td></td>
  </tr>`).join('');
}

/* ------------------------------------------------------------------ team + breakdowns */

function renderTeam() {
  const d = state.overview;
  const t = d.totals;
  // Each step as a share of the one before it, which is where work is lost.
  const steps = [['Carts in', t.carts, t.carts], ['Assigned', t.assigned, t.carts], ['Called', t.worked, t.carts], ['Recovered', t.recovered, t.worked]];
  $('#funnel').innerHTML = hbars(steps.map(([label, n, base]) => ({
    label, n, display: `${count(n)} · ${pct(n, base)}%`,
  })), { ink: true });

  $('#callers').innerHTML = d.callers.length
    ? d.callers.map((c) => `<tr>
        <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="avatar" style="width:24px;height:24px;font-size:10px">${esc(initials(c.caller))}</span>${esc(c.caller)}</span></td>
        <td class="r num">${count(c.touched)}</td><td class="r num">${count(c.recovered)}</td>
        <td class="r num">${c.recovery_rate}%</td><td class="r num">${money(c.recovered_value)}</td></tr>`).join('')
    : '<tr><td colspan="5"><div class="empty-note">Nobody has worked a cart in this range.</div></td></tr>';

  const ago = (s) => (s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);
  $('#online').innerHTML = d.online.length
    ? d.online.map((o) => `<div class="person">
        <span class="avatar">${esc(initials(o.name))}<span class="live"></span></span>
        <span>${esc(o.name)}</span>${o.is_admin ? '<span class="tag">Admin</span>' : ''}
        <span class="when">${esc(ago(o.seconds_ago))}</span></div>`).join('')
    : '<div class="empty-note">Nobody is on the board right now.</div>';
  $('#onlineMeta').textContent = `${d.online.length} of ${d.team} active`;
}

function renderBreakdowns() {
  const d = state.overview;
  const t = d.totals;
  // Which fields each source cannot fill is read from the data, not hardcoded,
  // so it stays true if a source starts sending more.
  $('#sources').innerHTML = hbars(d.bySource.map((s) => {
    const missing = [!s.has_stage && 'no drop stage', !s.has_risk && 'no risk flag', !s.has_utm && 'no marketing source'].filter(Boolean);
    return {
      label: SOURCE_NAME[s.source] || s.source, n: s.carts,
      note: `${money(s.value)} · ${s.recovered} recovered${missing.length ? ` · ${missing.join(', ')}` : ''}`,
    };
  }));

  const gokwik = d.bySource.find((s) => s.source === 'gokwik')?.carts ?? 0;
  $('#stageMeta').textContent = gokwik === t.carts ? 'in range' : `GoKwik carts only — ${gokwik} of ${t.carts}`;
  $('#stages').innerHTML = hbars(d.stages);
  $('#risk').innerHTML = hbars(d.risk.map((r) => ({ label: `${r.label} · ${SOURCE_NAME[r.source] || r.source}`, n: r.n })));
  $('#utm').innerHTML = hbars(d.utm);
  const tagged = d.utm.reduce((sum, u) => sum + (u.label === 'unknown' ? 0 : u.n), 0);
  $('#utmMeta').textContent = `${tagged} of ${t.carts} carry one`;

  $('#footnote').textContent = `${t.assigned} of ${t.carts} carts assigned · ${t.callbacks} callbacks scheduled in range`
    + (t.overdue ? `, ${t.overdue} overdue` : '') + ` · ${t.declined} declined.`;
}

async function loadReasons() {
  try {
    const d = await getJSON(`/api/reasons/summary?days=${state.days}`);
    $('#reasons').innerHTML = d.reasons.length
      ? hbars(d.reasons.map((r) => ({ label: r.tag, n: r.count })))
      : '<div class="empty-note"><b>No reasons recorded yet</b>Callers add these as they work.</div>';
    $('#reasonMeta').textContent = d.taggedCarts ? `${d.taggedCarts} tagged` : '';
  } catch { /* secondary — never let it blank the page */ }
}

/* ------------------------------------------------------------------ report */

const PERIOD_HEAD = { day: 'Date', week: 'Week starting', month: 'Month' };

function periodLabel(bucket) {
  // A YYYY-MM-DD string, deliberately not parsed as a UTC instant — that would
  // reintroduce the timezone shift the server query exists to avoid.
  const [y, m, dd] = bucket.split('-').map(Number);
  const date = new Date(y, m - 1, dd);
  return state.period === 'month'
    ? date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

async function loadReport() {
  try {
    const d = await getJSON(`/api/admin/report?period=${state.period}&limit=14`);
    $('#periodHead').textContent = PERIOD_HEAD[state.period];
    $('#reportCsv').href = `/api/admin/report.csv?period=${state.period}`;
    $('#reportRows').innerHTML = d.rows.length
      ? d.rows.map((r) => `<tr>
          <td>${esc(periodLabel(r.bucket))}</td>
          <td class="r num">${count(r.carts)}</td><td class="r num">${money(r.cart_value)}</td>
          <td class="r num">${count(r.worked)}</td><td class="r num">${r.contact_rate}%</td>
          <td class="r num">${count(r.recovered)}</td><td class="r num"><b>${r.recovery_rate}%</b></td>
          <td class="r num">${money(r.recovered_value)}</td></tr>`).join('')
      : '<tr><td colspan="8"><div class="empty-note">No carts yet.</div></td></tr>';
  } catch (err) {
    $('#reportRows').innerHTML = `<tr><td colspan="8"><div class="empty-note">${esc(err.message)}</div></td></tr>`;
  }
}

/* ------------------------------------------------------------------ drawer */

async function openDrawer(bucket, label) {
  $('#drawerTitle').textContent = label;
  $('#drawerSub').textContent = 'Loading…';
  $('#drawerBody').innerHTML = Array.from({ length: 4 }, () => '<div class="drow"><div class="grow"><span class="sk w70"></span><span class="sk w50" style="margin-top:8px"></span></div></div>').join('');
  $('#drawer').hidden = false;
  $('#drawerScrim').hidden = false;
  try {
    const d = await getJSON(`/api/admin/carts?bucket=${encodeURIComponent(bucket)}&days=${state.days}`);
    $('#drawerSub').textContent = `${d.carts.length} cart${d.carts.length === 1 ? '' : 's'} · all time`;
    $('#drawerBody').innerHTML = d.carts.length
      ? d.carts.map((c) => `<div class="drow">
          <div class="grow">
            <div class="cell-main">${esc(c.customer_name || 'Guest')}</div>
            <div class="cell-sub">${esc(c.phone || 'no phone')} · ${esc(c.assigned_to_name || 'Unassigned')} · waiting ${esc(relative(c.received_at).replace(' ago', ''))}</div>
            <div style="margin-top:6px">${statusIndicator(c.status)}</div>
          </div>
          <span class="amt">${money(c.total_price)}</span>
          ${c.phone ? `<a class="icon-btn" href="tel:${esc(c.phone)}" title="Call">${icon('phone')}</a>` : ''}
        </div>`).join('')
      : '<div class="empty-note"><b>Nothing in here</b>That is the good outcome.</div>';
    renderIcons();
  } catch (err) {
    $('#drawerSub').textContent = '';
    $('#drawerBody').innerHTML = `<div class="empty-note">${esc(err.message)}</div>`;
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawerScrim').hidden = true;
}

/* ------------------------------------------------------------------ load */

async function loadAll({ quiet = false } = {}) {
  $('#refresh').classList.add('spin');
  if (!quiet) tableSkeleton();

  const opsLoaded = loadOps().catch(() => {});
  const [overview, report, carts, events] = await Promise.allSettled([
    getJSON(`/api/admin/overview?days=${state.days}`),
    getJSON('/api/admin/report?period=day&limit=60'),
    getJSON(`/api/carts?days=${state.days}`),
    getJSON('/api/admin/events?limit=200'),
  ]);

  if (report.status === 'fulfilled') {
    state.daily = new Map(report.value.rows.map((r) => [r.bucket, r]));
  }
  if (overview.status === 'fulfilled') {
    state.overview = overview.value;
    renderAlerts(state.overview.health);
    renderAttention(state.overview.queue, state.overview.health.slaHours);
    renderTeam();
    renderBreakdowns();
  } else {
    $('#alerts').innerHTML = `<div class="alert" role="alert">${icon('triangle-alert')}<p>${esc(overview.reason.message)}</p></div>`;
  }
  if (carts.status === 'fulfilled') {
    state.carts = carts.value.carts;
    state.callbackTotal = carts.value.callbackTotal ?? state.carts.filter((c) => c.status === 'Callback scheduled').length;
    syncFilterOptions();
    renderTable();
    const overdue = state.carts.some((c) => c.status === 'Callback scheduled' && c.callback_at && new Date(c.callback_at) < new Date());
    setNavCount('countToCall', state.carts.filter((c) => (c.status || 'Not called') === 'Not called').length);
    setNavCount('countCallbacks', state.callbackTotal, { alert: overdue });
  } else {
    $('#cartRows').innerHTML = `<tr><td colspan="10"><div class="empty-note">${esc(carts.reason.message)}</div></td></tr>`;
  }
  if (state.overview) { renderKpis(); renderOps(); }
  await opsLoaded;
  renderOps2();
  renderChart();
  if (events.status === 'fulfilled') { state.events = events.value.events; renderActivity(); }

  $('#refresh').classList.remove('spin');
  renderIcons();
}

/* ------------------------------------------------------------------ events */

$('#range').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  state.shown = 12;
  closeDrawer();
  loadAll();
  loadReasons();
});
$('#refresh').addEventListener('click', () => { loadAll({ quiet: true }); loadReasons(); loadReport(); });
$('#chartMetric').addEventListener('change', (e) => { state.metric = e.target.value; renderChart(); });

$('#attention').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bucket]');
  if (b) openDrawer(b.dataset.bucket, b.querySelector('.att-label').textContent.trim());
});
$('#worklist').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-bucket]');
  if (b) openDrawer(b.dataset.bucket, b.dataset.label);
});
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); }, { signal: pageSignal() });

$('#actTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tab = b.dataset.tab;
  $$('#actTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderActivity();
});
$('#actSearch').addEventListener('input', (e) => { state.actQ = e.target.value.trim(); renderActivity(); });

let qTimer;
$('#fq').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); state.shown = 12; renderTable(); }, 150);
});
for (const [id, key] of [['#fstatus', 'status'], ['#fowner', 'owner'], ['#freason', 'reason']]) {
  $(id).addEventListener('change', (e) => { state.filters[key] = e.target.value; state.shown = 12; renderTable(); });
}
$('#fclear').addEventListener('click', () => {
  state.filters = { q: '', status: '', owner: '', reason: '' };
  $('#fq').value = ''; $('#fstatus').value = ''; $('#fowner').value = ''; $('#freason').value = '';
  renderTable();
});
$('#cartTable thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'customer_name' ? 1 : -1 };
  renderTable();
});
$('#showMore').addEventListener('click', () => { state.shown += 25; renderTable(); });

$('#periodGroup').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.period = b.dataset.period;
  $$('#periodGroup button').forEach((x) => x.classList.toggle('active', x === b));
  loadReport();
});

// Close the "more" menu when clicking elsewhere — <details> does not on its own.
document.addEventListener('click', (e) => {
  for (const d of $$('details.menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
}, { signal: pageSignal() });

/* ------------------------------------------------------------------ boot */

// Same cadence as before. Skipped while hidden, and quiet, so an open filter
// or a scrolled table is not reset under the reader. Stops when the page is left.
const poll = setInterval(() => { if (!document.hidden) loadAll({ quiet: true }); }, 60_000);
onLeave(() => { clearInterval(poll); clearTimeout(qTimer); });

(async () => {
  try {
    const [me, cfg] = await Promise.all([getJSON('/auth/me'), getJSON('/api/config')]);
    if (me && me.authenticated === false) { window.location.href = '/login'; return; }
    setTimezone(cfg.boardTimezone);
    initShell(me);
    greet(me);
  } catch { /* the page still works on its defaults */ }
  renderIcons();
  loadAll();
  loadReasons();
  loadReport();
})();
