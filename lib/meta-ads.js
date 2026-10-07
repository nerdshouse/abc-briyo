import crypto from 'node:crypto';

/**
 * Meta Ads (Marketing API) — read-only, server-side. See docs/briyo-os/MARKETING.md.
 *
 * - GET only. The token goes in an Authorization header (never a URL), every
 *   call is signed with appsecret_proof when META_APP_SECRET is set, and no
 *   token, secret or raw Meta error ever leaves this module.
 * - One normaliser computes every metric from raw sums, so CTR/CPC/CPM/CPA/ROAS
 *   mean the same everywhere and are null (shown "—") when undefined.
 * - A short cache: identical concurrent requests share one call; results live
 *   45 s when the range includes today, 10 min otherwise; if Meta fails, the
 *   last good result (≤ 24 h) is served marked stale.
 */

export const DEFAULT_VERSION = 'v25.0';
const TIMEOUT_MS = 15000;
const MAX_PAGES = 20;
const LIVE_TTL_MS = 45 * 1000;
const PAST_TTL_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 24 * 3600 * 1000;
const MAX_CUSTOM_DAYS = 92;
// Ads Manager's "Purchases": one type, never summed (summing double-counts).
export const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const INSIGHT_FIELDS = ['spend', 'impressions', 'reach', 'clicks', 'actions', 'action_values', 'date_start', 'date_stop'];
export const RANGES = {
  today: 'today', yesterday: 'yesterday', last_7d: 'last_7d', last_30d: 'last_30d', this_month: 'this_month',
};
export const RANGE_LABELS = { today: 'Today', yesterday: 'Yesterday', last_7d: 'Last 7 days', last_30d: 'Last 30 days', this_month: 'This month', custom: 'Custom' };

/** An error a person can act on. `kind` drives the message and HTTP status; `detail` is for logs only. */
export class MetaError extends Error {
  constructor(kind, message, { status = 502, retryable = false, detail = {} } = {}) {
    super(message);
    this.name = 'MetaError'; this.kind = kind; this.status = status; this.retryable = retryable; this.detail = detail;
  }
}

const MESSAGES = {
  not_configured: 'Meta Ads is not connected. An admin adds META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in Render.',
  token: 'The Meta access token is invalid, expired or revoked. Generate a new system-user token with ads_read and update META_ACCESS_TOKEN.',
  permission: 'The Meta token cannot read this ad account. Assign the ad account to the system user (view performance) and include ads_read.',
  account: 'The ad account in META_AD_ACCOUNT_ID was not found or is not accessible.',
  rate_limit: 'Meta is limiting requests right now. Briyo OS will retry shortly.',
  timeout: 'Meta did not answer in time. Briyo OS will retry shortly.',
  temporary: 'Meta had a temporary problem. Briyo OS will retry shortly.',
  bad_response: 'Meta returned data Briyo OS could not read.',
  bad_request: 'That request could not be made to Meta.',
};

/** Meta error JSON → MetaError (no raw text kept for users). */
export function classifyMetaError(err, httpStatus = 0) {
  const code = Number(err?.code); const sub = Number(err?.error_subcode);
  const detail = { code, subcode: sub || undefined, type: err?.type, fbtrace_id: err?.fbtrace_id, http: httpStatus };
  if (code === 190 || code === 102) return new MetaError('token', MESSAGES.token, { status: 502, detail });
  if ([4, 17, 32, 613, 80000, 80003, 80004, 80014].includes(code)) return new MetaError('rate_limit', MESSAGES.rate_limit, { status: 503, retryable: true, detail });
  if (code === 10 || code === 200 || code === 294 || (code >= 200 && code < 300)) return new MetaError('permission', MESSAGES.permission, { status: 502, detail });
  if (code === 100 && /act_|ad account|nonexisting|does not exist/i.test(err?.message || '')) return new MetaError('account', MESSAGES.account, { status: 502, detail });
  if (code === 1 || code === 2 || httpStatus >= 500) return new MetaError('temporary', MESSAGES.temporary, { status: 503, retryable: true, detail });
  return new MetaError('bad_request', MESSAGES.bad_request, { status: 502, detail });
}

