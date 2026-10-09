/**
 * Your profile — name, email, photo; the WhatsApp number is read-only.
 * When the profile is incomplete, this is the only page Briyo OS opens (the
 * server sends every other page here): no navigation, one clear task.
 * Photos are cropped to a centred square and resized in the browser before
 * upload; the server still checks the file type and size.
 */
import { $, esc, icon, renderIcons, initShell, setAvatar, toast, roleSummary, initials } from './ui/components.js';

const state = { me: null, profile: null, home: '/overview', next: null, wasIncomplete: false, saving: false };
/** The page asked for before completing the profile: a same-site path only (the server applies the same rule). */
function safeNext(v) {
  const s = String(v ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || /[\\\s]/.test(s) || s.length > 500) return null;
  return /^\/(profile|login|logout|auth|api|no-access)(\/|\.|$)/.test(s.split(/[?#]/)[0]) ? null : s;
}
const CAP_LABEL = {
  'logistics.view': 'See orders, shipments, couriers and destinations', 'logistics.edit': 'Create and update orders and shipments',
  'logistics.setup': 'Manage couriers and destinations', 'inventory.view': 'See stock, batches and SKUs',
  'inventory.move': 'Receive, adjust and transfer stock', 'inventory.catalog': 'Manage master SKUs, platforms, suppliers and warehouses',
  'support.work': 'Work the cart recovery call board', 'hr.view': 'See jobs, candidates and resumes', 'hr.manage': 'Manage jobs and applications', 'marketing.view': 'See Meta Ads performance (read-only)',
};
const FIELD_LABEL = { name: 'Full name', email: 'Email', photo: 'Profile photo' };

const api = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, field: data.field });
  return data;
};

function renderAvatar(url) {
  const el = $('#pfAvatar');
  el.innerHTML = url ? `<img src="${esc(url)}" alt="" />` : `<span>${esc(initials(state.profile?.name || '?'))}</span>`;
  el.classList.toggle('empty', !url);
  $('#pfFileLabel').textContent = url ? 'Replace photo' : 'Upload photo';
}

function render() {
  const p = state.profile;
  const incomplete = !p.complete;
  // Anyone with an incomplete profile is held here (the server sends every other page and API here too).
  document.querySelector('.app').classList.toggle('locked', incomplete);
  $('#pfTitle').textContent = incomplete ? 'Complete Your Profile' : 'Your profile';
  $('#topTitle').textContent = incomplete ? 'Complete Your Profile' : 'Your profile';
  document.title = `${incomplete ? 'Complete Your Profile' : 'Your profile'} — Briyo OS`;
  $('#pfSub').textContent = incomplete
    ? 'Before accessing Briyo OS, please complete the required details in your profile. This helps us keep our team directory accurate.'
    : 'How you appear to the team across Briyo OS.';
  $('#pfSave').textContent = incomplete ? 'Save and Continue' : 'Save profile';
  // Each missing field is marked where it is filled in.
  const miss = new Set(p.missing);
  $('#pfName').closest('.fld').classList.toggle('missing', miss.has('name'));
  $('#pfEmail').closest('.fld').classList.toggle('missing', miss.has('email'));
  document.querySelector('.pf-photo').classList.toggle('missing', miss.has('photo'));
  if (incomplete) {
    if (miss.has('name') && !$('#pfNameErr').textContent) $('#pfNameErr').textContent = 'Required: your full name.';
    if (miss.has('email') && !$('#pfEmailErr').textContent) $('#pfEmailErr').textContent = 'Required: a valid email address.';
    if (miss.has('photo') && !$('#pfPhotoErr').textContent) $('#pfPhotoErr').textContent = 'Required: upload a photo of yourself.';
  }
  $('#pfMeter').innerHTML = `<span class="pf-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.completion}" aria-label="Profile complete"><span style="width:${p.completion}%"></span></span> ${p.completion}%`;
  $('#pfGate').innerHTML = incomplete
    ? `<div class="alert warn pf-gate">${icon('user-round-pen')}<div><b>Profile incomplete</b><ul class="pf-missing">${p.missing.map((m) => `<li>${esc(FIELD_LABEL[m] || m)}</li>`).join('')}</ul></div></div>` : '';
  if (document.activeElement !== $('#pfName')) $('#pfName').value = p.name && p.name !== 'Team' ? p.name : '';
  if (document.activeElement !== $('#pfEmail')) $('#pfEmail').value = p.email || '';
  $('#pfPhone').value = `+${p.phone}`;
  renderAvatar(p.photoUrl);
  setAvatar($('#userAvatar'), { name: p.name, photoUrl: p.photoUrl });
  $('#userName').textContent = p.name;

  const me = state.me; const cat = me.moduleCatalog || {};
  const mods = Object.entries(me.modules || {});
  $('#pfAccess').innerHTML = `
    <p class="pf-role">${me.isAdmin ? '<span class="badge info">Admin</span> Full access to every department and to Members.' : esc(roleSummary(me))}</p>
    ${mods.length ? `<ul class="pf-mods">${mods.map(([m, r]) => `<li><b>${esc(cat[m]?.label || m)}</b><span class="badge">${esc(cat[m]?.roles?.find((x) => x.key === r)?.label || r)}</span></li>`).join('')}</ul>` : ''}
    ${(me.caps || []).length ? `<h3 class="dsec-title">You can</h3><ul class="pf-caps">${me.caps.map((c) => `<li>${icon('check')}${esc(CAP_LABEL[c] || c)}</li>`).join('')}</ul>`
      : '<p class="soft">No department yet. An admin assigns departments in Members.</p>'}`;
  renderIcons();
}

