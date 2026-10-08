import { APP_TIMEZONE } from './timezone.js';
import crypto from 'node:crypto';
import { getPool } from './db.js';
import { storage, validateDocument, newPrefixedKey, MAX_DOCUMENT_BYTES, DEFAULT_FORMATS } from './storage.js';
import {
  ensureAffiliateSchema, newAffiliatePublicId, bad, clean, tx, lockAffiliate, logAffiliateEvent,
} from './affiliates.js';

/**
 * Professional verification (Phase 1D):
 *   Affiliate → Professional profile → Verification application → Admin decision.
 *
 *   professional_profiles       one per affiliate: the professional identity and credential details
 *   verification_applications   the history of applications; the profile is copied into the
 *                               application when it is submitted, so a decision always refers to
 *                               exactly what was reviewed
 *   professional_documents      metadata of certificates and other evidence; the bytes live in
 *                               private storage (lib/storage.js), never in Postgres or a public URL
 *
 * Only categories with affiliate_categories.requires_verification take part. Nothing here activates
 * an affiliate: approval moves pending_verification → approved, and activation stays the separate
 * Phase 1C action. No referral asset is created.
 *
 * History is never destroyed (database triggers): decided applications (approved, rejected) cannot
 * be changed, documents cannot be changed, and none of the three tables accepts a DELETE — except
 * inside a transaction that sets app.purge_affiliates, which only the test suite's purge does.
 */

export const APPLICATION_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'rejected'];
const ACTIVE = ['draft', 'submitted', 'under_review'];
export const DOCUMENT_TYPES = ['certificate', 'registration', 'other'];
export const DOCUMENT_FORMATS = DEFAULT_FORMATS;            // pdf, png, jpg, jpeg — checked by content, not just the name
export const EXPIRING_SOON_DAYS = 30;
const IST = APP_TIMEZONE;

/**
 * Allowed application transitions. "Resubmit" is not an edit of the rejected
 * application: it opens a new draft application linked to it, so the rejection
 * stays on record exactly as it was decided.
 */
export const VERIFICATION_ACTIONS = {
  submit: { from: ['draft'], to: 'submitted', event: 'verification_submitted' },
  review: { from: ['submitted'], to: 'under_review', event: 'verification_under_review' },
  approve: { from: ['under_review'], to: 'approved', event: 'verification_approved' },
  reject: { from: ['submitted', 'under_review'], to: 'rejected', event: 'verification_rejected', reason: true },
};

const list = (v) => v.map((x) => `'${x}'`).join(',');
const refPattern = '^[A-HJKMNP-Z2-9]{10}$';

