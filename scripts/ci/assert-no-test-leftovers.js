/**
 * After `npm run db:check`: fails if the privacy steps left anything behind in the
 * test database — the temporary fault trigger or its function, the fictional cart,
 * webhook failure or auto-recovery rows, or rows for the fictional 91900000085x–
 * 91900000087x numbers. Read-only. Uses TEST_DATABASE_URL only, like db-check.
 *
 *   node scripts/ci/assert-no-test-leftovers.js
 */
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set.');
  process.exit(2);
}

const FICTIONAL = '^9190000008[5-7][0-9]$';
const CHECKS = [
  ['fault trigger dbcheck_wh_fail', `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'dbcheck_wh_fail'`],
  ['fault function dbcheck_wh_fail', `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'dbcheck_wh_fail'`],
  ['DBCHECK-HC carts', `SELECT count(*)::int AS n FROM abandoned_carts WHERE cart_id LIKE 'DBCHECK-HC-%'`],
  ['order webhook failure rows', `SELECT count(*)::int AS n FROM webhook_failures WHERE kind = 'order-completed' AND body LIKE '%DBCHECK-WH%'`],
  ['auto-recovery rows', `SELECT count(*)::int AS n FROM auto_recovery_log WHERE cart_id LIKE 'DBCHECK-HC-%' OR order_id LIKE 'GK-DBCHECK-%'`],
  ['fictional members', `SELECT count(*)::int AS n FROM allowed_users WHERE phone ~ '${FICTIONAL}'`],
  ['fictional OTP state', `SELECT count(*)::int AS n FROM otp_state WHERE phone ~ '${FICTIONAL}'`],
  ['fictional login log rows', `SELECT count(*)::int AS n FROM login_log WHERE phone ~ '${FICTIONAL}'`],
  ['fictional member log rows', `SELECT count(*)::int AS n FROM member_log WHERE target_phone ~ '${FICTIONAL}'`],
];

const client = new pg.Client({ connectionString: url });
await client.connect();
let left = 0;
try {
  await client.query('BEGIN READ ONLY');
  for (const [label, sql] of CHECKS) {
    const { n } = (await client.query(sql)).rows[0];
    console.log(`  ${n ? 'LEFT' : 'ok  '}  ${label}${n ? `: ${n}` : ''}`);
    left += n;
  }
  await client.query('ROLLBACK');
} finally {
  await client.end();
}
if (left) {
  console.error(`\n${left} test object(s) left behind.`);
  process.exit(1);
}
console.log('\nNo test leftovers.');
