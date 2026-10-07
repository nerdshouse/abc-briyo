import crypto from 'node:crypto';
import { getPool } from './db.js';
import { assertMarkerIn } from './env-guard.js';

/**
 * Affiliates — the identity and configuration foundation (Phase 1A).
 *
 *   affiliate_categories  who a partner is (nutritionist, influencer, customer…), as data
 *   affiliates            the partner: opaque public id, category, contact, status
 *   affiliate_rates       commission-rate history in basis points; append-only, the
 *                         only source of an affiliate's rate (no "current rate" column)
 *   affiliate_settings    module configuration (attribution window, rule version)
 *   affiliate_events      the module's audit trail; append-only
 *
 * Nothing here attributes orders, calculates commission or pays anyone: those
 * come in later phases and will read from these tables. Statuses are valid
 * states only; workflow transitions are not implemented yet.
 *
 * Append-only tables are enforced by the database, as order_events and the
 * inventory ledger are: UPDATE and DELETE raise, except a DELETE inside a
 * transaction that sets app.purge_affiliates — used solely by the test suite.
 */

export const AFFILIATE_STATUSES = ['draft', 'pending_verification', 'approved', 'active', 'suspended', 'closed'];

const SEED_CATEGORIES = [
  ['nutritionist', 'Nutritionist', true, 10],
  ['dietitian', 'Dietitian', true, 20],
  ['doctor', 'Doctor', true, 30],
  ['dentist', 'Dentist', true, 40],
  ['other_professional', 'Other Professional', true, 50],
  ['influencer', 'Influencer', false, 60],
  ['creator', 'Creator', false, 70],
  ['customer', 'Customer', false, 80],
];

// Seeded once; an admin's later edit is never overwritten (ON CONFLICT DO NOTHING).
const SEED_SETTINGS = [
  ['attribution_window_days', 30],
  ['attribution_rule_version', 'v1'],
];

/**
 * Public ids: 6 characters from an alphabet without look-alikes (no 0/O, 1/I/L),
 * drawn with crypto.randomInt — opaque, non-sequential, safe to show. 31^6 ≈ 887
 * million; the UNIQUE constraint is the guarantee, so a caller retries on 23505.
 */
export const PUBLIC_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PUBLIC_ID_LENGTH = 6;
export function newAffiliatePublicId(length = PUBLIC_ID_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PUBLIC_ID_ALPHABET[crypto.randomInt(PUBLIC_ID_ALPHABET.length)];
  return out;
}

const list = (values) => values.map((v) => `'${v}'`).join(',');
/** Replaces a named CHECK so the allowed values track the constants above (as lib/orders.js does). */
const setCheck = (table, name, expr) => `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}, ADD CONSTRAINT ${name} CHECK (${expr})`;

