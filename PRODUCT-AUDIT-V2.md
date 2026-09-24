# PRODUCT AUDIT V2 — Briyo Cart Recovery Board

Audited 23 September 2026 against the live codebase and the production database (210 carts), plus hands-on use of the running app at desktop and phone widths. Every claim below is traced to code or to a query against real data. Where I could not verify something, I say so rather than asserting it.

---

## 0. The headline

The board's interface is not the main problem. **The operation is a day late.**

```
Time from cart arriving to first human touch        carts    recovered
  under 15 min                                          0            0
  15–30 min                                             1            0
  30–60 min                                             3            0
  1–6 hr                                               13            1
  6–24 hr                                              42            1
  24 hr +                                             151            8
```

**72% of all carts are first touched more than 24 hours after they arrive. Not one cart in the history of this board has been contacted within 15 minutes.** For a product whose value decays in minutes, that single fact outweighs every UI issue in this document.

A second fact frames it: carts arrive around the clock — 23 of 210 between midnight and 3am — and almost nothing is worked in the hour it lands. The team is not idle (only 1 of 210 carts is still `Not called`; 136 are `No answer`). They are working hard, just late.

**I cannot yet prove that calling faster recovers more.** The sample above is too thin — four carts have ever been called within an hour, and none recovered. That is an argument *for* building the instrumentation, not against acting: right now the business cannot answer its most important question.

---

## 1. Current architecture

Single Node/Express process, Postgres (Neon), vanilla JS front end with no build step, deployed on Render's free tier. 29 source files, 8,778 lines, 44 commits.

```
GoKwik ──webhook──┐
Shopify CSV ──────┼──> Express ──> Postgres ──> vanilla JS board (polling, 60s)
Shopify API ──────┘        │
                           ├──> 11za WhatsApp (OTP + ops alerts)
                           └──> hourly timer (stale digest, silence alarm, daily summary)
```

No framework, no queue, no cache, no background worker beyond one `setInterval`. For a three-person team this is the right amount of machinery and I would not change it.

