/**
 * HTTP retry/backoff for order-source API clients (Shopify today; Amazon later).
 *
 * Classification travels on the thrown Error as flags, never as an HTTP `status` property (routes treat
 * `err.status` as "a client error to show"):
 *   throttled  — the source asked us to slow down (HTTP 429, or its own rate-limit signal)
 *   transient  — a gateway error (502/503/504) or a connection that failed before any response
 *   neither    — permanent: any other HTTP error, authentication, malformed or domain errors
 *
 * withRetry() is the one retry loop:
 *   - throttled: retried while the overall attempt number is below `throttleAttempts`, waiting backoffMs × 2^attempt;
 *   - transient (and not throttled): at most `transientAttempts` tries in all, waiting backoffMs × 1, × 2, …;
 *   - anything else is thrown at once.
 * `attempt` counts every try, transient retries included — exactly the loop Shopify has always used.
 */
export const TRANSIENT_STATUSES = Object.freeze([502, 503, 504]);
export const isThrottleStatus = (status) => status === 429;
export const isTransientStatus = (status) => TRANSIENT_STATUSES.includes(status);

/** How a non-2xx HTTP status should be treated: 'throttled' | 'transient' | 'permanent'. */
export function classifyStatus(status) {
  if (isThrottleStatus(status)) return 'throttled';
  if (isTransientStatus(status)) return 'transient';
  return 'permanent';
}

/** Marks an error with its classification flags (only the ones that apply). */
export const markThrottled = (err) => Object.assign(err, { throttled: true });
export const markTransient = (err, transient = true) => Object.assign(err, { transient });

/**
 * A request that failed before any response (reset, refused, DNS, timeout): transient. `label` names the
 * service in the message, e.g. "Shopify could not be reached: ECONNRESET".
 */
export function connectionFailure(err, label) {
  const why = String(err?.cause?.code || err?.cause?.message || err?.message || 'connection failed').slice(0, 120);
  return markTransient(new Error(`${label} could not be reached: ${why}`));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn(attempt)` with the retry policy above. `onTransientRetry(n, max, err)` is called before the n-th
 * transient retry (for counting/logging); `wait` is injectable for tests.
 * A throttled error may carry `retryAfterMs` (the source's own hint, e.g. Amazon's rate-limit header): the wait is
 * then at least that, capped at `maxWaitMs`. An error without it (every Shopify error) waits exactly as above.
 */
export async function withRetry(fn, { backoffMs = 1000, throttleAttempts = 4, transientAttempts = 3, onTransientRetry = null, wait = sleep, maxWaitMs = 60000 } = {}) {
  let transientFailures = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err.throttled && attempt < throttleAttempts) {
        const base = backoffMs * 2 ** attempt;
        await wait(Number.isFinite(err.retryAfterMs) ? Math.min(Math.max(base, err.retryAfterMs), maxWaitMs) : base);
        continue;
      }
      if (err.transient && !err.throttled && transientFailures < transientAttempts - 1) {
        transientFailures += 1;
        if (onTransientRetry) onTransientRetry(transientFailures, transientAttempts - 1, err);
        await wait(backoffMs * 2 ** (transientFailures - 1));
        continue;
      }
      throw err;
    }
  }
}
