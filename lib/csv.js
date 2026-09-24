/**
 * RFC 4180 CSV parser.
 *
 * Hand-rolled rather than a dependency because the only hard parts are quoted
 * fields containing commas, newlines and doubled quotes — all of which appear in
 * Shopify exports (product names carry commas and pipes, notes carry newlines).
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  // Strip a UTF-8 BOM; Shopify includes one and it would corrupt the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else { field += c; }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Rows as objects keyed by header, with headers matched leniently. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
      return o;
    });
  return { headers, records };
}

/**
 * One CSV cell, safe to open in Excel.
 *
 * Excel executes a cell beginning with =, +, - or @, so a note reading
 * "=cmd|..." would run on the machine of whoever opens the export. Those get a
 * leading apostrophe, which Excel strips on display.
 *
 * Numbers are exempt on purpose. The obvious guard — prefix anything matching
 * /^[=+\-@]/ — also mangles every negative number into '-100, which is wrong in
 * a column of figures and was a latent bug in the board export before this
 * helper existed. A value that parses as a finite number cannot be a formula.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const out = value instanceof Date ? value.toISOString() : String(value);
  const isNumeric = out !== '' && Number.isFinite(Number(out));
  const needsGuard = !isNumeric && /^[=+\-@\t\r]/.test(out);
  const body = (needsGuard ? `'${out}` : out).replace(/"/g, '""');
  return `"${body}"`;
}

/** A whole CSV from column definitions and rows — one implementation, two exports. */
export function toCsv(columns, rows) {
  return [
    columns.map(([header]) => csvCell(header)).join(','),
    ...rows.map((r) => columns.map(([, get]) => csvCell(get(r))).join(',')),
  ].join('\r\n');
}
