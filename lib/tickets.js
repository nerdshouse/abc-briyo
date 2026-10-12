/**
 * Tickets: any member raises one; it goes to the ticket owner (the founder, Janvi Patel) and she is told on WhatsApp.
 *
 * Who may do what (enforced here and in lib/tickets-routes.js, never only in the page):
 *   - Any signed-in member (requireAuth + requireCompleteProfile already passed) creates tickets, and sees and comments
 *     on the tickets THEY created. Nobody else's: another member's ticket is "No such ticket." (404), never 403, so a
 *     ticket number says nothing about tickets that are not yours.
 *   - Ticket managers — the ticket owner, and admins (who hold every power in Briyo OS) — see every ticket, change
 *     status, reassign (to another ticket manager) and retry the WhatsApp notice.
 *   This is not a module role: raising a ticket must not depend on having one, and it grants nothing elsewhere.
 *
 * The owner is found in the member list (allowed_users) by name — TICKETS_OWNER_NAME, default "Janvi Patel": exactly
 * one ACTIVE member must carry it. None or several → ticket creation is refused with TICKET_OWNER_UNRESOLVED (503),
 * never assigned to someone else. Her number is never written in code; it is her member record's. A member cannot
 * give THEMSELF that name (lib/profile.js updateProfile, reservedName) — only an admin can — so nobody can take over
 * the inbox or block it by renaming themselves.
 *
 * Numbers: TKT-00001…, generated from the row's sequence id (as SO- and ORD- numbers are): unique under any
 * concurrency; a refused or rolled-back insert can leave a gap.
 *
 * WhatsApp: a durable outbox row (ticket_notifications) is written in the same transaction as the ticket, then sent
 * after commit — so a ticket never depends on WhatsApp. See deliverTicketNotification for the states and retries.
 */
