import { sql } from '@vercel/postgres';

let initPromise = null;

/**
 * Creates the table on first use. Vercel serverless instances are short-lived,
 * so we memoise per-instance rather than relying on a migration step.
 * CREATE TABLE IF NOT EXISTS is safe to run concurrently from multiple lambdas.
 */
export function ensureSchema() {
  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS abandoned_carts (
          id            BIGSERIAL PRIMARY KEY,
          cart_id       TEXT,
          customer_name TEXT,
          phone         TEXT,
          email         TEXT,
          total_price   NUMERIC(12, 2),
          currency      TEXT,
          checkout_url  TEXT,
          item_count    INTEGER,
          abandoned_at  TIMESTAMPTZ,
          raw_payload   JSONB NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS abandoned_carts_created_at_idx
          ON abandoned_carts (created_at DESC)
      `;
    })().catch((err) => {
      // Let the next request retry instead of caching a failed init.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export { sql };
