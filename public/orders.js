/**
 * Orders & Logistics — All orders, channel tabs, the logistics queues, the
 * order drawer and manual create/edit. Everything reads /api/orders; channels,
 * couriers and statuses come from /api/orders/meta, never from this file.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dateShort, dateTime, initShell, pageFetch,
  navigate, pageSignal, onLeave, onQueryChange, ordersMeta,
} from './ui/components.js';

// Requests belong to this page: cancelled, and never rendered, once it is left.
const fetch = pageFetch();

const LABEL_OVERRIDES = {
  rto: 'RTO', not_ready: 'Not ready', cod: 'COD', third_party: 'Third party',
  dispatch_product_image: 'Dispatch Product Image',
  tax_invoice: 'Tax Invoice', courier_receipt: 'Courier Receipt', marketplace_invoice: 'Marketplace Invoice',
  credit_note: 'Credit Note', other: 'Other',
};
const label = (v) => (v ? LABEL_OVERRIDES[v] || (v[0].toUpperCase() + v.slice(1)).replaceAll('_', ' ') : '—');

// Dot colours reuse the board's status palette: grey waiting, amber in hand,
// blue moving, green done, red stopped.
const DOT = {
  new: 'new', confirmed: 'callback', completed: 'recovered', cancelled: 'lost',
  not_ready: 'new', packed: 'noresp', dispatched: 'callback', in_transit: 'callback',
  out_for_delivery: 'callback', delivered: 'recovered', delivery_failed: 'lost', rto: 'lost',
};
const indicator = (v) => `<span class="status ${DOT[v] || ''}"><span class="dot"></span>${esc(label(v))}</span>`;
const NO_SHIPMENT = '<span class="status none" title="Not in any shipment yet"><span class="dot"></span>No shipment yet</span>';
const shipIndicator = (o) => (o.shipment_id ? indicator(o.shipment_status) : NO_SHIPMENT);
// Only an order with no shipment, not cancelled, can be ticked for a new one.
const pickable = (o) => !o.shipment_id && o.order_status !== 'cancelled';
const pickBox = (o) => (pickable(o) ? `<label class="pick" title="Choose for a shipment"><input type="checkbox" data-pick="${o.id}"${state.sel.has(o.id) ? ' checked' : ''} aria-label="Choose order ${esc(o.source_order_id)}" /></label>` : '');

// The usual next move from each shipment state. Anything else is in the select.
const NEXT_STEPS = {
  not_ready: ['packed'],
  packed: ['dispatched'],
  dispatched: ['in_transit'],
  in_transit: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered', 'delivery_failed'],
  delivery_failed: ['out_for_delivery', 'rto'],
};
const STEP_TEXT = {
  packed: 'Mark packed', dispatched: 'Mark dispatched', in_transit: 'In transit',
  out_for_delivery: 'Out for delivery', delivered: 'Mark delivered', delivery_failed: 'Delivery failed', rto: 'Mark RTO',
};

const PAGE = 100;
const FILTER_KEYS = ['q', 'channel', 'destination', 'status', 'shipment', 'courier', 'invoice', 'tracking', 'from', 'to'];

const state = {
  meta: null,
  type: '',          // dispatch type tab: '' = all
  view: '',
  f: Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])),
  orders: [],
  total: 0,
  offset: 0,
  openId: null,
  detail: null,
  editing: null,
  retry: null,       // uploads that failed, kept (with their files) for Retry
  sel: new Map(),    // orders ticked for one new shipment: id → order
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

// Value and date are optional on an order: unknown shows as a dash, never ₹0.
const amount = (v) => (v === null || v === undefined ? '—' : money(v));
const day = (iso) => (iso ? dateShort(iso) : '—');

const channelLabel = (key) => state.meta.channels.find((c) => c.key === key)?.label || key;
const typeLabel = (key) => state.meta.dispatchTypes.find((t) => t.key === key)?.label || (key ? label(key) : 'No type');
const destinationName = (id) => state.meta.destinations.find((d) => d.id === Number(id))?.name || (id ? `#${id}` : '—');
/** Channels used for a dispatch type (all channels when none is chosen). */
const channelsFor = (type) => state.meta.channels.filter((c) => c.active
  && (!type || !c.dispatch_types?.length || c.dispatch_types.includes(type)));
const destinationsFor = (channel, type) => state.meta.destinations
  .filter((d) => d.active && (!channel || d.channel === channel) && (!type || d.dispatch_type === type));
const courierById = (id) => state.meta.couriers.find((c) => c.id === Number(id));

/* ------------------------------------------------------------------ URL state */

function readUrl() {
  const u = new URLSearchParams(window.location.search);
  state.type = u.get('type') || '';
  state.view = u.get('view') || '';
  for (const k of FILTER_KEYS) state.f[k] = u.get(k) || '';
  const open = u.get('open');
  state.openId = open && /^\d+$/.test(open) ? Number(open) : null;
}

function writeUrl() {
  const u = new URLSearchParams();
  if (state.type) u.set('type', state.type);
  if (state.view) u.set('view', state.view);
  for (const k of FILTER_KEYS) if (state.f[k]) u.set(k, state.f[k]);
  if (state.openId) u.set('open', state.openId);
  const qs = u.toString();
  // Filters and the open order refine the current entry; history.state carries
  // the scroll position for Back, so it is kept.
  history.replaceState(history.state, '', qs ? `/orders?${qs}` : '/orders');
}

/**
 * The URL for this list under another dispatch-type tab. A channel or
 * destination that does not belong to the new type is dropped with it.
 */
function typeUrl(type) {
  const u = new URL(window.location.href);
  if (type) u.searchParams.set('type', type); else u.searchParams.delete('type');
  const ch = u.searchParams.get('channel');
  if (type && ch && !channelsFor(type).some((c) => c.key === ch)) u.searchParams.delete('channel');
  const dest = state.meta.destinations.find((d) => d.id === Number(u.searchParams.get('destination')));
  if (type && dest && dest.dispatch_type !== type) u.searchParams.delete('destination');
  u.searchParams.delete('open');
  return u.pathname + u.search;
}

/* ------------------------------------------------------------------ list */

const ordersUrl = (append) => {
  const u = new URLSearchParams();
  if (state.type) u.set('type', state.type);
  if (state.view) u.set('view', state.view);
  for (const k of FILTER_KEYS) if (state.f[k]) u.set(k, state.f[k]);
  u.set('limit', PAGE);
  u.set('offset', append ? state.offset : 0);
  return `/api/orders?${u}`;
};

