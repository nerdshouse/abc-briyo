import express from 'express';
import { currentUserName } from './auth-routes.js';
import { can } from './permissions.js';
import { MAX_DOCUMENT_BYTES, StorageNotConfigured } from './storage.js';
import { ensureAffiliateReferralSchema, getReferral, createReferralLink, disableReferralLink, syncStorefrontRedirect } from './affiliate-referrals.js';
import { getAffiliatePerformance, setCommissionStatus, backfillAffiliateCommissions, COMMISSION_STATUS_CAP } from './affiliate-commissions.js';
import { listCoupons, createCoupon, disableCoupon, syncCouponsForAffiliate } from './affiliate-coupons.js';
import {
  ensureAffiliatePayoutSchema, getPayoutDetails, setPayoutDetails, previewPayoutBatch, createPayoutBatch, listPayoutBatches, getPayoutBatch,
  markPayoutPaid, markPayoutFailed, cancelPayoutBatch, payoutBankFile, tdsRegister, tdsSettings, updateTdsSettings, affiliatePayouts, financialYearOf,
} from './affiliate-payouts.js';
import {
  ensureAffiliateVerificationSchema, getVerification, createProfessionalProfile, updateProfessionalProfile, uploadProfessionalDocument,
  openProfessionalDocument, verificationAction, resubmitVerification, startVerification, VERIFICATION_ACTIONS,
} from './affiliate-verification.js';
import {
  listAffiliates, getAffiliate, createAffiliate, updateAffiliate, setAffiliateStatus, addAffiliateRate,
  listAffiliateCategories, AFFILIATE_STATUSES, AFFILIATE_TRANSITIONS, AFFILIATE_SORTS,
} from './affiliates.js';

/**
 * /api/affiliates — mounted behind requireAuth + requirePermission('affiliate.view').
 * Reading needs affiliate.view; affiliate changes and professional profiles /
 * documents need affiliate.manage; verification decisions and opening a
 * document need affiliate.verify (Phase 1D). Internal
 * only: no public route, and affiliates are addressed by their opaque public id,
 * never the database id. Verification, commissions and payouts are later phases.
 */
export const router = express.Router();

// Changes need affiliate.manage, affiliate.verify, or (commission ledger only) affiliate.commissions / affiliate.payouts;
// each route then names exactly which one (need() below).
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || can(req.session?.caps || [], ['affiliate.manage', 'affiliate.verify'])) return next();
  if (/^\/(commissions\/backfill|[^/]+\/commissions\/\d+\/status)$/.test(req.path) && can(req.session?.caps || [], ['affiliate.commissions', 'affiliate.payouts'])) return next();
  // Payouts and TDS: finance staff (affiliate.payouts). An affiliate's payout details: they or an affiliate manager.
  if (/^\/payouts(\/|$)/.test(req.path) && can(req.session?.caps || [], 'affiliate.payouts')) return next();
  if (/^\/[^/]+\/payout-details$/.test(req.path) && can(req.session?.caps || [], 'affiliate.payouts')) return next();
  return res.status(403).json({ ok: false, error: 'Only an affiliate manager or an admin can change affiliates.' });
});
const need = (cap, error) => (req, res, next) => (can(req.session?.caps || [], cap) ? next() : res.status(403).json({ ok: false, error }));
const manage = need('affiliate.manage', 'Only an affiliate manager or an admin can change affiliates.');
const verify = need('affiliate.verify', 'Only a verification reviewer (affiliate manager) or an admin can do this.');
// The tables are prepared at startup (server.js); a request that arrives first waits on the same promise, and a failed startup attempt is retried here.
router.use((req, res, next) => ensureAffiliateVerificationSchema().then(() => ensureAffiliateReferralSchema()).then(() => ensureAffiliatePayoutSchema()).then(() => next(), next));

