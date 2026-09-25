/**
 * Orders & Logistics — All orders, channel tabs, the logistics queues, the
 * order drawer and manual create/edit. Everything reads /api/orders; channels,
 * couriers and statuses come from /api/orders/meta, never from this file.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dateShort, dateTime, initShell, pageFetch,
  navigate, pageSignal, onLeave, onQueryChange,
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
const FILTER_KEYS = ['q', 'status', 'shipment', 'courier', 'invoice', 'tracking', 'from', 'to'];

const state = {
  meta: null,
  channel: '',
  view: '',
  f: Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])),
  orders: [],
  total: 0,
  offset: 0,
  openId: null,
  detail: null,
  editing: null,
  retry: null,       // uploads that failed, kept (with their files) for Retry
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
const courierById = (id) => state.meta.couriers.find((c) => c.id === Number(id));

/* ------------------------------------------------------------------ URL state */

function readUrl() {
  const u = new URLSearchParams(window.location.search);
  state.channel = u.get('channel') || '';
  state.view = u.get('view') || '';
  for (const k of FILTER_KEYS) state.f[k] = u.get(k) || '';
  const open = u.get('open');
  state.openId = open && /^\d+$/.test(open) ? Number(open) : null;
}

function writeUrl() {
  const u = new URLSearchParams();
  if (state.channel) u.set('channel', state.channel);
  if (state.view) u.set('view', state.view);
  for (const k of FILTER_KEYS) if (state.f[k]) u.set(k, state.f[k]);
  if (state.openId) u.set('open', state.openId);
  const qs = u.toString();
  // Filters and the open order refine the current entry; history.state carries
  // the scroll position for Back, so it is kept.
  history.replaceState(history.state, '', qs ? `/orders?${qs}` : '/orders');
}

/** The URL for this list with a different channel, keeping the other filters. */
function channelUrl(channel) {
  const u = new URL(window.location.href);
  if (channel) u.searchParams.set('channel', channel); else u.searchParams.delete('channel');
  u.searchParams.delete('open');
  return u.pathname + u.search;
}

/* ------------------------------------------------------------------ list */

async function load({ append = false } = {}) {
  const u = new URLSearchParams();
  if (state.channel) u.set('channel', state.channel);
  if (state.view) u.set('view', state.view);
  for (const k of FILTER_KEYS) if (state.f[k]) u.set(k, state.f[k]);
  u.set('limit', PAGE);
  u.set('offset', append ? state.offset : 0);
  try {
    const data = await api(`/api/orders?${u}`);
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
  const title = view || (state.channel ? `${channelLabel(state.channel)} orders` : 'All orders');
  $('#pageTitle').textContent = title;
  $('#crumbGroup').textContent = view ? 'Logistics' : 'Orders';
  $('#crumbHere').textContent = view || (state.channel ? channelLabel(state.channel) : 'All orders');
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
    ...state.meta.channels.filter((c) => c.active || data.channelCounts[c.key])
      .map((c) => ({ key: c.key, label: c.label, n: data.channelCounts[c.key] || 0 }))];
  $('#channelTabs').innerHTML = tabs.map((t) => `<button type="button" role="tab" class="tab${t.key === state.channel ? ' active' : ''}"
      data-channel="${esc(t.key)}" aria-selected="${t.key === state.channel}">${esc(t.label)}<span class="tab-count">${count(t.n)}</span></button>`).join('');
}

