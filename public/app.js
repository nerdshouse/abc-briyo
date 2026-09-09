'use strict';

const STATUSES = [
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
];

/** Call-priority ranking for the risk sort. Anything unrecognised sorts last. */
const RISK_ORDER = {
  'high risk': 3,
  'medium risk': 2,
  'low risk': 1,
  control: 0,
};

let REASON_TAGS = [];
let SLA_HOURS = 6;

let TEAM = [];
let ME = null;

const state = {
  carts: [],
  query: '',
  mineOnly: false,
  assignee: '',
  overdueOnly: false,
  days: 7,       // default range: last 7 days
  status: '',
  stage: '',
  sort: 'value',
};

const cartById = (id) => state.carts.find((c) => String(c.id) === String(id));

const $ = (sel) => document.querySelector(sel);

/** Attach a listener only if the element exists — a missing control should
 *  never throw and take the whole board down with it. */
function on(sel, event, handler) {
  const el = $(sel);
  if (el) el.addEventListener(event, handler);
  else console.warn(`No element matches ${sel}; skipping ${event} handler.`);
}
const rowsEl = $('#rows');
const errorEl = $('#errorBanner');

// ---------- formatting helpers ----------

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});

function money(amount, currency) {
  if (amount == null) return '—';
  if (!currency || currency === 'INR') return inr.format(amount);
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * Convert an Indian number to wa.me's 91XXXXXXXXXX form.
 * Returns null when it doesn't look like a usable number.
 */
function waNumber(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;          // bare 10-digit mobile
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;               // already country-coded
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`; // leading trunk 0
  return digits.length >= 10 ? digits : null;                     // non-IN, pass through
}

function waMessage(cart) {
  const name = cart.customer_name ? cart.customer_name.split(' ')[0] : 'there';
  return `Hi ${name}! This is Briyo Supplements. We noticed you left a few items in your cart — ` +
         `can we help you complete your order? Here's your cart: ${cart.checkout_url || ''}`;
}

/**
 * Line items stay in raw_payload rather than becoming columns, because GoKwik
 * sends them either as an array or as a "#Name(Variant)*1" string. The server
 * exposes the parsed form on each cart; fall back to the raw shapes if absent.
 */
function itemsOf(cart) {
  if (Array.isArray(cart.items) && cart.items.length) return cart.items;
  const raw = cart.raw_payload || {};
  const list = raw.items || raw.line_items || raw.lineItems || raw.products || [];
  if (!Array.isArray(list)) return [];
  return list.map((i) => ({
    title: i?.title || i?.name || i?.product_name || i?.sku || 'Item',
    quantity: Number(i?.quantity ?? i?.qty ?? 1),
  }));
}

const riskClass = (flag) => 'risk-' + String(flag || '').toLowerCase().split(' ')[0];

/**
 * GoKwik runs its own recovery email/messaging. Showing that lets a caller open
 * with the right line instead of repeating a message the customer already got —
 * and is why this board deliberately sends nothing automatically.
 */
function gokwikTouch(cart) {
  const bits = [];
  if (cart.gokwik_message_queued) bits.push('msg sent');
  if (cart.gokwik_email_sent) bits.push('email sent');
  const already = bits.length
    ? `<div class="touched" title="GoKwik already contacted this customer">GoKwik: ${bits.join(' + ')}</div>`
    : '';
  const repeat = cart.brand_order_count > 0
    ? `<div class="repeat" title="Has ordered before">Repeat buyer (${cart.brand_order_count})</div>`
    : '';
  return already + repeat;
}

/** Overdue / due-today state for a scheduled callback. */
function callbackState(cart) {
  if (cart.status !== 'Callback scheduled' || !cart.callback_at) return null;
  const due = new Date(cart.callback_at);
  if (Number.isNaN(due.getTime())) return null;
  const now = new Date();
  if (due < now) return { kind: 'overdue', label: 'Overdue', due };
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
  if (due <= endOfDay) return { kind: 'due-today', label: 'Due today', due };
  return { kind: 'scheduled', label: due.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }), due };
}

