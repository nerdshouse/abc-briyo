import crypto from 'node:crypto';
import { getPool } from './db.js';
import { ensureOrdersSchema, inTransaction, teamTimezone } from './orders.js';
import { assertMarkerIn } from './env-guard.js';
import { storage, validateDocument, DEFAULT_FORMATS } from './storage.js';

/**
 * Inventory: one canonical SKU per sellable variant, stock held in batches,
 * and every change to stock written to an append-only ledger.
 *
 *   skus                    the SKU master. Amazon identifiers are columns on
 *                           the SKU, never alternative SKUs. Shopify uses `sku`.
 *   inventory_batches       a batch of one SKU in one warehouse. `on_hand` is
 *                           maintained by the database from the ledger only.
 *   inventory_movements     the ledger: signed quantities, append-only.
 *   inventory_reservations  stock set aside for a shipment, per batch.
 *   batch_documents         COAs and other papers, kept in document storage.
 *   suppliers, warehouses   small lookups so names are not retyped.
 *   inventory_audit         non-quantity actions: SKU edits, status, uploads.
 *
 * Importing or creating an order never touches stock. A shipment can reserve
 * stock; dispatching it deducts exactly what was reserved, in the same
 * transaction as the status change, once.
 */

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// ---------------------------------------------------------------- constants

/** Every movement type, its direction and label. */
export const MOVEMENT_TYPES = {
  received: { sign: 1, label: 'Inventory received' },
  customer_return: { sign: 1, label: 'Customer return' },
  adjustment_increase: { sign: 1, label: 'Stock adjustment increase' },
  transfer_in: { sign: 1, label: 'Transfer in' },
  shipment_dispatched: { sign: -1, label: 'Shipment dispatched' },
  damaged: { sign: -1, label: 'Damaged' },
  expired: { sign: -1, label: 'Expired' },
  sample: { sign: -1, label: 'Sample' },
  internal_use: { sign: -1, label: 'Internal use' },
  adjustment_decrease: { sign: -1, label: 'Stock adjustment decrease' },
  transfer_out: { sign: -1, label: 'Transfer out' },
};
const IN_TYPES = Object.keys(MOVEMENT_TYPES).filter((k) => MOVEMENT_TYPES[k].sign > 0);
const OUT_TYPES = Object.keys(MOVEMENT_TYPES).filter((k) => MOVEMENT_TYPES[k].sign < 0);
/** What staff may record by hand. Receipts, transfers and dispatch have their own flows. */
export const MANUAL_MOVEMENTS = ['customer_return', 'adjustment_increase', 'damaged', 'expired', 'sample', 'internal_use', 'adjustment_decrease'];

/** Statuses a person sets. "Expired" by date and "Depleted" are worked out, not stored. */
export const BATCH_STATUSES = ['active', 'quarantined', 'blocked', 'expired'];
export const EFFECTIVE_STATUSES = ['active', 'quarantined', 'blocked', 'expired', 'depleted'];
export const BATCH_DOCUMENT_TYPES = ['coa', 'lab_report', 'supplier_invoice', 'purchase_document', 'other'];
export const EXPIRY_WINDOWS = [30, 60, 90];
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

// ---------------------------------------------------------------- schema

