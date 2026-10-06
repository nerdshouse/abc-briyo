import { getPool } from './db.js';
import { inTransaction } from './orders.js';
import { readTable } from './amazon-import.js';
import {
  ensureInventorySchema, SKU_PATTERN, PLATFORM_SKU_PLACEHOLDERS, splitPlatformCell, platformSkuInput, remapOrderItems, audit,
} from './inventory.js';

/**
 * Master SKU sheet import: one row per master Briyo SKU, its product name, and
 * a column per platform holding that platform's SKU(s) for the product.
 *
 *   Briyo SKU | Product Name | Amazon | Blinkit Sku ID | Zepto | Tata 1mg | …
 *
 * A platform cell may hold several SKUs, separated by new lines, "/" or ",".
 * Each becomes its own platform-SKU → master-SKU mapping. Placeholders such as
 * "NA" mean "none on this platform".
 *
 * Preview writes nothing. Import is all-or-nothing: any error and nothing is
 * written. Re-importing the same sheet changes nothing. A platform SKU that
 * already points at a different master is a conflict, never reassigned.
 * Mappings and masters missing from the sheet are left as they are.
 */

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const MAX_REPORTED = 500;
const MASTER_HEADERS = new Set(['parentbriyoskucode', 'briyosku', 'briyoskucode', 'masterbriyosku', 'masterbriyoskucode', 'mastersku', 'sku', 'skucode']);
const NAME_HEADERS = new Set(['productname', 'name', 'briyoproductname', 'product']);
const FILLER_WORDS = new Set(['sku', 'skus', 'id', 'ids', 'code', 'codes', 'seller', 'listing']);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const platformOfHeader = (header, platforms) => {
  const core = String(header).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER_WORDS.has(w)).join('');
  return platforms.find((p) => norm(p.label) === core || norm(p.key) === core) || null;
};
const ASIN = /^B0[0-9A-Z]{8}$/;
const UUIDISH = /^[0-9a-f]{4,}-[0-9a-f-]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads and checks the sheet. Pure: no database. Returns masters, mappings,
 * errors and warnings with spreadsheet row numbers (header = row 1).
 */
export function planSkuSheet(rows, platforms) {
  if (!rows.length) throw bad('The file is empty.');
  const headers = rows[0].map((h) => String(h ?? '').replace(/\s+/g, ' ').trim());
  const masterCol = headers.findIndex((h) => MASTER_HEADERS.has(norm(h)));
  const nameCol = headers.findIndex((h) => NAME_HEADERS.has(norm(h)));
  if (masterCol < 0) throw bad('No master SKU column found. Expected a column such as "Briyo SKU" or "Parent Briyo SKU Code".');
  if (nameCol < 0) throw bad('No product name column found. Expected "Product Name".');

  const errors = []; const warnings = [];
  const err = (row, reason, extra = {}) => errors.push({ row, reason, ...extra });
  const columns = [];
  headers.forEach((h, i) => {
    if (i === masterCol || i === nameCol || !h) return;
    const p = platformOfHeader(h, platforms);
    const used = rows.slice(1).some((r) => String(r[i] ?? '').trim() && !PLATFORM_SKU_PLACEHOLDERS.has(String(r[i]).trim().toUpperCase()));
    if (p) columns.push({ index: i, header: h, platform: p.key, label: p.label });
    else if (used) err(1, `Column "${h}" does not match any platform. Add the platform first, or rename the column.`, { column: h });
    else warnings.push({ row: 1, reason: `Column "${h}" is empty and does not match a platform; ignored.`, column: h });
  });
  const dupPlatform = columns.filter((c, i) => columns.findIndex((d) => d.platform === c.platform) !== i);
  for (const c of dupPlatform) err(1, `Two columns map to ${c.label} ("${c.header}"). Keep one.`, { column: c.header });

  const masters = []; const mappings = []; const seenMasters = new Map();
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    if (!r.some((v) => String(v ?? '').trim())) return;
    const sku = String(r[masterCol] ?? '').trim();
    const name = String(r[nameCol] ?? '').trim();
    if (!sku) return err(row, 'Master SKU is missing.', { column: headers[masterCol] });
    if (!SKU_PATTERN.test(sku)) return err(row, `Master SKU "${sku}" is not valid (letters, numbers, - _ . / only, no spaces).`, { column: headers[masterCol], value: sku });
    const key = sku.toLowerCase();
    if (seenMasters.has(key)) return err(row, `Master SKU ${sku} appears again (first on row ${seenMasters.get(key)}).`, { column: headers[masterCol], value: sku });
    seenMasters.set(key, row);
    if (!name) err(row, `Product name is missing for ${sku}.`, { column: headers[nameCol] });
    masters.push({ row, sku, name });
    let count = 0;
    for (const c of columns) {
      const cell = r[c.index];
      for (const token of splitPlatformCell(cell)) {
        try { platformSkuInput(c.label, token); } catch (e) {
          err(row, e.message, { column: c.header, platform: c.platform, value: token, master: sku });
          continue;
        }
        // A space inside a sheet value is usually a typo (e.g. "…-4c7d- 950d-…"). Real SKUs
        // can contain spaces, so this is never "fixed" — a person confirms it on the platform.
        if (/\s/.test(token)) {
          err(row, `${c.label} SKU "${token}" contains a space. Confirm the exact value on ${c.label}; if it really has a space, add it by hand on the master SKU.`, { column: c.header, platform: c.platform, value: token, master: sku });
          continue;
        }
        if (c.platform === 'amazon' && ASIN.test(token)) {
          err(row, `Amazon value "${token}" looks like an ASIN, not a seller SKU. Confirm or replace it.`, { column: c.header, platform: c.platform, value: token, master: sku });
          continue;
        }
        if (UUIDISH.test(token) && token.split('-').length === 5 && !UUID.test(token)) {
          err(row, `${c.label} value "${token}" looks like a UUID but is malformed.`, { column: c.header, platform: c.platform, value: token, master: sku });
          continue;
        }
        mappings.push({ row, platform: c.platform, label: c.label, code: token, master: sku });
        count += 1;
      }
    }
    if (!count) warnings.push({ row, reason: `${sku} has no platform SKUs in this sheet.`, master: sku });
  });

  // Same platform SKU listed more than once: once for the same master is a
  // duplicate (kept once); for two masters it is a conflict.
  const byKey = new Map();
  for (const m of mappings) {
    const k = `${m.platform}|${m.code.toLowerCase()}`;
    (byKey.get(k) || byKey.set(k, []).get(k)).push(m);
  }
  const unique = []; let duplicates = 0;
  for (const list of byKey.values()) {
    const ms = [...new Set(list.map((m) => m.master.toLowerCase()))];
    if (ms.length > 1) {
      for (const m of list) err(m.row, `${m.label} SKU ${m.code} is listed for ${ms.length} master SKUs (${[...new Set(list.map((x) => `${x.master} row ${x.row}`))].join(', ')}). One platform SKU can map to one master only.`, { platform: m.platform, value: m.code, master: m.master, conflict: true });
      continue;
    }
    duplicates += list.length - 1;
    unique.push(list[0]);
  }
  // A platform SKU equal to another master's own code would be shadowed by it.
  for (const m of unique) {
    const owner = seenMasters.has(m.code.toLowerCase()) ? masters.find((x) => x.sku.toLowerCase() === m.code.toLowerCase()) : null;
    if (owner && owner.sku.toLowerCase() !== m.master.toLowerCase()) {
      err(m.row, `${m.label} SKU ${m.code} is also the master SKU on row ${owner.row}.`, { platform: m.platform, value: m.code, master: m.master, conflict: true });
    }
  }
  return {
    columns: columns.map(({ header, platform, label }) => ({ header, platform, label })),
    masters, mappings: unique, duplicates, errors, warnings,
  };
}

