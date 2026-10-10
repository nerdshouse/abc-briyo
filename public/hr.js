/**
 * HR — jobs and candidates, one page with two views (/hr/jobs, /hr/candidates).
 * Jobs: list, the job editor (draft → publish → close → archive → restore),
 * the public link and a draft preview. Candidates: list, search and filters,
 * and the application drawer (status with history, notes, resume download).
 * Every number and permission comes from /api/hr; the server checks again.
 */
import {
  $, $$, esc, count, icon, renderIcons, relative, initShell, pageFetch,
  pageSignal, onQueryChange, stateBlock,
} from './ui/components.js';
// Every HR time is shown in IST (Asia/Kolkata), whatever the board's timezone or the viewer's computer.
import { istDateTime } from './ui/ist.js';

const fetch = pageFetch();

const JOB_FILTERS = ['q', 'status'];
const APP_FILTERS = ['q', 'job', 'status', 'from', 'to'];
const state = {
  view: 'jobs', me: null, meta: null, jobs: [], apps: [], f: {},
  openJob: null, job: null, jobTab: 'edit', openApp: null, app: null, dirty: false,
};

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
const canManage = () => Boolean(state.meta?.canManage);
const opt = (value, text, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(text)}</option>`;

// ------------------------------------------------------------------ labels

const EMPLOYMENT = { full_time: 'Full-time', part_time: 'Part-time', internship: 'Internship', contract: 'Contract', freelance: 'Freelance' };
const MODE = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' };
const PERIOD = { year: 'per year', month: 'per month', hour: 'per hour' };
const SECTION = {
  about: 'About the role', responsibilities: 'Responsibilities', requirements: 'Requirements', nice_to_have: 'Nice to have',
  benefits: 'Benefits', hiring_process: 'Hiring process', additional: 'Additional information',
};
const JOB_STATUS = { draft: ['new', 'Draft'], published: ['recovered', 'Published'], closed: ['noresp', 'Closed'], archived: ['none', 'Archived'] };
const APP_STATUS = {
  applied: ['new', 'Applied'], screening: ['callback', 'Screening'], interview: ['callback', 'Interview'], offer: ['noresp', 'Offer'],
  hired: ['recovered', 'Hired'], rejected: ['lost', 'Rejected'], withdrawn: ['none', 'Withdrawn'],
};
const tag = (map, s) => `<span class="status ${map[s]?.[0] || ''}"><span class="dot"></span>${esc(map[s]?.[1] || s)}</span>`;
const EVENT = {
  application_started: 'Started the application', resume_uploaded: 'Uploaded a resume', application_submitted: 'Application submitted',
  status_changed: 'Status changed', note_added: 'Note added', resume_removed: 'Resume removed', resume_removal_started: 'Resume removal started', resume_removal_failed: 'Resume removal did not finish', candidate_profile_updated: 'Candidate updated their details',
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const salaryText = (j) => {
  if (j.salary_min === null || j.salary_max === null) return null;
  const f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: j.salary_currency || 'INR', maximumFractionDigits: 0 });
  return `${f.format(j.salary_min)} – ${f.format(j.salary_max)}${j.salary_period ? ` ${PERIOD[j.salary_period]}` : ''}`;
};
const expText = (j) => {
  if (j.experience_min === null && j.experience_max === null) return null;
  if (j.experience_max === null) return `${j.experience_min}+ years`;
  if (j.experience_min === null) return `Up to ${j.experience_max} years`;
  return `${j.experience_min}–${j.experience_max} years`;
};
const jobFacts = (j) => [j.department, j.location, MODE[j.work_mode], EMPLOYMENT[j.employment_type]].filter(Boolean);

/** Plain text with "- " bullets, never HTML: lines starting "- " become a list. */
function richText(src) {
  const out = []; let list = []; let para = [];
  const flushList = () => { if (list.length) out.push(`<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`); list = []; };
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(esc).join('<br>')}</p>`); para = []; };
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^-\s+/.test(line)) { flushPara(); list.push(line.replace(/^-\s+/, '')); } else if (!line) { flushPara(); flushList(); } else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join('');
}

// ------------------------------------------------------------------ URL

const filtersOf = () => (state.view === 'jobs' ? JOB_FILTERS : APP_FILTERS);
function readUrl() {
  state.view = window.location.pathname === '/hr/candidates' ? 'candidates' : 'jobs';
  const u = new URLSearchParams(window.location.search);
  state.f = Object.fromEntries(filtersOf().map((k) => [k, u.get(k) || '']));
  state.openJob = state.view === 'jobs' && /^(\d+|new)$/.test(u.get('job') || '') ? u.get('job') : null;
  state.openApp = state.view === 'candidates' && /^\d+$/.test(u.get('app') || '') ? Number(u.get('app')) : null;
}
function writeUrl() {
  const u = new URLSearchParams();
  for (const k of filtersOf()) if (state.f[k]) u.set(k, state.f[k]);
  if (state.openJob) u.set('job', state.openJob);
  if (state.openApp) u.set('app', state.openApp);
  const next = `${window.location.pathname}${u.toString() ? `?${u}` : ''}`;
  if (next !== `${window.location.pathname}${window.location.search}`) history.replaceState(history.state, '', next);
}
const anyFilter = () => filtersOf().some((k) => state.f[k]);

// ------------------------------------------------------------------ page frame

