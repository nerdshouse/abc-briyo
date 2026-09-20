import { shopifyConfigured, fetchAbandonedCheckouts, authMode, apiVersionWarning } from './shopify.js';
import { importCarts, recordSystemEvent } from './db.js';
import { normalisePhone } from './otp.js';

/**
 * Polls Shopify for abandoned checkouts.
 *
 * Shopify has no abandoned-checkout webhook — the only checkout topics are
 * create/update/delete, and abandonment is a time-based judgement Shopify makes
 * itself — so this is a pull, not a push.
 *
 * Safe to run repeatedly: importCarts upserts on cart_id, so re-seeing the same
 * checkout updates its cart fields and never touches a call log. That also means
 * a missed run costs nothing; the next one catches up.
 */
const DEFAULT_MINUTES = 15;

let running = false;

export async function pollShopifyOnce({ assignedTo = null } = {}) {
  if (!shopifyConfigured()) return { skipped: 'not configured' };
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const carts = await fetchAbandonedCheckouts();
    if (!carts.length) return { fetched: 0, inserted: 0, updated: 0 };
    const result = await importCarts(carts, { source: 'shopify', assignedTo });
    await recordSystemEvent('last_shopify_poll', String(carts.length)).catch(() => {});
    return { fetched: carts.length, ...result };
  } finally {
    running = false;
  }
}

export function startShopifyPoll() {
  if (process.env.SHOPIFY_POLL_ENABLED === 'false') {
    console.log('Shopify poll: disabled (SHOPIFY_POLL_ENABLED=false)');
    return null;
  }
  if (!shopifyConfigured()) {
    console.log('Shopify poll: off (set SHOPIFY_STORE_DOMAIN + SHOPIFY_CLIENT_ID/SECRET to pull abandoned checkouts)');
    return null;
  }

  const minutes = Number(process.env.SHOPIFY_POLL_MINUTES || DEFAULT_MINUTES);
  const everyMs = Math.max(5, Number.isFinite(minutes) ? minutes : DEFAULT_MINUTES) * 60_000;
  const assignedTo = normalisePhone(process.env.IMPORT_DEFAULT_CALLER || '') || null;

  const tick = async () => {
    try {
      const r = await pollShopifyOnce({ assignedTo });
      if (r.skipped) return;
      if (r.inserted) console.log(`Shopify poll: ${r.inserted} new cart(s), ${r.updated} updated`);
    } catch (err) {
      // Never throw out of the timer — a bad token must not take the app down.
      console.error('Shopify poll failed:', err.message);
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  // A first pull shortly after boot, not immediately, so startup stays fast.
  setTimeout(tick, 20_000).unref?.();
  const warn = apiVersionWarning();
  if (warn) console.warn(`  WARNING: ${warn}`);
  console.log(`Shopify poll: every ${everyMs / 60000} min via ${authMode()}`);
  return timer;
}
