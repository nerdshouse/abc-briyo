/**
 * Physical units on an order's lines, for the order drawer's total.
 *
 *   - A line linked to a Briyo product counts quantity × units per listing (its
 *     pack size, from the same LINE_UNITS_SQL that stock reservation uses).
 *   - A hand-entered line ("manual:…") is already counted in units.
 *   - A platform line that is not mapped yet has no known pack size, so it is
 *     counted apart — never as units, and never guessed as a minimum.
 *
 * Pure: imported by public/orders.js and by scripts/db-check.js.
 */
const fmt = (n) => new Intl.NumberFormat('en-IN').format(n);
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

export function unitSummary(items) {
  const list = items || [];
  let known = 0;
  let unmapped = 0;
  for (const it of list) {
    const manual = String(it.source_line_item_id || '').startsWith('manual:');
    if (it.sku_id || manual) known += Number(it.quantity || 0) * Math.max(1, Number(it.units_per_listing) || 1);
    else unmapped += 1;
  }
  return { lines: list.length, known, unmapped };
}

/** "2 lines · 7 units", "2 lines · 6 known units · 1 unmapped line", or "1 line · units unknown (1 unmapped line)". */
export function unitSummaryText(items) {
  const { lines, known, unmapped } = unitSummary(items);
  if (!unmapped) return `${plural(lines, 'line')} · ${plural(known, 'unit')}`;
  if (!known) return `${plural(lines, 'line')} · units unknown (${plural(unmapped, 'unmapped line')})`;
  return `${plural(lines, 'line')} · ${plural(known, 'known unit')} · ${plural(unmapped, 'unmapped line')}`;
}

/** Why the total is partial, for a tooltip; empty when every unit is known. */
export const UNMAPPED_UNITS_NOTE = 'A platform SKU that is not mapped to a Briyo product has no known pack size yet, so its '
  + 'units are not counted. Map it in Inventory → Unmapped SKUs.';
