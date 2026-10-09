/**
 * Inventory: alternative variants, stock returns and incoming stock.
 *
 * None of this keeps its own stock figure. Stock moves only through the ledger (lib/inventory.js writeMovement):
 *   - a return is a `customer_return` movement — into the batch it came from when sellable, or into a held batch
 *     (quarantined, or blocked when damaged) that is never available;
 *   - incoming stock is an expectation only; a receipt is recorded as it arrives and becomes stock only when someone
 *     accepts it (receiveTx: the same batch rule and `received` movement as Receive stock).
 * Alternatives are information: they never move stock and never change an order.
 *
 * Every write is in one transaction, locks what it changes, and is idempotent by a request key where a retry or a
 * double click could repeat it.
 */
import { getPool } from './db.js';
import { inTransaction, teamTimezone } from './orders.js';
import {
  ensureInventorySchema, writeMovement, audit, dateOf, receiveTx, priorMovement, requestKey, supplierFor,
  cleanText as text, intOf, idOf, getSku,
} from './inventory.js';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const todayIst = (tz = teamTimezone()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

/* ------------------------------------------------------------------ alternatives */

/** The SKU's alternatives, each with its own current stock (never shared, never added up). */
export async function listAlternatives(skuId, { tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    `SELECT a.id, a.alternative_sku_id, a.note, a.created_at, a.created_by FROM sku_alternatives a
      WHERE a.sku_id = $1 ORDER BY a.id`, [skuId]);
  const out = [];
  for (const r of rows) {
    const s = await getSku(Number(r.alternative_sku_id), { tz });
    if (!s) continue;
    out.push({ id: Number(r.id), sku_id: s.id, sku: s.sku, product_name: s.product_name, variant_name: s.variant_name, unit_type: s.unit_type,
      active: s.active, available: s.available, reserved: s.reserved, out_of_stock: s.out_of_stock, low_stock: s.low_stock,
      note: r.note, created_at: r.created_at, created_by: r.created_by });
  }
  return out;
}

/** Links an alternative (informational). Both SKUs must exist; a SKU is never its own alternative. */
export async function addAlternative(skuId, input, { actor }) {
  await ensureInventorySchema();
  const altId = idOf(input.alternative_sku_id);
  if (!idOf(skuId) || !altId) throw bad('Choose the alternative SKU.');
  if (Number(skuId) === altId) throw bad('A SKU cannot be its own alternative.');
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, sku FROM skus WHERE id = ANY($1)', [[Number(skuId), altId]]);
    if (rows.length !== 2) throw bad('Unknown SKU.', 404);
    try {
      const { rows: [r] } = await client.query(
        'INSERT INTO sku_alternatives (sku_id, alternative_sku_id, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [Number(skuId), altId, text(input.note, 300), actor]);
      await audit(client, 'alternative_added', { actor, skuId: Number(skuId), metadata: { alternative_sku_id: altId, note: text(input.note, 300) } });
      return { id: Number(r.id) };
    } catch (err) {
      if (err.code === '23505') throw bad('That SKU is already listed as an alternative.', 409, { conflict: true });
      throw err;
    }
  });
}

export async function removeAlternative(linkId, { actor }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows: [r] } = await client.query('DELETE FROM sku_alternatives WHERE id = $1 RETURNING sku_id, alternative_sku_id', [linkId]);
    if (!r) throw bad('That alternative is no longer listed.', 404);
    await audit(client, 'alternative_removed', { actor, skuId: Number(r.sku_id), metadata: { alternative_sku_id: Number(r.alternative_sku_id) } });
    return { removed: true };
  });
}

/* ------------------------------------------------------------------ returns */

export const RETURN_SOURCES = {
  customer: 'Customer', courier_rto: 'Courier RTO', marketplace: 'Marketplace', retailer: 'Retailer / partner',
  stock_outward: 'Stock outward', other: 'Other',
};
export const RETURN_CONDITIONS = {
  sellable: 'Sellable — back into available stock',
  damaged: 'Damaged — held, never available',
  quarantined: 'Quarantined — held for inspection, not available',
};
const HOLD_STATUS = { damaged: 'blocked', quarantined: 'quarantined' };

