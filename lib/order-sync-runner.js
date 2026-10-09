import { getPool } from './db.js';

/**
 * The source-independent part of an order sync (Shopify today; Amazon later): the run lifecycle in
 * `order_imports`, incremental windows with a fixed upper watermark, when the checkpoint may move, chains of
 * resumed runs, and one-at-a-time per source. What to fetch, how to map it and how to write it stay with the
 * source (lib/shopify-orders.js).
 *
 * A run is one `order_imports` row (kind e.g. 'shopify_sync'): 'running' → 'completed' | 'partial' | 'failed'.
 * details.window is the window it covers, details.cursor the next page to read, details.resumed_from the run it
 * continues — a chain. A partial run ends with a cursor and the next run of the chain continues from it.
 */
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/**
 * A "running" row with no sign of life for this long was cut off (a restart, or a process that stopped answering)
 * and no longer blocks or counts as running. "Sign of life" is the run's heartbeat (details.heartbeat_at, written
 * before every request and after every page) or, for a row that never wrote one, its start. A source whose every
 * request is bounded can pass a shorter `staleMs` (lib/shopify-orders.js: requests time out after 60 s).
 */
export const STALE_RUN_MS = 30 * 60000;
/** SQL for the moment a run last showed progress. */
export const LAST_SIGN_OF_LIFE_SQL = `coalesce((details->>'heartbeat_at')::timestamptz, started_at)`;
const lastSignOfLife = (r) => new Date(r.details?.heartbeat_at || r.started_at).getTime();
/** True when a 'running' row has shown no progress for `staleMs`. */
export const isStaleRun = (r, staleMs = STALE_RUN_MS, now = Date.now()) => r?.status === 'running' && now - lastSignOfLife(r) > staleMs;

/* ------------------------------------------------------------------ windows and checkpoints */

/**
 * The window of an incremental run: from the last checkpoint less `overlapMs` (a source's index can lag a write;
 * re-reading is idempotent) up to `now`, the fixed upper watermark taken once at the start. A change made while
 * the run pages through falls after the watermark and belongs to the next run, never skipped.
 */
export function incrementalWindow(checkpointIso, now, overlapMs) {
  return { mode: 'incremental', since: new Date(new Date(checkpointIso).getTime() - overlapMs).toISOString(), until: now.toISOString() };
}

/**
 * The checkpoint a finished run may record, or null when it may not move: a partial run has not covered its
 * window, and a single-order run ('order') says nothing about other orders. An incremental chain moves it to its
 * watermark; a full-history chain to the time it started; any other window to the run's own start.
 */
export function checkpointAfter(win, { partial, startedAt }) {
  if (partial || win.mode === 'order') return null;
  return win.until || win.chain_started_at || startedAt.toISOString();
}

/* ------------------------------------------------------------------ run lifecycle (order_imports) */

/** The run a resumed run continues: it must exist, be of `kind`, and still have a window and a cursor. */
export async function resumableRun(db, kind, runId) {
  const { rows: [prev] } = await db.query(`SELECT id, details FROM order_imports WHERE id = $1 AND kind = $2`, [runId, kind]);
  if (!prev?.details?.cursor || !prev.details.window) throw bad('That sync cannot be continued.');
  return { id: Number(prev.id), window: prev.details.window, cursor: prev.details.cursor };
}

/** Opens a run ('running'). A resumed run records its starting cursor at once, so a failure keeps its place. */
export async function openRun(db, { channel, kind, actor, filename, window, resumedFrom = null, cursor = null }) {
  const { rows: [r] } = await db.query(
    `INSERT INTO order_imports (channel, kind, status, started_at, imported_by, filename, rows_processed, orders_in_file, orders_created,
       orders_updated, orders_unchanged, items_created, items_updated, promotion_rows, duplicate_rows, error_rows, details)
     VALUES ($1, $2, 'running', now(), $3, $4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $5) RETURNING id`,
    [channel, kind, actor, filename, JSON.stringify({ window, resumed_from: resumedFrom, ...(cursor ? { cursor } : {}) })]);
  return Number(r.id);
}

/**
 * After each page: how far the run has got, where the next page starts (null when there is none) and, when given,
 * the orders written so far (so a run that never finishes still shows what it saved). Also a heartbeat.
 */
export async function recordPageProgress(db, runId, { cursor, fetched, created = null, updated = null, unchanged = null, pages = null }) {
  await db.query(`UPDATE order_imports SET rows_processed = $3, orders_in_file = $3,
      orders_created = coalesce($4, orders_created), orders_updated = coalesce($5, orders_updated), orders_unchanged = coalesce($6, orders_unchanged),
      details = details || $2::jsonb || jsonb_build_object('heartbeat_at', now()) WHERE id = $1`,
  [runId, JSON.stringify({ cursor, ...(pages === null ? {} : { pages }) }), fetched, created, updated, unchanged]);
}

/**
 * The run is alive: records the heartbeat and what it is doing (`progress`: phase, retries, a rate-limit wait —
 * never a cursor or order data), and reads back whether someone asked it to stop (from any process).
 * Returns { cancel: { by, at } | null, lost } — lost when the row is no longer 'running' (someone marked it
 * interrupted): the run must stop and must not record a result.
 */