/** `pending` is an orders request already in flight (the first load starts it early). */
async function load({ append = false, pending = null } = {}) {
  try {
    const data = await (pending || api(ordersUrl(append)));
    state.orders = append ? [...state.orders, ...data.orders] : data.orders;
    state.offset = state.orders.length;
    state.total = data.total;
    renderHead(data);
    renderTabs(data);
    renderRows();
    $('#alerts').innerHTML = '';
  } catch (err) {
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}

function renderHead(data) {
  const view = state.view && state.meta.views[state.view];
  const here = view || [state.type && typeLabel(state.type), state.f.channel && channelLabel(state.f.channel)].filter(Boolean).join(' · ');
  const title = view || (here ? `${here} orders` : 'All orders');
  $('#pageTitle').textContent = title;
  $('#crumbGroup').textContent = view ? 'Logistics' : 'Orders';
  $('#crumbHere').textContent = here || 'All orders';
  $('#topTitle').textContent = title;
  document.title = `${title} — Briyo`;
  // Only entered values are summed; say how many have none rather than imply ₹0.
  const valued = data.total - data.withoutValue;
  $('#pageSub').textContent = `${count(data.total)} ${data.total === 1 ? 'order' : 'orders'}`
    + (valued ? ` · ${money(data.totalValue)} order value` : '')
    + (data.withoutValue && data.total ? ` · ${count(data.withoutValue)} without a value` : '');
  $('#resultNote').textContent = anyFilter()
    ? `Showing ${count(state.orders.length)} of ${count(data.total)} matching the filters`
    : `Showing ${count(state.orders.length)} of ${count(data.total)}, newest order date first`;
  $('#fclear').hidden = !anyFilter();
  $('#more').hidden = state.orders.length >= data.total;
}

const anyFilter = () => FILTER_KEYS.some((k) => state.f[k]);

function renderTabs(data) {
  const tabs = [{ key: '', label: 'All', n: data.allCount },
    ...state.meta.dispatchTypes.map((t) => ({ key: t.key, label: t.label, n: data.typeCounts[t.key] || 0 }))];
  // Orders from before dispatch types (on a two-type channel) get their own tab until sorted.
  if (data.typeCounts.none) tabs.push({ key: 'none', label: 'No type', n: data.typeCounts.none });
  $('#channelTabs').innerHTML = tabs.map((t) => `<button type="button" role="tab" class="tab${t.key === state.type ? ' active' : ''}"
      data-type="${esc(t.key)}" aria-selected="${t.key === state.type}">${esc(t.label)}<span class="tab-count">${count(t.n)}</span></button>`).join('');
  // The channel and destination pickers follow the tab.
  const chans = state.type === 'none' ? state.meta.channels : channelsFor(state.type);
  $('#fchannel').innerHTML = opt('', 'All channels') + chans.map((c) => opt(c.key, `${c.label}${data.channelCounts[c.key] ? ` (${data.channelCounts[c.key]})` : ''}`, c.key === state.f.channel)).join('');
  const dests = destinationsFor(state.f.channel, state.type === 'none' ? '' : state.type);
  $('#fdest').innerHTML = opt('', 'All destinations') + dests.map((d) => opt(d.id, state.f.channel ? d.name : `${d.channel_label} · ${d.name}`, String(d.id) === state.f.destination)).join('');
  $('#fdest').hidden = !dests.length;
  $('#fchannel').classList.toggle('on', Boolean(state.f.channel));
  $('#fdest').classList.toggle('on', Boolean(state.f.destination));
}

function trackingCell(o) {
  if (!o.tracking_id) return '<span class="muted-cell">—</span>';
  const more = (o.orders_in_shipment > 1 ? ` <span class="mini-tag" title="${o.orders_in_shipment} orders travel in this shipment">${o.orders_in_shipment} orders</span>` : '')
    + (!o.in_shared_shipment && o.shipment_count > 1 ? ` <span class="mini-tag" title="${o.shipment_count} shipments on this order">+${o.shipment_count - 1}</span>` : '');
  return (o.tracking_url
    ? `<a class="track-link mono" href="${esc(o.tracking_url)}" target="_blank" rel="noopener noreferrer" title="Open the courier's tracking page">${esc(o.tracking_id)}</a>`
    : `<span class="mono">${esc(o.tracking_id)}</span>`) + more;
}

/** Compact proof summary: dispatch photo count and whether the tax invoice is in. */
function proofCell(o) {
  const photos = o.dispatch_image_count
    ? `<span class="proof-n" title="${o.dispatch_image_count} dispatch photo${o.dispatch_image_count === 1 ? '' : 's'}">${icon('camera')}${o.dispatch_image_count}</span>` : '';
  const inv = o.has_invoice ? `<span class="yes" title="Tax invoice uploaded">Inv${icon('check')}</span>` : '';
  return photos || inv ? `<span class="proof">${photos}${inv}</span>` : '<span class="muted-cell">—</span>';
}

// A cancelled order is flagged next to its number rather than in a column of its own.
const cancelledTag = (o) => (o.order_status === 'cancelled' ? '<span class="mini-tag warn">Cancelled</span>' : '');

function renderRows() {
  const empty = state.total === 0
    ? (anyFilter() || state.type || state.view
      ? '<b>Nothing matches.</b>Try clearing a filter.'
      : '<b>No orders yet.</b>Add a shipment with New Shipment, or Import orders.')
    : '';
  if (empty) {
    $('#rows').innerHTML = `<tr><td colspan="10"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return;
  }
  $('#rows').innerHTML = state.orders.map((o) => `
    <tr class="orow${o.id === state.openId ? ' open' : ''}" data-id="${o.id}" tabindex="0">
      <td><span class="cell-main mono" style="font-weight:500">${pickBox(o)}${esc(o.source_order_id)}${cancelledTag(o)}</span>${lineSkus(o)}</td>
      <td><span class="cell-main chan">${esc(o.channel_label)}</span>${o.destination_name
        ? `<span class="cell-sub muted" title="${esc(o.destination_name)}">${esc(o.destination_name)}</span>`
        : o.dispatch_type ? `<span class="cell-sub muted">${esc(typeLabel(o.dispatch_type))}</span>` : ''}</td>
      <td>${o.courier_name ? esc(o.courier_name) : '<span class="muted-cell">—</span>'}</td>
      <td>${trackingCell(o)}</td>
      <td>${shipIndicator(o)}</td>
      <td>${proofCell(o)}</td>
      <td class="num"${o.order_date ? '' : ' title="No order date — shown by when it was entered"'}>${esc(day(o.order_date))}</td>
      <td class="col-cust"><span class="cell-main">${o.customer_name ? esc(o.customer_name) : '<span class="muted-cell">—</span>'}</span></td>
      <td class="r num col-amt">${esc(amount(o.order_value))}</td>
      <td class="r"><button class="icon-btn bare" type="button" data-open="${o.id}" title="Open" aria-label="Open order ${esc(o.source_order_id)}">${icon('chevron-right')}</button></td>
    </tr>`).join('');
  $('#clist').innerHTML = state.orders.map((o) => `
    <li class="oitem" data-id="${o.id}" tabindex="0">
      <div class="oi-top">${pickBox(o)}<span class="oi-id mono">${esc(o.source_order_id)}</span><span class="chan">${esc(o.channel_label)}</span>${cancelledTag(o)}
        <span class="oi-val">${shipIndicator(o)}</span></div>
      ${o.line_skus?.length ? `<div class="oi-sub">${lineSkus(o)}</div>` : ''}
      ${o.destination_name ? `<div class="oi-sub">${icon('map-pin')} ${esc(o.destination_name)}</div>` : ''}
      <div class="oi-sub">${o.tracking_id ? `${esc(o.courier_name || '')} · <span class="mono">${esc(o.tracking_id)}</span>` : o.shipment_id ? 'No courier / AWB yet' : 'Not in a shipment yet'}</div>
      <div class="oi-stat"><span class="soft" style="font-size:12.5px">${esc(day(o.order_date))}</span>
        ${proofCell(o)}
        ${o.order_value !== null ? `<span class="soft" style="font-size:12.5px">${esc(amount(o.order_value))}</span>` : ''}</div>
    </li>`).join('');
  renderSelection();
  renderIcons();
}

/* ------------------------------------------------------------------ drawer */

/** Opens an order; `shipmentId` picks which of its shipments to show. */
async function openOrder(id, { shipmentId = null } = {}) {
  if (state.openId !== id) state.shipId = null;
  if (shipmentId) state.shipId = shipmentId;
  state.openId = id;
  writeUrl();
  $$('.orow').forEach((r) => r.classList.toggle('open', Number(r.dataset.id) === id));
  $('#drawer').hidden = false;
  $('#drawerScrim').hidden = false;
  $('#dSaved').textContent = '';
  if (!state.detail || state.detail.order.id !== id) {
    $('#dTitle').textContent = 'Loading…';
    $('#dSub').textContent = '';
    $('#dBody').innerHTML = '';
  }
  try {
    state.detail = await api(`/api/orders/${id}`);
    renderDrawer();
  } catch (err) {
    $('#dBody').innerHTML = `<div class="empty-note"><b>Could not open this order.</b>${esc(err.message)}</div>`;
  }
}

function closeDrawer() {
  state.openId = null;
  state.detail = null;
  state.shipId = null;
  writeUrl();
  $('#drawer').hidden = true;
  $('#drawerScrim').hidden = true;
  $$('.orow.open').forEach((r) => r.classList.remove('open'));
}

const opt = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;
/** An instant as "YYYY-MM-DDTHH:mm" on the team's clock (not the browser's). */
const toTeamInput = (iso) => {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: state.meta.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/* ------------------------------------------------------------------ documents */

const formatsFor = (type) => state.meta.documentFormats?.[type] || ['pdf', 'png', 'jpg', 'jpeg'];
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const acceptFor = (type) => [...formatsFor(type).map((e) => `.${e}`), ...new Set(formatsFor(type).map((e) => MIME[e]))].join(',');
const formatNames = (type) => [...new Set(formatsFor(type).map((e) => (e === 'jpeg' ? 'JPG' : e.toUpperCase())))].join(', ');

/** Quick check before sending; the server checks again, including the bytes. */
function fileProblem(file, type) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (!formatsFor(type).includes(ext)) return `${file.name}: only ${formatNames(type)} can be uploaded as ${label(type)}.`;
  if (file.size > state.meta.maxDocumentBytes) return `${file.name}: files must be ${bytes(state.meta.maxDocumentBytes)} or smaller.`;
  return null;
}

async function uploadFile(orderId, file, type) {
  return api(`/api/orders/${orderId}/documents?type=${encodeURIComponent(type)}`, {
    method: 'POST', body: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  });
}

/**
 * Uploads one by one, reporting progress. Files that fail are kept (with the
 * reason) for Retry — a failed upload never undoes the shipment and never
 * loses what was chosen.
 */
async function uploadAll(orderId, items, progressEl) {
  const failed = [];
  for (const [i, item] of items.entries()) {
    if (progressEl) progressEl.textContent = `Uploading ${i + 1} of ${items.length}: ${item.file.name}…`;
    try { await uploadFile(orderId, item.file, item.type); } catch (err) { failed.push({ ...item, error: err.message }); }
  }
  state.retry = failed.length ? { orderId, items: failed } : null;
  return failed;
}

function retryBanner(orderId) {
  const r = state.retry;
  if (!r || r.orderId !== orderId || !r.items.length) return '';
  return `<div class="retry" role="alert">
    <b>${r.items.length} upload${r.items.length === 1 ? '' : 's'} did not go through.</b> The shipment is saved.
    <ul>${r.items.map((x) => `<li>${esc(label(x.type))} · ${esc(x.file.name)} — ${esc(x.error)}</li>`).join('')}</ul>
    <div class="form-actions"><button class="btn primary" type="button" id="dRetry">${icon('rotate-cw')}Retry upload</button>
      <button class="btn" type="button" id="dRetryDrop">Discard</button></div>
  </div>`;
}

const docUrl = (o, d) => `/api/orders/${d.order_id || o.id}/documents/${d.id}`;
/** Where the drawer's photos and papers go: the shared shipment's lead order, or this order. */
const proofOrderId = () => state.detail.sharedWith || state.detail.order.id;

function docRows(o, list) {
  return `<ul class="docs">${list.map((d) => `
    <li class="doc${d.removed_at ? ' removed' : ''}">
      ${icon(d.mime_type === 'application/pdf' ? 'file-text' : 'image')}
      <div class="doc-name">
        <a href="${docUrl(o, d)}" target="_blank" rel="noopener">${esc(d.original_filename)}</a>
        <div class="doc-meta">${list.some((x) => x.document_type !== d.document_type) ? `${esc(label(d.document_type))} · ` : ''}${esc(bytes(d.file_size))} · ${esc(d.uploaded_by || 'Someone')}, ${esc(dateTime(d.uploaded_at))}
          ${d.removed_at ? ` · removed by ${esc(d.removed_by || 'someone')}` : ''}</div>
      </div>
      ${d.removed_at ? '' : `<button class="icon-btn bare" type="button" data-remove-doc="${d.id}" data-doc-order="${d.order_id}" title="Remove" aria-label="Remove ${esc(d.original_filename)}">${icon('trash-2')}</button>`}
    </li>`).join('')}</ul>`;
}

/** Dispatch photos as thumbnails first, then the paper trail by type. */
function proofSection(o, documents) {
  const m = state.meta;
  const live = documents.filter((d) => !d.removed_at);
  const photos = live.filter((d) => d.document_type === 'dispatch_product_image');
  const removedPhotos = documents.filter((d) => d.removed_at && d.document_type === 'dispatch_product_image');
  const ofType = (t) => documents.filter((d) => d.document_type === t);
  const others = documents.filter((d) => !['dispatch_product_image', 'tax_invoice', 'courier_receipt'].includes(d.document_type));
  const canUpload = !m.storage.error;
  const group = (title, list) => `<div class="proof-group"><div class="proof-h">${esc(title)}</div>
    ${list.length ? docRows(o, list) : '<p class="muted proof-none">Not uploaded</p>'}</div>`;
  return `
    <div class="proof-group">
      <div class="proof-h">Dispatch Product Images <span class="soft">${photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''}</span></div>
      ${photos.length ? `<div class="thumbs">${photos.map((d) => `
        <figure class="thumb">
          <a href="${docUrl(o, d)}" target="_blank" rel="noopener" title="${esc(d.original_filename)} · ${esc(d.uploaded_by || 'Someone')}, ${esc(dateTime(d.uploaded_at))}">
            <img src="${docUrl(o, d)}" alt="Dispatch photo ${esc(d.original_filename)}" loading="lazy" /></a>
          <button class="thumb-x" type="button" data-remove-doc="${d.id}" data-doc-order="${d.order_id}" title="Remove photo" aria-label="Remove ${esc(d.original_filename)}">${icon('x')}</button>
        </figure>`).join('')}</div>` : '<p class="muted proof-none">No dispatch photos yet.</p>'}
      ${canUpload ? `<label class="btn add-photos">${icon('camera')}Add photos
        <input type="file" id="dPhotos" multiple accept="${esc(acceptFor('dispatch_product_image'))}" hidden /></label>
        <span class="doc-meta">${esc(formatNames('dispatch_product_image'))}, up to ${esc(bytes(m.maxDocumentBytes))} each.</span>` : ''}
      ${removedPhotos.length ? `<div class="doc-meta" style="margin-top:6px">${removedPhotos.length} removed: ${removedPhotos.map((d) => `${esc(d.original_filename)} (by ${esc(d.removed_by || 'someone')})`).join(', ')}</div>` : ''}
    </div>
    ${group('Tax Invoice', ofType('tax_invoice'))}
    ${group('Courier Receipt', ofType('courier_receipt'))}
    ${others.length ? group('Other documents', others) : ''}
    ${m.storage.error ? `<div class="storage-note">${esc(m.storage.error)}</div>` : `<form class="upload" id="uploadForm">
      <select class="select" name="type" aria-label="Document type">${m.documentTypes.filter((t) => t !== 'dispatch_product_image')
        .map((t) => opt(t, label(t), t === (ofType('tax_invoice').some((d) => !d.removed_at) ? 'courier_receipt' : 'tax_invoice'))).join('')}</select>
      <input type="file" name="file" accept="${esc(acceptFor('tax_invoice'))}" aria-label="File" />
      <button class="btn" type="submit" id="uploadBtn">${icon('upload')}Upload</button>
    </form>
    <div class="doc-meta" style="margin-top:6px">Invoices and receipts: ${esc(formatNames('tax_invoice'))}, up to ${esc(bytes(m.maxDocumentBytes))}.</div>`}
    ${m.storage.driver === 'local' ? '<div class="storage-note">Development storage (this machine\'s disk). Production uses R2.</div>' : ''}`;
}

/* ------------------------------------------------------------------ shared shipments */

/**
 * The orders travelling in this shipment (several Amazon orders under one AWB),
 * with their total, and — for Amazon — a way to add more.
 */
function sharedBlock(o, ship) {
  const members = state.detail.members?.[ship.id] || [];
  const canAdd = o.channel === 'amazon';
  if (members.length < 2 && !canAdd) return '';
  const total = members.reduce((sum, x) => sum + (x.order_value || 0), 0);
  const unknown = members.filter((x) => x.order_value === null).length;
  return `<div class="shared">
    ${members.length > 1 ? `
      <div class="shared-h"><b>${members.length} orders in this shipment</b>
        <span class="soft">Total ${esc(money(total))}${unknown ? ` · ${unknown} without a value` : ''}</span></div>
      <ul class="shared-list">${members.map((x) => `
        <li class="${x.id === o.id ? 'here' : ''}">
          <button type="button" class="linkish mono" data-open-order="${x.id}" ${x.id === o.id ? 'disabled' : ''}>${esc(x.source_order_id)}</button>
          ${x.role === 'lead' ? '<span class="mini-tag">Main</span>' : ''}
          <span class="soft">${esc(day(x.order_date))}</span>
          <span class="num">${esc(amount(x.order_value))}</span>
          ${x.order_status === 'cancelled' ? '<span class="mini-tag warn">Cancelled</span>' : ''}
          ${x.role === 'member' ? `<button type="button" class="icon-btn bare" data-detach="${x.id}" title="Take out of this shipment" aria-label="Take order ${esc(x.source_order_id)} out of this shipment">${icon('x')}</button>` : ''}
        </li>`).join('')}</ul>
      ${state.detail.sharedWith ? '<p class="soft shared-note">Shared shipment: courier, AWB, status and photos apply to every order in it.</p>' : ''}` : ''}
    ${canAdd ? `<button type="button" class="btn" id="dAttachOpen">${icon('plus')}Add orders to this shipment</button>
      <div class="attach" id="dAttach" hidden>
        <input class="input plain" id="dAttachQ" placeholder="Find an order number" autocomplete="off" />
        <ul class="attach-list" id="dAttachList"><li class="soft">Loading…</li></ul>
        <div class="attach-new"><span class="soft">Or a new ${esc(o.channel_label)} order:</span>
          <input class="input plain mono" id="dNewNum" placeholder="Order number" autocomplete="off" />
          <input class="input plain" id="dNewDate" type="datetime-local" aria-label="Order date (IST)" />
          <input class="input plain" id="dNewValue" inputmode="decimal" placeholder="Value (₹)" autocomplete="off" /></div>
        <div class="form-actions"><button type="button" class="btn primary" id="dAttachSave">Add to shipment</button>
          <button type="button" class="btn" id="dAttachCancel">Cancel</button></div>
      </div>` : ''}
  </div>`;
}

async function loadAttachable() {
  const ship = currentShip();
  const q = $('#dAttachQ')?.value.trim() || '';
  const host = $('#dAttachList');
  try {
    const { orders } = await api(`/api/orders/shipments/${ship.id}/attachable?q=${encodeURIComponent(q)}`);
    host.innerHTML = orders.length ? orders.map((x) => `<li><label><input type="checkbox" value="${x.id}" />
      <span class="mono">${esc(x.source_order_id)}</span><span class="soft">${esc(day(x.order_date))}</span><span class="num">${esc(amount(x.order_value))}</span></label></li>`).join('')
      : '<li class="soft">No orders waiting that fit this shipment (same channel, type and destination, not shipped yet).</li>';
  } catch (err) { host.innerHTML = `<li class="saved failed">${esc(err.message)}</li>`; }
}

/** The shipment the drawer is showing. */
const currentShip = () => {
  const list = state.detail.shipments;
  return list.find((x) => x.id === state.shipId) || list[0];
};

function renderDrawer() {
  const { order: o, shipments, documents, events } = state.detail;
  const m = state.meta;
  const ship = currentShip();
  if (!ship) return renderDrawerNoShipment();
  state.shipId = ship.id;
  const courier = courierById(ship.courier_partner_id);
  const autoLink = Boolean(courier?.tracking_url_template);
  const notes = events.filter((e) => e.event_type === 'note_added');
  const live = documents.filter((d) => !d.removed_at);
  const has = (t) => live.some((d) => d.document_type === t);
  // In a shared shipment the photos and papers are the shipment's (kept on its lead order).
  const proofDocs = state.detail.shipmentDocuments || documents;

  $('#dTitle').textContent = `Order ${o.source_order_id}`;
  $('#dSub').textContent = [o.channel_label, o.dispatch_type && typeLabel(o.dispatch_type), o.destination_name, o.order_date && dateTime(o.order_date),
    o.order_status === 'cancelled' && 'Order cancelled'].filter(Boolean).join(' · ');
  queueMicrotask(() => loadStock(ship.id));

  $('#dBody').innerHTML = `
    <section class="dsec">
      <h3 class="dsec-title">Shipment <span class="dsec-meta">${indicator(ship.shipment_status)}</span></h3>
      ${sharedBlock(o, ship)}
      ${shipments.length > 1 ? `<div class="ship-tabs" role="tablist" aria-label="Shipments">${shipments.map((x, i) => `
        <button type="button" role="tab" class="pill${x.id === ship.id ? ' on' : ''}" data-ship="${x.id}" aria-selected="${x.id === ship.id}">
          ${i + 1} · ${esc(x.tracking_id || 'no AWB')}</button>`).join('')}</div>` : ''}
      <form id="shipForm" class="form-grid" novalidate>
        <label class="fld"><span>Courier</span>
          <select class="select" name="courier_partner_id">${opt('', 'Choose courier', !ship.courier_partner_id)}
            ${m.couriers.filter((c) => c.active || c.id === ship.courier_partner_id).map((c) => opt(c.id, c.name, c.id === ship.courier_partner_id)).join('')}
          </select></label>
        <label class="fld"><span>AWB / Tracking ID</span><input class="input mono" name="tracking_id" value="${esc(ship.tracking_id || '')}" maxlength="80" autocomplete="off" /></label>
        <label class="fld wide"><span>Tracking Link</span>
          <input class="input" name="tracking_url" value="${esc(ship.tracking_url || '')}" ${autoLink ? 'readonly' : ''}
                 placeholder="${autoLink ? 'Filled from the courier and AWB' : 'Paste a link, if the courier gives one'}" maxlength="500" autocomplete="off" />
          <span class="help" id="trackHelp">${trackHelp(courier)}</span>
          ${ship.tracking_url ? `<span class="help"><a class="track-link" href="${esc(ship.tracking_url)}" target="_blank" rel="noopener noreferrer">Open tracking</a></span>` : ''}</label>
        <label class="fld"><span>Shipment Status</span>
          <select class="select" name="shipment_status">${m.shipmentStatuses.map((s) => opt(s, label(s), s === ship.shipment_status)).join('')}</select></label>
        <label class="fld"><span>Expected Delivery</span><input class="input" type="date" name="expected_delivery_date" value="${esc(ship.expected_delivery_date || '')}" /></label>
      </form>
      <dl class="kv" style="margin-top:12px">
        <dt>Dispatch Date</dt><dd>${ship.dispatch_date ? esc(dateTime(ship.dispatch_date)) : '—'}</dd>
        <dt>Delivered</dt><dd>${ship.delivered_at ? esc(dateTime(ship.delivered_at)) : '—'}</dd>
      </dl>
      <div id="dStock" class="stock-block"></div>
      <div class="form-actions"><button class="btn primary" type="button" id="dShipSave">Save shipment</button>
        ${(NEXT_STEPS[ship.shipment_status] || []).map((s) => `<button class="btn" type="button" data-step="${s}">${esc(STEP_TEXT[s])}</button>`).join('')}</div>
      ${!['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto'].includes(ship.shipment_status)
        && !proofDocs.some((d) => !d.removed_at && d.document_type === 'dispatch_product_image')
        ? `<p class="photo-needed">${icon('camera')}Add a dispatch product photo (below) before marking it dispatched.</p>` : ''}
    </section>

    ${drawerCommon(o, documents, proofDocs, events, notes)}`;
  renderIcons();
}

/** Channels whose orders carry Briyo's own master SKU codes. Every other channel is a marketplace. */
const OWN_STORE_CHANNELS = new Set(['website']);
const isMarketplace = (channel) => Boolean(channel) && !OWN_STORE_CHANNELS.has(channel);

/**
 * The one SKU staff use to identify a product on this order's channel:
 *   Marketplaces (Amazon, Blinkit, Zepto, Tata 1mg…) → SKU = the platform's
 *     own SKU (what its seller panel shows), with the master Briyo SKU beside
 *     it, labelled, and Amazon's ASIN where known.
 *   Website / Shopify → SKU = the master Briyo SKU (Shopify uses it as is).
 * A marketplace SKU with no master SKU is flagged; it blocks dispatch until mapped.
 */
function skuIdentity({ channel, code, briyo, briyoId, asin = null, compact = false }) {
  const link = (text) => (briyoId ? `<a class="mono" href="/inventory?sku=${briyoId}">${esc(text)}</a>` : `<span class="mono">${esc(text)}</span>`);
  const sameAsMaster = briyoId && code && briyo && code.toLowerCase() === briyo.toLowerCase();
  if (isMarketplace(channel) && !sameAsMaster) {
    const primary = code ? `SKU <b class="mono">${esc(code)}</b>` : 'SKU <span class="soft">none</span>';
    const second = briyoId ? `Briyo SKU ${link(briyo)}`
      : '<span class="mini-tag warn" title="This platform SKU is not mapped to a master Briyo SKU yet. Stock cannot be reserved or dispatched until an admin maps it in Inventory → Unmapped platform SKUs.">Briyo SKU not mapped</span>';
    return [primary, second, !compact && asin ? `ASIN <span class="mono">${esc(asin)}</span>` : ''].filter(Boolean).join(' · ');
  }
  const own = briyo || code;
  if (!own) return '';
  return `SKU <b>${link(own)}</b>${briyoId ? '' : ' <span class="mini-tag" title="This SKU is not in the SKU master yet.">Not in SKU master</span>'}`;
}
const skuLine = (o, it) => skuIdentity({ channel: o.channel, code: it.sku, briyo: it.canonical_sku, briyoId: it.sku_id, asin: it.asin });

/**
 * Orders list: each line's SKU under the order number, one identifier per row
 * so a narrow column never breaks a code in half. Amazon: SKU (seller SKU),
 * then the Briyo SKU or "not mapped". Other channels: SKU (the Briyo SKU).
 */
function lineSkus(o) {
  const lines = o.line_skus || [];
  if (!lines.length) return '';
  const qty = (l) => (l.quantity > 1 ? ` ×${l.quantity}` : '');
  const own = (l) => l.sku_id && l.code && l.briyo_sku && l.code.toLowerCase() === l.briyo_sku.toLowerCase();
  const rows = lines.slice(0, 2).flatMap((l) => (isMarketplace(o.channel) && !own(l)
    ? [`<span class="ls" title="${esc(o.channel_label)} SKU ${esc(l.code || '')}">SKU <b>${esc(l.code || '—')}</b>${qty(l)}</span>`,
      l.sku_id ? `<span class="ls" title="Master Briyo SKU ${esc(l.briyo_sku)}">Briyo SKU ${esc(l.briyo_sku)}</span>`
        : '<span class="ls warn-text" title="This platform SKU is not mapped to a master Briyo SKU yet">Briyo SKU not mapped</span>']
    : [`<span class="ls" title="SKU ${esc(l.briyo_sku || l.code || '')}">SKU <b>${esc(l.briyo_sku || l.code || '—')}</b>${qty(l)}</span>`]));
  return `<span class="cell-sub line-skus">${rows.join('')}${lines.length > 2 ? `<span class="ls">+${lines.length - 2} more</span>` : ''}</span>`;
}

/** Line items, as the marketplace listed them. Manual orders have none. */
function itemsSection(o, items) {
  if (!items.length) return '';
  const units = items.reduce((n, it) => n + it.quantity, 0);
  return `<section class="dsec">
      <h3 class="dsec-title">Items <span class="dsec-meta soft">${count(items.length)} line${items.length === 1 ? '' : 's'} · ${count(units)} unit${units === 1 ? '' : 's'}</span></h3>
      <div class="item-list">${items.map((it) => `
        <div class="item-row">
          <div class="t"><div>${esc(it.title || it.sku || 'Item')}</div>
            <div class="muted" style="font-size:12px">${[skuLine(o, it),
              it.promotion_discount ? `Discount ${esc(money(it.promotion_discount))}` : '',
              it.shipping_price ? `Shipping ${esc(money(it.shipping_price))}` : ''].filter(Boolean).join(' · ')}</div></div>
          <div class="n"><div>× ${esc(it.quantity)}</div><div class="muted" style="font-size:12px">${esc(amount(it.item_price))}</div></div>
        </div>`).join('')}</div>
    </section>`;
}

/** What the Amazon report said beyond the order's own fields. */
function amazonDetails(a) {
  if (!a) return '';
  const to = a.ship_to || {};
  const place = [to.city, to.state, to.postal_code].filter(Boolean).join(', ');
  const win = (from, until) => [from && dateShort(from), until && dateShort(until)].filter(Boolean).join(' – ');
  const rows = [
    ['Ship To', [to.name, place].filter(Boolean).join(' · ')],
    ['Service Level', a.ship_service_level],
    ['Ship By', win(a.earliest_ship_date, a.latest_ship_date)],
    ['Deliver By', win(a.earliest_delivery_date, a.latest_delivery_date)],
    ['Amazon Flags', [a.is_prime && 'Prime', a.is_business_order && 'Business', a.fulfilled_by, a.is_amazon_invoiced && 'Amazon invoiced'].filter(Boolean).join(' · ')],
    ['PO Number', a.purchase_order_number],
    ['Delivery Note', a.delivery_instructions],
  ].filter(([, v]) => v);
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

/** Proof, notes, items, order details and activity: the same with or without a shipment. */
function drawerCommon(o, documents, proofDocs, events, notes) {
  const m = state.meta;
  return `
    <section class="dsec">
      <h3 class="dsec-title">Dispatch Proof &amp; Documents</h3>
      ${retryBanner(o.id)}
      ${proofSection(o, proofDocs)}
      ${state.detail.sharedWith && documents.length ? `<div class="proof-group"><div class="proof-h">This order's own documents</div>${docRows(o, documents)}</div>` : ''}
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Notes</h3>
      <textarea class="input" id="dNote" placeholder="Add a note — it is saved to the activity and cannot be edited" maxlength="2000"></textarea>
      <div class="form-actions"><button class="btn" type="button" id="dNoteAdd">Add note</button></div>
      ${notes.length ? `<ul class="d-history" style="margin-top:12px">${notes.slice(0, 5).map((n) => `
        <li><span style="min-width:0;white-space:pre-wrap">${esc(n.metadata.note)}</span><span class="d-when">${esc(n.actor || 'Someone')}, ${esc(dateTime(n.at))}</span></li>`).join('')}</ul>` : ''}
    </section>

    ${itemsSection(o, state.detail.items || [])}
    <details class="dsec more-sec">
      <summary class="dsec-title">Order details <span class="dsec-meta soft">${esc([amount(o.order_value), o.customer_name].filter((x) => x && x !== '—').join(' · ') || 'value, customer, payment')}</span></summary>
      <dl class="kv" style="margin-top:10px">
        <dt>Order Number</dt><dd class="mono">${esc(o.source_order_id)}</dd>
        <dt>Channel</dt><dd>${esc(o.channel_label)}</dd>
        <dt>Dispatch Type</dt><dd>${o.dispatch_type ? esc(typeLabel(o.dispatch_type)) : '<span class="muted">Not set</span>'}</dd>
        ${o.destination_name ? `<dt>Destination</dt><dd>${esc(o.destination_name)}</dd>` : ''}
        <dt>Order Date</dt><dd>${o.order_date ? esc(dateTime(o.order_date)) : '<span class="muted">Not entered</span>'}</dd>
        <dt>Order Value</dt><dd>${o.order_value === null ? '<span class="muted">Not entered</span>' : esc(`${money(o.order_value)}${o.currency && o.currency !== 'INR' ? ` ${o.currency}` : ''}`)}</dd>
        <dt>Customer</dt><dd>${esc([o.customer_name, o.customer_phone, o.customer_email].filter(Boolean).join(' · ') || '—')}</dd>
        <dt>Payment</dt><dd>${esc([o.payment_method && label(o.payment_method), o.payment_status && label(o.payment_status)].filter(Boolean).join(' · ') || 'Not known')}</dd>
        <dt>Fulfillment</dt><dd>${esc(o.fulfillment_type ? label(o.fulfillment_type) : 'Not set')}</dd>
        <dt>Entered</dt><dd>${esc(o.created_by || 'System')}, ${esc(dateTime(o.created_at))}${o.source === 'amazon_import' ? ' · Amazon import' : ''}</dd>
        ${amazonDetails(o.source_payload?.amazon)}
      </dl>
      <div class="d-row" style="margin-top:12px">
        <label class="d-label" for="dOrderStatus">Order status</label>
        <select class="select" id="dOrderStatus">${m.orderStatuses.map((s) => opt(s, label(s), s === o.order_status)).join('')}</select>
      </div>
      <div class="form-actions"><button class="btn" type="button" id="dEdit">${icon('pencil')}Edit order details</button></div>
    </details>

    <section class="dsec">
      <h3 class="dsec-title">Activity</h3>
      <div class="timeline">${events.map((e) => {
        const [ico, tone, text] = describeEvent(e);
        return `<div class="act">
          <span class="act-ico ${tone}">${icon(ico)}</span>
          <div style="min-width:0"><div class="act-title">${text}</div><div class="act-meta">${esc(e.actor || 'System')}</div></div>
          <span class="act-time">${esc(dateTime(e.at))}</span></div>`;
      }).join('')}</div>
    </section>`;
}

/** An order no shipment has been made for yet, e.g. one just imported from Amazon. */
function renderDrawerNoShipment() {
  const { order: o, documents, events } = state.detail;
  state.shipId = null;
  const notes = events.filter((e) => e.event_type === 'note_added');
  $('#dTitle').textContent = `Order ${o.source_order_id}`;
  $('#dSub').textContent = [o.channel_label, o.dispatch_type && typeLabel(o.dispatch_type), o.destination_name, o.order_date && dateTime(o.order_date),
    o.order_status === 'cancelled' && 'Order cancelled'].filter(Boolean).join(' · ');
  $('#dBody').innerHTML = `
    <section class="dsec">
      <h3 class="dsec-title">Shipment <span class="dsec-meta">${NO_SHIPMENT}</span></h3>
      <p class="imp-note" style="margin:0 0 12px">Nothing has been shipped for this order. When it is packed, create a shipment — several orders can share one parcel and AWB.</p>
      ${o.order_status === 'cancelled' ? '' : `<div class="form-actions" style="margin-top:0"><button class="btn primary" type="button" id="dShipNew">${icon('package-plus')}Create shipment</button>
        <button class="btn" type="button" id="dShipPick">${icon('list-checks')}Choose more orders for it</button></div>`}
    </section>
    ${drawerCommon(o, documents, documents, events, notes)}`;
  renderIcons();
}

const fmtVal = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'courier_partner_id') return courierById(v)?.name || `#${v}`;
  if (k === 'order_value') return money(v);
  if (k === 'channel') return channelLabel(v);
  if (k === 'dispatch_type') return typeLabel(v);
  if (k === 'destination_id') return destinationName(v);
  if (/_date$|_at$/.test(k) && k !== 'expected_delivery_date') return dateTime(v);
  if (/status$/.test(k)) return label(v);
  return String(v);
};
const FIELD_NAME = {
  order_value: 'value', source_order_id: 'order number', customer_name: 'name', customer_phone: 'phone',
  customer_email: 'email', payment_method: 'payment method', payment_status: 'payment status',
  order_date: 'order date', courier_partner_id: 'courier', tracking_id: 'AWB', tracking_url: 'tracking link',
  expected_delivery_date: 'expected delivery', dispatch_date: 'dispatched', delivered_at: 'delivered',
  dispatch_type: 'dispatch type', destination_id: 'destination',
};
const changeList = (changes) => Object.entries(changes || {})
  .map(([k, c]) => `${esc(FIELD_NAME[k] || label(k).toLowerCase())} <b>${esc(fmtVal(k, c.from))}</b> → <b>${esc(fmtVal(k, c.to))}</b>`)
  .join('; ');

function describeEvent(e) {
  const md = e.metadata || {};
  const ch = md.changes || {};
  switch (e.event_type) {
    case 'shipment_created': return ['package-plus', 'info', md.orders > 1 ? `Shipment created for ${md.orders} orders` : 'Shipment created'];
    case 'shipment_added': return ['package-plus', 'info', 'Another shipment added to this order'];
    case 'shipment_order_attached': return ['package-plus', 'info', `Order ${esc(md.source_order_id)} added to this shipment`];
    case 'shipment_order_detached': return ['package-minus', 'warn', `Order ${esc(md.source_order_id)} taken out of this shipment`];
    case 'attached_to_shipment': return ['package', 'info', `Added to the shipment of order ${esc(md.lead_source_order_id)}${md.tracking_id ? ` (AWB ${esc(md.tracking_id)})` : ''}`];
    case 'detached_from_shipment': return ['package-minus', 'warn', 'Taken out of the shared shipment'];
    case 'order_created': return ['plus', 'info', `${md.source === 'amazon_import' ? 'Imported from Amazon ·' : `Order created · ${esc(channelLabel(md.channel))}`} ${esc(md.source_order_id)}${md.order_value === null || md.order_value === undefined ? '' : ` · ${esc(money(md.order_value))}`}`];
    case 'order_status_changed': return ['circle-dot', ch.order_status?.to === 'cancelled' ? 'bad' : '', `Order ${esc(label(ch.order_status?.from))} → <b>${esc(label(ch.order_status?.to))}</b>`];
    case 'shipment_status_changed': {
      const to = ch.shipment_status?.to;
      const tone = to === 'delivered' ? 'good' : ['delivery_failed', 'rto', 'cancelled'].includes(to) ? 'bad' : 'info';
      return ['truck', tone, `Shipment ${esc(label(ch.shipment_status?.from))} → <b>${esc(label(to))}</b>`];
    }
    case 'courier_changed': return ['building-2', '', `Courier: ${changeList(ch)}`];
    case 'tracking_changed': return ['scan-barcode', '', `Tracking: ${changeList(ch)}`];
    case 'shipment_dates_changed': return ['calendar', '', `Dates: ${changeList(ch)}`];
    case 'order_edited': return ['pencil', '', `Edited: ${changeList(ch)}`];
    case 'document_uploaded': return md.document_type === 'dispatch_product_image'
      ? ['camera', 'good', `Dispatch product image uploaded · ${esc(md.filename)}`]
      : ['file-up', 'good', `Uploaded ${esc(label(md.document_type).toLowerCase())} · ${esc(md.filename)}`];
    case 'document_removed': return md.document_type === 'dispatch_product_image'
      ? ['camera-off', 'warn', `Dispatch product image removed · ${esc(md.filename)}`]
      : ['file-x', 'warn', `Removed ${esc(label(md.document_type).toLowerCase())} · ${esc(md.filename)}`];
    case 'amazon_import_updated': {
      const parts = [changeList(ch), md.items_added && `${md.items_added} item${md.items_added > 1 ? 's' : ''} added`,
        md.items_updated && `${md.items_updated} item${md.items_updated > 1 ? 's' : ''} updated`,
        md.details_changed && 'Amazon details refreshed'].filter(Boolean);
      return ['file-down', 'info', `Updated from Amazon import${parts.length ? `: ${parts.join('; ')}` : ''}`];
    }
    case 'note_added': return ['message-square-text', '', `Note: ${esc(md.note)}`];
    default: return ['activity', '', esc(label(e.event_type))];
  }
}

/**
 * Every edit carries the version it was based on; a stale one is refused.
 * Order fields and shipment fields are separate records with separate versions.
 */
async function patchOrder(fields, doneText = 'Saved', { shipment = false } = {}) {
  const o = state.detail.order;
  const ship = currentShip();
  const url = shipment ? `/api/orders/${ship.order_id || o.id}/shipments/${ship.id}` : `/api/orders/${o.id}`;
  const version = shipment ? ship.version : o.version;
  const saved = $('#dSaved');
  saved.className = 'saved pending';
  saved.textContent = 'Saving…';
  try {
    const data = await api(url, { method: 'PATCH', body: JSON.stringify({ ...fields, version }) });
    saved.className = 'saved';
    saved.textContent = data.changed ? doneText : 'Nothing changed';
    await openOrder(o.id);
    saved.textContent = data.changed ? doneText : 'Nothing changed';
    load();
  } catch (err) {
    saved.className = 'saved failed';
    saved.textContent = err.message;
    if (err.status === 409 && err.data?.conflict) {
      // Someone else saved first: show their version, keep the message.
      state.detail = await api(`/api/orders/${o.id}`).catch(() => state.detail);
      renderDrawer();
      load();
    }
  }
}

function trackHelp(courier) {
  if (!courier) return 'Choose a courier first.';
  if (!courier.tracking_url_template) return 'This courier has no link pattern, so paste one if you have it.';
  return courier.template_verified_at
    ? 'Built from the courier\'s link pattern when you save.'
    : 'Built from the courier\'s link pattern when you save. The pattern has not been checked with a real AWB yet.';
}

const dBody = $('#dBody');
let attachTimer;
dBody.addEventListener('input', (e) => {
  if (e.target.id === 'dAttachQ') { clearTimeout(attachTimer); attachTimer = setTimeout(loadAttachable, 250); }
});
onLeave(() => clearTimeout(attachTimer));

dBody.addEventListener('change', async (e) => {
  if (e.target.id === 'dPhotos') {
    const files = [...e.target.files];
    if (!files.length) return;
    const saved = $('#dSaved');
    const problems = files.map((f) => fileProblem(f, 'dispatch_product_image')).filter(Boolean);
    if (problems.length) { saved.className = 'saved failed'; saved.textContent = problems.join(' '); e.target.value = ''; return; }
    saved.className = 'saved pending';
    const id = state.detail.order.id;
    const failed = await uploadAll(proofOrderId(), files.map((file) => ({ file, type: 'dispatch_product_image' })), saved);
    await openOrder(id);
    $('#dSaved').className = failed.length ? 'saved failed' : 'saved';
    $('#dSaved').textContent = failed.length ? `${failed.length} of ${files.length} photo${files.length === 1 ? '' : 's'} did not upload — see Retry above.`
      : `${files.length} photo${files.length === 1 ? '' : 's'} added`;
    load();
    return;
  }
  if (e.target.name === 'type' && e.target.closest('#uploadForm')) {
    e.target.form.file.accept = acceptFor(e.target.value);
    return;
  }
  if (e.target.id === 'dOrderStatus') patchOrder({ order_status: e.target.value }, 'Order status saved');
  if (e.target.name === 'courier_partner_id') {
    // Show straight away whether the link will be generated or typed.
    const c = courierById(e.target.value);
    const url = $('#shipForm [name=tracking_url]');
    url.readOnly = Boolean(c?.tracking_url_template);
    url.placeholder = url.readOnly ? 'Filled from the courier and AWB' : 'Paste a link, if the courier gives one';
    $('#trackHelp').textContent = trackHelp(c);
  }
});

function shipmentFields() {
  const f = new FormData($('#shipForm'));
  const courier = courierById(f.get('courier_partner_id'));
  const out = {
    courier_partner_id: f.get('courier_partner_id') || null,
    tracking_id: f.get('tracking_id'),
    expected_delivery_date: f.get('expected_delivery_date') || null,
    shipment_status: f.get('shipment_status'),
  };
  // A generated link is the server's job; only a hand-typed one is sent.
  if (!courier?.tracking_url_template) out.tracking_url = f.get('tracking_url');
  return out;
}

dBody.addEventListener('click', async (e) => {
  const openOther = e.target.closest('[data-open-order]');
  if (openOther && !openOther.disabled) return openOrder(Number(openOther.dataset.openOrder));
  if (e.target.closest('#dAttachOpen')) { $('#dAttach').hidden = false; e.target.closest('#dAttachOpen').hidden = true; return loadAttachable(); }
  if (e.target.closest('#dAttachCancel')) { $('#dAttach').hidden = true; $('#dAttachOpen').hidden = false; return; }
  if (e.target.closest('#dAttachSave')) {
    const ship = currentShip();
    const orderIds = [...document.querySelectorAll('#dAttachList input:checked')].map((i) => Number(i.value));
    const num = $('#dNewNum').value.trim();
    const newOrders = num ? [{ source_order_id: num, order_date: $('#dNewDate').value || undefined, order_value: $('#dNewValue').value }] : [];
    const saved = $('#dSaved');
    if (!orderIds.length && !newOrders.length) { saved.className = 'saved failed'; saved.textContent = 'Tick an order or enter a new order number.'; return; }
    saved.className = 'saved pending'; saved.textContent = 'Adding…';
    try {
      const r = await api(`/api/orders/shipments/${ship.id}/orders`, { method: 'POST', body: JSON.stringify({ order_ids: orderIds, new_orders: newOrders }) });
      await openOrder(state.detail.order.id, { shipmentId: ship.id });
      $('#dSaved').className = 'saved';
      $('#dSaved').textContent = `${r.attached.length} order${r.attached.length === 1 ? '' : 's'} added — ${r.members.length} in this shipment`;
      load();
    } catch (err) { saved.className = 'saved failed'; saved.textContent = err.message; }
    return;
  }
  const detach = e.target.closest('[data-detach]');
  if (detach) {
    if (!confirm('Take this order out of the shipment? It keeps its own details; the change is recorded.')) return;
    const ship = currentShip();
    try {
      await api(`/api/orders/shipments/${ship.id}/orders/${detach.dataset.detach}`, { method: 'DELETE' });
      await openOrder(state.detail.order.id);
      $('#dSaved').className = 'saved'; $('#dSaved').textContent = 'Order taken out of the shipment';
      load();
    } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; }
    return;
  }
  if (e.target.closest('#dRetry')) {
    const { orderId, items } = state.retry;
    const btn = e.target.closest('#dRetry');
    btn.disabled = true;
    const saved = $('#dSaved');
    saved.className = 'saved pending';
    const failed = await uploadAll(orderId, items, saved);
    await openOrder(orderId);
    $('#dSaved').className = failed.length ? 'saved failed' : 'saved';
    $('#dSaved').textContent = failed.length ? `${failed.length} still did not upload.` : 'All uploads went through';
    load();
    return;
  }
  if (e.target.closest('#dRetryDrop')) { state.retry = null; return renderDrawer(); }
  const tab = e.target.closest('[data-ship]');
  if (tab) { state.shipId = Number(tab.dataset.ship); $('#dSaved').textContent = ''; return renderDrawer(); }
  if (e.target.closest('#dShipSave')) return patchOrder(shipmentFields(), 'Shipment saved', { shipment: true });
  if (e.target.closest('#dReserve')) return reserveStock();
  if (e.target.closest('#dRelease')) return releaseStock();
  if (e.target.closest('[data-alloc-add]')) {
    const box = e.target.closest('.alloc');
    const row = box.querySelector('.alloc-row').cloneNode(true);
    row.querySelector('[data-alloc-batch]').value = '';
    row.querySelector('[data-alloc-qty]').value = '';
    box.insertBefore(row, e.target.closest('[data-alloc-add]'));
    return null;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    return patchOrder({ ...shipmentFields(), shipment_status: step.dataset.step },
      STEP_TEXT[step.dataset.step].replace(/^Mark /, 'Marked '), { shipment: true });
  }
  if (e.target.closest('#dEdit')) return openForm(state.detail.order);
  // No shipment yet: start one with this order, now or after choosing more in the list.
  if (e.target.closest('#dShipNew, #dShipPick')) {
    const o = state.detail.order;
    if (!state.sel.has(o.id)) state.sel = new Map([[o.id, o], ...state.sel]);
    renderRows();
    if (e.target.closest('#dShipNew')) return openShipNew();
    return closeDrawer();
  }
  if (e.target.closest('#dNoteAdd')) {
    const note = $('#dNote').value.trim();
    if (!note) return;
    const btn = e.target.closest('#dNoteAdd');
    btn.disabled = true;
    try {
      await api(`/api/orders/${state.detail.order.id}/notes`, { method: 'POST', body: JSON.stringify({ note }) });
      await openOrder(state.detail.order.id);
      $('#dSaved').className = 'saved';
      $('#dSaved').textContent = 'Note added';
    } catch (err) {
      btn.disabled = false;
      $('#dSaved').className = 'saved failed';
      $('#dSaved').textContent = err.message;
    }
    return;
  }
  const rm = e.target.closest('[data-remove-doc]');
  if (rm) {
    if (!confirm('Remove this from the order? It stays in the activity record.')) return;
    try {
      await api(`/api/orders/${rm.dataset.docOrder || state.detail.order.id}/documents/${rm.dataset.removeDoc}`, { method: 'DELETE' });
      await openOrder(state.detail.order.id);
      $('#dSaved').textContent = 'Document removed';
      load();
    } catch (err) {
      $('#dSaved').className = 'saved failed';
      $('#dSaved').textContent = err.message;
    }
  }
});

dBody.addEventListener('submit', async (e) => {
  if (e.target.id === 'shipForm') { e.preventDefault(); return patchOrder(shipmentFields(), 'Shipment saved', { shipment: true }); }
  if (e.target.id !== 'uploadForm') return;
  e.preventDefault();
  const form = e.target;
  const file = form.file.files[0];
  const saved = $('#dSaved');
  if (!file) { saved.className = 'saved failed'; saved.textContent = 'Choose a file first.'; return; }
  const problem = fileProblem(file, form.type.value);
  if (problem) { saved.className = 'saved failed'; saved.textContent = problem; return; }
  const btn = $('#uploadBtn');
  btn.disabled = true;
  saved.className = 'saved pending';
  saved.textContent = `Uploading ${file.name}…`;
  try {
    await api(`/api/orders/${proofOrderId()}/documents?type=${encodeURIComponent(form.type.value)}`, {
      method: 'POST', body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    });
    await openOrder(state.detail.order.id);
    $('#dSaved').className = 'saved';
    $('#dSaved').textContent = 'Uploaded';
    load();
  } catch (err) {
    btn.disabled = false;
    saved.className = 'saved failed';
    saved.textContent = err.message;
  }
});

/* ------------------------------------------------------------------ create / edit */

/** Edit an existing order's details. New work starts from New Shipment instead. */
function openForm(order) {
  state.editing = order;
  const form = $('#orderForm');
  form.reset();
  $('#formError').hidden = true;
  $('#fSaved').textContent = '';
  fillRoute(form, '#fDestField', { type: order.dispatch_type || '', channel: order.channel, destination: order.destination_id || '', required: false });
  // An old channel (or one switched off) still shows for the order it belongs to.
  if (!form.channel.value && order.channel) form.channel.insertAdjacentHTML('beforeend', opt(order.channel, channelLabel(order.channel), true));
  form.payment_status.innerHTML = opt('', 'Not known', !order?.payment_status)
    + state.meta.paymentStatuses.map((s) => opt(s, label(s), s === order?.payment_status)).join('');
  form.payment_method.innerHTML = opt('', 'Not known', !order?.payment_method)
    + state.meta.paymentMethods.map((s) => opt(s, label(s), s === order?.payment_method)).join('');
  form.fulfillment_type.innerHTML = opt('', 'Not set', !order?.fulfillment_type)
    + state.meta.fulfillmentTypes.map((s) => opt(s, label(s), s === order?.fulfillment_type)).join('');
  if (order) {
    for (const k of ['source_order_id', 'customer_name', 'customer_phone', 'customer_email']) form[k].value = order[k] || '';
    form.order_value.value = order.order_value ?? '';
    form.order_date.value = toTeamInput(order.order_date);
    form.currency.value = order.currency && order.currency !== 'INR' ? order.currency : '';
  }
  // Editing opens the extra fields when any are filled; a new order starts folded.
  $('#moreDetails').open = ['customer_name', 'customer_phone', 'customer_email', 'payment_method',
    'payment_status', 'fulfillment_type'].some((k) => order[k]);
  $('#fTitle').textContent = `Edit order ${order.source_order_id}`;
  $('#fSubmit').textContent = 'Save Changes';
  $('#formDrawer').hidden = false;
  $('#drawerScrim').hidden = false;
  form.source_order_id.focus();
}

function closeForm() {
  $('#formDrawer').hidden = true;
  state.editing = null;
  if ($('#drawer').hidden) $('#drawerScrim').hidden = true;
}

$('#orderForm').addEventListener('change', (e) => {
  if (['dispatch_type', 'channel'].includes(e.target.name)) routeChanged(e.target.form, '#fDestField', e.target.name, false);
});

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = $('#formError');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(form));
  // Only send the route when it is set or being changed, so editing an older
  // order without a dispatch type does not demand one.
  if (!body.dispatch_type && !state.editing.dispatch_type) { delete body.dispatch_type; delete body.destination_id; }
  else if ($('#fDestField').hidden) body.destination_id = '';
  if (body.dispatch_type && !$('#fDestField').hidden && !body.destination_id) {
    err.textContent = 'Choose the destination.'; err.hidden = false; return;
  }
  const missing = [['channel', 'channel'], ['source_order_id', 'order number']]
    .filter(([k]) => !String(body[k] || '').trim()).map(([, l]) => l);
  if (missing.length) { err.textContent = `Enter the ${missing.join(', ')}.`; err.hidden = false; return; }
  // Order date is sent as wall-clock time; the server reads it in the team's timezone.
  const btn = $('#fSubmit');
  btn.disabled = true;
  try {
    const o = state.editing;
    await api(`/api/orders/${o.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: o.version }) });
    closeForm();
    await openOrder(o.id);
    $('#dSaved').textContent = 'Order details saved';
    load();
  } catch (ex) {
    err.innerHTML = esc(ex.message) + (ex.data?.existingId
      ? ` <a href="/orders?open=${ex.data.existingId}" data-goto="${ex.data.existingId}">Open it</a>` : '');
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$('#formError').addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (!a) return;
  e.preventDefault();
  closeForm();
  openOrder(Number(a.dataset.goto));
});

/* ------------------------------------------------------------------ route pickers */

/**
 * Dispatch type → channel → destination, for a form with those three selects.
 * Each choice narrows the next; a destination only shows for types that need one.
 */
function fillRoute(form, fieldId, { type = '', channel = '', destination = '', required = true } = {}) {
  const m = state.meta;
  form.dispatch_type.innerHTML = opt('', required ? 'Choose type' : 'Not set', !type)
    + m.dispatchTypes.map((t) => opt(t.key, t.label, t.key === type)).join('');
  const chans = channelsFor(type);
  if (channel && !chans.some((c) => c.key === channel)) channel = '';
  form.channel.innerHTML = opt('', 'Choose channel', !channel) + chans.map((c) => opt(c.key, c.label, c.key === channel)).join('');
  if (!channel && chans.length === 1) form.channel.value = chans[0].key;
  const needs = m.dispatchTypes.find((t) => t.key === type)?.needsDestination;
  const dests = needs ? destinationsFor(form.channel.value, type) : [];
  form.destination_id.innerHTML = opt('', form.channel.value ? 'Choose destination' : 'Choose the channel first', !destination)
    + dests.map((d) => opt(d.id, d.name, String(d.id) === String(destination))).join('');
  $(fieldId).hidden = !needs;
}

function routeChanged(form, fieldId, changed, required) {
  fillRoute(form, fieldId, {
    type: form.dispatch_type.value,
    channel: form.channel.value,
    destination: changed === 'destination_id' ? form.destination_id.value : '',
    required,
  });
}

/* ------------------------------------------------------------------ new shipment */


function openCreate() {
  const f = $('#createForm');
  f.reset();
  state.addToExisting = false;
  $('#cError').hidden = true;
  $('#cExists').hidden = true;
  $('#cSaved').textContent = '';
  $('#cSubmit').textContent = 'Create Shipment';
  const m = state.meta;
  fillRoute(f, '#cDestField', { type: state.type === 'none' ? '' : state.type, channel: state.f.channel });
  $('#cExtras').innerHTML = '';
  syncExtras();
  f.courier_partner_id.innerHTML = opt('', 'Choose courier', true)
    + m.couriers.filter((c) => c.active).map((c) => opt(c.id, c.name)).join('');
  // Packed by default: an AWB means ready to go, not gone. Dispatch is chosen.
  f.shipment_status.innerHTML = m.shipmentStatuses.filter((x) => x !== 'cancelled')
    .map((x) => opt(x, label(x), x === 'packed')).join('');
  f.payment_status.innerHTML = opt('', 'Not known', true) + m.paymentStatuses.map((x) => opt(x, label(x))).join('');
  f.payment_method.innerHTML = opt('', 'Not known', true) + m.paymentMethods.map((x) => opt(x, label(x))).join('');
  f.fulfillment_type.innerHTML = opt('', 'Not set', true) + m.fulfillmentTypes.map((x) => opt(x, label(x))).join('');
  const docsOff = Boolean(m.storage.error);
  for (const input of [f.dispatch_files, f.invoice_file, f.receipt_file]) input.disabled = docsOff;
  $('#cDocsNote').textContent = docsOff ? m.storage.error
    : `Invoice and receipt: ${formatNames('tax_invoice')}. Photos: ${formatNames('dispatch_product_image')}. Up to ${bytes(m.maxDocumentBytes)} each.`;
  showPreviews([]);
  $('#createDrawer').hidden = false;
  $('#drawerScrim').hidden = false;
  (f.dispatch_type.value ? (f.channel.value ? f.source_order_id : f.channel) : f.dispatch_type).focus();
}

function closeCreate() {
  $('#createDrawer').hidden = true;
  if ($('#drawer').hidden && $('#formDrawer').hidden) $('#drawerScrim').hidden = true;
}


let previewUrls = [];
/** Local previews of the chosen photos, before anything is uploaded. */
function showPreviews(files) {
  for (const u of previewUrls) URL.revokeObjectURL(u);
  previewUrls = files.map((f) => URL.createObjectURL(f));
  const host = $('#cThumbs');
  host.hidden = !files.length;
  host.innerHTML = files.map((f, i) => `<figure class="thumb"><img src="${previewUrls[i]}" alt="${esc(f.name)}" /></figure>`).join('')
    + (files.length ? `<span class="soft thumbs-n">${files.length} photo${files.length === 1 ? '' : 's'} selected</span>` : '');
}
/** Extra orders in the same parcel — Amazon only, where several orders go under one AWB. */
function syncExtras() {
  const amazon = $('#createForm').channel.value === 'amazon';
  $('#cExtraSec').hidden = !amazon;
  if (!amazon) $('#cExtras').innerHTML = '';
}
function addExtraRow() {
  $('#cExtras').insertAdjacentHTML('beforeend', `<div class="extra-row">
    <input class="input plain mono x-num" placeholder="Amazon order number" aria-label="Amazon order number" autocomplete="off" />
    <input class="input plain x-date" type="datetime-local" aria-label="Order date (IST)" />
    <input class="input plain x-value" inputmode="decimal" placeholder="Value (₹)" aria-label="Order value" autocomplete="off" />
    <button type="button" class="icon-btn bare x-remove" title="Remove" aria-label="Remove this order">${icon('x')}</button></div>`);
  renderIcons();
  $('#cExtras .extra-row:last-child .x-num').focus();
}
$('#cAddExtra').addEventListener('click', addExtraRow);
$('#cExtras').addEventListener('click', (e) => { const x = e.target.closest('.x-remove'); if (x) x.closest('.extra-row').remove(); });
const extraOrders = () => [...document.querySelectorAll('#cExtras .extra-row')]
  .map((r) => ({ source_order_id: r.querySelector('.x-num').value.trim(), order_date: r.querySelector('.x-date').value || undefined, order_value: r.querySelector('.x-value').value }))
  .filter((x) => x.source_order_id);

$('#createForm').addEventListener('change', (e) => {
  if (e.target.name === 'dispatch_files') showPreviews([...e.target.files]);
  if (['dispatch_type', 'channel'].includes(e.target.name)) { routeChanged(e.target.form, '#cDestField', e.target.name, true); syncExtras(); }
});

const orderFieldsReset = () => {
  state.addToExisting = false;
  $('#cExists').hidden = true;
  $('#cSubmit').textContent = 'Create Shipment';
};

$('#createForm').addEventListener('input', (e) => {
  // Changing which order this is voids an "add to existing" confirmation.
  if (['channel', 'source_order_id', 'dispatch_type', 'destination_id'].includes(e.target.name) && state.addToExisting) orderFieldsReset();
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#cError');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(f));
  delete body.invoice_file; delete body.receipt_file; delete body.dispatch_files;
  const extras = extraOrders();
  if (extras.length) body.extra_orders = extras;
  const nums = [body.source_order_id, ...extras.map((x) => x.source_order_id)].map((n) => String(n || '').trim().toLowerCase());
  if (new Set(nums).size !== nums.length) { err.textContent = 'The same order number is entered twice.'; err.hidden = false; return; }
  const needsDest = !$('#cDestField').hidden;
  if (!needsDest) delete body.destination_id;
  const missing = [['dispatch_type', 'dispatch type'], ['channel', 'channel'], ...(needsDest ? [['destination_id', 'destination']] : []),
    ['source_order_id', 'order number'], ['courier_partner_id', 'courier partner'], ['tracking_id', 'tracking ID / AWB']]
    .filter(([k]) => !String(body[k] || '').trim()).map(([, l]) => l);
  if (missing.length) { err.textContent = `Enter the ${missing.join(', ')}.`; err.hidden = false; return; }
  // Dispatched (or later) needs a dispatch photo. The shipment is saved as
  // Packed, the photos go up, then it moves to the chosen status.
  const SHIPPED = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto'];
  const target = body.shipment_status;
  if (SHIPPED.includes(target)) {
    if (!f.dispatch_files.files.length) {
      err.textContent = `Add at least one Dispatch Product Image to mark it ${label(target)} — or save it as Packed and add photos later.`;
      err.hidden = false; return;
    }
    body.shipment_status = 'packed';
  }
  // Photos first: they are the primary proof. Receipt and invoice are optional.
  const items = [
    ...[...f.dispatch_files.files].map((file) => ({ file, type: 'dispatch_product_image' })),
    ...[[f.invoice_file.files[0], 'tax_invoice'], [f.receipt_file.files[0], 'courier_receipt']]
      .filter(([file]) => file).map(([file, type]) => ({ file, type })),
  ];
  const problems = items.map((x) => fileProblem(x.file, x.type)).filter(Boolean);
  if (problems.length) { err.textContent = problems.join(' '); err.hidden = false; return; }
  const btn = $('#cSubmit');
  btn.disabled = true;
  $('#cSaved').className = 'saved pending';
  $('#cSaved').textContent = 'Saving…';
  try {
    const data = await api('/api/orders/shipments', {
      method: 'POST', body: JSON.stringify({ ...body, addToExisting: state.addToExisting }),
    });
    // Documents go up once the shipment exists. A failed upload never undoes the
    // shipment; the drawer lists what failed with a Retry that keeps the files.
    const failed = await uploadAll(data.orderId, items, $('#cSaved'));
    let moveError = null;
    if (target !== body.shipment_status) {
      try {
        const { shipments } = await api(`/api/orders/${data.orderId}`);
        const ship = shipments.find((x) => x.id === data.shipmentId);
        await api(`/api/orders/${data.orderId}/shipments/${ship.id}`, {
          method: 'PATCH', body: JSON.stringify({ shipment_status: target, version: ship.version }),
        });
      } catch (ex2) { moveError = ex2.message; }
    }
    showPreviews([]);
    closeCreate();
    await load();
    await openOrder(data.orderId, { shipmentId: data.shipmentId });
    const saved = $('#dSaved');
    saved.className = failed.length || moveError ? 'saved failed' : 'saved';
    saved.textContent = failed.length
      ? `Shipment saved as Packed, but ${failed.length} of ${items.length} upload${items.length === 1 ? '' : 's'} failed — Retry is under Dispatch Proof.`
      : moveError ? `Shipment saved as Packed. ${moveError}`
        : (data.createdOrder ? `Shipment created${extras.length ? ` with ${extras.length + 1} orders` : ''}` : 'Shipment added to this order');
  } catch (ex) {
    $('#cSaved').textContent = '';
    if (ex.data?.orderExists) {
      // Never a second order: show the one that exists and offer to add to it.
      const d = ex.data;
      $('#cExistsText').innerHTML = `<b>${esc(ex.message)}</b>`
        + (d.shipments?.length
          ? `<ul class="d-history" style="margin:8px 0 0">${d.shipments.map((x) => `<li><span>${esc(x.courier || 'No courier')} · <span class="mono">${esc(x.awb || 'no AWB')}</span></span><span class="d-when">${esc(label(x.status))}</span></li>`).join('')}</ul>`
          : '<div class="soft" style="margin-top:4px">It has no courier or AWB yet.</div>');
      $('#cAddExisting').textContent = d.canFillShipment ? 'Add this shipment to it' : 'Add as another shipment';
      $('#cOpenExisting').dataset.goto = d.existingId;
      $('#cExists').hidden = false;
      $('#cExists').scrollIntoView({ block: 'nearest' });
    } else {
      err.innerHTML = esc(ex.message) + (ex.data?.existingId
        ? ` <a href="/orders?open=${ex.data.existingId}" data-goto="${ex.data.existingId}">Open the order</a>` : '');
      err.hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
});

$('#cAddExisting').addEventListener('click', () => {
  state.addToExisting = true;
  $('#createForm').requestSubmit();
});
$('#createDrawer').addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (!a) return;
  e.preventDefault();
  closeCreate();
  openOrder(Number(a.dataset.goto));
});

/* ------------------------------------------------------------------ wiring */

function fillFilters() {
  const m = state.meta;
  $('#fstatus').innerHTML = opt('', 'Order status') + m.orderStatuses.map((s) => opt(s, label(s))).join('');
  $('#fshipment').innerHTML = opt('', 'Shipment') + opt('none', 'No shipment yet') + m.shipmentStatuses.map((s) => opt(s, label(s))).join('');
  $('#fcourier').innerHTML = opt('', 'Courier') + opt('none', 'No courier') + m.couriers.map((c) => opt(c.id, c.name)).join('');
  const ids = { status: 'fstatus', shipment: 'fshipment', courier: 'fcourier', invoice: 'finvoice', tracking: 'ftracking', from: 'ffrom', to: 'fto' };
  for (const [k, id] of Object.entries(ids)) {
    $(`#${id}`).value = state.f[k];
    $(`#${id}`).classList.toggle('on', Boolean(state.f[k]));
  }
  $('#q').value = state.f.q;
}

