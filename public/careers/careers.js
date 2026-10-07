/*
 * careers.briyo.xyz — the application form. One submit, two requests:
 *   1. POST /jobs/:id/apply          details + Turnstile + form token → upload token
 *   2. POST /jobs/:id/apply/resume   the file, with that single-use token
 * The page works without this script except for applying (a <noscript> says so).
 */
/*
 * Layout only (no part of applying): on wide screens the application card is
 * sticky beside the role. When the card is taller than the window, a plain
 * `top: 24px` would hide its end, so the offset goes negative by the overflow:
 * the card scrolls with the page until its bottom is in view, then holds there.
 */
(function () {
  'use strict';
  var card = document.getElementById('apply');
  if (!card || !window.matchMedia) return;
  var wide = window.matchMedia('(min-width: 960px)');
  var GAP = 24;
  function place() {
    if (!wide.matches) { card.style.removeProperty('--sticky-top'); return; }
    card.style.setProperty('--sticky-top', Math.min(GAP, window.innerHeight - card.offsetHeight - GAP) + 'px');
  }
  place();
  window.addEventListener('resize', place);
  if (window.ResizeObserver) new ResizeObserver(place).observe(card);
}());

(function () {
  'use strict';
  var form = document.getElementById('applyForm');
  if (!form || form.dataset.disabled) return;
  var pid = form.dataset.publicId;
  var btn = document.getElementById('submitBtn');
  var widget = null;
  btn.disabled = false; // disabled in the HTML: without this script the form must never submit natively
  // After step 1 succeeds, its upload token stays valid for 15 minutes: a rejected
  // file is retried with it, without sending the details (or Turnstile) again.
  var pending = null;
  var MAX = 10 * 1024 * 1024;
  var TEXT = ['full_name', 'email', 'phone', 'location', 'linkedin_url', 'portfolio_url', 'relevant_experience',
    'notice_period', 'expected_compensation', 'work_authorization', 'cover_letter', 'website'];
  var REQUIRED = { full_name: 'Please enter your full name.', email: 'Please enter your email.', phone: 'Please enter your phone number.',
    location: 'Please enter your current location.', relevant_experience: 'Please tell us about your relevant experience.',
    notice_period: 'Please enter your notice period or availability.', work_authorization: 'Please enter your work authorization.' };

  // The real Turnstile API (not a DOM element that happens to share the name).
  var ts = function () { return window.turnstile && typeof window.turnstile.render === 'function' ? window.turnstile : null; };
  window.briyoTurnstileReady = function () {
    if (!ts() || widget !== null) return;
    var el = document.getElementById('tsWidget');
    if (el) widget = window.turnstile.render(el, { sitekey: el.dataset.sitekey, action: 'apply', theme: 'light' });
  };
  window.briyoTurnstileReady();

  function setErr(name, msg) {
    var box = form.querySelector('[data-field="' + name + '"]');
    var err = document.getElementById('f-' + name + '-err');
    if (box) box.classList.toggle('has-err', Boolean(msg));
    if (err) err.textContent = msg || '';
    var input = document.getElementById('f-' + name);
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }
  function clearErrs() {
    Array.prototype.forEach.call(form.querySelectorAll('.has-err'), function (el) { setErr(el.dataset.field, ''); });
    var fe = document.getElementById('formError'); fe.hidden = true; fe.textContent = '';
  }
  function formError(msg) {
    var fe = document.getElementById('formError');
    fe.textContent = msg; fe.hidden = false;
    fe.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function focusFirstErr() {
    var first = form.querySelector('.has-err input, .has-err textarea');
    if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function busy(on, label) {
    btn.disabled = on;
    btn.textContent = label || 'Submit application';
    form.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function resetTurnstile() { if (ts() && widget !== null) { try { window.turnstile.reset(widget); } catch (e) { /* ignore */ } } }
  function turnstileToken() {
    if (ts() && widget !== null) return window.turnstile.getResponse(widget) || '';
    var hidden = form.querySelector('[name="cf-turnstile-response"]');
    return hidden ? hidden.value : '';
  }

  function checkFile(f) {
    if (!f) return 'Please attach your resume.';
    if (!/\.(pdf|docx)$/i.test(f.name)) return 'Please upload a PDF or Word (.docx) file.';
    if (f.size === 0) return 'That file is empty.';
    if (f.size > MAX) return 'That file is larger than 10 MB.';
    return '';
  }

  function validate(values, file) {
    var ok = true;
    Object.keys(REQUIRED).forEach(function (k) { if (!values[k]) { setErr(k, REQUIRED[k]); ok = false; } });
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) { setErr('email', 'Please enter a valid email address.'); ok = false; }
    if (values.phone && values.phone.replace(/\D/g, '').length < 8) { setErr('phone', 'Please enter a phone number with country code.'); ok = false; }
    var fe = checkFile(file); if (fe) { setErr('resume', fe); ok = false; }
    if (!document.getElementById('f-consent').checked) { setErr('consent', 'Please confirm the statement to apply.'); ok = false; }
    return ok;
  }

  function post(url, body, headers) {
    return fetch(url, { method: 'POST', headers: headers, body: body, credentials: 'omit' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { data.status = res.status; return data; });
    });
  }

  form.addEventListener('input', function (e) { var f = e.target.closest('[data-field]'); if (f && f.classList.contains('has-err')) setErr(f.dataset.field, ''); });
  document.getElementById('f-resume').addEventListener('change', function (e) { setErr('resume', checkFile(e.target.files[0])); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.disabled) return;
    clearErrs();
    var values = {};
    TEXT.forEach(function (k) { var el = form.elements[k]; values[k] = el ? el.value.trim() : ''; });
    var file = document.getElementById('f-resume').files[0];
    if (!validate(values, file)) { focusFirstErr(); return; }
    var reuse = pending && Date.now() - pending.at < 14 * 60 * 1000;
    var token = reuse ? '' : turnstileToken();
    if (!reuse && !token) { setErr('turnstile', 'Please complete the verification.'); return; }

    var body = Object.assign({}, values, { consent: true, turnstile_token: token, form_token: form.dataset.formToken });
    busy(true, reuse ? 'Uploading your resume…' : 'Sending your details…');
    var step1 = reuse ? Promise.resolve({ status: 201, uploadToken: pending.token })
      : post('/jobs/' + encodeURIComponent(pid) + '/apply', JSON.stringify(body), { 'Content-Type': 'application/json' });
    step1.then(function (r) {
      if (r.status !== 201) {
        resetTurnstile(); busy(false);
        if (r.field) { setErr(r.field === 'turnstile' ? 'turnstile' : r.field, r.error); focusFirstErr(); return null; }
        if (r.reload) { formError(r.error + ' '); var a = document.createElement('a'); a.href = location.pathname; a.textContent = 'Reload the page'; document.getElementById('formError').appendChild(a); return null; }
        formError(r.error || 'Something went wrong. Please try again.');
        return null;
      }
      if (!reuse) pending = { token: r.uploadToken, at: Date.now() };
      busy(true, 'Uploading your resume…');
      return post('/jobs/' + encodeURIComponent(pid) + '/apply/resume', file, {
        'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Upload-Token': r.uploadToken,
      }).then(function (u) {
        if (u.status === 201) {
          pending = null;
          form.hidden = true;
          var done = document.getElementById('done'); done.hidden = false; done.focus(); done.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        busy(false);
        if (u.status === 400 || u.status === 413) { setErr('resume', (u.error || 'That file could not be accepted.') + ' Please choose another file and submit again.'); focusFirstErr(); return; }
        // Token expired or already used: the next submit starts again from step 1.
        pending = null; resetTurnstile();
        formError((u.error || 'Your resume could not be uploaded.') + ' Please submit again.');
      });
    }).catch(function () {
      resetTurnstile(); busy(false);
      formError('We could not reach the server. Check your connection and try again.');
    });
  });
}());
