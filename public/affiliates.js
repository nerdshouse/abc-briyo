/**
 * Affiliates — the internal partner register (Phase 1C). One page, two views:
 *   /affiliates            KPIs and the searchable, paged list
 *   /affiliates/:publicId  one partner: profile, rate history, activity
 * Forms (new, edit, status with a reason, new rate) open in the side drawer.
 * Every number and permission comes from /api/affiliates; the server checks
 * again. No commission, revenue or order figures: those systems do not exist yet.
 */
import {
  $, esc, count, icon, renderIcons, relative, initShell, pageFetch, pageSignal, onQueryChange,
} from './ui/components.js';
import { istDate, istDateTime, istDayKey } from './ui/ist.js';

const fetch = pageFetch();
const PAGE = 50;
const FILTERS = ['q', 'category', 'status', 'sort', 'dir'];
const state = { me: null, meta: null, f: {}, list: [], total: 0, kpis: null, detail: null, publicId: null, form: null, dirty: false };

const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body ?? {}) });
const canManage = () => Boolean(state.meta?.canManage);
const opt = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

// ------------------------------------------------------------------ labels

const STATUS = {
  draft: ['new', 'Draft'], pending_verification: ['callback', 'Pending verification'], approved: ['callback', 'Approved'],
  active: ['recovered', 'Active'], suspended: ['noresp', 'Suspended'], closed: ['none', 'Closed'],
};
const tag = (s) => `<span class="status ${STATUS[s]?.[0] || ''}"><span class="dot"></span>${esc(STATUS[s]?.[1] || s)}</span>`;
const SORTS = { created: 'Newest first', name: 'Name A–Z', category: 'Category', status: 'Status', activity: 'Recent activity' };
const SORT_DIR = { created: 'desc', name: 'asc', category: 'asc', status: 'asc', activity: 'desc' };
/** 1250 → "12.5%". Integer arithmetic only. */
const pct = (bps) => {
  if (bps === null || bps === undefined) return null;
  const whole = Math.trunc(bps / 100); const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
};
const rateCell = (bps) => (bps === null || bps === undefined ? '<span class="soft">Not set</span>' : esc(pct(bps)));
const ACTION_ICON = { activate: 'circle-check', suspend: 'circle-pause', reactivate: 'circle-play', close: 'circle-x' };
const CONFIRM = {
  activate: 'Activate this affiliate? Nothing is attributed or paid yet; this only marks the partner as active.',
  reactivate: 'Reactivate this affiliate? It returns to the status it had before it was suspended.',
};

// ------------------------------------------------------------------ URL

function readUrl() {
  const m = /^\/affiliates\/([A-Za-z0-9]{6,12})\/?$/.exec(window.location.pathname);
  state.publicId = m ? m[1].toUpperCase() : null;
  const u = new URLSearchParams(window.location.search);
  state.f = Object.fromEntries(FILTERS.map((k) => [k, u.get(k) || '']));
}
function writeUrl() {
  if (state.publicId) return;
  const u = new URLSearchParams();
  for (const k of FILTERS) if (state.f[k]) u.set(k, state.f[k]);
  const next = `/affiliates${u.toString() ? `?${u}` : ''}`;
  if (next !== `${window.location.pathname}${window.location.search}`) history.replaceState(history.state, '', next);
}
const anyFilter = () => ['q', 'category', 'status'].some((k) => state.f[k]);

