/**
 * Recovery verification (Support, admins): recovered carts against imported Shopify orders. The server does all the
 * matching and the sums; this page shows them and records a person's confirm / reject on a proposed match.
 */
import { $, $$, esc, count, money, icon, renderIcons, initShell, pageFetch } from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const state = { data: null, status: '', open: null };
const STATUS_TONE = { verified_paid: 'ok', verified_placed: 'warn', possible: 'warn', no_match: '', cancelled_refunded: 'bad', needs_review: 'bad' };
const PAYMENT = { paid: 'Paid', pending: 'Pending', cancelled: 'Cancelled', refunded: 'Refunded', unknown: 'No financial record' };
const when = (v) => (v ? istDateTime(v) : '—');
const amt = (v, cur) => (v === null || v === undefined ? '—' : cur && cur !== 'INR' ? `${cur} ${Number(v).toLocaleString('en-IN')}` : money(v));

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
};
const note = (msg) => { $('#alerts').innerHTML = msg ? `<div class="alert">${icon('circle-alert')}<span>${esc(msg)}</span></div>` : ''; renderIcons(); };
const tag = (status, label) => `<span class="tag ${STATUS_TONE[status] || ''}">${esc(label)}</span>`;

async function load() {
  const qs = new URLSearchParams(Object.entries({ from: $('#fFrom').value, to: $('#fTo').value, agent: $('#fAgent').value, window: $('#fWindow').value }).filter(([, v]) => v));
  const d = await api(`/api/recovery-verification?${qs}`);
  state.data = d;
  const agentSel = $('#fAgent'); const cur = agentSel.value;
  agentSel.innerHTML = `<option value="">Everyone</option>${d.agents.map((a) => `<option${a === cur ? ' selected' : ''}>${esc(a)}</option>`).join('')}`;
  const s = d.summary;
  const rev = s.revenue.length ? s.revenue : [{ currency: 'INR', amount: 0, paidOrders: 0, averagePaidOrder: null, perRecoveredCart: s.recovered ? 0 : null }];
  $('#stats').innerHTML = [
    [s.recovered, 'Carts marked Recovered'], [s.verifiedOrders, 'Verified Shopify orders'], [s.paidOrders, 'Verified paid orders'],
    [s.pendingOrders, 'Pending-payment orders'], [s.unmatched, 'Unmatched carts'], [s.ambiguous, 'Ambiguous matches'],
    ...rev.flatMap((r) => [[amt(r.amount, r.currency), `Paid order revenue${s.revenue.length > 1 ? ` (${r.currency})` : ''}`],
      [r.averagePaidOrder === null ? '—' : amt(r.averagePaidOrder, r.currency), 'Average paid order'],
      [r.perRecoveredCart === null ? '—' : amt(r.perRecoveredCart, r.currency), 'Revenue per recovered cart']]),
  ].map(([v, l]) => `<div class="imp-stat"><b>${typeof v === 'number' ? count(v) : esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  $('#note').innerHTML = [
    `Matched within <b>${d.windowHours} hours</b> after a cart was marked Recovered (same phone; same product where both sides list products). Each Shopify order counts once; only confidently matched orders that Shopify reports as paid count as revenue, at Shopify's current total.`,
    s.withoutRecoveryTime ? `${count(s.withoutRecoveryTime)} cart(s) have no recorded recovery time — at most a possible match.` : '',
    s.excludedNoRecoveryTime ? `${count(s.excludedNoRecoveryTime)} cart(s) without a recovery time are left out of this date range.` : '',
    s.paidWithoutValue ? `${count(s.paidWithoutValue)} paid order(s) have no recorded value and are not in the revenue.` : '',
  ].filter(Boolean).join(' ');
  const counts = {}; for (const r of d.results) counts[r.status] = (counts[r.status] || 0) + 1;
  const seg = [['', 'All', d.results.length], ...Object.entries({ verified_paid: 'Verified — paid', verified_placed: 'Verified — order placed', possible: 'Possible match', needs_review: 'Needs review', no_match: 'No matching order', cancelled_refunded: 'Cancelled / refunded' }).map(([k, l]) => [k, l, counts[k] || 0])];
  $('#statusSeg').innerHTML = seg.map(([k, l, n]) => `<button type="button" class="${k === state.status ? 'on' : ''}" data-status="${k}">${esc(l)} <span class="tab-count">${count(n)}</span></button>`).join('');
  renderRows();
}