/* ------------------------------------------------------------ shipment stock */

/**
 * Stock for the shipment on screen: what its orders need per SKU, the FEFO
 * batch suggestion (changeable), and Reserve / Release. Dispatch then deducts
 * exactly what is reserved; the server refuses it otherwise.
 */
// Batch dates are calendar days ('YYYY-MM-DD'): formatted in UTC from their own parts so no timezone shifts them.
const DAY_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const calendarDay = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? DAY_FMT.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : '—';
};

async function loadStock(shipmentId) {
  const host = $('#dStock');
  if (!host) return;
  try {
    const { stock } = await api(`/api/inventory/shipments/${shipmentId}`);
    if (currentShip()?.id !== shipmentId) return;
    state.stock = stock;
    renderStock();
  } catch (err) {
    host.innerHTML = err.status === 403 ? '' : `<p class="saved failed">${esc(err.message)}</p>`;
  }
}

function renderStock() {
  const st = state.stock;
  const host = $('#dStock');
  if (!host || !st || st.state === 'no_items') { if (host) host.innerHTML = ''; return; }
  const done = st.state === 'dispatched';
  const editable = !done && !['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto', 'cancelled'].includes(st.status);
  const head = {
    reserved: `${icon('circle-check')}Stock reserved — ready to dispatch`,
    needs_reservation: `${icon('package-search')}Confirm the batches to reserve stock before dispatch`,
    insufficient: `${icon('triangle-alert')}Not enough stock`,
    unmapped: `${icon('triangle-alert')}SKU not mapped to a Briyo SKU — cannot dispatch`,
    dispatched: `${icon('package-check')}Stock deducted at dispatch`,
  }[st.state];
  const tone = { reserved: 'good', dispatched: 'good', needs_reservation: '', insufficient: 'bad', unmapped: 'bad' }[st.state];
  const allocFor = (l) => (l.reserved.length ? l.reserved.map((r) => ({ batch_id: r.batch_id, quantity: r.quantity }))
    : l.suggestion.picks.length ? l.suggestion.picks : [{ batch_id: '', quantity: l.required }]);
  const batchOpts = (l, sel) => opt('', 'Choose batch', !sel) + l.batches.filter((b) => b.effective_status === 'active' && (b.available > 0 || b.id === sel))
    .map((b) => opt(b.id, `${b.batch_number} · exp ${calendarDay(b.expiry_date)} · ${b.available} free${b.location ? ` · ${b.location}` : ''}`, b.id === sel)).join('');
  host.innerHTML = `
    <div class="stock-head ${tone}">${head}${st.orders.length > 1 ? `<span class="soft"> · ${st.orders.length} orders</span>` : ''}</div>
    ${st.unmapped.length ? `<ul class="stock-unmapped">${st.unmapped.map((u) => `<li>SKU <b class="mono">${esc(u.code || '—')}</b> × ${esc(u.quantity)} · <span class="mini-tag warn">Briyo SKU not mapped</span>
      <span class="soft">order ${esc(u.order_number)}</span></li>`).join('')}</ul>
      <p class="imp-note">An admin maps these to a master SKU in <a href="/inventory?view=unmapped">Inventory → Unmapped platform SKUs</a>. No stock is guessed or deducted.</p>` : ''}
    ${st.lines.map((l) => `<div class="stock-line" data-line="${l.sku_id}">
      <div class="stock-line-head">
        <span>${isMarketplace(st.channel) && (l.codes || []).some((c) => c.toLowerCase() !== l.sku.toLowerCase())
          ? `SKU <b class="mono">${esc((l.codes || []).join(', ') || '—')}</b> · Briyo SKU <a class="mono" href="/inventory?sku=${l.sku_id}">${esc(l.sku)}</a>`
          : `SKU <b><a class="mono" href="/inventory?sku=${l.sku_id}">${esc(l.sku)}</a></b>`}
          <span class="soft">${esc(l.product_name)}${l.variant_name ? ` · ${esc(l.variant_name)}` : ''}</span></span>
        <span class="stock-nums"><b>${count(l.required)}</b> needed${done ? '' : ` · ${count(l.available)} available to dispatch ${l.enough ? '<span class="ok-mark">✓</span>' : '<span class="mini-tag warn">Insufficient</span>'}`}</span>
      </div>
      ${done ? `<div class="soft stock-from">Deducted from ${l.dispatched.map((d) => `<span class="mono">${esc(d.batch_number)}</span> −${count(d.quantity)}`).join(', ')}</div>`
        : editable ? `<div class="alloc">${allocFor(l).map((a) => `<div class="alloc-row"><select class="select" data-alloc-batch aria-label="Batch for ${esc(l.sku)}">${batchOpts(l, a.batch_id)}</select>
            <input class="input" data-alloc-qty inputmode="numeric" value="${esc(a.quantity)}" aria-label="Quantity" /></div>`).join('')}
            <button type="button" class="linkish" data-alloc-add>+ another batch</button></div>`
          : `<div class="soft stock-from">${l.reserved.map((r) => `<span class="mono">${esc(r.batch_number)}</span> × ${count(r.quantity)}`).join(', ') || 'Nothing reserved'}</div>`}
      ${!done && l.suggestion.short && !l.reserved_quantity ? `<div class="warn-text stock-from">Short by ${count(l.suggestion.short)}</div>` : ''}
    </div>`).join('')}
    ${st.untracked?.length ? `<p class="imp-note">${st.untracked.map((u) => `<span class="mono">${esc(u.sku)}</span>`).join(', ')} not inventory-tracked — no stock needed.</p>` : ''}
    ${editable && st.lines.length && !st.unmapped.length ? `<div class="form-actions">
      <button class="btn" type="button" id="dReserve">${st.state === 'reserved' ? 'Update reservation' : 'Reserve stock'}</button>
      ${st.lines.some((l) => l.reserved.length) ? '<button class="btn" type="button" id="dRelease">Release</button>' : ''}</div>` : ''}`;
  renderIcons();
}

