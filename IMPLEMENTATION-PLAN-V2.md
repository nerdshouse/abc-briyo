# IMPLEMENTATION PLAN V2

Ordered by impact on time-to-first-contact, which is the metric the audit shows is failing. Nothing here has been built — this is for approval.

Every item lists: problem, solution, files, DB, risk, test, rollback.

---

## P0 — Correctness. Ship first, separately, this week.

### P0.1 Callbacks disappear from the queue
**Problem.** Measured live: 14 callbacks exist, the 7-day default shows 9, "Today" shows 5. The date window is applied server-side before the queue filter, so any callback on an older cart is never loaded. A caller watches promised callbacks vanish when they change the range. These are customers who were told we would ring back.
**Solution.** Load work queues independently of the browsing window: `/api/carts` gains `include=callbacks,overdue`, always returning those regardless of `days`. The range keeps applying to "All".
**Files.** `lib/db.js` (`listCarts`), `server.js` (`/api/carts`), `public/app.js` (`loadAll`, mode counts).
**DB.** None.
**Risk.** Low. Slightly larger payload.
**Test.** Assert the callback count is identical across `days=1,3,7,0`; extend `db:check`.
**Rollback.** Revert the commit; no data written.

### P0.2 Stop reporting unverified revenue as revenue
**Problem.** `auto_recovery_log` is empty, no cart has a `recovered_order_id`, all 10 recoveries are hand-marked. The dashboard presents cart value as recovered revenue.
**Solution.** Relabel to **"claimed recovery"** everywhere, add `recovered_source` defaulting to `manual`, and surface "0 of 10 verified" on the dashboard.
**Files.** `lib/db.js`, `public/dashboard.js`, `public/dashboard.html`.
**DB.** `ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovered_source TEXT` — additive.
**Risk.** None technically; it makes a number look worse, which is the point.
**Rollback.** Revert; column is harmless if left.

### P0.3 Report CSV formula-injection guard
**Problem.** The board CSV escapes `= + - @`; the report CSV does not.
**Files.** `server.js` (`/api/admin/report.csv`) — reuse the existing helper from `lib/csv.js`.
**Risk.** None. **Test.** Existing CSV check extended. **Rollback.** Trivial.

### P0.4 Timezone env name mismatch
**Problem.** `BOARD_TIMEZONE` (db.js) vs `BOARD_TZ` (sla-alert.js); only the first documented. Latent: setting the documented one alone moves the daily summary's day boundary away from every other number.
**Solution.** Read both, prefer `BOARD_TIMEZONE`, single shared constant.
**Files.** `lib/db.js`, `lib/sla-alert.js`, `.env.example`. **Risk.** None. **Rollback.** Trivial.

### P0.5 Re-point the "mine" accent stripe
**Problem.** Rule targets `tr[data-mine]`; the board renders `article.callcard`. Silently dead.
**Files.** `public/styles.css`. **Risk.** None.

---

## P1 — Speed to first contact. The reason this audit exists.

### P1.1 Contact attempts as immutable events
**Problem.** `cart_events` records *changes*, not *attempts*. "How many times did we ring this person" is inferred from status transitions, which is not the same thing — a caller who dials and gets no answer twice in a row produces one status change.
**Solution.** New table, written when the caller presses Call and when they record an outcome.

```sql
CREATE TABLE IF NOT EXISTS contact_attempts (
  id          BIGSERIAL PRIMARY KEY,
  cart_id     BIGINT NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL,
  caller      TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'call',      -- call | whatsapp
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome     TEXT,                               -- answered|no_answer|busy|invalid_number
  outcome_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS contact_attempts_cart_idx ON contact_attempts (cart_id, attempt_no);
CREATE INDEX IF NOT EXISTS contact_attempts_caller_idx ON contact_attempts (caller, started_at DESC);
```

**Migration.** Additive only. **Backfill is deliberately not attempted** — pre-existing status changes cannot be resolved into attempts without inventing them. Attempt history starts from deployment, stated on screen, same discipline as `cart_events`.
**Rollback.** `DROP TABLE contact_attempts` — nothing else reads it until P1.3.
**Risk.** Low. One extra insert per call.
**Test.** Press Call → attempt row with `outcome NULL`; record outcome → same row completed; second call → `attempt_no = 2`; delete cart → cascade.

### P1.2 Business-hours clock and SLA
**Problem.** 23 of 210 carts arrive between midnight and 3am. Wall-clock ageing makes them permanently overdue and the SLA meaningless.
**Solution.** `businessMinutesBetween(a, b)` pure helper; configurable `BUSINESS_HOURS` (default 09:00–21:00 IST). SLA in business minutes, default 15.
**Files.** new `lib/business-time.js`, `lib/db.js`, `server.js`.
**DB.** None — computed.
**Risk.** Medium: this changes what "overdue" means. Ship behind a config flag showing both clocks for one week.
**Test.** Pure unit cases across a night boundary, a weekend, and a same-day gap.

