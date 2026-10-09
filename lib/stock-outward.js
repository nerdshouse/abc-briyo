/**
 * Stock Outward — stock that leaves the warehouse for something other than a sale: free samples, photoshoots,
 * events, creator seeding, retailer samples, product testing, internal use.
 *
 * Built on the inventory ledger (lib/inventory.js), not beside it:
 *   - A draft touches no stock.
 *   - Issuing takes the chosen batches out through writeMovement ('outward_issued'): the batch is locked, free stock
 *     (on hand less reserved) is checked, and the ledger row moves on_hand — the same path every other stock change
 *     uses. Each batch's CP at that moment is kept, so the cost of non-sales stock is what it actually cost.
 *   - What became of the units is recorded as it is learned, never assumed:
 *       returned saleable     → back into the batch it came from ('outward_returned'), verified by the person recording it
 *       returned non-saleable → recorded, not restocked (it already left stock when issued)
 *       consumed              → used up (a shoot, a test)
 *       retained              → kept by the recipient (a sample given away)
 *     Their total never exceeds what was issued; what is left is outstanding.
 *   - Status follows the quantities: draft → issued → partially_returned (something recorded, units outstanding)
 *     → closed (nothing outstanding). A draft may be cancelled. An issued movement is never un-issued or edited in
 *     its stock fields: a mistake is corrected by recording a return.
 * Every step is in one transaction, under a lock on the movement; ledger rows carry idempotency keys, and a repeated
 * request (double click, retry) does nothing the second time. Who did it is always the signed-in user.
 */
import { getPool } from './db.js';
import { inTransaction, teamTimezone } from './orders.js';
import {
  ensureInventorySchema, writeMovement, audit, fefoSuggest, dateOf, OUTWARD_PURPOSES, OUTWARD_STATUSES,
} from './inventory.js';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (v, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const idOf = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);
const qtyOf = (v, label, { min = 0 } = {}) => {
  const s = String(v ?? '').trim();
  if (s === '' && min === 0) return 0;
  if (!/^\d+$/.test(s)) throw bad(`${label} must be a whole number.`);
  const n = Number(s);
  if (n < min) throw bad(`${label} must be at least ${min}.`);
  if (n > 100000) throw bad(`${label} is too large.`);
  return n;
};
const keyOf = (v) => (v && /^[A-Za-z0-9-]{8,80}$/.test(String(v)) ? String(v) : null);
const today = (tz) => `(now() AT TIME ZONE '${tz.replace(/'/g, '')}')::date`;

export const outstandingOf = (r) => r.quantity - r.returned_saleable - r.returned_non_saleable - r.consumed - r.retained;
const statusFor = (r) => (outstandingOf(r) === 0 ? 'closed'
  : r.returned_saleable + r.returned_non_saleable + r.consumed + r.retained > 0 ? 'partially_returned' : 'issued');

/** A team member (allowed_users) by phone: the name is taken from the record, never from the request. */
async function member(client, phone, label) {
  const p = String(phone ?? '').replace(/\D/g, '');
  if (!p) throw bad(`Choose who ${label}.`);
  const { rows } = await client.query('SELECT phone, name FROM allowed_users WHERE phone = $1 AND active', [p]);
  if (!rows.length) throw bad(`${label[0].toUpperCase()}${label.slice(1)} must be an active team member.`);
  return rows[0];
}

/**
 * Who requested the stock: a team member (requested_by = their phone; the name comes from their record), or
 * someone who is not one (requested_by = 'other' + requested_by_name, typed in). A typed requester is stored with no
 * phone and the typed name — never the word "Other" — so the two stay distinguishable. A typed name with a team
 * member is refused rather than ignored.
 */
