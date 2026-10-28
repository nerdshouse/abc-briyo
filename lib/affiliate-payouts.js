import { getPool } from './db.js';
import { newAffiliatePublicId, bad, clean, tx, lockAffiliate, logAffiliateEvent, checkVersion } from './affiliates.js';
import { ensureAffiliateReferralSchema } from './affiliate-referrals.js';

/**
 * Affiliate payouts and TDS (Phase 2B) — approved commissions are paid in batches through the bank, with TDS deducted.
 *
 *   Payout details   on the affiliate: PAN, the account holder's name, account number and IFSC. Shown masked; the full
 *                    values leave Briyo OS only in a batch's bank file (affiliate.payouts).
 *   Batch            every approved INR commission not already in an open payout, of affiliates with complete bank
 *                    details, grouped into one payout per affiliate. One batch is created at a time (advisory lock),
 *                    so two batches can never both count the same year's TDS.
 *   Payout           gross (the commissions), TDS, net = gross − TDS, the payee's details as they were when the batch
 *                    was made. pending → paid (with the bank's UTR and date: its commissions become paid in the same
 *                    transaction) | failed (with a reason: its commissions are free for the next batch) | cancelled.
 *                    Amounts and the payee snapshot never change (database trigger); nothing is deleted.
 *   Item             one commission in one payout; a commission is in at most one live payout (partial unique index).
 *
 * TDS (affiliate_settings, editable; confirm with a CA): Section 194H, 2% once an affiliate's commission in the
 * financial year (April–March, IST) passes ₹20,000; 20% with no PAN on file. Once the threshold is crossed the rate
 * applies to the whole year's commission: a payout's TDS = rate × (the year's gross so far, this payout included)
 * − TDS already deducted this year, never below 0 or above the payout. "So far" counts pending and paid payouts.
 * Amounts are worked in paise (integers); nothing uses floating point for money.
 */

export const PAYOUT_STATUSES = ['pending', 'paid', 'failed', 'cancelled'];
export const BATCH_STATUSES = ['open', 'closed', 'cancelled'];
export const TDS_DEFAULTS = { tds_section: '194H', tds_rate_bps: 200, tds_no_pan_rate_bps: 2000, tds_threshold_inr: 20000 };
export const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^[0-9]{6,18}$/;
const UTR = /^[A-Za-z0-9]{6,40}$/;
const REF = /^[A-HJKMNP-Z2-9]{10}$/;