const send = (res, err) => {
  if (err instanceof StorageNotConfigured) return res.status(503).json({ ok: false, error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: `Files must be ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB or smaller.`, field: 'file' });
  if (err.status && err.status < 500) return res.status(err.status).json({ ok: false, error: err.message, field: err.field, conflict: err.conflict, scope: err.scope });
  if (err.status === 502) return res.status(502).json({ ok: false, error: err.message });
  if (err.status === 503) return res.status(503).json({ ok: false, error: err.message });
  console.error('Affiliates error:', err.code || '', String(err.message).slice(0, 200));
  return res.status(500).json({ ok: false, error: 'Something went wrong. Nothing was saved.' });
};
const actorOf = (req) => currentUserName(req);

router.get('/meta', async (req, res) => {
  try {
    res.json({
      ok: true, statuses: AFFILIATE_STATUSES, categories: await listAffiliateCategories(), sorts: Object.keys(AFFILIATE_SORTS),
      transitions: Object.fromEntries(Object.entries(AFFILIATE_TRANSITIONS).map(([k, t]) => [k, { label: t.label, reason: Boolean(t.reason) }])),
      canManage: can(req.session?.caps || [], 'affiliate.manage'),
    });
  } catch (err) { send(res, err); }
});

router.get('/', async (req, res) => {
  try {
    const { q, category, status, sort, dir, limit, offset } = req.query;
    res.set('Cache-Control', 'private, no-store');
    res.json({ ok: true, ...(await listAffiliates({ q, category, status, sort, dir, limit, offset })) });
  } catch (err) { send(res, err); }
});

/* ------------------------------------------------------------------ payouts and TDS (Phase 2B)
 * Everything here is money: reading and changing it needs affiliate.payouts (admins hold every capability). These
 * routes come before /:publicId, which would otherwise read "payouts" as an affiliate id.
 */
const payouts = need('affiliate.payouts', 'Only affiliate finance staff (payouts) or an admin can see or make payouts.');
const noStore = (res) => res.set('Cache-Control', 'private, no-store');
const listOf = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
router.get('/payouts/overview', payouts, async (req, res) => {
  try { noStore(res); res.json({ ok: true, batches: await listPayoutBatches(), settings: await tdsSettings(), financial_year: financialYearOf() }); } catch (err) { send(res, err); }
});
router.get('/payouts/preview', payouts, async (req, res) => {
  try { noStore(res); res.json({ ok: true, preview: await previewPayoutBatch({ exclude: listOf(req.query.exclude) }) }); } catch (err) { send(res, err); }
});
router.post('/payouts/batches', payouts, async (req, res) => {
  try {
    const { ref } = await createPayoutBatch({ exclude: listOf(req.body?.exclude), note: req.body?.note, actor: await actorOf(req) });
    res.status(201).json({ ok: true, batch: await getPayoutBatch(ref) });
  } catch (err) { send(res, err); }
});
router.get('/payouts/batches/:ref', payouts, async (req, res) => {
  try {
    const b = await getPayoutBatch(req.params.ref);
    if (!b) return res.status(404).json({ ok: false, error: 'No such batch.' });
    noStore(res); return res.json({ ok: true, batch: b });
  } catch (err) { return send(res, err); }
});
const file = (res, out) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(out.body);
};
router.get('/payouts/batches/:ref/bank-file', payouts, async (req, res) => {
  try { file(res, await payoutBankFile(req.params.ref, { actor: await actorOf(req) })); } catch (err) { send(res, err); }
});
router.post('/payouts/batches/:ref/cancel', payouts, async (req, res) => {
  try { await cancelPayoutBatch(req.params.ref, { reason: req.body?.reason, actor: await actorOf(req) }); res.json({ ok: true, batch: await getPayoutBatch(req.params.ref) }); } catch (err) { send(res, err); }
});
router.post('/payouts/payouts/:ref/paid', payouts, async (req, res) => {
  try {
    const { utr, paid_on: paidOn, version, batch } = req.body ?? {};
    await markPayoutPaid(req.params.ref, { utr, paid_on: paidOn, version, actor: await actorOf(req) });
    res.json({ ok: true, batch: batch ? await getPayoutBatch(batch) : null });
  } catch (err) { send(res, err); }
});
router.post('/payouts/payouts/:ref/failed', payouts, async (req, res) => {
  try {
    const { reason, version, batch } = req.body ?? {};
    await markPayoutFailed(req.params.ref, { reason, version, actor: await actorOf(req) });
    res.json({ ok: true, batch: batch ? await getPayoutBatch(batch) : null });
  } catch (err) { send(res, err); }
});
router.get('/payouts/tds-register', payouts, async (req, res) => {
  try { file(res, await tdsRegister({ fy: req.query.fy })); } catch (err) { send(res, err); }
});
router.put('/payouts/settings', payouts, async (req, res) => {
  try { res.json({ ok: true, settings: await updateTdsSettings(req.body ?? {}, { actor: await actorOf(req) }) }); } catch (err) { send(res, err); }
});

