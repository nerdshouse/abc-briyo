'use strict';

const STATUSES = [
  'Not called',
  'Called – No answer',
  'Callback scheduled',
  'Called – Recovered',
  'Called – Declined',
];

const state = {
  carts: [],
  statusMap: {},
  days: 7,       // default range: last 7 days
  status: '',
  sort: 'value',
};

const $ = (sel) => document.querySelector(sel);
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
  const name = cart.name ? cart.name.split(' ')[0] : 'there';
  return `Hi ${name}! This is Briyo Supplements. We noticed you left a few items in your cart — ` +
         `can we help you complete your order? Here's your cart: ${cart.checkoutUrl || ''}`;
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

async function loadAll() {
  try {
    const [cfgRes, cartsRes, statusRes] = await Promise.all([
      fetch('/api/config'), fetch('/api/carts'), fetch('/api/status'),
    ]);
    if ([cfgRes, cartsRes, statusRes].some((r) => r.status === 401)) {
      window.location.href = '/login';
      return;
    }
    const cfg = await cfgRes.json();
    const carts = await cartsRes.json();
    const status = await statusRes.json();

    if (cfg.mock) $('#mockBanner').hidden = false;
    if (!carts.ok) throw new Error(carts.error || 'Could not load carts');
    if (!status.ok) throw new Error(status.error || 'Could not load statuses');

    state.carts = carts.carts;
    state.statusMap = status.statusMap || {};
    clearError();
    render();
  } catch (err) {
    showError(`Could not load the board: ${err.message}`);
    rowsEl.innerHTML = '<tr><td colspan="6" class="empty">Failed to load.</td></tr>';
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

    state.statusMap = data.statusMap;
    clearError();
    if (cell) { cell.textContent = `Saved ${relativeTime(data.entry.updatedAt)}`; cell.className = 'saved'; }
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
  let list = state.carts.filter((c) => new Date(c.createdAt).getTime() >= cutoff);

  if (state.status) {
    list = list.filter((c) => (state.statusMap[c.id]?.status || 'Not called') === state.status);
  }

  return list.sort((a, b) => (
    state.sort === 'value'
      ? b.amount - a.amount
      : new Date(b.createdAt) - new Date(a.createdAt)
  ));
}

function renderStats() {
  const list = visibleCarts();
  const total = list.reduce((sum, c) => sum + c.amount, 0);
  const called = list.filter((c) => {
    const s = state.statusMap[c.id]?.status;
    return s && s !== 'Not called';
  }).length;
  const recovered = list.filter((c) => state.statusMap[c.id]?.status === 'Called – Recovered').length;
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
    rowsEl.innerHTML = '<tr><td colspan="6" class="empty">No abandoned carts in this range.</td></tr>';
    return;
  }

  rowsEl.innerHTML = list.map((c) => {
    const entry = state.statusMap[c.id] || {};
    const status = entry.status || 'Not called';
    const wa = waNumber(c.phone);
    const itemSummary = c.items.length
      ? c.items.map((i) => `<strong>${esc(i.title)}</strong>${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join('<br>')
      : '—';

    const links = [];
    if (c.phone) links.push(`<a href="tel:${esc(String(c.phone).replace(/\s/g, ''))}">Call</a>`);
    if (wa) links.push(`<a href="https://wa.me/${wa}?text=${encodeURIComponent(waMessage(c))}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (c.checkoutUrl) links.push(`<a href="${esc(c.checkoutUrl)}" target="_blank" rel="noopener">Cart link</a>`);
    if (!c.phone) links.push('<span class="muted">No phone</span>');

    return `
      <tr data-row="${esc(c.id)}" data-status="${esc(status)}">
        <td><div>${relativeTime(c.createdAt)}</div>
            <div class="muted">${new Date(c.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div></td>
        <td><div class="cust-name">${esc(c.name || 'Guest')}</div>
            <div class="cust-email">${esc(c.email || '—')}</div></td>
        <td class="items">${itemSummary}</td>
        <td class="right">${money(c.amount, c.currency)}</td>
        <td><div class="links">${links.join('')}</div></td>
        <td class="status-cell">
          <select data-id="${esc(c.id)}" class="js-status">
            ${STATUSES.map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input type="text" class="js-notes" data-id="${esc(c.id)}"
                 placeholder="Notes…" value="${esc(entry.notes || '')}" />
          <div class="saved">${entry.updatedAt ? `Saved ${relativeTime(entry.updatedAt)}` : ''}</div>
        </td>
      </tr>`;
  }).join('');
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
    const notes = document.querySelector(`.js-notes[data-id="${CSS.escape(id)}"]`)?.value ?? '';
    saveRow(id, { status: e.target.value, notes });
  }
});

// Notes save on blur and on Enter — not per keystroke, which would hammer the metafield.
rowsEl.addEventListener('blur', (e) => {
  if (e.target.classList.contains('js-notes')) {
    const id = e.target.dataset.id;
    if ((state.statusMap[id]?.notes || '') === e.target.value) return;
    const status = document.querySelector(`.js-status[data-id="${CSS.escape(id)}"]`)?.value;
    saveRow(id, { status, notes: e.target.value }, e.target);
  }
}, true);

rowsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('js-notes')) e.target.blur();
});

$('#rangeGroup').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.days = Number(btn.dataset.days);
  $('#rangeGroup').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

$('#statusFilter').addEventListener('change', (e) => { state.status = e.target.value; render(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
$('#refresh').addEventListener('click', loadAll);

$('#logout').addEventListener('click', async () => {
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
