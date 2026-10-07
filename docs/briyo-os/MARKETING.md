# Briyo OS: Marketing (Meta Ads), version 1

Read-only, live Meta Ads performance inside Briyo OS. Admin-only. There is no mock data.

## 1. Architecture

```
Browser (Briyo OS)  ──►  /api/marketing/*  (requireAuth → requireCompleteProfile → requirePermission('marketing.view'))
                              │
                              ▼
                      lib/meta-ads.js
                        • Meta client (GET only, token in Authorization header, appsecret_proof)
                        • normalisation + metrics (one place)
                        • short-lived cache: in-flight sharing, TTL by freshness, stale-if-error, shared failure backoff
                              │
                              ▼
                      graph.facebook.com/{version}/…
```

- **No direct browser access:** the browser never calls Meta, and never sees the token, the app secret, or any raw Meta error.
- **One service, two users:** the Admin Overview uses the same service and cache. It never makes its own Meta call.
- **Server-side only:** Meta credentials stay in the server environment; the browser only talks to `/api/marketing/*`.
- **Built for more channels:** `lib/meta-ads.js` exposes channel-neutral shapes (`totals`, `rows`, `trend`), so Google or TikTok can be added later as sibling services.

## 2. Meta requirements (researched October 2026)

- **API version:** Marketing API **v25.0** (released 18 Feb 2026; expires 29 Jul 2028). It is pinned and can be overridden with `META_API_VERSION`.
- **Permission:** **`ads_read`** only. Meta's documentation says standard access to `ads_read` is sufficient for an app reading its own business's ad account. `ads_management` is **not** requested.
- **Access tier:** Standard ("Limited") access is granted automatically, and App Review is not required to read your own ad account.
- **Rate limits at the Standard/development tier:** roughly 600 + 400 × active ads per hour per ad account. The caching below keeps us far under that: at most a few calls per 45 s, shared by all admins.
- **Token:** a **System User** access token from Meta Business Settings.
  - It is not tied to a person and does not expire after 60 days.
  - It is scoped to the assets it is assigned to: assign the Briyo ad account with "View performance" (or partial access) only.
- **Securing calls:** if **Require App Secret** is enabled in the app (recommended), every call carries `appsecret_proof` = HMAC-SHA256(token, app secret).
- **Freshness:** Insights refresh about **every 15 minutes**. Conversion data keeps changing for days, attribution follows the ad set's settings (aligned with Ads Manager since June 2025), and figures stabilise after 28 days. "Live" therefore means "as fresh as Meta has it". The UI shows when Briyo OS last fetched, never "real time".
- **Throttling:** codes 4 (subcodes 1504022/1504039), 17, 613, 80000, 80003, 80004 and 80014. Headers `x-fb-ads-insights-throttle` and `x-business-use-case-usage` report usage. We back off and serve stale data.
- **Pagination:** cursor-based. We follow `paging.cursors.after` and never use `paging.next`, because those URLs can embed the token. Pages are capped.
- **Sync vs async:** version 1 queries are small (account, campaign, ad set or ad level, one date range, at most 31 daily buckets), so they are synchronous with a 15 s timeout. If timeouts appear on large accounts, the next step is async jobs (`report_run_id` + `async_status`).
- **Attribution:** every Insights request sends `use_unified_attribution_setting=true`, so figures follow each ad set's own attribution setting, as Ads Manager does.
- **"Today" and the account timezone:** `date_preset=today` follows the **ad account's timezone**. Briyo OS uses the same account-local date for custom ranges: the picker's latest selectable day, the "no future dates" check, and whether a custom range is live. Example: at 00:30 IST on 7 Oct, an IST account's today is 7 Oct even though UTC is still 6 Oct. The page shows the account timezone; fetch times are shown in IST. Briyo OS's global timezone behaviour is unchanged.

## 3. Meta Business setup (done once by an admin, in Meta)

1. Use the Briyo **Business portfolio** that owns the ad account.
2. Create a Meta **app** (type: Business) owned by that portfolio, then add the **Marketing API** product.
3. In App Settings › Advanced, turn on **Require App Secret**.
4. In Business Settings › Users › **System users**, add a system user with the Employee role.
5. Assign the **ad account** to that system user with view-only access ("View performance").
6. Add the app to the system user, then **Generate token** with only `ads_read`. Copy it once and store it in Render.

## 4. Data and metrics

**Insights fields requested:**
- `spend`, `impressions`, `reach`, `clicks`, `actions`, `action_values`, `date_start`, `date_stop`
- ids and names at campaign, ad set and ad level