export const OTHER_REQUESTER = 'other';
async function requester(client, input) {
  const sel = String(input.requested_by ?? '').trim();
  const typed = input.requested_by_name;
  if (sel.toLowerCase() === OTHER_REQUESTER) {
    const name = String(typed ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw bad('Enter the requester\'s name.', 400, { field: 'requested_by_name' });
    if (name.length > 60) throw bad('The requester\'s name is too long (60 characters at most).', 400, { field: 'requested_by_name' });
    if (/[\u0000-\u001f\u007f]/.test(name)) throw bad('The requester\'s name has characters that are not allowed.', 400, { field: 'requested_by_name' });
    if (/^other$/i.test(name)) throw bad('Enter the requester\'s actual name.', 400, { field: 'requested_by_name' });
    return { phone: null, name };
  }
  if (typed !== undefined && typed !== null && String(typed).trim() !== '') {
    throw bad('A requester name is only typed in when "Other" is chosen.', 400, { field: 'requested_by_name' });
  }
  return member(client, sel, 'requested the stock');
}

/** Active team members, for the Requested by / Issued by pickers. */
export async function outwardPeople() {
  const { rows } = await getPool().query('SELECT phone, name FROM allowed_users WHERE active ORDER BY lower(name), phone');
  return rows.map((r) => ({ phone: r.phone, name: r.name }));
}

/** The editable header fields, validated. `partial` lets an issued movement change only its non-stock details. */
async function headerFields(client, input, { stockFields = true } = {}) {
  const f = {};
  if (stockFields) {
    f.movement_date = dateOf(input.movement_date, 'Movement date');
    if (!f.movement_date) throw bad('Enter the movement date.');
    if (!OUTWARD_PURPOSES[input.purpose]) throw bad('Choose the purpose.');
    f.purpose = input.purpose;
    const skuId = idOf(input.sku_id);
    if (!skuId) throw bad('Choose the product.');
    const { rows } = await client.query('SELECT id, sku, active, track_inventory FROM skus WHERE id = $1', [skuId]);
    if (!rows.length) throw bad('No such product.', 404);
    if (!rows[0].active) throw bad(`${rows[0].sku} is inactive. Choose an active product.`);
    if (rows[0].track_inventory === false) throw bad(`${rows[0].sku} is not stock-tracked, so it cannot be issued from inventory.`);
    f.sku_id = skuId;
    f.quantity = qtyOf(input.quantity, 'Quantity', { min: 1 });
    const req = await requester(client, input);
    const iss = await member(client, input.issued_by, 'is issuing the stock');
    Object.assign(f, { requested_by_phone: req.phone, requested_by_name: req.name, issued_by_phone: iss.phone, issued_by_name: iss.name });
    f.recipient_name = text(input.recipient_name, 160);
    if (!f.recipient_name) throw bad('Enter the recipient or point of contact.');
  }
  for (const [k, max] of [['recipient_org', 160], ['department', 120], ['campaign', 160], ['request_reference', 80], ['notes', 1000]]) {
    if (input[k] !== undefined) f[k] = text(input[k], max);
  }
  if (input.expected_return_date !== undefined) f.expected_return_date = dateOf(input.expected_return_date, 'Expected return date');
  return f;
}

async function event(client, outwardId, type, actor, extra = {}) {
  const { rows } = await client.query(
    `INSERT INTO stock_outward_events (outward_id, event_type, returned_saleable, returned_non_saleable, consumed, retained, batches, metadata, notes, actor, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [outwardId, type, extra.returned_saleable || 0, extra.returned_non_saleable || 0, extra.consumed || 0, extra.retained || 0,
      extra.batches ? JSON.stringify(extra.batches) : null, JSON.stringify(extra.metadata || {}), extra.notes || null, actor, extra.key || null]);
  return rows[0] ? Number(rows[0].id) : null;
}

async function locked(client, id) {
  // Dates as text, so a DATE never shifts by a timezone.
  const { rows } = await client.query('SELECT *, movement_date::text AS movement_date, expected_return_date::text AS expected_return_date FROM stock_outwards WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw bad('No such stock outward.', 404);
  return rows[0];
}

/** A new draft. Nothing leaves stock. */
export async function createOutward(input, { actor }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const f = await headerFields(client, input);
    const keys = Object.keys(f);
    const { rows } = await client.query(
      `INSERT INTO stock_outwards (${keys.join(', ')}, created_by, updated_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 1})
       RETURNING id, reference`, [...keys.map((k) => f[k]), actor]);
    await event(client, rows[0].id, 'created', actor, { metadata: { quantity: f.quantity, sku_id: f.sku_id, purpose: f.purpose } });
    return { id: Number(rows[0].id), reference: rows[0].reference };
  });
}

/** A draft's fields, all of them; an issued movement's details only (never product, quantity or people). */
export async function updateOutward(id, input, { actor, version }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const cur = await locked(client, id);
    if (version !== undefined && Number(version) !== cur.version) throw bad('Someone else changed this stock outward. Reload to see it.', 409, { conflict: true });
    if (cur.status === 'cancelled') throw bad('This stock outward was cancelled.', 409);
    const draft = cur.status === 'draft';
    if (!draft) {
      for (const k of ['movement_date', 'purpose', 'sku_id', 'quantity', 'requested_by', 'requested_by_name', 'issued_by', 'recipient_name']) {
        if (input[k] !== undefined) throw bad('Product, quantity, date, purpose and people are fixed once stock is issued. Record a return to correct an issue.', 409);
      }
    }
    // A draft keeps what it had; choosing a different requester replaces the typed name too (never left stale).
    const base = rowInput(cur);
    if (input.requested_by !== undefined) delete base.requested_by_name;
    const f = await headerFields(client, draft ? { ...base, ...input } : input, { stockFields: draft });
    const changes = {};
    for (const [k, v] of Object.entries(f)) {
      const was = cur[k];
      if (String(was ?? '') !== String(v ?? '')) changes[k] = { from: was ?? null, to: v ?? null };
    }
    if (!Object.keys(changes).length) return { changed: false };
    const keys = Object.keys(changes);
    await client.query(`UPDATE stock_outwards SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(),
      updated_by = $${keys.length + 2} WHERE id = $1`, [id, ...keys.map((k) => f[k]), actor]);
    await event(client, id, 'edited', actor, { metadata: { changes } });
    return { changed: true };
  });
}
const rowInput = (r) => ({
  movement_date: r.movement_date, purpose: r.purpose, sku_id: r.sku_id,
  quantity: r.quantity, requested_by: r.requested_by_phone ?? OTHER_REQUESTER,
  ...(r.requested_by_phone ? {} : { requested_by_name: r.requested_by_name }), issued_by: r.issued_by_phone, recipient_name: r.recipient_name,
});

/** Cancels a draft (nothing was issued, so nothing moves). */
export async function cancelOutward(id, { actor, reason }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const cur = await locked(client, id);
    if (cur.status === 'cancelled') return { changed: false };
    if (cur.status !== 'draft') throw bad('Only a draft can be cancelled. Issued stock is reconciled by recording what came back.', 409);
    await client.query(`UPDATE stock_outwards SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [id, actor]);
    await event(client, id, 'cancelled', actor, { notes: text(reason, 300) });
    return { changed: true };
  });
}