function renderRows() {
  const rows = state.data.results.filter((r) => !state.status || r.status === state.status);
  $('#rows').innerHTML = rows.length ? rows.map((r) => `<tr data-cart="${r.cartId}" tabindex="0">
      <td>${esc(r.customerName || '—')}<span class="cell-sub muted mono">${esc(r.phone || '—')}</span></td>
      <td class="mono">${esc(r.cartRef || r.cartId)}<span class="cell-sub muted">${esc(when(r.cartCreatedAt))}</span></td>
      <td>${r.recoveryTimeRecorded ? esc(when(r.recoveredAt)) : '<span class="warn-text">Not recorded</span>'}<span class="cell-sub muted">${esc(r.method || '')}</span></td>
      <td>${esc(r.agent || '—')}</td>
      <td class="r num">${esc(amt(r.cartValue, r.cartCurrency))}</td>
      <td>${r.order ? `${esc(r.order.name || r.order.id)}<span class="cell-sub muted">${esc(when(r.order.date))}</span>` : r.candidates.length ? `<span class="muted">${count(r.candidates.length)} candidate${r.candidates.length > 1 ? 's' : ''}</span>` : '—'}</td>
      <td class="r num">${r.order ? esc(amt(r.order.value, r.order.currency)) : '—'}</td>
      <td>${r.order ? esc(PAYMENT[r.order.payment] || r.order.payment) : '—'}</td>
      <td>${tag(r.status, r.statusLabel)}<span class="cell-sub muted">${esc(r.reason || '')}</span></td></tr>`).join('')
    : '<tr><td colspan="9" class="muted">No recovered carts in this view.</td></tr>';
}