let schema = null;
export function ensureAffiliateVerificationSchema() {
  if (!schema) {
    schema = (async () => {
      await ensureAffiliateSchema();
      const ddl = [];
      ddl.push(`
        CREATE TABLE IF NOT EXISTS professional_profiles (
          id                     BIGSERIAL PRIMARY KEY,
          affiliate_id           BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          full_name              TEXT NOT NULL CHECK (btrim(full_name) <> '' AND length(full_name) <= 160),
          profession             TEXT NOT NULL CHECK (btrim(profession) <> '' AND length(profession) <= 120),
          qualification          TEXT CHECK (length(qualification) <= 200),
          institution            TEXT CHECK (length(institution) <= 200),
          registration_number    TEXT CHECK (length(registration_number) <= 80),
          registration_authority TEXT CHECK (length(registration_authority) <= 200),
          practice_name          TEXT CHECK (length(practice_name) <= 200),
          specialization         TEXT CHECK (length(specialization) <= 200),
          country                TEXT CHECK (length(country) <= 80),
          state                  TEXT CHECK (length(state) <= 80),
          city                   TEXT CHECK (length(city) <= 80),
          profile_notes          TEXT CHECK (length(profile_notes) <= 1000),
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by             TEXT,
          updated_by             TEXT,
          version                INTEGER NOT NULL DEFAULT 1,
          CONSTRAINT professional_profiles_affiliate_key UNIQUE (affiliate_id)
        )`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS verification_applications (
          id                      BIGSERIAL PRIMARY KEY,
          public_id               TEXT NOT NULL CHECK (public_id ~ '${refPattern}'),
          affiliate_id            BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          professional_profile_id BIGINT NOT NULL REFERENCES professional_profiles(id) ON DELETE RESTRICT,
          -- NO ACTION (still refuses deleting a referenced application) so the test purge can remove a chain in one statement.
          previous_application_id BIGINT REFERENCES verification_applications(id),
          status                  TEXT NOT NULL DEFAULT 'draft',
          profile_snapshot        JSONB,
          submitted_at            TIMESTAMPTZ,
          submitted_by            TEXT,
          review_started_at       TIMESTAMPTZ,
          review_started_by       TEXT,
          reviewed_at             TIMESTAMPTZ,
          reviewed_by             TEXT,
          rejection_reason        TEXT CHECK (length(rejection_reason) <= 1000),
          review_notes            TEXT CHECK (length(review_notes) <= 1000),
          version                 INTEGER NOT NULL DEFAULT 1,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by              TEXT,
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT verification_applications_public_id_key UNIQUE (public_id),
          CONSTRAINT verification_applications_rejection_reason CHECK (status <> 'rejected' OR btrim(coalesce(rejection_reason, '')) <> ''),
          CONSTRAINT verification_applications_decided CHECK (status NOT IN ('approved', 'rejected') OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
          CONSTRAINT verification_applications_submitted CHECK (status = 'draft' OR (submitted_at IS NOT NULL AND profile_snapshot IS NOT NULL))
        )`);
      ddl.push(`ALTER TABLE verification_applications DROP CONSTRAINT IF EXISTS verification_applications_status_check,
        ADD CONSTRAINT verification_applications_status_check CHECK (status IN (${list(APPLICATION_STATUSES)}))`);
      // One open application per affiliate, enforced by the database.
      ddl.push(`CREATE UNIQUE INDEX IF NOT EXISTS verification_applications_one_active
        ON verification_applications (affiliate_id) WHERE status IN (${list(ACTIVE)})`);
      ddl.push('CREATE INDEX IF NOT EXISTS verification_applications_affiliate_idx ON verification_applications (affiliate_id, id DESC)');
      ddl.push('CREATE INDEX IF NOT EXISTS verification_applications_status_idx ON verification_applications (status)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS professional_documents (
          id                          BIGSERIAL PRIMARY KEY,
          public_id                   TEXT NOT NULL CHECK (public_id ~ '${refPattern}'),
          verification_application_id BIGINT NOT NULL REFERENCES verification_applications(id) ON DELETE RESTRICT,
          document_type               TEXT NOT NULL,
          original_filename           TEXT NOT NULL CHECK (btrim(original_filename) <> '' AND length(original_filename) <= 200),
          content_type                TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
          byte_size                   BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= ${MAX_DOCUMENT_BYTES}),
          storage_key                 TEXT NOT NULL,
          sha256                      TEXT CHECK (sha256 ~ '^[0-9a-f]{64}$'),
          document_label              TEXT CHECK (length(document_label) <= 120),
          issued_at                   DATE,
          expires_at                  DATE,
          uploaded_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          uploaded_by                 TEXT,
          version                     INTEGER NOT NULL DEFAULT 1,
          CONSTRAINT professional_documents_public_id_key UNIQUE (public_id),
          CONSTRAINT professional_documents_storage_key_key UNIQUE (storage_key),
          CONSTRAINT professional_documents_dates CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
        )`);
      ddl.push(`ALTER TABLE professional_documents DROP CONSTRAINT IF EXISTS professional_documents_type_check,
        ADD CONSTRAINT professional_documents_type_check CHECK (document_type IN (${list(DOCUMENT_TYPES)}))`);
      ddl.push('CREATE INDEX IF NOT EXISTS professional_documents_application_idx ON professional_documents (verification_application_id)');
      // History protections.
      ddl.push(`
        CREATE OR REPLACE FUNCTION professional_verification_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.purge_affiliates', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
          END IF;
          IF TG_TABLE_NAME = 'professional_documents' THEN
            RAISE EXCEPTION 'professional_documents is append-only';
          END IF;
          -- Nested: plpgsql would resolve OLD.status even on tables without it.
          IF TG_TABLE_NAME = 'verification_applications' THEN
            IF OLD.status IN ('approved', 'rejected') THEN
              RAISE EXCEPTION 'a decided verification application is final';
            END IF;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['professional_profiles', 'verification_applications', 'professional_documents']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_guard ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_guard BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION professional_verification_guard()`);
      }
      await getPool().query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

/* ------------------------------------------------------------------ helpers */

const newRef = () => newAffiliatePublicId(10);
const PROFILE_FIELDS = {
  full_name: 160, profession: 120, qualification: 200, institution: 200, registration_number: 80, registration_authority: 200,
  practice_name: 200, specialization: 200, country: 80, state: 80, city: 80, profile_notes: 1000,
};
const LABEL = { full_name: 'Full name', profession: 'Profession', profile_notes: 'Notes' };

function profileInput(input, { partial = false } = {}) {
  const out = {};
  for (const [k, max] of Object.entries(PROFILE_FIELDS)) {
    if (partial && !(k in input)) continue;
    const raw = k === 'profile_notes' ? String(input[k] ?? '').trim() : clean(input[k], max + 1);
    const v = raw || null;
    if (v && v.length > max) throw bad(`${LABEL[k] || k.replace(/_/g, ' ')} can be at most ${max} characters.`, 400, { field: k });
    if (['full_name', 'profession'].includes(k) && !v) throw bad(`Enter the ${k === 'full_name' ? 'full name as on the credential' : 'profession'}.`, 400, { field: k });
    out[k] = v;
  }
  return out;
}

const dateOrNull = (v, field) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) {
    throw bad('Enter a valid date.', 400, { field });
  }
  return s;
};
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
/** expired / expiring_soon / valid / null — for display; never changes any status. */
export function expiryState(expiresOn, today = todayIst()) {
  if (!expiresOn) return null;
  const d = String(expiresOn).slice(0, 10);
  if (d < today) return 'expired';
  const soon = new Date(`${today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + EXPIRING_SOON_DAYS);
  return d <= soon.toISOString().slice(0, 10) ? 'expiring_soon' : 'valid';
}

const PROFILE_COLS = Object.keys(PROFILE_FIELDS);
const toProfile = (p) => p && ({
  ...Object.fromEntries(PROFILE_COLS.map((k) => [k, p[k]])),
  created_at: p.created_at, created_by: p.created_by, updated_at: p.updated_at, updated_by: p.updated_by, version: p.version,
});
const toDocument = (d) => ({
  ref: d.public_id, document_type: d.document_type, original_filename: d.original_filename, content_type: d.content_type, byte_size: Number(d.byte_size),
  // DATE columns are read as text (issued_on / expires_on): a JS Date would shift them by the server's timezone.
  document_label: d.document_label, issued_at: d.issued_on, expires_at: d.expires_on, expiry: expiryState(d.expires_on),
  uploaded_at: d.uploaded_at, uploaded_by: d.uploaded_by,
});

async function lockProfessional(db, publicId) {
  const a = await lockAffiliate(db, publicId);
  if (!a.requires_verification) throw bad('This category does not require professional verification.', 409);
  return a;
}
const checkAppVersion = (app, version) => {
  if (version !== undefined && version !== null && Number(version) !== app.version) {
    throw bad('Someone else changed this application since you opened it. Reload to see their change.', 409, { conflict: true });
  }
};
async function currentApplication(db, affiliateId, { lock = false } = {}) {
  const { rows: [app] } = await db.query(
    `SELECT * FROM verification_applications WHERE affiliate_id = $1 ORDER BY id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [affiliateId]);
  return app || null;
}
/** A new draft may start when nothing is open and the affiliate is actually waiting for verification. */
function canStartApplication(a, latest) {
  if (latest && ACTIVE.includes(latest.status)) return false;
  return a.status === 'pending_verification';
}

/* ------------------------------------------------------------------ reads */

/**
 * The verification view of one affiliate: profile, the current application
 * and the full history, newest first. No internal ids, no storage keys.
 */
export async function getVerification(publicId) {
  await ensureAffiliateVerificationSchema();
  const pid = String(publicId || '').toUpperCase();
  if (!/^[A-HJKMNP-Z2-9]{6,12}$/.test(pid)) return null;
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.status, a.public_id, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`, [pid]);
  if (!a) return null;
  const [{ rows: [profile] }, { rows: apps }] = await Promise.all([
    db.query('SELECT * FROM professional_profiles WHERE affiliate_id = $1', [a.id]),
    db.query(`SELECT v.*, p.public_id AS previous_ref FROM verification_applications v LEFT JOIN verification_applications p ON p.id = v.previous_application_id
              WHERE v.affiliate_id = $1 ORDER BY v.id DESC`, [a.id]),
  ]);
  const { rows: docs } = apps.length ? await db.query(
    `SELECT *, issued_at::text AS issued_on, expires_at::text AS expires_on FROM professional_documents
     WHERE verification_application_id = ANY($1) ORDER BY uploaded_at, id`, [apps.map((x) => x.id)]) : { rows: [] };
  const applications = apps.map((v) => ({
    ref: v.public_id, status: v.status, previous_ref: v.previous_ref || null,
    created_at: v.created_at, created_by: v.created_by, submitted_at: v.submitted_at, submitted_by: v.submitted_by,
    review_started_at: v.review_started_at, review_started_by: v.review_started_by, reviewed_at: v.reviewed_at, reviewed_by: v.reviewed_by,
    rejection_reason: v.rejection_reason, review_notes: v.review_notes, profile_snapshot: v.profile_snapshot, version: v.version,
    documents: docs.filter((d) => String(d.verification_application_id) === String(v.id)).map(toDocument),
  }));
  const current = applications[0] || null;
  const latest = apps[0] || null;
  return {
    required: a.requires_verification,
    affiliate_status: a.status,
    profile: toProfile(profile) || null,
    current,
    applications,
    can_start: Boolean(profile) && a.requires_verification && canStartApplication(a, latest),
    actions: current && a.requires_verification ? Object.entries(VERIFICATION_ACTIONS).filter(([, t]) => t.from.includes(current.status)).map(([k]) => k) : [],
    document_types: DOCUMENT_TYPES, formats: DOCUMENT_FORMATS, max_bytes: MAX_DOCUMENT_BYTES, expiring_soon_days: EXPIRING_SOON_DAYS,
  };
}

/* ------------------------------------------------------------------ profile */

/** Creates the professional profile and opens the first draft application, in one transaction. */
export async function createProfessionalProfile(publicId, input = {}, { actor } = {}) {
  await ensureAffiliateVerificationSchema();
  const p = profileInput(input);
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    if (a.status === 'closed') throw bad('A closed affiliate cannot get a professional profile.', 409);
    const { rows: [exists] } = await db.query('SELECT 1 FROM professional_profiles WHERE affiliate_id = $1', [a.id]);
    if (exists) throw bad('This affiliate already has a professional profile. Edit it instead.', 409);
    const { rows: [prof] } = await db.query(
      `INSERT INTO professional_profiles (affiliate_id, ${PROFILE_COLS.join(', ')}, created_by, updated_by)
       VALUES ($1, ${PROFILE_COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${PROFILE_COLS.length + 2}, $${PROFILE_COLS.length + 2}) RETURNING id`,
      [a.id, ...PROFILE_COLS.map((k) => p[k]), actor || null]);
    await logAffiliateEvent(db, a.id, 'professional_profile_created', actor, { fields: PROFILE_COLS.filter((k) => p[k]) }, 'professional_profile', a.public_id);
    const latest = await currentApplication(db, a.id);
    if (canStartApplication(a, latest)) await openDraft(db, a, prof.id, actor, null);
  });
  return getVerification(publicId);
}

async function openDraft(db, a, profileId, actor, previous) {
  const ref = newRef();
  await db.query(`INSERT INTO verification_applications (public_id, affiliate_id, professional_profile_id, previous_application_id, created_by)
                  VALUES ($1, $2, $3, $4, $5)`, [ref, a.id, profileId, previous?.id || null, actor || null]);
  await logAffiliateEvent(db, a.id, 'verification_application_created', actor, { application: ref, ...(previous ? { previous_application: previous.public_id } : {}) }, 'verification_application', ref);
  return ref;
}

/** Edits the profile (version-checked). Applications already submitted keep the copy they were reviewed with. */
export async function updateProfessionalProfile(publicId, input = {}, { actor, version } = {}) {
  await ensureAffiliateVerificationSchema();
  const p = profileInput(input, { partial: true });
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    if (a.status === 'closed') throw bad('A closed affiliate cannot be edited.', 409);
    const { rows: [prof] } = await db.query('SELECT * FROM professional_profiles WHERE affiliate_id = $1 FOR UPDATE', [a.id]);
    if (!prof) throw bad('Create the professional profile first.', 404);
    if (version !== undefined && version !== null && Number(version) !== prof.version) {
      throw bad('Someone else changed this profile since you opened it. Reload to see their change.', 409, { conflict: true });
    }
    const changed = Object.keys(p).filter((k) => (prof[k] ?? null) !== p[k]);
    if (!changed.length) return;
    await db.query(`UPDATE professional_profiles SET ${changed.map((k, i) => `${k} = $${i + 2}`).join(', ')},
      version = version + 1, updated_at = now(), updated_by = $${changed.length + 2} WHERE id = $1`, [prof.id, ...changed.map((k) => p[k]), actor || null]);
    await logAffiliateEvent(db, a.id, 'professional_profile_updated', actor, { fields: changed }, 'professional_profile', a.public_id);
  });
  return getVerification(publicId);
}

/* ------------------------------------------------------------------ documents */

/**
 * Stores a document for the current draft application. Checks run before
 * anything is written; the object goes to private storage under an opaque key
 * (never the filename); if the database write fails the object is removed.
 */
export async function uploadProfessionalDocument(publicId, { filename, buffer, document_type: type, document_label: label, issued_at: issued, expires_at: expires } = {},
  { actor, store = storage() } = {}) {
  await ensureAffiliateVerificationSchema();
  if (!DOCUMENT_TYPES.includes(type)) throw bad('Choose what kind of document this is.', 400, { field: 'document_type' });
  const name = String(filename || '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 200);
  if (!name) throw bad('The file has no name.', 400, { field: 'file' });
  if (!buffer?.length) throw bad('The file is empty.', 400, { field: 'file' });
  if (buffer.length > MAX_DOCUMENT_BYTES) throw bad(`Files must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.`, 413, { field: 'file' });
  const check = validateDocument(name, buffer, DOCUMENT_FORMATS);
  if (!check.ok) throw bad(check.error, 415, { field: 'file' });
  const docLabel = clean(label, 121);
  if (docLabel && docLabel.length > 120) throw bad('The label can be at most 120 characters.', 400, { field: 'document_label' });
  const issuedAt = dateOrNull(issued, 'issued_at');
  const expiresAt = dateOrNull(expires, 'expires_at');
  if (issuedAt && expiresAt && expiresAt < issuedAt) throw bad('The expiry date is before the issue date.', 400, { field: 'expires_at' });
  // Check the application before anything reaches storage.
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    const app = await currentApplication(db, a.id);
    if (!app || app.status !== 'draft') throw bad('Documents can be added only to a draft application. Start one first.', 409);
  });
  const key = newPrefixedKey('affiliates/verification', check.ext);
  await store.put(key, buffer, check.mime);
  try {
    await tx(async (db) => {
      const a = await lockProfessional(db, publicId);
      const app = await currentApplication(db, a.id, { lock: true });
      if (!app || app.status !== 'draft') throw bad('The application was submitted meanwhile. Documents can be added only to a draft.', 409);
      const ref = newRef();
      await db.query(`INSERT INTO professional_documents (public_id, verification_application_id, document_type, original_filename, content_type, byte_size,
                        storage_key, sha256, document_label, issued_at, expires_at, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ref, app.id, type, name, check.mime, buffer.length, key, crypto.createHash('sha256').update(buffer).digest('hex'), docLabel, issuedAt, expiresAt, actor || null]);
      await logAffiliateEvent(db, a.id, 'professional_document_uploaded', actor,
        { application: app.public_id, document: ref, document_type: type, byte_size: buffer.length, content_type: check.mime, ...(expiresAt ? { expires_at: expiresAt } : {}) }, 'professional_document', ref);
    });
  } catch (err) {
    await store.remove(key).catch(() => console.error('Orphaned verification document object after a failed write'));
    throw err;
  }
  return getVerification(publicId);
}

