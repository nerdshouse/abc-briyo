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
const state = { me: null, meta: null, f: {}, list: [], total: 0, kpis: null, detail: null, ver: null, ref: null, publicId: null, form: null, dirty: false };

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
    const pid = encodeURIComponent(state.publicId);
    const [data, ver, ref] = await Promise.all([api(`/api/affiliates/${pid}`), api(`/api/affiliates/${pid}/verification`), api(`/api/affiliates/${pid}/referral`)]);
    state.detail = data; state.ver = ver; state.ref = ref;
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

      ${verificationCard()}
      ${referralCard()}

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
  if (kind === 'ver') { openVerificationForm(extra); return; }
  if (kind === 'ref') { openReferralForm(extra); return; }
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
    if (VER_FORMS.includes(state.form?.ver)) { await saveVerification(); return; }
    if (state.form?.ref) { await saveReferral(); return; }
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
    state.ver = await api(`/api/affiliates/${encodeURIComponent(a.public_id)}/verification`).catch(() => state.ver);
    state.ref = await api(`/api/affiliates/${encodeURIComponent(a.public_id)}/referral`).catch(() => state.ref);
    state.dirty = false; closeDrawer({ force: true });
    renderDetail();
  } catch (err) {
    if ($('#drawer').hidden) { failed(err, false); if (err.status === 409) loadDetail(); return; }
    fieldError(err);
  } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------------ professional verification (Phase 1D)

const APP_STATUS = {
  draft: ['new', 'Draft'], submitted: ['callback', 'Submitted'], under_review: ['callback', 'Under review'],
  approved: ['recovered', 'Approved'], rejected: ['lost', 'Rejected'],
};
const appTag = (s) => (s ? `<span class="status ${APP_STATUS[s]?.[0] || ''}"><span class="dot"></span>${esc(APP_STATUS[s]?.[1] || s)}</span>`
  : '<span class="status none"><span class="dot"></span>Not started</span>');
const DOC_TYPE = { certificate: 'Certificate', registration: 'Registration proof', other: 'Other' };
const PROF_FIELDS = [
  ['full_name', 'Name on credential'], ['profession', 'Profession'], ['qualification', 'Qualification'], ['institution', 'Institution'],
  ['registration_number', 'Registration number'], ['registration_authority', 'Registration authority'], ['practice_name', 'Practice'],
  ['specialization', 'Specialization'], ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['profile_notes', 'Notes'],
];
const VER_FORMS = ['profile', 'upload', 'approve', 'reject', 'action'];
const VER_CONFIRM = {
  submit: 'Submit this application for verification? The professional details are copied into it and its documents are locked.',
  review: 'Mark this application as under review?',
  resubmit: 'Start a new application after the rejection? The rejected application stays on record unchanged.',
  start: 'Start a verification application?',
};
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const docUrl = (app, d) => `/api/affiliates/${encodeURIComponent(state.publicId)}/verification/${encodeURIComponent(app.ref)}/documents/${encodeURIComponent(d.ref)}`;
const expiryTag = (d) => (d.expiry === 'expired' ? '<span class="mini-tag warn">Expired</span>' : d.expiry === 'expiring_soon' ? '<span class="mini-tag warn">Expires soon</span>' : '');
const by = (at, who) => (at ? `${esc(istDateTime(at))}${who ? ` <span class="soft">· ${esc(who)}</span>` : ''}` : '<span class="soft">—</span>');