const isOverdue = (c) => callbackState(c)?.kind === 'overdue';

/** <input type="datetime-local"> needs local wall-clock, not an ISO UTC string. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- data ----------

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function clearError() {
  errorEl.hidden = true;
}

/**
 * The free Render instance sleeps after 15 minutes and takes up to a minute to
 * wake, so the first request after a quiet spell can fail outright at the
 * network level ("Failed to fetch"). Retry a couple of times before giving up,
 * and say what's happening rather than showing a bare error.
 */
async function loadAll(attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    // The date range is now applied server-side, so the array stays small and
    // every other filter and sort can stay client-side over it.
    const params = state.query
      ? `q=${encodeURIComponent(state.query)}`
      : `days=${state.days}`;
    const [cfgRes, cartsRes] = await Promise.all([
      fetch('/api/config'), fetch(`/api/carts?${params}`),
    ]);
    if ([cfgRes, cartsRes].some((r) => r.status === 401)) {
      window.location.href = '/login';
      return;
    }
    const cfg = await cfgRes.json();
    const carts = await cartsRes.json();
    if (Array.isArray(cfg.reasonTags)) REASON_TAGS = cfg.reasonTags;
    if (cfg.slaHours) SLA_HOURS = cfg.slaHours;
    if (Array.isArray(cfg.team)) TEAM = cfg.team;
    ME = cfg.me ?? ME;
    syncAssigneeFilter();

    if (cfg.mock) $('#mockBanner').hidden = false;
    if (!carts.ok) throw new Error(carts.error || 'Could not load carts');

    state.carts = carts.carts;
    state.stale = carts.stale || null;
    state.total = carts.total ?? carts.carts.length;
    state.truncated = Boolean(carts.truncated);
    renderResultNote();
    syncExportLink();

    const sel = $('#stageFilter');
    if (sel) {
      const stages = [...new Set(state.carts.map((c) => c.drop_stage).filter(Boolean))].sort();
      const keep = sel.value;
      sel.innerHTML = '<option value="">Any drop stage</option>' +
        stages.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      sel.value = keep;
    }

    clearError();
    render();
  } catch (err) {
    // A TypeError from fetch means the request never completed — server asleep,
    // restarting, or the network dropped. An HTTP error would not land here.
    const networkLevel = err instanceof TypeError;
    if (networkLevel && attempt < MAX_ATTEMPTS) {
      showError(`Server isn't responding — it may be waking up. Retrying (${attempt}/${MAX_ATTEMPTS - 1})…`);
      rowsEl.innerHTML = '<tr><td colspan="8" class="empty">Waking the server…</td></tr>';
      await new Promise((r) => setTimeout(r, attempt * 4000));
      return loadAll(attempt + 1);
    }
    showError(networkLevel
      ? "Couldn't reach the server after several tries — it may still be starting up. Press Refresh in a moment."
      : `Could not load the board: ${err.message}`);
    rowsEl.innerHTML = '<tr><td colspan="8" class="empty">Failed to load.</td></tr>';
  }
}