/**
 * A document's bytes for an authorised viewer, read through the app (never a
 * bucket URL). The document must belong to this affiliate's application.
 * Every successful read is recorded as professional_document_viewed.
 */
export async function openProfessionalDocument(publicId, applicationRef, documentRef, { actor, store = storage() } = {}) {
  await ensureAffiliateVerificationSchema();
  const pid = String(publicId || '').toUpperCase();
  const ok = (v) => /^[A-HJKMNP-Z2-9]{10}$/.test(String(v || ''));
  if (!/^[A-HJKMNP-Z2-9]{6,12}$/.test(pid) || !ok(applicationRef) || !ok(documentRef)) throw bad('No such document.', 404);
  const { rows: [d] } = await getPool().query(
    `SELECT d.*, a.id AS affiliate_id, v.public_id AS application_ref FROM professional_documents d
       JOIN verification_applications v ON v.id = d.verification_application_id
       JOIN affiliates a ON a.id = v.affiliate_id
     WHERE a.public_id = $1 AND v.public_id = $2 AND d.public_id = $3`, [pid, applicationRef, documentRef]);
  if (!d) throw bad('No such document.', 404);
  let buffer;
  try { buffer = await store.get(d.storage_key); } catch (err) {
    console.error(`Verification document ${d.public_id} unreadable:`, err.code || err.status || '', String(err.message).slice(0, 120));
    throw bad('The file could not be read from storage.', err.status === 404 || err.code === 'ENOENT' ? 410 : 502);
  }
  await logAffiliateEvent(getPool(), d.affiliate_id, 'professional_document_viewed', actor,
    { application: d.application_ref, document: d.public_id, document_type: d.document_type }, 'professional_document', d.public_id);
  return { buffer, filename: d.original_filename, mime: d.content_type };
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * submit (draft → submitted, needs a certificate; the profile is copied in),
 * review (submitted → under_review), approve (under_review → approved; the
 * affiliate pending_verification → approved — NOT active), reject (submitted |
 * under_review → rejected, reason required). Each runs in one transaction with
 * its event; the row lock and the version mean two decisions cannot both land.
 */
export async function verificationAction(publicId, action, { actor, version, reason, notes } = {}) {
  await ensureAffiliateVerificationSchema();
  const t = VERIFICATION_ACTIONS[action];
  if (!t) throw bad('Unknown verification action.', 400, { field: 'action' });
  const why = clean(reason, 1001);
  if (t.reason && !why) throw bad('Give the reason for rejecting.', 400, { field: 'reason' });
  if (why && why.length > 1000) throw bad('Keep the reason under 1,000 characters.', 400, { field: 'reason' });
  const note = String(notes ?? '').trim() || null;
  if (note && note.length > 1000) throw bad('Keep the notes under 1,000 characters.', 400, { field: 'notes' });
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    const app = await currentApplication(db, a.id, { lock: true });
    if (!app) throw bad('There is no verification application yet.', 404);
    checkAppVersion(app, version);
    if (!t.from.includes(app.status)) throw bad(`An application that is ${app.status.replace('_', ' ')} cannot be ${{ submit: 'submitted', review: 'moved to review', approve: 'approved', reject: 'rejected' }[action]}.`, 409);
    const sets = ['status = $2', 'version = version + 1', 'updated_at = now()']; const p = [app.id, t.to];
    const add = (sql, v) => { p.push(v); sets.push(sql.replace('?', `$${p.length}`)); };
    if (action === 'submit') {
      const { rows: [cert] } = await db.query(`SELECT 1 FROM professional_documents WHERE verification_application_id = $1 AND document_type = 'certificate' LIMIT 1`, [app.id]);
      if (!cert) throw bad('Upload the certificate before submitting.', 409);
      const { rows: [prof] } = await db.query('SELECT * FROM professional_profiles WHERE id = $1', [app.professional_profile_id]);
      add('profile_snapshot = ?', JSON.stringify(Object.fromEntries(PROFILE_COLS.map((k) => [k, prof[k]]))));
      add('submitted_by = ?', actor || null); sets.push('submitted_at = now()');
    } else if (action === 'review') {
      add('review_started_by = ?', actor || null); sets.push('review_started_at = now()');
    } else {
      if (action === 'approve' && a.status !== 'pending_verification') {
        throw bad(a.status === 'suspended' ? 'This affiliate is suspended. Reactivate it before approving its verification.' : `An affiliate that is ${a.status.replace('_', ' ')} cannot be approved.`, 409);
      }
      add('reviewed_by = ?', actor || null); sets.push('reviewed_at = now()');
      if (why) add('rejection_reason = ?', why);
      if (note) add('review_notes = ?', note);
    }
    await db.query(`UPDATE verification_applications SET ${sets.join(', ')} WHERE id = $1`, p);
    await logAffiliateEvent(db, a.id, t.event, actor, {
      application: app.public_id, from: app.status, to: t.to, ...(why ? { reason: why } : {}), ...(note ? { review_notes: note } : {}),
    }, 'verification_application', app.public_id);
    if (action === 'approve') {
      // Eligible for the Phase 1C "Activate" action; not activated, and no referral asset is created.
      await db.query(`UPDATE affiliates SET status = 'approved', version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1`, [a.id, actor || null]);
      await logAffiliateEvent(db, a.id, 'affiliate_status_changed', actor, { from: a.status, to: 'approved', note: 'Professional verification approved' }, 'affiliate', a.public_id);
    }
  });
  return getVerification(publicId);
}

