/**
 * Call board (v2 shell).
 *
 * The same caller workflow as before — the same endpoints, the same save
 * payloads, the same conflict guard and callback-time rule — laid out as a dense
 * table with the outcome controls in a drawer, so a row can be scanned in one
 * glance and worked without leaving the list.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dayKey, dateTime,
  relative, span, statusOf, statusIndicator, followUp, hbars, initials, initShell,
  setNavCount, STATUS_LABELS, pageSignal, onLeave, onQueryChange, pageFetch,
} from './ui/components.js';

// Requests belong to this page: cancelled, and never rendered, once it is left.
const fetch = pageFetch();

const STATUSES = [
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
];

/** Call-priority ranking for the risk sort. Anything unrecognised sorts last. */
const RISK_ORDER = { 'high risk': 3, 'medium risk': 2, 'low risk': 1, control: 0 };

let REASON_TAGS = [];
let SLA_HOURS = 6;
let TEAM = [];
let ME = null;

const st = (c) => c.status || 'Not called';

/**
 * Views, in the order a caller works. The first four are the board's original
 * queues and keep their URL names; the rest are narrower lenses on the same
 * loaded carts, filtered in the browser — no new query, no new rule.
 */
const VIEWS = {
  tocall:     { label: 'To call',         sort: 'value',    match: (c) => st(c) === 'Not called' },
  attention:  { label: 'Needs attention', sort: 'recent',   match: (c) => Boolean(attentionOf(c)) },
  callbacks:  { label: 'Callbacks',       sort: 'callback', match: (c) => st(c) === 'Callback scheduled' },
  mine:       { label: 'My queue',        sort: 'value',    match: (c) => Boolean(ME) && c.assigned_to === ME },
  unassigned: { label: 'Unassigned',      sort: 'value',    match: (c) => !c.assigned_to },
  recovered:  { label: 'Recovered',       sort: 'recent',   match: (c) => st(c) === 'Called – Recovered' },
  lost:       { label: 'Lost',            sort: 'recent',   match: (c) => st(c) === 'Called – Declined' },
  all:        { label: 'All',             sort: 'recent',   match: () => true },
};

const state = {
  carts: [],
  query: '',
  days: 7,
  view: 'tocall',
  sort: 'value',
  dir: -1,
  sortTouched: false,     // once chosen by hand, stop re-picking it per view
  f: { status: '', owner: '', follow: '', reason: '', value: '' },
  stale: null,
  total: 0,
  callbackTotal: null,
  truncated: false,
  mock: false,
  done: new Set(),        // saved rows that no longer belong in the view — dimmed, not removed
  openId: null,
};

const cartById = (id) => state.carts.find((c) => String(c.id) === String(id));

/* ------------------------------------------------------------------ helpers */

/** "18m" / "4h" / "3d" — age at a glance; the exact time is in the tooltip. */
function ageShort(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Convert an Indian number to wa.me's 91XXXXXXXXXX form; null if unusable. */
function waNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return digits.length >= 10 ? digits : null;
}

