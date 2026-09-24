import { getPool, ensureSchema } from './db.js';

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
export const DOCUMENT_TYPES = ['tax_invoice', 'courier_receipt', 'marketplace_invoice', 'credit_note', 'other'];

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
    where: `o.order_status IN ('new','confirmed') AND s.shipment_status IN ('not_ready','packed')`,
  },
  in_transit: { label: 'In transit', where: `s.shipment_status IN ('dispatched','in_transit','out_for_delivery')` },
  delivered: { label: 'Delivered', where: `s.shipment_status = 'delivered'` },
  failed: { label: 'Failed / RTO', where: `s.shipment_status IN ('delivery_failed','rto')` },
};

const SEED_CHANNELS = [
  ['website', 'Website', 10], ['amazon', 'Amazon', 20], ['blinkit', 'Blinkit', 30],
  ['instamart', 'Instamart', 40], ['zepto', 'Zepto', 50],
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
      for (const [key, label, sort] of SEED_CHANNELS) {
        await sql.query(`INSERT INTO sales_channels (key, label, sort) VALUES ($1, $2, $3)
                         ON CONFLICT (key) DO NOTHING`, [key, label, sort]);
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
          order_date        TIMESTAMPTZ NOT NULL,
          customer_name     TEXT,
          customer_phone    TEXT,
          customer_email    TEXT,
          order_value       NUMERIC(12,2) NOT NULL CHECK (order_value >= 0),
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
      await sql.query('CREATE INDEX IF NOT EXISTS orders_date_idx ON orders (order_date DESC)');

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
    'SELECT key, label, active FROM sales_channels ORDER BY sort, key');
  return rows;
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
  o.*, c.label AS channel_label,
  s.id AS shipment_id, s.version AS shipment_version, s.shipment_status, s.courier_partner_id,
  s.tracking_id, s.tracking_url, s.dispatch_date, s.expected_delivery_date::text AS expected_delivery_date,
  s.delivered_at, cp.name AS courier_name,
  (SELECT count(*)::int FROM order_shipments x WHERE x.order_id = o.id) AS shipment_count,
  EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id = o.id AND d.removed_at IS NULL
          AND d.document_type = 'tax_invoice') AS has_invoice,
  (SELECT count(*)::int FROM order_documents d WHERE d.order_id = o.id AND d.removed_at IS NULL) AS document_count`;

const ORDER_FROM = `
  FROM orders o
  JOIN sales_channels c ON c.key = o.channel
  LEFT JOIN LATERAL (SELECT * FROM order_shipments x WHERE x.order_id = o.id ORDER BY x.id LIMIT 1) s ON true
  LEFT JOIN courier_partners cp ON cp.id = s.courier_partner_id`;

const toOrder = (r) => r && ({
  ...r, id: Number(r.id), order_value: Number(r.order_value),
  shipment_id: r.shipment_id === null ? null : Number(r.shipment_id),
});

/**
 * WHERE clause for a list. `channel` is left out when counting tabs, so every
 * tab shows what it would contain under the other filters. Date bounds are
 * whole days in the team's timezone, inclusive at both ends.
 */
function orderFilters(f, tz, { withChannel = true } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);

  if (f.view && LOGISTICS_VIEWS[f.view]) where.push(LOGISTICS_VIEWS[f.view].where);
  if (withChannel && f.channel) where.push(`o.channel = ${p(f.channel)}`);
  if (f.q) {
    const like = p(`%${String(f.q).trim()}%`);
    where.push(`(o.internal_order_id ILIKE ${like} OR o.source_order_id ILIKE ${like}
                 OR o.customer_name ILIKE ${like} OR o.customer_phone ILIKE ${like}
                 OR EXISTS (SELECT 1 FROM order_shipments x WHERE x.order_id = o.id AND x.tracking_id ILIKE ${like}))`);
  }
  if (f.status) where.push(`o.order_status = ${p(f.status)}`);
  if (f.shipment) where.push(`s.shipment_status = ${p(f.shipment)}`);
  if (f.courier === 'none') where.push('s.courier_partner_id IS NULL');
  else if (f.courier) where.push(`s.courier_partner_id = ${p(Number(f.courier))}`);
  const invoice = `EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id = o.id
                   AND d.removed_at IS NULL AND d.document_type = 'tax_invoice')`;
  if (f.invoice === 'yes') where.push(invoice);
  if (f.invoice === 'no') where.push(`NOT ${invoice}`);
  if (f.tracking === 'yes') where.push(`coalesce(s.tracking_id, '') <> ''`);
  if (f.tracking === 'no') where.push(`coalesce(s.tracking_id, '') = ''`);
  if (day(f.from)) where.push(`o.order_date >= (${p(day(f.from))}::date::timestamp AT TIME ZONE ${p(tz)})`);
  if (day(f.to)) where.push(`o.order_date < ((${p(day(f.to))}::date + 1)::timestamp AT TIME ZONE ${p(tz)})`);

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listOrders(filters, { tz = teamTimezone(), limit = 100, offset = 0 } = {}) {
  const sql = getPool();
  const main = orderFilters(filters, tz);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const tabs = orderFilters(filters, tz, { withChannel: false });

  const [rows, total, tabCounts, views] = await Promise.all([
    sql.query(`SELECT ${ORDER_COLUMNS} ${ORDER_FROM} ${main.sql}
               ORDER BY o.order_date DESC, o.id DESC LIMIT ${lim} OFFSET ${off}`, main.params),
    sql.query(`SELECT count(*)::int AS n, coalesce(sum(o.order_value), 0)::numeric AS value
               ${ORDER_FROM} ${main.sql}`, main.params),
    sql.query(`SELECT o.channel, count(*)::int AS n ${ORDER_FROM} ${tabs.sql} GROUP BY o.channel`, tabs.params),
    sql.query(`SELECT ${Object.entries(LOGISTICS_VIEWS)
      .map(([k, v]) => `count(*) FILTER (WHERE ${v.where})::int AS ${k}`).join(', ')} ${ORDER_FROM}`),
  ]);

  const byChannel = Object.fromEntries(tabCounts.rows.map((r) => [r.channel, r.n]));
  return {
    orders: rows.rows.map(toOrder),
    total: total.rows[0].n,
    totalValue: Number(total.rows[0].value),
    channelCounts: byChannel,
    allCount: Object.values(byChannel).reduce((a, b) => a + b, 0),
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

function parseMoney(v) {
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || String(v ?? '').trim() === '') throw bad('Enter the order value as a number, 0 or more.');
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

async function logEvent(client, orderId, eventType, actor, metadata = {}) {
  await client.query(
    'INSERT INTO order_events (order_id, event_type, actor, metadata) VALUES ($1, $2, $3, $4)',
    [orderId, eventType, actor, JSON.stringify(metadata)]);
}

async function inTransaction(fn) {
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
 * Manual create. Only channel, source order ID, date and value are required.
 * The order starts with one empty shipment, filled in later by logistics. A
 * second order with the same channel + source order ID is refused and points
 * at the existing one.
 */
export async function createOrder(input, { actor, source = 'manual' } = {}) {
  const channel = String(input.channel || '').trim();
  const sourceOrderId = text(input.source_order_id, 100);
  if (!channel) throw bad('Choose a channel.');
  if (!sourceOrderId) throw bad('Enter the source order ID.');
  const orderDate = parseTime(input.order_date, 'Order date');
  if (!orderDate) throw bad('Enter the order date.');
  const orderValue = parseMoney(input.order_value);

  return inTransaction(async (client) => {
    if (!(await channelExists(client, channel))) throw bad('Unknown channel.');
    const { rows } = await client.query(
      `INSERT INTO orders (channel, source_order_id, order_date, order_value, currency,
                          customer_name, customer_phone, customer_email,
                          payment_method, payment_status, fulfillment_type, source, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       ON CONFLICT (channel, source_order_id) DO NOTHING
       RETURNING id`,
      [channel, sourceOrderId, orderDate, orderValue, text(input.currency, 3)?.toUpperCase() || 'INR',
        text(input.customer_name, 120) ?? null, text(input.customer_phone, 20) ?? null,
        text(input.customer_email, 160) ?? null,
        oneOf(input.payment_method, PAYMENT_METHODS, 'Payment method', { nullable: true }) ?? null,
        oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }) ?? null,
        oneOf(input.fulfillment_type, FULFILLMENT_TYPES, 'Fulfillment type', { nullable: true }) ?? null,
        source, actor]);
    if (!rows.length) {
      const existing = await client.query(
        `SELECT o.id, o.internal_order_id, c.label FROM orders o JOIN sales_channels c ON c.key = o.channel
         WHERE o.channel = $1 AND o.source_order_id = $2`, [channel, sourceOrderId]);
      const e = existing.rows[0];
      throw bad(`${e.label} order ${sourceOrderId} already exists as ${e.internal_order_id}.`, 409,
        { existingId: Number(e.id) });
    }
    const id = Number(rows[0].id);
    const { rows: ship } = await client.query(
      `INSERT INTO order_shipments (order_id, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [id, actor]);
    await logEvent(client, id, 'order_created', actor, {
      source, channel, source_order_id: sourceOrderId, order_value: orderValue, shipment_id: Number(ship[0].id),
    });
    return id;
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
    order_value: input.order_value === undefined ? undefined : parseMoney(input.order_value),
    currency: input.currency === undefined ? undefined : (text(input.currency, 3)?.toUpperCase() || 'INR'),
    customer_name: text(input.customer_name, 120),
    customer_phone: text(input.customer_phone, 20),
    customer_email: text(input.customer_email, 160),
    payment_method: oneOf(input.payment_method, PAYMENT_METHODS, 'Payment method', { nullable: true }),
    payment_status: oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }),
    fulfillment_type: oneOf(input.fulfillment_type, FULFILLMENT_TYPES, 'Fulfillment type', { nullable: true }),
    order_status: oneOf(input.order_status, ORDER_STATUSES, 'Order status'),
  };
  if (next.channel === '' || next.source_order_id === null) throw bad('Channel and source order ID cannot be blank.');
  if (next.order_date === null) throw bad('Order date cannot be blank.');

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
    if (err.code === '23505') throw bad('Another order already has that channel and source order ID.', 409);
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