let schema = null;
export function ensureAffiliatePayoutSchema() {
  if (!schema) {
    schema = (async () => {
      await ensureAffiliateReferralSchema();
      const ddl = [];
      ddl.push(`ALTER TABLE affiliates
        ADD COLUMN IF NOT EXISTS pan TEXT CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
        ADD COLUMN IF NOT EXISTS payee_name TEXT CHECK (length(payee_name) <= 120),
        ADD COLUMN IF NOT EXISTS bank_account TEXT CHECK (bank_account IS NULL OR bank_account ~ '^[0-9]{6,18}$'),
        ADD COLUMN IF NOT EXISTS bank_ifsc TEXT CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
        ADD COLUMN IF NOT EXISTS payout_details_updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS payout_details_updated_by TEXT`);
      ddl.push(`INSERT INTO affiliate_settings (key, value, updated_by) VALUES
        ${Object.entries(TDS_DEFAULTS).map(([k, v]) => `('${k}', '${JSON.stringify(v)}'::jsonb, 'system')`).join(', ')}
        ON CONFLICT (key) DO NOTHING`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_payout_batches (
          id            BIGSERIAL PRIMARY KEY,
          public_id     TEXT NOT NULL CHECK (public_id ~ '^[A-HJKMNP-Z2-9]{10}$'),
          status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
          currency      TEXT NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
          note          TEXT CHECK (length(note) <= 300),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by    TEXT,
          closed_at     TIMESTAMPTZ,
          cancelled_at  TIMESTAMPTZ,
          cancelled_by  TEXT,
          cancel_reason TEXT CHECK (length(cancel_reason) <= 300),
          version       INTEGER NOT NULL DEFAULT 1,
          CONSTRAINT affiliate_payout_batches_public_id_key UNIQUE (public_id),
          CONSTRAINT affiliate_payout_batches_cancel CHECK (status <> 'cancelled' OR btrim(coalesce(cancel_reason, '')) <> '')
        )`);
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_payouts (
          id             BIGSERIAL PRIMARY KEY,
          public_id      TEXT NOT NULL CHECK (public_id ~ '^[A-HJKMNP-Z2-9]{10}$'),
          batch_id       BIGINT NOT NULL REFERENCES affiliate_payout_batches(id) ON DELETE RESTRICT,
          affiliate_id   BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          currency       TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
          gross_amount   NUMERIC(14,2) NOT NULL CHECK (gross_amount > 0),
          tds_section    TEXT NOT NULL CHECK (length(tds_section) <= 20),
          tds_rate_bps   INTEGER NOT NULL CHECK (tds_rate_bps BETWEEN 0 AND 10000),
          tds_amount     NUMERIC(14,2) NOT NULL CHECK (tds_amount >= 0),
          net_amount     NUMERIC(14,2) NOT NULL,
          financial_year TEXT NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
          pan            TEXT,
          payee_name     TEXT NOT NULL,
          bank_account   TEXT NOT NULL,
          bank_ifsc      TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
          utr            TEXT,
          paid_on        DATE,
          paid_at        TIMESTAMPTZ,
          paid_by        TEXT,
          failure_reason TEXT CHECK (length(failure_reason) <= 300),
          version        INTEGER NOT NULL DEFAULT 1,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by     TEXT,
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by     TEXT,
          CONSTRAINT affiliate_payouts_public_id_key UNIQUE (public_id),
          CONSTRAINT affiliate_payouts_one_per_batch UNIQUE (batch_id, affiliate_id),
          CONSTRAINT affiliate_payouts_net CHECK (net_amount = gross_amount - tds_amount AND tds_amount <= gross_amount),
          CONSTRAINT affiliate_payouts_paid CHECK (status <> 'paid' OR (btrim(coalesce(utr, '')) <> '' AND paid_on IS NOT NULL)),
          CONSTRAINT affiliate_payouts_failed CHECK (status <> 'failed' OR btrim(coalesce(failure_reason, '')) <> '')
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_payouts_affiliate_idx ON affiliate_payouts (affiliate_id, financial_year)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_payout_items (
          id            BIGSERIAL PRIMARY KEY,
          payout_id     BIGINT NOT NULL REFERENCES affiliate_payouts(id) ON DELETE RESTRICT,
          commission_id BIGINT NOT NULL REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
          amount        NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
          active        BOOLEAN NOT NULL DEFAULT true
        )`);
      // A commission is in at most one live payout; a failed or cancelled payout releases it (active = false).
      ddl.push('CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payout_items_one_live ON affiliate_payout_items (commission_id) WHERE active');
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_payout_items_payout_idx ON affiliate_payout_items (payout_id)');
      ddl.push(`
        CREATE OR REPLACE FUNCTION affiliate_payout_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.purge_affiliates', true) = 'on' OR current_setting('app.purge_orders', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
          END IF;
          IF TG_TABLE_NAME = 'affiliate_payout_items' THEN
            IF NEW.payout_id IS DISTINCT FROM OLD.payout_id OR NEW.commission_id IS DISTINCT FROM OLD.commission_id
               OR NEW.amount IS DISTINCT FROM OLD.amount OR (NEW.active AND NOT OLD.active) THEN
              RAISE EXCEPTION 'a payout item only ever stops being live';
            END IF;
          ELSIF TG_TABLE_NAME = 'affiliate_payouts' THEN
            IF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.affiliate_id IS DISTINCT FROM OLD.affiliate_id OR NEW.currency IS DISTINCT FROM OLD.currency
               OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount OR NEW.tds_section IS DISTINCT FROM OLD.tds_section
               OR NEW.tds_rate_bps IS DISTINCT FROM OLD.tds_rate_bps OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount
               OR NEW.net_amount IS DISTINCT FROM OLD.net_amount OR NEW.financial_year IS DISTINCT FROM OLD.financial_year
               OR NEW.pan IS DISTINCT FROM OLD.pan OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
               OR NEW.bank_account IS DISTINCT FROM OLD.bank_account OR NEW.bank_ifsc IS DISTINCT FROM OLD.bank_ifsc
               OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
              RAISE EXCEPTION 'a payout''s amounts and payee are fixed when it is created; only its status changes';
            END IF;
            IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('paid', 'failed', 'cancelled')) THEN
              RAISE EXCEPTION 'a % payout cannot become %', OLD.status, NEW.status;
            END IF;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['affiliate_payout_batches', 'affiliate_payouts', 'affiliate_payout_items']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_guard ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_guard BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION affiliate_payout_guard()`);
      }
      await getPool().query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

/* ------------------------------------------------------------------ money and dates */

/** "1234.5" / "1234.50" / 1234.5 → 123450 paise. Throws on anything else. */
export function toPaise(v) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? '').trim());
  if (!m) throw new Error(`Not an amount: ${v}`);
  const p = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -p : p;
}
export const fromPaise = (p) => `${p < 0 ? '-' : ''}${Math.trunc(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;

/** India's financial year (April–March, IST) of a moment: "2026-27". */
export function financialYearOf(at = new Date()) {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date(at)).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * TDS on one payout. All amounts in paise. Below the threshold (the year's gross including this payout) nothing is
 * deducted; at or above it, the rate (no-PAN rate without a PAN) applies to the whole year's gross, less what was
 * already deducted this year, kept within 0 … the payout's gross.
 */
export function computeTds({ grossPaise, fyGrossBeforePaise = 0, fyTdsBeforePaise = 0, hasPan, settings }) {
  const s = { ...TDS_DEFAULTS, ...settings };
  const total = fyGrossBeforePaise + grossPaise;
  if (total <= Number(s.tds_threshold_inr) * 100) return { rateBps: 0, tdsPaise: 0, belowThreshold: true };
  const rateBps = hasPan ? Number(s.tds_rate_bps) : Number(s.tds_no_pan_rate_bps);
  const due = Math.round((total * rateBps) / 10000) - fyTdsBeforePaise;
  return { rateBps, tdsPaise: Math.min(Math.max(due, 0), grossPaise), belowThreshold: false };
}

export async function tdsSettings(db = getPool()) {
  const { rows } = await db.query('SELECT key, value FROM affiliate_settings WHERE key = ANY($1)', [Object.keys(TDS_DEFAULTS)]);
  return { ...TDS_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

/** Changes the TDS settings (affiliate.payouts). Applies to batches made from now on; made payouts keep theirs. */
export async function updateTdsSettings(input = {}, { actor } = {}) {
  await ensureAffiliatePayoutSchema();
  const cur = await tdsSettings();
  const next = { ...cur };
  const pct = (v, field) => {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(v ?? '').trim());
    const bps = m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : NaN;
    if (!(bps >= 0 && bps <= 10000)) throw bad('Enter a percentage from 0 to 100, up to 2 decimals.', 400, { field });
    return bps;
  };
  if (input.tds_section !== undefined) {
    const sec = clean(input.tds_section, 21);
    if (!sec || sec.length > 20) throw bad('Enter the section, e.g. 194H.', 400, { field: 'tds_section' });
    next.tds_section = sec;
  }
  if (input.tds_rate_percent !== undefined) next.tds_rate_bps = pct(input.tds_rate_percent, 'tds_rate_percent');
  if (input.tds_no_pan_rate_percent !== undefined) next.tds_no_pan_rate_bps = pct(input.tds_no_pan_rate_percent, 'tds_no_pan_rate_percent');
  if (input.tds_threshold_inr !== undefined) {
    const t = String(input.tds_threshold_inr).trim();
    if (!/^\d{1,9}$/.test(t)) throw bad('Enter the yearly threshold in whole rupees.', 400, { field: 'tds_threshold_inr' });
    next.tds_threshold_inr = Number(t);
  }
  const changed = Object.keys(TDS_DEFAULTS).filter((k) => next[k] !== cur[k]);
  if (!changed.length) return next;
  await tx(async (db) => {
    for (const k of changed) {
      await db.query(`INSERT INTO affiliate_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = affiliate_settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [k, JSON.stringify(next[k]), actor || null]);
    }
    await logAffiliateEvent(db, null, 'tds_settings_changed', actor, { changes: Object.fromEntries(changed.map((k) => [k, { from: cur[k], to: next[k] }])) }, 'settings', 'tds');
  });
  return next;
}

