'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let bootstrapAdmins = [];

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

async function load() {
  try {
    const data = await api('/api/members');
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
          <span class="cust-name">${esc(m.name)}</span>
          ${locked ? '<div class="muted" title="Set in ADMIN_PHONES — cannot be changed here">env admin</div>' : ''}
        </td>
        <td>+${esc(m.phone)}</td>
        <td>
          ${m.is_admin ? '<span class="chip">Admin</span>' : '<span class="muted">Caller</span>'}
          ${m.active ? '' : '<div class="muted">deactivated</div>'}
        </td>
        <td class="muted">${when(m.last_login)}</td>
        <td class="muted">${when(m.added_at)}${m.added_by ? `<div>by ${esc(m.added_by)}</div>` : ''}</td>
        <td class="actions">
          ${locked ? '<span class="muted">—</span>' : `
            <button data-act="admin" data-phone="${esc(m.phone)}" data-to="${m.is_admin ? 'false' : 'true'}"
              ${lastAdmin ? 'disabled title="The last admin cannot be demoted"' : ''}>
              ${m.is_admin ? 'Make caller' : 'Make admin'}
            </button>
            <button data-act="active" data-phone="${esc(m.phone)}" data-to="${m.active ? 'false' : 'true'}"
              ${lastAdmin ? 'disabled title="The last admin cannot be deactivated"' : ''}>
              ${m.active ? 'Deactivate' : 'Reactivate'}
            </button>
            <button data-act="remove" data-phone="${esc(m.phone)}" class="danger"
              ${lastAdmin ? 'disabled title="The last admin cannot be removed"' : ''}>Remove</button>
          `}
        </td>
      </tr>`;
  }).join('');
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
      }),
    });
    showOk(`${data.member.name} can now sign in with +${data.member.phone}.`);
    $('#addForm').reset();
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

$('#mphone').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d\s+]/g, '');
});

load();
