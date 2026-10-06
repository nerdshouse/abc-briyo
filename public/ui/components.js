/**
 * Briyo OS — UI components (shared design system)
 *
 * Plain functions that return HTML strings or draw into an element, in the same
 * template-string idiom as the rest of the front end. No framework and no build
 * step: a page imports what it needs as an ES module.
 */

/* ------------------------------------------------------------------ basics */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (v) => inr.format(Number(v || 0));
export const count = (v) => new Intl.NumberFormat('en-IN').format(Number(v || 0));
export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/** A Lucide placeholder; renderIcons() swaps it for the SVG. */
export const icon = (name, cls = '') => `<i data-lucide="${esc(name)}"${cls ? ` class="${esc(cls)}"` : ''}></i>`;

import { navigate, startRouter, syncSidebarActive } from './nav.js';
export { navigate, pageSignal, onLeave, onQueryChange, pageFetch } from './nav.js';

/** Lucide scans the whole document, so this is cheap to call after any render. */
export function renderIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } });
}

/* ------------------------------------------------------------------ time
   Every calendar-day decision is made in the board's timezone, never the
   browser's, so a laptop set to UTC reads the same "today" as the reports. */

let TZ = 'Asia/Kolkata';
export const setTimezone = (tz) => { if (tz) TZ = tz; };

/** YYYY-MM-DD in the board's timezone — the same string the report buckets use. */
export const dayKey = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d instanceof Date ? d : new Date(d));

/** The last `n` day keys ending `offset` days before today, oldest first. */
export function lastDays(n, offset = 0) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => dayKey(new Date(now - (offset + n - 1 - i) * 86400000)));
}

export const clock = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
}).format(new Date(iso)).toUpperCase();

export const dateShort = (iso) => new Intl.DateTimeFormat('en-IN', {
  timeZone: TZ, day: 'numeric', month: 'short',
}).format(new Date(iso));

export const dateTime = (iso) => `${dateShort(iso)}, ${clock(iso).toLowerCase()}`;