/* ------------------------------------------------------------------ payout details */

const maskAccount = (v) => (v ? `•••• ${v.slice(-4)}` : null);
const maskPan = (v) => (v ? `${'•'.repeat(6)}${v.slice(-4)}` : null);
const detailsOf = (a) => ({
  pan: maskPan(a.pan), has_pan: Boolean(a.pan), payee_name: a.payee_name || null, bank_account: maskAccount(a.bank_account), bank_ifsc: a.bank_ifsc || null,
  complete: Boolean(a.payee_name && a.bank_account && a.bank_ifsc), updated_at: a.payout_details_updated_at, updated_by: a.payout_details_updated_by,
});

/** An affiliate's payout details, masked (PAN and account show their last 4 characters). */
export async function getPayoutDetails(publicId) {
  await ensureAffiliatePayoutSchema();
  const { rows: [a] } = await getPool().query('SELECT * FROM affiliates WHERE public_id = $1', [String(publicId || '').toUpperCase()]);
  return a ? { ...detailsOf(a), version: a.version } : null;
}

/**
 * Sets PAN and bank details. A blank field leaves the stored value as it is (they are never shown in full, so the
 * form cannot echo them back); `clear_pan: true` removes the PAN. Only the names of the changed fields are logged.
 */
export async function setPayoutDetails(publicId, input = {}, { actor, version } = {}) {
  await ensureAffiliatePayoutSchema();
  const f = {};
  const up = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();
  if (String(input.pan ?? '').trim()) {
    f.pan = up(input.pan);
    if (!PAN.test(f.pan)) throw bad('A PAN is 10 characters: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F).', 400, { field: 'pan' });
  } else if (input.clear_pan === true || input.clear_pan === 'true') f.pan = null;
  if (input.payee_name !== undefined && String(input.payee_name).trim()) {
    f.payee_name = clean(input.payee_name, 121);
    if (f.payee_name.length > 120) throw bad('Keep the account holder name under 120 characters.', 400, { field: 'payee_name' });
  }
  if (String(input.bank_account ?? '').trim()) {
    f.bank_account = String(input.bank_account).replace(/\s+/g, '');
    if (!ACCOUNT.test(f.bank_account)) throw bad('The account number is 6–18 digits.', 400, { field: 'bank_account' });
  }
  if (String(input.bank_ifsc ?? '').trim()) {
    f.bank_ifsc = up(input.bank_ifsc);
    if (!IFSC.test(f.bank_ifsc)) throw bad('An IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234).', 400, { field: 'bank_ifsc' });
  }
  return tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    checkVersion(a, version);
    if (a.status === 'closed') throw bad('A closed affiliate cannot be changed.', 409);
    const changed = Object.keys(f).filter((k) => (a[k] ?? null) !== f[k]);
    if (!changed.length) return { ...detailsOf(a), version: a.version };
    const keys = [...changed];
    await db.query(`UPDATE affiliates SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')},
        payout_details_updated_at = now(), payout_details_updated_by = $${keys.length + 2}, version = version + 1, updated_at = now(), updated_by = $${keys.length + 2}
      WHERE id = $1`, [a.id, ...keys.map((k) => f[k]), actor || null]);
    await logAffiliateEvent(db, a.id, 'payout_details_updated', actor, { fields: changed });
    const { rows: [b] } = await db.query('SELECT * FROM affiliates WHERE id = $1', [a.id]);
    return { ...detailsOf(b), version: b.version };
  });
}

