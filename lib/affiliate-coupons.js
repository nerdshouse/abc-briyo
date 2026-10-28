import { getPool } from './db.js';
import { newAffiliatePublicId, bad, clean, tx, lockAffiliate, logAffiliateEvent } from './affiliates.js';
import { ensureAffiliateReferralSchema, getAffiliateReferralEligibility } from './affiliate-referrals.js';

/**
 * Affiliate coupon codes — a real Shopify discount code per affiliate, and the coupon path of attribution
 * (resolveOrderAttribution in lib/affiliate-referrals.js: an order carrying an active affiliate code credits that
 * affiliate, ahead of any referral click).
 *
 *   A coupon is an affiliate_referral_assets row (type 'coupon'): its code, the discount it gives (discount_bps,
 *   1–90%), whether one customer may use it once, and the Shopify discount behind it. Code and discount are fixed
 *   when it is created (database trigger): a different value is a new code. active → disabled is final.
 *
 *   Shopify first, then the record: the discount is created in Shopify (discountCodeBasicCreate, all customers, all
 *   products), and only then is the coupon saved. If saving fails, the Shopify discount is deleted again, so neither
 *   side has a code the other does not know. Disabling deactivates the Shopify discount first; if Shopify cannot be
 *   reached, nothing changes and the action can be retried.
 *
 *   The Shopify discount follows the affiliate: a suspended or closed affiliate's codes are deactivated in Shopify
 *   (customers can no longer use them), and reactivated when the affiliate is eligible again
 *   (syncCouponsForAffiliate, run after every status change). A failure is recorded on the coupon and retried with
 *   "Sync with Shopify".
 *
 * Needs the Shopify scopes read_discounts and write_discounts (lib/shopify-oauth.js): a missing scope is reported, not
 * worked around. `gql` is injectable for tests.
 */

export const COUPON_CODE = /^[A-Z0-9](?:[A-Z0-9-]{2,18})[A-Z0-9]$/;
export const COUPON_RULE = 'A code is 4–20 letters, numbers or hyphens (not at either end), e.g. DRASHA10.';
const MAX_DISCOUNT_BPS = 9000;

const graphqlOf = async (gql) => gql || (await import('./shopify.js')).graphql;
const scopeError = (err) => /access denied|scope|not approved|write_discounts|read_discounts/i.test(String(err?.message));
const shopifyFail = (err, what) => {
  if (err.status) return err;
  if (scopeError(err)) {
    return bad('The Shopify app does not have the discounts permission yet (read_discounts, write_discounts). Reconnect Shopify in Briyo OS to grant it, then try again.', 409, { scope: true });
  }
  return bad(`Shopify could not ${what}: ${String(err.message).slice(0, 160)}`, 502);
};

/** "12.5" or 12.5 → 1250 basis points; 1–90%, at most two decimals. No floating point. */
export function parseDiscountBps(v) {
  const s = String(v ?? '').trim().replace(/%$/, '').trim();
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw bad('Enter the discount as a percentage, e.g. 10 or 12.5.', 400, { field: 'discount_percent' });
  const bps = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (bps < 1 || bps > MAX_DISCOUNT_BPS) throw bad('The discount must be between 0.01% and 90%.', 400, { field: 'discount_percent' });
  return bps;
}
export function couponCode(v) {
  const code = String(v ?? '').trim().toUpperCase();
  if (!COUPON_CODE.test(code)) throw bad(COUPON_RULE, 400, { field: 'code' });
  return code;
}

const toCoupon = (r, uses = 0) => ({
  ref: r.public_id, code: r.code, status: r.status, discount_bps: r.discount_bps, once_per_customer: Boolean(r.once_per_customer),
  shopify: { set: Boolean(r.shopify_discount_gid), active: r.shopify_active === true, synced_at: r.shopify_synced_at, error: r.shopify_error },
  created_at: r.created_at, created_by: r.created_by, disabled_at: r.disabled_at, disabled_by: r.disabled_by, disable_reason: r.disable_reason,
  version: r.version, orders: uses,
});

