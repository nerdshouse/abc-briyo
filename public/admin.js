'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let bootstrapAdmins = [];
// Modules and their roles, from the server (lib/permissions.js).
let catalog = {};
let editing = null;   // phone whose module access is open for editing

function showError(msg) { $('#banner').textContent = msg; $('#banner').hidden = false; $('#ok').hidden = true; }
function showOk(msg) { $('#ok').textContent = msg; $('#ok').hidden = false; $('#banner').hidden = true; }
function clearBanners() { $('#banner').hidden = true; $('#ok').hidden = true; }

const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) { showError('Admins only.'); throw new Error('forbidden'); }
  if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let members = [];
async function load() {
  try {
    if (!Object.keys(catalog).length) {
      const me = await fetch('/auth/me').then((r) => r.json()).catch(() => ({}));
      catalog = me.moduleCatalog || {};
      $('#addModules').innerHTML = moduleSelects({ support: 'agent' }, 'add-');
    }
    const data = await api('/api/members');
    members = data.members || [];
    bootstrapAdmins = data.bootstrapAdmins || [];
    renderMembers(data.members || []);
    renderLog(data.log || []);
  } catch (err) {
    if (err.message !== 'forbidden') showError(err.message);
    $('#memberRows').innerHTML = '<tr><td colspan="6" class="empty">Could not load members.</td></tr>';
  }
}

function renderMembers(members) {
  if (!members.length) {
    $('#memberRows').innerHTML = '<tr><td colspan="6" class="empty">No members yet.</td></tr>';
    return;
  }
  const activeAdmins = members.filter((m) => m.active && m.is_admin).length;

  $('#memberRows').innerHTML = members.map((m) => {
    // A number in ADMIN_PHONES keeps admin regardless of this table, so don't
    // offer a control that would appear to do nothing.
    const locked = bootstrapAdmins.includes(m.phone);
    const lastAdmin = m.active && m.is_admin && activeAdmins === 1;

    return `
      <tr class="${m.active ? '' : 'inactive'}">
        <td>
          <input class="js-name" data-phone="${esc(m.phone)}" value="${esc(m.name)}"
                 maxlength="60" aria-label="Name" autocomplete="off" />
          ${locked ? '<div class="muted" title="Set in ADMIN_PHONES — cannot be changed here">env admin</div>' : ''}
        </td>
        <td>
          <span class="mono">+${esc(m.phone)}</span>
          ${locked ? '' : `<button class="linky" data-act="phone" data-phone="${esc(m.phone)}">Change</button>`}
        </td>
        <td>
          <div class="chips">${m.is_admin ? '<span class="chip">Admin · all modules</span>' : ''}${moduleChips(m)}</div>
          ${m.active ? '' : '<div class="muted">deactivated</div>'}
        </td>
        <td class="muted">${when(m.last_login)}</td>
        <td class="muted">${when(m.added_at)}${m.added_by ? `<div>by ${esc(m.added_by)}</div>` : ''}</td>
        <td class="actions">
          ${locked ? '<span class="muted">—</span>' : `
            <button data-act="admin" data-phone="${esc(m.phone)}" data-to="${m.is_admin ? 'false' : 'true'}"
              ${lastAdmin ? 'disabled title="The last admin cannot be demoted"' : ''}>
              ${m.is_admin ? 'Remove admin' : 'Make admin'}
            </button>
            <button data-act="modules" data-phone="${esc(m.phone)}">Module access</button>
            <button data-act="active" data-phone="${esc(m.phone)}" data-to="${m.active ? 'false' : 'true'}"
              ${lastAdmin ? 'disabled title="The last admin cannot be deactivated"' : ''}>
              ${m.active ? 'Deactivate' : 'Reactivate'}
            </button>
            <button data-act="remove" data-phone="${esc(m.phone)}" class="danger"
              ${lastAdmin ? 'disabled title="The last admin cannot be removed"' : ''}>Remove</button>
          `}
        </td>
      </tr>${editing === m.phone ? editorRow(m) : ''}`;
  }).join('');
}

/** Chips for a member's module roles; members with none say so. */
function moduleChips(m) {
  const entries = Object.entries(m.modules || {});
  if (!entries.length) return m.is_admin ? '' : '<span class="chip muted-chip">No module access</span>';
  return entries.map(([mod, role]) => `<span class="chip">${esc(catalog[mod]?.label || mod)} · ${esc(roleLabel(mod, role))}</span>`).join('');
}
const roleLabel = (mod, role) => catalog[mod]?.roles?.find((r) => r.key === role)?.label || role;