let inventorySchema = null;
export function ensureInventorySchema() {
  if (!inventorySchema) {
    inventorySchema = (async () => {
      await ensureOrdersSchema();
      const sql = getPool();
      // Every statement is idempotent DDL without parameters, so they travel as
      // one batch: one round trip to the database instead of one per statement.
      const ddl = [];
      ddl.push(`
        CREATE TABLE IF NOT EXISTS skus (
          id                 SERIAL PRIMARY KEY,
          sku                TEXT NOT NULL,
          product_name       TEXT NOT NULL,
          variant_name       TEXT,
          category           TEXT,
          unit_type          TEXT NOT NULL DEFAULT 'unit',
          active             BOOLEAN NOT NULL DEFAULT true,
          reorder_level      INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
          reorder_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (reorder_quantity >= 0),
          amazon_seller_sku  TEXT,
          asin               TEXT,
          amazon_listing_id  TEXT,
          amazon_product_id  TEXT,
          amazon_item_name   TEXT,
          track_inventory    BOOLEAN NOT NULL DEFAULT true,
          version            INTEGER NOT NULL DEFAULT 1,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by         TEXT,
          updated_by         TEXT
        )`);
      // One SKU system-wide, whatever the letter case; one SKU per Amazon seller SKU.
      // A SKU that is not physical stock (a service, a digital item) is not checked at dispatch.
      ddl.push('ALTER TABLE skus ADD COLUMN IF NOT EXISTS track_inventory BOOLEAN NOT NULL DEFAULT true');
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS skus_sku_key ON skus (lower(sku))');
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS skus_amazon_seller_sku_key ON skus (lower(amazon_seller_sku)) WHERE amazon_seller_sku IS NOT NULL');

      // Platforms whose SKUs map to master SKUs. Adding one is a row, not a
      // migration. A platform's key matches the order channel key (amazon,
      // blinkit, tata_1mg…), which is how an order line finds its platform.
      ddl.push(`
        CREATE TABLE IF NOT EXISTS sku_platforms (
          key        TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
          label      TEXT NOT NULL,
          active     BOOLEAN NOT NULL DEFAULT true,
          sort       INTEGER NOT NULL DEFAULT 100,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      ddl.push(`INSERT INTO sku_platforms (key, label, sort) VALUES
        ('amazon', 'Amazon', 10), ('blinkit', 'Blinkit', 20), ('zepto', 'Zepto', 30),
        ('tata_1mg', 'Tata 1mg', 40), ('netmeds', 'Netmeds', 50), ('clinikally', 'Clinikally', 60),
        ('website', 'Website · Shopify', 5)
        ON CONFLICT (key) DO NOTHING`);
      // Platform SKU → master SKU. A platform SKU normally means one master; a
      // second master is only added deliberately, with a recorded reason
      // (duplicate_override). A master may have many platform SKUs.
      ddl.push(`
        CREATE TABLE IF NOT EXISTS sku_platform_mappings (
          id           BIGSERIAL PRIMARY KEY,
          sku_id       INTEGER NOT NULL REFERENCES skus(id),
          platform     TEXT NOT NULL REFERENCES sku_platforms(key),
          platform_sku TEXT NOT NULL CHECK (platform_sku <> '' AND platform_sku = btrim(platform_sku) AND platform_sku !~ '[\\r\\n\\t]'),
          source       TEXT NOT NULL DEFAULT 'manual',
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by   TEXT
        )`);
      ddl.push('ALTER TABLE sku_platform_mappings ADD COLUMN IF NOT EXISTS duplicate_override BOOLEAN NOT NULL DEFAULT false');
      ddl.push('ALTER TABLE sku_platform_mappings ADD COLUMN IF NOT EXISTS duplicate_reason TEXT');
      // How many master-SKU units one channel listing is (a "pack of 2" listing
      // of a single-pack master = 2). Existing mappings become 1.
      ddl.push('ALTER TABLE sku_platform_mappings ADD COLUMN IF NOT EXISTS units_per_listing INTEGER NOT NULL DEFAULT 1');
      ddl.push(`DO $$ BEGIN
        ALTER TABLE sku_platform_mappings ADD CONSTRAINT sku_platform_mappings_units_per_listing CHECK (units_per_listing >= 1);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      ddl.push(`DO $$ BEGIN
        ALTER TABLE sku_platform_mappings ADD CONSTRAINT sku_platform_mappings_override_reason
          CHECK (NOT duplicate_override OR coalesce(btrim(duplicate_reason), '') <> '');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      // Unique per master (no duplicate rows); the same code on two masters is
      // allowed only through the override above.
      ddl.push('DROP INDEX IF EXISTS sku_platform_mappings_key');
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS sku_platform_mappings_master_key ON sku_platform_mappings (sku_id, platform, lower(platform_sku))');
      ddl.push('CREATE INDEX IF NOT EXISTS sku_platform_mappings_code_idx ON sku_platform_mappings (platform, lower(platform_sku))');
      ddl.push('CREATE INDEX IF NOT EXISTS sku_platform_mappings_sku_idx ON sku_platform_mappings (sku_id)');


      ddl.push(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          reference  TEXT,
          active     BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by TEXT
        )`);
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON suppliers (lower(name))');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS warehouses (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          active     BOOLEAN NOT NULL DEFAULT true,
          sort       INTEGER NOT NULL DEFAULT 100,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS warehouses_name_key ON warehouses (lower(name))');
      ddl.push(`INSERT INTO warehouses (name, sort) SELECT 'Main Warehouse', 10
                       WHERE NOT EXISTS (SELECT 1 FROM warehouses)`);

      ddl.push(`
        CREATE TABLE IF NOT EXISTS inventory_batches (
          id                BIGSERIAL PRIMARY KEY,
          sku_id            INTEGER NOT NULL REFERENCES skus(id),
          batch_number      TEXT NOT NULL,
          warehouse_id      INTEGER NOT NULL REFERENCES warehouses(id),
          location          TEXT,
          mfg_date          DATE,
          expiry_date       DATE,
          quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
          unit_cost         NUMERIC(12,2) CHECK (unit_cost >= 0),
          supplier_id       INTEGER REFERENCES suppliers(id),
          po_number         TEXT,
          grn_number        TEXT,
          received_date     DATE,
          status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','blocked','expired')),
          notes             TEXT,
          on_hand           INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by        TEXT,
          updated_by        TEXT,
          CHECK (mfg_date IS NULL OR expiry_date IS NULL OR mfg_date <= expiry_date),
          UNIQUE (sku_id, batch_number, warehouse_id)
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS inventory_batches_sku_idx ON inventory_batches (sku_id, expiry_date)');

      ddl.push(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id              BIGSERIAL PRIMARY KEY,
          sku_id          INTEGER NOT NULL REFERENCES skus(id),
          batch_id        BIGINT NOT NULL REFERENCES inventory_batches(id),
          warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
          quantity        INTEGER NOT NULL CHECK (quantity <> 0),
          movement_type   TEXT NOT NULL,
          reason          TEXT NOT NULL,
          reference_type  TEXT,
          reference_id    TEXT,
          shipment_id     BIGINT REFERENCES order_shipments(id),
          order_id        BIGINT REFERENCES orders(id),
          actor           TEXT,
          at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          notes           TEXT,
          idempotency_key TEXT UNIQUE,
          CHECK ((movement_type IN (${IN_TYPES.map((t) => `'${t}'`).join(',')}) AND quantity > 0)
              OR (movement_type IN (${OUT_TYPES.map((t) => `'${t}'`).join(',')}) AND quantity < 0))
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS inventory_movements_sku_idx ON inventory_movements (sku_id, at DESC)');
      ddl.push('CREATE INDEX IF NOT EXISTS inventory_movements_shipment_idx ON inventory_movements (shipment_id) WHERE shipment_id IS NOT NULL');

      ddl.push(`
        CREATE TABLE IF NOT EXISTS inventory_reservations (
          id           BIGSERIAL PRIMARY KEY,
          shipment_id  BIGINT NOT NULL REFERENCES order_shipments(id),
          sku_id       INTEGER NOT NULL REFERENCES skus(id),
          batch_id     BIGINT NOT NULL REFERENCES inventory_batches(id),
          quantity     INTEGER NOT NULL CHECK (quantity > 0),
          status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by   TEXT,
          closed_at    TIMESTAMPTZ,
          closed_by    TEXT,
          close_reason TEXT
        )`);
      ddl.push(`CREATE UNIQUE INDEX IF NOT EXISTS inventory_reservations_active_key
                       ON inventory_reservations (shipment_id, batch_id) WHERE status = 'active'`);
      ddl.push(`CREATE INDEX IF NOT EXISTS inventory_reservations_batch_idx
                       ON inventory_reservations (batch_id) WHERE status = 'active'`);

      ddl.push(`
        CREATE TABLE IF NOT EXISTS batch_documents (
          id                BIGSERIAL PRIMARY KEY,
          batch_id          BIGINT NOT NULL REFERENCES inventory_batches(id),
          document_type     TEXT NOT NULL,
          original_filename TEXT NOT NULL,
          storage_path      TEXT NOT NULL,
          mime_type         TEXT NOT NULL,
          file_size         INTEGER NOT NULL,
          uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          uploaded_by       TEXT,
          removed_at        TIMESTAMPTZ,
          removed_by        TEXT
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS batch_documents_batch_idx ON batch_documents (batch_id)');

      ddl.push(`
        CREATE TABLE IF NOT EXISTS inventory_audit (
          id          BIGSERIAL PRIMARY KEY,
          at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          actor       TEXT,
          action      TEXT NOT NULL,
          sku_id      INTEGER REFERENCES skus(id),
          batch_id    BIGINT REFERENCES inventory_batches(id),
          shipment_id BIGINT REFERENCES order_shipments(id),
          metadata    JSONB NOT NULL DEFAULT '{}'
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS inventory_audit_sku_idx ON inventory_audit (sku_id, at DESC)');

      // Order lines point at the canonical SKU once it is known. The raw code
      // from the channel stays in order_items.sku.
      ddl.push('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sku_id INTEGER REFERENCES skus(id)');
      ddl.push('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS asin TEXT');
      ddl.push('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS amazon_listing_id TEXT');
      ddl.push('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS amazon_product_id TEXT');
      ddl.push('CREATE INDEX IF NOT EXISTS order_items_sku_idx ON order_items (sku_id)');
      ddl.push('CREATE INDEX IF NOT EXISTS order_items_unmapped_idx ON order_items (lower(sku)) WHERE sku_id IS NULL');

      // The ledger is the only way stock changes. A movement updates its
      // batch's on_hand in the same statement; on_hand cannot go below zero
      // (CHECK), and nothing else may change it.
      ddl.push(`
        CREATE OR REPLACE FUNCTION inventory_movement_apply() RETURNS trigger AS $$
        DECLARE b RECORD;
        BEGIN
          SELECT sku_id, warehouse_id INTO b FROM inventory_batches WHERE id = NEW.batch_id;
          IF b.sku_id IS DISTINCT FROM NEW.sku_id OR b.warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
            RAISE EXCEPTION 'movement does not match its batch';
          END IF;
          PERFORM set_config('app.ledger_write', 'on', true);
          UPDATE inventory_batches SET on_hand = on_hand + NEW.quantity, updated_at = now() WHERE id = NEW.batch_id;
          PERFORM set_config('app.ledger_write', 'off', true);
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      ddl.push('DROP TRIGGER IF EXISTS inventory_movement_apply ON inventory_movements');
      ddl.push(`CREATE TRIGGER inventory_movement_apply AFTER INSERT ON inventory_movements
                       FOR EACH ROW EXECUTE FUNCTION inventory_movement_apply()`);
      ddl.push(`
        CREATE OR REPLACE FUNCTION inventory_on_hand_guard() RETURNS trigger AS $$
        BEGIN
          IF NEW.on_hand IS DISTINCT FROM OLD.on_hand AND coalesce(current_setting('app.ledger_write', true), 'off') <> 'on' THEN
            RAISE EXCEPTION 'on_hand changes only through inventory_movements';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      ddl.push('DROP TRIGGER IF EXISTS inventory_on_hand_guard ON inventory_batches');
      ddl.push(`CREATE TRIGGER inventory_on_hand_guard BEFORE UPDATE ON inventory_batches
                       FOR EACH ROW EXECUTE FUNCTION inventory_on_hand_guard()`);
      // Append-only, as order_events: only the test suite's purge may delete.
      ddl.push(`
        CREATE OR REPLACE FUNCTION inventory_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND current_setting('app.purge_inventory', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['inventory_movements', 'inventory_audit']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_append_only ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
                         FOR EACH ROW EXECUTE FUNCTION inventory_append_only()`);
      }
      // One global stock cutover (a single row). Orders placed before it are
      // historical for inventory: they may be mapped and reported on, but never
      // reserve or consume stock. NULL = no cutover (every order takes part).
      ddl.push(`
        CREATE TABLE IF NOT EXISTS inventory_settings (
          id         BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
          cutover_at TIMESTAMPTZ,
          version    INTEGER NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by TEXT
        )`);
      ddl.push('INSERT INTO inventory_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING');
      // An order with stock reserved or dispatched cannot have its date moved
      // across the cutover by any path (order edit, Amazon or Shopify re-import):
      // that would silently strand or re-open stock already set aside.
      ddl.push(`CREATE OR REPLACE FUNCTION orders_inventory_cutover_guard() RETURNS trigger AS $$
        DECLARE cut TIMESTAMPTZ;
        BEGIN
          SELECT cutover_at INTO cut FROM inventory_settings WHERE id;
          IF cut IS NULL THEN RETURN NEW; END IF;
          IF (coalesce(OLD.order_date, OLD.created_at) >= cut) = (coalesce(NEW.order_date, NEW.created_at) >= cut) THEN RETURN NEW; END IF;
          IF EXISTS (SELECT 1 FROM inventory_movements m WHERE m.order_id = OLD.id AND m.movement_type = 'shipment_dispatched')
             OR EXISTS (SELECT 1 FROM inventory_reservations r
                        JOIN order_shipments x ON x.id = r.shipment_id
                        LEFT JOIN shipment_orders so ON so.shipment_id = x.id AND so.detached_at IS NULL
                        WHERE r.status = 'active' AND (x.order_id = OLD.id OR so.order_id = OLD.id)) THEN
            RAISE EXCEPTION 'This order cannot be moved across the inventory cutover: stock is already reserved for it or dispatched against it. Release the reservation first; dispatched stock stays as recorded.'
              USING HINT = 'inventory_cutover';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      ddl.push('DROP TRIGGER IF EXISTS orders_inventory_cutover ON orders');
      ddl.push(`CREATE TRIGGER orders_inventory_cutover BEFORE UPDATE OF order_date, created_at ON orders
                FOR EACH ROW EXECUTE FUNCTION orders_inventory_cutover_guard()`);
      await sql.query(ddl.join(';\n'));
      await migrateLegacyAmazonSkus(sql);
    })().catch((err) => { inventorySchema = null; throw err; });
  }
  return inventorySchema;
}

/**
 * One-time move of the old single column skus.amazon_seller_sku into Amazon
 * platform-SKU mappings. Order lines already resolved keep their master SKU;
 * lines waiting on that code resolve through the mapping from now on. The old
 * column is then cleared (not dropped) only where its value now lives in a
 * mapping, so this never re-adds a mapping someone later removed. Idempotent.
 */
export async function migrateLegacyAmazonSkus(db) {
  const { rowCount: moved } = await db.query(`INSERT INTO sku_platform_mappings (sku_id, platform, platform_sku, source, created_by)
    SELECT id, 'amazon', trim(amazon_seller_sku), 'migrated', 'migration' FROM skus
    WHERE amazon_seller_sku IS NOT NULL AND trim(amazon_seller_sku) <> '' AND trim(amazon_seller_sku) !~ '[\\r\\n\\t]'
      AND NOT EXISTS (SELECT 1 FROM sku_platform_mappings m WHERE m.platform = 'amazon' AND lower(m.platform_sku) = lower(trim(skus.amazon_seller_sku)))
    ON CONFLICT DO NOTHING`);
  const { rowCount: cleared } = await db.query(`UPDATE skus s SET amazon_seller_sku = NULL
    WHERE amazon_seller_sku IS NOT NULL AND EXISTS (SELECT 1 FROM sku_platform_mappings m
      WHERE m.sku_id = s.id AND m.platform = 'amazon' AND lower(m.platform_sku) = lower(trim(s.amazon_seller_sku)))`);
  return { moved, cleared };
}

// ---------------------------------------------------------------- stock cutover
/**
 * The one rule for whether an order takes part in inventory (alias = orders).
 * Its time is the order's own date (order_date; created_at when an order has
 * none, as the order list does), compared as timestamptz in the database:
 * before the cutover → historical, never reserves or consumes stock; at or
 * after it, or with no cutover set → the normal lifecycle. Every stock path
 * reaches orders through shipmentOrderIds / orderHasItems, which use this.
 */
export const INVENTORY_ELIGIBLE_SQL = (o = 'o') => `(
  (SELECT cutover_at FROM inventory_settings WHERE id) IS NULL
  OR coalesce(${o}.order_date, ${o}.created_at) >= (SELECT cutover_at FROM inventory_settings WHERE id))`;

/** Whether an order takes part in inventory (the same rule, for one order). */
export async function isInventoryEligible(client, orderId) {
  const { rows } = await client.query(`SELECT ${INVENTORY_ELIGIBLE_SQL('o')} AS ok FROM orders o WHERE o.id = $1`, [orderId]);
  return Boolean(rows[0]?.ok);
}

export async function getInventoryCutover() {
  await ensureInventorySchema();
  const { rows } = await getPool().query('SELECT cutover_at, version, updated_at, updated_by FROM inventory_settings WHERE id');
  return rows[0];
}

/**
 * Sets (or clears, with null) the stock cutover. Needs confirm: true, and the
 * version last read, so an existing cutover is never changed by accident or by
 * a stale screen. Refused while stock is reserved for, or has been dispatched
 * against, an order the new value would move to the other side of the line —
 * that would silently strand or re-open stock already set aside.
 */
export async function setInventoryCutover(value, { actor, confirm = false, version } = {}) {
  let next = null;
  if (value !== null) {
    const s = String(value ?? '').trim();
    // Absolute instants only: an ISO timestamp with an explicit offset or Z.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) {
      throw bad('Give the cutover as a full date and time with its timezone, e.g. 2026-10-15T00:00:00+05:30.');
    }
    next = new Date(s).toISOString();
  }
  if (confirm !== true) throw bad('Confirm the stock cutover before saving it.', 400, { confirmRequired: true });
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT cutover_at, version FROM inventory_settings WHERE id FOR UPDATE');
    const cur = rows[0];
    if (Number(version) !== cur.version) {
      throw bad('The stock cutover was changed by someone else. Reload and check it before saving.', 409, { conflict: true });
    }
    const from = cur.cutover_at ? cur.cutover_at.toISOString() : null;
    if (from === next) return { cutover_at: next, version: cur.version, changed: false };
    // Orders whose side of the line differs between the old and the new value.
    const { rows: moved } = await client.query(
      `SELECT 1 FROM orders o
       WHERE ($1::timestamptz IS NULL OR coalesce(o.order_date, o.created_at) >= $1) IS DISTINCT FROM
             ($2::timestamptz IS NULL OR coalesce(o.order_date, o.created_at) >= $2)
         AND (EXISTS (SELECT 1 FROM inventory_movements m WHERE m.order_id = o.id AND m.movement_type = 'shipment_dispatched')
           OR EXISTS (SELECT 1 FROM inventory_reservations r
                      JOIN order_shipments x ON x.id = r.shipment_id
                      LEFT JOIN shipment_orders so ON so.shipment_id = x.id AND so.detached_at IS NULL
                      WHERE r.status = 'active' AND (x.order_id = o.id OR so.order_id = o.id)))
       LIMIT 1`, [from, next]);
    if (moved.length) {
      throw bad('Stock is already reserved for, or dispatched against, orders this change would move across the cutover. Release those reservations first; dispatched stock stays as recorded.', 409, { conflict: true });
    }
    const { rows: saved } = await client.query(
      'UPDATE inventory_settings SET cutover_at = $1, version = version + 1, updated_at = now(), updated_by = $2 WHERE id RETURNING version',
      [next, actor]);
    await audit(client, 'inventory_cutover_set', { actor, metadata: { from, to: next } });
    return { cutover_at: next, version: saved[0].version, changed: true };
  });
}

// ---------------------------------------------------------------- helpers

const text = (v, max = 200) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const intOf = (v, label, { min = 0 } = {}) => {
  const s = String(v ?? '').trim();
  if (!/^-?\d+$/.test(s)) throw bad(`${label} must be a whole number.`);
  const n = Number(s);
  if (n < min) throw bad(`${label} must be at least ${min}.`);
  if (n > 10_000_000) throw bad(`${label} is too large.`);
  return n;
};
/**
 * Units per listing: a whole number of at least 1. Omitted (undefined) means 1;
 * null, empty, zero, negative and decimal values are refused, never guessed.
 */
export function unitsPerListingOf(v) {
  if (v === undefined) return 1;
  if (v === null || (typeof v !== 'number' && typeof v !== 'string')) throw bad('Units per listing must be a whole number of at least 1.');
  const s = String(v).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1) throw bad('Units per listing must be a whole number of at least 1.');
  if (Number(s) > 1000) throw bad('Units per listing is too large.');
  return Number(s);
}
/**
 * Master-SKU units per unit of an order line (alias oi, its order o, master s).
 * A line resolved by the master's own code is 1; a line resolved through a
 * platform mapping takes that mapping's units_per_listing. The only place a
 * channel quantity becomes an inventory quantity is through this.
 */
const LINE_UNITS_SQL = `CASE WHEN oi.sku_id IS NULL OR lower(oi.sku) = lower(s.sku) THEN 1
  ELSE coalesce((SELECT m.units_per_listing FROM sku_platform_mappings m
                 WHERE m.sku_id = oi.sku_id AND m.platform = o.channel AND lower(m.platform_sku) = lower(oi.sku)
                 LIMIT 1), 1) END`;
const moneyOf = (v, label) => {
  const s = String(v ?? '').trim().replace(/[₹,\s]/g, '');
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad(`${label} must be an amount like 180 or 175.50.`);
  return Number(s);
};
/**
 * A calendar date as 'YYYY-MM-DD' text, never a timestamp, so no timezone can
 * move it. A month alone (as printed on a label: 08/2028, 2028-08) means that
 * month's last calendar day: 08/2028 → 2028-08-31, 02/2028 → 2028-02-29.
 */
export function dateOf(v, label = 'Date') {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month, in UTC
  let m = /^(\d{4})-(\d{1,2})$/.exec(s) || /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const [y, mo] = /^\d{4}$/.test(m[1]) ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
    if (mo < 1 || mo > 12) throw bad(`${label}: month must be 01–12.`);
    return `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) || /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const [y, mo, d] = m[1].length === 4 ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= lastDay(y, mo)) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  throw bad(`${label} must be a date (31-08-2028) or a month (08-2028).`);
}
const idOf = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function audit(client, action, { actor, skuId = null, batchId = null, shipmentId = null, metadata = {} }) {
  await client.query(
    'INSERT INTO inventory_audit (action, actor, sku_id, batch_id, shipment_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [action, actor, skuId, batchId, shipmentId, JSON.stringify(metadata)]);
}

/** The team's calendar day, which decides what has expired. */
const TODAY = '(now() AT TIME ZONE $TZ)::date';
const today = (tz) => TODAY.replace('$TZ', `'${String(tz).replace(/'/g, '')}'`);

/**
 * Per batch: stored fields, reserved quantity and the effective status.
 * Only an "active" batch is sellable.
 */
const batchStockSql = (tz) => `
  SELECT b.*, coalesce(r.reserved, 0)::int AS reserved,
         CASE WHEN b.status <> 'active' THEN b.status
              WHEN b.expiry_date IS NOT NULL AND b.expiry_date < ${today(tz)} THEN 'expired'
              WHEN b.on_hand = 0 THEN 'depleted'
              ELSE 'active' END AS effective_status,
         CASE WHEN b.expiry_date IS NULL THEN NULL ELSE (b.expiry_date - ${today(tz)}) END AS days_to_expiry
  FROM inventory_batches b
  LEFT JOIN (SELECT batch_id, sum(quantity) AS reserved FROM inventory_reservations
             WHERE status = 'active' GROUP BY batch_id) r ON r.batch_id = b.id`;

const toBatch = (r) => ({
  id: Number(r.id), sku_id: r.sku_id, batch_number: r.batch_number, warehouse_id: r.warehouse_id,
  warehouse_name: r.warehouse_name, location: r.location, mfg_date: r.mfg_date, expiry_date: r.expiry_date,
  quantity_received: r.quantity_received, unit_cost: num(r.unit_cost), supplier_id: r.supplier_id,
  supplier_name: r.supplier_name, po_number: r.po_number, grn_number: r.grn_number, received_date: r.received_date,
  status: r.status, effective_status: r.effective_status, notes: r.notes, on_hand: r.on_hand, reserved: r.reserved,
  available: r.effective_status === 'active' ? Math.max(r.on_hand - r.reserved, 0) : 0,
  days_to_expiry: r.days_to_expiry === null ? null : Number(r.days_to_expiry),
  value: r.unit_cost === null ? null : Math.round(r.on_hand * Number(r.unit_cost) * 100) / 100,
  version: r.version, sku: r.sku, product_name: r.product_name, variant_name: r.variant_name,
});

/** Dates come back as text, so a DATE never shifts by a timezone. */
const DATE_TEXT = `mfg_date::text AS mfg_date, expiry_date::text AS expiry_date, received_date::text AS received_date`;
const batchQuery = (tz, where = '', order = 'ORDER BY s.sku, bs.expiry_date NULLS LAST, bs.id') => `
  SELECT bs.*, bs.mfg_date::text AS mfg_date, bs.expiry_date::text AS expiry_date, bs.received_date::text AS received_date,
         s.sku, s.product_name, s.variant_name, w.name AS warehouse_name, sp.name AS supplier_name
  FROM (${batchStockSql(tz)}) bs
  JOIN skus s ON s.id = bs.sku_id
  JOIN warehouses w ON w.id = bs.warehouse_id
  LEFT JOIN suppliers sp ON sp.id = bs.supplier_id
  ${where} ${order}`;

// ---------------------------------------------------------------- SKUs

// Master SKU fields. Platform SKUs (Amazon, Blinkit, Zepto, …) are not fields
// of a SKU: they are rows in sku_platform_mappings that point at it.
const SKU_FIELDS = ['product_name', 'variant_name', 'category', 'unit_type', 'active', 'reorder_level', 'reorder_quantity',
  'asin', 'amazon_listing_id', 'amazon_product_id', 'amazon_item_name'];

function skuInput(input, { creating }) {
  const out = {};
  if (creating) {
    const sku = String(input.sku ?? '').trim();
    if (!sku) throw bad('Enter the master Briyo SKU.');
    if (!SKU_PATTERN.test(sku)) throw bad('A master SKU uses letters, numbers, - _ . / only (no spaces), up to 64 characters.');
    out.sku = sku;
  }
  if (creating || input.product_name !== undefined) {
    out.product_name = text(input.product_name, 200);
    if (!out.product_name) throw bad('Enter the product name.');
  }
  for (const k of ['variant_name', 'category', 'asin', 'amazon_listing_id', 'amazon_product_id']) {
    if (creating || input[k] !== undefined) out[k] = text(input[k], 120);
  }
  if (creating || input.amazon_item_name !== undefined) out.amazon_item_name = text(input.amazon_item_name, 500);
  if (creating || input.unit_type !== undefined) out.unit_type = text(input.unit_type, 40) || 'unit';
  if (creating || input.track_inventory !== undefined) {
    out.track_inventory = input.track_inventory === undefined ? true : input.track_inventory === true || input.track_inventory === 'true';
  }
  if (creating || input.active !== undefined) out.active = input.active === undefined ? true : input.active === true || input.active === 'true';
  if (creating || input.reorder_level !== undefined) out.reorder_level = input.reorder_level === '' || input.reorder_level == null ? 0 : intOf(input.reorder_level, 'Reorder level');
  if (creating || input.reorder_quantity !== undefined) out.reorder_quantity = input.reorder_quantity === '' || input.reorder_quantity == null ? 0 : intOf(input.reorder_quantity, 'Reorder quantity');
  return out;
}

// ---------------------------------------------------------------- platforms & platform SKUs

/** Placeholders a sheet uses for "no SKU on this platform". */
export const PLATFORM_SKU_PLACEHOLDERS = new Set(['NA', 'N/A', 'N.A.', '-', '—', 'NONE', 'NIL', 'NULL']);

/**
 * One platform SKU, cleaned and checked. Returns { code } or throws. Platform
 * SKUs are external identifiers: they are never edited or guessed, only
 * trimmed; anything that looks wrong is refused for a person to decide.
 */
export function platformSkuInput(platform, value, { fromOrder = false } = {}) {
  const code = String(value ?? '').trim();
  if (!code || PLATFORM_SKU_PLACEHOLDERS.has(code.toUpperCase())) throw bad('Enter the platform SKU.');
  // Tabs and line breaks only come from pasting several values at once.
  if (/[\r\n\t]/.test(code)) throw bad(`Platform SKU "${code}" contains a line break or tab. Enter one SKU per line.`);
  // A typed SKU with a space inside is almost always a typo ("WF-IATY- Z4SW"). It is
  // never "fixed" here — the person corrects it. The one exception is a code taken
  // verbatim from an order line (Unmapped platform SKUs), which is what the
  // platform itself sent, spaces and all.
  if (!fromOrder && /\s/.test(code)) {
    throw bad(`${platform} SKU "${code}" contains a space. Enter it exactly as ${platform} shows it, without spaces.`, 400, { invalidPlatformSku: code });
  }
  if (code.length > 80) throw bad('Platform SKUs are up to 80 characters.');
  return { code };
}

export async function listPlatforms({ includeInactive = true } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    `SELECT p.key, p.label, p.active, p.sort, (SELECT count(*)::int FROM sku_platform_mappings m WHERE m.platform = p.key) AS mappings
     FROM sku_platforms p ${includeInactive ? '' : 'WHERE p.active'} ORDER BY p.sort, p.label`);
  return rows;
}

