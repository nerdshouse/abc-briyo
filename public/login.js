'use strict';

const $ = (s) => document.querySelector(s);
const banner = $('#banner');
let currentPhone = '';
let resendTimer = null;

function showError(msg) { banner.textContent = msg; banner.hidden = false; }
function clearError() { banner.hidden = true; }

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
  return data;
}

function startResendCountdown(seconds = 60) {
  const btn = $('#resend');
  clearInterval(resendTimer);
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `Resend in ${left}s`;
  resendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendTimer);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    } else {
      btn.textContent = `Resend in ${left}s`;
    }
  }, 1000);
}

async function requestCode(phone) {
  const data = await post('/auth/request-otp', { phone });
  currentPhone = phone;
  $('#sentTo').textContent = `+91 ${phone.replace(/\D/g, '').slice(-10)}`;
  $('#phoneForm').hidden = true;
  $('#otpForm').hidden = false;
  $('#code').focus();
  if (data.consoleMode) $('#consoleNote').hidden = false;
  startResendCountdown();
}

$('#phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const btn = $('#sendBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await requestCode($('#phone').value);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send code';
  }
});

$('#otpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const btn = $('#verifyBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    await post('/auth/verify-otp', { phone: currentPhone, code: $('#code').value });
    window.location.href = '/';
  } catch (err) {
    showError(err.message);
    $('#code').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify & sign in';
  }
});

$('#resend').addEventListener('click', async () => {
  clearError();
  try {
    await requestCode(currentPhone);
  } catch (err) {
    showError(err.message);
  }
});

$('#changeNumber').addEventListener('click', () => {
  clearInterval(resendTimer);
  clearError();
  $('#otpForm').hidden = true;
  $('#phoneForm').hidden = false;
  $('#code').value = '';
  $('#phone').focus();
});

// Digits only, and auto-submit once six are entered.
$('#phone').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^\d\s+]/g, '');
});
$('#code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '');
  if (e.target.value.length === 6) $('#otpForm').requestSubmit();
});