import crypto from 'node:crypto';
import { getPool } from './db.js';
import { inTransaction } from './orders.js';
import { normalisePhone, bootstrapAdmins } from './otp.js';
import { sendTicketAlert } from './whatsapp.js';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export const CATEGORIES = { bug: 'Bug', technical_issue: 'Technical Issue', access_request: 'Access Request', operational_issue: 'Operational Issue', other: 'Other' };
export const PRIORITIES = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const STATUSES = { open: 'Open', in_progress: 'In Progress', waiting: 'Waiting for Information', resolved: 'Resolved', closed: 'Closed' };
export const LIMITS = { title: 160, description: 5000, comment: 2000, search: 100 };
const NUMBER_RE = /^TKT-\d{5,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_SENDING_MINUTES = 10;
// A member's new tickets per rolling hour (each one is a WhatsApp message to the founder). TICKETS_PER_HOUR overrides.
const perHour = () => Math.max(Number.parseInt(process.env.TICKETS_PER_HOUR, 10) || 20, 1);

export const ownerName = () => String(process.env.TICKETS_OWNER_NAME || 'Janvi Patel').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ schema */

let schema = null;
export function ensureTicketsSchema() {
  if (!schema) {
    schema = (async () => {
      const list = (o) => Object.keys(o).map((k) => `'${k}'`).join(',');
      const ddl = [`
        CREATE TABLE IF NOT EXISTS tickets (
          id             BIGSERIAL PRIMARY KEY,
          -- lpad would cut 100000 to 10000; past five digits the number simply grows.
          number         TEXT GENERATED ALWAYS AS ('TKT-' || CASE WHEN id < 100000 THEN lpad(id::text, 5, '0') ELSE id::text END) STORED UNIQUE,
          title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${LIMITS.title}),
          description    TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND ${LIMITS.description}),
          category       TEXT NOT NULL CHECK (category IN (${list(CATEGORIES)})),
          priority       TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN (${list(PRIORITIES)})),
          status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${list(STATUSES)})),
          -- Removing a member keeps their tickets (and the names on them); only the link to the member goes.
          creator_phone  TEXT REFERENCES allowed_users(phone) ON UPDATE CASCADE ON DELETE SET NULL,
          creator_name   TEXT NOT NULL,
          assignee_phone TEXT REFERENCES allowed_users(phone) ON UPDATE CASCADE ON DELETE SET NULL,
          assignee_name  TEXT,
          request_id     UUID,
          version        INTEGER NOT NULL DEFAULT 1,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          resolved_at    TIMESTAMPTZ,
          closed_at      TIMESTAMPTZ,
          UNIQUE (creator_phone, request_id)
        )`,
      'CREATE INDEX IF NOT EXISTS tickets_creator_idx ON tickets (creator_phone, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (assignee_phone, status)',
      `CREATE TABLE IF NOT EXISTS ticket_comments (
          id           BIGSERIAL PRIMARY KEY,
          ticket_id    BIGINT NOT NULL REFERENCES tickets(id),
          author_phone TEXT REFERENCES allowed_users(phone) ON UPDATE CASCADE ON DELETE SET NULL,
          author_name  TEXT NOT NULL,
          body         TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${LIMITS.comment}),
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      'CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx ON ticket_comments (ticket_id, id)',
      `CREATE TABLE IF NOT EXISTS ticket_events (
          id          BIGSERIAL PRIMARY KEY,
          ticket_id   BIGINT NOT NULL REFERENCES tickets(id),
          event_type  TEXT NOT NULL,
          actor_phone TEXT,
          actor_name  TEXT,
          at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          metadata    JSONB NOT NULL DEFAULT '{}'
        )`,
      'CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id, id)',
      // Append-only, as order_events: the only way past it is a transaction that sets app.purge_tickets (test suite).
      `CREATE OR REPLACE FUNCTION ticket_events_append_only() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' AND current_setting('app.purge_tickets', true) = 'on' THEN RETURN OLD; END IF;
          RAISE EXCEPTION 'ticket_events is append-only';
        END $$ LANGUAGE plpgsql`,
      'DROP TRIGGER IF EXISTS ticket_events_append_only ON ticket_events',
      `CREATE TRIGGER ticket_events_append_only BEFORE UPDATE OR DELETE ON ticket_events
         FOR EACH ROW EXECUTE FUNCTION ticket_events_append_only()`,
      // The WhatsApp outbox: one row per ticket and kind, so a retry can never make a second notice.
      `CREATE TABLE IF NOT EXISTS ticket_notifications (
          id              BIGSERIAL PRIMARY KEY,
          ticket_id       BIGINT NOT NULL REFERENCES tickets(id),
          kind            TEXT NOT NULL,
          recipient_phone TEXT,
          status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sending','submitted','unconfirmed','failed','skipped')),
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_attempt_at TIMESTAMPTZ,
          submitted_at    TIMESTAMPTZ,
          UNIQUE (ticket_id, kind)
        )`];
      await getPool().query(ddl.join(';\n'));
    })().catch((err) => { schema = null; throw err; });
  }
  return schema;
}

/* ------------------------------------------------------------------ input */

/** Plain text: control characters removed (newlines kept where allowed), trimmed. */
function textField(v, field, label, max, { multiline = false, required = true } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${label} must be text.`, 400, { field });
  // Invisible and direction-changing characters are removed (they could disguise a title in the list or the notice).
  let s = v.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '').replace(/\r\n?/g, '\n').replace(multiline ? /[\u0000-\u0008\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, multiline ? '' : ' ');
  s = multiline ? s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (!s && required) throw bad(`Enter the ${label.toLowerCase()}.`, 400, { field });
  if (s.length > max) throw bad(`${label} is too long (${s.length} characters; the limit is ${max}).`, 400, { field });
  return s;
}
const oneOfField = (v, map, field, label) => {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : v;
  if (typeof k !== 'string' || !Object.hasOwn(map, k)) throw bad(`Choose a valid ${label.toLowerCase()}.`, 400, { field });
  return k;
};

export function ticketInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the ticket as a JSON object.');
  const requestId = input.request_id === undefined || input.request_id === null || input.request_id === '' ? null : String(input.request_id).toLowerCase();
  if (requestId !== null && !UUID_RE.test(requestId)) throw bad('request_id must be a UUID.', 400, { field: 'request_id' });
  return {
    title: textField(input.title, 'title', 'Title', LIMITS.title),
    description: textField(input.description, 'description', 'Description', LIMITS.description, { multiline: true }),
    category: oneOfField(input.category, CATEGORIES, 'category', 'Category'),
    // Required, with Medium as the default the form starts on: only absent means Medium; anything sent must be valid.
    priority: input.priority === undefined || input.priority === null || input.priority === '' ? 'medium' : oneOfField(input.priority, PRIORITIES, 'priority', 'Priority'),
    requestId,
  };
}

/* ------------------------------------------------------------------ who */

/** The ticket owner's member row, or a refusal that says what is wrong (never a substitute). */
export async function resolveOwner(db = getPool()) {
  const name = ownerName();
  const { rows } = await db.query(
    `SELECT phone, name FROM allowed_users WHERE active AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower($1)`, [name]);
  if (rows.length !== 1) {
    throw bad(`Tickets are not set up: the ticket owner "${name}" ${rows.length ? `matches ${rows.length} active members` : 'is not an active member'}. Ask an admin to check the member list (or TICKETS_OWNER_NAME).`,
      503, { code: 'TICKET_OWNER_UNRESOLVED' });
  }
  return rows[0];
}

/** Can this session see every ticket and change status/assignee? Admins, and the ticket owner. */
export async function isTicketManager(session, db = getPool()) {
  if (!session?.phone) return false;
  if (session.isAdmin) return true;
  try { return (await resolveOwner(db)).phone === session.phone; } catch { return false; }
}

// Members are referred to by an opaque key in the API (filters, reassignment), never by phone number.
// Stable across restarts and instances when SESSION_SECRET is set (keys on an open page keep working after a deploy).
const KEY_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
  ? crypto.createHash('sha256').update(`tickets-member-key:${process.env.SESSION_SECRET}`).digest() : crypto.randomBytes(32);
export const memberKey = (phone) => crypto.createHmac('sha256', KEY_SECRET).update(`ticket-member:${phone}`).digest('hex').slice(0, 20);

async function memberName(db, phone) {
  const { rows } = await db.query('SELECT name FROM allowed_users WHERE phone = $1 AND active', [phone]);
  if (!rows.length) throw bad('Your access has been removed.', 401);
  return rows[0].name;
}

/** Ticket managers, for reassignment: admins and the owner, by key and name only. */
export async function ticketManagers(db = getPool()) {
  const owner = await resolveOwner(db).catch(() => null);
  const { rows } = await db.query(
    'SELECT phone, name FROM allowed_users WHERE active AND (is_admin OR phone = $1 OR phone = ANY($2)) ORDER BY name',
    [owner?.phone ?? null, [...bootstrapAdmins()]]);
  return rows.map((r) => ({ key: memberKey(r.phone), name: r.name, owner: r.phone === owner?.phone, phone: r.phone }));
}

/* ------------------------------------------------------------------ events */

async function logTicketEvent(client, ticketId, type, actor, metadata = {}) {
  await client.query('INSERT INTO ticket_events (ticket_id, event_type, actor_phone, actor_name, metadata) VALUES ($1, $2, $3, $4, $5)',
    [ticketId, type, actor?.phone ?? null, actor?.name ?? null, JSON.stringify(metadata)]);
}

/* ------------------------------------------------------------------ create */

const sameTicket = (row, f) => row.title === f.title && row.description === f.description && row.category === f.category && row.priority === f.priority;

/**
 * Creates the ticket, its "created" and "assigned" events and its pending WhatsApp notice, in one transaction.
 * A repeated request_id from the same member (a retried submit) returns the ticket already made — never a second one.
 * Returns { ticket, created, notificationId }.
 */
export async function createTicket(input, session) {
  if (!session?.phone) throw bad('Not signed in.', 401);
  const f = ticketInput(input);
  await ensureTicketsSchema();
  return inTransaction(async (client) => {
    const creatorName = await memberName(client, session.phone);
    if (f.requestId) {
      // Serialise retries of one request id, so two simultaneous submits cannot both insert.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ticket-request:${session.phone}:${f.requestId}`]);
      const { rows: seen } = await client.query('SELECT * FROM tickets WHERE creator_phone = $1 AND request_id = $2', [session.phone, f.requestId]);
      if (seen.length) {
        if (!sameTicket(seen[0], f)) throw bad('That request was already used for a different ticket. Reload and try again.', 409, { conflict: true });
        const n = (await client.query("SELECT id FROM ticket_notifications WHERE ticket_id = $1 AND kind = 'ticket_created'", [seen[0].id])).rows[0];
        return { ticket: seen[0], created: false, notificationId: n ? Number(n.id) : null };
      }
    }
    const { rows: recent } = await client.query(
      "SELECT count(*)::int AS n FROM tickets WHERE creator_phone = $1 AND created_at > now() - interval '1 hour'", [session.phone]);
    if (recent[0].n >= perHour()) throw bad(`You have raised ${recent[0].n} tickets in the last hour. Add to an existing ticket, or try again later.`, 429);
    const owner = await resolveOwner(client);
    const { rows } = await client.query(
      `INSERT INTO tickets (title, description, category, priority, creator_phone, creator_name, assignee_phone, assignee_name, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [f.title, f.description, f.category, f.priority, session.phone, creatorName, owner.phone, owner.name, f.requestId]);
    const t = rows[0];
    const actor = { phone: session.phone, name: creatorName };
    await logTicketEvent(client, t.id, 'created', actor, { category: f.category, priority: f.priority });
    await logTicketEvent(client, t.id, 'assigned', { phone: null, name: 'Briyo OS' }, { to: owner.name, reason: 'ticket owner (automatic)' });
    const { rows: n } = await client.query(
      `INSERT INTO ticket_notifications (ticket_id, kind, recipient_phone) VALUES ($1, 'ticket_created', $2) RETURNING id`, [t.id, owner.phone]);
    return { ticket: t, created: true, notificationId: Number(n[0].id) };
  });
}

/* ------------------------------------------------------------------ read */

const STATUS_ORDER = Object.keys(STATUSES);
const publicTicket = (t, manager) => ({
  number: t.number, title: t.title, description: t.description, category: t.category, priority: t.priority, status: t.status,
  creator_name: t.creator_name, assignee_name: t.assignee_name, version: t.version,
  created_at: t.created_at, updated_at: t.updated_at, resolved_at: t.resolved_at, closed_at: t.closed_at,
  ...(t.comment_count !== undefined ? { comment_count: Number(t.comment_count) } : {}),
  ...(manager && t.creator_phone ? { creator_key: memberKey(t.creator_phone) } : {}),
});

/** A ticket the session may see, locked when asked; otherwise 404 (the same answer as for a number that does not exist). */
async function visibleTicket(db, number, session, { lock = false, manager }) {
  if (typeof number !== 'string' || !NUMBER_RE.test(number)) throw bad('No such ticket.', 404);
  const { rows } = await db.query(`SELECT * FROM tickets WHERE number = $1${lock ? ' FOR UPDATE' : ''}`, [number]);
  const t = rows[0];
  if (!t || (!manager && t.creator_phone !== session?.phone)) throw bad('No such ticket.', 404);
  return t;
}

/**
 * Tickets the session may see. Members: only their own, whatever scope they ask for. Managers: scope all (default),
 * assigned (to them) or mine (created by them); creator filter by member key.
 */
export async function listTickets(session, filters = {}) {
  await ensureTicketsSchema();
  const db = getPool();
  const manager = await isTicketManager(session, db);
  const where = []; const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const scope = manager ? (['all', 'assigned', 'mine'].includes(filters.scope) ? filters.scope : 'all') : 'mine';
  if (scope === 'mine') where.push(`t.creator_phone = ${p(session.phone)}`);
  if (scope === 'assigned') where.push(`t.assignee_phone = ${p(session.phone)}`);
  const pick = (v, map, field, label) => (v === undefined || v === '' ? null : oneOfField(v, map, field, label));
  const status = filters.status === 'active' ? 'active' : pick(filters.status, STATUSES, 'status', 'Status');
  if (status === 'active') where.push("t.status NOT IN ('resolved','closed')");
  else if (status) where.push(`t.status = ${p(status)}`);
  const priority = pick(filters.priority, PRIORITIES, 'priority', 'Priority');
  if (priority) where.push(`t.priority = ${p(priority)}`);
  const category = pick(filters.category, CATEGORIES, 'category', 'Category');
  if (category) where.push(`t.category = ${p(category)}`);
  if (manager && filters.creator) {
    const { rows: creators } = await db.query('SELECT DISTINCT creator_phone FROM tickets WHERE creator_phone IS NOT NULL');
    const phone = creators.map((r) => r.creator_phone).find((ph) => memberKey(ph) === String(filters.creator));
    where.push(phone ? `t.creator_phone = ${p(phone)}` : 'false');
  }
  const q = typeof filters.q === 'string' ? filters.q.replace(/\s+/g, ' ').trim().slice(0, LIMITS.search) : '';
  if (q) {
    const like = p(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(t.number ILIKE ${like} OR t.title ILIKE ${like} OR t.description ILIKE ${like}${manager ? ` OR t.creator_name ILIKE ${like}` : ''})`);
  }
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 100, 1), 200);
  const { rows } = await db.query(
    `SELECT t.*, (SELECT count(*) FROM ticket_comments c WHERE c.ticket_id = t.id) AS comment_count
     FROM tickets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit}`, params);
  return { tickets: rows.map((t) => publicTicket(t, manager)), manager, scope };
}

/** One ticket with comments, activity and (managers) the WhatsApp notice state. */
export async function getTicket(number, session) {
  await ensureTicketsSchema();
  const db = getPool();
  const manager = await isTicketManager(session, db);
  const t = await visibleTicket(db, number, session, { manager });
  const [{ rows: comments }, { rows: events }, { rows: notes }] = await Promise.all([
    db.query('SELECT id, author_name, body, created_at FROM ticket_comments WHERE ticket_id = $1 ORDER BY id', [t.id]),
    db.query('SELECT id, event_type, actor_name, at, metadata FROM ticket_events WHERE ticket_id = $1 ORDER BY id', [t.id]),
    manager ? db.query('SELECT kind, status, attempts, last_error, last_attempt_at, submitted_at FROM ticket_notifications WHERE ticket_id = $1 ORDER BY id', [t.id]) : { rows: [] },
  ]);
  return {
    ticket: publicTicket(t, manager), manager,
    comments: comments.map((c) => ({ id: Number(c.id), author_name: c.author_name, body: c.body, created_at: c.created_at })),
    events: events.map((e) => ({ id: Number(e.id), type: e.event_type, actor_name: e.actor_name, at: e.at, metadata: e.metadata })),
    ...(manager ? { notifications: notes } : {}),
  };
}

/* ------------------------------------------------------------------ change */

export async function addComment(number, input, session) {
  await ensureTicketsSchema();
  const body = textField(input?.body, 'body', 'Comment', LIMITS.comment, { multiline: true });
  return inTransaction(async (client) => {
    const manager = await isTicketManager(session, client);
    const t = await visibleTicket(client, number, session, { lock: true, manager });
    const name = await memberName(client, session.phone);
    const { rows } = await client.query(
      'INSERT INTO ticket_comments (ticket_id, author_phone, author_name, body) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
      [t.id, session.phone, name, body]);
    await client.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
    await logTicketEvent(client, t.id, 'commented', { phone: session.phone, name }, { comment_id: Number(rows[0].id) });
    return { id: Number(rows[0].id), author_name: name, body, created_at: rows[0].created_at };
  });
}

/** Locks a ticket a MANAGER changes: 404 if they could not see it, 403 if they can see it but may not manage it, 409 if stale. */
async function managedTicket(client, number, session, version) {
  const manager = await isTicketManager(session, client);
  const t = await visibleTicket(client, number, session, { lock: true, manager });
  if (!manager) throw bad('Only the ticket owner or an admin can change this.', 403);
  if (version === undefined || version === null || version === '') throw bad('Reload the ticket and try again.', 400, { field: 'version' });
  if (Number(version) !== t.version) {
    throw bad('Someone changed this ticket while you had it open. Reload to see their change.', 409, { conflict: true });
  }
  return t;
}

export async function setTicketStatus(number, input, session) {
  await ensureTicketsSchema();
  const status = oneOfField(input?.status, STATUSES, 'status', 'Status');
  return inTransaction(async (client) => {
    const t = await managedTicket(client, number, session, input?.version);
    if (t.status === status) return { changed: false, ticket: publicTicket(t, true) };
    const { rows } = await client.query(
      `UPDATE tickets SET status = $2, version = version + 1, updated_at = now(),
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $2 = 'closed' THEN resolved_at ELSE NULL END,
         closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END
       WHERE id = $1 RETURNING *`, [t.id, status]);
    const name = await memberName(client, session.phone);
    await logTicketEvent(client, t.id, 'status_changed', { phone: session.phone, name }, { from: t.status, to: status });
    return { changed: true, ticket: publicTicket(rows[0], true) };
  });
}

export async function assignTicket(number, input, session) {
  await ensureTicketsSchema();
  if (typeof input?.assignee !== 'string' || !input.assignee) throw bad('Choose who the ticket goes to.', 400, { field: 'assignee' });
  return inTransaction(async (client) => {
    const t = await managedTicket(client, number, session, input?.version);
    const target = (await ticketManagers(client)).find((m) => m.key === input.assignee);
    if (!target) throw bad('Tickets can only go to the ticket owner or an admin.', 400, { field: 'assignee' });
    if (target.phone === t.assignee_phone) return { changed: false, ticket: publicTicket(t, true) };
    const { rows } = await client.query(
      'UPDATE tickets SET assignee_phone = $2, assignee_name = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
      [t.id, target.phone, target.name]);
    const name = await memberName(client, session.phone);
    await logTicketEvent(client, t.id, 'assigned', { phone: session.phone, name }, { from: t.assignee_name, to: target.name });
    return { changed: true, ticket: publicTicket(rows[0], true) };
  });
}

/* ------------------------------------------------------------------ WhatsApp */

const appUrl = () => String(process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const TICKET_ALERT_MAX = 900;

/**
 * The notice's single template variable. One line (a WhatsApp template parameter may not carry new lines, tabs or
 * runs of spaces), at most TICKET_ALERT_MAX characters: number, priority, category, who raised it, title, a summary
 * of the description, and the ticket's link when the app's address is configured (APP_BASE_URL).
 */
export function ticketAlertText(t) {
  const url = appUrl();
  const link = url ? ` | ${url}/tickets?open=${t.number}` : '';
  const head = `New ticket ${t.number} | ${PRIORITIES[t.priority]} priority | ${CATEGORIES[t.category]} | From ${clip(oneLine(t.creator_name), 60)} | ${clip(oneLine(t.title), 160)}`;
  const room = TICKET_ALERT_MAX - head.length - link.length - 3;
  const summary = room > 20 ? ` | ${clip(oneLine(t.description), room)}` : '';
  return `${head}${summary}${link}`;
}

const maskPhone = (p) => (p ? `…${String(p).slice(-4)}` : '—');
/** An error message safe to store and log: no auth token, no full recipient number. */
function scrub(message, phone) {
  let s = String(message || 'Unknown error').slice(0, 500);
  const token = process.env.ELEVENZA_AUTH_TOKEN;
  if (token && token.length >= 4) s = s.split(token).join('[token]');
  for (const p of [phone, phone && String(phone).slice(-10)].filter((x) => x && x.length >= 6)) s = s.split(p).join(maskPhone(phone));
  // Any other phone-like run of digits (spaced, dashed, +91…) the provider may echo.
  return s.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => (m.replace(/\D/g, '').length >= 10 ? maskPhone(m.replace(/\D/g, '')) : m));
}

/**
 * Sends (or re-sends) one notice. The row is claimed atomically (pending/failed/skipped → sending, attempts + 1), so two
 * callers can never both send it; a notice already submitted is never sent again.
 *   submitted    11za accepted the send (its API said so — not a read receipt)
 *   unconfirmed  11za answered 200 without a readable confirmation: not retried automatically (it may have gone)
 *   failed       11za refused or could not be reached; the error is kept (scrubbed); retry is allowed
 *   skipped      not sent: WhatsApp or the ticket template is not configured, or the number is unusable; retry allowed
 * `retryStale`: a manager's retry may also take a row left "sending" for STALE_SENDING_MINUTES (a crash mid-send) —
 * it may then reach Janvi twice; that is the only path that can.
 */
export async function deliverTicketNotification(notificationId, { retryStale = false, retryUnconfirmed = false } = {}) {
  await ensureTicketsSchema();
  const db = getPool();
  const claimable = ["'pending'", "'failed'", "'skipped'", ...(retryUnconfirmed ? ["'unconfirmed'"] : [])].join(',');
  const { rows } = await db.query(
    `UPDATE ticket_notifications n SET status = 'sending', attempts = attempts + 1, last_attempt_at = now()
     WHERE n.id = $1 AND (n.status IN (${claimable})
       OR ($2 AND n.status = 'sending' AND n.last_attempt_at < now() - interval '${STALE_SENDING_MINUTES} minutes'))
     RETURNING n.*, (SELECT row_to_json(t) FROM tickets t WHERE t.id = n.ticket_id) AS ticket,
       (SELECT u.name FROM allowed_users u WHERE u.phone = n.recipient_phone) AS recipient_name`, [notificationId, retryStale]);
  if (!rows.length) {
    const { rows: cur } = await db.query('SELECT status FROM ticket_notifications WHERE id = $1', [notificationId]);
    return { sent: false, status: cur[0]?.status ?? null, reason: cur.length ? 'not due for sending' : 'no such notification' };
  }
  const n = rows[0];
  const finish = async (status, error = null) => {
    await db.query(`UPDATE ticket_notifications SET status = $2, last_error = $3, submitted_at = CASE WHEN $2 = 'submitted' THEN now() ELSE submitted_at END WHERE id = $1`,
      [n.id, status, error]);
    return { sent: status === 'submitted' || status === 'unconfirmed', status, error };
  };
  const phone = normalisePhone(n.recipient_phone);
  if (!phone) return finish('skipped', "The ticket owner's member number is not a usable WhatsApp number.");
  let result;
  try {
    result = await sendTicketAlert(phone, ticketAlertText(n.ticket), n.recipient_name || 'Team');
  } catch (err) {
    const msg = scrub(err.message, phone);
    console.error(`Ticket ${n.ticket.number}: WhatsApp notice failed (attempt ${n.attempts}): ${msg}`);
    return finish('failed', msg);
  }
  if (!result?.delivered) return finish('skipped', scrub(result?.reason || 'Not sent.', phone));
  if (result.confirmed === false) return finish('unconfirmed', '11za answered without a readable confirmation; check before retrying.');
  return finish('submitted');
}

/**
 * Notices nobody sent: still "pending" a minute after their ticket was saved (the process stopped between the commit
 * and the send). Run at startup. Only "pending" — a notice left "sending" may have gone, and is a manager's call.
 */
export async function sendStrandedTicketNotifications({ olderThanSeconds = 60, limit = 50 } = {}) {
  await ensureTicketsSchema();
  const { rows } = await getPool().query(
    `SELECT id FROM ticket_notifications WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1) ORDER BY id LIMIT $2`,
    [olderThanSeconds, limit]);
  let sent = 0;
  for (const r of rows) if ((await deliverTicketNotification(Number(r.id)).catch(() => ({}))).sent) sent += 1;
  return { found: rows.length, sent };
}

/** The notice of a ticket, by ticket id (a replayed create uses it to send a notice still pending). */
export async function pendingNotificationOf(ticketId) {
  const { rows } = await getPool().query("SELECT id FROM ticket_notifications WHERE ticket_id = $1 AND kind = 'ticket_created' AND status = 'pending'", [ticketId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/** A manager's "send again" for a ticket's notice. Never creates a notice, never sends one already submitted. */
export async function retryTicketNotification(number, session) {
  await ensureTicketsSchema();
  const db = getPool();
  if (!(await isTicketManager(session, db))) {
    await visibleTicket(db, number, session, { manager: false });   // 404 for tickets they cannot see
    throw bad('Only the ticket owner or an admin can resend the notice.', 403);
  }
  const t = await visibleTicket(db, number, session, { manager: true });
  const { rows } = await db.query("SELECT id, status FROM ticket_notifications WHERE ticket_id = $1 AND kind = 'ticket_created'", [t.id]);
  if (!rows.length) throw bad('This ticket has no WhatsApp notice to resend.', 404);
  if (rows[0].status === 'submitted') return { sent: false, status: 'submitted', reason: 'Already sent.' };
  return deliverTicketNotification(Number(rows[0].id), { retryStale: true, retryUnconfirmed: true });
}

/** For tests only: removes the given test tickets and everything under them (events need the purge flag). */
export async function purgeTestTickets(ids) {
  if (!ids.length) return;
  await inTransaction(async (client) => {
    await client.query("SET LOCAL app.purge_tickets = 'on'");
    for (const table of ['ticket_notifications', 'ticket_comments', 'ticket_events']) await client.query(`DELETE FROM ${table} WHERE ticket_id = ANY($1)`, [ids]);
    await client.query('DELETE FROM tickets WHERE id = ANY($1)', [ids]);
  });
}
