import crypto from 'node:crypto';
import { getPool } from './db.js';
import { ensureOrdersSchema } from './orders.js';

/**
 * Order financial snapshots — Shopify's financial record of each order, kept
 * apart from the operational order model (Phase 1B).
 *
 * orders / order_items are the logistics representation: shaped for parcels and
 * stock, and deliberately frozen once stock is reserved or dispatched. They are
 * NOT a financial source (no tax-inclusive flag, no refunds, current quantity
 * paired with an original price). This layer is: an append-only history of what
 * Shopify said, captured by the existing order sync, for future affiliate
 * attribution and commission calculation. It calculates nothing itself.
 *
 *   order_financial_snapshots                one row per materially different state of an order
 *   order_financial_snapshot_lines           the order's lines in that state
 *   order_financial_snapshot_refunds         its refunds in that state
 *   order_financial_snapshot_refund_lines    each refund's lines
 *   order_financial_snapshot_refund_shipping each refund's shipping lines
 *
 * Append-only: rows are never updated or deleted (database triggers), except a
 * DELETE inside a transaction that sets app.purge_order_financials — the test
 * suite's purge only. The latest state of an order is its highest `sequence`
 * (view order_financial_latest).
 *
 * Money: Shopify's amount strings are kept verbatim (shop and presentment
 * currency) in money JSONB; the numeric columns hold the shop-currency amounts as
 * NUMERIC(14,2), converted by Postgres from the string — never via a JavaScript
 * number. An amount with more than 2 decimal places is refused rather than rounded.
 */

const GID = (type) => new RegExp(`^gid://shopify/${type}/\\d+$`);

