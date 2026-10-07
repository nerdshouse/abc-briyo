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
                        • short-lived cache: in-flight sharing, TTL, stale-if-error
                              │
                              ▼
                      graph.facebook.com/{version}/…
```

- **No direct browser access:** the browser never calls Meta, and never sees the token, the app secret, or any raw Meta error.
- **One service, two users:** the Admin Overview uses the same service and cache. It never makes its own Meta call.
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
- **"Today":** `date_preset=today` follows the **ad account's timezone**. The page shows that timezone, plus fetch times in IST.

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

**Purchases and revenue:** exactly one action type is used, never summed: the first one present of `omni_purchase` → `purchase` → `offsite_conversion.fb_pixel_purchase`.
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

## 5. Caching

- **Cache key:** in-process, keyed by account, endpoint, level, range, object id and filters.
- **Lifetime:** ranges that include today expire after **45 s**. Ranges entirely in the past expire after **10 min**.
- **Request sharing:** identical requests that arrive at the same moment share one in-flight Meta call. Many admins produce one call.
- **Stale-if-error:** if Meta fails, the last good result (up to 24 h old) is served with `stale: true`, the reason, and the last successful fetch time.
- **Visibility:** the UI shows "Data delayed · Last successful update …". With nothing cached, it shows an actionable error.
- **Storage:** no database tables. Production runs as one instance, so the in-process cache is sufficient.

## 6. Navigation and screens

GROWTH → **Marketing**, with sub-items **Overview** and **Campaigns**.
- **Ad sets** and **Ads** are drill-downs (campaign → ad sets → ads), not empty separate pages.
- The page sits in the shell at `/marketing`, with `?view=campaigns`, `?campaign=…` and `?adset=…`.

- **Header:** "Marketing · Meta Ads", the account name, currency and timezone, a freshness pill, and Refresh.
- **Ranges:** Today · Yesterday · Last 7 days · Last 30 days · This month · Custom (custom is capped at 92 days).
- **KPI cards:** Spend · Meta-attributed revenue · Meta ROAS · Purchases · Cost / purchase · CTR · CPC · CPM.
- **Trend chart:** spend vs Meta-attributed revenue by day, for multi-day ranges. Today has no daily trend, and the chart says so.
- **Campaign table:** search, status filter, sortable columns. Clicking a campaign opens its detail (KPIs, trend, ad sets). Clicking an ad set opens its ads.
- **Auto-refresh:** every 60 s while the page is visible, for ranges that include today.

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
- **Read-only:** the client exposes `GET` only. There is no code path that writes to Meta, and the token's `ads_read` scope would refuse writes anyway.
- **Bounded queries:** ranges are validated (custom ≤ 92 days, no future dates) and id parameters are digits only.