**Object fields:**
- `name`, `status`, `effective_status`, `objective` (campaigns), `daily_budget`/`lifetime_budget`
- Budgets are **not** shown in version 1.

**Purchases and revenue:** the purchase action type is resolved **once** per row, never summed: the first present (in either `actions` or `action_values`) of `omni_purchase` → `purchase` → `offsite_conversion.fb_pixel_purchase`. The purchase count and the conversion value both come from that same type; if that type has no entry in one list, that figure is 0 rather than taken from another type.
- `omni_purchase` is what Ads Manager reports as "Purchases" across pixel, Conversions API and app.
- Summing the types would double-count.

Metrics are computed from raw sums, never by averaging Meta's averages:

| Metric | Formula | Shown as "—" when |
|---|---|---|
| CTR | clicks ÷ impressions × 100 | impressions = 0 |
| CPC | spend ÷ clicks | clicks = 0 |
| CPM | spend ÷ impressions × 1000 | impressions = 0 |
| Cost / purchase (CPA) | spend ÷ purchases | purchases = 0 |
| **Meta ROAS** | Meta-attributed purchase value ÷ spend | spend = 0, or value missing |

- **Zero handling:** Meta omits zero actions. When a row has delivery but no purchase action, purchases and value are a real **0**. ROAS is then 0.00× when spend > 0, and "—" when spend is 0.
- **Labelling:** revenue is always labelled **"Meta-attributed revenue"**. It is not Briyo's actual revenue.
- **Reach:** reach is not additive across days, so it only comes from un-bucketed queries.

### Account billing and funds

The account read (`GET /{act_id}?fields=name,currency,timezone_name,account_status,spend_cap,amount_spent`, cached 30 min) also feeds an **Account & billing** card on the Marketing page:

| Shown | Meta field | Notes |
|---|---|---|
| Account status | `account_status` | 1 Active, 2 Disabled, 3 Unsettled, 7 Pending risk review, 8 Pending settlement, 9 In grace period, 100/101 closing/closed |
| Spending limit | `spend_cap` | Minor currency units ÷ 100 (zero-decimal currencies as is); `0` = no limit |
| Spent toward the limit | `amount_spent` | Lifetime, relative to `spend_cap` |
| Available funds | — | **Not available from Meta** |

**Available / prepaid funds are not exposed by the Marketing API (v25.0)** for this setup:
- `balance` is the *bill amount due*, not funds remaining.
- `funding_source_details` (payment method, coupons, display text) needs MANAGE or ADVERTISE task access; the ads_read system user has view-only access, and its display text is not a reliable number.
- `is_prepay_account` also needs ADVERTISE/MANAGE.
- Spending limit minus amount spent is **not** available funds and is never calculated.

The UI therefore shows "Not available from Meta". The service carries `availableFunds: null, availableFundsSupported: false`, so a real value can be shown later without UI changes.

## 5. Freshness, caching and backoff

| Range | Class | Cache | Auto-refresh |
|---|---|---|---|
| Today, This month, Custom ending on the account's today | Live | 45 s | Every 60 s while the page is visible |
| Yesterday, Last 7 days, Last 30 days, Custom ending before the account's today | Closed | 10 min | No |

