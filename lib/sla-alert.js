import { sendOpsAlert } from './whatsapp.js';
import { normalisePhone } from './otp.js';

/**
 * Hourly digest of carts nobody has called.
 *
 * One message per run, never one per cart — the point is a nudge, not a
 * notification storm. It also stays quiet when the count hasn't grown since the
 * last alert, so a backlog nobody is clearing doesn't re-alert every hour.
 */
const DEFAULT_INTERVAL_MIN = 60;

let lastAlertedCount = 0;

export function startSlaAlerts({ getStale, slaHours }) {
  if (process.env.SLA_ALERTS_ENABLED === 'false') {
    console.log('SLA alerts: disabled (SLA_ALERTS_ENABLED=false)');
    return null;
  }

  const opsPhone = normalisePhone(process.env.OPS_PHONE);
  if (!opsPhone) {
    console.log('SLA alerts: off (set OPS_PHONE to receive the stale-cart digest)');
    return null;
  }

  const threshold = Number(process.env.SLA_ALERT_THRESHOLD || 1);
  const everyMs = Number(process.env.SLA_ALERT_MINUTES || DEFAULT_INTERVAL_MIN) * 60_000;

  const tick = async () => {
    try {
      const stale = await getStale(slaHours);
      const count = Number(stale?.count ?? 0);

      if (count < threshold) {
        if (count === 0) lastAlertedCount = 0;   // backlog cleared, re-arm
        return;
      }
      // Only speak up when it has got worse since the last alert.
      if (count <= lastAlertedCount) return;

      const value = Math.round(Number(stale.value ?? 0));
      const text =
        `Cart Recovery Board: ${count} cart${count === 1 ? '' : 's'} ` +
        `still uncalled after ${slaHours}h (₹${value.toLocaleString('en-IN')} total). ` +
        `https://abc.briyo.xyz`;

      await sendOpsAlert(opsPhone, text);
      lastAlertedCount = count;
      console.log(`SLA alert sent: ${count} stale cart(s)`);
    } catch (err) {
      console.error('SLA alert check failed:', err.message);
    }
  };

  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  console.log(`SLA alerts: every ${everyMs / 60000} min to +${opsPhone} when >= ${threshold} cart(s) exceed ${slaHours}h`);
  return timer;
}

/** Exposed for tests. */
export function _resetAlertState() { lastAlertedCount = 0; }
