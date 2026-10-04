import { getPool, ensureSchema } from './db.js';
import { assertMarkerIn } from './env-guard.js';
import {
  ensureInventorySchema, dispatchShipmentStock, releaseShipmentStock, shipmentHasDispatchedStock, orderHasItems,
} from './inventory.js';

/**
 * Orders & Logistics — one normalized order model for every sales channel.
 *
 * An order is the commercial record (channel, money, payment, order status).
 * A shipment is the physical one (courier, AWB, shipment status, dates). An
 * order has one or more shipments; the UI shows the first for now. The two
 * lifecycles are independent: nothing here changes one because of the other.
 *
 * Channels and couriers are rows, not code. Nothing branches on a channel name,
 * and fulfillment type is its own field, never inferred from the channel.
 *
 * Operational history is never overwritten: every change writes an
 * order_events row in the same transaction, and a trigger rejects UPDATE and
 * DELETE on that table.
 *
 * Time: every timestamp is stored as timestamptz (UTC). Input without an
 * explicit offset is read as the team's wall-clock time (BOARD_TIMEZONE,
 * default Asia/Kolkata) — never the browser's.
 */

export const ORDER_STATUSES = ['new', 'confirmed', 'cancelled', 'completed'];
export const SHIPMENT_STATUSES = [
  'not_ready', 'packed', 'dispatched', 'in_transit', 'out_for_delivery',
  'delivered', 'delivery_failed', 'rto', 'cancelled',
];
export const PAYMENT_METHODS = ['prepaid', 'cod', 'marketplace', 'other'];
export const PAYMENT_STATUSES = [
  'pending', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'failed', 'voided',
];
export const FULFILLMENT_TYPES = ['merchant', 'marketplace', 'third_party'];
export const DOCUMENT_TYPES = [
  'dispatch_product_image', 'tax_invoice', 'courier_receipt', 'marketplace_invoice', 'credit_note', 'other',
];
/**
 * Accepted file formats per document type. Dispatch proof is photos only;
 * every other type keeps the formats it has always had. Anything not listed
 * uses the default (PDF, PNG, JPG).
 */
export const DOCUMENT_FORMATS = { dispatch_product_image: ['jpg', 'jpeg', 'png', 'webp'] };

export const teamTimezone = () => process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata';

// Shipment states that mean a parcel has left with a courier. Reaching any of
// them needs a courier and an AWB, so a record is never "in transit" to nowhere.
const SHIPPED = new Set(['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto']);

/**
 * Logistics queues, as slices of the primary shipment (alias `s`) and order
 * status (alias `o`). Defined once; the list, the counts and the sidebar share them.
 */
export const LOGISTICS_VIEWS = {
  pending_dispatch: {
    label: 'Pending dispatch',
    // An order with no shipment yet (e.g. just imported from Amazon) is waiting too.
    where: `o.order_status IN ('new','confirmed') AND (s.id IS NULL OR s.shipment_status IN ('not_ready','packed'))`,
  },
  in_transit: { label: 'In transit', where: `s.shipment_status IN ('dispatched','in_transit','out_for_delivery')` },
  delivered: { label: 'Delivered', where: `s.shipment_status = 'delivered'` },
  failed: { label: 'Failed / RTO', where: `s.shipment_status IN ('delivery_failed','rto')` },
};

/**
 * How a shipment leaves: straight to a customer (Easy Ship), or as stock to a
 * warehouse, quick-commerce hub, partner or retailer. Everything but Easy Ship
 * goes to a named destination.
 */
export const DISPATCH_TYPES = ['easy_ship', 'warehouse', 'quick_commerce', 'partner', 'retailer'];
export const DISPATCH_TYPE_LABELS = {
  easy_ship: 'Easy Ship', warehouse: 'Warehouse', quick_commerce: 'Quick Commerce', partner: 'Partner', retailer: 'Retailer',
};
const needsDestination = (type) => Boolean(type) && type !== 'easy_ship';

// [key, label, sort, dispatch types it is used for] — from the logistics team's sheet.
const SEED_CHANNELS = [
  ['website', 'Website', 10, ['easy_ship']],
  ['amazon', 'Amazon', 20, ['easy_ship', 'warehouse']],
  ['flipkart', 'Flipkart', 30, ['easy_ship']],
  ['myntra', 'Myntra', 40, ['easy_ship']],
  ['pharmeasy', 'PharmEasy', 50, ['easy_ship']],
  ['tata_1mg', 'Tata 1mg', 60, ['easy_ship', 'warehouse']],
  ['hyugalife', 'HyugaLife', 70, ['easy_ship']],
  ['blinkit', 'Blinkit', 80, ['quick_commerce']],
  ['instamart', 'Instamart', 90, ['quick_commerce']],
  ['zepto', 'Zepto', 100, ['quick_commerce']],
  ['bigbasket', 'BigBasket', 110, ['partner']],
  ['nykaa', 'Nykaa', 120, ['partner']],
  ['netmeds', 'Netmeds', 130, ['partner']],
  ['retailers', 'Retailers', 140, ['retailer']],
];

// Destinations as the logistics team's sheet names them: [channel, type, names].
const SEED_DESTINATIONS = [
  ['tata_1mg', 'warehouse', ['TATA 1MG Health Care Solutions Private Limited - BEHRAMPUR',
    'TATA 1MG Health Care Solutions Private Limited - NOIDA', 'TATA 1MG Health Care Solutions Private Limited - BANGLORE',
    'TATA 1MG Health Care Solutions Private Limited - MUMBAI', 'TATA 1MG Health Care Solutions Private Limited - KOLKATA']],
  ['amazon', 'warehouse', ['AMD2', 'BLR7', 'BLR8', 'HYD3', 'HYD8', 'BOM5', 'CCX1', 'CCX2', 'CJB1', 'DEX3', 'LKO1', 'MAA4', 'PNQ2']],
  ['bigbasket', 'partner', ['INNOVATIVE RETAILL CONCEPTS PVT LTD- WMS-Noida-FC', 'INNOVATIVE RETAILL CONCEPTS PVT LTD- WMS-Kundli-FC',
    'INNOVATIVE RETAILL CONCEPTS PVT LTD- WMS-Bangalore-FC', 'INNOVATIVE RETAILL CONCEPTS PVT LTD- WMS-Kolkata-FC',
    'INNOVATIVE RETAILL CONCEPTS PVT LTD- WMS-Chennai-FC', 'INNOVATIVE RETAILL CONCEPTS PVT LTD-WMS-Ahmedabad-FC',
    'INNOVATIVE RETAILL CONCEPTS PVT LTD-WMS-Hyderabad-FC', 'INNOVATIVE RETAILL CONCEPTS PVT LTD-WMS-Pune-FC',
    'INNOVATIVE RETAILL CONCEPTS PVT LTD-WMS-Bangalore-FC2', 'INNOVATIVE RETAILL CONCEPTS PVT LTD-Mumbai-GM-NDC']],
  ['blinkit', 'quick_commerce', ['BLINK COMMERCE PRIVATE LIMITED-PUNE P3', 'BLINK COMMERCE PRIVATE LIMITED-BENGALURU B5',
    'BLINK COMMERCE PRIVATE LIMITED-RAJPURA R2', 'BLINK COMMERCE PRIVATE LIMITED-KUNDLI FEEDAR',
    'BLINK COMMERCE PRIVATE LIMITED-LUCKNOW L4', 'BLINK COMMERCE PRIVATE LIMITED-AHMEDABAD A2',
    'BLINK COMMERCE PRIVATE LIMITED-MUMBAI M12', 'BLINK COMMERCE PRIVATE LIMITED-KOLKATA K6',
    'BLINK COMMERCE PRIVATE LIMITED-NAGPUR N1', 'BLINK COMMERCE PRIVATE LIMITED-JAIPUR J3',
    'BLINK COMMERCE PRIVATE LIMITED-FARIDABAD', 'BLINK COMMERCE PRIVATE LIMITED-HYDERBAD H3']],
  ['instamart', 'quick_commerce', ['SCOOTSY LOGISTICS PRIVATE LIMITED-BLR DHL', 'SCOOTSY LOGISTICS PRIVATE LIMITED-MUM FC22',
    'SCOOTSY LOGISTICS PRIVATE LIMITED-BLR IM4', 'SCOOTSY LOGISTICS PRIVATE LIMITED-BLR Ecom2',
    'SCOOTSY LOGISTICS PRIVATE LIMITED-BLR IM1', 'SCOOTSY LOGISTICS PRIVATE LIMITED-MUM IM1', 'SCOOTSY LOGISTICS PRIVATE LIMITED-MUM IM3']],
  ['zepto', 'quick_commerce', ['ZEPTO LIMITED-GUR-SS-MH-FARUKHNAGAR (GUR044M)', 'ZEPTO LIMITED-MUM-SS-MH-SHAKTI (MUM175M)',
    'ZEPTO LIMITED-CHN-SS-MH-THIRUVALLUR (CHN063M)', 'ZEPTO LIMITED-BLR-SS-MH-SUMADHURA (BLR135M)',
    'ZEPTO LIMITED- BLR-DRY-MH-Sumadhura2 (BLR294M)']],
  ['nykaa', 'partner', ['FDA-Mumbai', 'TAURU', 'BANGLORE-1', 'KOL-2 WAREHOUSE', 'DELHI-2', 'DEL1']],
  ['netmeds', 'partner', ['RELIANCE RETAIL LIMITED [NOIDA2 FC]', 'RELIANCE RETAIL LIMITED [BHIWANDI FC]',
    'RELIANCE RETAIL LIMITED [BANGALORE FC]', 'RELIANCE RETAIL LIMITED [HOWRA FC]']],
  ['retailers', 'retailer', ['Trakdem Solutionts Pvt. Ltd.', 'NEW WELCOME AGENCIES PVT. LTD.',
    'AKAB HEALTHCARE PRIVATE LIMITED', 'GPSAR Healthcare Ltd', 'Sastasundar Healthbuddy Limited']],
];

