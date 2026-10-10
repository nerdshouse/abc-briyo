import { istDate, istDateTime, formatDayKey } from './ui/ist.js';
/**
 * Inventory — stock by SKU and batch, the SKU drawer (batches, COAs, ledger),
 * and the admin forms: new SKU, add inventory, adjust, transfer, batch status,
 * mapping an Amazon seller SKU. Every number comes from /api/inventory; stock
 * is never edited here, only recorded as movements.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dateTime, initShell, pageFetch,
  pageSignal, onLeave, onQueryChange, stateBlock, confirmDialog,
} from './ui/components.js';

const fetch = pageFetch();

const FILTERS = ['q', 'warehouse', 'location', 'status', 'expiring', 'stock'];
let incomingAct = () => null;   // set in bind(): the incoming actions (record, accept/reject, stage, cancel)
const state = {
  me: null, meta: null, data: null, view: '', f: Object.fromEntries(FILTERS.map((k) => [k, ''])),
  openSku: null, detail: null, form: null,
  um: { platform: '', q: '' },   // SKU Mapping worklist filters (this page only)
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
const day = (d) => formatDayKey(d);   // DD-MM-YYYY from the key's own parts
// An order's date (a timestamp), shown as the day it was in India.
const seenDate = (t) => istDate(t);
const amount = (v) => (v === null || v === undefined ? '—' : money(v));
const requestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// Batch status dots reuse the board palette: green sellable, amber held, red stopped, grey empty.
const STATUS = {
  active: ['recovered', 'Active'], quarantined: ['noresp', 'Quarantined'], blocked: ['lost', 'Blocked'],
  expired: ['lost', 'Expired'], depleted: ['new', 'Depleted'],
};
const statusTag = (s) => `<span class="status ${STATUS[s]?.[0] || ''}"><span class="dot"></span>${esc(STATUS[s]?.[1] || s)}</span>`;
/**
 * A batch's expiry, with its state as text beside the colour (never colour alone): near expiry orange (≤ the
 * configured days), expired red, unknown expiry muted amber (no date recorded — never guessed), held grey.
 */
const expiryCell = (b) => {
  const st = b.expiry_state;
  const d = b.days_to_expiry;
  const date = b.expiry_date ? `<span class="${st === 'expired' ? 'exp-bad' : st === 'near_expiry' ? 'exp-warn' : ''}">${esc(day(b.expiry_date))}</span>` : '';
  if (st === 'unknown_expiry') return '<span class="xtag unknown" style="margin-left:0">Unknown expiry</span>';
  if (!b.expiry_date) return '<span class="muted-cell">—</span>';
  if (st === 'expired') return `${date}<span class="xtag expired">Expired</span>`;
  if (st === 'near_expiry') return `${date}<span class="xtag near">Near expiry · ${d === 0 ? 'today' : `${count(d)} d`}</span>`;
  return date;
};
const stockFlag = (r) => (r.out_of_stock ? '<span class="xtag out" style="margin-left:0">Out of stock</span>' : r.low_stock ? '<span class="mini-tag warn">Low stock</span>' : '');
/** Zero is stored as the number 0 and shown as "Nil". */
const nil = (n) => (Number(n) === 0 ? '<span class="nil">Nil</span>' : count(n));
const plural = (n, unit) => `${count(n)} ${unit || 'unit'}${n === 1 ? '' : /(s|x|ch|sh)$/i.test(unit || '') ? 'es' : 's'}`;
const incomingTag = (n) => (n > 0 ? `<span class="xtag incoming">+${count(n)} incoming</span>` : '');
const altLine = (alts) => (alts?.length ? `<span class="alt-line">Alternatives: ${alts.map((a) => `<span class="mono">${esc(a.sku)}</span>${a.variant_name ? ` (${esc(a.variant_name)})` : ''} — ${a.available ? `${count(a.available)} available` : 'Nil'}`).join('; ')}</span>` : '');

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
  // First load: say so in the table (it used to sit empty until the data arrived).
  if (!state.data) $('#rows').innerHTML = `<tr><td colspan="8">${stateBlock('loading', 'Loading stock…', '', { compact: true })}</td></tr>`;
  const u = new URLSearchParams();
  for (const k of FILTERS) if (state.f[k]) u.set(k, state.f[k]);
  try {
    // The forms list every SKU, not just the rows the filters show. That list is reference data (codes, names,
    // active) for the pickers — stock always comes from /api/inventory — so it is fetched once and again only after
    // something that can change it (any save in the forms, alternatives, platform SKUs, Refresh): a filter change
    // makes one request, not two.
    const needSkus = !state.skus || state.skusStale;
    const [data, all] = await Promise.all([api(`/api/inventory?${u}`), needSkus ? api('/api/inventory/skus') : null]);
    state.data = data;
    if (all) { state.skus = all.skus; state.skusStale = false; }
    render();
    $('#alerts').innerHTML = '';
  } catch (err) {
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}

/**
 * The SKU Mapping worklist: unmapped order lines, one row per platform code (every line with that code resolves
 * together). Read-only until a person picks "Map to master SKU" and saves the form — nothing is ever pre-selected.
 */
