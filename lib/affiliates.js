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
    let paths = [];
    if (ids.length && (await client.query(`SELECT to_regclass('professional_documents') AS t`)).rows[0].t) {
      const apps = 'SELECT id FROM verification_applications WHERE affiliate_id = ANY($1)';
      paths = (await client.query(`DELETE FROM professional_documents WHERE verification_application_id IN (${apps}) RETURNING storage_key`, [ids])).rows.map((r) => r.storage_key);
      await client.query('DELETE FROM verification_applications WHERE affiliate_id = ANY($1)', [ids]);
      await client.query('DELETE FROM professional_profiles WHERE affiliate_id = ANY($1)', [ids]);
    }
    if (ids.length) {
      await client.query('DELETE FROM affiliate_events WHERE affiliate_id = ANY($1)', [ids]);
      await client.query('DELETE FROM affiliate_rates WHERE affiliate_id = ANY($1)', [ids]);
      await client.query('DELETE FROM affiliates WHERE id = ANY($1)', [ids]);
    }
    await client.query('DELETE FROM affiliate_events WHERE affiliate_id IS NULL AND actor = $1', [actor]);
    await client.query('COMMIT');
    return { affiliates: ids.length, paths };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/* ======================================================================
 * Phase 1C — internal admin: create, search, inspect, edit, suspend /
 * reactivate / close, and rate history. No verification, attribution,
 * commissions or payouts: those phases build on these records.
 * ==================================================================== */

export const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const clean = (v, max) => { const s = String(v ?? '').trim().replace(/\s+/g, ' '); return s ? s.slice(0, max) : null; };

/**
 * The lifecycle Phase 1C supports. Conservative by design:
 *   create         → pending_verification if the category requires verification,
 *                    otherwise draft. Never active, never approved.
 *   activate       draft → active, only for a category that needs no verification
 *                  (approved → active too; only verification, a later phase, makes "approved")
 *   suspend        active | approved → suspended (reason required)
 *   reactivate     suspended → the status it had when suspended
 *   close          any status except closed → closed (reason required). Terminal.
 *   category change to one that requires verification moves draft / active /
 *                  approved to pending_verification (never silently verified);
 *                  to one that does not, pending_verification goes back to draft.
 * Nothing is ever deleted.
 */
export const AFFILIATE_TRANSITIONS = {
  activate: { from: ['draft', 'approved'], label: 'Activate' },
  suspend: { from: ['active', 'approved'], label: 'Suspend', reason: true },
  reactivate: { from: ['suspended'], label: 'Reactivate' },
  close: { from: ['draft', 'pending_verification', 'approved', 'active', 'suspended'], label: 'Close', reason: true },
};
// Sort keys a request may use, each mapped to a fixed expression: user input never reaches ORDER BY.
export const AFFILIATE_SORTS = {
  created: 'created_at', name: 'lower(display_name)', status: 'status', category: 'lower(category_label)', activity: 'last_activity_at',
};
const MAX_REASON = 300;

/** True when the affiliate's latest verification application is approved (false before Phase 1D's tables exist). */
export async function hasApprovedVerification(db, affiliateId) {
  if (!(await db.query(`SELECT to_regclass('verification_applications') AS t`)).rows[0].t) return false;
  const { rows: [r] } = await db.query('SELECT status FROM verification_applications WHERE affiliate_id = $1 ORDER BY id DESC LIMIT 1', [affiliateId]);
  return r?.status === 'approved';
}

async function categoryOf(db, key) {
  const k = clean(key, 40);
  if (!k) throw bad('Choose a category.', 400, { field: 'category' });
  const { rows: [c] } = await db.query('SELECT key, label, requires_verification, active FROM affiliate_categories WHERE key = $1', [k]);
  if (!c || !c.active) throw bad('That category does not exist or is not active.', 400, { field: 'category' });
  return c;
}

