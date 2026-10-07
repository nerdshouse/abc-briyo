# Briyo OS: Affiliates (Phase 1A foundation, Phase 1C admin)

The affiliate / referral module manages partners such as nutritionists, doctors, influencers and customers who refer orders to the Briyo Supplements storefront. Shopify remains the ecommerce source of truth. Briyo OS will own partner management, verification, attribution, commissions and payouts.

**Phase 1A** added the identity and configuration foundation (tables, statuses, rates, events, roles). **Phase 1C** adds the internal admin: a Growth → Affiliates page where authorised members create, search, inspect, edit, suspend / reactivate / close partners and manage their rate history.

> Referral attribution, commissions, payouts, public referral links and professional verification are **not implemented**. The admin manages partner records only; no figure on it is a commission, revenue or order number.

## Tables (`lib/affiliates.js`, `ensureAffiliateSchema()`)

The tables are created idempotently on first use, like the other modules (`CREATE … IF NOT EXISTS`, named CHECK constraints re-set on every run, triggers recreated). Seeds use `ON CONFLICT DO NOTHING`, so an admin's later edit is never overwritten.

| Table | Purpose | Key rules |
|---|---|---|
| `affiliate_categories` | What kind of partner (data, not code) | PK `key`; seeded with nutritionist, dietitian, doctor, dentist, other_professional (these require verification), influencer, creator, customer |
| `affiliates` | The partner | `public_id` is unique, opaque and **immutable** (trigger). `category` references `affiliate_categories(key)` **ON UPDATE/DELETE RESTRICT**: a category in use can't be deleted or re-keyed, and deleting a category never deletes affiliates. Named check `affiliates_status_check`. |
| `affiliate_rates` | Commission-rate history | `rate_bps` 0–10000; `UNIQUE (affiliate_id, effective_from)`; **append-only** |
| `affiliate_settings` | Module configuration (JSONB values with a version) | Seeded with `attribution_window_days = 30` and `attribution_rule_version = "v1"` |
| `affiliate_events` | The module's audit trail (`actor`, `action`, `affiliate_id`, `entity`, `entity_id`, `metadata`) | **append-only**; actions are snake_case names |

### Statuses
`draft`, `pending_verification`, `approved`, `active`, `suspended`, `closed`. Phase 1C implements the transitions below; see [Lifecycle](#lifecycle-phase-1c).

### Public ID
6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O or 1/I/L), drawn with `crypto.randomInt` (`newAffiliatePublicId()`). It's never the database `id`. The unique constraint is the guarantee, so a creator retries on a duplicate.

### Rates (basis points)
`1500` = 15%. An affiliate's rate is **only** the rate history; there's no "current rate" column. A change of rate is a new row with a new `effective_from`. `rateAt(db, affiliateId, at)` returns the latest row effective by `at`, which is deterministic because two rows can't share an `effective_from`. Later phases will capture the applicable rate on each commission.

### Append-only
`affiliate_rates` and `affiliate_events` refuse UPDATE and DELETE at the database level, as `order_events` and the inventory ledger do. The only exception is a DELETE inside a transaction that sets `app.purge_affiliates`, which only the test suite's `purgeTestAffiliates()` does (refused unless the database is labelled test or development).

## Permissions (`lib/permissions.js`)

| Module `affiliate` role | Capabilities |
|---|---|
| viewer | `affiliate.view` |
| manager | `affiliate.view`, `affiliate.manage`, `affiliate.verify` |
| finance | `affiliate.view`, `affiliate.commissions`, `affiliate.payouts` |

- **Admins** (and super admins) hold every capability, as before.
- **Other members:** no existing member gains anything; access needs an explicit `affiliate` role.
- **Database:** the constraint `member_module_roles_pair_ok` (`lib/db.js`) now also accepts `affiliate` with viewer, manager or finance.
- **Used by Phase 1C:** `affiliate.view` (pages and every read API) and `affiliate.manage` (create, edit, status, rates). `affiliate.verify`, `affiliate.commissions` and `affiliate.payouts` have no route yet, so a finance member can read but not change anything.
- **Home page:** a member whose only module is Affiliates lands on `/affiliates`.

## Admin (Phase 1C)

### Pages
| Route | What it shows |
|---|---|
| `/affiliates` | KPIs (total, active, pending verification, suspended; each filters the list), then the list: partner, category, status, current rate, created, last activity. Search by name, email, phone or public ID; filter by category and status; sort (newest, name, category, status, recent activity); 50 per page with **Show more**. |
| `/affiliates/:publicId` | Header (name, status, category, public ID, created, current rate) and capability-gated actions; **Profile**; **Rate history**; **Activity**. |

Forms (new affiliate, edit profile, status change with a reason, new rate) open in the side drawer, as in HR. The page is `public/affiliates.html` + `public/affiliates.js`, on the shared shell (`public/ui/components.js`), with no framework or build step. Both pages need `affiliate.view`; anyone else is sent to their own home page. The sidebar shows **Growth → Affiliates** only to members holding `affiliate.view`.

