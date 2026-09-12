'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let days = 7;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (v) => inr.format(Number(v || 0));

/** "7h" reads faster than "25542 seconds" when you are scanning for a problem. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ago = (s) => (s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);

function bars(rows, { label = 'label', value = 'n', suffix = '' } = {}) {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  const max = Math.max(1, ...rows.map((r) => Number(r[value])));
  return rows.map((r) => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(r[label])}">${esc(r[label])}</span>
      <span class="bar"><span class="bar-fill" style="width:${(Number(r[value]) / max) * 100}%"></span></span>
      <span class="bar-count">${r[value]}${suffix}</span>
    </div>`).join('');
}

async function load() {
  try {
    const res = await fetch(`/api/admin/overview?days=${days}`);
    if (res.status === 403) { $('#banner').textContent = 'Admins only.'; $('#banner').hidden = false; return; }
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load the dashboard');
    render(d);
    $('#banner').hidden = true;
  } catch (err) {
    $('#banner').textContent = err.message;
    $('#banner').hidden = false;
  }
}

function render(d) {
  const t = d.totals;
  const rate = t.worked ? Math.round((t.recovered / t.worked) * 100) : 0;
  const uncalled = t.carts - t.worked;

  // A headline number invites "which ones?", so the countable ones link to the
  // board already filtered rather than leaving you to rebuild it by hand.
  const board = (params) => `/?days=${days}&${params}`;
  $('#headline').innerHTML = [
    ['Carts in', t.carts, '', board('')],
    ['Cart value', money(t.value), '', null],
    ['Worked', `${t.worked}`, '', board('status=__called')],
    ['Recovered', `${t.recovered}`, t.recovered ? 'stat-good' : '', board(`status=${encodeURIComponent('Called – Recovered')}`)],
    ['Recovered value', money(t.recovered_value), t.recovered ? 'stat-good' : '', board(`status=${encodeURIComponent('Called – Recovered')}`)],
    ['Recovery rate', `${rate}%`, '', null],
    ['Not called yet', uncalled, uncalled ? 'stat-warn' : '', board(`status=${encodeURIComponent('Not called')}`)],
    ['Median time to first call', duration(d.medianSecondsToFirstTouch), '', null],
  ].map(([label, value, cls, href]) => (href
    ? `<a class="stat stat-click ${cls}" href="${href}" title="See these carts on the board">
         <div class="label">${label}</div><div class="value">${value}</div></a>`
    : `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`
  )).join('');

  // Health banner — only speaks up when something is actually wrong.
  const h = d.health;
  const problems = [];
  if (h.ingestSilent) problems.push(`No carts received for ${Math.round(h.lastIngestAgeMinutes / 60)}h — check the GoKwik webhook.`);
  if (h.webhookFailures24h) problems.push(`${h.webhookFailures24h} webhook delivery failure(s) in the last 24h.`);
  if (h.staleCarts) problems.push(`${h.staleCarts} cart(s) uncalled for over ${h.slaHours}h (${money(h.staleValue)}).`);
  const banner = $('#health');
  banner.className = 'banner ' + (h.ingestSilent || h.webhookFailures24h ? 'error' : 'mock');
  banner.innerHTML = problems.length
    ? `<strong>Needs attention.</strong> ${problems.map(esc).join(' ')}`
    : '';
  banner.hidden = !problems.length;

  $('#online').innerHTML = d.online.length
    ? d.online.map((o) => `
        <div class="onliner">
          <span class="dot"></span>
          <span class="oname">${esc(o.name)}</span>
          ${o.is_admin ? '<span class="chip">Admin</span>' : ''}
          <span class="muted">${ago(o.seconds_ago)}</span>
        </div>`).join('')
    : '<p class="muted">Nobody is on the board right now.</p>';
  $('#onlineMeta').textContent = `${d.online.length} of ${d.team} active`;

  $('#callers').innerHTML = d.callers.length
    ? d.callers.map((c) => `
        <tr>
          <td>${esc(c.caller)}</td>
          <td class="right">${c.touched}</td>
          <td class="right">${c.recovered}</td>
          <td class="right">${c.recovery_rate}%</td>
          <td class="right">${money(c.recovered_value)}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="empty">Nobody has worked a cart in this range.</td></tr>';

  $('#byDay').innerHTML = d.byDay.length
    ? (() => {
        const max = Math.max(1, ...d.byDay.map((x) => x.carts));
        return d.byDay.map((x) => `
          <div class="bar-row">
            <span class="bar-label">${new Date(x.day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
            <span class="bar">
              <span class="bar-fill" style="width:${(x.carts / max) * 100}%"></span>
              <span class="bar-fill bar-good" style="width:${(x.recovered / max) * 100}%"></span>
            </span>
            <span class="bar-count">${x.carts}</span>
          </div>`).join('');
      })()
    : '<p class="muted">No carts in this range.</p>';

  $('#stages').innerHTML = bars(d.stages);
  $('#risk').innerHTML = bars(d.risk);
  $('#sources').innerHTML = bars(d.sources);

  $('#footnote').textContent =
    `${t.assigned} of ${t.carts} carts assigned · ${t.callbacks} callbacks scheduled`
    + (t.overdue ? `, ${t.overdue} overdue` : '')
    + ` · ${t.declined} declined.`;
}

let period = 'day';
const PERIOD_HEAD = { day: 'Date', week: 'Week starting', month: 'Month' };

function periodLabel(bucket) {
  // bucket is a YYYY-MM-DD string, deliberately not a Date — parsing it as one
  // reintroduces the timezone shift the server query exists to avoid.
  const [y, m, dd] = bucket.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  if (period === 'month') return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: period === 'week' ? undefined : undefined });
}

async function loadReport() {
  try {
    const res = await fetch(`/api/admin/report?period=${period}&limit=14`);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load the report');

    $('#periodHead').textContent = PERIOD_HEAD[period];
    $('#reportCsv').href = `/api/admin/report.csv?period=${period}`;
    $('#reportRows').innerHTML = d.rows.length
      ? d.rows.map((r) => `
          <tr>
            <td>${esc(periodLabel(r.bucket))}</td>
            <td class="right">${r.carts}</td>
            <td class="right">${money(r.cart_value)}</td>
            <td class="right">${r.worked}</td>
            <td class="right">${r.contact_rate}%</td>
            <td class="right">${r.recovered}</td>
            <td class="right"><strong>${r.recovery_rate}%</strong></td>
            <td class="right">${money(r.recovered_value)}</td>
          </tr>`).join('')
      : '<tr><td colspan="8" class="empty">No carts yet.</td></tr>';
  } catch (err) {
    $('#reportRows').innerHTML = `<tr><td colspan="8" class="empty">${esc(err.message)}</td></tr>`;
  }
}

$('#periodGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  period = btn.dataset.period;
  $('#periodGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  loadReport();
});

$('#dashRange').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  days = Number(btn.dataset.days);
  $('#dashRange').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  load();
});

fetch('/auth/me').then((r) => r.json()).then((me) => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#hello').textContent = me.name ? `${part}, ${me.name}` : 'Dashboard';
}).catch(() => {});

load();
loadReport();
setInterval(load, 60_000);
