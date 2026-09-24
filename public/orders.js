/**
 * Orders & Logistics — All orders, channel tabs, the logistics queues, the
 * order drawer and manual create/edit. Everything reads /api/orders; channels,
 * couriers and statuses come from /api/orders/meta, never from this file.
 */
import {
  $, $$, esc, money, count, icon, renderIcons, setTimezone, dateShort, dateTime, initShell,
} from './ui/components.js';

const LABEL_OVERRIDES = { rto: 'RTO', not_ready: 'Not ready', cod: 'COD', third_party: 'Third party' };
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
  history.replaceState(null, '', qs ? `/orders?${qs}` : '/orders');
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
  $('#pageSub').textContent = `${count(data.total)} ${data.total === 1 ? 'order' : 'orders'} · ${money(data.totalValue)} order value`;
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
  return o.tracking_url
    ? `<a class="track-link mono" href="${esc(o.tracking_url)}" target="_blank" rel="noopener noreferrer" title="Open the courier's tracking page">${esc(o.tracking_id)}</a>`
    : `<span class="mono">${esc(o.tracking_id)}</span>`;
}

function renderRows() {
  const empty = state.total === 0
    ? (anyFilter() || state.channel || state.view
      ? '<b>No orders match.</b>Try clearing a filter.'
      : '<b>No orders yet.</b>Create one with New order.')
    : '';
  if (empty) {
    $('#rows').innerHTML = `<tr><td colspan="11"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return;
  }
  $('#rows').innerHTML = state.orders.map((o) => `
    <tr class="orow${o.id === state.openId ? ' open' : ''}" data-id="${o.id}" tabindex="0">
      <td><span class="cell-main" style="font-weight:500">${esc(o.internal_order_id)}</span>
          <span class="cell-sub muted mono" title="Source order ID">${esc(o.source_order_id)}</span></td>
      <td><span class="chan">${esc(o.channel_label)}</span></td>
      <td><span class="cell-main">${o.customer_name ? esc(o.customer_name) : '<span class="muted-cell">—</span>'}</span>
          ${o.customer_phone ? `<span class="cell-sub muted">${esc(o.customer_phone)}</span>` : ''}</td>
      <td class="r num">${esc(money(o.order_value))}</td>
      <td>${indicator(o.order_status)}</td>
      <td>${indicator(o.shipment_status)}</td>
      <td class="col-courier">${o.courier_name ? esc(o.courier_name) : '<span class="muted-cell">—</span>'}</td>
      <td class="col-track">${trackingCell(o)}</td>
      <td>${o.has_invoice ? `<span class="yes">${icon('check')}Yes</span>` : '<span class="muted-cell">No</span>'}</td>
      <td class="num">${esc(dateShort(o.order_date))}</td>
      <td class="r"><button class="icon-btn bare" type="button" data-open="${o.id}" title="Open order" aria-label="Open ${esc(o.internal_order_id)}">${icon('chevron-right')}</button></td>
    </tr>`).join('');
  $('#clist').innerHTML = state.orders.map((o) => `
    <li class="oitem" data-id="${o.id}" tabindex="0">
      <div class="oi-top"><span class="oi-id">${esc(o.internal_order_id)}</span><span class="chan">${esc(o.channel_label)}</span>
        <span class="oi-val">${esc(money(o.order_value))}</span></div>
      <div class="oi-sub">${esc(o.customer_name || 'No customer name')} · ${esc(dateShort(o.order_date))} · <span class="mono">${esc(o.source_order_id)}</span></div>
      <div class="oi-stat">${indicator(o.order_status)}${indicator(o.shipment_status)}
        ${o.tracking_id ? `<span class="soft" style="font-size:12.5px">${esc(o.courier_name || '')} ${esc(o.tracking_id)}</span>` : ''}
        ${o.has_invoice ? `<span class="yes">${icon('check')}Invoice</span>` : ''}</div>
    </li>`).join('');
  renderIcons();
}

/* ------------------------------------------------------------------ drawer */

async function openOrder(id) {
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

function renderDrawer() {
  const { order: o, shipments, documents, events } = state.detail;
  const m = state.meta;
  const ship = shipments[0];
  const courier = courierById(ship.courier_partner_id);
  const autoLink = Boolean(courier?.tracking_url_template);
  const notes = events.filter((e) => e.event_type === 'note_added');

  $('#dTitle').textContent = o.internal_order_id;
  $('#dSub').textContent = `${o.channel_label} · ${o.source_order_id} · ${dateTime(o.order_date)}`;

  $('#dBody').innerHTML = `
    <section class="dsec">
      <h3 class="dsec-title">Order <span class="dsec-meta num">${esc(money(o.order_value))}</span></h3>
      <dl class="kv">
        <dt>Channel</dt><dd>${esc(o.channel_label)}</dd>
        <dt>Source order ID</dt><dd class="mono">${esc(o.source_order_id)}</dd>
        <dt>Order date</dt><dd>${esc(dateTime(o.order_date))}</dd>
        <dt>Payment</dt><dd>${esc([o.payment_method && label(o.payment_method), o.payment_status && label(o.payment_status)].filter(Boolean).join(' · ') || 'Not known')}</dd>
        <dt>Fulfillment</dt><dd>${esc(o.fulfillment_type ? label(o.fulfillment_type) : 'Not set')}</dd>
        <dt>Entered</dt><dd>${esc(o.created_by || 'System')}, ${esc(dateTime(o.created_at))}${o.source !== 'manual' ? ` · via ${esc(o.source)}` : ''}</dd>
      </dl>
      <div class="d-row" style="margin-top:12px">
        <label class="d-label" for="dOrderStatus">Order status</label>
        <select class="select" id="dOrderStatus">${m.orderStatuses.map((s) => opt(s, label(s), s === o.order_status)).join('')}</select>
      </div>
      <div class="form-actions"><button class="btn" type="button" id="dEdit">${icon('pencil')}Edit order details</button></div>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Customer</h3>
      <dl class="kv">
        <dt>Name</dt><dd>${esc(o.customer_name || '—')}</dd>
        <dt>Phone</dt><dd>${o.customer_phone ? `<a class="track-link" href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a>` : '—'}</dd>
        <dt>Email</dt><dd>${esc(o.customer_email || '—')}</dd>
      </dl>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Shipment${shipments.length > 1 ? ` 1 of ${shipments.length}` : ''} <span class="dsec-meta">${indicator(ship.shipment_status)}</span></h3>
      <form id="shipForm" class="form-grid" novalidate>
        <label class="fld"><span>Courier</span>
          <select class="select" name="courier_partner_id">${opt('', 'Choose courier', !ship.courier_partner_id)}
            ${m.couriers.filter((c) => c.active || c.id === ship.courier_partner_id).map((c) => opt(c.id, c.name, c.id === ship.courier_partner_id)).join('')}
          </select></label>
        <label class="fld"><span>AWB / tracking ID</span><input class="input mono" name="tracking_id" value="${esc(ship.tracking_id || '')}" maxlength="80" autocomplete="off" /></label>
        <label class="fld wide"><span>Tracking link</span>
          <input class="input" name="tracking_url" value="${esc(ship.tracking_url || '')}" ${autoLink ? 'readonly' : ''}
                 placeholder="${autoLink ? 'Filled from the courier and AWB' : 'Paste a link, if the courier gives one'}" maxlength="500" autocomplete="off" />
          <span class="help" id="trackHelp">${trackHelp(courier)}</span>
          ${ship.tracking_url ? `<span class="help"><a class="track-link" href="${esc(ship.tracking_url)}" target="_blank" rel="noopener noreferrer">Open tracking</a></span>` : ''}</label>
        <label class="fld"><span>Expected delivery</span><input class="input" type="date" name="expected_delivery_date" value="${esc(ship.expected_delivery_date || '')}" /></label>
        <label class="fld"><span>Shipment status</span>
          <select class="select" name="shipment_status">${m.shipmentStatuses.map((s) => opt(s, label(s), s === ship.shipment_status)).join('')}</select></label>
      </form>
      <div class="form-actions"><button class="btn primary" type="button" id="dShipSave">Save shipment</button></div>
      ${(NEXT_STEPS[ship.shipment_status] || []).length ? `<div class="steps">
        ${NEXT_STEPS[ship.shipment_status].map((s) => `<button class="btn" type="button" data-step="${s}">${esc(STEP_TEXT[s])}</button>`).join('')}
      </div>` : ''}
      <dl class="kv" style="margin-top:12px">
        <dt>Dispatched</dt><dd>${ship.dispatch_date ? esc(dateTime(ship.dispatch_date)) : '—'}</dd>
        <dt>Delivered</dt><dd>${ship.delivered_at ? esc(dateTime(ship.delivered_at)) : '—'}</dd>
      </dl>
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Documents <span class="dsec-meta soft">${count(documents.filter((d) => !d.removed_at).length)}</span></h3>
      ${documents.length ? `<ul class="docs">${documents.map((d) => `
        <li class="doc${d.removed_at ? ' removed' : ''}">
          ${icon(d.mime_type === 'application/pdf' ? 'file-text' : 'image')}
          <div class="doc-name">
            <a href="/api/orders/${o.id}/documents/${d.id}" target="_blank" rel="noopener">${esc(d.original_filename)}</a>
            <div class="doc-meta">${esc(label(d.document_type))} · ${esc(bytes(d.file_size))} · ${esc(d.uploaded_by || 'Someone')}, ${esc(dateTime(d.uploaded_at))}
              ${d.removed_at ? ` · removed by ${esc(d.removed_by || 'someone')}` : ''}</div>
          </div>
          ${d.removed_at ? '' : `<button class="icon-btn bare" type="button" data-remove-doc="${d.id}" title="Remove" aria-label="Remove ${esc(d.original_filename)}">${icon('trash-2')}</button>`}
        </li>`).join('')}</ul>` : '<p class="soft" style="margin:0;font-size:12.5px">No documents yet.</p>'}
      ${m.storage.error ? `<div class="storage-note">${esc(m.storage.error)}</div>` : `<form class="upload" id="uploadForm">
        <select class="select" name="type" aria-label="Document type">${m.documentTypes.map((t) => opt(t, label(t), t === 'tax_invoice')).join('')}</select>
        <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" aria-label="File" />
        <button class="btn" type="submit" id="uploadBtn">${icon('upload')}Upload</button>
      </form>
      <div class="doc-meta" style="margin-top:6px">PDF, PNG or JPG, up to ${bytes(m.maxDocumentBytes)}.</div>`}
      ${m.storage.driver === 'local' ? '<div class="storage-note">Development storage (this machine\'s disk). Production uses R2.</div>' : ''}
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Notes</h3>
      <textarea class="input" id="dNote" placeholder="Add a note — it is saved to the timeline and cannot be edited" maxlength="2000"></textarea>
      <div class="form-actions"><button class="btn" type="button" id="dNoteAdd">Add note</button></div>
      ${notes.length ? `<ul class="d-history" style="margin-top:12px">${notes.slice(0, 5).map((n) => `
        <li><span style="min-width:0;white-space:pre-wrap">${esc(n.metadata.note)}</span><span class="d-when">${esc(n.actor || 'Someone')}, ${esc(dateTime(n.at))}</span></li>`).join('')}</ul>` : ''}
    </section>

    <section class="dsec">
      <h3 class="dsec-title">Activity timeline</h3>
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
  order_value: 'value', source_order_id: 'source ID', customer_name: 'name', customer_phone: 'phone',
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
    case 'order_created': return ['plus', 'info', `Order created · ${esc(channelLabel(md.channel))} ${esc(md.source_order_id)} · ${esc(money(md.order_value))}`];
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
    case 'document_uploaded': return ['file-up', 'good', `Uploaded ${esc(label(md.document_type).toLowerCase())} · ${esc(md.filename)}`];
    case 'document_removed': return ['file-x', 'warn', `Removed ${esc(label(md.document_type).toLowerCase())} · ${esc(md.filename)}`];
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
  const ship = state.detail.shipments[0];
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
dBody.addEventListener('change', (e) => {
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
    if (!confirm('Remove this document from the order? It stays in the activity record.')) return;
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
  // Checked here for a quick answer; the server checks again, including the bytes.
  if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) { saved.className = 'saved failed'; saved.textContent = 'Only PDF, PNG, JPG and JPEG files can be uploaded.'; return; }
  if (file.size > state.meta.maxDocumentBytes) { saved.className = 'saved failed'; saved.textContent = `Files must be ${bytes(state.meta.maxDocumentBytes)} or smaller.`; return; }
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

function openForm(order = null) {
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
    form.order_value.value = order.order_value;
    form.order_date.value = toTeamInput(order.order_date);
  } else {
    form.order_date.value = toTeamInput(new Date().toISOString());
  }
  $('#fTitle').textContent = order ? `Edit ${order.internal_order_id}` : 'New order';
  $('#fSub').textContent = order ? 'Every change is recorded in the timeline.' : 'Logistics details are added after the order exists.';
  $('#fSubmit').textContent = order ? 'Save changes' : 'Create order';
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
  const missing = [['channel', 'channel'], ['source_order_id', 'source order ID'], ['order_date', 'order date'], ['order_value', 'order value']]
    .filter(([k]) => !String(body[k] || '').trim()).map(([, l]) => l);
  if (missing.length) { err.textContent = `Enter the ${missing.join(', ')}.`; err.hidden = false; return; }
  // Sent as wall-clock time; the server reads it in the team's timezone.
  const btn = $('#fSubmit');
  btn.disabled = true;
  try {
    if (state.editing) {
      const o = state.editing;
      await api(`/api/orders/${o.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: o.version }) });
      closeForm();
      await openOrder(o.id);
      $('#dSaved').textContent = 'Order details saved';
    } else {
      const data = await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      closeForm();
      await load();
      openOrder(data.order.id);
    }
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
  $('#channelTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-channel]');
    if (!b) return;
    state.channel = b.dataset.channel;
    writeUrl(); load();
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
  $('#newOrder').addEventListener('click', () => openForm());
  $('#dClose').addEventListener('click', closeDrawer);
  $('#fClose').addEventListener('click', closeForm);
  $('#fCancel').addEventListener('click', closeForm);
  $('#drawerScrim').addEventListener('click', () => { if (!$('#formDrawer').hidden) closeForm(); else closeDrawer(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#formDrawer').hidden) closeForm(); else if (!$('#drawer').hidden) closeDrawer();
  });
}

(async function init() {
  try {
    const [me, meta] = await Promise.all([api('/auth/me'), api('/api/orders/meta')]);
    state.meta = meta;
    setTimezone(meta.timezone);
    $('#tzNote').textContent = meta.timezone === 'Asia/Kolkata' ? '(IST)' : `(${meta.timezone})`;
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
