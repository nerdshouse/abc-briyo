/**
 * Affiliate programme report — every affiliate over a period of IST days: clicks, credited orders, order value and,
 * for those allowed to see money, commissions and payouts. One page, /affiliate-report?from=YYYY-MM-DD&to=YYYY-MM-DD.
 * Every figure comes from /api/affiliates/report (lib/affiliate-report.js); the server decides what money is shown.
 */
import { $, esc, count, icon, renderIcons, initShell, pageFetch, onQueryChange } from './ui/components.js';
import { istDayKey } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, from: null, to: null, report: null };

const api = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
};
const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v || 0));
const fig = (label, value, note = '') => `<div class="af-fig"><span class="af-fig-label">${esc(label)}</span><span class="af-fig-value num">${value}</span>${note ? `<span class="af-fig-note">${note}</span>` : ''}</div>`;
const shortDay = (key) => { const [, m, d] = key.split('-'); return `${d}-${m}`; };
const dayKey = (offset) => istDayKey(new Date(Date.now() - offset * 86400000));

/** Ready-made periods; anything else is "Custom" with the two dates. */
function presets() {
  const today = dayKey(0);
  const [y, m] = today.split('-');
  const fyStart = Number(m) >= 4 ? `${y}-04-01` : `${Number(y) - 1}-04-01`;
  return [
    ['7', 'Last 7 days', dayKey(6), today],
    ['30', 'Last 30 days', dayKey(29), today],
    ['90', 'Last 90 days', dayKey(89), today],
    ['month', 'This month', `${y}-${m}-01`, today],
    ['fy', 'This financial year', fyStart, today],
  ];
}

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const d = presets()[1];
  state.from = q.get('from') || d[2];
  state.to = q.get('to') || d[3];
}
function go(from, to) {
  window.history.pushState(null, '', `/affiliate-report?from=${from}&to=${to}`);
  readUrl(); load();
}