/** "Tue" / "24 Sep" for a YYYY-MM-DD key, without parsing it as a UTC instant. */
export function keyLabel(key, style = 'short') {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return style === 'weekday'
    ? date.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })
    : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function relative(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** "18 min" / "4h 10m" / "2d 3h". */
export function span(ms) {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "7h 12m" from seconds, for medians. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  return span(seconds * 1000);
}

/* ------------------------------------------------------------------ comparison */

/**
 * Period-over-period change, as display text and a tone.
 *
 * `goodWhenUp` is null for neutral quantities — more abandoned carts is not
 * good or bad news in itself, so it gets no colour. Rates compare in points,
 * not percent of a percent.
 */
export function delta(cur, prev, { mode = 'pct', goodWhenUp = true } = {}) {
  if (prev === null || prev === undefined) return null;
  const diff = cur - prev;
  let text;
  if (mode === 'pts') {
    text = `${diff > 0 ? '+' : ''}${diff.toFixed(1)} pts`;
  } else if (prev === 0) {
    text = cur === 0 ? 'No change' : 'New';
  } else {
    const p = (diff / prev) * 100;
    text = `${p > 0 ? '+' : ''}${Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
  }
  const tone = Math.abs(diff) < 1e-9 || goodWhenUp === null
    ? 'flat'
    : (diff > 0) === goodWhenUp ? 'up' : 'down';
  return { text: text.replace(/^-/, '−'), tone };
}

/* ------------------------------------------------------------------ sparkline */

let sparkId = 0;

/**
 * A small trend line with a soft fill, coloured by direction like the rest of
 * the comparison: green rising, red falling, grey flat or neutral.
 */
export function sparkline(values, { tone = 'flat', width = 80, height = 30 } = {}) {
  const id = `sp${++sparkId}`;
  const colour = tone === 'up' ? '#12A66A' : tone === 'down' ? '#F04438' : '#98A2B3';
  if (!values.length) return `<svg class="spark" width="${width}" height="${height}"></svg>`;
  // A series that is zero throughout has no direction. Colouring it by the
  // period comparison drew a red line along the floor, which reads as broken
  // rather than as "nothing happened" — so it gets a quiet dashed baseline.
  if (values.every((v) => !v)) {
    return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${width}" y1="${height - 4}" y2="${height - 4}" stroke="#D0D5DD" stroke-width="1.25" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const rng = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [i * step, height - 3 - ((v - min) / rng) * (height - 8)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${colour}" stop-opacity=".12"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${colour}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* ------------------------------------------------------------------ cards */

/** The patterned frame with its title, holding whatever goes in the pane. */
export function sectionCard({ title, iconName, meta = '', tools = '', body, cls = '' }) {
  return `<section class="card ${cls}">
    <header class="card-head">
      <h2 class="card-title">${iconName ? icon(iconName) : ''}${esc(title)}${meta ? ` <span class="card-meta">${meta}</span>` : ''}</h2>
      ${tools ? `<div class="card-tools">${tools}</div>` : ''}
    </header>
    ${body}
  </section>`;
}

/**
 * KPI card: label, the number, its change against the previous period, and a
 * trend line. `tip` holds the definition — no number on this page is unexplained.
 */
export function metricCard({ label, iconName = 'info', value, change, compare, series = [], tip = '' }) {
  const d = change;
  return `<section class="card metric">
    <header class="card-head">
      <h2 class="card-title">${esc(label)}</h2>
      <span title="${esc(tip)}">${icon(iconName, 'info')}</span>
    </header>
    <div class="pane">
      <div>
        <div class="metric-value">${value}</div>
        <span class="delta ${d ? d.tone : ''}">${d ? `<b>${esc(d.text)}</b>${esc(compare)}` : esc(compare)}</span>
      </div>
      ${sparkline(series, { tone: d ? d.tone : 'flat' })}
    </div>
  </section>`;
}

/* ------------------------------------------------------------------ bar chart */

/** Round a maximum up to a tidy axis ceiling: 7 → 8, 43 → 50, 584 → 600. */
function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * Vertical bars with a right-hand axis, a dashed guide from the active bar and
 * a pill label beside it. The newest bar is active until the pointer moves, so
 * the chart always states one number instead of waiting to be hovered.
 */
export function barChart(el, { points, format = count, labelStyle = 'weekday' }) {
  el.innerHTML = '';
  if (!points.length || points.every((p) => !p.value)) {
    el.innerHTML = '<div class="chart-empty">Nothing in this period yet.</div>';
    return;
  }

  const draw = () => {
    const W = Math.max(280, el.clientWidth - 28);
    const H = Math.max(160, el.clientHeight - 16);
    const axisW = 40;
    const baseY = H - 24;
    const plotW = W - axisW;
    const max = niceMax(Math.max(...points.map((p) => p.value)));
    const n = points.length;
    const slot = plotW / n;
    const barW = Math.max(3, Math.min(44, slot * 0.66));
    const r = Math.min(7, barW / 2.6);
    const yOf = (v) => baseY - (v / max) * (baseY - 8);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
    const every = Math.ceil(n / (W < 520 ? 5 : 9));

    const bars = points.map((p, i) => {
      const x = i * slot + (slot - barW) / 2;
      const y = Math.min(yOf(p.value), baseY - (p.value ? 2 : 0));
      const h = baseY - y;
      if (h <= 0) return '';
      const rr = Math.min(r, h);
      const d = `M${x},${baseY} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + barW - rr} Q${x + barW},${y} ${x + barW},${y + rr} V${baseY} Z`;
      return `<path class="bar" data-i="${i}" d="${d}"/>`;
    }).join('');

    const labels = points.map((p, i) => ((n - 1 - i) % every === 0
      ? `<text class="axis-label" x="${i * slot + slot / 2}" y="${H - 4}" text-anchor="middle">${esc(keyLabel(p.key, n > 10 ? 'short' : labelStyle))}</text>`
      : '')).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
      <defs>
        <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ECEEF1"/><stop offset="1" stop-color="#F6F7F9"/></linearGradient>
        <linearGradient id="barInk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#344054"/><stop offset="1" stop-color="#1B2433"/></linearGradient>
      </defs>
      ${ticks.map((t) => `<line class="grid-line" x1="0" x2="${plotW}" y1="${yOf(t)}" y2="${yOf(t)}"/>
        <text class="axis-label" x="${W}" y="${yOf(t) + 4}" text-anchor="end">${esc(format(t))}</text>`).join('')}
      ${bars}
      ${labels}
      <line class="guide" x1="0" x2="${plotW}" y1="0" y2="0" hidden/>
      <circle class="guide-dot" r="2.5" hidden/>
    </svg><div class="chart-tip" hidden></div>`;

    const svg = el.querySelector('svg');
    const tip = el.querySelector('.chart-tip');
    const guide = svg.querySelector('.guide');
    const dot = svg.querySelector('.guide-dot');
    const scale = () => svg.getBoundingClientRect().width / W;

    const activate = (i) => {
      svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
      const p = points[i];
      if (!p || !p.value) { guide.setAttribute('hidden', ''); dot.setAttribute('hidden', ''); tip.hidden = true; return; }
      const y = yOf(p.value);
      const x = i * slot + (slot - barW) / 2;
      guide.setAttribute('x1', x); guide.setAttribute('y1', y); guide.setAttribute('y2', y);
      guide.removeAttribute('hidden');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.removeAttribute('hidden');
      const s = scale();
      tip.innerHTML = `${esc(keyLabel(p.key, labelStyle === 'weekday' && n <= 10 ? 'weekday' : 'short'))} : ${esc(format(p.value))}${p.sub ? `<span>${esc(p.sub)}</span>` : ''}`;
      tip.style.left = `${x * s + 20}px`;
      tip.style.top = `${y * s + 8}px`;
      tip.hidden = false;
    };

    const last = points.map((p) => p.value > 0).lastIndexOf(true);
    activate(last);
    svg.addEventListener('mousemove', (e) => {
      const px = (e.clientX - svg.getBoundingClientRect().left) / scale();
      const i = Math.min(n - 1, Math.max(0, Math.floor(px / slot)));
      activate(i);
    });
    svg.addEventListener('mouseleave', () => activate(last));
  };

  draw();
  // Redraw on resize rather than scaling, so text and bar radii stay crisp.
  if (el._ro) el._ro.disconnect();
  el._ro = new ResizeObserver(() => { clearTimeout(el._t); el._t = setTimeout(draw, 80); });
  el._ro.observe(el);
}