async function reserveStock() {
  const allocations = [];
  for (const row of $$('#dStock [data-line]')) {
    for (const a of row.querySelectorAll('.alloc-row')) {
      const b = a.querySelector('[data-alloc-batch]').value;
      const q = a.querySelector('[data-alloc-qty]').value.trim();
      if (b || (q && q !== '0')) allocations.push({ batch_id: b, quantity: q });
    }
  }
  const saved = $('#dSaved');
  saved.className = 'saved pending';
  saved.textContent = 'Reserving…';
  try {
    const r = await api(`/api/inventory/shipments/${currentShip().id}/reserve`, { method: 'POST', body: JSON.stringify({ allocations }) });
    state.stock = r.stock;
    renderStock();
    saved.className = 'saved';
    saved.textContent = 'Stock reserved';
  } catch (err) { saved.className = 'saved failed'; saved.textContent = err.message; }
}

async function releaseStock() {
  const saved = $('#dSaved');
  try {
    const r = await api(`/api/inventory/shipments/${currentShip().id}/release`, { method: 'POST' });
    state.stock = r.stock;
    renderStock();
    saved.className = 'saved';
    saved.textContent = 'Reservation released';
  } catch (err) { saved.className = 'saved failed'; saved.textContent = err.message; }
}

/* ---------------------------------------------- one shipment, several orders */

