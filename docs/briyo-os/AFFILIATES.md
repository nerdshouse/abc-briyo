# Briyo OS: Affiliates (Phase 1A foundation, 1C admin, 1D professional verification, 1E referral attribution)

The affiliate / referral module manages partners such as nutritionists, doctors, influencers and customers who refer orders to the Briyo Supplements storefront. Shopify remains the ecommerce source of truth. Briyo OS will own partner management, verification, attribution, commissions and payouts.

**Phase 1A** added the identity and configuration foundation (tables, statuses, rates, events, roles). **Phase 1C** adds the internal admin: a Growth → Affiliates page where authorised members create, search, inspect, edit, suspend / reactivate / close partners and manage their rate history.

**Phase 1D** adds professional verification: a professional profile, verification applications with a full decision history, private certificate storage and the admin review on the affiliate page.

**Phase 1E** adds referral links, click tracking and order attribution: who gets credit for an order.

> **Phase 1E does not calculate commissions or payouts.** Commissions, the commission ledger and payouts are not implemented; no figure in the module is a commission or an amount owed.

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

Nothing deletes an affiliate. `approved` is reached only by approving a professional verification (Phase 1D, below); activation is always the separate **Activate** action. Reactivating a suspended professional returns to `active` / `approved` only when their latest verification application is approved; otherwise to `pending_verification`.

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

## Professional verification (Phase 1D)

`lib/affiliate-verification.js`, routes in `lib/affiliate-routes.js`, UI in the **Professional verification** card on `/affiliates/:publicId`.

Only categories with `affiliate_categories.requires_verification = true` take part (nutritionist, dietitian, doctor, dentist, other professional). There is no second list of professional categories. A non-professional affiliate has no profile, application or document, and its page shows no verification section.

### Tables
Created at startup (`ensureAffiliateVerificationSchema()` in `server.js`, idempotent, schema objects only, nothing seeded).

| Table | What it holds | Key rules |
|---|---|---|
| `professional_profiles` | One per affiliate: name as on the credential, profession, qualification, institution, registration number and authority, practice, specialization, city / state / country, notes | `UNIQUE (affiliate_id)`; FK to `affiliates` ON DELETE RESTRICT; length checks; `version` for optimistic locking. Contact details stay on `affiliates`. |
| `verification_applications` | The history of applications: status, who submitted / started review / decided and when, rejection reason, review notes, `profile_snapshot` (the profile copied in at submission, so a decision refers to exactly what was reviewed), `previous_application_id` for a resubmission | Statuses `draft`, `submitted`, `under_review`, `approved`, `rejected`. **One open application per affiliate** by the partial unique index `verification_applications_one_active` (draft / submitted / under_review). Checks: a rejection has a reason; a decision has a reviewer and time; anything past draft has a submission time and snapshot. |
| `professional_documents` | Document metadata: type (`certificate`, `registration`, `other`), original filename, content type, size, `storage_key`, sha256, label, issued / expiry dates (DATE), uploader | `UNIQUE (storage_key)`; FK to the application ON DELETE RESTRICT; size 1 byte – 10 MB; content types PDF, PNG, JPEG; expiry not before issue. No file bytes in Postgres. |

Each application and document also has an opaque 10-character reference (`public_id`) used in URLs and the UI; database ids are never sent to the browser.

**History is never destroyed** (trigger `professional_verification_guard`): rows in the three tables are never deleted; a decided (approved / rejected) application cannot be changed; documents cannot be changed. The only exception is the test suite's purge (`app.purge_affiliates`).

Actor columns (`created_by`, `reviewed_by`, `uploaded_by`, …) hold the member's name as text, like every other affiliate table: `allowed_users` has no numeric id to reference.

### Lifecycle
| Action | From | To | Capability |
|---|---|---|---|
| Create profile | — | profile + a **draft** application (when the affiliate is pending verification) | `affiliate.manage` |
| Upload document | draft | (draft) | `affiliate.manage` |
| Submit | draft, with at least one certificate | `submitted` — the profile is copied into the application; its documents are locked | `affiliate.verify` |
| Mark under review | submitted | `under_review` | `affiliate.verify` |
| Approve (confirmation, optional notes) | under_review | `approved`; the affiliate `pending_verification` → `approved` | `affiliate.verify` |
| Reject (reason required) | submitted, under_review | `rejected`; the affiliate stays `pending_verification` | `affiliate.verify` |
| New application ("resubmit") | latest is rejected | a **new** draft linked to the rejected one, which stays exactly as decided | `affiliate.verify` |
| Start application | nothing open and the affiliate is pending verification (e.g. after moving to another professional category) | new draft | `affiliate.verify` |

Anything else is refused with 409, as is a stale `version`. Each action runs in one transaction with a row lock and writes its event in the same transaction, so two simultaneous decisions cannot both succeed.