/* ------------------------------------------------------------------ status */

/**
 * The five internal statuses, in words a reader recognises. Display-only: the
 * stored values and the board's vocabulary are unchanged.
 */
const STATUS = {
  'Not called': { cls: 'new', label: 'New' },
  'Called – No answer': { cls: 'noresp', label: 'No response' },
  'Callback scheduled': { cls: 'callback', label: 'Callback' },
  'Called – Recovered': { cls: 'recovered', label: 'Recovered' },
  'Called – Declined': { cls: 'lost', label: 'Lost' },
};
export const STATUS_LABELS = Object.values(STATUS).map((s) => s.label);
export const statusOf = (raw) => STATUS[raw || 'Not called'] || { cls: '', label: raw || '—' };

export function statusIndicator(raw) {
  const s = statusOf(raw);
  return `<span class="status ${s.cls}" title="${esc(raw || 'Not called')}"><span class="dot"></span>${esc(s.label)}</span>`;
}

/** Follow-up column: the same five callback states the board shows. */
export function followUp(cart) {
  if (cart.status !== 'Callback scheduled') return '<span class="muted">—</span>';
  if (!cart.callback_at) return '<span class="followup missing">No time set</span>';
  const due = new Date(cart.callback_at);
  const diff = due - Date.now();
  if (diff < -60000) return `<span class="followup overdue">Overdue ${esc(span(diff))}</span>`;
  if (diff <= 5 * 60000) return '<span class="followup soon">Due now</span>';
  if (diff <= 60 * 60000) return `<span class="followup soon">In ${esc(span(diff))}</span>`;
  const today = dayKey(new Date());
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  const day = dayKey(due);
  if (day === today) return `<span class="followup">Today ${esc(clock(due).toLowerCase())}</span>`;
  if (day === tomorrow) return `<span class="followup">Tomorrow ${esc(clock(due).toLowerCase())}</span>`;
  return `<span class="followup">${esc(dateTime(due))}</span>`;
}

/* ------------------------------------------------------------------ bars */

/** Horizontal bars for breakdowns. `note` renders a quiet line under a row. */
export function hbars(rows, { ink = false } = {}) {
  if (!rows.length) return '<div class="empty-note">Nothing yet.</div>';
  const max = Math.max(1, ...rows.map((r) => Number(r.n)));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar">
      <span class="hbar-label" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="hbar-val">${esc(r.display ?? count(r.n))}</span>
      <span class="hbar-track"><span class="hbar-fill${ink ? ' ink' : ''}" style="width:${(Number(r.n) / max) * 100}%"></span></span>
      ${r.note ? `<span class="hbar-note">${esc(r.note)}</span>` : ''}
    </div>`).join('')}</div>`;
}

export const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0].toUpperCase()).join('');

