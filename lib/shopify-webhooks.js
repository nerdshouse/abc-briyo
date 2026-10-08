import crypto from 'node:crypto';
import { getPool } from './db.js';
import { graphql, shopifyConfigured } from './shopify.js';
import { runShopifySync } from './shopify-orders.js';

/**
 * Shopify orders/create webhook — the fast path into the existing order import.
 *
 *   POST /api/webhook/shopify/orders-create
 *     → HMAC-SHA256 of the raw body with SHOPIFY_CLIENT_SECRET (X-Shopify-Hmac-Sha256), shop and topic checked;
 *     → the delivery is stored first (shopify_webhook_deliveries, keyed by X-Shopify-Webhook-Id), then 200;
 *     → processed after the response: runShopifySync for that one order — the same mapping, duplicate
 *       hold-back, advisory lock, financial snapshot, attribution and commission as Sync now and the poll.
 *
 * Nothing from the webhook body is imported: only the order id is taken from it, and the order is read back
 * from the Admin API. A repeated delivery (same webhook id) is acknowledged and ignored. A delivery that fails,
 * or is cut off by a restart, is still in the table and is retried by the sweep (bounded); the 15-minute order
 * poll remains the reconciliation behind both. Never creates shipments, reservations or stock movements, and
 * stores no customer data (id, topic, shop and status only).
 */
const TOPIC = 'orders/create';
const MAX_ATTEMPTS = 5;
const STALE_CLAIM = '10 minutes';
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d{1,20}$/;

let schema = null;
export function ensureShopifyWebhookSchema() {
  if (!schema) {
    schema = getPool().query(`
      CREATE TABLE IF NOT EXISTS shopify_webhook_deliveries (
        webhook_id   TEXT PRIMARY KEY CHECK (length(webhook_id) BETWEEN 1 AND 200),
        topic        TEXT NOT NULL,
        shop         TEXT NOT NULL,
        order_gid    TEXT CHECK (order_gid IS NULL OR order_gid ~ '^gid://shopify/Order/[0-9]+$'),
        status       TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
        attempts     INTEGER NOT NULL DEFAULT 0,
        claimed_at   TIMESTAMPTZ,
        last_error   TEXT,
        run_id       BIGINT,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS shopify_webhook_deliveries_pending ON shopify_webhook_deliveries (received_at) WHERE status IN ('received', 'processing', 'failed');
    `).catch((err) => { schema = null; throw err; });
  }
  return schema;
}

const shopHost = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/** Shopify's webhook signature: base64 HMAC-SHA256 of the exact body bytes, compared in constant time. */
export function verifyWebhookHmac(rawBody, header, secret = process.env.SHOPIFY_CLIENT_SECRET) {
  if (!secret || typeof header !== 'string' || !header) return false;
  const mine = crypto.createHmac('sha256', secret).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8')).digest();
  let given;
  try { given = Buffer.from(header, 'base64'); } catch { return false; }
  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}

/**
 * Checks and records one delivery. Returns { status, body, deliveryId? } for the HTTP response; the caller then
 * processes `deliveryId` (when set) after responding. Invalid signatures are refused and nothing is stored.
 */