- **Last 7 / Last 30** are complete days **excluding today** (Meta's `last_7d` / `last_30d` presets, sent unchanged); the page says so.
- **Cache key:** in-process, keyed by account, endpoint, level, range, object id and filters. No database tables; production runs one instance.
- **Request sharing:** identical concurrent requests share one in-flight Meta call.
- **Refresh:** honoured only when the cached data is at least 10 s old, and never during a failure backoff.
- **Stale-if-error:** if Meta fails, the last good result (up to 24 h old) is served with `stale: true`, the reason and the last successful fetch time.
- **Failure backoff:** after a Meta failure (rate limit, timeout, temporary error, token or permission problem, malformed response) the service backs off for **45 s, shared by all requests and ranges**. During it no Meta call is made: requests get the last good data marked delayed, or an error if nothing is cached. After 45 s the next request retries; there is no permanent circuit breaker. Invalid input and internal errors do not start a backoff.

### Freshness states

| State | Where | Meaning |
|---|---|---|
| **Live** | Marketing page | Live range, served fresh from Meta (as fresh as Meta has it). |
| **Data delayed** | Marketing page | Meta failed or is backing off; last good data shown with "Last successful update …". |
| **Loading** | Overview card | Meta did not answer within the Overview budget; the figures appear on the next load. |
| **Unavailable** | Marketing page / Overview | Meta failed and nothing is cached; an actionable message is shown. |
| **Not connected** | Marketing page / Overview | No token or ad account is configured. |

### Admin Overview

- Marketing never blocks the rest of the Overview.
- The card shows today's spend, Meta-attributed revenue, Meta ROAS (the same `metricsFrom` calculation as the page) and purchases, with the freshness state as its header (Live, Data delayed, Loading, Unavailable, Not connected) and the account timezone.
- Cached data is shown immediately. A fresh fetch gets about **2 s**; past that the card shows **Loading** and every other department renders normally, with no alert raised.
- The fetch keeps running in the background and fills the shared cache, so the next Overview (or the Marketing page) gets the figures at once.
- The Marketing page itself is not subject to the 2 s budget (it uses the normal 15 s request timeout).

## 6. Navigation and screens

GROWTH → **Marketing**, with sub-items **Overview** and **Campaigns**.
- **Ad sets** and **Ads** are drill-downs (campaign → ad sets → ads), not empty separate pages.
- The page sits in the shell at `/marketing`, with `?view=campaigns`, `?campaign=…` and `?adset=…`.

- **Header:** "Marketing · Meta Ads", the account name, currency and timezone, a freshness pill, and Refresh.
- **Ranges:** Today · Yesterday · Last 7 days · Last 30 days · This month · Custom (custom is capped at 92 days).
- **KPI cards:** Spend · Meta-attributed revenue · Meta ROAS · Purchases · Cost / purchase · CTR · CPC · CPM.
- **Trend chart:** spend vs Meta-attributed revenue by day, for multi-day ranges. Today has no daily trend, and the chart says so.
- **Campaign table:** search, status filter, sortable columns. Clicking a campaign opens its detail (KPIs, trend, ad sets). Clicking an ad set opens its ads.
- **Auto-refresh:** every 60 s while the page is visible, for live ranges only (see §5).

## 7. Colour and thresholds

- **No business ROAS target exists yet,** so ROAS is shown **neutral** by default.
- **Optional target:** an admin can set `MARKETING_ROAS_TARGET` (for example `2.5`). Then:
  - ROAS ≥ target is **success** ("On target").
  - ROAS below target with spend is **warning** ("Below target").
  - Spend with zero purchases on a closed day is **warning**.
- **Statuses:**
  - Active is shown as info.
  - Paused, archived and other stopped states are neutral.
  - Delivery problems (`DISAPPROVED`, `WITH_ISSUES`) are critical.
- **Freshness:** Live is success, Delayed is warning, Unavailable is critical.

## 8. RBAC

- A new capability, **`marketing.view`**, has **no module role**, so only admins hold it (admins hold every capability).
- Every `/api/marketing/*` route and the `/marketing` page require it on the server. Hiding the link is not the control.
- The careers host never reaches these routes.

## 9. Environment variables

| Variable | Purpose | Comes from | Secret |
|---|---|---|---|
| `META_ACCESS_TOKEN` | System user token with `ads_read` | Business Settings › System users › Generate token | **Yes** |
| `META_AD_ACCOUNT_ID` | The ad account to read (`act_…` or the numeric id) | Ads Manager › account selector / Business Settings › Ad accounts | No |
| `META_APP_SECRET` | Signs every call (`appsecret_proof`) | App Dashboard › App settings › Basic | **Yes** |
| `META_API_VERSION` | Optional pin (default `v25.0`) | Meta changelog | No |
| `MARKETING_ROAS_TARGET` | Optional ROAS target for health colours | Business decision | No |

`META_APP_ID` is not needed for reading. With no token or account set, Marketing shows "Not connected" and nothing breaks.

## 10. Database

None. Snapshots, a warehouse, blended ROAS and CAC are later phases.

## 11. Security

- **Token handling:** the token lives only in server memory and the environment. It is sent in an `Authorization: Bearer` header, never in a URL.
- **Logging:** logs record the Meta error code, subcode and `fbtrace_id`, never the token or the full URL.
- **Responses:** responses never include the token, the app secret, or Meta's raw error text.
- **Signing:** every call carries `appsecret_proof` when `META_APP_SECRET` is set.
- **Scope:** `ads_read` only; `ads_management` is never requested.
- **Read-only:** version 1 is read-only. The client exposes `GET` only. There is no code path that writes to Meta, and the token's `ads_read` scope would refuse writes anyway.
- **Bounded queries:** ranges are validated (custom ≤ 92 days, no future dates) and id parameters are digits only.