function waMessage(cart) {
  const name = cart.customer_name ? cart.customer_name.split(' ')[0] : 'there';
  return `Hi ${name}! This is Briyo Supplements. We noticed you left a few items in your cart — `
    + `can we help you complete your order? Here's your cart: ${cart.checkout_url || ''}`;
}
const waLink = (c) => { const n = waNumber(c.phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(waMessage(c))}` : null; };
const telLink = (c) => (c.phone ? `tel:${String(c.phone).replace(/\s/g, '')}` : null);

/**
 * Line items live in the payload; GoKwik sends them as an array or a string.
 * The server exposes the parsed form; fall back to the raw shapes if absent.
 */
function itemsOf(cart) {
  if (Array.isArray(cart.items) && cart.items.length) return cart.items;
  const raw = cart.raw_payload || {};
  const list = raw.items || raw.line_items || raw.lineItems || raw.products || [];
  if (!Array.isArray(list)) return [];
  return list.map((i) => ({
    title: i?.title || i?.name || i?.product_name || i?.sku || 'Item',
    quantity: Number(i?.quantity ?? i?.qty ?? 1),
  }));
}

/** Pull the pack size off the end of a long product name so it survives truncation. */
function splitPack(title) {
  const m = String(title).match(/^(.*?)\s*[-–|]\s*((?:Pack of|Box of)\s*\d+|\d+\s*Box(?:es)?)\s*$/i);
  return m ? { name: m[1].trim(), pack: m[2].trim() } : { name: String(title), pack: null };
}

const isHighRisk = (c) => /^high/i.test(String(c.risk_flag || ''));

/** Callback timing in the board's timezone — the buckets the Follow-up filter uses. */
function callbackKind(c) {
  if (st(c) !== 'Callback scheduled') return 'none';
  if (!c.callback_at) return 'missing';
  const diff = new Date(c.callback_at) - Date.now();
  if (diff < -60000) return 'overdue';
  if (dayKey(new Date(c.callback_at)) === dayKey(new Date()) || diff <= 60 * 60000) return 'today';
  return 'upcoming';
}

/**
 * Why a row deserves a second look, or null. Only facts already on the cart:
 * a promised callback that has passed or has no time, or a new cart past the
 * SLA the server already enforces for the stale alarm.
 */
function attentionOf(c) {
  const s = st(c);
  if (s === 'Callback scheduled') {
    if (!c.callback_at) return { kind: 'warn', text: 'Callback has no time set' };
    const diff = new Date(c.callback_at) - Date.now();
    if (diff < -60000) return { kind: 'bad', text: `Callback overdue by ${span(diff)}` };
    return null;
  }
  if (s === 'Not called') {
    const age = Date.now() - new Date(c.received_at).getTime();
    if (age > SLA_HOURS * 3600000) return { kind: 'warn', text: `Not called for ${span(age)} — past the ${SLA_HOURS}h target` };
  }
  return null;
}

/** <input type="datetime-local"> wants local wall-clock, not an ISO UTC string. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Who, and exactly when — attribution without asking anyone to type it. */
function savedLabel(cart) {
  if (!cart?.status_updated_at) return '';
  return `${cart.updated_by ? `${esc(cart.updated_by)} · ` : ''}${esc(dateTime(cart.status_updated_at))}`;
}

/* ------------------------------------------------------------------ alerts */

const alertsEl = $('#alerts');
let errorText = '';
function showError(msg) { errorText = msg; renderAlerts(); }
function clearError() { if (errorText) { errorText = ''; renderAlerts(); } }

/** The error, the mock banner, and the stale alarm — which no filter can hide. */
function renderAlerts() {
  const parts = [];
  if (errorText) parts.push(`<div class="alert" role="alert">${icon('triangle-alert')}<p>${esc(errorText)}</p></div>`);
  if (state.mock) {
    parts.push(`<div class="alert warn">${icon('info')}<p><b>Mock mode.</b> No database is configured, so this is sample data held in memory and lost on restart.</p></div>`);
  }
  const stale = Number(state.stale?.count ?? 0);
  if (stale) {
    parts.push(`<div class="alert warn">${icon('clock')}<p>${count(stale)} cart${stale === 1 ? '' : 's'} still not called after ${SLA_HOURS}h`
      + `${state.stale?.value ? ` (${esc(money(state.stale.value))})` : ''}.</p>`
      + '<button type="button" class="alert-link" data-goto="attention">Show them</button></div>');
  }
  alertsEl.innerHTML = parts.join('');
  renderIcons();
}

/* ------------------------------------------------------------------ URL */

const time = (iso) => (iso ? new Date(iso).getTime() : null);
const SORTS = {
  value:    { dir: -1, val: (c) => Number(c.total_price || 0) },
  recent:   { dir: -1, val: (c) => time(c.received_at) },
  // Ascending by callback time gives overdue, then due now, then upcoming.
  // Carts with no time set go to the bottom: a promise already broken outranks
  // a data-entry gap. Non-callbacks after those.
  callback: { dir: 1, val: (c) => (st(c) !== 'Callback scheduled' ? Number.MAX_VALUE : c.callback_at ? time(c.callback_at) : Number.MAX_SAFE_INTEGER) },
  customer: { dir: 1, val: (c) => String(c.customer_name || '').toLowerCase() },
  status:   { dir: 1, val: (c) => STATUSES.indexOf(st(c)) },
  owner:    { dir: 1, val: (c) => (c.assigned_to_name ? c.assigned_to_name.toLowerCase() : null) },
  updated:  { dir: -1, val: (c) => time(c.status_updated_at) },
  risk:     { dir: -1, val: (c) => RISK_ORDER[String(c.risk_flag || '').toLowerCase()] ?? -1 },
};

let urlApplied = false;
/**
 * Other pages link here already narrowed (?mode=, ?q=, ?days=). Old bookmarks
 * carried status/mine/overdue — mapped to the nearest view so they still land
 * somewhere sensible.
 */
function applyUrl() {
  if (urlApplied) return;
  urlApplied = true;
  const p = new URLSearchParams(window.location.search);
  if (p.has('days')) { state.days = Number(p.get('days')); $('#range').value = String(state.days); }
  if (p.has('q')) { state.query = p.get('q'); $('#search').value = state.query; }
  const legacy = p.get('status') === 'Not called' ? 'tocall'
    : p.get('status') === 'Callback scheduled' || p.get('overdue') === '1' ? 'callbacks'
    : p.get('mine') === '1' ? 'mine'
    : p.has('status') ? 'all' : null;
  if (p.has('mode') && VIEWS[p.get('mode')]) state.view = p.get('mode');
  else if (legacy) state.view = legacy;
  state.sort = VIEWS[state.view].sort;
  state.dir = SORTS[state.sort].dir;
}

/* ------------------------------------------------------------------ load */

async function loadAll(attempt = 1) {
  applyUrl();
  const MAX_ATTEMPTS = 3;
  $('#refresh').classList.add('spin');
  try {
    // The range is applied server-side; search deliberately ignores it.
    const params = state.query ? `q=${encodeURIComponent(state.query)}` : `days=${state.days}`;
    const [cfgRes, cartsRes] = await Promise.all([fetch('/api/config'), fetch(`/api/carts?${params}`)]);
    if ([cfgRes, cartsRes].some((r) => r.status === 401)) { window.location.href = '/login'; return; }
    const cfg = await cfgRes.json();
    const carts = await cartsRes.json();
    if (Array.isArray(cfg.reasonTags)) REASON_TAGS = cfg.reasonTags;
    if (cfg.slaHours) SLA_HOURS = cfg.slaHours;
    if (cfg.boardTimezone) setTimezone(cfg.boardTimezone);
    if (Array.isArray(cfg.team)) TEAM = cfg.team;
    ME = cfg.me ?? ME;
    state.mock = Boolean(cfg.mock);
    if (!carts.ok) throw new Error(carts.error || 'Could not load carts');

    state.carts = carts.carts;
    state.loadedFor = state.query;
    state.stale = carts.stale || null;
    state.total = carts.total ?? carts.carts.length;
    state.callbackTotal = carts.callbackTotal ?? null;
    state.truncated = Boolean(carts.truncated);
    state.done.clear();

    errorText = '';
    syncFilterOptions();
    render();
    renderInsights();   // the range may have changed; this is the only place it can
  } catch (err) {
    // A TypeError from fetch means the request never completed — the free
    // instance asleep or restarting. An HTTP error would not land here.
    const networkLevel = err instanceof TypeError;
    if (networkLevel && attempt < MAX_ATTEMPTS) {
      showError(`Server isn't responding — it may be waking up. Retrying (${attempt}/${MAX_ATTEMPTS - 1})…`);
      skeleton();
      await new Promise((r) => setTimeout(r, attempt * 4000));
      return loadAll(attempt + 1);
    }
    showError(networkLevel
      ? "Couldn't reach the server after several tries — it may still be starting up. Press Refresh in a moment."
      : `Could not load the board: ${err.message}`);
    $('#rows').innerHTML = '<tr><td colspan="11"><div class="empty-note"><b>Failed to load</b></div></td></tr>';
    $('#clist').innerHTML = '';
  } finally {
    $('#refresh').classList.remove('spin');
  }
}

function skeleton() {
  const cell = (w) => `<td><span class="sk ${w}"></span></td>`;
  $('#rows').innerHTML = Array.from({ length: 8 }, () => `<tr>${cell('')}${cell('w70')}${cell('w70')}${cell('w50')}${cell('w50')}${cell('w50')}${cell('w50')}${cell('w50')}${cell('w50')}${cell('w30')}${cell('')}</tr>`).join('');
  $('#clist').innerHTML = Array.from({ length: 4 }, () => '<li class="citem"><span class="sk w50"></span><span class="sk w70" style="margin-top:10px"></span><span class="sk w90" style="margin-top:10px"></span></li>').join('');
}

/* ------------------------------------------------------------------ sort + filter */

function compare(a, b) {
  const s = SORTS[state.sort];
  const x = s.val(a);
  const y = s.val(b);
  // Empty values sort last whichever way the column is ordered.
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  const d = (x < y ? -1 : x > y ? 1 : 0) * state.dir;
  // Within the same risk band, bigger carts first — that is the call order.
  if (d === 0 && state.sort === 'risk') return Number(b.total_price || 0) - Number(a.total_price || 0);
  return d;
}