// Public tracking pages as found, NOT verified with a real AWB. They are
// seeded unverified; an admin marks one verified after testing it.
const SEED_COURIERS = [
  ['Delhivery', 'https://www.delhivery.com/track/package/{awb}', 10],
  ['Blue Dart', 'https://www.bluedart.com/web/guest/trackdartresult?trackFor=0&trackNo={awb}', 20],
  ['DTDC', 'https://www.dtdc.in/tracking.asp?strCnno={awb}', 30],
  ['Xpressbees', 'https://www.xpressbees.com/shipment/tracking?awbNo={awb}', 40],
  ['Ekart', 'https://ekartlogistics.com/shipmenttrack/{awb}', 50],
  ['Amazon Shipping', 'https://track.amazon.in/tracking/{awb}', 60],
  ['India Post', null, 70],
  ['Porter', null, 80],
  ['Shree Tirupati Courier', null, 85],
  ['Other', null, 90],
];

const list = (values) => values.map((v) => `'${v}'`).join(',');

/** Replaces a CHECK constraint so the allowed values track the constants above. */
async function setCheck(client, table, name, expr) {
  await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}, ADD CONSTRAINT ${name} CHECK (${expr})`);
}

let ordersSchema = null;
export function ensureOrdersSchema() {
  if (!ordersSchema) {
    ordersSchema = (async () => {
      await ensureSchema();
      const sql = getPool();
      await sql.query(`
        CREATE TABLE IF NOT EXISTS sales_channels (
          key        TEXT PRIMARY KEY,
          label      TEXT NOT NULL,
          sort       INTEGER NOT NULL DEFAULT 100,
          active     BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query(`ALTER TABLE sales_channels ADD COLUMN IF NOT EXISTS dispatch_types TEXT[] NOT NULL DEFAULT '{}'`);
      // New channels are added; existing ones keep their label and only gain
      // dispatch types if they have none yet (so an admin's edit is never undone).
      for (const [key, label, sort, types] of SEED_CHANNELS) {
        await sql.query(`INSERT INTO sales_channels (key, label, sort, dispatch_types) VALUES ($1, $2, $3, $4)
                         ON CONFLICT (key) DO UPDATE SET dispatch_types = EXCLUDED.dispatch_types
                         WHERE sales_channels.dispatch_types = '{}'`, [key, label, sort, types]);
      }
      await sql.query(`
        CREATE TABLE IF NOT EXISTS courier_partners (
          id                    SERIAL PRIMARY KEY,
          name                  TEXT NOT NULL UNIQUE,
          tracking_url_template TEXT,
          active                BOOLEAN NOT NULL DEFAULT true,
          sort                  INTEGER NOT NULL DEFAULT 100
        )`);
      // Set when someone has opened a generated link for a real AWB and it
      // worked. Cleared whenever the pattern changes.
      await sql.query(`ALTER TABLE courier_partners ADD COLUMN IF NOT EXISTS template_verified_at TIMESTAMPTZ`);
      await sql.query(`ALTER TABLE courier_partners ADD COLUMN IF NOT EXISTS template_verified_by TEXT`);
      for (const [name, template, sort] of SEED_COURIERS) {
        await sql.query(`INSERT INTO courier_partners (name, tracking_url_template, sort) VALUES ($1, $2, $3)
                         ON CONFLICT (name) DO NOTHING`, [name, template, sort]);
      }

      await sql.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id                BIGSERIAL PRIMARY KEY,
          internal_order_id TEXT GENERATED ALWAYS AS ('ORD-' || lpad(id::text, 6, '0')) STORED UNIQUE,
          channel           TEXT NOT NULL REFERENCES sales_channels(key),
          source_order_id   TEXT NOT NULL,
          order_date        TIMESTAMPTZ,
          customer_name     TEXT,
          customer_phone    TEXT,
          customer_email    TEXT,
          order_value       NUMERIC(12,2) CHECK (order_value >= 0),
          currency          TEXT NOT NULL DEFAULT 'INR',
          payment_method    TEXT,
          payment_status    TEXT,
          order_status      TEXT NOT NULL DEFAULT 'new',
          fulfillment_type  TEXT,
          source            TEXT NOT NULL DEFAULT 'manual',
          source_payload    JSONB,
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by        TEXT,
          updated_by        TEXT,
          UNIQUE (channel, source_order_id)
        )`);
      await sql.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT');
      // Only channel and order number are required: logistics often has no
      // date or value to hand, and must not be made to invent one.
      await sql.query('ALTER TABLE orders ALTER COLUMN order_date DROP NOT NULL, ALTER COLUMN order_value DROP NOT NULL');
      await sql.query('CREATE INDEX IF NOT EXISTS orders_date_idx ON orders (order_date DESC)');

      // Where stock goes: warehouses, hubs, partner FCs, retailers.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS dispatch_destinations (
          id            SERIAL PRIMARY KEY,
          channel       TEXT NOT NULL REFERENCES sales_channels(key),
          dispatch_type TEXT NOT NULL,
          name          TEXT NOT NULL,
          active        BOOLEAN NOT NULL DEFAULT true,
          sort          INTEGER NOT NULL DEFAULT 100,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (channel, dispatch_type, name)
        )`);
      await setCheck(sql, 'dispatch_destinations', 'dispatch_destinations_type_check', `dispatch_type IN (${list(DISPATCH_TYPES)})`);
      // Seeded once, from the sheet; after that the list is the admins' to edit.
      const { rows: anyDest } = await sql.query('SELECT 1 FROM dispatch_destinations LIMIT 1');
      if (!anyDest.length) {
        for (const [channel, type, names] of SEED_DESTINATIONS) {
          for (const [i, name] of names.entries()) {
            await sql.query(`INSERT INTO dispatch_destinations (channel, dispatch_type, name, sort) VALUES ($1, $2, $3, $4)
                             ON CONFLICT DO NOTHING`, [channel, type, name.trim(), (i + 1) * 10]);
          }
        }
      }
      await sql.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_type TEXT');
      await sql.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS destination_id INTEGER REFERENCES dispatch_destinations(id)');
      await setCheck(sql, 'orders', 'orders_dispatch_type_check', `dispatch_type IN (${list(DISPATCH_TYPES)})`);
      // Orders entered before dispatch types existed take their channel's only
      // type (e.g. Blinkit → Quick Commerce). Channels with two types stay unset.
      await sql.query(`UPDATE orders o SET dispatch_type = c.dispatch_types[1]
                       FROM sales_channels c
                       WHERE o.channel = c.key AND o.dispatch_type IS NULL AND cardinality(c.dispatch_types) = 1`);

      await sql.query(`
        CREATE TABLE IF NOT EXISTS order_shipments (
          id                     BIGSERIAL PRIMARY KEY,
          order_id               BIGINT NOT NULL REFERENCES orders(id),
          courier_partner_id     INTEGER REFERENCES courier_partners(id),
          tracking_id            TEXT,
          tracking_url           TEXT,
          shipment_status        TEXT NOT NULL DEFAULT 'not_ready',
          dispatch_date          TIMESTAMPTZ,
          expected_delivery_date DATE,
          delivered_at           TIMESTAMPTZ,
          version                INTEGER NOT NULL DEFAULT 1,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by             TEXT,
          updated_by             TEXT
        )`);
      await sql.query('CREATE INDEX IF NOT EXISTS order_shipments_order_idx ON order_shipments (order_id, id)');
      await sql.query('CREATE INDEX IF NOT EXISTS order_shipments_status_idx ON order_shipments (shipment_status)');
      // Shared shipments: extra orders that travel inside another order's
      // shipment (e.g. several Amazon orders under one AWB). The shipment's own
      // order_id stays its lead order; single-order shipments have no rows here.
      // Detaching keeps the row (detached_at) so the history stays readable.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS shipment_orders (
          id          BIGSERIAL PRIMARY KEY,
          shipment_id BIGINT NOT NULL REFERENCES order_shipments(id),
          order_id    BIGINT NOT NULL REFERENCES orders(id),
          attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          attached_by TEXT,
          detached_at TIMESTAMPTZ,
          detached_by TEXT
        )`);
      // An order is in at most one shared shipment at a time.
      await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS shipment_orders_one_active
                       ON shipment_orders (order_id) WHERE detached_at IS NULL`);
      await sql.query(`CREATE INDEX IF NOT EXISTS shipment_orders_shipment_idx
                       ON shipment_orders (shipment_id) WHERE detached_at IS NULL`);

      // One-time move of milestone-1 shipment columns off `orders`. Copies
      // every row first, drops the columns only after, all in one transaction.
      const { rows: legacy } = await sql.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'shipment_status'`);
      if (legacy.length) {
        const client = await sql.connect();
        try {
          await client.query('BEGIN');
          await client.query(`
            INSERT INTO order_shipments (order_id, courier_partner_id, tracking_id, tracking_url, shipment_status,
                                         dispatch_date, expected_delivery_date, delivered_at, created_at, updated_at,
                                         created_by, updated_by)
            SELECT id, courier_partner_id, tracking_id, tracking_url, shipment_status, dispatch_date,
                   expected_delivery_date, delivered_at, created_at, updated_at, created_by, updated_by
            FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_shipments s WHERE s.order_id = o.id)`);
          await client.query(`ALTER TABLE orders
            DROP COLUMN courier_partner_id, DROP COLUMN tracking_id, DROP COLUMN tracking_url,
            DROP COLUMN shipment_status, DROP COLUMN dispatch_date, DROP COLUMN expected_delivery_date,
            DROP COLUMN delivered_at`);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // Allowed values live in the constants above; constraints follow them.
      // Legacy free-text payment values (milestone 1 had none in real use)
      // are nulled rather than guessed at, before the stricter check applies.
      await sql.query(`UPDATE orders SET payment_method = NULL
                       WHERE payment_method IS NOT NULL AND payment_method NOT IN (${list(PAYMENT_METHODS)})`);
      await sql.query(`UPDATE orders SET payment_status = NULL
                       WHERE payment_status IS NOT NULL AND payment_status NOT IN (${list(PAYMENT_STATUSES)})`);
      await setCheck(sql, 'orders', 'orders_payment_method_check', `payment_method IN (${list(PAYMENT_METHODS)})`);
      await setCheck(sql, 'orders', 'orders_payment_status_check', `payment_status IN (${list(PAYMENT_STATUSES)})`);
      await setCheck(sql, 'orders', 'orders_order_status_check', `order_status IN (${list(ORDER_STATUSES)})`);
      await setCheck(sql, 'orders', 'orders_fulfillment_type_check', `fulfillment_type IN (${list(FULFILLMENT_TYPES)})`);
      await sql.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipment_status_check');
      await setCheck(sql, 'order_shipments', 'order_shipments_status_check', `shipment_status IN (${list(SHIPMENT_STATUSES)})`);

      await sql.query(`
        CREATE TABLE IF NOT EXISTS order_documents (
          id                BIGSERIAL PRIMARY KEY,
          order_id          BIGINT NOT NULL REFERENCES orders(id),
          document_type     TEXT NOT NULL CHECK (document_type IN (${list(DOCUMENT_TYPES)})),
          original_filename TEXT NOT NULL,
          storage_path      TEXT NOT NULL UNIQUE,
          mime_type         TEXT NOT NULL,
          file_size         INTEGER NOT NULL,
          uploaded_by       TEXT,
          uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          removed_at        TIMESTAMPTZ,
          removed_by        TEXT
        )`);
      await sql.query('CREATE INDEX IF NOT EXISTS order_documents_order_idx ON order_documents (order_id)');
      // What was ordered. Filled by imports (e.g. Amazon), one row per
      // marketplace line item; source_line_item_id keeps re-imports idempotent.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS order_items (
          id                  BIGSERIAL PRIMARY KEY,
          order_id            BIGINT NOT NULL REFERENCES orders(id),
          source_line_item_id TEXT NOT NULL,
          sku                 TEXT,
          title               TEXT,
          quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
          item_price          NUMERIC(12,2),
          item_tax            NUMERIC(12,2),
          price_excl_tax      NUMERIC(12,2),
          promotion_discount  NUMERIC(12,2),
          promotion_id        TEXT,
          shipping_price      NUMERIC(12,2),
          shipping_tax        NUMERIC(12,2),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (order_id, source_line_item_id)
        )`);
      // One row per order-report import: who, when, which file, what happened.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS order_imports (
          id               BIGSERIAL PRIMARY KEY,
          channel          TEXT NOT NULL REFERENCES sales_channels(key),
          imported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          imported_by      TEXT,
          filename         TEXT,
          file_sha256      TEXT,
          rows_processed   INTEGER NOT NULL,
          orders_in_file   INTEGER NOT NULL,
          orders_created   INTEGER NOT NULL,
          orders_updated   INTEGER NOT NULL,
          orders_unchanged INTEGER NOT NULL,
          items_created    INTEGER NOT NULL,
          items_updated    INTEGER NOT NULL,
          promotion_rows   INTEGER NOT NULL,
          duplicate_rows   INTEGER NOT NULL,
          error_rows       INTEGER NOT NULL,
          errors           JSONB NOT NULL DEFAULT '[]'
        )`);
      // Allowed types follow DOCUMENT_TYPES (dispatch_product_image was added later).
      await setCheck(sql, 'order_documents', 'order_documents_document_type_check',
        `document_type IN (${list(DOCUMENT_TYPES)})`);
      await sql.query(`
        CREATE TABLE IF NOT EXISTS order_events (
          id         BIGSERIAL PRIMARY KEY,
          order_id   BIGINT NOT NULL REFERENCES orders(id),
          event_type TEXT NOT NULL,
          actor      TEXT,
          at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          metadata   JSONB NOT NULL DEFAULT '{}'
        )`);
      await sql.query('CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, at)');
      // Append-only, enforced by the database. The only way past it is a
      // transaction that sets app.purge_orders, used solely by the test suite.
      await sql.query(`
        CREATE OR REPLACE FUNCTION order_events_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND current_setting('app.purge_orders', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'order_events is append-only';
        END $$ LANGUAGE plpgsql`);
      await sql.query('DROP TRIGGER IF EXISTS order_events_append_only ON order_events');
      await sql.query(`CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
                       FOR EACH ROW EXECUTE FUNCTION order_events_append_only()`);
    })().catch((err) => { ordersSchema = null; throw err; });
  }
  return ordersSchema;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function offsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/** "2026-09-24T11:30" in `tz` → UTC ISO string. */
export function zonedToUtc(naive, tz = teamTimezone()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(naive);
  if (!m) return null;
  const guess = Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6] || 0);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // settles across a DST edge; a no-op for IST
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export async function listChannels() {
  const { rows } = await getPool().query(
    'SELECT key, label, active, dispatch_types FROM sales_channels ORDER BY sort, key');
  return rows;
}

export async function listDestinations({ includeInactive = false } = {}) {
  const { rows } = await getPool().query(
    `SELECT d.id, d.channel, c.label AS channel_label, d.dispatch_type, d.name, d.active
     FROM dispatch_destinations d JOIN sales_channels c ON c.key = d.channel
     ${includeInactive ? '' : 'WHERE d.active'} ORDER BY c.sort, d.dispatch_type, d.sort, d.name`);
  return rows;
}

/** Admin: add, rename or switch off a destination. Destinations are never deleted. */
export async function saveDestination({ id, channel, dispatch_type: type, name, active }) {
  const clean = name === undefined ? undefined : String(name).trim().slice(0, 160);
  if (clean === '') throw bad('A destination needs a name.');
  if (id) {
    const { rows } = await getPool().query(
      `UPDATE dispatch_destinations SET name = COALESCE($2, name), active = COALESCE($3, active)
       WHERE id = $1 RETURNING id, channel, dispatch_type, name, active`, [id, clean ?? null, active ?? null]);
    return rows[0] || null;
  }
  if (!clean) throw bad('A destination needs a name.');
  if (!needsDestination(type)) throw bad('Choose Warehouse, Quick Commerce, Partner or Retailer.');
  const { rows: ch } = await getPool().query('SELECT dispatch_types FROM sales_channels WHERE key = $1', [channel]);
  if (!ch.length) throw bad('Unknown channel.');
  if (ch[0].dispatch_types.length && !ch[0].dispatch_types.includes(type)) {
    throw bad(`That channel is not used for ${DISPATCH_TYPE_LABELS[type]}.`);
  }
  const { rows } = await getPool().query(
    `INSERT INTO dispatch_destinations (channel, dispatch_type, name, sort)
     VALUES ($1, $2, $3, (SELECT coalesce(max(sort), 0) + 10 FROM dispatch_destinations WHERE channel = $1 AND dispatch_type = $2))
     RETURNING id, channel, dispatch_type, name, active`, [channel, type, clean]);
  return rows[0];
}

/**
 * Checks channel ↔ dispatch type ↔ destination. A channel with one type takes
 * it by default; Easy Ship has no destination, every other type needs one
 * that belongs to that channel and type.
 */
async function resolveRoute(client, channel, type, destinationId) {
  const { rows } = await client.query('SELECT dispatch_types, label FROM sales_channels WHERE key = $1', [channel]);
  if (!rows.length) throw bad('Unknown channel.');
  const types = rows[0].dispatch_types;
  let t = type || (types.length === 1 ? types[0] : null);
  if (!t) throw bad(`Choose the dispatch type for ${rows[0].label}.`);
  if (!DISPATCH_TYPES.includes(t)) throw bad('Unknown dispatch type.');
  if (types.length && !types.includes(t)) throw bad(`${rows[0].label} is not used for ${DISPATCH_TYPE_LABELS[t]}.`);
  if (!needsDestination(t)) return { dispatchType: t, destinationId: null };
  if (!destinationId) throw bad('Choose the destination.');
  const { rows: d } = await client.query(
    'SELECT id FROM dispatch_destinations WHERE id = $1 AND channel = $2 AND dispatch_type = $3 AND active',
    [Number(destinationId), channel, t]);
  if (!d.length) throw bad(`That destination is not a ${rows[0].label} ${DISPATCH_TYPE_LABELS[t]} destination.`);
  return { dispatchType: t, destinationId: Number(destinationId) };
}

const COURIER_COLUMNS = 'id, name, tracking_url_template, active, template_verified_at, template_verified_by';

export async function listCouriers({ includeInactive = false } = {}) {
  const { rows } = await getPool().query(
    `SELECT ${COURIER_COLUMNS} FROM courier_partners
     ${includeInactive ? '' : 'WHERE active'} ORDER BY sort, name`);
  return rows;
}

export async function saveCourier({ id, name, template, active, verified }, { actor } = {}) {
  const clean = {
    name: name === undefined ? null : String(name).trim().slice(0, 60) || null,
    template: template === undefined ? undefined : (String(template || '').trim() || null),
  };
  if (clean.template && !/^https:\/\/\S+\{awb\}/.test(clean.template)) {
    throw Object.assign(new Error('The pattern must be an https:// address containing {awb}.'), { status: 400 });
  }
  if (id) {
    // A changed pattern is unverified again, whatever was claimed before.
    const { rows } = await getPool().query(
      `UPDATE courier_partners SET
         name = COALESCE($2, name),
         tracking_url_template = CASE WHEN $3 THEN $4 ELSE tracking_url_template END,
         active = COALESCE($5, active),
         template_verified_at = CASE
           WHEN $3 AND $4 IS DISTINCT FROM tracking_url_template THEN NULL
           WHEN $6::boolean IS TRUE AND template_verified_at IS NULL THEN now()
           WHEN $6::boolean IS FALSE THEN NULL
           ELSE template_verified_at END,
         template_verified_by = CASE
           WHEN $3 AND $4 IS DISTINCT FROM tracking_url_template THEN NULL
           WHEN $6::boolean IS TRUE AND template_verified_at IS NULL THEN $7
           WHEN $6::boolean IS FALSE THEN NULL
           ELSE template_verified_by END
       WHERE id = $1 RETURNING ${COURIER_COLUMNS}`,
      [id, clean.name, clean.template !== undefined, clean.template ?? null, active ?? null,
        verified === undefined ? null : Boolean(verified), actor ?? null]);
    return rows[0] || null;
  }
  if (!clean.name) throw Object.assign(new Error('A courier needs a name.'), { status: 400 });
  const { rows } = await getPool().query(
    `INSERT INTO courier_partners (name, tracking_url_template) VALUES ($1, $2)
     RETURNING ${COURIER_COLUMNS}`, [clean.name, clean.template ?? null]);
  return rows[0];
}

/** Fills a courier's template with an AWB. Null when either is missing. */
export function trackingUrlFor(template, awb) {
  if (!template || !awb) return null;
  return template.replaceAll('{awb}', encodeURIComponent(String(awb).trim()));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// The first shipment is the one the list and the drawer show. Its columns
// keep their milestone-1 names in the list, so the screen reads unchanged.
const ORDER_COLUMNS = `
  o.*, c.label AS channel_label, dd.name AS destination_name,
  s.id AS shipment_id, s.version AS shipment_version, s.shipment_status, s.courier_partner_id,
  s.tracking_id, s.tracking_url, s.dispatch_date, s.expected_delivery_date::text AS expected_delivery_date,
  s.delivered_at, cp.name AS courier_name,
  (SELECT count(*)::int FROM order_shipments x WHERE x.order_id = o.id) AS shipment_count,
  sm.shipment_id IS NOT NULL AS in_shared_shipment,
  1 + (SELECT count(*)::int FROM shipment_orders m WHERE m.shipment_id = s.id AND m.detached_at IS NULL) AS orders_in_shipment,
  EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id IN (o.id, s.order_id) AND d.removed_at IS NULL
          AND d.document_type = 'tax_invoice') AS has_invoice,
  (SELECT count(*)::int FROM order_documents d WHERE d.order_id = o.id AND d.removed_at IS NULL) AS document_count,
  (SELECT count(*)::int FROM order_documents d WHERE d.order_id = s.order_id AND d.removed_at IS NULL
          AND d.document_type = 'dispatch_product_image') AS dispatch_image_count`;

/**
 * The list's columns: as ORDER_COLUMNS, minus the raw channel payload (about
 * 1 KB of addresses per Amazon order, only shown in the drawer), plus each
 * order's line SKUs, aggregated in this same query, not one query per order.
 */
const ORDER_LIST_COLUMNS = ORDER_COLUMNS.replace('o.*,', `o.id, o.internal_order_id, o.channel, o.source_order_id, o.order_date, o.customer_name,
  o.customer_phone, o.customer_email, o.order_value, o.currency, o.payment_method, o.payment_status, o.order_status,
  o.fulfillment_type, o.source, o.version, o.created_at, o.updated_at, o.created_by, o.updated_by, o.dispatch_type,
  o.destination_id,`) + `,
  (SELECT json_agg(json_build_object('code', i.sku, 'sku_id', i.sku_id, 'briyo_sku', k.sku, 'quantity', i.quantity) ORDER BY i.id)
     FROM order_items i LEFT JOIN skus k ON k.id = i.sku_id WHERE i.order_id = o.id) AS line_skus`;

const ORDER_FROM = `
  FROM orders o
  JOIN sales_channels c ON c.key = o.channel
  LEFT JOIN dispatch_destinations dd ON dd.id = o.destination_id
  LEFT JOIN shipment_orders sm ON sm.order_id = o.id AND sm.detached_at IS NULL
  LEFT JOIN LATERAL (SELECT * FROM order_shipments x
                     WHERE CASE WHEN sm.shipment_id IS NOT NULL THEN x.id = sm.shipment_id ELSE x.order_id = o.id END
                     ORDER BY x.id LIMIT 1) s ON true
  LEFT JOIN courier_partners cp ON cp.id = s.courier_partner_id`;

const toOrder = (r) => r && ({
  ...r, id: Number(r.id), order_value: r.order_value === null ? null : Number(r.order_value),
  shipment_id: r.shipment_id === null ? null : Number(r.shipment_id),
});

/**
 * WHERE clause for a list. `channel` is left out when counting tabs, so every
 * tab shows what it would contain under the other filters. Date bounds are
 * whole days in the team's timezone, inclusive at both ends.
 */
function orderFilters(f, tz, { withChannel = true, withType = true } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);

  if (f.view && LOGISTICS_VIEWS[f.view]) where.push(LOGISTICS_VIEWS[f.view].where);
  if (withChannel && f.channel) where.push(`o.channel = ${p(f.channel)}`);
  if (withType && f.type === 'none') where.push('o.dispatch_type IS NULL');
  else if (withType && f.type) where.push(`o.dispatch_type = ${p(f.type)}`);
  if (f.destination) where.push(`o.destination_id = ${p(Number(f.destination))}`);
  if (f.q) {
    const like = p(`%${String(f.q).trim()}%`);
    where.push(`(o.internal_order_id ILIKE ${like} OR o.source_order_id ILIKE ${like}
                 OR o.customer_name ILIKE ${like} OR o.customer_phone ILIKE ${like}
                 OR EXISTS (SELECT 1 FROM order_shipments x WHERE x.order_id = o.id AND x.tracking_id ILIKE ${like})
                 OR s.tracking_id ILIKE ${like})`);
  }
  if (f.status) where.push(`o.order_status = ${p(f.status)}`);
  if (f.shipment === 'none') where.push('s.id IS NULL');
  else if (f.shipment) where.push(`s.shipment_status = ${p(f.shipment)}`);
  if (f.courier === 'none') where.push('s.courier_partner_id IS NULL');
  else if (f.courier) where.push(`s.courier_partner_id = ${p(Number(f.courier))}`);
  const invoice = `EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id = o.id
                   AND d.removed_at IS NULL AND d.document_type = 'tax_invoice')`;
  if (f.invoice === 'yes') where.push(invoice);
  if (f.invoice === 'no') where.push(`NOT ${invoice}`);
  if (f.tracking === 'yes') where.push(`coalesce(s.tracking_id, '') <> ''`);
  if (f.tracking === 'no') where.push(`coalesce(s.tracking_id, '') = ''`);
  // An order with no order date is placed by the day it was entered.
  if (day(f.from)) where.push(`coalesce(o.order_date, o.created_at) >= (${p(day(f.from))}::date::timestamp AT TIME ZONE ${p(tz)})`);
  if (day(f.to)) where.push(`coalesce(o.order_date, o.created_at) < ((${p(day(f.to))}::date + 1)::timestamp AT TIME ZONE ${p(tz)})`);

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listOrders(filters, { tz = teamTimezone(), limit = 100, offset = 0 } = {}) {
  await ensureInventorySchema();   // the list shows each line's SKU from the SKU master
  const sql = getPool();
  const main = orderFilters(filters, tz);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const tabs = orderFilters(filters, tz, { withType: false });
  const chans = orderFilters(filters, tz, { withChannel: false });

  const [rows, total, tabCounts, views, chanCounts] = await Promise.all([
    sql.query(`SELECT ${ORDER_LIST_COLUMNS} ${ORDER_FROM} ${main.sql}
               ORDER BY coalesce(o.order_date, o.created_at) DESC, o.id DESC LIMIT ${lim} OFFSET ${off}`, main.params),
    sql.query(`SELECT count(*)::int AS n, coalesce(sum(o.order_value), 0)::numeric AS value,
                      count(*) FILTER (WHERE o.order_value IS NULL)::int AS no_value
               ${ORDER_FROM} ${main.sql}`, main.params),
    sql.query(`SELECT coalesce(o.dispatch_type, 'none') AS t, count(*)::int AS n ${ORDER_FROM} ${tabs.sql} GROUP BY 1`, tabs.params),
    sql.query(`SELECT ${Object.entries(LOGISTICS_VIEWS)
      .map(([k, v]) => `count(*) FILTER (WHERE ${v.where})::int AS ${k}`).join(', ')} ${ORDER_FROM}`),
    sql.query(`SELECT o.channel, count(*)::int AS n ${ORDER_FROM} ${chans.sql} GROUP BY o.channel`, chans.params),
  ]);

  const byType = Object.fromEntries(tabCounts.rows.map((r) => [r.t, r.n]));
  const byChannel = Object.fromEntries(chanCounts.rows.map((r) => [r.channel, r.n]));
  return {
    orders: rows.rows.map(toOrder),
    total: total.rows[0].n,
    totalValue: Number(total.rows[0].value),
    withoutValue: total.rows[0].no_value,
    typeCounts: byType,
    channelCounts: byChannel,
    allCount: Object.values(byType).reduce((a, b) => a + b, 0),
    viewCounts: views.rows[0],
  };
}

export async function getOrder(id) {
  const { rows } = await getPool().query(`SELECT ${ORDER_COLUMNS} ${ORDER_FROM} WHERE o.id = $1`, [id]);
  return toOrder(rows[0]) || null;
}

export async function orderShipments(orderId) {
  const { rows } = await getPool().query(
    `SELECT s.*, s.expected_delivery_date::text AS expected_delivery_date, cp.name AS courier_name,
            cp.tracking_url_template, cp.template_verified_at
     FROM order_shipments s LEFT JOIN courier_partners cp ON cp.id = s.courier_partner_id
     WHERE s.order_id = $1 ORDER BY s.id`, [orderId]);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_id: Number(r.order_id) }));
}

/** Every order travelling in a shipment: its lead order first, then the attached ones. */
export async function shipmentMembers(shipmentId, client = getPool()) {
  const { rows } = await client.query(
    `SELECT o.id, o.source_order_id, o.order_date, o.order_value, o.currency, o.order_status,
            CASE WHEN o.id = s.order_id THEN 'lead' ELSE 'member' END AS role, m.attached_at, m.attached_by
     FROM order_shipments s
     JOIN orders o ON o.id = s.order_id
        OR o.id IN (SELECT order_id FROM shipment_orders WHERE shipment_id = s.id AND detached_at IS NULL)
     LEFT JOIN shipment_orders m ON m.shipment_id = s.id AND m.order_id = o.id AND m.detached_at IS NULL
     WHERE s.id = $1
     ORDER BY (o.id = s.order_id) DESC, m.attached_at, o.id`, [shipmentId]);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_value: r.order_value === null ? null : Number(r.order_value) }));
}

/** The shared shipment this order travels in, if it was attached to one. */
export async function sharedShipmentOf(orderId) {
  const { rows } = await getPool().query(
    `SELECT s.*, s.expected_delivery_date::text AS expected_delivery_date, cp.name AS courier_name,
            cp.tracking_url_template, cp.template_verified_at
     FROM shipment_orders m JOIN order_shipments s ON s.id = m.shipment_id
     LEFT JOIN courier_partners cp ON cp.id = s.courier_partner_id
     WHERE m.order_id = $1 AND m.detached_at IS NULL`, [orderId]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), order_id: Number(rows[0].order_id) } : null;
}

/**
 * Orders that could join a shipment: same channel, dispatch type and
 * destination as its lead order, not in another shared shipment, and not
 * already being shipped on their own (their own shipment is still blank).
 */
export async function attachableOrders(shipmentId, { q = '' } = {}) {
  const { rows } = await getPool().query(
    `SELECT o.id, o.source_order_id, o.order_date, o.order_value, o.currency, o.order_status
     FROM order_shipments s JOIN orders lead ON lead.id = s.order_id
     JOIN orders o ON o.channel = lead.channel AND o.dispatch_type IS NOT DISTINCT FROM lead.dispatch_type
                  AND o.destination_id IS NOT DISTINCT FROM lead.destination_id AND o.id <> lead.id
     WHERE s.id = $1 AND o.order_status NOT IN ('cancelled')
       AND NOT EXISTS (SELECT 1 FROM shipment_orders m WHERE m.order_id = o.id AND m.detached_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM order_shipments x WHERE x.order_id = o.id
                       AND (x.courier_partner_id IS NOT NULL OR coalesce(x.tracking_id, '') <> '' OR x.shipment_status <> 'not_ready'))
       AND ($2 = '' OR o.source_order_id ILIKE '%' || $2 || '%')
     ORDER BY coalesce(o.order_date, o.created_at) DESC LIMIT 50`, [shipmentId, String(q || '').trim()]);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_value: r.order_value === null ? null : Number(r.order_value) }));
}

export async function orderItems(orderId) {
  const { rows } = await getPool().query(
    `SELECT oi.id, oi.source_line_item_id, oi.sku, oi.title, oi.quantity, oi.item_price, oi.item_tax, oi.price_excl_tax,
            oi.promotion_discount, oi.promotion_id, oi.shipping_price, oi.shipping_tax,
            oi.sku_id, oi.asin, oi.amazon_listing_id, oi.amazon_product_id,
            s.sku AS canonical_sku, s.product_name AS canonical_product
     FROM order_items oi LEFT JOIN skus s ON s.id = oi.sku_id WHERE oi.order_id = $1 ORDER BY oi.id`, [orderId]);
  const num = (v) => (v === null ? null : Number(v));
  return rows.map((r) => ({ ...r, id: Number(r.id), item_price: num(r.item_price), item_tax: num(r.item_tax),
    price_excl_tax: num(r.price_excl_tax), promotion_discount: num(r.promotion_discount),
    shipping_price: num(r.shipping_price), shipping_tax: num(r.shipping_tax) }));
}

export async function orderDocuments(orderId) {
  const { rows } = await getPool().query(
    `SELECT id, order_id, document_type, original_filename, mime_type, file_size,
            uploaded_by, uploaded_at, removed_at, removed_by
     FROM order_documents WHERE order_id = $1 ORDER BY uploaded_at DESC, id DESC`, [orderId]);
  return rows.map((r) => ({ ...r, id: Number(r.id), order_id: Number(r.order_id) }));
}

export async function getDocument(orderId, docId) {
  const { rows } = await getPool().query(
    'SELECT * FROM order_documents WHERE order_id = $1 AND id = $2', [orderId, docId]);
  return rows[0] || null;
}

export async function orderEvents(orderId) {
  const { rows } = await getPool().query(
    `SELECT id, event_type, actor, at, metadata FROM order_events
     WHERE order_id = $1 ORDER BY at DESC, id DESC`, [orderId]);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const text = (v, max = 200) => {
  if (v === undefined) return undefined;
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** Optional money: blank means unknown (null), anything else must be a number ≥ 0. */
function parseMoney(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw bad('Order value must be a number, 0 or more.');
  return Math.round(n * 100) / 100;
}

/**
 * A moment in time. Accepts an ISO string with Z or an offset, or a wall-clock
 * "YYYY-MM-DDTHH:mm" which is read in the team's timezone — so the browser's
 * own clock setting never shifts an order date.
 */
function parseTime(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v).trim();
  const zoned = zonedToUtc(s);
  if (zoned) return zoned;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    throw bad(`${label} must be a date and time.`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw bad(`${label} is not a valid date.`);
  return d.toISOString();
}

function parseDay(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad(`${label} must be a date (YYYY-MM-DD).`);
  return String(v);
}

function oneOf(v, allowed, label, { nullable = false } = {}) {
  if (v === undefined) return undefined;
  if ((v === null || v === '') && nullable) return null;
  if (!allowed.includes(v)) throw bad(`${label} must be one of: ${allowed.join(', ')}.`);
  return v;
}

async function channelExists(client, key) {
  const { rows } = await client.query('SELECT 1 FROM sales_channels WHERE key = $1 AND active', [key]);
  return rows.length > 0;
}

export async function logEvent(client, orderId, eventType, actor, metadata = {}) {
  await client.query(
    'INSERT INTO order_events (order_id, event_type, actor, metadata) VALUES ($1, $2, $3, $4)',
    [orderId, eventType, actor, JSON.stringify(metadata)]);
}

export async function inTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const same = (a, b) => {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) || /^\d{4}-\d{2}-\d{2}T/.test(String(b))) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return String(a) === String(b);
};

/** Field-by-field diff of the keys the caller supplied. */
function diff(cur, next, merged) {
  const changes = {};
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) continue;
    if (!same(cur[k], merged[k])) changes[k] = { from: cur[k] ?? null, to: merged[k] ?? null };
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Manual create. Only channel and order number (source_order_id) are required;
 * everything else is filled in when known. The order starts with one empty
 * shipment for logistics. A second order with the same channel + order number
 * is refused and points at the existing one; the same number on another
 * channel is a different order.
 */
/** Validated order fields from a form. Only channel and order number are required. */
function orderInput(input) {
  const channel = String(input.channel || '').trim();
  const sourceOrderId = text(input.source_order_id, 100);
  if (!channel) throw bad('Choose a channel.');
  if (!sourceOrderId) throw bad('Enter the order number.');
  return {
    channel, sourceOrderId,
    orderDate: parseTime(input.order_date, 'Order date') ?? null,
    orderValue: parseMoney(input.order_value) ?? null,
    currency: text(input.currency, 3)?.toUpperCase() || 'INR',
    customerName: text(input.customer_name, 120) ?? null,
    customerPhone: text(input.customer_phone, 20) ?? null,
    customerEmail: text(input.customer_email, 160) ?? null,
    paymentMethod: oneOf(input.payment_method, PAYMENT_METHODS, 'Payment method', { nullable: true }) ?? null,
    paymentStatus: oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }) ?? null,
    fulfillmentType: oneOf(input.fulfillment_type, FULFILLMENT_TYPES, 'Fulfillment type', { nullable: true }) ?? null,
    dispatchType: text(input.dispatch_type, 40) ?? null,
    destinationId: input.destination_id === undefined || input.destination_id === '' ? null : input.destination_id,
    note: String(input.note ?? '').trim().slice(0, 2000),
  };
}

/**
 * Inserts the order row and its first (empty) shipment, logging the creation.
 * Returns null when channel + order number already exist — the caller decides
 * what that means. Never creates a duplicate.
 */
async function insertOrder(client, f, { actor, source }) {
  if (!(await channelExists(client, f.channel))) throw bad('Unknown channel.');
  const route = await resolveRoute(client, f.channel, f.dispatchType, f.destinationId);
  const { rows } = await client.query(
    `INSERT INTO orders (channel, source_order_id, order_date, order_value, currency,
                        customer_name, customer_phone, customer_email,
                        payment_method, payment_status, fulfillment_type, dispatch_type, destination_id,
                        source, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
     ON CONFLICT (channel, source_order_id) DO NOTHING
     RETURNING id`,
    [f.channel, f.sourceOrderId, f.orderDate, f.orderValue, f.currency, f.customerName, f.customerPhone,
      f.customerEmail, f.paymentMethod, f.paymentStatus, f.fulfillmentType, route.dispatchType, route.destinationId,
      source, actor]);
  if (!rows.length) return null;
  const id = Number(rows[0].id);
  const { rows: ship } = await client.query(
    `INSERT INTO order_shipments (order_id, created_by, updated_by) VALUES ($1, $2, $2)
     RETURNING *, expected_delivery_date::text AS expected_delivery_date`, [id, actor]);
  await logEvent(client, id, 'order_created', actor, {
    source, channel: f.channel, source_order_id: f.sourceOrderId, order_value: f.orderValue,
    dispatch_type: route.dispatchType, destination_id: route.destinationId, shipment_id: Number(ship[0].id),
  });
  return { id, shipment: ship[0] };
}

async function existingOrder(client, channel, sourceOrderId) {
  const { rows } = await client.query(
    `SELECT o.id, c.label FROM orders o JOIN sales_channels c ON c.key = o.channel
     WHERE o.channel = $1 AND o.source_order_id = $2 FOR UPDATE OF o`, [channel, sourceOrderId]);
  return rows[0] ? { id: Number(rows[0].id), label: rows[0].label } : null;
}

export async function createOrder(input, { actor, source = 'manual' } = {}) {
  const f = orderInput(input);
  return inTransaction(async (client) => {
    const made = await insertOrder(client, f, { actor, source });
    if (!made) {
      const e = await existingOrder(client, f.channel, f.sourceOrderId);
      throw bad(`${e.label} order ${f.sourceOrderId} already exists.`, 409, { existingId: e.id });
    }
    if (f.note) await logEvent(client, made.id, 'note_added', actor, { note: f.note });
    return made.id;
  });
}

const ORDER_EVENT = { order_status: 'order_status_changed' };
const SHIPMENT_FIELDS = ['shipment_status', 'courier_partner_id', 'tracking_id', 'tracking_url',
  'dispatch_date', 'expected_delivery_date', 'delivered_at'];

/**
 * Edits the commercial record. Shipment fields are refused here — they belong
 * to updateShipment — so an order edit, cancellation included, can never move
 * a parcel's state. `version` must match, so two people cannot silently
 * overwrite each other.
 */
export async function updateOrder(id, input, { actor, version } = {}) {
  const stray = SHIPMENT_FIELDS.filter((k) => input[k] !== undefined);
  if (stray.length) throw bad(`Shipment fields (${stray.join(', ')}) are edited on the shipment, not the order.`);

  const next = {
    channel: input.channel === undefined ? undefined : String(input.channel).trim(),
    source_order_id: input.source_order_id === undefined ? undefined : text(input.source_order_id, 100),
    order_date: parseTime(input.order_date, 'Order date'),
    order_value: parseMoney(input.order_value),
    currency: input.currency === undefined ? undefined : (text(input.currency, 3)?.toUpperCase() || 'INR'),
    customer_name: text(input.customer_name, 120),
    customer_phone: text(input.customer_phone, 20),
    customer_email: text(input.customer_email, 160),
    payment_method: oneOf(input.payment_method, PAYMENT_METHODS, 'Payment method', { nullable: true }),
    payment_status: oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }),
    fulfillment_type: oneOf(input.fulfillment_type, FULFILLMENT_TYPES, 'Fulfillment type', { nullable: true }),
    order_status: oneOf(input.order_status, ORDER_STATUSES, 'Order status'),
    dispatch_type: input.dispatch_type === undefined ? undefined : (text(input.dispatch_type, 40) ?? null),
    destination_id: input.destination_id === undefined ? undefined
      : (input.destination_id === null || input.destination_id === '' ? null : Number(input.destination_id)),
  };
  if (next.channel === '' || next.source_order_id === null) throw bad('Channel and order number cannot be blank.');

  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur) throw bad('No such order.', 404);
    if (Number(version) !== cur.version) {
      throw bad(`${cur.updated_by || 'Someone'} changed this order while you had it open. Reload to see their change.`,
        409, { conflict: true });
    }
    if (next.channel !== undefined && next.channel !== cur.channel && !(await channelExists(client, next.channel))) {
      throw bad('Unknown channel.');
    }
    const merged = { ...cur };
    for (const [k, v] of Object.entries(next)) if (v !== undefined) merged[k] = v;
    // Channel, type and destination are checked together whenever one changes.
    if (['channel', 'dispatch_type', 'destination_id'].some((f) => next[f] !== undefined)) {
      const route = await resolveRoute(client, merged.channel, merged.dispatch_type, merged.destination_id);
      merged.dispatch_type = route.dispatchType;
      merged.destination_id = route.destinationId;
      next.dispatch_type = merged.dispatch_type;
      next.destination_id = merged.destination_id;
    }
    const changes = diff(cur, next, merged);
    if (!Object.keys(changes).length) return { id, changed: false };

    const keys = Object.keys(changes);
    await client.query(
      `UPDATE orders SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
         version = version + 1, updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`,
      [id, ...keys.map((k) => merged[k]), actor]);

    const groups = {};
    for (const [k, v] of Object.entries(changes)) (groups[ORDER_EVENT[k] || 'order_edited'] ||= {})[k] = v;
    for (const [type, fields] of Object.entries(groups)) await logEvent(client, id, type, actor, { changes: fields });
    return { id, changed: true };
  }).catch((err) => {
    if (err.code === '23505') throw bad('Another order already has that channel and order number.', 409);
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

const SHIPMENT_EVENT = {
  shipment_status: 'shipment_status_changed',
  courier_partner_id: 'courier_changed',
  tracking_id: 'tracking_changed',
  tracking_url: 'tracking_changed',
  dispatch_date: 'shipment_dates_changed',
  expected_delivery_date: 'shipment_dates_changed',
  delivered_at: 'shipment_dates_changed',
};

function shipmentInput(input) {
  const next = {
    shipment_status: oneOf(input.shipment_status, SHIPMENT_STATUSES, 'Shipment status'),
    courier_partner_id: input.courier_partner_id === undefined ? undefined
      : (input.courier_partner_id === null || input.courier_partner_id === '' ? null : Number(input.courier_partner_id)),
    tracking_id: text(input.tracking_id, 80),
    tracking_url: text(input.tracking_url, 500),
    dispatch_date: parseTime(input.dispatch_date, 'Dispatch date'),
    expected_delivery_date: parseDay(input.expected_delivery_date, 'Expected delivery'),
    delivered_at: parseTime(input.delivered_at, 'Delivered at'),
  };
  if (next.tracking_url && !/^https?:\/\//i.test(next.tracking_url)) throw bad('Tracking link must start with https://');
  return next;
}

/**
 * Applies shipment edits to a locked row: tracking link, dispatch/delivered
 * stamps, the courier+AWB rule, the version bump and one audit event per kind
 * of change. Shared by editing and by New Shipment, so both obey one rulebook.
 */
async function applyShipmentUpdate(client, orderId, cur, next, input, actor) {
  const merged = { ...cur };
  for (const [k, v] of Object.entries(next)) if (v !== undefined) merged[k] = v;

  // The tracking link follows the courier and AWB unless someone typed one.
  // A generated link belongs to its courier: switching courier drops it
  // rather than point staff at the wrong company's page.
  if (next.tracking_url === undefined
      && (next.courier_partner_id !== undefined || next.tracking_id !== undefined)) {
    let template = null;
    if (merged.courier_partner_id) {
      const c = await client.query('SELECT tracking_url_template FROM courier_partners WHERE id = $1',
        [merged.courier_partner_id]);
      if (!c.rows.length) throw bad('Unknown courier.');
      template = c.rows[0].tracking_url_template;
    }
    const courierChanged = merged.courier_partner_id !== cur.courier_partner_id;
    merged.tracking_url = template ? trackingUrlFor(template, merged.tracking_id)
      : (merged.tracking_id && !courierChanged ? cur.tracking_url : null);
    next.tracking_url = merged.tracking_url;
  }

  if (SHIPPED.has(merged.shipment_status) && merged.shipment_status !== cur.shipment_status
      && (!merged.courier_partner_id || !merged.tracking_id)) {
    throw bad('Choose a courier and enter the AWB before marking it dispatched or later.');
  }
  // Dispatch proof: at least one package/product photo before a parcel is
  // recorded as having left. Checked when it first leaves (not between later
  // stages), inside the same transaction as the change.
  if (SHIPPED.has(merged.shipment_status) && !SHIPPED.has(cur.shipment_status)) {
    const { rows: ph } = await client.query(
      `SELECT count(*)::int AS n FROM order_documents
       WHERE order_id = $1 AND removed_at IS NULL AND document_type = 'dispatch_product_image'`, [orderId]);
    if (!ph[0].n) {
      throw bad('Add at least one dispatch product photo before marking it dispatched.', 400, { needsPhoto: true });
    }
    // Stock leaves with the parcel: the reserved batches are deducted here, in
    // this transaction, or the status change does not happen at all.
    await dispatchShipmentStock(client, cur.id, { actor });
  }
  // Once stock has left it cannot be "un-dispatched"; a return brings it back.
  if (!SHIPPED.has(merged.shipment_status) && SHIPPED.has(cur.shipment_status)
      && await shipmentHasDispatchedStock(client, cur.id)) {
    throw bad('Stock was already deducted when this shipment was dispatched, so it cannot go back to an earlier status. Mark it RTO and record the return in Inventory.', 409, { stockDispatched: true });
  }
  if (merged.shipment_status === 'cancelled' && cur.shipment_status !== 'cancelled') {
    await releaseShipmentStock(cur.id, { actor, reason: 'shipment cancelled' }, client);
  }
  if (merged.shipment_status !== cur.shipment_status) {
    if (SHIPPED.has(merged.shipment_status) && !merged.dispatch_date) {
      merged.dispatch_date = new Date().toISOString();
      next.dispatch_date = merged.dispatch_date;
    }
    if (merged.shipment_status === 'delivered' && input.delivered_at === undefined && !cur.delivered_at) {
      merged.delivered_at = new Date().toISOString();
      next.delivered_at = merged.delivered_at;
    }
    // Moving off Delivered (a correction) clears the stamp; the log keeps it.
    if (cur.shipment_status === 'delivered' && input.delivered_at === undefined) {
      merged.delivered_at = null;
      next.delivered_at = null;
    }
  }

  const changes = diff(cur, next, merged);
  if (!Object.keys(changes).length) return { changed: false };

  const keys = Object.keys(changes);
  await client.query(
    `UPDATE order_shipments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
       version = version + 1, updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`,
    [cur.id, ...keys.map((k) => merged[k]), actor]);
  await client.query('UPDATE orders SET updated_at = now(), updated_by = $2 WHERE id = $1', [orderId, actor]);

  const groups = {};
  for (const [k, v] of Object.entries(changes)) (groups[SHIPMENT_EVENT[k]] ||= {})[k] = v;
  for (const [type, fields] of Object.entries(groups)) {
    await logEvent(client, orderId, type, actor, { shipment_id: Number(cur.id), changes: fields });
  }
  return { changed: true };
}

/** Edits one shipment of an order, guarded by the shipment's own version. */
export async function updateShipment(orderId, shipmentId, input, { actor, version } = {}) {
  const next = shipmentInput(input);
  await ensureInventorySchema();
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT *, expected_delivery_date::text AS expected_delivery_date FROM order_shipments
       WHERE id = $1 AND order_id = $2 FOR UPDATE`, [shipmentId, orderId]);
    const cur = rows[0];
    if (!cur) throw bad('No such shipment.', 404);
    if (Number(version) !== cur.version) {
      throw bad(`${cur.updated_by || 'Someone'} changed this shipment while you had it open. Reload to see their change.`,
        409, { conflict: true });
    }
    return applyShipmentUpdate(client, orderId, cur, next, input, actor);
  });
}

