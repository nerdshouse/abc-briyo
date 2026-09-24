'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let days = 7;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (v) => inr.format(Number(v || 0));
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/** "7h" reads faster than "25542 seconds" when you are scanning for a problem. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const ago = (s) => (s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);

const relative = (iso) => {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

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

/** A plain card. `tip` carries the definition, so no number is unexplained. */
const card = (label, value, cls = '', tip = '') =>
  `<div class="stat ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>
     <div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;

/** A card that opens the rows behind it. */
const clickCard = (bucket, label, value, cls = '', tip = '') =>
  `<button type="button" class="stat stat-click ${cls}" data-bucket="${esc(bucket)}"
           title="${esc(tip)}">
     <div class="label">${esc(label)}</div><div class="value">${value}</div></button>`;

let latest = null;

async function load() {
  try {
    const res = await fetch(`/api/admin/overview?days=${days}`);
    if (res.status === 403) { $('#banner').textContent = 'Admins only.'; $('#banner').hidden = false; return; }
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load the dashboard');
    latest = d;
    render(d);
    $('#banner').hidden = true;
  } catch (err) {
    $('#banner').textContent = err.message;
    $('#banner').hidden = false;
  }
}

function renderQueue(q, slaHours) {
  $('#queue').innerHTML = [
    clickCard('unassigned', 'Unassigned', q.unassigned, q.unassigned ? 'stat-warn' : '',
      `Never called and nobody has claimed it — ${money(q.unassigned_value)} sitting with no owner.`),
    clickCard('stale', `Uncalled ${slaHours}h+`, q.stale, q.stale ? 'stat-alarm' : '',
      `Still "Not called" more than ${slaHours}h after it reached us — ${money(q.stale_value)}.`),
    clickCard('callbacks_today', 'Callbacks today', q.callbacks_today, q.callbacks_today ? 'stat-warn' : '',
      'Promised a call back at some point today.'),
    clickCard('callbacks_overdue', 'Callbacks missed', q.callbacks_overdue, q.callbacks_overdue ? 'stat-alarm' : '',
      'The promised time has already passed. Overlaps with "today" when the slot was earlier today.'),
  ].join('');
}

/** The rows behind a queue number, in a drawer under the cards. */
async function openDrawer(bucket, label) {
  const el = $('#drawer');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const res = await fetch(`/api/admin/carts?bucket=${encodeURIComponent(bucket)}&days=${days}`);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load those carts');

    el.innerHTML = `
      <div class="panel insight" style="margin-top:12px">
        <header>
          <h2>${esc(label)}</h2>
          <button type="button" class="linky" id="closeDrawer">Close</button>
        </header>
        <table class="mini">
          <thead><tr>
            <th>Customer</th><th class="right">Value</th><th>Status</th>
            <th>Owner</th><th class="right">Waiting</th><th>Call</th>
          </tr></thead>
          <tbody>${d.carts.length ? d.carts.map((c) => `
            <tr>
              <td>${esc(c.customer_name || '—')}<br><span class="muted">${esc(c.phone || '')}</span></td>
              <td class="right">${money(c.total_price)}</td>
              <td>${esc(c.status || 'Not called')}</td>
              <td>${esc(c.assigned_to_name || '—')}</td>
              <td class="right">${relative(c.received_at)}</td>
              <td>${c.phone ? `<a href="tel:${esc(c.phone)}">Call</a>` : '—'}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">Nothing in here — good.</td></tr>'}
          </tbody>
        </table>
      </div>`;
    $('#closeDrawer').addEventListener('click', () => { el.innerHTML = ''; });
  } catch (err) {
    el.innerHTML = `<p class="banner error">${esc(err.message)}</p>`;
  }
}

$('#queue').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-bucket]');
  if (!btn) return;
  openDrawer(btn.dataset.bucket, btn.querySelector('.label').textContent);
});