async function profileInput(input, { partial = false } = {}) {
  const { normalizeEmail, normalizePhone } = await import('./hr.js');
  const out = {};
  if (!partial || 'display_name' in input) {
    const n = clean(input.display_name, 121);
    if (!n) throw bad('Enter a display name.', 400, { field: 'display_name' });
    if (n.length > 120) throw bad('The display name can be at most 120 characters.', 400, { field: 'display_name' });
    out.display_name = n;
  }
  for (const [k, norm] of [['contact_email', normalizeEmail], ['contact_phone', normalizePhone]]) {
    if (partial && !(k in input)) continue;
    const raw = String(input[k] ?? '').trim();
    if (!raw) { out[k] = null; continue; }
    try { out[k] = norm(raw); } catch (err) { throw bad(err.message, 400, { field: k }); }
  }
  return out;
}

/** Percent or basis points → validated integer bps (0–10000). Exact: no floating point. */
export function parseRateBps(input) {
  if (input?.rate_bps !== undefined && input.rate_bps !== null && input.rate_bps !== '') {
    const s = String(input.rate_bps).trim();
    if (!/^\d{1,5}$/.test(s) || Number(s) > 10000) throw bad('The rate must be between 0% and 100%.', 400, { field: 'rate' });
    return Number(s);
  }
  const p = String(input?.rate_percent ?? '').trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(p);
  if (!m) throw bad('Enter the rate as a percentage with at most 2 decimals, e.g. 12.5.', 400, { field: 'rate' });
  const bps = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (bps > 10000) throw bad('The rate must be between 0% and 100%.', 400, { field: 'rate' });
  return bps;
}
const hasRate = (input) => [input?.rate_bps, input?.rate_percent].some((v) => v !== undefined && v !== null && String(v).trim() !== '');

function effectiveFrom(v, now = new Date()) {
  if (v === undefined || v === null || v === '') return now;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad('The effective date is not a valid date.', 400, { field: 'effective_from' });
  // No retroactive rates: there are no commissions yet, and history must not be rewritten later.
  if (d.getTime() < now.getTime() - 5 * 60000) throw bad('A new rate cannot start in the past.', 400, { field: 'effective_from' });
  if (d.getTime() > now.getTime() + 366 * 86400000) throw bad('A new rate can start at most a year ahead.', 400, { field: 'effective_from' });
  return d;
}
export function reasonOf(v, { required = false, field = 'reason' } = {}) {
  const r = clean(v, MAX_REASON + 1);
  if (required && !r) throw bad('Give a reason.', 400, { field });
  if (r && r.length > MAX_REASON) throw bad(`Keep the reason under ${MAX_REASON} characters.`, 400, { field });
  return r;
}