/* ------------------------------------------------------------------ batches */

/** Approved commissions that can be paid now, per affiliate, with what holds any of them back. Reads only. */
async function payable(db, { lock = false } = {}) {
  const { rows } = await db.query(`
    SELECT c.id, c.affiliate_id, c.currency, c.commission_amount::text AS amount, a.public_id, a.display_name, a.status AS affiliate_status,
           a.pan, a.payee_name, a.bank_account, a.bank_ifsc,
           (o.order_status = 'cancelled' OR f.cancelled_at IS NOT NULL) AS order_cancelled, o.source_payload->'shopify'->>'name' AS order_name
    FROM affiliate_commissions c JOIN affiliates a ON a.id = c.affiliate_id JOIN orders o ON o.id = c.order_id
    LEFT JOIN order_financial_latest f ON f.order_id = c.order_id
    WHERE c.status = 'approved' AND NOT EXISTS (SELECT 1 FROM affiliate_payout_items i WHERE i.commission_id = c.id AND i.active)
    ORDER BY a.id, c.id ${lock ? 'FOR UPDATE OF c' : ''}`);
  return rows;
}

async function fyTotals(db, affiliateId, fy) {
  const { rows: [t] } = await db.query(
    `SELECT coalesce(sum(gross_amount), 0)::text AS gross, coalesce(sum(tds_amount), 0)::text AS tds FROM affiliate_payouts
     WHERE affiliate_id = $1 AND financial_year = $2 AND status IN ('pending', 'paid')`, [affiliateId, fy]);
  return { gross: toPaise(t.gross), tds: toPaise(t.tds) };
}

/** The batch that would be made now: one payout per affiliate, with TDS; and every approved commission held back, and why. */
async function plan(db, { exclude = [], only = null, lock = false, now = new Date() } = {}) {
  const settings = await tdsSettings(db);
  const fy = financialYearOf(now);
  const skip = new Set(exclude.map((x) => String(x).toUpperCase()));
  // `only` (internal: tests, scripts) limits the batch to these affiliates; the screen always offers everyone.
  const just = only ? new Set(only.map((x) => String(x).toUpperCase())) : null;
  const by = new Map();
  const held = [];
  for (const r of await payable(db, { lock })) {
    if (just && !just.has(r.public_id)) continue;
    const why = r.currency !== 'INR' ? `Paid in ${r.currency}: only INR payouts are supported`
      : r.order_cancelled ? 'Its order is cancelled: reverse this commission instead'
        : null;
    if (why) { held.push({ affiliate: r.public_id, name: r.display_name, order: r.order_name, amount: r.amount, currency: r.currency, reason: why }); continue; }
    const g = by.get(r.affiliate_id) || { r, ids: [], items: [], grossPaise: 0 };
    g.ids.push(Number(r.id)); g.items.push({ id: Number(r.id), paise: toPaise(r.amount) }); g.grossPaise += toPaise(r.amount);
    by.set(r.affiliate_id, g);
  }
  const payouts = [];
  const blocked = [];
  for (const [affiliateId, g] of by) {
    const a = g.r;
    const base = { affiliate: a.public_id, name: a.display_name, affiliate_status: a.affiliate_status, commissions: g.ids.length, gross: fromPaise(g.grossPaise) };
    if (skip.has(a.public_id)) { blocked.push({ ...base, reason: 'Left out of this batch' }); continue; }
    if (!(a.payee_name && a.bank_account && a.bank_ifsc)) { blocked.push({ ...base, reason: 'Bank details are missing: add the account holder, account number and IFSC' }); continue; }
    const before = await fyTotals(db, affiliateId, fy);
    const t = computeTds({ grossPaise: g.grossPaise, fyGrossBeforePaise: before.gross, fyTdsBeforePaise: before.tds, hasPan: Boolean(a.pan), settings });
    payouts.push({
      ...base, affiliate_id: affiliateId, items: g.items, gross_paise: g.grossPaise, has_pan: Boolean(a.pan),
      fy_gross_before: fromPaise(before.gross), tds_rate_bps: t.rateBps, tds: fromPaise(t.tdsPaise), net: fromPaise(g.grossPaise - t.tdsPaise),
      tds_paise: t.tdsPaise, below_threshold: t.belowThreshold, payee: { pan: a.pan, name: a.payee_name, account: a.bank_account, ifsc: a.bank_ifsc },
    });
  }
  const sum = (k) => fromPaise(payouts.reduce((n, p) => n + toPaise(p[k]), 0));
  return { financial_year: fy, settings, payouts, blocked, held, totals: { payouts: payouts.length, gross: sum('gross'), tds: sum('tds'), net: sum('net') } };
}
const publicPlan = (p) => ({
  ...p,
  payouts: p.payouts.map(({ affiliate_id: _a, items: _i, gross_paise: _g, tds_paise: _t, payee, ...x }) => ({ ...x, bank_account: maskAccount(payee.account), bank_ifsc: payee.ifsc })),
});