/** Save one row. Never re-renders the row being edited, so in-progress text survives. */
async function saveRow(id, patch, noteEl) {
  const cell = document.querySelector(`[data-row="${CSS.escape(id)}"] .saved`);
  if (cell) { cell.textContent = 'Saving…'; cell.className = 'saved pending'; }

  try {
    const res = await fetch('/api/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Sent so the server can tell if someone else saved since we last read.
      body: JSON.stringify({ id, seenAt: cartById(id)?.status_updated_at ?? null, ...patch }),
    });
    const data = await res.json();

    if (res.status === 409 && data.conflict) {
      showError(`${data.error} Your text is still here — reload to see theirs, or save again to overwrite.`);
      if (cell) { cell.textContent = 'Not saved — conflict'; cell.className = 'saved failed'; }
      // Adopt their timestamp so a deliberate second save goes through.
      const cart = cartById(id);
      if (cart && data.current) cart.status_updated_at = data.current.status_updated_at;
      return;
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Update the row in place; never re-render it, so an in-progress edit survives.
    const cart = cartById(id);
    if (cart) {
      cart.status = data.entry.status;
      cart.notes = data.entry.notes;
      cart.status_updated_at = data.entry.status_updated_at;
      cart.callback_at = data.entry.callback_at ?? null;
      cart.reason_tags = data.entry.reason_tags ?? cart.reason_tags ?? [];
      cart.updated_by = data.entry.updated_by ?? cart.updated_by;
      if ('assigned_to' in data.entry) {
        cart.assigned_to = data.entry.assigned_to;
        cart.assigned_to_name = data.entry.assigned_to_name;
      }
    }
    clearError();
    if (cell) { cell.textContent = savedLabel(cart || data.entry); cell.className = 'saved'; }

    // Chips and the callback badge reflect the just-saved values without a
    // full re-render, which would discard any in-progress edit on other rows.
    const tr = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (tr && cart) {
      const chips = tr.querySelector('.chips');
      if (chips) {
        chips.innerHTML = (cart.reason_tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
      }
      const summary = tr.querySelector('.tagpick summary');
      if (summary) summary.textContent = (cart.reason_tags || []).length ? 'Edit reasons' : '+ reason';

      // Owner cell: keep the select, the "mine" marker and the Take it button
      // in step without a full re-render, which would discard other rows' edits.
      const assignSel = tr.querySelector('.js-assign');
      if (assignSel) assignSel.value = cart.assigned_to || '';
      tr.dataset.mine = String(cart.assigned_to === ME);
      const takeIt = tr.querySelector('.js-takeit');
      if (cart.assigned_to && takeIt) takeIt.remove();
      if (!cart.assigned_to && !takeIt && ME && assignSel) {
        assignSel.insertAdjacentHTML('afterend',
          `<button type="button" class="linky js-takeit" data-id="${esc(cart.id)}">Take it</button>`);
      }
    }
    if (tr) tr.dataset.status = data.entry.status;
    renderStats();
    scheduleInsights();
  } catch (err) {
    // Keep the user's edit on screen; just tell them it isn't saved.
    showError(`Couldn't save that change: ${err.message} — your edit is still here, try again.`);
    if (cell) { cell.textContent = 'Not saved'; cell.className = 'saved failed'; }
    if (noteEl) noteEl.focus();
  }
}

// ---------- rendering ----------

function visibleCarts() {
  const cutoff = state.days > 0 ? Date.now() - state.days * 86400000 : 0;
  let list = state.carts.filter((c) => new Date(c.received_at).getTime() >= cutoff);

  if (state.status) list = list.filter((c) => (c.status || 'Not called') === state.status);
  if (state.stage) list = list.filter((c) => (c.drop_stage || '') === state.stage);
  if (state.overdueOnly) list = list.filter(isOverdue);
  if (state.mineOnly) list = list.filter((c) => c.assigned_to === ME);
  if (state.assignee === '__unassigned') list = list.filter((c) => !c.assigned_to);
  else if (state.assignee) list = list.filter((c) => c.assigned_to === state.assignee);

  return list.sort((a, b) => {
    if (state.sort === 'value') return (b.total_price ?? 0) - (a.total_price ?? 0);
    if (state.sort === 'callback') {
      // Carts with a callback come first, soonest due at the top.
      const due = (c) => (c.status === 'Callback scheduled' && c.callback_at
        ? new Date(c.callback_at).getTime() : Infinity);
      return due(a) - due(b);
    }
    if (state.sort === 'risk') {
      const rank = (c) => RISK_ORDER[String(c.risk_flag || '').toLowerCase()] ?? -1;
      // Within the same risk band, bigger carts first — that's the call order.
      return (rank(b) - rank(a)) || ((b.total_price ?? 0) - (a.total_price ?? 0));
    }
    return new Date(b.received_at) - new Date(a.received_at);
  });
}

function renderStats() {
  const list = visibleCarts();
  const total = list.reduce((sum, c) => sum + (c.total_price ?? 0), 0);
  const called = list.filter((c) => c.status && c.status !== 'Not called').length;
  const recovered = list.filter((c) => c.status === 'Called – Recovered').length;
  const rate = list.length ? Math.round((recovered / list.length) * 100) : 0;

  const cards = [
    ['Abandoned carts', list.length, ''],
    ['Total cart value', money(total, 'INR'), ''],
    ['Called', called, ''],
    ['Recovered', recovered, ''],
    ['Recovery rate', `${rate}%`, ''],
  ];

  // Stale is a whole-table figure from the server, not filtered — it is an
  // operational alarm, and hiding it behind a filter would defeat the point.
  const staleCount = Number(state.stale?.count ?? 0);
  cards.push([
    `Stale — never called (${SLA_HOURS}h+)`,
    staleCount,
    staleCount > 0 ? 'stat-alarm' : '',
  ]);

  const overdue = state.carts.filter(isOverdue).length;
  if (overdue > 0) cards.push(['Overdue callbacks', overdue, 'stat-warn']);

  $('#stats').innerHTML = cards.map(([label, value, cls]) => `
    <div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>
  `).join('');
}

/** "Last updated by Priya, 2h ago" — attribution without asking anyone to pick it. */
function savedLabel(cart) {
  if (!cart.status_updated_at) return '';
  const when = relativeTime(cart.status_updated_at);
  return cart.updated_by
    ? `Last updated by ${esc(cart.updated_by)}, ${when}`
    : `Saved ${when}`;
}

function renderRows() {
  const list = visibleCarts();

  if (!list.length) {
    rowsEl.innerHTML = '<tr><td colspan="8" class="empty">No abandoned carts in this range.</td></tr>';
    return;
  }

  rowsEl.innerHTML = list.map((c) => {
    const status = c.status || 'Not called';
    const cb = callbackState(c);
    const wa = waNumber(c.phone);
    const items = itemsOf(c);
    const itemSummary = items.length
      ? items.map((i) => `<strong>${esc(i.title)}</strong>${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join('<br>')
      : (c.item_count ? `${c.item_count} item${c.item_count === 1 ? '' : 's'}` : '—');

    const links = [];
    if (c.phone) links.push(`<a href="tel:${esc(String(c.phone).replace(/\s/g, ''))}">Call</a>`);
    if (wa) links.push(`<a href="https://wa.me/${wa}?text=${encodeURIComponent(waMessage(c))}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (c.checkout_url) links.push(`<a href="${esc(c.checkout_url)}" target="_blank" rel="noopener">Cart link</a>`);
    if (!c.phone) links.push('<span class="muted">No phone</span>');

    return `
      <tr data-row="${esc(c.id)}" data-status="${esc(status)}" data-mine="${c.assigned_to === ME}">
        <td data-label="Abandoned"><div>${relativeTime(c.received_at)}</div>
            <div class="muted">${new Date(c.received_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            ${cb ? `<div class="cb cb-${cb.kind}">${cb.kind === 'scheduled' ? 'Callback ' : ''}${esc(cb.label)}</div>` : ''}</td>
        <td data-label="Customer"><div class="cust-name">${esc(c.customer_name || 'Guest')}</div>
            <div class="cust-email">${esc(c.email || '—')}</div></td>
        <td class="items" data-label="Items">${itemSummary}</td>
        <td class="right" data-label="Value">
          ${money(c.total_price, c.currency)}
          ${c.discount_total ? `<div class="muted">−${money(c.discount_total, c.currency)} disc.</div>` : ''}
        </td>
        <td class="stage" data-label="Dropped at">
          ${gokwikTouch(c)}
          ${c.drop_stage ? esc(c.drop_stage) : '<span class="muted">—</span>'}
          ${c.risk_flag ? `<div class="risk ${riskClass(c.risk_flag)}">${esc(c.risk_flag)}</div>` : ''}
          ${c.utm_source ? `<div class="muted">via ${esc(c.utm_source)}</div>` : ''}
        </td>
        <td class="owner" data-label="Owner">
          <select class="js-assign" data-id="${esc(c.id)}" autocomplete="off" aria-label="Assign to">
            <option value="">Unassigned</option>
            ${TEAM.map((t) => `<option value="${esc(t.phone)}" ${t.phone === c.assigned_to ? 'selected' : ''}>${esc(t.name)}${t.phone === ME ? ' (me)' : ''}</option>`).join('')}
          </select>
          ${!c.assigned_to && ME ? `<button type="button" class="linky js-takeit" data-id="${esc(c.id)}">Take it</button>` : ''}
        </td>
        <td data-label="Contact"><div class="links">${links.join('')}</div></td>
        <td class="status-cell" data-label="Status &amp; notes">
          <select data-id="${esc(c.id)}" class="js-status" autocomplete="off">
            ${STATUSES.map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input type="datetime-local" class="js-callback" data-id="${esc(c.id)}" autocomplete="off"
                 value="${toLocalInput(c.callback_at)}"
                 ${status === 'Callback scheduled' ? '' : 'hidden'} />
          <input type="text" class="js-notes" data-id="${esc(c.id)}" autocomplete="off"
                 placeholder="Notes…" value="${esc(c.notes || '')}" />
          <details class="tagpick" data-id="${esc(c.id)}">
            <summary>${(c.reason_tags || []).length ? 'Edit reasons' : '+ reason'}</summary>
            <div class="tagmenu">
              ${REASON_TAGS.map((t) => `
                <label><input type="checkbox" class="js-tag" data-id="${esc(c.id)}" value="${esc(t)}"
                  ${(c.reason_tags || []).includes(t) ? 'checked' : ''} /> ${esc(t)}</label>`).join('')}
            </div>
          </details>
          <div class="chips">${(c.reason_tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
          <div class="saved">${savedLabel(c)}</div>
        </td>
      </tr>`;
  }).join('');

  // Browsers restore form-control values across reloads, which would both show
  // the wrong status and fire a change event that saves it. Re-assert every
  // control from server state after inserting the markup.
  for (const sel of rowsEl.querySelectorAll('.js-status')) {
    const cart = cartById(sel.dataset.id);
    if (cart) sel.value = cart.status || 'Not called';
  }
  for (const sel of rowsEl.querySelectorAll('.js-assign')) {
    const cart = cartById(sel.dataset.id);
    if (cart) sel.value = cart.assigned_to || '';
  }
  for (const input of rowsEl.querySelectorAll('.js-notes')) {
    const cart = cartById(input.dataset.id);
    if (cart) input.value = cart.notes || '';
  }
}

let insightsTimer = null;
/** Two network requests per save adds up across three callers on a free
 *  instance; the panels are secondary so a trailing debounce is fine. */
function scheduleInsights() {
  clearTimeout(insightsTimer);
  insightsTimer = setTimeout(renderInsights, 3000);
}

async function renderInsights() {
  const days = state.days;
  try {
    const [rRes, cRes] = await Promise.all([
      fetch(`/api/reasons/summary?days=${days}`),
      fetch(`/api/stats/by-caller?days=${days}`),
    ]);
    if (!rRes.ok || !cRes.ok) return;
    const reasons = await rRes.json();
    const callers = await cRes.json();

    const max = Math.max(1, ...reasons.reasons.map((r) => r.count));
    $('#reasonList').innerHTML = reasons.reasons.length
      ? reasons.reasons.map((r) => `
          <div class="bar-row">
            <span class="bar-label">${esc(r.tag)}</span>
            <span class="bar"><span class="bar-fill" style="width:${(r.count / max) * 100}%"></span></span>
            <span class="bar-count">${r.count}</span>
          </div>`).join('')
      : '<p class="muted">No reasons tagged yet. Add them from the table as you call.</p>';
    $('#reasonMeta').textContent = reasons.taggedCarts
      ? `${reasons.taggedCarts} cart${reasons.taggedCarts === 1 ? '' : 's'} tagged`
      : '';

    $('#callerRows').innerHTML = callers.callers.length
      ? callers.callers.map((c) => `
          <tr>
            <td>${esc(c.caller)}</td>
            <td class="right">${c.touched}</td>
            <td class="right">${c.recovered}</td>
            <td class="right">${c.recovery_rate}%</td>
            <td class="right">${money(c.recovered_value, 'INR')}</td>
          </tr>`).join('')
      : '<tr><td colspan="5" class="empty">Nobody has worked a cart in this range yet.</td></tr>';
  } catch {
    // Insights are secondary; never let them break the call list.
  }
}

/** Says what is on screen versus what exists — the old code silently dropped
 *  everything past the 500th row with no indication. */
function renderResultNote() {
  const el = $('#resultNote');
  if (!el) return;
  if (state.query) {
    el.textContent = `${state.carts.length} result${state.carts.length === 1 ? '' : 's'} for "${state.query}" — searching all history.`
      + (state.truncated ? ' Showing the first 50; narrow the search.' : '');
    el.hidden = false;
    return;
  }
  if (state.truncated) {
    el.textContent = `Showing ${state.carts.length} of ${state.total} carts in this range — narrow the date range to see the rest.`;
    el.hidden = false;
    return;
  }
  el.hidden = true;
}

function syncExportLink() {
  const a = $('#exportCsv');
  if (!a) return;
  a.href = state.query
    ? `/api/carts.csv?q=${encodeURIComponent(state.query)}`
    : `/api/carts.csv?days=${state.days}`;
}

/** Highlight filters that are actually doing something, and offer a way out. */
function markActiveFilters() {
  for (const id of ['#statusFilter', '#assigneeFilter', '#stageFilter']) {
    const el = $(id);
    if (el) el.classList.toggle('on', Boolean(el.value));
  }
  const any = state.status || state.stage || state.assignee || state.mineOnly
    || state.overdueOnly || state.query;
  const btn = $('#clearFilters');
  if (btn) btn.hidden = !any;
}

function render() {
  markActiveFilters();
  renderStats();
  renderRows();
  renderInsights();
}

// ---------- events ----------

// Delegated so re-renders never orphan a listener.
rowsEl.addEventListener('change', (e) => {
  const id = e.target.dataset?.id;

  if (e.target.classList.contains('js-status')) {
    // Ignore no-op changes (e.g. browser form restoration re-firing on load).
    if ((cartById(id)?.status || 'Not called') === e.target.value) return;
    const status = e.target.value;

    // Reveal the picker immediately so the caller can set a time without waiting
    // for the save round-trip.
    const cbInput = document.querySelector(`.js-callback[data-id="${CSS.escape(id)}"]`);
    if (cbInput) {
      cbInput.hidden = status !== 'Callback scheduled';
      if (status !== 'Callback scheduled') cbInput.value = '';
    }

    const notes = document.querySelector(`.js-notes[data-id="${CSS.escape(id)}"]`)?.value ?? '';
    const payload = { status, notes };
    if (status === 'Callback scheduled') {
      payload.callbackAt = cbInput?.value ? new Date(cbInput.value).toISOString() : null;
    } else {
      payload.callbackAt = null;
    }
    saveRow(id, payload);
    return;
  }

  if (e.target.classList.contains('js-callback')) {
    saveRow(id, {
      status: 'Callback scheduled',
      callbackAt: e.target.value ? new Date(e.target.value).toISOString() : null,
    });
    return;
  }

  if (e.target.classList.contains('js-assign')) {
    if ((cartById(id)?.assigned_to || '') === e.target.value) return;
    saveRow(id, { assignedTo: e.target.value || null });
    return;
  }

  if (e.target.classList.contains('js-tag')) {
    const boxes = [...document.querySelectorAll(`.js-tag[data-id="${CSS.escape(id)}"]`)];
    const reasonTags = boxes.filter((b) => b.checked).map((b) => b.value);
    saveRow(id, { reasonTags });
  }
});

// Notes save on blur and on Enter — not per keystroke, which would hammer the metafield.
rowsEl.addEventListener('blur', (e) => {
  if (e.target.classList.contains('js-notes')) {
    const id = e.target.dataset.id;
    if ((cartById(id)?.notes || '') === e.target.value) return;
    const status = document.querySelector(`.js-status[data-id="${CSS.escape(id)}"]`)?.value;
    saveRow(id, { status, notes: e.target.value }, e.target);
  }
}, true);

rowsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('js-notes')) e.target.blur();
});