/* ------------------------------------------------------------------ shell */

/**
 * The Briyo OS sidebar, one definition for every page.
 *
 * Pages ship an empty <aside id="sidebar">; it is built here once from the
 * signed-in member's capabilities (lib/permissions.js) and stays mounted across
 * client-side navigation. Links a member cannot use are not shown — the server
 * still checks every page and API. Department counts arrive afterwards.
 *
 * Briyo OS
 *   Overview
 *   OPERATIONS  Logistics · Inventory
 *   CUSTOMER    Support (cart recovery)
 *   PEOPLE      HR
 *   ADMIN       Members · Import carts · Export report
 */
const navLink = (href, label, ico, { count: n = null, id = '', view = '', alert = false, download = false } = {}) => `<a class="nav-item" href="${href}"${view ? ` data-view-link="${view}"` : ''}${download ? ' download' : ''}>`
  + `${ico ? `<i data-lucide="${ico}"></i>` : ''}<span class="nav-label">${esc(label)}</span>`
  + `${id ? `<span class="nav-count${alert ? ' alert' : ''}" id="${id}" hidden></span>` : n ? `<span class="nav-count">${count(n)}</span>` : ''}</a>`;
const navDept = (label, ico, href, body = '') => `<div class="nav-dept">${navLink(href, label, ico)}${body ? `<div class="nav-tree">${body}</div>` : ''}</div>`;
const navSection = (caption, body) => (body ? `<div class="nav-group"><div class="nav-caption">${caption}</div>${body}</div>` : '');

function sidebarHtml(me) {
  const has = (c) => hasCap(me, c);
  const admin = Boolean(me?.isAdmin);
  const support = has('support.work');
  return `
    <a class="brand" href="/overview" aria-label="Briyo OS — overview">
      <span class="brand-mark" aria-hidden="true">B</span>
      <div><div class="brand-name">Briyo OS</div><div class="brand-sub">Operating system</div></div>
    </a>
    ${support ? `<form class="side-search" id="sideSearchForm" role="search" data-context="recovery">
      <i data-lucide="search"></i>
      <input id="sideSearch" type="search" placeholder="Find a customer" autocomplete="off" aria-label="Search every cart by name, phone or email" />
      <kbd>⌘ K</kbd>
    </form>` : ''}
    <nav aria-label="Departments">
      <div class="nav-group nav-top">${navLink('/overview', 'Overview', 'layout-dashboard')}</div>
      ${navSection('Operations', '<div id="opsNav"></div>')}
      ${navSection('Customer', support ? navDept('Support', 'headset', '/?mode=tocall',
        navLink('/?mode=tocall', 'To call', '', { id: 'countToCall', view: 'tocall' })
        + navLink('/?mode=callbacks', 'Callbacks', '', { id: 'countCallbacks', view: 'callbacks' })
        + navLink('/?mode=mine', 'My queue', '', { view: 'mine' })
        + navLink('/?mode=all', 'All carts', '', { view: 'all' })) : '')}
      ${navSection('People', has('hr.view') ? navDept('HR', 'briefcase', '/hr/jobs',
        navLink('/hr/jobs', 'Jobs') + navLink('/hr/candidates', 'Candidates')) : '')}
      ${navSection('Admin', admin ? navLink('/admin', 'Members', 'users')
        + navLink('/dashboard', 'Analytics', 'chart-no-axes-column')
        + navLink('/import', 'Import carts', 'upload')
        + navLink('/api/admin/report.csv?period=day', 'Export report', 'download', { download: true }) : '')}
    </nav>
    <div class="sidebar-foot">
      <a class="user-card" href="/profile" title="Your profile">
        <span class="avatar" id="userAvatar">·<span class="live"></span></span>
        <div style="min-width:0">
          <div class="user-name" id="userName">Signed in</div>
          <div class="user-role" id="userRole"></div>
        </div>
      </a>
      <button class="icon-btn bare sign-out" id="signOut" type="button" title="Sign out" aria-label="Sign out"><i data-lucide="log-out"></i></button>
    </div>`;
}

let shellBound = false;
let shellSearch = null;