export async function logAffiliateEvent(db, affiliateId, action, actor, metadata = {}, entity = 'affiliate', entityId = null) {
  await db.query(`INSERT INTO affiliate_events (actor, action, affiliate_id, entity, entity_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor || null, action, affiliateId, entity, entityId, JSON.stringify(metadata)]);
}

export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

/** Categories offered when creating or editing (active only). */
export async function listAffiliateCategories() {
  await ensureAffiliateSchema();
  const { rows } = await getPool().query('SELECT key, label, requires_verification FROM affiliate_categories WHERE active ORDER BY sort, label');
  return rows;
}

const LIST_COLUMNS = `a.public_id, a.display_name, a.contact_email, a.contact_phone, a.category, c.label AS category_label,
  c.requires_verification, a.status, a.created_at, a.updated_at,
  (SELECT r.rate_bps FROM affiliate_rates r WHERE r.affiliate_id = a.id AND r.effective_from <= now() ORDER BY r.effective_from DESC LIMIT 1) AS current_rate_bps,
  (SELECT max(e.at) FROM affiliate_events e WHERE e.affiliate_id = a.id) AS last_activity_at`;

/**
 * The admin list: search (name, email, phone, public id), category and status
 * filters, a whitelisted sort, limit/offset paging. KPI counts are over every
 * affiliate, not the filtered set.
 */
export async function listAffiliates({ q, category, status, sort = 'created', dir = 'desc', limit = 50, offset = 0 } = {}) {
  await ensureAffiliateSchema();
  const where = []; const p = [];
  const term = clean(q, 120);
  if (term) {
    p.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const like = `$${p.length}`;
    const conds = [`a.display_name ILIKE ${like}`, `a.contact_email ILIKE ${like}`, `a.public_id ILIKE ${like}`];
    const digits = term.replace(/\D/g, '');
    if (digits.length >= 4) { p.push(`%${digits}%`); conds.push(`regexp_replace(coalesce(a.contact_phone, ''), '\\D', '', 'g') LIKE $${p.length}`); }
    where.push(`(${conds.join(' OR ')})`);
  }
  if (category) { p.push(String(category)); where.push(`a.category = $${p.length}`); }
  if (status) {
    if (!AFFILIATE_STATUSES.includes(status)) throw bad('Unknown status.', 400, { field: 'status' });
    p.push(status); where.push(`a.status = $${p.length}`);
  }
  const order = Object.hasOwn(AFFILIATE_SORTS, sort) ? AFFILIATE_SORTS[sort] : AFFILIATE_SORTS.created;
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const off = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getPool();
  const [{ rows }, { rows: [{ total }] }, { rows: counts }] = await Promise.all([
    db.query(`SELECT * FROM (SELECT ${LIST_COLUMNS} FROM affiliates a JOIN affiliate_categories c ON c.key = a.category ${W}) x
              ORDER BY ${order} ${direction} NULLS LAST, public_id LIMIT ${lim} OFFSET ${off}`, p),
    db.query(`SELECT count(*)::int AS total FROM affiliates a JOIN affiliate_categories c ON c.key = a.category ${W}`, p),
    db.query('SELECT status, count(*)::int AS n FROM affiliates GROUP BY status'),
  ]);
  const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return {
    affiliates: rows.map(toListRow), total, limit: lim, offset: off,
    kpis: { total: counts.reduce((n, r) => n + r.n, 0), active: by.active || 0, pending_verification: by.pending_verification || 0, suspended: by.suspended || 0 },
  };
}
const toListRow = (r) => ({
  public_id: r.public_id, display_name: r.display_name, contact_email: r.contact_email, contact_phone: r.contact_phone,
  category: r.category, category_label: r.category_label, requires_verification: r.requires_verification, status: r.status,
  current_rate_bps: r.current_rate_bps ?? null, created_at: r.created_at, updated_at: r.updated_at, last_activity_at: r.last_activity_at,
});

export async function lockAffiliate(db, publicId) {
  const pid = String(publicId || '').toUpperCase();
  if (!/^[A-HJKMNP-Z2-9]{6,12}$/.test(pid)) throw bad('No such affiliate.', 404);
  const { rows: [a] } = await db.query(
    `SELECT a.*, c.label AS category_label, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category
     WHERE a.public_id = $1 FOR UPDATE OF a`, [pid]);
  if (!a) throw bad('No such affiliate.', 404);
  return a;
}
export const checkVersion = (a, version) => {
  if (version !== undefined && version !== null && Number(version) !== a.version) {
    throw bad('Someone else changed this affiliate since you opened it. Reload to see their change.', 409, { conflict: true });
  }
};

const EVENT_TEXT = {
  affiliate_created: 'Affiliate created', affiliate_updated: 'Profile updated', affiliate_status_changed: 'Status changed',
  affiliate_suspended: 'Suspended', affiliate_reactivated: 'Reactivated', affiliate_rate_added: 'Rate added', affiliate_closed: 'Closed',
  // Phase 1D — professional verification
  professional_profile_created: 'Professional profile created', professional_profile_updated: 'Professional profile updated',
  verification_application_created: 'Verification application started', verification_submitted: 'Verification submitted',
  verification_under_review: 'Verification under review', verification_approved: 'Verification approved',
  verification_rejected: 'Verification rejected', verification_resubmitted: 'New verification application after rejection',
  professional_document_uploaded: 'Document uploaded', professional_document_viewed: 'Document opened',
};
const DOC_TYPE_TEXT = { certificate: 'Certificate', registration: 'Registration proof', other: 'Other document' };
const pct = (bps) => { const f = String(bps % 100).padStart(2, '0').replace(/0+$/, ''); return `${Math.trunc(bps / 100)}${f ? `.${f}` : ''}%`; };
// Dates in the activity log are India Standard Time, as everywhere else in Briyo OS.
const IST_DAY = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const FIELD_TEXT = { display_name: 'display name', contact_email: 'email', contact_phone: 'phone', category: 'category' };
const STATUS_TEXT = { draft: 'Draft', pending_verification: 'Pending verification', approved: 'Approved', active: 'Active', suspended: 'Suspended', closed: 'Closed',
  // verification applications (Phase 1D)
  submitted: 'Submitted', under_review: 'Under review', rejected: 'Rejected' };
/** A readable line for an event. Only whitelisted metadata is used; raw JSON never leaves the server. */
function eventSummary(e) {
  const m = e.metadata || {};
  const parts = [];
  if (m.from && m.to) parts.push(`${STATUS_TEXT[m.from] || m.from} → ${STATUS_TEXT[m.to] || m.to}`);
  if (Array.isArray(m.fields) && m.fields.length) parts.push(`Changed ${m.fields.map((f) => FIELD_TEXT[f] || f).join(', ')}`);
  if (m.category_from && m.category_to) parts.push(`Category ${m.category_from} → ${m.category_to}`);
  if (Number.isInteger(m.rate_bps)) parts.push(`${pct(m.rate_bps)} from ${IST_DAY.format(new Date(m.effective_from))}`);
  if (m.status && !m.from) parts.push(STATUS_TEXT[m.status] || m.status);
  if (m.document_type) parts.push(`${DOC_TYPE_TEXT[m.document_type] || m.document_type}${m.document ? ` ${m.document}` : ''}`);
  if (m.application && !m.document) parts.push(`Application ${m.application}`);
  if (m.previous_application) parts.push(`after ${m.previous_application}`);
  if (m.reason) parts.push(`Reason: ${m.reason}`);
  if (m.review_notes) parts.push(`Notes: ${m.review_notes}`);
  if (m.note) parts.push(m.note);
  return parts.join(' · ');
}

/** One affiliate for the detail page: profile, rate history, activity. No internal ids. */
export async function getAffiliate(publicId) {
  await ensureAffiliateSchema();
  const pid = String(publicId || '').toUpperCase();
  if (!/^[A-HJKMNP-Z2-9]{6,12}$/.test(pid)) return null;
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.*, c.label AS category_label, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`, [pid]);
  if (!a) return null;
  const [{ rows: rates }, { rows: events }] = await Promise.all([
    db.query(`SELECT rate_bps, effective_from, reason, created_by, created_at, effective_from <= now() AS in_effect
              FROM affiliate_rates WHERE affiliate_id = $1 ORDER BY effective_from DESC`, [a.id]),
    db.query(`SELECT at, actor, action, entity, metadata FROM affiliate_events WHERE affiliate_id = $1 ORDER BY at DESC, id DESC LIMIT 200`, [a.id]),
  ]);
  const current = rates.find((r) => r.in_effect) || null;
  return {
    affiliate: {
      public_id: a.public_id, display_name: a.display_name, contact_email: a.contact_email, contact_phone: a.contact_phone,
      category: a.category, category_label: a.category_label, requires_verification: a.requires_verification, status: a.status,
      suspension_reason: a.status === 'suspended' ? a.suspension_reason : null, suspended_at: a.status === 'suspended' ? a.suspended_at : null,
      suspended_by: a.status === 'suspended' ? a.suspended_by : null, activated_at: a.activated_at,
      created_at: a.created_at, created_by: a.created_by, updated_at: a.updated_at, updated_by: a.updated_by, version: a.version,
      current_rate_bps: current?.rate_bps ?? null,
      transitions: Object.entries(AFFILIATE_TRANSITIONS).filter(([k, t]) => t.from.includes(a.status)
        && !(k === 'activate' && a.status === 'draft' && a.requires_verification)).map(([k]) => k),
    },
    rates: rates.map((r) => ({ rate_bps: r.rate_bps, effective_from: r.effective_from, reason: r.reason, created_by: r.created_by, created_at: r.created_at,
      state: r === current ? 'current' : r.in_effect ? 'past' : 'scheduled' })),
    events: events.map((e) => ({ at: e.at, actor: e.actor, action: e.action, label: EVENT_TEXT[e.action] || e.action.replace(/_/g, ' '),
      entity: e.entity, summary: eventSummary(e) })),
  };
}