router.get('/:publicId', async (req, res) => {
  try {
    const out = await getAffiliate(req.params.publicId);
    if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ ok: true, ...out });
  } catch (err) { return send(res, err); }
});
router.get('/:publicId/events', async (req, res) => {
  try {
    const out = await getAffiliate(req.params.publicId);
    if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
    return res.json({ ok: true, events: out.events });
  } catch (err) { return send(res, err); }
});

router.post('/', manage, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await createAffiliate(req.body ?? {}, { actor: await actorOf(req) })) }); } catch (err) { send(res, err); }
});
router.patch('/:publicId', manage, async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    const out = await updateAffiliate(req.params.publicId, fields, { actor: await actorOf(req), version });
    // A category change can change eligibility: the affiliate's Shopify discount codes follow (best effort, recorded).
    await syncCouponsForAffiliate(req.params.publicId, { actor: await actorOf(req) }).catch(() => {});
    res.json({ ok: true, ...out });
  } catch (err) { send(res, err); }
});
router.post('/:publicId/status', manage, async (req, res) => {
  try {
    const { action, version, reason } = req.body ?? {};
    const out = await setAffiliateStatus(req.params.publicId, action, { actor: await actorOf(req), version, reason });
    // Suspended / closed: the affiliate's Shopify discount codes stop working; eligible again: they work again.
    await syncCouponsForAffiliate(req.params.publicId, { actor: await actorOf(req) }).catch(() => {});
    res.json({ ok: true, ...out });
  } catch (err) { send(res, err); }
});
router.post('/:publicId/rates', manage, async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await addAffiliateRate(req.params.publicId, req.body ?? {}, { actor: await actorOf(req) })) }); } catch (err) { send(res, err); }
});

/* ------------------------------------------------------------------ professional verification (Phase 1D)
 * Read: affiliate.view. Profile and documents: affiliate.manage. Lifecycle
 * decisions and opening a document: affiliate.verify. Finance roles hold neither.
 */
const caps = (req) => ({ canManage: can(req.session?.caps || [], 'affiliate.manage'), canVerify: can(req.session?.caps || [], 'affiliate.verify') });
const verificationOut = async (req, res, out, status = 200) => {
  if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
  res.set('Cache-Control', 'private, no-store');
  return res.status(status).json({ ok: true, verification: out, ...caps(req) });
};

router.get('/:publicId/verification', async (req, res) => {
  try { await verificationOut(req, res, await getVerification(req.params.publicId)); } catch (err) { send(res, err); }
});
router.get('/:publicId/professional', async (req, res) => {
  try {
    const v = await getVerification(req.params.publicId);
    if (!v) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
    return res.json({ ok: true, required: v.required, profile: v.profile });
  } catch (err) { return send(res, err); }
});
router.post('/:publicId/professional', manage, async (req, res) => {
  try { await verificationOut(req, res, await createProfessionalProfile(req.params.publicId, req.body ?? {}, { actor: await actorOf(req) }), 201); } catch (err) { send(res, err); }
});
router.patch('/:publicId/professional', manage, async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    await verificationOut(req, res, await updateProfessionalProfile(req.params.publicId, fields, { actor: await actorOf(req), version }));
  } catch (err) { send(res, err); }
});