**Approval never activates.** The affiliate becomes `approved` and can then be activated with the Phase 1C **Activate** action. No referral link, code or rate is created. Approval is refused for a suspended or closed affiliate.

The UI states it plainly: a certificate on file is not a verification; only an **approved** application counts.

### Documents and storage
- **Formats:** PDF, PNG and JPG up to 10 MB (`MAX_DOCUMENT_BYTES`), checked by `validateDocument()` in `lib/storage.js` against the file's content (signature), not only its name or the browser's type.
- **Errors:** empty → 400, too large → 413, wrong or disguised type → 415.
- **Storage:** the existing private store (`lib/storage.js`: R2 in production, local disk in tests). The key is `affiliates/verification/YYYY-MM/<uuid>.<ext>`, never derived from the filename. The original filename is metadata only, with path separators and control characters neutralised. If the database write fails, the stored object is removed.
- **Opening a document** (`GET /api/affiliates/:publicId/verification/:applicationRef/documents/:documentRef`, `affiliate.verify`): the document must belong to that affiliate's application. The bytes are streamed through the app with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`; there is no public or pre-signed URL, and nothing is persisted. Every open writes `professional_document_viewed`.
- Storage keys, hashes and database ids are never returned to the browser.

### Expiry
Certificates carry an expiry date (DATE). The UI marks **Expired** and **Expires soon** (within 30 days, IST). Expiry never changes an application's or an affiliate's status, and there are no reminder jobs in this phase.

### RBAC
| Capability | Verification use |
|---|---|
| `affiliate.view` (viewer, manager, finance, admin) | See the profile, applications, decisions and document metadata |
| `affiliate.manage` (manager, admin) | Create / edit the professional profile; upload documents |
| `affiliate.verify` (manager, admin) | Submit, review, approve, reject, start / new application; open documents |

Finance (`affiliate.commissions`, `affiliate.payouts`) has no verification authority. No capability was added or granted to existing members. Every rule is enforced on the server; the UI only hides what the member cannot do.

### API
| Endpoint | Capability |
|---|---|
| `GET /api/affiliates/:publicId/verification` (profile, current application, history, allowed actions) | `affiliate.view` |
| `GET /api/affiliates/:publicId/professional` | `affiliate.view` |
| `POST` / `PATCH /api/affiliates/:publicId/professional` (`version` on PATCH) | `affiliate.manage` |
| `POST /api/affiliates/:publicId/verification/documents?type&label&issued_at&expires_at` (raw file body, name in `X-Filename`) | `affiliate.manage` |
| `GET /api/affiliates/:publicId/verification/:applicationRef/documents/:documentRef` | `affiliate.verify` |
| `POST /api/affiliates/:publicId/verification/{submit,review,approve,reject,resubmit,start}` (`version`, `reason`, `notes`) | `affiliate.verify` |

### Events (in `affiliate_events`)
`professional_profile_created`, `professional_profile_updated` (field names only), `verification_application_created`, `verification_submitted`, `verification_under_review`, `verification_approved`, `verification_rejected`, `verification_resubmitted`, `professional_document_uploaded`, `professional_document_viewed`, and `affiliate_status_changed` when approval moves the affiliate to `approved`.

Metadata holds application / document references, from → to, reason and notes. It never holds file contents, storage keys, URLs or credentials.

## Referral links and attribution (Phase 1E)

`lib/affiliate-referrals.js`; routes in `lib/affiliate-routes.js`; the storefront snippet in `storefront/briyo-referral.liquid`; the **Referral link** card on `/affiliates/:publicId`.

### The path of a referral
```
https://briyosupplements.com/r/{affiliate public id}       public link (Shopify URL redirect — set up explicitly, below)
  → https://{AFFILIATE_CLICK_HOST}/r/{affiliate public id}  Briyo OS on its own isolated host: records a click
  → 302 https://briyosupplements.com/?bref={id}&bclid={click id}&utm_source=affiliate&utm_medium=referral&utm_campaign={id}
  → storefront snippet: stores bref/bclid, writes private cart attributes __briyo_ref / __briyo_click
  → checkout → Shopify order customAttributes
  → existing Briyo OS Shopify order sync → financial snapshot + attribution
```
The affiliate's public ID is the referral identifier, so the public link never changes for a partner, even if a link is disabled and a new one created.

### Eligibility (one server-side rule: `getAffiliateReferralEligibility`)
| Affiliate | Eligible |
|---|---|
| suspended or closed | never |
| professional category | only with an **approved** verification **and** status `active` |
| other categories | status `active` (Phase 1C lifecycle) |

It is checked when a link is created, on every redirect, and again when an order is attributed. A suspended or closed affiliate keeps its link record, but the link is unusable: visitors land on the storefront home page, no click is recorded, nothing is attributed, and the response does not say why. Reactivation makes the same link usable again; no new asset is created.