/** The orders ticked so far, and whether they can travel together. */
function renderSelection() {
  const list = [...state.sel.values()];
  $('#selBar').hidden = !list.length;
  if (!list.length) return;
  const first = list[0];
  const mixed = list.some((o) => o.channel !== first.channel || (o.dispatch_type || '') !== (first.dispatch_type || '')
    || (o.destination_id ?? null) !== (first.destination_id ?? null));
  $('#selText').innerHTML = `<b>${count(list.length)}</b> order${list.length > 1 ? 's' : ''} chosen`
    + (mixed ? ' · <span class="warn-text">only orders of the same channel, type and destination can share a shipment</span>' : '');
  $('#selShip').disabled = mixed;
}

function togglePick(id, on) {
  const o = state.orders.find((x) => x.id === id) || (state.detail?.order.id === id ? state.detail.order : null);
  if (on && o) state.sel.set(id, o); else state.sel.delete(id);
  renderSelection();
}

function openShipNew() {
  const list = [...state.sel.values()];
  if (!list.length) return;
  const f = $('#shipNewForm');
  f.reset();
  $('#sError').hidden = true;
  $('#sSaved').textContent = '';
  f.courier_partner_id.innerHTML = opt('', 'Choose courier', true)
    + state.meta.couriers.filter((c) => c.active).map((c) => opt(c.id, c.name)).join('');
  $('#sTitle').textContent = list.length > 1 ? `Create Shipment · ${list.length} orders` : 'Create Shipment';
  const total = list.reduce((n, o) => n + (o.order_value || 0), 0);
  $('#sTotal').textContent = `${list[0].channel_label}${list[0].dispatch_type ? ` · ${typeLabel(list[0].dispatch_type)}` : ''} · ${money(total)}`;
  $('#sOrders').innerHTML = list.map((o, i) => `<li><span class="mono">${esc(o.source_order_id)}</span>
    ${i === 0 ? '<span class="mini-tag">Main</span>' : ''}<span class="soft">${esc(day(o.order_date))}</span><span class="num">${esc(amount(o.order_value))}</span>
    <button type="button" class="icon-btn bare" data-unpick="${o.id}" title="Leave out" aria-label="Leave order ${esc(o.source_order_id)} out">${icon('x')}</button></li>`).join('');
  $('#shipDrawer').hidden = false;
  $('#drawerScrim').hidden = false;
  renderIcons();
  f.courier_partner_id.focus();
}