/** What a new batch would contain now. Reads only; nothing is reserved. */
export async function previewPayoutBatch({ exclude = [], only = null } = {}) {
  await ensureAffiliatePayoutSchema();
  return publicPlan(await plan(getPool(), { exclude, only }));
}

/** Makes the batch: its payouts (TDS fixed now), and their commissions taken out of the pool. All or nothing. */
export async function createPayoutBatch({ exclude = [], only = null, note = '', actor } = {}) {
  await ensureAffiliatePayoutSchema();
  const memo = clean(note, 301);
  if (memo && memo.length > 300) throw bad('Keep the note under 300 characters.', 400, { field: 'note' });
  return tx(async (db) => {
    // One batch at a time: the year's TDS of each affiliate is read and then extended in this transaction.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('affiliate_payout_batch'))`);
    const p = await plan(db, { exclude, only, lock: true });
    if (!p.payouts.length) throw bad('There is nothing to pay: no approved commission with complete bank details is waiting.', 409);
    const ref = newAffiliatePublicId(10);
    const { rows: [b] } = await db.query('INSERT INTO affiliate_payout_batches (public_id, note, created_by) VALUES ($1, $2, $3) RETURNING id', [ref, memo, actor || null]);
    for (const x of p.payouts) {
      const pref = newAffiliatePublicId(10);
      const { rows: [po] } = await db.query(
        `INSERT INTO affiliate_payouts (public_id, batch_id, affiliate_id, currency, gross_amount, tds_section, tds_rate_bps, tds_amount, net_amount, financial_year,
           pan, payee_name, bank_account, bank_ifsc, created_by, updated_by)
         VALUES ($1, $2, $3, 'INR', $4::numeric, $5, $6, $7::numeric, $8::numeric, $9, $10, $11, $12, $13, $14, $14) RETURNING id`,
        [pref, b.id, x.affiliate_id, x.gross, p.settings.tds_section, x.tds_rate_bps, x.tds, x.net, p.financial_year,
          x.payee.pan, x.payee.name, x.payee.account, x.payee.ifsc, actor || null]);
      for (const it of x.items) await db.query('INSERT INTO affiliate_payout_items (payout_id, commission_id, amount) VALUES ($1, $2, $3::numeric)', [po.id, it.id, fromPaise(it.paise)]);
      await logAffiliateEvent(db, x.affiliate_id, 'payout_created', actor, {
        batch: ref, payout: pref, commissions: x.items.length, gross: x.gross, tds: x.tds, tds_rate_bps: x.tds_rate_bps, net: x.net, financial_year: p.financial_year,
      }, 'payout', pref);
    }
    await logAffiliateEvent(db, null, 'payout_batch_created', actor, { batch: ref, payouts: p.payouts.length, ...p.totals }, 'payout_batch', ref);
    return { ref };
  });
}

const toPayout = (r) => ({
  ref: r.public_id, affiliate: r.affiliate_ref, name: r.display_name, status: r.status, currency: r.currency,
  gross: r.gross_amount, tds_section: r.tds_section, tds_rate_bps: r.tds_rate_bps, tds: r.tds_amount, net: r.net_amount, financial_year: r.financial_year,
  has_pan: Boolean(r.pan), pan: maskPan(r.pan), payee_name: r.payee_name, bank_account: maskAccount(r.bank_account), bank_ifsc: r.bank_ifsc,
  utr: r.utr, paid_on: r.paid_on, paid_at: r.paid_at, paid_by: r.paid_by, failure_reason: r.failure_reason, commissions: r.commissions, version: r.version,
});
const PAYOUT_SQL = `SELECT p.*, p.gross_amount::text AS gross_amount, p.tds_amount::text AS tds_amount, p.net_amount::text AS net_amount, p.paid_on::text AS paid_on,
    a.public_id AS affiliate_ref, a.display_name, (SELECT count(*)::int FROM affiliate_payout_items i WHERE i.payout_id = p.id) AS commissions
  FROM affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id`;