/** Edits one shipment of an order, guarded by the shipment's own version. */
export async function updateShipment(orderId, shipmentId, input, { actor, version } = {}) {
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
      [shipmentId, ...keys.map((k) => merged[k]), actor]);
    await client.query('UPDATE orders SET updated_at = now(), updated_by = $2 WHERE id = $1', [orderId, actor]);

    const groups = {};
    for (const [k, v] of Object.entries(changes)) (groups[SHIPMENT_EVENT[k]] ||= {})[k] = v;
    for (const [type, fields] of Object.entries(groups)) {
      await logEvent(client, orderId, type, actor, { shipment_id: Number(shipmentId), changes: fields });
    }
    return { changed: true };
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
    await client.query(`SET LOCAL app.purge_orders = 'on'`);
    const { rows } = await client.query('SELECT id FROM orders WHERE source_order_id LIKE $1', [`${prefix}%`]);
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { orders: 0, paths: [] };
    const docs = await client.query('DELETE FROM order_documents WHERE order_id = ANY($1) RETURNING storage_path', [ids]);
    await client.query('DELETE FROM order_events WHERE order_id = ANY($1)', [ids]);
    await client.query('DELETE FROM order_shipments WHERE order_id = ANY($1)', [ids]);
    await client.query('DELETE FROM orders WHERE id = ANY($1)', [ids]);
    return { orders: ids.length, paths: docs.rows.map((r) => r.storage_path) };
  });
}
