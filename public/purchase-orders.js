/**
 * Inventory → Purchase orders (lib/purchase-orders.js). The list shows ordered vs received vs pending per PO; the
 * drawer raises or edits a PO, receives each delivery against a line straight into stock (damaged packs recorded, not
 * stocked, with what was wrong), takes the COA once QC clears, and prints the PO. "Received" is every delivery by
 * product and manufacturer, with an Excel (CSV) export. Inventory members read; Inventory operators write.
 */
import { $, $$, esc, count, icon, renderIcons, initShell, pageFetch, hasCap } from './ui/components.js';
import { istDateTime, formatDayKey } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, meta: null, list: [], open: null, form: null, receiving: null, tab: 'list', busy: false };
const canWrite = () => hasCap(state.me, 'inventory.move');
const canCompany = () => hasCap(state.me, 'inventory.catalog');
const day = (d) => (d ? formatDayKey(d) : '—');
const rid = () => crypto.randomUUID();
const STATE = {
  open: ['Nothing received', ''], partly_received: ['Partly received', 'warn'], received: ['Fully received', 'ok'], over_received: ['Over-received', 'warn'],
  closed_short: ['Closed short', 'warn'], closed: ['Closed', ''], cancelled: ['Cancelled', ''], pending: ['Pending', ''],
};
const tag = (s) => `<span class="tag ${STATE[s]?.[1] || ''}">${esc(STATE[s]?.[0] || s)}</span>`;
const inr = (n) => (n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);
const opt = (v, label, sel = false) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const skuLabel = (k) => `${k.sku} — ${[k.product_name, k.variant_name].filter(Boolean).join(' ')}`;

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.headers || (opts.body ? { 'Content-Type': 'application/json' } : undefined) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const note = (msg, ok = false) => {
  $('#alerts').innerHTML = msg ? `<div class="alert${ok ? ' ok' : ''}">${icon(ok ? 'circle-check' : 'circle-alert')}<span>${esc(msg)}</span></div>` : '';
  renderIcons();
};
const saved = (msg, failed = false) => { $('#dSaved').className = `saved${failed ? ' failed' : ''}`; $('#dSaved').textContent = msg || ''; };

/* ------------------------------------------------------------------ list */

async function load() {
  const u = new URLSearchParams();
  for (const [k, id] of [['q', 'fQ'], ['status', 'fStatus'], ['supplier', 'fSupplier']]) if ($(`#${id}`).value) u.set(k, $(`#${id}`).value);
  state.list = (await api(`/api/inventory/purchase-orders?${u}`)).orders;
  $('#rows').innerHTML = state.list.length ? state.list.map((p) => `<tr data-id="${p.id}" tabindex="0" style="cursor:pointer">
      <td class="mono"><b>${esc(p.po_number)}</b></td><td>${esc(day(p.po_date))}</td>
      <td>${esc(p.supplier_name)}${p.manufacturer_unit ? `<div class="soft" style="font-size:12px">${esc(p.manufacturer_unit)}</div>` : ''}</td>
      <td class="mono" style="white-space:normal;max-width:220px">${esc(p.products.join(', '))}</td>
      <td class="r num">${count(p.ordered_qty)}</td><td class="r num">${count(p.received_qty)}</td><td class="r num">${p.pending_qty ? `<b>${count(p.pending_qty)}</b>` : '—'}</td>
      <td class="r num">${p.short_qty ? `<span class="warn-text">−${count(p.short_qty)}</span>` : ''}${p.excess_qty ? ` <span class="warn-text">+${count(p.excess_qty)}</span>` : ''}${!p.short_qty && !p.excess_qty ? '—' : ''}</td>
      <td>${tag(p.state)}</td></tr>`).join('')
    : `<tr><td colspan="9"><div class="empty-note"><b>No purchase orders${$('#fQ').value || $('#fStatus').value || $('#fSupplier').value ? ' match the filters' : ' yet'}.</b>${canWrite() ? 'Raise one with New purchase order.' : ''}</div></td></tr>`;
  renderIcons();
}

