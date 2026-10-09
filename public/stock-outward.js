/**
 * Stock Outward (Inventory): non-sales stock movements. Reading needs inventory.view; creating, issuing and
 * recording returns need inventory.move — the API checks both, the page only hides what you cannot do.
 * A draft takes no stock; Issue takes the chosen batches through the stock ledger; what comes back is recorded
 * by kind, and only units confirmed saleable go back into stock.
 */
import { $, $$, esc, count, money, icon, renderIcons, initShell, pageFetch, hasCap } from './ui/components.js';
import { istDateTime, formatDayKey } from './ui/ist.js';

const fetch = pageFetch();
const state = { meta: null, me: null, list: [], open: null, tab: 'list' };
const canMove = () => hasCap(state.me, 'inventory.move');
const day = (d) => (d ? formatDayKey(d) : '—');
const STATUS = { draft: ['Draft', ''], issued: ['Issued', 'warn'], partially_returned: ['Partially returned', 'warn'], closed: ['Closed', 'ok'], cancelled: ['Cancelled', ''] };
const statusTag = (s) => `<span class="tag ${STATUS[s]?.[1] || ''}">${esc(STATUS[s]?.[0] || s)}</span>`;
const rid = () => crypto.randomUUID();

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const note = (msg, ok = false) => {
  $('#alerts').innerHTML = msg ? `<div class="alert${ok ? ' ok' : ''}">${icon(ok ? 'circle-check' : 'circle-alert')}<span>${esc(msg)}</span></div>` : '';
  renderIcons();
};
const saved = (msg, failed = false) => { $('#dSaved').className = `saved${failed ? ' failed' : ''}`; $('#dSaved').textContent = msg || ''; };
const opt = (v, label, sel = false) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const skuLabel = (k) => `${k.sku} — ${[k.product_name, k.variant_name].filter(Boolean).join(' ')}`;
const used = (o) => o.consumed + o.returned_non_saleable + o.retained;

/* ------------------------------------------------------------------ list */

function filters() {
  return { q: $('#fQ').value, from: $('#fFrom').value, to: $('#fTo').value, purpose: $('#fPurpose').value,
    sku_id: $('#fSku').value, employee: $('#fEmployee').value, status: $('#fStatus').value };
}
async function load() {
  const qs = new URLSearchParams(Object.entries(filters()).filter(([, v]) => v));
  const { outwards } = await api(`/api/inventory/outward?${qs}`);
  state.list = outwards;
  $('#rows').innerHTML = outwards.length ? outwards.map((o) => `<tr data-id="${o.id}" tabindex="0">
      <td class="mono">${esc(o.reference)}${o.request_reference ? `<span class="cell-sub muted">${esc(o.request_reference)}</span>` : ''}</td>
      <td>${esc(day(o.movement_date))}</td>
      <td>${esc(o.purpose_label)}${o.campaign ? `<span class="cell-sub muted">${esc(o.campaign)}</span>` : ''}</td>
      <td><span class="mono">${esc(o.sku)}</span><span class="cell-sub muted">${esc(o.product_name)}</span></td>
      <td class="r num">${count(o.quantity)}</td>
      <td class="r num">${o.status === 'draft' || o.status === 'cancelled' ? '—' : count(o.returned_saleable)}</td>
      <td class="r num">${o.status === 'draft' || o.status === 'cancelled' ? '—' : count(used(o))}</td>
      <td class="r num">${o.status === 'draft' || o.status === 'cancelled' ? '—' : `<b>${count(o.outstanding)}</b>`}</td>
      <td>${esc(o.requested_by_name)}</td><td>${esc(o.issued_by_name)}</td>
      <td>${esc(o.recipient_name)}${o.recipient_org ? `<span class="cell-sub muted">${esc(o.recipient_org)}</span>` : ''}</td>
      <td>${statusTag(o.status)}</td></tr>`).join('')
    : '<tr><td colspan="12" class="muted">No stock outward matches these filters.</td></tr>';
}

/* ------------------------------------------------------------------ drawer */

