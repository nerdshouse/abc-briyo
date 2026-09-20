'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const money = (v) => (v === null || v === undefined ? '—' : inr.format(v));
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

let csvText = '';

function showError(m) { $('#banner').textContent = m; $('#banner').hidden = false; $('#ok').hidden = true; }
function showOk(m) { $('#ok').textContent = m; $('#ok').hidden = false; $('#banner').hidden = true; }
function clearBanners() { $('#banner').hidden = true; $('#ok').hidden = true; }

// Populate the assignee list, defaulting to whoever the server nominates.
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  const sel = $('#assignTo');
  (cfg.team || []).forEach((t) => {
    const o = document.createElement('option');
    o.value = t.phone; o.textContent = t.name;
    sel.appendChild(o);
  });
  if (cfg.importDefaultCaller) sel.value = cfg.importDefaultCaller;
}).catch(() => {});

$('#file').addEventListener('change', async (e) => {
  clearBanners();
  $('#previewPanel').hidden = true;
  const file = e.target.files?.[0];
  if (!file) { $('#previewBtn').disabled = true; return; }
  csvText = await file.text();
  $('#previewBtn').disabled = false;
});

async function send(apply) {
  const assignTo = $('#assignTo').value;
  const res = await fetch(`/api/admin/import?apply=${apply}&assignTo=${encodeURIComponent(assignTo)}`, {
    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csvText,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Import failed (${res.status})`);
  return data;
}

$('#previewBtn').addEventListener('click', async () => {
  clearBanners();
  $('#previewBtn').disabled = true; $('#previewBtn').textContent = 'Reading…';
  try {
    const d = await send(false);
    renderPreview(d);
  } catch (err) {
    showError(err.message);
  } finally {
    $('#previewBtn').disabled = false; $('#previewBtn').textContent = 'Preview';
  }
});

function renderPreview(d) {
  $('#previewPanel').hidden = false;
  $('#previewMeta').textContent = `${d.rows} rows → ${d.checkouts} checkouts`;
  $('#previewStats').innerHTML = [
    ['Checkouts', d.checkouts],
    ['Rows in file', d.rows],
    ['Will be assigned to', d.assignedToName || 'Nobody'],
  ].map(([l, v]) => `<div class="stat"><div class="label">${esc(l)}</div><div class="value" style="font-size:18px">${esc(v)}</div></div>`).join('');

  // Say what will be missing before they commit, not after.
  const warn = [];
  if (d.missing.phone) warn.push(`${d.missing.phone} checkout(s) have no phone number — those cannot be called.`);
  if (d.missing.customerName) warn.push(`${d.missing.customerName} have no customer name.`);
  if (d.missing.checkoutUrl === d.checkouts) warn.push('Shopify exports carry no recovery link, so Cart link will be empty on all of these.');
  (d.skipped || []).forEach((s) => warn.push(`Skipped ${s.name}: ${s.reason}.`));
  $('#warnings').innerHTML = warn.length
    ? `<div class="banner mock"><strong>Before you import.</strong> ${warn.map(esc).join(' ')}</div>`
    : '';

  $('#sampleRows').innerHTML = d.sample.map((c) => `
    <tr>
      <td>${esc(c.cartId)}</td>
      <td>${esc(c.customerName || '—')}</td>
      <td>${esc(c.phone || '—')}</td>
      <td>${esc(c.email || '—')}</td>
      <td class="right">${money(c.totalPrice)}</td>
      <td class="right">${c.itemCount ?? '—'}</td>
      <td>${esc(when(c.abandonedAt))}</td>
    </tr>`).join('');
}

$('#applyBtn').addEventListener('click', async () => {
  clearBanners();
  $('#applyBtn').disabled = true; $('#applyBtn').textContent = 'Importing…';
  try {
    const d = await send(true);
    $('#previewPanel').hidden = true;
    $('#file').value = ''; csvText = ''; $('#previewBtn').disabled = true;
    showOk(`Imported ${d.inserted} new checkout(s)`
      + (d.updated ? `, updated ${d.updated} already on the board` : '')
      + (d.assignedToName ? `, assigned to ${d.assignedToName}` : '')
      + '.');
  } catch (err) {
    showError(err.message);
  } finally {
    $('#applyBtn').disabled = false; $('#applyBtn').textContent = 'Import these checkouts';
  }
});

// --- live Shopify sync ---
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  const el = $('#shopifyState');
  if (cfg.shopifyAuthorized) {
    el.textContent = 'connected';
    el.style.color = 'var(--accent)';
  } else if (cfg.shopifyConnected) {
    // Credentials are in place but the store has never authorised us. One
    // browser round-trip fixes it, so offer the button rather than an error.
    el.textContent = 'needs authorising';
    $('#pullBtn').disabled = true;
    $('#pullResult').innerHTML =
      '<div class="banner mock">The credentials are set, but the store has not granted access yet. '
      + '<a class="primary" href="/auth/shopify/install">Connect Shopify</a> — you will be sent to '
      + 'Shopify to approve, then straight back here. This is a one-time step.</div>';
  } else {
    el.textContent = 'not connected';
    $('#pullBtn').disabled = true;
    $('#pullResult').innerHTML =
      '<div class="banner mock">Add <code>SHOPIFY_STORE_DOMAIN</code>, <code>SHOPIFY_CLIENT_ID</code> '
      + 'and <code>SHOPIFY_CLIENT_SECRET</code> to the environment to turn this on. '
      + 'Until then, use the CSV export above.</div>';
  }
  if (new URLSearchParams(location.search).get('shopify') === 'connected') {
    $('#pullResult').innerHTML =
      '<div class="banner">Shopify connected. The first pull is running now — reload in a moment.</div>';
  }
}).catch(() => {});

$('#pullBtn').addEventListener('click', async () => {
  clearBanners();
  $('#pullBtn').disabled = true; $('#pullBtn').textContent = 'Pulling…';
  try {
    const res = await fetch('/api/admin/shopify/pull', { method: 'POST' });
    const d = await res.json();
    if (!res.ok || !d.ok) throw new Error(d.error || 'Pull failed');
    $('#pullResult').innerHTML = `<div class="banner success">Pulled ${d.fetched ?? 0} checkout(s): `
      + `${d.inserted ?? 0} new, ${d.updated ?? 0} already on the board.</div>`;
  } catch (err) {
    $('#pullResult').innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
  } finally {
    $('#pullBtn').disabled = false; $('#pullBtn').textContent = 'Pull from Shopify now';
  }
});

$('#cancelBtn').addEventListener('click', () => {
  $('#previewPanel').hidden = true;
  $('#file').value = ''; csvText = ''; $('#previewBtn').disabled = true;
  clearBanners();
});