function closeShipNew() {
  $('#shipDrawer').hidden = true;
  if ($('#drawer').hidden && $('#formDrawer').hidden && $('#createDrawer').hidden && $('#importDrawer').hidden) $('#drawerScrim').hidden = true;
}

async function submitShipNew(e) {
  e.preventDefault();
  const f = $('#shipNewForm');
  const err = $('#sError');
  err.hidden = true;
  if (!f.courier_partner_id.value) { err.textContent = 'Choose the courier partner.'; err.hidden = false; return; }
  if (!f.tracking_id.value.trim()) { err.textContent = 'Enter the AWB / tracking ID.'; err.hidden = false; return; }
  $('#sSubmit').disabled = true;
  $('#sSaved').textContent = 'Creating…';
  try {
    const r = await api('/api/orders/shipments/from-orders', {
      method: 'POST',
      body: JSON.stringify({
        order_ids: [...state.sel.keys()], courier_partner_id: f.courier_partner_id.value,
        tracking_id: f.tracking_id.value.trim(), tracking_url: f.tracking_url.value.trim() || undefined,
        shipment_status: f.shipment_status.value,
      }),
    });
    state.sel.clear();
    closeShipNew();
    load();
    openOrder(r.orderId, { shipmentId: r.shipmentId });
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    $('#sSubmit').disabled = false;
    $('#sSaved').textContent = '';
  }
}

