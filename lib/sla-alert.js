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
let lastSummaryDay = null;

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

const BOARD_TZ = process.env.BOARD_TZ || 'Asia/Kolkata';
const DEFAULT_SUMMARY_HOUR = 20;

/** The board's own calendar day, as YYYY-MM-DD. */
export function boardDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOARD_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function boardHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: BOARD_TZ, hour: 'numeric', hour12: false,
  }).format(now));
}

/**
 * Is it time for today's summary?
 *
 * Latched on the calendar day rather than an interval, so a redeploy — which
 * resets every timer in the process — cannot send the same evening's digest
 * twice. Pure, so the decision is testable without sending anything.
 */
export function shouldSendSummary(lastSentDay, { hour, now = new Date() } = {}) {
  if (boardHour(now) < hour) return false;
  return lastSentDay !== boardDay(now);
}

/**
 * The evening message.
 *
 * Kept pure and separate from the sending for the same reason isIngestSilent
 * is: the wording is the part that changes, and it should be checkable without
 * a WhatsApp credit being spent.
 */
export function buildDailySummary({ today, queue, callers = [], slaHours }) {
  const rupees = (v) => `₹${Math.round(Number(v || 0)).toLocaleString('en-IN')}`;
  const lines = [
    `Cart Recovery Board — today`,
    `${today.carts} cart${today.carts === 1 ? '' : 's'} in (${rupees(today.value)})`,
    `${today.called} called · ${today.recovered} recovered (${rupees(today.recovered_value)})`,
  ];

  // Only name what needs doing. A quiet queue should produce a short message,
  // not a list of zeroes nobody reads.
  const waiting = [
    queue.unassigned && `${queue.unassigned} unassigned`,
    queue.stale && `${queue.stale} uncalled ${slaHours}h+`,
    queue.callbacks_overdue && `${queue.callbacks_overdue} callback${queue.callbacks_overdue === 1 ? '' : 's'} missed`,
  ].filter(Boolean);
  if (waiting.length) lines.push(`Needs doing: ${waiting.join(' · ')}`);

  const worked = callers.filter((c) => c.touched > 0);
  if (worked.length) {
    lines.push(worked.map((c) => `${c.caller}: ${c.touched}`).join(' · '));
  }

  lines.push('https://abc.briyo.xyz/dashboard');
  return lines.join('\n');
}

export function startSlaAlerts({ getStale, slaHours, getLastIngest, getDailyStats }) {
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

  const summaryHour = Number(process.env.DAILY_SUMMARY_HOUR ?? DEFAULT_SUMMARY_HOUR);

  /**
   * One digest a day, to the same number the alarms go to. Independent of both
   * latches above: a day with no problems still gets a summary, and a day full
   * of them still gets exactly one.
   */
  const checkSummary = async () => {
    if (!getDailyStats || process.env.DAILY_SUMMARY_ENABLED === 'false') return;
    if (!shouldSendSummary(lastSummaryDay, { hour: summaryHour })) return;

    const stats = await getDailyStats();
    // Claim the day before sending: a failed send must not retry every hour
    // for the rest of the evening.
    lastSummaryDay = boardDay();
    await sendOpsAlert(opsPhone, buildDailySummary({ ...stats, slaHours }));
    console.log(`Daily summary sent for ${lastSummaryDay}`);
  };

  const tick = async () => {
    try {
      await checkSilence();
    } catch (err) {
      console.error('Ingest-silence check failed:', err.message);
    }
    try {
      await checkSummary();
    } catch (err) {
      console.error('Daily summary failed:', err.message);
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
  console.log(getDailyStats && process.env.DAILY_SUMMARY_ENABLED !== 'false'
    ? `Daily summary: once a day after ${summaryHour}:00 ${BOARD_TZ}`
    : 'Daily summary: off');
  return timer;
}

/** Exposed for tests. */
export function _resetAlertState() {
  lastAlertedCount = 0; lastSilenceAlertAt = 0; lastSummaryDay = null;
}