let affiliateSchema = null;
export function ensureAffiliateSchema() {
  if (!affiliateSchema) {
    affiliateSchema = (async () => {
      const sql = getPool();
      // Idempotent DDL without parameters, sent as one batch (as lib/inventory.js does).
      const ddl = [];
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_categories (
          key                   TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
          label                 TEXT NOT NULL CHECK (btrim(label) <> ''),
          requires_verification BOOLEAN NOT NULL DEFAULT false,
          active                BOOLEAN NOT NULL DEFAULT true,
          sort                  INTEGER NOT NULL DEFAULT 100,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      ddl.push(`INSERT INTO affiliate_categories (key, label, requires_verification, sort) VALUES
        ${SEED_CATEGORIES.map(([k, l, v, s]) => `('${k}', '${l}', ${v}, ${s})`).join(',\n        ')}
        ON CONFLICT (key) DO NOTHING`);

      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliates (
          id                BIGSERIAL PRIMARY KEY,
          public_id         TEXT NOT NULL CHECK (public_id ~ '^[A-HJKMNP-Z2-9]{6,12}$'),
          category          TEXT NOT NULL REFERENCES affiliate_categories(key) ON UPDATE RESTRICT ON DELETE RESTRICT,
          display_name      TEXT NOT NULL CHECK (btrim(display_name) <> ''),
          contact_email     TEXT,
          contact_phone     TEXT,
          status            TEXT NOT NULL DEFAULT 'draft',
          suspended_at      TIMESTAMPTZ,
          suspended_by      TEXT,
          suspension_reason TEXT,
          activated_at      TIMESTAMPTZ,
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by        TEXT,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by        TEXT,
          CONSTRAINT affiliates_public_id_key UNIQUE (public_id)
        )`);
      ddl.push(setCheck('affiliates', 'affiliates_status_check', `status IN (${list(AFFILIATE_STATUSES)})`));
      ddl.push('CREATE INDEX IF NOT EXISTS affiliates_status_idx ON affiliates (status)');
      ddl.push('CREATE INDEX IF NOT EXISTS affiliates_category_idx ON affiliates (category)');
      // The public id is printed on links and codes: once issued it never changes.
      ddl.push(`
        CREATE OR REPLACE FUNCTION affiliates_public_id_immutable() RETURNS trigger AS $$
        BEGIN
          IF NEW.public_id IS DISTINCT FROM OLD.public_id THEN
            RAISE EXCEPTION 'affiliates.public_id is immutable';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      ddl.push('DROP TRIGGER IF EXISTS affiliates_public_id_immutable ON affiliates');
      ddl.push(`CREATE TRIGGER affiliates_public_id_immutable BEFORE UPDATE ON affiliates
                FOR EACH ROW EXECUTE FUNCTION affiliates_public_id_immutable()`);

      // Rate history. 1500 = 15%. One row per (affiliate, effective_from); a change
      // of rate is a new row. The rate on a date is the latest row effective by then.
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_rates (
          id             BIGSERIAL PRIMARY KEY,
          affiliate_id   BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          rate_bps       INTEGER NOT NULL CONSTRAINT affiliate_rates_rate_bps_check CHECK (rate_bps >= 0 AND rate_bps <= 10000),
          effective_from TIMESTAMPTZ NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by     TEXT,
          reason         TEXT,
          CONSTRAINT affiliate_rates_affiliate_effective_key UNIQUE (affiliate_id, effective_from)
        )`);

      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_settings (
          key        TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,60}$'),
          value      JSONB NOT NULL,
          version    INTEGER NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by TEXT
        )`);
      ddl.push(`INSERT INTO affiliate_settings (key, value, updated_by) VALUES
        ${SEED_SETTINGS.map(([k, v]) => `('${k}', '${JSON.stringify(v)}'::jsonb, 'system')`).join(',\n        ')}
        ON CONFLICT (key) DO NOTHING`);

      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_events (
          id           BIGSERIAL PRIMARY KEY,
          at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          actor        TEXT,
          action       TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{1,60}$'),
          affiliate_id BIGINT REFERENCES affiliates(id) ON DELETE RESTRICT,
          entity       TEXT,
          entity_id    TEXT,
          metadata     JSONB NOT NULL DEFAULT '{}'
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_events_affiliate_idx ON affiliate_events (affiliate_id, at DESC)');
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_events_at_idx ON affiliate_events (at DESC)');

      // Append-only: rates are financial history, events are the audit trail.
      ddl.push(`
        CREATE OR REPLACE FUNCTION affiliate_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND current_setting('app.purge_affiliates', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['affiliate_rates', 'affiliate_events']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_append_only ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
                  FOR EACH ROW EXECUTE FUNCTION affiliate_append_only()`);
      }
      await sql.query(ddl.join(';\n'));
    })().catch((err) => { affiliateSchema = null; throw err; });
  }
  return affiliateSchema;
}

/** Tests only: forget that the schema ran, so the next call runs the DDL again. */
export const _resetAffiliateSchemaForTest = () => { affiliateSchema = null; };

/**
 * The rate in force for an affiliate at a moment: the latest row effective by
 * then (ties are impossible: UNIQUE (affiliate_id, effective_from)). Null when
 * none applies yet. `db` is a pool or a transaction client.
 */
export async function rateAt(db, affiliateId, at = new Date()) {
  const { rows } = await db.query(
    `SELECT id, rate_bps, effective_from FROM affiliate_rates
     WHERE affiliate_id = $1 AND effective_from <= $2
     ORDER BY effective_from DESC LIMIT 1`, [affiliateId, at]);
  return rows[0] ? { id: Number(rows[0].id), rate_bps: rows[0].rate_bps, effective_from: rows[0].effective_from } : null;
}

/** A setting's value, or `fallback` when it is not set. */
export async function getAffiliateSetting(key, fallback = null) {
  await ensureAffiliateSchema();
  const { rows } = await getPool().query('SELECT value FROM affiliate_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

/** Sets a setting (insert or update), bumping its version. Returns the new version. */
export async function setAffiliateSetting(key, value, { actor } = {}) {
  await ensureAffiliateSchema();
  const { rows } = await getPool().query(
    `INSERT INTO affiliate_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = affiliate_settings.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING version`, [key, JSON.stringify(value), actor || null]);
  return rows[0].version;
}

/**
 * Test suite only: removes affiliates created by `actor` (and their rates and
 * events). Refused unless the database is labelled test or development.
 */
export async function purgeTestAffiliates(actor) {
  if (!actor || actor.length < 6) throw new Error('Refusing to purge without a specific test actor.');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await assertMarkerIn(client, ['test', 'development'], 'Test affiliate purge');
    await client.query(`SET LOCAL app.purge_affiliates = 'on'`);
    const { rows } = await client.query('SELECT id FROM affiliates WHERE created_by = $1', [actor]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await client.query('DELETE FROM affiliate_events WHERE affiliate_id = ANY($1)', [ids]);
      await client.query('DELETE FROM affiliate_rates WHERE affiliate_id = ANY($1)', [ids]);
      await client.query('DELETE FROM affiliates WHERE id = ANY($1)', [ids]);
    }
    await client.query('DELETE FROM affiliate_events WHERE affiliate_id IS NULL AND actor = $1', [actor]);
    await client.query('COMMIT');
    return { affiliates: ids.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