function openCart(id) {
  const r = state.data.results.find((x) => x.cartId === id);
  if (!r) return;
  state.open = r;
  $('#dTitle').textContent = `${r.customerName || 'Customer'} · ${r.statusLabel}`;
  $('#dSub').textContent = `Cart ${r.cartRef || r.cartId} · ${r.phone || 'no phone'}`;
  const product = (p) => `${esc(p.title)}${p.sku ? ` <span class="mono muted">${esc(p.sku)}</span>` : ''} × ${count(p.quantity || 1)}`;
  const cand = (c) => `<div class="rv-cand">
      <div class="rv-cand-h"><b>${esc(c.order.name || c.order.id)}</b> · ${esc(when(c.order.date))} · ${esc(amt(c.order.value, c.order.currency))} · ${esc(PAYMENT[c.order.payment] || c.order.payment)}${c.order.financialStatus ? ` <span class="muted">(${esc(c.order.financialStatus)})</span>` : ''}</div>
      <div class="muted">${c.order.products.map(product).join(' · ') || 'No products recorded'}</div>
      <div>${c.reasons.map((x) => `<span class="tag ok">${esc(x)}</span>`).join(' ')} ${c.conflicts.map((x) => `<span class="tag bad">${esc(x)}</span>`).join(' ')}</div>
      ${r.decision ? '' : `<div class="rv-actions"><button class="btn" type="button" data-decide="confirmed" data-order="${c.order.id}">Confirm this order</button><button class="btn" type="button" data-decide="rejected" data-order="${c.order.id}">Not this order</button></div>`}
    </div>`;
  $('#dBody').innerHTML = `
    <section class="dsec"><dl class="facts">
      <dt>Verification</dt><dd>${tag(r.status, r.statusLabel)} ${esc(r.reason || '')}</dd>
      <dt>Recovered</dt><dd>${r.recoveryTimeRecorded ? esc(when(r.recoveredAt)) : 'Not recorded (lower confidence)'} · ${esc(r.method || '—')}</dd>
      <dt>Agent</dt><dd>${esc(r.agent || '—')}</dd>
      <dt>Cart created</dt><dd>${esc(when(r.cartCreatedAt))}</dd>
      <dt>Cart value</dt><dd>${esc(amt(r.cartValue, r.cartCurrency))}</dd>
      <dt>Cart products</dt><dd>${r.products.map(product).join('<br>') || '—'}</dd>
      <dt>Matching window</dt><dd>${esc(when(r.window.from))} → ${esc(when(r.window.to))}</dd>
    </dl></section>
    ${r.order ? `<section class="dsec"><h3 class="dsec-title">Matched order</h3>${cand({ order: r.order, reasons: [r.reason], conflicts: [] }).replace(/<div class="rv-actions">[\s\S]*?<\/div>/, '')}</section>` : ''}
    ${r.decision ? `<section class="dsec"><h3 class="dsec-title">Decision</h3><p>Confirmed by ${esc(r.decision.by || '—')} on ${esc(when(r.decision.at))}${r.decision.note ? ` — ${esc(r.decision.note)}` : ''}.</p>
      <button class="btn" type="button" data-revert="${r.decision.id}">Revert this decision</button></section>` : ''}
    ${r.candidates.length && !(r.order && r.candidates.length === 1 && r.candidates[0].order.id === r.order.id && r.status !== 'possible') ? `<section class="dsec"><h3 class="dsec-title">Candidate orders</h3>${r.candidates.map(cand).join('')}</section>` : ''}
    <section class="dsec"><h3 class="dsec-title">Decision history</h3><div id="dHist" class="muted">Loading…</div></section>`;
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
  $('#dSaved').textContent = '';
  api(`/api/recovery-verification/carts/${r.cartId}/decisions`).then(({ decisions }) => {
    $('#dHist').innerHTML = decisions.length ? decisions.map((d) => `<div>${esc(d.decision === 'confirmed' ? 'Confirmed' : 'Rejected')} ${esc(d.order_name || d.order_id)} — ${esc(d.decided_by || '—')}, ${esc(when(d.decided_at))}
      <span class="muted">(automatic result then: ${esc(d.auto_result?.status || '—')})</span>${d.reverted_at ? ` · reverted by ${esc(d.reverted_by || '—')}, ${esc(when(d.reverted_at))}` : ''}</div>`).join('') : 'No decisions yet.';
  }).catch(() => { $('#dHist').textContent = 'Could not load.'; });
  renderIcons();
}
const closeDrawer = () => { $('#drawer').hidden = true; $('#drawerScrim').hidden = true; state.open = null; };

$('#dBody').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-decide]'); const rv = e.target.closest('[data-revert]');
  if (!d && !rv) return;
  const btn = d || rv; btn.disabled = true;
  try {
    if (d) {
      const why = d.dataset.decide === 'rejected' ? prompt('Why is this not the order? (optional)') : prompt('Note (optional)');
      if (why === null) { btn.disabled = false; return; }
      await api('/api/recovery-verification/decisions', { method: 'POST', body: JSON.stringify({ cart_id: state.open.cartId, order_id: Number(d.dataset.order), decision: d.dataset.decide, note: why }) });
    } else {
      if (!confirm('Revert this decision? The automatic matching applies again.')) { btn.disabled = false; return; }
      await api(`/api/recovery-verification/decisions/${rv.dataset.revert}/revert`, { method: 'POST', body: '{}' });
    }
    const id = state.open.cartId;
    await load(); openCart(id); $('#dSaved').textContent = 'Saved';
  } catch (err) { $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message; btn.disabled = false; }
});

(async () => {
  try {
    const me = await api('/auth/me');
    initShell(me);
    for (const id of ['fFrom', 'fTo', 'fAgent', 'fWindow']) $(`#${id}`).addEventListener('change', () => load().catch((err) => note(err.message)));
    $('#statusSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (!b) return; state.status = b.dataset.status; for (const x of $$('#statusSeg button')) x.classList.toggle('on', x === b); renderRows(); });
    const openRow = (e) => { const tr = e.target.closest('tr[data-cart]'); if (tr) openCart(Number(tr.dataset.cart)); };
    $('#rows').addEventListener('click', openRow);
    $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e); });
    $('#dClose').addEventListener('click', closeDrawer); $('#drawerScrim').addEventListener('click', closeDrawer);
    await load();
  } catch (err) { note(err.message); }
})();