/** After a rejection: a new draft application linked to the rejected one, which stays as decided. */
export async function resubmitVerification(publicId, { actor, version } = {}) {
  await ensureAffiliateVerificationSchema();
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    const latest = await currentApplication(db, a.id, { lock: true });
    if (!latest || latest.status !== 'rejected') throw bad('Only a rejected application can be followed by a new one.', 409);
    checkAppVersion(latest, version);
    if (a.status !== 'pending_verification') throw bad(`An affiliate that is ${a.status.replace('_', ' ')} cannot start a new verification.`, 409);
    const ref = await openDraft(db, a, latest.professional_profile_id, actor, latest);
    await logAffiliateEvent(db, a.id, 'verification_resubmitted', actor, { application: ref, previous_application: latest.public_id }, 'verification_application', ref);
  });
  return getVerification(publicId);
}

/** A new draft when none is open — e.g. after a move to another professional category. */
export async function startVerification(publicId, { actor } = {}) {
  await ensureAffiliateVerificationSchema();
  await tx(async (db) => {
    const a = await lockProfessional(db, publicId);
    const { rows: [prof] } = await db.query('SELECT id FROM professional_profiles WHERE affiliate_id = $1', [a.id]);
    if (!prof) throw bad('Create the professional profile first.', 409);
    const latest = await currentApplication(db, a.id, { lock: true });
    if (latest?.status === 'rejected') throw bad('Use "New application" to follow the rejected one.', 409);
    if (!canStartApplication(a, latest)) throw bad('A verification application is already open, or this affiliate is not waiting for verification.', 409);
    await openDraft(db, a, prof.id, actor, null);
  });
  return getVerification(publicId);
}