function passesFilters(c) {
  const { status, owner, follow, reason, value } = state.f;
  if (status && statusOf(c.status).label !== status) return false;
  if (owner === '__none' ? c.assigned_to : owner && c.assigned_to !== owner) return false;
  if (follow && callbackKind(c) !== follow) return false;
  const tags = c.reason_tags || [];
  if (reason === '__none' ? tags.length : reason && !tags.includes(reason)) return false;
  if (value) {
    const [lo, hi] = value.split('-').map((v) => (v === '' ? null : Number(v)));
    const v = Number(c.total_price || 0);
    if (v < lo || (hi !== null && v >= hi)) return false;
  }
  return true;
}

/**
 * What is on screen, in order. A search is already the filter — narrowing it by
 * view as well would hide the customer who just rang back, the only reason to
 * search — so the view is bypassed; the column filters still apply.
 */
function visibleCarts() {
  const base = state.query
    ? state.carts.slice()
    : state.carts.filter((c) => VIEWS[state.view].match(c) || state.done.has(String(c.id)));
  return base.filter(passesFilters).sort(compare);
}

function syncFilterOptions() {
  const keep = (sel, html) => { const el = $(sel); const v = el.value; el.innerHTML = html; el.value = v; };
  keep('#fstatus', '<option value="">Status</option>' + STATUS_LABELS.map((s) => `<option>${esc(s)}</option>`).join(''));
  keep('#fowner', '<option value="">Owner</option>'
    + TEAM.map((t) => `<option value="${esc(t.phone)}">${esc(t.name)}${t.phone === ME ? ' (me)' : ''}</option>`).join('')
    + '<option value="__none">Unassigned</option>');
  const tags = [...new Set([...REASON_TAGS, ...state.carts.flatMap((c) => c.reason_tags || [])])];
  keep('#freason', '<option value="">Reason</option>' + tags.map((t) => `<option>${esc(t)}</option>`).join('')
    + '<option value="__none">None recorded</option>');
}

/* ------------------------------------------------------------------ render */

function render() {
  renderTabs();
  renderSummary();
  renderMeta();
  renderRows();
  renderSortMarks();
  syncRange();
  syncExport();
  renderAlerts();
  syncSidebar();
}

function renderTabs() {
  $('#viewTabs').innerHTML = Object.entries(VIEWS).map(([key, v]) => {
    const n = state.carts.filter(v.match).length;
    const tone = key === 'attention' && n ? ' is-alert' : '';
    return `<button type="button" role="tab" class="tab${key === state.view ? ' active' : ''}" data-view="${key}" aria-selected="${key === state.view}">`
      + `${esc(v.label)}<span class="tab-count${tone}">${count(n)}</span></button>`;
  }).join('');
  $('#viewTabs').classList.toggle('searching', Boolean(state.query));
  $('#crumbView').textContent = state.query ? 'Search' : VIEWS[state.view].label;
}

function renderSummary() {
  const value = state.carts.reduce((sum, c) => sum + Number(c.total_price || 0), 0);
  $('#rangeSummary').textContent = state.query
    ? `Searching all history for “${state.query}”`
    : `${count(state.total)} cart${state.total === 1 ? '' : 's'} · ${money(value)} in play`;
}

const RANGE_LABEL = { 1: 'today', 3: 'the last 3 days', 7: 'the last 7 days', 0: 'all time' };

/** Always says what is on screen versus what exists. */
function renderMeta() {
  const shown = visibleCarts().length;
  const filtered = Object.values(state.f).some(Boolean);
  const el = $('#resultNote');
  $('#fclear').hidden = !filtered;
  for (const [id, key] of [['#fstatus', 'status'], ['#fowner', 'owner'], ['#ffollow', 'follow'], ['#freason', 'reason'], ['#fvalue', 'value']]) {
    $(id).classList.toggle('on', Boolean(state.f[key]));
  }

  if (state.query) {
    el.textContent = `${count(shown)} result${shown === 1 ? '' : 's'} for “${state.query}” across all history`
      + (filtered ? ', filtered' : '') + (state.truncated ? ' — showing the first 50; narrow the search.' : '.');
    return;
  }
  if (state.view === 'callbacks') {
    const cbs = state.carts.filter(VIEWS.callbacks.match);
    const n = (k) => cbs.filter((c) => callbackKind(c) === k).length;
    const parts = [n('overdue') && `${n('overdue')} overdue`, n('today') && `${n('today')} due today`,
      n('upcoming') && `${n('upcoming')} upcoming`, n('missing') && `${n('missing')} with no time set`].filter(Boolean);
    el.textContent = `${cbs.length} callback${cbs.length === 1 ? '' : 's'}, all time${parts.length ? ` — ${parts.join(' · ')}` : ''}. The date range does not apply here.`;
    return;
  }
  const label = RANGE_LABEL[state.days] ?? `the last ${state.days} days`;
  el.textContent = state.truncated
    ? `Showing ${count(state.carts.length)} of ${count(state.total)} carts from ${label} — narrow the range to see the rest.`
    : `${count(shown)} in ${VIEWS[state.view].label.toLowerCase()}${filtered ? ' (filtered)' : ''}, of ${count(state.total)} cart${state.total === 1 ? '' : 's'} from ${label}.`;
}

const flagIcon = (a) => `<span class="flag ${a.kind}" title="${esc(a.text)}">${icon(a.kind === 'bad' ? 'alarm-clock' : 'circle-alert')}</span>`;
const tagsHtml = (c) => (c.brand_order_count > 0 ? `<span class="mini-tag" title="Has ordered ${c.brand_order_count} time(s) before">Repeat</span>` : '')
  + (isHighRisk(c) ? `<span class="mini-tag warn" title="${esc(c.risk_flag)} of return-to-origin">High RTO</span>` : '');

