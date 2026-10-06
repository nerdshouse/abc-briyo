/**
 * Members (admin) — every person who can sign in to Briyo OS, their profile,
 * departments and roles, account state and history.
 *
 * Every change goes through the existing /api/members endpoints, which keep
 * their protections (env admins, the last admin, number moves); this page
 * only presents them. Times are shown in IST.
 */
import {
  $, $$, esc, count, icon, renderIcons, initShell, pageFetch, pageSignal, onQueryChange, relative, toast, confirmDialog, initials,
} from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, catalog: {}, members: [], log: [], bootstrap: [], filter: 'all', q: '', open: null, adding: false };

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {} });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, field: data.field });
  return data;
};
const send = (url, method, body) => api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });

const FILTERS = {
  all: ['All', () => true],
  incomplete: ['Incomplete profile', (m) => m.active && !m.profile_complete],
  no_access: ['No department', (m) => m.active && !m.is_admin && !Object.keys(m.modules || {}).length],
  admins: ['Admins', (m) => m.active && m.is_admin],
  inactive: ['Deactivated', (m) => !m.active],
};
const FIELD = { name: 'name', email: 'email', photo: 'photo' };
const FIELD_LABEL = { name: 'full name', email: 'email', photo: 'profile photo' };
const CAP_LABEL = {
  'logistics.view': 'See orders and shipments', 'logistics.edit': 'Create and update orders and shipments', 'logistics.setup': 'Manage couriers and destinations',
  'inventory.view': 'See stock and SKUs', 'inventory.move': 'Receive, adjust and transfer stock', 'inventory.catalog': 'Manage SKUs, suppliers and warehouses',
  'support.work': 'Work the cart recovery board', 'hr.view': 'See jobs and candidates', 'hr.manage': 'Manage jobs and applications',
};

const roleLabel = (mod, role) => state.catalog[mod]?.roles?.find((r) => r.key === role)?.label || role;
const deptLabel = (mod) => state.catalog[mod]?.label || mod;
const isEnvAdmin = (m) => state.bootstrap.includes(m.phone);
const activeAdmins = () => state.members.filter((m) => m.active && m.is_admin).length;
const avatar = (m, cls = '') => `<span class="avatar ${cls}">${m.photo_url ? `<img src="${esc(m.photo_url)}" alt="" loading="lazy" />` : esc(initials(m.name))}</span>`;
const deptChips = (m) => {
  const mods = Object.entries(m.modules || {});
  const chips = mods.map(([k, r]) => `<span class="badge">${esc(deptLabel(k))} · ${esc(roleLabel(k, r))}</span>`).join('');
  return `${m.is_admin ? '<span class="badge info">Admin</span>' : ''}${chips || (m.is_admin ? '' : '<span class="badge warn">No department</span>')}`;
};
const profileBadge = (m) => (m.profile_complete ? '<span class="badge ok">Complete</span>'
  : `<span class="badge warn" title="Missing: ${esc(m.profile_missing.join(', '))}">Missing ${esc(m.profile_missing.map((x) => FIELD[x]).join(', '))}</span>`);
const statusBadge = (m) => (m.active ? '<span class="status ok"><span class="dot"></span>Active</span>' : '<span class="status neutral"><span class="dot"></span>Deactivated</span>');

// ------------------------------------------------------------------ list

function readUrl() {
  const u = new URLSearchParams(window.location.search);
  state.filter = FILTERS[u.get('filter')] ? u.get('filter') : 'all';
  state.q = u.get('q') || '';
  state.open = u.get('member') || null;
}
function writeUrl() {
  const u = new URLSearchParams();
  if (state.filter !== 'all') u.set('filter', state.filter);
  if (state.q) u.set('q', state.q);
  if (state.open) u.set('member', state.open);
  const next = `${window.location.pathname}${u.toString() ? `?${u}` : ''}`;
  if (next !== `${window.location.pathname}${window.location.search}`) history.replaceState(history.state, '', next);
}

