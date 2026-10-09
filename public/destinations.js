/** Dispatch destinations: everyone with orders access can read; admins edit. */
import { $, $$, esc, icon, renderIcons, initShell, pageFetch } from './ui/components.js';

// Requests belong to this page: cancelled, and never rendered, once it is left.
const fetch = pageFetch();

let isAdmin = false;
let data = { destinations: [], channels: [], dispatchTypes: [], platforms: [] };
let tab = '';

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};
const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
const note = (msg, bad = true) => {
  $('#alerts').innerHTML = msg
    ? `<div class="alert"${bad ? '' : ' style="background:var(--success-soft);border-color:#ABEFC6;color:var(--text)"'}>${icon(bad ? 'circle-alert' : 'check')}<span>${esc(msg)}</span></div>`
    : '';
  renderIcons();
};

// Easy Ship has no destinations, so it has no tab here.
const types = () => data.dispatchTypes.filter((t) => t.key !== 'easy_ship');
const channelsFor = (type) => data.channels.filter((c) => c.active && (!c.dispatch_types?.length || c.dispatch_types.includes(type)));

function render() {
  if (!tab) tab = types()[0]?.key || '';
  $('#typeTabs').innerHTML = types().map((t) => {
    const n = data.destinations.filter((d) => d.dispatch_type === t.key && d.active).length;
    return `<button type="button" role="tab" class="tab${t.key === tab ? ' active' : ''}" data-type="${esc(t.key)}"
      aria-selected="${t.key === tab}">${esc(t.label)}<span class="tab-count">${n}</span></button>`;
  }).join('');

  const groups = channelsFor(tab).map((c) => ({ c, list: data.destinations.filter((d) => d.dispatch_type === tab && d.channel === c.key) }))
    .filter((g) => g.list.length || isAdmin);
  $('#destGroups').innerHTML = groups.map(({ c, list }) => `
    <div class="dest-group">
      <div class="dest-h">${esc(c.label)} <span class="soft">${list.filter((d) => d.active).length} active</span></div>
      ${list.length ? `<ul class="dest-list">${list.map((d) => `
        <li class="dest${d.active ? '' : ' off'}" data-id="${d.id}">
          ${isAdmin ? `<input class="input plain" name="name" value="${esc(d.name)}" maxlength="160" aria-label="Destination name" />
            ${d.dispatch_type === 'retailer' ? `<select class="select dest-pf" name="sku_platform" aria-label="Product-code list for ${esc(d.name)}" title="The retailer's own product codes and names: saved matches to Briyo SKUs are reused on its next orders">
              <option value="">No product-code list</option>${data.platforms.map((p) => opt(p.key, `Codes: ${p.label}`, p.key === d.sku_platform)).join('')}</select>` : ''}
            <label class="soft dest-on"><input type="checkbox" name="active"${d.active ? ' checked' : ''} />Active</label>
            <button class="btn" type="button" data-save>Save</button>`
            : `<span>${esc(d.name)}</span>${d.sku_platform ? `<span class="muted">Codes: ${esc(data.platforms.find((p) => p.key === d.sku_platform)?.label || d.sku_platform)}</span>` : ''}${d.active ? '' : '<span class="muted">Off</span>'}`}
        </li>`).join('')}</ul>` : '<p class="muted dest-none">None yet.</p>'}
    </div>`).join('') || '<div class="empty-note">No destinations for this type yet.</div>';

  if (isAdmin) {
    $('#destAdd').hidden = false;
    $('#aType').innerHTML = types().map((t) => opt(t.key, t.label, t.key === tab)).join('');
    $('#aChannel').innerHTML = channelsFor(tab).map((c) => opt(c.key, c.label)).join('');
  }
  renderIcons();
}

async function load() {
  data = await api('/api/destinations');
  render();
}

$('#typeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (b) { tab = b.dataset.type; render(); }
});
$('#aType').addEventListener('change', (e) => {
  $('#aChannel').innerHTML = channelsFor(e.target.value).map((c) => opt(c.key, c.label)).join('');
});
$('#aSave').addEventListener('click', async () => {
  const body = { dispatch_type: $('#aType').value, channel: $('#aChannel').value, name: $('#aName').value };
  try {
    await api('/api/destinations', { method: 'POST', body: JSON.stringify(body) });
    note(`${body.name.trim()} added.`, false);
    $('#aName').value = '';
    tab = body.dispatch_type;
    await load();
  } catch (err) { note(err.message); }
});
$('#destGroups').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const li = btn.closest('[data-id]');
  const body = { name: li.querySelector('[name=name]').value, active: li.querySelector('[name=active]').checked };
  const pf = li.querySelector('[name=sku_platform]');
  if (pf) body.sku_platform = pf.value;
  btn.disabled = true;
  try {
    await api(`/api/destinations/${li.dataset.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    note(`${body.name.trim()} saved.`, false);
    await load();
  } catch (err) { note(err.message); btn.disabled = false; }
});

(async () => {
  try {
    const me = await api('/auth/me');
    // "isAdmin" here means may change this list: Logistics managers and admins.
    isAdmin = Boolean(me.caps?.includes('logistics.setup'));
    initShell(me);
    await load();
  } catch (err) { note(err.message); }
})();
