import pg from 'pg';
import { assertDatabaseEnvironment } from './env-guard.js';

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
      // Before any DDL: APP_ENV and the database's own label must agree.
      await assertDatabaseEnvironment(sql);
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
        "source TEXT NOT NULL DEFAULT 'gokwik'",
        'assigned_to TEXT',
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
      await sql.query('ALTER TABLE allowed_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ');
      // Non-admin job. NULL reads as 'caller', so every existing member keeps
      // exactly the access they had; 'logistics' is opt-in, per person.
      await sql.query(`ALTER TABLE allowed_users ADD COLUMN IF NOT EXISTS role TEXT
                       CHECK (role IN ('caller', 'logistics'))`);
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
      /**
       * Append-only log of status transitions.
       *
       * updateStatus overwrites status/updated_by in place, and unlike the
       * ingest path there is no raw_payload to reconstruct from — so without
       * this table "how many times did we try this customer" and "who worked it
       * before" are unanswerable, and unanswerable *retroactively*. One row per
       * status change, a few hundred a day at most.
       *
       * note_len, not the note itself: this is an audit trail, not a second
       * copy of customer notes sitting outside the PII story.
       */
      await sql.query(`
        CREATE TABLE IF NOT EXISTS cart_events (
          id          BIGSERIAL PRIMARY KEY,
          cart_id     BIGINT NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
          from_status TEXT,
          to_status   TEXT,
          actor       TEXT,
          note_len    INTEGER,
          at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await sql.query(`CREATE INDEX IF NOT EXISTS cart_events_cart_idx
                       ON cart_events (cart_id, at)`);
      // Added after the table was already recording status moves, so additive:
      // `kind` says which part of the cart changed, `detail` carries the new
      // value in a form a person can read straight off a log line.
      for (const col of ['kind TEXT', 'detail TEXT']) {
        await sql.query(`ALTER TABLE cart_events ADD COLUMN IF NOT EXISTS ${col}`);
      }
      // Rows written before `kind` existed can only be status changes — that is
      // all the table recorded then — so this backfill is exact, not a guess.
      await sql.query(`UPDATE cart_events SET kind = 'status' WHERE kind IS NULL`);
      // The activity log is read newest-first across every cart.
      await sql.query(`CREATE INDEX IF NOT EXISTS cart_events_at_idx
                       ON cart_events (at DESC)`);

      // Expression indexes matching matchOrderToCarts / searchCarts verbatim.
      // If either query is reworded these silently stop being used, so keep the
      // expressions identical to the ones in those functions.
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_phone10_idx
                       ON abandoned_carts (right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10))`);
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_email_lower_idx
                       ON abandoned_carts (lower(coalesce(email, '')))`);
      await sql.query(`CREATE INDEX IF NOT EXISTS abandoned_carts_assigned_idx
                       ON abandoned_carts (assigned_to) WHERE assigned_to IS NOT NULL`);
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

/**
 * The board's day boundary. "Today" has to mean the calendar day the callers are
 * living in, not the last 24 hours — a rolling window made "Today" return most
 * of yesterday, which is why the range buttons looked broken.
 */
// One canonical name: BOARD_TIMEZONE. BOARD_TZ is accepted only so an existing
// deployment does not silently change day boundaries mid-flight; it is
// deprecated and warned about at boot in server.js.
const BOARD_TZ = process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata';

/** N calendar days back, inclusive of today, as a timestamptz cutoff. */
const dayWindowSql = (param) =>
  `(date_trunc('day', (now() AT TIME ZONE '${BOARD_TZ}')) - make_interval(days => ${param} - 1)) AT TIME ZONE '${BOARD_TZ}'`;

const CART_COLUMNS = `id, cart_id, customer_name, phone, email, total_price, currency,
            checkout_url, item_count, abandoned_at, status, notes,
            status_updated_at, received_at, mrp_total, discount_total,
            drop_stage, drop_reason, risk_flag, utm_source, utm_campaign, utm_medium,
            address, subtotal, gokwik_email_sent, gokwik_message_queued, brand_order_count, source,
            callback_at, reason_tags, updated_by, recovered_order_id,
            recovered_order_name, recovered_at, raw_payload,
            assigned_to,
            (SELECT name FROM allowed_users u WHERE u.phone = abandoned_carts.assigned_to) AS assigned_to_name`;

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
/**
 * A scheduled callback is a promise to a customer and outlives any date window.
 *
 * The window exists so the board is not an infinite list; it is a *browsing*
 * control. Applying it to callbacks meant a cart promised a call back three
 * weeks ago was simply never loaded — 14 callbacks existed while the default
 * seven-day view showed 9 and "Today" showed 5, and a caller changing the range
 * watched promised callbacks vanish with nothing to tell them.
 */
const ACTIONABLE_CALLBACK = "status = 'Callback scheduled'";

export async function listCarts({ sinceDays = 7, limit = 5000 } = {}) {
  const windowed = Number(sinceDays) > 0;
  // Outside the window, callbacks still come back. Carts that are recovered or
  // declined are not in this status, so a closed cart cannot be dragged in.
  const where = windowed
    ? `WHERE (received_at >= ${dayWindowSql('$1::int')} OR ${ACTIONABLE_CALLBACK})`
    : '';
  const limitParam = windowed ? '$2' : '$1';
  const params = windowed ? [Number(sinceDays), limit] : [limit];

  const { rows } = await getPool().query(
    `SELECT ${CART_COLUMNS} FROM abandoned_carts ${where}
     ORDER BY received_at DESC LIMIT ${limitParam}`, params);

  // `total` counts the window alone, because it is what the "N carts from the
  // last 7 days" line describes; callbacks pulled in from outside are reported
  // separately so the two numbers are never silently conflated.
  const countWhere = windowed ? `WHERE received_at >= ${dayWindowSql('$1::int')}` : '';
  const { rows: counted } = await getPool().query(
    `SELECT count(*)::int AS n FROM abandoned_carts ${countWhere}`,
    windowed ? [Number(sinceDays)] : []);

  const { rows: cbs } = await getPool().query(
    `SELECT count(*)::int AS n FROM abandoned_carts WHERE ${ACTIONABLE_CALLBACK}`);

  return {
    carts: rows.map(toCart),
    total: counted[0].n,
    callbackTotal: cbs[0].n,
    truncated: counted[0].n > rows.length,
  };
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

export async function updateStatus(id, {
  status, notes, callbackAt, reasonTags, updatedBy, assignedTo,
}) {
  // One statement, one transaction: the row update and its history entry can
  // never diverge, because a data-modifying CTE cannot half-succeed. `prev`
  // reads the pre-update status — every sub-statement sees the same snapshot.
  const { rows } = await getPool().query(
    `WITH prev AS (
       SELECT id, status, notes, callback_at, reason_tags, assigned_to
       FROM abandoned_carts WHERE id = $1
     ),
     upd AS (
     UPDATE abandoned_carts
     SET status      = COALESCE($2, status),
         notes       = COALESCE($3, notes),
         -- callback_at is cleared deliberately when the status moves away from
         -- "Callback scheduled", so $4 being null must be able to null it out.
         callback_at = CASE WHEN $5 THEN $4::timestamptz ELSE callback_at END,
         reason_tags = COALESCE($6::text[], reason_tags),
         updated_by  = COALESCE($7, updated_by),
         -- like callback_at, an explicit null must be able to clear it, so the
         -- "was it supplied" flag is passed separately from the value.
         assigned_to = CASE WHEN $9 THEN $8 ELSE assigned_to END,
         status_updated_at = now()
     WHERE id = $1
     RETURNING id, status, notes, callback_at, reason_tags, updated_by, status_updated_at,
               assigned_to
     ),
     /*
      * One row per thing that actually changed, not one per save.
      *
      * Each arm carries its own IS DISTINCT FROM guard, so a save that touches
      * only the notes logs only a note edit. That matters for anything counting
      * call attempts later: a status arm that fired on every save would make
      * every activity figure built on this table wrong.
      */
     ev AS (
       INSERT INTO cart_events (cart_id, kind, from_status, to_status, actor, note_len, detail)
       SELECT * FROM (
         SELECT p.id, 'status', p.status, u.status, u.updated_by,
                length(coalesce(u.notes, '')), NULL::text
         FROM prev p JOIN upd u ON u.id = p.id
         WHERE p.status IS DISTINCT FROM u.status

         UNION ALL
         -- The note text is kept, not just its length: an audit trail that says
         -- "the note changed" without saying to what cannot settle a dispute
         -- about what a customer was promised. Truncated — this is a log line.
         SELECT p.id, 'note', NULL, NULL, u.updated_by,
                length(coalesce(u.notes, '')), left(coalesce(u.notes, ''), 300)
         FROM prev p JOIN upd u ON u.id = p.id
         WHERE p.notes IS DISTINCT FROM u.notes

         UNION ALL
         SELECT p.id, 'callback', NULL, NULL, u.updated_by, NULL,
                CASE WHEN u.callback_at IS NULL THEN 'cleared'
                     ELSE to_char(u.callback_at AT TIME ZONE '${BOARD_TZ}', 'DD Mon YYYY, HH12:MI am') END
         FROM prev p JOIN upd u ON u.id = p.id
         WHERE p.callback_at IS DISTINCT FROM u.callback_at

         UNION ALL
         SELECT p.id, 'reason', NULL, NULL, u.updated_by, NULL,
                COALESCE(NULLIF(array_to_string(u.reason_tags, ', '), ''), 'cleared')
         FROM prev p JOIN upd u ON u.id = p.id
         WHERE p.reason_tags IS DISTINCT FROM u.reason_tags

         UNION ALL
         SELECT p.id, 'assign', NULL, NULL, u.updated_by, NULL,
                COALESCE((SELECT name FROM allowed_users a WHERE a.phone = u.assigned_to), 'unassigned')
         FROM prev p JOIN upd u ON u.id = p.id
         WHERE p.assigned_to IS DISTINCT FROM u.assigned_to
       ) AS changes(cart_id, kind, from_status, to_status, actor, note_len, detail)
     )
     SELECT upd.*,
            (SELECT name FROM allowed_users u WHERE u.phone = upd.assigned_to) AS assigned_to_name
     FROM upd`,
    [id, status ?? null, notes ?? null, callbackAt ?? null, callbackAt !== undefined,
     reasonTags ?? null, updatedBy ?? null, assignedTo ?? null, assignedTo !== undefined]);
  return rows[0] || null;
}

/** Just the callback time, for validating a status change without a full read. */
export async function callbackAtOf(id) {
  const { rows } = await getPool().query(
    'SELECT callback_at FROM abandoned_carts WHERE id = $1', [id]);
  return rows[0] ? rows[0].callback_at : undefined;
}

/** Everything that has happened to one cart, oldest first — a call history. */
export async function cartEvents(cartId, { limit = 100 } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, kind, from_status, to_status, actor, detail, note_len, at
     FROM cart_events WHERE cart_id = $1
     ORDER BY at ASC, id ASC LIMIT ${Number(limit)}`, [cartId]);
  return rows;
}

