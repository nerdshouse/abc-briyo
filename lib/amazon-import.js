import crypto from 'node:crypto';
import { getPool } from './db.js';
import { parseCsv } from './csv.js';
import { readXlsx, excelSerialToIso } from './xlsx.js';
import { inTransaction, logEvent, ensureOrdersSchema } from './orders.js';

/**
 * Amazon order import — Seller Central's order report (the "All Orders" flat
 * file, 66 columns), as .csv, tab-separated .txt or .xlsx.
 *
 * One spreadsheet row is one LINE ITEM, not one order: rows are grouped on
 * `order-id`, and each `order-item-id` becomes a row in order_items. Amazon
 * also writes a promotion-detail row after a discounted item (same order-id
 * and order-item-id, everything else blank); those are folded into their item.
 *
 * Re-importing is safe: orders are matched on channel + order number, line
 * items on order + order-item-id. Unchanged rows write nothing. Shipments,
 * documents, notes, order status and dispatch routing are never touched.
 *
 * The import creates orders and line items only — no shipments. Logistics
 * creates a shipment when a parcel is packed, often one for several orders.
 */

/**
 * Payment, from Amazon's `payment-method` column only:
 *   "COD"          → method cod,         status pending (collected on delivery)
 *   blank          → method marketplace, status not known
 *   anything else  → method other,       status not known
 * `payments-date` is kept in the Amazon details but never read as "paid":
 * Amazon fills it on COD orders too.
 */
export function amazonPayment(method) {
  const m = String(method ?? '').trim();
  if (/^cod$/i.test(m)) return { payment_method: 'cod', payment_status: 'pending' };
  if (!m) return { payment_method: 'marketplace', payment_status: null };
  return { payment_method: 'other', payment_status: null };
}

export const IGNORED_COLUMNS = new Set([
  'gift-wrap-price', 'gift-wrap-tax', 'ship-phone-number', 'gift-wrap-type', 'gift-message-text',
  'ship-promotion-id', 'delivery-start-date', 'delivery-end-date', 'delivery-time-zone',
  'external-order-id', 'already-paid', 'payment-method-fee', 'vat-exclusive-giftwrap-price', 'is-iba',
]);
const REQUIRED_COLUMNS = ['order-id', 'order-item-id', 'purchase-date', 'sku', 'product-name',
  'quantity-purchased', 'currency', 'item-price'];
const MAX_REPORTED_ERRORS = 500;
// A row with any of these describes an item (and its order).
const ITEM_FIELDS_IN_FILE = ['purchase-date', 'sku', 'product-name', 'quantity-purchased', 'item-price', 'item-tax',
  'shipping-price', 'shipping-tax', 'currency', 'buyer-name', 'buyer-email', 'recipient-name', 'ship-address-1'];
