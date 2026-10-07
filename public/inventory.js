/**
 * Inventory — stock by SKU and batch, the SKU drawer (batches, COAs, ledger),
 * and the admin forms: new SKU, add inventory, adjust, transfer, batch status,
 * mapping an Amazon seller SKU. Every number comes from /api/inventory; stock
 * is never edited here, only recorded as movements.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dateTime, initShell, pageFetch,
  pageSignal, onLeave, onQueryChange,
} from './ui/components.js';

const fetch = pageFetch();

const FILTERS = ['q', 'warehouse', 'location', 'status', 'expiring', 'stock'];
const state = {
  me: null, meta: null, data: null, view: '', f: Object.fromEntries(FILTERS.map((k) => [k, ''])),
  openSku: null, detail: null, form: null,
};

const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
// What this member may do here (lib/permissions.js); the server checks again.
const canMove = () => Boolean(state.me?.caps?.includes('inventory.move'));
const canCatalog = () => Boolean(state.me?.caps?.includes('inventory.catalog'));
const opt = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;
// A batch date is a calendar day ('YYYY-MM-DD'): formatted in UTC from its own
// parts, so the viewer's timezone can never move it to the day before.
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const day = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? DAY_FMT.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : '—';
};
const amount = (v) => (v === null || v === undefined ? '—' : money(v));
const requestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// Batch status dots reuse the board palette: green sellable, amber held, red stopped, grey empty.
const STATUS = {
  active: ['recovered', 'Active'], quarantined: ['noresp', 'Quarantined'], blocked: ['lost', 'Blocked'],
  expired: ['lost', 'Expired'], depleted: ['new', 'Depleted'],
};
const statusTag = (s) => `<span class="status ${STATUS[s]?.[0] || ''}"><span class="dot"></span>${esc(STATUS[s]?.[1] || s)}</span>`;
const expiryCell = (b) => {
  if (!b.expiry_date) return '<span class="muted-cell">—</span>';
  const d = b.days_to_expiry;
  const tone = d !== null && d < 0 ? 'bad' : d !== null && d <= 90 && b.on_hand > 0 ? 'warn' : '';
  const note = d === null ? '' : d < 0 ? 'expired' : d <= 90 ? `${d} d` : '';
  return `<span class="${tone ? `exp-${tone}` : ''}">${esc(day(b.expiry_date))}</span>${note && b.on_hand > 0 ? ` <span class="mini-tag ${tone === 'bad' ? 'warn' : ''}">${esc(note)}</span>` : ''}`;
};
const stockFlag = (r) => (r.out_of_stock ? '<span class="mini-tag warn">Out of stock</span>' : r.low_stock ? '<span class="mini-tag warn">Low stock</span>' : '');

// ------------------------------------------------------------------ URL

function readUrl() {
  const u = new URLSearchParams(window.location.search);
  for (const k of FILTERS) state.f[k] = u.get(k) || '';
  state.view = u.get('view') || '';
  state.openSku = /^\d+$/.test(u.get('sku') || '') ? Number(u.get('sku')) : null;
}
function writeUrl() {
  const u = new URLSearchParams();
  for (const k of FILTERS) if (state.f[k]) u.set(k, state.f[k]);
  if (state.view) u.set('view', state.view);
  if (state.openSku) u.set('sku', state.openSku);
  const next = `${window.location.pathname}${u.toString() ? `?${u}` : ''}`;
  if (next !== `${window.location.pathname}${window.location.search}`) history.replaceState(history.state, '', next);
}
const anyFilter = () => FILTERS.some((k) => state.f[k]);

// ------------------------------------------------------------------ list

async function load() {
  const u = new URLSearchParams();
  for (const k of FILTERS) if (state.f[k]) u.set(k, state.f[k]);
  try {
    // The forms list every SKU, not just the rows the filters show.
    const [data, all] = await Promise.all([api(`/api/inventory?${u}`), api('/api/inventory/skus')]);
    state.data = data;
    state.skus = all.skus;
    render();
    $('#alerts').innerHTML = '';
  } catch (err) {
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}

function render() {
  const { cards: c, rows, unmapped } = state.data;
  const title = state.view === 'unmapped' ? 'Unmapped SKUs' : state.f.stock === 'low' ? 'Low stock'
    : state.f.expiring ? 'Expiring stock' : 'Inventory';
  $('#pageTitle').textContent = title;
  $('#crumbHere').textContent = title === 'Inventory' ? 'Stock' : title;
  $('#topTitle').textContent = title;
  document.title = `${title} — Briyo OS`;
  $('#pageSub').textContent = `${count(c.totalSkus)} active SKUs · ${count(c.availableUnits)} available to dispatch of ${count(c.onHandUnits)} on hand · ${money(c.inventoryValue)} at cost`
    + (c.unitsWithoutCost ? ` · ${count(c.unitsWithoutCost)} units without a cost` : '');

  const card = (n, label, { tone = '', filter = null, title: tip = '' } = {}) => `<button type="button" class="imp-stat inv-card ${tone}"
      ${filter ? `data-filter='${esc(JSON.stringify(filter))}'` : 'disabled'} title="${esc(tip)}"><b>${typeof n === 'number' ? count(n) : esc(n)}</b><span>${esc(label)}</span></button>`;
  $('#cards').innerHTML = [
    card(c.onHandUnits, 'On hand', { title: 'Physically in stock: every batch, whatever its status' }),
    card(c.sellableUnits, 'Sellable', { title: 'On hand in active, unexpired batches' }),
    card(c.reservedSellableUnits, 'Reserved', { title: 'Sellable stock set aside for shipments not yet dispatched' }),
    card(c.availableUnits, 'Available to dispatch', { tone: 'good', title: 'Sellable − reserved' }),
    card(c.expiredUnits, 'Expired', { tone: c.expiredUnits ? 'bad' : '', filter: { status: 'expired' } }),
    card(c.quarantinedUnits + c.blockedUnits, c.blockedUnits ? 'Quarantined / blocked' : 'Quarantined', { tone: c.quarantinedUnits + c.blockedUnits ? 'warn' : '', filter: { status: 'quarantined' },
      title: `${c.quarantinedUnits} quarantined, ${c.blockedUnits} blocked` }),
    card(c.lowStock, 'Low stock SKUs', { tone: c.lowStock ? 'warn' : '', filter: { stock: 'low' }, title: 'Available to dispatch at or under the reorder level' }),
    card(c.outOfStock, 'Out of stock SKUs', { tone: c.outOfStock ? 'bad' : '', filter: { stock: 'out' }, title: 'Nothing available to dispatch' }),
    card(c.expiring90, 'Batches expiring ≤ 90 d', { tone: c.expiring90 ? 'warn' : '', filter: { expiring: '90' },
      title: `${c.expiring30} within 30 days, ${c.expiring60} within 60 days` }),
    card(money(c.inventoryValue), 'Inventory value', { title: 'On hand × unit cost, per batch (all statuses). Not selling price.' }),
  ].join('');
  $('#formula').textContent = `On hand ${count(c.onHandUnits)} = sellable ${count(c.sellableUnits)} + expired ${count(c.expiredUnits)} + quarantined ${count(c.quarantinedUnits)} + blocked ${count(c.blockedUnits)}.`
    + ` Available to dispatch ${count(c.availableUnits)} = sellable ${count(c.sellableUnits)} − reserved ${count(c.reservedSellableUnits)}.`;

  // Unmapped seller SKUs: orders that cannot be dispatched until mapped.
  $('#unmapped').innerHTML = unmapped.length ? `<section class="card unmapped-card${state.view === 'unmapped' ? ' focus' : ''}" id="unmappedCard">
    <header class="card-head"><h2 class="card-title">${icon('triangle-alert')}Unmapped platform SKUs <span class="card-meta">${count(unmapped.length)} code${unmapped.length > 1 ? 's' : ''} on orders that match no master SKU · those orders cannot be dispatched until mapped</span></h2></header>
    <div class="pane"><div class="table-wrap"><table class="table"><thead><tr><th>Platform SKU</th><th>Platform</th><th>Item</th><th class="r">Orders</th><th class="r">Units</th><th class="r"></th></tr></thead><tbody>
    ${unmapped.map((u) => `<tr><td class="mono">${esc(u.code)}${u.asin ? `<span class="cell-sub muted">ASIN ${esc(u.asin)}</span>` : ''}</td>
      <td>${esc(u.platform_label)}</td>
      <td><span class="cell-text">${esc(u.title || '—')}</span></td><td class="r num">${count(u.orders)}</td><td class="r num">${count(u.units)}</td>
      <td class="r">${!canCatalog() ? '<span class="soft">Ask an Inventory manager</span>'
        : u.mappable ? `<button class="btn" type="button" data-map="${esc(u.code)}" data-platform="${esc(u.channel)}" data-platform-label="${esc(u.platform_label)}" data-title="${esc(u.title || '')}" data-asin="${esc(u.asin || '')}">Map to master SKU</button>`
          : `<span class="soft" title="${esc(u.platform_label)} orders use master SKU codes directly. Create a master SKU with this code, or add ${esc(u.platform_label)} as a platform.">Not a mapped platform</span>`}</td></tr>`).join('')}
    </tbody></table></div></div></section>` : (state.view === 'unmapped' ? '<section class="card"><div class="pane"><div class="empty-note"><b>Every SKU on an order is mapped.</b>Nothing to resolve.</div></div></section>' : '');

  $('#resultNote').textContent = `${count(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}${anyFilter() ? ' matching the filters' : ''} · one row per batch, earliest expiry first`;
  $('#fclear').hidden = !anyFilter();

  if (!rows.length) {
    const empty = anyFilter() ? '<b>Nothing matches.</b>Try clearing a filter.'
      : `<b>No SKUs yet.</b>${canCatalog() ? 'Create one with New SKU, then Add Inventory.' : 'An Inventory manager adds SKUs and stock.'}`;
    $('#rows').innerHTML = `<tr><td colspan="8"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return renderIcons();
  }
  $('#rows').innerHTML = rows.map((r) => `
    <tr class="orow${r.sku_id === state.openSku ? ' open' : ''}" data-sku="${r.sku_id}" tabindex="0">
      <td><span class="cell-main mono" style="font-weight:500">${esc(r.sku)}</span>${r.sku_active === false ? '<span class="mini-tag">Inactive</span>' : ''}</td>
      <td><span class="cell-main">${esc(r.product_name)}</span>${r.variant_name ? `<span class="cell-sub muted">${esc(r.variant_name)}</span>` : ''}</td>
      <td class="r num">${r.empty ? '<span class="muted-cell">—</span>' : count(r.available)}${stockFlag(r) ? `<span class="cell-sub">${stockFlag(r)}</span>` : ''}</td>
      <td class="r num">${r.empty || !r.reserved ? '<span class="muted-cell">—</span>' : count(r.reserved)}</td>
      <td>${r.empty ? '<span class="muted-cell">No stock yet</span>' : `<span class="mono">${esc(r.batch_number)}</span><span class="cell-sub muted">${count(r.on_hand)} on hand</span>`}</td>
      <td>${r.empty ? '<span class="muted-cell">—</span>' : expiryCell(r)}</td>
      <td>${r.empty ? '<span class="muted-cell">—</span>' : `${esc(r.warehouse_name)}${r.location ? `<span class="cell-sub muted">${esc(r.location)}</span>` : ''}`}</td>
      <td>${r.empty ? '<span class="muted-cell">—</span>' : statusTag(r.effective_status)}</td>
    </tr>`).join('');
  $('#clist').innerHTML = rows.map((r) => `
    <li class="oitem" data-sku="${r.sku_id}" tabindex="0">
      <div class="oi-top"><span class="oi-id mono">${esc(r.sku)}</span>${r.empty ? '' : `<span class="oi-val">${statusTag(r.effective_status)}</span>`}</div>
      <div class="oi-sub">${esc(r.product_name)}${r.variant_name ? ` · ${esc(r.variant_name)}` : ''}</div>
      <div class="oi-sub">${r.empty ? 'No stock yet' : `Batch <span class="mono">${esc(r.batch_number)}</span> · ${esc(r.warehouse_name)}${r.location ? ` · ${esc(r.location)}` : ''}`}</div>
      ${r.empty ? '' : `<div class="oi-stat"><span class="soft" style="font-size:12.5px">${count(r.available)} available${r.reserved ? ` · ${count(r.reserved)} reserved` : ''}</span>
        <span style="font-size:12.5px">${expiryCell(r)}</span>${stockFlag(r)}</div>`}
    </li>`).join('');
  renderIcons();
}

// ------------------------------------------------------------------ scroll lock

/**
 * While a drawer is open the page behind it must not move. The window is the
 * scroller here (the sidebar is sticky to it), so the lock hides overflow on
 * <html> — which keeps the sidebar in place, unlike position:fixed on body —
 * pads for the vanished scrollbar so nothing shifts sideways, and puts the
 * exact scroll position back on unlock.
 */