function rowHtml(c) {
  const a = attentionOf(c);
  const items = itemsOf(c);
  const first = items[0] ? splitPack(items[0].title) : null;
  const units = items.reduce((n, i) => n + (i.quantity || 1), 0);
  const tel = telLink(c);
  const wa = waLink(c);
  const cls = ['brow', a && `attn attn-${a.kind}`, ME && c.assigned_to === ME && 'mine',
    state.done.has(String(c.id)) && 'done', state.openId === String(c.id) && 'open'].filter(Boolean).join(' ');
  const tags = c.reason_tags || [];

  return `<tr class="${cls}" data-id="${esc(c.id)}" data-mine="${ME && c.assigned_to === ME ? 'true' : 'false'}" tabindex="0">
    <td class="col-flag">${a ? flagIcon(a) : ''}</td>
    <td>
      <div class="cell-main">${esc(c.customer_name || 'Guest')}${tagsHtml(c)}</div>
      <div class="cell-sub num">${esc(c.phone || 'No phone number')}</div>
    </td>
    <td class="col-items">${first
      ? `<div class="cell-item" title="${esc(items.map((i) => `${i.title} ×${i.quantity || 1}`).join('\n'))}">${esc(first.name)}${items[0].quantity > 1 ? ` <span class="soft">×${items[0].quantity}</span>` : ''}</div>`
        + `<div class="cell-sub">${items.length > 1 ? `+${items.length - 1} more · ` : ''}${units} unit${units === 1 ? '' : 's'}${first.pack ? ` · ${esc(first.pack)}` : ''}</div>`
      : `<span class="muted">${c.item_count ? `${c.item_count} items` : '—'}</span>`}</td>
    <td class="r"><div class="cell-main num">${money(c.total_price)}</div>${c.discount_total ? `<div class="cell-sub num">${money(c.discount_total)} off</div>` : ''}</td>
    <td><button type="button" class="status-btn" data-act="status" aria-haspopup="menu" title="Change outcome">${statusIndicator(c.status)}${icon('chevron-down', 'caret')}</button></td>
    <td>${c.assigned_to_name
      ? `<span class="owner">${esc(c.assigned_to_name)}</span>`
      : `<span class="muted unassigned">Unassigned</span>${ME ? '<button type="button" class="take" data-act="take" title="Assign this cart to me">Take</button>' : ''}`}</td>
    <td class="col-last">${c.status_updated_at
      ? `<div class="cell-text">${esc(c.updated_by || '—')}</div><div class="cell-sub" title="${esc(dateTime(c.status_updated_at))}">${esc(relative(c.status_updated_at))}</div>`
      : '<span class="muted">—</span>'}</td>
    <td>${followUp(c)}</td>
    <td class="col-reason">${tags.length
      ? `<span class="cell-text" title="${esc(tags.join(', '))}">${esc(tags.join(', '))}</span>`
      : c.drop_stage ? `<span class="muted cell-text" title="No reason recorded yet. GoKwik says they dropped off at the ${esc(c.drop_stage)}.">${esc(c.drop_stage)}</span>` : '<span class="muted">—</span>'}</td>
    <td class="r num soft" title="${esc(dateTime(c.received_at))}">${esc(ageShort(c.received_at))}</td>
    <td><div class="row-actions">
      ${tel ? `<a class="icon-btn bare" href="${esc(tel)}" title="Call ${esc(c.phone)}" aria-label="Call">${icon('phone')}</a>` : `<span class="icon-btn bare off" title="No phone number">${icon('phone-off')}</span>`}
      ${wa ? `<a class="icon-btn bare" href="${esc(wa)}" target="_blank" rel="noopener" title="WhatsApp with a ready opener" aria-label="WhatsApp">${icon('message-circle')}</a>` : ''}
      <button type="button" class="icon-btn bare" data-act="open" title="Open cart" aria-label="Open cart">${icon('panel-right-open')}</button>
    </div></td>
  </tr>`;
}

function cardHtml(c) {
  const a = attentionOf(c);
  const items = itemsOf(c);
  const first = items[0] ? splitPack(items[0].title) : null;
  const tel = telLink(c);
  const wa = waLink(c);
  const cls = ['citem', a && `attn attn-${a.kind}`, ME && c.assigned_to === ME && 'mine',
    state.done.has(String(c.id)) && 'done'].filter(Boolean).join(' ');
  return `<li class="${cls}" data-id="${esc(c.id)}" tabindex="0">
    <div class="ci-top">
      <span class="ci-val num">${money(c.total_price)}</span>
      <span class="ci-age num" title="${esc(dateTime(c.received_at))}">${esc(ageShort(c.received_at))} ago</span>
      ${a ? flagIcon(a) : ''}
      <button type="button" class="status-btn" data-act="status" aria-haspopup="menu">${statusIndicator(c.status)}${icon('chevron-down', 'caret')}</button>
    </div>
    <div class="ci-name">${esc(c.customer_name || 'Guest')}${tagsHtml(c)}</div>
    ${first ? `<div class="ci-items">${esc(first.name)}${items[0].quantity > 1 ? ` ×${items[0].quantity}` : ''}${items.length > 1 ? ` <span class="muted">+${items.length - 1} more</span>` : ''}</div>` : ''}
    ${st(c) === 'Callback scheduled' ? `<div class="ci-follow">${icon('calendar-clock')}${followUp(c)}</div>` : ''}
    ${a ? `<div class="ci-attn ${a.kind}">${esc(a.text)}</div>` : ''}
    <div class="ci-actions">
      ${tel ? `<a class="btn primary" href="${esc(tel)}">${icon('phone')}Call</a>` : '<span class="btn off">No phone</span>'}
      ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">${icon('message-circle')}WhatsApp</a>` : ''}
      <button type="button" class="btn" data-act="open">Open</button>
    </div>
  </li>`;
}

function renderRows() {
  const list = visibleCarts();
  if (!list.length) {
    const filtered = Object.values(state.f).some(Boolean);
    const [title, hint] = state.query
      ? ['Nothing matches that search.', 'Try a phone number, or part of a name or email.']
      : filtered ? ['No carts match these filters.', 'Try adjusting the filters or the date range.']
      : state.view === 'tocall' ? ['Nothing left to call.', 'Every cart in this range has been worked. Check Callbacks next.']
      : state.view === 'attention' ? ['Nothing needs attention.', 'No overdue callbacks and nothing past the call target.']
      : [`Nothing in ${VIEWS[state.view].label.toLowerCase()}.`, 'Switch view, or widen the date range.'];
    const empty = `<div class="empty-note"><b>${esc(title)}</b>${esc(hint)}${filtered ? ' <button type="button" class="linkish" data-clear>Clear filters</button>' : ''}</div>`;
    $('#rows').innerHTML = `<tr><td colspan="11">${empty}</td></tr>`;
    $('#clist').innerHTML = `<li class="citem empty">${empty}</li>`;
    return;
  }
  $('#rows').innerHTML = list.map(rowHtml).join('');
  $('#clist').innerHTML = list.map(cardHtml).join('');
  renderIcons();
}

/** Update one cart in place after a save — the rest of the list is untouched. */
function rerenderCart(id) {
  const c = cartById(id);
  if (!c) return;
  const tr = $(`#rows tr[data-id="${CSS.escape(String(id))}"]`);
  if (tr) tr.outerHTML = rowHtml(c);
  const li = $(`#clist li[data-id="${CSS.escape(String(id))}"]`);
  if (li) li.outerHTML = cardHtml(c);
  renderIcons();
}

function renderSortMarks() {
  $$('#cartTable th.sortable').forEach((th) => {
    const on = th.dataset.sort === state.sort;
    th.querySelector('.sort').textContent = on ? (state.dir > 0 ? '↑' : '↓') : '↕';
    th.classList.toggle('sorted', on);
  });
  $('#sort').value = ['value', 'risk', 'recent', 'callback'].includes(state.sort) ? state.sort : '';
}