/* ---------------------------------------------------------- Amazon import */

const imp = { file: null, busy: false, done: false };

function openImport() {
  imp.file = null; imp.done = false;
  $('#iFile').value = '';
  $('#iResult').innerHTML = '';
  $('#iError').hidden = true;
  $('#iSaved').textContent = '';
  $('#iSubmit').disabled = true;
  $('#iSubmit').textContent = 'Import';
  $('#iCancel').textContent = 'Cancel';
  $('#importDrawer').hidden = false;
  $('#drawerScrim').hidden = false;
  $('#iFile').focus();
  loadImportHistory();
}

async function loadImportHistory() {
  try {
    const { imports } = await api('/api/orders/import/history');
    $('#iHistory').innerHTML = imports.length ? `<section class="dsec">
      <h3 class="dsec-title">Recent imports</h3>
      <div class="imp-scroll"><table class="imp-errors"><thead><tr><th>When</th><th>By</th><th>File</th><th>Rows</th><th>New</th><th>Updated</th><th>Items</th><th>Dup.</th><th>Errors</th></tr></thead><tbody>
      ${imports.map((x) => `<tr><td>${esc(dateTime(x.imported_at))}</td><td>${esc(x.imported_by || '—')}</td><td>${esc(x.filename || '—')}</td>
        <td class="num">${count(x.rows_processed)}</td><td class="num">${count(x.orders_created)}</td><td class="num">${count(x.orders_updated)}</td>
        <td class="num">${count(x.items_created)}</td><td class="num">${count(x.duplicate_rows)}</td><td class="num">${count(x.error_rows)}</td></tr>`).join('')}
      </tbody></table></div></section>` : '';
  } catch { $('#iHistory').innerHTML = ''; }
}