function renderUnmapped() {
  const all = state.data.unmapped || [];
  const noCode = state.data.unmappedNoCode || [];
  if (!all.length && !noCode.length) {
    $('#unmapped').innerHTML = state.view === 'unmapped' ? '<section class="card"><div class="pane"><div class="empty-note"><b>Every SKU on an order is mapped.</b>Nothing to resolve.</div></div></section>' : '';
    return;
  }
  const lines = all.reduce((n, u) => n + u.lines, 0) + noCode.length;
  const platforms = [...new Map(all.map((u) => [u.channel, u.platform_label])).entries()];
  $('#unmapped').innerHTML = `<section class="card unmapped-card${state.view === 'unmapped' ? ' focus' : ''}" id="unmappedCard">
    <header class="card-head"><h2 class="card-title">${icon('triangle-alert')}SKU mapping <span class="card-meta">${count(lines)} unmapped order line${lines === 1 ? '' : 's'} · ${count(all.length)} platform code${all.length === 1 ? '' : 's'}${noCode.length ? ` · ${count(noCode.length)} without a code` : ''} · those orders cannot be dispatched until mapped</span></h2></header>
    <div class="pane">
      <div class="board-filters um-filters">
        <label class="search">${icon('search')}<input class="input" id="umQ" type="search" autocomplete="off" spellcheck="false" placeholder="Code, product, order, ASIN or listing" aria-label="Search unmapped lines" value="${esc(state.um.q)}"></label>
        <select class="select${state.um.platform ? ' on' : ''}" id="umPlatform" aria-label="Platform"><option value="">All platforms</option>${platforms.map(([k, l]) => `<option value="${esc(k)}"${state.um.platform === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <p class="soft um-note">Mapping a code points every order line with it at the master SKU you choose. Nothing is mapped until you save, and stock is not touched.</p>
      <div class="table-wrap"><table class="table um-table"><thead><tr><th>Platform SKU</th><th>Platform</th><th>Item</th><th>Orders</th><th class="r">Lines</th><th class="r">Units</th><th>Seen</th><th class="r"></th></tr></thead><tbody id="umRows"></tbody></table></div>
      ${noCode.length ? `<h3 class="um-sub">Lines without a SKU code · ${count(noCode.length)}</h3>
      <p class="soft um-note">Nothing to map these by. Fix the product's SKU at the source and re-sync.</p>
      <div class="table-wrap"><table class="table um-table"><thead><tr><th>Order</th><th>Platform</th><th>Item</th><th class="r">Qty</th><th>Line ID</th><th>Ordered</th></tr></thead><tbody>
      ${noCode.map((l) => `<tr><td class="mono">${esc(l.order_ref)}</td><td>${esc(l.platform_label)}</td><td class="um-wrap"><span class="cell-text">${esc(l.title || '—')}</span>${l.asin ? `<span class="cell-sub muted">ASIN ${esc(l.asin)}</span>` : ''}</td>
        <td class="r num">${count(l.quantity)}</td><td class="mono soft">${esc(l.source_line_item_id || '—')}</td><td class="num">${seenDate(l.order_date)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </div></section>`;
  renderUnmappedRows();
}

function renderUnmappedRows() {
  const q = state.um.q.trim().toLowerCase();
  const rows = (state.data.unmapped || []).filter((u) => (!state.um.platform || u.channel === state.um.platform)
    && (!q || [u.code, u.title, ...(u.titles || []), ...(u.order_refs || []), u.asin, ...(u.listing_ids || [])].some((v) => String(v || '').toLowerCase().includes(q))));
  const refs = (u) => { const r = u.order_refs || []; return r.length ? `${r.slice(0, 3).map(esc).join(', ')}${u.orders > 3 ? ` <span class="soft">+${count(u.orders - 3)}</span>` : ''}` : '—'; };
  $('#umRows').innerHTML = rows.length ? rows.map((u) => `<tr><td class="mono um-wrap">${esc(u.code)}${u.asin ? `<span class="cell-sub muted">ASIN ${esc(u.asin)}</span>` : ''}${(u.listing_ids || []).length ? `<span class="cell-sub muted">Listing ${u.listing_ids.map(esc).join(', ')}</span>` : ''}</td>
      <td class="um-plat">${esc(u.platform_label)}</td>
      <td class="um-wrap"><span class="cell-text">${esc(u.title || '—')}</span>${(u.titles || []).length > 1 ? `<span class="cell-sub muted" title="${esc(u.titles.join(' · '))}">${count(u.titles.length)} titles on these lines</span>` : ''}</td>
      <td class="mono um-wrap" title="${esc((u.order_refs || []).join(', '))}">${refs(u)}</td>
      <td class="r num">${count(u.lines)}</td><td class="r num">${count(u.units)}</td>
      <td class="num"><span class="cell-sub" title="First seen">${seenDate(u.first_seen)}</span><span class="cell-sub muted" title="Last seen">to ${seenDate(u.last_seen)}</span></td>
      <td class="r">${!canCatalog() ? '<span class="soft">Ask an Inventory manager</span>'
        : u.mappable ? `<button class="btn" type="button" data-map="${esc(u.code)}" data-platform="${esc(u.channel)}" data-platform-label="${esc(u.platform_label)}" data-title="${esc(u.title || '')}" data-asin="${esc(u.asin || '')}">Map to master SKU</button>`
          : `<span class="soft" title="${esc(u.platform_label)} orders use master SKU codes directly. Create a master SKU with this code, or add ${esc(u.platform_label)} as a platform.">Not a mapped platform</span>`}</td></tr>`).join('')
    : '<tr><td colspan="8"><span class="soft">No unmapped codes match this filter.</span></td></tr>';
}

function render() {
  const { cards: c, rows, unmapped } = state.data;
  const title = state.view === 'unmapped' ? 'Unmapped SKUs' : state.f.stock === 'low' ? 'Low stock' : state.f.stock === 'incoming' ? 'Incoming stock'
    : state.f.stock === 'out' ? 'Out of stock' : state.f.expiring === 'unknown' ? 'Unknown expiry' : state.f.expiring ? 'Expiring stock' : 'Inventory';
  $('#pageTitle').textContent = title;
  $('#crumbHere').textContent = title === 'Inventory' ? 'Stock' : title;
  $('#topTitle').textContent = title;
  document.title = `${title} — Briyo OS`;
  // Units are only added up within one unit type: bottles and sachets never make one "total".
  const units = Object.entries(c.unitTotals || {});
  const mixed = units.length > 1;
  const perUnit = (k) => units.map(([u, t]) => plural(t[k], u)).join(' · ');
  $('#pageSub').textContent = mixed
    ? `${count(c.totalSkus)} active SKUs · available to dispatch: ${perUnit('available')} · ${money(c.inventoryValue)} at cost`
    : `${count(c.totalSkus)} active SKUs · ${count(c.availableUnits)} available to dispatch of ${count(c.onHandUnits)} on hand · ${money(c.inventoryValue)} at cost`
    + (c.unitsWithoutCost ? ` · ${count(c.unitsWithoutCost)} units without a cost` : '');

  const card = (n, label, { tone = '', filter = null, title: tip = '' } = {}) => `<button type="button" class="imp-stat inv-card ${tone}"
      ${filter ? `data-filter='${esc(JSON.stringify(filter))}'` : 'disabled'} title="${esc(tip)}"><b>${typeof n === 'number' ? count(n) : esc(n)}</b><span>${esc(label)}</span></button>`;
  const unitCard = (k, label, opts) => (mixed
    ? `<div class="imp-stat inv-card ${opts.tone || ''}" title="${esc(opts.title || '')}"><b>${units.map(([u, t]) => `<span class="unit-split">${esc(plural(t[k], u))}</span>`).join('')}</b><span>${esc(label)}</span></div>`
    : card(k === 'on_hand' ? c.onHandUnits : k === 'available' ? c.availableUnits : c.reservedSellableUnits, label, opts));
  $('#cards').innerHTML = [
    unitCard('on_hand', 'On hand', { title: 'Physically in stock: every batch, whatever its status' }),
    ...(mixed ? [] : [card(c.sellableUnits, 'Sellable', { title: 'On hand in active, unexpired batches' })]),
    unitCard('reserved', 'Reserved', { title: 'Sellable stock set aside for shipments not yet dispatched' }),
    unitCard('available', 'Available to dispatch', { tone: 'good', title: 'Sellable − reserved' }),
    card(c.expiredUnits, 'Expired', { tone: c.expiredUnits ? 'bad' : '', filter: { status: 'expired' } }),
    card(c.quarantinedUnits + c.blockedUnits, c.blockedUnits ? 'Quarantined / blocked' : 'Quarantined', { tone: c.quarantinedUnits + c.blockedUnits ? 'warn' : '', filter: { status: 'quarantined' },
      title: `${c.quarantinedUnits} quarantined, ${c.blockedUnits} blocked` }),
    card(c.lowStock, 'Low stock SKUs', { tone: c.lowStock ? 'warn' : '', filter: { stock: 'low' }, title: 'Available to dispatch at or under the reorder level' }),
    card(c.outOfStock, 'Out of stock SKUs', { tone: c.outOfStock ? 'bad' : '', filter: { stock: 'out' }, title: 'Nothing available to dispatch' }),
    card(c.nearExpiry, `Near expiry (≤ ${c.nearExpiryDays} d)`, { tone: c.nearExpiry ? 'warn' : '', filter: { expiring: 'near' },
      title: `Batches with stock expiring within ${c.nearExpiryDays} days · ${c.expiring30} within 30, ${c.expiring60} within 60` }),
    card(c.unknownExpiry, 'Unknown expiry', { filter: { expiring: 'unknown' }, title: 'Batches with stock and no expiry date recorded' }),
    card(c.incomingSkus, 'SKUs with incoming', { filter: { stock: 'incoming' }, title: 'Expected stock not yet accepted. Never counted as available.' }),
    card(money(c.inventoryValue), 'Inventory value', { title: 'On hand × unit cost, per batch (all statuses). Not selling price.' }),
  ].join('');
  $('#formula').textContent = mixed ? 'On hand = sellable + expired + quarantined + blocked, and available to dispatch = sellable − reserved, for each unit type. Units of different types are never added together.' : `On hand ${count(c.onHandUnits)} = sellable ${count(c.sellableUnits)} + expired ${count(c.expiredUnits)} + quarantined ${count(c.quarantinedUnits)} + blocked ${count(c.blockedUnits)}.`
    + ` Available to dispatch ${count(c.availableUnits)} = sellable ${count(c.sellableUnits)} − reserved ${count(c.reservedSellableUnits)}.`;

  renderUnmapped();

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
      <td class="r num">${r.empty ? nil(r.sku_available) : nil(r.available)}${stockFlag(r) || r.sku_incoming ? `<span class="cell-sub">${stockFlag(r)}${incomingTag(r.sku_incoming)}</span>` : ''}${altLine(r.alternatives)}</td>
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
      ${r.empty ? `<div class="oi-stat"><span class="soft" style="font-size:12.5px">Available: ${nil(r.sku_available)}</span>${stockFlag(r)}${incomingTag(r.sku_incoming)}</div>${altLine(r.alternatives)}`
        : `<div class="oi-stat"><span class="soft" style="font-size:12.5px">Available: ${nil(r.available)}${r.reserved ? ` · ${count(r.reserved)} reserved` : ''}</span>
        <span style="font-size:12.5px">${expiryCell(r)}</span>${stockFlag(r)}${incomingTag(r.sku_incoming)}</div>${altLine(r.alternatives)}`}
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
  if (!state.detail || state.detail.sku.id !== id) { $('#dTitle').textContent = 'Loading…'; $('#dSub').textContent = ''; $('#dBody').innerHTML = stateBlock('loading', 'Loading…', '', { compact: true }); }
  try {
    state.detail = await api(`/api/inventory/skus/${id}`);
    renderSku();
  } catch (err) {
    $('#dBody').innerHTML = stateBlock('error', 'Could not open this SKU.', err.message, { compact: true });
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
  const { sku: s, batches, movements, reservations, orderLines, alternatives = [], returns = [], incoming = [] } = state.detail;
  $('#dTitle').innerHTML = `<span class="mono">${esc(s.sku)}</span>`;
  $('#dSub').textContent = [s.product_name, s.variant_name, s.category, !s.active && 'Inactive'].filter(Boolean).join(' · ');
  const live = batches.filter((b) => b.on_hand > 0 || b.effective_status !== 'depleted');
  const old = batches.filter((b) => !live.includes(b));
  // CP (with the stock value it gives), SP and MRP — each only when entered; value always comes from CP.
  const priceLine = (b) => {
    const parts = [b.unit_cost !== null && `CP ${esc(money(b.unit_cost))} (value ${esc(money(b.value))})`,
      b.selling_price !== null && `SP ${esc(money(b.selling_price))}`, b.mrp !== null && `MRP ${esc(money(b.mrp))}`].filter(Boolean);
    return parts.length ? `<span class="cell-sub muted price-line">${parts.join(' · ')}</span>` : '';
  };
  const batchRow = (b) => `<tr>
      <td><span class="mono" style="font-weight:500">${esc(b.batch_number)}</span>
        <span class="cell-sub muted">${esc(b.warehouse_name)}${b.location ? ` · ${esc(b.location)}` : ''}</span>
        <span class="cell-sub muted">${[b.mfg_date && `Mfg ${esc(day(b.mfg_date))}`, b.supplier_name ? esc(b.supplier_name) : 'No supplier', b.grn_number && `GRN ${esc(b.grn_number)}`].filter(Boolean).join(' · ')}</span>
        ${priceLine(b)}</td>
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
        <button type="button" class="linkish" data-act="stock-return" data-batch="${b.id}">Return stock</button>
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
        <div class="imp-stat ${s.out_of_stock ? 'bad' : s.low_stock ? 'warn' : 'good'}"><b>${nil(s.available)}</b><span>Available to dispatch (${esc(s.unit_type || 'unit')})</span></div>
      </div>
      <div class="imp-stats stock-cards" style="margin-top:8px">
        <div class="imp-stat ${s.expired ? 'bad' : ''}"><b>${count(s.expired)}</b><span>Expired</span></div>
        <div class="imp-stat ${s.quarantined ? 'warn' : ''}"><b>${count(s.quarantined)}</b><span>Quarantined</span></div>
        <div class="imp-stat ${s.blocked ? 'bad' : ''}"><b>${count(s.blocked)}</b><span>Blocked</span></div>
        <div class="imp-stat"><b>${esc(money(s.value))}</b><span>Value at cost</span></div>
      </div>
      <p class="imp-note">On hand = sellable + expired + quarantined + blocked. Available to dispatch = sellable − reserved.
        ${s.track_inventory ? '' : '<b>Not inventory-tracked:</b> orders for this SKU dispatch without a stock check. '}Reorder level ${count(s.reorder_level)}${s.reorder_quantity ? `, reorder quantity ${count(s.reorder_quantity)}` : ''}.</p>
      ${canMove() || canCatalog() ? `<div class="form-actions">${canMove() ? `<button class="btn primary" type="button" data-act="receive">${icon('plus')}Add inventory</button>
        <button class="btn" type="button" data-act="stock-return">${icon('undo-2')}Return stock</button>
        <button class="btn" type="button" data-act="incoming-new">${icon('truck')}Expect incoming</button>` : ''}
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

    ${incomingSection(incoming, s)}
    ${alternativesSection(alternatives, s)}
    ${returnsSection(returns)}

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

const INCOMING_TONE = { accepted: 'ok', cancelled: 'held' };
/** One expectation: what is due, what arrived, what was accepted, and the next step for an operator. */
function incomingItem(i, { withSku = false } = {}) {
  const facts = [`expected ${plural(i.expected_quantity, i.unit)}`, i.expected_date && `due ${day(i.expected_date)}`, i.supplier_name, i.reference && `ref ${i.reference}`,
    i.batch_number && `batch ${i.batch_number}`].filter(Boolean).map(esc).join(' · ');
  const receipts = (i.receipts || []);
  return `<li>
    <div class="inc-head"><span>${withSku ? `<b class="mono">${esc(i.sku)}</b> · ` : ''}<span class="xtag ${INCOMING_TONE[i.status] || 'incoming'}" style="margin-left:0">${esc(i.status_label)}</span></span>
      <span class="soft">${i.open ? `${plural(i.outstanding, i.unit)} still to come in` : ''}</span></div>
    <div class="soft" style="margin-top:4px">${facts}</div>
    <div class="soft">Received ${count(i.received_quantity)} · accepted ${count(i.accepted_quantity)}${i.rejected_quantity ? ` · turned away ${count(i.rejected_quantity)}` : ''}${i.pending_quantity ? ` · <b>${count(i.pending_quantity)} waiting for acceptance</b>` : ''}${i.cancel_reason ? ` · cancelled: ${esc(i.cancel_reason)}` : ''}</div>
    ${receipts.length ? `<ul class="inc-receipts">${receipts.map((x) => `<li>${count(x.quantity)} in batch <span class="mono">${esc(x.batch_number)}</span> on ${esc(day(x.received_date))}${x.expiry_date ? `, expiry ${esc(day(x.expiry_date))}` : ', expiry unknown'} —
      ${x.status === 'pending' ? `waiting${canMove() ? ` <button type="button" class="linkish" data-inc-act="decide" data-receipt="${x.id}" data-incoming="${i.id}">Accept or reject</button>` : ''}`
        : x.status === 'accepted' ? `accepted ${count(x.accepted_quantity)} by ${esc(x.decided_by || '—')}` : `rejected by ${esc(x.decided_by || '—')}${x.decision_note ? `: ${esc(x.decision_note)}` : ''}`}</li>`).join('')}</ul>` : ''}
    ${canMove() && i.open ? `<div class="inc-actions"><button type="button" class="linkish" data-inc-act="receipt" data-incoming="${i.id}">Record a delivery</button>
      ${['planned', 'ordered', 'in_transit'].includes(i.status) && !i.received_quantity ? `<button type="button" class="linkish" data-inc-act="stage" data-incoming="${i.id}">Change stage</button>` : ''}
      <button type="button" class="linkish" data-inc-act="cancel" data-incoming="${i.id}">Cancel the rest</button></div>` : ''}
  </li>`;
}
function incomingSection(list, s) {
  const open = list.filter((i) => i.open);
  if (!list.length) return '';
  return `<section class="dsec">
    <h3 class="dsec-title">Incoming <span class="dsec-meta soft">${open.length ? `${plural(open.reduce((n, i) => n + i.outstanding, 0), s.unit_type)} expected · not available until accepted` : 'nothing open'}</span></h3>
    <ul class="inc-list">${list.slice(0, 20).map((i) => incomingItem(i)).join('')}</ul>
  </section>`;
}
function alternativesSection(alts, s) {
  if (!alts.length && !canCatalog()) return '';
  const others = (state.skus || []).filter((x) => x.id !== s.id && x.active && !alts.some((a) => a.sku_id === x.id));
  return `<section class="dsec">
    <h3 class="dsec-title">Alternatives <span class="dsec-meta soft">information only — each keeps its own stock; nothing is substituted automatically</span></h3>
    ${alts.length ? `<ul class="d-history">${alts.map((a) => `<li><span><a class="linkish mono" href="#" data-open-sku="${a.sku_id}">${esc(a.sku)}</a> ${esc(a.product_name)}${a.variant_name ? ` · ${esc(a.variant_name)}` : ''}
        ${a.note ? `<span class="soft"> — ${esc(a.note)}</span>` : ''}</span>
      <span class="d-when">${a.available ? `${esc(plural(a.available, a.unit_type))} available` : '<span class="xtag out" style="margin-left:0">Nil</span>'}
        ${canCatalog() ? ` <button type="button" class="linkish" data-alt-remove="${a.id}">Remove</button>` : ''}</span></li>`).join('')}</ul>`
      : '<p class="soft" style="margin:0">No alternatives listed.</p>'}
    ${canCatalog() ? `<div class="alt-add"><select class="select" id="altSku" aria-label="Alternative SKU">${opt('', 'Add an alternative variant…', true)}${others.map((x) => opt(x.id, `${x.sku} — ${x.product_name}${x.variant_name ? ` (${x.variant_name})` : ''}`)).join('')}</select>
      <input class="input" id="altNote" maxlength="300" placeholder="Note (optional)" aria-label="Note about this alternative (optional)" style="flex:1;min-width:140px" /><button type="button" class="btn" id="altAdd">Add</button></div>` : ''}
  </section>`;
}
const CONDITION_TAG = { sellable: '<span class="xtag ok" style="margin-left:0">Sellable</span>', damaged: '<span class="xtag expired" style="margin-left:0">Damaged</span>', quarantined: '<span class="xtag held" style="margin-left:0">Quarantined</span>' };
function returnsSection(list) {
  if (!list.length) return '';
  return `<section class="dsec">
    <h3 class="dsec-title">Returns <span class="dsec-meta soft">${count(list.length)}${list.length >= 50 ? ' (latest 50)' : ''}</span></h3>
    <ul class="d-history">${list.map((r) => `<li><span>${CONDITION_TAG[r.condition] || ''} ${esc(plural(r.quantity, r.unit))} from ${esc(r.returned_by)} <span class="soft">(${esc(state.meta.returnSources?.[r.source] || r.source)})</span> — ${esc(r.reason)}
        <span class="cell-sub muted">into batch <span class="mono">${esc(r.batch_number)}</span>${r.reference ? ` · ref ${esc(r.reference)}` : ''}${r.remarks ? ` · ${esc(r.remarks)}` : ''}</span></span>
      <span class="d-when">${esc(day(r.return_date))} · ${esc(r.recorded_by || '')}</span></li>`).join('')}</ul>
  </section>`;
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
            <span class="mini-tag" title="Units per listing: How many inventory units are represented by one platform listing. An order for 3 of this listing needs 3 × ${count(m.units_per_listing)} = ${count(3 * m.units_per_listing)} inventory units.">Units/listing: ${count(m.units_per_listing)}</span></div>
          <span class="pf-meta soft" title="${esc(`Added ${m.source === 'import' ? 'by import' : m.source === 'migrated' ? 'from the old Amazon field' : m.source === 'unmapped' ? 'from Unmapped platform SKUs' : 'by hand'}${m.created_by ? ` · ${m.created_by}` : ''}`)}">${usage[m.id] ? `${count(usage[m.id])} order line${usage[m.id] === 1 ? '' : 's'}` : ''}</span>
          ${canCatalog() ? `<button type="button" class="linkish pf-remove" data-units="${m.id}" data-current="${m.units_per_listing}" data-code="${esc(m.platform_sku)}" data-platform-label="${esc(g.label)}" aria-label="Edit units per listing for ${esc(g.label)} SKU ${esc(m.platform_sku)}">Edit units</button>` : ''}
          ${canCatalog() ? `<button type="button" class="linkish pf-remove" data-unmap="${m.id}" data-code="${esc(m.platform_sku)}" data-lines="${usage[m.id] || 0}" aria-label="Remove ${esc(g.label)} SKU ${esc(m.platform_sku)}">Remove</button>` : ''}
        </li>`).join('')).join('')}</ul>`
        : '<p class="soft" style="margin:0">No platform SKUs yet. Orders from marketplaces will not resolve to this product until they are added.</p>'}
      ${canCatalog() ? `<div class="pf-add">
        <label class="fld"><span>Platform</span><select class="select" id="pfPlatform">${platforms.filter((p) => p.active).map((p) => opt(p.key, p.label, p.key === state.pfPlatform)).join('')}</select></label>
        <label class="fld"><span>Platform SKU</span><div class="pf-entry">
          <input class="input mono" id="pfCode" placeholder="Enter platform SKU" maxlength="80" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn" id="pfAdd">Add</button></div></label>
        <label class="fld"><span>Units per listing</span><input class="input" id="pfUnits" type="number" min="1" step="1" value="1" inputmode="numeric" />
          <span class="help">How many inventory units are represented by one platform listing.</span></label>
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
        <span class="help">${kind === 'edit-sku' ? 'A master SKU code never changes.' : "Briyo's internal code: letters, numbers, - _ . / and single spaces (FORME COLLAGEN SINGLE SACHET). The website/Shopify uses it as is."}</span></label>
      <label class="fld"><span>Product name</span><input class="input" name="product_name" value="${esc(s.product_name || '')}" required maxlength="200" placeholder="Vitamin D3 2000 IU" /></label>
      <label class="fld"><span>Variant</span><input class="input" name="variant_name" value="${esc(s.variant_name || '')}" maxlength="120" placeholder="60 Capsules" /></label>
      <label class="fld"><span>Category</span><input class="input" name="category" value="${esc(s.category || '')}" maxlength="120" /></label>
      <label class="fld"><span>Unit type</span><input class="input" name="unit_type" value="${esc(s.unit_type || 'bottle')}" maxlength="40" /></label>
      <label class="fld"><span>Status</span><select class="select" name="active">${opt('true', 'Active', s.active !== false)}${opt('false', 'Inactive', s.active === false)}</select></label>
      <label class="fld"><span>Inventory</span><select class="select" name="track_inventory">${opt('true', 'Tracked (physical stock)', s.track_inventory !== false)}${opt('false', 'Not tracked', s.track_inventory === false)}</select>
        <span class="help">Tracked SKUs must have stock reserved before a shipment can be dispatched.</span></label>
      <label class="fld"><span>Reorder level</span><input class="input" name="reorder_level" type="number" inputmode="numeric" step="1" min="0" data-kind="int" value="${esc(s.reorder_level ?? '')}" placeholder="0" /></label>
      <label class="fld"><span>Reorder quantity</span><input class="input" name="reorder_quantity" type="number" inputmode="numeric" step="1" min="0" data-kind="int" value="${esc(s.reorder_quantity ?? '')}" placeholder="0" /></label>
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
          <span class="help">How many inventory units are represented by one platform listing.</span></label>
      </div></section>`;
  } else if (kind === 'units') {
    title = 'Units per listing';
    sub = `${ctx.platformLabel} SKU ${ctx.code} → ${state.detail.sku.sku}`;
    submit = 'Save';
    body = `<section class="dsec"><dl class="kv"><dt>Platform</dt><dd>${esc(ctx.platformLabel)}</dd><dt>Platform SKU</dt><dd class="mono">${esc(ctx.code)}</dd><dt>Master SKU</dt><dd class="mono">${esc(state.detail.sku.sku)}</dd></dl>
      <div class="form-grid" style="margin-top:12px">
        <label class="fld"><span>Units per listing</span><input class="input" name="units_per_listing" type="number" min="1" step="1" value="${esc(ctx.current)}" inputmode="numeric" required />
          <span class="help">How many inventory units are represented by one platform listing. Example: an order for 3 with 2 units per listing needs 6 inventory units. The order's own quantity is not changed.</span></label>
      </div>
      <p class="soft" style="margin:10px 0 0">Not allowed while orders using this SKU have stock reserved or dispatched.</p></section>`;
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
      ${intField('quantity', 'Quantity')}
      ${dateField('mfg_date', 'Manufacturing date')}
      ${dateField('expiry_date', 'Expiry', { monthOption: true, help: 'Leave empty if the batch has no expiry date; it shows as Unknown expiry.' })}
      <div class="price-row wide">
        <label class="fld"><span>Cost Price (CP) ₹</span><input class="input" name="unit_cost" inputmode="decimal" ${MONEY_ATTRS} placeholder="180" />
          <span class="help">Purchase cost per unit paid by Briyo.</span></label>
        <label class="fld"><span>Selling Price (SP) ₹</span><input class="input" name="selling_price" inputmode="decimal" ${MONEY_ATTRS} placeholder="249" />
          <span class="help">Selling price per unit charged to customers.</span></label>
        <label class="fld"><span>Maximum Retail Price (MRP) ₹</span><input class="input" name="mrp" inputmode="decimal" ${MONEY_ATTRS} placeholder="299" />
          <span class="help">Maximum retail price printed on the product packaging.</span></label>
      </div>
      ${dateField('received_date', 'Received date', { value: istToday(), notFuture: true })}
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
      ${intField('quantity', 'Quantity')}
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
      ${intField('quantity', 'Quantity')}
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
      <div class="price-row wide">
        <label class="fld"><span>Cost Price (CP) ₹</span><input class="input" name="unit_cost" inputmode="decimal" ${MONEY_ATTRS} placeholder="180" value="${esc(batch.unit_cost ?? '')}" />
          <span class="help">Purchase cost per unit paid by Briyo.</span></label>
        <label class="fld"><span>Selling Price (SP) ₹</span><input class="input" name="selling_price" inputmode="decimal" ${MONEY_ATTRS} placeholder="249" value="${esc(batch.selling_price ?? '')}" />
          <span class="help">Selling price per unit charged to customers.</span></label>
        <label class="fld"><span>Maximum Retail Price (MRP) ₹</span><input class="input" name="mrp" inputmode="decimal" ${MONEY_ATTRS} placeholder="299" value="${esc(batch.mrp ?? '')}" />
          <span class="help">Maximum retail price printed on the product packaging.</span></label>
      </div>
      ${dateField('mfg_date', 'Manufacturing date', { value: batch.mfg_date || '' })}
      ${dateField('expiry_date', 'Expiry', { value: batch.expiry_date || '', monthOption: true })}
      <label class="fld"><span>PO number</span><input class="input mono" name="po_number" value="${esc(batch.po_number || '')}" /></label>
      <label class="fld"><span>GRN number</span><input class="input mono" name="grn_number" value="${esc(batch.grn_number || '')}" /></label>
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000">${esc(batch.notes || '')}</textarea></label>
    </div></section>`;
  } else if (kind === 'stock-return') {
    title = 'Return stock';
    sub = 'Sellable units go back into the batch they came from. Damaged or quarantined units are held in a batch of their own and are never available.';
    submit = 'Record return';
    const skuSel = ctx.skuId || '';
    const batchesOf = (skuSel && state.detail && Number(state.detail.sku.id) === Number(skuSel)) ? state.detail.batches : [];
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>SKU</span>${skuSel ? `<input type="hidden" name="sku_id" value="${esc(skuSel)}" /><span class="mono">${esc(state.detail.sku.sku)}</span>`
        : `<select class="select" name="sku_id" required>${skuOptions('')}</select><span class="help">To put sellable units back into a batch, open the SKU and use Return stock there (its batches are listed).</span>`}</label>
      <label class="fld"><span>Quantity${skuSel ? ` (${esc(state.detail.sku.unit_type || 'units')})` : ''}</span><input class="input" id="ff-quantity" name="quantity" type="number" inputmode="numeric" step="1" min="1" max="10000000" data-kind="int" required /></label>
      ${dateField('return_date', 'Return date', { value: istToday(), notFuture: true })}
      <label class="fld"><span>Condition</span><select class="select" name="condition" required>${opt('', 'Choose…', true)}${Object.entries(m.returnConditions || {}).map(([k, t]) => opt(k, t)).join('')}</select></label>
      <label class="fld"><span>Batch it came from</span><select class="select" name="batch_id">${opt('', batchesOf.length ? 'Choose the batch' : 'Unknown', !ctx.batchId)}${batchesOf.map((b) => opt(b.id, `${b.batch_number}${b.expiry_date ? ` · exp ${day(b.expiry_date)}` : ' · expiry unknown'} · ${STATUS[b.effective_status]?.[1] || b.effective_status}`, b.id === ctx.batchId)).join('')}</select>
        <span class="help">Required for sellable units. An expired or held batch cannot take sellable units back.</span></label>
      <label class="fld"><span>Returned from</span><select class="select" name="source" required>${opt('', 'Choose…', true)}${Object.entries(m.returnSources || {}).map(([k, t]) => opt(k, t)).join('')}</select></label>
      <label class="fld"><span>Returned by</span><input class="input" name="returned_by" required maxlength="160" placeholder="Person or organisation" /></label>
      <label class="fld wide"><span>Reason</span><input class="input" name="reason" required maxlength="300" placeholder="Customer ordered the wrong flavour" /></label>
      <label class="fld"><span>Order / return reference</span><input class="input mono" name="reference" maxlength="80" /></label>
      <label class="fld wide"><span>Remarks</span><textarea class="input" name="remarks" maxlength="1000" placeholder="Seal intact, inspected by …"></textarea></label>
      <div class="fld wide" id="dupFld" hidden><span>This reference is already recorded for this SKU — say why this is a separate return</span>
        <input class="input" name="duplicate_reason" id="dupReturnReason" maxlength="300" placeholder="Second parcel from the same order" />
        <input type="hidden" name="confirm_duplicate" id="dupConfirm" value="" /></div>
    </div></section>`;
  } else if (kind === 'incoming-new') {
    title = 'Expect incoming stock';
    sub = 'Expected stock is shown as incoming and is never counted as available. It becomes stock only when a delivery is accepted.';
    submit = 'Save expectation';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>SKU</span><select class="select" name="sku_id" required>${skuOptions(ctx.skuId || '')}</select></label>
      ${intField('expected_quantity', 'Expected quantity')}
      ${dateField('expected_date', 'Expected arrival')}
      <label class="fld"><span>Stage</span><select class="select" name="status">${opt('planned', 'Planned', true)}${opt('ordered', 'Ordered')}${opt('in_transit', 'In transit')}</select></label>
      <label class="fld"><span>Supplier</span><input class="input" name="supplier_name" list="supList" maxlength="120" /><datalist id="supList">${m.suppliers.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist></label>
      <label class="fld"><span>PO / reference</span><input class="input mono" name="reference" maxlength="80" /></label>
      <label class="fld"><span>Batch number (if known)</span><input class="input mono" name="batch_number" maxlength="80" /></label>
      ${dateField('mfg_date', 'Manufacturing date (if known)')}
      ${dateField('expiry_date', 'Expiry (if known)', { monthOption: true })}
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000"></textarea></label>
    </div></section>`;
  } else if (kind === 'incoming-list') {
    title = 'Incoming stock';
    sub = 'Open expectations, earliest first. Nothing here is available until a delivery is accepted.';
    submit = 'Done';
    body = `<div class="form-actions" style="margin-bottom:12px"><button type="button" class="btn" data-inc-act="new">${icon('plus')}Expect incoming stock</button></div>
      <ul class="inc-list" id="incList"><li class="soft">Loading…</li></ul>`;
    // With their deliveries, so a waiting delivery can be accepted from here.
    api('/api/inventory/incoming?open=1&receipts=1').then((r) => {
      if (state.form?.kind !== 'incoming-list') return;
      $('#incList').innerHTML = r.incoming.length ? r.incoming.map((i) => incomingItem(i, { withSku: true })).join('') : '<li class="soft">Nothing is expected right now.</li>';
      renderIcons();
    }).catch((err) => { formError(err.message); });
  } else if (kind === 'receipt') {
    const i = ctx.incoming;
    title = 'Record a delivery';
    sub = `${i.sku} · expected ${plural(i.expected_quantity, i.unit)}, ${count(i.received_quantity)} received so far. It waits for acceptance before it becomes stock.`;
    submit = 'Record delivery';
    body = `<section class="dsec"><div class="form-grid">
      ${intField('quantity', 'Quantity received', { value: Math.max(i.expected_quantity - i.received_quantity, 0) || '', unit: i.unit })}
      <label class="fld"><span>Batch number</span><input class="input mono" name="batch_number" maxlength="80" value="${esc(i.batch_number || '')}" required /></label>
      ${dateField('mfg_date', 'Manufacturing date', { value: i.mfg_date || '' })}
      ${dateField('expiry_date', 'Expiry', { value: i.expiry_date || '', monthOption: true, help: 'Leave empty if unknown.' })}
      ${dateField('received_date', 'Received on', { value: istToday(), notFuture: true })}
      <label class="fld"><span>Warehouse</span><select class="select" name="warehouse_id">${wh('')}</select></label>
      <label class="fld wide"><span>Notes</span><textarea class="input" name="notes" maxlength="1000"></textarea></label>
    </div></section>`;
  } else if (kind === 'decide') {
    const x = ctx.receipt;
    title = 'Accept or reject a delivery';
    sub = `${count(x.quantity)} received in batch ${x.batch_number}${x.expiry_date ? `, expiry ${day(x.expiry_date)}` : ', expiry unknown'}. Accepted units are added to stock once; the rest is recorded as turned away.`;
    submit = 'Save decision';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>Decision</span><select class="select" name="decision">${opt('accept', 'Accept into stock', true)}${opt('reject', 'Reject all of it')}</select></label>
      <label class="fld"><span>Quantity accepted</span><input class="input" id="ff-accepted_quantity" name="accepted_quantity" type="number" inputmode="numeric" step="1" min="1" max="${esc(x.quantity)}" data-kind="int" value="${esc(x.quantity)}" />
        <span class="help">Less than received needs a reason below.</span></label>
      <label class="fld wide"><span>Reason / note</span><input class="input" name="note" maxlength="300" placeholder="10 sachets torn" /></label>
    </div></section>`;
  } else if (kind === 'incoming-stage') {
    const i = ctx.incoming;
    title = 'Change stage';
    sub = `${i.sku} · expected ${plural(i.expected_quantity, i.unit)}. Received and accepted follow from deliveries.`;
    submit = 'Save stage';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld"><span>Stage</span><select class="select" name="status" required>${['planned', 'ordered', 'in_transit'].map((k) => opt(k, m.incomingStatuses?.[k] || k, i.status === k)).join('')}</select></label>
    </div></section>`;
  } else if (kind === 'incoming-cancel') {
    const i = ctx.incoming;
    title = 'Cancel the rest';
    sub = `${i.sku} · ${plural(i.outstanding, i.unit)} still to come in. Anything already accepted stays in stock.`;
    submit = 'Cancel the rest';
    body = `<section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>Reason</span><input class="input" name="reason" required maxlength="300" placeholder="Supplier withdrew the order" /></label>
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
      <div class="attach-new"><input class="input plain" id="newWh" placeholder="New warehouse, e.g. 3PL Warehouse" aria-label="New warehouse name" maxlength="120" /><button type="button" class="btn" id="addWh">Add</button></div>
    </section>
    <section class="dsec"><h3 class="dsec-title">Suppliers</h3>
      <ul class="d-history">${m.suppliers.length ? m.suppliers.map((x) => `<li><span>${esc(x.name)}${x.reference ? ` <span class="soft">· ${esc(x.reference)}</span>` : ''}</span></li>`).join('') : '<li class="soft">None yet. They are also added from Add Inventory.</li>'}</ul>
      <div class="attach-new"><input class="input plain" id="newSup" placeholder="Supplier name" aria-label="New supplier name" maxlength="120" /><input class="input plain" id="newSupRef" placeholder="Reference (optional)" aria-label="Supplier reference (optional)" maxlength="120" /><button type="button" class="btn" id="addSup">Add</button></div>
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
function closeForm({ force = false } = {}) {
  if (!force && state.form?.dirty && !window.confirm('Discard what you have entered?')) return;
  $('#formDrawer').hidden = true;
  if ($('#drawer').hidden) $('#drawerScrim').hidden = true;
  syncScrollLock();
  state.form = null;
}
const formError = (msg) => { const e = $('#fError'); e.textContent = msg; e.hidden = !msg; };

/*
 * Form controls. Dates are native date pickers (typing still works): their value is the calendar date
 * 'YYYY-MM-DD' exactly as chosen, sent as text — never through a JS Date, so no timezone can move it. An expiry
 * may be month-only, as printed on a label: the picker then switches to a month and the server stores that
 * month's last day. Quantities are whole numbers, amounts have at most two decimals. The checks below only
 * point at the field before anything is sent; the server checks everything again.
 */
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const fieldId = (name) => `ff-${name}`;
function dateField(name, label, { value = '', required = false, notFuture = false, monthOption = false, help = '', wide = false } = {}) {
  const monthOnly = monthOption && /^\d{4}-\d{2}$/.test(value);
  // A div, not a label: the month-only switch has its own label, and labels never nest.
  return `<div class="fld${wide ? ' wide' : ''}"><span><label for="${fieldId(name)}">${esc(label)}</label>${required ? '' : ' <span class="opt">optional</span>'}</span>
    <input class="input" id="${fieldId(name)}" name="${name}" type="${monthOnly ? 'month' : 'date'}" value="${esc(value)}" data-kind="date"${required ? ' required' : ''}${notFuture ? ` max="${istToday()}"` : ''} />
    ${monthOption ? `<span class="month-only"><input type="checkbox" data-month-for="${name}"${monthOnly ? ' checked' : ''} id="${fieldId(name)}-m" /><label for="${fieldId(name)}-m">Label shows a month only (stored as the month's last day)</label></span>` : ''}
    ${help ? `<span class="help">${help}</span>` : ''}</div>`;
}
function intField(name, label, { value = '', required = true, min = 1, max = 10000000, help = '', unit = '' } = {}) {
  return `<label class="fld"><span>${esc(label)}${unit ? ` (${esc(unit)})` : ''}${required ? '' : ' <span class="opt">optional</span>'}</span>
    <input class="input" id="${fieldId(name)}" name="${name}" type="number" inputmode="numeric" step="1" min="${min}" max="${max}" value="${esc(value)}" data-kind="int"${required ? ' required' : ''} />
    ${help ? `<span class="help">${help}</span>` : ''}</label>`;
}
const MONEY_ATTRS = 'type="number" min="0" step="0.01" data-kind="money"';
const labelOf = (el) => (el.closest('.fld')?.querySelector(':scope > span')?.childNodes[0]?.textContent || el.name).trim();
/** The first problem in the form, marked on its field; '' when there is none. */
function checkFields(form) {
  let first = null; let msg = '';
  for (const el of form.querySelectorAll('input[data-kind], select[required], input[required], textarea[required]')) {
    if (el.disabled || el.type === 'hidden') continue;
    const v = el.value.trim(); const name = labelOf(el);
    let bad = '';
    if (el.validity?.badInput) bad = el.dataset.kind === 'date' ? `${name}: choose a valid date.` : el.dataset.kind === 'money' ? `${name} must be an amount like 180 or 175.50.` : `${name} must be a whole number.`;
    else if (!v && el.required) bad = `${name} is required.`;
    else if (v && el.dataset.kind === 'int' && !/^\d+$/.test(v)) bad = `${name} must be a whole number.`;
    else if (v && el.dataset.kind === 'int' && Number(v) < Number(el.min || 0)) bad = `${name} must be at least ${el.min}.`;
    else if (v && el.dataset.kind === 'int' && Number(v) > Number(el.max || Infinity)) bad = `${name} is too large.`;
    else if (v && el.dataset.kind === 'money' && !/^\d+(\.\d{1,2})?$/.test(v)) bad = `${name} must be an amount like 180 or 175.50.`;
    else if (v && el.dataset.kind === 'date' && el.max && v > el.max) bad = `${name} cannot be in the future.`;
    el.toggleAttribute('aria-invalid', Boolean(bad));
    if (bad) el.setAttribute('aria-describedby', 'fError'); else el.removeAttribute('aria-describedby');
    if (bad && !first) { first = el; msg = bad; }
  }
  if (first) first.focus();
  return msg;
}

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

// Stock cutover: orders placed before it are historical and never reserve or consume stock.
const CUT_FMT = { format: (d) => istDateTime(d).replace(/ IST$/, '') };   // " IST" is appended where shown
async function renderCutover() {
  const el = $('#cutover');
  try {
    const c = await api('/api/inventory/cutover');
    state.cutover = c;
    el.innerHTML = `<b>Stock cutover:</b> ${c.cutover_at
      ? `${esc(CUT_FMT.format(new Date(c.cutover_at)))} IST — orders placed before this are historical and never reserve or use stock.`
      : 'not set — every order takes part in stock.'}${canCatalog() ? ` <button type="button" class="linkish" id="cutoverEdit">${c.cutover_at ? 'Change' : 'Set'}</button>` : ''}`;
  } catch (err) { el.textContent = `Stock cutover: ${err.message}`; }
}
async function editCutover() {
  const cur = state.cutover;
  const input = window.prompt('Stock cutover, in IST, as YYYY-MM-DD HH:MM (e.g. 2026-10-15 00:00). Type CLEAR to remove it.', '');
  if (input === null) return;
  const v = input.trim();
  let iso = null;
  if (v.toUpperCase() !== 'CLEAR') {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/.exec(v);
    if (!m) { window.alert('Use YYYY-MM-DD HH:MM, e.g. 2026-10-15 00:00.'); return; }
    iso = `${m[1]}T${m[2]}:${m[3]}:00+05:30`;
  }
  const was = cur.cutover_at ? `${CUT_FMT.format(new Date(cur.cutover_at))} IST` : 'not set';
  const to = iso ? `${CUT_FMT.format(new Date(iso))} IST` : 'not set';
  if (!window.confirm(`Change the stock cutover from ${was} to ${to}?\n\nOrders placed before the cutover will never reserve or use stock.`)) return;
  try {
    await api('/api/inventory/cutover', { method: 'PUT', body: JSON.stringify({ cutover_at: iso, confirm: true, version: cur.version }) });
  } catch (err) { window.alert(err.message); }
  renderCutover();
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
  // Sent as typed: the API validates it (a whole number, at least 1) and its message is shown.
  const req = { skuId: state.detail.sku.id, platform: state.pfPlatform, codes: [code], unitsPerListing: $('#pfUnits').value.trim() };
  $('#pfAdd').disabled = true;
  try {
    const r = await addMapping(req);
    await openSku(req.skuId);
    $('#dSaved').className = 'saved';
    $('#dSaved').textContent = r.added.length ? `Added ${r.added[0]}${r.orderItemsMapped ? ` · ${r.orderItemsMapped} order line${r.orderItemsMapped > 1 ? 's' : ''} now resolve` : ''}` : 'Already mapped to this Master SKU.';
    state.skusStale = true; load();
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
  if (state.submitting) return;
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
  // Point at the field first; nothing is sent while a field is invalid (the server checks again regardless).
  const problem = checkFields(f);
  formError(problem);
  if (problem) return;
  const v = Object.fromEntries(new FormData(f).entries());
  delete v.coa;
  $('#fSubmit').disabled = true;
  state.submitting = true;
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
      const req = { skuId: Number(v.sku_id), platform: ctx.platform, codes: [ctx.code], fromOrder: true, unitsPerListing: String(v.units_per_listing ?? '').trim() };
      try { await addMapping(req); } catch (err) {
        if (!err.data?.duplicateMapping) throw err;
        return openForm('dup-map', { ...req, dup: err.data.duplicateMapping });
      }
      openAfter = req.skuId;
    } else if (kind === 'units') {
      await api(`/api/inventory/platform-skus/${ctx.mappingId}`, { method: 'PATCH', body: JSON.stringify({ units_per_listing: String(v.units_per_listing ?? '').trim() }) });
      state.notice = `Units per listing for ${ctx.code} saved.`;
      openAfter = state.detail.sku.id;
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
    } else if (kind === 'stock-return') {
      try {
        await api('/api/inventory/returns', { method: 'POST', body: JSON.stringify({ ...v, batch_id: v.batch_id || null, request_id: state.form.requestId }) });
      } catch (err) {
        // The same reference again: say so, ask for a reason, and send again only with it.
        if (err.data?.duplicate && $('#dupFld').hidden) { $('#dupFld').hidden = false; $('#dupConfirm').value = 'true'; $('#dupReturnReason').focus(); }
        throw err;
      }
      state.notice = 'Return recorded.';
      openAfter = Number(v.sku_id);
    } else if (kind === 'incoming-new') {
      await api('/api/inventory/incoming', { method: 'POST', body: JSON.stringify(v) });
      state.notice = 'Incoming stock recorded. It is not available until a delivery is accepted.';
      openAfter = Number(v.sku_id);
    } else if (kind === 'incoming-list') {
      closeForm({ force: true });
      return;
    } else if (kind === 'receipt') {
      await api(`/api/inventory/incoming/${ctx.incoming.id}/receipts`, { method: 'POST', body: JSON.stringify({ ...v, request_id: state.form.requestId }) });
      state.notice = 'Delivery recorded. Accept it to add it to stock.';
      openAfter = ctx.incoming.sku_id;
    } else if (kind === 'incoming-stage') {
      await api(`/api/inventory/incoming/${ctx.incoming.id}`, { method: 'PATCH', body: JSON.stringify({ status: v.status, version: ctx.incoming.version }) });
      state.notice = 'Stage saved.';
      openAfter = state.openSku || null;
    } else if (kind === 'incoming-cancel') {
      await api(`/api/inventory/incoming/${ctx.incoming.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: v.reason }) });
      state.notice = 'The rest is cancelled. Accepted stock stays.';
      openAfter = state.openSku || null;
    } else if (kind === 'decide') {
      const r = await api(`/api/inventory/incoming/receipts/${ctx.receipt.id}/decision`, { method: 'POST', body: JSON.stringify(v) });
      state.notice = r.status === 'accepted' ? `${count(r.acceptedQuantity)} accepted into stock.` : 'Delivery rejected.';
      openAfter = ctx.skuId;
    } else if (kind === 'transfer') {
      await api('/api/inventory/transfer', { method: 'POST', body: JSON.stringify({ ...v, batch_id: ctx.batchId, request_id: state.form.requestId }) });
      openAfter = state.detail.sku.id;
    } else if (kind === 'batch') {
      const batch = state.detail.batches.find((b) => b.id === ctx.batchId);
      if (v.status === batch.status) delete v.status;
      // Shown as DD-MM-YYYY; unchanged when it still reads the same date.
      if (v.mfg_date === (batch.mfg_date || '')) delete v.mfg_date;
      if (v.expiry_date === (batch.expiry_date || '')) delete v.expiry_date;
      await api(`/api/inventory/batches/${ctx.batchId}`, { method: 'PATCH', body: JSON.stringify({ ...v, version: batch.version }) });
      openAfter = state.detail.sku.id;
    }
    closeForm({ force: true });
    state.skusStale = true;
    await refreshMeta();
    await load();
    if (openAfter) await openSku(openAfter);
    if (state.notice) { $('#dSaved').className = 'saved'; $('#dSaved').textContent = state.notice; state.notice = null; }
  } catch (err) {
    formError(err.message);
  } finally {
    state.submitting = false;
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
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || (e.key === ' ' && e.target.matches('[data-sku]'))) { if (e.key === ' ') e.preventDefault(); rowOpen(e); } });
  }
  $('#unmapped').addEventListener('input', (e) => {
    if (e.target.id === 'umQ') { state.um.q = e.target.value; renderUnmappedRows(); }
  });
  $('#unmapped').addEventListener('change', (e) => {
    if (e.target.id === 'umPlatform') { state.um.platform = e.target.value; e.target.classList.toggle('on', Boolean(e.target.value)); renderUnmappedRows(); }
  });
  $('#unmapped').addEventListener('click', (e) => {
    const b = e.target.closest('[data-map]');
    if (b) openForm('map', { code: b.dataset.map, platform: b.dataset.platform, platformLabel: b.dataset.platformLabel, title: b.dataset.title, asin: b.dataset.asin });
  });
  $('#refresh').addEventListener('click', () => { state.skusStale = true; load(); if (state.openSku) openSku(state.openSku); });
  $('#addInventory').addEventListener('click', () => openForm('receive'));
  $('#returnStock').addEventListener('click', () => openForm('stock-return'));
  $('#incomingBtn').addEventListener('click', () => openForm('incoming-list'));
  // Incoming actions, from the SKU drawer and from the Incoming list.
  incomingAct = async (b) => {
    const act = b.dataset.incAct;
    if (act === 'new') return openForm('incoming-new', {});
    const id = Number(b.dataset.incoming);
    try {
      const { incoming } = await api(`/api/inventory/incoming/${id}`);
      if (act === 'receipt') return openForm('receipt', { incoming });
      if (act === 'decide') return openForm('decide', { receipt: incoming.receipts.find((x) => x.id === Number(b.dataset.receipt)), skuId: incoming.sku_id });
      // Stage and cancel are labelled forms in the drawer (they were browser prompts).
      if (act === 'stage') return openForm('incoming-stage', { incoming });
      if (act === 'cancel') return openForm('incoming-cancel', { incoming });
    } catch (err) {
      if (state.form) formError(err.message); else { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
    }
    return null;
  };
  $('#invForm').addEventListener('click', (e) => { const b = e.target.closest('[data-inc-act]'); if (b) { e.preventDefault(); incomingAct(b); } });
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
    // Something typed: closing now asks before discarding it.
    if (state.form && e.target.name && !e.target.closest('[data-no-dirty]')) state.form.dirty = true;
    if (e.target.id === 'dupReason') $('#fSubmit').disabled = !e.target.value.trim();
    // Editing a field marked wrong clears its mark; the message goes when nothing is marked any more.
    if (e.target.hasAttribute('aria-invalid')) {
      e.target.removeAttribute('aria-invalid'); e.target.removeAttribute('aria-describedby');
      if (!$('#invForm [aria-invalid]')) formError('');
    }
  });
  // "Label shows a month only": the expiry picker becomes a month picker (and back), keeping what was chosen.
  $('#invForm').addEventListener('change', (e) => {
    const name = e.target.dataset?.monthFor;
    if (!name) return;
    const input = $(`#invForm [name="${name}"]`);
    const v = input.value;
    if (e.target.checked) { input.type = 'month'; input.value = v ? v.slice(0, 7) : ''; } else { input.type = 'date'; input.value = /^\d{4}-\d{2}$/.test(v) ? '' : v; }
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
    if (state.form?.kind === 'places') { e.preventDefault(); return closeForm({ force: true }); }
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
    const ia = e.target.closest('[data-inc-act]');
    if (ia) return incomingAct(ia);
    const os = e.target.closest('[data-open-sku]');
    if (os) { e.preventDefault(); return openSku(Number(os.dataset.openSku)); }
    if (e.target.closest('#altAdd')) {
      try {
        await api(`/api/inventory/skus/${state.detail.sku.id}/alternatives`, { method: 'POST', body: JSON.stringify({ alternative_sku_id: $('#altSku').value, note: $('#altNote').value }) });
        state.skusStale = true; await openSku(state.detail.sku.id); load();
      } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
      return null;
    }
    const ar = e.target.closest('[data-alt-remove]');
    if (ar) {
      try { await api(`/api/inventory/alternatives/${ar.dataset.altRemove}`, { method: 'DELETE' }); await openSku(state.detail.sku.id); load(); } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
      return null;
    }
    const a = e.target.closest('[data-act]');
    if (a) {
      const batchId = a.dataset.batch ? Number(a.dataset.batch) : null;
      return openForm(a.dataset.act === 'receive' ? 'receive' : a.dataset.act, { batchId, skuId: state.detail.sku.id });
    }
    if (e.target.closest('#pfAdd')) { addPlatformSku(); return null; }
    const ch = e.target.closest('[data-units]');
    if (ch) return openForm('units', { mappingId: ch.dataset.units, code: ch.dataset.code, platformLabel: ch.dataset.platformLabel, current: ch.dataset.current });
    const un = e.target.closest('[data-unmap]');
    if (un) {
      const lines = Number(un.dataset.lines);
      if (!(await confirmDialog({ title: `Remove platform SKU ${un.dataset.code}?`, danger: true, confirmLabel: 'Remove',
        body: `It stops pointing at ${state.detail.sku.sku}.${lines ? ` ${lines} order line${lines > 1 ? 's' : ''} will become unmapped again.` : ''}` }))) return null;
      try {
        await api(`/api/inventory/platform-skus/${un.dataset.unmap}`, { method: 'DELETE' });
        state.skusStale = true;
        await openSku(state.detail.sku.id);
        load();
      } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
      return null;
    }
    const rm = e.target.closest('[data-doc-remove]');
    if (rm && await confirmDialog({ title: 'Remove this document from the batch?', body: 'It stays in the audit record.', danger: true, confirmLabel: 'Remove' })) {
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
    renderCutover();
    $('#cutover').addEventListener('click', (e) => { if (e.target.closest('#cutoverEdit')) editCutover(); });
    if (state.view === 'unmapped') $('#unmappedCard')?.scrollIntoView({ block: 'start' });
    if (state.openSku) openSku(state.openSku);
  } catch (err) {
    $('#pageSub').textContent = '';
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}());