export async function listPayoutBatches({ limit = 50 } = {}) {
  await ensureAffiliatePayoutSchema();
  const { rows } = await getPool().query(`
    SELECT b.*, count(p.id)::int AS payouts,
           count(p.id) FILTER (WHERE p.status = 'pending')::int AS pending, count(p.id) FILTER (WHERE p.status = 'paid')::int AS paid,
           count(p.id) FILTER (WHERE p.status = 'failed')::int AS failed,
           coalesce(sum(p.gross_amount) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS gross,
           coalesce(sum(p.tds_amount) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS tds,
           coalesce(sum(p.net_amount) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS net
    FROM affiliate_payout_batches b LEFT JOIN affiliate_payouts p ON p.batch_id = b.id
    GROUP BY b.id ORDER BY b.created_at DESC, b.id DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 50, 1), 200)]);
  return rows.map((b) => ({
    ref: b.public_id, status: b.status, currency: b.currency, note: b.note, created_at: b.created_at, created_by: b.created_by, closed_at: b.closed_at,
    cancelled_at: b.cancelled_at, cancel_reason: b.cancel_reason, payouts: b.payouts, pending: b.pending, paid: b.paid, failed: b.failed, gross: b.gross, tds: b.tds, net: b.net,
  }));
}

export async function getPayoutBatch(ref) {
  await ensureAffiliatePayoutSchema();
  const r = String(ref || '').toUpperCase();
  if (!REF.test(r)) return null;
  const db = getPool();
  const { rows: [b] } = await db.query('SELECT * FROM affiliate_payout_batches WHERE public_id = $1', [r]);
  if (!b) return null;
  const { rows } = await db.query(`${PAYOUT_SQL} WHERE p.batch_id = $1 ORDER BY a.display_name, p.id`, [b.id]);
  const live = rows.filter((p) => p.status !== 'cancelled');
  const sum = (k) => fromPaise(live.reduce((n, p) => n + toPaise(p[k]), 0));
  return {
    ref: b.public_id, status: b.status, currency: b.currency, note: b.note, created_at: b.created_at, created_by: b.created_by, closed_at: b.closed_at,
    cancelled_at: b.cancelled_at, cancelled_by: b.cancelled_by, cancel_reason: b.cancel_reason, version: b.version,
    totals: { gross: sum('gross_amount'), tds: sum('tds_amount'), net: sum('net_amount') },
    payouts: rows.map(toPayout),
  };
}

/** Closes the batch once no payout is pending: closed when any was paid, cancelled when none was. */
async function settleBatch(db, batchId, actor) {
  const { rows: [s] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'paid')::int AS paid FROM affiliate_payouts WHERE batch_id = $1`, [batchId]);
  if (s.pending) return;
  if (s.paid) await db.query(`UPDATE affiliate_payout_batches SET status = 'closed', closed_at = now(), version = version + 1 WHERE id = $1 AND status = 'open'`, [batchId]);
  else {
    await db.query(`UPDATE affiliate_payout_batches SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Every payout failed or was cancelled', version = version + 1
                    WHERE id = $1 AND status = 'open'`, [batchId, actor || null]);
  }
}

async function lockPayout(db, payoutRef) {
  const r = String(payoutRef || '').toUpperCase();
  if (!REF.test(r)) throw bad('No such payout.', 404);
  const { rows: [p] } = await db.query(`SELECT p.*, a.public_id AS affiliate_ref FROM affiliate_payouts p JOIN affiliates a ON a.id = p.affiliate_id WHERE p.public_id = $1 FOR UPDATE OF p`, [r]);
  if (!p) throw bad('No such payout.', 404);
  return p;
}

