/**
 * Affiliate payouts — approved commissions paid in batches through the bank, with TDS (Phase 2B). One page:
 *   /affiliate-payouts               batches, the TDS settings and the TDS register
 *   /affiliate-payouts?new=1         what a new batch would pay (nothing is reserved until it is created)
 *   /affiliate-payouts?batch={ref}   one batch: its bank file, then each payout marked paid (UTR) or failed
 * Every figure and permission comes from /api/affiliates/payouts; the server checks again.
 */
import {
  $, esc, count, icon, renderIcons, initShell, pageFetch, pageSignal, onQueryChange,
} from './ui/components.js';
import { istDate, istDateTime, istDayKey } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, view: 'list', batchRef: null, overview: null, preview: null, exclude: new Set(), batch: null, form: null, dirty: false };
const API = '/api/affiliates/payouts';

const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body ?? {}) });
const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
const pct = (bps) => `${Math.trunc(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, '0').replace(/0+$/, '')}` : ''}%`;
const by = (at, who) => (at ? `${esc(istDateTime(at))}${who ? ` <span class="soft">· ${esc(who)}</span>` : ''}` : '<span class="soft">—</span>');
const BATCH_TAG = { open: ['callback', 'Open'], closed: ['recovered', 'Closed'], cancelled: ['none', 'Cancelled'] };
const PAYOUT_TAG = { pending: ['callback', 'Waiting for bank'], paid: ['recovered', 'Paid'], failed: ['lost', 'Failed'], cancelled: ['none', 'Cancelled'] };
const tagOf = (map, s) => `<span class="status ${map[s]?.[0] || ''}"><span class="dot"></span>${esc(map[s]?.[1] || s)}</span>`;
const kv = (label, value) => `<div class="hr-kv"><span>${esc(label)}</span><span>${value}</span></div>`;
const fig = (label, value, note = '') => `<div class="af-fig"><span class="af-fig-label">${esc(label)}</span><span class="af-fig-value num">${value}</span>${note ? `<span class="af-fig-note">${note}</span>` : ''}</div>`;

// ------------------------------------------------------------------ URL

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  state.batchRef = q.get('batch') ? q.get('batch').toUpperCase() : null;
  state.view = state.batchRef ? 'batch' : q.get('new') ? 'new' : 'list';
}
function go(search) {
  window.history.pushState(null, '', `/affiliate-payouts${search}`);
  readUrl(); load();
}

function failed(err) {
  $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span><button class="btn" type="button" id="retry">Try again</button></div>`;
  renderIcons();
}

async function load() {
  $('#alerts').innerHTML = '';
  try {
    if (state.view === 'batch') { state.batch = (await api(`${API}/batches/${encodeURIComponent(state.batchRef)}`)).batch; renderBatch(); return; }
    state.overview = await api(`${API}/overview`);
    if (state.view === 'new') { await loadPreview(); return; }
    renderList();
  } catch (err) {
    if (err.status === 404 && state.view === 'batch') { $('#view').innerHTML = `<section class="card"><div class="empty-note"><b>No batch ${esc(state.batchRef)}.</b><a class="linkish" href="/affiliate-payouts">All batches</a></div></section>`; return; }
    failed(err);
  }
}

function head(title, sub, actions = '') {
  $('#pageTitle').innerHTML = title;
  $('#pageSub').innerHTML = sub;
  $('#pageActions').innerHTML = `<button class="icon-btn" id="refresh" type="button" title="Refresh" aria-label="Refresh">${icon('refresh-cw')}</button>${actions}`;
}

// ------------------------------------------------------------------ list: batches, TDS settings, register

