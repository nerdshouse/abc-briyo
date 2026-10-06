# Briyo OS: UI/UX audit (Phase 1)

Baseline: production `cad0feb`. This audit is read-only and covers the whole repository.

## 1. Application structure

- **Stack:** Node 20 and Express (ESM), Postgres on Neon, Cloudflare R2 (private), and a vanilla JS front end with no build step. It runs on one Render service in Singapore.
- **Hosts:** `abc.briyo.xyz` serves the internal app. `careers.briyo.xyz` serves the public careers site, which is host-isolated and handled by the first middleware.
- **Middleware order:** careers host, then body parsers, then public routes (webhooks, `/healthz`, `/readyz`, Shopify callback, `/login`, `/auth/*`), then `requireAuth` (fails closed), then the page and API capability gates, then static files.

**Pages**

| Page | Shell | Branding today |
|---|---|---|
| `/`: cart call board (Support) | sidebar shell | "Briyo Recovery / Abandoned carts" |
| `/dashboard` (admin) | sidebar shell | "Briyo Operations / Overview" |
| `/orders`, `/couriers`, `/destinations` (Logistics) | sidebar shell | "Briyo Operations / Orders & logistics" |
| `/inventory` | sidebar shell | same |
| `/hr/jobs`, `/hr/candidates` | sidebar shell | "Briyo Operations / People & hiring" |
| `/admin` (Members), `/import` (cart import) | **legacy standalone** (styles.css, no sidebar) | "Cart Recovery Board" |
| `/login`, `/no-access` | legacy standalone | "Cart Recovery Board" / "Briyo" |

## 2. Navigation today

- **Copy-pasted sidebar:** all 7 shell pages carry the same hand-written `<aside>`. Only the brand icon, name and subtitle differ.
- **Built two ways:** the static groups (Overview, Carts, Team, Data) are HTML. Logistics, Inventory and HR are injected by `renderOrdersNav()`.
- **Members and Import leave the shell:** both are legacy pages with a "← Back to the board" link.
- **Flat structure:** there is no department hierarchy and no Admin section. "Export report" is a raw CSV link in the nav.

## 3. Departments and modules

| Department | Screens | Roles (capabilities) |
|---|---|---|
| Logistics | Orders (by type and view), order drawer, shipments (create, attach, reserve/release, dispatch), documents, couriers, destinations, Amazon import | viewer (view), operator (+edit), manager (+setup) |
| Inventory | Stock overview, SKU drawer (batches, movements, COA), master SKUs, platform mappings, unmapped SKUs, receive/adjust/transfer, suppliers, warehouses | viewer (view), operator (+move), manager (+catalog) |
| Support | Call board (to call, callbacks, mine, all), cart drawer and history, CSV export; admin: cart import, report | agent and lead (support.work) |
| HR | Jobs, job editor and preview, candidates, application drawer, resume, delete job | manager (hr.view, hr.manage) |
| Admin | Dashboard (operations and recovery analytics), Members, member log | `is_admin` / ADMIN_PHONES |
| Careers (public) | Home, job page and apply, sitemap, robots | none |

## 4. Design system and components

- **Two token sets that conflict:**
  - `ui.css` (shell) is a neutral palette with an ink-black primary.
  - `styles.css` (legacy) uses a green accent, a different `--bg`/`--border`/`--text`, other variable names, and a spacing scale.
- **No type scale or spacing tokens in the shell.** There is one shadow and radii from 8 to 14.
- **Shared JS** (`ui/components.js`): esc, icons, formatting, `metricCard`, `sectionCard`, `barChart`, sparkline, `statusIndicator`, `initShell`.
- **Re-implemented in each page:** `api()` (6 copies), scroll lock (2), drawer open/close (5), Esc handlers (4), date formatters (5 or more).
- **Feedback:** there is no toast. Each page shows feedback inline in its own way.
- **Status colours:** `.status.{new,noresp,callback,recovered,lost}` are cart-status names reused for orders, inventory and HR. The meaning is coupled to cart vocabulary.

## 5. Dashboard today (admin only)

- **Operations half:** needs attention, quick status, recent orders, orders per day, logistics stages, four KPI cards.
- **Recovery half:** queue, operations, trend, activity feed, carts table, pipeline, by caller, who's online, reasons, sources, drop stages, risk, UTM, report.
- **Missing:**
  - HR, Inventory and People have no department summary.
  - There is no non-admin overview.
  - Inventory health is not shown beyond the order "needs attention" list.
- **Integrity notes:**
  - Cart overview panels mix `received_at` windows, `abandoned_at` buckets, and all-time queue counts.
  - Drill-downs are capped at 200 or 500 rows.
  - "Median to first touch" actually measures to the *last* status update.

## 6. Members today

- **`allowed_users`:** phone (PK, the WhatsApp number), name (60 chars), active, is_admin, added_by/at, last_seen_at, legacy role.
- **Missing:** there is no email column, no photo, and no profile page. Members are managed in a legacy table UI, and the log keeps only the last 20 changes.
- **Identity:** a name change affects OTP greetings and the `updated_by` actor names.

## 7. RBAC