/** The product's sellable batches and an earliest-expiry-first suggestion, as a shipment's stock panel offers them. */
export async function outwardStockOptions(skuId, quantity = 0, { tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    `SELECT b.id, b.batch_number, b.expiry_date::text AS expiry_date, b.location, w.name AS warehouse_name, b.unit_cost,
            greatest(b.on_hand - coalesce((SELECT sum(quantity) FROM inventory_reservations r WHERE r.batch_id = b.id AND r.status = 'active'), 0), 0)::int AS available
     FROM inventory_batches b JOIN warehouses w ON w.id = b.warehouse_id
     WHERE b.sku_id = $1 AND b.status = 'active' AND (b.expiry_date IS NULL OR b.expiry_date >= ${today(tz)}) AND b.on_hand > 0
     ORDER BY b.expiry_date NULLS LAST, b.id`, [skuId]);
  // Only active, unexpired batches are listed, so each is offered as active to the shared FEFO suggestion.
  const batches = rows.map((b) => ({ ...b, id: Number(b.id), unit_cost: b.unit_cost === null ? null : Number(b.unit_cost), effective_status: 'active' }));
  const fefo = quantity ? fefoSuggest(batches, quantity) : { picks: [], short: 0 };
  return { available: batches.reduce((n, b) => n + b.available, 0), batches, suggestion: fefo.picks, short: fefo.short };
}

/**
 * Issues a draft: the chosen batches (which must add up to its quantity) go out through the ledger. Idempotent: an
 * already-issued movement is returned as it is, never issued twice. Concurrent issues of the same stock are
 * serialised by the batch lock in writeMovement, which refuses what is not free.
 */
