/**
 * Keeps the free Render instance awake.
 *
 * Render spins a free service down after 15 minutes without *inbound* traffic,
 * and waking it takes up to a minute — long enough for a GoKwik delivery to time
 * out. Rather than depend on an external cron account, the service requests its
 * own public URL on an interval; that request arrives through Render's router
 * and counts as inbound traffic.
 *
 * Limitation worth knowing: this can only keep an awake instance awake. It can
 * never wake a sleeping one, because a sleeping instance isn't running to fire
 * the timer. That's fine while the interval stays below the 15-minute idle
 * threshold, but it means an external pinger is still the more robust option.
 */

const DEFAULT_INTERVAL_MIN = 10;

export function startKeepAlive() {
  if (process.env.KEEPALIVE_ENABLED === 'false') {
    console.log('Keep-alive: disabled (KEEPALIVE_ENABLED=false)');
    return null;
  }

  // Render injects RENDER_EXTERNAL_URL automatically.
  const base = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) {
    console.log('Keep-alive: off (no RENDER_EXTERNAL_URL or KEEPALIVE_URL — expected when running locally)');
    return null;
  }

  const minutes = Number(process.env.KEEPALIVE_MINUTES || DEFAULT_INTERVAL_MIN);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes >= 15) {
    console.warn(`Keep-alive: KEEPALIVE_MINUTES=${process.env.KEEPALIVE_MINUTES} is invalid; must be >0 and <15. Using ${DEFAULT_INTERVAL_MIN}.`);
  }
  const everyMs = (Number.isFinite(minutes) && minutes > 0 && minutes < 15 ? minutes : DEFAULT_INTERVAL_MIN) * 60_000;
  const url = `${base.replace(/\/+$/, '')}/healthz`;

  let consecutiveFailures = 0;
  const tick = async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (consecutiveFailures > 0) {
        console.log(`Keep-alive: recovered after ${consecutiveFailures} failure(s)`);
        consecutiveFailures = 0;
      }
    } catch (err) {
      consecutiveFailures += 1;
      // Log the first few, then stay quiet — a permanently wrong URL shouldn't
      // fill the log at six lines an hour, forever.
      if (consecutiveFailures <= 3) {
        console.warn(`Keep-alive ping failed (${consecutiveFailures}): ${err.message} — ${url}`);
      }
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();   // never hold the process open on shutdown
  console.log(`Keep-alive: pinging ${url} every ${everyMs / 60000} min`);
  return timer;
}