function failed(err, retry = true) {
  $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span>${retry ? '<button class="alert-link" type="button" id="retry">Try again</button>' : ''}</div>`;
  renderIcons();
}

// ------------------------------------------------------------------ list view

function listFrame() {
  document.title = 'Affiliates — Briyo OS';
  $('#topTitle').textContent = 'Affiliates';
  $('#pageTitle').textContent = 'Affiliates';
  $('#crumbs').innerHTML = `${icon('handshake')}<span>Growth</span><span class="sep">/</span><span class="here">Affiliates</span>`;
  $('#pageActions').innerHTML = `<button class="icon-btn" id="refresh" type="button" title="Refresh" aria-label="Refresh">${icon('refresh-cw')}</button>
    ${canManage() ? `<button class="btn primary" id="newAffiliate" type="button">${icon('plus')}New affiliate</button>` : ''}`;
  const f = state.f;
  $('#view').innerHTML = `
    <section class="card af-kpis"><div class="attention" id="kpis" aria-label="Affiliates by status"></div></section>
    <section class="card">
      <div class="pane">
        <div class="board-filters" id="filters">
          <label class="search">${icon('search')}<input class="input" id="fq" type="search" autocomplete="off" placeholder="Name, email, phone or ID" aria-label="Search affiliates" value="${esc(f.q)}" /></label>
          <select class="select${f.category ? ' on' : ''}" id="fcategory" aria-label="Category">${opt('', 'All categories', !f.category)}${state.meta.categories.map((c) => opt(c.key, c.label, f.category === c.key)).join('')}</select>
          <select class="select${f.status ? ' on' : ''}" id="fstatus" aria-label="Status">${opt('', 'All statuses', !f.status)}${state.meta.statuses.map((s) => opt(s, STATUS[s]?.[1] || s, f.status === s)).join('')}</select>
          <select class="select" id="fsort" aria-label="Sort">${Object.entries(SORTS).map(([k, t]) => opt(k, t, (f.sort || 'created') === k)).join('')}</select>
          <button type="button" class="linkish" id="fclear" hidden>Clear</button>
        </div>
        <div class="board-meta" id="resultNote" aria-live="polite"></div>
        <div class="table-wrap">
          <table class="table af-table">
            <thead><tr><th>Partner</th><th>Category</th><th>Status</th><th class="r">Current rate</th><th>Created</th><th>Last activity</th><th class="r"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody id="rows"><tr><td colspan="7"><div class="empty-note">Loading…</div></td></tr></tbody>
          </table>
        </div>
        <ul class="clist" id="clist" aria-label="Affiliates"></ul>
        <div class="table-more" id="more" hidden><button class="btn" type="button" id="moreBtn">Show more</button></div>
      </div>
    </section>`;
  renderIcons();
}

async function loadList({ append = false } = {}) {
  $('#alerts').innerHTML = '';
  const u = new URLSearchParams();
  for (const k of ['q', 'category', 'status']) if (state.f[k]) u.set(k, state.f[k]);
  const sort = state.f.sort || 'created';
  u.set('sort', sort); u.set('dir', state.f.dir || SORT_DIR[sort] || 'desc');
  u.set('limit', PAGE); u.set('offset', append ? state.list.length : 0);
  try {
    const data = await api(`/api/affiliates?${u}`);
    state.list = append ? state.list.concat(data.affiliates) : data.affiliates;
    state.total = data.total; state.kpis = data.kpis;
    renderList();
  } catch (err) { failed(err); }
}

function renderKpis() {
  const k = state.kpis;
  const tile = (status, label, n, sub, tone = '') => `
    <button type="button" class="att${n && tone ? ` ${tone}` : ''}${(state.f.status || '') === status ? ' on' : ''}" data-kpi="${status}" aria-pressed="${(state.f.status || '') === status}">
      <span class="att-label">${status ? '<span class="dot"></span>' : ''}${esc(label)}</span>
      <div class="att-value">${count(n)}</div>
      <div class="att-sub">${esc(sub)}</div>
    </button>`;
  $('#kpis').innerHTML = [
    tile('', 'Total affiliates', k.total, 'every status'),
    tile('active', 'Active', k.active, 'marked active'),
    tile('pending_verification', 'Pending verification', k.pending_verification, 'professionals awaiting checks'),
    tile('suspended', 'Suspended', k.suspended, 'paused with a reason'),
  ].join('');
}

function renderList() {
  renderKpis();
  const rows = state.list;
  $('#pageSub').textContent = state.kpis.total ? `${count(state.kpis.total)} partner${state.kpis.total === 1 ? '' : 's'} · ${count(state.kpis.active)} active` : 'Partner register';
  $('#resultNote').textContent = state.total
    ? `Showing ${count(rows.length)} of ${count(state.total)}${anyFilter() ? ' matching the filters' : ''}` : '';
  $('#fclear').hidden = !anyFilter();
  $('#more').hidden = rows.length >= state.total;
  if (!rows.length) {
    let empty;
    if (!state.kpis.total) {
      empty = `<b>No affiliates yet.</b>${canManage() ? 'Add the first partner with New affiliate. It starts as a draft, or pending verification for professionals.' : 'An affiliate manager adds partners.'}`;
    } else if (state.f.q) empty = `<b>No affiliate matches “${esc(state.f.q)}”.</b>Search covers name, email, phone and public ID.`;
    else empty = '<b>No affiliates match these filters.</b>Try another category or status, or clear the filters.';
    $('#rows').innerHTML = `<tr><td colspan="7"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return renderIcons();
  }
  const href = (a) => `/affiliates/${encodeURIComponent(a.public_id)}`;
  const activity = (a) => (a.last_activity_at ? `<span title="${esc(istDateTime(a.last_activity_at))}">${esc(relative(a.last_activity_at))}</span>` : '<span class="soft">—</span>');
  $('#rows').innerHTML = rows.map((a) => `
    <tr class="orow" data-href="${href(a)}" tabindex="0">
      <td><span class="cell-main" style="font-weight:500">${esc(a.display_name)}</span>
        <span class="cell-sub muted"><span class="mono">${esc(a.public_id)}</span>${a.contact_email ? ` · ${esc(a.contact_email)}` : ''}</span></td>
      <td>${esc(a.category_label)}</td>
      <td>${tag(a.status)}</td>
      <td class="r num">${rateCell(a.current_rate_bps)}</td>
      <td><span title="${esc(istDateTime(a.created_at))}">${esc(istDate(a.created_at))}</span></td>
      <td>${activity(a)}</td>
      <td class="r"><a class="linkish" href="${href(a)}">Open</a></td>
    </tr>`).join('');
  $('#clist').innerHTML = rows.map((a) => `
    <li class="oitem" data-href="${href(a)}" tabindex="0">
      <div class="oi-top"><span class="oi-id">${esc(a.display_name)}</span><span class="oi-val">${tag(a.status)}</span></div>
      <div class="oi-sub">${esc(a.category_label)} · <span class="mono">${esc(a.public_id)}</span>${a.current_rate_bps !== null ? ` · ${esc(pct(a.current_rate_bps))}` : ''}</div>
      <div class="oi-sub">Created ${esc(istDate(a.created_at))}${a.last_activity_at ? ` · active ${esc(relative(a.last_activity_at))}` : ''}</div>
    </li>`).join('');
  return renderIcons();
}