/** The whole board's activity, newest first, with enough cart context to read it. */
export async function recentEvents({ limit = 100, actor = null } = {}) {
  const params = [];
  let where = '';
  if (actor) { params.push(actor); where = 'WHERE e.actor = $1'; }
  const { rows } = await getPool().query(
    `SELECT e.id, e.kind, e.from_status, e.to_status, e.actor, e.detail, e.at,
            e.cart_id, c.customer_name, c.phone, c.total_price
     FROM cart_events e
     LEFT JOIN abandoned_carts c ON c.id = e.cart_id
     ${where}
     ORDER BY e.at DESC, e.id DESC LIMIT ${Number(limit)}`, params);
  return rows;
}

/**
 * Auto-recovery from a completed order event. Matches on the last 10 digits of
 * the phone, or the email, and only upgrades from statuses that mean "still
 * open" — a human who marked a cart Declined or Recovered is never overridden.
 */
const AUTO_UPGRADABLE = ['Not called', 'Called – No answer', 'Callback scheduled'];

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

// Same calendar-day boundary as the board, so the insight panels always agree
// with the list above them.
const sinceClause = (days) => (days > 0
  ? `received_at >= ${dayWindowSql(String(Number(days)))}`
  : 'TRUE');

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
    `SELECT phone, name, active, is_admin, coalesce(role, 'caller') AS role, added_at, added_by, last_seen_at,
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

export async function updateMember(phone, { name, active, isAdmin, role }) {
  const { rows } = await getPool().query(
    `UPDATE allowed_users SET
       name     = COALESCE($2, name),
       active   = COALESCE($3, active),
       is_admin = COALESCE($4, is_admin),
       role     = COALESCE($5, role)
     WHERE phone = $1
     RETURNING phone, name, active, is_admin, coalesce(role, 'caller') AS role, added_at, added_by`,
    [phone, name ?? null, active ?? null, isAdmin ?? null, role ?? null]);
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

/**
 * Moves a member to a new number, keeping their name, role, and when they were
 * added. Phone is the primary key, so this is a move rather than an update —
 * done in a transaction so a failure can't drop someone off the allowlist.
 *
 * Their history in login_log and member_log stays under the old number on
 * purpose: rewriting an audit trail to match the present is how audit trails
 * stop being useful.
 */
export async function changeMemberPhone(oldPhone, newPhone) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT phone FROM allowed_users WHERE phone = $1', [newPhone]);
    if (existing.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'taken' };
    }
    const { rows } = await client.query(
      `UPDATE allowed_users SET phone = $2 WHERE phone = $1
       RETURNING phone, name, active, is_admin, added_at, added_by`,
      [oldPhone, newPhone]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'missing' };
    }
    await client.query('COMMIT');
    return { ok: true, member: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Presence. Written on authenticated requests, throttled by the membership
 * cache in auth-routes so it is roughly one write per person per minute rather
 * than one per request. "Online" is then last_seen within a few minutes — good
 * enough to answer "who is working the list right now" without websockets.
 */
export async function touchLastSeen(phone) {
  await getPool().query(
    'UPDATE allowed_users SET last_seen_at = now() WHERE phone = $1', [phone]);
}

export async function whoIsOnline(withinMinutes = 5) {
  const { rows } = await getPool().query(
    `SELECT phone, name, is_admin, last_seen_at,
            EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS seconds_ago
     FROM allowed_users
     WHERE active AND last_seen_at > now() - ($1 || ' minutes')::interval
     ORDER BY last_seen_at DESC`, [String(withinMinutes)]);
  return rows;
}

// ---------------------------------------------------------------------------
// Admin overview
// ---------------------------------------------------------------------------

/**
 * Everything an admin needs to answer "is this working?" in one query set,
 * over the same calendar-day window the board uses so the numbers agree.
 */
export async function adminOverview(days = 7) {
  const where = `WHERE ${sinceClause(days)}`;

  const [funnel, speed, byDay, stages, risk, utm, bySource, callers] = await Promise.all([
    getPool().query(`
      SELECT count(*)::int AS carts,
             COALESCE(SUM(total_price), 0)::float AS value,
             count(*) FILTER (WHERE status <> 'Not called')::int AS worked,
             count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value,
             count(*) FILTER (WHERE status = 'Called – Declined')::int AS declined,
             -- Money splits three ways and the split is the whole point: a cart
             -- nobody has called yet is still open, not lost. Merging the two
             -- makes an untouched backlog look like customers who said no.
             COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Declined'), 0)::float AS declined_value,
             COALESCE(SUM(total_price) FILTER (WHERE status NOT IN ('Called – Recovered', 'Called – Declined')), 0)::float AS open_value,
             count(*) FILTER (WHERE status = 'Callback scheduled')::int AS callbacks,
             count(*) FILTER (WHERE assigned_to IS NOT NULL)::int AS assigned,
             count(*) FILTER (WHERE status = 'Callback scheduled' AND callback_at < now())::int AS overdue
      FROM abandoned_carts ${where}`),

    // How long carts wait before anyone touches them — the number that says
    // whether the team is actually keeping up.
    getPool().query(`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (status_updated_at - received_at))
        )::int AS median_seconds_to_first_touch
      FROM abandoned_carts
      ${where} AND status <> 'Not called' AND status_updated_at IS NOT NULL`),

    getPool().query(`
      SELECT to_char(COALESCE(abandoned_at, received_at) AT TIME ZONE '${BOARD_TZ}', 'YYYY-MM-DD') AS day,
             count(*)::int AS carts,
             count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
             COALESCE(SUM(total_price), 0)::float AS value,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value
      FROM abandoned_carts ${where}
      -- Bucketed by when the customer abandoned, not when we ingested it:
      -- "carts on Tuesday" means Tuesday's shoppers. The SLA clock above still
      -- runs on received_at, which is when the work actually landed on us.
      GROUP BY 1 ORDER BY 1`),

    // GoKwik only. Shopify never sends a drop stage, so including those carts
    // produced a fat "Unknown" bar that meant "we don't collect this", not
    // "we don't know" — the reader cannot tell those apart, so we exclude them
    // and say so in the panel header instead.
    getPool().query(`
      SELECT COALESCE(drop_stage, 'Unknown') AS label, count(*)::int AS n
      FROM abandoned_carts ${where} AND source = 'gokwik'
      GROUP BY 1 ORDER BY n DESC LIMIT 6`),

    // Risk is grouped by source deliberately. GoKwik's RTO flag and Shopify's
    // Risk Level are different vocabularies that happen to share the words
    // High/Medium/Low; stacking them in one bar was a wrong number, not merely
    // a vague one.
    getPool().query(`
      SELECT COALESCE(risk_flag, 'Unflagged') AS label, source, count(*)::int AS n
      FROM abandoned_carts ${where}
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`),

    getPool().query(`
      SELECT COALESCE(utm_source, 'unknown') AS label, count(*)::int AS n,
             COALESCE(SUM(total_price), 0)::float AS value
      FROM abandoned_carts ${where} GROUP BY 1 ORDER BY n DESC LIMIT 6`),

    // Where carts come from, and — just as usefully — which fields each source
    // can actually fill. The has_* counts drive the honest labelling on the
    // panels above, so those stay true if Shopify ever starts sending more.
    getPool().query(`
      SELECT source,
             count(*)::int AS carts,
             COALESCE(SUM(total_price), 0)::float AS value,
             count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
             count(*) FILTER (WHERE drop_stage IS NOT NULL)::int AS has_stage,
             count(*) FILTER (WHERE risk_flag IS NOT NULL)::int AS has_risk,
             count(*) FILTER (WHERE utm_source IS NOT NULL)::int AS has_utm
      FROM abandoned_carts ${where} GROUP BY 1 ORDER BY carts DESC`),

    getPool().query(`
      SELECT updated_by AS caller,
             count(*)::int AS touched,
             count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
             COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value
      FROM abandoned_carts
      ${where} AND updated_by IS NOT NULL
      GROUP BY 1 ORDER BY touched DESC`),
  ]);

  return {
    totals: funnel.rows[0],
    medianSecondsToFirstTouch: speed.rows[0].median_seconds_to_first_touch,
    byDay: byDay.rows,
    stages: stages.rows,
    risk: risk.rows,
    // utm_source (the marketing channel) and source (which system sent us the
    // cart) are different things. Naming both "source" on one page is exactly
    // the confusion this rewrite is meant to remove.
    utm: utm.rows,
    bySource: bySource.rows,
    callers: callers.rows.map((c) => ({
      ...c,
      recovery_rate: c.touched ? Math.round((c.recovered / c.touched) * 100) : 0,
    })),
  };
}

/**
 * Today, with yesterday beside it for contrast.
 *
 * Independent of the range selector on purpose: "how is today going" is the
 * question an owner opens the page to ask, and it should not change meaning
 * because the range happens to be set to 30 days. Days are BOARD_TZ calendar
 * days and bucket on when the customer abandoned, matching every other trend.
 */
export async function dailySnapshot() {
  const day = `date_trunc('day', COALESCE(abandoned_at, received_at) AT TIME ZONE '${BOARD_TZ}')`;
  const today = `date_trunc('day', (now() AT TIME ZONE '${BOARD_TZ}'))`;
  const { rows } = await getPool().query(`
    SELECT CASE WHEN ${day} = ${today} THEN 'today' ELSE 'yesterday' END AS bucket,
           count(*)::int AS carts,
           COALESCE(SUM(total_price), 0)::float AS value,
           count(*) FILTER (WHERE status <> 'Not called')::int AS called,
           count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
           COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value
    FROM abandoned_carts
    WHERE ${day} >= ${today} - interval '1 day'
    GROUP BY 1`);
  const blank = { carts: 0, value: 0, called: 0, recovered: 0, recovered_value: 0 };
  return {
    today: rows.find((r) => r.bucket === 'today') ?? blank,
    yesterday: rows.find((r) => r.bucket === 'yesterday') ?? blank,
  };
}

/**
 * The four questions an owner asks that the range buttons must NOT apply to.
 *
 * A callback overdue since last month still needs ringing today, so filtering
 * this by "last 7 days" would hide exactly the work that has been ignored
 * longest. Every bucket here is all-time by design.
 *
 * Held as SQL fragments in one place because the counts and the drill-down rows
 * must come from the same predicate. Kept apart, they drift within a month and
 * then the number and the list it opens disagree.
 */
export const ACTION_BUCKETS = {
  unassigned: "status = 'Not called' AND assigned_to IS NULL",
  callbacks_today:
    `status = 'Callback scheduled'
     AND callback_at >= (date_trunc('day', (now() AT TIME ZONE '${BOARD_TZ}'))) AT TIME ZONE '${BOARD_TZ}'
     AND callback_at <  (date_trunc('day', (now() AT TIME ZONE '${BOARD_TZ}')) + interval '1 day') AT TIME ZONE '${BOARD_TZ}'`,
  callbacks_overdue: "status = 'Callback scheduled' AND callback_at < now()",
  // $1 is the SLA hour count, supplied by the caller.
  stale: "status = 'Not called' AND received_at < now() - ($1 || ' hours')::interval",
};

/** All four counts in one scan, with the money each represents. */
export async function actionQueue(slaHours) {
  const money = (pred) => `COALESCE(SUM(total_price) FILTER (WHERE ${pred}), 0)::float`;
  const { rows } = await getPool().query(`
    SELECT
      count(*) FILTER (WHERE ${ACTION_BUCKETS.unassigned})::int        AS unassigned,
      ${money(ACTION_BUCKETS.unassigned)}                              AS unassigned_value,
      count(*) FILTER (WHERE ${ACTION_BUCKETS.callbacks_today})::int   AS callbacks_today,
      count(*) FILTER (WHERE ${ACTION_BUCKETS.callbacks_overdue})::int AS callbacks_overdue,
      count(*) FILTER (WHERE ${ACTION_BUCKETS.stale})::int             AS stale,
      ${money(ACTION_BUCKETS.stale)}                                   AS stale_value
    FROM abandoned_carts`, [String(slaHours)]);
  return rows[0];
}

/** The rows behind one action-queue number. Same predicate, so they agree. */
export async function cartsForBucket(bucket, { slaHours = 6, limit = 200 } = {}) {
  const pred = ACTION_BUCKETS[bucket];
  if (!pred) throw new Error(`Unknown bucket: ${bucket}`);
  // Only the stale predicate takes the SLA hours; binding a parameter the
  // statement never mentions is an error, so the fragment decides.
  const params = pred.includes('$1') ? [String(slaHours)] : [];
  const { rows } = await getPool().query(
    `SELECT ${CART_COLUMNS} FROM abandoned_carts
     WHERE ${pred}
     ORDER BY callback_at ASC NULLS LAST, total_price DESC NULLS LAST
     LIMIT ${Number(limit)}`, params);
  return rows.map(toCart);
}

/**
 * Day / week / month rollup.
 *
 * Buckets are computed in BOARD_TZ so a "day" is the team's day, not UTC's —
 * at IST+5:30 a UTC rollup would push every evening cart into tomorrow.
 */
export async function periodReport(period = 'day', limit = 12) {
  const unit = { day: 'day', week: 'week', month: 'month' }[period];
  if (!unit) throw new Error(`Unknown period: ${period}`);

  // Returned as text, not a timestamp. A `timestamp without time zone` comes
  // back as a local JS Date, and toISOString() then shifts it by the offset —
  // which silently moves every IST bucket to the previous day.
  const { rows } = await getPool().query(`
    SELECT to_char(date_trunc('${unit}', COALESCE(abandoned_at, received_at) AT TIME ZONE '${BOARD_TZ}'), 'YYYY-MM-DD') AS bucket,
           count(*)::int AS carts,
           COALESCE(SUM(total_price), 0)::float AS cart_value,
           count(*) FILTER (WHERE status <> 'Not called')::int AS worked,
           count(*) FILTER (WHERE status = 'Called – Recovered')::int AS recovered,
           COALESCE(SUM(total_price) FILTER (WHERE status = 'Called – Recovered'), 0)::float AS recovered_value,
           count(*) FILTER (WHERE status = 'Called – Declined')::int AS declined,
           count(*) FILTER (WHERE status = 'Not called')::int AS never_called
    FROM abandoned_carts
    -- Bounded by the number of buckets actually displayed. Without this the
    -- query scanned every row ever received and then threw away all but the
    -- last few, which also meant the table's row count did not match its label.
    WHERE COALESCE(abandoned_at, received_at) >=
          (date_trunc('${unit}', (now() AT TIME ZONE '${BOARD_TZ}'))
           - make_interval(${unit}s => $1 - 1)) AT TIME ZONE '${BOARD_TZ}'
    GROUP BY 1 ORDER BY 1 DESC LIMIT $1`, [limit]);

  return rows.map((r) => ({
    ...r,
    // Rate against carts *worked*, not carts received: you cannot recover a
    // cart nobody called, and mixing the two hides whether calling works.
    recovery_rate: r.worked ? Math.round((r.recovered / r.worked) * 100) : 0,
    contact_rate: r.carts ? Math.round((r.worked / r.carts) * 100) : 0,
  }));
}

/** The carts behind a headline number, for drilling into it. */
export async function cartsByStatus(status, { sinceDays = 0, limit = 500 } = {}) {
  const windowed = Number(sinceDays) > 0;
  const clauses = ['status = $1'];
  const params = [status];
  if (windowed) { params.push(Number(sinceDays)); clauses.push(`received_at >= ${dayWindowSql('$2::int')}`); }
  params.push(limit);

  const { rows } = await getPool().query(
    `SELECT ${CART_COLUMNS} FROM abandoned_carts
     WHERE ${clauses.join(' AND ')}
     ORDER BY status_updated_at DESC NULLS LAST, received_at DESC
     LIMIT $${params.length}`, params);
  return rows.map(toCart);
}

/**
 * Bulk insert of carts that did not arrive by webhook — a Shopify CSV export, or
 * the Shopify Admin API poller.
 *
 * received_at is always now(), never the cart's abandoned_at. The two columns
 * mean different things and conflating them broke both: abandoned_at is when the
 * customer walked away, received_at is when the cart reached the team. A CSV
 * imported a week late must not read as a week-old SLA breach against callers
 * who only just got it. Trends bucket on abandoned_at instead — see adminOverview.
 *
 * Uses the same ON CONFLICT semantics as the webhook path: re-importing the same
 * file, or re-polling the same checkout, updates the cart fields and **never**
 * touches status, notes, callback_at, reason_tags or updated_by. Importing twice
 * is safe by design — people will do it.
 */
export async function importCarts(carts, { source = 'import', assignedTo = null } = {}) {
  let inserted = 0;
  let updated = 0;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const c of carts) {
      const { rows } = await client.query(
        `INSERT INTO abandoned_carts
           (cart_id, customer_name, phone, email, total_price, currency, checkout_url,
            item_count, abandoned_at, raw_payload, mrp_total, discount_total, drop_stage,
            drop_reason, risk_flag, utm_source, address, subtotal, utm_campaign, utm_medium,
            gokwik_email_sent, gokwik_message_queued, brand_order_count, source,
            received_at, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24, now(), $25)
         ON CONFLICT (cart_id) DO UPDATE SET
           customer_name = COALESCE(EXCLUDED.customer_name, abandoned_carts.customer_name),
           phone         = COALESCE(EXCLUDED.phone,         abandoned_carts.phone),
           email         = COALESCE(EXCLUDED.email,         abandoned_carts.email),
           total_price   = COALESCE(EXCLUDED.total_price,   abandoned_carts.total_price),
           subtotal      = COALESCE(EXCLUDED.subtotal,      abandoned_carts.subtotal),
           discount_total= COALESCE(EXCLUDED.discount_total,abandoned_carts.discount_total),
           currency      = COALESCE(EXCLUDED.currency,      abandoned_carts.currency),
           checkout_url  = COALESCE(EXCLUDED.checkout_url,  abandoned_carts.checkout_url),
           item_count    = COALESCE(EXCLUDED.item_count,    abandoned_carts.item_count),
           abandoned_at  = COALESCE(EXCLUDED.abandoned_at,  abandoned_carts.abandoned_at),
           address       = COALESCE(EXCLUDED.address,       abandoned_carts.address),
           utm_source    = COALESCE(EXCLUDED.utm_source,    abandoned_carts.utm_source),
           risk_flag     = COALESCE(EXCLUDED.risk_flag,     abandoned_carts.risk_flag),
           raw_payload   = abandoned_carts.raw_payload || EXCLUDED.raw_payload,
           source        = EXCLUDED.source,
           -- Only fill the owner if nobody has claimed it; an import must never
           -- reassign a cart someone is already working.
           assigned_to   = COALESCE(abandoned_carts.assigned_to, EXCLUDED.assigned_to)
         RETURNING (xmax <> 0) AS was_update`,
        [c.cartId, c.customerName, c.phone, c.email, c.totalPrice, c.currency, c.checkoutUrl,
         c.itemCount, c.abandonedAt, JSON.stringify(c.raw ?? {}), c.mrpTotal, c.discountTotal,
         c.dropStage, c.dropReason, c.riskFlag, c.utmSource, c.address, c.subtotal,
         c.utmCampaign, c.utmMedium, c.gokwikEmailSent, c.gokwikMessageQueued,
         c.brandOrderCount, source, assignedTo]);
      if (rows[0].was_update) updated += 1; else inserted += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { inserted, updated, total: carts.length };
}
