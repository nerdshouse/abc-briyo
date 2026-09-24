/**
 * Which environment is this, and is it talking to the right database?
 *
 * Two independent signals must agree before anything touches Postgres:
 *
 *   APP_ENV            what the process says it is: production | development | test
 *   app_environment    a one-row table inside the database saying what the
 *                      database is. It travels with the data, so a connection
 *                      string pasted into the wrong .env is still caught.
 *
 * Tagging an untagged database:
 *   production   only on Render or with NODE_ENV=production — a laptop can't
 *                claim to be production.
 *   dev / test   only if the database holds no business data, so an old
 *                production copy can never be adopted as a scratch database.
 *
 * Test cleanup and seeding call the stricter helpers below, which re-read the
 * marker inside their own transaction.
 */

export const APP_ENVS = ['production', 'development', 'test'];

export class EnvironmentError extends Error {}

export const onRender = () => Boolean(process.env.RENDER);
export const nodeEnvProduction = () => process.env.NODE_ENV === 'production';

/** APP_ENV, validated. Required whenever a database is configured. */
export function appEnv() {
  const v = (process.env.APP_ENV || '').trim();
  if (!v) {
    throw new EnvironmentError(
      'APP_ENV is not set. Set APP_ENV=production on Render, APP_ENV=development locally.');
  }
  if (!APP_ENVS.includes(v)) throw new EnvironmentError(`APP_ENV="${v}" — expected one of ${APP_ENVS.join(', ')}.`);
  if (v !== 'production' && (onRender() || nodeEnvProduction())) {
    throw new EnvironmentError(`APP_ENV=${v} on a production host (Render / NODE_ENV=production). Refusing.`);
  }
  return v;
}

const MARKER_DDL = `
  CREATE TABLE IF NOT EXISTS app_environment (
    singleton  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    env        TEXT NOT NULL CHECK (env IN ('production', 'development', 'test')),
    tagged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    tagged_by  TEXT
  )`;

/** The database's own label, or null if it has none (or no marker table). */
export async function readMarker(client) {
  const { rows } = await client.query(`SELECT to_regclass('app_environment') AS t`);
  if (!rows[0].t) return null;
  const r = await client.query('SELECT env FROM app_environment');
  return r.rows[0]?.env ?? null;
}

async function holdsBusinessData(client) {
  for (const table of ['abandoned_carts', 'orders', 'allowed_users']) {
    const { rows } = await client.query('SELECT to_regclass($1) AS t', [table]);
    if (!rows[0].t) continue;
    const c = await client.query(`SELECT EXISTS (SELECT 1 FROM ${table}) AS any`);
    // A dev database seeds allowed_users from ALLOWED_PHONES on first boot, so
    // only carts and orders count as "real data" for that table's sake.
    if (c.rows[0].any && table !== 'allowed_users') return table;
  }
  return null;
}

/**
 * Checks (and on first run, sets) the database's label against APP_ENV.
 * Throws EnvironmentError on any mismatch. Returns the agreed environment.
 */
export async function assertDatabaseEnvironment(pool, expected = appEnv()) {
  const client = await pool.connect();
  try {
    let marker = await readMarker(client);
    if (!marker) {
      if (expected === 'production' && !onRender() && !nodeEnvProduction()) {
        throw new EnvironmentError(
          'This database has no environment label, and only the production host may label a database '
          + '"production". Refusing to run.');
      }
      if (expected !== 'production') {
        const busy = await holdsBusinessData(client);
        if (busy) {
          throw new EnvironmentError(
            `This database has no environment label but already holds data (${busy}). It may be production. `
            + `Refusing to label it "${expected}". Point ${expected === 'test' ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} `
            + 'at an empty database.');
        }
      }
      await client.query(MARKER_DDL);
      await client.query(
        `INSERT INTO app_environment (env, tagged_by) VALUES ($1, $2) ON CONFLICT (singleton) DO NOTHING`,
        [expected, `${expected} process${onRender() ? ' on Render' : ''}`]);
      marker = await readMarker(client);
      if (marker === expected) console.log(`Database labelled "${expected}".`);
    }
    if (marker !== expected) {
      throw new EnvironmentError(
        `APP_ENV=${expected}, but this database is labelled "${marker}". Refusing to run — `
        + (marker === 'production'
          ? 'a non-production process must never connect to the production database.'
          : 'check DATABASE_URL.'));
    }
    return marker;
  } finally {
    client.release();
  }
}

/**
 * For destructive test/seed helpers, called with the transaction's own client:
 * the marker is re-read inside the transaction that does the work.
 */
export async function assertMarkerIn(client, allowed, what) {
  const marker = await readMarker(client);
  if (!allowed.includes(marker)) {
    throw new EnvironmentError(
      `${what} refused: this database is labelled "${marker ?? 'nothing'}"; allowed only on ${allowed.join(' / ')}.`);
  }
  return marker;
}