/** A new platform is a row, not a schema change. Its key is what order channels use. */
export async function savePlatform(input, { actor }) {
  await ensureInventorySchema();
  const label = text(input.label, 60);
  if (!label) throw bad('Enter the platform name.');
  const key = String(input.key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!/^[a-z0-9_]{2,40}$/.test(key)) throw bad('Platform key must be 2–40 letters, numbers or _.');
  const existing = (await getPool().query('SELECT key FROM sku_platforms WHERE key = $1', [key])).rows[0];
  if (existing) {
    const { rows } = await getPool().query(
      'UPDATE sku_platforms SET label = $2, active = coalesce($3, active) WHERE key = $1 RETURNING key, label, active, sort',
      [key, label, input.active === undefined ? null : Boolean(input.active)]);
    return rows[0];
  }
  const { rows } = await getPool().query(
    `INSERT INTO sku_platforms (key, label, sort) VALUES ($1, $2, coalesce((SELECT max(sort) + 10 FROM sku_platforms), 10))
     RETURNING key, label, active, sort`, [key, label]);
  await inTransaction((c) => audit(c, 'platform_added', { actor, metadata: { key, label } }));
  return rows[0];
}

/**
 * Which mapping of a platform SKU decides its orders when the code sits on
 * more than one master (a duplicate override): the regular mapping before any
 * override, then the earliest. SQL fragment comparing mapping m against m2.
 */
const OUTRANKS = (m2, m) => `(${m2}.duplicate_override, ${m2}.created_at, ${m2}.id) < (${m}.duplicate_override, ${m}.created_at, ${m}.id)`;

/**
 * The master SKU a channel's codes mean. A master SKU code always wins (the
 * website/Shopify uses master codes as they are); otherwise the code is looked
 * up among that platform's SKUs — the platform being the order's channel. A
 * platform SKU on several masters resolves to its primary mapping (OUTRANKS).
 * Never creates anything: an unknown code stays unmapped.
 */
export async function resolveSkuIds(client, channel, codes) {
  const list = [...new Set(codes.filter(Boolean).map((c) => String(c).trim().toLowerCase()))];
  const out = new Map();
  if (!list.length) return out;
  const { rows } = await client.query(
    `SELECT code, id FROM (
       SELECT lower(sku) AS code, id, 1 AS rank, false AS ov, now() AS at, 0::bigint AS mid FROM skus WHERE lower(sku) = ANY($1)
       UNION ALL
       SELECT lower(platform_sku), sku_id, 2, duplicate_override, created_at, id FROM sku_platform_mappings WHERE platform = $2 AND lower(platform_sku) = ANY($1)
     ) x ORDER BY rank, ov, at, mid`, [list, channel]);
  for (const r of rows) if (!out.has(r.code)) out.set(r.code, r.id);
  return out;
}

/**
 * Points unmapped order lines at the master SKU they now match: its own code,
 * or a platform SKU for which this master holds the primary mapping. Returns
 * how many lines changed. Only sku_id is set; the line's own code is kept.
 */
export async function remapOrderItems(client, skuId) {
  const { rowCount } = await client.query(
    `UPDATE order_items oi SET sku_id = s.id, updated_at = now()
     FROM orders o, skus s
     WHERE s.id = $1 AND o.id = oi.order_id AND oi.sku_id IS NULL
       AND (lower(oi.sku) = lower(s.sku)
            OR EXISTS (SELECT 1 FROM sku_platform_mappings m
                       WHERE m.sku_id = s.id AND m.platform = o.channel AND lower(m.platform_sku) = lower(oi.sku)
                         AND NOT EXISTS (SELECT 1 FROM sku_platform_mappings m2
                                         WHERE m2.platform = m.platform AND lower(m2.platform_sku) = lower(m.platform_sku)
                                           AND m2.sku_id <> m.sku_id AND ${OUTRANKS('m2', 'm')})))`, [skuId]);
  return rowCount;
}

/**
 * Adds platform SKUs to a master SKU, in the caller's transaction.
 *  - not mapped anywhere on this platform → added;
 *  - already on this master → a no-op ("existing");
 *  - on another master → refused with duplicateMapping (409) unless the caller
 *    confirms (confirmDuplicate) AND gives a reason; then it is added as a
 *    duplicate override, the reason stored on the mapping and in the audit.
 * A platform SKU equal to another master's own code is always refused.
 * Every code is checked before anything is written.
 */
async function addMappingsTx(client, skuId, platform, codes, { actor, source = 'manual', confirmDuplicate = false, reason = '', fromOrder = false, unitsPerListing = 1 }) {
  const { rows: pf } = await client.query('SELECT key, label, active FROM sku_platforms WHERE key = $1', [platform]);
  if (!pf.length) throw bad(`Unknown platform "${platform}". Add the platform first.`);
  const label = pf[0].label;
  const clean = [...new Map(codes.map((c) => platformSkuInput(label, c, { fromOrder }).code).map((c) => [c.toLowerCase(), c])).values()];
  if (!clean.length) throw bad('Enter at least one platform SKU.');
  const { rows: target } = await client.query('SELECT id, sku, product_name FROM skus WHERE id = $1', [skuId]);
  const plan = [];
  for (const code of clean) {
    const { rows: asMaster } = await client.query('SELECT sku FROM skus WHERE lower(sku) = lower($1) AND id <> $2', [code, skuId]);
    if (asMaster.length) {
      throw bad(`${code} is itself the master SKU ${asMaster[0].sku}; it cannot also be a ${label} SKU of another product.`, 409,
        { conflict: true, mappingConflict: { platform, platform_sku: code, existing_master: asMaster[0].sku } });
    }
    const { rows: cur } = await client.query(
      `SELECT m.id, m.sku_id, s.sku, s.product_name FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id
       WHERE m.platform = $1 AND lower(m.platform_sku) = lower($2) ORDER BY m.duplicate_override, m.created_at, m.id FOR UPDATE OF m`, [platform, code]);
    if (cur.some((r) => r.sku_id === skuId)) { plan.push({ code, existing: true }); continue; }
    plan.push({ code, others: cur.map((r) => ({ sku: r.sku, product_name: r.product_name })) });
  }
  const dups = plan.filter((p) => p.others?.length);
  const why = String(reason ?? '').trim();
  if (dups.length && !confirmDuplicate) {
    const d = dups[0];
    throw bad(`${label} SKU ${d.code} is already mapped to master SKU ${d.others.map((o) => o.sku).join(', ')}. Confirm and give a reason to add it to ${target[0].sku} as well.`, 409, {
      conflict: true,
      mappingConflict: { platform, platform_sku: d.code, existing_master: d.others[0].sku },
      duplicateMapping: {
        platform, platform_label: label,
        duplicates: dups.map((p) => ({ platform_sku: p.code, mapped_to: p.others })),
        target: { sku: target[0].sku, product_name: target[0].product_name },
      },
    });
  }
  if (dups.length && !why) throw bad('Give a reason for adding a platform SKU that is already mapped to another master SKU.', 400, { reasonRequired: true });
  if (why.length > 1000) throw bad('Keep the reason under 1000 characters.');

  const added = []; const existing = []; const overrides = [];
  for (const p of plan) {
    if (p.existing) { existing.push(p.code); continue; }
    const override = Boolean(p.others.length);
    try {
      await client.query(
        `INSERT INTO sku_platform_mappings (sku_id, platform, platform_sku, source, created_by, duplicate_override, duplicate_reason, units_per_listing)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [skuId, platform, p.code, source, actor, override, override ? why : null, unitsPerListing]);
    } catch (err) {
      if (err.code === '23505') { existing.push(p.code); continue; }   // the same mapping, saved a moment ago
      throw err;
    }
    added.push(p.code);
    if (override) {
      overrides.push(p.code);
      const others = p.others.map((o) => o.sku).join(', ');
      await audit(client, 'platform_sku_duplicate_override', { actor, skuId, metadata: {
        message: `${label} SKU ${p.code} was added to ${target[0].sku} despite already being mapped to ${others}.`,
        reason: why, platform, platform_sku: p.code, master: target[0].sku, already_mapped_to: p.others.map((o) => o.sku), source,
      } });
    }
  }
  if (added.length) await audit(client, 'platform_skus_added', { actor, skuId, metadata: { platform, platform_skus: added, duplicate_overrides: overrides, source, units_per_listing: unitsPerListing } });
  return { added, existing, duplicateOverrides: overrides };
}

/**
 * Adds one or more platform SKUs (array, or text split on new lines, "/" or
 * ",") to a master SKU, then resolves any order lines waiting on them.
 * fromOrder: the code was picked from an order line (Unmapped platform SKUs)
 * and must exist on such a line exactly; it may then keep inner spaces.
 */
export async function addPlatformMappings(skuId, platform, value, { actor, confirmDuplicate = false, reason = '', fromOrder = false, unitsPerListing } = {}) {
  const units = unitsPerListingOf(unitsPerListing);
  await ensureInventorySchema();
  const codes = Array.isArray(value) ? value : (fromOrder ? [String(value ?? '')] : splitPlatformCell(value));
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM skus WHERE id = $1 FOR UPDATE', [skuId]);
    if (!rows.length) throw bad('No such master SKU.', 404);
    if (fromOrder) {
      for (const c of codes) {
        const { rows: seen } = await client.query(
          `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.channel = $1 AND oi.sku = $2 LIMIT 1`, [platform, String(c).trim()]);
        if (!seen.length) throw bad(`No ${platform} order line has the SKU "${String(c).trim()}". Add it on the master SKU instead.`);
      }
    }
    const r = await addMappingsTx(client, skuId, String(platform || ''), codes, { actor, confirmDuplicate, reason, fromOrder, source: fromOrder ? 'unmapped' : 'manual', unitsPerListing: units });
    const mapped = await remapOrderItems(client, skuId);
    return { ...r, orderItemsMapped: mapped };
  });
}

/**
 * Removes a platform SKU mapping. Order lines that were resolved through it
 * return to unmapped — or, if the same code is also on another master, move to
 * that one's mapping — unless any of them already has stock reserved or
 * dispatched, in which case the removal is refused (release the stock first).
 */
export async function removePlatformMapping(mappingId, { actor }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*, s.sku FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id WHERE m.id = $1 FOR UPDATE OF m`, [mappingId]);
    const m = rows[0];
    if (!m) throw bad('No such mapping.', 404);
    const linesSql = `SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.sku_id = $1 AND o.channel = $2 AND lower(oi.sku) = lower($3) AND lower(oi.sku) <> lower($4)`;
    const { rows: lines } = await client.query(linesSql, [m.sku_id, m.platform, m.platform_sku, m.sku]);
    if (lines.length) {
      if (await ordersHaveStock(client, lines)) {
        throw bad(`Orders using ${m.platform_sku} already have stock reserved or dispatched against ${m.sku}. Release the reservation first; dispatched stock stays as recorded.`, 409, { conflict: true });
      }
      await client.query('UPDATE order_items SET sku_id = NULL, updated_at = now() WHERE id = ANY($1)', [lines.map((l) => l.id)]);
    }
    await client.query('DELETE FROM sku_platform_mappings WHERE id = $1', [mappingId]);
    // The same code may still be on another master (a duplicate override): its lines go there.
    const { rows: others } = await client.query(
      'SELECT DISTINCT sku_id FROM sku_platform_mappings WHERE platform = $1 AND lower(platform_sku) = lower($2)', [m.platform, m.platform_sku]);
    let remapped = 0;
    for (const o of others) remapped += await remapOrderItems(client, o.sku_id);
    await audit(client, 'platform_sku_removed', { actor, skuId: m.sku_id, metadata: { platform: m.platform, platform_sku: m.platform_sku, duplicate_override: m.duplicate_override, order_lines_unmapped: lines.length - remapped, order_lines_moved: remapped } });
    return { removed: true, orderItemsUnmapped: lines.length - remapped, orderItemsMoved: remapped };
  });
}

