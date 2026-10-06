import crypto from 'node:crypto';
import { getPool } from './db.js';
import { inTransaction } from './orders.js';
import { storage, validateDocument, newPrefixedKey } from './storage.js';

/**
 * HR / recruitment: jobs, candidates, applications, resumes.
 *
 * One source of truth. HR works on abc.briyo.xyz; candidates apply on
 * careers.briyo.xyz — the same app, database and R2 bucket (lib/careers.js).
 *
 * An application is *complete* only once its resume is stored (completed_at).
 * Until then it is invisible to HR, and a candidate resubmitting the same job
 * reuses that pending row instead of being turned away as a duplicate.
 *
 * Privacy (intended policy, documented here; nothing is deleted automatically):
 * information about unsuccessful candidates is meant to be kept for
 * HR_RETENTION_MONTHS (12) and then removed — by an explicitly approved,
 * separate process that does not exist yet.
 */
export const HR_RETENTION_MONTHS = 12;
export const CONSENT_TEXT = 'I agree that Briyo may collect and process the information provided in this application for recruitment purposes.';
export const CONSENT_VERSION = '2026-10-v1';

export const JOB_STATUSES = ['draft', 'published', 'closed', 'archived'];
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'internship', 'contract', 'freelance'];
export const WORK_MODES = ['onsite', 'hybrid', 'remote'];
export const SALARY_PERIODS = ['year', 'month', 'hour'];
export const SECTION_KEYS = ['about', 'responsibilities', 'requirements', 'nice_to_have', 'benefits', 'hiring_process', 'additional'];
export const APPLICATION_STATUSES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
export const RESUME_FORMATS = ['pdf', 'docx'];
export const UPLOAD_TOKEN_MINUTES = 15;
// Careers paths that a job slug may never take (they would shadow a route).
export const RESERVED_SLUGS = new Set(['jobs', 'assets', 'api', 'apply', 'robots.txt', 'favicon.ico', 'healthz', 'readyz',
  'login', 'auth', 'admin', 'hr', 'careers', 'static', 'sitemap.xml', 'index', 'index.html']);

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const text = (v, max) => {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};
const numOrNull = (v, label, { min = 0, max = 1e9, int = false } = {}) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw bad(`${label} must be a number${int ? ' (whole)' : ''} between ${min} and ${max}.`);
  return n;
};
const oneOf = (v, list, label, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`Choose the ${label.toLowerCase()}.`); return null; }
  if (!list.includes(v)) throw bad(`Unknown ${label.toLowerCase()} "${v}".`);
  return v;
};
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------------ schema */