**Schema is imperative** — `ensureSchema()` runs `CREATE TABLE IF NOT EXISTS` plus additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` on every boot. There are no migration files and no rollback path. This has worked so far, but see §12.

---

## 2. Feature inventory

Condensed; the full version is in `Cart-Recovery-Board-Features.pdf`.

34 HTTP endpoints, 9 tables, 4 ingestion paths, 3 scheduled jobs, 42 settings, 60 database checks.

| Area | What exists |
|---|---|
| Ingestion | GoKwik abandoned-cart webhook; GoKwik order-completed webhook; Shopify CSV import; Shopify Admin API polling |
| Caller board | Four queues (To call / Callbacks / Mine / All), search across all history, date range, four sorts, call cards with inline outcome recording |
| Owner view | Action queue with drill-down, today vs yesterday, money split, pipeline funnel, per-caller, sources, reasons, drop stage, risk, UTM, activity log, day/week/month report |
| Access | WhatsApp OTP login, allowlist, caller/admin roles, last-admin guard, rate limiting, global sign-out |
| Alerts | Stale-cart digest, ingestion-silence alarm, daily summary, keep-alive |
| Records | `cart_events` history, activity log, member audit, login audit, webhook failures, auto-recovery log |
| Exports | Board CSV (18 cols), admin report CSV |

---

## 3. Actual user flows

**Caller, as observed:** open board → lands in "To call" sorted biggest-first → scroll → tap Call → phone dialler → return → open the outcome dropdown → pick a status → (if callback) type six date sub-fields → optionally type notes → optionally open reasons and tap pills. No keyboard path, no "next cart", no notion of which cart is most urgent beyond cart value.

**Admin:** open `/dashboard` → read "Needs doing now" → optionally drill into a number → read money and per-caller → read activity log.

**Measured cost of the dominant outcome:** "No answer" is 136 of 210 outcomes (65%). It currently costs a dropdown open plus a selection, round-tripping in ~1.4s. That is the single most repeated action in the product and it is not optimised.

---

## 4. Current database model

`abandoned_carts` is one wide table holding the cart **and** its call state. `cart_events` (added today) is an append-only log of status, note, callback, reason and assignment changes. Supporting tables: `allowed_users`, `member_log`, `system_state`, `webhook_failures`, `login_log`, `auto_recovery_log`, plus `otp_state`.

**Field availability, measured on the real 210 rows:**

| Field | Filled | Verdict |
|---|---|---|
| `phone` | 206/210 | Usable |
| `email` | 210/210 | Usable |
| `city` (in payload, **unmapped**) | 114/134 | **Available and unused** |
| `drop_stage` | 134/210 | Present but see below |
| `drop_reason` | **0/210** | GoKwik sends `drop_off_reasons` as `null` on every payload — not a mapping bug, the data does not exist |
| `risk_flag` | 132/210 | Usable |
| `brand_order_count > 0` | 14/134 | Real but rare (10% repeat) |
| `checkout_url` | 134/210 | GoKwik only; Shopify CSV carries none |
| `payment_methods` (payload) | 130 identical | **Store's enabled methods, not the customer's choice — useless as context** |
| `message_enqueued` (payload) | **134/134 = true** | Constant; carries no information |

---

## 5. Current state transitions

Five statuses: `Not called`, `Called – No answer`, `Callback scheduled`, `Called – Recovered`, `Called – Declined`. Free transitions between any of them — no state machine.

Live distribution: No answer 136, Declined 50, Callback 13, Recovered 10, Not called 1.

**The model conflates three different things** into one field: *where the cart is* (open/closed), *what happened on the last call* (answered/no answer), and *why the customer did not buy* (declined). "Called – Declined" is simultaneously a status and a reason. See §17.

---

## 6. Existing integrations — verified, not assumed

| Integration | Status |
|---|---|
| **GoKwik abandoned-cart webhook** | **Working.** 134 carts ingested, last delivery 34 min before audit, 0 failures in 24h. |
| **GoKwik order-completed webhook** | **Never fired. Zero evidence it exists.** `auto_recovery_log` has 0 rows; 0 carts have a `recovered_order_id`. All 10 "Recovered" carts were marked by hand. |
| **Shopify Admin API** | **Not connected.** OAuth handshake never completed; polling inactive. |
| **Shopify CSV import** | Working — 3 carts imported this way. |
| **11za WhatsApp** | Working for OTP. |

**Consequence:** recovery is 100% self-reported. Nothing verifies that a cart marked Recovered produced an order, and "recovered revenue" is the *abandoned cart's* value, not an order value. This is the weakest link in the entire reporting chain.

---

## 7. What is working well — keep

- **Ingestion reliability.** Defensive parsing, 200-on-failure to avoid retry storms, failures persisted for replay, `COALESCE` upserts that cannot blank a field or clobber a call log. This is genuinely well built.
- **`raw_payload` retention + renormalize.** Mapping mistakes are fixable retroactively. This has already paid for itself once.
- **The conflict guard.** Verified live with two real sessions: a stale save returns 409 with the other person's current state and the typist's text survives. Correct.
- **The four-queue model.** Counts on the buttons, one filter surface. Sound.
- **Honest labelling on the dashboard.** Panels that say "GoKwik carts only — 54 of 57" rather than presenting a partial picture silently.
- **Alert latching.** Three alarms, three independent latches, no notification storms.
- **`db:check`.** 60 assertions against the real database with clean-up. Rare and valuable.

---

## 8. What is confusing

- **Urgency is invisible.** Cart value renders at 18px; cart age at 12.5px grey inside a meta line. The most operationally important number on the card is the least prominent.
- **"Nudged" chip is always true** (134/134). A chip that never varies is decoration.
- **"Payment Page" chip is nearly always true** (129/134). Same problem.
- **Status names leak internal vocabulary.** A caller must translate "did they pick up?" into `Called – No answer`.
- **Five statuses, but three concepts.** See §17.

---

## 9. UX problems (desktop)

Measured at 1440×900 on the live board:

- **Card height 228px → 3.8 cards visible.** A work queue should show more.
- **264px of chrome above the first card.**
- **16 interactive controls per card**, 18 focusable elements. The outcome dropdown is the 4th tab stop, behind three links.
- **The recording form (202px) is nearly as tall as the customer context (142px).** The form dominates the card even though it is used once per cart.
- **No keyboard path.** No shortcuts for the four actions a caller repeats hundreds of times a day.

---

## 10. Caller productivity problems

- **The dominant action is not the fastest.** "No answer" (65% of outcomes) costs the same as every other outcome.
- **Callbacks cost six typed sub-fields** (dd/mm/yyyy/hh/mm/am-pm) with **no presets**. Most callbacks are "this evening" or "tomorrow morning".
- **No "next cart".** After recording an outcome the caller must find the next card themselves.
- **No attempt count.** A caller cannot see they have already rung this person twice. `cart_events` now makes this computable, but nothing surfaces it.
- **Sorting is naive.** "Biggest carts first" means a ₹3,000 cart from four days ago outranks a ₹2,500 cart from seven minutes ago — exactly backwards for a decaying asset.

---

## 11. Admin/dashboard problems

- **Recovered revenue is not revenue.** It is the abandoned cart's value, self-reported, unverified. Presented honestly on the page, but it is still the number the business will quote.
- **Per-caller attribution is by last edit.** `statsByCaller` groups by `updated_by`, which is whoever saved last — not who called, and not who recovered. With three callers it is approximately right; it is not a fair basis for performance review.
- **No speed metric anywhere.** The single most important operational number does not appear on the dashboard.
- **"Where they drop" has almost no signal** — 129 of 134 carts are "Payment Page".
- **No open-opportunity figure.** The dashboard shows counts and money but not "₹X is sitting unattended right now".

---

## 12. Technical debt

- **No migrations, no rollback.** Schema changes are additive `ALTER`s at boot. Adding columns is safe; changing or removing one has no path.
- **~100 lines of dead CSS** styling the retired table board (`table.board`, `.status-cell`, `td::before` card transform, `.cust-email`, `td.stage`).
- **`tr[data-mine="true"]`** — the "this cart is yours" accent stripe targets a `<tr>`; the board renders `<article class="callcard">`. **Silently does nothing.**
- **`.stat-on`** is styled for the dashboard's drill-down cards but never applied — opening a drawer gives no visual anchor.
- **Dead code**: `clearToken()`, `_resetAlertState()`, the unreachable `'Auto-nudged'` status.
- **Two env names for one setting** — `BOARD_TIMEZONE` (db.js) vs `BOARD_TZ` (sla-alert.js); only the first is documented. Harmless today (both default to Asia/Kolkata), latent otherwise.
- **README is 855 lines and stale** on the two sections that changed most.
- **No request sequencing on the client.** Two in-flight `loadAll()` calls resolve last-wins. I saw one anomalous result consistent with this and could not reproduce it deliberately — recording it as a latent risk, not a confirmed bug.

---

## 13. Security / data concerns

Mostly good, three gaps:

- **Good:** PII stripped at ingest (IP, device, session, tax IDs, encrypted billing); OTP hashed with constant-time compare and attempt counted before comparison; webhook secrets compared in constant time; CSV formula injection escaped on the customer export; exports logged; no enumeration on the login page.
- **Gap — report CSV** lacks the formula-injection guard the board CSV has. Low risk (all cells server-computed), trivial to fix.
- **Gap — note text now duplicated** into `cart_events.detail` (300 chars). Deliberate and defensible, but it places customer-adjacent text in a second table outside the redaction story. Worth an explicit retention decision.
- **Gap — login audit has no reader.** Data collected, never inspectable.

---

## 14. Reliability risks

- **Recovery detection has no working mechanism.** The only automated path has never fired. If the team stops marking carts by hand, recovery reporting silently goes to zero and nothing alarms.
- **Free-tier sleeping.** Mitigated by keep-alive, which cannot wake an already-sleeping instance — the client retries with backoff instead. Acceptable.
- **Single instance, in-memory rate limiting.** Fine at this scale; documented as such.
- **Callbacks can leave the queue.** See §15 — I class this as a reliability risk, not a UX nit, because it breaks a promise made to a customer.

---

## 15. Features that exist but are not useful

| Feature | Evidence |
|---|---|
| **"Nudged" chip** | `message_enqueued` is `true` on 134/134 carts. Never varies. |
| **Drop-stage chip and dashboard panel** | 129/134 are "Payment Page". Near-zero discriminating power. |
| **`drop_reason`** | 0/210 populated; GoKwik sends null. Dead column. |
| **Order-completed webhook** | Never fired. |
| **"Mine" queue** | Assignment is concentrated on one caller; the queue reads 0 for everyone else. |
| **Email on the card** | Searchable, never displayed — correct as-is, but the column exists in the export and nowhere else. |
| **Login audit** | Written, unreadable. |

### The callback bug — most severe finding after speed

**Measured live:** there are **14 callbacks** in the database. The board's default 7-day view shows **9**. Switching the range to "Today" shows **5**.

A caller sitting in the Callbacks queue who changes the date range watches four promised callbacks disappear, with no indication they exist. The date window is applied server-side before the queue filter, so any callback on a cart older than the window is simply not loaded.

These are customers who were told "we will call you back."

---

## 16. Features that should be removed

Full reasoning in `REMOVE-OR-SIMPLIFY.md`. Summary: the Nudged chip, the drop-stage chip, the `drop_reason` column, dead CSS and dead functions, the "Mine" queue in its current form, and the speculative order-completed webhook (keep the endpoint, stop presenting auto-recovery as a working feature).

---

## 17. Features that should be redesigned

**Separate the three concepts now conflated in `status`:**

| Concept | Question it answers | Proposed values |
|---|---|---|
| **Cart state** | Is this still open work? | `new`, `attempting`, `callback`, `recovered`, `lost` |
| **Attempt outcome** | What happened on *this* call? | `answered`, `no_answer`, `busy`, `invalid_number` |
| **Abandonment reason** | Why did they not buy? | short standard set (see below) |

Today `Called – Declined` is a state *and* a reason; `Called – No answer` is a state *and* an attempt outcome. Splitting them makes attempt counting, funnel analysis and reason reporting all possible without inventing data.

**Reason taxonomy** — the current 8 tags are reasonable but have never been used (0 carts tagged). Before expanding to reason+subreason, find out why callers do not tag. My hypothesis from using it: the pills sit behind a closed disclosure after the notes field, below the fold on mobile. Fix placement before adding taxonomy depth.

---

## 18. Missing features

Ranked by expected impact on the one metric that matters:

1. **Speed-to-contact measurement and SLA** — currently unmeasured and unmanaged.
2. **Priority ordering that respects decay** — see `CALLER-BOARD-V2.md`.
3. **Attempt tracking surfaced to the caller** — data now exists, nothing shows it.
4. **Callback presets** and a callback queue that cannot be filtered away.
5. **Working-hours awareness** — a cart abandoned at 2am should not read as 7 hours overdue at 9am.
6. **Verified recovery** — a real mechanism for confirming a cart became an order.
7. **Open-opportunity and at-risk money** on the dashboard.
8. **Keyboard shortcuts** for desktop callers.
9. **City** as customer context (available, unmapped).
10. **Customer verbatim field** — distinct from structured reasons.

---

## 19. Mobile usability

Measured on the running app:

| Width | Card height | Cards per screen | Chrome above first card | Horizontal scroll |
|---|---|---|---|---|
| 375px | 462px | **1.7** | **385px** | none |
| 430px | ~430px | ~2.0 | ~385px | none |

- **Nearly half the phone screen is consumed before the first cart appears.**
- **34 touch targets are under 36px**, smallest 13px (reason pills, disclosure summaries, inline links). The Call button is correctly 44px.
- No horizontal scrolling anywhere — the earlier responsive work holds up.

---

## 20. Highest-impact opportunities

In order. The first two are worth more than everything else combined.

1. **Make speed the product's organising principle.** Measure time-to-first-contact, set an SLA in business hours, sort by decaying priority, show a countdown. The board currently sorts by cart value, which actively works against this.
2. **Stop losing callbacks.** Load the callback queue independently of the date window.
3. **Make the dominant action one tap.** 65% of outcomes are "No answer".
4. **Fix recovery verification**, or stop reporting recovered revenue as if it were verified.
5. **Fair attribution** — record who called and who recovered, not who edited last.
6. **Reclaim the phone screen** — 385px of chrome before the first cart, 1.7 cards visible.
7. **Callback presets** — six typed sub-fields is the most expensive interaction in the product.
8. **Delete what carries no information** — the always-true chips, the empty column, the dead CSS.

---

## Appendix — how this was verified

- Live queries against the production database (210 carts) for every statistic quoted.
- Hands-on use of the running app as both a caller and an admin, at 1440px, 430px and 375px.
- An end-to-end workflow on three seeded, clearly-labelled test carts — no answer, callback, and a two-session edit race — all deleted afterwards (verified: 210 carts before and after, cascade confirmed).
- One finding was withdrawn during testing: an apparent search bug turned out to be my own interrupted page reload, and I could not reproduce it deliberately. It is recorded in §12 as a latent risk rather than a bug.