function closeImport() {
  if (imp.busy) return;
  $('#importDrawer').hidden = true;
  if ($('#drawer').hidden && $('#formDrawer').hidden && $('#createDrawer').hidden) $('#drawerScrim').hidden = true;
}

const importError = (msg) => { $('#iError').textContent = msg; $('#iError').hidden = !msg; };

async function sendImport(step) {
  const res = await fetch(`/api/orders/import/amazon/${step}`, {
    method: 'POST', body: imp.file, headers: { 'x-filename': encodeURIComponent(imp.file.name) },
  });
  const data = await res.json().catch(() => ({ ok: false, error: res.status === 413 ? 'The file is too large (15 MB at most).' : `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const stat = (n, text, tone = '') => `<div class="imp-stat ${tone}"><b>${typeof n === 'number' ? count(n) : esc(n)}</b><span>${esc(text)}</span></div>`;

function errorTable(errors, total) {
  if (!total) return '';
  return `<section class="dsec">
      <h3 class="dsec-title">Rows not imported <span class="dsec-meta soft">${count(total)}${total > errors.length ? `, first ${count(errors.length)} shown` : ''}</span></h3>
      <p class="imp-note" style="margin:0 0 4px">An order with any bad row is left out whole, so it is never half-imported. Fix the file and import it again.</p>
      <div class="imp-scroll"><table class="imp-errors"><thead><tr><th>Row</th><th>Order</th><th>Reason</th></tr></thead><tbody>
        ${errors.map((e) => `<tr><td class="mono">${e.row}</td><td class="mono">${esc(e.orderId || '—')}</td><td>${esc(e.reason)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
}

async function previewImport() {
  importError('');
  $('#iSubmit').disabled = true;
  if (!imp.file) { $('#iResult').innerHTML = ''; return; }
  $('#iResult').innerHTML = '<section class="dsec"><p class="muted" style="margin:0">Reading the file…</p></section>';
  try {
    const p = await sendImport('preview');
    const s = p.summary;
    $('#iResult').innerHTML = `
      <section class="dsec">
        <h3 class="dsec-title">Preview <span class="dsec-meta soft">nothing saved yet</span></h3>
        <div class="imp-stats">
          ${stat(s.rows, 'Rows in file')}
          ${stat(s.ordersInFile, 'Unique orders')}
          ${stat(s.lineItems, 'Line items')}
          ${stat(s.newOrders, 'New orders')}
          ${stat(s.existingOrders, `Already here${s.existingOrders ? ` (${count(s.ordersToUpdate)} to update)` : ''}`)}
          ${stat(s.newLineItems, 'New line items')}
          ${stat(s.duplicateRows, 'Duplicate rows', s.duplicateRows ? 'warn' : '')}
          ${stat(p.errorCount, 'Rows with errors', p.errorCount ? 'bad' : '')}
          ${stat(money(s.orderValue), 'Order value in file')}
          ${stat(s.unmappedSkus, 'Unmapped SKUs', s.unmappedSkus ? 'warn' : '')}
        </div>
        ${p.unmapped?.length ? `<p class="imp-note"><b>Unmapped SKUs:</b> ${p.unmapped.slice(0, 12).map((u) => `<span class="mono">${esc(u.code || '—')}</span> (${count(u.lines)})`).join(', ')}${p.unmapped.length > 12 ? ` and ${count(p.unmapped.length - 12)} more` : ''}.
          These orders import normally but show "Briyo SKU not mapped" and cannot be dispatched until an admin maps each code to a Briyo SKU in Inventory. No SKU is created.</p>` : ''}
        <p class="imp-note">${[
          s.promotionRows && `${count(s.promotionRows)} promotion row${s.promotionRows > 1 ? 's' : ''} folded into their items.`,
          s.skippedOrders && `${count(s.skippedOrders)} order${s.skippedOrders > 1 ? 's' : ''} will be skipped because of errors.`,
          'Order value is what buyers paid: items with tax, plus shipping, less discounts.',
        ].filter(Boolean).map(esc).join(' ')}</p>
      </section>
      ${errorTable(p.errors, p.errorCount)}`;
    const work = s.newOrders + s.ordersToUpdate;
    $('#iSubmit').disabled = !work;
    $('#iSubmit').textContent = work ? `Import ${count(work)} order${work > 1 ? 's' : ''}` : 'Nothing to import';
  } catch (err) {
    $('#iResult').innerHTML = '';
    importError(err.message);
  }
}

async function commitImport() {
  if (!imp.file || imp.busy) return;
  imp.busy = true;
  $('#iSubmit').disabled = true;
  $('#iSaved').textContent = 'Importing…';
  try {
    const r = await sendImport('commit');
    const s = r.summary;
    imp.done = true;
    $('#iResult').innerHTML = `
      <section class="dsec">
        <h3 class="dsec-title">Imported <span class="dsec-meta">${indicator('completed')}</span></h3>
        <div class="imp-stats">
          ${stat(s.ordersCreated, 'Orders added')}
          ${stat(s.ordersUpdated, 'Orders updated')}
          ${stat(s.ordersUnchanged, 'Already up to date')}
          ${stat(s.lineItemsAdded, 'Line items added')}
          ${stat(s.lineItemsUpdated, 'Line items updated')}
          ${stat(s.duplicateRows, 'Duplicate rows skipped', s.duplicateRows ? 'warn' : '')}
          ${stat(r.errorCount, 'Rows not imported', r.errorCount ? 'bad' : '')}
        </div>
        <p class="imp-note">No shipments were created. To ship, tick the orders in the list (Shipment → No shipment yet) and choose Create Shipment.</p>
      </section>
      ${errorTable(r.errors, r.errorCount)}`;
    $('#iSaved').textContent = '';
    $('#iSubmit').textContent = 'Done';
    $('#iSubmit').disabled = false;
    $('#iCancel').textContent = 'Close';
    load();
    loadImportHistory();
  } catch (err) {
    $('#iSaved').textContent = '';
    importError(`${err.message} Nothing was saved.`);
    $('#iSubmit').disabled = false;
  } finally {
    imp.busy = false;
  }
}

function bind() {
  const ids = { status: 'fstatus', shipment: 'fshipment', courier: 'fcourier', invoice: 'finvoice', tracking: 'ftracking', from: 'ffrom', to: 'fto' };
  for (const [k, id] of Object.entries(ids)) {
    $(`#${id}`).addEventListener('change', (e) => {
      state.f[k] = e.target.value;
      e.target.classList.toggle('on', Boolean(e.target.value));
      writeUrl(); load();
    });
  }
  // Channel and destination options depend on the tab, so they are filled by renderTabs.
  $('#fchannel').addEventListener('change', (e) => {
    state.f.channel = e.target.value;
    state.f.destination = '';   // a destination belongs to one channel
    writeUrl(); load();
  });
  $('#fdest').addEventListener('change', (e) => { state.f.destination = e.target.value; writeUrl(); load(); });
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.f.q = e.target.value.trim(); writeUrl(); load(); }, 250);
  });
  $('#fclear').addEventListener('click', () => {
    for (const k of FILTER_KEYS) state.f[k] = '';
    fillFilters(); writeUrl(); load();
  });
  // A dispatch-type tab is a place you can go Back to, so it is a history entry.
  $('#channelTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-type]');
    if (!b || b.dataset.type === state.type) return;
    navigate(typeUrl(b.dataset.type));
  });
  const rowOpen = (e) => {
    if (e.target.closest('a, .pick')) return;
    const r = e.target.closest('[data-id]');
    if (r) openOrder(Number(r.dataset.id));
  };
  for (const host of [$('#rows'), $('#clist')]) {
    host.addEventListener('change', (e) => {
      const box = e.target.closest('[data-pick]');
      if (box) togglePick(Number(box.dataset.pick), box.checked);
    });
  }
  $('#selClear').addEventListener('click', () => { state.sel.clear(); renderRows(); });
  $('#selShip').addEventListener('click', openShipNew);
  $('#sClose').addEventListener('click', closeShipNew);
  $('#sCancel').addEventListener('click', closeShipNew);
  $('#shipNewForm').addEventListener('submit', submitShipNew);
  $('#sOrders').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpick]');
    if (!b) return;
    state.sel.delete(Number(b.dataset.unpick));
    renderRows();
    if (state.sel.size) openShipNew(); else closeShipNew();
  });
  $('#rows').addEventListener('click', rowOpen);
  $('#clist').addEventListener('click', rowOpen);
  for (const host of [$('#rows'), $('#clist')]) {
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter') rowOpen(e); });
  }
  $('#moreBtn').addEventListener('click', () => load({ append: true }));
  $('#refresh').addEventListener('click', () => { load(); if (state.openId) openOrder(state.openId); });
  $('#newShipment').addEventListener('click', openCreate);
  $('#importOrders').addEventListener('click', openImport);
  $('#iClose').addEventListener('click', closeImport);
  $('#iCancel').addEventListener('click', closeImport);
  $('#iFile').addEventListener('change', (e) => { imp.file = e.target.files[0] || null; imp.done = false; previewImport(); });
  $('#iSubmit').addEventListener('click', () => (imp.done ? closeImport() : commitImport()));
  $('#cClose').addEventListener('click', closeCreate);
  $('#cCancel').addEventListener('click', closeCreate);
  $('#dClose').addEventListener('click', closeDrawer);
  $('#fClose').addEventListener('click', closeForm);
  $('#fCancel').addEventListener('click', closeForm);
  const closeTop = () => {
    if (!$('#shipDrawer').hidden) closeShipNew();
    else if (!$('#importDrawer').hidden) closeImport();
    else if (!$('#createDrawer').hidden) closeCreate();
    else if (!$('#formDrawer').hidden) closeForm();
    else if (!$('#drawer').hidden) closeDrawer();
  };
  $('#drawerScrim').addEventListener('click', closeTop);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTop(); }, { signal: pageSignal() });
  onLeave(() => clearTimeout(t));
  // Same page, new query (a sidebar channel or queue link, Back/Forward):
  // refresh the list in place, keeping scroll, instead of reloading the page.
  onQueryChange(async () => {
    const wasOpen = state.openId;
    readUrl();
    fillFilters();
    const loading = load();
    if (state.openId && state.openId !== wasOpen) openOrder(state.openId);
    else if (!state.openId && !$('#drawer').hidden) closeDrawer();
    await loading;
  });
}

(async function init() {
  try {
    // The orders themselves do not depend on meta: request all three at once
    // rather than waiting for meta before asking for the orders.
    readUrl();
    const firstOrders = api(ordersUrl(false));
    firstOrders.catch(() => {});
    const [me, meta] = await Promise.all([api('/auth/me'), ordersMeta()]);
    state.meta = meta;
    setTimezone(meta.timezone);
    for (const el of $$('.tz-note')) el.textContent = meta.timezone === 'Asia/Kolkata' ? '(IST)' : `(${meta.timezone})`;
    initShell(me);
    fillFilters();
    bind();
    await load({ pending: firstOrders });
    if (state.openId) openOrder(state.openId);
  } catch (err) {
    $('#pageSub').textContent = '';
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}());