async function loadReceived() {
  const u = new URLSearchParams();
  for (const [k, id] of [['supplier', 'rSupplier'], ['sku', 'rSku'], ['from', 'rFrom'], ['to', 'rTo']]) if ($(`#${id}`).value) u.set(k, $(`#${id}`).value);
  $('#rCsv').href = `/api/inventory/purchase-orders/received?format=csv&${u}`;
  const rows = (await api(`/api/inventory/purchase-orders/received?${u}`)).receipts;
  $('#recRows').innerHTML = rows.length ? rows.map((r) => `<tr><td>${esc(day(r.received_date))}</td><td class="mono"><a href="#" data-open-po="${r.po_id}">${esc(r.po_number)}</a></td>
      <td>${esc(r.supplier_name)}${r.manufacturer_unit ? `<div class="soft" style="font-size:12px">${esc(r.manufacturer_unit)}</div>` : ''}</td>
      <td><b class="mono">${esc(r.sku)}</b><div class="soft" style="font-size:12px">${esc(r.product_name)}</div></td><td>Pack of ${count(r.pack_size)} · ${esc(r.pack_type)}</td>
      <td class="r num">${count(r.ordered_qty)}</td><td class="r num">${count(r.received_qty)}</td><td class="r num">${r.damaged_qty ? `<span class="warn-text">${count(r.damaged_qty)}</span>` : '—'}</td>
      <td class="mono">${esc(r.batch_number)}</td><td>${esc(day(r.mfg_date))} / ${esc(day(r.expiry_date))}</td><td class="r num">${esc(inr(r.mrp))}</td>
      <td>${r.coa ? '<span class="tag ok">COA</span>' : '<span class="tag warn">Pending</span>'}</td>
      <td style="white-space:normal;min-width:180px">${(r.discrepancies || []).map((d) => `<span class="tag warn">${esc(state.meta.discrepancies[d] || d)}</span>`).join(' ')} ${esc(r.remarks || '')}</td></tr>`).join('')
    : '<tr><td colspan="13"><div class="empty-note"><b>Nothing received yet.</b>Deliveries recorded on a PO show here.</div></td></tr>';
}

