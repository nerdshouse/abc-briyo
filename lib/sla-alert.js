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
const DEFAULT_SILENCE_HOURS = 8;
const SILENCE_REALERT_MS = 6 * 3600 * 1000;

let lastAlertedCount = 0;
let lastSilenceAlertAt = 0;

/**
 * Has ingestion gone quiet?
 *
 * This is the failure that hides itself: if GoKwik stops sending, the stale-cart
 * backlog drains, the stale alert goes quiet, and the whole system looks exactly
 * like a team that has cleared its list. Nothing else would notice.
 *
 * Pure so it can be tested without sending a message. `lastAt` of null means we
 * have never received anything, which is not the same as silence — a brand-new
 * deployment should not alarm.
 */
export function isIngestSilent(lastAt, hours, now = Date.now()) {
  if (!lastAt) return false;
  const then = new Date(lastAt).getTime();
  if (Number.isNaN(then)) return false;
  return now - then > hours * 3600 * 1000;
}

export function startSlaAlerts({ getStale, slaHours, getLastIngest }) {
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

  const silenceHours = Number(process.env.INGEST_SILENCE_HOURS || DEFAULT_SILENCE_HOURS);

  /**
   * Independent of the stale-cart latch below. The two alarms mean opposite
   * things — "nobody is calling" vs "nothing is arriving" — and a broken webhook
   * must not be masked by a quiet backlog, so they never share state.
   */
  const checkSilence = async () => {
    if (!getLastIngest) return;
    const last = await getLastIngest();
    if (!isIngestSilent(last, silenceHours)) {
      lastSilenceAlertAt = 0;   // ingestion resumed — re-arm
      return;
    }
    // Don't message hourly through a weekend outage.
    if (Date.now() - lastSilenceAlertAt < SILENCE_REALERT_MS) return;

    const hours = Math.floor((Date.now() - new Date(last).getTime()) / 3600000);
    await sendOpsAlert(opsPhone,
      `Cart Recovery Board: no carts received for ${hours}h. ` +
      `Check the GoKwik webhook is still pointed at abc.briyo.xyz.`);
    lastSilenceAlertAt = Date.now();
    console.warn(`Ingest-silence alert sent: ${hours}h since the last cart`);
  };

  const tick = async () => {
    try {
      await checkSilence();
    } catch (err) {
      console.error('Ingest-silence check failed:', err.message);
    }
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
  console.log(`Ingest-silence alert: if no cart arrives for ${silenceHours}h (largest real gap observed so far: 3.3h)`);
  return timer;
}

/** Exposed for tests. */
export function _resetAlertState() { lastAlertedCount = 0; lastSilenceAlertAt = 0; }
