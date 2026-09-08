import 'dotenv/config';
import { buildBody, DEFAULT_URL } from '../lib/whatsapp.js';
import { normalisePhone } from '../lib/otp.js';

/**
 * Sends one real template message and prints 11za's raw response, so you can
 * confirm the payload field names without guessing. Usage:
 *   npm run otp:probe -- 9812345678
 */
const phone = normalisePhone(process.argv[2]);
if (!phone) {
  console.error('Usage: npm run otp:probe -- <10-digit Indian mobile>');
  process.exit(1);
}
if (!process.env.ELEVENZA_AUTH_TOKEN) {
  console.error('Set ELEVENZA_AUTH_TOKEN in .env first.');
  process.exit(1);
}

const url = process.env.ELEVENZA_API_URL || DEFAULT_URL;
const headerName = process.env.ELEVENZA_AUTH_HEADER || 'authToken';
const body = buildBody(phone, '123456');

console.log(`POST ${url}`);
console.log(`Header: ${headerName}: ${'*'.repeat(8)}`);
console.log('Body:', JSON.stringify(body, null, 2));

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', [headerName]: process.env.ELEVENZA_AUTH_TOKEN },
  body: JSON.stringify(body),
});

console.log(`\nHTTP ${res.status}`);
console.log(await res.text());
console.log('\nIf this failed, adjust ELEVENZA_PAYLOAD_TEMPLATE in .env and re-run.');
