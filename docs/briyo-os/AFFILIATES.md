# Briyo OS: Affiliates (Phase 1A, foundation only)

The affiliate / referral module manages partners such as nutritionists, doctors, influencers and customers who refer orders to the Briyo Supplements storefront. Shopify remains the ecommerce source of truth. Briyo OS will own partner management, verification, attribution, commissions and payouts.

**Phase 1A implements only the identity and configuration foundation.** It adds no routes, no UI and no Shopify integration, and nothing calls it in production yet.

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
`draft`, `pending_verification`, `approved`, `active`, `suspended`, `closed`.

These are valid states only. **No workflow transitions are implemented yet.**

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
- **Not used yet:** no route or page checks these capabilities.

## Not implemented in Phase 1A (by design)

- **Shopify:** financial snapshots, changes to the order query, scopes, discount codes, URL redirects.
- **Referrals:** referral links (`briyosupplements.com/r/…`), the click host, click tracking, codes, links, customer attribution.
- **Money:** attribution, commissions, the commission ledger, refunds and reversals, payouts.
- **Verification:** professional profiles, verification applications, certificate uploads.
- **Interfaces:** the affiliate UI, navigation, Overview module, affiliate portal and login, reporting.
- **Infrastructure:** Cloudflare, DNS, storefront or theme, and GoKwik changes.

See the Phase 0 architecture report for the planned later phases (1B onwards).
