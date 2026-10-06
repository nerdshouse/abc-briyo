/**
 * Briyo OS overview — what is happening in each department, and what needs
 * attention right now. One request (/api/overview); the server returns only
 * the departments this member may see. A department that could not be counted
 * says so; it never shows zeros it does not have.
 */
import { $, esc, count, money, icon, renderIcons, initShell, pageFetch, pageSignal, onLeave, relative } from './ui/components.js';

const fetch = pageFetch();
const state = { me: null, data: null, timer: null };

const api = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
};

const DEPTS = {
  logistics: { label: 'Logistics', icon: 'truck', href: '/orders' },
  inventory: { label: 'Inventory', icon: 'boxes', href: '/inventory' },
  support: { label: 'Support', icon: 'headset', href: '/?mode=tocall' },
  hr: { label: 'HR', icon: 'briefcase', href: '/hr/jobs' },
  people: { label: 'People', icon: 'users', href: '/admin' },
};
const SEV_LABEL = { critical: 'Critical', warning: 'Warning', attention: 'Attention' };

function greeting(tz) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
const today = (tz) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

/** A metric tile: label, number, optional note; a link when it opens a list. */
function metric(label, value, { href = '', note = '', tone = '' } = {}) {
  const body = `<span class="ov-m-label">${esc(label)}</span><span class="ov-m-value num${tone ? ` ${tone}` : ''}">${value}</span>${note ? `<span class="ov-m-note">${esc(note)}</span>` : ''}`;
  return href ? `<a class="ov-metric" href="${href}">${body}</a>` : `<div class="ov-metric">${body}</div>`;
}
const n = (v) => count(v ?? 0);
const toneIf = (v, tone) => (v > 0 ? tone : '');

function deptHealth(key) {
  const items = (state.data.attention || []).filter((a) => a.dept === key);
  if (items.some((a) => a.severity === 'critical')) return ['critical', 'Critical'];
  if (items.some((a) => a.severity === 'warning')) return ['warning', 'Needs action'];
  if (items.length) return ['attention', 'Attention'];
  return ['healthy', 'Healthy'];
}

const BODIES = {
  logistics: (s) => [
    metric('Orders today', n(s.today), { href: '/orders' }),
    metric('Pending dispatch', n(s.pending_dispatch), { href: '/orders?view=pending_dispatch' }),
    metric('In transit', n(s.in_transit), { href: '/orders?view=in_transit' }),
    metric('Delivered', n(s.delivered), { href: '/orders?view=delivered' }),
    metric('Failed / RTO', n(s.failed), { href: '/orders?view=failed', tone: toneIf(s.failed, 'bad') }),
    metric('Open, no shipment', n(s.without_shipment), { href: '/orders?view=pending_dispatch', tone: toneIf(s.without_shipment, 'warn') }),
  ].join(''),
  inventory: (s) => [
    metric('Master SKUs', n(s.master_skus), { href: '/inventory' }),
    s.stock_tracked ? metric('Low stock', n(s.low_stock), { href: '/inventory?stock=low', tone: toneIf(s.low_stock, 'warn') })
      : metric('Low stock', '—', { note: 'Starts with the first batch' }),
    s.stock_tracked ? metric('Out of stock', n(s.out_of_stock), { href: '/inventory?stock=out', tone: toneIf(s.out_of_stock, 'warn') })
      : metric('Out of stock', '—', { note: 'Starts with the first batch' }),
    metric('Unmapped SKUs', n(s.unmapped_skus), { href: '/inventory?view=unmapped', tone: toneIf(s.unmapped_skus, 'warn') }),
    metric('Expired batches', n(s.expired_batches), { href: '/inventory?expiring=expired', tone: toneIf(s.expired_batches, 'bad') }),
    metric('Expiring ≤ 30 days', n(s.expiring_30), { href: '/inventory?expiring=30' }),
    metric('Available units', n(s.available_units), { href: '/inventory' }),
    metric('Reserved units', n(s.reserved_units), { href: '/inventory' }),
  ].join(''),
  support: (s) => [
    metric('Not called', n(s.not_called), { href: '/?mode=tocall' }),
    metric(`Past ${s.sla_hours}h SLA`, n(s.uncalled_past_sla), { href: '/?mode=tocall', tone: toneIf(s.uncalled_past_sla, 'warn') }),
    metric('Unassigned', n(s.unassigned), { href: '/?mode=tocall' }),
    metric('Callbacks today', n(s.callbacks_today), { href: '/?mode=callbacks' }),
    metric('Callbacks overdue', n(s.callbacks_overdue), { href: '/?mode=callbacks', tone: toneIf(s.callbacks_overdue, 'bad') }),
    metric('Assigned to you', n(s.assigned_to_me), { href: '/?mode=mine' }),
  ].join('') + `<p class="ov-foot">Today: ${n(s.today.carts)} ${s.today.carts === 1 ? 'cart' : 'carts'} in · ${n(s.today.called)} called · ${n(s.today.recovered)} recovered${s.today.recovered_value ? ` (${money(s.today.recovered_value)})` : ''}</p>`,
  hr: (s) => [
    metric('Open jobs', n(s.open_jobs), { href: '/hr/jobs?status=published' }),
    metric('Drafts', n(s.draft_jobs), { href: '/hr/jobs?status=draft' }),
    metric('Awaiting review', n(s.awaiting_review), { href: '/hr/candidates?status=applied', tone: toneIf(s.awaiting_review, 'info') }),
    metric('In progress', n(s.in_progress), { href: '/hr/candidates', note: 'Screening · interview · offer' }),
    metric('Hired, 30 days', n(s.hired_30d), { href: '/hr/candidates?status=hired' }),
    metric('New this week', n(s.new_7d), { href: '/hr/candidates' }),
  ].join(''),
  people: (s) => {
    const cat = state.me?.moduleCatalog || {};
    const depts = Object.entries(s.by_department || {}).map(([k, v]) => `<span class="badge">${esc(cat[k]?.label || k)} <b class="num">${n(v)}</b></span>`).join('');
    return [
      metric('Active members', n(s.active), { href: '/admin', note: s.total !== s.active ? `${n(s.total - s.active)} deactivated` : '' }),
      metric('Admins', n(s.admins), { href: '/admin' }),
      metric('Online now', n(s.online), { href: '/admin' }),
      metric('Incomplete profiles', n(s.incomplete_profiles), { href: '/admin?filter=incomplete', tone: toneIf(s.incomplete_profiles, 'warn') }),
      metric('No department', n(s.no_access), { href: '/admin?filter=no_access', tone: toneIf(s.no_access, 'info') }),
    ].join('') + (depts ? `<div class="ov-chips" aria-label="Members by department">${depts}</div>` : '');
  },
};

