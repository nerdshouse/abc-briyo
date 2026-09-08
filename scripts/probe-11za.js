import 'dotenv/config';
import { buildBody, redact, DEFAULT_URL } from '../lib/whatsapp.js';
import { normalisePhone } from '../lib/otp.js';

/**
 * Sends one real template message and prints 11za's raw response, so you can
 * confirm the payload without guessing. The auth token is redacted in the output.
 *   npm run otp:probe -- 9812345678
 */
const phone = normalisePhone(process.argv[2]);
if (!phone) {
  console.error('Usage: npm run otp:probe -- <10-digit Indian mobile>');
  process.exit(1);
}

const missing = ['ELEVENZA_AUTH_TOKEN', 'ELEVENZA_TEMPLATE_NAME', 'ELEVENZA_ORIGIN_WEBSITE']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Set these in .env first: ${missing.join(', ')}`);
  process.exit(1);
}

const url = process.env.ELEVENZA_API_URL || DEFAULT_URL;
const body = buildBody(phone, '123456', process.argv[3] || 'Team');

console.log(`POST ${url}`);
console.log('Body:', JSON.stringify(redact(body), null, 2));

const headers = { 'Content-Type': 'application/json' };
if (process.env.ELEVENZA_AUTH_HEADER) {
  headers[process.env.ELEVENZA_AUTH_HEADER] = process.env.ELEVENZA_AUTH_TOKEN;
  console.log(`Header: ${process.env.ELEVENZA_AUTH_HEADER}: <redacted>`);
}

const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
console.log(`\nHTTP ${res.status}`);
console.log(await res.text());
console.log('\nIf this failed, adjust the ELEVENZA_* vars in .env and re-run. No code change needed.');