async function load() {
  const data = await api('/api/members');
  state.members = data.members || [];
  state.log = data.log || [];
  state.bootstrap = data.bootstrapAdmins || [];
  render();
}

function render() {
  const all = state.members;
  const active = all.filter((m) => m.active);
  const incomplete = active.filter((m) => !m.profile_complete).length;
  $('#pageSub').textContent = `${count(active.length)} active member${active.length === 1 ? '' : 's'}${incomplete ? ` · ${count(incomplete)} with an incomplete profile` : ' · every profile complete'}`;
  const noDept = active.filter(FILTERS.no_access[1]).length;
  const byDept = Object.keys(state.catalog).map((k) => [k, active.filter((m) => m.modules?.[k]).length]);
  $('#summary').innerHTML = `
    <div class="mb-stat"><span>Members</span><b class="num">${count(all.length)}</b></div>
    <div class="mb-stat"><span>Active</span><b class="num">${count(active.length)}</b></div>
    <a class="mb-stat${incomplete ? ' warn' : ''}" href="/admin?filter=incomplete"><span>Incomplete profiles</span><b class="num">${count(incomplete)}</b></a>
    <a class="mb-stat${noDept ? ' info' : ''}" href="/admin?filter=no_access"><span>No department</span><b class="num">${count(noDept)}</b></a>
    <div class="mb-stat mb-depts"><span>By department</span><div class="mb-chips">${byDept.map(([k, v]) => `<span class="badge">${esc(deptLabel(k))} <b class="num">${count(v)}</b></span>`).join('')}<span class="badge info">Admins <b class="num">${count(active.filter((m) => m.is_admin).length)}</b></span></div></div>`;
  $('#tabs').innerHTML = Object.entries(FILTERS).map(([k, [label, fn]]) => `<button type="button" class="tab${state.filter === k ? ' active' : ''}" role="tab" aria-selected="${state.filter === k}" data-filter="${k}">${esc(label)}<span class="tab-count">${count(all.filter(fn).length)}</span></button>`).join('');
  const q = state.q.toLowerCase().replace(/^\+/, '');
  const rows = all.filter(FILTERS[state.filter][1]).filter((m) => !q || [m.name, m.email, m.phone].some((v) => String(v || '').toLowerCase().includes(q)));
  $('#resultNote').textContent = `${count(rows.length)} member${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    const empty = state.q || state.filter !== 'all'
      ? `<div class="state">${icon('search-x')}<b>Nobody matches.</b><span>Try another search or filter.</span></div>`
      : `<div class="state">${icon('users')}<b>No members yet.</b><span>Add the first one with Add member.</span></div>`;
    $('#rows').innerHTML = `<tr><td colspan="6">${empty}</td></tr>`;
    $('#clist').innerHTML = `<li class="oitem">${empty}</li>`;
  } else {
    $('#rows').innerHTML = rows.map((m) => `
      <tr class="orow${m.active ? '' : ' mb-inactive'}${state.open === m.phone ? ' open' : ''}" data-member="${esc(m.phone)}" tabindex="0">
        <td><div class="mb-who">${avatar(m)}<div style="min-width:0"><span class="cell-main" style="font-weight:500">${esc(m.name)}</span><span class="cell-sub muted">${esc(m.email || 'No email yet')}</span></div></div></td>
        <td class="mono">+${esc(m.phone)}</td>
        <td><div class="mb-chips">${deptChips(m)}</div></td>
        <td>${profileBadge(m)}</td>
        <td><span title="${esc(istDateTime(m.last_seen_at || m.last_login))}">${m.last_seen_at || m.last_login ? esc(relative(m.last_seen_at || m.last_login)) : '<span class="muted-cell">Never signed in</span>'}</span></td>
        <td>${statusBadge(m)}</td>
      </tr>`).join('');
    $('#clist').innerHTML = rows.map((m) => `
      <li class="oitem" data-member="${esc(m.phone)}" tabindex="0">
        <div class="mb-who">${avatar(m)}<div style="min-width:0"><div class="oi-id">${esc(m.name)}</div><div class="oi-sub">+${esc(m.phone)}${m.email ? ` · ${esc(m.email)}` : ''}</div></div></div>
        <div class="mb-chips" style="margin-top:8px">${deptChips(m)} ${profileBadge(m)}${m.active ? '' : ' <span class="badge">Deactivated</span>'}</div>
      </li>`).join('');
  }
  $('#log').innerHTML = state.log.length ? `<ul class="hr-timeline mb-loglist">${state.log.map((l) => `<li><span><b>${esc(l.actor || 'Someone')}</b> ${esc(l.action)} ${l.target_phone ? `<span class="mono">+${esc(l.target_phone)}</span>` : ''}${l.detail ? ` — ${esc(l.detail)}` : ''}</span><span class="soft">${esc(istDateTime(l.at))}</span></li>`).join('')}</ul>`
    : `<div class="state"><b>No changes recorded yet.</b></div>`;
  renderIcons();
}

// ------------------------------------------------------------------ drawer

function openDrawer(title, sub = '') {
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
  $('#dTitle').textContent = title; $('#dSub').innerHTML = sub; $('#dSaved').textContent = '';
}
function closeDrawer() {
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true;
  state.open = null; state.adding = false; writeUrl();
  $$('.orow.open').forEach((r) => r.classList.remove('open'));
}
const saved = (msg, cls = 'saved') => { $('#dSaved').className = cls; $('#dSaved').textContent = msg; };

function moduleSelects(current = {}, prefix = '') {
  return Object.entries(state.catalog).map(([mod, c]) => `<label class="fld"><span>${esc(c.label)}</span>
    <select class="select" id="${prefix}${mod}" data-module="${esc(mod)}"><option value="">No access</option>
    ${c.roles.map((r) => `<option value="${esc(r.key)}"${current[mod] === r.key ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>`).join('');
}
function changesFrom(root, current = {}) {
  const out = {};
  for (const sel of root.querySelectorAll('select[data-module]')) {
    const want = sel.value || null;
    if ((current[sel.dataset.module] || null) !== want) out[sel.dataset.module] = want;
  }
  return out;
}
function capsOf(m) {
  if (m.is_admin) return null;
  const caps = new Set();
  for (const [mod, role] of Object.entries(m.modules || {})) for (const c of state.catalog[mod]?.roles?.find((r) => r.key === role)?.caps || []) caps.add(c);
  return [...caps];
}

async function openMember(phone) {
  const m = state.members.find((x) => x.phone === phone);
  if (!m) { closeDrawer(); return; }
  state.open = phone; state.adding = false; writeUrl();
  $$('.orow').forEach((r) => r.classList.toggle('open', r.dataset.member === phone));
  openDrawer(m.name, `+${esc(m.phone)} · ${statusBadge(m)}`);
  renderMember(m, null);
  try {
    const act = await api(`/api/members/${phone}/activity`);
    if (state.open === phone) renderMember(state.members.find((x) => x.phone === phone), act);
  } catch { /* activity is a nice-to-have; the rest of the drawer works */ }
}

function renderMember(m, act) {
  const env = isEnvAdmin(m);
  const lastAdmin = m.active && m.is_admin && activeAdmins() === 1;
  const caps = capsOf(m);
  const pct = Math.round(((4 - m.profile_missing.length) / 4) * 100);
  $('#dBody').innerHTML = `
    <section class="dsec mb-head">
      ${avatar(m, 'mb-avatar-lg')}
      <div style="min-width:0">
        <div class="mb-name">${esc(m.name)}</div>
        <div class="soft">${esc(m.email || 'No email yet')}</div>
        <div class="soft mono">+${esc(m.phone)}</div>
        <div class="mb-chips" style="margin-top:6px">${statusBadge(m)} ${env ? '<span class="badge info" title="Set in ADMIN_PHONES">Env admin</span>' : ''}</div>
      </div>
    </section>

    <section class="dsec"><h3 class="dsec-title">Profile <span><span class="pf-meter"><span style="width:${pct}%"></span></span> ${pct}%</span></h3>
      ${m.profile_complete ? '' : `<p class="mb-missing">${icon('circle-alert')} Missing: ${esc(m.profile_missing.map((x) => FIELD_LABEL[x]).join(', '))}. ${m.profile_required
        ? 'They must complete it before using Briyo OS.' : 'They can keep working; Briyo OS reminds them to finish it.'}</p>`}
      <form id="mbProfile" class="form-grid" novalidate>
        <label class="fld"><span>Full name</span><input class="input" name="name" value="${esc(m.name)}" maxlength="60" /></label>
        <label class="fld"><span>Email</span><input class="input" name="email" type="email" value="${esc(m.email || '')}" maxlength="254" /></label>
        <label class="fld wide"><span>Mobile (WhatsApp sign-in)</span><input class="input mono" value="+${esc(m.phone)}" readonly /></label>
      </form>
      <div class="form-actions"><button class="btn primary" type="button" data-act="save-profile">Save profile</button>
        ${m.has_photo ? '<button class="btn" type="button" data-act="clear-photo">Remove photo…</button>' : ''}</div>
      <div id="mbProfileErr"></div>
    </section>

    <section class="dsec"><h3 class="dsec-title">Departments &amp; roles</h3>
      ${m.is_admin ? '<p class="soft mb-note">Admins have every department while they are admin. The roles below apply if admin is removed.</p>' : ''}
      <div class="form-grid" id="mbModules">${moduleSelects(m.modules || {}, 'mb-')}</div>
      <div class="form-actions"><button class="btn primary" type="button" data-act="save-modules">Save access</button></div>
    </section>

    <section class="dsec"><h3 class="dsec-title">Permissions</h3>
      ${caps === null ? '<p class="soft">Everything, including Members and Analytics.</p>'
        : caps.length ? `<ul class="pf-caps">${caps.map((c) => `<li>${icon('check')}${esc(CAP_LABEL[c] || c)}</li>`).join('')}</ul>` : '<p class="soft">No department yet — they will see “No access yet” until one is assigned.</p>'}
    </section>

    <section class="dsec"><h3 class="dsec-title">Account</h3>
      <div class="kv-list">
        <div class="hr-kv"><span>Added</span><span>${esc(istDateTime(m.added_at))}${m.added_by ? ` · by ${esc(m.added_by)}` : ''}</span></div>
        <div class="hr-kv"><span>Last signed in</span><span>${m.last_login ? esc(istDateTime(m.last_login)) : 'Never'}</span></div>
        <div class="hr-kv"><span>Last active</span><span>${m.last_seen_at ? esc(istDateTime(m.last_seen_at)) : '—'}</span></div>
      </div>
      ${env ? '<p class="soft mb-note">This number is set in ADMIN_PHONES. Its admin access, number and status are managed in the environment, not here.</p>' : `
      <div class="form-actions">
        <button class="btn" type="button" data-act="admin" ${lastAdmin ? 'disabled title="The last admin cannot be demoted"' : ''}>${m.is_admin ? 'Remove admin' : 'Make admin'}</button>
        <button class="btn" type="button" data-act="phone">Change number…</button>
        <button class="btn" type="button" data-act="active" ${lastAdmin ? 'disabled title="The last admin cannot be deactivated"' : ''}>${m.active ? 'Deactivate' : 'Reactivate'}</button>
      </div>`}
    </section>

    ${env ? '' : `<section class="dsec hr-danger"><h3 class="dsec-title">Remove member</h3>
      <p class="soft">Removes their access for good. Their history stays in the record.</p>
      <button class="btn" type="button" data-act="remove" ${lastAdmin ? 'disabled title="The last admin cannot be removed"' : ''}>${icon('user-x')}Remove member…</button></section>`}

    <section class="dsec"><h3 class="dsec-title">Recent activity</h3>
      ${!act ? '<p class="soft">Loading…</p>' : (act.changes.length + act.signIns.length) ? `<ul class="hr-timeline">${[
        ...act.changes.map((c) => ({ at: c.at, html: `${esc(c.actor || 'Someone')} ${esc(c.action)}${c.detail ? ` — ${esc(c.detail)}` : ''}` })),
        ...act.signIns.map((l) => ({ at: l.at, html: l.ok ? 'Signed in' : `Sign-in failed${l.reason ? ` (${esc(l.reason)})` : ''}` })),
      ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 25).map((x) => `<li><span>${x.html}</span><span class="soft">${esc(istDateTime(x.at))}</span></li>`).join('')}</ul>` : '<p class="soft">Nothing recorded yet.</p>'}
    </section>`;
  renderIcons();
}

function renderAdd() {
  state.adding = true; state.open = null; writeUrl();
  openDrawer('Add member', 'They sign in with this WhatsApp number and a one-time code');
  $('#dBody').innerHTML = `<form id="mbAdd" class="dsec" novalidate>
    <div class="form-grid">
      <label class="fld"><span>Name <em>*</em></span><input class="input" name="name" maxlength="60" required autocomplete="off" /></label>
      <label class="fld"><span>Mobile (WhatsApp) <em>*</em></span><input class="input mono" name="phone" type="tel" inputmode="numeric" placeholder="98765 43210" required autocomplete="off" /></label>
    </div>
    <h3 class="dsec-title" style="margin-top:16px">Departments</h3>
    <div class="form-grid" id="addModules">${moduleSelects({ support: 'agent' }, 'add-')}</div>
    <label class="checkline mb-check"><input type="checkbox" name="isAdmin" /> Admin — every department, and can manage members</label>
    <p class="soft mb-note">On first sign-in they complete their profile: name, email and a photo.</p>
    <div id="mbAddErr"></div>
    <div class="form-actions"><button class="btn primary" type="submit">Add member</button></div>
  </form>`;
  renderIcons();
}

// ------------------------------------------------------------------ actions

async function act(kind) {
  const m = state.members.find((x) => x.phone === state.open);
  if (!m) return;
  const phone = m.phone;
  const errBox = $('#mbProfileErr');
  try {
    if (kind === 'save-profile') {
      const f = new FormData($('#mbProfile'));
      const body = {};
      if (f.get('name').trim() !== m.name) body.name = f.get('name').trim();
      if (f.get('email').trim().toLowerCase() !== (m.email || '')) body.email = f.get('email').trim();
      if (!Object.keys(body).length) { saved('Nothing to save'); return; }
      await send(`/api/members/${phone}`, 'PATCH', body);
      toast('Profile saved');
    } else if (kind === 'clear-photo') {
      if (!await confirmDialog({ title: 'Remove profile photo?', body: '<p>This will make the member\'s profile incomplete until a new photo is uploaded.</p>', confirmLabel: 'Remove photo', danger: true })) return;
      await send(`/api/members/${phone}/photo`, 'DELETE');
      toast('Photo removed — the profile is incomplete until a new one is uploaded');
    } else if (kind === 'save-modules') {
      const changes = changesFrom($('#mbModules'), m.modules || {});
      if (!Object.keys(changes).length) { saved('No changes'); return; }
      await send(`/api/members/${phone}`, 'PATCH', { modules: changes });
      toast('Access saved — it applies on their next page load');
    } else if (kind === 'admin') {
      if (!await confirmDialog({ title: m.is_admin ? 'Remove admin access?' : 'Make admin?', body: m.is_admin
        ? `<p>${esc(m.name)} keeps only their department roles.</p>` : `<p>${esc(m.name)} gets every department and can manage members.</p>`, confirmLabel: m.is_admin ? 'Remove admin' : 'Make admin', danger: m.is_admin })) return;
      await send(`/api/members/${phone}`, 'PATCH', { isAdmin: !m.is_admin });
      toast(m.is_admin ? 'Admin removed' : 'Now an admin');
    } else if (kind === 'active') {
      if (m.active && !await confirmDialog({ title: 'Deactivate this member?', body: `<p>${esc(m.name)} loses access within a minute. You can reactivate them later.</p>`, confirmLabel: 'Deactivate', danger: true })) return;
      await send(`/api/members/${phone}`, 'PATCH', { active: !m.active });
      toast(m.active ? 'Deactivated' : 'Reactivated');
    } else if (kind === 'phone') {
      const next = window.prompt(`New WhatsApp number for ${m.name}:`, '');
      if (!next || !next.trim()) return;
      const out = await send(`/api/members/${phone}`, 'PATCH', { newPhone: next.trim() });
      toast(`Number changed to +${out.member.phone}`);
      state.open = out.member.phone;
    } else if (kind === 'remove') {
      if (!await confirmDialog({ title: 'Remove this member?', body: `<p>${esc(m.name)} loses access within a minute. Their history stays in the record.</p>`, confirmLabel: 'Remove member', danger: true, typeToConfirm: `+${m.phone}` })) return;
      await send(`/api/members/${phone}`, 'DELETE');
      toast('Member removed');
      closeDrawer();
      await load();
      return;
    }
    await load();
    if (state.open) openMember(state.open);
  } catch (err) {
    if (errBox) errBox.innerHTML = `<div class="form-error">${esc(err.message)}</div>`; else toast(err.message, { tone: 'bad' });
  }
}

async function addMember(form) {
  const f = new FormData(form);
  $('#mbAddErr').innerHTML = '';
  try {
    const out = await send('/api/members', 'POST', {
      name: String(f.get('name') || '').trim(), phone: String(f.get('phone') || '').trim(), isAdmin: f.get('isAdmin') === 'on',
      // Every module, "No access" included, so an explicit none is not read as "not chosen".
      modules: Object.fromEntries([...form.querySelectorAll('select[data-module]')].map((s) => [s.dataset.module, s.value || null])),
    });
    toast(`${out.member.name} can now sign in with +${out.member.phone}`);
    await load();
    openMember(out.member.phone);
  } catch (err) { $('#mbAddErr').innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
}

function bind() {
  const sig = { signal: pageSignal() };
  $('#tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-filter]'); if (!t) return; state.filter = t.dataset.filter; writeUrl(); render(); });
  let timer = null;
  $('#q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value.trim(); writeUrl(); render(); }, 150); });
  $('#refresh').addEventListener('click', () => load().catch((err) => toast(err.message, { tone: 'bad' })));
  $('#addMember').addEventListener('click', renderAdd);
  const pick = (e) => { const r = e.target.closest('[data-member]'); if (r) openMember(r.dataset.member); };
  for (const el of [$('#rows'), $('#clist')]) {
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(e); });
  }
  $('#dBody').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) act(b.dataset.act); });
  $('#dBody').addEventListener('submit', (e) => { if (e.target.id === 'mbAdd') { e.preventDefault(); addMember(e.target); } });
  $('#dBody').addEventListener('input', (e) => { if (e.target.name === 'phone' && e.target.closest('#mbAdd')) e.target.value = e.target.value.replace(/[^\d\s+]/g, ''); });
  for (const el of [$('#dClose'), $('#dDone'), $('#drawerScrim')]) el.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden && !document.querySelector('.modal-scrim')) closeDrawer(); }, sig);
  onQueryChange(async () => { readUrl(); $('#q').value = state.q; render(); if (state.open) openMember(state.open); });
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    state.catalog = state.me.moduleCatalog || {};
    initShell(state.me);
    readUrl();
    $('#q').value = state.q;
    bind();
    await load();
    if (state.open) openMember(state.open);
  } catch (err) {
    $('#pageSub').textContent = '';
    $('#rows').innerHTML = `<tr><td colspan="6"><div class="state error"><b>Members could not be loaded.</b><span>${esc(err.message)}</span></div></td></tr>`;
  }
}());