let lockedAt = null;
function syncScrollLock() {
  const open = !$('#drawer').hidden || !$('#formDrawer').hidden;
  const root = document.documentElement;
  if (open && lockedAt === null) {
    lockedAt = window.scrollY;
    const bar = window.innerWidth - root.clientWidth;
    root.classList.add('scroll-locked');
    if (bar > 0) root.style.paddingRight = `${bar}px`;
  } else if (!open && lockedAt !== null) {
    const y = lockedAt;
    lockedAt = null;
    root.classList.remove('scroll-locked');
    root.style.paddingRight = '';
    window.scrollTo(0, y);
  }
}

// ------------------------------------------------------------------ SKU drawer

async function openSku(id) {
  state.openSku = id;
  writeUrl();
  $$('.orow').forEach((r) => r.classList.toggle('open', Number(r.dataset.sku) === id));
  $('#drawer').hidden = false;
  $('#drawerScrim').hidden = false;
  syncScrollLock();
  $('#dSaved').textContent = '';
  if (!state.detail || state.detail.sku.id !== id) { $('#dTitle').textContent = 'Loading…'; $('#dSub').textContent = ''; $('#dBody').innerHTML = ''; }
  try {
    state.detail = await api(`/api/inventory/skus/${id}`);
    renderSku();
  } catch (err) {
    $('#dBody').innerHTML = `<div class="empty-note"><b>Could not open this SKU.</b>${esc(err.message)}</div>`;
  }
}
function closeSku() {
  $('#drawer').hidden = true;
  if ($('#formDrawer').hidden) $('#drawerScrim').hidden = true;
  syncScrollLock();
  state.openSku = null;
  writeUrl();
  $$('.orow.open').forEach((r) => r.classList.remove('open'));
}

const MOVE_TONE = (q) => (q > 0 ? 'good' : 'warn');
const docUrl = (d, download) => `/api/inventory/batches/${d.batch_id}/documents/${d.id}${download ? '?download=1' : ''}`;
const refText = (m) => {
  if (m.shipment_id) return `Shipment${m.source_order_id ? ` · order <span class="mono">${esc(m.source_order_id)}</span>` : ''}`;
  if (m.reference_id) return `${esc(m.reference_type ? m.reference_type.toUpperCase() : 'Ref')} <span class="mono">${esc(m.reference_id)}</span>`;
  return '—';
};