### API (`lib/affiliate-routes.js`, mounted at `/api/affiliates`)
All endpoints need a signed-in Briyo OS session. Affiliates are addressed by their public ID; database IDs never appear in a response.

| Endpoint | Capability |
|---|---|
| `GET /api/affiliates/meta` (statuses, active categories, transitions, `canManage`) | `affiliate.view` |
| `GET /api/affiliates?q&category&status&sort&dir&limit&offset` | `affiliate.view` |
| `GET /api/affiliates/:publicId`, `GET /api/affiliates/:publicId/events` | `affiliate.view` |
| `POST /api/affiliates` | `affiliate.manage` |
| `PATCH /api/affiliates/:publicId` (`version` for optimistic locking) | `affiliate.manage` |
| `POST /api/affiliates/:publicId/status` (`action`, `reason`, `version`) | `affiliate.manage` |
| `POST /api/affiliates/:publicId/rates` (`rate_percent` or `rate_bps`, `effective_from`, `reason`) | `affiliate.manage` |

Refusals use the standard responses: 401 signed out, 403 `{ ok: false, error }` without the capability, 400 with `field` for invalid input, 404 unknown public ID, 409 for a stale version or an invalid transition. Sorting is a fixed whitelist (`created`, `name`, `category`, `status`, `activity`); search terms are parameters with LIKE wildcards escaped; `limit` is capped at 100.

### Validation (server-side)
Display name required (≤ 120 characters). The category must exist and be active. Email is checked and lower-cased. Phone is stored as E.164; a 10-digit number is taken as Indian (+91). Rates: 0–100% with at most two decimals (0–10000 bps), parsed without floating point. A reason is required for a rate change, a suspension and a closure (≤ 300 characters). The public ID is always generated by the server; a client-supplied one is ignored.

### Lifecycle (Phase 1C)
| Action | From | To |
|---|---|---|
| Create | — | `pending_verification` if the category requires verification, otherwise `draft` |
| Activate | `draft` (category without verification), `approved` | `active` (first activation sets `activated_at`) |
| Suspend (reason) | `active`, `approved` | `suspended`, recording the reason, actor and time |
| Reactivate | `suspended` | the status it had before the suspension, but never `active` for a category that requires verification (then `pending_verification`) |
| Close (reason) | any except `closed` | `closed`, which is final: no edits, rates or transitions |
| Category change | — | to a category that requires verification: `draft` / `active` / `approved` become `pending_verification`; back to one that doesn't: `pending_verification` becomes `draft`. Suspended and closed are kept. |

Nothing approves, verifies or deletes an affiliate. `approved` is reachable only through verification, which is a later phase.

### Rates
The current rate is the latest `affiliate_rates` row effective now (`rateAt`); there is no rate column on `affiliates`. Adding a rate inserts a new row with its reason and actor; earlier rows are never changed (the database refuses it). A rate starts now or at the start of a later day (IST), at most a year ahead; a past start is refused, so history is never rewritten. A duplicate start for the same affiliate is refused (409, `UNIQUE (affiliate_id, effective_from)`). A future rate shows as **Scheduled** until it takes effect. An initial rate can be set when creating the affiliate.

### Events
Every change writes one `affiliate_events` row in the same transaction, with the actor and time:

| Action | When | Metadata |
|---|---|---|
| `affiliate_created` | create | category, initial status |
| `affiliate_updated` | profile edit | the **names** of the changed fields (email and phone values are personal data and are not logged); category from → to |
| `affiliate_status_changed` | activate, or a status change caused by a category change | from, to |
| `affiliate_suspended` / `affiliate_reactivated` / `affiliate_closed` | those actions | from, to, reason |
| `affiliate_rate_added` | initial or new rate | rate (bps), effective from, reason |

Event names are snake_case because Phase 1A's `affiliate_events.action` check allows only `[a-z0-9_]`. The table is append-only. The API returns a readable summary of each event, never the raw metadata. No passwords, OTPs, tokens, sessions or documents are logged.

### Schema
Phase 1C adds no tables or columns. The Phase 1A tables are created at server startup (`ensureAffiliateSchema()` in `server.js`, in the background, alongside the other modules' schemas). It is idempotent and seeds only the categories and settings, never affiliates. Requests that arrive meanwhile wait on the same promise; if startup setup fails, it is logged and retried by the next affiliate request.

## Not implemented yet (by design)

- **Shopify:** scopes, discount codes, URL redirects. (Order financial snapshots arrived in Phase 1B; see ORDER-FINANCIAL-SNAPSHOTS.md.)
- **Referrals:** referral links (`briyosupplements.com/r/…`), the click host, click tracking, codes, links, customer attribution.
- **Money:** referral attribution, commissions, the commission ledger, refunds and reversals, payouts.
- **Verification:** professional profiles, verification applications, certificate uploads, approval / rejection. Professional partners stay `pending_verification`.
- **Interfaces:** an Overview card, the affiliate portal and login, reporting. (The internal admin UI exists since Phase 1C.)
- **Infrastructure:** Cloudflare, DNS, storefront or theme, and GoKwik changes.

See the Phase 0 architecture report for the planned later phases (1B onwards).
