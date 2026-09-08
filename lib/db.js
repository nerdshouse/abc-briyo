import pg from 'pg';

/**
 * Postgres (Neon) storage. Carts arrive from the GoKwik webhook; call status and
 * notes live on the same row, so a cart and its outreach state are one record.
 *
 * With no DATABASE_URL set the app runs in MOCK MODE against an in-memory store,
 * so the UI and login are usable without provisioning anything.
 */

export const isMockMode = () => !process.env.DATABASE_URL;

let pool = null;
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon requires TLS; it presents a valid cert so no need to disable verification.
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

let schemaPromise = null;
export function ensureSchema() {
  if (isMockMode()) return Promise.resolve();
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getPool();
      await sql.query(`
        CREATE TABLE IF NOT EXISTS abandoned_carts (
          id                BIGSERIAL PRIMARY KEY,
          cart_id           TEXT UNIQUE,
          customer_name     TEXT,
          phone             TEXT,
          email             TEXT,
          total_price       NUMERIC(12,2),
          currency          TEXT,
          checkout_url      TEXT,
          item_count        INTEGER,
          abandoned_at      TIMESTAMPTZ,
          raw_payload       JSONB NOT NULL,
          status            TEXT NOT NULL DEFAULT 'Not called',
          notes             TEXT NOT NULL DEFAULT '',
          status_updated_at TIMESTAMPTZ,
          received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      // Added after the first deploy, so they must be additive on an existing table.
      for (const col of [
        'mrp_total NUMERIC(12,2)', 'discount_total NUMERIC(12,2)',
        'drop_stage TEXT', 'drop_reason TEXT', 'risk_flag TEXT',
        'utm_source TEXT', 'address TEXT',
      ]) {
        await sql.query(`ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS ${col}`);
      }
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_received_idx
                       ON abandoned_carts (received_at DESC)`);
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_status_idx
                       ON abandoned_carts (status)`);
      await sql.query(`
        CREATE TABLE IF NOT EXISTS allowed_users (
          phone    TEXT PRIMARY KEY,
          name     TEXT NOT NULL DEFAULT 'Team',
          active   BOOLEAN NOT NULL DEFAULT true,
          added_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { ensureOtpSchema } = await import('./otp.js');
      await ensureOtpSchema();
    })().catch((err) => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

/**
 * Upsert on cart_id so GoKwik's retries don't create duplicates. An existing
 * row keeps its status and notes — re-delivery must never wipe a call log.
 * Rows with no cart_id can't be deduped, so they're plain inserts.
 */
export async function insertCart(normalized, rawPayload) {
  const n = normalized;
  const values = [
    n.cartId, n.customerName, n.phone, n.email, n.totalPrice, n.currency,
    n.checkoutUrl, n.itemCount, n.abandonedAt, JSON.stringify(rawPayload),
    n.mrpTotal, n.discountTotal, n.dropStage, n.dropReason, n.riskFlag,
    n.utmSource, n.address,
  ];
  const COLS = `(cart_id, customer_name, phone, email, total_price, currency,
                 checkout_url, item_count, abandoned_at, raw_payload,
                 mrp_total, discount_total, drop_stage, drop_reason, risk_flag,
                 utm_source, address)`;
  const PLACEHOLDERS = '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)';

  if (!n.cartId) {
    const { rows } = await getPool().query(
      `INSERT INTO abandoned_carts ${COLS} VALUES ${PLACEHOLDERS} RETURNING id`, values);
    return { id: rows[0].id, duplicate: false };
  }

  const { rows } = await getPool().query(
    `INSERT INTO abandoned_carts ${COLS} VALUES ${PLACEHOLDERS}
     ON CONFLICT (cart_id) DO UPDATE SET
       customer_name = COALESCE(EXCLUDED.customer_name, abandoned_carts.customer_name),
       phone         = COALESCE(EXCLUDED.phone,         abandoned_carts.phone),
       email         = COALESCE(EXCLUDED.email,         abandoned_carts.email),
       total_price   = COALESCE(EXCLUDED.total_price,   abandoned_carts.total_price),
       currency      = COALESCE(EXCLUDED.currency,      abandoned_carts.currency),
       checkout_url  = COALESCE(EXCLUDED.checkout_url,  abandoned_carts.checkout_url),
       item_count    = COALESCE(EXCLUDED.item_count,    abandoned_carts.item_count),
       abandoned_at  = COALESCE(EXCLUDED.abandoned_at,  abandoned_carts.abandoned_at),
       mrp_total     = COALESCE(EXCLUDED.mrp_total,     abandoned_carts.mrp_total),
       discount_total= COALESCE(EXCLUDED.discount_total,abandoned_carts.discount_total),
       drop_stage    = COALESCE(EXCLUDED.drop_stage,    abandoned_carts.drop_stage),
       drop_reason   = COALESCE(EXCLUDED.drop_reason,   abandoned_carts.drop_reason),
       risk_flag     = COALESCE(EXCLUDED.risk_flag,     abandoned_carts.risk_flag),
       utm_source    = COALESCE(EXCLUDED.utm_source,    abandoned_carts.utm_source),
       address       = COALESCE(EXCLUDED.address,       abandoned_carts.address),
       raw_payload   = EXCLUDED.raw_payload
     RETURNING id, (xmax <> 0) AS updated`, values);
  return { id: rows[0].id, duplicate: rows[0].updated };
}

export async function listCarts({ limit = 500 } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, cart_id, customer_name, phone, email, total_price, currency,
            checkout_url, item_count, abandoned_at, status, notes,
            status_updated_at, received_at, mrp_total, discount_total,
            drop_stage, drop_reason, risk_flag, utm_source, address, raw_payload
     FROM abandoned_carts ORDER BY received_at DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({
    ...r,
    total_price: r.total_price === null ? null : Number(r.total_price),
    mrp_total: r.mrp_total === null ? null : Number(r.mrp_total),
    discount_total: r.discount_total === null ? null : Number(r.discount_total),
  }));
}

export async function updateStatus(id, { status, notes }) {
  const { rows } = await getPool().query(
    `UPDATE abandoned_carts
     SET status = COALESCE($2, status),
         notes  = COALESCE($3, notes),
         status_updated_at = now()
     WHERE id = $1
     RETURNING id, status, notes, status_updated_at`, [id, status ?? null, notes ?? null]);
  return rows[0] || null;
}

export async function ping() {
  const { rows } = await getPool().query('SELECT now() AS now, version() AS version');
  return rows[0];
}
