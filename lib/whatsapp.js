/**
 * WhatsApp OTP delivery via 11za.
 *
 * The request body matches 11za's sendTemplate spec. Note the auth token travels
 * in the BODY, not a header — so nothing is sent as a header by default.
 *
 *   ELEVENZA_API_URL          endpoint (default: https://api.11za.in/apis/template/sendTemplate)
 *   ELEVENZA_AUTH_TOKEN       your 11za auth token
 *   ELEVENZA_TEMPLATE_NAME    approved template name (e.g. login_otp)
 *   ELEVENZA_ORIGIN_WEBSITE   the origin website registered on your 11za account
 *   ELEVENZA_LANGUAGE         template language code (default: en)
 *   ELEVENZA_AUTH_HEADER      optional; only set this if 11za also wants a header
 *   ELEVENZA_PAYLOAD_TEMPLATE optional override of the whole JSON body.
 *                             Placeholders: {{authToken}} {{name}} {{phone}}
 *                             {{origin}} {{template}} {{language}} {{otp}}
 *
 * With no ELEVENZA_AUTH_TOKEN set, the driver falls back to console mode: the
 * code is printed to the server log so the login flow is testable offline.
 */

const DEFAULT_URL = 'https://api.11za.in/apis/template/sendTemplate';

const DEFAULT_PAYLOAD = JSON.stringify({
  authToken: '{{authToken}}',
  name: '{{name}}',
  sendto: '{{phone}}',
  originWebsite: '{{origin}}',
  templateName: '{{template}}',
  language: '{{language}}',
  data: '{{otp}}',
});

export const driver = () => (process.env.ELEVENZA_AUTH_TOKEN ? '11za' : 'console');

function buildBody(phone, otp, name = 'Team', template = null) {
  const raw = process.env.ELEVENZA_PAYLOAD_TEMPLATE || DEFAULT_PAYLOAD;
  const filled = raw
    .replaceAll('{{authToken}}', process.env.ELEVENZA_AUTH_TOKEN || '')
    .replaceAll('{{name}}', name)
    .replaceAll('{{phone}}', phone)
    .replaceAll('{{origin}}', process.env.ELEVENZA_ORIGIN_WEBSITE || '')
    .replaceAll('{{template}}', template || process.env.ELEVENZA_TEMPLATE_NAME || 'login_otp')
    .replaceAll('{{language}}', process.env.ELEVENZA_LANGUAGE || 'en')
    .replaceAll('{{otp}}', otp);
  try {
    return JSON.parse(filled);
  } catch (err) {
    throw new Error(`ELEVENZA_PAYLOAD_TEMPLATE is not valid JSON after substitution: ${err.message}`);
  }
}

/** Never log or echo the token. */
export function redact(body) {
  const copy = { ...body };
  if (copy.authToken) copy.authToken = `${String(copy.authToken).slice(0, 4)}…redacted`;
  return copy;
}

/**
 * Sends an operational alert to the ops number.
 *
 * 11za's API sends *approved templates*, not free text — so this needs its own
 * template (ELEVENZA_OPS_TEMPLATE_NAME) with a single body variable. Reusing the
 * login_otp template would deliver "Your OTP is <a sentence about stale carts>",
 * which is worse than not sending. With no ops template configured the digest is
 * logged instead, so the feature degrades rather than misfires.
 */
export async function sendOpsAlert(phone, text) {
  const template = process.env.ELEVENZA_OPS_TEMPLATE_NAME;
  if (driver() === 'console' || !template) {
    console.log(`\n  [ops alert${template ? '' : ' — no ELEVENZA_OPS_TEMPLATE_NAME set, not sent'}] ` +
      `to +${phone}: ${text}\n`);
    return { delivered: false, reason: template ? 'console driver' : 'no ops template configured' };
  }
  return sendTemplate({ phone, template, data: text, name: 'Ops' });
}

export async function sendOtp(phone, otp, name = 'Team') {
  if (driver() === 'console') {
    console.log(`\n  [console driver] OTP for +${phone} is ${otp}  (expires in 5 minutes)\n`);
    return { delivered: false, console: true };
  }

  return sendTemplate({
    phone, template: process.env.ELEVENZA_TEMPLATE_NAME || 'login_otp', data: otp, name,
  });
}

async function sendTemplate({ phone, template, data, name }) {
  const url = process.env.ELEVENZA_API_URL || DEFAULT_URL;
  if (!process.env.ELEVENZA_ORIGIN_WEBSITE) {
    throw new Error('ELEVENZA_ORIGIN_WEBSITE is not set — 11za rejects sends without it.');
  }

  const headers = { 'Content-Type': 'application/json' };
  // 11za carries the token in the body; a header is only added if explicitly configured.
  if (process.env.ELEVENZA_AUTH_HEADER) {
    headers[process.env.ELEVENZA_AUTH_HEADER] = process.env.ELEVENZA_AUTH_TOKEN;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(phone, data, name, template)),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Could not reach 11za: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`11za returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  // A 200 can still carry a failure flag; surface that rather than assume success.
  try {
    const json = JSON.parse(text);
    if (json.success === false || json.status === 'error' || json.error) {
      throw new Error(`11za rejected the send: ${JSON.stringify(json).slice(0, 300)}`);
    }
  } catch (err) {
    if (err.message.startsWith('11za rejected')) throw err;
    console.warn('11za returned a non-JSON 200 response:', text.slice(0, 200));
  }

  return { delivered: true };
}

export { DEFAULT_URL, DEFAULT_PAYLOAD, buildBody };