function renderList() {
  const { batches, settings: s, financial_year: fy } = state.overview;
  head('Affiliate payouts', `Financial year ${esc(fy)} · ${count(batches.length)} batch${batches.length === 1 ? '' : 'es'}`,
    `<button class="btn primary" type="button" data-go="new">${icon('plus')}New payout batch</button>`);
  const years = [0, 1, 2].map((n) => { const y = Number(fy.slice(0, 4)) - n; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; });
  $('#view').innerHTML = `
    <div class="af-stack">
      <section class="card">
        <header class="card-head"><h2 class="card-title">${icon('layers')}Batches</h2></header>
        <div class="pane">
          ${batches.length ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Batch</th><th>Created</th><th>Status</th><th class="r">Payouts</th><th class="r">Gross</th><th class="r">TDS</th><th class="r">Net</th></tr></thead>
            <tbody>${batches.map((b) => `<tr class="orow" data-batch="${esc(b.ref)}" tabindex="0">
              <td class="mono"><b>${esc(b.ref)}</b>${b.note ? `<span class="cell-sub">${esc(b.note)}</span>` : ''}</td>
              <td>${by(b.created_at, b.created_by)}</td><td>${tagOf(BATCH_TAG, b.status)}</td>
              <td class="r num">${count(b.payouts)}<span class="cell-sub">${[b.paid && `${count(b.paid)} paid`, b.pending && `${count(b.pending)} waiting`, b.failed && `${count(b.failed)} failed`].filter(Boolean).join(' · ')}</span></td>
              <td class="r num">${esc(inr(b.gross))}</td><td class="r num">${esc(inr(b.tds))}</td><td class="r num"><b>${esc(inr(b.net))}</b></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-note"><b>No payout batches yet.</b>Start one with New payout batch: it gathers every approved commission of affiliates with bank details.</div>'}
        </div>
      </section>

      <section class="card">
        <header class="card-head"><h2 class="card-title">${icon('receipt-indian-rupee')}TDS</h2>
          <div class="card-tools"><button class="btn" type="button" data-tds>${icon('pencil')}Edit</button></div></header>
        <div class="pane pad">
          ${kv('Section', esc(s.tds_section))}
          ${kv('Rate with PAN', esc(pct(s.tds_rate_bps)))}
          ${kv('Rate without PAN', esc(pct(s.tds_no_pan_rate_bps)))}
          ${kv('Yearly threshold', `${esc(inr(s.tds_threshold_inr))} <span class="soft">per affiliate, April–March</span>`)}
          <p class="soft af-note">No TDS until an affiliate's commission in the financial year passes the threshold. From then on the rate applies to the whole year's commission: the first payout over the line also covers the earlier ones. Please confirm the section and rates with your CA; a change applies to batches made afterwards.</p>
          <h3 class="dsec-title af-gap">TDS register</h3>
          <div class="af-ver-actions"><select class="select" id="tdsYear" aria-label="Financial year">${years.map((y) => `<option value="${y}">FY ${y}</option>`).join('')}</select>
            <a class="btn" id="tdsDownload" href="${API}/tds-register?fy=${years[0]}">${icon('download')}Download register</a></div>
          <p class="soft af-note">Every paid payout of the year with PAN, gross, TDS and UTR, by quarter: for the quarterly TDS return (26Q) and Form 16A.</p>
        </div>
      </section>
    </div>`;
  renderIcons();
}

// ------------------------------------------------------------------ new batch: preview, then create

async function loadPreview() {
  const q = state.exclude.size ? `?exclude=${encodeURIComponent([...state.exclude].join(','))}` : '';
  state.preview = (await api(`${API}/preview${q}`)).preview;
  renderPreview();
}

function renderPreview() {
  const p = state.preview;
  head('New payout batch', `Financial year ${esc(p.financial_year)} · nothing is reserved until you create the batch`, `<a class="btn" href="/affiliate-payouts">${icon('arrow-left')}All batches</a>`);
  const left = p.blocked.filter((b) => state.exclude.has(b.affiliate));
  const blocked = p.blocked.filter((b) => !state.exclude.has(b.affiliate));
  $('#view').innerHTML = `<div class="af-stack">
    <section class="card">
      <div class="af-figs c4">${fig('Payouts', count(p.totals.payouts))}${fig('Gross commission', esc(inr(p.totals.gross)))}${fig('TDS', esc(inr(p.totals.tds)), `Section ${esc(p.settings.tds_section)}`)}${fig('Net to pay', `<b>${esc(inr(p.totals.net))}</b>`)}</div>
      <div class="pane">
        ${p.payouts.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>Affiliate</th><th class="r">Commissions</th><th class="r">Gross</th><th class="r">Earlier this year</th><th class="r">TDS</th><th class="r">Net</th><th>Bank</th><th></th></tr></thead>
          <tbody>${p.payouts.map((x) => `<tr><td><a class="linkish" href="/affiliates/${esc(x.affiliate)}">${esc(x.name)}</a><span class="cell-sub mono">${esc(x.affiliate)}${x.affiliate_status !== 'active' ? ` · ${esc(x.affiliate_status)}` : ''}</span></td>
            <td class="r num">${count(x.commissions)}</td><td class="r num">${esc(inr(x.gross))}</td><td class="r num">${esc(inr(x.fy_gross_before))}</td>
            <td class="r num">${esc(inr(x.tds))}<span class="cell-sub">${x.below_threshold ? 'Below threshold' : `${esc(pct(x.tds_rate_bps))}${x.has_pan ? '' : ' · no PAN'}`}</span></td>
            <td class="r num"><b>${esc(inr(x.net))}</b></td><td class="mono">${esc(x.bank_account)}<span class="cell-sub">${esc(x.bank_ifsc)}</span></td>
            <td class="r"><button class="btn" type="button" data-leave="${esc(x.affiliate)}">Leave out</button></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-note"><b>Nothing to pay now.</b>No approved commission of an affiliate with complete bank details is waiting.</div>'}
        ${left.length ? `<h3 class="dsec-title af-gap pad">Left out of this batch</h3><div class="table-wrap"><table class="table"><tbody>${left.map((b) => `<tr><td>${esc(b.name)} <span class="mono soft">${esc(b.affiliate)}</span></td>
          <td class="r num">${esc(inr(b.gross))}</td><td class="r"><button class="btn" type="button" data-include="${esc(b.affiliate)}">Put back</button></td></tr>`).join('')}</tbody></table></div>` : ''}
        ${blocked.length ? `<h3 class="dsec-title af-gap pad">Waiting, but cannot be paid yet</h3><div class="table-wrap"><table class="table"><tbody>${blocked.map((b) => `<tr><td><a class="linkish" href="/affiliates/${esc(b.affiliate)}">${esc(b.name)}</a></td>
          <td class="r num">${esc(inr(b.gross))}<span class="cell-sub">${count(b.commissions)} commission${b.commissions === 1 ? '' : 's'}</span></td><td>${esc(b.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${p.held.length ? `<h3 class="dsec-title af-gap pad">Approved commissions held back</h3><div class="table-wrap"><table class="table"><tbody>${p.held.map((h) => `<tr><td>${esc(h.name)} <span class="soft">· order ${esc(h.order || '—')}</span></td>
          <td class="r num">${esc(h.amount)} ${esc(h.currency)}</td><td>${esc(h.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${p.payouts.length ? `<div class="pad"><label class="fld wide"><span>Note (optional)</span><input class="input plain" id="batchNote" maxlength="300" placeholder="e.g. October commissions" /></label>
          <div class="af-ver-actions"><button class="btn primary" type="button" id="createBatch">${icon('check')}Create batch of ${count(p.totals.payouts)}</button></div>
          <p class="soft af-note">Creating the batch fixes each payout's TDS and takes its commissions out of the pool, so they cannot be paid twice. Then download the bank file, pay through the bank, and mark each payout paid with its UTR.</p></div>` : ''}
      </div>
    </section></div>`;
  renderIcons();
}

async function createBatch(btn) {
  btn.disabled = true;
  try {
    const out = await send(`${API}/batches`, 'POST', { exclude: [...state.exclude], note: $('#batchNote')?.value || '' });
    state.exclude.clear();
    go(`?batch=${encodeURIComponent(out.batch.ref)}`);
  } catch (err) { btn.disabled = false; failed(err); }
}

// ------------------------------------------------------------------ one batch

function renderBatch() {
  const b = state.batch;
  const pending = b.payouts.filter((p) => p.status === 'pending');
  const anyPaid = b.payouts.some((p) => p.status === 'paid');
  head(`Batch <span class="mono">${esc(b.ref)}</span> <span class="af-title-tag">${tagOf(BATCH_TAG, b.status)}</span>`,
    `Created ${by(b.created_at, b.created_by)}${b.note ? ` · ${esc(b.note)}` : ''}`,
    `<a class="btn" href="/affiliate-payouts">${icon('arrow-left')}All batches</a>
     ${pending.length ? `<a class="btn primary" href="${API}/batches/${encodeURIComponent(b.ref)}/bank-file">${icon('download')}Bank file (${count(pending.length)})</a>` : ''}
     ${b.status === 'open' && !anyPaid ? `<button class="btn" type="button" data-cancel>${icon('circle-x')}Cancel batch</button>` : ''}`);
  $('#view').innerHTML = `<div class="af-stack">
    <section class="card">
      <div class="af-figs c4">${fig('Payouts', count(b.payouts.length), pending.length ? `${count(pending.length)} waiting for the bank` : '')}${fig('Gross', esc(inr(b.totals.gross)))}${fig('TDS', esc(inr(b.totals.tds)))}${fig('Net', `<b>${esc(inr(b.totals.net))}</b>`)}</div>
      ${b.status === 'cancelled' ? `<div class="pad"><div class="alert warn">${icon('info')}<span>Cancelled ${by(b.cancelled_at, b.cancelled_by)}: ${esc(b.cancel_reason || '')}. Its commissions went back to the pool.</span></div></div>` : ''}
      <div class="pane">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Affiliate</th><th class="r">Gross</th><th class="r">TDS</th><th class="r">Net</th><th>Pay to</th><th>Status</th><th></th></tr></thead>
          <tbody>${b.payouts.map((p) => `<tr><td><a class="linkish" href="/affiliates/${esc(p.affiliate)}">${esc(p.name)}</a><span class="cell-sub mono">${esc(p.ref)} · ${count(p.commissions)} commission${p.commissions === 1 ? '' : 's'}</span></td>
            <td class="r num">${esc(inr(p.gross))}</td><td class="r num">${esc(inr(p.tds))}<span class="cell-sub">${esc(pct(p.tds_rate_bps))} · ${esc(p.tds_section)}${p.has_pan ? '' : ' · no PAN'}</span></td>
            <td class="r num"><b>${esc(inr(p.net))}</b></td>
            <td>${esc(p.payee_name)}<span class="cell-sub mono">${esc(p.bank_account)} · ${esc(p.bank_ifsc)}</span></td>
            <td>${tagOf(PAYOUT_TAG, p.status)}${p.utr ? `<span class="cell-sub mono">UTR ${esc(p.utr)}${p.paid_on ? ` · ${esc(istDate(`${p.paid_on}T00:00:00+05:30`))}` : ''}</span>` : ''}${p.failure_reason ? `<span class="cell-sub">${esc(p.failure_reason)}</span>` : ''}</td>
            <td class="r af-cm-acts">${p.status === 'pending' ? `<button class="btn" type="button" data-paid="${esc(p.ref)}">Mark paid</button> <button class="btn" type="button" data-failed="${esc(p.ref)}">Failed</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <div class="pane-foot">Pay the net amounts through the bank (upload the bank file, or pay each one), then mark each payout paid with the bank's UTR: its commissions become Paid. If the bank rejects one, mark it failed: its commissions go back to the pool for the next batch. The account numbers appear in full only in the bank file.</div>
      </div>
    </section></div>`;
  renderIcons();
}

// ------------------------------------------------------------------ drawer

function showDrawer(title, sub, body, label, danger = false) {
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
  document.documentElement.classList.add('scroll-locked');
  $('#dTitle').textContent = title; $('#dSub').textContent = sub || '';
  $('#dBody').innerHTML = body;
  $('#dButtons').innerHTML = `<button class="btn" type="button" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" type="button" id="dSave">${esc(label)}</button>`;
  $('#dSaved').textContent = ''; $('#dSaved').className = 'saved';
  state.dirty = false; state.discardAsked = false; $('#dDiscard').hidden = true;
  renderIcons();
  $('#dBody').querySelector('input, select, textarea')?.focus();
}
function closeDrawer({ force = false } = {}) {
  if ($('#drawer').hidden) return;
  if (!force && state.dirty && !state.discardAsked) { state.discardAsked = true; $('#dDiscard').hidden = false; $('#dDiscardYes').focus(); return; }
  $('#dDiscard').hidden = true; state.discardAsked = false;
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true;
  document.documentElement.classList.remove('scroll-locked');
  state.form = null; state.dirty = false;
}
const inp = (name, label, value = '', { type = 'text', req = false, help = '', attrs = '' } = {}) => `<label class="fld wide"><span>${label}${req ? ' <em>*</em>' : ''}</span>
  <input class="input plain" name="${name}" type="${type}" value="${esc(value)}" ${attrs} />${help ? `<span class="help">${help}</span>` : ''}</label>`;
const formData = () => Object.fromEntries(new FormData($('#pfForm')).entries());

function openPaid(ref) {
  const p = state.batch.payouts.find((x) => x.ref === ref);
  state.form = { kind: 'paid', ref, version: p.version };
  showDrawer('Mark payout paid', `${p.name} · ${inr(p.net)} to ${p.bank_account}`, `<form id="pfForm" novalidate><div class="form-grid">
    ${inp('utr', 'Bank reference (UTR)', '', { req: true, attrs: 'maxlength="40" autocomplete="off" spellcheck="false"', help: 'From the bank statement or the payment confirmation.' })}
    ${inp('paid_on', 'Paid on', istDayKey(new Date()), { type: 'date', req: true, attrs: `max="${istDayKey(new Date())}"` })}
    <p class="help wide">Its ${count(p.commissions)} commission${p.commissions === 1 ? '' : 's'} become Paid, and the payout goes into the TDS register for FY ${esc(p.financial_year)} (TDS ${esc(inr(p.tds))}). This cannot be undone.</p>
  </div></form>`, 'Mark paid');
}
function openFailed(ref) {
  const p = state.batch.payouts.find((x) => x.ref === ref);
  state.form = { kind: 'failed', ref, version: p.version };
  showDrawer('Payment failed', `${p.name} · ${inr(p.net)}`, `<form id="pfForm" novalidate><div class="form-grid">
    <label class="fld wide"><span>What happened <em>*</em></span><textarea class="input" name="reason" rows="3" maxlength="300" placeholder="e.g. Bank returned it: account closed"></textarea></label>
    <p class="help wide">Its commissions go back to the pool and will be in the next batch. Correct the affiliate's bank details first if they were wrong.</p>
  </div></form>`, 'Mark failed', true);
}
function openCancel() {
  state.form = { kind: 'cancel' };
  showDrawer('Cancel batch', `Batch ${state.batch.ref}`, `<form id="pfForm" novalidate><div class="form-grid">
    <label class="fld wide"><span>Reason <em>*</em></span><textarea class="input" name="reason" rows="3" maxlength="300"></textarea></label>
    <p class="help wide">Every payout in it is cancelled and its commissions go back to the pool. Only possible while none of it is paid. The batch is kept, marked cancelled.</p>
  </div></form>`, 'Cancel batch', true);
}
function openTds() {
  const s = state.overview.settings;
  state.form = { kind: 'tds' };
  const p = (bps) => (bps / 100).toString();
  showDrawer('TDS settings', 'Applies to batches made from now on', `<form id="pfForm" novalidate><div class="form-grid">
    ${inp('tds_section', 'Section', s.tds_section, { req: true, attrs: 'maxlength="20"', help: 'Commission or brokerage is usually Section 194H.' })}
    ${inp('tds_rate_percent', 'Rate with PAN (%)', p(s.tds_rate_bps), { req: true, attrs: 'inputmode="decimal"' })}
    ${inp('tds_no_pan_rate_percent', 'Rate without PAN (%)', p(s.tds_no_pan_rate_bps), { req: true, attrs: 'inputmode="decimal"' })}
    ${inp('tds_threshold_inr', 'Yearly threshold (₹)', String(s.tds_threshold_inr), { req: true, attrs: 'inputmode="numeric"', help: 'Per affiliate, per financial year (April–March).' })}
    <p class="help wide">Please confirm these with your CA. Payouts already made keep the TDS they were made with.</p>
  </div></form>`, 'Save settings');
}

async function saveForm() {
  const btn = $('#dSave');
  if (btn) btn.disabled = true;
  try {
    const f = state.form;
    if (f.kind === 'paid') state.batch = (await send(`${API}/payouts/${encodeURIComponent(f.ref)}/paid`, 'POST', { ...formData(), version: f.version, batch: state.batch.ref })).batch;
    else if (f.kind === 'failed') state.batch = (await send(`${API}/payouts/${encodeURIComponent(f.ref)}/failed`, 'POST', { ...formData(), version: f.version, batch: state.batch.ref })).batch;
    else if (f.kind === 'cancel') state.batch = (await send(`${API}/batches/${encodeURIComponent(state.batch.ref)}/cancel`, 'POST', formData())).batch;
    else if (f.kind === 'tds') state.overview.settings = (await send(`${API}/settings`, 'PUT', formData())).settings;
    state.dirty = false; closeDrawer({ force: true });
    if (state.view === 'batch') renderBatch(); else renderList();
  } catch (err) {
    $('#dSaved').className = 'saved failed'; $('#dSaved').textContent = err.message;
    if (err.data?.field) $('#dBody').querySelector(`[name="${CSS.escape(err.data.field)}"]`)?.focus();
  } finally { if (btn) btn.disabled = false; }
}

// ------------------------------------------------------------------ events

function bind() {
  const sig = { signal: pageSignal() };
  $('#view').addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-batch]');
    if (!t || e.target.closest('a')) return;
    if (t.dataset.batch) { go(`?batch=${encodeURIComponent(t.dataset.batch)}`); return; }
    if (t.dataset.leave) { state.exclude.add(t.dataset.leave); loadPreview().catch(failed); return; }
    if (t.dataset.include) { state.exclude.delete(t.dataset.include); loadPreview().catch(failed); return; }
    if (t.id === 'createBatch') { createBatch(t); return; }
    if (t.dataset.paid) { openPaid(t.dataset.paid); return; }
    if (t.dataset.failed) { openFailed(t.dataset.failed); return; }
    if (t.dataset.tds !== undefined) openTds();
  });
  $('#view').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.batch) go(`?batch=${encodeURIComponent(e.target.dataset.batch)}`); });
  $('#view').addEventListener('change', (e) => { if (e.target.id === 'tdsYear') $('#tdsDownload').href = `${API}/tds-register?fy=${encodeURIComponent(e.target.value)}`; });
  $('#pageActions').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'refresh') load();
    if (t.dataset.go === 'new') go('?new=1');
    if (t.dataset.cancel !== undefined) openCancel();
  });
  $('#alerts').addEventListener('click', (e) => { if (e.target.id === 'retry') load(); });
  $('#dBody').addEventListener('input', () => { state.dirty = true; });
  $('#dBody').addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });
  $('#dFoot').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'dSave') saveForm();
    if (t.dataset.close !== undefined) closeDrawer();
  });
  $('#dClose').addEventListener('click', () => closeDrawer());
  $('#dDiscardYes').addEventListener('click', () => closeDrawer({ force: true }));
  $('#dDiscardNo').addEventListener('click', () => { state.discardAsked = false; $('#dDiscard').hidden = true; });
  $('#drawerScrim').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); }, sig);
  onQueryChange(() => { readUrl(); load(); });
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    readUrl();
    bind();
    await load();
  } catch (err) { $('#view').innerHTML = ''; $('#pageSub').textContent = ''; failed(err); }
}());
