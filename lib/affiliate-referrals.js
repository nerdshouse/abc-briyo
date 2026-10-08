import { lastIstDaysSql } from './timezone.js';
import crypto from 'node:crypto';
import { getPool } from './db.js';
import { ensureOrdersSchema } from './orders.js';
import { rateLimit } from './rate-limit.js';
import { normalizeHost } from './careers.js';
import { ensureAffiliateSchema, newAffiliatePublicId, bad, clean, tx, lockAffiliate, logAffiliateEvent, hasApprovedVerification } from './affiliates.js';
import { ensureAffiliateVerificationSchema } from './affiliate-verification.js';
import { createCommissionForAttribution } from './affiliate-commissions.js';

/**
 * Referral assets, clicks and order attribution (Phase 1E) — the attribution
 * rail, not the money rail. Nothing here calculates or pays a commission.
 *
 *   briyosupplements.com/r/{affiliate public id}      the public link (a Shopify URL redirect, set up explicitly)
 *     → {AFFILIATE_CLICK_HOST}/r/{affiliate public id} this app, on its own isolated host: records a click
 *     → 302 to the storefront with ?bref=…&bclid=…    built server-side from a fixed base; never an open redirect
 *     → storefront snippet keeps bref/bclid as private cart attributes (__briyo_ref, __briyo_click)
 *     → the order carries them → the existing Shopify order sync reads them → one attribution per order
 *
 *   affiliate_referral_assets      an affiliate's link (and, later, coupon codes). Opaque, immutable identity;
 *                                  active → disabled, never deleted
 *   affiliate_referral_clicks      one row per redirect: opaque click id, opaque visitor id, allow-listed UTM
 *                                  fields, salted hashes of IP and user agent (never the raw values). Append-only.
 *   affiliate_order_attributions   who gets attribution credit for an order (not how much). One per order,
 *                                  append-only, with the rule version.
 *
 * Eligibility (getAffiliateReferralEligibility) is the single gate: the affiliate is active, and a professional
 * also has an approved verification. It is checked when an asset is created, on every redirect and again when an
 * order is attributed, so a suspended or closed affiliate gets no new clicks or attribution.
 */

export const ASSET_TYPES = ['link', 'coupon'];
export const ASSET_STATUSES = ['active', 'disabled'];
// referral_click = rule v1 (the order carries our click id); gokwik_full_url = rule v2 fallback (below).
export const ATTRIBUTION_METHODS = ['coupon', 'referral_click', 'gokwik_full_url'];
/** The GoKwik fallback's own rule version: never recorded as the v1 click-id rule. */
export const GOKWIK_RULE_VERSION = 'v2';
export const REF_ATTRIBUTE = '__briyo_ref';
export const CLICK_ATTRIBUTE = '__briyo_click';
// The single-underscore spelling (Phase 1B's documented keys) is accepted too, for robustness.
const REF_KEYS = [REF_ATTRIBUTE, '_briyo_ref'];
const CLICK_KEYS = [CLICK_ATTRIBUTE, '_briyo_click'];
export const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
export const VISITOR_COOKIE = 'bv';
export const VISITOR_MAX_AGE_DAYS = 30;
const DUPLICATE_CLICK_MS = 30 * 1000;   // a repeat of the same redirect by the same browser reuses the click
const CLOCK_SKEW_MS = 5 * 60 * 1000;    // Shopify's order time vs this server's click time
const AFFILIATE_ID = /^[A-HJKMNP-Z2-9]{6,12}$/;
const OPAQUE = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url

/* ------------------------------------------------------------------ configuration */

const httpsBase = (v, fallback) => {
  try {
    const u = new URL(String(v || fallback));
    if (u.protocol !== 'https:' && !(process.env.APP_ENV === 'test' && u.protocol === 'http:')) return new URL(fallback);
    return new URL(u.origin);
  } catch { return new URL(fallback); }
};
/** Where a click lands: the storefront home, fixed by configuration — never taken from the request. */
export const storefrontBase = () => httpsBase(process.env.AFFILIATE_STOREFRONT_URL, 'https://briyosupplements.com');
/** The canonical public link base (the Shopify storefront domain that owns /r/…). */
export const publicLinkBase = () => httpsBase(process.env.AFFILIATE_LINK_BASE, 'https://briyosupplements.com');
export const clickHostName = () => normalizeHost(process.env.AFFILIATE_CLICK_HOST);
export const publicReferralUrl = (affiliatePublicId) => `${publicLinkBase().origin}/r/${affiliatePublicId}`;

/* ------------------------------------------------------------------ schema */