/** Whether any of these order lines' orders already has stock reserved or dispatched. */
async function ordersHaveStock(client, lines) {
  const orderIds = [...new Set(lines.map((l) => Number(l.order_id)))];
  const { rows } = await client.query(
    `SELECT 1 FROM order_shipments s
     LEFT JOIN shipment_orders so ON so.shipment_id = s.id AND so.detached_at IS NULL
     WHERE (s.order_id = ANY($1) OR so.order_id = ANY($1))
       AND (EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.shipment_id = s.id AND r.status = 'active')
         OR EXISTS (SELECT 1 FROM inventory_movements mv WHERE mv.shipment_id = s.id))
     LIMIT 1`, [orderIds]);
  return rows.length > 0;
}

/**
 * Changes how many master units one listing of a platform SKU is. Refused while
 * any order using the mapping has stock reserved or dispatched, so a reservation
 * never stops matching what its shipment needs (release it first).
 */
export async function updateMappingUnits(mappingId, value, { actor }) {
  const units = unitsPerListingOf(value === undefined ? null : value);
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.*, s.sku FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id WHERE m.id = $1 FOR UPDATE OF m`, [mappingId]);
    const m = rows[0];
    if (!m) throw bad('No such mapping.', 404);
    if (m.units_per_listing === units) return { mapping_id: Number(m.id), units_per_listing: units, changed: false };
    const { rows: lines } = await client.query(
      `SELECT oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.sku_id = $1 AND o.channel = $2 AND lower(oi.sku) = lower($3) AND lower(oi.sku) <> lower($4)`,
      [m.sku_id, m.platform, m.platform_sku, m.sku]);
    if (lines.length && await ordersHaveStock(client, lines)) {
      throw bad(`Orders using ${m.platform_sku} already have stock reserved or dispatched against ${m.sku}. Release the reservation first; dispatched stock stays as recorded.`, 409, { conflict: true });
    }
    await client.query('UPDATE sku_platform_mappings SET units_per_listing = $2 WHERE id = $1', [mappingId, units]);
    await audit(client, 'platform_sku_units_changed', { actor, skuId: m.sku_id, metadata: { platform: m.platform, platform_sku: m.platform_sku, from: m.units_per_listing, to: units } });
    return { mapping_id: Number(m.id), units_per_listing: units, changed: true };
  });
}

/** A cell that may hold several platform SKUs: split on new lines, "/" and ",". */
export function splitPlatformCell(cell) {
  const raw = String(cell ?? '').trim();
  if (!raw || PLATFORM_SKU_PLACEHOLDERS.has(raw.toUpperCase())) return [];
  return raw.split(/\r?\n|\r|\/|,/).map((t) => t.trim()).filter((t) => t && !PLATFORM_SKU_PLACEHOLDERS.has(t.toUpperCase()));
}

/** Legacy input: amazon_seller_sku on a SKU form/API now means "add this Amazon platform SKU". */
async function legacyAmazonMapping(client, skuId, value, actor) {
  const code = text(value, 80);
  if (!code) return { added: [], existing: [] };
  return addMappingsTx(client, skuId, 'amazon', [code], { actor });
}

export async function createSku(input, { actor }) {
  await ensureInventorySchema();
  const f = skuInput(input, { creating: true });
  return inTransaction(async (client) => {
    const dup = await client.query('SELECT sku FROM skus WHERE lower(sku) = lower($1)', [f.sku]);
    if (dup.rows.length) throw bad(`Master SKU ${dup.rows[0].sku} already exists.`, 409, { conflict: true });
    // A master code may not equal any platform SKU that already points at another product.
    const asPlatform = await client.query(
      `SELECT m.platform, s.sku FROM sku_platform_mappings m JOIN skus s ON s.id = m.sku_id WHERE lower(m.platform_sku) = lower($1) LIMIT 1`, [f.sku]);
    if (asPlatform.rows.length) throw bad(`${f.sku} is already a ${asPlatform.rows[0].platform} SKU of ${asPlatform.rows[0].sku}.`, 409, { conflict: true });
    const keys = Object.keys(f);
    let rows;
    try {
      ({ rows } = await client.query(
        `INSERT INTO skus (${keys.join(', ')}, created_by, updated_by)
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 1}) RETURNING id`,
        [...keys.map((k) => f[k]), actor]));
    } catch (err) {
      if (err.code === '23505') throw bad('That master SKU already exists.', 409, { conflict: true });
      throw err;
    }
    const id = rows[0].id;
    await audit(client, 'sku_created', { actor, skuId: id, metadata: { sku: f.sku, ...f } });
    if (input.amazon_seller_sku) await legacyAmazonMapping(client, id, input.amazon_seller_sku, actor);
    const mapped = await remapOrderItems(client, id);
    return { id, orderItemsMapped: mapped };
  });
}

/** Edits a master SKU. Its code never changes: orders, stock and platform SKUs refer to it. */
export async function updateSku(id, input, { actor, version }) {
  await ensureInventorySchema();
  if (input.sku !== undefined) throw bad('A master SKU code cannot be changed once created.');
  const f = skuInput(input, { creating: false });
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM skus WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur) throw bad('No such SKU.', 404);
    if (version !== undefined && Number(version) !== cur.version) {
      throw bad('Someone else changed this SKU. Reload to see their change.', 409, { conflict: true });
    }
    let legacy = { added: [] };
    if (input.amazon_seller_sku) legacy = await legacyAmazonMapping(client, id, input.amazon_seller_sku, actor);
    const changes = {};
    for (const [k, v] of Object.entries(f)) if (String(cur[k] ?? '') !== String(v ?? '')) changes[k] = { from: cur[k], to: v };
    if (Object.keys(changes).length) {
      const keys = Object.keys(changes);
      await client.query(
        `UPDATE skus SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1,
           updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`,
        [id, ...keys.map((k) => f[k]), actor]);
      await audit(client, 'sku_updated', { actor, skuId: id, metadata: { changes } });
    }
    const mapped = await remapOrderItems(client, id);
    return { changed: Boolean(Object.keys(changes).length || legacy.added.length), orderItemsMapped: mapped };
  });
}

/** Stock per SKU: on hand, reserved, available (sellable batches only), value. */
const skuStockSql = (tz) => `
  SELECT s.*,
         coalesce(sum(bs.on_hand), 0)::int AS on_hand,
         coalesce(sum(CASE WHEN bs.effective_status = 'active' THEN bs.on_hand END), 0)::int AS sellable,
         coalesce(sum(CASE WHEN bs.effective_status = 'expired' THEN bs.on_hand END), 0)::int AS expired,
         coalesce(sum(CASE WHEN bs.effective_status = 'quarantined' THEN bs.on_hand END), 0)::int AS quarantined,
         coalesce(sum(CASE WHEN bs.effective_status = 'blocked' THEN bs.on_hand END), 0)::int AS blocked,
         coalesce(sum(bs.reserved), 0)::int AS reserved,
         coalesce(sum(CASE WHEN bs.effective_status = 'active' THEN least(bs.reserved, bs.on_hand) END), 0)::int AS reserved_sellable,
         coalesce(sum(CASE WHEN bs.effective_status = 'active' THEN greatest(bs.on_hand - bs.reserved, 0) END), 0)::int AS available,
         coalesce(sum(CASE WHEN bs.effective_status IN ('quarantined','blocked','expired') THEN bs.on_hand END), 0)::int AS unsellable,
         coalesce(sum(bs.on_hand * bs.unit_cost), 0)::numeric AS value,
         count(bs.id) FILTER (WHERE bs.on_hand > 0)::int AS batches_with_stock,
         (min(bs.expiry_date) FILTER (WHERE bs.on_hand > 0 AND bs.effective_status = 'active'))::text AS next_expiry
  FROM skus s LEFT JOIN (${batchStockSql(tz)}) bs ON bs.sku_id = s.id
  GROUP BY s.id`;

const toSku = (r) => {
  const available = r.available;
  return {
    id: r.id, sku: r.sku, product_name: r.product_name, variant_name: r.variant_name, category: r.category,
    unit_type: r.unit_type, active: r.active, reorder_level: r.reorder_level, reorder_quantity: r.reorder_quantity,
    platform_skus: r.platform_skus || [], asin: r.asin, amazon_listing_id: r.amazon_listing_id,
    amazon_product_id: r.amazon_product_id, amazon_item_name: r.amazon_item_name, track_inventory: r.track_inventory,
    version: r.version, created_at: r.created_at, updated_at: r.updated_at, created_by: r.created_by, updated_by: r.updated_by,
    // on_hand = sellable + expired + quarantined + blocked;  available (to dispatch) = sellable − reserved on sellable batches
    on_hand: r.on_hand, sellable: r.sellable, expired: r.expired, quarantined: r.quarantined, blocked: r.blocked,
    reserved: r.reserved, reserved_sellable: r.reserved_sellable, available, unsellable: r.unsellable,
    value: Math.round(Number(r.value) * 100) / 100, batches_with_stock: r.batches_with_stock,
    next_expiry: r.next_expiry || null,
    ...stockFlags({ active: r.active, available, reorder_level: r.reorder_level, track_inventory: r.track_inventory }),
  };
};

/** Low stock: at or under the reorder level. Out of stock: nothing available. */
export function stockFlags({ active, available, reorder_level: level, track_inventory: track = true }) {
  return {
    out_of_stock: Boolean(active) && Boolean(track) && available <= 0,
    low_stock: Boolean(active) && Boolean(track) && available > 0 && level > 0 && available <= level,
  };
}

export async function listSkus({ includeInactive = true, tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(`SELECT * FROM (${skuStockSql(tz)}) x ${includeInactive ? '' : 'WHERE active'} ORDER BY lower(sku)`);
  return withPlatformSkus(rows.map(toSku));
}

/** Platform SKUs for a set of master SKUs, in one query. */
async function withPlatformSkus(skus) {
  if (!skus.length) return skus;
  const { rows } = await getPool().query(
    `SELECT m.id, m.sku_id, m.platform, p.label AS platform_label, m.platform_sku, m.source, m.created_at, m.created_by,
            m.duplicate_override, m.duplicate_reason, m.units_per_listing
     FROM sku_platform_mappings m JOIN sku_platforms p ON p.key = m.platform
     WHERE m.sku_id = ANY($1) ORDER BY p.sort, lower(m.platform_sku)`, [skus.map((x) => x.id)]);
  const by = new Map();
  for (const r of rows) {
    const list = by.get(r.sku_id) || [];
    list.push({ id: Number(r.id), platform: r.platform, platform_label: r.platform_label, platform_sku: r.platform_sku, source: r.source, created_at: r.created_at, created_by: r.created_by,
      duplicate_override: r.duplicate_override, duplicate_reason: r.duplicate_reason, units_per_listing: r.units_per_listing });
    by.set(r.sku_id, list);
  }
  for (const x of skus) x.platform_skus = by.get(x.id) || [];
  return skus;
}

export async function getSku(id, { tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(`SELECT * FROM (${skuStockSql(tz)}) x WHERE id = $1`, [id]);
  return rows[0] ? (await withPlatformSkus([toSku(rows[0])]))[0] : null;
}

/** Everything the SKU drawer shows. */
export async function skuDetail(id, { tz = teamTimezone(), movementLimit = 200 } = {}) {
  const sku = await getSku(id, { tz });
  if (!sku) return null;
  const pool = getPool();
  const [batches, docs, movements, reservations, orderLines, auditRows] = await Promise.all([
    pool.query(batchQuery(tz, 'WHERE bs.sku_id = $1'), [id]),
    pool.query(`SELECT d.id, d.batch_id, d.document_type, d.original_filename, d.mime_type, d.file_size, d.uploaded_at, d.uploaded_by
                FROM batch_documents d JOIN inventory_batches b ON b.id = d.batch_id
                WHERE b.sku_id = $1 AND d.removed_at IS NULL ORDER BY d.uploaded_at DESC`, [id]),
    pool.query(`SELECT m.*, b.batch_number, w.name AS warehouse_name, o.source_order_id, o.channel AS order_channel
                FROM inventory_movements m JOIN inventory_batches b ON b.id = m.batch_id
                JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN orders o ON o.id = m.order_id
                WHERE m.sku_id = $1 ORDER BY m.at DESC, m.id DESC LIMIT $2`, [id, movementLimit]),
    pool.query(`SELECT r.id, r.shipment_id, r.batch_id, r.quantity, r.created_at, r.created_by, b.batch_number, s.tracking_id,
                       lo.source_order_id AS lead_order_number, s.order_id AS lead_order_id
                FROM inventory_reservations r JOIN inventory_batches b ON b.id = r.batch_id
                JOIN order_shipments s ON s.id = r.shipment_id JOIN orders lo ON lo.id = s.order_id
                WHERE r.sku_id = $1 AND r.status = 'active' ORDER BY r.created_at`, [id]),
    pool.query(`SELECT count(DISTINCT oi.order_id)::int AS orders, coalesce(sum(oi.quantity * ${LINE_UNITS_SQL}), 0)::int AS units
                FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN skus s ON s.id = oi.sku_id WHERE oi.sku_id = $1`, [id]),
    pool.query(`SELECT action, actor, at, metadata, batch_id FROM inventory_audit WHERE sku_id = $1 ORDER BY at DESC, id DESC LIMIT 50`, [id]),
  ]);
  const docsBy = {};
  for (const d of docs.rows) (docsBy[d.batch_id] ||= []).push({ ...d, id: Number(d.id), batch_id: Number(d.batch_id) });
  return {
    sku,
    batches: batches.rows.map((r) => ({ ...toBatch(r), documents: docsBy[r.id] || [] })),
    movements: movements.rows.map((m) => ({
      id: Number(m.id), at: m.at, movement_type: m.movement_type, label: MOVEMENT_TYPES[m.movement_type]?.label || m.movement_type,
      quantity: m.quantity, reason: m.reason, reference_type: m.reference_type, reference_id: m.reference_id,
      shipment_id: m.shipment_id === null ? null : Number(m.shipment_id), order_id: m.order_id === null ? null : Number(m.order_id),
      source_order_id: m.source_order_id, batch_id: Number(m.batch_id), batch_number: m.batch_number,
      warehouse_name: m.warehouse_name, actor: m.actor, notes: m.notes,
    })),
    reservations: reservations.rows.map((r) => ({ ...r, id: Number(r.id), shipment_id: Number(r.shipment_id), batch_id: Number(r.batch_id), lead_order_id: Number(r.lead_order_id) })),
    orderLines: orderLines.rows[0],
    audit: auditRows.rows,
  };
}

/** How many order lines currently resolve through each of a master SKU's platform SKUs. */
export async function mappingUsage(skuId) {
  const { rows } = await getPool().query(
    `SELECT m.id, count(oi.id)::int AS lines
     FROM sku_platform_mappings m
     LEFT JOIN orders o ON o.channel = m.platform
     LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.sku_id = m.sku_id AND lower(oi.sku) = lower(m.platform_sku)
     WHERE m.sku_id = $1 GROUP BY m.id`, [skuId]);
  return Object.fromEntries(rows.map((r) => [Number(r.id), r.lines]));
}

// ---------------------------------------------------------------- suppliers & warehouses

export async function listSuppliers() {
  await ensureInventorySchema();
  const { rows } = await getPool().query('SELECT id, name, reference, active FROM suppliers ORDER BY lower(name)');
  return rows;
}
export async function saveSupplier(input, { actor }) {
  await ensureInventorySchema();
  const name = text(input.name, 120);
  if (!name) throw bad('Enter the supplier name.');
  const reference = text(input.reference, 120);
  const id = idOf(input.id);
  try {
    if (id) {
      const { rows } = await getPool().query(
        `UPDATE suppliers SET name = $2, reference = $3, active = coalesce($4, active) WHERE id = $1 RETURNING id, name, reference, active`,
        [id, name, reference, input.active === undefined ? null : Boolean(input.active)]);
      if (!rows[0]) throw bad('No such supplier.', 404);
      return rows[0];
    }
    const { rows } = await getPool().query(
      'INSERT INTO suppliers (name, reference, created_by) VALUES ($1, $2, $3) RETURNING id, name, reference, active', [name, reference, actor]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw bad('A supplier with that name already exists.', 409);
    throw err;
  }
}

export async function listWarehouses() {
  await ensureInventorySchema();
  const { rows } = await getPool().query('SELECT id, name, active, sort FROM warehouses ORDER BY sort, lower(name)');
  return rows;
}
export async function saveWarehouse(input) {
  await ensureInventorySchema();
  const name = text(input.name, 120);
  if (!name) throw bad('Enter the warehouse name.');
  const id = idOf(input.id);
  try {
    if (id) {
      const { rows } = await getPool().query(
        'UPDATE warehouses SET name = $2, active = coalesce($3, active) WHERE id = $1 RETURNING id, name, active, sort',
        [id, name, input.active === undefined ? null : Boolean(input.active)]);
      if (!rows[0]) throw bad('No such warehouse.', 404);
      return rows[0];
    }
    const { rows } = await getPool().query('INSERT INTO warehouses (name) VALUES ($1) RETURNING id, name, active, sort', [name]);
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw bad('A warehouse with that name already exists.', 409);
    throw err;
  }
}

/** A supplier by id, or by name (created if new) — so receiving never retypes free text. */
async function supplierFor(client, input, actor) {
  const id = idOf(input.supplier_id);
  if (id) {
    const { rows } = await client.query('SELECT id FROM suppliers WHERE id = $1', [id]);
    if (!rows.length) throw bad('Unknown supplier.');
    return id;
  }
  const name = text(input.supplier_name, 120);
  if (!name) return null;
  const found = await client.query('SELECT id FROM suppliers WHERE lower(name) = lower($1)', [name]);
  if (found.rows.length) return found.rows[0].id;
  const { rows } = await client.query('INSERT INTO suppliers (name, created_by) VALUES ($1, $2) RETURNING id', [name, actor]);
  return rows[0].id;
}

// ---------------------------------------------------------------- movements

/**
 * The one way stock changes. Locks the batch, refuses to take more than is
 * free (on hand less reserved, unless the movement consumes a reservation),
 * and writes the ledger row; the database moves on_hand.
 */
async function writeMovement(client, m) {
  const def = MOVEMENT_TYPES[m.movement_type];
  if (!def) throw bad('Unknown movement type.');
  const qty = def.sign * Math.abs(m.quantity);
  const { rows } = await client.query(
    `SELECT b.id, b.sku_id, b.warehouse_id, b.on_hand,
            coalesce((SELECT sum(quantity) FROM inventory_reservations r WHERE r.batch_id = b.id AND r.status = 'active'), 0)::int AS reserved
     FROM inventory_batches b WHERE b.id = $1 FOR UPDATE`, [m.batch_id]);
  const b = rows[0];
  if (!b) throw bad('No such batch.', 404);
  if (qty < 0) {
    const free = b.on_hand - b.reserved;
    if (Math.abs(qty) > free) {
      throw bad(`Only ${Math.max(free, 0)} unit${free === 1 ? '' : 's'} of this batch can be taken (${b.on_hand} on hand, ${b.reserved} reserved).`, 409, { insufficientStock: true });
    }
  }
  try {
    const { rows: ins } = await client.query(
      `INSERT INTO inventory_movements (sku_id, batch_id, warehouse_id, quantity, movement_type, reason, reference_type,
         reference_id, shipment_id, order_id, actor, notes, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [b.sku_id, b.id, b.warehouse_id, qty, m.movement_type, m.reason || def.label, m.reference_type || null,
        m.reference_id === undefined || m.reference_id === null ? null : String(m.reference_id),
        m.shipment_id || null, m.order_id || null, m.actor, m.notes || null, m.idempotency_key || null]);
    return Number(ins[0].id);
  } catch (err) {
    if (err.code === '23514') throw bad('Not enough stock in this batch.', 409, { insufficientStock: true });
    throw err;
  }
}