/**
 * The date range is a browsing control. Callbacks outlive it, so inside that
 * view it is visibly off rather than live-looking and silently ignored.
 */
function syncRange() {
  const off = state.view === 'callbacks' && !state.query;
  $('#range').disabled = off;
  $('#rangePick').classList.toggle('disabled', off);
  $('#rangePick').title = off ? 'Callbacks are shown whatever the date range' : '';
}

function syncExport() {
  $('#exportCsv').href = state.query
    ? `/api/carts.csv?q=${encodeURIComponent(state.query)}`
    : `/api/carts.csv?days=${state.days}`;
}

function syncSidebar() {
  setNavCount('countToCall', state.carts.filter(VIEWS.tocall.match).length);
  const overdue = state.carts.some((c) => callbackKind(c) === 'overdue');
  setNavCount('countCallbacks', state.callbackTotal ?? state.carts.filter(VIEWS.callbacks.match).length, { alert: overdue });
  $$('[data-view-link]').forEach((a) => {
    const v = a.dataset.viewLink;
    a.classList.toggle('active', v === 'board' || (!state.query && v === state.view));
  });
}

/* ------------------------------------------------------------------ insights */

let byCallerForbidden = false;
let insightsTimer = null;
/** The panels are secondary; after a save a trailing refresh is plenty. */
function scheduleInsights() { clearTimeout(insightsTimer); insightsTimer = setTimeout(renderInsights, 3000); }

async function renderInsights() {
  try {
    const [rRes, cRes] = await Promise.all([
      fetch(`/api/reasons/summary?days=${state.days}`),
      // By-caller is admin-only; a caller gets 403 by design, so do not keep asking.
      byCallerForbidden ? Promise.resolve(null) : fetch(`/api/stats/by-caller?days=${state.days}`),
    ]);
    if (cRes?.status === 403) byCallerForbidden = true;
    if (cRes?.ok) {
      const d = await cRes.json();
      $('#callerRows').innerHTML = d.callers.length
        ? d.callers.map((c) => `<tr>
            <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="avatar" style="width:24px;height:24px;font-size:10px">${esc(initials(c.caller))}</span>${esc(c.caller)}</span></td>
            <td class="r num">${count(c.touched)}</td><td class="r num">${count(c.recovered)}</td>
            <td class="r num">${c.recovery_rate}%</td><td class="r num">${money(c.recovered_value)}</td></tr>`).join('')
        : '<tr><td colspan="5"><div class="empty-note">Nobody has worked a cart in this range yet.</div></td></tr>';
    } else if (byCallerForbidden) {
      $('#callerPanel').hidden = true;   // not an error: this panel simply is not theirs
    }
    if (!rRes.ok) return;
    const r = await rRes.json();
    $('#reasonList').innerHTML = r.reasons.length
      ? hbars(r.reasons.map((x) => ({ label: x.tag, n: x.count })))
      : '<div class="empty-note"><b>No reasons recorded yet</b>Add them from a cart as you call.</div>';
    $('#reasonMeta').textContent = r.taggedCarts ? `${r.taggedCarts} tagged` : '';
  } catch { /* secondary — never let them break the call list */ }
}

/* ------------------------------------------------------------------ save */

function setSaved(id, html, tone = '') {
  if (state.openId !== String(id)) return;
  const el = $('#dSaved');
  el.innerHTML = html;
  el.className = `saved ${tone}`;
}

/**
 * Save one change. The payloads are exactly the ones the board has always sent,
 * including `seenAt`, so the server's conflict guard still stops one caller's
 * notes silently replacing another's.
 */
async function saveRow(id, patch) {
  id = String(id);
  setSaved(id, 'Saving…', 'pending');
  try {
    const res = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, seenAt: cartById(id)?.status_updated_at ?? null, ...patch }),
    });
    const data = await res.json();

    if (res.status === 409 && data.conflict) {
      showError(`${data.error} Your text is still here — reload to see theirs, or save again to overwrite.`);
      setSaved(id, 'Not saved — conflict', 'failed');
      // Adopt their timestamp so a deliberate second save goes through.
      const cart = cartById(id);
      if (cart && data.current) cart.status_updated_at = data.current.status_updated_at;
      return false;
    }
    if (data.needsCallbackTime) {
      if (state.openId !== id) openDrawer(id);
      flagCallbackNeeded(data.error);
      setSaved(id, 'Not saved', 'failed');
      return false;
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const cart = cartById(id);
    if (cart) {
      cart.status = data.entry.status;
      cart.notes = data.entry.notes;
      cart.status_updated_at = data.entry.status_updated_at;
      cart.callback_at = data.entry.callback_at ?? null;
      cart.reason_tags = data.entry.reason_tags ?? cart.reason_tags ?? [];
      cart.updated_by = data.entry.updated_by ?? cart.updated_by;
      if ('assigned_to' in data.entry) {
        cart.assigned_to = data.entry.assigned_to;
        cart.assigned_to_name = data.entry.assigned_to_name;
      }
      // The row stays put rather than vanishing — losing it under your cursor
      // is worse than seeing it a moment longer — but dims once it has left the view.
      if (!state.query && !VIEWS[state.view].match(cart)) state.done.add(id);
      else state.done.delete(id);
    }
    clearError();
    setSaved(id, savedLabel(cart || data.entry));
    rerenderCart(id);
    if (state.openId === id) refreshDrawer();
    // Counts move with every save, so they cannot wait for the next reload.
    renderTabs();
    renderSummary();
    renderMeta();
    syncSidebar();
    scheduleInsights();
    return true;
  } catch (err) {
    showError(`Couldn't save that change: ${err.message} — your edit is still here, try again.`);
    setSaved(id, 'Not saved', 'failed');
    return false;
  }
}

/**
 * Changing the outcome. "Callback scheduled" needs a time, so it opens the
 * cart with the picker waiting rather than attempting a save the server refuses.
 */
function changeStatus(id, status) {
  const cart = cartById(id);
  if (!cart || st(cart) === status) return;
  if (status === 'Callback scheduled') {
    openDrawer(id);
    showCallback(true);
    const input = $('#dBody .js-callback');
    if (!input.value) { flagCallbackNeeded(); return; }
    saveRow(id, { status, callbackAt: new Date(input.value).toISOString() });
    return;
  }
  const notes = state.openId === String(id) ? ($('#dBody .js-notes')?.value ?? cart.notes ?? '') : (cart.notes ?? '');
  saveRow(id, { status, notes, callbackAt: null });
}

/* ------------------------------------------------------------------ status menu */

const menu = $('#statusMenu');
let menuFor = null;

