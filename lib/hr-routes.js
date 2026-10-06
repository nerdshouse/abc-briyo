import express from 'express';
import { currentUserName } from './auth-routes.js';
import { can } from './permissions.js';
import { StorageNotConfigured } from './storage.js';
import {
  listJobs, getJob, createJob, updateJob, setJobStatus,
  listApplications, getApplication, setApplicationStatus, addApplicationNote, resumeFile, removeResume,
  JOB_STATUSES, EMPLOYMENT_TYPES, WORK_MODES, SALARY_PERIODS, SECTION_KEYS, APPLICATION_STATUSES, careersBaseUrl,
} from './hr.js';

/**
 * /api/hr — mounted behind requireAuth + requirePermission('hr.view').
 * Reading needs hr.view; every change needs hr.manage. Internal host only:
 * the careers host never reaches this router (lib/careers.js).
 */
export const router = express.Router();

router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || can(req.session?.caps || [], 'hr.manage')) return next();
  return res.status(403).json({ ok: false, error: 'Only an HR manager or an admin can change jobs and applications.' });
});

const idOf = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const send = (res, err) => {
  if (err instanceof StorageNotConfigured) return res.status(503).json({ ok: false, error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ ok: false, error: err.message, conflict: err.conflict, field: err.field });
  console.error('HR error:', err.code || '', err.message?.slice(0, 200));
  return res.status(500).json({ ok: false, error: 'Something went wrong. Nothing was saved.' });
};

router.get('/meta', (req, res) => res.json({
  ok: true, jobStatuses: JOB_STATUSES, employmentTypes: EMPLOYMENT_TYPES, workModes: WORK_MODES, salaryPeriods: SALARY_PERIODS,
  sections: SECTION_KEYS, applicationStatuses: APPLICATION_STATUSES, careersBaseUrl: careersBaseUrl(),
  canManage: can(req.session?.caps || [], 'hr.manage'),
  timezone: process.env.BOARD_TIMEZONE || process.env.BOARD_TZ || 'Asia/Kolkata',
}));

router.get('/jobs', async (req, res) => {
  try { res.json({ ok: true, jobs: await listJobs({ q: req.query.q, status: req.query.status }) }); } catch (err) { send(res, err); }
});
router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await getJob(idOf(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: 'No such job.' });
    return res.json({ ok: true, job });
  } catch (err) { return send(res, err); }
});
router.post('/jobs', async (req, res) => {
  try { res.status(201).json({ ok: true, job: await createJob(req.body ?? {}, { actor: await currentUserName(req) }) }); } catch (err) { send(res, err); }
});
router.patch('/jobs/:id', async (req, res) => {
  try {
    const { version, ...fields } = req.body ?? {};
    res.json({ ok: true, job: await updateJob(idOf(req.params.id), fields, { actor: await currentUserName(req), version }) });
  } catch (err) { send(res, err); }
});
for (const action of ['publish', 'close', 'archive', 'restore']) {
  router.post(`/jobs/:id/${action}`, async (req, res) => {
    try { res.json({ ok: true, job: await setJobStatus(idOf(req.params.id), action, { actor: await currentUserName(req), version: req.body?.version }) }); }
    catch (err) { send(res, err); }
  });
}

router.get('/applications', async (req, res) => {
  try {
    const { job, status, q, from, to } = req.query;
    res.json({ ok: true, applications: await listApplications({ job, status, q, from, to }) });
  } catch (err) { send(res, err); }
});
router.get('/applications/:id', async (req, res) => {
  try {
    const a = await getApplication(idOf(req.params.id));
    if (!a) return res.status(404).json({ ok: false, error: 'No such application.' });
    return res.json({ ok: true, ...a });
  } catch (err) { return send(res, err); }
});
router.patch('/applications/:id/status', async (req, res) => {
  try {
    const { status, version, note } = req.body ?? {};
    res.json({ ok: true, ...(await setApplicationStatus(idOf(req.params.id), status, { actor: await currentUserName(req), version, note })) });
  } catch (err) { send(res, err); }
});
router.post('/applications/:id/notes', async (req, res) => {
  try { res.status(201).json({ ok: true, note: await addApplicationNote(idOf(req.params.id), req.body?.body, { actor: await currentUserName(req) }) }); }
  catch (err) { send(res, err); }
});

/** The resume, streamed through the app: never a public or pre-signed URL. */
router.get('/applications/:id/resume', async (req, res) => {
  try {
    const f = await resumeFile(idOf(req.params.id));
    res.set({
      'Content-Type': f.mime,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename || 'resume')}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.send(f.buffer);
  } catch (err) { send(res, err); }
});
router.delete('/applications/:id/resume', async (req, res) => {
  try { res.json({ ok: true, ...(await removeResume(idOf(req.params.id), { actor: await currentUserName(req) })) }); } catch (err) { send(res, err); }
});