let schema = null;
export function ensureOrderFinancialSnapshotSchema() {
  if (!schema) {
    schema = (async () => {
      await ensureOrdersSchema();
      const ddl = [];
      ddl.push(`
        CREATE TABLE IF NOT EXISTS order_financial_snapshots (
          id                      BIGSERIAL PRIMARY KEY,
          order_id                BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
          shopify_order_gid       TEXT NOT NULL CHECK (shopify_order_gid ~ '^gid://shopify/Order/[0-9]+$'),
          shopify_order_name      TEXT,
          sequence                INTEGER NOT NULL CHECK (sequence > 0),
          content_hash            TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
          source                  TEXT NOT NULL DEFAULT 'shopify_sync',
          sync_run_id             BIGINT,
          shopify_updated_at      TIMESTAMPTZ,
          captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          shop_currency           TEXT NOT NULL CHECK (shop_currency ~ '^[A-Z]{3}$'),
          presentment_currency    TEXT NOT NULL CHECK (presentment_currency ~ '^[A-Z]{3}$'),
          taxes_included          BOOLEAN NOT NULL,
          financial_status        TEXT,
          cancelled_at            TIMESTAMPTZ,
          current_subtotal        NUMERIC(14,2) NOT NULL,
          current_total_tax       NUMERIC(14,2) NOT NULL,
          current_shipping        NUMERIC(14,2) NOT NULL,
          current_total_discounts NUMERIC(14,2) NOT NULL,
          current_total_price     NUMERIC(14,2) NOT NULL,
          total_price             NUMERIC(14,2) NOT NULL,
          total_refunded          NUMERIC(14,2) NOT NULL,
          total_refunded_shipping NUMERIC(14,2) NOT NULL,
          discount_codes          TEXT[] NOT NULL DEFAULT '{}',
          discount_applications   JSONB NOT NULL DEFAULT '[]',
          custom_attributes       JSONB NOT NULL DEFAULT '[]',
          shopify_customer_gid    TEXT,
          money                   JSONB NOT NULL,
          CONSTRAINT order_financial_snapshots_order_sequence_key UNIQUE (order_id, sequence)
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS order_financial_snapshots_gid_idx ON order_financial_snapshots (shopify_order_gid, sequence DESC)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS order_financial_snapshot_lines (
          id                              BIGSERIAL PRIMARY KEY,
          snapshot_id                     BIGINT NOT NULL REFERENCES order_financial_snapshots(id) ON DELETE RESTRICT,
          position                        INTEGER NOT NULL,
          shopify_line_gid                TEXT NOT NULL CHECK (shopify_line_gid ~ '^gid://shopify/LineItem/[0-9]+$'),
          sku                             TEXT,
          name                            TEXT,
          title                           TEXT,
          variant_title                   TEXT,
          shopify_variant_gid             TEXT,
          shopify_product_gid             TEXT,
          quantity                        INTEGER NOT NULL CHECK (quantity >= 0),
          current_quantity                INTEGER NOT NULL CHECK (current_quantity >= 0),
          refundable_quantity             INTEGER NOT NULL CHECK (refundable_quantity >= 0),
          taxable                         BOOLEAN NOT NULL,
          is_gift_card                    BOOLEAN NOT NULL,
          requires_shipping               BOOLEAN NOT NULL,
          original_unit_price             NUMERIC(14,2) NOT NULL,
          discounted_unit_price_after_all NUMERIC(14,2) NOT NULL,
          original_total                  NUMERIC(14,2) NOT NULL,
          discounted_total                NUMERIC(14,2) NOT NULL,
          total_discount                  NUMERIC(14,2) NOT NULL,
          tax_amount                      NUMERIC(14,2) NOT NULL,
          tax_lines                       JSONB NOT NULL DEFAULT '[]',
          discount_allocations            JSONB NOT NULL DEFAULT '[]',
          money                           JSONB NOT NULL,
          CONSTRAINT order_financial_snapshot_lines_line_key UNIQUE (snapshot_id, shopify_line_gid)
        )`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS order_financial_snapshot_refunds (
          id                BIGSERIAL PRIMARY KEY,
          snapshot_id       BIGINT NOT NULL REFERENCES order_financial_snapshots(id) ON DELETE RESTRICT,
          shopify_refund_gid TEXT NOT NULL CHECK (shopify_refund_gid ~ '^gid://shopify/Refund/[0-9]+$'),
          refunded_at       TIMESTAMPTZ,
          note              TEXT,
          total_refunded    NUMERIC(14,2) NOT NULL,
          money             JSONB NOT NULL,
          CONSTRAINT order_financial_snapshot_refunds_refund_key UNIQUE (snapshot_id, shopify_refund_gid)
        )`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS order_financial_snapshot_refund_lines (
          id                      BIGSERIAL PRIMARY KEY,
          refund_id               BIGINT NOT NULL REFERENCES order_financial_snapshot_refunds(id) ON DELETE RESTRICT,
          position                INTEGER NOT NULL,
          shopify_refund_line_gid TEXT,
          shopify_line_gid        TEXT NOT NULL CHECK (shopify_line_gid ~ '^gid://shopify/LineItem/[0-9]+$'),
          quantity                INTEGER NOT NULL CHECK (quantity >= 0),
          restock_type            TEXT,
          restocked               BOOLEAN,
          price                   NUMERIC(14,2) NOT NULL,
          subtotal                NUMERIC(14,2) NOT NULL,
          total_tax               NUMERIC(14,2) NOT NULL,
          money                   JSONB NOT NULL,
          CONSTRAINT order_financial_snapshot_refund_lines_position_key UNIQUE (refund_id, position)
        )`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS order_financial_snapshot_refund_shipping (
          id                 BIGSERIAL PRIMARY KEY,
          refund_id          BIGINT NOT NULL REFERENCES order_financial_snapshot_refunds(id) ON DELETE RESTRICT,
          shopify_refund_shipping_gid TEXT NOT NULL,
          title              TEXT,
          code               TEXT,
          subtotal           NUMERIC(14,2) NOT NULL,
          tax                NUMERIC(14,2) NOT NULL,
          money              JSONB NOT NULL,
          CONSTRAINT order_financial_snapshot_refund_shipping_key UNIQUE (refund_id, shopify_refund_shipping_gid)
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS ofs_lines_snapshot_idx ON order_financial_snapshot_lines (snapshot_id)');
      ddl.push('CREATE INDEX IF NOT EXISTS ofs_refunds_snapshot_idx ON order_financial_snapshot_refunds (snapshot_id)');
      ddl.push('CREATE INDEX IF NOT EXISTS ofs_refund_lines_refund_idx ON order_financial_snapshot_refund_lines (refund_id)');
      ddl.push('CREATE INDEX IF NOT EXISTS ofs_refund_shipping_refund_idx ON order_financial_snapshot_refund_shipping (refund_id)');
      // The latest state of each order.
      ddl.push(`CREATE OR REPLACE VIEW order_financial_latest AS
        SELECT DISTINCT ON (order_id) * FROM order_financial_snapshots ORDER BY order_id, sequence DESC`);
      ddl.push(`
        CREATE OR REPLACE FUNCTION order_financial_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND current_setting('app.purge_order_financials', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
        END $$ LANGUAGE plpgsql`);
      for (const t of FINANCIAL_TABLES) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_append_only ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
                  FOR EACH ROW EXECUTE FUNCTION order_financial_append_only()`);
      }
      await getPool().query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}
export const FINANCIAL_TABLES = ['order_financial_snapshots', 'order_financial_snapshot_lines', 'order_financial_snapshot_refunds',
  'order_financial_snapshot_refund_lines', 'order_financial_snapshot_refund_shipping'];

/* ------------------------------------------------------------------ normalisation (pure) */

const fail = (msg) => { throw Object.assign(new Error(`Financial snapshot: ${msg}`), { financial: true }); };

/** Shopify's amount string, checked — never converted to a JS number. At most 2 decimals (refused, not rounded). */
function amountString(v, what) {
  const s = String(v ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) fail(`${what} is not an amount ("${s}")`);
  const [, dec = ''] = s.split('.');
  if (dec.replace(/0+$/, '').length > 2) fail(`${what} has more than 2 decimal places ("${s}")`);
  return s;
}
/** A MoneyBag → { shop: {amount, currency}, presentment: {amount, currency} }, strings verbatim. */
function bag(b, what, { required = true } = {}) {
  if (!b) { if (required) fail(`${what} is missing`); return null; }
  const one = (m, side) => {
    if (!m) fail(`${what}.${side} is missing`);
    if (!/^[A-Z]{3}$/.test(String(m.currencyCode || ''))) fail(`${what}.${side} has no currency`);
    return { amount: amountString(m.amount, `${what}.${side}`), currency: m.currencyCode };
  };
  return { shop: one(b.shopMoney, 'shopMoney'), presentment: one(b.presentmentMoney, 'presentmentMoney') };
}
/** Sums amount strings exactly, in minor units (BigInt), back to a 2-decimal string. */
export function addAmounts(list) {
  const cents = list.reduce((sum, s) => {
    const neg = s.startsWith('-'); const [i, d = ''] = s.replace('-', '').split('.');
    const v = BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
    return sum + (neg ? -v : v);
  }, 0n);
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
const int = (v, what) => (Number.isInteger(v) && v >= 0 ? v : fail(`${what} is not a whole number`));
const bool = (v, what) => (typeof v === 'boolean' ? v : fail(`${what} is missing`));

/**
 * One fully fetched Shopify order (page + detail + refund requests assembled)
 * → the snapshot. Throws if anything required is missing or malformed.
 */
export function financialSnapshotFrom(node) {
  if (!GID('Order').test(String(node?.id || ''))) fail('order id is missing or malformed');
  const shop = node.currencyCode; const presentment = node.presentmentCurrencyCode;
  if (!/^[A-Z]{3}$/.test(String(shop || '')) || !/^[A-Z]{3}$/.test(String(presentment || ''))) fail('currency codes are missing');
  const money = {
    current_subtotal: bag(node.currentSubtotalPriceSet, 'currentSubtotalPriceSet'),
    current_total_tax: bag(node.currentTotalTaxSet, 'currentTotalTaxSet'),
    current_shipping: bag(node.currentShippingPriceSet, 'currentShippingPriceSet'),
    current_total_discounts: bag(node.currentTotalDiscountsSet, 'currentTotalDiscountsSet'),
    current_total_price: bag(node.currentTotalPriceSet, 'currentTotalPriceSet'),
    total_price: bag(node.totalPriceSet, 'totalPriceSet'),
    total_refunded: bag(node.totalRefundedSet, 'totalRefundedSet'),
    total_refunded_shipping: bag(node.totalRefundedShippingSet, 'totalRefundedShippingSet'),
  };
  for (const [k, v] of Object.entries(money)) if (v.shop.currency !== shop) fail(`${k} is not in the shop currency`);
  const lines = (node.lineItems?.nodes || []).map((li, position) => {
    if (!GID('LineItem').test(String(li?.id || ''))) fail(`line ${position + 1} id is missing`);
    const m = {
      original_unit_price: bag(li.originalUnitPriceSet, `line ${li.id} originalUnitPriceSet`),
      discounted_unit_price_after_all: bag(li.discountedUnitPriceAfterAllDiscountsSet, `line ${li.id} discountedUnitPriceAfterAllDiscountsSet`),
      original_total: bag(li.originalTotalSet, `line ${li.id} originalTotalSet`),
      discounted_total: bag(li.discountedTotalSet, `line ${li.id} discountedTotalSet`),
      total_discount: bag(li.totalDiscountSet, `line ${li.id} totalDiscountSet`),
    };
    const taxLines = (li.taxLines || []).map((t) => ({ title: t.title ?? null, rate: t.rate ?? null, rate_percentage: t.ratePercentage ?? null,
      channel_liable: t.channelLiable ?? null, price: bag(t.priceSet, `line ${li.id} tax line`) }));
    const allocations = (li.discountAllocations || []).map((a) => ({ application_index: a.discountApplication?.index ?? null,
      amount: bag(a.allocatedAmountSet, `line ${li.id} discount allocation`) }));
    return {
      position, shopify_line_gid: li.id, sku: li.sku ?? null, name: li.name ?? null, title: li.title ?? null, variant_title: li.variantTitle ?? null,
      shopify_variant_gid: li.variant?.id ?? null, shopify_product_gid: li.product?.id ?? null,
      quantity: int(li.quantity, `line ${li.id} quantity`), current_quantity: int(li.currentQuantity, `line ${li.id} currentQuantity`),
      refundable_quantity: int(li.refundableQuantity, `line ${li.id} refundableQuantity`),
      taxable: bool(li.taxable, `line ${li.id} taxable`), is_gift_card: bool(li.isGiftCard, `line ${li.id} isGiftCard`),
      requires_shipping: bool(li.requiresShipping, `line ${li.id} requiresShipping`),
      money: m, tax_amount: addAmounts(taxLines.map((t) => t.price.shop.amount)), tax_lines: taxLines, discount_allocations: allocations,
    };
  });
  const refunds = (node.refunds || []).map((r) => {
    if (!GID('Refund').test(String(r?.id || ''))) fail('refund id is missing');
    return {
      shopify_refund_gid: r.id, refunded_at: r.createdAt ?? null, note: r.note ?? null,
      money: { total_refunded: bag(r.totalRefundedSet, `refund ${r.id} totalRefundedSet`) },
      lines: (r.refundLineItems?.nodes || []).map((rl, position) => ({
        position, shopify_refund_line_gid: rl.id ?? null, shopify_line_gid: rl.lineItem?.id ?? fail(`refund ${r.id} line has no line item`),
        quantity: int(rl.quantity, `refund ${r.id} line quantity`), restock_type: rl.restockType ?? null, restocked: rl.restocked ?? null,
        money: { price: bag(rl.priceSet, `refund ${r.id} line priceSet`), subtotal: bag(rl.subtotalSet, `refund ${r.id} line subtotalSet`),
          total_tax: bag(rl.totalTaxSet, `refund ${r.id} line totalTaxSet`) },
      })),
      shipping: (r.refundShippingLines?.nodes || []).map((s) => ({
        shopify_refund_shipping_gid: s.id ?? fail(`refund ${r.id} shipping line has no id`), title: s.shippingLine?.title ?? null, code: s.shippingLine?.code ?? null,
        money: { subtotal: bag(s.subtotalAmountSet, `refund ${r.id} shipping subtotal`), tax: bag(s.taxAmountSet, `refund ${r.id} shipping tax`) },
      })),
    };
  });
  const applications = (node.discountApplications?.nodes || []).map((a) => ({
    index: a.index, allocation_method: a.allocationMethod ?? null, target_selection: a.targetSelection ?? null, target_type: a.targetType ?? null,
    type: a.code !== undefined ? 'code' : a.description !== undefined ? 'manual' : a.title !== undefined ? 'automatic_or_script' : 'unknown',
    code: a.code ?? null, title: a.title ?? null, description: a.description ?? null,
    value: a.value?.percentage !== undefined ? { percentage: String(a.value.percentage) }
      : a.value?.amount !== undefined ? { amount: amountString(a.value.amount, 'discount value'), currency: a.value.currencyCode } : null,
  }));
  return {
    shopify_order_gid: node.id, shopify_order_name: node.name ?? null, shopify_updated_at: node.updatedAt ?? null,
    shop_currency: shop, presentment_currency: presentment, taxes_included: bool(node.taxesIncluded, 'taxesIncluded'),
    financial_status: node.displayFinancialStatus ?? null, cancelled_at: node.cancelledAt ?? null,
    discount_codes: (node.discountCodes || []).map(String), discount_applications: applications,
    custom_attributes: (node.customAttributes || []).map((a) => ({ key: String(a.key), value: a.value === null || a.value === undefined ? null : String(a.value) })),
    shopify_customer_gid: node.customer?.id ?? null,
    money, lines, refunds,
  };
}

const stable = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : JSON.stringify(v ?? null));

/**
 * The identity of a financial state: everything in the snapshot except
 * bookkeeping. Shopify's updatedAt changes for tags or notes too; the customer
 * GID is reference only and is absent whenever protected customer data is not
 * available, which is not a financial change. Equal hash → nothing financially
 * changed → no new snapshot.
 */
export function snapshotHash(snap) {
  const { shopify_updated_at: _u, shopify_customer_gid: _c, ...content } = snap;
  return crypto.createHash('sha256').update(stable(content)).digest('hex');
}

/* ------------------------------------------------------------------ writing */

/**
 * Records `snap` for `orderId` in the caller's transaction, unless the order's
 * latest snapshot already has the same content. Returns { recorded, sequence }.
 * The caller holds the sync's advisory lock, so sequences cannot race; the
 * UNIQUE (order_id, sequence) is the backstop.
 */
export async function recordFinancialSnapshot(client, orderId, snap, { runId = null } = {}) {
  const hash = snapshotHash(snap);
  const { rows: [latest] } = await client.query(
    'SELECT sequence, content_hash FROM order_financial_snapshots WHERE order_id = $1 ORDER BY sequence DESC LIMIT 1', [orderId]);
  if (latest?.content_hash === hash) return { recorded: false, sequence: latest.sequence };
  const sequence = (latest?.sequence || 0) + 1;
  const m = snap.money; const shopAmt = (k) => m[k].shop.amount;
  const { rows: [s] } = await client.query(
    `INSERT INTO order_financial_snapshots (order_id, shopify_order_gid, shopify_order_name, sequence, content_hash, sync_run_id,
       shopify_updated_at, shop_currency, presentment_currency, taxes_included, financial_status, cancelled_at,
       current_subtotal, current_total_tax, current_shipping, current_total_discounts, current_total_price, total_price,
       total_refunded, total_refunded_shipping, discount_codes, discount_applications, custom_attributes, shopify_customer_gid, money)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17::numeric,$18::numeric,
       $19::numeric,$20::numeric,$21,$22,$23,$24,$25) RETURNING id`,
    [orderId, snap.shopify_order_gid, snap.shopify_order_name, sequence, hash, runId, snap.shopify_updated_at, snap.shop_currency,
      snap.presentment_currency, snap.taxes_included, snap.financial_status, snap.cancelled_at,
      shopAmt('current_subtotal'), shopAmt('current_total_tax'), shopAmt('current_shipping'), shopAmt('current_total_discounts'),
      shopAmt('current_total_price'), shopAmt('total_price'), shopAmt('total_refunded'), shopAmt('total_refunded_shipping'),
      snap.discount_codes, JSON.stringify(snap.discount_applications), JSON.stringify(snap.custom_attributes), snap.shopify_customer_gid, JSON.stringify(m)]);
  for (const l of snap.lines) {
    const a = (k) => l.money[k].shop.amount;
    await client.query(
      `INSERT INTO order_financial_snapshot_lines (snapshot_id, position, shopify_line_gid, sku, name, title, variant_title, shopify_variant_gid,
         shopify_product_gid, quantity, current_quantity, refundable_quantity, taxable, is_gift_card, requires_shipping, original_unit_price,
         discounted_unit_price_after_all, original_total, discounted_total, total_discount, tax_amount, tax_lines, discount_allocations, money)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::numeric,$17::numeric,$18::numeric,$19::numeric,$20::numeric,$21::numeric,$22,$23,$24)`,
      [s.id, l.position, l.shopify_line_gid, l.sku, l.name, l.title, l.variant_title, l.shopify_variant_gid, l.shopify_product_gid, l.quantity,
        l.current_quantity, l.refundable_quantity, l.taxable, l.is_gift_card, l.requires_shipping, a('original_unit_price'),
        a('discounted_unit_price_after_all'), a('original_total'), a('discounted_total'), a('total_discount'), l.tax_amount,
        JSON.stringify(l.tax_lines), JSON.stringify(l.discount_allocations), JSON.stringify(l.money)]);
  }
  for (const r of snap.refunds) {
    const { rows: [rr] } = await client.query(
      `INSERT INTO order_financial_snapshot_refunds (snapshot_id, shopify_refund_gid, refunded_at, note, total_refunded, money)
       VALUES ($1,$2,$3,$4,$5::numeric,$6) RETURNING id`,
      [s.id, r.shopify_refund_gid, r.refunded_at, r.note, r.money.total_refunded.shop.amount, JSON.stringify(r.money)]);
    for (const rl of r.lines) {
      await client.query(
        `INSERT INTO order_financial_snapshot_refund_lines (refund_id, position, shopify_refund_line_gid, shopify_line_gid, quantity, restock_type,
           restocked, price, subtotal, total_tax, money) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11)`,
        [rr.id, rl.position, rl.shopify_refund_line_gid, rl.shopify_line_gid, rl.quantity, rl.restock_type, rl.restocked,
          rl.money.price.shop.amount, rl.money.subtotal.shop.amount, rl.money.total_tax.shop.amount, JSON.stringify(rl.money)]);
    }
    for (const sh of r.shipping) {
      await client.query(
        `INSERT INTO order_financial_snapshot_refund_shipping (refund_id, shopify_refund_shipping_gid, title, code, subtotal, tax, money)
         VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7)`,
        [rr.id, sh.shopify_refund_shipping_gid, sh.title, sh.code, sh.money.subtotal.shop.amount, sh.money.tax.shop.amount, JSON.stringify(sh.money)]);
    }
  }
  return { recorded: true, sequence };
}

/** Content hashes of the latest snapshot for each order id (read-only; for previews). */
export async function latestSnapshotHashes(db, orderIds) {
  if (!orderIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (order_id) order_id, content_hash FROM order_financial_snapshots WHERE order_id = ANY($1) ORDER BY order_id, sequence DESC`, [orderIds]);
  return new Map(rows.map((r) => [Number(r.order_id), r.content_hash]));
}
