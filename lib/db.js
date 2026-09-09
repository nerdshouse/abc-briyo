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
        'mrp_total NUMERIC(12,2)', 'discount_total NUMERIC(12,2)', 'subtotal NUMERIC(12,2)',
        'drop_stage TEXT', 'drop_reason TEXT', 'risk_flag TEXT',
        'utm_source TEXT', 'address TEXT',
        // v2
        'utm_campaign TEXT', 'utm_medium TEXT',
        'gokwik_email_sent BOOLEAN', 'gokwik_message_queued BOOLEAN',
        'brand_order_count INTEGER',
        'callback_at TIMESTAMPTZ', "reason_tags TEXT[] NOT NULL DEFAULT '{}'",
        'updated_by TEXT', 'recovered_order_id TEXT', 'recovered_order_name TEXT',
        'recovered_at TIMESTAMPTZ',
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
      await sql.query('ALTER TABLE allowed_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false');
      await sql.query('ALTER TABLE allowed_users ADD COLUMN IF NOT EXISTS added_by TEXT');
      await sql.query(`
        CREATE TABLE IF NOT EXISTS member_log (
          id           BIGSERIAL PRIMARY KEY,
          actor        TEXT,
          action       TEXT NOT NULL,
          target_phone TEXT,
          detail       TEXT,
          at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query(`
        CREATE TABLE IF NOT EXISTS system_state (
          key        TEXT PRIMARY KEY,
          value      TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query(`
        CREATE TABLE IF NOT EXISTS webhook_failures (
          id          BIGSERIAL PRIMARY KEY,
          kind        TEXT NOT NULL,
          error       TEXT,
          body        TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query(`CREATE INDEX IF NOT EXISTS webhook_failures_received_idx
                       ON webhook_failures (received_at DESC)`);
      await sql.query(`
        CREATE TABLE IF NOT EXISTS login_log (
          id     BIGSERIAL PRIMARY KEY,
          phone  TEXT,
          ok     BOOLEAN NOT NULL,
          reason TEXT,
          ip     TEXT,
          at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query('CREATE INDEX IF NOT EXISTS login_log_at_idx ON login_log (at DESC)');
      await sql.query(`
        CREATE TABLE IF NOT EXISTS auto_recovery_log (
          id           BIGSERIAL PRIMARY KEY,
          cart_id      TEXT,
          cart_row_id  BIGINT,
          order_id     TEXT,
          order_name   TEXT,
          matched_on   TEXT,
          matched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      // Expression indexes matching matchOrderToCarts / searchCarts verbatim.
      // If either query is reworded these silently stop being used, so keep the
      // expressions identical to the ones in those functions.
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_phone10_idx
                       ON abandoned_carts (right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10))`);
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_email_lower_idx
                       ON abandoned_carts (lower(coalesce(email, '')))`);
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_callback_idx
                       ON abandoned_carts (callback_at) WHERE callback_at IS NOT NULL`);
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
    n.utmSource, n.address, n.subtotal, n.utmCampaign, n.utmMedium,
    n.gokwikEmailSent, n.gokwikMessageQueued, n.brandOrderCount,
  ];
  const COLS = `(cart_id, customer_name, phone, email, total_price, currency,
                 checkout_url, item_count, abandoned_at, raw_payload,
                 mrp_total, discount_total, drop_stage, drop_reason, risk_flag,
                 utm_source, address, subtotal, utm_campaign, utm_medium,
                 gokwik_email_sent, gokwik_message_queued, brand_order_count)`;
  const PLACEHOLDERS =
    '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)';

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
       subtotal      = COALESCE(EXCLUDED.subtotal,      abandoned_carts.subtotal),
       utm_campaign  = COALESCE(EXCLUDED.utm_campaign,  abandoned_carts.utm_campaign),
       utm_medium    = COALESCE(EXCLUDED.utm_medium,    abandoned_carts.utm_medium),
       gokwik_email_sent     = COALESCE(EXCLUDED.gokwik_email_sent,     abandoned_carts.gokwik_email_sent),
       gokwik_message_queued = COALESCE(EXCLUDED.gokwik_message_queued, abandoned_carts.gokwik_message_queued),
       brand_order_count     = COALESCE(EXCLUDED.brand_order_count,     abandoned_carts.brand_order_count),
       -- Merge rather than replace. GoKwik retries are sometimes sparser than
       -- the original delivery, and raw_payload is the source of truth for
       -- backfill — a retry must never be able to remove information from it.
       -- New values win per key; keys the retry omitted survive.
       raw_payload   = abandoned_carts.raw_payload || EXCLUDED.raw_payload
     RETURNING id, (xmax <> 0) AS updated`, values);
  return { id: rows[0].id, duplicate: rows[0].updated };
}

const CART_COLUMNS = `id, cart_id, customer_name, phone, email, total_price, currency,
            checkout_url, item_count, abandoned_at, status, notes,
            status_updated_at, received_at, mrp_total, discount_total,
            drop_stage, drop_reason, risk_flag, utm_source, utm_campaign, utm_medium,
            address, subtotal, gokwik_email_sent, gokwik_message_queued, brand_order_count,
            callback_at, reason_tags, updated_by, recovered_order_id,
            recovered_order_name, recovered_at, raw_payload`;

const toCart = (r) => ({
  ...r,
  total_price: r.total_price === null ? null : Number(r.total_price),
  mrp_total: r.mrp_total === null ? null : Number(r.mrp_total),
  discount_total: r.discount_total === null ? null : Number(r.discount_total),
});

/**
 * A bounded window, not a page.
 *
 * The board filters and sorts client-side over whatever it is given, which is
 * what makes "risk then value" call-ordering and the stats totals work. Paging
 * would break all of that. Instead the date range the UI already has is pushed
 * down to the server, so the array stays small enough to reason about.
 *
 * `total` is returned separately so the UI can say "showing 500 of 1,240"
 * rather than silently dropping the oldest rows, which is what the old
 * unconditional LIMIT 500 did.
 */
export async function listCarts({ sinceDays = 7, limit = 5000 } = {}) {
  const windowed = Number(sinceDays) > 0;
  const where = windowed ? `WHERE received_at > now() - ($1 || ' days')::interval` : '';
  const limitParam = windowed ? '$2' : '$1';
  const params = windowed ? [String(Number(sinceDays)), limit] : [limit];

  const { rows } = await getPool().query(
    `SELECT ${CART_COLUMNS} FROM abandoned_carts ${where}
     ORDER BY received_at DESC LIMIT ${limitParam}`, params);

  const { rows: counted } = await getPool().query(
    `SELECT count(*)::int AS n FROM abandoned_carts ${where}`,
    windowed ? [String(Number(sinceDays))] : []);

  return { carts: rows.map(toCart), total: counted[0].n, truncated: counted[0].n > rows.length };
}

/**
 * Free-text lookup, deliberately ignoring the date window — the whole point is
 * "that customer from three weeks ago just rang back".
 * Phone matches on digits only, so "98123 45678" and "+919812345678" both hit.
 */
export async function searchCarts(query, limit = 50) {
  const q = String(query ?? '').trim();
  if (!q) return { carts: [], total: 0, truncated: false };
  const digits = q.replace(/\D/g, '');

  const { rows } = await getPool().query(
    `SELECT ${CART_COLUMNS} FROM abandoned_carts
     WHERE customer_name ILIKE '%' || $1 || '%'
        OR email ILIKE '%' || $1 || '%'
        OR cart_id ILIKE '%' || $1 || '%'
        OR ($2 <> '' AND regexp_replace(coalesce(phone,''), '\\D', '', 'g') LIKE '%' || $2 || '%')
     ORDER BY received_at DESC LIMIT $3`, [q, digits, limit]);

  return { carts: rows.map(toCart), total: rows.length, truncated: rows.length === limit };
}

/**
 * Optimistic-concurrency check. Returns the current row if someone else has
 * saved since the client last read it, otherwise null.
 *
 * Deliberately narrow: this exists to stop one caller silently overwriting
 * another's notes, not to lock rows. Same-user saves never conflict.
 */
export async function conflictingUpdate(id, seenAt, byUser) {
  if (!seenAt) return null;
  const { rows } = await getPool().query(
    `SELECT status, notes, updated_by, status_updated_at
     FROM abandoned_carts
     WHERE id = $1 AND status_updated_at IS NOT NULL
       -- Postgres keeps microseconds; JSON timestamps only carry milliseconds,
       -- so comparing raw values makes every save look like a conflict.
       AND date_trunc('milliseconds', status_updated_at) > date_trunc('milliseconds', $2::timestamptz)
       AND updated_by IS DISTINCT FROM $3`, [id, seenAt, byUser ?? null]);
  return rows[0] || null;
}

export async function updateStatus(id, { status, notes, callbackAt, reasonTags, updatedBy }) {
  const { rows } = await getPool().query(
    `UPDATE abandoned_carts
     SET status      = COALESCE($2, status),
         notes       = COALESCE($3, notes),
         -- callback_at is cleared deliberately when the status moves away from
         -- "Callback scheduled", so $4 being null must be able to null it out.
         callback_at = CASE WHEN $5 THEN $4::timestamptz ELSE callback_at END,
         reason_tags = COALESCE($6::text[], reason_tags),
         updated_by  = COALESCE($7, updated_by),
         status_updated_at = now()
     WHERE id = $1
     RETURNING id, status, notes, callback_at, reason_tags, updated_by, status_updated_at`,
    [id, status ?? null, notes ?? null, callbackAt ?? null, callbackAt !== undefined,
     reasonTags ?? null, updatedBy ?? null]);
  return rows[0] || null;
}

/**
 * Auto-recovery from a completed order event. Matches on the last 10 digits of
 * the phone, or the email, and only upgrades from statuses that mean "still
 * open" — a human who marked a cart Declined or Recovered is never overridden.
 */
const AUTO_UPGRADABLE = ['Not called', 'Called – No answer', 'Callback scheduled', 'Auto-nudged'];

export async function matchOrderToCarts({
  phone, email, orderId, orderName, updatedBy = 'Auto (GoKwik order match)',
}) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;
  const mail = email ? String(email).trim().toLowerCase() : null;
  if (!last10 && !mail) return [];

  const { rows } = await getPool().query(
    `UPDATE abandoned_carts SET
       status = 'Called – Recovered',
       updated_by = $6,
       recovered_order_id = $3,
       recovered_order_name = $4,
       recovered_at = now(),
       status_updated_at = now()
     WHERE status = ANY($5)
       AND (
         ($1::text IS NOT NULL AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1)
         OR ($2::text IS NOT NULL AND lower(coalesce(email,'')) = $2)
       )
     RETURNING id, cart_id, phone, email,
               CASE WHEN $1::text IS NOT NULL
                     AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1
                    THEN 'phone' ELSE 'email' END AS matched_on`,
    [last10, mail, orderId ?? null, orderName ?? null, AUTO_UPGRADABLE, updatedBy]);

  for (const r of rows) {
    await getPool().query(
      `INSERT INTO auto_recovery_log (cart_id, cart_row_id, order_id, order_name, matched_on)
       VALUES ($1,$2,$3,$4,$5)`,
      [r.cart_id, r.id, orderId ?? null, orderName ?? null, r.matched_on]);
  }
  return rows;
}

export { AUTO_UPGRADABLE };

export async function ping() {
  const { rows } = await getPool().query('SELECT now() AS now, version() AS version');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Aggregates for the dashboard
// ---------------------------------------------------------------------------

const sinceClause = (days) => (days > 0 ? `received_at > now() - interval '${Number(days)} days'` : 'TRUE');

/** Counts per reason tag over the window — the "why are people abandoning" view. */
export async function reasonSummary(days = 7) {
  const { rows } = await getPool().query(
    `SELECT tag, count(*)::int AS count
     FROM abandoned_carts, unnest(reason_tags) AS tag
     WHERE ${sinceClause(days)}
     GROUP BY tag ORDER BY count DESC, tag`);
  const { rows: totals } = await getPool().query(
    `SELECT count(*)::int AS tagged
     FROM abandoned_carts
     WHERE ${sinceClause(days)} AND array_length(reason_tags, 1) > 0`);
  return { reasons: rows, taggedCarts: totals[0].tagged };
}

/** Per-teammate activity over the window. */
export async function statsByCaller(days = 7) {
  const { rows } = await getPool().query(
    `SELECT updated_by AS caller,
            count(*)::int AS touched,
            count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
            COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value
     FROM abandoned_carts
     WHERE updated_by IS NOT NULL AND ${sinceClause(days)}
     GROUP BY updated_by ORDER BY touched DESC`);
  return rows.map((r) => ({
    ...r,
    recovery_rate: r.touched ? Math.round((r.recovered / r.touched) * 100) : 0,
  }));
}

/** Carts sitting at "Not called" longer than the SLA. */
export async function staleCarts(hours) {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS count,
            min(received_at) AS oldest,
            COALESCE(SUM(total_price), 0)::float AS value
     FROM abandoned_carts
     WHERE status = 'Not called' AND received_at < now() - ($1 || ' hours')::interval`,
    [String(hours)]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Backfill: re-derive columns from raw_payload
// ---------------------------------------------------------------------------

/**
 * Columns re-derived from raw_payload by the renormalizer.
 *
 * Deliberately excludes everything a human owns — status, notes, callback_at,
 * reason_tags, updated_by, recovered_*, status_updated_at, received_at. A
 * backfill must never be able to erase a call log.
 */
export const DERIVED_COLUMNS = [
  'customer_name', 'phone', 'email', 'total_price', 'subtotal', 'mrp_total',
  'discount_total', 'currency', 'checkout_url', 'item_count', 'abandoned_at',
  'drop_stage', 'drop_reason', 'risk_flag', 'utm_source', 'utm_campaign',
  'utm_medium', 'address', 'gokwik_email_sent', 'gokwik_message_queued',
  'brand_order_count',
];

/** column name -> normalizePayload() key. Exported so the backfill script
 *  cannot drift from what renormalizeRow actually writes. */
export const NORMALIZED_KEY_FOR = {
  customer_name: 'customerName', total_price: 'totalPrice', mrp_total: 'mrpTotal',
  discount_total: 'discountTotal', checkout_url: 'checkoutUrl', item_count: 'itemCount',
  abandoned_at: 'abandonedAt', drop_stage: 'dropStage', drop_reason: 'dropReason',
  risk_flag: 'riskFlag', utm_source: 'utmSource', utm_campaign: 'utmCampaign',
  utm_medium: 'utmMedium', gokwik_email_sent: 'gokwikEmailSent',
  gokwik_message_queued: 'gokwikMessageQueued', brand_order_count: 'brandOrderCount',
};
export const normalizedValue = (n, col) => n[NORMALIZED_KEY_FOR[col] ?? col] ?? null;

/** Columns stored as NUMERIC — pg returns these as strings, so "215.00" and 215
 *  are equal in value but not as strings. Compare them numerically. */
export const NUMERIC_COLUMNS = new Set([
  'total_price', 'subtotal', 'mrp_total', 'discount_total', 'item_count',
]);

/**
 * Plain assignment, NOT the COALESCE upsert used by insertCart.
 *
 * insertCart is deliberately additive so a webhook retry can never blank a
 * field — which also means it can never *correct* a wrong non-null value.
 * A backfill needs the opposite semantics, so this is a separate function on
 * purpose. Keeping the two apart is the design, not an oversight.
 */
export async function renormalizeRow(id, normalized) {
  const sets = DERIVED_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const values = DERIVED_COLUMNS.map((c) => normalizedValue(normalized, c));
  const { rows } = await getPool().query(
    `UPDATE abandoned_carts SET ${sets} WHERE id = $1 RETURNING id`, [id, ...values]);
  return rows[0] || null;
}

/** Page through rows for backfill; keyset so it works at 17 rows and at 50k. */
export async function eachCartPage(afterId = 0, limit = 200) {
  const { rows } = await getPool().query(
    `SELECT id, raw_payload, ${DERIVED_COLUMNS.join(', ')}
     FROM abandoned_carts WHERE id > $1 ORDER BY id LIMIT $2`, [afterId, limit]);
  return rows;
}

/** Removes keys we never derive from and should not retain. Idempotent. */
export async function redactRow(id, keys) {
  const expr = keys.map((_, i) => `- $${i + 2}::text`).join(' ');
  const { rows } = await getPool().query(
    `UPDATE abandoned_carts SET raw_payload = raw_payload ${expr}
     WHERE id = $1 RETURNING id`, [id, ...keys]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * Small key/value table for facts about the system rather than the data —
 * currently just when a webhook last arrived. One extra write per delivery
 * (~21/day), which is cheaper than a full events table we would never query.
 */
export async function recordSystemEvent(key, value = null) {
  await getPool().query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]);
}

export async function getSystemState(key) {
  const { rows } = await getPool().query(
    'SELECT key, value, updated_at FROM system_state WHERE key = $1', [key]);
  return rows[0] || null;
}

/**
 * Webhook deliveries we accepted (200) but failed to store. Returning 200 is
 * deliberate — GoKwik retries on non-2xx and a retry storm is worse — but that
 * means the only record was Render's logs, which rotate. The body is kept so a
 * failure can be replayed once the cause is fixed.
 */
export async function recordWebhookFailure({ kind, error, body }) {
  await getPool().query(
    `INSERT INTO webhook_failures (kind, error, body) VALUES ($1, $2, $3)`,
    [kind, String(error).slice(0, 2000), typeof body === 'string' ? body : JSON.stringify(body ?? null)]);
}

export async function webhookFailureCount(hours = 24) {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM webhook_failures
     WHERE received_at > now() - ($1 || ' hours')::interval`, [String(hours)]);
  return rows[0].n;
}

export async function cartCount() {
  const { rows } = await getPool().query('SELECT count(*)::int AS n FROM abandoned_carts');
  return rows[0].n;
}

/**
 * Login attempts. Render's logs rotate, so console.log was the only record of
 * who signed in — and none of it survived a redeploy. Deliberately minimal:
 * phone, outcome, reason, IP. Never the code.
 */
export async function recordLogin({ phone, ok, reason, ip }) {
  await getPool().query(
    `INSERT INTO login_log (phone, ok, reason, ip) VALUES ($1,$2,$3,$4)`,
    [phone ?? null, Boolean(ok), reason ? String(reason).slice(0, 200) : null, ip ?? null]);
}

export async function recentLogins(limit = 50) {
  const { rows } = await getPool().query(
    'SELECT phone, ok, reason, ip, at FROM login_log ORDER BY at DESC LIMIT $1', [limit]);
  return rows;
}

// ---------------------------------------------------------------------------
// Member management
// ---------------------------------------------------------------------------

export async function listMembers() {
  const { rows } = await getPool().query(
    `SELECT phone, name, active, is_admin, added_at, added_by,
            (SELECT max(at) FROM login_log l WHERE l.phone = u.phone AND l.ok) AS last_login
     FROM allowed_users u ORDER BY active DESC, added_at`);
  return rows;
}

export async function upsertMember({ phone, name, isAdmin = false, addedBy = null }) {
  const { rows } = await getPool().query(
    `INSERT INTO allowed_users (phone, name, is_admin, active, added_by)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (phone) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, allowed_users.name),
       is_admin = EXCLUDED.is_admin,
       active = true
     RETURNING phone, name, active, is_admin, added_at, added_by`,
    [phone, name || 'Team', Boolean(isAdmin), addedBy]);
  return rows[0];
}

export async function updateMember(phone, { name, active, isAdmin }) {
  const { rows } = await getPool().query(
    `UPDATE allowed_users SET
       name     = COALESCE($2, name),
       active   = COALESCE($3, active),
       is_admin = COALESCE($4, is_admin)
     WHERE phone = $1
     RETURNING phone, name, active, is_admin, added_at, added_by`,
    [phone, name ?? null, active ?? null, isAdmin ?? null]);
  return rows[0] || null;
}

export async function deleteMember(phone) {
  const { rowCount } = await getPool().query('DELETE FROM allowed_users WHERE phone = $1', [phone]);
  return rowCount > 0;
}

/**
 * How many admins would remain if `excluding` were removed or demoted.
 * Used to refuse the change that would leave nobody able to manage members —
 * the one mistake in this panel that can't be undone from inside the app.
 */
export async function otherActiveAdminCount(excluding) {
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM allowed_users
     WHERE active AND is_admin AND phone <> $1`, [excluding]);
  return rows[0].n;
}

export async function recordMemberChange({ actor, action, targetPhone, detail }) {
  await getPool().query(
    `INSERT INTO member_log (actor, action, target_phone, detail) VALUES ($1,$2,$3,$4)`,
    [actor ?? null, action, targetPhone ?? null, detail ? String(detail).slice(0, 300) : null]);
}

export async function recentMemberChanges(limit = 30) {
  const { rows } = await getPool().query(
    'SELECT actor, action, target_phone, detail, at FROM member_log ORDER BY at DESC LIMIT $1', [limit]);
  return rows;
}