let schema = null;
export function ensureAffiliateReferralSchema() {
  if (!schema) {
    schema = (async () => {
      await ensureAffiliateSchema();
      await ensureAffiliateVerificationSchema();
      await ensureOrdersSchema();
      const ddl = [];
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_referral_assets (
          id                          BIGSERIAL PRIMARY KEY,
          public_id                   TEXT NOT NULL CHECK (public_id ~ '^[A-HJKMNP-Z2-9]{10}$'),
          affiliate_id                BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          type                        TEXT NOT NULL,
          code                        TEXT,
          status                      TEXT NOT NULL DEFAULT 'active',
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by                  TEXT,
          disabled_at                 TIMESTAMPTZ,
          disabled_by                 TEXT,
          disable_reason              TEXT CHECK (length(disable_reason) <= 300),
          storefront_redirect_gid     TEXT,
          storefront_redirect_at      TIMESTAMPTZ,
          version                     INTEGER NOT NULL DEFAULT 1,
          CONSTRAINT affiliate_referral_assets_public_id_key UNIQUE (public_id),
          CONSTRAINT affiliate_referral_assets_code CHECK ((type = 'link' AND code IS NULL) OR (type = 'coupon' AND btrim(coalesce(code, '')) <> '')),
          CONSTRAINT affiliate_referral_assets_disabled CHECK (status <> 'disabled' OR (disabled_at IS NOT NULL AND btrim(coalesce(disable_reason, '')) <> ''))
        )`);
      ddl.push(`ALTER TABLE affiliate_referral_assets DROP CONSTRAINT IF EXISTS affiliate_referral_assets_type_check,
        ADD CONSTRAINT affiliate_referral_assets_type_check CHECK (type IN (${ASSET_TYPES.map((t) => `'${t}'`).join(',')}))`);
      ddl.push(`ALTER TABLE affiliate_referral_assets DROP CONSTRAINT IF EXISTS affiliate_referral_assets_status_check,
        ADD CONSTRAINT affiliate_referral_assets_status_check CHECK (status IN (${ASSET_STATUSES.map((t) => `'${t}'`).join(',')}))`);
      // One usable link per affiliate; a coupon code belongs to one affiliate.
      ddl.push(`CREATE UNIQUE INDEX IF NOT EXISTS affiliate_referral_assets_one_active_link ON affiliate_referral_assets (affiliate_id) WHERE type = 'link' AND status = 'active'`);
      ddl.push(`CREATE UNIQUE INDEX IF NOT EXISTS affiliate_referral_assets_coupon_code ON affiliate_referral_assets (lower(code)) WHERE type = 'coupon'`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_referral_assets_affiliate_idx ON affiliate_referral_assets (affiliate_id)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_referral_clicks (
          id                BIGSERIAL PRIMARY KEY,
          public_id         TEXT NOT NULL CHECK (public_id ~ '^[A-Za-z0-9_-]{22}$'),
          affiliate_id      BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          referral_asset_id BIGINT NOT NULL REFERENCES affiliate_referral_assets(id) ON DELETE RESTRICT,
          clicked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          visitor_id        TEXT NOT NULL CHECK (visitor_id ~ '^[A-Za-z0-9_-]{22}$'),
          landing_url       TEXT CHECK (length(landing_url) <= 1000),
          utm_source        TEXT CHECK (length(utm_source) <= 100),
          utm_medium        TEXT CHECK (length(utm_medium) <= 100),
          utm_campaign      TEXT CHECK (length(utm_campaign) <= 100),
          utm_content       TEXT CHECK (length(utm_content) <= 100),
          utm_term          TEXT CHECK (length(utm_term) <= 100),
          user_agent_hash   TEXT CHECK (user_agent_hash ~ '^[0-9a-f]{64}$'),
          ip_hash           TEXT CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT affiliate_referral_clicks_public_id_key UNIQUE (public_id)
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_referral_clicks_visitor_idx ON affiliate_referral_clicks (visitor_id, clicked_at DESC)');
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_referral_clicks_affiliate_idx ON affiliate_referral_clicks (affiliate_id, clicked_at DESC)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_order_attributions (
          id                 BIGSERIAL PRIMARY KEY,
          order_id           BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
          affiliate_id       BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          referral_asset_id  BIGINT REFERENCES affiliate_referral_assets(id) ON DELETE RESTRICT,
          click_id           TEXT CHECK (click_id ~ '^[A-Za-z0-9_-]{22}$'),
          attribution_method TEXT NOT NULL,
          attributed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          order_placed_at    TIMESTAMPTZ NOT NULL,
          rule_version       TEXT NOT NULL CHECK (btrim(rule_version) <> ''),
          window_days        INTEGER,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          metadata           JSONB NOT NULL DEFAULT '{}',
          CONSTRAINT affiliate_order_attributions_order_key UNIQUE (order_id),
          CONSTRAINT affiliate_order_attributions_click CHECK (attribution_method <> 'referral_click' OR click_id IS NOT NULL)
        )`);
      ddl.push(`ALTER TABLE affiliate_order_attributions DROP CONSTRAINT IF EXISTS affiliate_order_attributions_method_check,
        ADD CONSTRAINT affiliate_order_attributions_method_check CHECK (attribution_method IN (${ATTRIBUTION_METHODS.map((t) => `'${t}'`).join(',')}))`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_order_attributions_affiliate_idx ON affiliate_order_attributions (affiliate_id, attributed_at DESC)');
      // History: clicks and attributions are append-only; an asset's identity never changes and a disabled asset stays disabled.
      ddl.push(`
        CREATE OR REPLACE FUNCTION affiliate_referral_guard() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.purge_affiliates', true) = 'on' OR current_setting('app.purge_orders', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
          END IF;
          IF TG_TABLE_NAME <> 'affiliate_referral_assets' THEN
            RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
          END IF;
          IF NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.affiliate_id IS DISTINCT FROM OLD.affiliate_id OR NEW.type IS DISTINCT FROM OLD.type
             OR NEW.code IS DISTINCT FROM OLD.code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'a referral asset identity is immutable';
          END IF;
          IF OLD.status = 'disabled' AND NEW.status <> 'disabled' THEN
            RAISE EXCEPTION 'a disabled referral asset stays disabled';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['affiliate_referral_assets', 'affiliate_referral_clicks', 'affiliate_order_attributions']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_guard ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_guard BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION affiliate_referral_guard()`);
      }
      // Commission ledger (lib/affiliate-commissions.js): one row per attribution, its rate and amounts
      // fixed when created; only the status moves, and every move is kept in affiliate_commission_events.
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_commissions (
          id                BIGSERIAL PRIMARY KEY,
          affiliate_id      BIGINT NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
          attribution_id    BIGINT NOT NULL REFERENCES affiliate_order_attributions(id) ON DELETE RESTRICT,
          order_id          BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
          snapshot_id       BIGINT,
          currency          TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
          rate_id           BIGINT REFERENCES affiliate_rates(id) ON DELETE RESTRICT,
          rate_bps          INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
          base_amount       NUMERIC(14,2) NOT NULL CHECK (base_amount >= 0),
          commission_amount NUMERIC(14,2) NOT NULL CHECK (commission_amount >= 0),
          status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','reversed')),
          status_reason     TEXT CHECK (length(status_reason) <= 500),
          version           INTEGER NOT NULL DEFAULT 1,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by        TEXT,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by        TEXT,
          CONSTRAINT affiliate_commissions_attribution_key UNIQUE (attribution_id)
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_idx ON affiliate_commissions (affiliate_id, created_at DESC)');
      ddl.push(`
        CREATE TABLE IF NOT EXISTS affiliate_commission_events (
          id            BIGSERIAL PRIMARY KEY,
          commission_id BIGINT NOT NULL REFERENCES affiliate_commissions(id) ON DELETE RESTRICT,
          from_status   TEXT,
          to_status     TEXT NOT NULL,
          reason        TEXT,
          actor         TEXT,
          at            TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      ddl.push('CREATE INDEX IF NOT EXISTS affiliate_commission_events_commission_idx ON affiliate_commission_events (commission_id, at)');
      // A reversed commission always says why (lib/affiliate-commissions.js asks for it; the database insists).
      ddl.push(`DO $$ BEGIN
        ALTER TABLE affiliate_commissions ADD CONSTRAINT affiliate_commissions_reversal_reason CHECK (status <> 'reversed' OR btrim(coalesce(status_reason, '')) <> '');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      ddl.push(`
        CREATE OR REPLACE FUNCTION affiliate_commission_guard() RETURNS trigger AS $$
        BEGIN
          -- A commission starts as pending; any other status is reached only through the lifecycle below.
          IF TG_OP = 'INSERT' THEN
            IF TG_TABLE_NAME = 'affiliate_commissions' AND NEW.status <> 'pending' THEN RAISE EXCEPTION 'a commission is created as pending'; END IF;
            RETURN NEW;
          END IF;
          IF TG_OP = 'DELETE' THEN
            IF current_setting('app.purge_affiliates', true) = 'on' OR current_setting('app.purge_orders', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
          END IF;
          IF TG_TABLE_NAME = 'affiliate_commission_events' THEN RAISE EXCEPTION 'affiliate_commission_events is append-only'; END IF;
          IF NEW.affiliate_id IS DISTINCT FROM OLD.affiliate_id OR NEW.attribution_id IS DISTINCT FROM OLD.attribution_id
             OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
             OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.rate_id IS DISTINCT FROM OLD.rate_id OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps
             OR NEW.base_amount IS DISTINCT FROM OLD.base_amount OR NEW.commission_amount IS DISTINCT FROM OLD.commission_amount
             OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
            RAISE EXCEPTION 'a commission''s rate and amounts are fixed when it is created; only its status changes';
          END IF;
          -- The lifecycle (COMMISSION_TRANSITIONS): pending → approved | reversed; approved → paid | reversed;
          -- paid → reversed; reversed is final.
          IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
               (OLD.status = 'pending' AND NEW.status IN ('approved', 'reversed'))
            OR (OLD.status = 'approved' AND NEW.status IN ('paid', 'reversed'))
            OR (OLD.status = 'paid' AND NEW.status = 'reversed')) THEN
            RAISE EXCEPTION 'a % commission cannot become %', OLD.status, NEW.status;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      for (const t of ['affiliate_commissions', 'affiliate_commission_events']) {
        ddl.push(`DROP TRIGGER IF EXISTS ${t}_guard ON ${t}`);
        ddl.push(`CREATE TRIGGER ${t}_guard BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION affiliate_commission_guard()`);
      }
      ddl.push('DROP TRIGGER IF EXISTS affiliate_commissions_insert_guard ON affiliate_commissions');
      ddl.push('CREATE TRIGGER affiliate_commissions_insert_guard BEFORE INSERT ON affiliate_commissions FOR EACH ROW EXECUTE FUNCTION affiliate_commission_guard()');
      await getPool().query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

/* ------------------------------------------------------------------ eligibility */

/**
 * The single rule for referral eligibility. `affiliate` is a row with id,
 * status and requires_verification (or an id, which is then loaded).
 *   suspended / closed       never
 *   professional category    approved verification AND status active
 *   other categories         status active (the Phase 1C lifecycle)
 */
export async function getAffiliateReferralEligibility(db, affiliate) {
  let a = affiliate;
  if (typeof a !== 'object') {
    ({ rows: [a] } = await db.query(
      `SELECT a.id, a.status, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.id = $1`, [affiliate]));
    if (!a) return { eligible: false, reason: 'not_found', status: null };
  }
  const out = (eligible, reason) => ({ eligible, reason, status: a.status });
  if (a.status === 'suspended') return out(false, 'suspended');
  if (a.status === 'closed') return out(false, 'closed');
  if (a.requires_verification && !(await hasApprovedVerification(db, a.id))) return out(false, 'verification_not_approved');
  if (a.status !== 'active') return out(false, a.status === 'approved' ? 'not_activated' : 'not_active');
  return out(true, 'eligible');
}
const REASON_TEXT = {
  suspended: 'The affiliate is suspended.', closed: 'The affiliate is closed.',
  verification_not_approved: 'Professional verification is not approved yet.',
  not_activated: 'Verification is approved; activate the affiliate first.', not_active: 'Activate the affiliate first.',
};

/* ------------------------------------------------------------------ assets (admin) */

const toAsset = (r) => ({
  ref: r.public_id, type: r.type, status: r.status, created_at: r.created_at, created_by: r.created_by,
  disabled_at: r.disabled_at, disabled_by: r.disabled_by, disable_reason: r.disable_reason, version: r.version,
  storefront_redirect_at: r.storefront_redirect_at, storefront_redirect_set: Boolean(r.storefront_redirect_gid),
});

/** The referral view of one affiliate: eligibility, link assets, click and attribution summary. No PII, no ids. */
export async function getReferral(publicId) {
  await ensureAffiliateReferralSchema();
  const pid = String(publicId || '').toUpperCase();
  if (!AFFILIATE_ID.test(pid)) return null;
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.public_id, a.status, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`, [pid]);
  if (!a) return null;
  const elig = await getAffiliateReferralEligibility(db, a);
  const [{ rows: assets }, { rows: [clicks] }, { rows: attributions }] = await Promise.all([
    db.query(`SELECT * FROM affiliate_referral_assets WHERE affiliate_id = $1 AND type = 'link' ORDER BY created_at DESC, id DESC`, [a.id]),
    db.query(`SELECT count(*)::int AS n, max(clicked_at) AS latest, count(*) FILTER (WHERE clicked_at >= ${lastIstDaysSql(30)})::int AS recent
              FROM affiliate_referral_clicks WHERE affiliate_id = $1`, [a.id]),
    db.query(`SELECT t.attribution_method, t.attributed_at, t.order_placed_at, t.rule_version, o.source_payload->'shopify'->>'name' AS order_name
              FROM affiliate_order_attributions t JOIN orders o ON o.id = t.order_id WHERE t.affiliate_id = $1 ORDER BY t.attributed_at DESC LIMIT 20`, [a.id]),
  ]);
  const { rows: [{ n: attributionCount }] } = await db.query('SELECT count(*)::int AS n FROM affiliate_order_attributions WHERE affiliate_id = $1', [a.id]);
  const active = assets.find((x) => x.status === 'active') || null;
  return {
    eligibility: { ...elig, text: elig.eligible ? null : REASON_TEXT[elig.reason] || 'Not eligible.' },
    public_url: publicReferralUrl(a.public_id),
    link: active ? toAsset(active) : null,
    // Usable now: an active asset AND an eligible affiliate. Suspension or closure makes it unusable without touching the asset.
    usable: Boolean(active) && elig.eligible,
    history: assets.filter((x) => x !== active).map(toAsset),
    clicks: { total: clicks.n, last_30_days: clicks.recent, latest_at: clicks.latest },
    attributions: { total: attributionCount, recent: attributions.map((t) => ({ order: t.order_name, method: t.attribution_method, attributed_at: t.attributed_at, order_placed_at: t.order_placed_at, rule_version: t.rule_version })) },
    click_host_configured: Boolean(clickHostName()),
  };
}

/** Creates the affiliate's referral link (one active link at a time). Eligible affiliates only. */
export async function createReferralLink(publicId, { actor } = {}) {
  await ensureAffiliateReferralSchema();
  await tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    const elig = await getAffiliateReferralEligibility(db, a);
    if (!elig.eligible) throw bad(`A referral link cannot be created: ${REASON_TEXT[elig.reason] || 'not eligible.'}`, 409, { reason: elig.reason });
    const { rows: [has] } = await db.query(`SELECT 1 FROM affiliate_referral_assets WHERE affiliate_id = $1 AND type = 'link' AND status = 'active'`, [a.id]);
    if (has) throw bad('This affiliate already has an active referral link.', 409);
    const ref = newAffiliatePublicId(10);
    await db.query(`INSERT INTO affiliate_referral_assets (public_id, affiliate_id, type, created_by) VALUES ($1, $2, 'link', $3)`, [ref, a.id, actor || null]);
    await logAffiliateEvent(db, a.id, 'referral_asset_created', actor, { asset: ref, type: 'link' }, 'referral_asset', ref);
  });
  return getReferral(publicId);
}

/** Disables the active link for good (the record stays). A reason is required. */
export async function disableReferralLink(publicId, { actor, reason, version } = {}) {
  await ensureAffiliateReferralSchema();
  const why = clean(reason, 301);
  if (!why) throw bad('Give a reason.', 400, { field: 'reason' });
  if (why.length > 300) throw bad('Keep the reason under 300 characters.', 400, { field: 'reason' });
  await tx(async (db) => {
    const a = await lockAffiliate(db, publicId);
    const { rows: [x] } = await db.query(`SELECT * FROM affiliate_referral_assets WHERE affiliate_id = $1 AND type = 'link' AND status = 'active' FOR UPDATE`, [a.id]);
    if (!x) throw bad('There is no active referral link to disable.', 409);
    if (version !== undefined && version !== null && Number(version) !== x.version) throw bad('Someone else changed this link since you opened it. Reload.', 409, { conflict: true });
    await db.query(`UPDATE affiliate_referral_assets SET status = 'disabled', disabled_at = now(), disabled_by = $2, disable_reason = $3, version = version + 1 WHERE id = $1`,
      [x.id, actor || null, why]);
    await logAffiliateEvent(db, a.id, 'referral_asset_disabled', actor, { asset: x.public_id, reason: why }, 'referral_asset', x.public_id);
  });
  return getReferral(publicId);
}

/**
 * Creates the storefront redirect /r/{id} → click host in Shopify, when an
 * admin asks for it. Never automatic. Needs the write_online_store_navigation
 * scope, which the current Shopify app does not hold: a missing scope is
 * reported, not worked around. `gql` is injectable for tests.
 */
export async function syncStorefrontRedirect(publicId, { actor, gql } = {}) {
  await ensureAffiliateReferralSchema();
  const host = clickHostName();
  if (!host) throw bad('The click host is not configured (AFFILIATE_CLICK_HOST).', 409);
  const pid = String(publicId || '').toUpperCase();
  const { rows: [x] } = await getPool().query(
    `SELECT r.*, a.public_id AS affiliate_ref FROM affiliate_referral_assets r JOIN affiliates a ON a.id = r.affiliate_id
     WHERE a.public_id = $1 AND r.type = 'link' AND r.status = 'active'`, [pid]);
  if (!x) throw bad('Create the referral link first.', 409);
  const path = `/r/${x.affiliate_ref}`;
  const target = `https://${host}/r/${x.affiliate_ref}`;
  const call = gql || (await import('./shopify.js')).graphql;
  let gid;
  try {
    const found = await call(`query BriyoReferralRedirect($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` });
    const same = (found?.urlRedirects?.nodes || []).find((n) => n.path === path);
    if (same && same.target !== target) throw bad(`Shopify already redirects ${path} somewhere else. Review it in Shopify → Navigation → URL redirects.`, 409);
    if (same) gid = same.id;
    else {
      const made = await call(`mutation BriyoReferralRedirectCreate($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`,
        { r: { path, target } });
      const errs = made?.urlRedirectCreate?.userErrors || [];
      if (errs.length) throw bad(`Shopify refused the redirect: ${errs.map((e) => e.message).join('; ')}`, 409);
      gid = made?.urlRedirectCreate?.urlRedirect?.id;
    }
  } catch (err) {
    if (err.status) throw err;
    if (/access denied|scope|not approved|write_online_store_navigation|read_online_store_navigation/i.test(String(err.message))) {
      throw bad('The Shopify app is missing the online store navigation scope (read_online_store_navigation, write_online_store_navigation). Add it to the app and reconnect Shopify, then try again.', 409, { scope: true });
    }
    throw bad(`Shopify could not be reached: ${String(err.message).slice(0, 160)}`, 502);
  }
  await tx(async (db) => {
    await db.query('UPDATE affiliate_referral_assets SET storefront_redirect_gid = $2, storefront_redirect_at = now(), version = version + 1 WHERE id = $1', [x.id, gid || 'unknown']);
    await logAffiliateEvent(db, x.affiliate_id, 'storefront_redirect_synced', actor, { asset: x.public_id, path }, 'referral_asset', x.public_id);
  });
  return getReferral(publicId);
}

/* ------------------------------------------------------------------ the public redirect */

const opaque = () => crypto.randomBytes(16).toString('base64url');
const salt = () => process.env.AFFILIATE_HASH_SALT || process.env.HR_IP_HASH_SALT || null;
const keyedHash = (v) => (salt() && v ? crypto.createHmac('sha256', `affiliate-click:${salt()}`).update(String(v)).digest('hex') : null);
const visitorFrom = (req) => {
  const raw = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${VISITOR_COOKIE}=`));
  const v = raw ? raw.slice(VISITOR_COOKIE.length + 1) : '';
  return OPAQUE.test(v) ? v : null;
};
/** UTM values: allow-listed keys only, short, plain characters; anything else is dropped. */
export function utmFrom(query = {}) {
  const out = {};
  for (const k of UTM_FIELDS) {
    const v = Array.isArray(query[k]) ? query[k][0] : query[k];
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, 100);
    if (s && /^[\w .:+\-/]{1,100}$/.test(s)) out[k] = s;
  }
  return out;
}
const homeUrl = () => `${storefrontBase().origin}/`;

/**
 * GET /r/:affiliatePublicId on the click host. Always a 302 to the storefront:
 * with bref/bclid when the link is usable (and a click is recorded), plain
 * home otherwise — the response never says why. The destination is built here
 * from the configured storefront origin; nothing from the request becomes the
 * target except the allow-listed UTM values.
 */
export async function handleReferralRedirect(req, res) {
  res.set({ 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
  const home = () => res.redirect(302, homeUrl());
  try {
    const pid = String(req.params.affiliatePublicId || '').toUpperCase();
    if (!AFFILIATE_ID.test(pid)) return home();
    await ensureAffiliateReferralSchema();
    const db = getPool();
    const { rows: [a] } = await db.query(
      `SELECT a.id, a.public_id, a.status, c.requires_verification, r.id AS asset_id
       FROM affiliates a JOIN affiliate_categories c ON c.key = a.category
       JOIN affiliate_referral_assets r ON r.affiliate_id = a.id AND r.type = 'link' AND r.status = 'active'
       WHERE a.public_id = $1`, [pid]);
    if (!a || !(await getAffiliateReferralEligibility(db, a)).eligible) return home();
    let visitor = visitorFrom(req);
    if (!visitor) visitor = opaque();
    res.cookie(VISITOR_COOKIE, visitor, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: VISITOR_MAX_AGE_DAYS * 86400000 });
    const utm = { utm_source: 'affiliate', utm_medium: 'referral', utm_campaign: a.public_id, ...utmFrom(req.query) };
    // A repeat of the same redirect by the same browser (a double tap, a prefetch, a retry) reuses the click.
    const { rows: [recent] } = await db.query(
      `SELECT public_id FROM affiliate_referral_clicks WHERE visitor_id = $1 AND referral_asset_id = $2 AND clicked_at > now() - ($3 || ' milliseconds')::interval
       ORDER BY clicked_at DESC LIMIT 1`, [visitor, a.asset_id, String(DUPLICATE_CLICK_MS)]);
    let click = recent?.public_id || null;
    const dest = (c) => {
      const u = new URL(homeUrl());
      u.searchParams.set('bref', a.public_id);
      if (c) u.searchParams.set('bclid', c);
      for (const [k, v] of Object.entries(utm)) u.searchParams.set(k, v);
      return u.toString();
    };
    if (!click) {
      // Abuse guard: past the per-IP limit the visitor still lands, but no click is recorded.
      const ip = req.ip || req.socket?.remoteAddress || '';
      if (!rateLimit({ key: `refclick:${ip}`, limit: 30, windowMs: 10 * 60 * 1000 }).ok) return res.redirect(302, dest(null));
      click = opaque();
      await db.query(`INSERT INTO affiliate_referral_clicks (public_id, affiliate_id, referral_asset_id, visitor_id, landing_url, utm_source, utm_medium, utm_campaign,
          utm_content, utm_term, user_agent_hash, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [click, a.id, a.asset_id, visitor, dest(click).slice(0, 1000), utm.utm_source || null, utm.utm_medium || null, utm.utm_campaign || null, utm.utm_content || null,
        utm.utm_term || null, keyedHash(String(req.get('user-agent') || '').slice(0, 512)), keyedHash(ip)]);
    }
    return res.redirect(302, dest(click));
  } catch (err) {
    console.error('Referral redirect failed:', err.code || '', String(err.message).slice(0, 160));
    return home();
  }
}