function setTab(tab) {
  state.tab = tab;
  for (const b of $$('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#listView').hidden = tab !== 'list'; $('#receivedView').hidden = tab !== 'received';
  (tab === 'list' ? load() : loadReceived()).catch((err) => note(err.message));
}

/* ------------------------------------------------------------------ drawer */

function openDrawer() { $('#drawer').hidden = false; $('#drawerScrim').hidden = false; }
function closeDrawer() { $('#drawer').hidden = true; $('#drawerScrim').hidden = true; state.open = null; state.form = null; state.receiving = null; saved(''); }

function lineRow(l = {}) {
  const m = state.meta;
  return `<div class="po-line" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;align-items:end;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">
    <label class="fld" style="grid-column:1 / -1"><span>Product</span><div style="display:flex;gap:6px"><select class="select" data-k="sku_id" style="flex:1">${opt('', 'Choose product', !l.sku_id)}${m.skus.map((k) => opt(k.id, skuLabel(k), Number(l.sku_id) === k.id)).join('')}</select>
      <button type="button" class="icon-btn bare" data-remove-line title="Remove product" aria-label="Remove product">${icon('x')}</button></div></label>
    <label class="fld"><span>Pack size</span><input class="input" data-k="pack_size" inputmode="numeric" placeholder="60" value="${esc(l.pack_size ?? '')}" /></label>
    <label class="fld"><span>Holds</span><select class="select" data-k="unit_label">${m.unitLabels.map((u) => opt(u, u, (l.unit_label || 'Caps') === u)).join('')}</select></label>
    <label class="fld"><span>Pack type</span><select class="select" data-k="pack_type">${m.packTypes.map((t) => opt(t, t[0].toUpperCase() + t.slice(1), (l.pack_type || 'bottle') === t)).join('')}</select></label>
    <label class="fld"><span>Order qty (packs)</span><input class="input" data-k="ordered_qty" inputmode="numeric" value="${esc(l.ordered_qty ?? '')}" /></label>
    <label class="fld"><span>Unit price (₹)</span><input class="input" data-k="unit_price" inputmode="decimal" placeholder="per pack" value="${esc(l.unit_price ?? '')}" /></label>
    <label class="fld"><span>GST %</span><input class="input" data-k="gst_pct" inputmode="decimal" placeholder="5" value="${esc(l.gst_pct ?? '')}" /></label>
    <label class="fld"><span>MRP (₹)</span><input class="input" data-k="mrp" inputmode="decimal" value="${esc(l.mrp ?? '')}" /></label>
    <label class="fld" style="grid-column:1 / -1"><span class="soft">Description / remarks printed with the product (e.g. 150 ml opaque bottle)</span><input class="input" data-k="remarks" maxlength="500" value="${esc(l.remarks ?? '')}" /></label>
  </div>`;
}

function poForm(po = null, pre = {}) {
  const m = state.meta;
  state.form = { id: po?.id || null, version: po?.version, requestId: rid() };
  $('#dTitle').textContent = po ? `Edit ${po.po_number}` : 'New purchase order';
  $('#dSub').textContent = po ? 'Products can be changed only until something is received.' : 'One PO per manufacturer. Add every product on it.';
  const lines = po?.lines?.length ? po.lines : [{ sku_id: pre.sku || '', ordered_qty: pre.qty || '', pack_type: 'bottle' }];
  $('#dBody').innerHTML = `<form id="poForm" novalidate><section class="dsec"><div class="form-grid">
      <label class="fld"><span>PO number</span><input class="input mono" name="po_number" maxlength="40" value="${esc(po?.po_number || m.suggested)}" />
        <span class="help">BR + year + month letter + series (e.g. BR26N12). Suggested; change it if needed.</span></label>
      <label class="fld"><span>PO date</span><input class="input" type="date" name="po_date" value="${esc(po?.po_date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }))}" /></label>
      <label class="fld"><span>Manufacturer</span><select class="select" name="supplier_id">${opt('', 'Choose manufacturer', !po)}${m.suppliers.map((s) => opt(s.id, s.name, po?.supplier_id === s.id)).join('')}</select>
        <span class="help">Add a new one in Inventory → Warehouses &amp; suppliers.</span></label>
      <label class="fld"><span>Manufacturing unit / location</span><input class="input" name="manufacturer_unit" maxlength="160" placeholder="e.g. Vapi plant" value="${esc(po?.manufacturer_unit || '')}" /></label>
      <label class="fld wide"><span>Manufacturer address</span><textarea class="input" name="supplier_address" rows="2" maxlength="600">${esc(po?.supplier_address || '')}</textarea><span class="help">Printed on the PO and kept for this manufacturer's next PO.</span></label>
      <label class="fld"><span>Manufacturer GST no.</span><input class="input mono" name="supplier_gstin" maxlength="20" value="${esc(po?.supplier_gstin || '')}" /></label>
      <label class="fld"><span>Expected delivery</span><input class="input" type="date" name="expected_date" value="${esc(po?.expected_date || '')}" /></label>
      <label class="fld"><span>Payment terms</span><input class="input" name="payment_terms" maxlength="300" placeholder="e.g. 30 days from invoice" value="${esc(po?.payment_terms ?? m.company.terms_payment ?? '')}" /></label>
      <label class="fld"><span>Transport</span><input class="input" name="transport" maxlength="160" value="${esc(po?.transport ?? 'Tempo or transporter arrange')}" /></label>
      <label class="fld"><span>Material booking station</span><input class="input" name="booking_station" maxlength="120" value="${esc(po?.booking_station ?? 'Vadodara')}" /></label>
      <label class="fld wide"><span>Remarks</span><textarea class="input" name="remarks" rows="2" maxlength="2000">${esc(po?.remarks || '')}</textarea></label>
    </div></section>
    <section class="dsec"><h3 class="dsec-title">Products</h3><div id="poLines">${lines.map(lineRow).join('')}</div>
      <button type="button" class="btn" id="addLine">${icon('plus')}Add product</button>
      <p class="help" style="margin-top:8px">Units (capsules / tablets / sachets) = packs × pack size, shown on the PO. Stock is counted in packs, as on the master SKU.</p></section></form>`;
  $('#dActions').innerHTML = `<button class="btn" type="button" data-act="cancel-form">Cancel</button><button class="btn primary" type="button" data-act="save-po">${po ? 'Save changes' : 'Create PO'}</button>`;
  saved('');
  openDrawer();
  renderIcons();
}

async function savePo() {
  if (state.busy) return;
  const f = $('#poForm');
  const lines = $$('#poLines .po-line').map((row) => Object.fromEntries($$('[data-k]', row).map((i) => [i.dataset.k, i.value.trim()])))
    .filter((l) => l.sku_id || l.ordered_qty || l.pack_size);
  const body = { po_number: f.po_number.value.trim(), po_date: f.po_date.value, supplier_id: f.supplier_id.value, manufacturer_unit: f.manufacturer_unit.value,
    expected_date: f.expected_date.value, remarks: f.remarks.value, supplier_address: f.supplier_address.value, supplier_gstin: f.supplier_gstin.value,
    payment_terms: f.payment_terms.value, transport: f.transport.value, booking_station: f.booking_station.value, lines };
  state.busy = true; saved('Saving…');
  try {
    const r = state.form.id
      ? await api(`/api/inventory/purchase-orders/${state.form.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: state.form.version }) })
      : await api('/api/inventory/purchase-orders', { method: 'POST', body: JSON.stringify(body) });
    state.meta.suggested = (await api('/api/inventory/purchase-orders/meta')).suggested;
    await load();
    showPo(r.po);
    saved(state.form?.id ? 'Saved' : `PO ${r.po.po_number} created`);
  } catch (err) { saved(err.message, true); } finally { state.busy = false; }
}

function receiptForm(l, po) {
  const m = state.meta;
  return `<form class="po-receive" data-line="${l.id}" novalidate style="border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0">
    <div class="form-grid">
      <label class="fld"><span>Packs received</span><input class="input" name="received_qty" inputmode="numeric" value="${esc(l.pending_qty || '')}" /><span class="help">${count(l.pending_qty)} pending on this PO</span></label>
      <label class="fld"><span>Of which damaged</span><input class="input" name="damaged_qty" inputmode="numeric" value="0" /><span class="help">Recorded, not added to stock</span></label>
      <label class="fld"><span>Batch number</span><input class="input mono" name="batch_number" maxlength="80" /></label>
      <label class="fld"><span>Mfg date</span><input class="input" type="date" name="mfg_date" /></label>
      <label class="fld"><span>Expiry date</span><input class="input" type="date" name="expiry_date" /></label>
      <label class="fld"><span>MRP (₹)</span><input class="input" name="mrp" inputmode="decimal" value="${esc(l.mrp ?? '')}" /></label>
      ${m.warehouses.length > 1 ? `<label class="fld"><span>Warehouse</span><select class="select" name="warehouse_id">${m.warehouses.map((w, i) => opt(w.id, w.name, i === 0)).join('')}</select></label>` : ''}
      <label class="fld"><span>Received on</span><input class="input" type="date" name="received_date" value="${esc(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }))}" /></label>
      <div class="fld wide"><span>Anything wrong?</span><div style="display:flex;flex-wrap:wrap;gap:12px">${Object.entries(m.discrepancies).map(([k, v]) => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="disc" value="${k}" />${esc(v)}</label>`).join('')}</div></div>
      <label class="fld wide"><span>Remarks</span><textarea class="input" name="remarks" rows="2" maxlength="2000" placeholder="e.g. 20 bottles short, 2 cartons torn, labels smudged"></textarea></label>
    </div>
    <div class="form-actions"><button class="btn primary" type="submit">Receive into stock</button><button class="btn" type="button" data-act="cancel-receive">Cancel</button></div>
  </form>`;
}

function showPo(po) {
  state.open = po; state.form = null;
  $('#dTitle').textContent = `PO ${po.po_number}`;
  $('#dSub').textContent = `${po.supplier_name}${po.manufacturer_unit ? ` · ${po.manufacturer_unit}` : ''} · ${day(po.po_date)}`;
  const open = po.status === 'open';
  $('#dBody').innerHTML = `<section class="dsec"><div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center">${tag(po.state)}
      ${po.expected_date ? `<span class="soft">Delivery by ${esc(day(po.expected_date))}</span>` : ''}
      <span class="soft">Raised by ${esc(po.created_by)} · ${esc(istDateTime(po.created_at))}</span></div>
      ${po.remarks ? `<p style="margin:8px 0 0">${esc(po.remarks)}</p>` : ''}
      ${po.closed_reason ? `<p class="warn-text" style="margin:8px 0 0">${po.status === 'cancelled' ? 'Cancelled' : 'Closed'}: ${esc(po.closed_reason)}</p>` : ''}</section>
    ${po.lines.map((l) => `<section class="dsec">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div><b class="mono">${esc(l.sku)}</b> ${esc(l.product_name)} <span class="soft">· ${count(l.pack_size)} ${esc(l.unit_label)} ${esc(l.pack_type)} · ${l.unit_price === null ? 'no price' : `${esc(inr(l.unit_price))} + ${l.gst_pct ?? 0}% GST = ${esc(inr(l.total))}`} · MRP ${esc(inr(l.mrp))}</span>${l.remarks ? `<div class="soft" style="font-size:12px">${esc(l.remarks)}</div>` : ''}</div>
        <div>${tag(l.state)}</div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin:8px 0">
        ${[['Ordered', `${count(l.ordered_qty)} packs`], ['Units', count(l.unit_qty)], ['Received', count(l.received_qty)], ['Into stock', count(l.stocked_qty)], ['Damaged', count(l.damaged_qty)],
          [l.short_qty ? 'Short' : 'Pending', count(l.short_qty || l.pending_qty)], ['Excess', count(l.excess_qty)]]
          .map(([k, v]) => `<div><div class="soft" style="font-size:12px">${k}</div><b>${v}</b></div>`).join('')}</div>
      ${l.receipts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Received</th><th class="r">Packs</th><th class="r">Damaged</th><th>Batch</th><th>Mfg / Expiry</th><th class="r">MRP</th><th>Notes</th><th>COA</th></tr></thead><tbody>
        ${l.receipts.map((r) => `<tr><td>${esc(day(r.received_date))}<div class="soft" style="font-size:12px">${esc(r.received_by)}</div></td><td class="r num">${count(r.received_qty)}</td>
          <td class="r num">${r.damaged_qty ? `<span class="warn-text">${count(r.damaged_qty)}</span>` : '—'}</td><td class="mono">${esc(r.batch_number)}</td>
          <td>${esc(day(r.mfg_date))} / ${esc(day(r.expiry_date))}</td><td class="r num">${esc(inr(r.mrp))}</td>
          <td style="white-space:normal;min-width:160px">${r.discrepancies.map((d) => `<span class="tag warn">${esc(state.meta.discrepancies[d] || d)}</span>`).join(' ')} ${esc(r.remarks || '')}</td>
          <td>${r.documents.filter((d) => d.type === 'coa').map((d) => `<a href="/api/inventory/batches/${r.batch_id}/documents/${d.id}" target="_blank" rel="noopener">${esc(d.filename)}</a>`).join('<br>')}
            ${r.batch_id && canWrite() ? `<label class="linkish" style="cursor:pointer;display:block">${r.coa ? 'Add another' : 'Upload COA'}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg" data-coa="${r.batch_id}" /></label>` : r.coa ? '' : '<span class="soft">—</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="soft" style="margin:0">Nothing received yet.</p>'}
      ${open && canWrite() ? (state.receiving === l.id ? receiptForm(l, po) : `<button class="btn" type="button" data-receive="${l.id}" style="margin-top:8px">${icon('package-check')}Receive delivery</button>`) : ''}
    </section>`).join('')}
    ${open && canWrite() ? `<section class="dsec" id="closeSec" hidden><h3 class="dsec-title" id="closeTitle"></h3>
      <label class="fld"><span>Reason</span><input class="input" id="closeReason" maxlength="500" /></label>
      <div class="form-actions"><button class="btn primary" type="button" data-act="confirm-status">Confirm</button><button class="btn" type="button" data-act="cancel-status">Back</button></div></section>` : ''}`;
  const anyReceived = po.lines.some((l) => l.receipts.length);
  $('#dActions').innerHTML = `<a class="btn" href="/purchase-orders/${po.id}/print" target="_blank" rel="noopener">${icon('printer')}Print / PDF</a>
    ${open && canWrite() ? `<button class="btn" type="button" data-act="edit">${icon('pencil')}Edit</button>
      <button class="btn" type="button" data-act="close">Close PO</button>${anyReceived ? '' : '<button class="btn" type="button" data-act="cancel-po">Cancel PO</button>'}` : ''}`;
  openDrawer();
  renderIcons();
}

async function openPo(id) {
  const { po } = await api(`/api/inventory/purchase-orders/${id}`);
  state.receiving = null;
  showPo(po);
}

async function receive(form) {
  if (state.busy) return;
  const body = Object.fromEntries(['received_qty', 'damaged_qty', 'batch_number', 'mfg_date', 'expiry_date', 'mrp', 'warehouse_id', 'received_date', 'remarks']
    .filter((k) => form[k]).map((k) => [k, form[k].value.trim()]));
  body.discrepancies = $$('input[name="disc"]:checked', form).map((c) => c.value);
  body.request_id = form.dataset.req || (form.dataset.req = rid());
  state.busy = true; saved('Receiving…');
  try {
    const r = await api(`/api/inventory/purchase-orders/lines/${form.dataset.line}/receipts`, { method: 'POST', body: JSON.stringify(body) });
    state.receiving = null;
    await openPo(state.open.id);
    await load();
    saved(r.repeated ? 'Already received' : `Received · ${count(r.stocked)} pack${r.stocked === 1 ? '' : 's'} added to stock`);
  } catch (err) { saved(err.message, true); } finally { state.busy = false; }
}

function companyForm() {
  const c = state.meta.company;
  state.form = { company: true };
  $('#dTitle').textContent = 'Company details';
  $('#dSub').textContent = 'Printed at the top of every purchase order.';
  $('#dBody').innerHTML = `<form id="coForm" novalidate><section class="dsec"><div class="form-grid">
    <label class="fld wide"><span>Company name</span><input class="input" name="name" maxlength="160" value="${esc(c.name)}" /></label>
    <label class="fld wide"><span>Address</span><textarea class="input" name="address" rows="3" maxlength="600">${esc(c.address)}</textarea></label>
    <label class="fld"><span>GSTIN</span><input class="input mono" name="gstin" maxlength="20" value="${esc(c.gstin || '')}" /></label>
    <label class="fld"><span>C.S.T. no. (optional)</span><input class="input mono" name="cst_no" maxlength="40" value="${esc(c.cst_no || '')}" /></label>
    <label class="fld wide"><span>Drug licence nos.</span><input class="input mono" name="dl_numbers" maxlength="200" placeholder="20B-225290, 21B-225291" value="${esc(c.dl_numbers || '')}" /></label>
    <label class="fld"><span>Phone</span><input class="input" name="phone" maxlength="40" value="${esc(c.phone)}" /></label>
    <label class="fld"><span>Email</span><input class="input" name="email" maxlength="120" value="${esc(c.email)}" /></label>
    <label class="fld wide"><span>Terms printed on the PO (optional)</span><textarea class="input" name="terms" rows="4" maxlength="2000" placeholder="e.g. Payment 30 days from invoice. COA with every batch. Minimum 80% shelf life on delivery.">${esc(c.terms)}</textarea></label>
  </div></section></form>`;
  $('#dActions').innerHTML = '<button class="btn" type="button" data-act="cancel-form">Cancel</button><button class="btn primary" type="button" data-act="save-company">Save</button>';
  saved(''); openDrawer(); renderIcons();
}

async function act(a) {
  try {
    if (a === 'cancel-form') { if (state.open) showPo(state.open); else closeDrawer(); return; }
    if (a === 'save-po') return await savePo();
    if (a === 'edit') return poForm(state.open);
    if (a === 'cancel-receive') { state.receiving = null; return showPo(state.open); }
    if (a === 'close' || a === 'cancel-po') {
      state.pendingStatus = a === 'close' ? 'closed' : 'cancelled';
      $('#closeSec').hidden = false;
      $('#closeTitle').textContent = a === 'close' ? 'Close this PO — anything still pending is marked short' : 'Cancel this PO';
      $('#closeReason').placeholder = a === 'close' ? 'e.g. Manufacturer cannot supply the rest' : 'e.g. Raised by mistake';
      $('#closeReason').focus();
      return;
    }
    if (a === 'cancel-status') { $('#closeSec').hidden = true; return; }
    if (a === 'confirm-status') {
      const r = await api(`/api/inventory/purchase-orders/${state.open.id}/status`, { method: 'POST', body: JSON.stringify({ status: state.pendingStatus, reason: $('#closeReason').value, version: state.open.version }) });
      await load(); showPo(r.po); saved(state.pendingStatus === 'closed' ? 'PO closed' : 'PO cancelled');
      return;
    }
    if (a === 'save-company') {
      const f = $('#coForm');
      const r = await api('/api/inventory/purchase-orders/company', { method: 'PUT', body: JSON.stringify(Object.fromEntries(['name', 'address', 'gstin', 'cst_no', 'dl_numbers', 'phone', 'email', 'terms'].map((k) => [k, f[k].value]))) });
      state.meta.company = r.company; closeDrawer(); note('Company details saved. They print on every PO.', true);
    }
  } catch (err) { saved(err.message, true); }
}

(async () => {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    state.meta = await api('/api/inventory/purchase-orders/meta');
    const sup = state.meta.suppliers.map((s) => opt(s.id, s.name)).join('');
    $('#fSupplier').innerHTML += sup; $('#rSupplier').innerHTML += sup;
    $('#rSku').innerHTML += state.meta.skus.map((k) => opt(k.id, skuLabel(k))).join('');
    $('#newPo').hidden = !canWrite(); $('#company').hidden = !canCompany();
    $('#newPo').addEventListener('click', () => poForm());
    $('#company').addEventListener('click', companyForm);
    for (const id of ['fStatus', 'fSupplier']) $(`#${id}`).addEventListener('change', () => load().catch((err) => note(err.message)));
    let t; $('#fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch((err) => note(err.message)), 250); });
    for (const id of ['rSupplier', 'rSku', 'rFrom', 'rTo']) $(`#${id}`).addEventListener('change', () => loadReceived().catch((err) => note(err.message)));
    for (const b of $$('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
    const openRow = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openPo(Number(tr.dataset.id)).catch((err) => note(err.message)); };
    $('#rows').addEventListener('click', openRow);
    $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
    $('#recRows').addEventListener('click', (e) => { const a = e.target.closest('[data-open-po]'); if (a) { e.preventDefault(); openPo(Number(a.dataset.openPo)).catch((err) => note(err.message)); } });
    $('#dActions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act); });
    $('#dBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (b) return act(b.dataset.act);
      if (e.target.closest('#addLine')) { $('#poLines').insertAdjacentHTML('beforeend', lineRow()); renderIcons(); return; }
      const rm = e.target.closest('[data-remove-line]'); if (rm) { if ($$('#poLines .po-line').length > 1) rm.closest('.po-line').remove(); return; }
      const rc = e.target.closest('[data-receive]'); if (rc) { state.receiving = Number(rc.dataset.receive); showPo(state.open); }
    });
    $('#dBody').addEventListener('submit', (e) => { if (e.target.matches('.po-receive')) { e.preventDefault(); receive(e.target); } });
    $('#dBody').addEventListener('change', async (e) => {
      // Choosing the manufacturer fills in the address and GST number last used for it.
      if (e.target.matches('#poForm [name="supplier_id"]')) {
        const s = state.meta.suppliers.find((x) => x.id === Number(e.target.value));
        const f = e.target.form;
        if (s) { f.supplier_address.value = s.address || ''; f.supplier_gstin.value = s.gstin || ''; }
        return;
      }
      const f = e.target.closest('[data-coa]');
      if (!f || !f.files[0]) return;
      saved('Uploading COA…');
      try {
        await api(`/api/inventory/batches/${f.dataset.coa}/documents?type=coa`, { method: 'POST', body: f.files[0], headers: { 'x-filename': encodeURIComponent(f.files[0].name) } });
        await openPo(state.open.id); saved('COA uploaded');
      } catch (err) { saved(err.message, true); }
    });
    $('#dClose').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    await load();
    // From Stock alerts → "Raise PO": open a new PO with that product and quantity.
    const u = new URLSearchParams(location.search);
    if (u.get('new') && canWrite()) poForm(null, { sku: u.get('sku'), qty: u.get('qty') });
  } catch (err) { note(err.message); }
})();