function fieldError(field, msg) {
  const map = { name: '#pfNameErr', email: '#pfEmailErr', photo: '#pfPhotoErr' };
  for (const [k, sel] of Object.entries(map)) if (!field || k === field) $(sel).textContent = k === field ? msg : '';
}

/** Centre-crop to a square and resize to 512 px; JPEG keeps it well under 2 MB. */
function squareCrop(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (side < 96) { URL.revokeObjectURL(url); reject(new Error('That image is too small. Use a photo at least 96 × 96 pixels.')); return; }
      const out = Math.min(512, side);
      const c = document.createElement('canvas'); c.width = out; c.height = out;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('That image could not be read.'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read. Use a JPG, PNG or WebP photo.')); };
    img.src = url;
  });
}

async function uploadPhoto(file) {
  fieldError('photo', '');
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { fieldError('photo', 'Use a JPG, PNG or WebP photo.'); return; }
  if (file.size > 15 * 1024 * 1024) { fieldError('photo', 'That photo is larger than 15 MB. Choose a smaller one.'); return; }
  $('#pfFileLabel').textContent = 'Uploading…';
  try {
    const blob = await squareCrop(file);
    const out = await api('/api/profile/photo', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Filename': 'photo.jpg' }, body: blob });
    state.profile = out.profile;
    render();
    if (!(state.wasIncomplete && state.profile.complete)) toast('Photo saved');
    afterSave();
  } catch (err) {
    fieldError('photo', err.message);
    renderAvatar(state.profile.photoUrl);
  }
}

async function saveFields(e) {
  e.preventDefault();
  if (state.saving) return;
  fieldError(null, '');
  const name = $('#pfName').value.trim(); const email = $('#pfEmail').value.trim();
  if (!name) { fieldError('name', 'Please enter your full name.'); $('#pfName').focus(); return; }
  if (!email) { fieldError('email', 'Please enter your email.'); $('#pfEmail').focus(); return; }
  state.saving = true; $('#pfSave').disabled = true; $('#pfSaved').textContent = 'Saving…';
  try {
    const out = await api('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email }) });
    state.profile = out.profile;          // as saved: completeness is worked out by the server from the database
    $('#pfSaved').textContent = '';
    render();
    if (!(state.wasIncomplete && state.profile.complete)) toast(state.profile.complete ? 'Profile saved' : 'Saved — still missing: ' + state.profile.missing.map((m) => FIELD_LABEL[m] || m).join(', '));
    afterSave();
  } catch (err) {
    $('#pfSaved').textContent = '';
    if (err.field) { fieldError(err.field, err.message); $(`#pf${err.field[0].toUpperCase()}${err.field.slice(1)}`)?.focus(); } else toast(err.message, { tone: 'bad' });
  } finally { state.saving = false; $('#pfSave').disabled = false; }
}

/**
 * The moment the server says the profile is complete, Briyo OS opens: back to the page that was asked for (if
 * safe), otherwise home. Re-checked with the server first, so a form that "looks" saved never opens anything.
 */
async function afterSave() {
  if (!(state.wasIncomplete && state.profile.complete)) return;
  const fresh = await api('/api/profile').catch(() => null);
  if (!fresh?.profile?.complete) return;
  try { sessionStorage.removeItem('briyo.nudge.hidden'); } catch { /* ignore */ }
  toast('Profile complete — welcome to Briyo OS');
  setTimeout(() => { window.location.href = state.next || state.home; }, 900);
}

(async function init() {
  try {
    const [me, prof] = await Promise.all([api('/auth/me'), api('/api/profile')]);
    if (!me.authenticated) { window.location.href = '/login'; return; }
    state.me = me; state.profile = prof.profile; state.home = prof.home === '/no-access' ? '/no-access' : (prof.home || '/overview');
    state.next = safeNext(new URLSearchParams(window.location.search).get('next'));
    state.wasIncomplete = !prof.profile.complete;
    initShell({ ...me, name: prof.profile.name, photoUrl: prof.profile.photoUrl });
    render();
    $('#pfForm').addEventListener('submit', saveFields);
    $('#pfFile').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadPhoto(f); });
    setAvatar($('#userAvatar'), { name: prof.profile.name, photoUrl: prof.profile.photoUrl });
  } catch (err) {
    $('#pfSub').textContent = '';
    $('#pfGate').innerHTML = `<div class="state error"><b>Your profile could not be loaded.</b><span>${esc(err.message)}</span></div>`;
  }
}());