/** An affiliate's coupons, newest first, with how many orders each one credited. No customer data. */
export async function listCoupons(publicId) {
  await ensureAffiliateReferralSchema();
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.status, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`,
    [String(publicId || '').toUpperCase()]);
  if (!a) return null;
  const elig = await getAffiliateReferralEligibility(db, a);
  const { rows } = await db.query(
    `SELECT r.*, (SELECT count(*)::int FROM affiliate_order_attributions t WHERE t.referral_asset_id = r.id) AS uses
     FROM affiliate_referral_assets r WHERE r.affiliate_id = $1 AND r.type = 'coupon' AND r.discount_bps IS NOT NULL
     ORDER BY r.created_at DESC, r.id DESC`, [a.id]);
  return { eligible: elig.eligible, eligibility_reason: elig.reason, coupons: rows.map((r) => toCoupon(r, r.uses)) };
}

/**
 * Creates an affiliate coupon: the Shopify discount, then the record. Eligible affiliates only (active, and an
 * approved verification for professionals). The code must be new to Briyo OS; Shopify refuses one it already has.
 */
export async function createCoupon(publicId, input = {}, { actor, gql } = {}) {
  await ensureAffiliateReferralSchema();
  const code = couponCode(input.code);
  const bps = parseDiscountBps(input.discount_percent);
  const once = input.once_per_customer === true || input.once_per_customer === 'true' || input.once_per_customer === 'on';
  const pid = String(publicId || '').toUpperCase();
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.public_id, a.display_name, a.status, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`, [pid]);
  if (!a) throw bad('No such affiliate.', 404);
  const elig = await getAffiliateReferralEligibility(db, a);
  if (!elig.eligible) throw bad('A coupon can only be created for an active affiliate (and, for professionals, an approved verification).', 409, { reason: elig.reason });
  const taken = async (c) => (await c.query(`SELECT 1 FROM affiliate_referral_assets WHERE type = 'coupon' AND lower(code) = lower($1)`, [code])).rows.length > 0;
  if (await taken(db)) throw bad(`The code ${code} is already in use. Choose another.`, 409, { field: 'code' });

  const call = await graphqlOf(gql);
  let gid;
  try {
    const out = await call(`mutation BriyoAffiliateCoupon($d: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field code message } } }`, {
      d: {
        title: `Affiliate ${a.public_id} · ${code}`.slice(0, 255),
        code,
        startsAt: new Date().toISOString(),
        context: { all: 'ALL' },
        customerGets: { value: { percentage: bps / 10000 }, items: { all: true } },
        appliesOncePerCustomer: once,
      },
    });
    const errs = out?.discountCodeBasicCreate?.userErrors || [];
    if (errs.length) throw bad(`Shopify refused the code: ${errs.map((e) => e.message).join('; ')}`, 409, { field: 'code' });
    gid = out?.discountCodeBasicCreate?.codeDiscountNode?.id;
    if (!gid) throw bad('Shopify did not return the new discount. Nothing was saved; try again.', 502);
  } catch (err) { throw shopifyFail(err, 'create the discount'); }

  try {
    const ref = await tx(async (c) => {
      const locked = await lockAffiliate(c, pid);
      const still = await getAffiliateReferralEligibility(c, locked);
      if (!still.eligible) throw bad('The affiliate stopped being eligible while the code was being created. Nothing was saved.', 409);
      if (await taken(c)) throw bad(`The code ${code} was just taken. Choose another.`, 409, { field: 'code' });
      const r = newAffiliatePublicId(10);
      await c.query(
        `INSERT INTO affiliate_referral_assets (public_id, affiliate_id, type, code, discount_bps, once_per_customer, shopify_discount_gid, shopify_active, shopify_synced_at, created_by)
         VALUES ($1, $2, 'coupon', $3, $4, $5, $6, true, now(), $7)`, [r, locked.id, code, bps, once, gid, actor || null]);
      await logAffiliateEvent(c, locked.id, 'coupon_created', actor, { asset: r, code, discount_bps: bps, once_per_customer: once }, 'referral_asset', r);
      return r;
    });
    return { ref, ...(await listCoupons(pid)) };
  } catch (err) {
    // The record was not saved: take the Shopify discount away again, so no code exists that Briyo OS does not know.
    try { await call('mutation BriyoAffiliateCouponUndo($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }', { id: gid }); }
    catch (undo) { console.error(`Affiliate coupon ${code}: saving failed and the Shopify discount ${gid} could not be deleted:`, String(undo.message).slice(0, 160)); }
    throw err;
  }
}

/** One coupon's Shopify discount on or off. Returns true when Shopify now matches; a missing discount counts as off. */
async function setShopifyActive(call, gid, on) {
  const op = on ? 'discountCodeActivate' : 'discountCodeDeactivate';
  const out = await call(`mutation BriyoAffiliateCouponState($id: ID!) { ${op}(id: $id) { codeDiscountNode { id } userErrors { field message } } }`, { id: gid });
  const errs = out?.[op]?.userErrors || [];
  if (errs.length && !(!on && errs.some((e) => /not exist|not found/i.test(e.message)))) throw new Error(errs.map((e) => e.message).join('; '));
  return true;
}