/** First middleware with careersHost: the click host gets only the redirect and a health check. */
export function clickHost(req, res, next) {
  const host = clickHostName();
  if (!host || normalizeHost(req.headers?.host) !== host) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text').send('Not found');
  if (req.path === '/healthz') return res.json({ ok: true });
  const m = /^\/r\/([^/]{1,64})\/?$/.exec(req.path);
  if (m) { req.params = { affiliatePublicId: m[1] }; return handleReferralRedirect(req, res); }
  if (req.path === '/' || req.path === '/r' || req.path === '/r/') return res.redirect(302, homeUrl());
  return res.status(404).type('text').send('Not found');
}

/* ------------------------------------------------------------------ attribution */

const attr = (list, keys) => {
  for (const k of keys) {
    const hit = (list || []).find((a) => a?.key === k && typeof a.value === 'string');
    if (hit) return hit.value.trim();
  }
  return null;
};
/**
 * GoKwik does not carry our private cart attributes into the order, but it records the
 * landing URL as the attribute `full_url`. When that URL is our own referral path,
 * `/r/{affiliate public id}` on our storefront or the store's myshopify domain, the
 * affiliate id is returned; anything else (another host, another path, a UTM value
 * alone) returns null.
 */
export function landingReferral(customAttributes) {
  const raw = attr(customAttributes, ['full_url']);
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const hosts = new Set();
  for (const base of [publicLinkBase(), storefrontBase()]) {
    const h = base.hostname;
    hosts.add(h); hosts.add(h.startsWith('www.') ? h.slice(4) : `www.${h}`);
  }
  const shop = normalizeHost(process.env.SHOPIFY_STORE_DOMAIN);
  if (shop) hosts.add(shop);
  if (!hosts.has(u.hostname.toLowerCase())) return null;
  const m = /^\/r\/([A-Za-z0-9]{6,12})\/?$/.exec(u.pathname);
  const id = m ? m[1].toUpperCase() : null;
  return id && AFFILIATE_ID.test(id) ? id : null;
}

