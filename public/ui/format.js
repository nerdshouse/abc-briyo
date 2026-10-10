/**
 * Money, as stored: two decimal places, Indian grouping. ₹180.50 stays ₹180.50 (never ₹181); a whole amount
 * shows its paise too (₹249.00) so a column of amounts lines up. Display only — nothing here rounds a value that is
 * stored, summed or sent. No imports and no DOM, so it can be tested in Node.
 */
const formatters = new Map();
const formatter = (currency) => {
  const c = String(currency || 'INR').toUpperCase();
  if (!formatters.has(c)) {
    let f;
    try { f = new Intl.NumberFormat('en-IN', { style: 'currency', currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    catch { f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }   // an unknown code: number only
    formatters.set(c, f);
  }
  return formatters.get(c);
};

/** ₹ amount with two decimals. null/undefined/'' → 0 (callers that mean "unknown" show '—' themselves). */
export const money = (v) => formatter('INR').format(Number(v || 0));

/** An amount in its own currency (USD 12.50 → US$12.50), two decimals; never converted. */
export const moneyIn = (currency, v) => formatter(currency).format(Number(v || 0));