export async function heartbeat(db, runId, progress = {}) {
  const { rows: [r] } = await db.query(
    `UPDATE order_imports SET details = details || jsonb_build_object('heartbeat_at', now(), 'progress', $2::jsonb)
      WHERE id = $1 AND status = 'running' RETURNING details->'cancel_requested' AS cancel`, [runId, JSON.stringify(progress)]);
  if (!r) return { cancel: null, lost: true };
  return { cancel: r.cancel || null, lost: false };
}

/** Asks a running run to stop, through its row, so the process running it sees it at its next heartbeat. Idempotent. */
export async function requestCancel(db, runId, { actor }) {
  const { rowCount } = await db.query(
    `UPDATE order_imports SET details = details || jsonb_build_object('cancel_requested', jsonb_build_object('by', $2::text, 'at', now()))
      WHERE id = $1 AND status = 'running' AND NOT (details ? 'cancel_requested')`, [runId, actor]);
  return rowCount > 0;
}

/** Closes a run as failed, with its counts so far and the reason. Never throws (the original error matters more). */
export async function failRun(db, runId, { fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errorRows, reportedErrors, details }) {
  await db.query(`UPDATE order_imports SET status = 'failed', completed_at = now(), rows_processed = $2, orders_in_file = $2,
      orders_created = $3, orders_updated = $4, orders_unchanged = $5, items_created = $6, items_updated = $7,
      error_rows = $8, errors = $9, details = details || $10::jsonb WHERE id = $1 AND status = 'running'`,
    [runId, fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errorRows, JSON.stringify(reportedErrors), JSON.stringify(details)]).catch(() => {});
}

/**
 * Closes a run as 'completed' or 'partial' with its totals and the source's own details. Returns false when the row
 * was no longer 'running' (marked interrupted meanwhile): the caller must then not move its checkpoint.
 */
export async function completeRun(db, runId, { partial, fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errors, reportedErrors, conflicts, unmappedLines, details }) {
  const { rowCount } = await db.query(
    `UPDATE order_imports SET status = $2, completed_at = now(), rows_processed = $3, orders_in_file = $3, orders_created = $4,
       orders_updated = $5, orders_unchanged = $6, items_created = $7, items_updated = $8, error_rows = $9, errors = $10,
       conflicts = $11, unmapped_lines = $12, details = details || $13::jsonb WHERE id = $1 AND status = 'running'`,
    [runId, partial ? 'partial' : 'completed', fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errors,
      JSON.stringify(reportedErrors), conflicts, unmappedLines, JSON.stringify(details)]);
  return rowCount > 0;
}

/* ------------------------------------------------------------------ chains, one at a time per source */

/**
 * A runner for one source's runs (`kind`). One chain at a time in this process; across processes a recent
 * 'running' row also blocks. `isBusy` adds the source's own background work (e.g. its poll);
 * `runningIgnoredActors` are actors whose running rows never block (e.g. single-order webhook imports);
 * `chainIgnoredActors` are left out of the button's status (e.g. the poll and webhooks).
 */
