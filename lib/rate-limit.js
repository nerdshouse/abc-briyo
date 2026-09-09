/**
 * Per-IP sliding window, in memory.
 *
 * The OTP endpoint is unauthenticated and the only existing throttle is
 * per-phone, so someone rotating numbers can burn 11za credits and get the
 * WhatsApp sender flagged — that's the real damage, not compute.
 *
 * In-memory is the right call here rather than a wrong one: the app runs as a
 * single Render instance, so a Redis dependency would add an outage mode to
 * protect against nothing. If it ever scales out, this becomes best-effort
 * rather than incorrect — the per-phone limit in lib/otp.js is the durable one.
 */
const buckets = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    buckets.set(key, hits);
    const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    return { ok: false, retryAfter };
  }

  hits.push(now);
  buckets.set(key, hits);

  // Cheap opportunistic sweep — without it the map grows unbounded on a
  // long-running instance.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
    }
  }
  return { ok: true, remaining: limit - hits.length };
}

export function _reset() { buckets.clear(); }