/**
 * Puts an existing order inside a shipment led by another order. Refuses
 * anything that would make one parcel two or one order two parcels: a
 * different channel, dispatch type or destination; an order already in a
 * shared shipment; an order already shipping on its own. Logged on both
 * orders. Runs inside the caller's transaction.
 */
async function attachOrderTx(client, shipmentId, orderId, actor) {
  const { rows: sh } = await client.query(
    `SELECT s.id, s.order_id, s.tracking_id, s.shipment_status, l.channel, l.dispatch_type, l.destination_id, l.source_order_id
     FROM order_shipments s JOIN orders l ON l.id = s.order_id WHERE s.id = $1 FOR UPDATE OF s`, [shipmentId]);
  const ship = sh[0];
  if (!ship) throw bad('No such shipment.', 404);
  // Stock for a parcel is deducted when it leaves; an order with items cannot join afterwards.
  if (SHIPPED.has(ship.shipment_status) && await orderHasItems(client, orderId)) {
    throw bad('This shipment has already been dispatched, so an order with items cannot be added to it. Create a new shipment.', 409, { alreadyShipped: true });
  }
  const { rows } = await client.query(
    'SELECT id, channel, dispatch_type, destination_id, source_order_id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const o = rows[0];
  if (!o) throw bad('No such order.', 404);
  if (Number(o.id) === Number(ship.order_id)) throw bad(`Order ${o.source_order_id} is already this shipment's main order.`);
  if (o.channel !== ship.channel) throw bad(`Order ${o.source_order_id} is from another channel; only orders from the same channel can share a shipment.`);
  if (o.dispatch_type !== ship.dispatch_type || (o.destination_id ?? null) !== (ship.destination_id ?? null)) {
    throw bad(`Order ${o.source_order_id} has a different dispatch type or destination from this shipment.`);
  }
  const { rows: other } = await client.query(
    `SELECT s.tracking_id FROM shipment_orders m JOIN order_shipments s ON s.id = m.shipment_id
     WHERE m.order_id = $1 AND m.detached_at IS NULL`, [orderId]);
  if (other.length) {
    throw bad(`Order ${o.source_order_id} is already in shipment ${other[0].tracking_id || 'without an AWB'}.`, 409, { alreadyShipped: true });
  }
  const { rows: own } = await client.query(
    `SELECT tracking_id, shipment_status FROM order_shipments WHERE order_id = $1
     AND (courier_partner_id IS NOT NULL OR coalesce(tracking_id, '') <> '' OR shipment_status <> 'not_ready') LIMIT 1`, [orderId]);
  if (own.length) {
    throw bad(`Order ${o.source_order_id} already has its own shipment${own[0].tracking_id ? ` (AWB ${own[0].tracking_id})` : ''}.`, 409, { alreadyShipped: true });
  }
  try {
    await client.query('INSERT INTO shipment_orders (shipment_id, order_id, attached_by) VALUES ($1, $2, $3)', [shipmentId, orderId, actor]);
  } catch (err) {
    if (err.code === '23505') throw bad(`Order ${o.source_order_id} was just added to another shipment.`, 409, { alreadyShipped: true });
    throw err;
  }
  await logEvent(client, ship.order_id, 'shipment_order_attached', actor,
    { shipment_id: Number(shipmentId), order_id: Number(orderId), source_order_id: o.source_order_id });
  await logEvent(client, orderId, 'attached_to_shipment', actor,
    { shipment_id: Number(shipmentId), lead_order_id: Number(ship.order_id), lead_source_order_id: ship.source_order_id, tracking_id: ship.tracking_id });
  await client.query('UPDATE orders SET updated_at = now(), updated_by = $2 WHERE id = ANY($1)', [[ship.order_id, orderId], actor]);
}

/**
 * Adds orders to a shipment: existing ones by id, and/or new ones created here
 * (same channel, type and destination as the lead order, no shipment of their
 * own needed). All or nothing.
 */
export async function attachToShipment(shipmentId, { orderIds = [], newOrders = [] } = {}, { actor } = {}) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT l.channel, l.dispatch_type, l.destination_id FROM order_shipments s JOIN orders l ON l.id = s.order_id WHERE s.id = $1`, [shipmentId]);
    if (!rows[0]) throw bad('No such shipment.', 404);
    const attached = [];
    for (const n of newOrders) {
      const f = orderInput({ ...n, channel: rows[0].channel, dispatch_type: rows[0].dispatch_type, destination_id: rows[0].destination_id });
      const made = await insertOrder(client, f, { actor, source: 'manual' });
      const id = made ? made.id : (await existingOrder(client, f.channel, f.sourceOrderId)).id;
      await attachOrderTx(client, shipmentId, id, actor);
      attached.push(id);
    }
    for (const id of [...new Set(orderIds.map(Number))]) {
      await attachOrderTx(client, shipmentId, id, actor);
      attached.push(id);
    }
    return { attached };
  });
}

/** Takes an order back out of a shared shipment. The link is kept as history. */
export async function detachFromShipment(shipmentId, orderId, { actor } = {}) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE shipment_orders m SET detached_at = now(), detached_by = $3
       WHERE m.shipment_id = $1 AND m.order_id = $2 AND m.detached_at IS NULL
       RETURNING (SELECT order_id FROM order_shipments WHERE id = m.shipment_id) AS lead_id,
                 (SELECT source_order_id FROM orders WHERE id = m.order_id) AS source_order_id`, [shipmentId, orderId, actor]);
    if (!rows.length) throw bad('That order is not in this shipment.', 404);
    await logEvent(client, rows[0].lead_id, 'shipment_order_detached', actor,
      { shipment_id: Number(shipmentId), order_id: Number(orderId), source_order_id: rows[0].source_order_id });
    await logEvent(client, orderId, 'detached_from_shipment', actor, { shipment_id: Number(shipmentId) });
  });
}