/** Disables a coupon for good (the record stays): the Shopify discount is deactivated first. A reason is required. */
export async function disableCoupon(publicId, couponRef, { reason, actor, version, gql } = {}) {
  await ensureAffiliateReferralSchema();
  const why = clean(reason, 301);
  if (!why) throw bad('Give a reason.', 400, { field: 'reason' });
  if (why.length > 300) throw bad('Keep the reason under 300 characters.', 400, { field: 'reason' });
  const pid = String(publicId || '').toUpperCase();
  const { rows: [x] } = await getPool().query(
    `SELECT r.* FROM affiliate_referral_assets r JOIN affiliates a ON a.id = r.affiliate_id
     WHERE a.public_id = $1 AND r.public_id = $2 AND r.type = 'coupon' AND r.discount_bps IS NOT NULL`, [pid, String(couponRef || '').toUpperCase()]);
  if (!x) throw bad('No such coupon.', 404);
  if (x.status !== 'active') throw bad('This coupon is already disabled.', 409);
  if (version !== undefined && version !== null && Number(version) !== x.version) throw bad('Someone else changed this coupon since you opened it. Reload.', 409, { conflict: true });
  if (x.shopify_discount_gid) {
    try { await setShopifyActive(await graphqlOf(gql), x.shopify_discount_gid, false); } catch (err) { throw shopifyFail(err, 'deactivate the discount; nothing was changed'); }
  }
  await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT status FROM affiliate_referral_assets WHERE id = $1 FOR UPDATE', [x.id]);
    if (cur.status !== 'active') throw bad('This coupon is already disabled.', 409);
    await c.query(`UPDATE affiliate_referral_assets SET status = 'disabled', disabled_at = now(), disabled_by = $2, disable_reason = $3,
                     shopify_active = false, shopify_synced_at = now(), shopify_error = NULL, version = version + 1 WHERE id = $1`, [x.id, actor || null, why]);
    await logAffiliateEvent(c, x.affiliate_id, 'coupon_disabled', actor, { asset: x.public_id, code: x.code, reason: why }, 'referral_asset', x.public_id);
  });
  return listCoupons(pid);
}

/**
 * Brings each active coupon's Shopify discount in line with the affiliate: on while the affiliate is eligible, off
 * otherwise. Never throws: each coupon's outcome is recorded (shopify_error) and returned.
 */
export async function syncCouponsForAffiliate(publicId, { actor, gql } = {}) {
  await ensureAffiliateReferralSchema();
  const db = getPool();
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.status, c.requires_verification FROM affiliates a JOIN affiliate_categories c ON c.key = a.category WHERE a.public_id = $1`,
    [String(publicId || '').toUpperCase()]);
  if (!a) return { synced: 0, failed: 0 };
  const want = (await getAffiliateReferralEligibility(db, a)).eligible;
  const { rows } = await db.query(
    `SELECT id, public_id, code, shopify_discount_gid, shopify_active, shopify_error FROM affiliate_referral_assets
     WHERE affiliate_id = $1 AND type = 'coupon' AND status = 'active' AND shopify_discount_gid IS NOT NULL`, [a.id]);
  // Out of step, or a recorded failure: an earlier attempt may have left Shopify in either state, so it is applied again.
  const todo = rows.filter((r) => r.shopify_active !== want || r.shopify_error);
  if (!todo.length) return { synced: 0, failed: 0, active: want };
  let call;
  try { call = await graphqlOf(gql); } catch { call = null; }
  const out = { synced: 0, failed: 0, active: want };
  for (const r of todo) {
    try {
      if (!call) throw new Error('Shopify is not configured');
      await setShopifyActive(call, r.shopify_discount_gid, want);
      await db.query('UPDATE affiliate_referral_assets SET shopify_active = $2, shopify_synced_at = now(), shopify_error = NULL WHERE id = $1', [r.id, want]);
      await logAffiliateEvent(db, a.id, want ? 'coupon_activated_in_shopify' : 'coupon_deactivated_in_shopify', actor, { asset: r.public_id, code: r.code }, 'referral_asset', r.public_id);
      out.synced += 1;
    } catch (err) {
      const msg = scopeError(err) ? 'The Shopify app does not have the discounts permission (read_discounts, write_discounts).' : String(err.message).slice(0, 300);
      await db.query('UPDATE affiliate_referral_assets SET shopify_error = $2 WHERE id = $1', [r.id, msg]);
      out.failed += 1;
    }
  }
  return out;
}
