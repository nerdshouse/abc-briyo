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

/** A "running" row older than this was cut off (a restart) and no longer blocks or counts as running. */
export const STALE_RUN_MS = 30 * 60000;
const STALE_RUN_SQL = `${STALE_RUN_MS / 60000} minutes`;

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

/** After each page: how far the run has got, and where the next page starts (null when there is none). */
export async function recordPageProgress(db, runId, { cursor, fetched }) {
  await db.query(`UPDATE order_imports SET rows_processed = $3, orders_in_file = $3, details = details || $2::jsonb WHERE id = $1`,
    [runId, JSON.stringify({ cursor }), fetched]);
}

/** Closes a run as failed, with its counts so far and the reason. Never throws (the original error matters more). */
export async function failRun(db, runId, { fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errorRows, reportedErrors, details }) {
  await db.query(`UPDATE order_imports SET status = 'failed', completed_at = now(), rows_processed = $2, orders_in_file = $2,
      orders_created = $3, orders_updated = $4, orders_unchanged = $5, items_created = $6, items_updated = $7,
      error_rows = $8, errors = $9, details = details || $10::jsonb WHERE id = $1`,
    [runId, fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errorRows, JSON.stringify(reportedErrors), JSON.stringify(details)]).catch(() => {});
}

/** Closes a run as 'completed' or 'partial' with its totals and the source's own details. */
export async function completeRun(db, runId, { partial, fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errors, reportedErrors, conflicts, unmappedLines, details }) {
  await db.query(
    `UPDATE order_imports SET status = $2, completed_at = now(), rows_processed = $3, orders_in_file = $3, orders_created = $4,
       orders_updated = $5, orders_unchanged = $6, items_created = $7, items_updated = $8, error_rows = $9, errors = $10,
       conflicts = $11, unmapped_lines = $12, details = details || $13::jsonb WHERE id = $1`,
    [runId, partial ? 'partial' : 'completed', fetched, created, updated, unchanged, itemsCreated, itemsUpdated, errors,
      JSON.stringify(reportedErrors), conflicts, unmappedLines, JSON.stringify(details)]);
}

/* ------------------------------------------------------------------ chains, one at a time per source */

/**
 * A runner for one source's runs (`kind`). One chain at a time in this process; across processes a recent
 * 'running' row also blocks. `isBusy` adds the source's own background work (e.g. its poll);
 * `runningIgnoredActors` are actors whose running rows never block (e.g. single-order webhook imports);
 * `chainIgnoredActors` are left out of the button's status (e.g. the poll and webhooks).
 */
export function createSyncRunner({ kind, label, isBusy = () => false, runningIgnoredActors = [], chainIgnoredActors = [], busyMessage }) {
  let current = null;
  const busy = () => Boolean(current) || isBusy();
  const notActor = (list, from) => list.map((_, i) => `imported_by IS DISTINCT FROM $${from + i}`).join(' AND ') || 'true';

  /** Refuses (409) when a chain or the source's own background work is running here, or a recent run elsewhere. */
  async function assertNoRunning(db = getPool()) {
    const refuse = () => bad(busyMessage, 409, { syncRunning: true });
    if (busy()) throw refuse();
    const { rows } = await db.query(
      `SELECT 1 FROM order_imports WHERE kind = $1 AND status = 'running' AND ${notActor(runningIgnoredActors, 2)}
         AND started_at > now() - interval '${STALE_RUN_SQL}' LIMIT 1`, [kind, ...runningIgnoredActors]);
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
      || (tail.status === 'running' && Date.now() - new Date(tail.started_at).getTime() > STALE_RUN_MS)) ? Number(tail.id) : null;
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
    const state = current || last.status === 'running' ? 'running' : last.status === 'completed' ? 'completed' : last.status === 'failed' ? 'failed' : 'partial';
    return {
      state, mode: rows[0].details?.window?.mode || null, runs: rows.length, startedAt: rows[0].started_at, completedAt: state === 'completed' ? last.completed_at : null,
      durationMs: last.completed_at ? new Date(last.completed_at) - new Date(rows[0].started_at) : null,
      fetched: sum('rows_processed'), created: sum('orders_created'), updated: sum('orders_updated'), unchanged: sum('orders_unchanged'),
      conflicts: sum('conflicts'), unmappedLines: sum('unmapped_lines'), errors: sum('error_rows'),
      externalCreated: ext('created'), externalUpdated: ext('updated'), externalCancelled: ext('cancelled'),
      failure: state === 'failed' ? (last.details?.failure || null) : null,
    };
  }

  return { kind, busy, assertNoRunning, chain, resumableTail, launch, status };
}
