# REMOVE OR SIMPLIFY

Every recommendation below is backed by a measurement against the production database or by using the running app. Nothing here is removed on taste.

---

## Remove outright

### 1. The "Nudged" chip
**Evidence:** `message_enqueued` is `true` on **134 of 134** GoKwik carts. `abc_email_sent` is `false` on all 134.
**Why it must go:** a chip that is present on every card carries zero information. It costs a line of chip space on every card on every screen, and it trains callers to ignore the chip row — which is where genuinely varying signals (risk, repeat) live.
**Replace with:** nothing on the card. Keep the underlying fields; if GoKwik's behaviour ever varies, revisit.

### 2. The drop-stage chip on the card
**Evidence:** 129 of 134 carts are "Payment Page". Three are "Payment Pending", one "payment failed", one "Address Page".
**Why:** it is effectively constant, so it cannot help a caller choose or prepare. Note also the casing inconsistency (`payment failed` vs `Payment Page`) — GoKwik is not normalising this.
**Keep where it is still useful:** the dashboard panel, but relabelled honestly as "almost all carts drop at payment" rather than presented as a distribution with signal.

### 3. The `drop_reason` column
**Evidence:** 0 of 210 rows populated. GoKwik sends `drop_off_reasons: null` on every single payload.
**Why:** it is a dead column that implies we know something we do not. This is *not* a mapping bug — I checked the raw payloads.
**Action:** stop mapping it; leave the column in place (dropping it needs a migration path that does not exist) but remove it from the export and any UI that implies it exists.

### 4. Dead CSS and dead functions
**Evidence:** `table.board`, `.status-cell`, `.cust-name`, `.cust-email`, `.when-rel`, `td.owner`, `td.items`, `td.stage` and the `td::before { content: attr(data-label) }` mobile transform — roughly 100 lines — style a table that no longer exists. `clearToken()` and `_resetAlertState()` are exported and never called. `'Auto-nudged'` is in the auto-upgrade list but not in the valid status set, so it matches zero rows forever.
**Why:** it makes the CSS file misleading to the next person and hides live rules among dead ones.

### 5. `tr[data-mine="true"]` accent stripe
**Evidence:** the rule targets a table row; the board renders `<article class="callcard">`.
**Why:** it is not "styling to remove" so much as **a feature that silently stopped working** — callers have no visual marker for their own carts. Either delete the rule or re-point it at `.callcard`. I recommend re-pointing (see `CALLER-BOARD-V2.md`).

---

## Simplify

### 6. The "Mine" queue
**Evidence:** assignment is concentrated on a single caller; the queue renders `Mine 0` for everyone else.
**Why it is not working:** ownership is being set by import defaults and one person taking carts, not by a workflow. A queue that is empty for two of three users is dead weight in the primary control.
**Recommendation:** keep ownership, change when it is acquired — a caller pressing **Call** takes the cart automatically. Then "Mine" becomes "what I have already started", which is a real queue. Do not build round-robin auto-assignment: with three callers it adds a scheduler and a fairness argument to solve a problem that a shared queue already solves.

### 7. The outcome dropdown
**Evidence:** "No answer" is **136 of 210** outcomes (65%). Every outcome currently costs the same: open a `<select>`, choose an option.
**Recommendation:** promote the two dominant outcomes to direct buttons (`No answer`, `Answered →`), leave the rest behind the secondary path. Optimise the 65% case to one tap.

### 8. The callback date-time field
**Evidence:** a native `datetime-local` requiring **six typed sub-fields** (dd/mm/yyyy/hh/mm/am-pm), with zero presets. It is the most expensive interaction in the product, and it is on the path of a promise made to a customer.
**Recommendation:** three preset buttons — **In 2 hours · This evening · Tomorrow morning** — plus the existing picker for anything else. Presets resolve against business hours.

### 9. The reason pills
**Evidence:** **0 carts have ever been tagged** with a reason, despite eight tags existing and the dashboard having a panel to display them.
**Diagnosis from using it:** the pills sit behind a closed disclosure, *below* the notes textarea, which on a 375px screen is below the fold of an already 462px-tall card. The feature is effectively invisible at the moment of use.
**Recommendation:** fix placement before touching taxonomy. Move reason capture into the outcome flow — it is asked at the moment the caller knows the answer, not as an optional afterthought. Do **not** add reason+subreason yet: adding depth to a feature with zero adoption will not produce data, it will produce a longer form nobody fills.

### 10. Date range on the board
**Evidence:** 14 callbacks exist; the 7-day default shows 9; "Today" shows 5.
**Recommendation:** the range should apply to *browsing* (All / recent history), never to work queues. Callbacks and overdue carts load independently of it. This is a correctness fix, not a preference.

### 11. Chrome above the first card
**Evidence:** 264px on desktop, **385px on a 375px phone** — nearly half the screen before any work is visible.
**Recommendation:** collapse the title and subtitle on mobile, merge the summary line into the queue header, and move the date range behind the search affordance. Target under 150px on a phone.

---

## Do not remove — considered and kept

| Thing | Why it stays |
|---|---|
| **The conflict guard** | Verified working with two real sessions. It is the only thing preventing one caller's notes being silently replaced. |
| **`raw_payload` retention** | Has already paid for itself once by making a mapping fix retroactive. |
| **The stale banner** | It is an alarm, it is un-filterable by design, and that design is correct. |
| **Honest partial-data labels** | "GoKwik carts only — 54 of 57" is the kind of thing that keeps a dashboard trustworthy. |
| **CSV export** | One click, already logged, unblocks every ad-hoc question. |
| **60-second polling** | For three users this is correct. WebSockets would add a connection lifecycle to solve nothing measurable. |
| **Search ignoring the queue** | Deliberate and right — the reason to search is the customer who just rang back. |
| **Order-completed webhook endpoint** | Keep the endpoint (it is harmless and may yet be wired up). **Stop presenting auto-recovery as a working feature** until a delivery is observed. |
