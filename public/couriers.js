/** Courier partners: everyone with orders access can read; admins edit. */
import { $, esc, icon, renderIcons, initShell, pageFetch } from './ui/components.js';

// Requests belong to this page: cancelled, and never rendered, once it is left.
const fetch = pageFetch();

let isAdmin = false;

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const note = (msg, bad = true) => {
  $('#alerts').innerHTML = msg
    ? `<div class="alert"${bad ? '' : ' style="background:var(--success-soft);border-color:#ABEFC6;color:var(--text)"'}>${icon(bad ? 'circle-alert' : 'check')}<span>${esc(msg)}</span></div>`
    : '';
  renderIcons();
};

async function load() {
  const { couriers } = await api('/api/couriers');
  $('#cpMeta').textContent = `${couriers.filter((c) => c.active).length} active`;
  const row = (c) => `<tr data-id="${c.id ?? ''}">
    <td>${isAdmin ? `<input class="input" name="name" value="${esc(c.name || '')}" maxlength="60" placeholder="Courier name" aria-label="Name" />` : esc(c.name)}</td>
    <td>${isAdmin ? `<input class="input mono" name="template" value="${esc(c.tracking_url_template || '')}" placeholder="https://…{awb}" aria-label="Tracking link pattern" />`
      : c.tracking_url_template ? `<span class="mono">${esc(c.tracking_url_template)}</span>` : '<span class="muted">No link — pasted by hand</span>'}</td>
    <td>${c.id ? (isAdmin ? `<label class="soft" style="font-size:12.5px;display:inline-flex;gap:6px;align-items:center"><input type="checkbox" name="active"${c.active ? ' checked' : ''} />Active</label>`
      : (c.active ? 'Active' : '<span class="muted">Off</span>')) : ''}</td>
    <td>${!c.id || !c.tracking_url_template ? '<span class="muted">—</span>'
      : isAdmin ? `<label class="soft" style="font-size:12.5px;display:inline-flex;gap:6px;align-items:center" title="Tick only after opening a generated link for a real AWB and seeing the right parcel"><input type="checkbox" name="verified"${c.template_verified_at ? ' checked' : ''} />Verified</label>`
      : (c.template_verified_at ? 'Verified' : '<span class="muted">Unverified</span>')}
      ${c.template_verified_at ? `<div class="muted" style="font-size:11.5px">${esc(c.template_verified_by || '')}</div>` : ''}</td>
    <td class="r">${isAdmin ? `<button class="btn" type="button" data-save>${c.id ? 'Save' : 'Add'}</button>` : ''}</td>
  </tr>`;
  $('#cpRows').innerHTML = couriers.map(row).join('') + (isAdmin ? row({ name: '', tracking_url_template: '' }) : '');
}

$('#cpRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const body = {
    name: tr.querySelector('[name=name]').value,
    template: tr.querySelector('[name=template]').value,
  };
  const active = tr.querySelector('[name=active]');
  if (active) body.active = active.checked;
  const verified = tr.querySelector('[name=verified]');
  if (verified) body.verified = verified.checked;
  btn.disabled = true;
  try {
    if (tr.dataset.id) await api(`/api/couriers/${tr.dataset.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    else await api('/api/couriers', { method: 'POST', body: JSON.stringify(body) });
    note(`${body.name.trim()} saved.`, false);
    await load();
  } catch (err) {
    note(err.message);
    btn.disabled = false;
  }
});

(async () => {
  try {
    const me = await api('/auth/me');
    isAdmin = Boolean(me.isAdmin);
    initShell(me);
    await load();
  } catch (err) { note(err.message); }
})();