// Upload: the raw file is the body, its name in x-filename, its metadata in the query — as order documents.
router.post('/:publicId/verification/documents', manage, express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 }), async (req, res) => {
  try {
    let filename;
    try { filename = decodeURIComponent(String(req.get('x-filename') || '')); } catch { return res.status(400).json({ ok: false, error: 'Malformed file name.', field: 'file' }); }
    const { type, label, issued_at: issued, expires_at: expires } = req.query;
    await verificationOut(req, res, await uploadProfessionalDocument(req.params.publicId, {
      filename, buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), document_type: String(type || ''),
      document_label: label, issued_at: issued, expires_at: expires,
    }, { actor: await actorOf(req) }), 201);
  } catch (err) { send(res, err); }
});

/** Streams a document through the app: no bucket or signed URL, never cached, every open audited. */
router.get('/:publicId/verification/:applicationRef/documents/:documentRef', verify, async (req, res) => {
  try {
    const f = await openProfessionalDocument(req.params.publicId, req.params.applicationRef, req.params.documentRef, { actor: await actorOf(req) });
    res.set({
      'Content-Type': f.mime,
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(f.buffer);
  } catch (err) { send(res, err); }
});

router.post('/:publicId/verification/start', verify, async (req, res) => {
  try { await verificationOut(req, res, await startVerification(req.params.publicId, { actor: await actorOf(req) }), 201); } catch (err) { send(res, err); }
});
router.post('/:publicId/verification/resubmit', verify, async (req, res) => {
  try { await verificationOut(req, res, await resubmitVerification(req.params.publicId, { actor: await actorOf(req), version: req.body?.version }), 201); } catch (err) { send(res, err); }
});
for (const action of Object.keys(VERIFICATION_ACTIONS)) {
  router.post(`/:publicId/verification/${action}`, verify, async (req, res) => {
    try {
      const { version, reason, notes } = req.body ?? {};
      await verificationOut(req, res, await verificationAction(req.params.publicId, action, { actor: await actorOf(req), version, reason, notes }));
    } catch (err) { send(res, err); }
  });
}

/* ------------------------------------------------------------------ referral link (Phase 1E)
 * Read: affiliate.view. Create / disable / set up the storefront redirect: affiliate.manage.
 * Verification and finance roles get no referral authority.
 */
const referralOut = (req, res, out, status = 200) => {
  if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
  res.set('Cache-Control', 'private, no-store');
  return res.status(status).json({ ok: true, referral: out, canManage: can(req.session?.caps || [], 'affiliate.manage') });
};
/**
 * Performance: clicks, attributed orders and — for admins and commission staff (affiliate.commissions) — each
 * order's current value and its commission. Money is financial data: for anyone else those fields are absent.
 */
const seesMoney = (req) => Boolean(req.session?.isAdmin) || can(req.session?.caps || [], 'affiliate.commissions');
router.get('/:publicId/performance', async (req, res) => {
  try {
    const out = await getAffiliatePerformance(req.params.publicId, { money: seesMoney(req) });
    if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ ok: true, performance: out, money: seesMoney(req),
      canApprove: can(req.session?.caps || [], 'affiliate.commissions'), canPay: can(req.session?.caps || [], 'affiliate.payouts') });
  } catch (err) { return send(res, err); }
});
router.post('/:publicId/commissions/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    // Only statuses with a capability can be requested; anything else (pending, unknown) is refused here, before
    // the commission is read, so the answer reveals nothing about it.
    const cap = Object.hasOwn(COMMISSION_STATUS_CAP, status) ? COMMISSION_STATUS_CAP[status] : null;
    if (!cap) return res.status(403).json({ ok: false, error: 'That status cannot be set.' });
    if (!can(req.session?.caps || [], cap)) {
      return res.status(403).json({ ok: false, error: status === 'paid' ? 'Only affiliate finance staff (payouts) or an admin can mark a commission paid.' : 'Only affiliate finance staff (commissions) or an admin can do this.' });
    }
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ ok: false, error: 'No such commission.' });
    res.json({ ok: true, commission: await setCommissionStatus(req.params.publicId, Number(req.params.id), { status, reason: req.body?.reason, version: req.body?.version, actor: await actorOf(req) }) });
  } catch (err) { send(res, err); }
});
// An explicit action: commissions for attributions that have none (made before the ledger, or skipped). Idempotent.
router.post('/commissions/backfill', need('affiliate.commissions', 'Only affiliate finance staff (commissions) or an admin can do this.'), async (req, res) => {
  try { res.json({ ok: true, ...(await backfillAffiliateCommissions({ actor: await actorOf(req) })) }); } catch (err) { send(res, err); }
});