/** The bank has paid it: records the UTR and date, and marks its commissions paid, in one transaction. */
export async function markPayoutPaid(payoutRef, { utr, paid_on: paidOn, actor, version } = {}) {
  await ensureAffiliatePayoutSchema();
  const ref = String(utr ?? '').trim();
  if (!UTR.test(ref)) throw bad('Enter the bank reference (UTR): 6–40 letters or digits.', 400, { field: 'utr' });
  const day = String(paidOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00+05:30`).getTime())) throw bad('Enter the date the bank paid it.', 400, { field: 'paid_on' });
  if (new Date(`${day}T00:00:00+05:30`) > new Date()) throw bad('The payment date cannot be in the future.', 400, { field: 'paid_on' });
  return tx(async (db) => {
    const p = await lockPayout(db, payoutRef);
    if (version !== undefined && version !== null && Number(version) !== p.version) throw bad('Someone else changed this payout. Reload.', 409, { conflict: true });
    if (p.status !== 'pending') throw bad(`This payout is already ${p.status}.`, 409);
    const { rows: dup } = await db.query(`SELECT public_id FROM affiliate_payouts WHERE lower(utr) = lower($1) AND id <> $2 LIMIT 1`, [ref, p.id]);
    if (dup.length) throw bad(`UTR ${ref} is already recorded on another payout.`, 409, { field: 'utr' });
    await db.query(`UPDATE affiliate_payouts SET status = 'paid', utr = $2, paid_on = $3::date, paid_at = now(), paid_by = $4, version = version + 1, updated_at = now(), updated_by = $4 WHERE id = $1`,
      [p.id, ref, day, actor || null]);
    const { rows: items } = await db.query(
      `SELECT c.id, c.status, o.source_payload->'shopify'->>'name' AS order_name FROM affiliate_payout_items i JOIN affiliate_commissions c ON c.id = i.commission_id
       JOIN orders o ON o.id = c.order_id WHERE i.payout_id = $1 AND i.active ORDER BY c.id FOR UPDATE OF c`, [p.id]);
    for (const c of items) {
      if (c.status !== 'approved') throw bad(`Order ${c.order_name}'s commission is ${c.status}, not approved. Mark this payout failed and make a new batch.`, 409);
      await db.query(`UPDATE affiliate_commissions SET status = 'paid', status_reason = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`,
        [c.id, `Payout ${p.public_id}, UTR ${ref}`, actor || null]);
      await db.query('INSERT INTO affiliate_commission_events (commission_id, from_status, to_status, actor, reason) VALUES ($1, $2, $3, $4, $5)',
        [c.id, 'approved', 'paid', actor || null, `Payout ${p.public_id}, UTR ${ref}`]);
    }
    await logAffiliateEvent(db, p.affiliate_id, 'payout_paid', actor, { payout: p.public_id, utr: ref, paid_on: day, net: p.net_amount, tds: p.tds_amount, commissions: items.length }, 'payout', p.public_id);
    await settleBatch(db, p.batch_id, actor);
    return { ref: p.public_id, status: 'paid' };
  });
}

/** The bank rejected it (wrong account, …): a reason is required, and its commissions are free for the next batch. */
export async function markPayoutFailed(payoutRef, { reason, actor, version } = {}) {
  await ensureAffiliatePayoutSchema();
  const why = clean(reason, 301);
  if (!why) throw bad('Give the reason the payment failed.', 400, { field: 'reason' });
  if (why.length > 300) throw bad('Keep the reason under 300 characters.', 400, { field: 'reason' });
  return tx(async (db) => {
    const p = await lockPayout(db, payoutRef);
    if (version !== undefined && version !== null && Number(version) !== p.version) throw bad('Someone else changed this payout. Reload.', 409, { conflict: true });
    if (p.status !== 'pending') throw bad(`This payout is already ${p.status}.`, 409);
    await db.query(`UPDATE affiliate_payouts SET status = 'failed', failure_reason = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1`, [p.id, why, actor || null]);
    const { rowCount } = await db.query('UPDATE affiliate_payout_items SET active = false WHERE payout_id = $1 AND active', [p.id]);
    await logAffiliateEvent(db, p.affiliate_id, 'payout_failed', actor, { payout: p.public_id, reason: why, commissions_released: rowCount }, 'payout', p.public_id);
    await settleBatch(db, p.batch_id, actor);
    return { ref: p.public_id, status: 'failed' };
  });
}

/** Cancels a batch before any of it is paid: every payout is cancelled and its commissions go back to the pool. */
export async function cancelPayoutBatch(batchRef, { reason, actor } = {}) {
  await ensureAffiliatePayoutSchema();
  const why = clean(reason, 301);
  if (!why) throw bad('Give a reason.', 400, { field: 'reason' });
  if (why.length > 300) throw bad('Keep the reason under 300 characters.', 400, { field: 'reason' });
  const r = String(batchRef || '').toUpperCase();
  return tx(async (db) => {
    const { rows: [b] } = await db.query('SELECT * FROM affiliate_payout_batches WHERE public_id = $1 FOR UPDATE', [r]);
    if (!b) throw bad('No such batch.', 404);
    if (b.status !== 'open') throw bad(`This batch is already ${b.status}.`, 409);
    const { rows: [paid] } = await db.query(`SELECT count(*)::int AS n FROM affiliate_payouts WHERE batch_id = $1 AND status = 'paid'`, [b.id]);
    if (paid.n) throw bad('Some payouts in this batch are already paid, so it cannot be cancelled. Mark the remaining ones failed instead.', 409);
    const { rows: ps } = await db.query(`UPDATE affiliate_payouts SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = $2
                                         WHERE batch_id = $1 AND status = 'pending' RETURNING id, affiliate_id, public_id`, [b.id, actor || null]);
    if (ps.length) await db.query('UPDATE affiliate_payout_items SET active = false WHERE payout_id = ANY($1) AND active', [ps.map((x) => x.id)]);
    await db.query(`UPDATE affiliate_payout_batches SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, version = version + 1 WHERE id = $1`, [b.id, actor || null, why]);
    for (const x of ps) await logAffiliateEvent(db, x.affiliate_id, 'payout_cancelled', actor, { payout: x.public_id, batch: r, reason: why }, 'payout', x.public_id);
    await logAffiliateEvent(db, null, 'payout_batch_cancelled', actor, { batch: r, reason: why, payouts: ps.length }, 'payout_batch', r);
    return { ref: r, status: 'cancelled' };
  });
}