/** Creates an affiliate (server-generated public id) with an optional initial rate. */
export async function createAffiliate(input = {}, { actor } = {}) {
  await ensureAffiliateSchema();
  const prof = await profileInput(input);
  const withRate = hasRate(input);
  const bps = withRate ? parseRateBps(input) : null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await tx(async (db) => {
        const cat = await categoryOf(db, input.category);
        const status = cat.requires_verification ? 'pending_verification' : 'draft';
        const publicId = newAffiliatePublicId();
        const { rows: [a] } = await db.query(
          `INSERT INTO affiliates (public_id, category, display_name, contact_email, contact_phone, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, public_id`,
          [publicId, cat.key, prof.display_name, prof.contact_email, prof.contact_phone, status, actor || null]);
        await logAffiliateEvent(db, a.id, 'affiliate_created', actor, { category: cat.key, status }, 'affiliate', a.public_id);
        if (withRate) {
          const at = new Date();
          await db.query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by, reason) VALUES ($1, $2, $3, $4, $5)`,
            [a.id, bps, at, actor || null, reasonOf(input.rate_reason) || 'Initial rate']);
          await logAffiliateEvent(db, a.id, 'affiliate_rate_added', actor, { rate_bps: bps, effective_from: at.toISOString(), reason: reasonOf(input.rate_reason) || 'Initial rate' }, 'rate', a.public_id);
        }
        return a.public_id;
      }).then((pid) => getAffiliate(pid));
    } catch (err) {
      if (err.code === '23505' && /public_id/.test(err.constraint || err.message)) continue;
      throw err;
    }
  }
  throw bad('Could not issue a unique public id. Try again.', 503);
}

/**
 * Edits the profile: display name, email, phone, category. Never the public
 * id, the rate or the status directly — a category change may only move the
 * status towards verification, never past it.
 */
export async function updateAffiliate(publicId, input = {}, { actor, version } = {}) {
  await ensureAffiliateSchema();
  for (const k of ['public_id', 'status', 'rate_bps', 'rate_percent', 'id']) if (k in input) throw bad(`${k === 'public_id' ? 'The public id' : k === 'status' ? 'The status' : 'The rate'} cannot be changed here.`, 400, { field: k });
  const prof = await profileInput(input, { partial: true });
  await tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    checkVersion(a, version);
    if (a.status === 'closed') throw bad('A closed affiliate cannot be edited.', 409);
    const sets = {}; const changed = [];
    for (const [k, v] of Object.entries(prof)) if ((a[k] ?? null) !== v) { sets[k] = v; changed.push(k); }
    const meta = {};
    let nextStatus = a.status;
    if ('category' in input && String(input.category || '') !== a.category) {
      const cat = await categoryOf(db, input.category);
      sets.category = cat.key; changed.push('category');
      meta.category_from = a.category; meta.category_to = cat.key;
      if (cat.requires_verification && ['draft', 'active', 'approved'].includes(a.status)) nextStatus = 'pending_verification';
      if (!cat.requires_verification && a.status === 'pending_verification') nextStatus = 'draft';
    }
    if (!changed.length) return;
    if (nextStatus !== a.status) sets.status = nextStatus;
    const keys = Object.keys(sets);
    await db.query(`UPDATE affiliates SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${keys.length + 2} WHERE id = $1`,
      [a.id, ...keys.map((k) => sets[k]), actor || null]);
    // Field names only for contact details: their values are personal data and stay off the audit trail.
    await logAffiliateEvent(db, a.id, 'affiliate_updated', actor, { fields: changed, ...meta }, 'affiliate', a.public_id);
    if (nextStatus !== a.status) {
      await logAffiliateEvent(db, a.id, 'affiliate_status_changed', actor, { from: a.status, to: nextStatus, note: 'Category change' }, 'affiliate', a.public_id);
    }
  });
  return getAffiliate(publicId);
}

/** Applies one lifecycle transition (AFFILIATE_TRANSITIONS). */
export async function setAffiliateStatus(publicId, action, { actor, version, reason } = {}) {
  await ensureAffiliateSchema();
  const t = AFFILIATE_TRANSITIONS[action];
  if (!t) throw bad('Unknown status change.', 400, { field: 'action' });
  const why = reasonOf(reason, { required: Boolean(t.reason) });
  await tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    checkVersion(a, version);
    if (!t.from.includes(a.status)) throw bad(`A${/^[aeiou]/i.test(STATUS_TEXT[a.status]) ? 'n' : ''} ${STATUS_TEXT[a.status].toLowerCase()} affiliate cannot be ${action === 'close' ? 'closed' : `${action}d`}.`, 409);
    let to;
    if (action === 'activate') {
      if (a.status === 'draft' && a.requires_verification) throw bad('This category requires professional verification before activation.', 409);
      to = 'active';
    } else if (action === 'suspend') to = 'suspended';
    else if (action === 'close') to = 'closed';
    else {
      // Back to where it was when suspended; never further.
      const { rows: [s] } = await db.query(
        `SELECT metadata->>'from' AS prev FROM affiliate_events WHERE affiliate_id = $1 AND action = 'affiliate_suspended' ORDER BY at DESC, id DESC LIMIT 1`, [a.id]);
      to = ['active', 'approved'].includes(s?.prev) ? s.prev : 'draft';
      // A professional goes back to active / approved only with an approved verification (Phase 1D).
      if (['active', 'approved'].includes(to) && a.requires_verification && !(await hasApprovedVerification(db, a.id))) to = 'pending_verification';
    }
    const extra = to === 'suspended' ? ', suspended_at = now(), suspended_by = $4, suspension_reason = $5'
      : to === 'active' && !a.activated_at ? ', activated_at = now()' : '';
    await db.query(`UPDATE affiliates SET status = $2, version = version + 1, updated_at = now(), updated_by = $3${extra} WHERE id = $1`,
      [a.id, to, actor || null, ...(to === 'suspended' ? [actor || null, why] : [])]);
    const name = { suspend: 'affiliate_suspended', reactivate: 'affiliate_reactivated', close: 'affiliate_closed' }[action] || 'affiliate_status_changed';
    await logAffiliateEvent(db, a.id, name, actor, { from: a.status, to, ...(why ? { reason: why } : {}) }, 'affiliate', a.public_id);
  });
  return getAffiliate(publicId);
}

/** Adds a rate from now or a future date. Earlier rows are never changed. */
export async function addAffiliateRate(publicId, input = {}, { actor, now = new Date() } = {}) {
  await ensureAffiliateSchema();
  const bps = parseRateBps(input);
  const from = effectiveFrom(input.effective_from, now);
  const why = reasonOf(input.reason, { required: true });
  await tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    if (a.status === 'closed') throw bad('A closed affiliate cannot get a new rate.', 409);
    try {
      await db.query('SAVEPOINT rate');
      await db.query(`INSERT INTO affiliate_rates (affiliate_id, rate_bps, effective_from, created_by, reason) VALUES ($1, $2, $3, $4, $5)`,
        [a.id, bps, from, actor || null, why]);
    } catch (err) {
      if (err.code === '23505') throw bad('A rate already starts at exactly that moment. Choose another start.', 409, { field: 'effective_from' });
      throw err;
    }
    await logAffiliateEvent(db, a.id, 'affiliate_rate_added', actor, { rate_bps: bps, effective_from: from.toISOString(), reason: why }, 'rate', a.public_id);
  });
  return getAffiliate(publicId);
}
