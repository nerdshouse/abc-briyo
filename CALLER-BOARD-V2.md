# CALLER BOARD V2

Designed against the fields we actually have, verified on 210 production carts. The organising principle is **speed to first contact**, because 72% of carts currently wait over 24 hours.

---

## 1. The priority score

Transparent, deterministic, no ML. Computed in SQL, explainable in one line to the caller.

### Inputs I rejected, and why

| Proposed input | Verdict | Evidence |
|---|---|---|
| Funnel drop stage / "checkout intent" | **Rejected** | 129 of 134 carts are "Payment Page". A signal that is constant cannot rank anything. |
| Whether GoKwik already nudged them | **Rejected** | `message_enqueued` true on 134/134. Constant. |
| Payment method / payment failure | **Rejected** | The payload's `payment_methods` is the *store's* enabled list (identical on 130 carts), not the customer's selection. We do not possess this. Inventing it would be worse than omitting it. |
| Source (GoKwik vs Shopify) | **Rejected as a score input** | Only 3 non-GoKwik carts. Not a ranking signal at this volume. |
| RTO risk | **Kept, small, negative** | High RTO risk means likely to refuse delivery. It is a reason to push prepaid *on the call*, not a reason to call sooner. Slight demotion only. |

### The model

```
priority = value_weight × freshness  +  repeat_bonus  −  attempt_penalty  −  rto_penalty

value_weight   = min(cart_value / 500, 5.0)        ₹500 = 1.0, capped at 5.0
freshness      = 1.00   if business-age <  30 min
                 0.75   if business-age <   2 hr
                 0.45   if business-age <   6 hr
                 0.25   if business-age <  24 hr
                 0.10   otherwise
repeat_bonus   = +1.5   if brand_order_count > 0          (true for 14 of 134 — rare, so meaningful)
attempt_penalty= 0.6 × attempts_so_far                     (from cart_events)
rto_penalty    = 0.3    if risk_flag = 'High Risk'
```

**Callbacks are not scored.** A callback that is due is absolute priority and sits in its own lane above everything. Scoring it would let a big fresh cart outrank a promise made to a customer.

### Why this shape

- **Freshness multiplies rather than adds.** This is what makes the user's example come out right: ₹2,500 at 7 minutes scores `5.0 × 1.00 = 5.0`; ₹3,000 at 4 days scores `5.0 × 0.10 = 0.5`. Ten to one. An additive model would let value swamp age.
- **Value is capped at ₹2,500.** Observed carts run ₹316–₹2,499. Without a cap, one outlier cart would permanently occupy the top of the queue regardless of age.
- **Attempts subtract.** Prevents the same unreachable customer being re-dialled ahead of untouched carts — the mechanism that produces "we called them five times and nobody else at all".
- **Business-age, not wall-clock.** A cart abandoned at 2am is 0 business-minutes old at 9am, not 7 hours overdue. 23 of 210 carts arrived between midnight and 3am, so this is not hypothetical.

### What the caller sees

Never the number. The **reasons**, ranked:

```
HIGH PRIORITY
₹2,499 · 6 min ago
Repeat customer · 3 previous orders

  → freshly abandoned
  → high cart value
  → has ordered before
```

---

## 2. Desktop layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  TO CALL 12   ·   OVERDUE 5   ·   CALLBACKS DUE 3   ·   MINE 4           │
│  ₹28,430 open        median first call 11 min        3 breaching SLA     │
└──────────────────────────────────────────────────────────────────────────┘
  [ search name, phone, email, cart id ]                      All ▾   ⟳

  ── DUE NOW ────────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────────────┐
│ CALLBACK · OVERDUE BY 12 MIN            ₹1,840   Priya Nair              │
│ promised 4:30 pm today · attempt 2                                       │
│ [ CALL ]   WhatsApp  Cart                        No answer  │  Answered ▸ │
└──────────────────────────────────────────────────────────────────────────┘

  ── NEXT BEST ──────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────────────┐