/** The sheet against what is stored: new, unchanged, renamed, conflicting. */
async function diffSkuSheet(client, plan) {
  const { rows: dbMasters } = await client.query('SELECT id, sku, product_name FROM skus WHERE lower(sku) = ANY($1)',
    [plan.masters.map((m) => m.sku.toLowerCase())]);
  const masterBy = new Map(dbMasters.map((r) => [r.sku.toLowerCase(), r]));
  const errors = [];
  const newMasters = []; const renamed = []; const sameMasters = [];
  for (const m of plan.masters) {
    const cur = masterBy.get(m.sku.toLowerCase());
    if (!cur) newMasters.push(m);
    else if (m.name && cur.product_name !== m.name) renamed.push({ ...m, id: cur.id, from: cur.product_name });
    else sameMasters.push(m);
  }
  const codes = plan.mappings.map((m) => m.code.toLowerCase());
  const { rows: dbMaps } = codes.length ? await client.query(
    `SELECT m.platform, lower(m.platform_sku) AS code, m.platform_sku, s.sku FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id
     WHERE lower(m.platform_sku) = ANY($1)`, [codes]) : { rows: [] };
  const mapBy = new Map(dbMaps.map((r) => [`${r.platform}|${r.code}`, r]));
  const { rows: asMasters } = codes.length ? await client.query('SELECT lower(sku) AS code, sku FROM skus WHERE lower(sku) = ANY($1)', [codes]) : { rows: [] };
  const masterCodes = new Map(asMasters.map((r) => [r.code, r.sku]));
  const newMaps = []; const sameMaps = [];
  for (const m of plan.mappings) {
    const cur = mapBy.get(`${m.platform}|${m.code.toLowerCase()}`);
    if (cur && cur.sku.toLowerCase() !== m.master.toLowerCase()) {
      errors.push({ row: m.row, reason: `${m.label} SKU ${m.code} already maps to master SKU ${cur.sku}; the sheet says ${m.master}. Not changed — resolve it first.`, platform: m.platform, value: m.code, master: m.master, conflict: true });
      continue;
    }
    const owner = masterCodes.get(m.code.toLowerCase());
    if (owner && owner.toLowerCase() !== m.master.toLowerCase()) {
      errors.push({ row: m.row, reason: `${m.label} SKU ${m.code} is the code of existing master SKU ${owner}.`, platform: m.platform, value: m.code, master: m.master, conflict: true });
      continue;
    }
    (cur ? sameMaps : newMaps).push(m);
  }
  // Stored mappings of these masters that the sheet does not list: kept, reported.
  const { rows: kept } = dbMasters.length ? await client.query(
    `SELECT m.platform, m.platform_sku, s.sku FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id WHERE m.sku_id = ANY($1)`,
    [dbMasters.map((r) => r.id)]) : { rows: [] };
  const inSheet = new Set(plan.mappings.map((m) => `${m.platform}|${m.code.toLowerCase()}`));
  const notInSheet = kept.filter((k) => !inSheet.has(`${k.platform}|${k.platform_sku.toLowerCase()}`));
  return { errors, newMasters, renamed, sameMasters, newMaps, sameMaps, notInSheet };
}

