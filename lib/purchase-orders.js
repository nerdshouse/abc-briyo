/**
 * Purchase orders: what was ordered from a manufacturer, what actually arrived, and what is still pending.
 *
 *   PO        number (Briyo's own: BR + year + month letter + series, e.g. BR26N12 — suggested, editable, unique), date,
 *             manufacturer (a supplier) and its unit / location, expected date, remarks.
 *   lines     one per product: master SKU, pack size (30 / 60 / 90 …) and pack type (bottle / carton / sachet …) as on
 *             this PO, packs ordered, MRP; capsule (unit) quantity = packs × pack size.
 *   receipts  each delivery against a line, received straight into stock in one step: packs received, of which damaged
 *             (never stocked), batch, mfg / expiry dates, MRP, warehouse, what was wrong (short, excess, damaged,
 *             missing, other) and remarks. The good packs go in through receiveTx — the same batch rule and ledger row as
 *             Add inventory — so the batch, its MRP and its COA (uploaded once QC clears) live in Inventory as usual.
 *
 * Status per line: pending, partly received, received, over-received; a PO closed with packs still pending is
 * "closed short". Open POs' pending packs count as incoming stock for the stock alerts (lib/inventory-inbound.js).
 * A received delivery is history: corrections are stock adjustments in Inventory. Every write is audited.
 */
import { getPool, getSystemState, recordSystemEvent } from './db.js';
import { inTransaction, teamTimezone } from './orders.js';
import { ensureInventorySchema, receiveTx, audit, idOf, intOf, cleanText as text, requestKey } from './inventory.js';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const PACK_TYPES = ['bottle', 'jar', 'carton', 'sachet', 'strip', 'pouch', 'other'];
/** What one pack holds, as the PO's packing style says it ("60 Caps"). */
export const UNIT_LABELS = ['Caps', 'Softgels', 'Tabs', 'Sachets', 'Gummies', 'ml', 'g'];
export const DISCREPANCIES = { short: 'Short quantity', excess: 'Excess quantity', damaged: 'Damaged', missing: 'Missing products', other: 'Other' };
/**
 * Month letters for suggested PO numbers: the month's first letter (J F M A M J J A S O N D — November is N, as the
 * team writes BR26N12), unless PO_MONTH_LETTERS gives 12 of its own. The series, not the letter, makes a number unique.
 */
const monthLetters = () => {
  const own = String(process.env.PO_MONTH_LETTERS || '').trim().toUpperCase();
  return /^[A-Z]{12}$/.test(own) ? own : 'JFMAMJJASOND';
};
const todayIst = (tz = teamTimezone()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const dateOf = (v, label) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad(`${label} is not a valid date.`);
  return s;
};
const money = (v, label) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad(`${label} must be an amount like 495 or 495.50.`);
  return Number(s);
};