function render(d) {
  const t = d.totals;
  const h = d.health;

  renderQueue(d.queue, h.slaHours);

  // --- today, with yesterday for contrast --------------------------------
  const { today, yesterday } = d.daily;
  const delta = (a, b) => {
    if (!b) return '';
    const diff = pct(a - b, b);
    return diff === 0 ? ' (same as yesterday)' : ` (${diff > 0 ? '+' : ''}${diff}% vs yesterday)`;
  };
  $('#today').innerHTML = [
    card('Carts in', today.carts, '', `Yesterday: ${yesterday.carts}`),
    card('Cart value', money(today.value), '', `Yesterday: ${money(yesterday.value)}`),
    card('Called', today.called, today.carts && !today.called ? 'stat-warn' : '',
      `Yesterday: ${yesterday.called}. Anything other than "Not called".`),
    card('Recovered', today.recovered, today.recovered ? 'stat-good' : '',
      `Yesterday: ${yesterday.recovered}`),
    card('Recovered cart value', money(today.recovered_value), today.recovered ? 'stat-good' : '',
      `Yesterday: ${money(yesterday.recovered_value)}. Cart value at abandonment, not verified order revenue.`),
  ].join('');
  $('#todayMeta').textContent = `${yesterday.carts} cart${yesterday.carts === 1 ? '' : 's'} yesterday`
    + delta(today.carts, yesterday.carts);

  // --- money -------------------------------------------------------------
  $('#money').innerHTML = [
    card('Came in', money(t.value), '', 'Cart value of everything received in this range.'),
    card('Recovered cart value', money(t.recovered_value), t.recovered ? 'stat-good' : '',
      'Cart value at the time of abandonment for carts marked recovered. '
      + 'It is not verified order revenue — no order is fetched to confirm it.'),
    card('Still open', money(t.open_value), '',
      'Neither recovered nor declined — including carts nobody has called yet.'),
    card('Lost', money(t.declined_value), '',
      'Cart value where the customer actually said no. Uncalled carts are NOT counted here.'),
    card('Recovered % of called', `${pct(t.recovered, t.worked)}%`, '',
      'Recovered ÷ carts called. The board uses this same definition.'),
    card('Median time to first call', duration(d.medianSecondsToFirstTouch), '',
      'From the cart reaching us to someone first touching it.'),
  ].join('');
  $('#moneyMeta').textContent = days ? `last ${days} day${days === 1 ? '' : 's'}` : 'all time';

  // --- health ------------------------------------------------------------
  const problems = [];
  if (h.ingestSilent) problems.push(`No carts received for ${Math.round(h.lastIngestAgeMinutes / 60)}h — check the GoKwik webhook.`);
  if (h.webhookFailures24h) problems.push(`${h.webhookFailures24h} webhook delivery failure(s) in the last 24h.`);
  if (h.staleCarts) problems.push(`${h.staleCarts} cart(s) uncalled for over ${h.slaHours}h (${money(h.staleValue)}).`);
  const banner = $('#health');
  banner.className = 'banner ' + (h.ingestSilent || h.webhookFailures24h ? 'error' : 'mock');
  banner.innerHTML = problems.length ? `<strong>Needs attention.</strong> ${problems.map(esc).join(' ')}` : '';
  banner.hidden = !problems.length;

  // --- pipeline ----------------------------------------------------------
  // Each step as a share of the one before it, which is where work is lost.
  const steps = [
    ['Carts in', t.carts, t.carts],
    ['Assigned', t.assigned, t.carts],
    ['Called', t.worked, t.carts],
    ['Recovered', t.recovered, t.worked],
  ];
  $('#funnel').innerHTML = steps.map(([label, n, base]) => `
    <div class="bar-row">
      <span class="bar-label">${label}</span>
      <span class="bar"><span class="bar-fill" style="width:${pct(n, t.carts)}%"></span></span>
      <span class="bar-count">${n} <span class="muted">${pct(n, base)}%</span></span>
    </div>`).join('');

  // --- trend -------------------------------------------------------------
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

  // --- team --------------------------------------------------------------
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

  // --- sources -----------------------------------------------------------
  // The gaps are the point: it says which panels below a source can populate,
  // read from the data rather than hardcoded, so it stays true if that changes.
  const SOURCE_NAME = { gokwik: 'GoKwik', shopify: 'Shopify (live)', 'shopify-csv': 'Shopify (CSV)' };
  $('#sources').innerHTML = d.bySource.length
    ? d.bySource.map((s) => {
        const missing = [
          !s.has_stage && 'no drop stage',
          !s.has_risk && 'no risk flag',
          !s.has_utm && 'no marketing source',
        ].filter(Boolean);
        return `
          <div class="bar-row">
            <span class="bar-label" title="${esc(s.source)}">${esc(SOURCE_NAME[s.source] || s.source)}</span>
            <span class="bar"><span class="bar-fill"
              style="width:${pct(s.carts, Math.max(1, ...d.bySource.map((x) => x.carts)))}%"></span></span>
            <span class="bar-count">${s.carts}</span>
          </div>
          <p class="muted" style="margin:-4px 0 8px 0">
            ${money(s.value)} · ${s.recovered} recovered${missing.length ? ` · ${esc(missing.join(', '))}` : ''}
          </p>`;
      }).join('')
    : '<p class="muted">No carts in this range.</p>';

  // --- drop stage / risk / utm -------------------------------------------
  const gokwik = d.bySource.find((s) => s.source === 'gokwik')?.carts ?? 0;
  $('#stageMeta').textContent = gokwik === t.carts
    ? 'in range' : `GoKwik carts only — ${gokwik} of ${t.carts}`;
  $('#stages').innerHTML = bars(d.stages);

  $('#risk').innerHTML = d.risk.length
    ? bars(d.risk.map((r) => ({
        label: `${r.label} · ${SOURCE_NAME[r.source] || r.source}`, n: r.n,
      })))
    : '<p class="muted">Nothing yet.</p>';

  $('#utm').innerHTML = bars(d.utm);
  const taggedUtm = d.utm.reduce((sum, u) => sum + (u.label === 'unknown' ? 0 : u.n), 0);
  $('#utmMeta').textContent = `${taggedUtm} of ${t.carts} carts carry a marketing source`;

  $('#footnote').textContent =
    `${t.assigned} of ${t.carts} carts assigned · ${t.callbacks} callbacks scheduled`
    + (t.overdue ? `, ${t.overdue} overdue` : '')
    + ` · ${t.declined} declined.`;
}