const summarise = (plan, d, allErrors) => {
  const perPlatform = {};
  for (const m of plan.mappings) perPlatform[m.label] = (perPlatform[m.label] || 0) + 1;
  return {
    rows: plan.masters.length,
    platformColumns: plan.columns,
    mastersNew: d.newMasters.length,
    mastersRenamed: d.renamed.length,
    mastersUnchanged: d.sameMasters.length,
    mappingsInSheet: plan.mappings.length,
    mappingsNew: d.newMaps.length,
    mappingsUnchanged: d.sameMaps.length,
    duplicateMappings: plan.duplicates,
    conflicts: allErrors.filter((e) => e.conflict).length,
    errorCount: allErrors.length,
    warningCount: plan.warnings.length,
    storedMappingsNotInSheet: d.notInSheet.length,
    perPlatform,
  };
};

async function platformsFor(client) {
  return (await client.query('SELECT key, label FROM sku_platforms WHERE active ORDER BY sort')).rows;
}

/** Reads, checks and compares. Writes nothing. */
export async function previewSkuImport(buffer, filename) {
  await ensureInventorySchema();
  const pool = getPool();
  const plan = planSkuSheet(readTable(buffer, filename), await platformsFor(pool));
  const d = await diffSkuSheet(pool, plan);
  const errors = [...plan.errors, ...d.errors].sort((a, b) => a.row - b.row);
  return {
    summary: summarise(plan, d, errors),
    errors: errors.slice(0, MAX_REPORTED),
    warnings: plan.warnings.slice(0, MAX_REPORTED),
    renamed: d.renamed.map((r) => ({ row: r.row, sku: r.sku, from: r.from, to: r.name })),
    newMasters: d.newMasters.map((m) => ({ row: m.row, sku: m.sku, name: m.name })),
    newMappings: d.newMaps.map((m) => ({ row: m.row, platform: m.label, platform_sku: m.code, master: m.master })),
    storedNotInSheet: d.notInSheet.slice(0, MAX_REPORTED),
  };
}

/** All or nothing, under a lock, re-checked inside the transaction. */
export async function commitSkuImport(buffer, filename, { actor } = {}) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('inventory:sku-import'))`);
    const plan = planSkuSheet(readTable(buffer, filename), await platformsFor(client));
    const d = await diffSkuSheet(client, plan);
    const errors = [...plan.errors, ...d.errors].sort((a, b) => a.row - b.row);
    if (errors.length) {
      throw bad(`Nothing was imported: ${errors.length} problem${errors.length > 1 ? 's' : ''} to fix first (see preview).`, 400, { importErrors: errors.slice(0, MAX_REPORTED) });
    }
    const ids = new Map();
    for (const m of d.newMasters) {
      const { rows } = await client.query(
        'INSERT INTO skus (sku, product_name, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id', [m.sku, m.name, actor]);
      ids.set(m.sku.toLowerCase(), rows[0].id);
      await audit(client, 'sku_created', { actor, skuId: rows[0].id, metadata: { sku: m.sku, product_name: m.name, source: 'import', file: filename || null } });
    }
    for (const m of d.renamed) {
      await client.query('UPDATE skus SET product_name = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [m.id, m.name, actor]);
      await audit(client, 'sku_updated', { actor, skuId: m.id, metadata: { changes: { product_name: { from: m.from, to: m.name } }, source: 'import' } });
    }
    const { rows: all } = await client.query('SELECT id, lower(sku) AS k FROM skus WHERE lower(sku) = ANY($1)', [plan.masters.map((m) => m.sku.toLowerCase())]);
    for (const r of all) ids.set(r.k, r.id);
    for (const m of d.newMaps) {
      await client.query(
        'INSERT INTO sku_platform_mappings (sku_id, platform, platform_sku, source, created_by) VALUES ($1, $2, $3, $4, $5)',
        [ids.get(m.master.toLowerCase()), m.platform, m.code, 'import', actor]);
    }
    let orderItemsMapped = 0;
    for (const id of new Set(ids.values())) orderItemsMapped += await remapOrderItems(client, id);
    const summary = { ...summarise(plan, d, []), orderItemsMapped };
    await audit(client, 'sku_master_import', { actor, metadata: { file: filename || null, ...summary } });
    return { summary, warnings: plan.warnings.slice(0, MAX_REPORTED) };
  });
}
