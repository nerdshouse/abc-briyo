import { getPool, ensureSchema } from './db.js';

/**
 * Orders & Logistics — one normalized order model for every sales channel.
 *
 * Channels and couriers are rows, not code: adding a marketplace or a courier
 * is an INSERT. Nothing below branches on a channel name.
 *
 * Operational history is never overwritten. Every change to an order writes an
 * order_events row in the same transaction, and a trigger rejects UPDATE and
 * DELETE on that table.
 */

export const ORDER_STATUSES = ['new', 'confirmed', 'cancelled', 'completed'];
export const SHIPMENT_STATUSES = [
  'not_ready', 'packed', 'dispatched', 'in_transit', 'out_for_delivery',
  'delivered', 'delivery_failed', 'rto', 'cancelled',
];
export const PAYMENT_STATUSES = ['pending', 'paid', 'cod', 'refunded', 'failed'];
export const DOCUMENT_TYPES = ['tax_invoice', 'courier_receipt', 'marketplace_invoice', 'credit_note', 'other'];

// Shipment states that mean a parcel has left with a courier. Reaching any of
// them needs a courier and an AWB, so the record is never "in transit" to nowhere.
const SHIPPED = new Set(['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_failed', 'rto']);

/** Logistics queues are fixed slices of shipment status, defined once here. */
export const LOGISTICS_VIEWS = {
  pending_dispatch: {
    label: 'Pending dispatch',
    where: `o.order_status IN ('new','confirmed') AND o.shipment_status IN ('not_ready','packed')`,
  },
  in_transit: { label: 'In transit', where: `o.shipment_status IN ('dispatched','in_transit','out_for_delivery')` },
  delivered: { label: 'Delivered', where: `o.shipment_status = 'delivered'` },
  failed: { label: 'Failed / RTO', where: `o.shipment_status IN ('delivery_failed','rto')` },
};

const SEED_CHANNELS = [
  ['website', 'Website', 10], ['amazon', 'Amazon', 20], ['blinkit', 'Blinkit', 30],
  ['instamart', 'Instamart', 40], ['zepto', 'Zepto', 50],
];

// Public tracking pages as of writing. Unverified against live AWBs — an admin
// can correct any of them on the Courier partners page. NULL means the courier
// has no per-AWB link, so staff paste one by hand if they have it.
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
      for (const [name, template, sort] of SEED_COURIERS) {
        await sql.query(`INSERT INTO courier_partners (name, tracking_url_template, sort) VALUES ($1, $2, $3)
                         ON CONFLICT (name) DO NOTHING`, [name, template, sort]);
      }
      await sql.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id                     BIGSERIAL PRIMARY KEY,
          internal_order_id      TEXT GENERATED ALWAYS AS ('ORD-' || lpad(id::text, 6, '0')) STORED UNIQUE,
          channel                TEXT NOT NULL REFERENCES sales_channels(key),
          source_order_id        TEXT NOT NULL,
          order_date             TIMESTAMPTZ NOT NULL,
          customer_name          TEXT,
          customer_phone         TEXT,
          customer_email         TEXT,
          order_value            NUMERIC(12,2) NOT NULL CHECK (order_value >= 0),
          currency               TEXT NOT NULL DEFAULT 'INR',
          payment_method         TEXT,
          payment_status         TEXT CHECK (payment_status IN (${list(PAYMENT_STATUSES)})),
          order_status           TEXT NOT NULL DEFAULT 'new' CHECK (order_status IN (${list(ORDER_STATUSES)})),
          shipment_status        TEXT NOT NULL DEFAULT 'not_ready' CHECK (shipment_status IN (${list(SHIPMENT_STATUSES)})),
          courier_partner_id     INTEGER REFERENCES courier_partners(id),
          tracking_id            TEXT,
          tracking_url           TEXT,
          dispatch_date          TIMESTAMPTZ,
          expected_delivery_date DATE,
          delivered_at           TIMESTAMPTZ,
          source                 TEXT NOT NULL DEFAULT 'manual',
          source_payload         JSONB,
          version                INTEGER NOT NULL DEFAULT 1,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by             TEXT,
          updated_by             TEXT,
          UNIQUE (channel, source_order_id)
        )`);
      await sql.query('CREATE INDEX IF NOT EXISTS orders_date_idx ON orders (order_date DESC)');
      await sql.query('CREATE INDEX IF NOT EXISTS orders_shipment_idx ON orders (shipment_status)');
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
      // Append-only, enforced by the database rather than by convention. The
      // only way past it is a transaction that sets app.purge_orders, which
      // exists solely so the test suite can remove its own records.
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
// Reference data
// ---------------------------------------------------------------------------

export async function listChannels() {
  const { rows } = await getPool().query(
    'SELECT key, label, active FROM sales_channels ORDER BY sort, key');
  return rows;
}

export async function listCouriers({ includeInactive = false } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, name, tracking_url_template, active FROM courier_partners
     ${includeInactive ? '' : 'WHERE active'} ORDER BY sort, name`);
  return rows;
}