/**
 * New Shipment — the logistics team's one action. Channel, order number,
 * courier and AWB are required.
 *
 * - No order with that channel + number: creates the order and its shipment.
 * - Order exists and `addToExisting` is not set: refuses with the existing
 *   order's shipments, so the screen can offer to add to it instead.
 * - Order exists and `addToExisting` is set: refuses an AWB the order already
 *   has; otherwise fills the order's untouched first shipment if there is one,
 *   or adds a new shipment.
 *
 * Status defaults to Packed: an AWB means the parcel is ready, not that it has
 * left. Dispatch is always an explicit choice. Everything happens in one
 * transaction, with the order row locked, so two people entering the same
 * order at once cannot both create it or both add the same AWB.
 */
export async function createShipment(input, { actor, source = 'manual', addToExisting = false } = {}) {
  await ensureInventorySchema();
  const f = orderInput(input);
  const next = shipmentInput(input);
  if (!next.courier_partner_id) throw bad('Choose the courier partner.');
  if (!next.tracking_id) throw bad('Enter the tracking ID / AWB.');
  if (next.shipment_status === undefined) next.shipment_status = 'packed';

  return inTransaction(async (client) => {
    const courier = await client.query('SELECT 1 FROM courier_partners WHERE id = $1', [next.courier_partner_id]);
    if (!courier.rows.length) throw bad('Unknown courier.');

    let orderId;
    let shipment = null;
    const made = await insertOrder(client, f, { actor, source });
    if (made) {
      orderId = made.id;
      shipment = made.shipment;
    } else {
      const e = await existingOrder(client, f.channel, f.sourceOrderId);
      orderId = e.id;
      const { rows: ships } = await client.query(
        `SELECT s.*, s.expected_delivery_date::text AS expected_delivery_date, cp.name AS courier_name
         FROM order_shipments s LEFT JOIN courier_partners cp ON cp.id = s.courier_partner_id
         WHERE s.order_id = $1 ORDER BY s.id FOR UPDATE OF s`, [orderId]);
      const awb = next.tracking_id.trim().toLowerCase();
      if (ships.some((x) => (x.tracking_id || '').trim().toLowerCase() === awb)) {
        throw bad(`${e.label} order ${f.sourceOrderId} already has a shipment with AWB ${next.tracking_id}.`, 409,
          { existingId: orderId, duplicateAwb: true });
      }
      const blank = ships.find((x) => !x.courier_partner_id && !(x.tracking_id || '').trim()
        && x.shipment_status === 'not_ready');
      if (!addToExisting) {
        throw bad(`${e.label} order ${f.sourceOrderId} already exists.`, 409, {
          existingId: orderId,
          orderExists: true,
          canFillShipment: Boolean(blank),
          shipments: ships.filter((x) => x !== blank).map((x) => ({
            courier: x.courier_name, awb: x.tracking_id, status: x.shipment_status,
          })),
        });
      }
      if (blank) {
        shipment = blank;
      } else {
        const { rows } = await client.query(
          `INSERT INTO order_shipments (order_id, created_by, updated_by) VALUES ($1, $2, $2)
           RETURNING *, expected_delivery_date::text AS expected_delivery_date`, [orderId, actor]);
        shipment = rows[0];
        await logEvent(client, orderId, 'shipment_added', actor, { shipment_id: Number(shipment.id) });
      }
    }

    await applyShipmentUpdate(client, orderId, shipment, next, input, actor);
    if (f.note) await logEvent(client, orderId, 'note_added', actor, { note: f.note });
    // More orders in the same parcel (e.g. several Amazon orders under one AWB):
    // new ones are created with the lead's channel, type and destination.
    const lead = await client.query('SELECT channel, dispatch_type, destination_id FROM orders WHERE id = $1', [orderId]);
    for (const n of Array.isArray(input.extra_orders) ? input.extra_orders : []) {
      const ef = orderInput({ ...n, channel: lead.rows[0].channel, dispatch_type: lead.rows[0].dispatch_type, destination_id: lead.rows[0].destination_id });
      // A number that already exists means that order: it is attached, not duplicated.
      const extra = await insertOrder(client, ef, { actor, source });
      const extraId = extra ? extra.id : (await existingOrder(client, ef.channel, ef.sourceOrderId)).id;
      await attachOrderTx(client, shipment.id, extraId, actor);
    }
    for (const id of [...new Set((Array.isArray(input.attach_order_ids) ? input.attach_order_ids : []).map(Number))]) {
      await attachOrderTx(client, shipment.id, id, actor);
    }
    return { orderId, shipmentId: Number(shipment.id), createdOrder: Boolean(made) };
  });
}