export function initShell(me, { onSearch } = {}) {
  // The shell survives client-side navigation: built and bound once; each page
  // only swaps in its own search behaviour.
  shellSearch = onSearch || null;
  if (!shellBound) {
    shellBound = true;
    const side = $('#sidebar');
    if (side && !side.dataset.built) { side.innerHTML = sidebarHtml(me); side.dataset.built = '1'; }
    const app = $('.app');
    const toggle = $('#navOpen');
    const open = () => { app.classList.add('nav-open'); toggle?.setAttribute('aria-expanded', 'true'); };
    const close = () => { app.classList.remove('nav-open'); toggle?.setAttribute('aria-expanded', 'false'); };
    toggle?.setAttribute('aria-controls', 'sidebar');
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.addEventListener('click', open);
    $('#scrim')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && app.classList.contains('nav-open')) { close(); toggle?.focus(); }
      // ⌘K only where the customer search is actually shown.
      const search = $('#sideSearch');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && search?.offsetParent) {
        e.preventDefault();
        open();
        search.focus();
      }
    });
    $('#sideSearchForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('#sideSearch').value.trim();
      if (!q) return;
      // On the board the sidebar search is the board's own search; elsewhere it
      // hands off to the board, the only page that searches every cart.
      if (shellSearch) { shellSearch(q); close(); } else navigate(`/?q=${encodeURIComponent(q)}`);
    });
    if (/Mac|iPhone|iPad/.test(navigator.platform) === false) {
      const k = $('.side-search kbd'); if (k) k.textContent = 'Ctrl K';
    }
    $('#signOut')?.addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
    startRouter();
    enhanceDrawers();
    if (!document.querySelector('.skip-link')) {
      document.body.insertAdjacentHTML('afterbegin', '<a class="skip-link" href="#main">Skip to content</a>');
    }
  }
  document.querySelector('main.page')?.setAttribute('id', 'main');

  // Page-level elements still follow the same rules: admin-only and
  // capability-gated controls are hidden, not disabled (the server checks again).
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !me?.isAdmin;
  for (const el of document.querySelectorAll('[data-cap]')) el.hidden = !el.dataset.cap.split(/\s+/).some((c) => hasCap(me, c));
  for (const el of document.querySelectorAll('[data-recovery]')) el.hidden = !hasCap(me, 'support.work');
  renderOrdersNav(me).catch(() => {});

  // A profile that became incomplete (e.g. an admin took the photo down) is
  // completed before anything else; the server enforces the same on every request.
  if (me && me.profileComplete === false && window.location.pathname !== '/profile') { window.location.href = '/profile'; return; }
  if (me?.name) {
    $('#userName').textContent = me.profile?.name || me.name;
    $('#userRole').textContent = roleSummary(me);
    setAvatar($('#userAvatar'), { name: me.profile?.name || me.name, photoUrl: me.photoUrl || me.profile?.photoUrl });
  }
  syncSidebarActive();
  renderIcons();
}

/**
 * Every drawer on every page, without touching page code: announced as a
 * dialog, focus moves in when it opens and returns to where it was when it
 * closes, and the page behind stops scrolling. Watches the `hidden` attribute,
 * which is how all pages open and close their drawers.
 */
function enhanceDrawers() {
  const returnTo = new WeakMap();
  const prepare = (d) => {
    if (d.dataset.dialog) return;
    d.dataset.dialog = '1';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    const title = d.querySelector('.drawer-title');
    if (title) { if (!title.id) title.id = `${d.id || 'drawer'}-title`; d.setAttribute('aria-labelledby', title.id); }
  };
  const sync = () => {
    const open = [...document.querySelectorAll('.drawer')].filter((d) => !d.hidden);
    document.documentElement.classList.toggle('drawer-open', open.length > 0);
  };
  const onChange = (d) => {
    prepare(d);
    if (!d.hidden) {
      returnTo.set(d, document.activeElement);
      requestAnimationFrame(() => {
        if (d.hidden || d.contains(document.activeElement)) return;
        const target = d.querySelector('[autofocus], .drawer-body input:not([type=hidden]):not([disabled]), .drawer-body select, .drawer-body textarea, .drawer-head button')
          || d;
        if (target === d) d.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      });
    } else {
      const back = returnTo.get(d);
      if (back && document.contains(back) && !document.querySelector('.drawer:not([hidden])')) back.focus({ preventScroll: true });
    }
    sync();
  };
  document.querySelectorAll('.drawer').forEach(prepare);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.target.classList?.contains('drawer')) onChange(m.target);
      if (m.type === 'childList') m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.classList.contains('drawer')) prepare(n); n.querySelectorAll?.('.drawer').forEach(prepare); } });
    }
    if (list.some((m) => m.type === 'childList')) sync();
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true, childList: true });
}