export function metaConfig(env = process.env) {
  const token = String(env.META_ACCESS_TOKEN || '').trim();
  let account = String(env.META_AD_ACCOUNT_ID || '').trim();
  if (/^\d+$/.test(account)) account = `act_${account}`;
  if (account && !/^act_\d+$/.test(account)) account = '';
  const target = Number(env.MARKETING_ROAS_TARGET);
  return {
    configured: Boolean(token && account),
    token, account, appSecret: String(env.META_APP_SECRET || '').trim(),
    version: /^v\d+\.\d+$/.test(String(env.META_API_VERSION || '')) ? env.META_API_VERSION : DEFAULT_VERSION,
    roasTarget: Number.isFinite(target) && target > 0 ? target : null,
    // Test suites point the client at a local stub; never honoured outside APP_ENV=test.
    baseUrl: env.APP_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+$/.test(String(env.META_GRAPH_BASE || '')) ? env.META_GRAPH_BASE : 'https://graph.facebook.com',
  };
}

/**
 * A minimal Graph client: GET only. `fetchImpl` is injectable for tests.
 * Follows cursor pagination itself (never `paging.next`, which can carry a token).
 */
export function createMetaClient({ token, appSecret = '', version = DEFAULT_VERSION, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, log = console, baseUrl = 'https://graph.facebook.com' } = {}) {
  const proof = appSecret ? crypto.createHmac('sha256', appSecret).update(token).digest('hex') : null;
  async function call(path, params = {}) {
    const url = new URL(`${baseUrl}/${version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    if (proof) url.searchParams.set('appsecret_proof', proof);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const kind = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'temporary';
      log.error(`Meta ${path}: ${kind} (${err?.name || 'network'})`);
      throw new MetaError(kind, MESSAGES[kind], { status: 503, retryable: true, detail: { network: err?.name } });
    }
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok || body?.error) {
      const e = classifyMetaError(body?.error || {}, res.status);
      log.error(`Meta ${path}: ${e.kind} code=${e.detail.code} sub=${e.detail.subcode ?? '-'} trace=${e.detail.fbtrace_id ?? '-'} http=${res.status}`);
      throw e;
    }
    if (!body || typeof body !== 'object') {
      log.error(`Meta ${path}: unreadable response (http ${res.status})`);
      throw new MetaError('bad_response', MESSAGES.bad_response);
    }
    return body;
  }
  async function list(path, params = {}) {
    const rows = [];
    let after;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await call(path, { ...params, ...(after ? { after } : {}) });
      if (!Array.isArray(body.data)) { log.error(`Meta ${path}: data is not a list`); throw new MetaError('bad_response', MESSAGES.bad_response); }
      rows.push(...body.data);
      after = body.paging?.cursors?.after;
      if (!after || !body.paging?.next) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }
  return { call, list };
}

// ------------------------------------------------------------------ metrics

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pickAction = (list) => {
  if (!Array.isArray(list)) return null;
  for (const t of PURCHASE_TYPES) { const a = list.find((x) => x?.action_type === t); if (a) return num(a.value); }
  return null;
};
const ratio = (a, b, k = 1) => (b > 0 && Number.isFinite(a) ? (a / b) * k : null);

/** Raw sums → every metric. Missing pieces are null, never NaN/Infinity. */
export function metricsFrom({ spend = 0, impressions = 0, clicks = 0, reach = null, purchases = null, value = null }) {
  const p = purchases ?? 0; const v = value ?? 0;
  return {
    spend, impressions, clicks, reach,
    purchases: p, revenue: v,
    ctr: ratio(clicks, impressions, 100),
    cpc: ratio(spend, clicks),
    cpm: ratio(spend, impressions, 1000),
    cpa: p > 0 ? spend / p : null,
    roas: spend > 0 ? v / spend : null,
  };
}

/** One Meta insights row → raw sums (purchases/value 0 when Meta omitted them: it omits zeros). */
export function rawFromRow(r) {
  if (!r || typeof r !== 'object') throw new MetaError('bad_response', MESSAGES.bad_response);
  return {
    spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks),
    reach: r.reach === undefined ? null : num(r.reach),
    purchases: pickAction(r.actions) ?? 0, value: pickAction(r.action_values) ?? 0,
  };
}
export const sumRaw = (rows) => rows.reduce((t, r) => ({
  spend: t.spend + r.spend, impressions: t.impressions + r.impressions, clicks: t.clicks + r.clicks,
  reach: null, purchases: t.purchases + r.purchases, value: t.value + r.value,
}), { spend: 0, impressions: 0, clicks: 0, reach: null, purchases: 0, value: 0 });

// ------------------------------------------------------------------ ranges

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Validated range → Meta params. Custom: both days, since ≤ until, ≤ 92 days, not in the future. */
export function rangeParams({ range = 'today', since, until } = {}, now = new Date()) {
  if (RANGES[range]) return { key: range, params: { date_preset: RANGES[range] }, live: ['today', 'last_7d', 'last_30d', 'this_month'].includes(range), multiDay: !['today', 'yesterday'].includes(range) };
  if (range !== 'custom') throw new MetaError('bad_request', 'Unknown date range.', { status: 400 });
  if (!DAY.test(String(since)) || !DAY.test(String(until))) throw new MetaError('bad_request', 'Choose a start and an end date.', { status: 400 });
  const a = new Date(`${since}T00:00:00Z`); const b = new Date(`${until}T00:00:00Z`);
  const days = Math.round((b - a) / 86400000) + 1;
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  if (Number.isNaN(days) || days < 1) throw new MetaError('bad_request', 'The start date must be on or before the end date.', { status: 400 });
  if (days > MAX_CUSTOM_DAYS) throw new MetaError('bad_request', `Custom ranges are limited to ${MAX_CUSTOM_DAYS} days.`, { status: 400 });
  if (until > tomorrow) throw new MetaError('bad_request', 'The range cannot end in the future.', { status: 400 });
  const live = until >= now.toISOString().slice(0, 10);
  return { key: `custom:${since}:${until}`, params: { time_range: { since, until } }, live, multiDay: days > 1 };
}

// ------------------------------------------------------------------ cache

export function createCache({ now = () => Date.now() } = {}) {
  const store = new Map(); const inflight = new Map();
  /**
   * get(key, ttlMs, loader) → { data, fetchedAt, stale, error? }
   * Fresh hit: cached. Miss/expired: one shared load; on failure, the last good
   * value (≤ 24 h) with stale=true and the error kind; otherwise the error throws.
   */
  async function get(key, ttlMs, loader, { force = false } = {}) {
    const hit = store.get(key);
    // A manual refresh bypasses the cache only if what we have is at least 10 s old (no hammering Meta).
    if (hit && (!force || now() - hit.at < 10000) && now() - hit.at < ttlMs) return { data: hit.data, fetchedAt: new Date(hit.at).toISOString(), stale: false, cached: true };
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        try {
          const data = await loader();
          store.set(key, { data, at: now() });
          return { data, fetchedAt: new Date(now()).toISOString(), stale: false, cached: false };
        } finally { inflight.delete(key); }
      })());
    }
    try { return await inflight.get(key); } catch (err) {
      const last = store.get(key);
      if (last && now() - last.at < STALE_MAX_MS && err instanceof MetaError && err.kind !== 'not_configured') {
        return { data: last.data, fetchedAt: new Date(last.at).toISOString(), stale: true, cached: true, error: { kind: err.kind, message: err.message } };
      }
      throw err;
    }
  }
  return { get, clear: () => { store.clear(); inflight.clear(); }, size: () => store.size };
}

// ------------------------------------------------------------------ service

const STATUS_FIELDS = 'id,name,status,effective_status,objective';

/**
 * The Marketing service. `deps` let tests inject config, fetch and clock.
 * Every method returns { …data, fetchedAt, stale, error? } from the cache.
 */
export function createMetaService({ config = metaConfig(), fetchImpl, now, log = console } = {}) {
  const cache = createCache({ now });
  const client = config.configured ? createMetaClient({ token: config.token, appSecret: config.appSecret, version: config.version, fetchImpl, log, baseUrl: config.baseUrl }) : null;
  const need = () => { if (!client) throw new MetaError('not_configured', MESSAGES.not_configured, { status: 503 }); };
  const ttl = (r) => (r.live ? LIVE_TTL_MS : PAST_TTL_MS);
  const insights = (path, r, extra = {}) => client.list(`${path}/insights`, { fields: INSIGHT_FIELDS.concat(extra.fields || []).join(','), ...r.params, ...extra.params });

  async function account({ force } = {}) {
    need();
    return cache.get(`acct:${config.account}`, 30 * 60 * 1000, async () => {
      const a = await client.call(config.account, { fields: 'name,currency,timezone_name,account_status' });
      if (!a || typeof a.name !== 'string') throw new MetaError('bad_response', MESSAGES.bad_response);
      return { id: config.account, name: a.name, currency: a.currency || 'INR', timezone: a.timezone_name || null, status: a.account_status ?? null };
    }, { force });
  }

  /** Totals (with reach) and, for multi-day ranges, one row per day. */
  async function summary(input = {}, { force } = {}) {
    need();
    const r = rangeParams(input);
    return cache.get(`summary:${config.account}:${r.key}`, ttl(r), async () => {
      const [tot, days] = await Promise.all([
        insights(config.account, r, { params: { level: 'account' } }),
        r.multiDay ? insights(config.account, r, { params: { level: 'account', time_increment: 1 } }) : Promise.resolve({ rows: [] }),
      ]);
      const raw = tot.rows.length ? rawFromRow(tot.rows[0]) : { spend: 0, impressions: 0, clicks: 0, reach: 0, purchases: 0, value: 0 };
      return {
        range: r.key, delivered: tot.rows.length > 0,
        totals: metricsFrom(raw),
        trend: days.rows.map((d) => ({ date: d.date_start, ...metricsFrom(rawFromRow(d)) })).sort((a, b) => a.date.localeCompare(b.date)),
      };
    }, { force });
  }

  /** Objects (status/objective) merged with their insights for the range; objects without delivery show "—". */
  async function level(kind, input = {}, { parent = null, force } = {}) {
    need();
    const r = rangeParams(input);
    const L = { campaign: ['campaigns', 'campaign'], adset: ['adsets', 'adset'], ad: ['ads', 'ad'] }[kind];
    if (!L) throw new MetaError('bad_request', 'Unknown level.', { status: 400 });
    if (parent && !/^\d+$/.test(String(parent.id))) throw new MetaError('bad_request', 'Invalid id.', { status: 400 });
    const scope = parent ? parent.id : config.account;
    return cache.get(`${kind}:${config.account}:${scope}:${r.key}`, ttl(r), async () => {
      const filtering = [{ field: 'effective_status', operator: 'NOT_IN', value: ['DELETED', 'ARCHIVED'] }];
      const [objs, ins] = await Promise.all([
        client.list(`${scope}/${L[0]}`, { fields: STATUS_FIELDS.replace(',objective', kind === 'campaign' ? ',objective' : ''), filtering, limit: 200 }),
        insights(scope, r, { params: { level: L[1], limit: 500 }, fields: [`${L[1]}_id`, `${L[1]}_name`] }),
      ]);
      const byId = new Map(ins.rows.map((row) => [String(row[`${L[1]}_id`]), row]));
      const seen = new Set();
      const rows = objs.rows.map((o) => {
        seen.add(String(o.id));
        const row = byId.get(String(o.id));
        return { id: String(o.id), name: o.name || '(unnamed)', status: o.effective_status || o.status || null, objective: o.objective || null,
          delivered: Boolean(row), ...(row ? metricsFrom(rawFromRow(row)) : metricsFrom({})) };
      });
      // Delivered in the range but now archived/deleted: still part of the range's spend.
      for (const [id, row] of byId) {
        if (!seen.has(id)) rows.push({ id, name: row[`${L[1]}_name`] || '(unnamed)', status: 'ARCHIVED', objective: null, delivered: true, ...metricsFrom(rawFromRow(row)) });
      }
      rows.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
      return { range: r.key, level: kind, parent, rows, truncated: objs.truncated || ins.truncated };
    }, { force });
  }

  /** One campaign or ad set: its name/status, totals and daily trend. */
  async function object(kind, id, input = {}, { force } = {}) {
    need();
    if (!/^\d+$/.test(String(id))) throw new MetaError('bad_request', 'Invalid id.', { status: 400 });
    const r = rangeParams(input);
    return cache.get(`obj:${kind}:${id}:${r.key}`, ttl(r), async () => {
      const [o, tot, days] = await Promise.all([
        client.call(String(id), { fields: kind === 'campaign' ? `${STATUS_FIELDS},account_id` : 'id,name,status,effective_status,campaign_id,account_id' }),
        insights(String(id), r),
        r.multiDay ? insights(String(id), r, { params: { time_increment: 1 } }) : Promise.resolve({ rows: [] }),
      ]);
      // Only objects of the configured account are readable through Briyo OS.
      if (o.account_id && `act_${o.account_id}` !== config.account) throw new MetaError('account', MESSAGES.account, { status: 404 });
      return {
        range: r.key, kind, id: String(id), name: o.name || '(unnamed)', status: o.effective_status || o.status || null,
        objective: o.objective || null, campaignId: o.campaign_id || null,
        totals: metricsFrom(tot.rows.length ? rawFromRow(tot.rows[0]) : {}), delivered: tot.rows.length > 0,
        trend: days.rows.map((d) => ({ date: d.date_start, ...metricsFrom(rawFromRow(d)) })).sort((a, b) => a.date.localeCompare(b.date)),
      };
    }, { force });
  }

  return { config: { configured: config.configured, account: config.account, version: config.version, roasTarget: config.roasTarget, signed: Boolean(config.appSecret) }, account, summary, level, object, cache };
}

/** The process-wide service (created on first use, from the environment). */
let shared = null;
export const metaService = () => { if (!shared) shared = createMetaService(); return shared; };
export const _resetMetaService = (svc = null) => { shared = svc; };