export async function receiveOrdersCreate({ rawBody, headers }) {
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  if (!verifyWebhookHmac(rawBody, h('x-shopify-hmac-sha256'))) return { status: 401, body: { ok: false, error: 'invalid signature' } };
  const shop = shopHost(h('x-shopify-shop-domain'));
  if (!shop || shop !== shopHost(process.env.SHOPIFY_STORE_DOMAIN)) return { status: 403, body: { ok: false, error: 'unknown shop' } };
  const topic = String(h('x-shopify-topic') || '');
  const webhookId = String(h('x-shopify-webhook-id') || '').trim().slice(0, 200);
  if (!webhookId) return { status: 400, body: { ok: false, error: 'missing webhook id' } };
  await ensureShopifyWebhookSchema();
  let gid = null;
  try { const b = JSON.parse(String(rawBody)); gid = b.admin_graphql_api_id || (b.id ? `gid://shopify/Order/${b.id}` : null); } catch { gid = null; }
  const usable = topic === TOPIC && ORDER_GID.test(String(gid || ''));
  const { rows } = await getPool().query(
    `INSERT INTO shopify_webhook_deliveries (webhook_id, topic, shop, order_gid, status, last_error)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
    [webhookId, topic.slice(0, 60), shop, usable ? gid : null, usable ? 'received' : 'ignored', usable ? null : 'not an orders/create delivery with an order id']);
  if (!rows.length) return { status: 200, body: { ok: true, duplicate: true } };
  return { status: 200, body: { ok: true }, deliveryId: usable ? webhookId : null };
}

/**
 * Imports the order behind one stored delivery through the existing sync. Safe to call more than once and
 * alongside the poll or a manual sync: the import itself is idempotent and serialised.
 */
export async function processWebhookDelivery(webhookId, { gql = graphql, backoffMs } = {}) {
  await ensureShopifyWebhookSchema();
  const db = getPool();
  // Claim it atomically: one worker at a time. A claim left by a process that died mid-import goes stale
  // after STALE_CLAIM and is picked up again; the import itself is idempotent either way.
  const { rows: [d] } = await db.query(
    `UPDATE shopify_webhook_deliveries SET status = 'processing', attempts = attempts + 1, claimed_at = now()
     WHERE webhook_id = $1 AND attempts < $2
       AND (status IN ('received', 'failed') OR (status = 'processing' AND claimed_at < now() - interval '${STALE_CLAIM}'))
     RETURNING order_gid, attempts`, [webhookId, MAX_ATTEMPTS]);
  if (!d) return { skipped: true };
  try {
    const r = await runShopifySync({ window: { mode: 'order', orderId: d.order_gid }, dryRun: false, actor: 'shopify-webhook', gql, ...(backoffMs === undefined ? {} : { backoffMs }) });
    await db.query(`UPDATE shopify_webhook_deliveries SET status = 'processed', processed_at = now(), last_error = NULL, run_id = $2 WHERE webhook_id = $1`, [webhookId, r.runId]);
    return { processed: true, runId: r.runId, summary: r.summary };
  } catch (err) {
    await db.query(`UPDATE shopify_webhook_deliveries SET status = 'failed', last_error = $2 WHERE webhook_id = $1`, [webhookId, String(err.message).slice(0, 300)]).catch(() => {});
    throw err;
  }
}

/** Retries deliveries left pending (a failure, or a restart before processing), oldest first, bounded. */
export async function processPendingWebhooks({ gql = graphql, olderThanMs = 60000, limit = 20, backoffMs } = {}) {
  await ensureShopifyWebhookSchema();
  const { rows } = await getPool().query(
    `SELECT webhook_id FROM shopify_webhook_deliveries
     WHERE attempts < $1 AND received_at <= now() - ($2 || ' milliseconds')::interval
       AND (status IN ('received', 'failed') OR (status = 'processing' AND claimed_at < now() - interval '${STALE_CLAIM}'))
     ORDER BY received_at LIMIT $3`, [MAX_ATTEMPTS, String(olderThanMs), limit]);
  let processed = 0; let failed = 0;
  for (const r of rows) {
    try { if ((await processWebhookDelivery(r.webhook_id, { gql, backoffMs })).processed) processed += 1; } catch { failed += 1; }
  }
  return { pending: rows.length, processed, failed };
}

/** Every 5 minutes: retry pending deliveries. Quiet unless something was retried. */
export function startShopifyWebhookSweep() {
  if (!shopifyConfigured() || !process.env.SHOPIFY_CLIENT_SECRET) return null;
  const tick = async () => {
    try {
      const r = await processPendingWebhooks();
      if (r.pending) console.log(`Shopify webhooks: retried ${r.pending} pending delivery(ies), ${r.processed} imported, ${r.failed} failed`);
    } catch (err) { console.error('Shopify webhook sweep failed:', String(err.message).slice(0, 200)); }
  };
  const timer = setInterval(tick, 5 * 60000);
  timer.unref?.();
  return timer;
}