let schema = null;
export function ensureHrSchema() {
  if (!schema) {
    schema = (async () => {
      const sql = getPool();
      const ddl = [`
        CREATE TABLE IF NOT EXISTS hr_jobs (
          id              BIGSERIAL PRIMARY KEY,
          public_id       TEXT NOT NULL UNIQUE,
          slug            TEXT UNIQUE,
          title           TEXT NOT NULL,
          department      TEXT,
          location        TEXT,
          employment_type TEXT CHECK (employment_type IN ('full_time','part_time','internship','contract','freelance')),
          work_mode       TEXT CHECK (work_mode IN ('onsite','hybrid','remote')),
          experience_min  NUMERIC CHECK (experience_min >= 0),
          experience_max  NUMERIC CHECK (experience_max >= 0),
          salary_min      NUMERIC CHECK (salary_min >= 0),
          salary_max      NUMERIC CHECK (salary_max >= 0),
          salary_currency TEXT NOT NULL DEFAULT 'INR',
          salary_period   TEXT CHECK (salary_period IN ('year','month','hour')),
          openings        INTEGER CHECK (openings > 0),
          summary         TEXT,
          sections        JSONB NOT NULL DEFAULT '{}',
          status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','archived')),
          published_at    TIMESTAMPTZ,
          closed_at       TIMESTAMPTZ,
          archived_at     TIMESTAMPTZ,
          version         INTEGER NOT NULL DEFAULT 1,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by      TEXT,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by      TEXT
        )`,
      'CREATE INDEX IF NOT EXISTS hr_jobs_status_idx ON hr_jobs (status)',
      // Every slug a job has had, so an old public link keeps redirecting.
      `CREATE TABLE IF NOT EXISTS hr_job_slugs (
          slug       TEXT PRIMARY KEY,
          job_id     BIGINT NOT NULL REFERENCES hr_jobs(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      `CREATE TABLE IF NOT EXISTS hr_candidates (
          id            BIGSERIAL PRIMARY KEY,
          email         TEXT NOT NULL CHECK (email = lower(btrim(email))),
          full_name     TEXT NOT NULL,
          phone         TEXT,
          location      TEXT,
          linkedin_url  TEXT,
          portfolio_url TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS hr_candidates_email_key ON hr_candidates (email)',
      `CREATE TABLE IF NOT EXISTS hr_applications (
          id                   BIGSERIAL PRIMARY KEY,
          job_id               BIGINT NOT NULL REFERENCES hr_jobs(id),
          candidate_id         BIGINT NOT NULL REFERENCES hr_candidates(id),
          status               TEXT NOT NULL DEFAULT 'applied'
                               CHECK (status IN ('applied','screening','interview','offer','hired','rejected','withdrawn')),
          answers              JSONB NOT NULL DEFAULT '{}',
          cover_letter         TEXT,
          resume_storage_path  TEXT,
          resume_filename      TEXT,
          resume_mime          TEXT,
          resume_size          INTEGER,
          resume_uploaded_at   TIMESTAMPTZ,
          upload_token_hash    TEXT,
          upload_token_expires TIMESTAMPTZ,
          submitted_ip_hash    TEXT,
          consent_at           TIMESTAMPTZ NOT NULL,
          consent_text_version TEXT NOT NULL,
          applied_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at         TIMESTAMPTZ,
          status_changed_at    TIMESTAMPTZ,
          version              INTEGER NOT NULL DEFAULT 1,
          UNIQUE (job_id, candidate_id)
        )`,
      'CREATE INDEX IF NOT EXISTS hr_applications_job_status_idx ON hr_applications (job_id, status)',
      'CREATE INDEX IF NOT EXISTS hr_applications_job_applied_idx ON hr_applications (job_id, applied_at DESC)',
      'CREATE INDEX IF NOT EXISTS hr_applications_status_idx ON hr_applications (status)',
      'CREATE UNIQUE INDEX IF NOT EXISTS hr_applications_token_idx ON hr_applications (upload_token_hash) WHERE upload_token_hash IS NOT NULL',
      `CREATE TABLE IF NOT EXISTS hr_application_status_history (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT NOT NULL REFERENCES hr_applications(id),
          from_status    TEXT,
          to_status      TEXT NOT NULL,
          actor          TEXT,
          note           TEXT,
          at             TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      'CREATE INDEX IF NOT EXISTS hr_status_history_app_idx ON hr_application_status_history (application_id, at)',
      `CREATE TABLE IF NOT EXISTS hr_application_notes (
          id             BIGSERIAL PRIMARY KEY,
          application_id BIGINT NOT NULL REFERENCES hr_applications(id),
          body           TEXT NOT NULL,
          actor          TEXT,
          at             TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      'CREATE INDEX IF NOT EXISTS hr_notes_app_idx ON hr_application_notes (application_id, at)',
      `CREATE TABLE IF NOT EXISTS hr_events (
          id             BIGSERIAL PRIMARY KEY,
          job_id         BIGINT REFERENCES hr_jobs(id),
          application_id BIGINT REFERENCES hr_applications(id),
          candidate_id   BIGINT REFERENCES hr_candidates(id),
          event_type     TEXT NOT NULL,
          actor          TEXT,
          at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          metadata       JSONB NOT NULL DEFAULT '{}'
        )`,
      'CREATE INDEX IF NOT EXISTS hr_events_job_idx ON hr_events (job_id, at)',
      'CREATE INDEX IF NOT EXISTS hr_events_app_idx ON hr_events (application_id, at)',
      // Resume lifecycle (see removeResume): present → removing → removed. The
      // storage key is kept while removing, so an interrupted removal can finish.
      `ALTER TABLE hr_applications ADD COLUMN IF NOT EXISTS resume_state TEXT CHECK (resume_state IN ('present','removing','removed'))`,
      `UPDATE hr_applications SET resume_state = 'present' WHERE resume_state IS NULL AND resume_storage_path IS NOT NULL`,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_applications_resume_state_ok') THEN
           ALTER TABLE hr_applications ADD CONSTRAINT hr_applications_resume_state_ok CHECK (
             (resume_state IN ('present','removing') AND resume_storage_path IS NOT NULL)
             OR (resume_state = 'removed' AND resume_storage_path IS NULL)
             OR (resume_state IS NULL AND resume_storage_path IS NULL));
         END IF;
       END $$`,
      `CREATE INDEX IF NOT EXISTS hr_applications_removing_idx ON hr_applications (id) WHERE resume_state = 'removing'`];
      await sql.query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

async function logEvent(client, { jobId = null, applicationId = null, candidateId = null, type, actor = null, metadata = {} }) {
  await client.query(
    'INSERT INTO hr_events (job_id, application_id, candidate_id, event_type, actor, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [jobId, applicationId, candidateId, type, actor, JSON.stringify(metadata)]);
}

/* ------------------------------------------------------------------ jobs */

const BASE32 = 'abcdefghijkmnpqrstuvwxyz23456789';   // no 0/o/1/l
export function newPublicId(len = 10) {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => BASE32[b % BASE32.length]).join('');
}
export function slugify(title) {
  return String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '') || 'job';
}

export const careersBaseUrl = () => String(process.env.CAREERS_BASE_URL || 'https://careers.briyo.xyz').replace(/\/+$/, '');
export const publicUrlOf = (job) => (job.slug ? `${careersBaseUrl()}/${job.slug}/apply` : null);

/** Validated job fields from HR input. `creating` requires a title. */
function jobInput(input, { creating = false } = {}) {
  const f = {};
  const has = (k) => input[k] !== undefined;
  if (creating || has('title')) {
    f.title = text(input.title, 140);
    if (!f.title) throw bad('Enter the job title.');
  }
  for (const [k, max] of [['department', 80], ['location', 120], ['summary', 600]]) if (has(k)) f[k] = text(input[k], max);
  if (has('employment_type')) f.employment_type = oneOf(input.employment_type, EMPLOYMENT_TYPES, 'Employment type');
  if (has('work_mode')) f.work_mode = oneOf(input.work_mode, WORK_MODES, 'Work mode');
  if (has('experience_min')) f.experience_min = numOrNull(input.experience_min, 'Minimum experience', { max: 60 });
  if (has('experience_max')) f.experience_max = numOrNull(input.experience_max, 'Maximum experience', { max: 60 });
  if (has('salary_min')) f.salary_min = numOrNull(input.salary_min, 'Minimum salary', { max: 1e10 });
  if (has('salary_max')) f.salary_max = numOrNull(input.salary_max, 'Maximum salary', { max: 1e10 });
  if (has('salary_currency')) {
    const c = String(input.salary_currency || 'INR').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw bad('Currency must be a 3-letter code such as INR.');
    f.salary_currency = c;
  }
  if (has('salary_period')) f.salary_period = oneOf(input.salary_period, SALARY_PERIODS, 'Salary period');
  if (has('openings')) f.openings = numOrNull(input.openings, 'Openings', { min: 1, max: 1000, int: true });
  if (has('sections')) {
    const s = input.sections && typeof input.sections === 'object' ? input.sections : {};
    const out = {};
    for (const k of SECTION_KEYS) { const v = text(s[k], 6000); if (v) out[k] = v; }
    f.sections = out;
  }
  return f;
}

function checkRanges(job) {
  if (job.experience_min !== null && job.experience_max !== null && Number(job.experience_min) > Number(job.experience_max)) throw bad('Minimum experience is more than the maximum.');
  if (job.salary_min !== null && job.salary_max !== null && Number(job.salary_min) > Number(job.salary_max)) throw bad('Minimum salary is more than the maximum.');
}

const toJob = (r) => r && ({
  ...r, id: Number(r.id),
  experience_min: r.experience_min === null ? null : Number(r.experience_min),
  experience_max: r.experience_max === null ? null : Number(r.experience_max),
  salary_min: r.salary_min === null ? null : Number(r.salary_min),
  salary_max: r.salary_max === null ? null : Number(r.salary_max),
  public_url: publicUrlOf(r),
});

export async function createJob(input, { actor }) {
  await ensureHrSchema();
  const f = { salary_currency: 'INR', sections: {}, ...jobInput(input, { creating: true }) };
  checkRanges({ experience_min: null, experience_max: null, salary_min: null, salary_max: null, ...f });
  return inTransaction(async (client) => {
    const keys = Object.keys(f);
    const vals = keys.map((k) => (k === 'sections' ? JSON.stringify(f[k]) : f[k]));
    let row;
    for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
      try {
        ({ rows: [row] } = await client.query(
          `INSERT INTO hr_jobs (public_id, ${keys.join(', ')}, created_by, updated_by)
           VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, $${keys.length + 2}, $${keys.length + 2}) RETURNING *`,
          [newPublicId(), ...vals, actor]));
      } catch (err) { if (err.code !== '23505') throw err; }   // public_id collision: draw again
    }
    await logEvent(client, { jobId: row.id, type: 'job_created', actor, metadata: { title: row.title } });
    return toJob(row);
  });
}

export async function getJob(id) {
  await ensureHrSchema();
  const { rows } = await getPool().query('SELECT * FROM hr_jobs WHERE id = $1', [id]);
  return toJob(rows[0]) || null;
}

/** Jobs for HR, newest first, with complete-application counts per status. */
export async function listJobs({ q = '', status = '' } = {}) {
  await ensureHrSchema();
  const where = []; const params = [];
  if (status) { params.push(status); where.push(`j.status = $${params.length}`); }
  if (q) { params.push(`%${String(q).trim()}%`); where.push(`(j.title ILIKE $${params.length} OR j.department ILIKE $${params.length} OR j.location ILIKE $${params.length})`); }
  const { rows } = await getPool().query(
    `SELECT j.*,
            coalesce((SELECT json_object_agg(status, n) FROM (SELECT status, count(*)::int n FROM hr_applications a
                       WHERE a.job_id = j.id AND a.completed_at IS NOT NULL GROUP BY status) c), '{}') AS status_counts,
            (SELECT count(*)::int FROM hr_applications a WHERE a.job_id = j.id AND a.completed_at IS NOT NULL) AS candidate_count,
            (SELECT count(*)::int FROM hr_applications a WHERE a.job_id = j.id AND a.completed_at IS NULL) AS incomplete_count
     FROM hr_jobs j ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY j.updated_at DESC, j.id DESC LIMIT 500`, params);
  return rows.map(toJob);
}

async function uniqueSlug(client, base, jobId) {
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-job` : base;
  for (let n = 2; ; n += 1) {
    const { rows } = await client.query('SELECT job_id FROM hr_job_slugs WHERE slug = $1', [candidate]);
    if (!rows.length || Number(rows[0].job_id) === Number(jobId)) return candidate;
    candidate = `${base}-${n}`;
  }
}
async function assignSlug(client, job, wanted, actor) {
  const slug = await uniqueSlug(client, slugify(wanted), job.id);
  if (slug === job.slug) return slug;
  await client.query('INSERT INTO hr_job_slugs (slug, job_id) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING', [slug, job.id]);
  await client.query('UPDATE hr_jobs SET slug = $2 WHERE id = $1', [job.id, slug]);
  await logEvent(client, { jobId: job.id, type: 'job_slug_set', actor, metadata: { from: job.slug, to: slug } });
  return slug;
}

/**
 * Edits a job (version-checked). The slug is set when the job is first
 * published and does not follow later title edits; `slug` in the input
 * renames it on purpose, and the old one keeps redirecting.
 */
export async function updateJob(id, input, { actor, version }) {
  await ensureHrSchema();
  const f = jobInput(input);
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM hr_jobs WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur) throw bad('No such job.', 404);
    if (Number(version) !== cur.version) throw bad(`${cur.updated_by || 'Someone'} changed this job while you had it open. Reload to see their change.`, 409, { conflict: true });
    checkRanges({ ...cur, ...f });
    const keys = Object.keys(f);
    let row = cur;
    if (keys.length) {
      ({ rows: [row] } = await client.query(
        `UPDATE hr_jobs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $${keys.length + 2}
         WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => (k === 'sections' ? JSON.stringify(f[k]) : f[k])), actor]));
      await logEvent(client, { jobId: id, type: 'job_updated', actor, metadata: { fields: keys } });
    }
    if (input.slug !== undefined && cur.slug) {
      await assignSlug(client, row, input.slug, actor);
      if (!keys.length) await client.query('UPDATE hr_jobs SET version = version + 1, updated_at = now(), updated_by = $2 WHERE id = $1', [id, actor]);
      ({ rows: [row] } = await client.query('SELECT * FROM hr_jobs WHERE id = $1', [id]));
    }
    return toJob(row);
  });
}

const TRANSITIONS = {
  publish: { from: ['draft', 'closed'], to: 'published', stamp: 'published_at', event: 'job_published' },
  close: { from: ['published'], to: 'closed', stamp: 'closed_at', event: 'job_closed' },
  archive: { from: ['draft', 'published', 'closed'], to: 'archived', stamp: 'archived_at', event: 'job_archived' },
  restore: { from: ['archived'], to: 'draft', stamp: null, event: 'job_restored' },
};

/** publish | close | archive | restore. Publishing needs the basics filled in. */
export async function setJobStatus(id, action, { actor, version }) {
  await ensureHrSchema();
  const t = TRANSITIONS[action];
  if (!t) throw bad('Unknown action.');
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM hr_jobs WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur) throw bad('No such job.', 404);
    if (Number(version) !== cur.version) throw bad(`${cur.updated_by || 'Someone'} changed this job while you had it open. Reload to see their change.`, 409, { conflict: true });
    if (!t.from.includes(cur.status)) throw bad(`A ${cur.status} job cannot be ${action === 'restore' ? 'restored' : `${action}ed`}.`, 409);
    if (t.to === 'published') {
      const missing = [!cur.title && 'title', !cur.employment_type && 'employment type', !cur.work_mode && 'work mode', !cur.summary && 'summary',
        cur.work_mode !== 'remote' && !cur.location && 'location'].filter(Boolean);
      if (missing.length) throw bad(`Fill in the ${missing.join(', ')} before publishing.`);
      if (!cur.slug) await assignSlug(client, cur, cur.title, actor);
    }
    const { rows: [row] } = await client.query(
      `UPDATE hr_jobs SET status = $2, ${t.stamp ? `${t.stamp} = now(), ` : ''}version = version + 1, updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING *`, [id, t.to, actor]);
    await logEvent(client, { jobId: id, type: t.event, actor, metadata: { from: cur.status, to: t.to } });
    return toJob(row);
  });
}

/* ------------------------------------------------------------------ public */

/** Only what a candidate or an external page may see. Never ids, counts or HR data. */
export function publicJobView(j) {
  return {
    public_id: j.public_id, slug: j.slug, title: j.title, department: j.department, location: j.location,
    employment_type: j.employment_type, work_mode: j.work_mode,
    experience: j.experience_min === null && j.experience_max === null ? null : { min: j.experience_min, max: j.experience_max },
    // Policy: public only when both ends are set. Partial values stay internal.
    salary: j.salary_min === null || j.salary_max === null ? null
      : { min: j.salary_min, max: j.salary_max, currency: j.salary_currency, period: j.salary_period },
    openings: j.openings, summary: j.summary, public_url: publicUrlOf(j),
    applications_open: j.status === 'published',
    published_at: j.published_at,
  };
}

export async function publicJobs() {
  await ensureHrSchema();
  const { rows } = await getPool().query(`SELECT * FROM hr_jobs WHERE status = 'published' ORDER BY published_at DESC, id DESC`);
  return rows.map(toJob).map(publicJobView);
}

/** A published or closed job for its public page, by public id. Draft/archived/unknown → null. */
export async function publicJobById(publicId) {
  await ensureHrSchema();
  const { rows } = await getPool().query(`SELECT * FROM hr_jobs WHERE public_id = $1 AND status IN ('published','closed')`, [String(publicId || '')]);
  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Resolves /<slug>/apply. Current slug → { job }; an old slug of a visible job
 * → { redirect: current slug }; draft/archived/unknown → null (the same 404).
 */
export async function publicJobBySlug(slug) {
  await ensureHrSchema();
  const { rows } = await getPool().query(
    `SELECT j.* FROM hr_job_slugs s JOIN hr_jobs j ON j.id = s.job_id
     WHERE s.slug = $1 AND j.status IN ('published','closed')`, [String(slug || '').toLowerCase()]);
  if (!rows[0]) return null;
  const job = toJob(rows[0]);
  return job.slug === String(slug).toLowerCase() ? { job } : { redirect: job.slug };
}

/* ------------------------------------------------------------------ applications (public) */

export function normalizeEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw bad('Enter a valid email address.', 400, { field: 'email' });
  return e;
}

/**
 * E.164. International numbers must start with + and a country code. A bare
 * 10-digit number is taken as Indian (+91), the common case here.
 */
export function normalizePhone(v) {
  const raw = String(v ?? '').trim();
  const plus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!plus) {
    if (/^0?[6-9]\d{9}$/.test(digits)) digits = `91${digits.slice(-10)}`;
    else throw bad('Enter the phone number with its country code, e.g. +44 20 7946 0958.', 400, { field: 'phone' });
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) throw bad('Enter a valid phone number.', 400, { field: 'phone' });
  return `+${digits}`;
}

const urlOrNull = (v, label, field) => {
  const s = text(v, 300);
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw bad(`${label} is not a valid link.`, 400, { field }); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) throw bad(`${label} is not a valid link.`, 400, { field });
  return u.toString();
};

/** The standard V1 application form, validated. Unknown fields are ignored. */
export function applicationInput(input) {
  const req = (v, label, field, max) => { const s = text(v, max); if (!s) throw bad(`${label} is required.`, 400, { field }); return s; };
  if (input.consent !== true) throw bad('Please confirm the consent statement to apply.', 400, { field: 'consent' });
  return {
    candidate: {
      full_name: req(input.full_name, 'Full name', 'full_name', 120),
      email: normalizeEmail(input.email),
      phone: normalizePhone(input.phone),
      location: req(input.location, 'Current location', 'location', 120),
      linkedin_url: urlOrNull(input.linkedin_url, 'LinkedIn', 'linkedin_url'),
      portfolio_url: urlOrNull(input.portfolio_url, 'Portfolio', 'portfolio_url'),
    },
    cover_letter: text(input.cover_letter, 5000),
    answers: {
      relevant_experience: req(input.relevant_experience, 'Relevant experience', 'relevant_experience', 3000),
      notice_period: req(input.notice_period, 'Notice period / availability', 'notice_period', 200),
      expected_compensation: text(input.expected_compensation, 200),
      work_authorization: req(input.work_authorization, 'Work authorization / eligibility', 'work_authorization', 300),
    },
  };
}

const PROFILE_FIELDS = ['full_name', 'phone', 'location', 'linkedin_url', 'portfolio_url'];

/**
 * Step 1 of applying: validates, finds or creates the candidate (by email),
 * creates the application — or refreshes this candidate's still-pending one
 * for the same job — and returns a single-use resume upload token.
 * A completed application for the same job is a 409.
 */
export async function startApplication(publicId, input, { ipHash = null } = {}) {
  await ensureHrSchema();
  const a = applicationInput(input);
  return inTransaction(async (client) => {
    const { rows: jobs } = await client.query('SELECT id, title, status FROM hr_jobs WHERE public_id = $1 FOR SHARE', [String(publicId || '')]);
    const job = jobs[0];
    if (!job || !['published', 'closed'].includes(job.status)) throw bad('This job is not available.', 404);
    if (job.status !== 'published') throw bad('Applications for this job are closed.', 409, { closed: true });

    // Candidate: one per normalised email. A changed profile is updated and the
    // previous values kept in the HR history.
    let { rows: [cand] } = await client.query('SELECT * FROM hr_candidates WHERE email = $1 FOR UPDATE', [a.candidate.email]);
    if (!cand) {
      try {
        ({ rows: [cand] } = await client.query(
          `INSERT INTO hr_candidates (email, full_name, phone, location, linkedin_url, portfolio_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [a.candidate.email, a.candidate.full_name, a.candidate.phone, a.candidate.location, a.candidate.linkedin_url, a.candidate.portfolio_url]));
      } catch (err) {
        if (err.code === '23505') throw bad('Please submit again.', 409, { retry: true });   // the same email, at the same moment
        throw err;
      }
    } else {
      const changed = {};
      for (const k of PROFILE_FIELDS) {
        const next = a.candidate[k];
        // An empty optional field does not wipe what we already have.
        if (next !== null && next !== cand[k]) changed[k] = { from: cand[k], to: next };
      }
      if (Object.keys(changed).length) {
        const keys = Object.keys(changed);
        await client.query(`UPDATE hr_candidates SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
          [cand.id, ...keys.map((k) => changed[k].to)]);
        await logEvent(client, { jobId: job.id, candidateId: cand.id, type: 'candidate_profile_updated', metadata: { changed } });
      }
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const { rows: [existing] } = await client.query(
      'SELECT id, completed_at FROM hr_applications WHERE job_id = $1 AND candidate_id = $2 FOR UPDATE', [job.id, cand.id]);
    if (existing?.completed_at) throw bad('You have already applied for this role.', 409, { duplicate: true });
    let appId;
    if (existing) {
      await client.query(
        `UPDATE hr_applications SET answers = $2, cover_letter = $3, upload_token_hash = $4,
           upload_token_expires = now() + ($5 || ' minutes')::interval, submitted_ip_hash = $6, consent_at = now(), consent_text_version = $7
         WHERE id = $1`, [existing.id, JSON.stringify(a.answers), a.cover_letter, sha256(token), String(UPLOAD_TOKEN_MINUTES), ipHash, CONSENT_VERSION]);
      appId = existing.id;
    } else {
      ({ rows: [{ id: appId }] } = await client.query(
        `INSERT INTO hr_applications (job_id, candidate_id, answers, cover_letter, upload_token_hash, upload_token_expires,
           submitted_ip_hash, consent_at, consent_text_version)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval, $7, now(), $8) RETURNING id`,
        [job.id, cand.id, JSON.stringify(a.answers), a.cover_letter, sha256(token), String(UPLOAD_TOKEN_MINUTES), ipHash, CONSENT_VERSION]));
    }
    await logEvent(client, { jobId: job.id, applicationId: appId, candidateId: cand.id, type: 'application_started', metadata: { resumed: Boolean(existing) } });
    return { uploadToken: token, jobTitle: job.title, expiresInMinutes: UPLOAD_TOKEN_MINUTES };
  });
}

/**
 * Step 2: the resume, with the token from step 1. The file is checked (PDF or
 * DOCX, content must match, 10 MB), stored privately, and the application is
 * completed in one guarded update: a token can be used once, only before it
 * expires, only for its job. A failed check leaves the token usable (retry).
 */
export async function uploadResume(publicId, token, { filename, buffer }, { store = storage() } = {}) {
  await ensureHrSchema();
  const t = String(token || '');
  if (t.length < 20) throw bad('This upload link is not valid. Please submit the application again.', 401, { token: true });
  const { rows } = await getPool().query(
    `SELECT a.id, a.job_id, a.candidate_id, j.title FROM hr_applications a JOIN hr_jobs j ON j.id = a.job_id
     WHERE a.upload_token_hash = $1 AND j.public_id = $2 AND a.completed_at IS NULL AND a.upload_token_expires > now()`,
    [sha256(t), String(publicId || '')]);
  const app = rows[0];
  if (!app) throw bad('This upload link has expired or was already used. Please submit the application again.', 401, { token: true });
  const name = String(filename || '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
  const check = validateDocument(name, buffer, RESUME_FORMATS);
  if (!check.ok) throw bad(check.error, 400, { field: 'resume' });
  const key = newPrefixedKey('hr/resumes', check.ext);
  await store.put(key, buffer, check.mime);
  try {
    return await inTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE hr_applications SET resume_state = 'present', resume_storage_path = $3, resume_filename = $4, resume_mime = $5, resume_size = $6,
           resume_uploaded_at = now(), completed_at = now(), applied_at = now(), upload_token_hash = NULL, upload_token_expires = NULL
         WHERE id = $1 AND upload_token_hash = $2 AND completed_at IS NULL AND upload_token_expires > now()`,
        [app.id, sha256(t), key, name, check.mime, buffer.length]);
      if (!rowCount) throw bad('This upload link has expired or was already used. Please submit the application again.', 401, { token: true });
      await logEvent(client, { jobId: app.job_id, applicationId: app.id, candidateId: app.candidate_id, type: 'resume_uploaded', metadata: { size: buffer.length, mime: check.mime } });
      await logEvent(client, { jobId: app.job_id, applicationId: app.id, candidateId: app.candidate_id, type: 'application_submitted' });
      return { ok: true, jobTitle: app.title };
    });
  } catch (err) {
    await store.remove(key).catch(() => console.error(`Orphaned resume object for application ${app.id}`));
    throw err;
  }
}

/* ------------------------------------------------------------------ applications (HR) */

const toApp = (r) => r && ({ ...r, id: Number(r.id), job_id: Number(r.job_id), candidate_id: Number(r.candidate_id),
  has_resume: r.resume_state === 'present', resume_storage_path: undefined, upload_token_hash: undefined, submitted_ip_hash: undefined });

/** Complete applications only, newest first. Search: name, email, phone. */
export async function listApplications({ job = '', status = '', q = '', from = '', to = '' } = {}) {
  await ensureHrSchema();
  const where = ['a.completed_at IS NOT NULL']; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (/^\d+$/.test(String(job))) where.push(`a.job_id = ${p(Number(job))}`);
  if (status) { if (!APPLICATION_STATUSES.includes(status)) throw bad('Unknown status.'); where.push(`a.status = ${p(status)}`); }
  if (q && String(q).trim()) {
    const like = p(`%${String(q).trim()}%`);
    const digits = String(q).replace(/\D/g, '');
    where.push(`(c.full_name ILIKE ${like} OR c.email ILIKE ${like}${digits.length >= 4 ? ` OR c.phone LIKE ${p(`%${digits}%`)}` : ''})`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) where.push(`a.applied_at >= ${p(from)}::date`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) where.push(`a.applied_at < (${p(to)}::date + 1)`);
  const { rows } = await getPool().query(
    `SELECT a.id, a.job_id, a.candidate_id, a.status, a.applied_at, a.status_changed_at, a.resume_storage_path, a.resume_state, a.version,
            c.full_name, c.email, c.phone, c.location, j.title AS job_title, j.public_id AS job_public_id
     FROM hr_applications a JOIN hr_candidates c ON c.id = a.candidate_id JOIN hr_jobs j ON j.id = a.job_id
     WHERE ${where.join(' AND ')} ORDER BY a.applied_at DESC, a.id DESC LIMIT 500`, params);
  return rows.map(toApp);
}

export async function getApplication(id) {
  await ensureHrSchema();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.*, c.full_name, c.email, c.phone, c.location, c.linkedin_url, c.portfolio_url, c.created_at AS candidate_since,
            j.title AS job_title, j.slug AS job_slug, j.status AS job_status
     FROM hr_applications a JOIN hr_candidates c ON c.id = a.candidate_id JOIN hr_jobs j ON j.id = a.job_id WHERE a.id = $1`, [id]);
  if (!rows[0]) return null;
  const [history, notes, events, others] = await Promise.all([
    pool.query('SELECT from_status, to_status, actor, note, at FROM hr_application_status_history WHERE application_id = $1 ORDER BY at, id', [id]),
    pool.query('SELECT id, body, actor, at FROM hr_application_notes WHERE application_id = $1 ORDER BY at DESC, id DESC', [id]),
    pool.query('SELECT event_type, actor, at, metadata FROM hr_events WHERE application_id = $1 OR (candidate_id = $2 AND event_type = \'candidate_profile_updated\') ORDER BY at, id', [id, rows[0].candidate_id]),
    pool.query(`SELECT a.id, j.title AS job_title, a.status, a.applied_at FROM hr_applications a JOIN hr_jobs j ON j.id = a.job_id
                WHERE a.candidate_id = $1 AND a.id <> $2 AND a.completed_at IS NOT NULL ORDER BY a.applied_at DESC`, [rows[0].candidate_id, id]),
  ]);
  const app = toApp(rows[0]);
  app.job_public_url = publicUrlOf({ slug: rows[0].job_slug });
  return { application: app, history: history.rows, notes: notes.rows.map((n) => ({ ...n, id: Number(n.id) })), events: events.rows,
    other_applications: others.rows.map((o) => ({ ...o, id: Number(o.id) })) };
}

/** Changes status with history (from, to, actor, note). Version-checked. */
export async function setApplicationStatus(id, status, { actor, version, note = null }) {
  await ensureHrSchema();
  if (!APPLICATION_STATUSES.includes(status)) throw bad('Unknown status.');
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, job_id, candidate_id, status, version, completed_at FROM hr_applications WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur || !cur.completed_at) throw bad('No such application.', 404);
    if (Number(version) !== cur.version) throw bad('Someone changed this application while you had it open. Reload to see their change.', 409, { conflict: true });
    if (cur.status === status) return { changed: false };
    await client.query('UPDATE hr_applications SET status = $2, status_changed_at = now(), version = version + 1 WHERE id = $1', [id, status]);
    const n = text(note, 1000);
    await client.query('INSERT INTO hr_application_status_history (application_id, from_status, to_status, actor, note) VALUES ($1, $2, $3, $4, $5)',
      [id, cur.status, status, actor, n]);
    await logEvent(client, { jobId: cur.job_id, applicationId: id, candidateId: cur.candidate_id, type: 'status_changed', actor, metadata: { from: cur.status, to: status } });
    return { changed: true };
  });
}

export async function addApplicationNote(id, body, { actor }) {
  await ensureHrSchema();
  const b = text(body, 4000);
  if (!b) throw bad('Write the note first.');
  return inTransaction(async (client) => {
    const { rows } = await client.query('SELECT job_id, candidate_id, completed_at FROM hr_applications WHERE id = $1', [id]);
    if (!rows[0]?.completed_at) throw bad('No such application.', 404);
    const { rows: [n] } = await client.query('INSERT INTO hr_application_notes (application_id, body, actor) VALUES ($1, $2, $3) RETURNING id, at', [id, b, actor]);
    await logEvent(client, { jobId: rows[0].job_id, applicationId: id, candidateId: rows[0].candidate_id, type: 'note_added', actor, metadata: { note_id: Number(n.id) } });
    return { id: Number(n.id), at: n.at };
  });
}

/** The stored resume for an authorised download. */
export async function resumeFile(id, { store = storage() } = {}) {
  await ensureHrSchema();
  const { rows } = await getPool().query('SELECT resume_state, resume_storage_path, resume_filename, resume_mime FROM hr_applications WHERE id = $1 AND completed_at IS NOT NULL', [id]);
  const r = rows[0];
  // Only a present resume is served: never one that is being removed.
  if (r?.resume_state !== 'present') throw bad(r?.resume_state === 'removing' ? 'This resume is being removed.' : 'No resume on this application.', 404);
  return { buffer: await store.get(r.resume_storage_path), filename: r.resume_filename, mime: r.resume_mime };
}

/**
 * Removes a resume for good. Storage and the database cannot share a
 * transaction, so the row carries the state and every step can be repeated:
 *
 *   1. present → removing  (committed first; downloads stop; event recorded)
 *   2. delete the object   (an object that is already gone counts as deleted)
 *   3. removing → removed  (key and file fields cleared; event recorded)
 *
 * Step 2 fails → back to present, the file is untouched and still downloadable.
 * Step 3 fails → the row stays "removing" with its key: HR sees "removal not
 * finished" and the same call (or retryPendingRemovals at boot) finishes it.
 * Already removed → { removed: true, already: true }, no error.
 * The candidate, the application and its status are never touched.
 */
export async function removeResume(id, { actor, reason = null, store = storage(), hooks = {} }) {
  await ensureHrSchema();
  let why = text(reason, 300);
  const pool = getPool();
  // 1. Claim.
  const claim = await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT job_id, candidate_id, resume_state, resume_storage_path, resume_filename FROM hr_applications WHERE id = $1 AND completed_at IS NOT NULL FOR UPDATE', [id]);
    const r = rows[0];
    if (!r) throw bad('No such application.', 404);
    if (r.resume_state === 'removed') return { done: true };
    if (r.resume_state !== 'present' && r.resume_state !== 'removing') throw bad('No resume on this application.', 404);
    r.claimedNow = r.resume_state === 'present';
    // Finishing an earlier removal: keep the reason it was started with.
    if (!r.claimedNow && !why) {
      const { rows: [st] } = await client.query(`SELECT metadata->>'reason' AS reason FROM hr_events WHERE application_id = $1 AND event_type = 'resume_removal_started' ORDER BY id DESC LIMIT 1`, [id]);
      why = st?.reason || null;
    }
    if (r.claimedNow) {
      await client.query(`UPDATE hr_applications SET resume_state = 'removing', version = version + 1 WHERE id = $1`, [id]);
      await logEvent(client, { jobId: r.job_id, applicationId: id, candidateId: r.candidate_id, type: 'resume_removal_started', actor,
        metadata: { filename: r.resume_filename, reason: why } });
    }
    return r;
  });
  if (claim.done) return { removed: true, already: true };
  const ids = { jobId: claim.job_id, applicationId: id, candidateId: claim.candidate_id };

  // 2. Delete the object (R2 answers 204 for a missing key; local storage uses force).
  try { await store.remove(claim.resume_storage_path); } catch (err) {
    console.error(`Resume for application ${id} could not be removed from storage:`, err.message?.slice(0, 200));
    // Back to present only if this call started the removal: the file is then known
    // to be untouched. A retry of an earlier removal stays "removing" — the file may
    // already be gone, so it must never be offered for download again.
    await inTransaction(async (client) => {
      if (claim.claimedNow) await client.query(`UPDATE hr_applications SET resume_state = 'present', version = version + 1 WHERE id = $1 AND resume_state = 'removing'`, [id]);
      await logEvent(client, { ...ids, type: 'resume_removal_failed', actor, metadata: { stage: 'storage' } });
    }).catch(() => { /* stays "removing": the next attempt retries */ });
    throw bad(claim.claimedNow ? 'The file could not be removed from storage. The resume is still on file; please try again.'
      : 'The file could not be removed from storage. The removal is still pending; please try again.', 502);
  }

  // 3. Finalize.
  try {
    await inTransaction(async (client) => {
      if (hooks.beforeFinalize) await hooks.beforeFinalize(client);
      const { rowCount } = await client.query(`UPDATE hr_applications SET resume_state = 'removed', resume_storage_path = NULL, resume_filename = NULL,
          resume_mime = NULL, resume_size = NULL, resume_uploaded_at = NULL, version = version + 1 WHERE id = $1 AND resume_state = 'removing'`, [id]);
      if (rowCount) {
        await logEvent(client, { ...ids, type: 'resume_removed', actor, metadata: { filename: claim.resume_filename, reason: why ?? undefined } });
      }
    });
  } catch (err) {
    console.error(`Resume for application ${id}: file deleted, record not finalized:`, err.message?.slice(0, 200));
    await pool.query('INSERT INTO hr_events (job_id, application_id, candidate_id, event_type, actor, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [claim.job_id, id, claim.candidate_id, 'resume_removal_failed', actor, JSON.stringify({ stage: 'finalize' })]).catch(() => {});
    throw bad('The file was deleted but the record could not be updated. It is marked as being removed; retry to finish.', 503, { retry: true });
  }
  return { removed: true };
}

/** Finishes removals that were interrupted after the file was deleted. Safe to run any time. */
export async function retryPendingRemovals({ store = storage() } = {}) {
  await ensureHrSchema();
  const { rows } = await getPool().query(`SELECT id FROM hr_applications WHERE resume_state = 'removing' ORDER BY id LIMIT 100`);
  let finished = 0;
  for (const { id } of rows) {
    try { await removeResume(Number(id), { actor: 'system: removal retry', store }); finished += 1; } catch { /* left for the next run */ }
  }
  return { pending: rows.length, finished };
}

/** For db-check only: removes rows whose job title starts with `prefix`. */
export async function purgeTestHr(prefix) {
  const pool = getPool();
  const { rows: jobs } = await pool.query('SELECT id FROM hr_jobs WHERE title LIKE $1', [`${prefix}%`]);
  const ids = jobs.map((j) => j.id);
  if (!ids.length) return { jobs: 0, paths: [] };
  const { rows: apps } = await pool.query('SELECT id, candidate_id, resume_storage_path FROM hr_applications WHERE job_id = ANY($1)', [ids]);
  const appIds = apps.map((a) => a.id);
  const candIds = [...new Set(apps.map((a) => a.candidate_id))];
  await pool.query('DELETE FROM hr_events WHERE job_id = ANY($1) OR application_id = ANY($2) OR candidate_id = ANY($3)', [ids, appIds, candIds]);
  await pool.query('DELETE FROM hr_application_notes WHERE application_id = ANY($1)', [appIds]);
  await pool.query('DELETE FROM hr_application_status_history WHERE application_id = ANY($1)', [appIds]);
  await pool.query('DELETE FROM hr_applications WHERE id = ANY($1)', [appIds]);
  await pool.query('DELETE FROM hr_candidates c WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM hr_applications a WHERE a.candidate_id = c.id)', [candIds]);
  await pool.query('DELETE FROM hr_job_slugs WHERE job_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM hr_jobs WHERE id = ANY($1)', [ids]);
  return { jobs: ids.length, paths: apps.map((a) => a.resume_storage_path).filter(Boolean) };
}
