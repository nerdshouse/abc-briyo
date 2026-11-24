/**
 * Inventory → Alerts (lib/stock-alerts.js): products that need a PO by A/B/C class, batches too old (or nearly) for a
 * platform's shelf-life minimum, every product's class, and the settings — cut-offs, days of cover, lead time, each
 * platform's minimum, and the WhatsApp numbers for the daily digest. Everyone with Inventory reads; Inventory
 * managers (inventory.catalog) change the settings and classes, and can send the digest now.
 */
import { $, $$, esc, count, icon, renderIcons, initShell, pageFetch, hasCap } from './ui/components.js';
import { istDateTime, formatDayKey } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, data: null, saving: false };
const canManage = () => hasCap(state.me, 'inventory.catalog');
const day = (d) => (d ? formatDayKey(d) : '—');
const num = (n) => (n === null || n === undefined ? '—' : count(n));

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
const classTag = (c) => `<span class="tag ${c === 'A' ? 'warn' : ''}" title="Class ${c}">${c}</span>`;
const product = (p) => `<b class="mono">${esc(p.sku)}</b><div class="soft" style="font-size:12px">${esc([p.product_name, p.variant_name].filter(Boolean).join(' '))}</div>`;
/** Days of stock left: beyond a year it is just "1 year+". */
const daysLeft = (n) => (n === null ? '—' : n > 365 ? '1 year+' : count(n));
const card = (title, meta, body) => `<section class="card"><header class="card-head"><h2 class="card-title">${title}${meta ? ` <span class="card-meta">${meta}</span>` : ''}</h2></header>${body}</section>`;