/**
 * One new shipment for orders that have none yet — typically several Amazon
 * orders packed into one parcel. The first order is the shipment's main order;
 * the rest are attached to it. Same channel, dispatch type and destination
 * throughout, and all or nothing.
 */
export async function createShipmentForOrders(orderIds, input, { actor } = {}) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw bad('Choose at least one order.');
  if (ids.length > 50) throw bad('Up to 50 orders can go in one shipment.');
  const next = shipmentInput(input);
  if (!next.courier_partner_id) throw bad('Choose the courier partner.');
  if (!next.tracking_id) throw bad('Enter the tracking ID / AWB.');
  if (next.shipment_status === undefined) next.shipment_status = 'packed';
  await ensureInventorySchema();

  return inTransaction(async (client) => {
    const courier = await client.query('SELECT 1 FROM courier_partners WHERE id = $1', [next.courier_partner_id]);
    if (!courier.rows.length) throw bad('Unknown courier.');
    // Stock is confirmed against the whole parcel, so it is dispatched after it is created.
    if (SHIPPED.has(next.shipment_status)) {
      for (const id of ids) {
        if (await orderHasItems(client, id)) throw bad('Create the shipment first, confirm its stock batches, then mark it dispatched.', 400, { needsStock: true });
      }
    }
    const [leadId, ...rest] = ids;
    const { rows: lr } = await client.query('SELECT id, source_order_id, order_status FROM orders WHERE id = $1 FOR UPDATE', [leadId]);
    const lead = lr[0];
    if (!lead) throw bad('No such order.', 404);
    if (lead.order_status === 'cancelled') throw bad(`Order ${lead.source_order_id} is cancelled.`);
    const { rows: shared } = await client.query(
      'SELECT 1 FROM shipment_orders WHERE order_id = $1 AND detached_at IS NULL', [leadId]);
    const { rows: own } = await client.query(
      `SELECT *, expected_delivery_date::text AS expected_delivery_date FROM order_shipments
       WHERE order_id = $1 ORDER BY id FOR UPDATE`, [leadId]);
    const blank = own.find((x) => !x.courier_partner_id && !(x.tracking_id || '').trim() && x.shipment_status === 'not_ready');
    if (shared.length || own.some((x) => x !== blank)) {
      throw bad(`Order ${lead.source_order_id} already has a shipment.`, 409, { alreadyShipped: true });
    }
    let shipment = blank;
    if (!shipment) {
      const { rows } = await client.query(
        `INSERT INTO order_shipments (order_id, created_by, updated_by) VALUES ($1, $2, $2)
         RETURNING *, expected_delivery_date::text AS expected_delivery_date`, [leadId, actor]);
      shipment = rows[0];
      await logEvent(client, leadId, 'shipment_created', actor, { shipment_id: Number(shipment.id), orders: ids.length });
    }
    await applyShipmentUpdate(client, leadId, shipment, next, input, actor);
    for (const id of rest) {
      const { rows } = await client.query('SELECT source_order_id, order_status FROM orders WHERE id = $1', [id]);
      if (rows[0]?.order_status === 'cancelled') throw bad(`Order ${rows[0].source_order_id} is cancelled.`);
      await attachOrderTx(client, shipment.id, id, actor);
    }
    return { orderId: leadId, shipmentId: Number(shipment.id) };
  });
}

