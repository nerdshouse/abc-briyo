import express from 'express';
import { currentUserName } from './auth-routes.js';
import { can } from './permissions.js';
import {
  ensureAffiliateSchema, listAffiliates, getAffiliate, createAffiliate, updateAffiliate, setAffiliateStatus, addAffiliateRate,
  listAffiliateCategories, AFFILIATE_STATUSES, AFFILIATE_TRANSITIONS, AFFILIATE_SORTS,
} from './affiliates.js';

/**
 * /api/affiliates — mounted behind requireAuth + requirePermission('affiliate.view').
 * Reading needs affiliate.view; every change needs affiliate.manage. Internal
 * only: no public route, and affiliates are addressed by their opaque public id,
 * never the database id. Verification, commissions and payouts are later phases.
 */
export const router = express.Router();

router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || can(req.session?.caps || [], 'affiliate.manage')) return next();
  return res.status(403).json({ ok: false, error: 'Only an affiliate manager or an admin can change affiliates.' });
});
// The tables are prepared at startup (server.js); a request that arrives first waits on the same promise, and a failed startup attempt is retried here.
router.use((req, res, next) => ensureAffiliateSchema().then(() => next(), next));

const send = (res, err) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ ok: false, error: err.message, field: err.field, conflict: err.conflict });
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

router.post('/', async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await createAffiliate(req.body ?? {}, { actor: await actorOf(req) })) }); } catch (err) { send(res, err); }
});
router.patch('/:publicId', async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, ...(await updateAffiliate(req.params.publicId, fields, { actor: await actorOf(req), version })) });
  } catch (err) { send(res, err); }
});
router.post('/:publicId/status', async (req, res) => {
  try {
    const { action, version, reason } = req.body ?? {};
    res.json({ ok: true, ...(await setAffiliateStatus(req.params.publicId, action, { actor: await actorOf(req), version, reason })) });
  } catch (err) { send(res, err); }
});
router.post('/:publicId/rates', async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await addAffiliateRate(req.params.publicId, req.body ?? {}, { actor: await actorOf(req) })) }); } catch (err) { send(res, err); }
});