let schema = null;
export async function ensurePurchaseOrders() {
  await ensureInventorySchema();
  if (!schema) {
    schema = getPool().query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id               BIGSERIAL PRIMARY KEY,
        po_number        TEXT NOT NULL CHECK (btrim(po_number) <> ''),
        po_date          DATE NOT NULL,
        supplier_id      BIGINT NOT NULL REFERENCES suppliers(id),
        manufacturer_unit TEXT,
        expected_date    DATE,
        remarks          TEXT,
        payment_terms    TEXT,
        transport        TEXT,
        booking_station  TEXT,
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
        closed_reason    TEXT,
        version          INTEGER NOT NULL DEFAULT 1,
        created_by       TEXT NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by       TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_number_key ON purchase_orders (lower(po_number));
      CREATE TABLE IF NOT EXISTS purchase_order_lines (
        id           BIGSERIAL PRIMARY KEY,
        po_id        BIGINT NOT NULL REFERENCES purchase_orders(id),
        sku_id       BIGINT NOT NULL REFERENCES skus(id),
        pack_size    INTEGER NOT NULL CHECK (pack_size > 0),
        pack_type    TEXT NOT NULL,
        ordered_qty  INTEGER NOT NULL CHECK (ordered_qty > 0),
        unit_label   TEXT NOT NULL DEFAULT 'Caps',
        unit_price   NUMERIC(12,2) CHECK (unit_price >= 0),
        gst_pct      NUMERIC(5,2) CHECK (gst_pct >= 0 AND gst_pct <= 40),
        mrp          NUMERIC(12,2) CHECK (mrp >= 0),
        remarks      TEXT,
        position     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx ON purchase_order_lines (po_id);
      CREATE INDEX IF NOT EXISTS purchase_order_lines_sku_idx ON purchase_order_lines (sku_id);
      CREATE TABLE IF NOT EXISTS purchase_order_receipts (
        id             BIGSERIAL PRIMARY KEY,
        line_id        BIGINT NOT NULL REFERENCES purchase_order_lines(id),
        received_qty   INTEGER NOT NULL CHECK (received_qty >= 0),
        damaged_qty    INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0 AND damaged_qty <= received_qty),
        batch_number   TEXT NOT NULL CHECK (btrim(batch_number) <> ''),
        mfg_date       DATE,
        expiry_date    DATE,
        mrp            NUMERIC(12,2) CHECK (mrp >= 0),
        warehouse_id   BIGINT REFERENCES warehouses(id),
        received_date  DATE NOT NULL,
        discrepancies  TEXT[] NOT NULL DEFAULT '{}',
        remarks        TEXT,
        batch_id       BIGINT REFERENCES inventory_batches(id),
        movement_id    BIGINT,
        request_key    TEXT UNIQUE,
        received_by    TEXT NOT NULL,
        received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (mfg_date IS NULL OR expiry_date IS NULL OR mfg_date <= expiry_date),
        CHECK (received_qty > 0 OR cardinality(discrepancies) > 0)
      );
      CREATE INDEX IF NOT EXISTS purchase_order_receipts_line_idx ON purchase_order_receipts (line_id);
      -- The manufacturer's address and GST number, printed on the PO (kept on the supplier, so the next PO has them).
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS gstin TEXT;`).catch((err) => { schema = null; throw err; });
  }
  return schema;
}

// ------------------------------------------------------------------ numbers

/** BR + 2-digit year + month letter + series (the year's highest series + 1), e.g. BR26N13. A suggestion only. */
export async function suggestPoNumber(db = getPool(), now = new Date()) {
  await ensurePurchaseOrders();
  const ist = todayIst();
  const yy = ist.slice(2, 4);
  const letter = monthLetters()[Number(ist.slice(5, 7)) - 1];
  const { rows } = await db.query(`SELECT po_number FROM purchase_orders WHERE po_number ~* $1`, [`^BR${yy}[A-Z][0-9]+$`]);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.po_number.match(/(\d+)$/)[1])), 0);
  void now;
  return `BR${yy}${letter}${max + 1}`;
}

// ------------------------------------------------------------------ reading

const LINE_SQL = `
  SELECT l.*, s.sku, s.product_name, s.variant_name, s.unit_type,
         coalesce(r.received, 0)::int AS received_qty, coalesce(r.damaged, 0)::int AS damaged_qty, coalesce(r.receipts, 0)::int AS receipts
    FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
    LEFT JOIN (SELECT line_id, sum(received_qty) AS received, sum(damaged_qty) AS damaged, count(*) AS receipts
                 FROM purchase_order_receipts GROUP BY line_id) r ON r.line_id = l.id`;

/** A line's state from what it ordered and received (and whether its PO is closed or cancelled). */
export function lineState(l, poStatus = 'open') {
  const pending = Math.max(l.ordered_qty - l.received_qty, 0);
  const excess = Math.max(l.received_qty - l.ordered_qty, 0);
  const state = poStatus === 'cancelled' ? 'cancelled'
    : excess > 0 ? 'over_received'
      : pending === 0 ? 'received'
        : poStatus === 'closed' ? 'closed_short'
          : l.received_qty > 0 ? 'partly_received' : 'pending';
  return { pending_qty: poStatus === 'open' ? pending : 0, short_qty: poStatus === 'closed' ? pending : 0, excess_qty: excess, state };
}

const r2 = (n) => Math.round(n * 100) / 100;
const toLine = (l, poStatus) => {
  const price = l.unit_price === null ? null : Number(l.unit_price);
  const gst = l.gst_pct === null ? null : Number(l.gst_pct);
  const taxable = price === null ? null : r2(price * l.ordered_qty);
  const gstAmt = taxable === null || gst === null ? null : r2(taxable * gst / 100);
  return {
  id: Number(l.id), sku_id: Number(l.sku_id), sku: l.sku, product_name: l.product_name, variant_name: l.variant_name, unit_type: l.unit_type,
  pack_size: l.pack_size, pack_type: l.pack_type, unit_label: l.unit_label, ordered_qty: l.ordered_qty, unit_qty: l.ordered_qty * l.pack_size,
  unit_price: price, gst_pct: gst, taxable, gst_amount: gstAmt, total: taxable === null ? null : r2(taxable + (gstAmt || 0)),
  mrp: l.mrp === null ? null : Number(l.mrp), remarks: l.remarks, received_qty: l.received_qty, damaged_qty: l.damaged_qty,
  stocked_qty: l.received_qty - l.damaged_qty, receipts: l.receipts, ...lineState(l, poStatus),
  };
};

/** The overall state of a PO from its lines. */
const poState = (po, lines) => (po.status !== 'open' ? (po.status === 'closed' && lines.some((l) => l.short_qty) ? 'closed_short' : po.status)
  : !lines.length || lines.every((l) => l.state === 'pending') ? 'open'
    : lines.every((l) => ['received', 'over_received'].includes(l.state)) ? 'received' : 'partly_received');

export async function listPurchaseOrders({ status = '', supplier = '', q = '' } = {}) {
  await ensurePurchaseOrders();
  const { rows: pos } = await getPool().query(
    `SELECT p.*, p.po_date::text AS po_date, p.expected_date::text AS expected_date, sp.name AS supplier_name
       FROM purchase_orders p JOIN suppliers sp ON sp.id = p.supplier_id
      WHERE ($1 = '' OR p.supplier_id::text = $1)
        AND ($2 = '' OR p.po_number ILIKE '%' || $2 || '%' OR EXISTS (SELECT 1 FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
               WHERE l.po_id = p.id AND (s.sku ILIKE '%' || $2 || '%' OR s.product_name ILIKE '%' || $2 || '%')))
      ORDER BY p.po_date DESC, p.id DESC LIMIT 500`, [String(supplier || ''), String(q || '').trim()]);
  const ids = pos.map((p) => Number(p.id));
  const { rows: lines } = ids.length ? await getPool().query(`${LINE_SQL} WHERE l.po_id = ANY($1) ORDER BY l.position, l.id`, [ids]) : { rows: [] };
  const out = pos.map((p) => {
    const ls = lines.filter((l) => Number(l.po_id) === Number(p.id)).map((l) => toLine(l, p.status));
    const sum = (k) => ls.reduce((n, l) => n + l[k], 0);
    return {
      id: Number(p.id), po_number: p.po_number, po_date: p.po_date, supplier_id: Number(p.supplier_id), supplier_name: p.supplier_name,
      manufacturer_unit: p.manufacturer_unit, expected_date: p.expected_date, status: p.status, state: poState(p, ls),
      lines: ls.length, products: ls.map((l) => l.sku), ordered_qty: sum('ordered_qty'), received_qty: sum('received_qty'),
      pending_qty: sum('pending_qty'), short_qty: sum('short_qty'), excess_qty: sum('excess_qty'), damaged_qty: sum('damaged_qty'),
    };
  });
  return status ? out.filter((p) => p.state === status || (status === 'active' && ['open', 'partly_received'].includes(p.state))) : out;
}

export async function getPurchaseOrder(id, db = getPool()) {
  await ensurePurchaseOrders();
  const { rows: [p] } = await db.query(
    `SELECT p.*, p.po_date::text AS po_date, p.expected_date::text AS expected_date, sp.name AS supplier_name, sp.reference AS supplier_reference,
            sp.address AS supplier_address, sp.gstin AS supplier_gstin
       FROM purchase_orders p JOIN suppliers sp ON sp.id = p.supplier_id WHERE p.id = $1`, [idOf(id)]);
  if (!p) return null;
  const { rows: lines } = await db.query(`${LINE_SQL} WHERE l.po_id = $1 ORDER BY l.position, l.id`, [p.id]);
  const { rows: receipts } = await db.query(
    `SELECT r.*, r.mfg_date::text AS mfg_date, r.expiry_date::text AS expiry_date, r.received_date::text AS received_date, w.name AS warehouse_name,
            (SELECT json_agg(json_build_object('id', d.id, 'type', d.document_type, 'filename', d.original_filename) ORDER BY d.id)
               FROM batch_documents d WHERE d.batch_id = r.batch_id AND d.removed_at IS NULL) AS documents
       FROM purchase_order_receipts r JOIN purchase_order_lines l ON l.id = r.line_id LEFT JOIN warehouses w ON w.id = r.warehouse_id
      WHERE l.po_id = $1 ORDER BY r.received_date, r.id`, [p.id]);
  const ls = lines.map((l) => toLine(l, p.status));
  return {
    id: Number(p.id), po_number: p.po_number, po_date: p.po_date, supplier_id: Number(p.supplier_id), supplier_name: p.supplier_name,
    manufacturer_unit: p.manufacturer_unit, expected_date: p.expected_date, remarks: p.remarks, status: p.status, closed_reason: p.closed_reason,
    supplier_address: p.supplier_address, supplier_gstin: p.supplier_gstin, payment_terms: p.payment_terms, transport: p.transport, booking_station: p.booking_station,
    totals: { taxable: r2(ls.reduce((n, l) => n + (l.taxable || 0), 0)), gst: r2(ls.reduce((n, l) => n + (l.gst_amount || 0), 0)), total: r2(ls.reduce((n, l) => n + (l.total || 0), 0)),
      priced: ls.every((l) => l.unit_price !== null) },
    state: poState(p, ls), version: p.version, created_by: p.created_by, created_at: p.created_at, updated_by: p.updated_by, updated_at: p.updated_at,
    lines: ls.map((l) => ({ ...l, receipts: receipts.filter((r) => Number(r.line_id) === l.id).map((r) => ({
      id: Number(r.id), received_qty: r.received_qty, damaged_qty: r.damaged_qty, stocked_qty: r.received_qty - r.damaged_qty,
      batch_number: r.batch_number, batch_id: r.batch_id === null ? null : Number(r.batch_id), mfg_date: r.mfg_date, expiry_date: r.expiry_date,
      mrp: r.mrp === null ? null : Number(r.mrp), warehouse_name: r.warehouse_name, received_date: r.received_date,
      discrepancies: r.discrepancies, remarks: r.remarks, received_by: r.received_by, received_at: r.received_at,
      documents: (r.documents || []).map((d) => ({ ...d, id: Number(d.id) })),
      coa: (r.documents || []).some((d) => d.type === 'coa'),
    })) })),
  };
}

/** Every delivery, newest first, for the "Received" history and its CSV. Filters: supplier, sku, from / to dates. */
export async function receiptHistory({ supplier = '', sku = '', from = '', to = '' } = {}) {
  await ensurePurchaseOrders();
  const { rows } = await getPool().query(
    `SELECT r.id, r.received_date::text AS received_date, p.id AS po_id, p.po_number, sp.name AS supplier_name, p.manufacturer_unit,
            s.sku, s.product_name, l.pack_size, l.pack_type, l.ordered_qty, r.received_qty, r.damaged_qty, r.batch_number,
            r.mfg_date::text AS mfg_date, r.expiry_date::text AS expiry_date, coalesce(r.mrp, l.mrp) AS mrp, r.discrepancies, r.remarks, r.received_by,
            EXISTS (SELECT 1 FROM batch_documents d WHERE d.batch_id = r.batch_id AND d.document_type = 'coa' AND d.removed_at IS NULL) AS coa
       FROM purchase_order_receipts r JOIN purchase_order_lines l ON l.id = r.line_id JOIN purchase_orders p ON p.id = l.po_id
       JOIN suppliers sp ON sp.id = p.supplier_id JOIN skus s ON s.id = l.sku_id
      WHERE ($1 = '' OR p.supplier_id::text = $1) AND ($2 = '' OR l.sku_id::text = $2)
        AND ($3 = '' OR r.received_date >= $3::date) AND ($4 = '' OR r.received_date <= $4::date)
      ORDER BY r.received_date DESC, r.id DESC LIMIT 2000`, [String(supplier || ''), String(sku || ''), String(from || ''), String(to || '')]);
  return rows.map((r) => ({ ...r, id: Number(r.id), po_id: Number(r.po_id), mrp: r.mrp === null ? null : Number(r.mrp) }));
}

/** Active manufacturers with the address and GST number last used on a PO. */
export async function poSuppliers() {
  await ensurePurchaseOrders();
  const { rows } = await getPool().query('SELECT id, name, address, gstin FROM suppliers WHERE active ORDER BY lower(name)');
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// ------------------------------------------------------------------ writing

function linesInput(list) {
  if (!Array.isArray(list) || !list.length) throw bad('Add at least one product.');
  if (list.length > 50) throw bad('Up to 50 products on one PO.');
  const seen = new Set();
  return list.map((l, i) => {
    const skuId = idOf(l.sku_id);
    if (!skuId) throw bad(`Line ${i + 1}: choose the product.`);
    const packType = String(l.pack_type || '').trim().toLowerCase();
    if (!PACK_TYPES.includes(packType)) throw bad(`Line ${i + 1}: choose the packing type (${PACK_TYPES.join(', ')}).`);
    const key = `${skuId}|${l.pack_size}|${packType}`;
    if (seen.has(key)) throw bad(`Line ${i + 1}: the same product and pack is listed twice.`);
    seen.add(key);
    const unitLabel = String(l.unit_label || 'Caps').trim();
    if (!UNIT_LABELS.includes(unitLabel)) throw bad(`Line ${i + 1}: choose what a pack holds (${UNIT_LABELS.join(', ')}).`);
    const gstRaw = String(l.gst_pct ?? '').trim();
    if (gstRaw && (!/^\d+(\.\d{1,2})?$/.test(gstRaw) || Number(gstRaw) > 40)) throw bad(`Line ${i + 1}: GST % must be a number like 5, 12 or 18.`);
    return {
      unit_label: unitLabel, unit_price: money(l.unit_price, `Line ${i + 1}: unit price`), gst_pct: gstRaw ? Number(gstRaw) : null,
      sku_id: skuId, pack_size: intOf(l.pack_size, `Line ${i + 1}: pack size`, { min: 1 }), pack_type: packType,
      ordered_qty: intOf(l.ordered_qty, `Line ${i + 1}: quantity ordered`, { min: 1 }), mrp: money(l.mrp, `Line ${i + 1}: MRP`),
      remarks: text(l.remarks, 500), position: i,
    };
  });
}

function headerInput(input, { creating }) {
  const out = {};
  if (creating || input.po_number !== undefined) {
    out.po_number = text(input.po_number, 40)?.toUpperCase();
    if (!out.po_number) throw bad('Enter the PO number.');
    if (!/^[A-Z0-9][A-Z0-9/_-]*$/.test(out.po_number)) throw bad('The PO number can have letters, digits, / - and _ only (e.g. BR26N12).');
  }
  if (creating || input.po_date !== undefined) {
    out.po_date = dateOf(input.po_date, 'PO date') || todayIst();
  }
  if (creating || input.supplier_id !== undefined) {
    out.supplier_id = idOf(input.supplier_id);
    if (!out.supplier_id) throw bad('Choose the manufacturer.');
  }
  if (input.manufacturer_unit !== undefined || creating) out.manufacturer_unit = text(input.manufacturer_unit, 160);
  if (input.expected_date !== undefined || creating) out.expected_date = dateOf(input.expected_date, 'Expected date');
  if (input.remarks !== undefined || creating) out.remarks = text(input.remarks, 2000);
  if (input.payment_terms !== undefined || creating) out.payment_terms = text(input.payment_terms, 300);
  if (input.transport !== undefined || creating) out.transport = text(input.transport, 160);
  if (input.booking_station !== undefined || creating) out.booking_station = text(input.booking_station, 120);
  return out;
}

const dupNumber = (err, n) => { if (err.code === '23505') throw bad(`PO number ${n} is already used. Choose another.`, 409, { duplicate: true }); throw err; };

const insertLine = (client, poId, l) => client.query(
  `INSERT INTO purchase_order_lines (po_id, sku_id, pack_size, pack_type, unit_label, ordered_qty, unit_price, gst_pct, mrp, remarks, position)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [poId, l.sku_id, l.pack_size, l.pack_type, l.unit_label, l.ordered_qty, l.unit_price, l.gst_pct, l.mrp, l.remarks, l.position]);

/** The manufacturer's address / GST number given on a PO are kept on the supplier (the next PO starts with them). */
async function saveSupplierDetails(client, supplierId, input) {
  const sets = []; const vals = [];
  if (input.supplier_address !== undefined) { vals.push(text(input.supplier_address, 600)); sets.push(`address = $${vals.length + 1}`); }
  if (input.supplier_gstin !== undefined) {
    const g = text(input.supplier_gstin, 20)?.toUpperCase() || null;
    if (g && !/^[0-9]{2}[A-Z0-9]{13}$/.test(g)) throw bad('The manufacturer GST number should be 15 characters, e.g. 24AACCB5247K1ZP.');
    vals.push(g); sets.push(`gstin = $${vals.length + 1}`);
  }
  if (sets.length) await client.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, [supplierId, ...vals]);
}

