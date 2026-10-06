import { getPool } from './db.js';
import { inTransaction } from './orders.js';
import { readTable } from './amazon-import.js';
import { ensureInventorySchema, SKU_PATTERN, remapOrderItems, audit } from './inventory.js';

/**
 * Master SKU import: one row per master Briyo SKU and its product name.
 *
 *   Briyo SKU | Product Name
 *
 * That is all it imports. Platform SKUs (Amazon, Blinkit, Zepto…) are not
 * read from the sheet: Operations adds them on each master SKU by hand, and
 * resolves old orders from Inventory → Unmapped platform SKUs. Any other
 * column is ignored and listed as a warning, never an error.
 *
 * Preview writes nothing. Import is all-or-nothing: any error and nothing is
 * written. Re-importing the same sheet changes nothing. Masters missing from
 * the sheet are left as they are.
 */

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const MAX_REPORTED = 500;
const MASTER_HEADERS = new Set(['parentbriyoskucode', 'briyosku', 'briyoskucode', 'masterbriyosku', 'masterbriyoskucode', 'mastersku', 'sku', 'skucode']);
const NAME_HEADERS = new Set(['productname', 'name', 'briyoproductname', 'product']);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Reads and checks the sheet. Pure: no database. Returns masters, errors and
 * warnings with spreadsheet row numbers (header = row 1).
 */
export function planSkuSheet(rows) {
  if (!rows.length) throw bad('The file is empty.');
  const headers = rows[0].map((h) => String(h ?? '').replace(/\s+/g, ' ').trim());
  const masterCol = headers.findIndex((h) => MASTER_HEADERS.has(norm(h)));
  const nameCol = headers.findIndex((h) => NAME_HEADERS.has(norm(h)));
  if (masterCol < 0) throw bad('No master SKU column found. Expected a column named "Briyo SKU".');
  if (nameCol < 0) throw bad('No product name column found. Expected a column named "Product Name".');

  const errors = []; const warnings = [];
  const err = (row, reason, extra = {}) => errors.push({ row, reason, ...extra });
  const ignored = headers.filter((h, i) => h && i !== masterCol && i !== nameCol);
  if (ignored.length) {
    warnings.push({ row: 1, reason: `Ignored column${ignored.length > 1 ? 's' : ''}: ${ignored.map((h) => `"${h}"`).join(', ')}. Only Briyo SKU and Product Name are imported; add platform SKUs on each master SKU.` });
  }

  const masters = []; const seen = new Map();
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    const sku = String(r[masterCol] ?? '').trim();
    const name = String(r[nameCol] ?? '').replace(/\s+/g, ' ').trim();
    if (!sku && !name) return;   // blank line
    if (!sku) return err(row, `Master SKU is missing${name ? ` for "${name}"` : ''}.`, { column: headers[masterCol] });
    if (!SKU_PATTERN.test(sku)) return err(row, `Master SKU "${sku}" is not valid (letters, numbers, - _ . / only, no spaces).`, { column: headers[masterCol], value: sku });
    const key = sku.toLowerCase();
    if (seen.has(key)) return err(row, `Master SKU ${sku} appears again (first on row ${seen.get(key)}).`, { column: headers[masterCol], value: sku });
    seen.set(key, row);
    if (!name) return err(row, `Product name is missing for ${sku}.`, { column: headers[nameCol], value: sku });
    if (name.length > 300) return err(row, `Product name for ${sku} is longer than 300 characters.`, { column: headers[nameCol], value: sku });
    masters.push({ row, sku, name });
  });
  if (!masters.length && !errors.length) err(2, 'The sheet has no master SKU rows.');
  return { masters, ignoredColumns: ignored, errors, warnings };
}

