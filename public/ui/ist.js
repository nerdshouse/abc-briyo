/**
 * HR times, always in India Standard Time (Asia/Kolkata, UTC+05:30).
 *
 * Timestamps are stored in UTC; this is the presentation layer only. Fixed to
 * IST on purpose — it does not follow the board's timezone setting or the
 * viewer's computer. Pure functions, no DOM: the tests import this file.
 */
export const HR_TIMEZONE = 'Asia/Kolkata';

const valid = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(new Date(v).getTime());

const DATE = new Intl.DateTimeFormat('en-IN', { timeZone: HR_TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: HR_TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const KEY = new Intl.DateTimeFormat('en-CA', { timeZone: HR_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** "7 Oct 2026" — the IST calendar date. */
export const istDate = (v) => (valid(v) ? DATE.format(new Date(v)) : '—');
/** "1:30 am" */
export const istTime = (v) => (valid(v) ? TIME.format(new Date(v)).toLowerCase().replace(/\s+/g, ' ') : '—');
/** "7 Oct 2026, 1:30 am IST" */
export const istDateTime = (v) => (valid(v) ? `${istDate(v)}, ${istTime(v)} IST` : '—');
/** "2026-10-07" — the IST calendar day, for date inputs and comparisons. */
export const istDayKey = (v) => (valid(v) ? KEY.format(new Date(v)) : '');
