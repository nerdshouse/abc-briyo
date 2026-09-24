# ADMIN DASHBOARD V2

The current dashboard is already ordered work-first, which is right. Three things are missing or wrong: **speed is not measured at all**, **recovered revenue is not revenue**, and **attribution is by last edit**.

---

## 1. Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  NEEDS ATTENTION                              all time · ignores range │
│                                                                        │
│   ₹18,420          8              3              6           1         │
│   AT RISK      OVERDUE SLA   CALLBACKS      UNASSIGNED   INGEST        │
│   past SLA                    MISSED                      OK           │
│                                                                        │
│   ₹78,230 open opportunity across 41 carts                             │
└────────────────────────────────────────────────────────────────────────┘

┌─── TODAY ──────────────────────────────────────────────────────────────┐
│  Carts 24 · ₹41,300   Contacted 18 (75%)   Recovered 3 · ₹4,120 (17%)  │
│  MEDIAN FIRST CONTACT  2h 14m        ▲ worse than yesterday (1h 40m)   │
└────────────────────────────────────────────────────────────────────────┘

┌─── SPEED TO FIRST CONTACT ─────────────────────────────────────────────┐
│  under 15 min   ▓                    3 carts    recovered  2  (67%)    │
│  15–60 min      ▓▓▓▓                12 carts    recovered  3  (25%)    │
│  1–6 hr         ▓▓▓▓▓▓▓▓            31 carts    recovered  4  (13%)    │
│  6–24 hr        ▓▓▓▓▓▓▓▓▓▓▓▓        48 carts    recovered  2   (4%)    │
│  over 24 hr     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  116 carts    recovered  6   (5%)    │
│                                                                        │
│  % within SLA (15 min, business hours):  4%                            │
└────────────────────────────────────────────────────────────────────────┘

┌─── FUNNEL ─────────────────────────────────────────────────────────────┐
│  Abandoned 210 → Attempted 209 (99%) → Connected 73 (35%)              │
│                → Recovered 10 (14% of connected)                       │
│  Biggest leak: 136 attempted but never connected                       │
└────────────────────────────────────────────────────────────────────────┘

┌─── CALLERS ────────────────────────────────────────────────────────────┐
│  Caller    assigned  attempts  connected  callbacks  recovered  value  │
│            ──────── ───────── ────────── ────────── ────────── ─────── │
│  Prayag         52       118         41          6          7  ₹9,140  │
│  Janvi           6        14          9          1          2  ₹2,300  │
│                                                                        │
│  median first response:  Prayag 1h 52m · Janvi 3h 10m                  │
└────────────────────────────────────────────────────────────────────────┘
```

Then the existing panels (sources, reasons, risk, activity log, period report) unchanged below.

---

## 2. What is new, and why

### AT RISK and OPEN OPPORTUNITY
Two money figures, both all-time and un-filterable:
- **Open opportunity** — cart value of everything not yet recovered or declined. The size of the prize.
- **At risk** — cart value of everything past SLA with nobody acting. The part being lost right now.

This is the question you said the dashboard should answer immediately, and today it does not answer it at all.

### Speed to first contact
The centrepiece. Shows both **how fast we are** and **whether speed pays**.

**Important caveat to keep on the page:** we cannot answer the second question yet. In the current data only 4 carts have ever been contacted within an hour and none recovered, so the buckets above are illustrative. The panel earns its place precisely *because* the business cannot currently answer this — and it will be answerable within weeks of measuring properly.

### Measuring it honestly
`cart_events` only began on 23 September 2026. Before that, the only timestamp is `status_updated_at`, which is the *last* edit, not the first. So:

- **From 23 Sep forward:** true first-contact time, from the first `cart_events` row.
- **Before 23 Sep:** approximate, labelled as such, from `status_updated_at − received_at`.

Do not blend them silently. The panel should say which period it is describing.

### Business hours
Speed is measured in **business time**, configurable, default 09:00–21:00 IST. A cart abandoned at 01:40 is 0 business-minutes old at 09:00. Without this, 23 of 210 carts are permanently "overdue" for reasons no caller can influence, and the SLA becomes noise. Show elapsed wall-clock separately where it matters.

---

## 3. Fair attribution

**Current:** `statsByCaller` groups by `updated_by` — whoever saved last. A caller who fixes a typo on someone else's recovered cart takes the credit.

**Proposed** — explicit, from `contact_attempts` and new cart columns:

| Field | Meaning |
|---|---|
| `first_contacted_by` | who made the first attempt — the speed metric owner |
| `connected_by` | who first actually spoke to the customer |
| `recovered_by` | who was on the attempt that preceded recovery |
| `recovered_source` | `manual` \| `order_webhook` \| `shopify_match` |

**Report attempts and connections, not "touches".** Counting touches rewards opening carts. Counting *connections* rewards reaching customers, which is the job.

**No leaderboard.** Two callers with wildly different assigned volumes cannot be ranked on absolutes. Show rates and medians side by side and let a human read them.

---

## 4. Recovered value — two numbers, never one

| Number | Definition | Available today |
|---|---|---|
| **Recovery opportunity** | cart value of carts marked recovered | Yes |
| **Verified recovered revenue** | value of the order that actually followed | **No — nothing verifies this** |

Auto-recovery has never fired: `auto_recovery_log` is empty and no cart has a `recovered_order_id`. All 10 recoveries are self-reported.

Until a verification mechanism exists, the dashboard must label the number **"claimed"**. Overstating recovered revenue is the single most damaging thing this dashboard could do.

---

## 5. Analytics worth keeping, and what each answers

| Report | Business question |
|---|---|
| Recovery by time-to-contact | Does calling faster actually work? *(unanswerable today — this is why we measure)* |
| Recovery by abandonment reason | What is checkout doing wrong? *(needs tagging above 0%)* |
| Recovery by cart-value bucket | Should we prioritise big carts at all? |
| Recovery by new vs repeat | Do we treat returning customers differently? |
| Contact rate by hour of day | When should the team actually be calling? |
| Recovery by caller | Coaching, not ranking |

**Dropped from the brief:** by product, by UTM, by payment type, by weekday. Product and UTM split 210 carts into slivers with no statistical meaning; payment type we do not possess; weekday needs months of data. Add them when volume justifies them, not before.

---

## 6. Kept as-is

The action queue with drill-down, the health banner that speaks only when something is wrong, honest partial-data labels, the day/week/month report with CSV, and the activity log. These are working and should not be disturbed.