function openStatusMenu(btn, id) {
  const cart = cartById(id);
  menuFor = String(id);
  menu.innerHTML = STATUSES.map((s) => `<button type="button" role="menuitem" data-status="${esc(s)}" class="${st(cart) === s ? 'on' : ''}" title="${esc(s)}">`
    + `${statusIndicator(s)}${st(cart) === s ? icon('check', 'tick') : ''}</button>`).join('');
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left)) + window.scrollX}px`;
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  renderIcons();
  menu.querySelector('button')?.focus();
}
function closeStatusMenu() { menu.hidden = true; menuFor = null; }

menu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (!b || !menuFor) return;
  const id = menuFor;
  closeStatusMenu();
  changeStatus(id, b.dataset.status);
});

/* ------------------------------------------------------------------ drawer */

const drawer = $('#drawer');
const SOURCE_NAME = { gokwik: 'GoKwik', shopify: 'Shopify', 'shopify-csv': 'Shopify CSV' };

function openDrawer(id) {
  id = String(id);
  const cart = cartById(id);
  if (!cart) return;
  const switching = state.openId !== id;
  state.openId = id;
  $$('#rows tr.open').forEach((tr) => tr.classList.remove('open'));
  $(`#rows tr[data-id="${CSS.escape(id)}"]`)?.classList.add('open');
  if (switching) {
    renderDrawer(cart);
    loadEvents(id);
  }
  drawer.hidden = false;
  $('#drawerScrim').hidden = false;
  syncDrawerNav();
}