// One-tap self-assign — the common case, and the whole point of this feature is
// stopping two people ringing the same customer.
rowsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.js-takeit');
  if (btn) saveRow(btn.dataset.id, { assignedTo: ME });
});

on('#rangeGroup', 'click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.days = Number(btn.dataset.days);
  $('#rangeGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  loadAll();

/**
 * Poll so a teammate's change shows up without a manual refresh. Skipped while
 * a field is focused — reloading under someone's cursor would discard what they
 * are typing, which is exactly what the conflict guard exists to prevent.
 */
const REFRESH_MS = Number(60_000);
setInterval(() => {
  if (document.hidden) return;
  const active = document.activeElement;
  if (active && active.closest?.('#rows')) return;
  if (state.query) return;   // don't yank a search result set away
  loadAll();
}, REFRESH_MS);   // the range is a server-side query now, not a local filter
});

let searchTimer = null;
on('#search', 'input', (e) => {
  const value = e.target.value.trim();
  clearTimeout(searchTimer);
  // Search hits the whole history, so don't fire on every keystroke.
  searchTimer = setTimeout(() => {
    if (value === state.query) return;
    state.query = value;
    loadAll();
  }, 350);
});
on('#search', 'keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.query = ''; loadAll(); }
});

on('#statusFilter', 'change', (e) => { state.status = e.target.value; render(); });
on('#stageFilter', 'change', (e) => { state.stage = e.target.value; render(); });
function syncAssigneeFilter() {
  const sel = $('#assigneeFilter');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '<option value="">Anyone</option><option value="__unassigned">Unassigned</option>'
    + TEAM.map((t) => `<option value="${esc(t.phone)}">${esc(t.name)}${t.phone === ME ? ' (me)' : ''}</option>`).join('');
  sel.value = keep;
}