/** The sheet against what is stored: new, unchanged, renamed, clashing with a platform SKU. */
async function diffSkuSheet(client, plan) {
  const keys = plan.masters.map((m) => m.sku.toLowerCase());
  const { rows: dbMasters } = await client.query('SELECT id, sku, product_name FROM skus WHERE lower(sku) = ANY($1)', [keys]);
  const masterBy = new Map(dbMasters.map((r) => [r.sku.toLowerCase(), r]));
  // A new master code equal to a platform SKU of another product would be ambiguous on orders.
  const { rows: asPlatform } = await client.query(
    `SELECT lower(m.platform_sku) AS code, p.label, s.sku FROM sku_platform_mappings m
     JOIN sku_platforms p ON p.key = m.platform JOIN skus s ON s.id = m.sku_id WHERE lower(m.platform_sku) = ANY($1)`, [keys]);
  const platformBy = new Map(asPlatform.map((r) => [r.code, r]));
  const errors = []; const newMasters = []; const renamed = []; const sameMasters = [];
  for (const m of plan.masters) {
    const cur = masterBy.get(m.sku.toLowerCase());
    if (!cur) {
      const clash = platformBy.get(m.sku.toLowerCase());
      if (clash) { errors.push({ row: m.row, reason: `${m.sku} is already a ${clash.label} SKU of master SKU ${clash.sku}.`, value: m.sku, conflict: true }); continue; }
      newMasters.push(m);
    } else if (cur.product_name !== m.name) renamed.push({ ...m, id: cur.id, from: cur.product_name });
    else sameMasters.push(m);
  }
  return { errors, newMasters, renamed, sameMasters };
}

const summarise = (plan, d, allErrors) => ({
  rows: plan.masters.length,
  mastersNew: d.newMasters.length,
  mastersRenamed: d.renamed.length,
  mastersUnchanged: d.sameMasters.length,
  ignoredColumns: plan.ignoredColumns,
  errorCount: allErrors.length,
  warningCount: plan.warnings.length,
});

/** Reads, checks and compares. Writes nothing. */
export async function previewSkuImport(buffer, filename) {
  await ensureInventorySchema();
  const plan = planSkuSheet(readTable(buffer, filename));
  const d = await diffSkuSheet(getPool(), plan);
  const errors = [...plan.errors, ...d.errors].sort((a, b) => a.row - b.row);
  return {
    summary: summarise(plan, d, errors),
    errors: errors.slice(0, MAX_REPORTED),
    warnings: plan.warnings.slice(0, MAX_REPORTED),
    renamed: d.renamed.map((r) => ({ row: r.row, sku: r.sku, from: r.from, to: r.name })),
    newMasters: d.newMasters.slice(0, MAX_REPORTED).map((m) => ({ row: m.row, sku: m.sku, name: m.name })),
  };
}

/** All or nothing, under a lock, re-checked inside the transaction. */
export async function commitSkuImport(buffer, filename, { actor } = {}) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('inventory:sku-import'))`);
    const plan = planSkuSheet(readTable(buffer, filename));
    const d = await diffSkuSheet(client, plan);
    const errors = [...plan.errors, ...d.errors].sort((a, b) => a.row - b.row);
    if (errors.length) {
      throw bad(`Nothing was imported: ${errors.length} problem${errors.length > 1 ? 's' : ''} to fix first (see preview).`, 400, { importErrors: errors.slice(0, MAX_REPORTED) });
    }
    let orderItemsMapped = 0;
    for (const m of d.newMasters) {
      const { rows } = await client.query(
        'INSERT INTO skus (sku, product_name, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id', [m.sku, m.name, actor]);
      await audit(client, 'sku_created', { actor, skuId: rows[0].id, metadata: { sku: m.sku, product_name: m.name, source: 'import', file: filename || null } });
      // Orders that already carry this master code (e.g. the website) resolve now.
      orderItemsMapped += await remapOrderItems(client, rows[0].id);
    }
    for (const m of d.renamed) {
      await client.query('UPDATE skus SET product_name = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [m.id, m.name, actor]);
      await audit(client, 'sku_updated', { actor, skuId: m.id, metadata: { changes: { product_name: { from: m.from, to: m.name } }, source: 'import' } });
    }
    const summary = { ...summarise(plan, d, []), orderItemsMapped };
    await audit(client, 'sku_master_import', { actor, metadata: { file: filename || null, ...summary } });
    return { summary, warnings: plan.warnings.slice(0, MAX_REPORTED) };
  });
}
