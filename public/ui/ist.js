/**
 * Briyo OS dates and times — the one front-end formatter/parser. Always India Standard Time
 * (Asia/Kolkata, UTC+05:30), never the viewer's computer; mirrors lib/timezone.js on the server.
 *
 *   dates  DD-MM-YYYY                    08-10-2026
 *   times  DD-MM-YYYY, h:mm AM/PM IST    08-10-2026, 10:35 AM IST
 *
 * Timestamps stay ISO instants and date-only values stay YYYY-MM-DD everywhere except on screen.
 * Pure functions, no DOM: the tests import this file.
 */
export const APP_TIMEZONE = 'Asia/Kolkata';
export const HR_TIMEZONE = APP_TIMEZONE;   // older name, same zone

const valid = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(new Date(v).getTime());
const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const partsOf = (v) => Object.fromEntries(PARTS.formatToParts(new Date(v)).map((x) => [x.type, x.value]));

/** "08-10-2026" — an instant's IST calendar date. */
export const istDate = (v) => { if (!valid(v)) return '—'; const p = partsOf(v); return `${p.day}-${p.month}-${p.year}`; };
/** "10:35 AM" — an instant's IST clock time. */
export const istTime = (v) => { if (!valid(v)) return '—'; const p = partsOf(v); const h = Number(p.hour); return `${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`; };
/** "08-10-2026, 10:35 AM IST" */
export const istDateTime = (v) => (valid(v) ? `${istDate(v)}, ${istTime(v)} IST` : '—');
/** "2026-10-08" — the IST calendar day of an instant, for inputs and comparisons (not for display). */
export const istDayKey = (v) => { if (!valid(v)) return ''; const p = partsOf(v); return `${p.year}-${p.month}-${p.day}`; };

/** A date-only value "2026-10-08" → "08-10-2026". No timezone: the date never shifts. */
export function formatDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '—';
}
/** "08-10-2026" as typed → "2026-10-08", or null when it is not a real calendar date. */
export function parseDisplayDate(text) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** An instant → "YYYY-MM-DDTHH:mm" on the IST clock, for <input type="datetime-local">. */
export const istInputValue = (v) => { if (!valid(v)) return ''; const p = partsOf(v); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
/** "YYYY-MM-DDTHH:mm" read as IST wall-clock time → ISO instant (or null). Never the browser's zone. */
export function fromIstInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const p = partsOf(guess);
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess;
  return new Date(guess - offset).toISOString();
}
