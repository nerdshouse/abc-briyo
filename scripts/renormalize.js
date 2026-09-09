import 'dotenv/config';
import {
  ensureSchema, getPool, isMockMode, eachCartPage, renormalizeRow, redactRow,
  DERIVED_COLUMNS, normalizedValue, NUMERIC_COLUMNS,
} from '../lib/db.js';
import { normalizePayload, REDACTED_KEYS } from '../lib/normalize.js';

/**
 * Re-derives the mapped columns from raw_payload, and optionally strips PII keys.
 *
 * raw_payload is the source of truth: this is a pure function of it, so running
 * it twice is a no-op and there is no "already done" flag to get wrong.
 *
 *   npm run db:renormalize              dry run — shows what would change
 *   npm run db:renormalize -- --apply   write the changes
 *   npm run db:renormalize -- --redact  also strip REDACTED_KEYS from raw_payload
 *   npm run db:renormalize -- --id=42   single row
 *   npm run db:renormalize -- --backup  snapshot the table first (do this once)
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const APPLY = has('--apply');
const REDACT = has('--redact');
const BACKUP = has('--backup');
const ONLY_ID = Number((args.find((a) => a.startsWith('--id=')) || '').split('=')[1]) || null;

if (isMockMode()) {
  console.error('DATABASE_URL is not set — nothing to renormalize.');
  process.exit(1);
}

/**
 * A dry run that misreports is worse than no dry run, so this is fussy:
 * pg returns NUMERIC as a string ("215.00" vs 215) and TIMESTAMPTZ as a Date.
 */
const same = (a, b, col) => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  if (NUMERIC_COLUMNS.has(col)) return Number(a) === Number(b);
  return String(a) === String(b);
};

await ensureSchema();

if (BACKUP) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const table = `abandoned_carts_backup_${stamp}`;
  await getPool().query(`CREATE TABLE IF NOT EXISTS ${table} AS SELECT * FROM abandoned_carts`);
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM ${table}`);
  console.log(`Backup: ${table} (${rows[0].n} rows). Drop it once you're satisfied.\n`);
}

console.log(APPLY ? 'APPLYING changes\n' : 'DRY RUN — nothing will be written (use --apply)\n');

const changes = new Map(DERIVED_COLUMNS.map((c) => [c, 0]));
let scanned = 0; let changedRows = 0; let skipped = 0; let redacted = 0;
const examples = [];
let cursor = ONLY_ID ? ONLY_ID - 1 : 0;

for (;;) {
  const page = await eachCartPage(cursor, ONLY_ID ? 1 : 200);
  if (!page.length) break;

  for (const row of page) {
    cursor = row.id;
    scanned += 1;

    // Normalising a body we never parsed would blank good columns with nulls.
    if (row.raw_payload && row.raw_payload._unparsed_body !== undefined) {
      skipped += 1;
      continue;
    }

    const n = normalizePayload(row.raw_payload);
    // Uses the same mapping renormalizeRow writes with, so the preview can't
    // disagree with what would actually be written.
    const diffs = DERIVED_COLUMNS.filter((col) => !same(row[col], normalizedValue(n, col), col));

    if (diffs.length) {
      changedRows += 1;
      diffs.forEach((c) => changes.set(c, changes.get(c) + 1));
      if (examples.length < 3) {
        examples.push(`  row ${row.id}: ` + diffs
          .map((c) => `${c} ${JSON.stringify(row[c])} → ${JSON.stringify(normalizedValue(n, c))}`)
          .slice(0, 3).join(', '));
      }
      if (APPLY) await renormalizeRow(row.id, n);
    }

    if (REDACT) {
      const present = REDACTED_KEYS.filter((k) => row.raw_payload && k in row.raw_payload);
      if (present.length) {
        redacted += 1;
        if (APPLY) await redactRow(row.id, present);
      }
    }
  }

  if (ONLY_ID) break;
}

console.log(`Scanned ${scanned} row(s); ${changedRows} would change; ${skipped} skipped (unparsed body).`);
for (const [col, n] of changes) if (n) console.log(`  ${col.padEnd(16)} ${n} row(s)`);
if (examples.length) { console.log('\nExamples:'); examples.forEach((e) => console.log(e)); }
if (REDACT) console.log(`\nRedaction: ${redacted} row(s) carry keys to strip (${REDACTED_KEYS.join(', ')}).`);
console.log(APPLY ? '\nDone — changes written.' : '\nNothing written. Re-run with --apply.');

await getPool().end();