- Module roles live in `member_module_roles` and map to capabilities via GRANTS. Admin is a separate flag that grants every capability. The server is the source of truth: `requirePermission`/`requirePage` for routes, plus per-router write gates.
- **Gap to keep in mind:** page access to `/dashboard` is admin-only, enforced server-side by `requireAdminPage`.

## 8. Major inconsistencies

1. **Product name:** five names are in use (Briyo Recovery, Briyo Operations, Cart Recovery Board, Briyo, Briyo Supplements), and the brand icon changes per page.
2. **Two visual systems:** Members, Import, Login and No-access look like a different product.
3. **Verbs:** create actions are labelled "New Shipment", "Create Shipment", "Create Order", "New master SKU", "Add Inventory", "New job", "Add member" and "Add". Destructive actions use "Remove", "Delete permanently", "Remove permanently", "Take out of this shipment" and "Leave out".
4. **Case:** Title Case and sentence case are mixed.
5. **States:**
   - Loading is variously a skeleton, "Loading…" text, or a table row.
   - Empty states are with or without a title.
   - Errors come in three styles.
6. **Drawers:**
   - Two widths.
   - No `role="dialog"`.
   - No focus move or trap.
   - Scroll lock on only 2 of 5 pages.
7. **Breakpoints:** 15 different values across three files.
8. **Mobile:** dashboard, couriers, destinations and members have no mobile list, only tables that scroll sideways.

## 9. Bugs found during the audit (in production)

- **B1:** `orders.js:371` `data-remove-doc=""${d.id}"` and `orders.js:436` `data-detach=""${x.id}"`. The stray quote empties the attribute, so **removing an order document and detaching an order from a shared shipment do not work**.
- **B2:** `getDocument` (lib/orders.js) does not exclude `removed_at`, so a removed order document can still be downloaded by direct URL. Batch documents already exclude removed files.
- **B3:** `/api/carts` computes `callbackTotal` but does not return it. This is minor.

## 10. Database and API changes needed

- **Member profiles:** additive columns on `allowed_users`: `email`, `photo_key`, `photo_mime`, `photo_updated_at`, `profile_completed_at`. Existing rows are preserved, and no photos are invented.
- **Profile API:**
  - `GET/PUT /api/profile` (self)
  - `POST /api/profile/photo` (image, 2 MB)
  - `GET /api/members/:phone/photo` (any signed-in member, so avatars can be shown; private storage, streamed)
  - Admin member edits gain email and photo.
- **Profile gate:** after `requireAuth`, a member with an incomplete profile is sent to `/profile` (pages) or gets 403 `PROFILE_INCOMPLETE` (APIs). Profile, auth, health and webhook routes stay open.
- **`GET /api/overview`:** one aggregate endpoint returning only the sections the caller's capabilities allow, using cheap `COUNT` queries rather than full lists:
  - **Logistics:** today's orders (IST), view counts, orders without a shipment.
  - **Inventory:** cards and unmapped count.
  - **Support:** queue counts.
  - **HR:** open jobs, applications awaiting review, recent hires.
  - **People (admin only):** members by department, incomplete profiles.
- **Fixes:** B1, B2 (B3 is optional).

## 11. Implementation phases (each a separate commit)

| # | Phase |
|---|---|
| 1 | Audit (this document) and bug fixes B1, B2 |
| 2 | Design tokens (one system), shared primitives (api, toast, drawer/modal a11y and scroll lock, status badge, states), one shared sidebar for all pages with grouped IA: Overview / Operations / Customer / People / Admin |
| 3 | Briyo OS rename (product = Briyo OS, the cart department = Support → Cart Recovery) |
| 4 | `/api/overview` and the Overview command centre (role-aware; admin sees everything) |
| 5 | Member profiles: schema, profile API, photo storage, forced completion flow, Members page rebuilt in the shell with profile drawer and completion |
| 6 | Module polish: terminology, states, drawers, tables |
| 7 | Responsive pass (375 → 1440) |
| 8 | Accessibility and performance pass |
| 9 | Tests: profile gate, photo validation, overview auth and data, RBAC matrix, careers isolation; browser checks |

## 12. Risks and regression areas

- **Profile gate:** it would lock every existing member out until they upload a photo. That is intended, but it means rollout day needs everyone ready. The gate must not affect webhooks, health checks, careers, `/auth/*`, or the profile page's own assets. It also breaks existing tests that spawn the server with photo-less fixtures, so those fixtures must be marked complete.
- **Mock/env-admin mode:** env admins without a table row cannot store a profile. The gate is skipped when there is no row.
- **Shared sidebar change:** client-side navigation (`nav.js` SHELL_PATHS) swaps only `<main>` and the overlays. A new shared sidebar must keep that contract.
- **Status colour remap:** the existing class names are used by every page, so remap through new semantic classes and do not rename the old ones in place.
- **Dashboard rewrite:** the existing admin analytics (recovery funnel, report, CSV) must remain reachable.
- **Careers:** must remain untouched, with isolation tests kept.
- **Timezone:** HR stays fixed to IST. Board and orders follow `BOARD_TIMEZONE`, which defaults to Asia/Kolkata. Do not change it globally.
