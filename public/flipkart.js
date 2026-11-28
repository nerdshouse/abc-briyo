/**
 * Logistics → Flipkart (lib/flipkart-sync.js): is Flipkart connected, what the last order sync did (new, changed,
 * Flipkart SKUs not mapped yet), and the stock each mapped Flipkart SKU should show — with what was last sent. An admin
 * syncs orders now; an Inventory manager sends stock now. Logistics members read.
 */
import { $, esc, count, icon, renderIcons, initShell, pageFetch, hasCap } from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, status: null, plan: [] };
const isAdmin = () => Boolean(state.me?.isAdmin);
const canStock = () => hasCap(state.me, 'inventory.catalog');

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const note = (msg, ok = false) => {
  $('#alerts').innerHTML = msg ? `<div class="alert${ok ? ' ok' : ''}">${icon(ok ? 'circle-check' : 'circle-alert')}<span>${esc(msg)}</span></div>` : '';
  renderIcons();
};
const card = (title, meta, body) => `<section class="card"><header class="card-head"><h2 class="card-title">${title}${meta ? ` <span class="card-meta">${meta}</span>` : ''}</h2></header>${body}</section>`;
const when = (v) => (v ? istDateTime(v) : '—');
const statCard = (v, label, tone = '', tip = '') => `<div class="imp-stat inv-card ${tone}" title="${esc(tip)}"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;

function render() {
  const st = state.status;
  const ls = st.last_sync;
  const lk = st.last_stock;
  $('#cards').innerHTML = [
    statCard(st.connected ? 'Connected' : 'Not connected', 'Flipkart Seller API', st.connected ? 'good' : 'bad', st.connected ? 'FLIPKART_APP_ID and FLIPKART_APP_SECRET are set' : 'Set FLIPKART_APP_ID and FLIPKART_APP_SECRET on Render'),
    statCard(ls?.ok ? `${count(ls.created)} new` : ls ? 'Failed' : '—', ls ? `Last order sync · ${when(ls.finished_at)}` : 'No order sync yet', ls && !ls.ok ? 'bad' : '', `Every ${st.poll_minutes} minutes`),
    statCard(ls?.ok ? count((ls.unmapped || []).length) : '—', 'Flipkart SKUs to map', ls?.unmapped?.length ? 'warn' : ''),
    statCard(st.stock_auto ? 'Automatic' : 'On demand', lk ? `Stock last sent · ${when(lk.at)}` : 'Stock not sent yet', st.stock_auto ? 'good' : '', st.stock_auto ? `Sent every ${st.poll_minutes} minutes when it changes` : 'FLIPKART_STOCK_SYNC=true on Render sends it automatically'),
  ].join('');

  const connect = st.connected ? '' : card(`${icon('plug')}Connect Flipkart`, '', `<div class="pane"><ol style="margin:0;padding-left:18px;line-height:1.7">
      <li>Seller Hub → Manage Profile → Developer Access → <b>Self Access</b> → <b>Create New Access</b>: name <b>Briyo OS</b>, domain <b>abc.briyo.xyz</b>, purpose: order, shipment and inventory sync to our own order management system.</li>
      <li>Once Flipkart approves it, add its <b>App ID</b> and <b>Secret</b> on Render as <span class="mono">FLIPKART_APP_ID</span> and <span class="mono">FLIPKART_APP_SECRET</span> (not the FinanceOS ones).</li>
      <li>Orders then sync every ${st.poll_minutes} minutes. Map Flipkart SKUs to master SKUs in Inventory so their stock is counted.</li></ol></div>`);

  const sync = card(`${icon('refresh-ccw')}Orders`, ls?.ok ? `${count(ls.shipments)} shipments read · last ${ls.days} days of dispatched and cancelled, and every open one` : '',
    !ls ? `<div class="pane"><div class="empty-note"><b>No sync yet.</b>${st.connected ? `Orders come in every ${st.poll_minutes} minutes, or press Sync orders now.` : 'Orders come in once Flipkart is connected.'}</div></div>`
      : !ls.ok ? `<div class="pane"><p class="warn-text">The last sync failed: ${esc(ls.failure)}</p></div>`
        : `<div class="pane"><div class="ox-kv c3" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
          ${[['New orders', ls.created], ['Changed', ls.updated], ['Unchanged', ls.unchanged], ['Lines added', ls.items_added], ['Lines updated', ls.items_updated], ['Held for a person', ls.conflicts]]
            .map(([k, v]) => `<div><div class="soft" style="font-size:12px">${esc(k)}</div><b>${count(v)}</b></div>`).join('')}</div>
          ${ls.unmapped?.length ? `<p style="margin:12px 0 4px"><b>Flipkart SKUs not mapped yet</b> — their orders cannot be dispatched until mapped in <a href="/inventory?view=unmapped">Inventory → Unmapped SKUs</a>:</p>
            <p class="mono" style="margin:0">${ls.unmapped.map((u) => `${esc(u.code || '(no SKU)')} × ${count(u.lines)}`).join(' · ')}</p>` : ''}
          ${ls.errors?.length ? `<p class="warn-text" style="margin-top:8px">${count(ls.errors.length)} order${ls.errors.length === 1 ? '' : 's'} skipped: ${esc(ls.errors.slice(0, 3).map((e) => `${e.orderId || '—'} (${e.reason})`).join('; '))}</p>` : ''}</div>`);

  const plan = state.plan;
  const stock = card(`${icon('boxes')}Stock to Flipkart`, `${count(plan.length)} mapped Flipkart SKU${plan.length === 1 ? '' : 's'}${st.buffer ? ` · ${count(st.buffer)} units held back per product` : ''}`,
    plan.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Flipkart SKU</th><th>Master SKU</th><th class="r">Briyo available</th><th class="r">Units / listing</th>
      <th class="r">To send</th><th class="r">Last sent</th><th>When</th><th>Status</th></tr></thead><tbody>
      ${plan.map((p) => `<tr><td class="mono">${esc(p.flipkart_sku)}</td><td><b class="mono">${esc(p.sku || '—')}</b><div class="soft" style="font-size:12px">${esc(p.product_name || '')}</div></td>
        <td class="r num">${p.available === null ? '—' : count(p.available)}</td><td class="r num">${count(p.units_per_listing)}</td>
        <td class="r num"><b>${p.qty === null ? '—' : count(p.qty)}</b></td><td class="r num">${p.last_qty === null ? '—' : count(p.last_qty)}</td>
        <td>${esc(when(p.last_pushed_at))}</td>
        <td style="white-space:normal;min-width:180px">${p.skip ? `<span class="soft">Skipped: ${esc(p.skip)}</span>`
          : p.last_error ? `<span class="warn-text">${esc(p.last_error)}</span>`
          : p.last_qty !== null && p.last_qty === p.qty ? '<span class="soft">Up to date</span>' : '<span>Will be sent</span>'}</td></tr>`).join('')}
    </tbody></table></div><p class="imp-note" style="margin:8px 14px">Only Flipkart SKUs mapped to a master SKU are sent; any other listing is never touched. Stock = Briyo available ÷ units per listing${st.buffer ? `, less ${st.buffer}` : ''}. A bundle sends how many can be made from its contents.</p>`
      : '<div class="pane"><div class="empty-note"><b>No Flipkart SKUs are mapped yet.</b>Open a master SKU in Inventory and add its Flipkart SKU under the Flipkart platform.</div></div>');

  $('#body').innerHTML = connect + sync + stock;
  $('#syncNow').hidden = !(isAdmin() && st.connected);
  $('#pushNow').hidden = !(canStock() && st.connected && plan.length);
  renderIcons();
}