function render() {
  const d = state.data;
  const s = d.settings;
  const rules = s.platforms.filter((p) => p.min_pct);
  // The Inventory page's summary cards (b = the figure, span = the label).
  const statCard = (v, label, tone, tip) => `<div class="imp-stat inv-card ${tone}" title="${esc(tip)}"><b>${esc(v)}</b><span>${esc(label)}</span></div>`;
  const wa = s.whatsapp_to.length;
  $('#cards').innerHTML = [
    statCard(count(d.summary.po), 'Need a PO', d.summary.po ? 'warn' : '', 'Available + incoming below the reorder point'),
    statCard(count(d.summary.below), 'Too old for a platform', d.summary.below ? 'bad' : '', 'Under a platform’s shelf-life minimum'),
    statCard(count(d.summary.soon), 'Near a platform limit', d.summary.soon ? 'warn' : '', `Cross a minimum within ${s.shelf_warn_days} days`),
    statCard(wa ? `${String(s.send_hour).padStart(2, '0')}:00` : 'Off', wa ? `WhatsApp daily · ${wa} number${wa === 1 ? '' : 's'}` : 'WhatsApp digest: no numbers', wa ? 'good' : '', 'Sent once a day, only when there is something to alert'),
  ].join('');

  const po = card(`${icon('shopping-cart')}Need a PO`, `${count(d.po.length)} · last ${s.sales_days} days of dispatches, lead time ${s.lead_days} days`,
    d.po.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Class</th><th class="r">Sold (${s.sales_days}d)</th><th class="r">Per day</th>
      <th class="r">Available</th><th class="r">Incoming</th><th class="r">Days left</th><th class="r">Reorder point</th><th class="r">Suggested PO</th></tr></thead><tbody>
      ${d.po.map((p) => `<tr><td>${product(p)}</td><td>${classTag(p.class)}</td><td class="r num">${num(p.sold)}</td><td class="r num">${p.daily}</td>
        <td class="r num">${num(p.available)}</td><td class="r num">${num(p.incoming)}</td>
        <td class="r num">${p.days_left === null ? '—' : `<b${p.days_left <= s.lead_days ? ' class="warn-text"' : ''}>${count(p.days_left)}</b>`}</td>
        <td class="r num" title="${p.fixed_level ? 'The SKU’s own reorder level' : `${p.daily}/day × (${s.lead_days} lead + ${p.cover_days} cover days)`}">${num(p.reorder_point)}${p.fixed_level ? ' <span class="soft">(set)</span>' : ''}</td>
        <td class="r num"><b>${num(p.suggested_qty)}</b></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="pane"><div class="empty-note"><b>Nothing to reorder.</b>Every product has enough stock for its lead time and cover.</div></div>');

  const shelfBody = !rules.length
    ? '<div class="pane"><div class="empty-note"><b>No platform minimums set yet.</b>Set each platform’s minimum shelf life in Settings below (e.g. 70%).</div></div>'
    : d.shelf.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Batch</th><th class="r">Units</th><th>Mfg</th><th>Expiry</th><th class="r">Life left</th><th>Platforms</th></tr></thead><tbody>
      ${d.shelf.map((x) => `<tr><td>${product(x)}</td><td class="mono">${esc(x.batch_number)}<div class="soft" style="font-size:12px">${esc(x.warehouse)}</div></td><td class="r num">${count(x.on_hand)}</td>
        <td>${esc(day(x.mfg_date))}</td><td>${esc(day(x.expiry_date))}</td><td class="r num"><b${x.below.length ? ' class="warn-text"' : ''}>${x.shelf_pct}%</b></td>
        <td style="white-space:normal;min-width:220px">${x.below.length ? `<div class="warn-text">Not for ${x.below.map((r) => `${esc(r.label)} (${r.min_pct}%)`).join(', ')}</div>` : ''}
          ${x.soon.map((r) => `<div class="soft">Under ${r.min_pct}% for ${esc(r.label)} on ${esc(day(r.on))}</div>`).join('')}</td></tr>`).join('')}</tbody></table></div>
      <p class="imp-note" style="margin:8px 14px">Batches under a platform’s minimum are not picked for that platform’s shipments (warehouse, quick commerce, partner, retailer). Easy Ship parcels go to customers and are not affected. Sell these through the website or Easy Ship before expiry.</p>`
      : '<div class="pane"><div class="empty-note"><b>All batches are fresh enough.</b>None is under, or close to, a platform’s minimum.</div></div>';
  const shelf = card(`${icon('calendar-clock')}Shelf life`, rules.length ? rules.map((r) => `${esc(r.label)} ${r.min_pct}%`).join(' · ') : '', shelfBody)
    + (d.unmeasured_batches ? `<p class="imp-note">${count(d.unmeasured_batches)} batch${d.unmeasured_batches === 1 ? '' : 'es'} with stock have no manufacturing date, so their shelf life cannot be measured.</p>` : '');

  const classes = card(`${icon('layers')}Products by class`, `A = first ${s.a_share}% of units sold · B = up to ${s.b_share}% · C = the rest · cover A ${s.cover_a} / B ${s.cover_b} / C ${s.cover_c} days`,
    `<div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Class</th><th class="r">Sold (${s.sales_days}d)</th><th class="r">Per day</th><th class="r">Available + incoming</th>
      <th class="r">Reorder point</th><th class="r">Order up to</th><th class="r">Days left</th></tr></thead><tbody>
      ${d.products.map((p) => `<tr><td>${product(p)}</td><td>${canManage()
        ? `<select class="select mini-select" data-class="${p.sku_id}" aria-label="Class for ${esc(p.sku)}">${['', 'A', 'B', 'C'].map((c) => `<option value="${c}"${(p.class_set_by_hand ? p.class : '') === c ? ' selected' : ''}>${c ? `${c} (by hand)` : `${p.auto_class} (from sales)`}</option>`).join('')}</select>`
        : `${classTag(p.class)}${p.class_set_by_hand ? ' <span class="soft">by hand</span>' : ''}`}</td>
        <td class="r num">${num(p.sold)}</td><td class="r num">${p.daily}</td><td class="r num">${num(p.available + p.incoming)}</td>
        <td class="r num">${num(p.reorder_point)}</td><td class="r num">${num(p.order_up_to)}</td><td class="r num">${daysLeft(p.days_left)}</td></tr>`).join('')}
    </tbody></table></div>`);

  const f = (k, label, help = '') => `<label class="fld"><span>${esc(label)}</span><input class="input" name="${k}" inputmode="numeric" value="${esc(s[k])}"${canManage() ? '' : ' disabled'} />${help ? `<span class="help">${esc(help)}</span>` : ''}</label>`;
  const settings = card(`${icon('settings')}Settings`, s.updated_by ? `last changed by ${esc(s.updated_by)}, ${esc(istDateTime(s.updated_at))}` : '',
    `<form class="pane" id="settingsForm" novalidate><div class="form-grid">
      ${f('a_share', 'Class A: first % of units sold', 'Best sellers making up this share')}${f('b_share', 'Class B: up to % of units sold', 'The rest are class C')}
      ${f('sales_days', 'Sales period (days)', 'Sales speed is worked out over this')}${f('lead_days', 'Supplier lead time (days)', 'PO to stock arriving')}
      ${f('cover_a', 'Cover for class A (days)')}${f('cover_b', 'Cover for class B (days)')}${f('cover_c', 'Cover for class C (days)')}
      ${f('shelf_warn_days', 'Warn before a shelf-life limit (days)')}
    </div>
    <h3 class="dsec-title" style="margin-top:14px">Minimum shelf life per platform</h3>
    <p class="help" style="margin:0 0 8px">Leave blank where a platform has no minimum. Applies to stock sent to the platform (not Easy Ship).</p>
    <div class="form-grid">${s.platforms.map((p) => `<label class="fld"><span>${esc(p.label)} (%)</span><input class="input" data-platform="${esc(p.channel)}" inputmode="numeric" placeholder="none" value="${esc(p.min_pct ?? '')}"${canManage() ? '' : ' disabled'} /></label>`).join('')}</div>
    <h3 class="dsec-title" style="margin-top:14px">WhatsApp digest</h3>
    <div class="form-grid">
      <label class="fld wide"><span>Numbers (one per line)</span><textarea class="input" name="whatsapp_to" rows="3"${canManage() ? '' : ' disabled'}>${esc(s.whatsapp_to.map((p) => `+${p.slice(0, 2)} ${p.slice(2, 7)} ${p.slice(7)}`).join('\n'))}</textarea></label>
      ${f('send_hour', 'Send after (hour, IST, 0–23)', 'Once a day, only when there is something to alert')}
    </div>
    ${d.sends?.length ? `<p class="help">Last sent: ${d.sends.map((x) => `${esc(day(x.day))} — ${x.delivered}/${x.recipients} delivered${x.errors?.length ? ` (${esc(x.errors[0].error)})` : ''}`).join(' · ')}</p>` : ''}
    ${canManage() ? '<div class="form-actions"><button class="btn primary" type="submit" id="saveSettings">Save settings</button><span class="saved" id="setSaved"></span></div>' : ''}
  </form>`);

  $('#body').innerHTML = po + shelf + classes + settings;
  $('#sendNow').hidden = !canManage();
  renderIcons();
}

async function load() {
  state.data = await api('/api/inventory/alerts');
  render();
}

async function saveSettings(form) {
  if (state.saving) return;
  state.saving = true;
  const out = $('#setSaved');
  out.className = 'saved pending'; out.textContent = 'Saving…';
  const body = { version: state.data.settings.version, whatsapp_to: form.whatsapp_to.value };
  for (const k of ['a_share', 'b_share', 'sales_days', 'lead_days', 'cover_a', 'cover_b', 'cover_c', 'shelf_warn_days', 'send_hour']) body[k] = form[k].value;
  body.platforms = $$('[data-platform]').map((i) => ({ channel: i.dataset.platform, min_pct: i.value.trim() }));
  try {
    await api('/api/inventory/alerts/settings', { method: 'PUT', body: JSON.stringify(body) });
    await load();
    note('Settings saved.', true);
  } catch (err) { out.className = 'saved failed'; out.textContent = err.message; } finally { state.saving = false; }
}

(async () => {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    await load();
    $('#refresh').addEventListener('click', () => load().catch((err) => note(err.message)));
    $('#body').addEventListener('submit', (e) => { if (e.target.id === 'settingsForm') { e.preventDefault(); saveSettings(e.target); } });
    $('#body').addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-class]');
      if (!sel) return;
      try { await api(`/api/inventory/alerts/class/${sel.dataset.class}`, { method: 'PUT', body: JSON.stringify({ class: sel.value }) }); await load(); } catch (err) { note(err.message); }
    });
    $('#sendNow').addEventListener('click', async () => {
      const b = $('#sendNow');
      b.disabled = true;
      try {
        const r = await api('/api/inventory/alerts/send', { method: 'POST' });
        note(r.sent ? `WhatsApp digest sent to ${r.delivered} of ${r.recipients} number${r.recipients === 1 ? '' : 's'}.` : (r.reason || (r.errors?.[0]?.error) || 'Not sent.'), r.sent);
        await load();
      } catch (err) { note(err.message); } finally { b.disabled = false; }
    });
  } catch (err) { note(err.message); $('#body').innerHTML = ''; }
})();