/* ------------------------------------------------------------------ files */

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s; };
const csv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/**
 * The bank-upload file of a batch: one row per pending payout, with the full account number (the only place it
 * leaves Briyo OS). Columns most Indian corporate-banking bulk uploads accept; adjust the order in the bank's template
 * if it differs. Each download is logged.
 */
export async function payoutBankFile(batchRef, { actor } = {}) {
  await ensureAffiliatePayoutSchema();
  const r = String(batchRef || '').toUpperCase();
  const db = getPool();
  const { rows: [b] } = await db.query('SELECT id, public_id FROM affiliate_payout_batches WHERE public_id = $1', [r]);
  if (!b) throw bad('No such batch.', 404);
  const { rows } = await db.query(`SELECT p.*, p.net_amount::text AS net, a.public_id AS affiliate_ref, a.contact_email, a.contact_phone FROM affiliate_payouts p
    JOIN affiliates a ON a.id = p.affiliate_id WHERE p.batch_id = $1 AND p.status = 'pending' ORDER BY p.payee_name, p.id`, [b.id]);
  if (!rows.length) throw bad('No payout in this batch is waiting to be paid.', 409);
  await logAffiliateEvent(db, null, 'payout_bank_file_downloaded', actor, { batch: r, payouts: rows.length }, 'payout_batch', r);
  return {
    filename: `briyo-affiliate-payouts-${r}.csv`,
    body: csv([['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Payment Reference', 'Narration', 'Email', 'Phone'],
      ...rows.map((p) => [p.payee_name, p.bank_account, p.bank_ifsc, p.net, p.public_id, `Briyo affiliate commission ${r}`, p.contact_email || '', p.contact_phone || ''])]),
  };
}

/** Quarter of the financial year (Q1 = April–June) of an IST date "YYYY-MM-DD". */
const quarterOf = (day) => { const m = Number(day.slice(5, 7)); return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'; };

/** The TDS register of a financial year: every paid payout, for the quarterly TDS return (26Q) and Form 16A. */
export async function tdsRegister({ fy } = {}) {
  await ensureAffiliatePayoutSchema();
  const year = String(fy || financialYearOf()).trim();
  if (!/^\d{4}-\d{2}$/.test(year)) throw bad('Choose a financial year, e.g. 2026-27.', 400, { field: 'fy' });
  const { rows } = await getPool().query(`${PAYOUT_SQL} WHERE p.financial_year = $1 AND p.status = 'paid' ORDER BY p.paid_on, p.id`, [year]);
  return {
    filename: `briyo-affiliate-tds-${year}.csv`,
    body: csv([['Financial year', 'Quarter', 'Paid on', 'Affiliate', 'Affiliate ID', 'Payee', 'PAN', 'Section', 'Gross commission', 'TDS rate %', 'TDS deducted', 'Net paid', 'UTR', 'Payout'],
      ...rows.map((p) => [p.financial_year, quarterOf(p.paid_on), p.paid_on, p.display_name, p.affiliate_ref, p.payee_name, p.pan || 'PAN NOT AVAILABLE', p.tds_section,
        p.gross_amount, (p.tds_rate_bps / 100).toFixed(2), p.tds_amount, p.net_amount, p.utr, p.public_id])]),
    rows: rows.length,
  };
}

/** An affiliate's payouts (newest first), for its page. */
export async function affiliatePayouts(publicId) {
  await ensureAffiliatePayoutSchema();
  const { rows } = await getPool().query(`${PAYOUT_SQL} WHERE a.public_id = $1 ORDER BY p.created_at DESC, p.id DESC`, [String(publicId || '').toUpperCase()]);
  return rows.map(toPayout);
}

/** Whether a commission sits in a payout that is not yet settled (so it must not be reversed or paid by hand). */
export async function commissionInOpenPayout(db, commissionId) {
  const { rows: [x] } = await db.query(
    `SELECT p.public_id FROM affiliate_payout_items i JOIN affiliate_payouts p ON p.id = i.payout_id WHERE i.commission_id = $1 AND i.active AND p.status = 'pending'`, [commissionId]);
  return x ? x.public_id : null;
}