│ NEW · 4 MIN LEFT ON SLA                 ₹2,499   Axit Mehta  ★ repeat    │
│ Vitamin D3 ×2 · Melatonin ×1 · Mumbai                                    │
│ freshly abandoned · high value · ordered 3× before                       │
│ [ CALL ]   WhatsApp  Cart                        No answer  │  Answered ▸ │
└──────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│ OVERDUE BY 2H 10M                       ₹1,299   Ravi Sharma             │
│ Whey Isolate ×1 · Delhi · attempt 1 — no answer 2h ago                   │
│ [ CALL ]   WhatsApp  Cart                        No answer  │  Answered ▸ │
└──────────────────────────────────────────────────────────────────────────┘
```

### What changed and why

| Element | Decision | Reason |
|---|---|---|
| Cart age | **Promoted** to the status line, in the same weight as value | Today it is 12.5px grey; it is the most important operational fact |
| SLA countdown | **Added** — "4 min left" / "overdue by 2h 10m" | Makes speed visible at the moment of choosing |
| Cart value | **Kept prominent** | Still the second-strongest signal |
| Why-ranked line | **Added** | The score must be explainable or callers will not trust the order |
| City | **Added** | Available on 114/134 carts, currently unmapped, genuinely useful on a call |
| Attempt count | **Added** | Prevents duplicate calls; data now exists in `cart_events` |
| Repeat marker | **Kept, promoted** | Rare (10%) therefore meaningful |
| Risk chip | **Kept, demoted** | Real signal, but it changes *how* you sell, not *when* you call |
| Nudged chip | **Removed** | Constant |
| Drop-stage chip | **Removed** | Constant |
| Outcome form | **Collapsed** to two buttons | 65% of outcomes are "No answer" — make it one tap |
| Notes / reasons | **Moved** into the Answered flow | They are only relevant once somebody picked up |
| Owner select | **Removed from the card** | Replaced by implicit ownership on Call |

Card target height: **~120px** desktop (from 228px), **~200px** mobile (from 462px).

---

## 3. The outcome flow

Today: one dropdown with five internal status names, plus four independent fields.
Proposed: two taps for the common case, guided for the rest.

```
        [ CALL ]                    ← pressing this takes ownership automatically
            │
   ┌────────┴────────┐
   │                 │
No answer        Answered ▸
   │                 │
   │         ┌───────┼───────┬──────────┐
   │     Recovered  Callback  Not now   Declined
   │         │        │         │          │
   │         │     [presets]    │      why? (pills)
   │         │   2h · evening   │
   │         │   tomorrow am    │
   └─────────┴────────┴─────────┴──────────┘
                      │
              "Customer said…"  (optional, one line)
                      │
                 SAVE & NEXT →
```

- **The caller never picks an internal status.** The system derives `cart_state` and writes an immutable `contact_attempt`.
- **Reason is asked at the moment the answer is known** — not left as an optional field below the fold, which is why 0 of 210 carts are tagged today.
- **"Customer said…"** is a free-text verbatim, deliberately separate from the structured reason. That is the qualitative data marketing actually wants.

---

## 4. Focus mode — recommended, alongside not instead

A single-cart view reachable by pressing **F** or "Start calling". One cart, full width, the flow above, then `SAVE & NEXT`.

**Recommendation: build it as a second view, not a replacement.** The queue is how you *choose* and audit; focus mode is how you *grind*. Replacing the queue would remove the caller's ability to skip, search, and see what is coming — and with three callers sharing a pool, being able to see the pool matters.

---

## 5. Keyboard (desktop only, focus mode only)

`C` call · `N` no answer · `A` answered · `B` callback · `R` recovered · `J`/`K` next/previous · `/` search.

**Deliberately not global.** Shortcuts on a scrolling list with 18 focusable elements per card is how you get accidental "Recovered". Confined to focus mode, where exactly one cart is addressable and the action is unambiguous.

---

## 6. Mobile

```
┌────────────────────────────────┐
│ TO CALL 12  OVERDUE 5  CB 3    │   ← 48px, sticky
├────────────────────────────────┤
│ OVERDUE BY 2H        ₹1,299    │
│ Ravi Sharma · Delhi            │
│ Whey Isolate ×1                │
│ attempt 1 · no answer 2h ago   │
│                                │
│ ┌────────────────────────────┐ │
│ │        CALL CUSTOMER       │ │   ← 52px
│ └────────────────────────────┘ │
│ WhatsApp    Cart               │
│ ─────────────────────────────  │
│  No answer    │   Answered ▸   │   ← 44px each
└────────────────────────────────┘
```

Targets: chrome above the first card **under 150px** (from 385px); **2.5–3 cards per screen** (from 1.7); every target **≥ 44px** (34 are currently under 36px).

---

## 7. Rejected from the brief

| Idea | Why not |
|---|---|
| Numeric score shown to callers | Invites arguing with the number instead of calling. Show ranked reasons. |
| Reason + subreason taxonomy | Zero carts are tagged today. Adding depth to an unused feature produces a longer form, not better data. Revisit once tagging is above ~50%. |
| Bulk "mark recovered/declined" | Destructive, and recovery is already unverified. Bulk *assign* is safe and can come later if needed. |
| Round-robin auto-assignment | Three callers. A shared queue plus take-on-call solves it without a scheduler or a fairness dispute. |
| Desktop notifications | Notification fatigue for a team sitting in the app all day. The sticky header count is enough. |
| WebSockets | 60s polling is adequate for three users; no measurable benefit. |