/** The referral values an order carries, validated; null when absent or malformed. */
export function referralAttributes(customAttributes) {
  const ref = attr(customAttributes, REF_KEYS);
  const click = attr(customAttributes, CLICK_KEYS);
  return {
    ref: ref && AFFILIATE_ID.test(ref.toUpperCase()) ? ref.toUpperCase() : null,
    click: click && OPAQUE.test(click) ? click : null,
  };
}

async function settings(db) {
  const { rows } = await db.query(`SELECT key, value FROM affiliate_settings WHERE key IN ('attribution_window_days', 'attribution_rule_version')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const days = Number(s.attribution_window_days);
  return { windowDays: Number.isInteger(days) && days > 0 && days <= 365 ? days : null, ruleVersion: typeof s.attribution_rule_version === 'string' ? s.attribution_rule_version : null };
}

/**
 * Who gets credit for this order, under rule v1 — read-only:
 *   1. coupon: a discount code on the order that is an active affiliate coupon asset created before the
 *      order, for an affiliate eligible now. (No coupon assets can be created yet: reserved for the coupon phase.)
 *   2. referral click: the order's click id must be a recorded click whose affiliate matches the order's
 *      bref; then the latest click by the same visitor, made no later than the order and within
 *      attribution_window_days (affiliate_settings) before it, for an affiliate eligible now, wins.
 *   otherwise nobody.
 */
export async function resolveOrderAttribution(db, { orderedAt, discountCodes = [], customAttributes = [] }) {
  const placed = new Date(orderedAt);
  if (Number.isNaN(placed.getTime())) return null;
  const { windowDays, ruleVersion } = await settings(db);
  if (!ruleVersion) return null;
  const codes = [...new Set(discountCodes.map((c) => String(c || '').trim().toLowerCase()).filter(Boolean))];
  if (codes.length) {
    const { rows } = await db.query(
      `SELECT r.id AS asset_id, r.public_id, r.code, a.id, a.status, c.requires_verification FROM affiliate_referral_assets r
         JOIN affiliates a ON a.id = r.affiliate_id JOIN affiliate_categories c ON c.key = a.category
       WHERE r.type = 'coupon' AND r.status = 'active' AND lower(r.code) = ANY($1) AND r.created_at <= $2 ORDER BY r.created_at, r.id`, [codes, placed]);
    for (const r of rows) {
      if ((await getAffiliateReferralEligibility(db, r)).eligible) {
        return { affiliateId: r.id, assetId: r.asset_id, clickId: null, method: 'coupon', ruleVersion, windowDays, metadata: { asset: r.public_id, code: r.code } };
      }
    }
  }
  const { ref, click } = referralAttributes(customAttributes);
  if (!click && !ref) return gokwikFallback(db, { placed, windowDays, customAttributes });
  if (!click || !windowDays) return null;
  const { rows: [seed] } = await db.query(
    `SELECT k.visitor_id, a.public_id AS affiliate_ref FROM affiliate_referral_clicks k JOIN affiliates a ON a.id = k.affiliate_id WHERE k.public_id = $1`, [click]);
  // The click must exist on the server and agree with the order's affiliate reference.
  if (!seed || (ref && ref !== seed.affiliate_ref)) return null;
  const { rows: candidates } = await db.query(
    `SELECT k.public_id, k.referral_asset_id, k.clicked_at, a.id, a.status, c.requires_verification, r.status AS asset_status
       FROM affiliate_referral_clicks k JOIN affiliates a ON a.id = k.affiliate_id JOIN affiliate_categories c ON c.key = a.category
       JOIN affiliate_referral_assets r ON r.id = k.referral_asset_id
     WHERE k.visitor_id = $1 AND k.clicked_at <= $2::timestamptz + interval '${CLOCK_SKEW_MS / 1000} seconds'
       AND k.clicked_at >= $2::timestamptz - ($3 || ' days')::interval
     ORDER BY k.clicked_at DESC, k.id DESC`, [seed.visitor_id, placed, String(windowDays)]);
  for (const k of candidates) {
    if (k.asset_status !== 'active') continue;
    if (!(await getAffiliateReferralEligibility(db, k)).eligible) continue;
    return { affiliateId: k.id, assetId: k.referral_asset_id, clickId: k.public_id, method: 'referral_click', ruleVersion, windowDays,
      metadata: { order_click: click, clicked_at: k.clicked_at } };
  }
  return null;
}

/**
 * Rule v2, the GoKwik fallback, used only when the order carries none of our own referral
 * attributes (an order with our attributes is decided by v1 alone, even when v1 says no):
 *   1. GoKwik's `full_url` must be our referral path /r/{affiliate public id} (landingReferral).
 *      UTM values are never enough.
 *   2. That affiliate must have a recorded click made no later than the order and within
 *      attribution_window_days before it, on an active link, and the affiliate must be
 *      eligible now. The latest such click is credited. Nothing is synthesised.
 * The click cannot be tied to this visitor (GoKwik drops our click id), so the credit is
 * the affiliate's and `click_id` names their latest qualifying click; the metadata says so.
 */
async function gokwikFallback(db, { placed, windowDays, customAttributes }) {
  const affiliateRef = landingReferral(customAttributes);
  if (!affiliateRef || !windowDays) return null;
  const { rows: candidates } = await db.query(
    `SELECT k.public_id, k.referral_asset_id, k.clicked_at, a.id, a.status, c.requires_verification, r.status AS asset_status
       FROM affiliate_referral_clicks k JOIN affiliates a ON a.id = k.affiliate_id JOIN affiliate_categories c ON c.key = a.category
       JOIN affiliate_referral_assets r ON r.id = k.referral_asset_id
     WHERE a.public_id = $1 AND k.clicked_at <= $2::timestamptz AND k.clicked_at >= $2::timestamptz - ($3 || ' days')::interval
     ORDER BY k.clicked_at DESC, k.id DESC`, [affiliateRef, placed, String(windowDays)]);
  for (const k of candidates) {
    if (k.asset_status !== 'active') continue;
    if (!(await getAffiliateReferralEligibility(db, k)).eligible) continue;
    return { affiliateId: k.id, assetId: k.referral_asset_id, clickId: k.public_id, method: 'gokwik_full_url', ruleVersion: GOKWIK_RULE_VERSION, windowDays,
      metadata: { source: 'gokwik_full_url', landing_path: `/r/${affiliateRef}`, clicked_at: k.clicked_at, click_match: 'latest_affiliate_click_before_order' } };
  }
  return null;
}

/**
 * Records the attribution for an order inside the caller's transaction. Once
 * an order has an attribution it is never changed: a repeat (another sync run)
 * returns the existing one. Returns { recorded, method } or null.
 */
export async function attributeOrder(client, orderId, input, { actor = null } = {}) {
  const { rows: [existing] } = await client.query('SELECT attribution_method FROM affiliate_order_attributions WHERE order_id = $1', [orderId]);
  if (existing) return { recorded: false, method: existing.attribution_method };
  const r = await resolveOrderAttribution(client, input);
  if (!r) return null;
  const { rows: [ins] } = await client.query(
    `INSERT INTO affiliate_order_attributions (order_id, affiliate_id, referral_asset_id, click_id, attribution_method, order_placed_at, rule_version, window_days, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (order_id) DO NOTHING RETURNING id`,
    [orderId, r.affiliateId, r.assetId, r.clickId, r.method, new Date(input.orderedAt), r.ruleVersion, r.windowDays, JSON.stringify(r.metadata)]);
  if (!ins) return { recorded: false, method: r.method };
  const { rows: [o] } = await client.query(`SELECT source_payload->'shopify'->>'name' AS name FROM orders WHERE id = $1`, [orderId]);
  await logAffiliateEvent(client, r.affiliateId, 'order_attributed', actor, { order: o?.name || null, method: r.method, rule_version: r.ruleVersion }, 'order', o?.name || null);
  // The commission is created with the attribution, in the same transaction: rate and base fixed now.
  const commission = await createCommissionForAttribution(client, ins.id, { actor });
  return { recorded: true, method: r.method, commission: commission.created };
}