### Tables (created at startup, schema only)
| Table | Holds | Rules |
|---|---|---|
| `affiliate_referral_assets` | An affiliate's link (`type = 'link'`); `type = 'coupon'` with a `code` is reserved for the coupon phase | Opaque 10-character `public_id`; one **active** link per affiliate (partial unique index); identity (`public_id`, affiliate, type, code, created_at) immutable and `active → disabled` final (trigger); disabling needs a reason; never deleted |
| `affiliate_referral_clicks` | One row per recorded redirect: opaque `public_id` (the `bclid`), opaque `visitor_id`, allow-listed UTM fields, `ip_hash` / `user_agent_hash` | Append-only. No raw IP, user agent, name, email or phone is stored. |
| `affiliate_order_attributions` | Who gets attribution credit for an order: affiliate, asset, click, method (`coupon` / `referral_click`), order time, `rule_version`, window used | `UNIQUE (order_id)`; FK to `orders`; append-only. Credit only, no amounts. |

### Click host
- **Setting:** `AFFILIATE_CLICK_HOST`, for example `go.briyo.xyz`.
- **Isolation:** like the careers host, it is answered by the first middleware in `server.js` and serves only `GET /r/:affiliatePublicId` and `/healthz`. Everything else is a plain 404, and it never reaches sessions, `/api`, `/auth` or app pages. The internal host has no `/r` route.
- **Not set:** no click host is served.
- **DNS:** the host must point at the Render service. That is a manual DNS step; nothing here changes DNS or Cloudflare.

### The redirect
- **Always a 302, never a 301.** It lands on `AFFILIATE_STOREFRONT_URL` (default `https://briyosupplements.com`) at `/`. The destination is built server-side, so nothing in the request can choose it: there is no open redirect.
- **Parameters:** only `bref`, `bclid` and the allow-listed `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` are sent on. Each UTM value is at most 100 plain characters, and anything else is dropped. Defaults are `utm_source=affiliate`, `utm_medium=referral` and `utm_campaign={id}`.
- **Click ID (`bclid`):** 16 random bytes, base64url (22 characters). It reveals no affiliate, customer, time or sequence.
- **Visitor ID:** a separate random value in the click host's first-party cookie `bv` (HttpOnly, SameSite=Lax, Secure over HTTPS). It lasts 30 days and is never derived from the IP, email or phone. It only links clicks from the same browser and is not a customer identity; there is no cross-device matching and no fingerprinting.
- **Retries:** the same browser repeating the same redirect within 30 seconds reuses the click.
- **Abuse:** past 30 clicks per IP in 10 minutes, the visitor still lands but no click is recorded.
- **IP and user agent:** stored only as HMAC hashes keyed by `AFFILIATE_HASH_SALT` (falling back to `HR_IP_HASH_SALT`), and not stored at all when neither is set.
- **Unusable link:** a malformed, unknown, disabled, suspended or closed link lands on the plain home page with no click recorded.

### Attribution (rule `v1`, from `affiliate_settings.attribution_rule_version`)
Run by the **existing** Shopify order sync (`lib/shopify-orders.js`), inside the same transaction as the order and its financial snapshot. There is no second importer, and no polling or webhook.

1. **Coupon first.** A discount code on the order that matches an active affiliate **coupon asset**, created before the order, for an affiliate eligible now. *No coupon assets can be created yet* (there is no coupon source), so this path is wired and tested but inactive until the coupon phase. Codes that are not affiliate coupons never create an attribution.
2. **Referral click.**
   - The order's `__briyo_click` must be a click recorded by Briyo OS, and the order's `__briyo_ref` (when present) must name that click's affiliate.
   - Then the **latest** click by the same visitor wins, provided it was made no later than the order (5-minute clock tolerance), within `affiliate_settings.attribution_window_days` before the order (30 days, read on every run, never hard-coded), with an active link and an affiliate eligible now. An ineligible affiliate's click is skipped in favour of the visitor's previous eligible one.
3. Otherwise **no attribution.** Browser values alone are never trusted.

Attribution is decided **once, when Briyo first imports the order**:
- **No rewrites:** a later sync never adds, changes or removes it, even after a suspension, reactivation or settings change.
- **No duplicates:** one per order, enforced by the database.
- **Nothing retroactive:** orders imported before Phase 1E are never attributed.
- **Values untouched:** order values, items, snapshots, stock and shipments are not changed.

The sync also adds `shopify.referral = { ref, click }` to the order's stored payload when present, and the financial snapshot keeps every custom attribute verbatim. Previews report `newAffiliateAttributions`; runs report `affiliateAttributionsRecorded`.