/** One select per module; "No access" removes that module only. */
function moduleSelects(current = {}, prefix = '') {
  return Object.entries(catalog).map(([mod, c]) => `<div class="field">
      <label for="${prefix}${mod}">${esc(c.label)}</label>
      <select id="${prefix}${mod}" data-module="${esc(mod)}">
        <option value="">No access</option>
        ${c.roles.map((r) => `<option value="${esc(r.key)}"${current[mod] === r.key ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
      </select></div>`).join('');
}

function editorRow(m) {
  return `<tr class="module-editor"><td colspan="6">
    <div class="module-selects" data-editor="${esc(m.phone)}">${moduleSelects(m.modules || {}, `ed-${m.phone}-`)}</div>
    ${m.is_admin ? '<p class="muted">Admins have every module while they are admin. These roles apply if admin is removed.</p>' : ''}
    <div class="row-actions">
      <button class="primary" data-act="save-modules" data-phone="${esc(m.phone)}">Save access</button>
      <button data-act="cancel-modules">Cancel</button>
    </div></td></tr>`;
}

/** The modules a set of selects now asks for, as changes against `current`. */
function changesFrom(root, current = {}) {
  const out = {};
  for (const sel of root.querySelectorAll('select[data-module]')) {
    const want = sel.value || null;
    if ((current[sel.dataset.module] || null) !== want) out[sel.dataset.module] = want;
  }
  return out;
}

function renderLog(log) {
  $('#memberLog').innerHTML = log.length
    ? log.map((l) => `
        <div class="logline">
          <span class="muted">${when(l.at)}</span>
          <span>${esc(l.actor || 'someone')} <strong>${esc(l.action)}</strong>
          ${l.target_phone ? `+${esc(l.target_phone)}` : ''}${l.detail ? ` — ${esc(l.detail)}` : ''}</span>
        </div>`).join('')
    : '<p class="muted">No changes recorded yet.</p>';
}

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearBanners();
  const btn = $('#addBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const data = await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#mname').value.trim(),
        phone: $('#mphone').value.trim(),
        isAdmin: $('#madmin').checked,
        // Every module, "No access" included, so an explicit none is not
        // mistaken for "not chosen" (which defaults to Support agent).
        modules: Object.fromEntries([...$('#addModules').querySelectorAll('select[data-module]')]
          .map((sel) => [sel.dataset.module, sel.value || null])),
      }),
    });
    showOk(`${data.member.name} can now sign in with +${data.member.phone}.`);
    $('#addForm').reset();
    $('#addModules').innerHTML = moduleSelects({ support: 'agent' }, 'add-');
    await load();
  } catch (err) {
    if (err.message !== 'forbidden') showError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Add member';
  }
});

$('#memberRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;
  const { act, phone, to } = btn.dataset;
  clearBanners();

  if (act === 'remove' && !confirm(`Remove +${phone}? They will lose access within a minute.`)) return;

  if (act === 'modules') { editing = editing === phone ? null : phone; renderMembers(members); return; }
  if (act === 'cancel-modules') { editing = null; renderMembers(members); return; }
  if (act === 'save-modules') {
    const m = members.find((x) => x.phone === phone);
    const changes = changesFrom(document.querySelector(`[data-editor="${phone}"]`), m?.modules || {});
    if (!Object.keys(changes).length) { editing = null; renderMembers(members); return; }
    btn.disabled = true;
    try {
      await api(`/api/members/${phone}`, { method: 'PATCH', body: JSON.stringify({ modules: changes }) });
      editing = null;
      showOk('Module access saved. It applies on their next page load.');
      await load();
    } catch (err) {
      if (err.message !== 'forbidden') showError(err.message);
      btn.disabled = false;
    }
    return;
  }

  if (act === 'phone') {
    const next = prompt(`New mobile number for +${phone}:`, '');
    if (!next || !next.trim()) return;
    try {
      const data = await api(`/api/members/${phone}`, {
        method: 'PATCH', body: JSON.stringify({ newPhone: next.trim() }),
      });
      showOk(`Number changed to +${data.member.phone}. They sign in with the new one from now on.`);
      await load();
    } catch (err) {
      if (err.message !== 'forbidden') showError(err.message);
    }
    return;
  }

  btn.disabled = true;
  try {
    if (act === 'remove') {
      await api(`/api/members/${phone}`, { method: 'DELETE' });
      showOk(`+${phone} removed.`);
    } else {
      const body = act === 'admin' ? { isAdmin: to === 'true' } : { active: to === 'true' };
      await api(`/api/members/${phone}`, { method: 'PATCH', body: JSON.stringify(body) });
      showOk('Updated.');
    }
    await load();
  } catch (err) {
    if (err.message !== 'forbidden') showError(err.message);
    btn.disabled = false;
  }
});

// Name saves on Enter or when the field loses focus — same as the notes field
// on the board, so there is no second editing idiom to learn.
$('#memberRows').addEventListener('blur', async (e) => {
  if (!e.target.classList.contains('js-name')) return;
  const input = e.target;
  const phone = input.dataset.phone;
  const value = input.value.trim();
  if (!value || value === input.defaultValue) { input.value = input.defaultValue; return; }

  clearBanners();
  try {
    const data = await api(`/api/members/${phone}`, {
      method: 'PATCH', body: JSON.stringify({ name: value }),
    });
    input.defaultValue = data.member.name;
    showOk(`Renamed to ${data.member.name}.`);
    await load();
  } catch (err) {
    if (err.message !== 'forbidden') showError(err.message);
    input.value = input.defaultValue;
  }
}, true);

$('#memberRows').addEventListener('keydown', (e) => {
  if (e.target.classList.contains('js-name') && e.key === 'Enter') e.target.blur();
  if (e.target.classList.contains('js-name') && e.key === 'Escape') {
    e.target.value = e.target.defaultValue;
    e.target.blur();
  }
});

$('#mphone').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d\s+]/g, '');
});

load();