const ACTIVITY_VERB = {
  status: (e) => `${e.from_status || 'new'} → <strong>${esc(e.to_status)}</strong>`,
  note: (e) => (e.detail ? `noted “${esc(e.detail)}”` : 'cleared the note'),
  callback: (e) => (e.detail === 'cleared' ? 'cleared the callback' : `callback set for ${esc(e.detail)}`),
  reason: (e) => (e.detail === 'cleared' ? 'cleared the reasons' : `reason: ${esc(e.detail)}`),
  assign: (e) => (e.detail === 'unassigned' ? 'unassigned it' : `assigned to ${esc(e.detail)}`),
};

const when = (iso) => new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});

/** Who did what to which cart, newest first. */
async function loadActivity() {
  try {
    const res = await fetch('/api/admin/events?limit=60');
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load the activity log');
    $('#activity').innerHTML = d.events.length
      ? `<div class="hist">${d.events.map((e) => {
          const verb = ACTIVITY_VERB[e.kind];
          const what = verb ? verb(e) : esc(e.detail || e.kind || 'changed');
          const who = esc(e.customer_name || `cart ${e.cart_id}`);
          return `<div class="hist-row">
            <span class="hist-when">${esc(when(e.at))}</span>
            <span class="hist-what"><strong>${esc(e.actor || 'system')}</strong> — ${what}
              <span class="muted">on ${who}</span></span>
            <span class="hist-who">${e.total_price != null ? money(e.total_price) : ''}</span>
          </div>`;
        }).join('')}</div>`
      : '<p class="muted">Nothing recorded yet.</p>';
    $('#activityMeta').textContent = `${d.events.length} most recent changes`;
  } catch (err) {
    $('#activity').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

/** Reasons live on their own endpoint, shared with the board. */
async function loadReasons() {
  try {
    const res = await fetch(`/api/reasons/summary?days=${days}`);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load reasons');
    $('#reasons').innerHTML = d.reasons.length
      ? bars(d.reasons.map((r) => ({ label: r.tag, n: r.count })))
      : '<p class="muted">No reasons tagged yet — callers add these as they work.</p>';
    $('#reasonMeta').textContent = d.taggedCarts
      ? `${d.taggedCarts} cart${d.taggedCarts === 1 ? '' : 's'} tagged` : '';
  } catch { /* secondary — never let it blank the page */ }
}

let period = 'day';
const PERIOD_HEAD = { day: 'Date', week: 'Week starting', month: 'Month' };

function periodLabel(bucket) {
  // bucket is a YYYY-MM-DD string, deliberately not a Date — parsing it as one
  // reintroduces the timezone shift the server query exists to avoid.
  const [y, m, dd] = bucket.split('-').map(Number);
  const d = new Date(y, m - 1, dd);
  if (period === 'month') return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
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
  // The drawer belongs to a number that may no longer be on screen.
  $('#drawer').innerHTML = '';
  load();
  loadReasons();
  loadActivity();
});

fetch('/auth/me').then((r) => r.json()).then((me) => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#hello').textContent = me.name ? `${part}, ${me.name}` : 'Owner view';
}).catch(() => {});

load();
loadReasons();
loadReport();
loadActivity();
setInterval(load, 60_000);