function frame() {
  const jobs = state.view === 'jobs';
  $('#crumbHere').textContent = jobs ? 'Jobs' : 'Candidates';
  $('#pageTitle').textContent = jobs ? 'Jobs' : 'Candidates';
  $('#topTitle').textContent = jobs ? 'Jobs' : 'Candidates';
  document.title = `${jobs ? 'Jobs' : 'Candidates'} — HR — Briyo OS`;
  $('#newJob').hidden = !(jobs && canManage());
  $('#footnote').textContent = jobs
    ? 'A job is private until it is published. Its public link is fixed at first publish; editing the title never changes it.'
    : 'Only complete applications (with a resume) are listed. Resumes are private and download only through this app.';
  const f = state.f;
  $('#filters').innerHTML = jobs ? `
    <label class="search">${icon('search')}<input class="input" id="fq" type="search" autocomplete="off" placeholder="Title, department or location" aria-label="Search jobs" value="${esc(f.q)}" /></label>
    <select class="select" id="fstatus" aria-label="Status">${opt('', 'Active jobs', !f.status)}${state.meta.jobStatuses.map((s) => opt(s, JOB_STATUS[s][1], f.status === s)).join('')}</select>
    <button type="button" class="linkish" id="fclear" hidden>Clear</button>` : `
    <label class="search">${icon('search')}<input class="input" id="fq" type="search" autocomplete="off" placeholder="Name, email or phone" aria-label="Search candidates" value="${esc(f.q)}" /></label>
    <select class="select" id="fjob" aria-label="Job">${opt('', 'All jobs', !f.job)}${state.jobs.map((j) => opt(j.id, j.title, String(j.id) === f.job)).join('')}</select>
    <select class="select" id="fstatus" aria-label="Status">${opt('', 'All statuses', !f.status)}${state.meta.applicationStatuses.map((s) => opt(s, APP_STATUS[s][1], f.status === s)).join('')}</select>
    <span class="date-pick">From <input class="input" id="ffrom" type="date" value="${esc(f.from)}" aria-label="Applied from" /></span>
    <span class="date-pick">to <input class="input" id="fto" type="date" value="${esc(f.to)}" aria-label="Applied to" /></span>
    <button type="button" class="linkish" id="fclear" hidden>Clear</button>`;
  $('#thead').innerHTML = jobs
    ? '<tr><th>Job</th><th>Status</th><th class="r">Candidates</th><th>Where</th><th>Updated</th></tr>'
    : '<tr><th>Candidate</th><th>Job</th><th>Status</th><th>Applied</th><th>Resume</th></tr>';
  renderIcons();
}

function skeleton() {
  $('#rows').innerHTML = `<tr><td colspan="5">${stateBlock('loading', 'Loading…', '', { compact: true })}</td></tr>`;
  $('#clist').innerHTML = `<li class="oitem">${stateBlock('loading', 'Loading…', '', { compact: true })}</li>`;
}
function failed(err) {
  $('#pageSub').textContent = '';
  $('#alerts').innerHTML = `<div class="alert">${icon('circle-alert')}<span>${esc(err.message)}</span><button class="alert-link" type="button" id="retry">Try again</button></div>`;
  $('#rows').innerHTML = ''; $('#clist').innerHTML = '';
  renderIcons();
}

// ------------------------------------------------------------------ jobs list

// On the candidates view the job list feeds the Job filter: every job, unfiltered.
async function loadJobs() {
  const u = new URLSearchParams();
  if (state.view === 'jobs' && state.f.q) u.set('q', state.f.q);
  if (state.view === 'jobs' && state.f.status) u.set('status', state.f.status);
  state.jobs = (await api(`/api/hr/jobs?${u}`)).jobs;
}