// A row with only these (plus order-id / order-item-id) is promotion detail.
const PROMOTION_FIELDS = ['item-promotion-discount', 'item-promotion-id', 'ship-promotion-discount'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/* ------------------------------------------------------------------ reading */

/** The file as rows of strings, whatever form Seller Central or Excel saved it in. */
export function readTable(buffer, filename = '') {
  if (!buffer?.length) throw bad('The file is empty.');
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;   // "PK": .xlsx
  if (isZip || /\.xlsx$/i.test(filename)) {
    try { return readXlsx(buffer); } catch (err) { throw bad(`Could not read the Excel file: ${err.message}`); }
  }
  if (/\.xls$/i.test(filename)) throw bad('Old .xls files cannot be read. Save it as .xlsx or .csv and try again.');
  let text = buffer.toString('utf8');
  if (text.includes('�')) text = buffer.toString('latin1');   // not UTF-8: Windows-1252 export
  const first = text.split(/\r?\n/, 1)[0];
  const delimiter = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  return parseCsv(text, delimiter);
}

/* ------------------------------------------------------------------ parsing */

const num = (v) => {
  const s = String(v ?? '').trim().replace(/[₹,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const bool = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
};
/** ISO timestamps as Amazon writes them; Excel date cells arrive as day serials. */
const time = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToIso(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? NaN : d.toISOString();
};
const text = (v, max = 300) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
/** Stable JSON for comparing payloads (Postgres jsonb does not keep key order). */
const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null));

/**
 * Groups and validates the rows. Pure: no database. An order with any bad row
 * is left out whole, so a half-imported order can never appear.
 */
export function planAmazon(rows) {
  if (!rows.length) throw bad('The file is empty.');
  const headers = rows[0].map((h) => String(h).trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    throw bad(`This does not look like an Amazon order report — missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  }
  const col = Object.fromEntries(headers.map((h, i) => [h, i]));
  // Excluded columns are unreadable here, so nothing can map or store them by accident.
  const get = (r, h) => (col[h] === undefined || IGNORED_COLUMNS.has(h) ? '' : String(r[col[h]] ?? '').trim());

  const errors = [];
  const orders = new Map();
  const detailRows = [];
  let dataRows = 0;
  let duplicateRows = 0;
  const fail = (row, orderId, reason) => {
    errors.push({ row, orderId: orderId || null, reason });
    if (orderId && orders.has(orderId)) orders.get(orderId).bad = true;
    else if (orderId) orders.set(orderId, { id: orderId, rows: [row], items: new Map(), bad: true });
  };

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;                                   // spreadsheet row, header is row 1
    if (!r.some((v) => String(v ?? '').trim())) return;    // blank line
    dataRows += 1;
    const orderId = get(r, 'order-id');
    const itemId = get(r, 'order-item-id');
    if (!orderId) return fail(rowNo, null, 'Missing order-id');
    if (!itemId) return fail(rowNo, orderId, 'Missing order-item-id');

    // Promotion-only row, recognised by its content rather than its position:
    // none of the fields that describe an item or an order, and at least one
    // promotion field. It is matched to its item by order-id + order-item-id
    // wherever that item is in the file, and never becomes an order or item.
    const describesItem = ITEM_FIELDS_IN_FILE.some((h) => get(r, h));
    const hasPromotion = PROMOTION_FIELDS.some((h) => get(r, h));
    if (!describesItem && hasPromotion) {
      detailRows.push({ rowNo, orderId, itemId, itemDiscount: num(get(r, 'item-promotion-discount')),
        shipDiscount: num(get(r, 'ship-promotion-discount')), promotionId: text(get(r, 'item-promotion-id'), 200) });
      return;
    }

    const orderDate = time(get(r, 'purchase-date'));
    const qtyRaw = get(r, 'quantity-purchased');
    const qty = /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : NaN;
    const money = {
      item_price: num(get(r, 'item-price')), item_tax: num(get(r, 'item-tax')),
      shipping_price: num(get(r, 'shipping-price')), shipping_tax: num(get(r, 'shipping-tax')),
      promotion_discount: num(get(r, 'item-promotion-discount')), ship_discount: num(get(r, 'ship-promotion-discount')),
      price_excl_tax: num(get(r, 'vat-exclusive-item-price')), cod: num(get(r, 'cod-collectible-amount')),
    };
    const problems = [];
    if (orderDate === null) problems.push('purchase-date is empty');
    else if (Number.isNaN(orderDate)) problems.push(`purchase-date "${get(r, 'purchase-date')}" is not a date`);
    if (Number.isNaN(qty)) problems.push(`quantity-purchased "${qtyRaw}" is not a whole number`);
    if (money.item_price === null) problems.push('item-price is empty');
    for (const [k, v] of Object.entries(money)) if (Number.isNaN(v)) problems.push(`${k.replace(/_/g, '-')} is not a number`);
    const currency = get(r, 'currency').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) problems.push(`currency "${get(r, 'currency')}" is not valid`);
    const fulfilledBy = get(r, 'fulfilled-by');
    if (fulfilledBy && fulfilledBy.toLowerCase() !== 'easy ship') {
      problems.push(`fulfilled by "${fulfilledBy}" — only Easy Ship orders are shipped by the team`);
    }
    if (problems.length) return fail(rowNo, orderId, problems.join('; '));

    let o = orders.get(orderId);
    if (!o) {
      const payMethod = get(r, 'payment-method');
      o = {
        id: orderId, rows: [], items: new Map(), bad: false,
        order: {
          source_order_id: orderId, order_date: orderDate, currency,
          customer_name: text(get(r, 'buyer-name'), 120), customer_email: text(get(r, 'buyer-email'), 160),
          customer_phone: text(get(r, 'buyer-phone-number'), 20),
          ...amazonPayment(payMethod),
          amazon: {
            payments_date: time(get(r, 'payments-date')) || null,
            order_channel: text(get(r, 'order-channel')), order_channel_instance: text(get(r, 'order-channel-instance')),
            payment_method: text(payMethod), cod_collectible_amount: money.cod,
            is_business_order: bool(get(r, 'is-business-order')), purchase_order_number: text(get(r, 'purchase-order-number')),
            price_designation: text(get(r, 'price-designation')), is_prime: bool(get(r, 'is-prime')),
            fulfilled_by: text(fulfilledBy), is_amazon_invoiced: bool(get(r, 'is-amazon-invoiced')),
            ship_service_level: text(get(r, 'ship-service-level')),
            ship_to: {
              name: text(get(r, 'recipient-name')), address_1: text(get(r, 'ship-address-1')),
              address_2: text(get(r, 'ship-address-2')), address_3: text(get(r, 'ship-address-3')),
              city: text(get(r, 'ship-city')), state: text(get(r, 'ship-state')),
              postal_code: text(get(r, 'ship-postal-code')), country: text(get(r, 'ship-country')),
            },
            bill_to: {
              name: text(get(r, 'bill-name')), address_1: text(get(r, 'bill-address-1')),
              address_2: text(get(r, 'bill-address-2')), address_3: text(get(r, 'bill-address-3')),
              city: text(get(r, 'bill-city')), state: text(get(r, 'bill-state')),
              postal_code: text(get(r, 'bill-postal-code')), country: text(get(r, 'bill-country')),
            },
            delivery_instructions: text(get(r, 'delivery-Instructions'), 500),
            earliest_ship_date: time(get(r, 'earliest-ship-date')) || null, latest_ship_date: time(get(r, 'latest-ship-date')) || null,
            earliest_delivery_date: time(get(r, 'earliest-delivery-date')) || null, latest_delivery_date: time(get(r, 'latest-delivery-date')) || null,
          },
        },
      };
      orders.set(orderId, o);
    } else if (!o.order) {
      // Earlier rows of this order were bad; this one is noted but the order stays out.
      o.rows.push(rowNo);
      return;
    } else if (o.order.order_date !== orderDate || o.order.currency !== currency) {
      return fail(rowNo, orderId, 'This row has a different purchase-date or currency from the rest of the order');
    }
    o.rows.push(rowNo);

    const item = {
      source_line_item_id: itemId, sku: text(get(r, 'sku'), 120), title: text(get(r, 'product-name'), 500), quantity: qty,
      item_price: money.item_price, item_tax: money.item_tax, price_excl_tax: money.price_excl_tax,
      promotion_discount: money.promotion_discount, promotion_id: text(get(r, 'item-promotion-id'), 200),
      shipping_price: money.shipping_price, shipping_tax: money.shipping_tax, ship_discount: money.ship_discount,
    };
    const prev = o.items.get(itemId);
    if (prev) {
      // The same line item twice: an exact repeat is just a duplicate row.
      if (stable({ ...prev, rowNo: 0 }) === stable({ ...item, rowNo: 0 })) { duplicateRows += 1; return; }
      return fail(rowNo, orderId, `order-item-id ${itemId} appears twice with different values`);
    }
    o.items.set(itemId, { ...item, rowNo });
  });

  // Fold promotion-detail rows into their items.
  let promotionRows = 0;
  for (const d of detailRows) {
    const o = orders.get(d.orderId);
    const item = o?.items.get(d.itemId);
    // Unmatched: reported, and its order (if any) is held back rather than imported without the discount.
    if (!item) { fail(d.rowNo, d.orderId, `Promotion row for order-item-id ${d.itemId} has no matching line item in this file`); continue; }
    if (Number.isNaN(d.itemDiscount) || Number.isNaN(d.shipDiscount)) { fail(d.rowNo, d.orderId, 'Promotion amount is not a number'); continue; }
    item.promotion_discount = Math.round(((item.promotion_discount || 0) + (d.itemDiscount || 0)) * 100) / 100;
    item.ship_discount = Math.round(((item.ship_discount || 0) + (d.shipDiscount || 0)) * 100) / 100;
    if (d.promotionId && !item.promotion_id) item.promotion_id = d.promotionId;
    promotionRows += 1;
  }

  const valid = [];
  for (const o of orders.values()) {
    if (o.bad || !o.order) continue;
    const items = [...o.items.values()].map(({ rowNo, ...it }) => it);
    // Order value = Σ item-price (tax included) + shipping-price
    //               + item-promotion-discount + ship-promotion-discount
    // (Amazon writes discounts as negative numbers). Not cod-collectible-amount.
    const value = items.reduce((sum, it) => sum + (it.item_price || 0) + (it.shipping_price || 0)
      + (it.promotion_discount || 0) + (it.ship_discount || 0), 0);
    valid.push({ ...o.order, order_value: Math.round(value * 100) / 100, items, rows: o.rows });
  }

  return {
    headers,
    ignoredColumns: headers.filter((h) => IGNORED_COLUMNS.has(h)),
    stats: {
      rows: dataRows,
      ordersInFile: orders.size,
      validOrders: valid.length,
      skippedOrders: orders.size - valid.length,
      lineItems: valid.reduce((n, o) => n + o.items.length, 0),
      promotionRows,
      duplicateRows,
      errorRows: errors.length,
      orderValue: Math.round(valid.reduce((s, o) => s + o.order_value, 0) * 100) / 100,
    },
    orders: valid,
    errors,
  };
}

/* ------------------------------------------------------------------ compare */

const ORDER_FIELDS = ['order_date', 'currency', 'order_value', 'customer_name', 'customer_email', 'customer_phone', 'payment_method', 'payment_status'];
const ITEM_FIELDS = ['sku', 'title', 'quantity', 'item_price', 'item_tax', 'price_excl_tax', 'promotion_discount', 'promotion_id', 'shipping_price', 'shipping_tax'];
const sameValue = (a, b) => {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) || /^\d{4}-\d{2}-\d{2}T/.test(String(b))) return new Date(a).getTime() === new Date(b).getTime();
  if (typeof a === 'number' || typeof b === 'number' || /^-?\d+(\.\d+)?$/.test(String(a))) return Number(a) === Number(b);
  return String(a) === String(b);
};

/** What the import would do, against what is already stored. */
async function diff(client, plan) {
  const ids = plan.orders.map((o) => o.source_order_id);
  const { rows: existing } = await client.query(
    `SELECT id, source_order_id, ${ORDER_FIELDS.join(', ')}, source_payload FROM orders
     WHERE channel = 'amazon' AND source_order_id = ANY($1)`, [ids]);
  const byNumber = new Map(existing.map((r) => [r.source_order_id, r]));
  const { rows: existingItems } = existing.length ? await client.query(
    `SELECT order_id, source_line_item_id, ${ITEM_FIELDS.join(', ')} FROM order_items WHERE order_id = ANY($1)`,
    [existing.map((r) => r.id)]) : { rows: [] };
  const itemsByKey = new Map(existingItems.map((r) => [`${r.order_id}|${r.source_line_item_id}`, r]));

  const out = { create: [], update: [], unchanged: [], newItems: 0, changedItems: 0, sameItems: 0 };
  for (const o of plan.orders) {
    const cur = byNumber.get(o.source_order_id);
    if (!cur) { out.create.push(o); out.newItems += o.items.length; continue; }
    const changes = {};
    for (const f of ORDER_FIELDS) {
      // An empty value in the file never wipes something already recorded,
      // and payment status is the team's once set (e.g. a COD marked paid).
      if (o[f] === null && cur[f] !== null) continue;
      if (f === 'payment_status' && cur[f] !== null) continue;
      if (!sameValue(cur[f], o[f])) changes[f] = { from: cur[f] instanceof Date ? cur[f].toISOString() : cur[f], to: o[f] };
    }
    const payloadChanged = stable(cur.source_payload?.amazon ?? null) !== stable(o.amazon);
    let added = 0; let changedItems = 0;
    for (const it of o.items) {
      const ex = itemsByKey.get(`${cur.id}|${it.source_line_item_id}`);
      if (!ex) added += 1;
      else if (ITEM_FIELDS.some((f) => !sameValue(ex[f], it[f]))) changedItems += 1;
      else out.sameItems += 1;
    }
    out.newItems += added; out.changedItems += changedItems;
    const entry = { o, id: Number(cur.id), changes, payloadChanged, added, changedItems };
    if (Object.keys(changes).length || payloadChanged || added || changedItems) out.update.push(entry);
    else out.unchanged.push(entry);
  }
  return out;
}

const summarise = (plan, d) => ({
  ...plan.stats,
  newOrders: d.create.length,
  existingOrders: d.update.length + d.unchanged.length,
  ordersToUpdate: d.update.length,
  ordersUnchanged: d.unchanged.length,
  newLineItems: d.newItems,
  changedLineItems: d.changedItems,
  unchangedLineItems: d.sameItems,
});

/* ------------------------------------------------------------------ preview & import */

/** Reads, validates and compares. Writes nothing. */
export async function previewAmazonImport(buffer, filename) {
  await ensureOrdersSchema();
  const plan = planAmazon(readTable(buffer, filename));
  const d = await diff(getPool(), plan);
  return {
    summary: summarise(plan, d),
    errors: plan.errors.slice(0, MAX_REPORTED_ERRORS),
    errorCount: plan.errors.length,
    ignoredColumns: plan.ignoredColumns,
    sample: [...d.create.slice(0, 8).map((o) => ({ number: o.source_order_id, date: o.order_date, items: o.items.length, value: o.order_value, status: 'new' })),
      ...d.update.slice(0, 4).map((u) => ({ number: u.o.source_order_id, date: u.o.order_date, items: u.o.items.length, value: u.o.order_value, status: 'update' }))],
  };
}

/**
 * Imports the valid orders in one transaction, re-reading the database inside
 * it so the result matches the moment of writing. One import at a time.
 */
export async function commitAmazonImport(buffer, filename, { actor } = {}) {
  await ensureOrdersSchema();
  const plan = planAmazon(readTable(buffer, filename));
  return inTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('orders:amazon-import'))`);
    const d = await diff(client, plan);
    const ids = new Map([...d.update, ...d.unchanged].map((u) => [u.o.source_order_id, u.id]));

    // New orders and their creation events, in bulk. No shipment: that comes later.
    if (d.create.length) {
      const c = d.create;
      const { rows } = await client.query(
        `INSERT INTO orders (channel, dispatch_type, source, source_order_id, order_date, currency, order_value,
                             customer_name, customer_email, customer_phone, payment_method, payment_status,
                             source_payload, created_by, updated_by)
         SELECT 'amazon', 'easy_ship', 'amazon_import', * , $11, $11 FROM unnest(
           $1::text[], $2::timestamptz[], $3::text[], $4::numeric[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::jsonb[])
         ON CONFLICT (channel, source_order_id) DO NOTHING
         RETURNING id, source_order_id`,
        [c.map((o) => o.source_order_id), c.map((o) => o.order_date), c.map((o) => o.currency),
          c.map((o) => o.order_value), c.map((o) => o.customer_name), c.map((o) => o.customer_email),
          c.map((o) => o.customer_phone), c.map((o) => o.payment_method), c.map((o) => o.payment_status),
          c.map((o) => JSON.stringify({ amazon: o.amazon })), actor]);
      if (rows.length !== c.length) throw bad('Another import added some of these orders at the same moment. Check the file again.', 409);
      for (const r of rows) ids.set(r.source_order_id, Number(r.id));
      const orderIds = rows.map((r) => Number(r.id));
      const byNumber = new Map(c.map((o) => [o.source_order_id, o]));
      await client.query(
        `INSERT INTO order_events (order_id, event_type, actor, metadata)
         SELECT unnest($1::bigint[]), 'order_created', $3, unnest($2::jsonb[])`,
        [orderIds, rows.map((r) => {
          const o = byNumber.get(r.source_order_id);
          return JSON.stringify({ source: 'amazon_import', file: filename || null, channel: 'amazon', source_order_id: o.source_order_id,
            order_value: o.order_value, dispatch_type: 'easy_ship', items: o.items.length });
        }), actor]);
    }

    // Existing orders: Amazon-owned fields only, one event per changed order.
    for (const u of d.update) {
      const keys = Object.keys(u.changes);
      if (keys.length || u.payloadChanged) {
        const sets = keys.map((k, i) => `${k} = $${i + 3}`);
        await client.query(
          `UPDATE orders SET ${[...sets, `source_payload = coalesce(source_payload, '{}'::jsonb) || $${keys.length + 3}::jsonb`].join(', ')},
             version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`,
          [u.id, actor, ...keys.map((k) => u.o[k]), JSON.stringify({ amazon: u.o.amazon })]);
      }
      if (keys.length || u.payloadChanged || u.added || u.changedItems) {
        await logEvent(client, u.id, 'amazon_import_updated', actor, {
          file: filename || null, changes: u.changes, details_changed: u.payloadChanged || undefined,
          items_added: u.added || undefined, items_updated: u.changedItems || undefined,
        });
      }
    }

    // Line items: new ones added, changed ones updated, identical ones untouched.
    const all = plan.orders.flatMap((o) => o.items.map((it) => ({ ...it, order_id: ids.get(o.source_order_id) })));
    let added = 0; let updated = 0;
    if (all.length) {
      const { rows } = await client.query(
        `INSERT INTO order_items (order_id, source_line_item_id, sku, title, quantity, item_price, item_tax, price_excl_tax,
                                  promotion_discount, promotion_id, shipping_price, shipping_tax)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::int[], $6::numeric[], $7::numeric[],
                              $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::numeric[])
         ON CONFLICT (order_id, source_line_item_id) DO UPDATE SET
           sku = EXCLUDED.sku, title = EXCLUDED.title, quantity = EXCLUDED.quantity, item_price = EXCLUDED.item_price,
           item_tax = EXCLUDED.item_tax, price_excl_tax = EXCLUDED.price_excl_tax, promotion_discount = EXCLUDED.promotion_discount,
           promotion_id = EXCLUDED.promotion_id, shipping_price = EXCLUDED.shipping_price, shipping_tax = EXCLUDED.shipping_tax,
           updated_at = now()
         WHERE (order_items.sku, order_items.title, order_items.quantity, order_items.item_price, order_items.item_tax,
                order_items.price_excl_tax, order_items.promotion_discount, order_items.promotion_id,
                order_items.shipping_price, order_items.shipping_tax)
           IS DISTINCT FROM (EXCLUDED.sku, EXCLUDED.title, EXCLUDED.quantity, EXCLUDED.item_price, EXCLUDED.item_tax,
                EXCLUDED.price_excl_tax, EXCLUDED.promotion_discount, EXCLUDED.promotion_id,
                EXCLUDED.shipping_price, EXCLUDED.shipping_tax)
         RETURNING (xmax = 0) AS inserted`,
        [all.map((x) => x.order_id), all.map((x) => x.source_line_item_id), all.map((x) => x.sku), all.map((x) => x.title),
          all.map((x) => x.quantity), all.map((x) => x.item_price), all.map((x) => x.item_tax), all.map((x) => x.price_excl_tax),
          all.map((x) => x.promotion_discount), all.map((x) => x.promotion_id), all.map((x) => x.shipping_price),
          all.map((x) => x.shipping_tax)]);
      added = rows.filter((r) => r.inserted).length;
      updated = rows.length - added;
    }

    const summary = {
      ...summarise(plan, d),
      ordersCreated: d.create.length,
      ordersUpdated: d.update.length,
      lineItemsAdded: added,
      lineItemsUpdated: updated,
    };
    const { rows: rec } = await client.query(
      `INSERT INTO order_imports (channel, imported_by, filename, file_sha256, rows_processed, orders_in_file, orders_created,
         orders_updated, orders_unchanged, items_created, items_updated, promotion_rows, duplicate_rows, error_rows, errors)
       VALUES ('amazon', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, imported_at`,
      [actor, filename || null, crypto.createHash('sha256').update(buffer).digest('hex'), summary.rows, summary.ordersInFile,
        summary.ordersCreated, summary.ordersUpdated, summary.ordersUnchanged, added, updated, summary.promotionRows,
        summary.duplicateRows, plan.errors.length, JSON.stringify(plan.errors.slice(0, MAX_REPORTED_ERRORS))]);
    return {
      importId: Number(rec[0].id),
      importedAt: rec[0].imported_at,
      summary,
      errors: plan.errors.slice(0, MAX_REPORTED_ERRORS),
      errorCount: plan.errors.length,
    };
  });
}

/** The latest imports, newest first, for the import drawer. */
export async function recentImports(limit = 10) {
  const { rows } = await getPool().query(
    `SELECT id, channel, imported_at, imported_by, filename, rows_processed, orders_created, orders_updated,
            orders_unchanged, items_created, items_updated, duplicate_rows, error_rows
     FROM order_imports ORDER BY imported_at DESC, id DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}