async function load() {
  const [st, plan] = await Promise.all([api('/api/orders/flipkart/status'), api('/api/orders/flipkart/stock')]);
  state.status = st; state.plan = plan.plan;
  render();
}

(async () => {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    await load();
    $('#refresh').addEventListener('click', () => load().catch((err) => note(err.message)));
    $('#syncNow').addEventListener('click', async () => {
      const b = $('#syncNow'); b.disabled = true; note('Syncing Flipkart orders…', true);
      try {
        const { result: r } = await api('/api/orders/flipkart/sync', { method: 'POST', body: JSON.stringify({}) });
        note(`Flipkart orders synced: ${r.created} new, ${r.updated} changed${r.conflicts ? `, ${r.conflicts} held for a person` : ''}.`, true);
        await load();
      } catch (err) { note(err.message); } finally { b.disabled = false; }
    });
    $('#pushNow').addEventListener('click', async () => {
      const b = $('#pushNow'); b.disabled = true; note('Sending stock to Flipkart…', true);
      try {
        const { result: r } = await api('/api/orders/flipkart/stock', { method: 'POST', body: JSON.stringify({}) });
        note(r.due ? `Stock sent for ${r.sent} Flipkart SKU${r.sent === 1 ? '' : 's'}${r.failed ? `; ${r.failed} failed (see Status)` : ''}.` : 'Everything was already up to date on Flipkart.', !r.failed);
        await load();
      } catch (err) { note(err.message); } finally { b.disabled = false; }
    });
  } catch (err) { note(err.message); $('#body').innerHTML = ''; }
})();