// ------------------------------------------------------------------ detail view

async function loadDetail() {
  $('#alerts').innerHTML = '';
  try {
    const data = await api(`/api/affiliates/${encodeURIComponent(state.publicId)}`);
    state.detail = data;
    renderDetail();
  } catch (err) {
    if (err.status === 404) {
      $('#pageTitle').textContent = 'Affiliate not found';
      $('#pageSub').textContent = '';
      $('#view').innerHTML = `<section class="card"><div class="empty-note"><b>No affiliate has the ID ${esc(state.publicId)}.</b><a class="linkish" href="/affiliates">Back to all affiliates</a></div></section>`;
      return;
    }
    failed(err);
  }
}

function renderDetail() {
  const { affiliate: a, rates, events } = state.detail;
  document.title = `${a.display_name} — Affiliates — Briyo OS`;
  $('#topTitle').textContent = a.display_name;
  $('#pageTitle').innerHTML = `${esc(a.display_name)} <span class="af-title-tag">${tag(a.status)}</span>`;
  $('#pageSub').innerHTML = `${esc(a.category_label)} · <span class="mono">${esc(a.public_id)}</span> · created ${esc(istDate(a.created_at))} · rate ${a.current_rate_bps === null ? 'not set' : esc(pct(a.current_rate_bps))}`;
  $('#crumbs').innerHTML = `${icon('handshake')}<span>Growth</span><span class="sep">/</span><a href="/affiliates">Affiliates</a><span class="sep">/</span><span class="here">${esc(a.display_name)}</span>`;
  const closed = a.status === 'closed';
  $('#pageActions').innerHTML = `<button class="icon-btn" id="refresh" type="button" title="Refresh" aria-label="Refresh">${icon('refresh-cw')}</button>
    ${canManage() && !closed ? `<button class="btn" type="button" data-open="edit">${icon('pencil')}Edit</button>` : ''}
    ${canManage() ? a.transitions.map((t) => `<button class="btn${t === 'activate' ? ' primary' : ''}" type="button" data-status="${t}">${icon(ACTION_ICON[t])}${esc(state.meta.transitions[t].label)}</button>`).join('') : ''}`;

  const kv = (label, value) => `<div class="hr-kv"><span>${esc(label)}</span><span>${value}</span></div>`;
  const by = (at, who) => (at ? `${esc(istDateTime(at))}${who ? ` <span class="soft">· ${esc(who)}</span>` : ''}` : '<span class="soft">—</span>');
  const verify = a.requires_verification
    ? (a.status === 'pending_verification' ? 'Required — the verification workflow is not built yet, so this partner stays pending.' : 'Required for this category')
    : 'Not required for this category';
  const rateState = { current: '<span class="mini-tag">Current</span>', scheduled: '<span class="mini-tag">Scheduled</span>', past: '' };
  $('#view').innerHTML = `
    <div class="af-detail">
      <section class="card af-profile">
        <header class="card-head"><h2 class="card-title">${icon('id-card')}Profile</h2></header>
        <div class="pane pad">
          ${kv('Display name', esc(a.display_name))}
          ${kv('Email', a.contact_email ? esc(a.contact_email) : '<span class="soft">—</span>')}
          ${kv('Phone', a.contact_phone ? `<span class="mono">${esc(a.contact_phone)}</span>` : '<span class="soft">—</span>')}
          ${kv('Category', esc(a.category_label))}
          ${kv('Verification', esc(verify))}
          ${kv('Status', tag(a.status))}
          ${a.status === 'suspended' ? kv('Suspended', `${by(a.suspended_at, a.suspended_by)}${a.suspension_reason ? `<span class="cell-sub">${esc(a.suspension_reason)}</span>` : ''}`) : ''}
          ${kv('Activated', a.activated_at ? esc(istDateTime(a.activated_at)) : '<span class="soft">Never</span>')}
          ${kv('Public ID', `<span class="mono">${esc(a.public_id)}</span>`)}
          ${kv('Created', by(a.created_at, a.created_by))}
          ${kv('Last updated', by(a.updated_at, a.updated_by))}
        </div>
      </section>

      <section class="card af-rates">
        <header class="card-head"><h2 class="card-title">${icon('percent')}Rate history</h2>
          ${canManage() && !closed ? `<div class="card-tools"><button class="btn" type="button" data-open="rate">${icon('plus')}New rate</button></div>` : ''}</header>
        <div class="pane">
          ${rates.length ? `<div class="table-wrap"><table class="table">
            <thead><tr><th class="r">Rate</th><th>Effective from</th><th>Reason</th><th>Added</th></tr></thead>
            <tbody>${rates.map((r) => `<tr>
              <td class="r num"><b>${esc(pct(r.rate_bps))}</b> ${rateState[r.state]}</td>
              <td>${esc(istDateTime(r.effective_from))}</td>
              <td>${r.reason ? esc(r.reason) : '<span class="soft">—</span>'}</td>
              <td>${by(r.created_at, r.created_by)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty-note"><b>No rate yet.</b>${canManage() && !closed ? 'Add one with New rate. Rates are never edited: a change is a new row.' : 'An affiliate manager sets the rate.'}</div>`}
          <div class="pane-foot">A rate is the share the partner would earn once commissions exist. Nothing is calculated or paid yet.</div>
        </div>
      </section>

      <section class="card af-activity">
        <header class="card-head"><h2 class="card-title">${icon('history')}Activity</h2><span class="card-meta">${count(events.length)} event${events.length === 1 ? '' : 's'}</span></header>
        <div class="pane">
          ${events.length ? `<ol class="af-events">${events.map((e) => `<li>
            <div class="af-ev-head"><b>${esc(e.label)}</b><span class="soft" title="${esc(istDateTime(e.at))}">${esc(relative(e.at))}</span></div>
            ${e.summary ? `<div class="af-ev-sum">${esc(e.summary)}</div>` : ''}
            <div class="af-ev-meta soft">${esc(istDateTime(e.at))}${e.actor ? ` · ${esc(e.actor)}` : ''}</div></li>`).join('')}</ol>`
    : '<div class="empty-note"><b>No activity yet.</b></div>'}
        </div>
      </section>
    </div>`;
  renderIcons();
}

// ------------------------------------------------------------------ drawer forms

function showDrawer(title, sub, body, buttons) {
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
  document.documentElement.classList.add('scroll-locked');
  $('#dTitle').textContent = title; $('#dSub').textContent = sub || '';
  $('#dBody').innerHTML = body; $('#dButtons').innerHTML = buttons;
  $('#dSaved').textContent = ''; $('#dSaved').className = 'saved';
  state.dirty = false;
  renderIcons();
  $('#dBody').querySelector('input:not([type=hidden]), select, textarea')?.focus();
}
function closeDrawer({ force = false } = {}) {
  if ($('#drawer').hidden) return;
  if (!force && state.dirty && !window.confirm('Discard your unsaved changes?')) return;
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true;
  document.documentElement.classList.remove('scroll-locked');
  state.form = null; state.dirty = false;
}
const fieldError = (err) => {
  $('#dSaved').className = 'saved failed';
  $('#dSaved').textContent = err.message;
  $$field(err.data?.field)?.focus();
};
const $$field = (name) => (name ? $('#dBody').querySelector(`[name="${CSS.escape(name === 'rate' ? 'rate_percent' : name)}"]`) : null);
const footButtons = (label) => `<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="dSave">${esc(label)}</button>`;
const inp = (name, label, value = '', { type = 'text', req = false, help = '', ph = '', attrs = '' } = {}) => `<label class="fld wide"><span>${label}${req ? ' <em>*</em>' : ''}</span>
  <input class="input plain" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" ${attrs} />${help ? `<span class="help">${help}</span>` : ''}</label>`;
const catSelect = (cur) => `<label class="fld wide"><span>Category <em>*</em></span><select class="select" name="category">${cur ? '' : opt('', 'Choose…', true)}${state.meta.categories.map((c) => opt(c.key, `${c.label}${c.requires_verification ? ' — needs verification' : ''}`, cur === c.key)).join('')}</select>
  <span class="help">Professional categories start as pending verification and cannot be activated until verification exists.</span></label>`;

function openForm(kind, extra) {
  const a = state.detail?.affiliate;
  state.form = kind;
  if (kind === 'new') {
    showDrawer('New affiliate', 'A public ID is issued automatically', `<form id="afForm" novalidate><div class="form-grid">
      ${inp('display_name', 'Display name', '', { req: true, ph: 'Dr. Asha Rao', attrs: 'maxlength="120"' })}
      ${catSelect('')}
      ${inp('contact_email', 'Email', '', { type: 'email', ph: 'name@example.com' })}
      ${inp('contact_phone', 'Phone', '', { type: 'tel', ph: '+91 98765 43210', help: 'A 10-digit number is taken as Indian (+91).' })}
      ${inp('rate_percent', 'Initial rate (%)', '', { ph: '10', attrs: 'inputmode="decimal"', help: 'Optional. 0 to 100, up to 2 decimals. Starts now; later changes add new rates.' })}
    </div></form>`, footButtons('Create affiliate'));
  } else if (kind === 'edit') {
    showDrawer('Edit profile', `${a.display_name} · ${a.public_id}`, `<form id="afForm" novalidate><div class="form-grid">
      ${inp('display_name', 'Display name', a.display_name, { req: true, attrs: 'maxlength="120"' })}
      ${catSelect(a.category)}
      ${inp('contact_email', 'Email', a.contact_email || '', { type: 'email' })}
      ${inp('contact_phone', 'Phone', a.contact_phone || '', { type: 'tel', help: 'A 10-digit number is taken as Indian (+91).' })}
      <p class="help wide">The public ID, status and rate are not edited here. Moving to a professional category returns the partner to pending verification.</p>
    </div></form>`, footButtons('Save changes'));
  } else if (kind === 'rate') {
    const tomorrow = istDayKey(new Date(Date.now() + 86400000));
    showDrawer('New rate', `${a.display_name} · current ${a.current_rate_bps === null ? 'not set' : pct(a.current_rate_bps)}`, `<form id="afForm" novalidate><div class="form-grid">
      ${inp('rate_percent', 'Rate (%)', '', { req: true, ph: '12.5', attrs: 'inputmode="decimal"', help: '0 to 100, up to 2 decimals.' })}
      <fieldset class="fld wide af-when"><span>Starts</span>
        <label><input type="radio" name="when" value="now" checked /> Now</label>
        <label><input type="radio" name="when" value="date" /> From the start of a later day (IST)</label>
        <input class="input plain" name="effective_day" type="date" min="${tomorrow}" value="${tomorrow}" disabled aria-label="Start date" />
      </fieldset>
      <label class="fld wide"><span>Reason <em>*</em></span><textarea class="input" name="reason" rows="2" maxlength="300" placeholder="Why the rate changes"></textarea></label>
      <p class="help wide">Earlier rates stay in the history unchanged. Rates cannot start in the past.</p>
    </div></form>`, footButtons('Add rate'));
  } else if (kind === 'status') {
    const t = state.meta.transitions[extra];
    if (!t.reason) {
      if (!window.confirm(CONFIRM[extra] || `${t.label} this affiliate?`)) { state.form = null; return; }
      state.form = { status: extra, noForm: true };
      saveForm();
      return;
    }
    state.form = { status: extra };
    const warn = extra === 'close' ? 'Closing is final: a closed affiliate cannot be reopened or edited. History is kept.' : 'The partner keeps its history and can be reactivated later.';
    showDrawer(`${t.label} affiliate`, `${a.display_name} · ${a.public_id}`, `<form id="afForm" novalidate><div class="form-grid">
      <label class="fld wide"><span>Reason <em>*</em></span><textarea class="input" name="reason" rows="3" maxlength="300"></textarea><span class="help">Recorded with your name and the time.</span></label>
      <p class="help wide">${esc(warn)}</p>
    </div></form>`, `<button class="btn" type="button" data-close>Cancel</button><button class="btn ${extra === 'close' ? 'danger' : 'primary'}" type="button" id="dSave">${esc(t.label)}</button>`);
  }
}

const formData = () => Object.fromEntries(new FormData($('#afForm')).entries());

async function saveForm() {
  const a = state.detail?.affiliate;
  const btn = $('#dSave');
  if (btn) btn.disabled = true;
  try {
    if (state.form === 'new') {
      const out = await send('/api/affiliates', 'POST', formData());
      state.dirty = false; closeDrawer({ force: true });
      window.location.assign(`/affiliates/${encodeURIComponent(out.affiliate.public_id)}`);
      return;
    }
    let out;
    if (state.form === 'edit') out = await send(`/api/affiliates/${a.public_id}`, 'PATCH', { ...formData(), version: a.version });
    else if (state.form === 'rate') {
      const d = formData();
      out = await send(`/api/affiliates/${a.public_id}/rates`, 'POST', {
        rate_percent: d.rate_percent, reason: d.reason,
        effective_from: d.when === 'date' && d.effective_day ? `${d.effective_day}T00:00:00+05:30` : undefined,
      });
    } else if (state.form?.status) {
      out = await send(`/api/affiliates/${a.public_id}/status`, 'POST', { action: state.form.status, version: a.version, reason: state.form.noForm ? undefined : formData().reason });
    }
    state.detail = out;
    state.dirty = false; closeDrawer({ force: true });
    renderDetail();
  } catch (err) {
    if ($('#drawer').hidden) { failed(err, false); if (err.status === 409) loadDetail(); return; }
    fieldError(err);
  } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------------ events

let searchTimer = null;
function bind() {
  const sig = { signal: pageSignal() };
  const setFilter = (k, v) => { state.f[k] = v; if (k === 'sort') state.f.dir = ''; writeUrl(); loadList(); };
  $('#view').addEventListener('input', (e) => {
    if (e.target.id === 'fq') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setFilter('q', e.target.value.trim()), 250);
    }
  });
  $('#view').addEventListener('change', (e) => {
    const k = { fcategory: 'category', fstatus: 'status', fsort: 'sort' }[e.target.id];
    if (k) { e.target.classList.toggle('on', Boolean(e.target.value) && k !== 'sort'); setFilter(k, e.target.value); }
  });
  const go = (e) => {
    if (e.target.closest('a, button')) return;
    const row = e.target.closest('[data-href]');
    if (row) window.location.assign(row.dataset.href);
  };
  $('#view').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (t?.id === 'fclear') { for (const k of ['q', 'category', 'status']) state.f[k] = ''; writeUrl(); listFrame(); loadList(); return; }
    if (t?.id === 'moreBtn') { loadList({ append: true }); return; }
    if (t?.dataset.kpi !== undefined) { state.f.status = t.dataset.kpi; writeUrl(); listFrame(); loadList(); return; }
    if (t?.dataset.open) { openForm(t.dataset.open); return; }
    go(e);
  });
  $('#view').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-href]')) window.location.assign(e.target.dataset.href); });
  $('#pageActions').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'refresh') { if (state.publicId) loadDetail(); else loadList(); }
    if (t.id === 'newAffiliate') openForm('new');
    if (t.dataset.open) openForm(t.dataset.open);
    if (t.dataset.status) openForm('status', t.dataset.status);
  });
  $('#alerts').addEventListener('click', (e) => { if (e.target.id === 'retry') { if (state.publicId) loadDetail(); else loadList(); } });
  $('#dBody').addEventListener('input', () => { state.dirty = true; });
  $('#dBody').addEventListener('change', (e) => {
    state.dirty = true;
    if (e.target.name === 'when') $('#dBody [name="effective_day"]').disabled = e.target.value !== 'date';
  });
  $('#dBody').addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });
  $('#dFoot').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'dSave') saveForm();
    if (t.dataset.close !== undefined) closeDrawer();
  });
  $('#dClose').addEventListener('click', () => closeDrawer());
  $('#drawerScrim').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); }, sig);
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); }, sig);
  onQueryChange(() => { readUrl(); if (!state.publicId) { listFrame(); loadList(); } });
}

(async function init() {
  try {
    const [me, meta] = await Promise.all([api('/auth/me'), api('/api/affiliates/meta')]);
    state.me = me; state.meta = meta;
    initShell(me);
    readUrl();
    bind();
    if (state.publicId) await loadDetail();
    else { listFrame(); await loadList(); }
  } catch (err) {
    $('#view').innerHTML = '';
    $('#pageSub').textContent = '';
    failed(err);
  }
}());