function renderJobs() {
  // Archived jobs only when asked for: they are history, not work.
  const rows = state.f.status ? state.jobs : state.jobs.filter((j) => j.status !== 'archived');
  const archived = state.jobs.length - rows.length;
  const open = rows.filter((j) => j.status === 'published').length;
  $('#pageSub').textContent = `${count(open)} open ${open === 1 ? 'job' : 'jobs'} · ${count(rows.reduce((n, j) => n + j.candidate_count, 0))} candidates`;
  $('#resultNote').textContent = `${count(rows.length)} ${rows.length === 1 ? 'job' : 'jobs'}${anyFilter() ? ' matching the filters' : ''}${archived ? ` · ${count(archived)} archived hidden` : ''}`;
  $('#fclear').hidden = !anyFilter();
  if (!rows.length) {
    const empty = anyFilter() || archived ? `<b>Nothing ${anyFilter() ? 'matches' : 'open'}.</b>${archived ? 'Archived jobs are under Status → Archived.' : 'Try clearing a filter.'}`
      : `<b>No jobs yet.</b>${canManage() ? 'Create one with New job. It stays private until you publish it.' : 'An HR manager creates jobs.'}`;
    $('#rows').innerHTML = `<tr><td colspan="5"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return renderIcons();
  }
  const cands = (j) => `${count(j.candidate_count)}${j.incomplete_count ? `<span class="cell-sub muted">${count(j.incomplete_count)} incomplete</span>` : ''}`;
  $('#rows').innerHTML = rows.map((j) => `
    <tr class="orow${String(j.id) === state.openJob ? ' open' : ''}" data-job="${j.id}" tabindex="0">
      <td><span class="cell-main" style="font-weight:500">${esc(j.title)}</span>${j.department ? `<span class="cell-sub muted">${esc(j.department)}</span>` : ''}</td>
      <td>${tag(JOB_STATUS, j.status)}</td>
      <td class="r num"><a class="linkish" href="/hr/candidates?job=${j.id}" data-stop>${cands(j)}</a></td>
      <td>${esc([j.location, MODE[j.work_mode]].filter(Boolean).join(' · ') || '—')}</td>
      <td><span title="${esc(istDateTime(j.updated_at))}">${esc(relative(j.updated_at))}</span>${j.updated_by ? `<span class="cell-sub muted">${esc(j.updated_by)}</span>` : ''}</td>
    </tr>`).join('');
  $('#clist').innerHTML = rows.map((j) => `
    <li class="oitem" data-job="${j.id}" tabindex="0">
      <div class="oi-top"><span class="oi-id">${esc(j.title)}</span><span class="oi-val">${tag(JOB_STATUS, j.status)}</span></div>
      <div class="oi-sub">${esc(jobFacts(j).join(' · ') || 'Details to add')}</div>
      <div class="oi-sub">${count(j.candidate_count)} candidate${j.candidate_count === 1 ? '' : 's'}${j.incomplete_count ? ` · ${count(j.incomplete_count)} incomplete` : ''} · updated ${esc(relative(j.updated_at))}</div>
    </li>`).join('');
  return renderIcons();
}

// ------------------------------------------------------------------ candidates list

async function loadApps() {
  const u = new URLSearchParams();
  for (const k of APP_FILTERS) if (state.f[k]) u.set(k, state.f[k]);
  const [apps, jobs] = await Promise.all([api(`/api/hr/applications?${u}`), state.jobs.length ? null : api('/api/hr/jobs')]);
  state.apps = apps.applications;
  if (jobs) state.jobs = jobs.jobs;
}

function renderApps() {
  const rows = state.apps;
  const job = state.jobs.find((j) => String(j.id) === state.f.job);
  $('#pageSub').textContent = job ? `For ${job.title}` : 'Every complete application, newest first';
  $('#resultNote').textContent = `${count(rows.length)} ${rows.length === 1 ? 'application' : 'applications'}${anyFilter() ? ' matching the filters' : ''}${rows.length >= 500 ? ' · showing the newest 500' : ''}`;
  $('#fclear').hidden = !anyFilter();
  if (!rows.length) {
    const empty = anyFilter() ? '<b>Nothing matches.</b>Try clearing a filter.' : '<b>No applications yet.</b>They appear here once a candidate has sent their resume.';
    $('#rows').innerHTML = `<tr><td colspan="5"><div class="empty-note">${empty}</div></td></tr>`;
    $('#clist').innerHTML = `<li class="oitem"><div class="empty-note">${empty}</div></li>`;
    return renderIcons();
  }
  $('#rows').innerHTML = rows.map((a) => `
    <tr class="orow${a.id === state.openApp ? ' open' : ''}" data-app="${a.id}" tabindex="0">
      <td><span class="cell-main" title="${esc(a.full_name)}">${esc(a.full_name)}</span><span class="cell-sub" title="${esc(a.email)}">${esc(a.email)}</span></td>
      <td><span class="cell-main hr-job" title="${esc(a.job_title)}">${esc(a.job_title)}</span>${a.location ? `<span class="cell-sub">${icon('map-pin', 'inline-ico')}${esc(a.location)}</span>` : ''}</td>
      <td>${tag(APP_STATUS, a.status)}</td>
      <td><span title="${esc(istDateTime(a.applied_at))}">${esc(relative(a.applied_at))}</span></td>
      <td>${a.has_resume ? `<span class="hr-pill ok">${icon('file-text')}On file</span>` : `<span class="hr-pill${a.resume_state === 'removing' ? ' warn' : ''}">${a.resume_state === 'removing' ? 'Removal pending' : 'Removed'}</span>`}</td>
    </tr>`).join('');
  $('#clist').innerHTML = rows.map((a) => `
    <li class="oitem" data-app="${a.id}" tabindex="0">
      <div class="oi-top"><span class="oi-id">${esc(a.full_name)}</span><span class="oi-val">${tag(APP_STATUS, a.status)}</span></div>
      <div class="oi-sub">${esc(a.job_title)}${a.location ? ` · ${esc(a.location)}` : ''}</div>
      <div class="oi-sub hr-wrap">${esc(a.email)} · applied ${esc(relative(a.applied_at))}</div>
    </li>`).join('');
  return renderIcons();
}

async function load() {
  $('#alerts').innerHTML = '';
  if (!(state.view === 'jobs' ? state.jobs : state.apps).length) skeleton();
  try {
    if (state.view === 'jobs') { await loadJobs(); renderJobs(); } else {
      await loadApps();
      const sel = $('#fjob');
      if (sel && sel.options.length - 1 !== state.jobs.length) frame();
      renderApps();
    }
  } catch (err) { failed(err); }
}

// ------------------------------------------------------------------ drawer plumbing

let lockedAt = null;
function syncScrollLock() {
  const open = !$('#drawer').hidden;
  const root = document.documentElement;
  if (open && lockedAt === null) {
    lockedAt = window.scrollY;
    const bar = window.innerWidth - root.clientWidth;
    root.classList.add('scroll-locked');
    if (bar > 0) root.style.paddingRight = `${bar}px`;
  } else if (!open && lockedAt !== null) {
    const y = lockedAt; lockedAt = null;
    root.classList.remove('scroll-locked'); root.style.paddingRight = '';
    window.scrollTo(0, y);
  }
}
function showDrawer(title, sub = '') {
  $('#drawer').hidden = false; $('#drawerScrim').hidden = false; syncScrollLock();
  $('#dTitle').textContent = title; $('#dSub').textContent = sub; $('#dSaved').textContent = ''; $('#dSaved').className = 'saved';
}
function closeDrawer({ force = false } = {}) {
  if (!force && state.dirty && !window.confirm('Discard your unsaved changes to this job?')) return;
  $('#drawer').hidden = true; $('#drawerScrim').hidden = true; syncScrollLock();
  state.openJob = null; state.openApp = null; state.job = null; state.app = null; state.dirty = false;
  writeUrl();
  $$('.orow.open').forEach((r) => r.classList.remove('open'));
}
const saved = (msg, cls = 'saved') => { $('#dSaved').className = cls; $('#dSaved').textContent = msg; };
const conflictNote = (err) => (err.status === 409 && err.data?.conflict
  ? `${err.message} <button type="button" class="linkish" data-reload>Reload</button>` : esc(err.message));

// ------------------------------------------------------------------ job drawer

async function openJob(id) {
  state.openJob = String(id); state.openApp = null; state.dirty = false; writeUrl();
  $$('.orow').forEach((r) => r.classList.toggle('open', r.dataset.job === String(id)));
  if (id === 'new') {
    state.job = null; state.jobTab = 'edit';
    showDrawer('New job', 'Saved as a private draft');
    return renderJob();
  }
  showDrawer('Loading…');
  $('#dBody').innerHTML = stateBlock('loading', 'Loading…', '', { compact: true }); $('#dButtons').innerHTML = '';
  try {
    state.job = (await api(`/api/hr/jobs/${id}`)).job;
    if (state.openJob !== String(id)) return null;
    return renderJob();
  } catch (err) {
    $('#dTitle').textContent = 'Job';
    $('#dBody').innerHTML = stateBlock('error', 'Could not open this job.', err.message, { compact: true });
    return null;
  }
}

const ACTIONS = {
  draft: [['publish', 'Publish', 'primary']], published: [['close', 'Close applications', ''], ['archive', 'Archive', '']],
  closed: [['publish', 'Reopen', 'primary'], ['archive', 'Archive', '']], archived: [['restore', 'Restore as draft', '']],
};
const CONFIRM = {
  publish: 'Publish this job? It becomes visible on the careers site and starts taking applications.',
  close: 'Close applications? The page stays reachable by its link, marked closed, and no new applications are accepted.',
  archive: 'Archive this job? Its public page disappears. Candidates and history are kept.',
  restore: 'Restore this job as a private draft?',
};

/** When things happened to this job, in IST. */
function jobHistoryBlock(j) {
  if (!j) return '';
  const row = (label, at, by) => (at ? `<div class="hr-kv"><span>${esc(label)}</span><span>${esc(istDateTime(at))}${by ? ` <span class="soft">· ${esc(by)}</span>` : ''}</span></div>` : '');
  return `<section class="dsec"><h3 class="dsec-title">History</h3>
    ${row('Created', j.created_at, j.created_by)}${row('Last updated', j.updated_at, j.updated_by)}${row('Published', j.published_at)}${row('Closed', j.closed_at)}${row('Archived', j.archived_at)}</section>`;
}

/**
 * Permanent deletion, for jobs nobody has applied to. The server checks the
 * permission, the applications rule and the typed title again.
 */
function deleteBlock(j) {
  if (!j || !canManage()) return '';
  const cc = state.jobs.find((x) => x.id === j.id);
  const hasApps = cc ? (cc.candidate_count + cc.incomplete_count) > 0 : false;
  return `<section class="dsec hr-danger"><h3 class="dsec-title">Delete job</h3>
    ${hasApps ? '<p class="soft">This job cannot be permanently deleted because it has applications. Close or archive the job instead.</p>'
      : `<p class="soft">Removes the job and its public link for good. Only possible while nobody has applied.</p>
    <button class="btn" type="button" id="jobDelete">${icon('trash-2')}Delete job…</button>
    <div class="hr-confirm" id="jobDeleteConfirm" hidden>
      <p><b>Delete this job permanently?</b> This cannot be undone. Type the job title to confirm:</p>
      <p class="mono">${esc(j.title)}</p>
      <input class="input" id="jobDeleteTitle" autocomplete="off" aria-label="Type the job title to confirm deletion" />
      <div class="form-actions"><button class="btn" type="button" id="jobDeleteCancel">Cancel</button>
        <button class="btn danger" type="button" id="jobDeleteYes" disabled>Delete permanently</button></div>
      <div id="jobDeleteErr"></div></div>`}</section>`;
}

async function deleteJob() {
  const j = state.job;
  $('#jobDeleteYes').disabled = true;
  saved('Deleting…', 'saved pending');
  try {
    const out = await api(`/api/hr/jobs/${j.id}`, { method: 'DELETE', body: JSON.stringify({ version: j.version, confirm_title: $('#jobDeleteTitle').value }) });
    state.dirty = false;
    closeDrawer({ force: true });
    $('#alerts').innerHTML = `<div class="alert ok hr-ok">${icon('check')}<span>Deleted “${esc(out.deleted.title)}” on ${esc(istDateTime(out.deleted.at))}.</span></div>`;
    renderIcons();
    await loadJobs(); renderJobs();
  } catch (err) {
    saved('Not deleted', 'saved failed');
    $('#jobDeleteErr').innerHTML = `<div class="form-error">${conflictNote(err)}</div>`;
    $('#jobDeleteYes').disabled = $('#jobDeleteTitle').value.trim() !== j.title.trim();
  }
}

function publicLinkBlock(j) {
  if (!j) return '';
  if (!j.public_url) {
    return `<section class="dsec"><h3 class="dsec-title">Public link</h3><p class="soft hr-note">Not public yet. The link is created the first time the job is published, from its title.</p></section>`;
  }
  const live = j.status === 'published' || j.status === 'closed';
  const note = { published: 'Live and taking applications.', closed: 'Reachable, marked closed, hidden from search engines. No applications.',
    archived: 'Not reachable while archived. Restoring and publishing again brings the same link back.', draft: 'Not reachable while a draft. Publishing brings this same link back.' }[j.status];
  return `<section class="dsec"><h3 class="dsec-title">Public link</h3>
    <div class="hr-link"><input class="input mono" id="pubUrl" readonly value="${esc(j.public_url)}" aria-label="Public link" />
      <button class="btn" type="button" data-copy>${icon('copy')}Copy</button>
      ${live ? `<a class="btn" href="${esc(j.public_url)}" target="_blank" rel="noopener noreferrer">${icon('external-link')}Open</a>` : ''}</div>
    <p class="soft hr-note">${esc(note)} Public ID <span class="mono">${esc(j.public_id)}</span>.</p></section>`;
}

function jobForm(j) {
  const v = (k) => esc(j?.[k] ?? '');
  const ro = canManage() ? '' : ' disabled';
  const sel = (id, label, map, cur, req) => `<label class="fld"><span>${label}${req ? ' <em>*</em>' : ''}</span><select class="select" name="${id}"${ro}>${opt('', '—', !cur)}${Object.entries(map).map(([k, t]) => opt(k, t, cur === k)).join('')}</select></label>`;
  const inp = (name, label, { type = 'text', req = false, wide = false, help = '', ph = '' } = {}) => `<label class="fld${wide ? ' wide' : ''}"><span>${label}${req ? ' <em>*</em>' : ''}</span>
    <input class="input" name="${name}" type="${type}" value="${v(name)}" placeholder="${esc(ph)}"${type === 'number' ? ' min="0" step="any" inputmode="decimal"' : ''}${ro} />${help ? `<span class="help">${help}</span>` : ''}</label>`;
  const req = '<span class="help">Needed to publish.</span>';
  return `<form id="jobForm" novalidate>
    <section class="dsec"><h3 class="dsec-title">Basics</h3><div class="form-grid">
      ${inp('title', 'Job title', { req: true, wide: true, ph: 'Performance Marketing Manager' })}
      ${inp('department', 'Department', { ph: 'Marketing' })}
      ${inp('location', 'Location', { ph: 'Mumbai', help: 'Needed to publish unless the job is remote.' })}
      ${sel('employment_type', 'Employment type', EMPLOYMENT, j?.employment_type, true)}
      ${sel('work_mode', 'Work mode', MODE, j?.work_mode, true)}
      ${inp('openings', 'Openings', { type: 'number' })}
      <span></span>
      ${inp('experience_min', 'Experience from (years)', { type: 'number' })}
      ${inp('experience_max', 'Experience to (years)', { type: 'number' })}
    </div></section>
    <section class="dsec"><h3 class="dsec-title">Salary</h3><div class="form-grid">
      ${inp('salary_min', 'Minimum', { type: 'number' })}
      ${inp('salary_max', 'Maximum', { type: 'number' })}
      <label class="fld"><span>Currency</span><input class="input" name="salary_currency" maxlength="3" value="${esc(j?.salary_currency || 'INR')}"${ro} /></label>
      ${sel('salary_period', 'Period', { year: 'Per year', month: 'Per month', hour: 'Per hour' }, j?.salary_period)}
      <p class="help wide">Shown publicly only when both minimum and maximum are set. A single value stays internal.</p>
    </div></section>
    <section class="dsec"><h3 class="dsec-title">Description</h3><div class="form-grid">
      <label class="fld wide"><span>Summary <em>*</em></span><textarea class="input" name="summary" rows="3" maxlength="600"${ro}>${v('summary')}</textarea>${req}</label>
      ${state.meta.sections.map((k) => `<label class="fld wide"><span>${esc(SECTION[k] || k)}</span>
        <textarea class="input" name="sec_${k}" rows="${k === 'about' ? 4 : 3}"${ro}>${esc(j?.sections?.[k] || '')}</textarea></label>`).join('')}
      <p class="help wide">Plain text. Start a line with "- " for a bullet. No other formatting is applied.</p>
    </div></section>
    ${j?.slug && canManage() ? `<details class="more"><summary>${icon('chevron-right')}Change the public link <span class="soft">— old links keep redirecting</span></summary>
      <div class="dsec"><div class="form-grid"><label class="fld wide"><span>Link name</span><input class="input mono" name="slug" value="${esc(j.slug)}" /><span class="help">Lowercase words and hyphens. Leave as is unless the role really changed.</span></label></div></div></details>` : ''}
  </form>`;
}

function jobPreview(j) {
  const f = j || {};
  const salary = salaryText(f);
  const exp = expText(f);
  const secs = state.meta.sections.filter((k) => f.sections?.[k]);
  return `<div class="hr-preview">
    <p class="hr-preview-note">${icon('eye')} Preview — how candidates will see this job. ${f.status === 'published' ? '' : 'Only HR can see this; it is not public.'}</p>
    <h2>${esc(f.title || 'Untitled job')}</h2>
    <p class="hr-facts">${jobFacts(f).map(esc).join(' · ') || '<span class="soft">Location, work mode and type not set</span>'}</p>
    ${exp || salary ? `<p class="hr-facts">${[exp ? `Experience: ${esc(exp)}` : '', salary ? esc(salary) : ''].filter(Boolean).join(' · ')}</p>` : ''}
    ${f.summary ? `<p class="hr-summary">${esc(f.summary)}</p>` : ''}
    ${secs.map((k) => `<h3>${esc(SECTION[k])}</h3>${richText(f.sections[k])}`).join('')}
    ${!f.summary && !secs.length ? '<p class="soft">No description yet.</p>' : ''}
  </div>`;
}

function readJobForm() {
  const fd = new FormData($('#jobForm'));
  const g = (k) => String(fd.get(k) ?? '').trim();
  const out = {
    title: g('title'), department: g('department') || null, location: g('location') || null,
    employment_type: g('employment_type') || null, work_mode: g('work_mode') || null,
    openings: num(g('openings')), experience_min: num(g('experience_min')), experience_max: num(g('experience_max')),
    salary_min: num(g('salary_min')), salary_max: num(g('salary_max')), salary_currency: g('salary_currency') || 'INR',
    salary_period: g('salary_period') || null, summary: g('summary') || null,
    sections: Object.fromEntries(state.meta.sections.map((k) => [k, String(fd.get(`sec_${k}`) ?? '').trim()]).filter(([, t]) => t)),
  };
  if (fd.has('slug') && g('slug') && g('slug') !== state.job?.slug) out.slug = g('slug');
  return out;
}

function renderJob() {
  const j = state.job;
  const isNew = !j;
  // Candidate counts live on the list row; the single-job answer does not carry them.
  const cc = j ? (state.jobs.find((x) => x.id === j.id)?.candidate_count ?? 0) : 0;
  if (j) { $('#dTitle').textContent = j.title; $('#dSub').innerHTML = `${tag(JOB_STATUS, j.status)} · ${count(cc)} candidate${cc === 1 ? '' : 's'} · updated ${esc(relative(j.updated_at))}`; }
  const tabs = `<div class="hr-tabs seg seg-quiet" role="tablist">
    <button type="button" data-tab="edit" class="${state.jobTab === 'edit' ? 'active' : ''}">${canManage() ? 'Edit' : 'Details'}</button>
    <button type="button" data-tab="preview" class="${state.jobTab === 'preview' ? 'active' : ''}">Preview</button></div>`;
  const actions = j && canManage() ? `<div class="d-actions">${(ACTIONS[j.status] || []).map(([a, label, cls]) => `<button class="btn ${cls}" type="button" data-action="${a}">${esc(label)}</button>`).join('')}
    ${cc ? `<a class="btn" href="/hr/candidates?job=${j.id}">${icon('users')}Candidates</a>` : ''}</div>` : '';
  // Unsaved edits survive a rebuild (e.g. publishing from the Preview tab): read them first, put them back after.
  const pending = state.dirty && $('#jobForm') ? readJobForm() : null;
  $('#dBody').innerHTML = `${actions}<div class="dsec hr-tabbar">${tabs}</div><div id="jobErr"></div>${publicLinkBlock(j)}${jobForm(pending ? { ...j, ...pending } : j)}<div id="previewPane" hidden></div>${jobHistoryBlock(j)}${deleteBlock(j)}`;
  showTab();
  $('#dButtons').innerHTML = canManage() ? `<button class="btn" type="button" data-close>${isNew ? 'Cancel' : 'Close'}</button>
    <button class="btn primary" type="button" id="jobSave">${isNew ? 'Create draft' : 'Save changes'}</button>` : '<button class="btn" type="button" data-close>Close</button>';
  renderIcons();
}

/** Edit ⇄ Preview without rebuilding the form, so nothing typed is lost. */
function showTab() {
  $$('.hr-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.jobTab));
  $('#jobForm').hidden = state.jobTab !== 'edit';
  $('#previewPane').hidden = state.jobTab !== 'preview';
  if (state.jobTab === 'preview') $('#previewPane').innerHTML = jobPreview({ ...state.job, ...readJobForm() });
  renderIcons();
}

async function saveJob() {
  const body = readJobForm();
  $('#jobErr').innerHTML = '';
  if (!body.title) { $('#jobErr').innerHTML = '<div class="form-error">A job title is required.</div>'; return false; }
  saved('Saving…', 'saved pending');
  $('#jobSave').disabled = true;
  try {
    if (!state.job) {
      state.job = (await send('/api/hr/jobs', 'POST', body)).job;
      state.openJob = String(state.job.id); writeUrl();
    } else {
      state.job = { ...state.job, ...(await send(`/api/hr/jobs/${state.job.id}`, 'PATCH', { ...body, version: state.job.version })).job };
    }
    state.dirty = false;
    renderJob(); saved('Saved');
    loadJobs().then(renderJobs).catch(() => {});
    return true;
  } catch (err) {
    saved('Not saved', 'saved failed');
    $('#jobErr').innerHTML = `<div class="form-error">${conflictNote(err)}</div>`;
    return false;
  } finally { if ($('#jobSave')) $('#jobSave').disabled = false; }
}

async function jobAction(action) {
  if (state.dirty) {
    if (!window.confirm('Save your changes first, then continue?')) return;
    if (!(await saveJob())) return;
  }
  if (!window.confirm(CONFIRM[action])) return;
  saved('Working…', 'saved pending');
  try {
    const out = await send(`/api/hr/jobs/${state.job.id}/${action}`, 'POST', { version: state.job.version });
    state.job = { ...state.job, ...out.job };
    renderJob();
    saved({ publish: 'Published', close: 'Applications closed', archive: 'Archived', restore: 'Restored as draft' }[action]);
    loadJobs().then(renderJobs).catch(() => {});
  } catch (err) {
    saved('Not changed', 'saved failed');
    $('#jobErr').innerHTML = `<div class="form-error">${conflictNote(err)}</div>`;
    $('#jobErr').scrollIntoView({ block: 'nearest' });
  }
}

// ------------------------------------------------------------------ application drawer

async function openApp(id) {
  state.openApp = id; state.openJob = null; writeUrl();
  $$('.orow').forEach((r) => r.classList.toggle('open', Number(r.dataset.app) === id));
  showDrawer(state.app?.application.id === id ? state.app.application.full_name : 'Loading…');
  if (state.app?.application.id !== id) { $('#dBody').innerHTML = stateBlock('loading', 'Loading…', '', { compact: true }); }
  $('#dButtons').innerHTML = '<button class="btn" type="button" data-close>Close</button>';
  try {
    const d = await api(`/api/hr/applications/${id}`);
    if (state.openApp !== id) return;
    state.app = d;
    renderApp();
  } catch (err) {
    $('#dTitle').textContent = 'Application';
    $('#dBody').innerHTML = stateBlock('error', 'Could not open this application.', err.message, { compact: true });
  }
}

const kv = (label, value) => (value ? `<div class="hr-kv"><span>${esc(label)}</span><span>${value}</span></div>` : '');
const extLink = (u) => (u && /^https?:\/\//i.test(u) ? `<a class="track-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(u.replace(/^https?:\/\/(www\.)?/i, ''))}</a>` : '');
const sizeText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function renderApp() {
  const { application: a, history, notes, events, other_applications: others } = state.app;
  $('#dTitle').textContent = a.full_name;
  $('#dSub').innerHTML = `<span class="hr-sub-job">${esc(a.job_title)}</span> · Applied ${esc(istDateTime(a.applied_at))}`;
  const ans = a.answers || {};
  const statusCtl = canManage() ? `<section class="dsec"><h3 class="dsec-title">Status <span>${tag(APP_STATUS, a.status)}</span></h3>
    <div class="hr-panel"><div class="hr-status">
      <label class="fld"><span>Move to</span><select class="select" id="appStatus">${state.meta.applicationStatuses.map((s) => opt(s, APP_STATUS[s][1], a.status === s)).join('')}</select></label>
      <label class="fld hr-grow"><span>Note for the history <span class="soft">(optional)</span></span><input class="input" id="appStatusNote" maxlength="1000" placeholder="Why the status is changing" /></label>
      <button class="btn primary" type="button" id="appStatusSave" disabled>Update status</button></div><div id="statusErr"></div></div></section>`
    : `<section class="dsec"><h3 class="dsec-title">Status</h3>${tag(APP_STATUS, a.status)}</section>`;
  const resume = a.has_resume
    ? `<div class="hr-file"><span class="hr-file-ico">${icon('file-text')}</span><div class="hr-file-meta"><div class="hr-file-name" title="${esc(a.resume_filename || 'Resume')}">${esc(a.resume_filename || 'Resume')}</div>
        <div class="hr-file-sub">${esc((a.resume_mime || '').includes('pdf') ? 'PDF' : 'Word document')}${a.resume_size ? ` · ${sizeText(a.resume_size)}` : ''} · uploaded ${esc(istDateTime(a.resume_uploaded_at))}</div></div>
        <div class="hr-file-actions"><a class="btn" href="/api/hr/applications/${a.id}/resume" download data-full-nav>${icon('download')}Download</a>
        ${canManage() ? `<button class="icon-btn hr-del" type="button" id="resumeRemove" title="Remove resume" aria-label="Remove resume">${icon('trash-2')}</button>` : ''}</div></div>
      <div class="hr-confirm" id="resumeConfirm" hidden>
        <p><b>Permanently remove this resume?</b> The file is deleted from storage and cannot be recovered. The candidate and application stay.</p>
        <input class="input" id="resumeReason" maxlength="300" placeholder="Reason (optional)" aria-label="Reason for removing the resume" />
        <div class="form-actions"><button class="btn" type="button" id="resumeCancel">Cancel</button><button class="btn danger" type="button" id="resumeConfirmBtn">Remove permanently</button></div>
        <div id="resumeErr"></div></div>`
    : a.resume_state === 'removing'
      // The database says a removal started and has not finished: never offer the file.
      ? `<div class="alert warn">${icon('triangle-alert')}<span>Removal not finished. The file may already be deleted; it is not available.</span>
          ${canManage() ? '<button class="alert-link" type="button" id="resumeRetry">Finish removal</button>' : ''}</div><div id="resumeErr"></div>`
    : (() => { const ev = [...events].reverse().find((e) => e.event_type === 'resume_removed');
      return `<p class="soft">${ev ? `Removed by ${esc(ev.actor || '—')} on ${esc(istDateTime(ev.at))}${ev.metadata?.reason ? ` — ${esc(ev.metadata.reason)}` : ''}.` : 'No resume on file.'}</p>`; })();
  const contact = (ico, label, value) => `<div class="hr-contact"><span class="hr-contact-ico" title="${esc(label)}">${icon(ico)}</span><span class="sr-only">${esc(label)}</span>${value || '<span class="soft">Not given</span>'}</div>`;
  const fact = (label, value) => `<div class="hr-fact"><span>${esc(label)}</span><b>${value ? esc(value) : '<span class="soft">Not answered</span>'}</b></div>`;
  $('#dBody').innerHTML = `
    ${statusCtl}
    <section class="dsec"><h3 class="dsec-title">Resume</h3>${resume}</section>
    <section class="dsec"><h3 class="dsec-title">Contact</h3><div class="hr-contacts">
      ${contact('mail', 'Email', `<a class="track-link" href="mailto:${esc(a.email)}">${esc(a.email)}</a>`)}
      ${contact('phone', 'Phone', a.phone ? `<a class="track-link mono" href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : '')}
      ${contact('map-pin', 'Location', esc(a.location))}
      ${a.linkedin_url ? contact('linkedin', 'LinkedIn', extLink(a.linkedin_url)) : ''}${a.portfolio_url ? contact('globe', 'Portfolio', extLink(a.portfolio_url)) : ''}</div></section>
    <section class="dsec"><h3 class="dsec-title">Application</h3>
      <div class="hr-facts-grid">${fact('Notice period', ans.notice_period)}${fact('Work authorization', ans.work_authorization)}${ans.expected_compensation ? fact('Expected pay', ans.expected_compensation) : ''}</div>
      ${ans.relevant_experience ? `<div class="hr-answer"><span>Relevant experience</span><p>${esc(ans.relevant_experience)}</p></div>` : ''}
      ${a.cover_letter ? `<div class="hr-answer"><span>Cover letter</span><p>${esc(a.cover_letter)}</p></div>` : ''}
      <p class="hr-consent">${icon('shield-check', 'inline-ico')}Consent given ${esc(istDateTime(a.consent_at))} · version ${esc(a.consent_text_version)}</p></section>
    ${others.length ? `<section class="dsec"><h3 class="dsec-title">Other applications</h3>${others.map((o) => `<div class="hr-kv"><span><a class="linkish" href="/hr/candidates?app=${o.id}" data-app-link="${o.id}">${esc(o.job_title)}</a></span><span>${tag(APP_STATUS, o.status)}</span></div>`).join('')}</section>` : ''}
    <section class="dsec"><h3 class="dsec-title">Internal notes <span>${count(notes.length)}</span></h3>
      ${canManage() ? `<div class="hr-note-add"><textarea class="input" id="noteBody" rows="2" maxlength="4000" placeholder="Add an internal note. Candidates never see notes." aria-label="New note"></textarea>
        <div class="hr-note-bar"><span class="soft">${icon('lock', 'inline-ico')}Only the team can see notes</span><button class="btn primary" type="button" id="noteSave" disabled>Add note</button></div></div><div id="noteErr"></div>` : ''}
      ${notes.length ? `<ul class="hr-notes">${notes.map((n) => `<li><div class="hr-note-head"><b>${esc(n.actor || '—')}</b><span class="soft">${esc(istDateTime(n.at))}</span></div><p>${esc(n.body)}</p></li>`).join('')}</ul>` : '<p class="soft">No notes yet.</p>'}</section>
    <section class="dsec"><h3 class="dsec-title">Status history</h3>
      ${history.length ? `<ul class="hr-timeline">${history.map((h) => `<li>${tag(APP_STATUS, h.from_status)} → ${tag(APP_STATUS, h.to_status)}
        <span class="soft">${esc(h.actor || '—')} · ${esc(istDateTime(h.at))}</span>${h.note ? `<p>${esc(h.note)}</p>` : ''}</li>`).join('')}</ul>` : '<p class="soft">Still at Applied. Changes appear here with who made them.</p>'}</section>
    <section class="dsec"><h3 class="dsec-title">Activity</h3>
      <ul class="hr-timeline">${events.map((e) => `<li>${esc(EVENT[e.event_type] || e.event_type)}${(e.event_type === 'resume_removed' || e.event_type === 'resume_removal_started') && e.metadata?.reason ? ` <span class="soft">— ${esc(e.metadata.reason)}</span>` : ''}${e.event_type === 'candidate_profile_updated' && e.metadata?.changed ? ` <span class="soft">(${esc(Object.keys(e.metadata.changed).join(', ').replace(/_/g, ' '))})</span>` : ''}
        <span class="soft">${esc(e.actor || 'Candidate')} · ${esc(istDateTime(e.at))}</span></li>`).join('')}</ul></section>`;
  renderIcons();
}

async function saveStatus() {
  const a = state.app.application;
  const status = $('#appStatus').value;
  $('#appStatusSave').disabled = true; $('#appStatusSave').textContent = 'Updating…'; $('#statusErr').innerHTML = '';
  saved('Saving…', 'saved pending');
  try {
    await send(`/api/hr/applications/${a.id}/status`, 'PATCH', { status, version: a.version, note: $('#appStatusNote').value.trim() || null });
    await openApp(a.id);
    saved(`Moved to ${APP_STATUS[status][1]}`);
    loadApps().then(renderApps).catch(() => {});
  } catch (err) {
    saved('Not saved', 'saved failed');
    $('#statusErr').innerHTML = `<div class="form-error">${conflictNote(err)}</div>`;
    $('#appStatusSave').disabled = false; $('#appStatusSave').textContent = 'Update status';
  }
}

async function removeResume() {
  const id = state.app.application.id;
  const btn = $('#resumeConfirmBtn') || $('#resumeRetry');
  btn.disabled = true;
  saved('Removing…', 'saved pending');
  try {
    await api(`/api/hr/applications/${id}/resume`, { method: 'DELETE', body: JSON.stringify({ reason: $('#resumeReason')?.value.trim() || null }) });
    await openApp(id);
    saved('Resume removed');
    loadApps().then(renderApps).catch(() => {});
  } catch (err) {
    saved('Not removed', 'saved failed');
    // Whatever happened, show what the database now says.
    if (err.status >= 500) await openApp(id).catch(() => {});
    if ($('#resumeErr')) $('#resumeErr').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    if ($('#resumeConfirm')) $('#resumeConfirm').hidden = false;
    const again = $('#resumeConfirmBtn') || $('#resumeRetry'); if (again) again.disabled = false;
  }
}

async function saveNote() {
  const body = $('#noteBody').value.trim();
  if (!body) return;
  $('#noteSave').disabled = true; $('#noteSave').textContent = 'Adding…';
  saved('Saving…', 'saved pending');
  try {
    await send(`/api/hr/applications/${state.app.application.id}/notes`, 'POST', { body });
    await openApp(state.app.application.id);
    saved('Note added');
  } catch (err) {
    saved('Not saved', 'saved failed');
    $('#noteErr').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    $('#noteSave').disabled = false; $('#noteSave').textContent = 'Add note';
  }
}

// ------------------------------------------------------------------ events

let searchTimer = null;
function bind() {
  const sig = { signal: pageSignal() };
  const setFilter = (k, v) => { state.f[k] = v; writeUrl(); load(); };
  $('#filters').addEventListener('input', (e) => {
    if (e.target.id !== 'fq') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter('q', e.target.value.trim()), 250);
  });
  $('#filters').addEventListener('change', (e) => {
    const k = { fstatus: 'status', fjob: 'job', ffrom: 'from', fto: 'to' }[e.target.id];
    if (k) setFilter(k, e.target.value);
  });
  $('#filters').addEventListener('click', (e) => {
    if (e.target.id !== 'fclear') return;
    for (const k of filtersOf()) state.f[k] = '';
    writeUrl(); frame(); load();
  });
  $('#refresh').addEventListener('click', () => load());
  $('#alerts').addEventListener('click', (e) => { if (e.target.id === 'retry') load(); });
  $('#newJob').addEventListener('click', () => openJob('new'));
  const pick = (e) => {
    if (e.target.closest('[data-stop]')) return;
    const row = e.target.closest('[data-job], [data-app]');
    if (!row) return;
    if (row.dataset.job) openJob(row.dataset.job); else openApp(Number(row.dataset.app));
  };
  for (const el of [$('#rows'), $('#clist')]) {
    el.addEventListener('click', pick);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || (e.key === ' ' && e.target.matches('[data-job], [data-app]'))) { if (e.key === ' ') e.preventDefault(); pick(e); } });
  }

  $('#dBody').addEventListener('input', (e) => {
    if (e.target.id === 'jobDeleteTitle') { $('#jobDeleteYes').disabled = e.target.value.trim() !== state.job.title.trim(); return; }
    if (e.target.closest('#jobForm')) state.dirty = true;
    if (e.target.id === 'noteBody') $('#noteSave').disabled = !e.target.value.trim();
  });
  $('#dBody').addEventListener('change', (e) => {
    if (e.target.closest('#jobForm')) state.dirty = true;
    if (e.target.id === 'appStatus') $('#appStatusSave').disabled = e.target.value === state.app.application.status;
  });
  $('#dBody').addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.tab) { state.jobTab = t.dataset.tab; showTab(); return; }
    if (t.dataset.action) { jobAction(t.dataset.action); return; }
    if (t.id === 'jobDelete') { $('#jobDeleteConfirm').hidden = false; $('#jobDeleteTitle').focus(); return; }
    if (t.id === 'jobDeleteCancel') { $('#jobDeleteConfirm').hidden = true; $('#jobDeleteTitle').value = ''; $('#jobDeleteYes').disabled = true; return; }
    if (t.id === 'jobDeleteYes') { deleteJob(); return; }
    if (t.id === 'appStatusSave') { saveStatus(); return; }
    if (t.id === 'noteSave') { saveNote(); return; }
    if (t.id === 'resumeRemove') { $('#resumeConfirm').hidden = false; $('#resumeReason').focus(); return; }
    if (t.id === 'resumeCancel') { $('#resumeConfirm').hidden = true; return; }
    if (t.id === 'resumeConfirmBtn' || t.id === 'resumeRetry') { removeResume(); return; }
    if (t.dataset.reload !== undefined) { state.dirty = false; if (state.openJob) openJob(state.openJob); else if (state.openApp) openApp(state.openApp); return; }
    if (t.dataset.appLink) { e.preventDefault(); openApp(Number(t.dataset.appLink)); return; }
    if (t.dataset.copy !== undefined) {
      const url = $('#pubUrl').value;
      try { await navigator.clipboard.writeText(url); saved('Link copied'); } catch { $('#pubUrl').select(); saved('Press ⌘C / Ctrl+C to copy'); }
    }
  });
  $('#dFoot').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'jobSave') saveJob();
    if (t.dataset.close !== undefined) closeDrawer();
  });
  $('#dClose').addEventListener('click', () => closeDrawer());
  $('#drawerScrim').addEventListener('click', () => closeDrawer());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); }, sig);
  window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); }, sig);
  onQueryChange(async () => {
    const before = state.view;
    readUrl();
    if (before !== state.view) state.apps = [];
    frame();
    await load();
    openFromUrl();
  });
}

function openFromUrl() {
  if (state.openJob) openJob(state.openJob);
  else if (state.openApp) openApp(state.openApp);
  else if (!$('#drawer').hidden) closeDrawer({ force: true });
}

(async function init() {
  try {
    const [me, meta] = await Promise.all([api('/auth/me'), api('/api/hr/meta')]);
    state.me = me; state.meta = meta;
    initShell(me);
    readUrl();
    if (state.view === 'candidates') await loadJobs().catch(() => {});
    frame();
    bind();
    await load();
    openFromUrl();
  } catch (err) { failed(err); }
}());