function trackingCell(o) {
  if (!o.tracking_id) return '<span class="muted-cell">—</span>';
  const more = o.shipment_count > 1 ? ` <span class="mini-tag" title="${o.shipment_count} shipments on this order">+${o.shipment_count - 1}</span>` : '';
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
    ? (anyFilter() || state.channel || state.view
      ? '<b>Nothing matches.</b>Try clearing a filter.'
      : '<b>No shipments yet.</b>Add one with New Shipment.')
    : '';
  if (empty) {
    $('#rows').innerHTML = `<tr><td colspan="10"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return;
  }
  $('#rows').innerHTML = state.orders.map((o) => `
    <tr class="orow${o.id === state.openId ? ' open' : ''}" data-id="${o.id}" tabindex="0">
      <td><span class="cell-main mono" style="font-weight:500">${esc(o.source_order_id)}${cancelledTag(o)}</span></td>
      <td><span class="chan">${esc(o.channel_label)}</span></td>
      <td>${o.courier_name ? esc(o.courier_name) : '<span class="muted-cell">—</span>'}</td>
      <td>${trackingCell(o)}</td>
      <td>${indicator(o.shipment_status)}</td>
      <td>${proofCell(o)}</td>
      <td class="num"${o.order_date ? '' : ' title="No order date — shown by when it was entered"'}>${esc(day(o.order_date))}</td>
      <td class="col-cust"><span class="cell-main">${o.customer_name ? esc(o.customer_name) : '<span class="muted-cell">—</span>'}</span></td>
      <td class="r num col-amt">${esc(amount(o.order_value))}</td>
      <td class="r"><button class="icon-btn bare" type="button" data-open="${o.id}" title="Open" aria-label="Open order ${esc(o.source_order_id)}">${icon('chevron-right')}</button></td>
    </tr>`).join('');
  $('#clist').innerHTML = state.orders.map((o) => `
    <li class="oitem" data-id="${o.id}" tabindex="0">
      <div class="oi-top"><span class="oi-id mono">${esc(o.source_order_id)}</span><span class="chan">${esc(o.channel_label)}</span>${cancelledTag(o)}
        <span class="oi-val">${indicator(o.shipment_status)}</span></div>
      <div class="oi-sub">${o.tracking_id ? `${esc(o.courier_name || '')} · <span class="mono">${esc(o.tracking_id)}</span>` : 'No courier / AWB yet'}</div>
      <div class="oi-stat"><span class="soft" style="font-size:12.5px">${esc(day(o.order_date))}</span>
        ${proofCell(o)}
        ${o.order_value !== null ? `<span class="soft" style="font-size:12.5px">${esc(amount(o.order_value))}</span>` : ''}</div>
    </li>`).join('');
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

const docUrl = (o, d) => `/api/orders/${o.id}/documents/${d.id}`;

function docRows(o, list) {
  return `<ul class="docs">${list.map((d) => `
    <li class="doc${d.removed_at ? ' removed' : ''}">
      ${icon(d.mime_type === 'application/pdf' ? 'file-text' : 'image')}
      <div class="doc-name">
        <a href="${docUrl(o, d)}" target="_blank" rel="noopener">${esc(d.original_filename)}</a>
        <div class="doc-meta">${list.some((x) => x.document_type !== d.document_type) ? `${esc(label(d.document_type))} · ` : ''}${esc(bytes(d.file_size))} · ${esc(d.uploaded_by || 'Someone')}, ${esc(dateTime(d.uploaded_at))}
          ${d.removed_at ? ` · removed by ${esc(d.removed_by || 'someone')}` : ''}</div>
      </div>
      ${d.removed_at ? '' : `<button class="icon-btn bare" type="button" data-remove-doc="${d.id}" title="Remove" aria-label="Remove ${esc(d.original_filename)}">${icon('trash-2')}</button>`}
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
          <button class="thumb-x" type="button" data-remove-doc="${d.id}" title="Remove photo" aria-label="Remove ${esc(d.original_filename)}">${icon('x')}</button>
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

/** The shipment the drawer is showing. */
const currentShip = () => {
  const list = state.detail.shipments;
  return list.find((x) => x.id === state.shipId) || list[0];
};

function renderDrawer() {
  const { order: o, shipments, documents, events } = state.detail;
  const m = state.meta;
  const ship = currentShip();
  state.shipId = ship.id;
  const courier = courierById(ship.courier_partner_id);
  const autoLink = Boolean(courier?.tracking_url_template);
  const notes = events.filter((e) => e.event_type === 'note_added');
  const live = documents.filter((d) => !d.removed_at);
  const has = (t) => live.some((d) => d.document_type === t);

  $('#dTitle').textContent = `Order ${o.source_order_id}`;
  $('#dSub').textContent = [o.channel_label, o.order_date && dateTime(o.order_date),
    o.order_status === 'cancelled' && 'Order cancelled'].filter(Boolean).join(' · ');

  $('#dBody').innerHTML = `
    <section class="dsec">
      <h3 class="dsec-title">Shipment <span class="dsec-meta">${indicator(ship.shipment_status)}</span></h3>
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
      <div class="form-actions"><button class="btn primary" type="button" id="dShipSave">Save shipment</button>
        ${(NEXT_STEPS[ship.shipment_status] || []).map((s) => `<button class="btn" type="button" data-step="${s}">${esc(STEP_TEXT[s])}</button>`).join('')}</div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Dispatch Proof &amp; Documents</h3>
      ${retryBanner(o.id)}
      ${proofSection(o, documents)}
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Notes</h3>
      <textarea class="input" id="dNote" placeholder="Add a note — it is saved to the activity and cannot be edited" maxlength="2000"></textarea>
      <div class="form-actions"><button class="btn" type="button" id="dNoteAdd">Add note</button></div>
      ${notes.length ? `<ul class="d-history" style="margin-top:12px">${notes.slice(0, 5).map((n) => `
        <li><span style="min-width:0;white-space:pre-wrap">${esc(n.metadata.note)}</span><span class="d-when">${esc(n.actor || 'Someone')}, ${esc(dateTime(n.at))}</span></li>`).join('')}</ul>` : ''}
    </section>

    <details class="dsec more-sec">
      <summary class="dsec-title">Order details <span class="dsec-meta soft">${esc([amount(o.order_value), o.customer_name].filter((x) => x && x !== '—').join(' · ') || 'value, customer, payment')}</span></summary>
      <dl class="kv" style="margin-top:10px">
        <dt>Order Number</dt><dd class="mono">${esc(o.source_order_id)}</dd>
        <dt>Channel</dt><dd>${esc(o.channel_label)}</dd>
        <dt>Order Date</dt><dd>${o.order_date ? esc(dateTime(o.order_date)) : '<span class="muted">Not entered</span>'}</dd>
        <dt>Order Value</dt><dd>${o.order_value === null ? '<span class="muted">Not entered</span>' : esc(`${money(o.order_value)}${o.currency && o.currency !== 'INR' ? ` ${o.currency}` : ''}`)}</dd>
        <dt>Customer</dt><dd>${esc([o.customer_name, o.customer_phone, o.customer_email].filter(Boolean).join(' · ') || '—')}</dd>
        <dt>Payment</dt><dd>${esc([o.payment_method && label(o.payment_method), o.payment_status && label(o.payment_status)].filter(Boolean).join(' · ') || 'Not known')}</dd>
        <dt>Fulfillment</dt><dd>${esc(o.fulfillment_type ? label(o.fulfillment_type) : 'Not set')}</dd>
        <dt>Entered</dt><dd>${esc(o.created_by || 'System')}, ${esc(dateTime(o.created_at))}</dd>
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
  renderIcons();
}

const fmtVal = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'courier_partner_id') return courierById(v)?.name || `#${v}`;
  if (k === 'order_value') return money(v);
  if (k === 'channel') return channelLabel(v);
  if (/_date$|_at$/.test(k) && k !== 'expected_delivery_date') return dateTime(v);
  if (/status$/.test(k)) return label(v);
  return String(v);
};
const FIELD_NAME = {
  order_value: 'value', source_order_id: 'order number', customer_name: 'name', customer_phone: 'phone',
  customer_email: 'email', payment_method: 'payment method', payment_status: 'payment status',
  order_date: 'order date', courier_partner_id: 'courier', tracking_id: 'AWB', tracking_url: 'tracking link',
  expected_delivery_date: 'expected delivery', dispatch_date: 'dispatched', delivered_at: 'delivered',
};
const changeList = (changes) => Object.entries(changes || {})
  .map(([k, c]) => `${esc(FIELD_NAME[k] || label(k).toLowerCase())} <b>${esc(fmtVal(k, c.from))}</b> → <b>${esc(fmtVal(k, c.to))}</b>`)
  .join('; ');

function describeEvent(e) {
  const md = e.metadata || {};
  const ch = md.changes || {};
  switch (e.event_type) {
    case 'shipment_added': return ['package-plus', 'info', 'Another shipment added to this order'];
    case 'order_created': return ['plus', 'info', `Order created · ${esc(channelLabel(md.channel))} ${esc(md.source_order_id)}${md.order_value === null || md.order_value === undefined ? '' : ` · ${esc(money(md.order_value))}`}`];
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
  const url = shipment ? `/api/orders/${o.id}/shipments/${ship.id}` : `/api/orders/${o.id}`;
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
dBody.addEventListener('change', async (e) => {
  if (e.target.id === 'dPhotos') {
    const files = [...e.target.files];
    if (!files.length) return;
    const saved = $('#dSaved');
    const problems = files.map((f) => fileProblem(f, 'dispatch_product_image')).filter(Boolean);
    if (problems.length) { saved.className = 'saved failed'; saved.textContent = problems.join(' '); e.target.value = ''; return; }
    saved.className = 'saved pending';
    const id = state.detail.order.id;
    const failed = await uploadAll(id, files.map((file) => ({ file, type: 'dispatch_product_image' })), saved);
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
  const step = e.target.closest('[data-step]');
  if (step) {
    return patchOrder({ ...shipmentFields(), shipment_status: step.dataset.step },
      STEP_TEXT[step.dataset.step].replace(/^Mark /, 'Marked '), { shipment: true });
  }
  if (e.target.closest('#dEdit')) return openForm(state.detail.order);
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
      await api(`/api/orders/${state.detail.order.id}/documents/${rm.dataset.removeDoc}`, { method: 'DELETE' });
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
    await api(`/api/orders/${state.detail.order.id}/documents?type=${encodeURIComponent(form.type.value)}`, {
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
  form.channel.innerHTML = state.meta.channels.filter((c) => c.active || c.key === order?.channel)
    .map((c) => opt(c.key, c.label, c.key === (order?.channel || state.channel))).join('');
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

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = $('#formError');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(form));
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
  f.channel.innerHTML = opt('', 'Choose channel', !state.channel)
    + m.channels.filter((c) => c.active).map((c) => opt(c.key, c.label, c.key === state.channel)).join('');
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
  (state.channel ? f.source_order_id : f.channel).focus();
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
$('#createForm').addEventListener('change', (e) => {
  if (e.target.name === 'dispatch_files') showPreviews([...e.target.files]);
});

const orderFieldsReset = () => {
  state.addToExisting = false;
  $('#cExists').hidden = true;
  $('#cSubmit').textContent = 'Create Shipment';
};

$('#createForm').addEventListener('input', (e) => {
  // Changing which order this is voids an "add to existing" confirmation.
  if (['channel', 'source_order_id'].includes(e.target.name) && state.addToExisting) orderFieldsReset();
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#cError');
  err.hidden = true;
  const body = Object.fromEntries(new FormData(f));
  delete body.invoice_file; delete body.receipt_file; delete body.dispatch_files;
  const missing = [['channel', 'channel'], ['source_order_id', 'order number'], ['courier_partner_id', 'courier partner'], ['tracking_id', 'tracking ID / AWB']]
    .filter(([k]) => !String(body[k] || '').trim()).map(([, l]) => l);
  if (missing.length) { err.textContent = `Enter the ${missing.join(', ')}.`; err.hidden = false; return; }
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
    showPreviews([]);
    closeCreate();
    await load();
    await openOrder(data.orderId, { shipmentId: data.shipmentId });
    const saved = $('#dSaved');
    saved.className = failed.length ? 'saved failed' : 'saved';
    saved.textContent = failed.length
      ? `Shipment saved, but ${failed.length} of ${items.length} upload${items.length === 1 ? '' : 's'} failed — Retry is under Dispatch Proof.`
      : (data.createdOrder ? 'Shipment created' : 'Shipment added to this order');
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
  $('#fshipment').innerHTML = opt('', 'Shipment') + m.shipmentStatuses.map((s) => opt(s, label(s))).join('');
  $('#fcourier').innerHTML = opt('', 'Courier') + opt('none', 'No courier') + m.couriers.map((c) => opt(c.id, c.name)).join('');
  const ids = { status: 'fstatus', shipment: 'fshipment', courier: 'fcourier', invoice: 'finvoice', tracking: 'ftracking', from: 'ffrom', to: 'fto' };
  for (const [k, id] of Object.entries(ids)) {
    $(`#${id}`).value = state.f[k];
    $(`#${id}`).classList.toggle('on', Boolean(state.f[k]));
  }
  $('#q').value = state.f.q;
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
  let t;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.f.q = e.target.value.trim(); writeUrl(); load(); }, 250);
  });
  $('#fclear').addEventListener('click', () => {
    for (const k of FILTER_KEYS) state.f[k] = '';
    fillFilters(); writeUrl(); load();
  });
  // A channel is a place you can go Back to, so it is a history entry.
  $('#channelTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-channel]');
    if (!b || b.dataset.channel === state.channel) return;
    navigate(channelUrl(b.dataset.channel));
  });
  const rowOpen = (e) => {
    if (e.target.closest('a')) return;
    const r = e.target.closest('[data-id]');
    if (r) openOrder(Number(r.dataset.id));
  };
  $('#rows').addEventListener('click', rowOpen);
  $('#clist').addEventListener('click', rowOpen);
  for (const host of [$('#rows'), $('#clist')]) {
    host.addEventListener('keydown', (e) => { if (e.key === 'Enter') rowOpen(e); });
  }
  $('#moreBtn').addEventListener('click', () => load({ append: true }));
  $('#refresh').addEventListener('click', () => { load(); if (state.openId) openOrder(state.openId); });
  $('#newShipment').addEventListener('click', openCreate);
  $('#cClose').addEventListener('click', closeCreate);
  $('#cCancel').addEventListener('click', closeCreate);
  $('#dClose').addEventListener('click', closeDrawer);
  $('#fClose').addEventListener('click', closeForm);
  $('#fCancel').addEventListener('click', closeForm);
  const closeTop = () => {
    if (!$('#createDrawer').hidden) closeCreate();
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
    const [me, meta] = await Promise.all([api('/auth/me'), api('/api/orders/meta')]);
    state.meta = meta;
    setTimezone(meta.timezone);
    for (const el of $$('.tz-note')) el.textContent = meta.timezone === 'Asia/Kolkata' ? '(IST)' : `(${meta.timezone})`;
    initShell(me);
    readUrl();
    fillFilters();
    bind();
    await load();
    if (state.openId) openOrder(state.openId);
  } catch (err) {
    $('#pageSub').textContent = '';
    $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span></div>`;
    renderIcons();
  }
}());
