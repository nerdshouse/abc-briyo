/**
 * Briyo OS time: one business timezone, one display format.
 *
 *   APP_TIMEZONE   Asia/Kolkata (IST, UTC+05:30). Every business day, "today", report range and displayed
 *                  time is in IST — never the server's, the browser's or UTC.
 *   Display        dates  DD-MM-YYYY                      e.g. 08-10-2026
 *                  times  DD-MM-YYYY, h:mm AM/PM IST       e.g. 08-10-2026, 10:35 AM IST
 *
 * Storage and APIs are unchanged: timestamptz in Postgres, ISO-8601 instants in JSON, YYYY-MM-DD for
 * date-only values (DATE columns come back as text, lib/db.js). This module only interprets and presents.
 *
 * BOARD_TIMEZONE / BOARD_TZ are kept for compatibility but never override APP_TIMEZONE: unset or
 * Asia/Kolkata is accepted silently; anything else is ignored with a warning at boot.
 */
export const APP_TIMEZONE = 'Asia/Kolkata';

/**
 * SQL for "the last N IST calendar days, today included" as a timestamptz lower bound: from 00:00 IST
 * N−1 days ago. Use with `col >= ${lastIstDaysSql(30)}`. A business window, not a rolling 24h×N.
 */
export const lastIstDaysSql = (n) => `((((now() AT TIME ZONE '${APP_TIMEZONE}')::date - ${Number(n) - 1})::timestamp) AT TIME ZONE '${APP_TIMEZONE}')`;

/** The warning for a legacy timezone variable set to something other than IST, or null. */
export function legacyTimezoneWarning(env = process.env) {
  const set = ['BOARD_TIMEZONE', 'BOARD_TZ'].filter((k) => env[k] && env[k].trim() && env[k].trim() !== APP_TIMEZONE);
  if (!set.length) return null;
  return `${set.map((k) => `${k}=${env[k]}`).join(', ')} is ignored: Briyo OS always uses ${APP_TIMEZONE} (IST). `
    + 'Remove the variable; it is kept only for compatibility and will be dropped.';
}

const valid = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(new Date(v).getTime());
const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const partsOf = (v) => Object.fromEntries(PARTS.formatToParts(new Date(v)).map((x) => [x.type, x.value]));

/** "2026-10-08" — the IST calendar day of an instant (for SQL parameters and comparisons, not display). */
export const istDayKey = (v) => { if (!valid(v)) return ''; const p = partsOf(v); return `${p.year}-${p.month}-${p.day}`; };

/** "08-10-2026" — an instant's IST date. */
export const formatDate = (v) => { if (!valid(v)) return '—'; const p = partsOf(v); return `${p.day}-${p.month}-${p.year}`; };

/** "08-10-2026, 10:35 AM IST" — an instant in IST. */
export function formatDateTime(v) {
  if (!valid(v)) return '—';
  const p = partsOf(v);
  const h = Number(p.hour);
  return `${p.day}-${p.month}-${p.year}, ${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'} IST`;
}

/** "2026-10-08" (a date-only value) → "08-10-2026". No timezone involved: the date never shifts. */
export function formatDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '—';
}

/** "08-10-2026" (as a person types it) → "2026-10-08", or null when it is not a real calendar date. */
export function parseDisplayDate(text) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > last) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The instant an IST business day starts: "2026-10-08" → 2026-10-07T18:30:00.000Z. Pure arithmetic on the
 * zone's offset at that moment (IST has no daylight saving, but nothing here assumes it).
 */
export function istDayStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const p = partsOf(guess);
  const offset = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - guess;
  return new Date(guess - offset);
}
/** The instant the next IST day starts — the exclusive end of an IST business day. */
export function istDayEnd(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
  return istDayStart(next);
}