function failed(err) {
  $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span><button class="btn" type="button" id="retry">Try again</button></div>`;
  renderIcons();
}

async function load() {
  $('#alerts').innerHTML = '';
  try {
    state.report = await api(`/api/affiliates/report?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`);
    render();
  } catch (err) { failed(err); }
}

/** Bars for one daily series (orders or clicks), drawn as inline SVG in the page's own colours. */
function bars(series, key, label) {
  const max = Math.max(1, ...series.map((d) => d[key]));
  const w = 100 / series.length;
  const total = series.reduce((n, d) => n + d[key], 0);
  return `<div class="ar-chart">
    <div class="ar-chart-head"><span class="af-fig-label">${esc(label)} per day</span><span class="soft num">${count(total)} in all · busiest day ${count(max === 1 && !total ? 0 : max)}</span></div>
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="${esc(label)} per day">
      ${series.map((d, i) => { const h = (d[key] / max) * 38; return `<rect x="${(i * w + w * 0.15).toFixed(3)}" y="${(40 - h).toFixed(3)}" width="${(w * 0.7).toFixed(3)}" height="${h.toFixed(3)}" class="ar-bar ${key}"><title>${esc(shortDay(d.day))}: ${count(d[key])} ${esc(label.toLowerCase())}</title></rect>`; }).join('')}
    </svg>
    <div class="ar-axis soft"><span>${esc(shortDay(series[0].day))}</span><span>${esc(shortDay(series[series.length - 1].day))}</span></div>
  </div>`;
}

function render() {
  const r = state.report;
  const t = r.totals;
  const p = r.period;
  const preset = presets().find(([, , f, to]) => f === p.from && to === p.to);
  $('#pageTitle').textContent = 'Affiliate report';
  $('#pageSub').innerHTML = `${esc(p.from.split('-').reverse().join('-'))} to ${esc(p.to.split('-').reverse().join('-'))} · ${count(p.days)} day${p.days === 1 ? '' : 's'} · ${count(r.affiliates.by_status.active || 0)} active affiliate${(r.affiliates.by_status.active || 0) === 1 ? '' : 's'} of ${count(r.affiliates.total)}`;
  $('#pageActions').innerHTML = `
    <select class="select" id="preset" aria-label="Period">${presets().map(([k, l]) => `<option value="${k}"${preset?.[0] === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}<option value="custom"${preset ? '' : ' selected'}>Custom…</option></select>
    <span class="ar-custom"${preset ? ' hidden' : ''}><input class="input" type="date" id="from" value="${esc(p.from)}" aria-label="From" /><input class="input" type="date" id="to" value="${esc(p.to)}" aria-label="To" /><button class="btn" type="button" id="apply">Show</button></span>
    <button class="btn" type="button" id="csv">${icon('download')}Download CSV</button>
    <button class="icon-btn" id="refresh" type="button" title="Refresh" aria-label="Refresh">${icon('refresh-cw')}</button>`;

  const c = t.commissions;
  const po = t.payouts;
  $('#view').innerHTML = `<div class="af-stack">
    <section class="card">
      <header class="card-head"><h2 class="card-title">${icon('mouse-pointer-click')}Referrals</h2></header>
      <div class="af-figs c4">
        ${fig('Link clicks', count(t.clicks))}
        ${fig('Orders credited', count(t.orders - t.cancelled), [t.by_method.link && `${count(t.by_method.link)} by link`, t.by_method.coupon && `${count(t.by_method.coupon)} by coupon`, t.by_method.gokwik && `${count(t.by_method.gokwik)} older GoKwik rule`, t.cancelled && `${count(t.cancelled)} cancelled, not counted`].filter(Boolean).join(' · '))}
        ${fig('Click to order', t.conversion === null ? '—' : `${t.conversion}%`, 'of link clicks became an order')}
        ${fig('Order value', esc(inr(t.order_value)), t.average_order_value === null ? '' : `average ${esc(inr(t.average_order_value))}`)}
      </div>
      <div class="ar-charts">${bars(r.series, 'clicks', 'Clicks')}${bars(r.series, 'orders', 'Orders')}</div>
      ${t.other_currency_orders ? `<p class="soft af-note pad">${count(t.other_currency_orders)} order${t.other_currency_orders === 1 ? '' : 's'} in another currency are counted but not added to the value.</p>` : ''}
    </section>

    ${c ? `<section class="card">
      <header class="card-head"><h2 class="card-title">${icon('percent')}Commissions <span class="soft" style="font-weight:400">on orders placed in this period</span></h2></header>
      <div class="af-figs c4">
        ${fig('Earned', `<b>${esc(inr(c.earned))}</b>`, 'pending + approved + paid')}
        ${fig('Waiting for approval', esc(inr(c.by_status.pending)))}
        ${fig('Approved, not paid', esc(inr(c.by_status.approved)))}
        ${fig('Paid', esc(inr(c.by_status.paid)))}
      </div>
      ${c.by_status.reversed || c.on_cancelled_orders || c.orders_without_commission ? `<p class="soft af-note pad">${[
        c.by_status.reversed && `${esc(inr(c.by_status.reversed))} reversed`,
        c.on_cancelled_orders && `${esc(inr(c.on_cancelled_orders))} still open on cancelled orders (to be reversed)`,
        c.orders_without_commission && `${count(c.orders_without_commission)} credited order${c.orders_without_commission === 1 ? '' : 's'} without a commission (no rate or no financial record; see each affiliate's activity)`,
      ].filter(Boolean).join(' · ')}.</p>` : ''}
    </section>` : ''}

    ${po ? `<section class="card">
      <header class="card-head"><h2 class="card-title">${icon('banknote')}Payouts <span class="soft" style="font-weight:400">paid at the bank in this period</span></h2>
        <div class="card-tools"><a class="btn" href="/affiliate-payouts">${icon('arrow-right')}Payouts</a></div></header>
      <div class="af-figs c4">
        ${fig('Paid to affiliates', `<b>${esc(inr(po.paid.net))}</b>`, `${count(po.paid.payouts)} payout${po.paid.payouts === 1 ? '' : 's'}`)}
        ${fig('Commission paid (gross)', esc(inr(po.paid.gross)))}
        ${fig('TDS deducted', esc(inr(po.paid.tds)))}
        ${fig('Waiting at the bank now', esc(inr(po.waiting.net)), `${count(po.waiting.payouts)} payout${po.waiting.payouts === 1 ? '' : 's'}, any date`)}
      </div>
    </section>` : ''}

    <section class="card">
      <header class="card-head"><h2 class="card-title">${icon('trophy')}By affiliate</h2><span class="soft">${count(r.rows.length)} · most orders first</span></header>
      <div class="pane">
        ${r.rows.length ? `<div class="table-wrap"><table class="table af-table">
          <thead><tr><th>Affiliate</th><th class="r">Clicks</th><th class="r">Orders</th><th class="r">Click to order</th><th class="r">Order value</th>${c ? '<th class="r">Commission earned</th>' : ''}${po ? '<th class="r">Paid (net)</th>' : ''}</tr></thead>
          <tbody>${r.rows.map((a) => `<tr class="orow" data-aff="${esc(a.public_id)}" tabindex="0">
            <td><span class="cell-main"><b>${esc(a.name)}</b></span><span class="cell-sub">${esc(a.public_id)} · ${esc(a.category)}${a.status === 'active' ? '' : ` · ${esc(a.status.replace(/_/g, ' '))}`}</span></td>
            <td class="r num">${count(a.clicks)}</td>
            <td class="r num">${count(a.orders - a.cancelled)}${a.by_method.coupon || a.cancelled ? `<span class="cell-sub">${[a.by_method.coupon && `${count(a.by_method.coupon)} coupon`, a.cancelled && `${count(a.cancelled)} cancelled`].filter(Boolean).join(' · ')}</span>` : ''}</td>
            <td class="r num">${a.conversion === null ? '<span class="soft">—</span>' : `${a.conversion}%`}</td>
            <td class="r num">${esc(inr(a.order_value))}</td>
            ${c ? `<td class="r num">${esc(inr(a.commission_earned))}</td>` : ''}
            ${po ? `<td class="r num">${esc(inr(a.paid_net))}</td>` : ''}
          </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-note"><b>No affiliate activity in this period.</b>Try a longer period.</div>'}
      </div>
    </section>
  </div>`;
  renderIcons();
}

/** The table as a CSV file, the figures exactly as shown (rupees, no currency symbol). */
function downloadCsv() {
  const r = state.report;
  if (!r) return;
  const c = Boolean(r.totals.commissions);
  const po = Boolean(r.totals.payouts);
  const head = ['Affiliate', 'ID', 'Category', 'Status', 'Clicks', 'Orders', 'Orders by link', 'Orders by coupon', 'Cancelled orders', 'Click to order %', 'Order value (INR)',
    ...(c ? ['Commission earned (INR)'] : []), ...(po ? ['Paid net (INR)', 'TDS deducted (INR)'] : [])];
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
  const lines = [head, ...r.rows.map((a) => [a.name, a.public_id, a.category, a.status, a.clicks, a.orders - a.cancelled, a.by_method.link, a.by_method.coupon, a.cancelled,
    a.conversion ?? '', a.order_value.toFixed(2), ...(c ? [a.commission_earned.toFixed(2)] : []), ...(po ? [a.paid_net.toFixed(2), a.paid_tds.toFixed(2)] : [])])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`${lines.map((l) => l.map(cell).join(',')).join('\n')}\n`], { type: 'text/csv' }));
  a.download = `affiliate-report-${r.period.from}-to-${r.period.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bind() {
  $('#pageActions').addEventListener('change', (e) => {
    if (e.target.id !== 'preset') return;
    if (e.target.value === 'custom') { $('.ar-custom').hidden = false; $('#from').focus(); return; }
    const p = presets().find(([k]) => k === e.target.value);
    if (p) go(p[2], p[3]);
  });
  $('#pageActions').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'refresh') load();
    if (t.id === 'csv') downloadCsv();
    if (t.id === 'apply' && $('#from').value && $('#to').value) go($('#from').value, $('#to').value);
  });
  const open = (e) => { const tr = e.target.closest('[data-aff]'); if (tr) window.location.href = `/affiliates/${encodeURIComponent(tr.dataset.aff)}`; };
  $('#view').addEventListener('click', open);
  $('#view').addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
  $('#alerts').addEventListener('click', (e) => { if (e.target.id === 'retry') load(); });
  onQueryChange(() => { readUrl(); load(); });
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    readUrl();
    bind();
    await load();
  } catch (err) { $('#view').innerHTML = ''; $('#pageSub').textContent = ''; failed(err); }
}());
