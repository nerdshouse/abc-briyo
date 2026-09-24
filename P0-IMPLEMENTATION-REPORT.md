# P0 IMPLEMENTATION REPORT

Branch `p0-correctness`, 12 files, +268 / −140. **Not deployed. Not merged. Not committed to `main`.**

All six P0 items implemented and verified against source, the production database, and the running app in a browser.

---

## Files changed

| File | Why |
|---|---|
| `lib/db.js` | callbacks escape the date window; canonical timezone |
| `lib/csv.js` | new shared `csvCell` / `toCsv` helpers |
| `lib/sla-alert.js` | canonical timezone; removed `_resetAlertState()` |
| `lib/shopify-oauth.js` | removed `clearToken()` |
| `lib/mock.js` | removed unreachable `'Auto-nudged'` |
| `server.js` | both CSV exports use one helper; `BOARD_TZ` deprecation warning; `boardTimezone` in `/api/config` |
| `public/app.js` | callback states, ordering, range disabling, board timezone |
| `public/dashboard.js`, `dashboard.html` | recovery relabelled |
| `public/styles.css` | ownership stripe re-pointed; 64 dead rules removed |
| `scripts/db-check.js` | 2 new regression tests; 2 existing tests tightened |
| `.env.example` | `BOARD_TZ` documented as deprecated |

## Database migrations

**None.** Every change is code-only.

---

## 1. Callbacks never disappear

**Before.** The date window was applied server-side before the queue filter, so a callback on a cart older than the window was never loaded. Measured live: **14 callbacks existed; the 7-day default showed 9; "Today" showed 5.** A caller sitting in the Callbacks queue who changed the range watched four promised callbacks vanish, with nothing to tell them.

**After.** `listCarts` returns carts in the window **or** in `Callback scheduled`, whatever the range:

```sql
WHERE (received_at >= <window> OR status = 'Callback scheduled')
```

Recovered and declined carts are not in that status, so a closed cart cannot be dragged back in. `total` still counts the window alone — it is what the "N carts from the last 7 days" line describes — and a separate `callbackTotal` is returned so the two are never conflated.

**Verified at the data layer:**

| Range | Carts loaded | Callbacks visible |
|---|---|---|
| Today | 20 | **12** |
| 3 days | 22 | **12** |
| 7 days | 63 | **12** |
| All | 210 | **12** |

**Verified in the browser:** `Callbacks 11` at every range (count differs from the table above only because the team worked the board between runs).

**Date range control.** Chose option A — it is **visually disabled** inside the Callbacks queue, with the title "Callbacks are shown whatever the date range", and the result note reads *"11 callbacks, all time … The date range does not apply here."* A live-looking control that silently changes nothing is precisely how the original bug stayed hidden: the count moved, so it looked like it was working.

**Callback states**, all in `BOARD_TIMEZONE`, verified by seeding one cart per state (all received 20 days ago, i.e. outside every window):

| Seeded | Rendered | Order |
|---|---|---|
| −18 min | `Overdue 19 min` | 1 |
| +2 min | `Due now` | 2 |
| +42 min | `In 41 min` | 3 |
| today 18:30 | `Today 6:30 pm` | 4 |
| tomorrow 11:00 | `Tomorrow 11:00 am` | 5 |
| no time set | `No time set` | 6–16 |

Ordering is ascending by `callback_at`, which gives overdue → due now → upcoming naturally.

**One judgement call.** Carts whose callback time was never set (11 of them) initially sorted to the *top*. I moved them to the **bottom**: they need fixing, but a promise already broken outranks a data-entry gap, and putting eleven of them above a genuinely overdue call buries the actual work.

---

## 2. Timezone unified

**Before.** `lib/db.js` read `BOARD_TIMEZONE`; `lib/sla-alert.js` read `BOARD_TZ`; `.env.example` documented only the first. Setting the documented name alone would have left the evening digest on a different calendar day from every number it links to.

**After.** Both resolve `BOARD_TIMEZONE || BOARD_TZ || 'Asia/Kolkata'`. `BOARD_TZ` is kept only so an existing deployment does not shift its day boundaries on upgrade, is documented as deprecated in `.env.example`, and **warns at boot**:

```
BOARD_TZ is deprecated — rename it to BOARD_TIMEZONE. It is still honoured,
but only BOARD_TIMEZONE is documented.
```

Verified: warning fires with `BOARD_TZ` set and `BOARD_TIMEZONE` unset; silent otherwise.

The board also now receives `boardTimezone` from `/api/config` and formats callback times with it, so a laptop set to UTC still reads the same "today 6:30 pm" the SLA, reports and digest mean. Previously the client used browser-local time.

---

## 3. Report CSV formula injection

**Before.** The board export escaped `= + - @`; the report export had no guard at all — two implementations, one of them unsafe.

**After.** One `csvCell` / `toCsv` in `lib/csv.js`, used by both.

**I fixed a bug in the original guard rather than copying it.** The obvious regex `/^[=+\-@]/` also mangles every negative number into `'-100`, which is wrong in a column of figures. A value that parses as a finite number cannot be a formula, so numbers are exempt.

| Input | Output |
|---|---|
| `=cmd\|/c calc` | `"'=cmd\|/c calc"` |
| `+1+1` | `"'+1+1"` |
| `@SUM(A1)` | `"'@SUM(A1)"` |
| `-100` | `"-100"` — intact |
| `-12.5` | `"-12.5"` — intact |
| `say "hi"` | `"say ""hi"""` |