function render() {
  const d = state.data;
  const tz = d.timezone || 'Asia/Kolkata';
  const first = String(state.me?.name || '').split(/\s+/)[0];
  $('#ovDate').textContent = today(tz);
  $('#ovHello').textContent = `${greeting(tz)}${first && first !== 'Team' ? `, ${first}` : ''}`;
  const keys = Object.keys(d.sections);
  $('#ovSub').textContent = state.me?.isAdmin ? 'The state of Briyo, department by department.'
    : `Your ${keys.length === 1 ? 'department' : 'departments'} at a glance.`;
  $('#ovUpdated').textContent = `Updated ${relative(d.generated_at)}`;

  // Needs attention
  const items = d.attention || [];
  $('#ovAttnMeta').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';
  $('#ovAttention').innerHTML = items.length ? `<ul class="ov-attn">${items.map((a) => `
    <li><a href="${a.href}">
      <span class="health ${a.severity}">${SEV_LABEL[a.severity]}</span>
      <span class="ov-attn-text">${a.count !== null ? `<b class="num">${n(a.count)}</b> ` : ''}${esc(a.text)}</span>
      <span class="badge">${esc(DEPTS[a.dept]?.label || a.dept)}</span>
      ${icon('chevron-right', 'ov-chev')}
    </a></li>`).join('')}</ul>`
    : `<div class="state"><span class="health healthy">Healthy</span><b>Nothing needs attention right now.</b><span>Every department you can see is up to date.</span></div>`;

  // Departments
  $('#ovDepts').innerHTML = keys.filter((k) => DEPTS[k]).map((k) => {
    const s = d.sections[k];
    const dept = DEPTS[k];
    if (!s.ok) {
      return `<section class="card ov-dept"><header class="ov-dept-head"><h2>${icon(dept.icon)}${esc(dept.label)}</h2></header>
        <div class="state error"><b>Unavailable right now</b><span>This department could not be counted. Refresh to try again.</span></div></section>`;
    }
    const [tone, word] = deptHealth(k);
    return `<section class="card ov-dept" aria-labelledby="ov-${k}">
      <header class="ov-dept-head">
        <h2 id="ov-${k}"><a href="${dept.href}">${icon(dept.icon)}${esc(dept.label)}</a></h2>
        <span class="health ${tone}">${word}</span>
        <a class="ov-open" href="${dept.href}" aria-label="Open ${esc(dept.label)}">Open ${icon('arrow-right')}</a>
      </header>
      <div class="ov-metrics">${BODIES[k](s)}</div>
    </section>`;
  }).join('');
  renderIcons();
}

async function load() {
  $('#ovRefresh').disabled = true;
  try {
    state.data = await api('/api/overview');
    render();
  } catch (err) {
    $('#ovAttention').innerHTML = `<div class="state error"><b>The overview could not be loaded.</b><span>${esc(err.message)}</span><button class="btn" type="button" data-retry>Try again</button></div>`;
    $('#ovSub').textContent = '';
    renderIcons();
  } finally { $('#ovRefresh').disabled = false; }
}

(async function init() {
  try {
    state.me = await api('/auth/me');
    initShell(state.me);
    $('#ovRefresh').addEventListener('click', load);
    $('#ovAttention').addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) load(); });
    await load();
    // Refresh quietly every two minutes while the page is open and visible.
    state.timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120000);
    onLeave(() => clearInterval(state.timer));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.data && Date.now() - new Date(state.data.generated_at) > 120000) load(); }, { signal: pageSignal() });
  } catch (err) {
    $('#ovSub').textContent = '';
    $('#ovAttention').innerHTML = `<div class="state error"><b>Briyo OS could not load.</b><span>${esc(err.message)}</span></div>`;
  }
}());