// ---------------------------------------------------------------------------
// Notes and documents
// ---------------------------------------------------------------------------

export async function addOrderNote(orderId, note, { actor }) {
  const body = String(note ?? '').trim().slice(0, 2000);
  if (!body) throw bad('Write a note first.');
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
    if (!rows.length) throw bad('No such order.', 404);
    await logEvent(client, orderId, 'note_added', actor, { note: body });
  });
}

/** Records the metadata for a file already written to storage. */
export async function addDocument(orderId, doc, { actor }) {
  if (!DOCUMENT_TYPES.includes(doc.document_type)) throw bad('Choose what kind of document this is.');
  return inTransaction(async (client) => {
    const { rows: o } = await client.query('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o.length) throw bad('No such order.', 404);
    const { rows } = await client.query(
      `INSERT INTO order_documents (order_id, document_type, original_filename, storage_path, mime_type, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [orderId, doc.document_type, doc.original_filename.slice(0, 200), doc.storage_path, doc.mime_type, doc.file_size, actor]);
    const docId = Number(rows[0].id);
    await client.query('UPDATE orders SET updated_at = now(), updated_by = $2 WHERE id = $1', [orderId, actor]);
    await logEvent(client, orderId, 'document_uploaded', actor, {
      document_id: docId, document_type: doc.document_type,
      filename: doc.original_filename, file_size: doc.file_size,
    });
    return docId;
  });
}

/** Removal hides a document; the row and the stored object are kept for the record. */
export async function removeDocument(orderId, docId, { actor }) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE order_documents SET removed_at = now(), removed_by = $3
       WHERE order_id = $1 AND id = $2 AND removed_at IS NULL
       RETURNING document_type, original_filename`, [orderId, docId, actor]);
    if (!rows.length) throw bad('No such document, or it was already removed.', 404);
    await logEvent(client, orderId, 'document_removed', actor, {
      document_id: Number(docId), document_type: rows[0].document_type, filename: rows[0].original_filename,
    });
  });
}

/**
 * Test-only: removes orders whose source order ID starts with `prefix`, with
 * their shipments, documents and history. The append-only trigger is lifted
 * for this one transaction and nothing else. Sequences are not touched.
 */
export async function purgeTestOrders(prefix) {
  if (!prefix || prefix.length < 8) throw new Error('Refusing to purge without a specific test prefix.');
  return inTransaction(async (client) => {
    // Checked inside this transaction, before the audit-log lock is lifted.
    await assertMarkerIn(client, ['test', 'development'], 'Test order purge');
    await client.query(`SET LOCAL app.purge_orders = 'on'`);
    const { rows } = await client.query('SELECT id FROM orders WHERE source_order_id LIKE $1', [`${prefix}%`]);
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { orders: 0, paths: [] };
    const docs = await client.query('DELETE FROM order_documents WHERE order_id = ANY($1) RETURNING storage_path', [ids]);
    await client.query('DELETE FROM order_events WHERE order_id = ANY($1)', [ids]);
    await client.query('DELETE FROM order_items WHERE order_id = ANY($1)', [ids]);
    // Import records written by the test suite (imported_by is its actor name).
    await client.query(`DELETE FROM order_imports WHERE imported_by LIKE $1`, [`${prefix}%`]);
    // Inventory written against these test orders and their shipments.
    if ((await client.query(`SELECT to_regclass('inventory_movements') AS t`)).rows[0].t) {
      await client.query(`SET LOCAL app.purge_inventory = 'on'`);
      const ships = `SELECT id FROM order_shipments WHERE order_id = ANY($1)`;
      await client.query(`DELETE FROM inventory_audit WHERE shipment_id IN (${ships})`, [ids]);
      await client.query(`DELETE FROM inventory_reservations WHERE shipment_id IN (${ships})`, [ids]);
      await client.query(`DELETE FROM inventory_movements WHERE order_id = ANY($1) OR shipment_id IN (${ships})`, [ids]);
    }
    await client.query(`DELETE FROM shipment_orders WHERE order_id = ANY($1)
                        OR shipment_id IN (SELECT id FROM order_shipments WHERE order_id = ANY($1))`, [ids]);
    await client.query('DELETE FROM order_shipments WHERE order_id = ANY($1)', [ids]);
    await client.query('DELETE FROM orders WHERE id = ANY($1)', [ids]);
    return { orders: ids.length, paths: docs.rows.map((r) => r.storage_path) };
  });
}
