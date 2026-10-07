import express from 'express';
import { metaService, MetaError, RANGE_LABELS } from './meta-ads.js';

/**
 * /api/marketing — mounted behind requireAuth + requireCompleteProfile +
 * requirePermission('marketing.view') (admins only in V1). GET only: Briyo OS
 * never writes to Meta. Responses carry normalised numbers, the fetch time and
 * freshness; never a token, a secret or Meta's raw error text.
 */
export const router = express.Router();

// Read-only, enforced here too: anything but GET is refused.
router.use((req, res, next) => (req.method === 'GET' || req.method === 'HEAD'
  ? next() : res.status(405).json({ ok: false, error: 'Marketing is read-only.' })));

const rangeOf = (q) => ({ range: String(q.range || 'today'), since: q.since, until: q.until });
const force = (q) => q.refresh === '1';
const out = (res, payload) => res.set('Cache-Control', 'private, no-store').json({ ok: true, ...payload });

function fail(res, err) {
  if (err instanceof MetaError) {
    return res.status(err.status).json({ ok: false, kind: err.kind, error: err.message });
  }
  console.error('Marketing error:', err?.name || 'Error', String(err?.message || '').slice(0, 160));
  return res.status(500).json({ ok: false, kind: 'internal', error: 'Marketing data could not be loaded. Try again in a moment.' });
}

router.get('/status', async (req, res) => {
  const svc = metaService();
  const base = { configured: svc.config.configured, version: svc.config.version, signed: svc.config.signed, roasTarget: svc.config.roasTarget, ranges: RANGE_LABELS };
  if (!svc.config.configured) return out(res, { ...base, account: null });
  try {
    const a = await svc.account({ force: force(req.query) });
    return out(res, { ...base, account: a.data, fetchedAt: a.fetchedAt, stale: a.stale });
  } catch (err) {
    if (err instanceof MetaError) return out(res, { ...base, account: null, connectionError: { kind: err.kind, message: err.message } });
    return fail(res, err);
  }
});

router.get('/summary', async (req, res) => {
  try { const r = await metaService().summary(rangeOf(req.query), { force: force(req.query) }); out(res, { ...r.data, fetchedAt: r.fetchedAt, stale: r.stale, staleReason: r.error || null }); }
  catch (err) { fail(res, err); }
});

router.get('/campaigns', async (req, res) => {
  try { const r = await metaService().level('campaign', rangeOf(req.query), { force: force(req.query) }); out(res, { ...r.data, fetchedAt: r.fetchedAt, stale: r.stale, staleReason: r.error || null }); }
  catch (err) { fail(res, err); }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const svc = metaService(); const q = rangeOf(req.query); const f = force(req.query);
    const [obj, sets] = await Promise.all([svc.object('campaign', req.params.id, q, { force: f }), svc.level('adset', q, { parent: { id: req.params.id }, force: f })]);
    out(res, { ...obj.data, adsets: sets.data.rows, truncated: sets.data.truncated,
      fetchedAt: obj.fetchedAt < sets.fetchedAt ? obj.fetchedAt : sets.fetchedAt, stale: obj.stale || sets.stale, staleReason: obj.error || sets.error || null });
  } catch (err) { fail(res, err); }
});

router.get('/adsets/:id', async (req, res) => {
  try {
    const svc = metaService(); const q = rangeOf(req.query); const f = force(req.query);
    const [obj, ads] = await Promise.all([svc.object('adset', req.params.id, q, { force: f }), svc.level('ad', q, { parent: { id: req.params.id }, force: f })]);
    out(res, { ...obj.data, ads: ads.data.rows, truncated: ads.data.truncated,
      fetchedAt: obj.fetchedAt < ads.fetchedAt ? obj.fetchedAt : ads.fetchedAt, stale: obj.stale || ads.stale, staleReason: obj.error || ads.error || null });
  } catch (err) { fail(res, err); }
});