### P1.3 Priority ordering with decay
**Problem.** "Biggest carts first" ranks a 4-day-old ₹3,000 cart above a 7-minute-old ₹2,500 one.
**Solution.** The scoring model in `CALLER-BOARD-V2.md`, computed in SQL as a generated expression in `ORDER BY` (not a stored column — it changes every minute).
**Files.** `lib/db.js` (`listCarts`), `public/app.js` (sort options), `public/styles.css`.
**Risk.** Medium — it changes what callers see first. Ship as a new sort option **"Smart order"**, default it after a week of the team using it by choice.
**Test.** Fixture carts asserting the documented ordering, including the ₹2,500-fresh vs ₹3,000-stale case.

### P1.4 SLA countdown on the card
"4 min left" / "overdue by 2h 10m", in the status line at full weight. Age moves from 12.5px grey to a first-class element.
**Files.** `public/app.js`, `styles.css`. **Risk.** None. **Rollback.** CSS/markup revert.

### P1.5 Queue health header
Replace `58 carts · ₹33,766` with: To call · Overdue · Callbacks due · Open value · Recovered today · Median first contact.
**Files.** `public/index.html`, `app.js`, `server.js` (extend `/api/carts` summary). **Risk.** None.

---

## P2 — Caller workflow throughput

### P2.1 Two-tap outcome
**Problem.** 65% of outcomes are "No answer" and cost the same as everything else.
**Solution.** `No answer` and `Answered ▸` as direct buttons; the guided flow behind `Answered`. Internal status derived, never chosen.
**Files.** `public/app.js`, `styles.css`, `server.js` (accept outcome verbs, map to status server-side).
**Risk.** Medium — this is the interaction the team has muscle memory for. Ship to one caller first.
**Test.** Every outcome path produces the correct status and exactly one attempt row.

### P2.2 Callback presets
`In 2 hours · This evening · Tomorrow morning`, resolved against business hours, picker retained for anything else.
**Files.** `public/app.js`, `styles.css`. **Risk.** Low. **Test.** Each preset resolves correctly across a day boundary.

### P2.3 Reason capture inside the outcome flow
**Problem.** 0 of 210 carts tagged. The pills are behind a closed disclosure, below the notes, below the fold on a phone.
**Solution.** Ask at the moment the caller knows — inside `Answered`. Plus one optional **"Customer said…"** verbatim line, distinct from the tags.
**DB.** `ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS customer_said TEXT` — additive.
**Risk.** Low. **Measure:** tagging rate weekly. If it stays near zero, the problem is not placement and we stop investing.

### P2.4 Take-on-call ownership
Pressing Call assigns the cart to the caller if unassigned. Removes the owner dropdown from the card.
**Files.** `public/app.js`, `server.js`. **Risk.** Low. **Rollback.** Restore the select.

### P2.5 Focus mode + keyboard
One cart at a time, `SAVE & NEXT`, shortcuts confined to this view only.
**Risk.** Medium if shortcuts leak into the list view — they must not. **Test.** Assert no shortcut handler is bound outside focus mode.

---

## P3 — Admin analytics

- **P3.1 Speed panel** — buckets, SLA attainment, recovery by bucket, with the pre/post-23-Sep data caveat on screen.
- **P3.2 Open opportunity / At risk** — two money figures, all-time.
- **P3.3 Fair attribution** — `first_contacted_by`, `connected_by`, `recovered_by`, `recovered_source`; report attempts and connections, not touches. *(additive columns)*
- **P3.4 Funnel** — abandoned → attempted → connected → recovered, only stages the data supports.

---

## P4 — Polish and removal

- Delete dead CSS (~100 lines), `clearToken()`, `_resetAlertState()`, `'Auto-nudged'`.
- Remove the Nudged and drop-stage chips (constant, per `REMOVE-OR-SIMPLIFY.md`).
- Map `city` onto the card (available on 114/134, currently unused).
- Mobile chrome reduction: 385px → under 150px; touch targets to 44px.
- Rewrite the two stale README sections.
- A reader for the login audit, or stop writing it.

---

## Sequencing and safety

**Branch.** `git checkout -b v2-recovery-queue`. Nothing lands on `main` without review; P0 can ship to production independently since each item is self-contained.

**Migration discipline.** Every change above is an additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` or a new table, consistent with how this schema already evolves. No column is dropped, renamed or retyped, so rollback is always "revert the code, leave the column". The one new table drops cleanly.

**Backfill.** None of the new tables are backfilled. History starts at deployment and the UI says so — the same discipline used for `cart_events`, and the honest choice given the old data cannot be resolved into attempts.

**Test plan.** Extend `scripts/db-check.js` (currently 60 assertions) rather than introducing a second framework. New assertions: attempt creation and numbering, business-time across a night boundary, priority ordering fixtures, callback visibility across every range, outcome-verb mapping, CSV injection on the report, cascade deletes.

**Manual pass before each ship:** the workflow I ran for this audit — seed labelled carts, work them through no-answer/callback/recovered, two-session edit race, mobile at 375/390/430 — then delete them.

**Rollout.** P0 to everyone immediately. P1.3 and P2.1 to one caller for a week before the team, because they change muscle memory. Measure median time-to-first-contact before and after; if it does not move, the plan was wrong and we should say so.