/** A key already used means this exact request was done before: return what it did. */
async function priorMovement(client, key) {
  if (!key) return null;
  const { rows } = await client.query('SELECT id, batch_id FROM inventory_movements WHERE idempotency_key = $1', [key]);
  return rows[0] ? { movementId: Number(rows[0].id), batchId: Number(rows[0].batch_id), repeated: true } : null;
}
const requestKey = (kind, v) => (v && /^[A-Za-z0-9-]{8,80}$/.test(String(v)) ? `${kind}:${v}` : null);

/**
 * Goods in. Creates the batch if it is new (same SKU + batch number +
 * warehouse is the same batch), then a +quantity movement. `request_id`
 * makes a double-click or retry a no-op.
 */
export async function receiveInventory(input, { actor }) {
  await ensureInventorySchema();
  const skuId = idOf(input.sku_id);
  if (!skuId) throw bad('Choose the SKU.');
  const batchNumber = text(input.batch_number, 80);
  if (!batchNumber) throw bad('Enter the batch number.');
  const quantity = intOf(input.quantity, 'Quantity', { min: 1 });
  const mfg = dateOf(input.mfg_date, 'Manufacturing date');
  const expiry = dateOf(input.expiry_date, 'Expiry date');
  if (mfg && expiry && mfg > expiry) throw bad('Expiry date is before the manufacturing date.');
  const unitCost = moneyOf(input.unit_cost, 'Unit cost');
  const received = dateOf(input.received_date, 'Received date');
  const key = requestKey('receive', input.request_id);

  return inTransaction(async (client) => {
    const again = await priorMovement(client, key);
    if (again) return again;
    const { rows: sk } = await client.query('SELECT id, active FROM skus WHERE id = $1', [skuId]);
    if (!sk.length) throw bad('Unknown SKU.');
    if (!sk[0].active) throw bad('This SKU is inactive. Reactivate it before receiving stock.');
    const warehouseId = idOf(input.warehouse_id) || (await client.query('SELECT id FROM warehouses WHERE active ORDER BY sort, id LIMIT 1')).rows[0]?.id;
    const wh = await client.query('SELECT id FROM warehouses WHERE id = $1 AND active', [warehouseId]);
    if (!wh.rows.length) throw bad('Choose a warehouse.');
    const supplierId = await supplierFor(client, input, actor);

    const { rows: existing } = await client.query(
      `SELECT *, ${DATE_TEXT} FROM inventory_batches WHERE sku_id = $1 AND lower(batch_number) = lower($2) AND warehouse_id = $3 FOR UPDATE`,
      [skuId, batchNumber, warehouseId]);
    let batch = existing[0];
    let created = false;
    if (batch) {
      // Same batch again (a second delivery): its dates must agree.
      if ((mfg && batch.mfg_date && mfg !== batch.mfg_date) || (expiry && batch.expiry_date && expiry !== batch.expiry_date)) {
        throw bad(`Batch ${batch.batch_number} is already recorded with different dates (mfg ${batch.mfg_date || '—'}, expiry ${batch.expiry_date || '—'}).`, 409, { conflict: true });
      }
      await client.query(
        `UPDATE inventory_batches SET quantity_received = quantity_received + $2,
           mfg_date = coalesce(mfg_date, $3), expiry_date = coalesce(expiry_date, $4), version = version + 1,
           updated_at = now(), updated_by = $5 WHERE id = $1`, [batch.id, quantity, mfg, expiry, actor]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO inventory_batches (sku_id, batch_number, warehouse_id, location, mfg_date, expiry_date, quantity_received,
           unit_cost, supplier_id, po_number, grn_number, received_date, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::date, ${today(teamTimezone())}), $13, $14, $14) RETURNING *`,
        [skuId, batchNumber, warehouseId, text(input.location, 80), mfg, expiry, quantity, unitCost, supplierId,
          text(input.po_number, 80), text(input.grn_number, 80), received, text(input.notes, 1000), actor]);
      batch = rows[0];
      created = true;
      await audit(client, 'batch_created', { actor, skuId, batchId: batch.id, metadata: { batch_number: batchNumber, warehouse_id: warehouseId } });
    }
    const grn = text(input.grn_number, 80);
    const movementId = await writeMovement(client, {
      movement_type: 'received', batch_id: batch.id, quantity, actor,
      reason: 'Inventory received', reference_type: grn ? 'grn' : (text(input.po_number, 80) ? 'po' : null),
      reference_id: grn || text(input.po_number, 80), notes: text(input.notes, 1000), idempotency_key: key,
    });
    return { batchId: Number(batch.id), movementId, created };
  });
}

/**
 * A movement recorded by hand: a return, a write-off, a correction. Never an
 * overwrite: the change is the movement, with its reason.
 */
export async function adjustStock(input, { actor }) {
  await ensureInventorySchema();
  const type = String(input.movement_type || '');
  if (!MANUAL_MOVEMENTS.includes(type)) throw bad('Choose what kind of change this is.');
  const batchId = idOf(input.batch_id);
  if (!batchId) throw bad('Choose the batch.');
  const quantity = intOf(input.quantity, 'Quantity', { min: 1 });
  const reason = text(input.reason, 300);
  if (!reason) throw bad('Say why the stock is changing.');
  let referenceType = text(input.reference_type, 40);
  const referenceId = text(input.reference_id, 80);
  if (type === 'customer_return') {
    if (!referenceId) throw bad('Enter the return or order reference for a customer return.');
    referenceType = referenceType || 'return';
  }
  const key = requestKey('adjust', input.request_id);
  return inTransaction(async (client) => {
    const again = await priorMovement(client, key);
    if (again) return again;
    const movementId = await writeMovement(client, {
      movement_type: type, batch_id: batchId, quantity, actor, reason, reference_type: referenceType || 'adjustment',
      reference_id: referenceId, notes: text(input.notes, 1000), idempotency_key: key,
      order_id: idOf(input.order_id),
    });
    return { movementId, batchId };
  });
}

/** Moves stock between warehouses: out of one batch, into the same batch number there. */
export async function transferStock(input, { actor }) {
  await ensureInventorySchema();
  const batchId = idOf(input.batch_id);
  const toWarehouse = idOf(input.to_warehouse_id);
  const quantity = intOf(input.quantity, 'Quantity', { min: 1 });
  if (!batchId || !toWarehouse) throw bad('Choose the batch and where it is going.');
  const key = requestKey('transfer', input.request_id);
  return inTransaction(async (client) => {
    const again = await priorMovement(client, key && `${key}:out`);
    if (again) return again;
    const { rows } = await client.query(`SELECT *, ${DATE_TEXT} FROM inventory_batches WHERE id = $1 FOR UPDATE`, [batchId]);
    const from = rows[0];
    if (!from) throw bad('No such batch.', 404);
    if (from.warehouse_id === toWarehouse) throw bad('That batch is already in this warehouse.');
    const wh = await client.query('SELECT id FROM warehouses WHERE id = $1 AND active', [toWarehouse]);
    if (!wh.rows.length) throw bad('Unknown warehouse.');
    const { rows: target } = await client.query(
      'SELECT id FROM inventory_batches WHERE sku_id = $1 AND lower(batch_number) = lower($2) AND warehouse_id = $3 FOR UPDATE',
      [from.sku_id, from.batch_number, toWarehouse]);
    let toId = target[0]?.id;
    if (!toId) {
      const { rows: made } = await client.query(
        `INSERT INTO inventory_batches (sku_id, batch_number, warehouse_id, location, mfg_date, expiry_date, quantity_received,
           unit_cost, supplier_id, po_number, grn_number, received_date, status, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING id`,
        [from.sku_id, from.batch_number, toWarehouse, text(input.location, 80), from.mfg_date, from.expiry_date, from.unit_cost,
          from.supplier_id, from.po_number, from.grn_number, from.received_date, from.status, from.notes, actor]);
      toId = made[0].id;
      await audit(client, 'batch_created', { actor, skuId: from.sku_id, batchId: toId, metadata: { transfer_from: Number(from.id) } });
    }
    const ref = `T-${crypto.randomUUID().slice(0, 8)}`;
    const notes = text(input.notes, 1000);
    const out = await writeMovement(client, { movement_type: 'transfer_out', batch_id: from.id, quantity, actor, reason: 'Transfer out',
      reference_type: 'transfer', reference_id: ref, notes, idempotency_key: key && `${key}:out` });
    const inn = await writeMovement(client, { movement_type: 'transfer_in', batch_id: toId, quantity, actor, reason: 'Transfer in',
      reference_type: 'transfer', reference_id: ref, notes, idempotency_key: key && `${key}:in` });
    return { movementId: out, inMovementId: inn, batchId: Number(toId), reference: ref };
  });
}

const BATCH_EDITABLE = ['location', 'notes', 'status', 'unit_cost', 'po_number', 'grn_number', 'mfg_date', 'expiry_date', 'supplier_id'];

/** Batch details and status. Quantities never change here — only through movements. */
export async function updateBatch(id, input, { actor, version }) {
  await ensureInventorySchema();
  for (const k of ['on_hand', 'quantity_received', 'quantity']) {
    if (input[k] !== undefined) throw bad('Stock changes are recorded as movements, not edited.');
  }
  const f = {};
  if (input.location !== undefined) f.location = text(input.location, 80);
  if (input.notes !== undefined) f.notes = text(input.notes, 1000);
  if (input.po_number !== undefined) f.po_number = text(input.po_number, 80);
  if (input.grn_number !== undefined) f.grn_number = text(input.grn_number, 80);
  if (input.unit_cost !== undefined) f.unit_cost = moneyOf(input.unit_cost, 'Unit cost');
  if (input.mfg_date !== undefined) f.mfg_date = dateOf(input.mfg_date, 'Manufacturing date');
  if (input.expiry_date !== undefined) f.expiry_date = dateOf(input.expiry_date, 'Expiry date');
  if (input.status !== undefined) {
    if (!BATCH_STATUSES.includes(input.status)) throw bad('Unknown batch status.');
    f.status = input.status;
  }
  if (input.supplier_id !== undefined) f.supplier_id = idOf(input.supplier_id);
  const reason = text(input.reason, 300);
  if (f.status && !reason) throw bad('Say why the batch status is changing.');
  return inTransaction(async (client) => {
    const { rows } = await client.query(`SELECT *, ${DATE_TEXT} FROM inventory_batches WHERE id = $1 FOR UPDATE`, [id]);
    const cur = rows[0];
    if (!cur) throw bad('No such batch.', 404);
    if (version !== undefined && Number(version) !== cur.version) throw bad('Someone else changed this batch. Reload to see it.', 409, { conflict: true });
    const changes = {};
    for (const [k, v] of Object.entries(f)) if (String(cur[k] ?? '') !== String(v ?? '')) changes[k] = { from: cur[k], to: v };
    if (!Object.keys(changes).length) return { changed: false };
    const keys = Object.keys(changes);
    try {
      await client.query(
        `UPDATE inventory_batches SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1,
           updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`, [id, ...keys.map((k) => f[k]), actor]);
    } catch (err) {
      if (err.code === '23514') throw bad('Expiry date is before the manufacturing date.');
      throw err;
    }
    await audit(client, changes.status ? 'batch_status_changed' : 'batch_updated', {
      actor, skuId: cur.sku_id, batchId: id, metadata: { changes, reason },
    });
    return { changed: true };
  });
}

// ---------------------------------------------------------------- batch documents

export async function uploadBatchDocument({ batchId, filename, buffer, documentType, actor, store = storage() }) {
  await ensureInventorySchema();
  if (!BATCH_DOCUMENT_TYPES.includes(documentType)) throw bad('Choose what kind of document this is.');
  const { rows } = await getPool().query('SELECT id, sku_id FROM inventory_batches WHERE id = $1', [batchId]);
  if (!rows.length) throw bad('No such batch.', 404);
  const check = validateDocument(filename, buffer, DEFAULT_FORMATS);
  if (!check.ok) throw bad(check.error);
  const key = `inventory/${new Date().toISOString().slice(0, 7)}/batch-${batchId}-${crypto.randomUUID()}.${check.ext}`;
  await store.put(key, buffer, check.mime);
  try {
    return await inTransaction(async (client) => {
      const { rows: ins } = await client.query(
        `INSERT INTO batch_documents (batch_id, document_type, original_filename, storage_path, mime_type, file_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [batchId, documentType, filename, key, check.mime, buffer.length, actor]);
      await audit(client, 'batch_document_uploaded', { actor, skuId: rows[0].sku_id, batchId, metadata: { document_type: documentType, filename } });
      return Number(ins[0].id);
    });
  } catch (err) {
    await store.remove(key).catch((e) => console.error(`Orphaned batch document ${key}:`, e.message));
    throw err;
  }
}

export async function getBatchDocument(batchId, docId) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    'SELECT * FROM batch_documents WHERE id = $1 AND batch_id = $2 AND removed_at IS NULL', [docId, batchId]);
  return rows[0] || null;
}

