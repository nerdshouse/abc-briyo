/**
 * WhatsApp OTP delivery via 11za.
 *
 * 11za's API reference is not public, so the request is fully driven by env vars
 * rather than hardcoded — you can match their spec without touching this file:
 *
 *   ELEVENZA_API_URL          full endpoint URL
 *                             (default: https://api.11za.in/apis/template/sendTemplate)
 *   ELEVENZA_AUTH_HEADER      header name carrying the key (default: authToken)
 *   ELEVENZA_AUTH_TOKEN       the key itself
 *   ELEVENZA_TEMPLATE_NAME    your approved login-OTP template name
 *   ELEVENZA_PAYLOAD_TEMPLATE JSON body, with {{phone}} / {{otp}} / {{template}}
 *                             substituted before sending
 *
 * With no ELEVENZA_AUTH_TOKEN set, the driver falls back to console mode: the
 * code is printed to the server log so the whole login flow is testable offline.
 */

const DEFAULT_URL = 'https://api.11za.in/apis/template/sendTemplate';

/**
 * Best-effort default, based on 11za's published Pabbly template endpoint, which
 * uses these field names. Their /apis/template/sendTemplate reference is not
 * public — run `npm run otp:probe -- <phone>` to see the real response and adjust
 * ELEVENZA_PAYLOAD_TEMPLATE if these names are wrong. No code change needed.
 */
const DEFAULT_PAYLOAD = JSON.stringify({
  TemplateName: '{{template}}',
  PhoneNumber: '{{phone}}',
  Language: 'en',
  BodyDynamicData: '{{otp}}',
});

export const driver = () => (process.env.ELEVENZA_AUTH_TOKEN ? '11za' : 'console');

function buildBody(phone, otp) {
  const raw = process.env.ELEVENZA_PAYLOAD_TEMPLATE || DEFAULT_PAYLOAD;
  const filled = raw
    .replaceAll('{{phone}}', phone)
    .replaceAll('{{otp}}', otp)
    .replaceAll('{{template}}', process.env.ELEVENZA_TEMPLATE_NAME || 'login_otp');
  try {
    return JSON.parse(filled);
  } catch (err) {
    throw new Error(`ELEVENZA_PAYLOAD_TEMPLATE is not valid JSON after substitution: ${err.message}`);
  }
}

export async function sendOtp(phone, otp) {
  if (driver() === 'console') {
    console.log(`\n  [console driver] OTP for +${phone} is ${otp}  (expires in 5 minutes)\n`);
    return { delivered: false, console: true };
  }

  const url = process.env.ELEVENZA_API_URL || DEFAULT_URL;

  const headerName = process.env.ELEVENZA_AUTH_HEADER || 'authToken';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [headerName]: process.env.ELEVENZA_AUTH_TOKEN,
      },
      body: JSON.stringify(buildBody(phone, otp)),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Could not reach 11za: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`11za returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  // Some providers return 200 with a failure flag in the body; surface that too.
  try {
    const json = JSON.parse(text);
    const failed = json.success === false || json.status === 'error' || json.error;
    if (failed) {
      throw new Error(`11za rejected the send: ${JSON.stringify(json).slice(0, 300)}`);
    }
  } catch (err) {
    if (err.message.startsWith('11za rejected')) throw err;
    // Non-JSON 200 — assume success, but log it so a silent failure is visible.
    console.warn('11za returned a non-JSON 200 response:', text.slice(0, 200));
  }

  return { delivered: true, response: text.slice(0, 500) };
}

export { DEFAULT_URL, DEFAULT_PAYLOAD, buildBody };