/**
 * Records returned stock. Sellable units go back into the batch they came from (it must be the SKU's, and sellable
 * itself — an expired or held batch is refused: record those units as damaged or quarantined). Damaged and
 * quarantined units go into a held batch of their own (batch number "<source batch>-RET<id>", status blocked or
 * quarantined, the source batch's dates copied, never guessed), so on hand stays true while available does not
 * change. The same reference for the same SKU again is refused unless confirmed with a reason; the same request_id is
 * a no-op that returns the first result.
 */
export async function recordReturn(input, { actor }) {
  await ensureInventorySchema();
  const skuId = idOf(input.sku_id);
  if (!skuId) throw bad('Choose the SKU.');
  const quantity = intOf(input.quantity, 'Quantity', { min: 1 });
  const condition = String(input.condition || '');
  if (!RETURN_CONDITIONS[condition]) throw bad('Choose the condition: sellable, damaged or quarantined.');
  const source = String(input.source || '');
  if (!RETURN_SOURCES[source]) throw bad('Choose where the stock came back from.');
  const returnedBy = text(input.returned_by, 160);
  if (!returnedBy) throw bad('Enter who returned it (a person or an organisation).');
  const reason = text(input.reason, 300);
  if (!reason) throw bad('Say why it was returned.');
  const returnDate = dateOf(input.return_date, 'Return date') || todayIst();
  if (returnDate > todayIst()) throw bad('The return date cannot be in the future.');
  const reference = text(input.reference, 80);
  const remarks = text(input.remarks, 1000);
  const sourceBatchId = idOf(input.batch_id);
  if (condition === 'sellable' && !sourceBatchId) throw bad('Choose the batch the sellable units go back into.');
  const key = requestKey('return', input.request_id);

  return inTransaction(async (client) => {
    if (key) {
      const { rows: [prior] } = await client.query('SELECT id, batch_id, movement_id FROM stock_returns WHERE request_key = $1', [key]);
      if (prior) return { returnId: Number(prior.id), batchId: Number(prior.batch_id), movementId: Number(prior.movement_id), repeated: true };
    }
    const { rows: [sku] } = await client.query('SELECT id, sku, unit_type FROM skus WHERE id = $1 FOR UPDATE', [skuId]);
    if (!sku) throw bad('Unknown SKU.', 404);
    if (reference) {
      const { rows: dup } = await client.query(
        `SELECT id, quantity, to_char(return_date, 'DD-MM-YYYY') AS return_date FROM stock_returns WHERE sku_id = $1 AND lower(reference) = lower($2) ORDER BY id LIMIT 1`, [skuId, reference]);
      if (dup.length && !(input.confirm_duplicate === true || input.confirm_duplicate === 'true')) {
        throw bad(`A return for ${sku.sku} with reference ${reference} is already recorded (${dup[0].quantity} on ${dup[0].return_date}). Confirm it is a separate return and give a reason.`, 409, { duplicate: true, existingReturnId: Number(dup[0].id) });
      }
      if (dup.length && !text(input.duplicate_reason, 300)) throw bad('Say why this is a separate return for the same reference.', 400, { duplicate: true });
    }
    let src = null;
    if (sourceBatchId) {
      const { rows: [b] } = await client.query(
        `SELECT id, sku_id, batch_number, warehouse_id, status, mfg_date::text AS mfg_date, expiry_date::text AS expiry_date, unit_cost, selling_price, mrp,
                (expiry_date IS NOT NULL AND expiry_date < (now() AT TIME ZONE $2)::date) AS is_expired
           FROM inventory_batches WHERE id = $1 FOR UPDATE`, [sourceBatchId, teamTimezone()]);
      if (!b || Number(b.sku_id) !== skuId) throw bad('That batch is not one of this SKU\'s batches.');
      src = b;
    }
    if (condition === 'sellable' && (src.status !== 'active' || src.is_expired)) {
      throw bad(`Batch ${src.batch_number} is ${src.is_expired ? 'expired' : src.status}, so units cannot go back into sellable stock there. Record them as damaged or quarantined.`, 409, { unsellable: true });
    }
    const { rows: [{ id: returnId }] } = await client.query(`SELECT nextval(pg_get_serial_sequence('stock_returns', 'id'))::bigint AS id`);
    let batchId = src?.id;
    if (condition !== 'sellable') {
      const warehouseId = src?.warehouse_id || (await client.query('SELECT id FROM warehouses WHERE active ORDER BY sort, id LIMIT 1')).rows[0]?.id;
      if (!warehouseId) throw bad('Add a warehouse first.');
      const { rows: [hb] } = await client.query(
        `INSERT INTO inventory_batches (sku_id, batch_number, warehouse_id, mfg_date, expiry_date, quantity_received, unit_cost, selling_price, mrp,
           status, received_date, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
        [skuId, `${src ? src.batch_number : 'UNKNOWN'}-RET${returnId}`, warehouseId, src?.mfg_date || null, src?.expiry_date || null,
          src?.unit_cost ?? null, src?.selling_price ?? null, src?.mrp ?? null, HOLD_STATUS[condition], returnDate,
          `Return #${returnId} held as ${condition}${src ? ` (from batch ${src.batch_number})` : ' (source batch unknown)'}`, actor]);
      batchId = Number(hb.id);
      await audit(client, 'batch_created', { actor, skuId, batchId, metadata: { return_id: Number(returnId), held_as: condition, source_batch_id: src ? Number(src.id) : null } });
    }
    const movementId = await writeMovement(client, {
      movement_type: 'customer_return', batch_id: batchId, quantity, actor,
      reason: `Return (${condition}): ${reason}`.slice(0, 300), reference_type: 'stock_return', reference_id: String(returnId),
      notes: remarks, idempotency_key: key,
    });
    await client.query(
      `INSERT INTO stock_returns (id, sku_id, quantity, unit, return_date, source, returned_by, reason, condition, remarks, reference,
         source_batch_id, batch_id, movement_id, duplicate_reason, request_key, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [returnId, skuId, quantity, sku.unit_type || 'unit', returnDate, source, returnedBy, reason, condition, remarks, reference,
        src ? src.id : null, batchId, movementId, text(input.duplicate_reason, 300), key, actor]);
    await audit(client, 'stock_returned', { actor, skuId, batchId, metadata: { return_id: Number(returnId), quantity, condition, source, reference } });
    return { returnId: Number(returnId), batchId: Number(batchId), movementId, condition };
  });
}

export async function listReturns({ skuId = null, limit = 100 } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    `SELECT r.id, r.sku_id, s.sku, s.product_name, r.quantity, r.unit, r.return_date::text AS return_date, r.source, r.returned_by, r.reason,
            r.condition, r.remarks, r.reference, r.batch_id, b.batch_number, sb.batch_number AS source_batch_number, r.recorded_by, r.recorded_at
       FROM stock_returns r JOIN skus s ON s.id = r.sku_id JOIN inventory_batches b ON b.id = r.batch_id
       LEFT JOIN inventory_batches sb ON sb.id = r.source_batch_id
      WHERE ($1::bigint IS NULL OR r.sku_id = $1) ORDER BY r.return_date DESC, r.id DESC LIMIT $2`, [skuId, Math.min(Number(limit) || 100, 500)]);
  return rows.map((r) => ({ ...r, id: Number(r.id), sku_id: Number(r.sku_id), batch_id: Number(r.batch_id) }));
}

/* ------------------------------------------------------------------ incoming stock */

export const INCOMING_STATUSES = {
  planned: 'Planned', ordered: 'Ordered', in_transit: 'In transit', partially_received: 'Partially received',
  received_pending_acceptance: 'Received, pending acceptance', accepted: 'Accepted', cancelled: 'Cancelled',
};
/** Stages a person sets before anything arrives. The rest follow from receipts. */
const MANUAL_STAGES = ['planned', 'ordered', 'in_transit'];
const OPEN = ['planned', 'ordered', 'in_transit', 'partially_received', 'received_pending_acceptance'];

/**
 * Status after a receipt or a decision: nothing received keeps the person's stage; with a receipt still waiting →
 * "received, pending acceptance" once the expected quantity has arrived, else "partially received"; with every
 * receipt decided → "accepted" once the expected quantity has arrived, else "partially received".
 */
async function refreshStatus(client, incomingId, actor) {
  const { rows: [r] } = await client.query(
    `SELECT i.status, i.expected_quantity,
            coalesce(sum(x.quantity), 0)::int AS received, bool_or(x.status = 'pending') AS pending
       FROM incoming_stock i LEFT JOIN incoming_receipts x ON x.incoming_id = i.id WHERE i.id = $1 GROUP BY i.id`, [incomingId]);
  if (!r || r.status === 'cancelled' || r.received === 0) return r?.status;
  const next = r.pending ? (r.received >= r.expected_quantity ? 'received_pending_acceptance' : 'partially_received')
    : (r.received >= r.expected_quantity ? 'accepted' : 'partially_received');
  if (next !== r.status) {
    await client.query('UPDATE incoming_stock SET status = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [incomingId, next, actor]);
  }
  return next;
}

const incomingSelect = `
  SELECT i.id, i.sku_id, s.sku, s.product_name, s.variant_name, i.expected_quantity, i.unit, i.expected_date::text AS expected_date,
         i.supplier_id, sp.name AS supplier_name, i.reference, i.batch_number, i.mfg_date::text AS mfg_date, i.expiry_date::text AS expiry_date,
         i.status, i.notes, i.cancel_reason, i.version, i.created_at, i.created_by, i.updated_at, i.updated_by,
         coalesce(sum(x.quantity), 0)::int AS received_quantity,
         coalesce(sum(x.accepted_quantity) FILTER (WHERE x.status = 'accepted'), 0)::int AS accepted_quantity,
         coalesce(sum(x.quantity - coalesce(x.accepted_quantity, 0)) FILTER (WHERE x.status <> 'pending'), 0)::int AS rejected_quantity,
         coalesce(sum(x.quantity) FILTER (WHERE x.status = 'pending'), 0)::int AS pending_quantity
    FROM incoming_stock i JOIN skus s ON s.id = i.sku_id LEFT JOIN suppliers sp ON sp.id = i.supplier_id
    LEFT JOIN incoming_receipts x ON x.incoming_id = i.id`;
const toIncoming = (r) => {
  const open = OPEN.includes(r.status);
  return {
    ...r, id: Number(r.id), sku_id: Number(r.sku_id), status_label: INCOMING_STATUSES[r.status] || r.status, open,
    // Still to come into stock: expected, less what was accepted or turned away. Never part of "available".
    outstanding: open ? Math.max(r.expected_quantity - r.accepted_quantity - r.rejected_quantity, 0) : 0,
  };
};

const RECEIPT_SELECT = `
  SELECT x.id, x.incoming_id, x.quantity, x.batch_number, x.mfg_date::text AS mfg_date, x.expiry_date::text AS expiry_date, x.warehouse_id, w.name AS warehouse_name,
         x.received_date::text AS received_date, x.status, x.accepted_quantity, x.batch_id, x.movement_id, x.notes, x.decision_note,
         x.received_by, x.received_at, x.decided_by, x.decided_at
    FROM incoming_receipts x LEFT JOIN warehouses w ON w.id = x.warehouse_id`;
const toReceipt = (x) => ({ ...x, id: Number(x.id), incoming_id: Number(x.incoming_id), batch_id: x.batch_id === null ? null : Number(x.batch_id) });

/** Expectations, open first; `withReceipts` adds each one's deliveries (one more query, not one per row). */
export async function listIncoming({ skuId = null, open = null, withReceipts = false } = {}) {
  await ensureInventorySchema();
  const out = await listIncomingRows({ skuId, open });
  if (!withReceipts || !out.length) return out;
  const { rows } = await getPool().query(`${RECEIPT_SELECT} WHERE x.incoming_id = ANY($1) ORDER BY x.id`, [out.map((i) => i.id)]);
  for (const i of out) i.receipts = rows.filter((x) => Number(x.incoming_id) === i.id).map(toReceipt);
  return out;
}
async function listIncomingRows({ skuId, open }) {
  const { rows } = await getPool().query(
    `${incomingSelect} WHERE ($1::bigint IS NULL OR i.sku_id = $1) AND ($2::boolean IS NULL OR (i.status = ANY($3)) = $2)
      GROUP BY i.id, s.sku, s.product_name, s.variant_name, sp.name ORDER BY (i.status = ANY($3)) DESC, i.expected_date NULLS LAST, i.id DESC`,
    [skuId, open, OPEN]);
  return rows.map(toIncoming);
}

export async function getIncoming(id) {
  await ensureInventorySchema();
  const { rows: [r] } = await getPool().query(`${incomingSelect} WHERE i.id = $1 GROUP BY i.id, s.sku, s.product_name, s.variant_name, sp.name`, [id]);
  if (!r) return null;
  const { rows: receipts } = await getPool().query(`${RECEIPT_SELECT} WHERE x.incoming_id = $1 ORDER BY x.id`, [id]);
  return { ...toIncoming(r), receipts: receipts.map(toReceipt) };
}

/** Outstanding incoming units per SKU (open expectations only). */
export async function incomingBySku() {
  const list = await listIncoming({ open: true });
  const by = new Map();
  for (const i of list) by.set(i.sku_id, (by.get(i.sku_id) || 0) + i.outstanding);
  return by;
}

export async function createIncoming(input, { actor }) {
  await ensureInventorySchema();
  const skuId = idOf(input.sku_id);
  if (!skuId) throw bad('Choose the SKU.');
  const expected = intOf(input.expected_quantity, 'Expected quantity', { min: 1 });
  const status = String(input.status || 'planned');
  if (!MANUAL_STAGES.includes(status)) throw bad('A new expectation is planned, ordered or in transit.');
  const mfg = dateOf(input.mfg_date, 'Manufacturing date');
  const expiry = dateOf(input.expiry_date, 'Expiry date');
  if (mfg && expiry && mfg > expiry) throw bad('Expiry date is before the manufacturing date.');
  return inTransaction(async (client) => {
    const { rows: [sku] } = await client.query('SELECT id, unit_type, active FROM skus WHERE id = $1', [skuId]);
    if (!sku) throw bad('Unknown SKU.', 404);
    if (!sku.active) throw bad('This SKU is inactive.');
    const supplierId = await supplierFor(client, input, actor);
    const { rows: [r] } = await client.query(
      `INSERT INTO incoming_stock (sku_id, expected_quantity, unit, expected_date, supplier_id, reference, batch_number, mfg_date, expiry_date, status, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
      [skuId, expected, sku.unit_type || 'unit', dateOf(input.expected_date, 'Expected date'), supplierId, text(input.reference, 80),
        text(input.batch_number, 80), mfg, expiry, status, text(input.notes, 1000), actor]);
    await audit(client, 'incoming_created', { actor, skuId, metadata: { incoming_id: Number(r.id), expected_quantity: expected, status } });
    return { id: Number(r.id) };
  });
}

/** Edits an open expectation: its stage (planned / ordered / in transit, before anything arrives), dates, quantity, notes. */
export async function updateIncoming(id, input, { actor, version }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows: [cur] } = await client.query('SELECT *, expected_date::text AS expected_date FROM incoming_stock WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw bad('Unknown incoming stock.', 404);
    if (version !== undefined && Number(version) !== cur.version) throw bad('Someone else changed this just now. Reload and try again.', 409, { conflict: true });
    if (!OPEN.includes(cur.status)) throw bad(`This is ${INCOMING_STATUSES[cur.status].toLowerCase()} and can no longer be changed.`, 409);
    const sets = {}; const meta = {};
    if (input.status !== undefined) {
      if (!MANUAL_STAGES.includes(input.status)) throw bad('Set the stage to planned, ordered or in transit; received and accepted follow from receipts.');
      const { rows: [{ n }] } = await client.query('SELECT count(*)::int n FROM incoming_receipts WHERE incoming_id = $1', [id]);
      if (n) throw bad('Stock has started to arrive; its status now follows the receipts.', 409);
      sets.status = input.status;
    }
    if (input.expected_quantity !== undefined) sets.expected_quantity = intOf(input.expected_quantity, 'Expected quantity', { min: 1 });
    if (input.expected_date !== undefined) sets.expected_date = dateOf(input.expected_date, 'Expected date');
    if (input.reference !== undefined) sets.reference = text(input.reference, 80);
    if (input.notes !== undefined) sets.notes = text(input.notes, 1000);
    for (const k of Object.keys(sets)) meta[k] = { from: cur[k], to: sets[k] };
    if (!Object.keys(sets).length) return { changed: false };
    const keys = Object.keys(sets);
    await client.query(`UPDATE incoming_stock SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`,
      [id, ...keys.map((k) => sets[k]), actor]);
    await refreshStatus(client, id, actor);
    await audit(client, 'incoming_updated', { actor, skuId: Number(cur.sku_id), metadata: { incoming_id: Number(id), changes: meta } });
    return { changed: true };
  });
}