router.get('/:publicId/referral', async (req, res) => {
  try { referralOut(req, res, await getReferral(req.params.publicId)); } catch (err) { send(res, err); }
});
router.post('/:publicId/referral', manage, async (req, res) => {
  try { referralOut(req, res, await createReferralLink(req.params.publicId, { actor: await actorOf(req) }), 201); } catch (err) { send(res, err); }
});
router.post('/:publicId/referral/disable', manage, async (req, res) => {
  try { referralOut(req, res, await disableReferralLink(req.params.publicId, { actor: await actorOf(req), reason: req.body?.reason, version: req.body?.version })); } catch (err) { send(res, err); }
});
// An explicit admin action: the only place this app writes to Shopify, and only a URL redirect.
router.post('/:publicId/referral/storefront-redirect', manage, async (req, res) => {
  try { referralOut(req, res, await syncStorefrontRedirect(req.params.publicId, { actor: await actorOf(req) })); } catch (err) { send(res, err); }
});

/* ------------------------------------------------------------------ coupons (Phase 2B)
 * Read: affiliate.view. Create / disable / sync: affiliate.manage. Each is a real Shopify discount code.
 */
const couponsOut = (req, res, out, status = 200) => {
  if (!out) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
  noStore(res);
  return res.status(status).json({ ok: true, ...out, canManage: can(req.session?.caps || [], 'affiliate.manage') });
};
router.get('/:publicId/coupons', async (req, res) => {
  try { couponsOut(req, res, await listCoupons(req.params.publicId)); } catch (err) { send(res, err); }
});
router.post('/:publicId/coupons', manage, async (req, res) => {
  try { couponsOut(req, res, await createCoupon(req.params.publicId, req.body ?? {}, { actor: await actorOf(req) }), 201); } catch (err) { send(res, err); }
});
router.post('/:publicId/coupons/sync', manage, async (req, res) => {
  try {
    const sync = await syncCouponsForAffiliate(req.params.publicId, { actor: await actorOf(req) });
    const out = await listCoupons(req.params.publicId);
    couponsOut(req, res, out && { ...out, sync });
  } catch (err) { send(res, err); }
});
router.post('/:publicId/coupons/:ref/disable', manage, async (req, res) => {
  try {
    couponsOut(req, res, await disableCoupon(req.params.publicId, req.params.ref, { reason: req.body?.reason, version: req.body?.version, actor: await actorOf(req) }));
  } catch (err) { send(res, err); }
});

/* ------------------------------------------------------------------ payout details (Phase 2B)
 * Read: affiliate.view, masked (PAN and account show their last 4). Change: affiliate.manage or affiliate.payouts.
 * The affiliate's own payouts are money: affiliate.payouts.
 */
const editsPayoutDetails = (req) => can(req.session?.caps || [], ['affiliate.manage', 'affiliate.payouts']);
router.get('/:publicId/payout-details', async (req, res) => {
  try {
    const d = await getPayoutDetails(req.params.publicId);
    if (!d) return res.status(404).json({ ok: false, error: 'No such affiliate.' });
    const seesPayouts = can(req.session?.caps || [], 'affiliate.payouts');
    noStore(res);
    return res.json({ ok: true, details: d, canEdit: editsPayoutDetails(req), payouts: seesPayouts ? await affiliatePayouts(req.params.publicId) : null });
  } catch (err) { return send(res, err); }
});
router.put('/:publicId/payout-details', async (req, res) => {
  try {
    if (!editsPayoutDetails(req)) return res.status(403).json({ ok: false, error: 'Only an affiliate manager, affiliate finance staff or an admin can change payout details.' });
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, details: await setPayoutDetails(req.params.publicId, fields, { version, actor: await actorOf(req) }), canEdit: true });
  } catch (err) { send(res, err); }
});

// Errors raised before a handler runs (an oversized upload, schema setup) answer in the same JSON shape.
router.use((err, req, res, _next) => send(res, err));