function openDrawer(title, sub) {
  $('#dTitle').textContent = title; $('#dSub').textContent = sub || '';
  saved('');
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#drawerScrim').hidden = true; state.open = null; }

/** New stock outward, or a draft's edit: every field. People come from the team list; the server takes names from it. */
function formHtml(o = {}) {
  const m = state.meta;
  const people = (sel) => `<option value="">Choose a team member</option>${m.people.map((p) => opt(p.phone, p.name, p.phone === sel)).join('')}`;
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return `<form id="soForm" novalidate><section class="dsec"><div class="form-grid">
    <label class="fld"><span>Movement date</span><input class="input" type="date" name="movement_date" required value="${esc(o.movement_date || todayKey)}" /></label>
    <label class="fld"><span>Purpose</span><select class="select" name="purpose" required><option value="">Choose</option>${m.purposes.map((p) => opt(p.key, p.label, p.key === o.purpose)).join('')}</select></label>
    <label class="fld wide"><span>Product</span><select class="select" name="sku_id" required><option value="">Choose a product</option>${m.skus.map((k) => opt(k.id, `${skuLabel(k)} · ${count(k.available)} available`, k.id === o.sku_id)).join('')}</select>
      <span class="help" id="soAvail"></span></label>
    <label class="fld"><span>Quantity</span><input class="input" name="quantity" inputmode="numeric" required value="${esc(o.quantity ?? '')}" /></label>
    <div class="fld"><label class="fld-lbl" for="soReqBy"><span>Requested by</span></label>
      <select class="select" id="soReqBy" name="requested_by" required>${people(o.requested_by_phone)}${opt('other', 'Other', Boolean(o.id && !o.requested_by_phone))}</select>
      <label class="so-other" id="soOtherWrap"${o.id && !o.requested_by_phone ? '' : ' hidden'}><span>Enter Requester's Name</span>
        <input class="input" name="requested_by_name" placeholder="Enter full name" maxlength="60" autocomplete="off" value="${esc(o.id && !o.requested_by_phone ? o.requested_by_name : '')}" /></label>
      <span class="err" id="soOtherErr" role="alert"></span></div>
    <label class="fld"><span>Issued by</span><select class="select" name="issued_by" required>${people(o.issued_by_phone)}</select>
      <span class="help">The person who physically hands the stock over.</span></label>
    <label class="fld"><span>Recipient / point of contact</span><input class="input" name="recipient_name" required maxlength="160" value="${esc(o.recipient_name || '')}" /></label>
    <label class="fld"><span>Organisation (company, retailer, agency)</span><input class="input" name="recipient_org" maxlength="160" value="${esc(o.recipient_org || '')}" /></label>
    <label class="fld"><span>Department / team</span><input class="input" name="department" maxlength="120" value="${esc(o.department || '')}" /></label>
    <label class="fld"><span>Event or campaign</span><input class="input" name="campaign" maxlength="160" value="${esc(o.campaign || '')}" /></label>
    <label class="fld"><span>Reference / request number</span><input class="input mono" name="request_reference" maxlength="80" value="${esc(o.request_reference || '')}" /></label>
    <label class="fld"><span>Expected return date</span><input class="input" type="date" name="expected_return_date" value="${esc(o.expected_return_date || '')}" /></label>
    <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000">${esc(o.notes || '')}</textarea></label>
  </div><p class="imp-note">Saving creates a draft. No stock moves until it is issued.</p></section></form>`;
}
/**
 * The form as sent: the typed requester name only with "Other" (a team member never carries a stale typed name).
 * Returns null, with the message beside the field, when "Other" has no name — the server checks the same.
 */
const formValues = () => {
  const v = Object.fromEntries(new FormData($('#soForm')));
  if (v.requested_by !== 'other') { delete v.requested_by_name; return v; }
  v.requested_by_name = String(v.requested_by_name || '').replace(/\s+/g, ' ').trim();
  if (!v.requested_by_name) {
    $('#soOtherErr').textContent = 'Enter the requester\'s name.';
    $('#soForm [name=requested_by_name]').focus();
    return null;
  }
  return v;
};
/** "Other" shows the name box right under Requested by; choosing a team member hides and clears it. */
function wireRequester() {
  const sel = $('#soReqBy');
  if (!sel) return;
  const sync = () => {
    const other = sel.value === 'other';
    const input = $('#soForm [name=requested_by_name]');
    $('#soOtherWrap').hidden = !other;
    input.required = other;
    if (!other) input.value = '';
    $('#soOtherErr').textContent = '';
  };
  sel.addEventListener('change', sync);
  $('#soForm [name=requested_by_name]').addEventListener('input', () => { $('#soOtherErr').textContent = ''; });
  const input = $('#soForm [name=requested_by_name]');
  input.required = sel.value === 'other';
}

function showAvailable() {
  const sel = $('#soForm [name=sku_id]');
  const k = state.meta.skus.find((x) => String(x.id) === sel?.value);
  if ($('#soAvail')) $('#soAvail').textContent = k ? `${count(k.available)} available to issue now.` : '';
}

function openNew() {
  openDrawer('New stock outward', 'A draft first; stock moves only when you issue it.');
  $('#dBody').innerHTML = formHtml();
  $('#dActions').innerHTML = '<button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="button" data-act="create">Save draft</button>';
  $('#soForm [name=sku_id]').addEventListener('change', showAvailable);
  wireRequester();
  renderIcons();
}

async function openOutward(id) {
  const { outward: o } = await api(`/api/inventory/outward/${id}`);
  state.open = o;
  openDrawer(`${o.reference} · ${o.purpose_label}`, `${o.sku} — ${o.product_name}`);
  const facts = [
    ['Status', statusTag(o.status)], ['Movement date', esc(day(o.movement_date))], ['Quantity', count(o.quantity)],
    ['Requested by', `${esc(o.requested_by_name)}${o.requested_by_external ? ' <span class="muted">(not a team member)</span>' : ''}`], ['Issued by', esc(o.issued_by_name)],
    ['Recipient / POC', esc(o.recipient_name)], ['Organisation', esc(o.recipient_org || '—')], ['Department', esc(o.department || '—')],
    ['Event / campaign', esc(o.campaign || '—')], ['Reference', esc(o.request_reference || '—')], ['Expected back', esc(day(o.expected_return_date))],
    ['Cost at CP', o.cost_value === null ? (o.status === 'draft' ? '—' : 'Unknown (a batch has no CP)') : esc(money(o.cost_value))],
  ];
  const issued = !['draft', 'cancelled'].includes(o.status);
  let body = `<section class="dsec"><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${o.notes ? `<p class="muted" style="margin:8px 0 0">${esc(o.notes)}</p>` : ''}</section>`;
  if (issued) {
    body += `<section class="dsec"><h3 class="dsec-title">Reconciliation</h3><div class="imp-stats">
      ${['Issued', 'Returned saleable', 'Returned non-saleable', 'Consumed', 'Kept by recipient', 'Outstanding'].map((l, i) => `<div class="imp-stat"><b>${count([o.quantity, o.returned_saleable, o.returned_non_saleable, o.consumed, o.retained, o.outstanding][i])}</b><span>${l}</span></div>`).join('')}
      </div>
      <table class="table" style="margin-top:10px"><thead><tr><th>Batch</th><th class="r">Issued</th><th class="r">Back in stock</th><th class="r">CP</th></tr></thead><tbody>
      ${o.batches.map((b) => `<tr><td class="mono">${esc(b.batch_number)}<span class="cell-sub muted">${esc(b.warehouse_name)}${b.expiry_date ? ` · exp ${esc(day(b.expiry_date))}` : ''}</span></td>
        <td class="r num">${count(b.quantity)}</td><td class="r num">${count(b.restocked)}</td><td class="r">${b.unit_cost === null ? '—' : esc(money(b.unit_cost))}</td></tr>`).join('')}
      </tbody></table></section>`;
  }
  if (o.status === 'draft' && canMove()) {
    const st = await api(`/api/inventory/outward/stock/${o.sku_id}?quantity=${o.quantity}`);
    const pre = new Map(st.suggestion.map((s) => [s.batch_id, s.quantity]));
    body += `<section class="dsec"><h3 class="dsec-title">Issue stock <span class="dsec-meta soft">${count(st.available)} available · ${count(o.quantity)} needed</span></h3>
      ${st.batches.length ? `<p class="muted" style="margin:0 0 8px">Choose the batches (earliest expiry suggested). They must add up to ${count(o.quantity)}.</p>
      <div class="so-alloc">${st.batches.map((b) => `<label class="fld"><span><span class="mono">${esc(b.batch_number)}</span> · ${esc(b.warehouse_name)}${b.expiry_date ? ` · exp ${esc(day(b.expiry_date))}` : ''} · ${count(b.available)} free</span>
        <input class="input" inputmode="numeric" data-alloc="${b.id}" value="${pre.get(b.id) || ''}" /></label>`).join('')}</div>`
        : '<p class="warn-text" style="margin:0">No sellable stock of this product to issue.</p>'}
      ${st.available < o.quantity ? `<p class="warn-text">Only ${count(st.available)} available — reduce the quantity or receive stock first.</p>` : ''}
    </section>
    <section class="dsec"><h3 class="dsec-title">Edit draft</h3>${formHtml(o)}</section>`;
  }
  if (['issued', 'partially_returned'].includes(o.status) && canMove()) {
    const multi = o.batches.length > 1;
    body += `<section class="dsec"><h3 class="dsec-title">Record what came back or was used <span class="dsec-meta soft">${count(o.outstanding)} outstanding</span></h3>
      <div class="form-grid" id="retForm">
        ${multi ? o.batches.map((b) => `<label class="fld"><span>Returned saleable to batch <span class="mono">${esc(b.batch_number)}</span></span><input class="input" inputmode="numeric" data-ret-batch="${b.batch_id}" /></label>`).join('')
          : '<label class="fld"><span>Returned — saleable</span><input class="input" inputmode="numeric" name="returned_saleable" /></label>'}
        <label class="fld"><span>Returned — damaged / non-saleable</span><input class="input" inputmode="numeric" name="returned_non_saleable" />
          <span class="help">Recorded only; it does not go back into stock.</span></label>
        <label class="fld"><span>Consumed / used</span><input class="input" inputmode="numeric" name="consumed" /></label>
        <label class="fld"><span>Kept by the recipient</span><input class="input" inputmode="numeric" name="retained" /></label>
        <label class="fld wide"><span class="check"><input type="checkbox" id="retVerified" /> The saleable units were inspected and are fit to sell again</span>
          <span class="help">Only these go back into stock.</span></label>
        <label class="fld wide"><span>Notes</span><input class="input" name="ret_notes" maxlength="1000" /></label>
      </div></section>`;
  }
  body += `<section class="dsec"><h3 class="dsec-title">History</h3><ul class="so-history">${o.events.map((e) => `<li>
      <b>${esc({ created: 'Draft created', edited: 'Edited', issued: 'Issued', returned: 'Recorded', closed: 'Closed', cancelled: 'Cancelled' }[e.event_type] || e.event_type)}</b>
      <span class="muted">${esc(istDateTime(e.at))} · ${esc(e.actor || '—')}</span>
      ${e.event_type === 'issued' && e.batches ? `<div class="muted">${e.batches.map((b) => `${count(b.quantity)} from ${esc(b.batch_number)}`).join(', ')}</div>` : ''}
      ${e.event_type === 'returned' ? `<div class="muted">${[e.returned_saleable && `${count(e.returned_saleable)} saleable back in stock`, e.returned_non_saleable && `${count(e.returned_non_saleable)} damaged / non-saleable (not restocked)`,
        e.consumed && `${count(e.consumed)} consumed`, e.retained && `${count(e.retained)} kept`].filter(Boolean).join(' · ')}</div>` : ''}
      ${e.event_type === 'edited' ? `<div class="muted">${Object.keys(e.metadata?.changes || {}).map(esc).join(', ')}</div>` : ''}
      ${e.notes ? `<div class="muted">${esc(e.notes)}</div>` : ''}</li>`).join('')}</ul></section>`;
  $('#dBody').innerHTML = body;
  const acts = [];
  if (o.status === 'draft' && canMove()) acts.push('<button class="btn" type="button" data-act="cancel-draft">Cancel draft</button>', '<button class="btn" type="button" data-act="save-draft">Save changes</button>', '<button class="btn primary" type="button" data-act="issue">Issue stock</button>');
  if (['issued', 'partially_returned'].includes(o.status) && canMove()) acts.push('<button class="btn" type="button" data-act="close-out">Close</button>', '<button class="btn primary" type="button" data-act="record">Record</button>');
  $('#dActions').innerHTML = acts.join('');
  if ($('#soForm [name=sku_id]')) $('#soForm [name=sku_id]').addEventListener('change', showAvailable);
  wireRequester();
  renderIcons();
}

async function act(name, btn) {
  const o = state.open;
  btn.disabled = true;
  try {
    if (name === 'close') return closeDrawer();
    if (name === 'create') {
      const v = formValues();
      if (!v) return;
      const r = await api('/api/inventory/outward', { method: 'POST', body: JSON.stringify(v) });
      await load();
      await openOutward(r.id);
      saved(`Draft ${r.reference} saved. Issue it when the stock is handed over.`);
    } else if (name === 'save-draft') {
      const v = formValues();
      if (!v) return;
      await api(`/api/inventory/outward/${o.id}`, { method: 'PATCH', body: JSON.stringify({ ...v, version: o.version }) });
      await load(); await openOutward(o.id); saved('Draft saved');
    } else if (name === 'cancel-draft') {
      if (!confirm('Cancel this draft? Nothing was issued, so no stock moves.')) return;
      await api(`/api/inventory/outward/${o.id}/cancel`, { method: 'POST', body: '{}' });
      await load(); await openOutward(o.id); saved('Draft cancelled');
    } else if (name === 'issue') {
      const allocations = $$('[data-alloc]').map((i) => ({ batch_id: i.dataset.alloc, quantity: i.value })).filter((a) => String(a.quantity).trim());
      if (!confirm(`Issue ${count(o.quantity)} × ${o.sku} to ${o.recipient_name}? This takes the stock out of inventory.`)) return;
      await api(`/api/inventory/outward/${o.id}/issue`, { method: 'POST', body: JSON.stringify({ allocations, request_id: state.issueKey || (state.issueKey = rid()) }) });
      state.issueKey = null;
      await load(); await openOutward(o.id); saved('Issued — stock taken out of inventory');
    } else if (name === 'record') {
      const f = $('#retForm');
      const val = (n) => f.querySelector(`[name=${n}]`)?.value || '';
      const batches = $$('[data-ret-batch]', f).map((i) => ({ batch_id: i.dataset.retBatch, quantity: i.value })).filter((a) => String(a.quantity).trim());
      const body = { returned_saleable: batches.length || !f.querySelector('[name=returned_saleable]') ? batches : val('returned_saleable'),
        returned_non_saleable: val('returned_non_saleable'), consumed: val('consumed'), retained: val('retained'), notes: val('ret_notes'),
        saleable_verified: $('#retVerified').checked, request_id: state.returnKey || (state.returnKey = rid()) };
      const r = await api(`/api/inventory/outward/${o.id}/return`, { method: 'POST', body: JSON.stringify(body) });
      state.returnKey = null;
      await load(); await openOutward(o.id); saved(r.status === 'closed' ? 'Recorded — every unit accounted for; closed' : `Recorded — ${count(r.outstanding)} still outstanding`);
    } else if (name === 'close-out') {
      await api(`/api/inventory/outward/${o.id}/close`, { method: 'POST', body: '{}' });
      await load(); await openOutward(o.id); saved('Closed');
    }
  } catch (err) {
    saved(err.message, true);
    if (err.data?.field === 'requested_by_name' && $('#soOtherErr')) $('#soOtherErr').textContent = err.message;
  } finally { btn.disabled = false; }
}

/* ------------------------------------------------------------------ reports */

async function loadReport() {
  const qs = new URLSearchParams(Object.entries({ from: $('#rFrom').value, to: $('#rTo').value }).filter(([, v]) => v));
  const r = await api(`/api/inventory/outward/report?${qs}`);
  const t = r.totals || {};
  const table = (title, rows, key, label) => `<section class="card so-rep"><header class="card-head"><h2 class="card-title">${esc(title)}</h2></header><div class="table-wrap"><table class="table">
    <thead><tr><th>${esc(label)}</th><th class="r">Issued</th><th class="r">Returned saleable</th><th class="r">Non-saleable</th><th class="r">Consumed</th><th class="r">Kept</th><th class="r">Outstanding</th></tr></thead>
    <tbody>${rows.length ? rows.map((x) => `<tr><td>${esc(key(x))}</td><td class="r num">${count(x.issued)}</td><td class="r num">${count(x.returned_saleable)}</td><td class="r num">${count(x.returned_non_saleable)}</td>
      <td class="r num">${count(x.consumed)}</td><td class="r num">${count(x.retained)}</td><td class="r num">${count(x.outstanding)}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">Nothing issued in this period.</td></tr>'}</tbody></table></div></section>`;
  $('#report').innerHTML = `<div class="imp-stats so-totals">
      <div class="imp-stat"><b>${count(t.issued || 0)}</b><span>Units issued</span></div><div class="imp-stat"><b>${count(t.returned_saleable || 0)}</b><span>Back in stock</span></div>
      <div class="imp-stat"><b>${count(t.returned_non_saleable || 0)}</b><span>Returned non-saleable</span></div><div class="imp-stat"><b>${count(t.consumed || 0)}</b><span>Consumed</span></div>
      <div class="imp-stat"><b>${count(t.retained || 0)}</b><span>Kept by recipients</span></div><div class="imp-stat"><b>${count(t.outstanding || 0)}</b><span>Outstanding</span></div>
      <div class="imp-stat"><b>${esc(money(r.cost.issuedValue))}</b><span>Issued at CP</span></div><div class="imp-stat"><b>${esc(money(r.cost.netValue))}</b><span>Net cost (less restocked)</span></div>
    </div>
    ${r.cost.unitsWithoutCost ? `<p class="warn-text">${count(r.cost.unitsWithoutCost)} issued unit(s) came from batches with no CP, so the cost above leaves them out.</p>` : ''}
    <p class="muted" style="font-size:12px">Cost uses each batch's Cost Price (CP) at the time of issue; Selling Price and MRP are never used.</p>
    ${table('By purpose', r.byPurpose, (x) => x.purpose_label, 'Purpose')}
    ${table('By product', r.byProduct, (x) => `${x.sku} — ${x.product_name}`, 'Product')}
    ${table('By requester', r.byRequester, (x) => `${x.name}${x.external ? ' (not a team member)' : ''}`, 'Requested by')}
    ${table('By issuer', r.byIssuer, (x) => x.name, 'Issued by')}
    ${table('By recipient / organisation', r.byRecipient, (x) => x.recipient, 'Recipient')}
    <section class="card so-rep"><header class="card-head"><h2 class="card-title">Outstanding — expected back</h2></header><div class="table-wrap"><table class="table">
      <thead><tr><th>Reference</th><th>Product</th><th>Recipient</th><th>Issued on</th><th>Expected back</th><th class="r">Outstanding</th></tr></thead>
      <tbody>${r.outstanding.length ? r.outstanding.map((x) => `<tr data-id="${x.id}" tabindex="0"><td class="mono">${esc(x.reference)}</td><td>${esc(x.sku)}</td><td>${esc(x.recipient)}</td>
        <td>${esc(day(x.movement_date))}</td><td>${esc(day(x.expected_return_date))}</td><td class="r num">${count(x.outstanding)}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Nothing outstanding.</td></tr>'}</tbody></table></div></section>`;
}

/* ------------------------------------------------------------------ wiring */

function setTab(tab) {
  state.tab = tab;
  for (const b of $$('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#listView').hidden = tab !== 'list'; $('#reportView').hidden = tab !== 'report';
  (tab === 'list' ? load() : loadReport()).catch((err) => note(err.message));
}

(async () => {
  try {
    const me = await api('/auth/me');
    state.me = me;
    initShell(me);
    state.meta = await api('/api/inventory/outward/meta');
    const m = state.meta;
    $('#fPurpose').innerHTML += m.purposes.map((p) => opt(p.key, p.label)).join('');
    $('#fSku').innerHTML += m.skus.map((k) => opt(k.id, skuLabel(k))).join('');
    $('#fEmployee').innerHTML += m.people.map((p) => opt(p.phone, p.name)).join('');
    $('#fStatus').innerHTML += [['outstanding', 'Outstanding (issued, not closed)'], ...m.statuses.map((s) => [s, STATUS[s]?.[0] || s])].map(([v, l]) => opt(v, l)).join('');
    $('#newOut').hidden = !canMove();
    $('#newOut').addEventListener('click', openNew);
    for (const id of ['fFrom', 'fTo', 'fPurpose', 'fSku', 'fEmployee', 'fStatus']) $(`#${id}`).addEventListener('change', () => load().catch((err) => note(err.message)));
    let t; $('#fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch((err) => note(err.message)), 250); });
    for (const id of ['rFrom', 'rTo']) $(`#${id}`).addEventListener('change', () => loadReport().catch((err) => note(err.message)));
    for (const b of $$('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
    const openRow = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openOutward(Number(tr.dataset.id)).catch((err) => note(err.message)); };
    for (const host of [$('#rows'), $('#report')]) {
      host.addEventListener('click', openRow);
      host.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
    }
    $('#dActions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act, b); });
    $('#dClose').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    await load();
  } catch (err) { note(err.message); }
})();