export async function saveCourier({ id, name, template, active }) {
  const clean = {
    name: name === undefined ? null : String(name).trim().slice(0, 60) || null,
    template: template === undefined ? undefined : (String(template || '').trim() || null),
  };
  if (clean.template && !/^https:\/\/\S+\{awb\}/.test(clean.template)) {
    throw Object.assign(new Error('The template must be an https:// address containing {awb}.'), { status: 400 });
  }
  if (id) {
    const { rows } = await getPool().query(
      `UPDATE courier_partners SET
         name = COALESCE($2, name),
         tracking_url_template = CASE WHEN $3 THEN $4 ELSE tracking_url_template END,
         active = COALESCE($5, active)
       WHERE id = $1 RETURNING id, name, tracking_url_template, active`,
      [id, clean.name, clean.template !== undefined, clean.template ?? null, active ?? null]);
    return rows[0] || null;
  }
  if (!clean.name) throw Object.assign(new Error('A courier needs a name.'), { status: 400 });
  const { rows } = await getPool().query(
    `INSERT INTO courier_partners (name, tracking_url_template) VALUES ($1, $2)
     RETURNING id, name, tracking_url_template, active`, [clean.name, clean.template ?? null]);
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

const ORDER_COLUMNS = `
  o.*, o.expected_delivery_date::text AS expected_delivery_date, c.label AS channel_label, cp.name AS courier_name,
  EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id = o.id AND d.removed_at IS NULL
          AND d.document_type = 'tax_invoice') AS has_invoice,
  (SELECT count(*)::int FROM order_documents d WHERE d.order_id = o.id AND d.removed_at IS NULL) AS document_count`;

const ORDER_FROM = `
  FROM orders o
  JOIN sales_channels c ON c.key = o.channel
  LEFT JOIN courier_partners cp ON cp.id = o.courier_partner_id`;

const toOrder = (r) => r && ({ ...r, id: Number(r.id), order_value: Number(r.order_value) });

/**
 * Builds the WHERE clause for a list. `channel` is left out when counting
 * tabs, so every tab shows what it would contain under the other filters.
 */
function orderFilters(f, tz, { withChannel = true } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  if (f.view && LOGISTICS_VIEWS[f.view]) where.push(LOGISTICS_VIEWS[f.view].where);
  if (withChannel && f.channel) where.push(`o.channel = ${p(f.channel)}`);
  if (f.q) {
    const like = p(`%${String(f.q).trim()}%`);
    where.push(`(o.internal_order_id ILIKE ${like} OR o.source_order_id ILIKE ${like}
                 OR o.tracking_id ILIKE ${like} OR o.customer_name ILIKE ${like}
                 OR o.customer_phone ILIKE ${like})`);
  }
  if (f.status) where.push(`o.order_status = ${p(f.status)}`);
  if (f.shipment) where.push(`o.shipment_status = ${p(f.shipment)}`);
  if (f.courier === 'none') where.push('o.courier_partner_id IS NULL');
  else if (f.courier) where.push(`o.courier_partner_id = ${p(Number(f.courier))}`);
  const invoice = `EXISTS (SELECT 1 FROM order_documents d WHERE d.order_id = o.id
                   AND d.removed_at IS NULL AND d.document_type = 'tax_invoice')`;
  if (f.invoice === 'yes') where.push(invoice);
  if (f.invoice === 'no') where.push(`NOT ${invoice}`);
  if (f.tracking === 'yes') where.push(`coalesce(o.tracking_id, '') <> ''`);
  if (f.tracking === 'no') where.push(`coalesce(o.tracking_id, '') = ''`);
  // Date bounds are whole days in the team's timezone, inclusive.
  if (f.from) where.push(`o.order_date >= (${p(f.from)}::date::timestamp AT TIME ZONE ${p(tz)})`);
  if (f.to) where.push(`o.order_date < ((${p(f.to)}::date + 1)::timestamp AT TIME ZONE ${p(tz)})`);

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listOrders(filters, { tz = 'Asia/Kolkata', limit = 100, offset = 0 } = {}) {
  const sql = getPool();
  const main = orderFilters(filters, tz);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);

  const [rows, total, tabs, views] = await Promise.all([
    sql.query(`SELECT ${ORDER_COLUMNS} ${ORDER_FROM} ${main.sql}
               ORDER BY o.order_date DESC, o.id DESC LIMIT ${lim} OFFSET ${off}`, main.params),
    sql.query(`SELECT count(*)::int AS n, coalesce(sum(o.order_value), 0)::numeric AS value
               ${ORDER_FROM} ${main.sql}`, main.params),
    (() => {
      const t = orderFilters(filters, tz, { withChannel: false });
      return sql.query(`SELECT o.channel, count(*)::int AS n ${ORDER_FROM} ${t.sql} GROUP BY o.channel`, t.params);
    })(),
    // Sidebar badges: queue sizes, independent of whatever is filtered.
    sql.query(`SELECT ${Object.entries(LOGISTICS_VIEWS)
      .map(([k, v]) => `count(*) FILTER (WHERE ${v.where})::int AS ${k}`).join(', ')} FROM orders o`),
  ]);

  const byChannel = Object.fromEntries(tabs.rows.map((r) => [r.channel, r.n]));
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
// Writes
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

function parseTime(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v);
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

/**
 * Manual create. Only the four identifying fields are required; logistics is
 * added later by whoever ships it. A second order with the same channel and
 * source order ID is refused and points at the existing one.
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
                          payment_method, payment_status, source, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (channel, source_order_id) DO NOTHING
       RETURNING id`,
      [channel, sourceOrderId, orderDate, orderValue, text(input.currency, 3)?.toUpperCase() || 'INR',
        text(input.customer_name, 120) ?? null, text(input.customer_phone, 20) ?? null,
        text(input.customer_email, 160) ?? null, text(input.payment_method, 40) ?? null,
        oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }) ?? null,
        source, actor]);
    if (!rows.length) {
      const existing = await client.query(
        `SELECT o.id, o.internal_order_id, c.label FROM orders o JOIN sales_channels c ON c.key = o.channel
         WHERE o.channel = $1 AND o.source_order_id = $2`,
        [channel, sourceOrderId]);
      const e = existing.rows[0];
      throw bad(`${e.label} order ${sourceOrderId} already exists as ${e.internal_order_id}.`, 409,
        { existingId: Number(e.id) });
    }
    const id = Number(rows[0].id);
    await logEvent(client, id, 'order_created', actor, {
      source, channel, source_order_id: sourceOrderId, order_value: orderValue,
    });
    return id;
  });
}

// Which event a changed field is filed under, so the timeline reads as
// "Shipment → Dispatched" rather than one undifferentiated "edited".
const FIELD_EVENT = {
  order_status: 'order_status_changed',
  shipment_status: 'shipment_status_changed',
  courier_partner_id: 'courier_changed',
  tracking_id: 'tracking_changed',
  tracking_url: 'tracking_changed',
};

/**
 * Applies a partial edit. `version` must match the row's current version, so
 * two people editing the same order cannot silently overwrite each other.
 */
export async function updateOrder(id, input, { actor, version } = {}) {
  const next = {
    channel: input.channel === undefined ? undefined : String(input.channel).trim(),
    source_order_id: input.source_order_id === undefined ? undefined : text(input.source_order_id, 100),
    order_date: parseTime(input.order_date, 'Order date'),
    order_value: input.order_value === undefined ? undefined : parseMoney(input.order_value),
    currency: input.currency === undefined ? undefined : (text(input.currency, 3)?.toUpperCase() || 'INR'),
    customer_name: text(input.customer_name, 120),
    customer_phone: text(input.customer_phone, 20),
    customer_email: text(input.customer_email, 160),
    payment_method: text(input.payment_method, 40),
    payment_status: oneOf(input.payment_status, PAYMENT_STATUSES, 'Payment status', { nullable: true }),
    order_status: oneOf(input.order_status, ORDER_STATUSES, 'Order status'),
    shipment_status: oneOf(input.shipment_status, SHIPMENT_STATUSES, 'Shipment status'),
    courier_partner_id: input.courier_partner_id === undefined ? undefined
      : (input.courier_partner_id === null || input.courier_partner_id === '' ? null : Number(input.courier_partner_id)),
    tracking_id: text(input.tracking_id, 80),
    tracking_url: text(input.tracking_url, 500),
    dispatch_date: parseTime(input.dispatch_date, 'Dispatch date'),
    expected_delivery_date: parseDay(input.expected_delivery_date, 'Expected delivery'),
    delivered_at: parseTime(input.delivered_at, 'Delivered at'),
  };
  if (next.channel === '' || next.source_order_id === null) throw bad('Channel and source order ID cannot be blank.');
  if (next.order_date === null) throw bad('Order date cannot be blank.');
  if (next.tracking_url && !/^https?:\/\//i.test(next.tracking_url)) throw bad('Tracking link must start with https://');

  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT *, expected_delivery_date::text AS expected_delivery_date FROM orders WHERE id = $1 FOR UPDATE', [id]);
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

    // The tracking link follows the courier and AWB unless someone typed one.
    // Couriers without a template keep whatever was entered by hand.
    if (next.tracking_url === undefined
        && (next.courier_partner_id !== undefined || next.tracking_id !== undefined)) {
      let template = null;
      if (merged.courier_partner_id) {
        const c = await client.query('SELECT tracking_url_template FROM courier_partners WHERE id = $1',
          [merged.courier_partner_id]);
        if (!c.rows.length) throw bad('Unknown courier.');
        template = c.rows[0].tracking_url_template;
      }
      // A generated link belongs to its courier: switching courier drops it
      // rather than point staff at the wrong company's tracking page.
      const courierChanged = merged.courier_partner_id !== cur.courier_partner_id;
      merged.tracking_url = template ? trackingUrlFor(template, merged.tracking_id)
        : (merged.tracking_id && !courierChanged ? cur.tracking_url : null);
    }

    if (SHIPPED.has(merged.shipment_status) && merged.shipment_status !== cur.shipment_status
        && (!merged.courier_partner_id || !merged.tracking_id)) {
      throw bad('Choose a courier and enter the AWB before marking it dispatched or later.');
    }
    if (merged.shipment_status !== cur.shipment_status) {
      if (SHIPPED.has(merged.shipment_status) && !merged.dispatch_date) merged.dispatch_date = new Date().toISOString();
      if (merged.shipment_status === 'delivered' && next.delivered_at === undefined && !cur.delivered_at) {
        merged.delivered_at = new Date().toISOString();
      }
      // Moving off Delivered (a correction) clears the stamp; the log keeps it.
      if (cur.shipment_status === 'delivered' && next.delivered_at === undefined) merged.delivered_at = null;
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

    const FIELDS = Object.keys(next);
    const changes = {};
    for (const k of FIELDS) if (!same(cur[k], merged[k])) changes[k] = { from: cur[k] ?? null, to: merged[k] ?? null };
    if (!Object.keys(changes).length) return { id, changed: false };

    const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 2}`);
    await client.query(
      `UPDATE orders SET ${sets.join(', ')}, version = version + 1, updated_at = now(),
         updated_by = $${sets.length + 2} WHERE id = $1`,
      [id, ...Object.keys(changes).map((k) => merged[k]), actor]);

    // One event per kind of change, so the history reads naturally.
    const groups = {};
    for (const [k, v] of Object.entries(changes)) {
      const type = FIELD_EVENT[k] || (k === 'dispatch_date' || k === 'delivered_at' || k === 'expected_delivery_date'
        ? 'shipment_dates_changed' : 'order_edited');
      (groups[type] ||= {})[k] = v;
    }
    for (const [type, fields] of Object.entries(groups)) await logEvent(client, id, type, actor, { changes: fields });
    return { id, changed: true };
  }).catch((err) => {
    if (err.code === '23505') throw bad('Another order already has that channel and source order ID.', 409);
    throw err;
  });
}

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

/** Removal hides a document; the row and the file are kept for the record. */
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
 * their documents and history. The append-only trigger is lifted for this one
 * transaction and nothing else.
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
    await client.query('DELETE FROM orders WHERE id = ANY($1)', [ids]);
    return { orders: ids.length, paths: docs.rows.map((r) => r.storage_path) };
  });
}