/** Removed from view, never deleted: the record and the file stay for audit. */
export async function removeBatchDocument(batchId, docId, { actor }) {
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE batch_documents d SET removed_at = now(), removed_by = $3 FROM inventory_batches b
       WHERE d.id = $1 AND d.batch_id = $2 AND b.id = d.batch_id AND d.removed_at IS NULL
       RETURNING d.document_type, d.original_filename, b.sku_id`, [docId, batchId, actor]);
    if (!rows.length) throw bad('No such document.', 404);
    await audit(client, 'batch_document_removed', { actor, skuId: rows[0].sku_id, batchId, metadata: { document_type: rows[0].document_type, filename: rows[0].original_filename } });
  });
}

// ---------------------------------------------------------------- shipments

/** The orders travelling in a shipment: its main order and any attached ones. */
// A shipment's orders that take part in inventory: not cancelled, and not
// historical (before the stock cutover — see INVENTORY_ELIGIBLE_SQL).
async function shipmentOrderIds(client, shipmentId) {
  const { rows } = await client.query(
    `SELECT o.id, o.source_order_id, o.order_status, o.channel FROM order_shipments s JOIN orders o ON o.id = s.order_id
     WHERE s.id = $1 AND ${INVENTORY_ELIGIBLE_SQL('o')}
     UNION
     SELECT o.id, o.source_order_id, o.order_status, o.channel FROM shipment_orders m JOIN orders o ON o.id = m.order_id
     WHERE m.shipment_id = $1 AND m.detached_at IS NULL AND ${INVENTORY_ELIGIBLE_SQL('o')}`, [shipmentId]);
  return rows.filter((r) => r.order_status !== 'cancelled').map((r) => ({ id: Number(r.id), number: r.source_order_id, channel: r.channel }));
}

/**
 * What a shipment needs: line items of all its orders, summed per canonical
 * SKU. Lines without a known SKU are listed separately and block dispatch.
 *
 * An order's quantities are consumed once, whatever number of parcels it goes
 * out in. When an order has more than one live shipment (a split), each
 * shipment needs only what the order's other shipments have not already
 * taken — dispatched from, or reserved for — and staff reserve what this
 * parcel actually carries (`split`), at most that remainder. An order in a
 * shared parcel cannot also be split, so a split shipment carries one order.
 */
async function shipmentNeeds(client, shipmentId) {
  const orders = await shipmentOrderIds(client, shipmentId);
  if (!orders.length) return { orders, needs: [], unmapped: [], untracked: [], perOrder: [], split: false };
  const ids = orders.map((o) => o.id);
  const [{ rows }, { rows: claimedRows }, { rows: siblings }] = await Promise.all([
    client.query(
      `SELECT oi.order_id, oi.sku_id, oi.sku AS code, oi.title, oi.quantity, ${LINE_UNITS_SQL} AS units_per_listing,
              s.sku, s.product_name, s.variant_name, s.track_inventory
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN skus s ON s.id = oi.sku_id
       WHERE oi.order_id = ANY($1) AND oi.quantity > 0 ORDER BY oi.order_id, oi.id`, [ids]),
    // Taken by the same orders' other shipments: what left with them, and what
    // a single-order sibling still has set aside.
    client.query(
      `SELECT order_id, sku_id, sum(q)::int AS q FROM (
         SELECT m.order_id, m.sku_id, -m.quantity AS q FROM inventory_movements m
         WHERE m.movement_type = 'shipment_dispatched' AND m.order_id = ANY($1) AND m.shipment_id <> $2
         UNION ALL
         SELECT x.order_id, r.sku_id, r.quantity FROM inventory_reservations r JOIN order_shipments x ON x.id = r.shipment_id
         WHERE r.status = 'active' AND r.shipment_id <> $2 AND x.order_id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM shipment_orders so WHERE so.shipment_id = x.id AND so.detached_at IS NULL)
       ) t GROUP BY order_id, sku_id`, [ids, shipmentId]),
    client.query(
      `SELECT 1 FROM order_shipments x WHERE x.order_id = ANY($1) AND x.id <> $2 AND x.shipment_status <> 'cancelled' LIMIT 1`,
      [ids, shipmentId]),
  ]);
  const claimed = new Map(claimedRows.map((r) => [`${r.order_id}|${r.sku_id}`, Number(r.q)]));
  const needs = new Map();
  const unmapped = [];
  const untracked = [];
  const perOrderMap = new Map();
  for (const r of rows) {
    // A line whose SKU is not inventory-tracked needs no stock. An unmapped line
    // might be physical stock, so it is never assumed not to be.
    if (r.sku_id && r.track_inventory === false) {
      untracked.push({ order_id: Number(r.order_id), sku: r.sku, quantity: r.quantity });
      continue;
    }
    if (!r.sku_id) {
      unmapped.push({ order_id: Number(r.order_id), order_number: orders.find((o) => o.id === Number(r.order_id))?.number, code: r.code, title: r.title, quantity: r.quantity });
      continue;
    }
    // Everything below is in master-SKU units: the line's channel quantity
    // times its listing's units. The order line itself keeps its own quantity.
    const units = r.quantity * r.units_per_listing;
    const n = needs.get(r.sku_id) || { sku_id: r.sku_id, sku: r.sku, product_name: r.product_name, variant_name: r.variant_name, required: 0, ordered: 0, codes: [] };
    n.ordered += units;
    // The channel's own codes for this SKU (e.g. Amazon seller SKUs), for display.
    if (r.code && !n.codes.some((c) => c.toLowerCase() === r.code.toLowerCase())) n.codes.push(r.code);
    needs.set(r.sku_id, n);
    const k = `${r.order_id}|${r.sku_id}`;
    const po = perOrderMap.get(k) || { order_id: Number(r.order_id), sku_id: r.sku_id, quantity: 0 };
    po.quantity += units;
    perOrderMap.set(k, po);
  }
  // What is left for this shipment, per order and SKU.
  const perOrder = [];
  for (const [k, po] of perOrderMap) {
    const left = Math.max(po.quantity - (claimed.get(k) || 0), 0);
    if (left > 0) perOrder.push({ ...po, quantity: left });
  }
  for (const n of needs.values()) n.required = perOrder.filter((p) => p.sku_id === n.sku_id).reduce((t, p) => t + p.quantity, 0);
  return {
    orders, unmapped, untracked, perOrder, split: siblings.length > 0,
    needs: [...needs.values()].filter((n) => n.required > 0),
  };
}

/**
 * Whether reserved quantities fit what a shipment needs. A single shipment
 * must carry an order's full quantity; one parcel of a split carries what
 * staff put in it — at least one unit, never more than is left to send.
 */
function reservationFits(needs, totals, split) {
  if (!split) return needs.every((n) => (totals.get(n.sku_id) || 0) === n.required);
  const all = [...totals.values()].reduce((t, v) => t + v, 0);
  return all > 0 && needs.every((n) => (totals.get(n.sku_id) || 0) <= n.required);
}

/** FEFO: sellable batches, earliest expiry first (no expiry last), then oldest receipt. */
async function sellableBatches(client, skuIds, { tz, excludeShipment = null } = {}) {
  if (!skuIds.length) return [];
  const { rows } = await client.query(
    `SELECT b.id, b.sku_id, b.batch_number, b.expiry_date::text AS expiry_date, b.location, w.name AS warehouse_name, b.on_hand,
            b.status, coalesce(r.reserved, 0)::int AS reserved,
            CASE WHEN b.status <> 'active' THEN b.status
                 WHEN b.expiry_date IS NOT NULL AND b.expiry_date < ${today(tz)} THEN 'expired'
                 WHEN b.on_hand = 0 THEN 'depleted' ELSE 'active' END AS effective_status
     FROM inventory_batches b JOIN warehouses w ON w.id = b.warehouse_id
     LEFT JOIN (SELECT batch_id, sum(quantity) AS reserved FROM inventory_reservations
                WHERE status = 'active' AND ($2::bigint IS NULL OR shipment_id <> $2) GROUP BY batch_id) r ON r.batch_id = b.id
     WHERE b.sku_id = ANY($1)
     ORDER BY b.expiry_date ASC NULLS LAST, b.received_date ASC NULLS LAST, b.id ASC`, [skuIds, excludeShipment]);
  return rows.map((r) => ({ ...r, id: Number(r.id), available: r.effective_status === 'active' ? Math.max(r.on_hand - r.reserved, 0) : 0 }));
}

/** Greedy FEFO split of `required` across batches. A suggestion only. */
export function fefoSuggest(batches, required) {
  const picks = [];
  let left = required;
  for (const b of batches) {
    if (left <= 0) break;
    if (b.effective_status !== 'active' || b.available <= 0) continue;
    const take = Math.min(b.available, left);
    picks.push({ batch_id: b.id, quantity: take });
    left -= take;
  }
  return { picks, short: Math.max(left, 0) };
}

/**
 * The stock picture for one shipment: what it needs, what is free, the FEFO
 * suggestion, what is reserved for it, and what was deducted when it left.
 */
export async function shipmentStock(shipmentId, { tz = teamTimezone(), client = null } = {}) {
  await ensureInventorySchema();
  const db = client || getPool();
  const { rows: sh } = await db.query('SELECT id, order_id, shipment_status FROM order_shipments WHERE id = $1', [shipmentId]);
  if (!sh.length) throw bad('No such shipment.', 404);
  const { orders, needs, unmapped, untracked, split } = await shipmentNeeds(db, shipmentId);
  const [batches, reservations, dispatched] = await Promise.all([
    sellableBatches(db, needs.map((n) => n.sku_id), { tz, excludeShipment: shipmentId }),
    db.query(`SELECT r.id, r.sku_id, r.batch_id, r.quantity, r.created_at, r.created_by, b.batch_number, b.expiry_date::text AS expiry_date
              FROM inventory_reservations r JOIN inventory_batches b ON b.id = r.batch_id
              WHERE r.shipment_id = $1 AND r.status = 'active' ORDER BY r.id`, [shipmentId]),
    db.query(`SELECT m.sku_id, m.batch_id, b.batch_number, -sum(m.quantity)::int AS quantity, min(m.at) AS at
              FROM inventory_movements m JOIN inventory_batches b ON b.id = m.batch_id
              WHERE m.shipment_id = $1 AND m.movement_type = 'shipment_dispatched' GROUP BY m.sku_id, m.batch_id, b.batch_number`, [shipmentId]),
  ]);
  const lines = needs.map((n) => {
    const own = batches.filter((b) => b.sku_id === n.sku_id);
    const available = own.reduce((s, b) => s + b.available, 0);
    const reserved = reservations.rows.filter((r) => r.sku_id === n.sku_id).map((r) => ({ ...r, id: Number(r.id), batch_id: Number(r.batch_id) }));
    const reservedQty = reserved.reduce((s, r) => s + r.quantity, 0);
    const out = dispatched.rows.filter((d) => d.sku_id === n.sku_id).map((d) => ({ ...d, batch_id: Number(d.batch_id) }));
    return {
      ...n, available, enough: available >= n.required,
      batches: own.map((b) => ({ id: b.id, batch_number: b.batch_number, expiry_date: b.expiry_date, location: b.location,
        warehouse_name: b.warehouse_name, available: b.available, effective_status: b.effective_status })),
      suggestion: fefoSuggest(own, n.required),
      reserved, reserved_quantity: reservedQty, dispatched: out,
    };
  });
  const isDispatched = dispatched.rows.length > 0;
  const fullyReserved = lines.length > 0
    && reservationFits(lines, new Map(lines.map((l) => [l.sku_id, l.reserved_quantity])), split)
    && reservations.rows.every((r) => lines.some((l) => l.sku_id === r.sku_id));
  // Reservations with nothing left to carry them (e.g. every order cancelled):
  // shown so they can be released, never silently kept.
  const stranded = !lines.length && reservations.rows.length > 0;
  const state = !lines.length && !unmapped.length && !isDispatched && !stranded ? 'no_items'
    : stranded && !isDispatched ? 'stranded'
    : isDispatched ? 'dispatched'
      : unmapped.length ? 'unmapped'
        : fullyReserved ? 'reserved'
          : lines.some((l) => !l.enough && l.reserved_quantity < l.required) ? 'insufficient' : 'needs_reservation';
  return {
    shipment_id: Number(shipmentId), status: sh[0].shipment_status, state, split, channel: orders[0]?.channel || null, orders, lines, unmapped, untracked,
    stranded_reservations: stranded ? reservations.rows.map((r) => ({ ...r, id: Number(r.id), batch_id: Number(r.batch_id) })) : [],
  };
}

/**
 * Sets aside stock for a shipment, batch by batch, as confirmed by staff.
 * Replaces what was reserved before. Every SKU must be covered exactly.
 */
export async function reserveShipmentStock(shipmentId, allocations, { actor, tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  if (!Array.isArray(allocations) || !allocations.length) throw bad('Choose the batches to reserve.');
  const picks = allocations.map((a) => ({ batch_id: idOf(a.batch_id), quantity: intOf(a.quantity, 'Quantity', { min: 1 }) }));
  if (picks.some((p) => !p.batch_id)) throw bad('Choose a batch for every line.');
  if (new Set(picks.map((p) => p.batch_id)).size !== picks.length) throw bad('Each batch can be listed once.');
  return inTransaction(async (client) => {
    const { rows: sh } = await client.query('SELECT id, shipment_status FROM order_shipments WHERE id = $1 FOR UPDATE', [shipmentId]);
    if (!sh.length) throw bad('No such shipment.', 404);
    if (SHIPPED_STATES.has(sh[0].shipment_status) || sh[0].shipment_status === 'cancelled') {
      throw bad('Stock can only be reserved before the shipment is dispatched.', 409);
    }
    const { needs, unmapped, split } = await shipmentNeeds(client, shipmentId);
    if (unmapped.length) throw bad(`Map ${unmapped.map((u) => u.code || 'the unnamed item').join(', ')} to a Briyo SKU first.`, 409, { unmappedSkus: true });
    if (!needs.length) throw bad('This shipment has no items that need stock.');
    // Lock the batches in id order so two people reserving at once queue up.
    const ids = picks.map((p) => p.batch_id).sort((a, b) => a - b);
    await client.query('SELECT id FROM inventory_batches WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
    const batches = await sellableBatches(client, needs.map((n) => n.sku_id), { tz, excludeShipment: shipmentId });
    const byId = new Map(batches.map((b) => [b.id, b]));
    const totals = new Map();
    for (const p of picks) {
      const b = byId.get(p.batch_id);
      if (!b) throw bad('A chosen batch is not stock of a SKU in this shipment.');
      if (b.effective_status !== 'active') throw bad(`Batch ${b.batch_number} is ${b.effective_status} and cannot be dispatched.`, 409, { unsellable: true });
      if (p.quantity > b.available) throw bad(`Batch ${b.batch_number} has only ${b.available} available.`, 409, { insufficientStock: true });
      totals.set(b.sku_id, (totals.get(b.sku_id) || 0) + p.quantity);
    }
    if (!reservationFits(needs, totals, split)) {
      for (const n of needs) {
        const got = totals.get(n.sku_id) || 0;
        if (split && got > n.required) throw bad(`${n.sku}: only ${n.required} left to send for this order; ${got} chosen.`, 400);
        if (!split && got !== n.required) throw bad(`${n.sku} needs ${n.required}; ${got} chosen.`, 400);
      }
      throw bad('Choose what goes in this parcel: at least one unit.', 400);
    }
    await client.query(
      `UPDATE inventory_reservations SET status = 'released', closed_at = now(), closed_by = $2, close_reason = 'replaced'
       WHERE shipment_id = $1 AND status = 'active'`, [shipmentId, actor]);
    for (const p of picks) {
      const b = byId.get(p.batch_id);
      await client.query(
        'INSERT INTO inventory_reservations (shipment_id, sku_id, batch_id, quantity, created_by) VALUES ($1, $2, $3, $4, $5)',
        [shipmentId, b.sku_id, b.id, p.quantity, actor]);
    }
    await audit(client, 'stock_reserved', { actor, shipmentId, metadata: { allocations: picks } });
    return { reserved: picks.length };
  });
}

/** Gives back what a shipment had set aside. */
export async function releaseShipmentStock(shipmentId, { actor, reason = 'released' } = {}, client = null) {
  if (!client) await ensureInventorySchema();
  const run = async (c) => {
    const { rows } = await c.query(
      `UPDATE inventory_reservations SET status = 'released', closed_at = now(), closed_by = $2, close_reason = $3
       WHERE shipment_id = $1 AND status = 'active' RETURNING batch_id, quantity`, [shipmentId, actor, reason]);
    if (rows.length) await audit(c, 'stock_released', { actor, shipmentId, metadata: { reason, released: rows.map((r) => ({ batch_id: Number(r.batch_id), quantity: r.quantity })) } });
    return { released: rows.length };
  };
  return client ? run(client) : inTransaction(run);
}

const SHIPPED_STATES = new Set(['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto']);

/**
 * Called inside the shipment's status change, with its row locked. Deducts
 * exactly the reserved batches, one movement per order and batch, keyed so a
 * repeat can never deduct twice. Throws (rolling back the status change) when
 * stock is not confirmed, a SKU is unmapped, or a batch is no longer sellable.
 */
export async function dispatchShipmentStock(client, shipmentId, { actor, tz = teamTimezone() } = {}) {
  const done = await client.query(
    `SELECT 1 FROM inventory_movements WHERE shipment_id = $1 AND movement_type = 'shipment_dispatched' LIMIT 1`, [shipmentId]);
  if (done.rows.length) return { deducted: 0, repeated: true };
  const { needs, unmapped, perOrder, split } = await shipmentNeeds(client, shipmentId);
  if (!needs.length && !unmapped.length) {
    // Nothing stocked travels (e.g. a manual order) — but stock still set aside
    // for it must be released first, never left reserved behind a parcel.
    const { rows: held } = await client.query(
      `SELECT 1 FROM inventory_reservations WHERE shipment_id = $1 AND status = 'active' LIMIT 1`, [shipmentId]);
    if (held.length) throw bad('Stock is still reserved for this shipment but none of its orders needs it. Release it first.', 409, { needsStock: true });
    return { deducted: 0 };
  }
  if (unmapped.length) {
    throw bad(`This shipment has an unmapped SKU (${unmapped.map((u) => u.code || u.title).join(', ')}). Map it to a Briyo SKU, reserve the stock, then dispatch.`, 409, { needsStock: true, unmappedSkus: true });
  }
  const { rows: res } = await client.query(
    `SELECT r.id, r.sku_id, r.batch_id, r.quantity FROM inventory_reservations r
     WHERE r.shipment_id = $1 AND r.status = 'active' ORDER BY r.batch_id FOR UPDATE`, [shipmentId]);
  const totals = new Map();
  for (const r of res) totals.set(r.sku_id, (totals.get(r.sku_id) || 0) + r.quantity);
  if (!reservationFits(needs, totals, split)) {
    if (!res.length) throw bad('Confirm the stock batches for this shipment before dispatching it.', 409, { needsStock: true });
    const n = needs.find((x) => (split ? (totals.get(x.sku_id) || 0) > x.required : (totals.get(x.sku_id) || 0) !== x.required)) || needs[0];
    throw bad(`The stock reserved for ${n.sku} (${totals.get(n.sku_id) || 0}) no longer matches what the shipment ${split ? 'has left to send' : 'needs'} (${n.required}). Confirm the batches again.`, 409, { needsStock: true });
  }
  if (res.some((r) => !needs.some((n) => n.sku_id === r.sku_id))) {
    throw bad('Stock is reserved for an item no longer in this shipment. Confirm the batches again.', 409, { needsStock: true });
  }
  const batches = await sellableBatches(client, needs.map((n) => n.sku_id), { tz });
  let deducted = 0;
  for (const n of needs) {
    // Pair each order's quantity with the reserved batches, in order, so every
    // movement names the order it went out for.
    const orderQueue = perOrder.filter((p) => p.sku_id === n.sku_id).map((p) => ({ ...p }));
    for (const r of res.filter((x) => x.sku_id === n.sku_id)) {
      const b = batches.find((x) => x.id === Number(r.batch_id));
      if (!b || b.effective_status !== 'active') {
        throw bad(`Batch ${b?.batch_number || r.batch_id} is ${b?.effective_status || 'unavailable'} and cannot be dispatched. Confirm another batch.`, 409, { needsStock: true, unsellable: true });
      }
      // Close this reservation first, so the batch's free stock includes it.
      await client.query(
        `UPDATE inventory_reservations SET status = 'consumed', closed_at = now(), closed_by = $2, close_reason = 'dispatched' WHERE id = $1`,
        [r.id, actor]);
      let left = r.quantity;
      while (left > 0 && orderQueue.length) {
        const o = orderQueue[0];
        const take = Math.min(left, o.quantity);
        await writeMovement(client, {
          movement_type: 'shipment_dispatched', batch_id: r.batch_id, quantity: take, actor, reason: 'Shipment dispatched',
          reference_type: 'shipment', reference_id: shipmentId, shipment_id: shipmentId, order_id: o.order_id,
          idempotency_key: `dispatch:${shipmentId}:${o.order_id}:${r.batch_id}:${r.id}`,
        });
        deducted += take;
        left -= take;
        o.quantity -= take;
        if (!o.quantity) orderQueue.shift();
      }
    }
  }
  await client.query(
    `UPDATE inventory_reservations SET status = 'consumed', closed_at = now(), closed_by = $2, close_reason = 'dispatched'
     WHERE shipment_id = $1 AND status = 'active'`, [shipmentId, actor]);
  await audit(client, 'stock_dispatched', { actor, shipmentId, metadata: { units: deducted } });
  return { deducted };
}

/** True when stock has already left for this shipment (it can no longer be "un-dispatched"). */
export async function shipmentHasDispatchedStock(client, shipmentId) {
  const { rows } = await client.query(
    `SELECT 1 FROM inventory_movements WHERE shipment_id = $1 AND movement_type = 'shipment_dispatched' LIMIT 1`, [shipmentId]);
  return rows.length > 0;
}

/** Whether an order has stocked line items (so it cannot join a parcel that already left). A historical order has none. */
export async function orderHasItems(client, orderId) {
  const { rows } = await client.query(
    `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN skus s ON s.id = oi.sku_id
     WHERE oi.order_id = $1 AND oi.quantity > 0 AND (oi.sku_id IS NULL OR s.track_inventory) AND ${INVENTORY_ELIGIBLE_SQL('o')} LIMIT 1`, [orderId]);
  return rows.length > 0;
}

// ---------------------------------------------------------------- overview

/** Amazon (or other) codes on order lines that match no SKU. */
export async function unmappedSkus() {
  await ensureInventorySchema();
  // One row per platform code: the SKU Mapping worklist. Read-only — listing never maps, creates or moves anything;
  // a person maps a code with addPlatformMappings(fromOrder), which resolves all of its lines at once.
  const { rows } = await getPool().query(
    `SELECT o.channel, coalesce(max(p.label), max(c.label), o.channel) AS platform_label, (max(p.key) IS NOT NULL) AS mappable,
            min(oi.sku) AS code, max(oi.title) AS title, max(oi.asin) AS asin,
            (array_agg(DISTINCT oi.title) FILTER (WHERE oi.title IS NOT NULL))[1:5] AS titles,
            (array_agg(DISTINCT oi.amazon_listing_id) FILTER (WHERE oi.amazon_listing_id IS NOT NULL))[1:5] AS listing_ids,
            count(*)::int AS lines,
            count(DISTINCT oi.order_id)::int AS orders, coalesce(sum(oi.quantity), 0)::int AS units,
            (array_agg(DISTINCT o.source_order_id ORDER BY o.source_order_id))[1:20] AS order_refs,
            min(o.order_date) AS first_seen, max(o.order_date) AS last_seen
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     LEFT JOIN sku_platforms p ON p.key = o.channel LEFT JOIN sales_channels c ON c.key = o.channel
     WHERE oi.sku_id IS NULL AND coalesce(oi.sku, '') <> ''
     GROUP BY o.channel, lower(oi.sku) ORDER BY count(DISTINCT oi.order_id) DESC, min(oi.sku)`);
  return rows;
}

/**
 * Unmapped order lines that carry no SKU code at all. Nothing can map them through a platform SKU, so they are
 * listed for a person to see (and fix at the source), never resolved here.
 */
export async function unmappedLinesWithoutCode({ limit = 200 } = {}) {
  await ensureInventorySchema();
  const { rows } = await getPool().query(
    `SELECT oi.id AS line_id, o.id AS order_id, o.channel, coalesce(c.label, o.channel) AS platform_label, o.source_order_id AS order_ref,
            oi.title, oi.quantity, oi.source_line_item_id, oi.asin, o.order_date
     FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN sales_channels c ON c.key = o.channel
     WHERE oi.sku_id IS NULL AND coalesce(oi.sku, '') = ''
     ORDER BY o.order_date DESC NULLS LAST, oi.id LIMIT $1`, [limit]);
  return rows;
}

export async function inventoryOverview(f = {}, { tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const pool = getPool();
  const skus = await listSkus({ tz });
  const { rows: batchRows } = await pool.query(batchQuery(tz));
  const batches = batchRows.map(toBatch);
  const active = skus.filter((s) => s.active);
  const expiring = (days) => batches.filter((b) => b.on_hand > 0 && b.effective_status === 'active' && b.days_to_expiry !== null && b.days_to_expiry <= days);
  const cards = {
    totalSkus: active.length,
    totalUnits: batches.reduce((n, b) => n + b.on_hand, 0),
    onHandUnits: skus.reduce((n, s) => n + s.on_hand, 0),
    sellableUnits: skus.reduce((n, s) => n + s.sellable, 0),
    expiredUnits: skus.reduce((n, s) => n + s.expired, 0),
    quarantinedUnits: skus.reduce((n, s) => n + s.quarantined, 0),
    blockedUnits: skus.reduce((n, s) => n + s.blocked, 0),
    reservedSellableUnits: skus.reduce((n, s) => n + s.reserved_sellable, 0),
    availableUnits: skus.reduce((n, s) => n + s.available, 0),
    reservedUnits: batches.reduce((n, b) => n + b.reserved, 0),
    unsellableUnits: skus.reduce((n, s) => n + s.unsellable, 0),
    lowStock: active.filter((s) => s.low_stock).length,
    outOfStock: active.filter((s) => s.out_of_stock).length,
    expired: batches.filter((b) => b.on_hand > 0 && b.effective_status === 'expired').length,
    expiring30: expiring(30).length,
    expiring60: expiring(60).length,
    expiring90: expiring(90).length,
    inventoryValue: Math.round(batches.reduce((n, b) => n + (b.value || 0), 0) * 100) / 100,
    unitsWithoutCost: batches.filter((b) => b.unit_cost === null).reduce((n, b) => n + b.on_hand, 0),
  };

  // One row per batch; a SKU with no batches still shows, as "no stock".
  const q = String(f.q || '').trim().toLowerCase();
  const skuById = new Map(skus.map((s) => [s.id, s]));
  let rows = batches.map((b) => ({ ...b, sku_row: skuById.get(b.sku_id) }));
  for (const s of skus) if (!batches.some((b) => b.sku_id === s.id)) rows.push({ sku_id: s.id, sku: s.sku, product_name: s.product_name, variant_name: s.variant_name, empty: true, sku_row: s });
  if (!f.showInactive) rows = rows.filter((r) => r.sku_row.active);
  if (q) rows = rows.filter((r) => [r.sku, r.product_name, r.variant_name, r.batch_number, r.sku_row.asin, ...(r.sku_row.platform_skus || []).map((m) => m.platform_sku)].some((v) => String(v || '').toLowerCase().includes(q)));
  if (f.warehouse) rows = rows.filter((r) => String(r.warehouse_id) === String(f.warehouse));
  if (f.location) rows = rows.filter((r) => String(r.location || '').toLowerCase().includes(String(f.location).toLowerCase()));
  if (f.status) rows = rows.filter((r) => r.effective_status === f.status || (f.status === 'no_stock' && r.empty));
  if (f.expiring) {
    rows = f.expiring === 'expired' ? rows.filter((r) => r.on_hand > 0 && r.effective_status === 'expired')
      : rows.filter((r) => r.on_hand > 0 && r.effective_status === 'active' && r.days_to_expiry !== null && r.days_to_expiry <= Number(f.expiring));
  }
  if (f.stock === 'low') rows = rows.filter((r) => r.sku_row.low_stock);
  if (f.stock === 'out') rows = rows.filter((r) => r.sku_row.out_of_stock);
  rows.sort((a, b) => a.sku.localeCompare(b.sku) || String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999')) || (a.id || 0) - (b.id || 0));
  return {
    cards,
    rows: rows.map(({ sku_row: s, ...r }) => ({ ...r, sku_available: s.available, sku_reserved: s.reserved, low_stock: s.low_stock, out_of_stock: s.out_of_stock, sku_active: s.active })),
    unmapped: await unmappedSkus(),
    unmappedNoCode: await unmappedLinesWithoutCode(),
    warehouses: await listWarehouses(),
    suppliers: await listSuppliers(),
  };
}

/**
 * The Overview's inventory figures, without the Inventory page's work (no batch
 * rows, platform SKUs, unmapped list, warehouses or suppliers). Counts are
 * direct SQL; the stock flags use the same per-SKU and per-batch SQL as
 * inventoryOverview(), so they cannot drift — and are skipped while no batch
 * exists (nothing to flag yet).
 */
export async function inventoryDashboard({ tz = teamTimezone() } = {}) {
  await ensureInventorySchema();
  const pool = getPool();
  const { rows: [c] } = await pool.query(`
    SELECT (SELECT count(*) FROM skus WHERE active)::int AS master_skus,
           (SELECT count(*) FROM sku_platform_mappings)::int AS mappings,
           (SELECT count(*) FROM (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                  WHERE oi.sku_id IS NULL AND coalesce(oi.sku, '') <> '' GROUP BY o.channel, lower(oi.sku)) u)::int AS platform_skus_to_map,
           (SELECT count(*) FROM inventory_batches)::int AS batches,
           (SELECT count(*) FROM inventory_movements)::int AS movements,
           (SELECT count(*) FROM inventory_reservations WHERE status = 'active')::int AS active_reservations,
           (SELECT cutover_at FROM inventory_settings WHERE id) AS cutover_at`);
  const out = { ...c, stock_tracked: c.batches > 0, in_stock: 0, low_stock: 0, out_of_stock: 0, expired_batches: 0, expiring_30: 0, available_units: 0, reserved_units: 0 };
  if (!out.stock_tracked) return out;
  const [{ rows: skuRows }, { rows: batchRows }] = await Promise.all([
    pool.query(`SELECT * FROM (${skuStockSql(tz)}) x`), pool.query(batchQuery(tz))]);
  const all = skuRows.map(toSku);
  const skus = all.filter((s) => s.active);   // flags count active SKUs, as the Inventory page does
  const batches = batchRows.map(toBatch);
  return {
    ...out,
    in_stock: skus.filter((s) => s.available > 0).length,
    low_stock: skus.filter((s) => s.low_stock).length,
    out_of_stock: skus.filter((s) => s.out_of_stock).length,
    expired_batches: batches.filter((b) => b.on_hand > 0 && b.effective_status === 'expired').length,
    expiring_30: batches.filter((b) => b.on_hand > 0 && b.effective_status === 'active' && b.days_to_expiry !== null && b.days_to_expiry <= 30).length,
    available_units: all.reduce((n, s) => n + s.available, 0),
    reserved_units: batches.reduce((n, b) => n + b.reserved, 0),
  };
}

// ---------------------------------------------------------------- tests only

/** Removes inventory written by the test suite (SKU codes with this prefix). Test/dev databases only. */
export async function purgeTestInventory(prefix) {
  if (!prefix || prefix.length < 8) throw new Error('Refusing to purge without a specific test prefix.');
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    await assertMarkerIn(client, ['test', 'development'], 'Test inventory purge');
    await client.query(`SET LOCAL app.purge_inventory = 'on'`);
    const { rows } = await client.query('SELECT id FROM skus WHERE sku LIKE $1', [`${prefix}%`]);
    const ids = rows.map((r) => r.id);
    const paths = [];
    if (ids.length) {
      await client.query('DELETE FROM sku_platform_mappings WHERE sku_id = ANY($1)', [ids]);
      const docs = await client.query(
        `DELETE FROM batch_documents d USING inventory_batches b WHERE b.id = d.batch_id AND b.sku_id = ANY($1) RETURNING d.storage_path`, [ids]);
      paths.push(...docs.rows.map((r) => r.storage_path));
      await client.query('DELETE FROM inventory_reservations WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM inventory_movements WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM inventory_audit WHERE sku_id = ANY($1) OR batch_id IN (SELECT id FROM inventory_batches WHERE sku_id = ANY($1))', [ids]);
      await client.query('UPDATE order_items SET sku_id = NULL WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM inventory_batches WHERE sku_id = ANY($1)', [ids]);
      await client.query('DELETE FROM skus WHERE id = ANY($1)', [ids]);
    }
    await client.query(`DELETE FROM inventory_audit WHERE sku_id IS NULL AND batch_id IS NULL AND actor LIKE $1`, [`${prefix}%`]);
    await client.query('DELETE FROM suppliers WHERE name LIKE $1', [`${prefix}%`]);
    await client.query('DELETE FROM warehouses WHERE name LIKE $1', [`${prefix}%`]);
    const platformPrefix = `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_')}%`;
    await client.query('DELETE FROM sku_platform_mappings WHERE platform LIKE $1', [platformPrefix]);
    await client.query('DELETE FROM sku_platforms WHERE key LIKE $1', [platformPrefix]);
    return { skus: ids.length, paths };
  });
}
