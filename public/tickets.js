/**
 * Tickets. Every member raises tickets and sees their own; the ticket owner (the founder) and admins see all of them,
 * change status and assignee, and can resend the WhatsApp notice. The API decides all of that (lib/tickets.js) — this
 * page only shows what the API returns and hides controls the API would refuse.
 * Everything a person typed is escaped (esc) before it is put into the page.
 */
import { $, $$, esc, icon, renderIcons, initShell, pageFetch, pageSignal, onLeave } from './ui/components.js';
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();
const state = { me: null, meta: null, scope: 'all', list: [], open: null, detail: null, saving: false };
const label = (list, key) => list?.find((x) => x.key === key)?.label || key;
const PRIORITY_TONE = { urgent: 'bad', high: 'warn', medium: '', low: '' };
const STATUS_TONE = { open: '', in_progress: 'warn', waiting: 'warn', resolved: 'ok', closed: '' };
const tag = (text, tone) => `<span class="tag ${tone || ''}">${esc(text)}</span>`;
const priorityTag = (p) => tag(label(state.meta.priorities, p), PRIORITY_TONE[p]);
const statusTag = (s) => tag(label(state.meta.statuses, s), STATUS_TONE[s]);
const when = (iso) => (iso ? istDateTime(iso) : '—');

const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
};
const note = (msg, ok = false) => {
  if (!$('#alerts')) return;   // the page was left meanwhile
  // Success uses the neutral success style (orders.css .alert.hr-ok); a plain .alert reads as an error.
  $('#alerts').innerHTML = msg ? `<div class="alert${ok ? ' hr-ok' : ''}" role="${ok ? 'status' : 'alert'}">${icon(ok ? 'circle-check' : 'circle-alert')}<span>${esc(msg)}</span></div>` : '';
  const waiting = $('#rows .empty-note[role=status]');
  if (msg && !ok && waiting) waiting.textContent = 'Could not load. See the message above.';
  renderIcons();
};
const saved = (msg, failed = false) => { $('#dSaved').className = `saved${failed ? ' failed' : ''}`; $('#dSaved').textContent = msg || ''; };
const opt = (v, text, sel = false) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(text)}</option>`;

/* ------------------------------------------------------------------ list */

function filters() {
  return { scope: state.meta.manager ? state.scope : 'mine', q: $('#fQ').value.trim(), status: $('#fStatus').value,
    priority: $('#fPriority').value, category: $('#fCategory').value, creator: state.meta.manager ? $('#fCreator').value : '' };
}
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const f = filters();
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const { tickets } = await api(`/api/tickets?${qs}`);
  if (seq !== loadSeq) return;   // a newer filter change is on its way
  state.list = tickets;
  const filtered = Boolean(f.q || f.status || f.priority || f.category || f.creator);
  const manager = state.meta.manager;
  $('#rows').innerHTML = tickets.length ? tickets.map((t) => `<tr data-number="${esc(t.number)}" tabindex="0">
      <td class="mono">${esc(t.number)}</td>
      <td class="tk-title"><span class="cell-main">${esc(t.title)}</span>${t.comment_count ? `<span class="cell-sub muted">${t.comment_count} comment${t.comment_count === 1 ? '' : 's'}</span>` : ''}</td>
      <td>${esc(label(state.meta.categories, t.category))}</td>
      <td>${priorityTag(t.priority)}</td>
      <td>${statusTag(t.status)}</td>
      ${manager ? `<td>${esc(t.creator_name)}</td>` : ''}
      <td>${esc(t.assignee_name || '—')}</td>
      <td class="num">${esc(when(t.updated_at))}</td></tr>`).join('')
    : `<tr><td colspan="8"><div class="empty-note">${filtered ? 'No tickets match these filters.'
      : manager && state.scope === 'all' ? 'No tickets yet.' : 'You have not raised any tickets yet. Use <b>New ticket</b> to raise one.'}</div></td></tr>`;
}
const reload = () => load().catch((err) => note(err.message));

/* ------------------------------------------------------------------ drawer */

function showDrawer(title, sub) {
  $('#dTitle').textContent = title; $('#dSub').textContent = sub || '';
  saved(''); $('#dActions').innerHTML = '';
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
}
function closeDrawer() {
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true; state.open = null; state.detail = null;
  const u = new URL(window.location.href);
  if (u.searchParams.has('open') || u.searchParams.has('new')) { u.searchParams.delete('open'); u.searchParams.delete('new'); history.replaceState(history.state, '', u); }
}

/** New ticket. The request id is made once per form, so a retried submit can never make a second ticket. */
function openNew(category = '') {
  state.open = null;
  showDrawer('New ticket', 'It goes to the founder, who is told on WhatsApp.');
  const m = state.meta;
  const ownerNote = m.owner?.resolved ? '' : `<div class="alert">${icon('circle-alert')}<span>${esc(m.owner?.error || 'Tickets are not set up yet.')}</span></div>`;
  $('#dBody').innerHTML = `${ownerNote}<form id="tkForm" novalidate data-request="${esc(crypto.randomUUID())}">
    <div class="form-error" id="tkErr" role="alert" hidden></div>
    <section class="dsec"><div class="form-grid">
      <label class="fld wide"><span>Title <em>*</em></span><input class="input" name="title" required maxlength="${m.limits.title}" autocomplete="off" placeholder="A short summary" /></label>
      <label class="fld"><span>Category <em>*</em></span><select class="select" name="category" required><option value="">Choose</option>${m.categories.map((c) => opt(c.key, c.label, c.key === category)).join('')}</select></label>
      <label class="fld"><span>Priority <em>*</em></span><select class="select" name="priority" required>${m.priorities.map((p) => opt(p.key, p.label, p.key === 'medium')).join('')}</select></label>
      <label class="fld wide"><span>Description <em>*</em></span><textarea class="input tk-desc" name="description" required maxlength="${m.limits.description}" placeholder="What happened, where, and what you expected"></textarea>
        <span class="help" id="tkCount"></span></label>
    </div></section></form>`;
  $('#dActions').innerHTML = '<button class="btn" type="button" data-act="cancel">Cancel</button><button class="btn primary" type="button" data-act="create">Raise ticket</button>';
  const desc = $('#tkForm [name=description]');
  const counter = () => { $('#tkCount').textContent = `${desc.value.length} / ${m.limits.description}`; };
  desc.addEventListener('input', counter); counter();
  renderIcons();
  $('#tkForm [name=title]').focus();
}

async function submitNew(btn) {
  const form = $('#tkForm');
  const err = $('#tkErr');
  err.hidden = true;
  const v = Object.fromEntries(new FormData(form));
  const missing = [['title', 'title'], ['category', 'category'], ['description', 'description']].filter(([k]) => !String(v[k] || '').trim());
  if (missing.length) {
    err.textContent = `Enter the ${missing.map(([, l]) => l).join(', ')}.`; err.hidden = false;
    form.querySelector(`[name=${missing[0][0]}]`).focus(); return;
  }
  btn.disabled = true; saved('Saving…');
  try {
    const r = await api('/api/tickets', { method: 'POST', body: JSON.stringify({ ...v, request_id: form.dataset.request }) });
    note(`Ticket ${r.ticket.number} raised${r.created ? '' : ' (it was already saved)'}. ${state.meta.owner?.name ? `${state.meta.owner.name} has been assigned.` : ''}`, true);
    await openTicket(r.ticket.number);
    reload();
  } catch (e) {
    saved('');
    err.textContent = e.message; err.hidden = false;
    const field = e.data?.field && form.querySelector(`[name=${e.data.field}]`);
    if (field) field.focus();
  } finally { btn.disabled = false; }
}

const EVENT_TEXT = {
  created: (e) => `Raised by ${e.actor_name || 'someone'}`,
  assigned: (e) => (e.metadata?.from ? `${e.actor_name} reassigned it from ${e.metadata.from} to ${e.metadata.to}` : `Assigned to ${e.metadata?.to}${e.metadata?.reason ? ` — ${e.metadata.reason}` : ''}`),
  status_changed: (e) => `${e.actor_name} changed the status from ${label(state.meta.statuses, e.metadata?.from)} to ${label(state.meta.statuses, e.metadata?.to)}`,
  commented: (e) => `${e.actor_name} commented`,
};
/** The current assignee is preselected; if they are not a manager any more they stay shown, so "Reassign" never moves the ticket by accident. */
function assigneeOptions(t, managers) {
  const current = managers.find((x) => x.name === t.assignee_name);
  return (current ? '' : `<option value="" selected disabled>${esc(t.assignee_name || 'Nobody')} (current)</option>`)
    + managers.map((x) => opt(x.key, `${x.name}${x.owner ? ' (ticket owner)' : ''}`, x === current)).join('');
}
// The server lets a manager resend anything not yet submitted, and a notice left "sending" for 10 minutes (a cut-off send).
const canResend = (n) => n.status !== 'submitted' && (n.status !== 'sending' || Date.now() - new Date(n.last_attempt_at).getTime() > 10 * 60000);
const NOTICE_TEXT = { pending: 'Waiting to be sent', sending: 'Sending…', submitted: 'Sent to WhatsApp', unconfirmed: 'Sent, but 11za did not confirm', failed: 'Not sent — failed', skipped: 'Not sent' };

async function openTicket(number) {
  const d = await api(`/api/tickets/${encodeURIComponent(number)}`);
  state.open = number; state.detail = d;
  const t = d.ticket;
  const m = state.meta;
  showDrawer(`${t.number} · ${t.title}`, `${label(m.categories, t.category)} · raised by ${t.creator_name} · ${when(t.created_at)}`);
  const u = new URL(window.location.href);
  if (u.searchParams.get('open') !== number) { u.searchParams.set('open', number); u.searchParams.delete('new'); history.replaceState(history.state, '', u); }
  const notice = (d.notifications || []).find((n) => n.kind === 'ticket_created');
  $('#dBody').innerHTML = `
    <section class="dsec"><dl class="tk-facts">
      <dt>Status</dt><dd>${statusTag(t.status)}</dd>
      <dt>Priority</dt><dd>${priorityTag(t.priority)}</dd>
      <dt>Category</dt><dd>${esc(label(m.categories, t.category))}</dd>
      <dt>Assigned to</dt><dd>${esc(t.assignee_name || '—')}</dd>
      <dt>Raised</dt><dd>${esc(when(t.created_at))}</dd>
      <dt>Updated</dt><dd>${esc(when(t.updated_at))}</dd>
      ${t.resolved_at ? `<dt>Resolved</dt><dd>${esc(when(t.resolved_at))}</dd>` : ''}
      ${t.closed_at ? `<dt>Closed</dt><dd>${esc(when(t.closed_at))}</dd>` : ''}
    </dl></section>
    <section class="dsec"><h3 class="dsec-title">Description</h3><div class="tk-text">${esc(t.description)}</div></section>
    ${d.manager ? `<section class="dsec"><h3 class="dsec-title">Manage</h3><div class="form-grid">
      <label class="fld"><span>Status</span><select class="select" id="tkStatus">${m.statuses.map((s) => opt(s.key, s.label, s.key === t.status)).join('')}</select></label>
      <label class="fld"><span>Assigned to</span><select class="select" id="tkAssignee">${assigneeOptions(t, m.managers || [])}</select></label>
    </div>
    <div class="tk-row"><button class="btn" type="button" data-act="status">Save status</button><button class="btn" type="button" data-act="assign">Reassign</button></div>
    ${notice ? `<p class="help tk-notice">WhatsApp notice to the ticket owner: <b>${esc(NOTICE_TEXT[notice.status] || notice.status)}</b>${notice.attempts ? ` · ${notice.attempts} attempt${notice.attempts === 1 ? '' : 's'}` : ''}${notice.last_error ? ` — ${esc(notice.last_error)}` : ''}
      ${canResend(notice) ? ' <button class="btn bare" type="button" data-act="resend">Send again</button>' : ''}</p>` : ''}
    </section>` : ''}
    <section class="dsec"><h3 class="dsec-title">Comments <span class="dsec-meta soft">${d.comments.length}</span></h3>
      ${d.comments.length ? `<ul class="tk-comments">${d.comments.map((c) => `<li><div class="tk-who"><b>${esc(c.author_name)}</b><span class="soft">${esc(when(c.created_at))}</span></div><div class="tk-text">${esc(c.body)}</div></li>`).join('')}</ul>` : '<p class="soft">No comments yet.</p>'}
      <label class="fld wide"><span class="sr-only">Add a comment</span><textarea class="input" id="tkComment" maxlength="${m.limits.comment}" placeholder="Add a comment"></textarea></label>
      <div class="tk-row"><button class="btn" type="button" data-act="comment">Add comment</button></div>
    </section>
    <section class="dsec"><h3 class="dsec-title">Activity</h3>
      <ul class="d-history">${d.events.map((e) => `<li><span>${esc((EVENT_TEXT[e.type] || ((x) => x.type))(e))}</span><span class="d-when">${esc(when(e.at))}</span></li>`).join('')}</ul>
    </section>`;
  renderIcons();
}

async function act(name, btn) {
  if (name === 'cancel') return closeDrawer();
  if (name === 'create') return submitNew(btn);
  if (state.saving || !state.open) return;
  const t = state.detail.ticket;
  const run = async (fn, okMsg) => {
    state.saving = true; btn.disabled = true; saved('Saving…');
    try { const r = await fn(); await openTicket(t.number); saved(typeof okMsg === 'function' ? okMsg(r) : okMsg); reload(); }
    catch (e) {
      saved(e.message, true);
      if (e.data?.conflict) { await openTicket(t.number).catch(() => {}); saved(e.message, true); }
    } finally { state.saving = false; btn.disabled = false; }
  };
  const path = `/api/tickets/${encodeURIComponent(t.number)}`;
  if (name === 'comment') {
    const body = $('#tkComment').value.trim();
    if (!body) { saved('Write a comment first.', true); $('#tkComment').focus(); return; }
    return run(() => api(`${path}/comments`, { method: 'POST', body: JSON.stringify({ body }) }), 'Comment added');
  }
  if (name === 'status') return run(() => api(`${path}/status`, { method: 'PATCH', body: JSON.stringify({ status: $('#tkStatus').value, version: t.version }) }), (r) => (r.changed ? 'Status saved' : 'No change'));
  if (name === 'assign' && !$('#tkAssignee').value) { saved('Choose who the ticket goes to.', true); return; }
  if (name === 'assign') return run(() => api(`${path}/assignee`, { method: 'PATCH', body: JSON.stringify({ assignee: $('#tkAssignee').value, version: t.version }) }), (r) => (r.changed ? 'Reassigned' : 'No change'));
  if (name === 'resend') return run(() => api(`${path}/notification/retry`, { method: 'POST', body: '{}' }), (r) => (r.status === 'submitted' ? 'Notice sent' : `Notice: ${NOTICE_TEXT[r.status] || r.status}${r.error ? ` — ${r.error}` : ''}`));
}

/* ------------------------------------------------------------------ wiring */

function setScope(scope) {
  state.scope = scope;
  for (const b of $$('[data-scope]')) { const on = b.dataset.scope === scope; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
  reload();
}

(async () => {
  try {
    const me = await api('/auth/me');
    state.me = me;
    initShell(me);
    state.meta = await api('/api/tickets/meta');
    const m = state.meta;
    $('#fStatus').innerHTML += m.statuses.map((s) => opt(s.key, s.label)).join('');
    $('#fPriority').innerHTML += m.priorities.map((p) => opt(p.key, p.label)).join('');
    $('#fCategory').innerHTML += m.categories.map((c) => opt(c.key, c.label)).join('');
    if (m.manager) {
      $('#scopeTabs').hidden = false;
      $('#fCreator').hidden = false;
      $('#fCreator').innerHTML += (m.creators || []).map((c) => opt(c.key, c.name)).join('');
      for (const th of $$('.tk-creator')) th.hidden = false;
      $('#pageSub').textContent = 'Every ticket raised in Briyo OS. You can change status, reassign, and resend the WhatsApp notice.';
    } else {
      $('#pageSub').textContent = 'Your tickets. Raise a bug, a technical or operational issue, or an access request — it goes straight to the founder.';
    }
    if (!m.owner?.resolved) note(m.owner?.error || 'Tickets are not set up yet.');
    $('#newTicket').addEventListener('click', () => openNew());
    for (const b of $$('[data-scope]')) b.addEventListener('click', () => setScope(b.dataset.scope));
    for (const id of ['fStatus', 'fPriority', 'fCategory', 'fCreator']) $(`#${id}`).addEventListener('change', reload);
    let tmr; $('#fQ').addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(reload, 250); });
    onLeave(() => clearTimeout(tmr));
    const openRow = (e) => { const tr = e.target.closest('tr[data-number]'); if (tr) openTicket(tr.dataset.number).catch((err) => note(err.message)); };
    $('#rows').addEventListener('click', openRow);
    $('#rows').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.key === ' ') e.preventDefault(); openRow(e); } });
    $('#dActions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act, b); });
    $('#dBody').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.act, b); });
    $('#dClose').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); }, { signal: pageSignal() });
    await load();
    const params = new URLSearchParams(window.location.search);
    if (params.get('open')) await openTicket(params.get('open')).catch((err) => note(err.message));
    else if (params.has('new')) openNew(params.get('new'));
  } catch (err) { note(err.message); }
})();