function renderSku() {
  const { sku: s, batches, movements, reservations, orderLines } = state.detail;
  $('#dTitle').innerHTML = `<span class="mono">${esc(s.sku)}</span>`;
  $('#dSub').textContent = [s.product_name, s.variant_name, s.category, !s.active && 'Inactive'].filter(Boolean).join(' · ');
  const live = batches.filter((b) => b.on_hand > 0 || b.effective_status !== 'depleted');
  const old = batches.filter((b) => !live.includes(b));
  const batchRow = (b) => `<tr>
      <td><span class="mono" style="font-weight:500">${esc(b.batch_number)}</span>
        <span class="cell-sub muted">${esc(b.warehouse_name)}${b.location ? ` · ${esc(b.location)}` : ''}</span>
        <span class="cell-sub muted">${[b.mfg_date && `Mfg ${esc(day(b.mfg_date))}`, b.supplier_name ? esc(b.supplier_name) : 'No supplier', b.grn_number && `GRN ${esc(b.grn_number)}`,
          b.unit_cost !== null && `${esc(money(b.unit_cost))} each · ${esc(money(b.value))}`].filter(Boolean).join(' · ')}</span></td>
      <td class="r num">${count(b.on_hand)}${b.reserved ? `<span class="cell-sub muted">${count(b.reserved)} reserved</span>` : ''}</td>
      <td>${expiryCell(b)}</td>
      <td>${statusTag(b.effective_status)}</td>
    </tr>
    <tr class="sub-row"><td colspan="4">
      <div class="batch-docs">${b.documents.length ? b.documents.map((d) => `<span class="doc-chip">${icon(d.document_type === 'coa' ? 'file-check' : 'file-text')}
          <b>${esc(d.document_type === 'coa' ? 'COA' : d.document_type.replaceAll('_', ' '))}</b> ${esc(d.original_filename)}
          <a href="${docUrl(d)}" target="_blank" rel="noopener">View</a><a href="${docUrl(d, true)}">Download</a>
          ${canMove() ? `<button type="button" class="linkish" data-doc-remove="${d.id}" data-batch="${b.id}">Remove</button>` : ''}</span>`).join('')
        : '<span class="soft">No COA uploaded.</span>'}
        ${canMove() ? `<label class="linkish upload-link">${icon('upload')}Upload COA / document<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg" data-upload="${b.id}" /></label>
          <select class="select mini-select" data-upload-type="${b.id}" aria-label="Document type">${state.meta.documentTypes.map((t) => opt(t, t === 'coa' ? 'COA' : t.replaceAll('_', ' '))).join('')}</select>` : ''}
      </div>
      ${canMove() ? `<div class="batch-actions">
        <button type="button" class="linkish" data-act="adjust" data-batch="${b.id}">Adjust / write off</button>
        <button type="button" class="linkish" data-act="return" data-batch="${b.id}">Customer return</button>
        <button type="button" class="linkish" data-act="transfer" data-batch="${b.id}">Transfer</button>
        <button type="button" class="linkish" data-act="batch" data-batch="${b.id}">Status &amp; details</button>
      </div>` : ''}
    </td></tr>`;

  $('#dBody').innerHTML = `
    <section class="dsec">
      <h3 class="dsec-title">Stock ${s.out_of_stock ? '<span class="mini-tag warn">Out of stock</span>' : s.low_stock ? '<span class="mini-tag warn">Low stock</span>' : ''}</h3>
      <div class="imp-stats stock-cards">
        <div class="imp-stat"><b>${count(s.on_hand)}</b><span>On hand</span></div>
        <div class="imp-stat"><b>${count(s.sellable)}</b><span>Sellable</span></div>
        <div class="imp-stat"><b>${count(s.reserved_sellable)}</b><span>Reserved</span></div>
        <div class="imp-stat ${s.out_of_stock ? 'bad' : s.low_stock ? 'warn' : 'good'}"><b>${count(s.available)}</b><span>Available to dispatch</span></div>
      </div>
      <div class="imp-stats stock-cards" style="margin-top:8px">
        <div class="imp-stat ${s.expired ? 'bad' : ''}"><b>${count(s.expired)}</b><span>Expired</span></div>
        <div class="imp-stat ${s.quarantined ? 'warn' : ''}"><b>${count(s.quarantined)}</b><span>Quarantined</span></div>
        <div class="imp-stat ${s.blocked ? 'bad' : ''}"><b>${count(s.blocked)}</b><span>Blocked</span></div>
        <div class="imp-stat"><b>${esc(money(s.value))}</b><span>Value at cost</span></div>
      </div>
      <p class="imp-note">On hand = sellable + expired + quarantined + blocked. Available to dispatch = sellable − reserved.
        ${s.track_inventory ? '' : '<b>Not inventory-tracked:</b> orders for this SKU dispatch without a stock check. '}Reorder level ${count(s.reorder_level)}${s.reorder_quantity ? `, reorder quantity ${count(s.reorder_quantity)}` : ''}.</p>
      ${canMove() || canCatalog() ? `<div class="form-actions">${canMove() ? `<button class="btn primary" type="button" data-act="receive">${icon('plus')}Add inventory</button>` : ''}
        ${canCatalog() ? `<button class="btn" type="button" data-act="edit-sku">${icon('pencil')}Edit master SKU</button>` : ''}</div>` : ''}
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Batches <span class="dsec-meta soft">earliest expiry first (FEFO)</span></h3>
      ${batches.length ? `<div class="table-wrap"><table class="table batch-table"><thead><tr><th>Batch</th><th class="r">Qty</th><th>Expiry</th><th>Status</th></tr></thead>
        <tbody>${live.map(batchRow).join('')}</tbody></table></div>
        ${old.length ? `<details class="old-batches"><summary class="soft">${count(old.length)} depleted batch${old.length > 1 ? 'es' : ''}</summary>
          <div class="table-wrap"><table class="table batch-table"><tbody>${old.map(batchRow).join('')}</tbody></table></div></details>` : ''}`
        : '<p class="soft" style="margin:0">No batches yet.</p>'}
    </section>

    ${reservations.length ? `<section class="dsec">
      <h3 class="dsec-title">Reserved for shipments <span class="dsec-meta soft">${count(reservations.reduce((n, r) => n + r.quantity, 0))} units</span></h3>
      <ul class="d-history">${reservations.map((r) => `<li><span><a class="linkish" href="/orders?open=${r.lead_order_id}">Order ${esc(r.lead_order_number)}</a>
        ${r.tracking_id ? ` · AWB <span class="mono">${esc(r.tracking_id)}</span>` : ''} · batch <span class="mono">${esc(r.batch_number)}</span></span>
        <span class="d-when">${count(r.quantity)} · ${esc(r.created_by || '')}</span></li>`).join('')}</ul>
    </section>` : ''}

    <section class="dsec">
      <h3 class="dsec-title">Master SKU <span class="dsec-meta soft">Briyo's internal identifier · holds the stock</span></h3>
      <dl class="kv">
        <dt>Master Briyo SKU</dt><dd class="mono"><b>${esc(s.sku)}</b></dd>
        <dt>Product</dt><dd>${esc(s.product_name)}</dd>
        ${s.variant_name ? `<dt>Variant</dt><dd>${esc(s.variant_name)}</dd>` : ''}
        ${s.category ? `<dt>Category</dt><dd>${esc(s.category)}</dd>` : ''}
        <dt>Unit</dt><dd>${esc(s.unit_type)}</dd>
        <dt>Inventory</dt><dd>${s.track_inventory ? 'Tracked — stock is reserved and deducted at dispatch' : 'Not tracked — no stock check at dispatch'}</dd>
        <dt>Website / Shopify</dt><dd>Uses the master SKU <span class="mono">${esc(s.sku)}</span> as is</dd>
        <dt>On orders</dt><dd>${count(orderLines.orders)} orders · ${count(orderLines.units)} units</dd>
      </dl>
    </section>

    ${platformSection(s)}

    <section class="dsec">
      <h3 class="dsec-title">Stock movements <span class="dsec-meta soft">${movements.length >= 200 ? 'latest 200' : count(movements.length)}</span></h3>
      ${movements.length ? `<div class="table-wrap"><table class="table move-table"><thead><tr><th>Date</th><th>Movement</th><th class="r">Qty</th><th>Batch</th><th>Reference</th><th>User</th></tr></thead><tbody>
      ${movements.map((m) => `<tr>
        <td class="num">${esc(dateTime(m.at))}</td>
        <td>${esc(m.label)}${m.reason && m.reason !== m.label ? `<span class="cell-sub muted">${esc(m.reason)}</span>` : ''}${m.notes ? `<span class="cell-sub muted">${esc(m.notes)}</span>` : ''}</td>
        <td class="r num"><span class="qty-${MOVE_TONE(m.quantity)}">${m.quantity > 0 ? '+' : '−'}${count(Math.abs(m.quantity))}</span></td>
        <td><span class="mono">${esc(m.batch_number)}</span><span class="cell-sub muted">${esc(m.warehouse_name)}</span></td>
        <td>${refText(m)}</td>
        <td>${esc(m.actor || 'System')}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="soft" style="margin:0">No movements yet.</p>'}
    </section>`;
  renderIcons();
}

/**
 * Platform SKUs: each marketplace's own identifier(s) for this product. They
 * all point at the one master SKU and share its stock — none is a product of
 * its own.
 */
function platformSection(s) {
  const usage = state.detail.mappingUsage || {};
  const platforms = state.meta.platforms || [];
  const groups = platforms.map((p) => ({ ...p, list: s.platform_skus.filter((m) => m.platform === p.key) })).filter((g) => g.list.length);
  return `<section class="dsec">
      <h3 class="dsec-title">Platform SKUs <span class="dsec-meta soft">${count(s.platform_skus.length)} mapping${s.platform_skus.length === 1 ? '' : 's'}</span></h3>
      <p class="imp-note" style="margin:0 0 10px">Marketplace identifiers for this product. An order from a platform with one of these codes resolves to master SKU
        <b class="mono">${esc(s.sku)}</b> and uses its stock. They are not separate products and hold no stock of their own.</p>
      ${s.platform_skus.length ? `<ul class="pf-list">${groups.map((g) => g.list.map((m) => `
        <li class="pf-row">
          <div class="pf-main"><span class="pf-label">${esc(g.label)}</span>
            <span class="pf-code mono">${esc(m.platform_sku)}</span>
            ${m.duplicate_override ? `<span class="mini-tag warn" title="${esc(`Also mapped to another master SKU. Reason: ${m.duplicate_reason}`)}">Duplicate</span>` : ''}
            <span class="mini-tag" title="Units per listing: how many master-SKU units one channel listing represents.">${count(m.units_per_listing)} unit${m.units_per_listing === 1 ? '' : 's'} per listing</span></div>
          <span class="pf-meta soft" title="${esc(`Added ${m.source === 'import' ? 'by import' : m.source === 'migrated' ? 'from the old Amazon field' : m.source === 'unmapped' ? 'from Unmapped platform SKUs' : 'by hand'}${m.created_by ? ` · ${m.created_by}` : ''}`)}">${usage[m.id] ? `${count(usage[m.id])} order line${usage[m.id] === 1 ? '' : 's'}` : ''}</span>
          ${canCatalog() ? `<button type="button" class="linkish pf-remove" data-units="${m.id}" data-current="${m.units_per_listing}" data-code="${esc(m.platform_sku)}" aria-label="Change units per listing for ${esc(g.label)} SKU ${esc(m.platform_sku)}">Units</button>` : ''}
          ${canCatalog() ? `<button type="button" class="linkish pf-remove" data-unmap="${m.id}" data-code="${esc(m.platform_sku)}" data-lines="${usage[m.id] || 0}" aria-label="Remove ${esc(g.label)} SKU ${esc(m.platform_sku)}">Remove</button>` : ''}
        </li>`).join('')).join('')}</ul>`
        : '<p class="soft" style="margin:0">No platform SKUs yet. Orders from marketplaces will not resolve to this product until they are added.</p>'}
      ${canCatalog() ? `<div class="pf-add">
        <label class="fld"><span>Platform</span><select class="select" id="pfPlatform">${platforms.filter((p) => p.active).map((p) => opt(p.key, p.label, p.key === state.pfPlatform)).join('')}</select></label>
        <label class="fld"><span>Platform SKU</span><div class="pf-entry">
          <input class="input mono" id="pfCode" placeholder="Enter platform SKU" maxlength="80" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn" id="pfAdd">Add</button></div></label>
        <label class="fld"><span>Units per listing</span><input class="input" id="pfUnits" type="number" min="1" step="1" value="1" inputmode="numeric" />
          <span class="help">How many master-SKU units one channel listing represents.</span></label>
        <p class="pf-error" id="pfError" role="alert" hidden></p>
      </div>` : ''}
      ${s.asin || s.amazon_listing_id || s.amazon_product_id || s.amazon_item_name ? `<dl class="kv" style="margin-top:12px">
        ${s.asin ? `<dt>ASIN</dt><dd class="mono">${esc(s.asin)}</dd>` : ''}
        ${s.amazon_listing_id ? `<dt>Amazon listing ID</dt><dd class="mono">${esc(s.amazon_listing_id)}</dd>` : ''}
        ${s.amazon_product_id ? `<dt>Amazon product ID</dt><dd class="mono">${esc(s.amazon_product_id)}</dd>` : ''}
        ${s.amazon_item_name ? `<dt>Amazon item name</dt><dd>${esc(s.amazon_item_name)}</dd>` : ''}</dl>` : ''}
    </section>`;
}

// ------------------------------------------------------------------ forms

function openForm(kind, ctx = {}) {
  state.form = { kind, ctx, requestId: requestId() };
  const f = $('#invForm');
  const m = state.meta;
  const skus = (state.skus || []).map((x) => ({ sku_id: x.id, sku: x.sku, product_name: x.product_name, variant_name: x.variant_name, sku_active: x.active }));
  const batch = ctx.batchId ? state.detail?.batches.find((b) => b.id === ctx.batchId) : null;
  const wh = (sel) => m.warehouses.filter((w) => w.active).map((w) => opt(w.id, w.name, String(w.id) === String(sel))).join('');
  const skuOptions = (sel) => opt('', 'Choose a SKU', !sel) + skus.filter((r) => r.sku_active !== false)
    .map((r) => opt(r.sku_id, `${r.sku} — ${r.product_name}${r.variant_name ? ` (${r.variant_name})` : ''}`, String(r.sku_id) === String(sel))).join('');
  const s = kind === 'edit-sku' ? state.detail.sku : (ctx.prefill || {});
  let title = ''; let sub = ''; let submit = 'Save'; let body = '';

  if (kind === 'sku' || kind === 'edit-sku') {
    title = kind === 'sku' ? 'New master SKU' : `Edit ${s.sku}`;
    sub = 'One master SKU per physical sellable product. Marketplace SKUs are added on its page and point back to it.';
    submit = kind === 'sku' ? 'Create master SKU' : 'Save';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>Master Briyo SKU</span><input class="input mono" name="sku" value="${esc(s.sku || '')}" ${kind === 'edit-sku' ? 'readonly' : 'required'} maxlength="64" placeholder="BS002E90" autocomplete="off" />
        <span class="help">${kind === 'edit-sku' ? 'A master SKU code never changes.' : "Briyo's internal code: letters, numbers, - _ . / — no spaces. The website/Shopify uses it as is."}</span></label>
      <label class="fld"><span>Product name</span><input class="input" name="product_name" value="${esc(s.product_name || '')}" required maxlength="200" placeholder="Vitamin D3 2000 IU" /></label>
      <label class="fld"><span>Variant</span><input class="input" name="variant_name" value="${esc(s.variant_name || '')}" maxlength="120" placeholder="60 Capsules" /></label>
      <label class="fld"><span>Category</span><input class="input" name="category" value="${esc(s.category || '')}" maxlength="120" /></label>
      <label class="fld"><span>Unit type</span><input class="input" name="unit_type" value="${esc(s.unit_type || 'bottle')}" maxlength="40" /></label>
      <label class="fld"><span>Status</span><select class="select" name="active">${opt('true', 'Active', s.active !== false)}${opt('false', 'Inactive', s.active === false)}</select></label>
      <label class="fld"><span>Inventory</span><select class="select" name="track_inventory">${opt('true', 'Tracked (physical stock)', s.track_inventory !== false)}${opt('false', 'Not tracked', s.track_inventory === false)}</select>
        <span class="help">Tracked SKUs must have stock reserved before a shipment can be dispatched.</span></label>
      <label class="fld"><span>Reorder level</span><input class="input" name="reorder_level" inputmode="numeric" value="${esc(s.reorder_level ?? '')}" placeholder="0" /></label>
      <label class="fld"><span>Reorder quantity</span><input class="input" name="reorder_quantity" inputmode="numeric" value="${esc(s.reorder_quantity ?? '')}" placeholder="0" /></label>
    </div></section>
    <section class="dsec"><h3 class="dsec-title">Amazon listing details <span class="dsec-meta soft">optional</span></h3>
      <p class="imp-note" style="margin:0 0 10px">Amazon seller SKUs, like every platform's SKUs, are added under <b>Platform SKUs</b> on this product's page.</p>
      <div class="form-grid">
      <label class="fld"><span>ASIN</span><input class="input mono" name="asin" value="${esc(s.asin || '')}" maxlength="40" /></label>
      <label class="fld"><span>Listing ID</span><input class="input mono" name="amazon_listing_id" value="${esc(s.amazon_listing_id || '')}" maxlength="80" /></label>
      <label class="fld"><span>Product ID</span><input class="input mono" name="amazon_product_id" value="${esc(s.amazon_product_id || '')}" maxlength="80" /></label>
      <label class="fld wide"><span>Amazon item name</span><input class="input" name="amazon_item_name" value="${esc(s.amazon_item_name || '')}" maxlength="500" /></label>
    </div></section>`;
  } else if (kind === 'map') {
    title = `Map ${ctx.platformLabel} SKU`;
    sub = `${ctx.platformLabel} SKU ${ctx.code} → a master Briyo SKU. Its orders then resolve to that product and its stock.`;
    submit = 'Map to master SKU';
    body = `<section class="dsec"><dl class="kv"><dt>Platform</dt><dd>${esc(ctx.platformLabel)}</dd><dt>Platform SKU</dt><dd class="mono">${esc(ctx.code)}</dd><dt>Item on the order</dt><dd>${esc(ctx.title || '—')}</dd>${ctx.asin ? `<dt>ASIN</dt><dd class="mono">${esc(ctx.asin)}</dd>` : ''}</dl>
      <div class="form-grid" style="margin-top:12px">
        <label class="fld wide"><span>Master Briyo SKU</span><select class="select" name="sku_id" required>${skuOptions('')}</select>
          <span class="help">No new SKU is created. If the product is not in the master list yet, create it with New master SKU first, then map.</span></label>
        <label class="fld"><span>Units per listing</span><input class="input" name="units_per_listing" type="number" min="1" step="1" value="1" inputmode="numeric" required />
          <span class="help">How many master-SKU units one channel listing represents.</span></label>
      </div></section>`;
  } else if (kind === 'dup-map') {
    const d = ctx.dup;
    title = 'SKU already mapped';
    sub = `${d.platform_label} · adding to ${d.target.sku}`;
    submit = 'Add anyway';
    body = `<section class="dsec">${d.duplicates.map((x) => `<p class="dup-lead"><b class="mono">${esc(x.platform_sku)}</b> is currently mapped to:</p>
        <ul class="dup-list">${x.mapped_to.map((o) => `<li><b class="mono">${esc(o.sku)}</b> — ${esc(o.product_name)}</li>`).join('')}</ul>`).join('')}
      <p class="soft" style="margin:12px 0 0">Adding it to <b class="mono">${esc(d.target.sku)}</b> — ${esc(d.target.product_name)} as well. Orders with this SKU keep resolving to
        <b class="mono">${esc(d.duplicates[0].mapped_to[0].sku)}</b> and use its stock.</p>
      <label class="fld wide" id="dupReasonFld" hidden style="margin-top:14px"><span>Why are you adding the same platform SKU to multiple master SKUs?</span>
        <textarea class="input" id="dupReason" name="duplicate_reason" rows="3" maxlength="1000" placeholder="Required"></textarea>
        <span class="help">Required. Stored with the mapping and in the audit record.</span></label>
    </section>`;
  } else if (kind === 'receive') {
    title = 'Add inventory';
    sub = 'Goods in: creates the batch if it is new and records +quantity in the ledger.';
    submit = 'Add inventory';
    const sup = m.suppliers.map((x) => `<option value="${esc(x.name)}"></option>`).join('');
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>SKU</span><select class="select" name="sku_id" required>${skuOptions(ctx.skuId || '')}</select></label>
      <label class="fld"><span>Batch number</span><input class="input mono" name="batch_number" required maxlength="80" autocomplete="off" /></label>
      <label class="fld"><span>Quantity</span><input class="input" name="quantity" inputmode="numeric" required /></label>
      <label class="fld"><span>Manufacturing date</span><input class="input" name="mfg_date" placeholder="08/2026 or 01/08/2026" autocomplete="off" /></label>
      <label class="fld"><span>Expiry</span><input class="input" name="expiry_date" placeholder="08/2028 or 31/08/2028" autocomplete="off" />
        <span class="help">A month alone means its last day: 08/2028 = 31 Aug 2028.</span></label>
      <label class="fld"><span>Unit cost (₹)</span><input class="input" name="unit_cost" inputmode="decimal" placeholder="180" /></label>
      <label class="fld"><span>Received date</span><input class="input" name="received_date" placeholder="Today if empty" autocomplete="off" /></label>
      <label class="fld"><span>Supplier</span><input class="input" name="supplier_name" list="supList" maxlength="120" autocomplete="off" /><datalist id="supList">${sup}</datalist>
        <span class="help">Pick one or type a new name; it is added to the supplier list.</span></label>
      <label class="fld"><span>PO number</span><input class="input mono" name="po_number" maxlength="80" /></label>
      <label class="fld"><span>GRN number</span><input class="input mono" name="grn_number" maxlength="80" /></label>
      <label class="fld"><span>Warehouse</span><select class="select" name="warehouse_id">${wh('')}</select></label>
      <label class="fld"><span>Location / rack</span><input class="input" name="location" maxlength="80" placeholder="Rack B2" /></label>
      <label class="fld wide"><span>COA</span><input class="input" type="file" name="coa" accept=".pdf,.png,.jpg,.jpeg" ${m.storage.error ? 'disabled' : ''} />
        <span class="help">${esc(m.storage.error || 'Certificate of Analysis for this batch (PDF, PNG or JPG). You can also add it later.')}</span></label>
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000"></textarea></label>
    </div></section>`;
  } else if (kind === 'adjust' || kind === 'return') {
    title = kind === 'return' ? 'Customer return' : 'Adjust stock';
    sub = `Batch ${batch.batch_number} · ${count(batch.on_hand)} on hand${batch.reserved ? `, ${count(batch.reserved)} reserved` : ''}. Recorded as a movement; nothing is overwritten.`;
    submit = kind === 'return' ? 'Add returned stock' : 'Record adjustment';
    const types = kind === 'return' ? ['customer_return'] : m.manualMovements.filter((t) => t !== 'customer_return');
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>Change</span><select class="select" name="movement_type">${types.map((t) => {
        const mt = m.movementTypes.find((x) => x.key === t);
        return opt(t, `${mt.sign > 0 ? '+' : '−'} ${mt.label}`, false);
      }).join('')}</select></label>
      <label class="fld"><span>Quantity</span><input class="input" name="quantity" inputmode="numeric" required /></label>
      <label class="fld wide"><span>Reason</span><input class="input" name="reason" required maxlength="300" placeholder="${kind === 'return' ? 'Returned sealed, inspected and sellable' : '5 bottles damaged during handling'}" /></label>
      ${kind === 'return' ? `<label class="fld"><span>Return / order reference</span><input class="input mono" name="reference_id" required maxlength="80" /></label>
        <p class="imp-note wide">Only sellable returns come back into stock. A damaged return is not added here.</p>` : ''}
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000"></textarea></label>
    </div></section>`;
  } else if (kind === 'transfer') {
    title = 'Transfer stock';
    sub = `Batch ${batch.batch_number} from ${batch.warehouse_name} · ${count(batch.available)} available.`;
    submit = 'Transfer';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>To warehouse</span><select class="select" name="to_warehouse_id" required>${m.warehouses.filter((w) => w.active && w.id !== batch.warehouse_id).map((w) => opt(w.id, w.name)).join('')}</select></label>
      <label class="fld"><span>Quantity</span><input class="input" name="quantity" inputmode="numeric" required /></label>
      <label class="fld"><span>Location / rack there</span><input class="input" name="location" maxlength="80" /></label>
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000"></textarea></label>
    </div></section>`;
  } else if (kind === 'batch') {
    title = `Batch ${batch.batch_number}`;
    sub = 'Status and details. Quantities change only through movements.';
    submit = 'Save batch';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>Status</span><select class="select" name="status">${m.batchStatuses.map((x) => opt(x, STATUS[x][1], x === batch.status)).join('')}</select>
        <span class="help">Quarantined, blocked and expired stock is never offered for dispatch.</span></label>
      <label class="fld"><span>Reason for a status change</span><input class="input" name="reason" maxlength="300" /></label>
      <label class="fld"><span>Location / rack</span><input class="input" name="location" value="${esc(batch.location || '')}" maxlength="80" /></label>
      <label class="fld"><span>Unit cost (₹)</span><input class="input" name="unit_cost" inputmode="decimal" value="${esc(batch.unit_cost ?? '')}" /></label>
      <label class="fld"><span>Manufacturing date</span><input class="input" name="mfg_date" value="${esc(batch.mfg_date || '')}" placeholder="08/2026" autocomplete="off" /></label>
      <label class="fld"><span>Expiry</span><input class="input" name="expiry_date" value="${esc(batch.expiry_date || '')}" placeholder="08/2028 or 31/08/2028" autocomplete="off" />
        <span class="help">A month alone means its last day.</span></label>
      <label class="fld"><span>PO number</span><input class="input mono" name="po_number" value="${esc(batch.po_number || '')}" /></label>
      <label class="fld"><span>GRN number</span><input class="input mono" name="grn_number" value="${esc(batch.grn_number || '')}" /></label>
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000">${esc(batch.notes || '')}</textarea></label>
    </div></section>`;
  } else if (kind === 'import') {
    title = 'Import master SKUs';
    sub = 'Import one row per Master SKU and Product Name. Preview first; nothing is saved until you import.';
    submit = 'Import';
    state.importFile = null; state.importPreview = null;
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>Sheet (.csv or .xlsx)</span><input class="input" type="file" id="impFile" accept=".csv,.xlsx,.txt,text/csv" />
        <span class="help">Two columns: <b>Briyo SKU</b> and <b>Product name</b>. New master SKUs are created and changed product names updated.
        Platform SKUs (Amazon, Blinkit, Zepto…) are not imported — add them on each master SKU afterwards. Any other column is ignored.</span></label>
    </div></section><div id="impResult"></div>`;
  } else if (kind === 'places') {
    title = 'Warehouses & suppliers';
    sub = 'Lists used when receiving stock. Nothing is deleted; switch off what is no longer used.';
    submit = 'Done';
    body = `<section class="dsec"><h3 class="dsec-title">Warehouses</h3>
      <ul class="d-history">${m.warehouses.map((w) => `<li><span>${esc(w.name)}${w.active ? '' : ' <span class="mini-tag">Off</span>'}</span>
        <button type="button" class="linkish" data-toggle-wh="${w.id}" data-active="${w.active}">${w.active ? 'Switch off' : 'Switch on'}</button></li>`).join('')}</ul>
      <div class="attach-new"><input class="input plain" id="newWh" placeholder="New warehouse, e.g. 3PL Warehouse" maxlength="120" /><button type="button" class="btn" id="addWh">Add</button></div>
    </section>
    <section class="dsec"><h3 class="dsec-title">Suppliers</h3>
      <ul class="d-history">${m.suppliers.length ? m.suppliers.map((x) => `<li><span>${esc(x.name)}${x.reference ? ` <span class="soft">· ${esc(x.reference)}</span>` : ''}</span></li>`).join('') : '<li class="soft">None yet. They are also added from Add Inventory.</li>'}</ul>
      <div class="attach-new"><input class="input plain" id="newSup" placeholder="Supplier name" maxlength="120" /><input class="input plain" id="newSupRef" placeholder="Reference (optional)" maxlength="120" /><button type="button" class="btn" id="addSup">Add</button></div>
    </section>`;
  }
  $('#fTitle').textContent = title;
  $('#fSub').textContent = sub;
  $('#fSubmit').textContent = submit;
  f.innerHTML = `<div class="form-error" id="fError" role="alert" hidden></div>${body}`;
  $('#fSaved').textContent = '';
  $('#formDrawer').hidden = false;
  $('#drawerScrim').hidden = false;
  syncScrollLock();
  renderIcons();
  f.querySelector('input:not([readonly]):not([type=file]), select')?.focus();
}
function closeForm() {
  $('#formDrawer').hidden = true;
  if ($('#drawer').hidden) $('#drawerScrim').hidden = true;
  syncScrollLock();
  state.form = null;
}
const formError = (msg) => { const e = $('#fError'); e.textContent = msg; e.hidden = !msg; };

async function uploadDoc(batchId, file, type = 'coa') {
  const res = await fetch(`/api/inventory/batches/${batchId}/documents?type=${encodeURIComponent(type)}`, {
    method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) },
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
}

async function sendSheet(step, file) {
  const res = await fetch(`/api/inventory/import/skus/${step}`, { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) } });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

function renderImportPreview(p) {
  const s = p.summary;
  const stat = (n, label, tone = '') => `<div class="imp-stat ${tone}"><b>${count(n)}</b><span>${esc(label)}</span></div>`;
  const rowsTable = (list, cols) => `<div class="imp-scroll"><table class="imp-errors"><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>
    ${list.map((r) => `<tr>${cols.map((c) => `<td${c[2] ? ' class="mono"' : ''}>${esc(c[1](r) ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const changes = s.mastersNew + s.mastersRenamed;
  $('#impResult').innerHTML = `
    <section class="dsec"><h3 class="dsec-title">Preview <span class="dsec-meta soft">nothing saved yet</span></h3>
      <div class="imp-stats">
        ${stat(s.rows, 'Master SKUs in sheet')}${stat(s.mastersNew, 'New master SKUs')}${stat(s.mastersRenamed, 'Product names changed', s.mastersRenamed ? 'warn' : '')}
        ${stat(s.mastersUnchanged, 'Unchanged')}${stat(s.errorCount, 'Errors', s.errorCount ? 'bad' : '')}${stat(s.warningCount, 'Warnings', s.warningCount ? 'warn' : '')}
      </div>
      ${s.errorCount ? '<p class="imp-note warn-text"><b>Nothing can be imported until every error below is fixed in the sheet.</b> The import is all-or-nothing. Warnings do not block it.</p>' : ''}
    </section>
    ${p.errors.length ? `<section class="dsec"><h3 class="dsec-title">Errors <span class="dsec-meta soft">${count(s.errorCount)} · block the import</span></h3>${rowsTable(p.errors, [['Row', (r) => r.row], ['Value', (r) => r.value, true], ['Problem', (r) => r.reason]])}</section>` : ''}
    ${p.warnings.length ? `<section class="dsec"><h3 class="dsec-title">Warnings <span class="dsec-meta soft">do not block the import</span></h3>${rowsTable(p.warnings, [['Row', (r) => r.row], ['Note', (r) => r.reason]])}</section>` : ''}
    ${p.renamed.length ? `<section class="dsec"><h3 class="dsec-title">Product names that will change</h3>${rowsTable(p.renamed, [['Master SKU', (r) => r.sku, true], ['Now', (r) => r.from], ['Sheet', (r) => r.to]])}</section>` : ''}
    ${p.newMasters.length ? `<section class="dsec"><h3 class="dsec-title">New master SKUs <span class="dsec-meta soft">${count(s.mastersNew)}</span></h3>${rowsTable(p.newMasters, [['Row', (r) => r.row], ['Master SKU', (r) => r.sku, true], ['Product name', (r) => r.name]])}</section>` : ''}`;
  $('#fSubmit').disabled = Boolean(s.errorCount) || !changes;
  $('#fSubmit').textContent = s.errorCount ? 'Fix the errors first' : changes ? 'Import' : 'Nothing new to import';
}

async function refreshMeta() { state.meta = await api('/api/inventory/meta'); }

/**
 * Manual entry: one platform SKU at a time. The server applies every rule
 * (trim, no inner spaces, idempotent, duplicate confirmation); the space
 * check here only gives the same answer without a round trip.
 */
async function addPlatformSku() {
  const input = $('#pfCode');
  const code = input.value.trim();
  const showError = (msg) => { if (msg) $('#dSaved').textContent = ''; $('#pfError').textContent = msg; $('#pfError').hidden = !msg; input.classList.toggle('invalid', Boolean(msg)); };
  showError('');
  if (!code) return showError('Enter the platform SKU.');
  if (/\s/.test(code)) return showError('SKU cannot contain spaces.');
  state.pfPlatform = $('#pfPlatform').value;
  const units = $('#pfUnits').value.trim();
  if (!/^[1-9]\d*$/.test(units)) return showError('Units per listing must be a whole number of at least 1.');
  const req = { skuId: state.detail.sku.id, platform: state.pfPlatform, codes: [code], unitsPerListing: Number(units) };
  $('#pfAdd').disabled = true;
  try {
    const r = await addMapping(req);
    await openSku(req.skuId);
    $('#dSaved').className = 'saved';
    $('#dSaved').textContent = r.added.length ? `Added ${r.added[0]}${r.orderItemsMapped ? ` · ${r.orderItemsMapped} order line${r.orderItemsMapped > 1 ? 's' : ''} now resolve` : ''}` : 'Already mapped to this Master SKU.';
    load();
  } catch (err) {
    if (err.data?.duplicateMapping) return openForm('dup-map', { ...req, dup: err.data.duplicateMapping });
    showError(err.data?.invalidPlatformSku ? 'SKU cannot contain spaces.' : err.message);
  } finally { if ($('#pfAdd')) $('#pfAdd').disabled = false; }
  return null;
}

/** Adds platform SKUs to a master; a duplicate comes back as err.data.duplicateMapping. */
const addMapping = ({ skuId, platform, codes, fromOrder = false, confirmDuplicate = false, reason = '', unitsPerListing }) =>
  api(`/api/inventory/skus/${skuId}/platform-skus`, { method: 'POST', body: JSON.stringify({
    platform, platform_skus: codes, from_order: fromOrder, confirm_duplicate: confirmDuplicate, duplicate_reason: reason, units_per_listing: unitsPerListing }) });

async function submitForm(e) {
  e.preventDefault();
  const { kind, ctx } = state.form;
  // Duplicate platform SKU: "Add anyway" first asks why; it cannot be sent without a reason.
  if (kind === 'dup-map' && $('#dupReasonFld').hidden) {
    $('#dupReasonFld').hidden = false;
    $('#fSubmit').textContent = 'Add with this reason';
    $('#fSubmit').disabled = true;
    $('#dupReason').focus();
    return;
  }
  const f = $('#invForm');
  const v = Object.fromEntries(new FormData(f).entries());
  delete v.coa;
  formError('');
  $('#fSubmit').disabled = true;
  $('#fSaved').textContent = 'Saving…';
  try {
    let openAfter = null;
    if (kind === 'sku') {
      const r = await api('/api/inventory/skus', { method: 'POST', body: JSON.stringify(v) });
      openAfter = r.id;
    } else if (kind === 'edit-sku') {
      const { sku, ...rest } = v;
      await api(`/api/inventory/skus/${state.detail.sku.id}`, { method: 'PATCH', body: JSON.stringify({ ...rest, version: state.detail.sku.version }) });
      openAfter = state.detail.sku.id;
    } else if (kind === 'map') {
      if (!v.sku_id) throw new Error('Choose the master Briyo SKU.');
      if (!/^[1-9]\d*$/.test(String(v.units_per_listing || '').trim())) throw new Error('Units per listing must be a whole number of at least 1.');
      const req = { skuId: Number(v.sku_id), platform: ctx.platform, codes: [ctx.code], fromOrder: true, unitsPerListing: Number(v.units_per_listing) };
      try { await addMapping(req); } catch (err) {
        if (!err.data?.duplicateMapping) throw err;
        return openForm('dup-map', { ...req, dup: err.data.duplicateMapping });
      }
      openAfter = req.skuId;
    } else if (kind === 'dup-map') {
      const reason = String(v.duplicate_reason || '').trim();
      if (!reason) throw new Error('Give a reason before adding the duplicate.');
      const r = await addMapping({ ...ctx, confirmDuplicate: true, reason });
      state.notice = `Added ${r.added.join(', ')} to ${ctx.dup.target.sku} as a duplicate (reason recorded).`;
      openAfter = ctx.skuId;
    } else if (kind === 'import') {
      if (!state.importFile || !state.importPreview || state.importPreview.summary.errorCount) throw new Error('Choose a sheet with no problems in its preview first.');
      const r = await sendSheet('commit', state.importFile);
      state.importResult = r;
      $('#alerts').innerHTML = `<div class="alert ok">${icon('circle-check')}<span>Imported: ${count(r.summary.mastersNew)} new master SKUs, ${count(r.summary.mastersRenamed)} product names updated, ${count(r.summary.mastersUnchanged)} unchanged. Add each product's platform SKUs on its master SKU.</span></div>`;
    } else if (kind === 'receive') {
      const r = await api('/api/inventory/receive', { method: 'POST', body: JSON.stringify({ ...v, request_id: state.form.requestId }) });
      const file = f.coa?.files?.[0];
      if (file) {
        try { await uploadDoc(r.batchId, file, 'coa'); } catch (err) {
          openAfter = Number(v.sku_id);
          $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>Stock was added, but the COA did not upload: ${esc(err.message)} Upload it from the batch.</span></div>`;
        }
      }
      openAfter = Number(v.sku_id);
    } else if (kind === 'adjust' || kind === 'return') {
      await api('/api/inventory/adjust', { method: 'POST', body: JSON.stringify({ ...v, batch_id: ctx.batchId, request_id: state.form.requestId }) });
      openAfter = state.detail.sku.id;
    } else if (kind === 'transfer') {
      await api('/api/inventory/transfer', { method: 'POST', body: JSON.stringify({ ...v, batch_id: ctx.batchId, request_id: state.form.requestId }) });
      openAfter = state.detail.sku.id;
    } else if (kind === 'batch') {
      const batch = state.detail.batches.find((b) => b.id === ctx.batchId);
      if (v.status === batch.status) delete v.status;
      if (v.mfg_date === (batch.mfg_date || '')) delete v.mfg_date;
      if (v.expiry_date === (batch.expiry_date || '')) delete v.expiry_date;
      await api(`/api/inventory/batches/${ctx.batchId}`, { method: 'PATCH', body: JSON.stringify({ ...v, version: batch.version }) });
      openAfter = state.detail.sku.id;
    }
    closeForm();
    await refreshMeta();
    await load();
    if (openAfter) await openSku(openAfter);
    if (state.notice) { $('#dSaved').className = 'saved'; $('#dSaved').textContent = state.notice; state.notice = null; }
  } catch (err) {
    formError(err.message);
  } finally {
    $('#fSubmit').disabled = state.form?.kind === 'dup-map' && !$('#dupReason')?.value.trim();
    $('#fSaved').textContent = '';
  }
}

// ------------------------------------------------------------------ bindings

function fillFilters() {
  $('#fwarehouse').innerHTML = opt('', 'All warehouses') + state.meta.warehouses.map((w) => opt(w.id, w.name)).join('');
  for (const k of ['warehouse', 'status', 'expiring', 'stock']) {
    const el = $(`#f${k}`);
    el.value = state.f[k];
    el.classList.toggle('on', Boolean(state.f[k]));
  }
  $('#flocation').value = state.f.location;
  $('#q').value = state.f.q;
}

function bind() {
  for (const k of ['warehouse', 'status', 'expiring', 'stock']) {
    $(`#f${k}`).addEventListener('change', (e) => { state.f[k] = e.target.value; e.target.classList.toggle('on', Boolean(e.target.value)); writeUrl(); load(); });
  }
  let t;
  for (const [id, k] of [['#q', 'q'], ['#flocation', 'location']]) {
    $(id).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.f[k] = e.target.value.trim(); writeUrl(); load(); }, 250); });
  }
  onLeave(() => clearTimeout(t));
  // Leaving the page with a drawer open must not leave the next page locked.
  onLeave(() => { document.documentElement.classList.remove('scroll-locked'); document.documentElement.style.paddingRight = ''; lockedAt = null; });
  $('#fclear').addEventListener('click', () => { for (const k of FILTERS) state.f[k] = ''; fillFilters(); writeUrl(); load(); });
  $('#cards').addEventListener('click', (e) => {
    const c = e.target.closest('[data-filter]');
    if (!c) return;
    const f = JSON.parse(c.dataset.filter);
    for (const k of FILTERS) state.f[k] = f[k] || '';
    fillFilters(); writeUrl(); load();
  });
  const rowOpen = (e) => { const r = e.target.closest('[data-sku]'); if (r) openSku(Number(r.dataset.sku)); };
  for (const host of [$('#rows'), $('#clist')]) {
    host.addEventListener('click', rowOpen);
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter') rowOpen(e); });
  }
  $('#unmapped').addEventListener('click', (e) => {
    const b = e.target.closest('[data-map]');
    if (b) openForm('map', { code: b.dataset.map, platform: b.dataset.platform, platformLabel: b.dataset.platformLabel, title: b.dataset.title, asin: b.dataset.asin });
  });
  $('#refresh').addEventListener('click', () => { load(); if (state.openSku) openSku(state.openSku); });
  $('#addInventory').addEventListener('click', () => openForm('receive'));
  $('#newSku').addEventListener('click', () => openForm('sku'));
  $('#places').addEventListener('click', () => openForm('places'));
  $('#importSkus').addEventListener('click', () => openForm('import'));
  $('#dBody').addEventListener('keydown', (e) => {
    if (e.target.id === 'pfCode' && e.key === 'Enter') { e.preventDefault(); addPlatformSku(); }
  });
  $('#dBody').addEventListener('input', (e) => {
    if (e.target.id === 'pfCode' && !$('#pfError').hidden) { $('#pfError').hidden = true; e.target.classList.remove('invalid'); }
  });
  $('#invForm').addEventListener('input', (e) => {
    if (e.target.id === 'dupReason') $('#fSubmit').disabled = !e.target.value.trim();
  });
  $('#invForm').addEventListener('change', async (e) => {
    if (e.target.id !== 'impFile') return;
    state.importFile = e.target.files[0] || null;
    state.importPreview = null;
    $('#impResult').innerHTML = state.importFile ? '<p class="soft">Reading the sheet…</p>' : '';
    formError('');
    if (!state.importFile) return;
    try { state.importPreview = await sendSheet('preview', state.importFile); renderImportPreview(state.importPreview); }
    catch (err) { $('#impResult').innerHTML = ''; formError(err.message); }
  });
  $('#dClose').addEventListener('click', closeSku);
  $('#fClose').addEventListener('click', closeForm);
  $('#fCancel').addEventListener('click', closeForm);
  $('#invForm').addEventListener('submit', (e) => {
    if (state.form?.kind === 'places') { e.preventDefault(); return closeForm(); }
    return submitForm(e);
  });
  $('#invForm').addEventListener('click', async (e) => {
    try {
      if (e.target.closest('#addWh')) {
        await api('/api/inventory/warehouses', { method: 'POST', body: JSON.stringify({ name: $('#newWh').value }) });
      } else if (e.target.closest('#addSup')) {
        await api('/api/inventory/suppliers', { method: 'POST', body: JSON.stringify({ name: $('#newSup').value, reference: $('#newSupRef').value }) });
      } else if (e.target.closest('[data-toggle-wh]')) {
        const b = e.target.closest('[data-toggle-wh]');
        const w = state.meta.warehouses.find((x) => x.id === Number(b.dataset.toggleWh));
        await api(`/api/inventory/warehouses/${w.id}`, { method: 'PATCH', body: JSON.stringify({ name: w.name, active: !w.active }) });
      } else return;
      await refreshMeta();
      fillFilters();
      openForm('places');
    } catch (err) { formError(err.message); }
  });
  $('#dBody').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (a) {
      const batchId = a.dataset.batch ? Number(a.dataset.batch) : null;
      return openForm(a.dataset.act === 'receive' ? 'receive' : a.dataset.act, { batchId, skuId: state.detail.sku.id });
    }
    if (e.target.closest('#pfAdd')) { addPlatformSku(); return null; }
    const ch = e.target.closest('[data-units]');
    if (ch) {
      const next = window.prompt(`Units per listing for ${ch.dataset.code}: how many master-SKU units one channel listing represents.`, ch.dataset.current);
      if (next === null || next.trim() === ch.dataset.current) return null;
      try {
        await api(`/api/inventory/platform-skus/${ch.dataset.units}`, { method: 'PATCH', body: JSON.stringify({ units_per_listing: next.trim() }) });
        await openSku(state.detail.sku.id);
        load();
      } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
      return null;
    }
    const un = e.target.closest('[data-unmap]');
    if (un) {
      const lines = Number(un.dataset.lines);
      if (!window.confirm(`Remove platform SKU ${un.dataset.code} from ${state.detail.sku.sku}?${lines ? ` ${lines} order line${lines > 1 ? 's' : ''} will become unmapped again.` : ''}`)) return null;
      try {
        await api(`/api/inventory/platform-skus/${un.dataset.unmap}`, { method: 'DELETE' });
        await openSku(state.detail.sku.id);
        load();
      } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
      return null;
    }
    const rm = e.target.closest('[data-doc-remove]');
    if (rm && window.confirm('Remove this document from the batch? It stays in the audit record.')) {
      try {
        await api(`/api/inventory/batches/${rm.dataset.batch}/documents/${rm.dataset.docRemove}`, { method: 'DELETE' });
        await openSku(state.detail.sku.id);
      } catch (err) { $('#dSaved').textContent = err.message; }
    }
    return null;
  });
  $('#dBody').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-upload]');
    if (!input?.files?.[0]) return;
    const type = $(`[data-upload-type="${input.dataset.upload}"]`)?.value || 'coa';
    $('#dSaved').className = 'saved pending';
    $('#dSaved').textContent = 'Uploading…';
    try {
      await uploadDoc(input.dataset.upload, input.files[0], type);
      $('#dSaved').className = 'saved';
      $('#dSaved').textContent = 'Uploaded';
      await openSku(state.detail.sku.id);
    } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
  });
  const closeTop = () => { if (!$('#formDrawer').hidden) closeForm(); else if (!$('#drawer').hidden) closeSku(); };
  $('#drawerScrim').addEventListener('click', closeTop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTop(); }, { signal: pageSignal() });
  onQueryChange(async () => {
    readUrl();
    fillFilters();
    await load();
    if (state.openSku) openSku(state.openSku); else if (!$('#drawer').hidden) closeSku();
    if (state.view === 'unmapped') $('#unmappedCard')?.scrollIntoView({ block: 'start' });
  });
}

(async function init() {
  try {
    const [me, meta] = await Promise.all([api('/auth/me'), api('/api/inventory/meta')]);
    state.me = me;
    state.meta = meta;
    setTimezone(meta.timezone);  // from the inventory meta: Inventory-only members cannot read the Orders API
    initShell(me);
    readUrl();
    fillFilters();
    bind();
    await load();
    if (state.view === 'unmapped') $('#unmappedCard')?.scrollIntoView({ block: 'start' });
    if (state.openSku) openSku(state.openSku);
  } catch (err) {
    $('#pageSub').textContent = '';
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}());