Live report CSV confirmed: `"2026-09-23","11","7586.92",…` — numbers unquoted-prefix, formulas guarded.

---

## 4. Recovery labelling

**Before.** "Recovered value" read as revenue. It is the abandoned cart's value, recorded by hand, with nothing verifying an order followed. `auto_recovery_log` is empty and no cart has a `recovered_order_id`.

**After.** Every occurrence is now **"Recovered cart value"** — dashboard money panel, today panel, per-caller table header. Zero occurrences of "recovered revenue" remain. The Money panel carries the explanatory line, bold but not dominant:

> **Recovered cart value is the abandoned cart value at the time of abandonment. It is not verified order revenue.** Recovery is recorded by hand and nothing yet checks it against a real order.

Tooltips on the cards repeat the definition.

---

## 5. Ownership indicator — and what it actually revealed

**The CSS bug.** `tr[data-mine="true"]` targeted a table row; the board renders `<article class="callcard">`. The rule matched nothing, so callers had no marker for their own carts.

**Fixed** by re-pointing to `.callcard[data-mine="true"]`. Verified live: 11 owned cards render `inset 3px 0 0 rgb(31,111,74)`. Left at the original subtlety — a 3px stripe, not restyled.

**The `Mine 0` question — investigated, not a bug.**

| Owner | Carts |
|---|---|
| Prayag Patel | **209** |
| unassigned | 1 |
| Janvi Patel | 0 |
| Axit Mehta | 0 |

The query is correct: Janvi and Axit genuinely own nothing. **No assignments were manufactured.** This is an operational fact, not a defect — and worth a decision separately: ownership is concentrated on one caller, which is why the queue is empty for the other two.

---

## 6. Dead code removed — verified, nothing speculative

| Removed | Verification |
|---|---|
| `clearToken()` | Only its definition existed in the entire repo |
| `_resetAlertState()` | Only its definition existed |
| `'Auto-nudged'` | Present in `AUTO_UPGRADABLE` in `db.js` and `mock.js`, absent from `VALID_STATUSES` — unreachable |
| 56 CSS rules | `.status-cell`, `.cust-name`, `.cust-email`, `.when-rel`, `.when-abs`, `td.owner`, `td.items`, `td.stage`, `button.stat.stat-on` — all zero references in HTML/JS |
| 8 CSS lines | `table.board` column widths |

**A mistake I caught and corrected.** The automated pass removed `.cust-email, .muted { … }` — a rule bundling a dead selector with a live one, which silently killed `.muted` styling across every page. I restored it as `.muted { … }` and then audited all six live classes that lost rules; the other five losses were scoped to the dead container (`.status-cell .saved` etc.) and are genuinely dead.

**Deliberately left.** The `@media (max-width:760px)` block still contains table-board rules **entangled with live ones** — `.links a { min-height: 44px }` is the mobile Call target. Separating them needs visual verification at three widths, which is P4 work, not a correctness phase. I annotated the block rather than risk the mobile layout. Similarly `button.stat.stat-alarm:hover, …stat-on` was left: the `:hover` half is live.

---

## Tests

`scripts/db-check.js`: **61 → 63 checks, all passing.**

**New:**
- *callbacks survive every date range* — a callback promised today on a cart received 20 days ago must be visible at `days=1,3,7,0`; and once it stops being a callback, the window must exclude it again (so the fix cannot degrade into "the window stopped working").
- *CSV export neutralises formulas without mangling numbers* — 8 cases through `csvCell`, plus `toCsv` asserting a guarded formula and an intact negative.

**Two existing tests tightened.** *"ranges are calendar days"* and *"date window is applied server-side"* began failing — correctly. They set a date on the shared test cart but never pinned its **status**, and by the time they ran an earlier step had left it in `Callback scheduled`, which is now deliberately exempt. Both now pin `status = 'Called – No answer'` so they test the date boundary rather than the callback rule. A third failure (*"an imported cart is received now"*) was a cascade: the second test threw before its reset line, leaving `received_at` 30 days old. Fixing the first two fixed it.

**Browser verification** — against the running app on the production database:

| Check | Result |
|---|---|
| Callbacks at 1/3/7/all days | 11 at every range |
| Five callback states + ordering | all correct, board timezone |
| Range control in Callbacks queue | disabled, explained |
| 1280px / 375px / 390px / 430px | no horizontal scroll at any width |
| Call button | 44px on mobile |
| Ownership stripe | renders on 11 owned cards |
| Conflict guard, two real sessions | 409 — *"Janvi Patel changed this row while you were editing."* |
| Board CSV | intact, BOM present |
| Report CSV | guarded, numbers unmangled |
| Dashboard | no "revenue" phrasing; caveat present; all sections render |
| Board after CSS cull | card background, muted text, items, call button all correct |

**Test data.** Five labelled callback carts (`ZZ-CB-DELETEME-*`) were seeded to exercise the five states, then deleted. Database confirmed at **210 carts before and after, zero test rows remaining.**

---

## Rollback

```bash
git checkout main          # branch is unmerged; production is untouched
```

No migrations, no data written, no deploy. If only one item needed reverting, each is a self-contained commit on the branch.

---

## Not done, deliberately

- **Phase 2 (speed to contact)** — not started, awaiting approval as instructed.
- **The entangled mobile CSS block** — see item 6.
- **Assignment concentration** — surfaced, not changed. Manufacturing assignments to make "Mine" look useful would have been the wrong fix.