function closeDrawer() {
  drawer.hidden = true;
  $('#drawerScrim').hidden = true;
  $$('#rows tr.open').forEach((tr) => tr.classList.remove('open'));
  const id = state.openId;
  state.openId = null;
  // Focus returns to the row, so keyboard work can carry on from the list.
  if (id) $(`#rows tr[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function syncDrawerNav() {
  const list = visibleCarts();
  const i = list.findIndex((c) => String(c.id) === state.openId);
  $('#dPrev').disabled = i <= 0;
  $('#dNext').disabled = i < 0 || i >= list.length - 1;
  $('#dNextBtn').disabled = $('#dNext').disabled;
}

function step(delta) {
  const list = visibleCarts();
  const i = list.findIndex((c) => String(c.id) === state.openId);
  const next = list[i + delta];
  if (next) openDrawer(next.id);
}

/**
 * Cart detail, in the order a caller needs it: who, what they wanted, what has
 * already happened, then the outcome and what comes next. Every control saves
 * with the same payload the old card sent.
 */
function renderDrawer(c) {
  const items = itemsOf(c);
  const tel = telLink(c);
  const wa = waLink(c);
  const tags = c.reason_tags || [];
  const s = st(c);

  $('#dTitle').textContent = c.customer_name || 'Guest';
  $('#dSub').innerHTML = `<span class="num">${esc(money(c.total_price))}</span> · abandoned ${esc(relative(c.abandoned_at || c.received_at))} · ${esc(SOURCE_NAME[c.source] || c.source || 'GoKwik')}`;
  $('#dSaved').innerHTML = savedLabel(c);
  $('#dSaved').className = 'saved';

  $('#dBody').innerHTML = `
    <div class="d-actions">
      ${tel ? `<a class="btn primary" href="${esc(tel)}">${icon('phone')}Call ${esc(c.phone)}</a>` : '<span class="btn off">No phone number</span>'}
      ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">${icon('message-circle')}WhatsApp</a>` : ''}
      ${c.checkout_url ? `<a class="btn" href="${esc(c.checkout_url)}" target="_blank" rel="noopener">${icon('external-link')}Open cart</a>` : ''}
    </div>

    <section class="dsec">
      <h3 class="dsec-title">Customer</h3>
      <dl class="kv">
        <dt>Phone</dt><dd class="num">${esc(c.phone || '—')}</dd>
        <dt>Email</dt><dd>${esc(c.email || '—')}</dd>
        ${c.brand_order_count > 0 ? `<dt>History</dt><dd>Ordered ${count(c.brand_order_count)} time${c.brand_order_count === 1 ? '' : 's'} before</dd>` : ''}
        ${c.risk_flag ? `<dt>RTO risk</dt><dd>${esc(c.risk_flag)}</dd>` : ''}
        ${c.gokwik_message_queued || c.gokwik_email_sent ? `<dt>GoKwik</dt><dd class="soft">Already sent this customer a ${[c.gokwik_message_queued && 'message', c.gokwik_email_sent && 'email'].filter(Boolean).join(' and ')}</dd>` : ''}
      </dl>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Cart <span class="dsec-meta num">${esc(money(c.total_price))}${c.discount_total ? ` · ${esc(money(c.discount_total))} off` : ''}</span></h3>
      ${items.length ? `<ul class="d-items">${items.map((i) => {
        const p = splitPack(i.title);
        return `<li><span class="d-item-name" title="${esc(i.title)}">${esc(p.name)}</span>${p.pack ? `<span class="mini-tag">${esc(p.pack)}</span>` : ''}<span class="d-qty num">×${i.quantity || 1}</span></li>`;
      }).join('')}</ul>` : `<p class="soft" style="margin:0">${c.item_count ? `${c.item_count} items` : 'No items recorded.'}</p>`}
      <dl class="kv" style="margin-top:10px">
        ${c.drop_stage ? `<dt>Dropped off at</dt><dd>${esc(c.drop_stage)}</dd>` : ''}
        <dt>Abandoned</dt><dd class="num">${esc(dateTime(c.abandoned_at || c.received_at))}</dd>
      </dl>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Contact history</h3>
      <div id="dHistory"><span class="sk w70"></span></div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Outcome</h3>
      <div class="outcomes" role="radiogroup" aria-label="Outcome">
        ${STATUSES.map((x) => `<button type="button" role="radio" class="oc${x === s ? ' on' : ''}" data-status="${esc(x)}" aria-checked="${x === s}" title="${esc(x)}">${statusIndicator(x)}</button>`).join('')}
      </div>
      <div class="d-callback" ${s === 'Callback scheduled' ? '' : 'hidden'}>
        <label class="d-label" for="dCallback">Call back at</label>
        <input id="dCallback" class="input js-callback" type="datetime-local" value="${esc(toLocalInput(c.callback_at))}" />
        <div class="cb-hint" hidden></div>
      </div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Next action</h3>
      <div class="d-row">
        <label class="d-label" for="dOwner">Owner</label>
        <div class="d-owner">
          <select id="dOwner" class="select js-assign" aria-label="Owner">
            <option value="">Unassigned</option>
            ${TEAM.map((t) => `<option value="${esc(t.phone)}"${t.phone === c.assigned_to ? ' selected' : ''}>${esc(t.name)}${t.phone === ME ? ' (me)' : ''}</option>`).join('')}
          </select>
          <button type="button" class="btn js-takeit"${c.assigned_to || !ME ? ' hidden' : ''}>Take it</button>
        </div>
      </div>
      <div class="d-row"><span class="d-label">Follow-up</span><span id="dFollow">${followUp(c)}</span></div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Notes</h3>
      <textarea class="input js-notes" rows="3" placeholder="What happened on the call…" aria-label="Call notes">${esc(c.notes || '')}</textarea>
      <div class="hint" style="margin-top:6px">Saves when you leave the box or press Enter · Shift+Enter for a new line</div>
      <div class="d-label" style="margin-top:14px">Why didn't they buy?</div>
      <div class="pills">
        ${REASON_TAGS.map((t) => `<label class="pill${tags.includes(t) ? ' on' : ''}"><input type="checkbox" class="js-tag" value="${esc(t)}"${tags.includes(t) ? ' checked' : ''} />${esc(t)}</label>`).join('')}
      </div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Timeline</h3>
      <div id="dTimeline"><span class="sk w70"></span></div>
    </section>`;
  $('#dBody').scrollTop = 0;
  renderIcons();
}

/** After a save: update what changed, never the note someone may be typing. */
function refreshDrawer() {
  const c = cartById(state.openId);
  if (!c) return;
  const s = st(c);
  $$('#dBody .oc').forEach((b) => { const on = b.dataset.status === s; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  showCallback(s === 'Callback scheduled');
  if (s === 'Callback scheduled' && c.callback_at) {
    const input = $('#dBody .js-callback');
    if (document.activeElement !== input) input.value = toLocalInput(c.callback_at);
    input.classList.remove('needed');
    $('#dBody .cb-hint').hidden = true;
  }
  $('#dOwner').value = c.assigned_to || '';
  $('#dBody .js-takeit').hidden = Boolean(c.assigned_to) || !ME;
  $('#dFollow').innerHTML = followUp(c);
  const tags = c.reason_tags || [];
  $$('#dBody .js-tag').forEach((b) => { b.checked = tags.includes(b.value); b.closest('.pill').classList.toggle('on', b.checked); });
  loadEvents(state.openId);
  syncDrawerNav();
}

function showCallback(on) {
  const box = $('#dBody .d-callback');
  if (box) box.hidden = !on;
}

/** Ask for the callback time next to the field that needs it, not in a banner. */
function flagCallbackNeeded(message) {
  showCallback(true);
  const input = $('#dBody .js-callback');
  const hint = $('#dBody .cb-hint');
  if (!input) return;
  input.classList.add('needed');
  hint.textContent = message || 'Pick the date and time you promised to call back.';
  hint.hidden = false;
  input.focus();
}

const EVENT_TEXT = {
  status: (e) => `${esc(statusOf(e.to_status).label)}${e.from_status ? ` <span class="muted">from ${esc(statusOf(e.from_status).label)}</span>` : ''}`,
  note: (e) => (e.detail ? `Note: “${esc(e.detail)}”` : 'Note cleared'),
  callback: (e) => (e.detail === 'cleared' ? 'Callback cleared' : `Callback set for ${esc(e.detail)}`),
  reason: (e) => (e.detail === 'cleared' ? 'Reasons cleared' : `Reason: ${esc(e.detail)}`),
  assign: (e) => (e.detail === 'unassigned' ? 'Unassigned' : `Assigned to ${esc(e.detail)}`),
};
const EVENT_ICON = { status: 'phone-call', note: 'sticky-note', callback: 'alarm-clock', reason: 'tag', assign: 'user-plus' };

/**
 * Contact history is the outcomes; the timeline is everything. Both read the
 * same cart_events rows — nothing inferred or back-filled — plus the
 * abandonment itself, which the cart records.
 */
async function loadEvents(id) {
  try {
    const res = await fetch(`/api/carts/${encodeURIComponent(id)}/events`);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not load the history');
    if (state.openId !== String(id)) return;   // the drawer moved on meanwhile
    const cart = cartById(id);
    const events = d.events;
    const statusEvents = events.filter((e) => (e.kind || 'status') === 'status').slice().reverse();

    $('#dHistory').innerHTML = statusEvents.length
      ? `<ul class="d-history">${statusEvents.map((e) => `<li>
          ${statusIndicator(e.to_status)}<span class="soft">${esc(e.actor || 'System')}</span>
          <span class="d-when num">${esc(dateTime(e.at))}</span></li>`).join('')}</ul>`
      : '<p class="soft" style="margin:0">No calls recorded yet. Call history is kept from 23 Sep 2026.</p>';

    const rows = [
      ...events.map((e) => {
        const kind = e.kind || 'status';
        return { at: e.at, ico: EVENT_ICON[kind] || 'activity', text: (EVENT_TEXT[kind] || (() => esc(e.detail || kind)))(e), who: e.actor };
      }),
      { at: cart.abandoned_at || cart.received_at, ico: 'shopping-cart', text: 'Cart abandoned', who: SOURCE_NAME[cart.source] || 'GoKwik' },
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    $('#dTimeline').innerHTML = `<div class="timeline">${rows.map((r) => `<div class="act">
      <span class="act-ico">${icon(r.ico)}</span>
      <div style="min-width:0"><div class="act-title">${r.text}</div><div class="act-meta">${esc(r.who || 'System')}</div></div>
      <span class="act-time">${esc(dateTime(r.at))}</span></div>`).join('')}</div>`;
    renderIcons();
  } catch (err) {
    if ($('#dHistory')) $('#dHistory').innerHTML = `<p class="soft" style="margin:0">${esc(err.message)}</p>`;
    if ($('#dTimeline')) $('#dTimeline').innerHTML = '';
  }
}

/* ------------------------------------------------------------------ drawer events */

const dBody = $('#dBody');

dBody.addEventListener('click', (e) => {
  const oc = e.target.closest('.oc');
  if (oc) {
    const status = oc.dataset.status;
    if (status === 'Callback scheduled') {
      // Nothing is saved until there is a time; picking one completes the save.
      showCallback(true);
      const input = $('#dBody .js-callback');
      if (!input.value) { flagCallbackNeeded(); return; }
      saveRow(state.openId, { status, callbackAt: new Date(input.value).toISOString() });
      return;
    }
    showCallback(false);
    changeStatus(state.openId, status);
    return;
  }
  if (e.target.closest('.js-takeit')) saveRow(state.openId, { assignedTo: ME });
});

dBody.addEventListener('change', (e) => {
  const id = state.openId;
  const cart = cartById(id);
  if (!cart) return;
  if (e.target.classList.contains('js-callback')) {
    if (!e.target.value) { flagCallbackNeeded(); return; }
    e.target.classList.remove('needed');
    $('#dBody .cb-hint').hidden = true;
    saveRow(id, { status: 'Callback scheduled', callbackAt: new Date(e.target.value).toISOString() });
    return;
  }
  if (e.target.classList.contains('js-assign')) {
    if ((cart.assigned_to || '') === e.target.value) return;
    saveRow(id, { assignedTo: e.target.value || null });
    return;
  }
  if (e.target.classList.contains('js-tag')) {
    const boxes = $$('#dBody .js-tag');
    for (const b of boxes) b.closest('.pill').classList.toggle('on', b.checked);
    saveRow(id, { reasonTags: boxes.filter((b) => b.checked).map((b) => b.value) });
  }
});

/**
 * Notes save on blur and on Enter — never per keystroke.
 *
 * Enter saves directly rather than relying on the blur it causes: a blur event
 * is not delivered when the page itself lacks focus, which would drop the note
 * silently. The in-flight guard stops the blur that follows from sending the
 * same text a second time.
 */
let notesInFlight = null;
function saveNotes(el) {
  const cart = cartById(state.openId);
  if (!cart) return;
  const value = el.value;
  if ((cart.notes || '') === value || notesInFlight === value) return;
  notesInFlight = value;
  saveRow(state.openId, { status: st(cart), notes: value }).finally(() => { notesInFlight = null; });
}
dBody.addEventListener('blur', (e) => {
  if (e.target.classList?.contains('js-notes')) saveNotes(e.target);
}, true);
dBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.classList.contains('js-notes')) {
    e.preventDefault();
    saveNotes(e.target);
    e.target.blur();
  }
});

$('#dClose').addEventListener('click', closeDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
$('#dPrev').addEventListener('click', () => step(-1));
$('#dNext').addEventListener('click', () => step(1));
$('#dNextBtn').addEventListener('click', () => step(1));

/* ------------------------------------------------------------------ list events */

/** One handler for both layouts: actions act, everything else opens the cart. */
function onListClick(e) {
  if (e.target.closest('[data-clear]')) { clearFilters(); return; }
  const host = e.target.closest('[data-id]');
  if (!host) return;
  const id = host.dataset.id;
  const actEl = e.target.closest('[data-act]');
  const act = actEl?.dataset.act;
  if (act === 'status') { e.stopPropagation(); openStatusMenu(actEl, id); return; }
  if (act === 'take') { saveRow(id, { assignedTo: ME }); return; }
  if (act === 'open') { openDrawer(id); return; }
  if (e.target.closest('a')) return;             // Call / WhatsApp links do their own thing
  openDrawer(id);
}
$('#rows').addEventListener('click', onListClick);
$('#clist').addEventListener('click', onListClick);
for (const el of [$('#rows'), $('#clist')]) {
  // A focused row opens with Enter, as any focusable control does.
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-id]')) { e.preventDefault(); openDrawer(e.target.dataset.id); }
  });
}

$('#viewTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

alertsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) setView(b.dataset.goto);
});

function setView(view) {
  if (!VIEWS[view]) return;
  // Leaving a search means going back to the range's carts, which needs a load.
  const wasSearch = Boolean(state.loadedFor);
  if (state.query) { state.query = ''; $('#search').value = ''; }
  state.view = view;
  state.done.clear();
  // Each view has an obvious order until someone chooses one by hand.
  if (!state.sortTouched) { state.sort = VIEWS[view].sort; state.dir = SORTS[state.sort].dir; }
  const url = new URL(window.location.href);
  url.searchParams.set('mode', view);
  url.searchParams.delete('q');
  window.history.replaceState(null, '', url);
  if (!drawer.hidden) closeDrawer();
  if (wasSearch) loadAll(); else render();
}

// Sidebar queue links (/?mode=…) and Back/Forward between them switch the
// view in place; the shell router hands the new URL here instead of reloading.
onQueryChange((url) => {
  const p = url.searchParams;
  if (p.get('q')) {
    $('#search').value = p.get('q');
    state.query = p.get('q');
    return loadAll();
  }
  setView(VIEWS[p.get('mode')] ? p.get('mode') : 'tocall');
});

$('#cartTable thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  state.dir = state.sort === key ? -state.dir : SORTS[key].dir;
  state.sort = key;
  state.sortTouched = true;
  render();
});

$('#sort').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.sort = e.target.value;
  state.dir = SORTS[state.sort].dir;
  state.sortTouched = true;
  render();
});

for (const [id, key] of [['#fstatus', 'status'], ['#fowner', 'owner'], ['#ffollow', 'follow'], ['#freason', 'reason'], ['#fvalue', 'value']]) {
  $(id).addEventListener('change', (e) => { state.f[key] = e.target.value; render(); });
}
function clearFilters() {
  state.f = { status: '', owner: '', follow: '', reason: '', value: '' };
  for (const id of ['#fstatus', '#fowner', '#ffollow', '#freason', '#fvalue']) $(id).value = '';
  render();
}
$('#fclear').addEventListener('click', clearFilters);

$('#range').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  loadAll();   // the range is a server-side query, not a local filter
});

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  const value = e.target.value.trim();
  clearTimeout(searchTimer);
  // Search reaches the whole history, so it waits for a pause in typing.
  searchTimer = setTimeout(() => {
    if (value === state.query) return;
    state.query = value;
    loadAll();
  }, 350);
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.query = ''; loadAll(); }
});

$('#refresh').addEventListener('click', () => loadAll());

// Page-wide listeners end with the page (pageSignal), so moving away and back
// never stacks a second copy.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menu.hidden) { closeStatusMenu(); return; }
  if (!drawer.hidden) closeDrawer();
}, { signal: pageSignal() });
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeStatusMenu();
  for (const d of $$('details.menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
}, { signal: pageSignal() });
window.addEventListener('scroll', () => { if (!menu.hidden) closeStatusMenu(); }, { passive: true, signal: pageSignal() });

/**
 * Poll so a teammate's change shows up without a manual refresh — but never
 * under someone's cursor: skipped while the tab is hidden, a cart is open, the
 * status menu is up, or a search is showing.
 */
const poll = setInterval(() => {
  if (document.hidden || !drawer.hidden || !menu.hidden || state.query) return;
  loadAll();
}, 60_000);
onLeave(() => { clearInterval(poll); clearTimeout(searchTimer); clearTimeout(insightsTimer); });

/* ------------------------------------------------------------------ boot */

(async () => {
  skeleton();
  try {
    const me = await (await fetch('/auth/me')).json();
    if (!me.authenticated) { window.location.href = '/login'; return; }
    initShell(me, {
      // The sidebar search is the board's own search here, not a page change.
      onSearch: (q) => { $('#search').value = q; state.query = q; loadAll(); },
    });
  } catch { /* the board still works on its defaults */ }
  renderIcons();
  loadAll();
})();