export async function createPurchaseOrder(input = {}, { actor }) {
  await ensurePurchaseOrders();
  const h = headerInput(input, { creating: true });
  const lines = linesInput(input.lines);
  return inTransaction(async (client) => {
    if (!(await client.query('SELECT 1 FROM suppliers WHERE id = $1', [h.supplier_id])).rows.length) throw bad('Unknown manufacturer.');
    const { rows: bad2 } = await client.query('SELECT id FROM skus WHERE id = ANY($1) AND (NOT active OR EXISTS (SELECT 1 FROM sku_bundle_components c WHERE c.bundle_sku_id = skus.id))', [lines.map((l) => l.sku_id)]);
    if (bad2.length) throw bad('A product on this PO is inactive or a bundle. Order its contents instead.');
    const { rows: [p] } = await client.query(
      `INSERT INTO purchase_orders (po_number, po_date, supplier_id, manufacturer_unit, expected_date, remarks, payment_terms, transport, booking_station, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
      [h.po_number, h.po_date, h.supplier_id, h.manufacturer_unit, h.expected_date, h.remarks, h.payment_terms, h.transport, h.booking_station, actor]).catch((err) => dupNumber(err, h.po_number));
    await saveSupplierDetails(client, h.supplier_id, input);
    for (const l of lines) {
      await insertLine(client, p.id, l);
    }
    await audit(client, 'purchase_order_created', { actor, metadata: { po_id: Number(p.id), po_number: h.po_number, lines: lines.length } });
    return getPurchaseOrder(p.id, client);
  });
}

/**
 * Edits an open PO against its version: header fields any time; lines (all of them, replaced) only while nothing has
 * been received against the PO.
 */
export async function updatePurchaseOrder(id, input = {}, { actor, version } = {}) {
  await ensurePurchaseOrders();
  const h = headerInput(input, { creating: false });
  const lines = input.lines !== undefined ? linesInput(input.lines) : null;
  return inTransaction(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [idOf(id)]);
    if (!p) throw bad('No such PO.', 404);
    if (Number(version) !== p.version) throw bad(`${p.updated_by || 'Someone'} changed this PO while you had it open. Reload to see their change.`, 409, { conflict: true });
    if (p.status !== 'open') throw bad(`This PO is ${p.status}; it can no longer be edited.`, 409);
    if (h.supplier_id && !(await client.query('SELECT 1 FROM suppliers WHERE id = $1', [h.supplier_id])).rows.length) throw bad('Unknown manufacturer.');
    await saveSupplierDetails(client, h.supplier_id || p.supplier_id, input);
    const keys = Object.keys(h);
    if (keys.length) {
      await client.query(`UPDATE purchase_orders SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1`,
        [p.id, actor, ...keys.map((k) => h[k])]).catch((err) => dupNumber(err, h.po_number));
    }
    if (lines) {
      const { rows: [r] } = await client.query('SELECT count(*)::int n FROM purchase_order_receipts x JOIN purchase_order_lines l ON l.id = x.line_id WHERE l.po_id = $1', [p.id]);
      if (r.n) throw bad('Stock has already been received on this PO, so its products cannot be changed. Close it and raise a new PO for anything else.', 409);
      await client.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [p.id]);
      for (const l of lines) {
        await insertLine(client, p.id, l);
      }
      if (!keys.length) await client.query('UPDATE purchase_orders SET version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1', [p.id, actor]);
    }
    await audit(client, 'purchase_order_updated', { actor, metadata: { po_id: Number(p.id), fields: keys, lines: lines ? lines.length : undefined } });
    return getPurchaseOrder(p.id, client);
  });
}

/** Closes an open PO (whatever is still pending is "short"), or cancels one nothing was received on. A reason is required. */
export async function setPurchaseOrderStatus(id, status, { actor, reason, version } = {}) {
  await ensurePurchaseOrders();
  if (!['closed', 'cancelled'].includes(status)) throw bad('Close or cancel the PO.');
  const why = text(reason, 500);
  if (!why) throw bad(status === 'closed' ? 'Say why the PO is closed (e.g. manufacturer cannot supply the rest).' : 'Say why the PO is cancelled.');
  return inTransaction(async (client) => {
    const { rows: [p] } = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [idOf(id)]);
    if (!p) throw bad('No such PO.', 404);
    if (version !== undefined && Number(version) !== p.version) throw bad('This PO changed while you had it open. Reload to see the change.', 409, { conflict: true });
    if (p.status !== 'open') throw bad(`This PO is already ${p.status}.`, 409);
    if (status === 'cancelled') {
      const { rows: [r] } = await client.query('SELECT count(*)::int n FROM purchase_order_receipts x JOIN purchase_order_lines l ON l.id = x.line_id WHERE l.po_id = $1', [p.id]);
      if (r.n) throw bad('Stock has been received on this PO, so it cannot be cancelled. Close it instead.', 409);
    }
    await client.query('UPDATE purchase_orders SET status = $2, closed_reason = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1', [p.id, status, why, actor]);
    await audit(client, `purchase_order_${status}`, { actor, metadata: { po_id: Number(p.id), po_number: p.po_number, reason: why } });
    return getPurchaseOrder(p.id, client);
  });
}

/**
 * One delivery against a PO line, straight into stock: received − damaged packs go into the batch (receiveTx, with
 * the PO number, manufacturer, MRP and dates); damaged packs are recorded, never stocked. A delivery of 0 good packs
 * (all damaged, or a "missing" note) records the receipt only. `request_id` makes a retry a no-op.
 */
export async function receiveAgainstLine(lineId, input = {}, { actor }) {
  await ensurePurchaseOrders();
  const received = intOf(input.received_qty, 'Packs received', { min: 0 });
  const damaged = String(input.damaged_qty ?? '').trim() === '' ? 0 : intOf(input.damaged_qty, 'Damaged packs', { min: 0 });
  if (damaged > received) throw bad('Damaged packs cannot be more than the packs received.');
  const batch = text(input.batch_number, 80);
  if (!batch) throw bad('Enter the batch number.');
  const mfg = dateOf(input.mfg_date, 'Manufacturing date');
  const exp = dateOf(input.expiry_date, 'Expiry date');
  if (mfg && exp && mfg > exp) throw bad('Expiry date is before the manufacturing date.');
  const receivedDate = dateOf(input.received_date, 'Received date') || todayIst();
  if (receivedDate > todayIst()) throw bad('The received date cannot be in the future.');
  const discrepancies = [...new Set((Array.isArray(input.discrepancies) ? input.discrepancies : []).map(String))];
  if (discrepancies.some((d) => !DISCREPANCIES[d])) throw bad('Unknown discrepancy type.');
  if (damaged && !discrepancies.includes('damaged')) discrepancies.push('damaged');
  const remarks = text(input.remarks, 2000);
  if (discrepancies.length && !remarks) throw bad('Describe what was wrong in the remarks (e.g. 20 bottles short, carton torn).');
  if (!received && !discrepancies.length) throw bad('Enter the packs received.');
  const mrp = money(input.mrp, 'MRP');
  const key = requestKey('po-receipt', input.request_id);
  return inTransaction(async (client) => {
    if (key) {
      const { rows: [prior] } = await client.query('SELECT id FROM purchase_order_receipts WHERE request_key = $1', [key]);
      if (prior) return { receiptId: Number(prior.id), repeated: true };
    }
    const { rows: [l] } = await client.query(
      `SELECT l.*, p.status, p.po_number, p.supplier_id, p.id AS po_id FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id
        WHERE l.id = $1 FOR UPDATE OF p`, [idOf(lineId)]);
    if (!l) throw bad('No such PO line.', 404);
    if (l.status !== 'open') throw bad(`PO ${l.po_number} is ${l.status}; nothing more can be received on it.`, 409);
    const good = received - damaged;
    let batchId = null; let movementId = null;
    if (good > 0) {
      const r = await receiveTx(client, {
        sku_id: l.sku_id, batch_number: batch, mfg_date: mfg, expiry_date: exp, quantity: good, mrp: mrp ?? l.mrp,
        warehouse_id: input.warehouse_id, supplier_id: l.supplier_id, po_number: l.po_number, received_date: receivedDate, notes: remarks,
      }, { actor, key: key ? `${key}:stock` : null, referenceType: 'purchase_order', referenceId: l.po_number });
      batchId = r.batchId; movementId = r.movementId;
    }
    const { rows: [rc] } = await client.query(
      `INSERT INTO purchase_order_receipts (line_id, received_qty, damaged_qty, batch_number, mfg_date, expiry_date, mrp, warehouse_id, received_date,
         discrepancies, remarks, batch_id, movement_id, request_key, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [l.id, received, damaged, batch, mfg, exp, mrp ?? l.mrp, idOf(input.warehouse_id), receivedDate, discrepancies, remarks, batchId, movementId, key, actor]);
    await audit(client, 'purchase_order_received', { actor, skuId: Number(l.sku_id), batchId, metadata: { po_id: Number(l.po_id), po_number: l.po_number, line_id: Number(l.id), received, damaged, discrepancies } });
    return { receiptId: Number(rc.id), batchId, movementId, stocked: good };
  });
}

/** Pending packs of open POs, per master SKU (the stock alerts count them as incoming). */
export async function poPendingBySku(db = getPool()) {
  const { rows: [t] } = await db.query(`SELECT to_regclass('purchase_order_lines') AS t`);
  if (!t.t) return new Map();
  const { rows } = await db.query(
    `SELECT l.sku_id, sum(greatest(l.ordered_qty - coalesce(r.received, 0), 0))::int AS pending
       FROM purchase_order_lines l JOIN purchase_orders p ON p.id = l.po_id AND p.status = 'open'
       LEFT JOIN (SELECT line_id, sum(received_qty) AS received FROM purchase_order_receipts GROUP BY line_id) r ON r.line_id = l.id
      GROUP BY l.sku_id`);
  return new Map(rows.filter((r) => r.pending > 0).map((r) => [Number(r.sku_id), r.pending]));
}

// ------------------------------------------------------------------ print header

const COMPANY_KEY = 'po_company';
export const DEFAULT_COMPANY = { name: 'Briyo Supplements LLP', address: '', gstin: '', cst_no: '', dl_numbers: '', phone: '', email: '', terms: '' };
export async function getPoCompany() {
  const row = await getSystemState(COMPANY_KEY).catch(() => null);
  try { return { ...DEFAULT_COMPANY, ...(row?.value ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULT_COMPANY }; }
}
export async function savePoCompany(input = {}, { actor }) {
  const next = {
    name: text(input.name, 160) || DEFAULT_COMPANY.name, address: text(input.address, 600), gstin: text(input.gstin, 20)?.toUpperCase() || null,
    cst_no: text(input.cst_no, 40), dl_numbers: text(input.dl_numbers, 200),
    phone: text(input.phone, 40), email: text(input.email, 120), terms: text(input.terms, 2000),
  };
  await recordSystemEvent(COMPANY_KEY, JSON.stringify(next));
  await inTransaction((c) => audit(c, 'po_company_saved', { actor, metadata: { name: next.name } }));
  return next;
}