### Storefront snippet: required, not deployed
The Shopify theme is not in this repository and is never changed by Briyo OS. `storefront/briyo-referral.liquid` is the exact snippet to install, after review:
1. Online Store → Themes → **duplicate** the live theme → Edit code → Snippets → add `briyo-referral`, then paste the file.
2. In `layout/theme.liquid`, just before `</body>`, add `{% render 'briyo-referral' %}`.
3. Preview the duplicate, run the verification below, then publish it.

What the snippet does:
- reads `bref` and `bclid` from the landing URL and checks their format;
- keeps the latest pair for 30 days in `localStorage` (cookie `briyo_ref` as a fallback);
- writes them once per cart to `/cart/update.js` as the private attributes `__briyo_ref` and `__briyo_click`.

It never changes prices or discounts, adds no UI, and fails silently: shopping and checkout continue as before. Browser privacy controls (Safari's ITP, private windows, cleared storage) can shorten or remove the stored pair. That is accepted, and no workaround (fingerprinting and the like) is used.

### Shopify URL redirect (`/r/{id}` on the storefront)
The storefront is Shopify-hosted, so `/r/{id}` has to be a Shopify **URL redirect** to `https://{AFFILIATE_CLICK_HOST}/r/{id}`.
- **How it's created:** the **Set up storefront redirect** action on the Referral card (`affiliate.manage`) does this through the Shopify Admin API. It is the only Shopify write in Briyo OS, it is always explicit, and nothing does it on startup or when a link is created.
- **Scope needed:** it requires the scopes **`read_online_store_navigation`** and **`write_online_store_navigation`**. The current app has only `read_orders`, so the action reports the missing scope instead of working around it.
- **To enable it:** add both scopes to the Shopify app, then reconnect Shopify in Briyo OS. Alternatively, create the redirect by hand in Shopify → Online Store → Navigation → URL redirects.
- **Conflicts:** an existing redirect with another target is refused, not overwritten.

### GoKwik: verification required before relying on attribution
Checkout runs through GoKwik. It has **not** been verified that cart attributes survive GoKwik into the Shopify order's `customAttributes`, and this cannot be reproduced locally. Before relying on attribution:
1. With the snippet live, open `https://briyosupplements.com/r/{a test affiliate's id}`. Confirm you land with `bref` / `bclid` and that `/cart.js` shows the two attributes.
2. Place a real low-value order through the GoKwik checkout.
3. In Shopify admin, check the order's additional details (or the Admin API `customAttributes`) for `__briyo_ref` / `__briyo_click`.
4. Run a Shopify order sync preview in Briyo OS and confirm `newAffiliateAttributions` counts it.

If the attributes do not arrive, click attribution cannot work through GoKwik as it stands. Coupon attribution, in its phase, does not depend on cart attributes.

### RBAC
| Capability | Referral use |
|---|---|
| `affiliate.view` | See link, status, click and attribution summaries (no customer data) |
| `affiliate.manage` | Create / disable the link; set up the storefront redirect |
| `affiliate.verify`, `affiliate.commissions`, `affiliate.payouts` | No referral authority of their own |

The public redirect needs no sign-in and reveals nothing internal.

### Events
- `referral_asset_created`
- `referral_asset_disabled` (with the reason)
- `storefront_redirect_synced`
- `order_attributed`, with the Shopify order name, method and rule version

Clicks are not events; they live in their own table.

### Settings and environment
| Name | Default | Purpose |
|---|---|---|
| `AFFILIATE_CLICK_HOST` | (none) | The click host, e.g. `go.briyo.xyz` |
| `AFFILIATE_STOREFRONT_URL` | `https://briyosupplements.com` | Where clicks land (origin only) |
| `AFFILIATE_LINK_BASE` | `https://briyosupplements.com` | Origin of the displayed public link |
| `AFFILIATE_HASH_SALT` | `HR_IP_HASH_SALT` | Key for the IP / user-agent hashes |
| `affiliate_settings.attribution_window_days` | 30 | Click window, read on every attribution |
| `affiliate_settings.attribution_rule_version` | `v1` | Stored on every attribution |

## Not implemented yet (by design)

- **Coupons:** creating affiliate coupon codes or Shopify discounts. The coupon attribution path exists but has no source yet.
- **Money:** commissions, the commission ledger, approval, refunds and reversals, payouts, payout batches, tax / TDS.
- **Automation:** Shopify order polling, webhooks, theme deployment, DNS / Cloudflare changes, Cloudflare Workers.
- **Attribution extras:** retroactive attribution, attribution corrections, marketing analytics dashboards.
- **Verification follow-ups:** automatic expiry handling or renewal reminders, self-service submission by the professional, other kinds of evidence checks.
- **Interfaces:** an Overview card, the affiliate portal and login, reporting. (The internal admin UI exists since Phase 1C.)
- **Infrastructure:** Cloudflare, DNS, storefront or theme, and GoKwik changes.

See the Phase 0 architecture report for the planned later phases (1B onwards).
