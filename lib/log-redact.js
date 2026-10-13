/**
 * Masking for log lines. No imports, so any module can use it (lib/profile.js
 * cannot import lib/otp.js, which imports it). lib/otp.js re-exports both
 * helpers for the callers that already take them from there.
 */

/**
 * A phone number as it may appear in logs: "...1234", the last four digits only.
 * Never the whole number. Anything missing, too short to be a phone number, or
 * without digits gets a placeholder instead, so a malformed value cannot leak.
 */
export function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '(no number)';
  if (digits.length < 8) return '(short number)';
  return `...${digits.slice(-4)}`;
}

// Between the digit groups of a written number: space, dot, dash, en/em dash,
// slash, underscore, comma, brackets — one or two of them ("(+91) 90000").
const SEP = '[\\s.\\-\\u2013\\u2014/_,()]';
// Up to eight digit groups, not glued to a digit on either side.
const CANDIDATE = new RegExp(`(?<!\\d)(?:\\+\\s?)?\\d+(?:${SEP}{1,2}\\d+){0,7}(?!\\d)`, 'g');
// An Indian mobile, as every number in this app is: 10 digits from 6-9, with an
// optional 0, 91 or 0091 in front.
const MOBILE = /^(?:0091|91|0)?[6-9]\d{9}$/;
// Two or more numbers in this app's own spelling (normalisePhone: 91 + a mobile)
// glued together with no separator. Only that exact 12-digit shape, repeated: a
// long ID is almost never a run of those (0.002% of random 24-digit IDs).
const GLUED = /^(?:91[6-9]\d{9}){2,}$/;

/**
 * Log text with every Indian mobile number in it masked as maskPhone does, for
 * error messages and upstream responses that might echo a number back.
 *
 * A number is recognised by its shape, not by a digit count, so readable values
 * stay readable: dates and times ("2026-10-13 10:00:00"), epoch timestamps,
 * amounts and IDs that are not 10 digits starting 6-9. Groups split by spaces,
 * dots, dashes, slashes, underscores, commas or brackets are joined first, and
 * an unrelated number written just before a mobile ("order 1234 9000000851")
 * does not hide it.
 *
 * Numbers this app wrote itself (91XXXXXXXXXX) glued together with no separator
 * ("919000000851919000000852") are masked one by one.
 *
 * Limits, without knowing what a field means — deliberately not guessed at, as
 * each guess would also mask ordinary values:
 *   - an ID that happens to be ten digits starting 6-9 is masked too;
 *   - a mobile with a stray digit glued to it ("90000008511", "19000000851") is
 *     not recognised: it looks exactly like an 11-digit ID;
 *   - a mobile split by three or more characters ("98765 - 43210") is not
 *     recognised: it looks exactly like a range of two 5-digit numbers;
 *   - more than eight groups ("9 8 7 6 5 4 3 2 1 0"), non-ASCII digits and
 *     non-Indian numbers are not recognised.
 * Never rely on this for values you know are phone numbers: use maskPhone.
 */
export function redactPhones(text) {
  return String(text ?? '').replace(CANDIDATE, (match) => {
    // Split into digit groups with their positions, then mask the first run of
    // whole groups (left to right) that spells a mobile number.
    const groups = [...match.matchAll(/\d+/g)].map((g) => ({ digits: g[0], start: g.index, end: g.index + g[0].length }));
    const out = [];
    let at = 0;
    for (let i = 0; i < groups.length; i += 1) {
      if (GLUED.test(groups[i].digits)) {
        const from = i === 0 && match[0] === '+' ? 0 : groups[i].start;
        out.push(match.slice(at, from), groups[i].digits.match(/\d{12}/g).map(maskPhone).join(''));
        at = groups[i].end;
        continue;
      }
      let joined = '';
      for (let j = i; j < groups.length; j += 1) {
        joined += groups[j].digits;
        if (joined.length > 14) break;
        if (MOBILE.test(joined)) {
          // A leading "+" belongs to the number.
          const from = i === 0 && match[0] === '+' ? 0 : groups[i].start;
          out.push(match.slice(at, from), maskPhone(joined));
          at = groups[j].end;
          i = j;
          break;
        }
      }
    }
    return at === 0 ? match : out.join('') + match.slice(at);
  });
}

const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g;

/** Log text with email addresses replaced by "(email)". */
export function redactEmails(text) {
  return String(text ?? '').replace(EMAIL, '(email)');
}

/**
 * An error message (or other free text) for one log line: phones and emails
 * redacted, THEN cut to `max` characters — cutting first could split a number or
 * an address so that what is left is no longer recognised, and leak. Line breaks
 * become spaces, so the text cannot start a log line of its own.
 */
export function redactForLog(text, max = 300) {
  return redactEmails(redactPhones(text)).replace(/[\r\n]+/g, ' ').slice(0, max);
}