/** A short confirmation that does not need an answer. `tone`: 'ok' (default) or 'bad'. */
export function toast(message, { tone = 'ok', ms = 3200 } = {}) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${tone === 'bad' ? 'bad' : ''}`;
  el.innerHTML = `${icon(tone === 'bad' ? 'circle-alert' : 'check')}<span>${esc(message)}</span>`;
  host.appendChild(el);
  renderIcons();
  setTimeout(() => el.remove(), ms);
}

/** One loading / empty / error block for every page. */
export function stateBlock(kind, title, detail = '', { action = '', iconName = '' } = {}) {
  const ico = iconName || { loading: 'loader', empty: 'inbox', error: 'circle-alert' }[kind] || 'info';
  return `<div class="state ${kind}"${kind === 'loading' ? ' aria-busy="true"' : ''}>${icon(ico)}<b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}${action}</div>`;
}

/** An avatar: the member's photo when they have one, initials until then. */
export function setAvatar(el, person) {
  if (!el) return;
  const live = el.querySelector('.live');
  if (person?.photoUrl) {
    el.innerHTML = `<img src="${esc(person.photoUrl)}" alt="" loading="lazy" decoding="async" />`;
  } else {
    el.textContent = initials(person?.name);
  }
  if (live) el.appendChild(live);
}

/**
 * /api/orders/meta, shared: the page and the sidebar ask for it at the same
 * moment, so they share one request instead of making two.
 */
let metaRequest = null;
let metaAt = 0;
export function ordersMeta() {
  if (!metaRequest || Date.now() - metaAt > 2000) {
    metaAt = Date.now();
    metaRequest = fetch('/api/orders/meta').then(async (res) => {
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
      return data;
    });
    metaRequest.catch(() => { metaRequest = null; });
  }
  return metaRequest;
}

/** True when the signed-in member holds a capability (admins hold all). */
export const hasCap = (me, cap) => Boolean(me?.caps?.includes(cap));

/** "Admin", or the member's module roles: "Logistics operator · Inventory viewer". */
export function roleSummary(me) {
  if (me?.isAdmin) return 'Admin';
  const cat = me?.moduleCatalog || {};
  const parts = Object.entries(me?.modules || {}).map(([m, r]) => {
    const label = cat[m]?.roles?.find((x) => x.key === r)?.label || r;
    return `${cat[m]?.label || m} ${label.toLowerCase()}`;
  });
  return parts.join(' · ') || 'No module access';
}

/** Operations: Logistics and Inventory, with live counts from the server's dispatch types and views. */
async function renderOrdersNav(me) {
  const host = document.getElementById('opsNav');
  if (!host) return;
  const logistics = hasCap(me, 'logistics.view');
  const inventory = hasCap(me, 'inventory.view');
  const group = host.closest('.nav-group');
  if (group) group.hidden = !logistics && !inventory;
  if (!logistics && !inventory) { host.innerHTML = ''; host.dataset.html = ''; return; }
  // Order counts come from the Orders API, which only Logistics may read.
  const meta = logistics ? await ordersMeta() : { ok: true, dispatchTypes: [], views: {} };
  if (!meta.ok) return;
  const html = `${logistics ? navDept('Logistics', 'truck', '/orders',
    navLink('/orders', 'All orders')
    + Object.entries(meta.views || {}).map(([k, label]) => navLink(`/orders?view=${k}`, label, '', { count: meta.viewCounts?.[k] })).join('')
    + (meta.dispatchTypes || []).map((t) => navLink(`/orders?type=${encodeURIComponent(t.key)}`, t.label)).join('')
    + navLink('/couriers', 'Couriers') + navLink('/destinations', 'Destinations')) : ''}${inventory ? navDept('Inventory', 'boxes', '/inventory',
    navLink('/inventory', 'Stock')
    + navLink('/inventory?stock=low', 'Low stock')
    + navLink('/inventory?expiring=90', 'Expiring soon')
    + navLink('/inventory?view=unmapped', 'Unmapped SKUs', '', { count: meta.inventory?.unmappedSkus })) : ''}`;
  // Re-rendered on every page; replaced only if something (a count) changed.
  if (host.dataset.html === html) return;
  host.dataset.html = html;
  host.innerHTML = html;
  syncSidebarActive();
  renderIcons();
}

/** Set a sidebar count badge; `alert` turns it red for work that is overdue. */
export function setNavCount(id, n, { alert = false } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !n;
  el.textContent = count(n);
  el.classList.toggle('alert', alert && n > 0);
}