export async function issueOutward(id, input, { actor, tz = teamTimezone() }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const cur = await locked(client, id);
    if (['issued', 'partially_returned', 'closed'].includes(cur.status)) return { repeated: true, status: cur.status };
    if (cur.status !== 'draft') throw bad('This stock outward was cancelled.', 409);
    const raw = Array.isArray(input?.allocations) ? input.allocations : [];
    const alloc = new Map();
    for (const a of raw) {
      const batchId = idOf(a?.batch_id);
      if (!batchId) throw bad('Choose the batch for each quantity.');
      const q = qtyOf(a?.quantity, 'Batch quantity');
      if (q) alloc.set(batchId, (alloc.get(batchId) || 0) + q);
    }
    const total = [...alloc.values()].reduce((n, q) => n + q, 0);
    if (!alloc.size) throw bad('Choose the batches the stock is taken from.', 400, { needsStock: true });
    if (total !== cur.quantity) throw bad(`The batches add up to ${total}, but ${cur.quantity} unit${cur.quantity === 1 ? ' is' : 's are'} being issued.`, 400, { needsStock: true });
    const { rows: bs } = await client.query(
      `SELECT id, sku_id, batch_number, status, unit_cost, (expiry_date IS NOT NULL AND expiry_date < ${today(tz)}) AS expired
       FROM inventory_batches WHERE id = ANY($1) ORDER BY id`, [[...alloc.keys()]]);
    if (bs.length !== alloc.size) throw bad('A chosen batch does not exist.', 404);
    for (const b of bs) {
      if (b.sku_id !== cur.sku_id) throw bad(`Batch ${b.batch_number} is not this product.`);
      if (b.status !== 'active' || b.expired) throw bad(`Batch ${b.batch_number} is ${b.expired ? 'expired' : b.status} and cannot be issued.`, 409, { unsellable: true });
    }
    let cost = 0; let costKnown = true;
    const batchesOut = [];
    for (const b of bs) {
      const q = alloc.get(Number(b.id));
      await writeMovement(client, {
        movement_type: 'outward_issued', batch_id: b.id, quantity: q, actor, reason: `Stock outward: ${OUTWARD_PURPOSES[cur.purpose]}`,
        reference_type: 'stock_outward', reference_id: cur.reference, notes: `To ${cur.recipient_name}${cur.recipient_org ? ` (${cur.recipient_org})` : ''}`,
        idempotency_key: `outward:${id}:issue:${b.id}`,
      });
      await client.query('INSERT INTO stock_outward_batches (outward_id, batch_id, quantity, unit_cost) VALUES ($1, $2, $3, $4)', [id, b.id, q, b.unit_cost]);
      if (b.unit_cost === null) costKnown = false; else cost += q * Number(b.unit_cost);
      batchesOut.push({ batch_id: Number(b.id), batch_number: b.batch_number, quantity: q, unit_cost: b.unit_cost === null ? null : Number(b.unit_cost) });
    }
    await client.query(
      `UPDATE stock_outwards SET status = 'issued', issued_at = now(), issue_actor = $2, cost_value = $3, version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [id, actor, costKnown ? Math.round(cost * 100) / 100 : null]);
    await event(client, id, 'issued', actor, { batches: batchesOut, metadata: { quantity: cur.quantity } });
    await audit(client, 'stock_outward_issued', { actor, skuId: cur.sku_id, metadata: { outward: cur.reference, quantity: cur.quantity, batches: batchesOut } });
    return { issued: true, status: 'issued' };
  });
}

/**
 * Records what became of issued units, in any mix: returned saleable (per batch, restocked into the batch it came
 * from), returned non-saleable (not restocked), consumed, retained. Never more than is outstanding. `request_id`
 * makes a retry a no-op. When nothing is left outstanding the movement closes.
 */
export async function recordOutwardReturn(id, input, { actor }) {
  await ensureInventorySchema();
  const key = keyOf(input?.request_id);
  return inTransaction(async (client) => {
    const cur = await locked(client, id);
    if (key) {
      const { rows } = await client.query('SELECT id FROM stock_outward_events WHERE idempotency_key = $1', [`outward-return:${id}:${key}`]);
      if (rows.length) return { repeated: true, status: cur.status };
    }
    if (cur.status === 'draft') throw bad('Nothing has been issued yet.', 409);
    if (cur.status === 'cancelled') throw bad('This stock outward was cancelled.', 409);
    if (cur.status === 'closed') throw bad('This stock outward is closed: every unit is accounted for.', 409);
    const nonSaleable = qtyOf(input?.returned_non_saleable, 'Non-saleable quantity');
    const consumed = qtyOf(input?.consumed, 'Consumed quantity');
    const retained = qtyOf(input?.retained, 'Retained quantity');
    const { rows: issued } = await client.query(
      `SELECT ob.batch_id, ob.quantity, ob.restocked, ob.unit_cost, b.batch_number FROM stock_outward_batches ob JOIN inventory_batches b ON b.id = ob.batch_id
       WHERE ob.outward_id = $1 ORDER BY ob.batch_id FOR UPDATE OF ob`, [id]);
    const saleable = new Map();
    for (const a of Array.isArray(input?.returned_saleable) ? input.returned_saleable : []) {
      const batchId = idOf(a?.batch_id);
      const q = qtyOf(a?.quantity, 'Saleable quantity');
      if (!q) continue;
      if (!batchId || !issued.some((x) => Number(x.batch_id) === batchId)) throw bad('Saleable units go back to a batch they were issued from.');
      saleable.set(batchId, (saleable.get(batchId) || 0) + q);
    }
    // A single-batch issue needs no batch choice for its saleable returns.
    if (input?.returned_saleable !== undefined && !Array.isArray(input.returned_saleable)) {
      const q = qtyOf(input.returned_saleable, 'Saleable quantity');
      if (q) {
        if (issued.length !== 1) throw bad('This was issued from more than one batch: say which batch each saleable unit goes back to.');
        saleable.set(Number(issued[0].batch_id), q);
      }
    }
    const saleableTotal = [...saleable.values()].reduce((n, q) => n + q, 0);
    const total = saleableTotal + nonSaleable + consumed + retained;
    if (!total) throw bad('Enter at least one quantity.');
    const outstanding = outstandingOf(cur);
    if (total > outstanding) throw bad(`Only ${outstanding} unit${outstanding === 1 ? ' is' : 's are'} outstanding; ${total} were entered.`, 409);
    if (saleableTotal && input?.saleable_verified !== true) throw bad('Confirm the returned units were inspected and are saleable before they go back into stock.', 400, { confirmRequired: true });
    const back = [];
    for (const [batchId, q] of saleable) {
      const b = issued.find((x) => Number(x.batch_id) === batchId);
      if (b.restocked + q > b.quantity) throw bad(`Only ${b.quantity - b.restocked} unit(s) issued from batch ${b.batch_number} can go back to it.`, 409);
      await writeMovement(client, {
        movement_type: 'outward_returned', batch_id: batchId, quantity: q, actor, reason: 'Stock outward return (inspected, saleable)',
        reference_type: 'stock_outward', reference_id: cur.reference, idempotency_key: key ? `outward:${id}:return:${key}:${batchId}` : null,
      });
      await client.query('UPDATE stock_outward_batches SET restocked = restocked + $3 WHERE outward_id = $1 AND batch_id = $2', [id, batchId, q]);
      back.push({ batch_id: batchId, batch_number: b.batch_number, quantity: q });
    }
    const next = { ...cur, returned_saleable: cur.returned_saleable + saleableTotal, returned_non_saleable: cur.returned_non_saleable + nonSaleable,
      consumed: cur.consumed + consumed, retained: cur.retained + retained };
    const status = statusFor(next);
    await client.query(
      `UPDATE stock_outwards SET returned_saleable = $2, returned_non_saleable = $3, consumed = $4, retained = $5, status = $6,
         closed_at = CASE WHEN $6 = 'closed' THEN now() ELSE NULL END, closed_by = CASE WHEN $6 = 'closed' THEN $7 ELSE NULL END,
         version = version + 1, updated_at = now(), updated_by = $7 WHERE id = $1`,
      [id, next.returned_saleable, next.returned_non_saleable, next.consumed, next.retained, status, actor]);
    await event(client, id, 'returned', actor, { returned_saleable: saleableTotal, returned_non_saleable: nonSaleable, consumed, retained,
      batches: back, notes: text(input?.notes, 1000), key: key ? `outward-return:${id}:${key}` : null, metadata: { outstanding: outstandingOf(next) } });
    if (status === 'closed') await event(client, id, 'closed', actor, { metadata: { reconciled: true } });
    return { status, outstanding: outstandingOf(next) };
  });
}

/** Close: only when every issued unit is accounted for. To close with units still out, record what became of them. */
export async function closeOutward(id, { actor }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const cur = await locked(client, id);
    if (cur.status === 'closed') return { changed: false };
    if (!['issued', 'partially_returned'].includes(cur.status)) throw bad('Only issued stock can be closed.', 409);
    const left = outstandingOf(cur);
    if (left > 0) throw bad(`${left} unit${left === 1 ? ' is' : 's are'} still outstanding. Record whether they were returned, consumed, damaged or kept by the recipient before closing.`, 409, { outstanding: left });
    return { changed: false };
  });
}

const LIST_SQL = `
  SELECT o.*, o.movement_date::text AS movement_date, o.expected_return_date::text AS expected_return_date,
         s.sku, s.product_name, s.variant_name
  FROM stock_outwards o JOIN skus s ON s.id = o.sku_id`;
const toRow = (r) => ({
  ...r, id: Number(r.id), cost_value: r.cost_value === null ? null : Number(r.cost_value), outstanding: outstandingOf(r),
  purpose_label: OUTWARD_PURPOSES[r.purpose] || r.purpose,
  requested_by_external: r.requested_by_phone === null,     // typed in ("Other"), not a team member
});

/** The list, newest first, with search and filters. */
export async function listOutwards(f = {}, { limit = 200 } = {}) {
  await ensureInventorySchema();
  const where = []; const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (text(f.q, 100)) {
    args.push(`%${text(f.q, 100).replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${args.length}`;
    where.push(`(s.sku ILIKE ${p} OR s.product_name ILIKE ${p} OR o.recipient_name ILIKE ${p} OR o.recipient_org ILIKE ${p} OR o.requested_by_name ILIKE ${p}
      OR o.reference ILIKE ${p} OR o.request_reference ILIKE ${p} OR o.campaign ILIKE ${p})`);
  }
  if (f.from) add('o.movement_date >= ?', dateOf(f.from, 'From'));
  if (f.to) add('o.movement_date <= ?', dateOf(f.to, 'To'));
  if (OUTWARD_PURPOSES[f.purpose]) add('o.purpose = ?', f.purpose);
  if (OUTWARD_STATUSES.includes(f.status)) add('o.status = ?', f.status);
  if (f.status === 'outstanding') where.push(`o.status IN ('issued','partially_returned')`);
  if (idOf(f.sku_id)) add('o.sku_id = ?', idOf(f.sku_id));
  if (text(f.employee, 40)) { args.push(String(f.employee).replace(/\D/g, '')); where.push(`(o.requested_by_phone = $${args.length} OR o.issued_by_phone = $${args.length})`); }
  args.push(Math.min(Number(limit) || 200, 500));
  const { rows } = await getPool().query(`${LIST_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.movement_date DESC, o.id DESC LIMIT $${args.length}`, args);
  return rows.map(toRow);
}

/** One movement: details, the batches it took (with CP at issue and what went back), and its history. */
export async function getOutward(id) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(`${LIST_SQL} WHERE o.id = $1`, [id]);
  if (!rows[0]) return null;
  const [{ rows: batches }, { rows: events }] = await Promise.all([
    getPool().query(`SELECT ob.batch_id, ob.quantity, ob.unit_cost, ob.restocked, b.batch_number, b.expiry_date::text AS expiry_date, w.name AS warehouse_name
                     FROM stock_outward_batches ob JOIN inventory_batches b ON b.id = ob.batch_id JOIN warehouses w ON w.id = b.warehouse_id
                     WHERE ob.outward_id = $1 ORDER BY ob.batch_id`, [id]),
    getPool().query('SELECT id, event_type, returned_saleable, returned_non_saleable, consumed, retained, batches, metadata, notes, actor, at FROM stock_outward_events WHERE outward_id = $1 ORDER BY id', [id]),
  ]);
  return {
    ...toRow(rows[0]),
    batches: batches.map((b) => ({ ...b, batch_id: Number(b.batch_id), unit_cost: b.unit_cost === null ? null : Number(b.unit_cost) })),
    events: events.map((e) => ({ ...e, id: Number(e.id) })),
  };
}

/**
 * Reports over issued movements (drafts and cancelled ones are not stock movements) in a date range: units by
 * purpose, product, employee and recipient; what came back and how; what is outstanding; and cost at CP —
 * issued at the batch's CP when issued, less saleable units restocked at that same CP. SP and MRP are never used.
 */
export async function outwardReport(f = {}) {
  await ensureInventorySchema();
  const args = []; const where = [`o.status NOT IN ('draft','cancelled')`];
  if (f.from) { args.push(dateOf(f.from, 'From')); where.push(`o.movement_date >= $${args.length}`); }
  if (f.to) { args.push(dateOf(f.to, 'To')); where.push(`o.movement_date <= $${args.length}`); }
  const W = `WHERE ${where.join(' AND ')}`;
  const sums = `sum(o.quantity)::int AS issued, sum(o.returned_saleable)::int AS returned_saleable, sum(o.returned_non_saleable)::int AS returned_non_saleable,
    sum(o.consumed)::int AS consumed, sum(o.retained)::int AS retained,
    sum(o.quantity - o.returned_saleable - o.returned_non_saleable - o.consumed - o.retained)::int AS outstanding, count(*)::int AS movements`;
  const q = (sql) => getPool().query(sql, args).then((r) => r.rows);
  const [byPurpose, byProduct, byRequester, byIssuer, byRecipient, totals, cost, outstanding] = await Promise.all([
    q(`SELECT o.purpose, ${sums} FROM stock_outwards o ${W} GROUP BY o.purpose ORDER BY issued DESC`),
    q(`SELECT s.sku, s.product_name, ${sums} FROM stock_outwards o JOIN skus s ON s.id = o.sku_id ${W} GROUP BY s.id ORDER BY issued DESC`),
    // A team member and a typed-in requester of the same name are kept apart.
    q(`SELECT o.requested_by_name AS name, (o.requested_by_phone IS NULL) AS external, ${sums} FROM stock_outwards o ${W}
       GROUP BY o.requested_by_phone, o.requested_by_name ORDER BY issued DESC`),
    q(`SELECT o.issued_by_name AS name, ${sums} FROM stock_outwards o ${W} GROUP BY o.issued_by_name ORDER BY issued DESC`),
    q(`SELECT coalesce(o.recipient_org, o.recipient_name) AS recipient, ${sums} FROM stock_outwards o ${W} GROUP BY 1 ORDER BY issued DESC`),
    q(`SELECT ${sums} FROM stock_outwards o ${W}`),
    q(`SELECT coalesce(sum(ob.quantity * ob.unit_cost), 0)::numeric AS issued_value,
              coalesce(sum(ob.restocked * ob.unit_cost), 0)::numeric AS restocked_value,
              coalesce(sum(ob.quantity) FILTER (WHERE ob.unit_cost IS NULL), 0)::int AS units_without_cost
       FROM stock_outward_batches ob JOIN stock_outwards o ON o.id = ob.outward_id ${W}`),
    q(`SELECT o.id, o.reference, o.movement_date::text AS movement_date, o.expected_return_date::text AS expected_return_date, s.sku, s.product_name,
              coalesce(o.recipient_org, o.recipient_name) AS recipient, (o.quantity - o.returned_saleable - o.returned_non_saleable - o.consumed - o.retained)::int AS outstanding
       FROM stock_outwards o JOIN skus s ON s.id = o.sku_id ${W} AND o.status IN ('issued','partially_returned') ORDER BY o.expected_return_date NULLS LAST, o.movement_date`),
  ]);
  const label = (r) => ({ ...r, purpose_label: OUTWARD_PURPOSES[r.purpose] || r.purpose });
  const c = cost[0];
  return {
    totals: totals[0], byPurpose: byPurpose.map(label), byProduct, byRequester, byIssuer, byRecipient, outstanding: outstanding.map((r) => ({ ...r, id: Number(r.id) })),
    cost: { issuedValue: Number(c.issued_value), restockedValue: Number(c.restocked_value), netValue: Math.round((Number(c.issued_value) - Number(c.restocked_value)) * 100) / 100, unitsWithoutCost: c.units_without_cost },
  };
}