/** Cancels what has not arrived. Receipts already accepted stay in stock; a receipt still pending must be decided first. */
export async function cancelIncoming(id, input, { actor }) {
  await ensureInventorySchema();
  const reason = text(input.reason, 300);
  if (!reason) throw bad('Say why it is cancelled.');
  return inTransaction(async (client) => {
    const { rows: [cur] } = await client.query('SELECT * FROM incoming_stock WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw bad('Unknown incoming stock.', 404);
    if (cur.status === 'cancelled') return { cancelled: true, repeated: true };
    if (!OPEN.includes(cur.status)) throw bad('This has already been accepted in full.', 409);
    const { rows: [{ n }] } = await client.query(`SELECT count(*)::int n FROM incoming_receipts WHERE incoming_id = $1 AND status = 'pending'`, [id]);
    if (n) throw bad('A receipt is still waiting to be accepted or rejected. Decide it first.', 409);
    await client.query(`UPDATE incoming_stock SET status = 'cancelled', cancel_reason = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`, [id, reason, actor]);
    await audit(client, 'incoming_cancelled', { actor, skuId: Number(cur.sku_id), metadata: { incoming_id: Number(id), reason } });
    return { cancelled: true };
  });
}

/**
 * Records what physically arrived (a partial delivery is one receipt of several). It is not stock yet: it waits for
 * acceptance. The batch number is required; dates are optional (an unknown expiry stays unknown).
 */
export async function recordReceipt(incomingId, input, { actor }) {
  await ensureInventorySchema();
  const quantity = intOf(input.quantity, 'Received quantity', { min: 1 });
  const batchNumber = text(input.batch_number, 80);
  const key = requestKey('receipt', input.request_id);
  const mfg = dateOf(input.mfg_date, 'Manufacturing date');
  const expiry = dateOf(input.expiry_date, 'Expiry date');
  if (mfg && expiry && mfg > expiry) throw bad('Expiry date is before the manufacturing date.');
  const received = dateOf(input.received_date, 'Received date') || todayIst();
  if (received > todayIst()) throw bad('The received date cannot be in the future.');
  return inTransaction(async (client) => {
    if (key) {
      const { rows: [prior] } = await client.query('SELECT id FROM incoming_receipts WHERE request_key = $1', [key]);
      if (prior) return { receiptId: Number(prior.id), repeated: true };
    }
    const { rows: [cur] } = await client.query(
      'SELECT *, mfg_date::text AS mfg_date, expiry_date::text AS expiry_date FROM incoming_stock WHERE id = $1 FOR UPDATE', [incomingId]);
    if (!cur) throw bad('Unknown incoming stock.', 404);
    if (!OPEN.includes(cur.status)) throw bad(`This is ${INCOMING_STATUSES[cur.status].toLowerCase()}; record new stock as a new expectation or with Receive stock.`, 409);
    const batch = batchNumber || cur.batch_number;
    if (!batch) throw bad('Enter the batch number on the delivery.');
    const { rows: [r] } = await client.query(
      `INSERT INTO incoming_receipts (incoming_id, quantity, batch_number, mfg_date, expiry_date, warehouse_id, received_date, notes, received_by, request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [incomingId, quantity, batch, mfg || cur.mfg_date || null, expiry || cur.expiry_date || null,
        idOf(input.warehouse_id), received, text(input.notes, 1000), actor, key]);
    const status = await refreshStatus(client, incomingId, actor);
    await audit(client, 'incoming_received', { actor, skuId: Number(cur.sku_id), metadata: { incoming_id: Number(incomingId), receipt_id: Number(r.id), quantity, batch_number: batch } });
    return { receiptId: Number(r.id), status };
  });
}

/**
 * Accepts (all or part of) a pending receipt into stock, or rejects it. Accepted units are received through the
 * ledger (receiveTx: same batch rule, a `received` movement, idempotency key incoming-receipt:<id>), in this same
 * transaction; the rest of the receipt is recorded as turned away. A receipt is decided once: deciding it again
 * returns the first decision, never a second movement.
 */
export async function decideReceipt(receiptId, input, { actor }) {
  await ensureInventorySchema();
  const accept = input.decision === 'accept';
  if (!accept && input.decision !== 'reject') throw bad('Accept or reject the receipt.');
  return inTransaction(async (client) => {
    // Dates as text: a DATE never passes through a JS Date (no timezone can move it).
    const { rows: [x] } = await client.query(
      `SELECT *, mfg_date::text AS mfg_date, expiry_date::text AS expiry_date, received_date::text AS received_date
         FROM incoming_receipts WHERE id = $1 FOR UPDATE`, [receiptId]);
    if (!x) throw bad('Unknown receipt.', 404);
    if (x.status !== 'pending') {
      return { receiptId: Number(x.id), status: x.status, acceptedQuantity: x.accepted_quantity, movementId: x.movement_id === null ? null : Number(x.movement_id), repeated: true };
    }
    const { rows: [inc] } = await client.query('SELECT * FROM incoming_stock WHERE id = $1 FOR UPDATE', [x.incoming_id]);
    const note = text(input.note, 300);
    let accepted = 0; let movement = null;
    if (accept) {
      accepted = input.accepted_quantity === undefined || input.accepted_quantity === '' ? x.quantity : intOf(input.accepted_quantity, 'Accepted quantity', { min: 1 });
      if (accepted > x.quantity) throw bad(`Only ${x.quantity} arrived on this receipt.`);
      if (accepted < x.quantity && !note) throw bad('Say why part of the receipt is not accepted.');
      movement = await receiveTx(client, {
        sku_id: inc.sku_id, batch_number: x.batch_number, quantity: accepted, mfg_date: x.mfg_date, expiry_date: x.expiry_date,
        received_date: x.received_date, warehouse_id: x.warehouse_id, supplier_id: inc.supplier_id, po_number: inc.reference,
        notes: `Incoming #${inc.id}, receipt #${x.id}${note ? ` — ${note}` : ''}`,
      }, { actor, key: `incoming-receipt:${x.id}`, referenceType: 'incoming_receipt', referenceId: String(x.id) });
    } else if (!note) {
      throw bad('Say why the receipt is rejected.');
    }
    await client.query(
      `UPDATE incoming_receipts SET status = $2, accepted_quantity = $3, batch_id = $4, movement_id = $5, decision_note = $6, decided_by = $7, decided_at = now() WHERE id = $1`,
      [x.id, accept ? 'accepted' : 'rejected', accepted, movement?.batchId ?? null, movement?.movementId ?? null, note, actor]);
    const status = await refreshStatus(client, x.incoming_id, actor);
    await audit(client, accept ? 'incoming_accepted' : 'incoming_rejected', { actor, skuId: Number(inc.sku_id), batchId: movement?.batchId ?? null,
      metadata: { incoming_id: Number(inc.id), receipt_id: Number(x.id), received: x.quantity, accepted, note } });
    return { receiptId: Number(x.id), status: accept ? 'accepted' : 'rejected', acceptedQuantity: accepted, movementId: movement?.movementId ?? null, incomingStatus: status };
  });
}
