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

const state = {
  carts: [],
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

async function loadAll() {
  try {
    const [cfgRes, cartsRes] = await Promise.all([fetch('/api/config'), fetch('/api/carts')]);
    if ([cfgRes, cartsRes].some((r) => r.status === 401)) {
      window.location.href = '/login';
      return;
    }
    const cfg = await cfgRes.json();
    const carts = await cartsRes.json();

    if (cfg.mock) $('#mockBanner').hidden = false;
    if (!carts.ok) throw new Error(carts.error || 'Could not load carts');

    state.carts = carts.carts;

    const sel = $('#stageFilter');
    if (sel) {
      const stages = [...new Set(state.carts.map((c) => c.drop_stage).filter(Boolean))].sort();
      const keep = sel.value;
      sel.innerHTML = '<option value="">All drop stages</option>' +
        stages.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      sel.value = keep;
    }

    clearError();
    render();
  } catch (err) {
    showError(`Could not load the board: ${err.message}`);
    rowsEl.innerHTML = '<tr><td colspan="7" class="empty">Failed to load.</td></tr>';
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
      body: JSON.stringify({ id, ...patch }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Update the row in place; never re-render it, so an in-progress edit survives.
    const cart = cartById(id);
    if (cart) {
      cart.status = data.entry.status;
      cart.notes = data.entry.notes;
      cart.status_updated_at = data.entry.status_updated_at;
    }
    clearError();
    if (cell) { cell.textContent = `Saved ${relativeTime(data.entry.status_updated_at)}`; cell.className = 'saved'; }
    renderStats();
    const tr = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (tr) tr.dataset.status = data.entry.status;
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

  return list.sort((a, b) => {
    if (state.sort === 'value') return (b.total_price ?? 0) - (a.total_price ?? 0);
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

  $('#stats').innerHTML = [
    ['Abandoned carts', list.length],
    ['Total cart value', money(total, 'INR')],
    ['Called', called],
    ['Recovered', recovered],
    ['Recovery rate', `${rate}%`],
  ].map(([label, value]) => `
    <div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>
  `).join('');
}

function renderRows() {
  const list = visibleCarts();

  if (!list.length) {
    rowsEl.innerHTML = '<tr><td colspan="7" class="empty">No abandoned carts in this range.</td></tr>';
    return;
  }

  rowsEl.innerHTML = list.map((c) => {
    const status = c.status || 'Not called';
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
      <tr data-row="${esc(c.id)}" data-status="${esc(status)}">
        <td><div>${relativeTime(c.received_at)}</div>
            <div class="muted">${new Date(c.received_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div></td>
        <td><div class="cust-name">${esc(c.customer_name || 'Guest')}</div>
            <div class="cust-email">${esc(c.email || '—')}</div></td>
        <td class="items">${itemSummary}</td>
        <td class="right">
          ${money(c.total_price, c.currency)}
          ${c.discount_total ? `<div class="muted">−${money(c.discount_total, c.currency)} disc.</div>` : ''}
        </td>
        <td class="stage">
          ${c.drop_stage ? esc(c.drop_stage) : '<span class="muted">—</span>'}
          ${c.risk_flag ? `<div class="risk ${riskClass(c.risk_flag)}">${esc(c.risk_flag)}</div>` : ''}
          ${c.utm_source ? `<div class="muted">via ${esc(c.utm_source)}</div>` : ''}
        </td>
        <td><div class="links">${links.join('')}</div></td>
        <td class="status-cell">
          <select data-id="${esc(c.id)}" class="js-status" autocomplete="off">
            ${STATUSES.map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input type="text" class="js-notes" data-id="${esc(c.id)}" autocomplete="off"
                 placeholder="Notes…" value="${esc(c.notes || '')}" />
          <div class="saved">${c.status_updated_at ? `Saved ${relativeTime(c.status_updated_at)}` : ''}</div>
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
  for (const input of rowsEl.querySelectorAll('.js-notes')) {
    const cart = cartById(input.dataset.id);
    if (cart) input.value = cart.notes || '';
  }
}

function render() {
  renderStats();
  renderRows();
}

// ---------- events ----------

// Delegated so re-renders never orphan a listener.
rowsEl.addEventListener('change', (e) => {
  if (e.target.classList.contains('js-status')) {
    const id = e.target.dataset.id;
    // Ignore no-op changes (e.g. browser form restoration re-firing on load).
    if ((cartById(id)?.status || 'Not called') === e.target.value) return;
    const notes = document.querySelector(`.js-notes[data-id="${CSS.escape(id)}"]`)?.value ?? '';
    saveRow(id, { status: e.target.value, notes });
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

on('#rangeGroup', 'click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.days = Number(btn.dataset.days);
  $('#rangeGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

on('#statusFilter', 'change', (e) => { state.status = e.target.value; render(); });
on('#stageFilter', 'change', (e) => { state.stage = e.target.value; render(); });
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
}).catch(() => {});

// Populate the status filter once.
$('#statusFilter').insertAdjacentHTML('beforeend',
  STATUSES.map((s) => `<option value="${s}">${s}</option>`).join(''));

loadAll();
