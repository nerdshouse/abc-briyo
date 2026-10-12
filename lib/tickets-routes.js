/**
 * /api/tickets — mounted after requireAuth and requireCompleteProfile, so every request is a signed-in, active member
 * with a complete profile. Who may see or change which ticket is decided in lib/tickets.js on every call (members:
 * their own tickets; the ticket owner and admins: all). Bodies are JSON only (express.json), as everywhere in
 * Briyo OS; the session cookie is SameSite=Lax.
 */
import express from 'express';
import { isMockMode } from './db.js';
import {
  CATEGORIES, PRIORITIES, STATUSES, LIMITS, ensureTicketsSchema, createTicket, listTickets, getTicket, addComment,
  setTicketStatus, assignTicket, retryTicketNotification, deliverTicketNotification, isTicketManager, ticketManagers,
  resolveOwner, memberKey, pendingNotificationOf,
} from './tickets.js';
import { getPool } from './db.js';

export const router = express.Router();

router.use(async (req, res, next) => {
  if (isMockMode()) return res.status(503).json({ ok: false, error: 'Tickets need a database (DATABASE_URL).' });
  if (!req.session?.phone) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  try { await ensureTicketsSchema(); return next(); } catch (err) { return next(err); }
});

const send = (res, err) => {
  if (err.status && err.status < 500 || err.code === 'TICKET_OWNER_UNRESOLVED') {
    return res.status(err.status).json({ ok: false, error: err.message, field: err.field, conflict: err.conflict, code: err.code });
  }
  console.error('Tickets request failed:', String(err.message).slice(0, 300));
  return res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
};
const labels = (o) => Object.entries(o).map(([key, label]) => ({ key, label }));

/** What the page needs: the lists, whether you manage tickets, and (managers) who tickets can go to and who raised them. */
router.get('/meta', async (req, res) => {
  try {
    const db = getPool();
    const manager = await isTicketManager(req.session, db);
    // Why the owner cannot be found is for managers (it names the setting); members are only told tickets are not set up.
    const owner = await resolveOwner(db).then((o) => ({ name: o.name, resolved: true }),
      (e) => ({ name: null, resolved: false, error: manager ? e.message : 'Tickets are not set up yet. Ask an admin.' }));
    const extra = {};
    if (manager) {
      extra.managers = (await ticketManagers(db)).map(({ key, name, owner: isOwner }) => ({ key, name, owner: isOwner }));
      const { rows } = await db.query('SELECT creator_phone, max(creator_name) AS name FROM tickets WHERE creator_phone IS NOT NULL GROUP BY creator_phone ORDER BY 2');
      extra.creators = rows.map((r) => ({ key: memberKey(r.creator_phone), name: r.name }));
    }
    res.json({ ok: true, categories: labels(CATEGORIES), priorities: labels(PRIORITIES), statuses: labels(STATUSES), limits: LIMITS, manager, owner, ...extra });
  } catch (err) { send(res, err); }
});

router.get('/', async (req, res) => {
  try { res.json({ ok: true, ...(await listTickets(req.session, req.query)) }); } catch (err) { send(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const r = await createTicket(req.body ?? {}, req.session);
    res.status(r.created ? 201 : 200).json({ ok: true, created: r.created, ticket: (await getTicket(r.ticket.number, req.session)).ticket });
    // After the response: the ticket stands whatever WhatsApp does. The outbox row records the outcome. A replayed
    // create (same request id) sends the notice only if it is still pending — e.g. the first response was lost.
    const notice = r.created ? r.notificationId : await pendingNotificationOf(r.ticket.id).catch(() => null);
    if (notice) {
      deliverTicketNotification(notice).catch((err) => console.error(`Ticket ${r.ticket.number}: notice not attempted: ${String(err.message).slice(0, 200)}`));
    }
  } catch (err) { send(res, err); }
});

router.get('/:number', async (req, res) => {
  try { res.json({ ok: true, ...(await getTicket(req.params.number, req.session)) }); } catch (err) { send(res, err); }
});

router.post('/:number/comments', async (req, res) => {
  try { res.status(201).json({ ok: true, comment: await addComment(req.params.number, req.body ?? {}, req.session) }); } catch (err) { send(res, err); }
});

router.patch('/:number/status', async (req, res) => {
  try { res.json({ ok: true, ...(await setTicketStatus(req.params.number, req.body ?? {}, req.session)) }); } catch (err) { send(res, err); }
});

router.patch('/:number/assignee', async (req, res) => {
  try { res.json({ ok: true, ...(await assignTicket(req.params.number, req.body ?? {}, req.session)) }); } catch (err) { send(res, err); }
});

router.post('/:number/notification/retry', async (req, res) => {
  try { res.json({ ok: true, ...(await retryTicketNotification(req.params.number, req.session)) }); } catch (err) { send(res, err); }
});