export function createSyncRunner({ kind, label, isBusy = () => false, runningIgnoredActors = [], chainIgnoredActors = [], busyMessage, staleMs = STALE_RUN_MS }) {
  const staleSql = `${Math.round(staleMs / 1000)} seconds`;
  let current = null;
  const busy = () => Boolean(current) || isBusy();
  const notActor = (list, from) => list.map((_, i) => `imported_by IS DISTINCT FROM $${from + i}`).join(' AND ') || 'true';

  /** Refuses (409) when a chain or the source's own background work is running here, or a recent run elsewhere. */
  async function assertNoRunning(db = getPool()) {
    const refuse = () => bad(busyMessage, 409, { syncRunning: true });
    if (busy()) throw refuse();
    const { rows } = await db.query(
      `SELECT 1 FROM order_imports WHERE kind = $1 AND status = 'running' AND ${notActor(runningIgnoredActors, 2)}
         AND ${LAST_SIGN_OF_LIFE_SQL} > now() - interval '${staleSql}' LIMIT 1`, [kind, ...runningIgnoredActors]);
    if (rows.length) throw refuse();
  }

  /** The latest run of one of `modes` (by its window), and the chain of resumed runs it belongs to (oldest first). */
  async function chain(db, modes) {
    const { rows: [last] } = await db.query(
      `SELECT id FROM order_imports WHERE kind = $1 AND details->'window'->>'mode' = ANY($2) AND ${notActor(chainIgnoredActors, 3)}
       ORDER BY id DESC LIMIT 1`, [kind, modes, ...chainIgnoredActors]);
    if (!last) return [];
    const out = [];
    let id = Number(last.id);
    while (id && out.length < 100) {
      const { rows: [r] } = await db.query(
        `SELECT id, status, started_at, completed_at, imported_by, rows_processed, orders_created, orders_updated, orders_unchanged, conflicts,
                unmapped_lines, error_rows, errors, details FROM order_imports WHERE id = $1`, [id]);
      if (!r) break;
      out.unshift(r);
      id = Number(r.details?.resumed_from) || null;
    }
    return out;
  }

  /** The run a new chain should continue instead of starting over: the tail left partial, failed, or cut off. */
  function resumableTail(chainRows) {
    const tail = chainRows[chainRows.length - 1];
    return tail && tail.details?.cursor && (['partial', 'failed'].includes(tail.status)
      || isStaleRun(tail, staleMs)) ? Number(tail.id) : null;
  }

  /**
   * Closes this source's 'running' rows that have shown no progress for `staleMs` as failed + interrupted, with who
   * noticed and the last sign of life. They keep their cursor, so the next run of their chain continues from their last
   * saved page; their checkpoint never moved. Rows of this process's own running chain are never touched.
   * Returns the ids closed.
   */
  async function markInterrupted(db, { actor = null, ids = null } = {}) {
    if (current) return [];
    const { rows } = await db.query(
      `UPDATE order_imports SET status = 'failed', completed_at = now(), details = details || jsonb_build_object(
          'interrupted', true, 'interrupted_by', $2::text, 'interrupted_at', now(), 'last_progress_at', ${LAST_SIGN_OF_LIFE_SQL},
          'failure', 'Interrupted: no progress since ' || to_char(${LAST_SIGN_OF_LIFE_SQL} AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI') || ' IST (the server restarted or the run stopped responding). Orders saved before then are kept; the next sync continues from its last saved page.')
        WHERE kind = $1 AND status = 'running' AND ${LAST_SIGN_OF_LIFE_SQL} < now() - interval '${staleSql}'
          AND ($3::bigint[] IS NULL OR id = ANY($3)) RETURNING id`, [kind, actor, ids]);
    for (const r of rows) console.warn(`${label} sync run ${r.id} marked interrupted${actor ? ` (noticed by ${actor})` : ''}`);
    return rows.map((r) => Number(r.id));
  }

  /**
   * Runs a chain in the background: `runOnce({ resumeRunId })` for the first run (resuming `resumeRunId` if
   * given), then again with each partial run's id until one is not partial. The caller has already called
   * assertNoRunning. Returns the chain's promise; failures are logged with `failLabel`.
   */
  function launch({ resumeRunId = null, runOnce, failLabel }) {
    const done = (async () => {
      let r = await runOnce({ resumeRunId });
      while (r.summary.partial && r.runId) r = await runOnce({ resumeRunId: r.runId });
      return r;
    })();
    current = done;
    done.catch((err) => console.error(`${label} ${failLabel} failed:`, String(err.message).slice(0, 200)))
      .finally(() => { if (current === done) current = null; });
    return done;
  }

  /** Totals across the latest chain of `modes`, and its state, for the source's button. */
  async function status(modes) {
    const rows = await chain(getPool(), modes);
    if (!rows.length) return { state: current ? 'running' : 'never', runs: 0 };
    const last = rows[rows.length - 1];
    const sum = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const ext = (k) => rows.reduce((n, r) => n + (Number(r.details?.external_shipments?.[k]) || 0), 0);
    // A 'running' row nobody is advancing (no heartbeat for staleMs, not this process's chain) is shown as interrupted,
    // never as running: it is what a restart in the middle of a run leaves behind.
    const interrupted = !current && (isStaleRun(last, staleMs) || (last.status === 'failed' && last.details?.interrupted));
    const state = interrupted ? 'interrupted' : current || last.status === 'running' ? 'running' : last.status === 'completed' ? 'completed' : last.status === 'failed' ? 'failed' : 'partial';
    const p = last.details?.progress || {};
    return {
      state, mode: rows[0].details?.window?.mode || null, runs: rows.length, startedAt: rows[0].started_at, completedAt: state === 'completed' ? last.completed_at : null,
      durationMs: last.completed_at ? new Date(last.completed_at) - new Date(rows[0].started_at) : null,
      fetched: sum('rows_processed'), created: sum('orders_created'), updated: sum('orders_updated'), unchanged: sum('orders_unchanged'),
      conflicts: sum('conflicts'), unmappedLines: sum('unmapped_lines'), errors: sum('error_rows'),
      externalCreated: ext('created'), externalUpdated: ext('updated'), externalCancelled: ext('cancelled'),
      failure: state === 'failed' || state === 'interrupted' ? (last.details?.failure || null) : null,
      runId: Number(last.id), lastProgressAt: last.details?.heartbeat_at || last.started_at,
      // What the run is doing now (only while running): fetching, applying a page, or waiting for a rate limit.
      phase: state === 'running' ? (p.phase || null) : null, waitingUntil: state === 'running' ? (p.waiting_until || null) : null,
      pages: rows.reduce((n, r) => n + (Number(r.details?.pages) || 0), 0), retries: Number(p.retries) || 0,
      cancelRequested: state === 'running' && Boolean(last.details?.cancel_requested),
    };
  }

  return { kind, busy, assertNoRunning, chain, resumableTail, launch, status, markInterrupted, staleMs };
}