on('#assigneeFilter', 'change', (e) => { state.assignee = e.target.value; render(); });
on('#clearFilters', 'click', () => {
  const hadQuery = Boolean(state.query);
  Object.assign(state, { status: '', stage: '', assignee: '', mineOnly: false, overdueOnly: false, query: '' });
  for (const id of ['#statusFilter', '#assigneeFilter', '#stageFilter']) {
    if ($(id)) $(id).value = '';
  }
  if ($('#search')) $('#search').value = '';
  $('#mineOnly')?.classList.remove('active');
  $('#overdueOnly')?.classList.remove('active');
  // Clearing a search means refetching; clearing local filters does not.
  if (hadQuery) loadAll(); else render();
});
on('#mineOnly', 'click', () => {
  state.mineOnly = !state.mineOnly;
  $('#mineOnly').classList.toggle('active', state.mineOnly);
  render();
});

on('#overdueOnly', 'click', () => {
  state.overdueOnly = !state.overdueOnly;
  $('#overdueOnly').classList.toggle('active', state.overdueOnly);
  render();
});
on('#sort', 'change', (e) => { state.sort = e.target.value; render(); });
on('#refresh', 'click', loadAll);

on('#logout', 'click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

// Show who is signed in; bounce to login if the session expired mid-session.
fetch('/auth/me').then((r) => r.json()).then((me) => {
  if (!me.authenticated) { window.location.href = '/login'; return; }
  $('#sessionPhone').textContent = `+${me.phone}`;
  // Member management is admin-only, so don't advertise a link that 403s.
  if (me.isAdmin) $('#adminLink').hidden = false;
}).catch(() => {});

// Populate the status filter once.
// Populated once from the fixed status list; the placeholder option is in the HTML.
$('#statusFilter')?.insertAdjacentHTML('beforeend',
  STATUSES.map((s) => `<option value="${s}">${s}</option>`).join(''));

loadAll();