function docTable(app, canOpen) {
  if (!app.documents.length) return '<div class="empty-note"><b>No documents on this application.</b></div>';
  return `<div class="table-wrap"><table class="table af-docs">
    <thead><tr><th>Document</th><th>File</th><th>Issued</th><th>Expires</th><th>Uploaded</th><th class="r"><span class="sr-only">Open</span></th></tr></thead>
    <tbody>${app.documents.map((d) => `<tr>
      <td><b>${esc(DOC_TYPE[d.document_type] || d.document_type)}</b>${d.document_label ? `<span class="cell-sub muted">${esc(d.document_label)}</span>` : ''}</td>
      <td>${esc(d.original_filename)}<span class="cell-sub muted">${esc(kb(d.byte_size))}</span></td>
      <td>${d.issued_at ? esc(istDate(`${d.issued_at}T12:00:00+05:30`)) : '<span class="soft">—</span>'}</td>
      <td>${d.expires_at ? `${esc(istDate(`${d.expires_at}T12:00:00+05:30`))} ${expiryTag(d)}` : '<span class="soft">—</span>'}</td>
      <td>${by(d.uploaded_at, d.uploaded_by)}</td>
      <td class="r">${canOpen ? `<a class="linkish" href="${docUrl(app, d)}" target="_blank" rel="noopener">Open</a>` : '<span class="soft" title="Opening documents needs verification access">—</span>'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function appFacts(app) {
  const kv = (label, value) => `<div class="hr-kv"><span>${esc(label)}</span><span>${value}</span></div>`;
  return `${kv('Application', `<span class="mono">${esc(app.ref)}</span>${app.previous_ref ? ` <span class="soft">· follows ${esc(app.previous_ref)}</span>` : ''}`)}
    ${kv('Status', appTag(app.status))}
    ${kv('Started', by(app.created_at, app.created_by))}
    ${kv('Submitted', by(app.submitted_at, app.submitted_by))}
    ${app.review_started_at ? kv('Review started', by(app.review_started_at, app.review_started_by)) : ''}
    ${['approved', 'rejected'].includes(app.status) ? kv(app.status === 'approved' ? 'Approved' : 'Rejected', by(app.reviewed_at, app.reviewed_by)) : ''}
    ${app.rejection_reason ? kv('Rejection reason', esc(app.rejection_reason)) : ''}
    ${app.review_notes ? kv('Review notes', esc(app.review_notes)) : ''}`;
}

function verificationCard() {
  const V = state.ver;
  const v = V?.verification;
  if (!v || (!v.required && !v.profile)) return '';
  const a = state.detail.affiliate;
  const closed = a.status === 'closed';
  const cur = v.current;
  const canM = V.canManage && !closed; const canV = V.canVerify && !closed;
  const act = (key, label, cls = '') => `<button class="btn${cls ? ` ${cls}` : ''}" type="button" data-ver="${key}">${esc(label)}</button>`;
  const actions = [];
  if (v.required && cur) {
    if (canM && cur.status === 'draft') actions.push(act('upload', 'Upload document'));
    if (canV && v.actions.includes('submit')) actions.push(act('submit', 'Submit for verification', cur.documents.some((d) => d.document_type === 'certificate') ? 'primary' : ''));
    if (canV && v.actions.includes('review')) actions.push(act('review', 'Mark under review', 'primary'));
    if (canV && v.actions.includes('approve')) actions.push(act('approve', 'Approve', 'primary'));
    if (canV && v.actions.includes('reject')) actions.push(act('reject', 'Reject'));
    if (canV && cur.status === 'rejected' && a.status === 'pending_verification') actions.push(act('resubmit', 'New application'));
  }
  if (canV && v.can_start && (!cur || !['draft', 'submitted', 'under_review', 'rejected'].includes(cur.status))) actions.push(act('start', 'Start application'));
  const history = v.applications.slice(1);
  const notice = !v.required
    ? '<div class="alert warn">This category does not require verification. The professional details below are kept for reference only.</div>'
    : cur?.status === 'approved'
      ? `<div class="alert af-ok">${icon('badge-check')}<span>Verification approved${a.status === 'approved' ? '. The affiliate can now be activated with <b>Activate</b>; nothing is activated automatically.' : '.'}</span></div>`
      : `<div class="alert warn">${icon('info')}<span>Not verified. A certificate on file is not a verification: only an <b>approved</b> application counts, and approval never activates the affiliate by itself.</span></div>`;
  return `<section class="card af-verify">
    <header class="card-head"><h2 class="card-title">${icon('shield-check')}Professional verification ${appTag(cur?.status)}</h2>
      ${canM && v.profile && v.required ? '<div class="card-tools"><button class="btn" type="button" data-ver="profile">Edit professional profile</button></div>' : ''}</header>
    <div class="pane pad">
      ${notice}
      ${v.profile ? `<div class="af-verify-grid">
        <div><h3 class="dsec-title">Professional profile</h3>
          ${PROF_FIELDS.filter(([k]) => v.profile[k]).map(([k, label]) => `<div class="hr-kv"><span>${esc(label)}</span><span>${esc(v.profile[k])}</span></div>`).join('')}
          <div class="hr-kv"><span>Last updated</span><span>${by(v.profile.updated_at, v.profile.updated_by)}</span></div></div>
        <div><h3 class="dsec-title">Current application</h3>${cur ? appFacts(cur) : '<p class="soft">No application yet.</p>'}</div>
      </div>` : `<div class="empty-note"><b>No professional profile yet.</b>${canM ? 'Add the professional details as they appear on the credential, then upload the certificate.' : 'An affiliate manager adds the professional details.'}
        ${canM ? '<div style="margin-top:10px"><button class="btn primary" type="button" data-ver="profile">Create professional profile</button></div>' : ''}</div>`}
      ${cur ? `<h3 class="dsec-title af-gap">Documents</h3>${docTable(cur, V.canVerify)}` : ''}
      ${actions.length ? `<div class="af-ver-actions">${actions.join('')}</div>` : ''}
      ${history.length ? `<details class="more af-gap"><summary>${icon('chevron-right')}Earlier applications <span class="soft">— ${history.length}, kept as decided</span></summary>
        ${history.map((h) => `<div class="af-hist">${appFacts(h)}${docTable(h, V.canVerify)}</div>`).join('')}</details>` : ''}
    </div>
  </section>`;
}

function openVerificationForm(kind) {
  const v = state.ver.verification; const cur = v.current; const a = state.detail.affiliate;
  const sub = `${a.display_name} · ${a.public_id}`;
  if (['submit', 'review', 'resubmit', 'start'].includes(kind)) {
    if (!window.confirm(VER_CONFIRM[kind])) return;
    state.form = { ver: 'action', action: kind, noForm: true };
    saveForm();
    return;
  }
  state.form = { ver: kind };
  if (kind === 'profile') {
    const p = v.profile || {};
    showDrawer(v.profile ? 'Edit professional profile' : 'Create professional profile', sub, `<form id="afForm" novalidate><div class="form-grid">
      ${PROF_FIELDS.filter(([k]) => k !== 'profile_notes').map(([k, label]) => inp(k, label, p[k] || '', { req: ['full_name', 'profession'].includes(k), attrs: `maxlength="${k === 'registration_number' ? 80 : ['city', 'state', 'country'].includes(k) ? 80 : 200}"` })).join('')}
      <label class="fld wide"><span>Notes</span><textarea class="input" name="profile_notes" rows="3" maxlength="1000">${esc(p.profile_notes || '')}</textarea></label>
      <p class="help wide">Enter the details as they appear on the credential. Submitted applications keep the copy they were reviewed with.</p>
    </div></form>`, footButtons(v.profile ? 'Save profile' : 'Create profile'));
  } else if (kind === 'upload') {
    showDrawer('Upload document', `${sub} · application ${cur.ref}`, `<form id="afForm" novalidate><div class="form-grid">
      <label class="fld wide"><span>Type <em>*</em></span><select class="select" name="type">${v.document_types.map((t) => opt(t, DOC_TYPE[t] || t, t === 'certificate')).join('')}</select></label>
      <label class="fld wide"><span>File <em>*</em></span><input class="input plain" name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" />
        <span class="help">PDF, PNG or JPG, up to ${Math.round(v.max_bytes / 1048576)} MB. The file is checked by its content and stored privately.</span></label>
      ${inp('label', 'Label', '', { ph: 'e.g. State Medical Council registration', attrs: 'maxlength="120"' })}
      ${inp('issued_at', 'Issued on', '', { type: 'date' })}
      ${inp('expires_at', 'Expires on', '', { type: 'date', help: 'Shown as expired or expiring soon; it never changes a status by itself.' })}
      <p class="help wide">Uploading does not verify anything. Documents cannot be removed once added; add a new one if a file was wrong.</p>
    </div></form>`, footButtons('Upload'));
  } else if (kind === 'approve') {
    showDrawer('Approve verification', `${sub} · application ${cur.ref}`, `<form id="afForm" novalidate><div class="form-grid">
      <p class="wide">Approve this application? The affiliate becomes <b>approved</b> and can then be activated with the separate <b>Activate</b> action. No referral link or code is created.</p>
      <label class="fld wide"><span>Review notes</span><textarea class="input" name="notes" rows="3" maxlength="1000" placeholder="Optional"></textarea></label>
    </div></form>`, '<button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" id="dSave">Approve verification</button>');
  } else if (kind === 'reject') {
    showDrawer('Reject verification', `${sub} · application ${cur.ref}`, `<form id="afForm" novalidate><div class="form-grid">
      <label class="fld wide"><span>Reason <em>*</em></span><textarea class="input" name="reason" rows="4" maxlength="1000"></textarea><span class="help">Recorded with your name and the time. The rejected application is kept unchanged; a new application can follow it.</span></label>
      <label class="fld wide"><span>Review notes</span><textarea class="input" name="notes" rows="2" maxlength="1000" placeholder="Optional"></textarea></label>
    </div></form>`, '<button class="btn" type="button" data-close>Cancel</button><button class="btn danger" type="button" id="dSave">Reject verification</button>');
  }
}

async function saveVerification() {
  const pid = encodeURIComponent(state.publicId);
  const v = state.ver.verification; const f = state.form;
  let out;
  if (f.ver === 'profile') {
    out = v.profile ? await send(`/api/affiliates/${pid}/professional`, 'PATCH', { ...formData(), version: v.profile.version })
      : await send(`/api/affiliates/${pid}/professional`, 'POST', formData());
  } else if (f.ver === 'upload') {
    const d = formData(); const file = $('#dBody [name="file"]').files[0];
    if (!file) throw Object.assign(new Error('Choose a file.'), { data: { field: 'file' } });
    const q = new URLSearchParams({ type: d.type });
    for (const k of ['label', 'issued_at', 'expires_at']) if (d[k]) q.set(k, d[k]);
    out = await api(`/api/affiliates/${pid}/verification/documents?${q}`, {
      method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    });
  } else if (f.ver === 'approve' || f.ver === 'reject') {
    out = await send(`/api/affiliates/${pid}/verification/${f.ver}`, 'POST', { ...formData(), version: v.current.version });
  } else if (f.ver === 'action') {
    const latest = v.current;
    out = await send(`/api/affiliates/${pid}/verification/${f.action}`, 'POST', latest ? { version: latest.version } : {});
  }
  state.ver = out;
  // Approval changes the affiliate's status too.
  state.detail = await api(`/api/affiliates/${pid}`);
  state.ref = await api(`/api/affiliates/${pid}/referral`).catch(() => state.ref);
  state.dirty = false; closeDrawer({ force: true });
  renderDetail();
}

// ------------------------------------------------------------------ referral link (Phase 1E)

const METHOD = { coupon: 'Coupon', referral_click: 'Referral click' };
function referralCard() {
  const R = state.ref?.referral;
  if (!R) return '';
  const a = state.detail.affiliate;
  const canM = state.ref.canManage;
  const link = R.link;
  const badge = link
    ? (R.usable ? '<span class="status recovered"><span class="dot"></span>Live</span>' : '<span class="status noresp"><span class="dot"></span>Not usable now</span>')
    : '<span class="status none"><span class="dot"></span>No link</span>';
  const kv = (label, value) => `<div class="hr-kv"><span>${esc(label)}</span><span>${value}</span></div>`;
  const notice = !R.eligibility.eligible
    ? `<div class="alert warn">${icon('info')}<span>${link ? 'The link exists but is not usable: ' : 'A referral link cannot be created yet: '}${esc(R.eligibility.text)}${link ? ' Visitors land on the storefront home page and no click is recorded.' : ''}</span></div>` : '';
  const actions = [];
  if (canM && !link && R.eligibility.eligible) actions.push('<button class="btn primary" type="button" data-ref="create">Create referral link</button>');
  if (canM && link) {
    actions.push(`<button class="btn" type="button" data-ref="redirect">${link.storefront_redirect_set ? 'Re-check storefront redirect' : 'Set up storefront redirect'}</button>`);
    actions.push('<button class="btn" type="button" data-ref="disable">Disable link</button>');
  }
  return `<section class="card af-referral">
    <header class="card-head"><h2 class="card-title">${icon('link')}Referral link ${badge}</h2></header>
    <div class="pane pad">
      ${notice}
      ${link ? `<div class="hr-link af-link"><input class="input mono" id="refUrl" readonly value="${esc(R.public_url)}" aria-label="Referral link" />
          <button class="btn" type="button" data-copy-link>${icon('copy')}Copy</button></div>
        <div class="af-ref-grid">
          <div>${kv('Created', by(link.created_at, link.created_by))}
            ${kv('Storefront redirect', link.storefront_redirect_set ? `Set up ${esc(istDateTime(link.storefront_redirect_at))}` : '<span class="soft">Not set up in Shopify yet — the public link does not work until it is.</span>')}</div>
          <div>${kv('Clicks', `${count(R.clicks.total)} <span class="soft">· ${count(R.clicks.last_30_days)} in 30 days</span>`)}
            ${kv('Latest click', R.clicks.latest_at ? esc(istDateTime(R.clicks.latest_at)) : '<span class="soft">None yet</span>')}
            ${kv('Attributed orders', count(R.attributions.total))}</div>
        </div>`
    : `<div class="empty-note"><b>No referral link.</b>${R.eligibility.eligible ? (canM ? 'Create one: the public link is fixed for this partner.' : 'An affiliate manager creates referral links.') : ''}</div>`}
      ${R.attributions.recent.length ? `<h3 class="dsec-title af-gap">Recent attributions</h3><div class="table-wrap"><table class="table">
        <thead><tr><th>Order</th><th>Method</th><th>Order placed</th><th>Attributed</th><th>Rule</th></tr></thead>
        <tbody>${R.attributions.recent.map((t) => `<tr><td>${esc(t.order || '—')}</td><td>${esc(METHOD[t.method] || t.method)}</td>
          <td>${esc(istDateTime(t.order_placed_at))}</td><td>${esc(istDateTime(t.attributed_at))}</td><td class="mono">${esc(t.rule_version)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${R.history.length ? `<details class="more af-gap"><summary>${icon('chevron-right')}Disabled links <span class="soft">— ${R.history.length}, kept</span></summary>
        ${R.history.map((h) => `<div class="af-hist">${kv('Created', by(h.created_at, h.created_by))}${kv('Disabled', by(h.disabled_at, h.disabled_by))}${kv('Reason', esc(h.disable_reason || '—'))}</div>`).join('')}</details>` : ''}
      ${actions.length && a.status !== 'closed' ? `<div class="af-ver-actions">${actions.join('')}</div>` : ''}
      <p class="soft af-note">Attribution credit only: no commission is calculated or paid.</p>
    </div>
  </section>`;
}

async function copyLink(btn) {
  const input = $('#refUrl');
  try { await navigator.clipboard.writeText(input.value); btn.textContent = 'Copied'; } catch { input.select(); btn.textContent = 'Press ⌘C'; }
  setTimeout(() => { btn.innerHTML = `${icon('copy')}Copy`; renderIcons(); }, 1600);
}

function openReferralForm(kind) {
  const a = state.detail.affiliate;
  if (kind === 'create' || kind === 'redirect') {
    const msg = kind === 'create'
      ? `Create the referral link for ${a.display_name}? Its public address is fixed: ${state.ref.referral.public_url}`
      : 'Create (or check) the /r/ redirect for this partner in Shopify? This is the only change Briyo OS makes in Shopify.';
    if (!window.confirm(msg)) return;
    state.form = { ref: kind, noForm: true };
    saveForm();
    return;
  }
  state.form = { ref: 'disable' };
  showDrawer('Disable referral link', `${a.display_name} · ${a.public_id}`, `<form id="afForm" novalidate><div class="form-grid">
    <label class="fld wide"><span>Reason <em>*</em></span><textarea class="input" name="reason" rows="3" maxlength="300"></textarea><span class="help">Recorded with your name and the time.</span></label>
    <p class="help wide">A disabled link stays disabled and is kept with its clicks and attributions. Visitors then land on the storefront home page. A new link can be created later; the public address stays the same.</p>
  </div></form>`, '<button class="btn" type="button" data-close>Cancel</button><button class="btn danger" type="button" id="dSave">Disable link</button>');
}

async function saveReferral() {
  const pid = encodeURIComponent(state.publicId);
  const f = state.form;
  let out;
  if (f.ref === 'create') out = await send(`/api/affiliates/${pid}/referral`, 'POST', {});
  else if (f.ref === 'redirect') out = await send(`/api/affiliates/${pid}/referral/storefront-redirect`, 'POST', {});
  else out = await send(`/api/affiliates/${pid}/referral/disable`, 'POST', { ...formData(), version: state.ref.referral.link?.version });
  state.ref = out;
  state.detail = await api(`/api/affiliates/${pid}`);
  state.dirty = false; closeDrawer({ force: true });
  renderDetail();
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
    if (t?.dataset.ver) { openForm('ver', t.dataset.ver); return; }
    if (t?.dataset.ref) { openForm('ref', t.dataset.ref); return; }
    if (t?.dataset.copyLink !== undefined) { copyLink(t); return; }
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
