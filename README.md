# Abandoned Cart Recovery Board — Briyo Supplements

A single-page board that lists abandoned carts **received from GoKwik** and tracks call /
WhatsApp outreach on each one. Carts arrive by webhook, are stored in Postgres with their
full original payload, and the whole team sees the same statuses and notes.

Access is gated by **WhatsApp OTP login**: you enter your mobile number, receive a one-time
code on WhatsApp via 11za, and only allowlisted numbers can get in.

- **Frontend:** plain HTML / CSS / vanilla JS (no framework, no build step)
- **Backend:** minimal Node + Express
- **Storage:** Postgres (Neon free tier)
- **Inbound:** GoKwik abandoned-cart webhook

This app is a **passive receiver**. It never calls GoKwik's or Shopify's API, and touches
nothing on the storefront — including the existing GoKwik / Meta pixel setup.

## Quick start

```bash
npm install
cp .env.example .env    # optional — see "Mock mode" below
npm start
```

Open http://localhost:3000.

### Mock mode

If `DATABASE_URL` is unset, the board starts in **mock mode**: five sample carts shaped like
GoKwik's payload, held in memory, with a yellow banner saying so. The UI, the login flow and
the webhook are all fully usable this way — handy before Neon is set up. Everything resets
when the server restarts.

---

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes (live) | Neon Postgres connection string. Unset ⇒ mock mode |
| `WEBHOOK_SECRET` | **yes** | Shared secret GoKwik must send (both webhooks). `openssl rand -hex 32` |
| `SLA_STALE_HOURS` | no | "Not called" for longer than this counts as stale. Default `6` |
| `OPS_PHONE` | no | WhatsApp number for the stale-cart digest. Blank disables it |
| `ELEVENZA_OPS_TEMPLATE_NAME` | no | Approved template for the digest. Unset ⇒ logged, not sent |
| `SLA_ALERT_MINUTES` / `SLA_ALERT_THRESHOLD` | no | Digest cadence and trigger. Default `60` / `1` |
| `KEEPALIVE_MINUTES` / `KEEPALIVE_ENABLED` | no | Self-ping cadence. Default `10` / on |
| `PORT` | no | Defaults to `3000` |
| `ALLOWED_PHONES` | **yes** | Comma-separated numbers permitted to sign in. **Empty means nobody can log in.** |
| `SESSION_SECRET` | **yes** | Signs session cookies and hashes OTPs. `openssl rand -hex 32` |
| `SESSION_TTL_HOURS` | no | How long a login lasts. Defaults to `12` |
| `COOKIE_SECURE` | no | Set `true` when served over HTTPS |
| `ELEVENZA_AUTH_TOKEN` | for live OTP | 11za auth token. Blank ⇒ console mode |
| `ELEVENZA_TEMPLATE_NAME` | for live OTP | Approved template name — `login_otp` |
| `ELEVENZA_ORIGIN_WEBSITE` | for live OTP | Origin website registered on your 11za account |
| `ELEVENZA_LANGUAGE` | no | Template language. Defaults to `en` |
| `ELEVENZA_API_URL` | no | Defaults to `https://api.11za.in/apis/template/sendTemplate` |
| `ELEVENZA_AUTH_HEADER` | no | Only if 11za also wants a header; the token goes in the body |
| `ELEVENZA_PAYLOAD_TEMPLATE` | no | Full body override; see placeholders in `.env.example` |

---

## Login

### How it works

1. Enter a mobile number. If it's on `ALLOWED_PHONES`, a 6-digit code is sent on WhatsApp.
2. Enter the code. On success you get a signed, `HttpOnly` session cookie and land on the board.
3. Everything except `/login` and `/auth/*` requires that cookie — the API returns `401`,
   pages redirect to `/login`.

Protections in place:

| | |
| --- | --- |
| Allowlist | Only numbers in `ALLOWED_PHONES` ever receive a code |
| No enumeration | Known and unknown numbers get a byte-identical response |
| Code lifetime | 5 minutes, single use — verifying consumes it |
| Wrong guesses | 5 attempts, then the code is destroyed |
| Resend cooldown | 60 seconds between sends to one number |
| Hourly ceiling | 5 code requests per number per hour |
| Storage | Codes are stored HMAC-hashed, never in plaintext |
| Comparison | OTP and cookie signature use constant-time comparison |

### Console mode

With `ELEVENZA_AUTH_TOKEN` unset, no WhatsApp message is sent — the code is **printed to the
server log** and the login page says so. The whole flow is testable this way with no 11za
account, which is how it was developed.

### Wiring up 11za

`POST https://api.11za.in/apis/template/sendTemplate` with this body — note the auth token
goes in the **body**, not a header:

```json
{
  "authToken": "…",
  "name": "Asha",
  "sendto": "919812345678",
  "originWebsite": "https://www.briyosupplements.com//",
  "templateName": "login_otp",
  "language": "en",
  "data": "482913"
}
```

`data` carries the OTP; `name` comes from `ALLOWED_PHONES` (see below). Everything is driven
by env vars, so you can adjust any field without editing code.

Send one real message and read 11za's raw reply (the token is redacted in the output):

```bash
npm run otp:probe -- 9812345678
```

If your template has more than one body variable, or is an **authentication-category**
template with a *copy code* button (those often need the OTP repeated as a button parameter),
override the whole body with `ELEVENZA_PAYLOAD_TEMPLATE` — the placeholders are listed in
`.env.example`.

**Check `ELEVENZA_ORIGIN_WEBSITE` character for character.** It's set to
`https://www.briyosupplements.com//` — with the trailing double slash, exactly as supplied.
That looks like a typo, but 11za may match it literally against what's registered on your
account, so it was left as given rather than "corrected". If sends fail with an origin or
domain error, try it with a single trailing slash and with none.

### Adding or removing people

Use the **Members** page at `/admin` — the link appears in the board header for admins only.

Add someone by name and mobile number and they can sign in immediately; there's no password
to send them, just their number and a one-time code on WhatsApp. Each row shows their role,
when they last signed in, and who added them. Every change is logged with who made it.

From each row you can:

| | |
| --- | --- |
| **Rename** | Click the name and type. Saves on Enter or blur, Escape cancels — the same idiom as the notes field on the board. The name is what the OTP message greets them by. |
| **Make admin / Make caller** | Promote or demote. Admins manage members; callers only work the board. |
| **Deactivate / Reactivate** | Blocks sign-in but keeps the record and their history. |
| **Change** (next to the number) | Moves them to a new number, keeping name, role and when they were added. Their old sign-in history stays under the old number — rewriting an audit trail to match the present is how audit trails stop being useful. |
| **Remove** | Deletes the row entirely. |

Changing a number is a move, not an edit — phone is the primary key — so it runs in a
transaction and refuses cleanly if the new number already belongs to someone.

**Only admins can manage members.** Everyone else works the board and never sees the page —
otherwise the allowlist stops being a boundary, since any caller could grant access to anyone.

**Removal takes effect within a minute**, not at session expiry. Membership is re-checked on
each request (cached ~60s), so "Remove" actually removes access rather than blocking only the
next login. `SESSION_EPOCH` remains the instant, everyone-at-once lever.

#### The ADMIN_PHONES safety net

Numbers in `ADMIN_PHONES` are admins regardless of the table, and **the panel refuses to
demote, deactivate or remove them** — it would leave that person with admin rights but no way
to sign in. Change the environment variable instead. They show as *env admin* with no action
buttons.

This exists because member management lives in the database: without a way to grant admin from
outside it, one bad edit could leave nobody able to fix it.

The panel also refuses any change that would leave **no active admins at all**.

#### Or by SQL

The table is still the source of truth if you'd rather not use the UI:

```sql
-- see who can log in
SELECT phone, name, active, added_at FROM allowed_users ORDER BY added_at;

-- add someone (phone must be the normalised 91XXXXXXXXXX form)
INSERT INTO allowed_users (phone, name) VALUES ('919812345678', 'Asha');

-- revoke access, keeping the record
UPDATE allowed_users SET active = false WHERE phone = '919812345678';

-- or remove entirely
DELETE FROM allowed_users WHERE phone = '919812345678';
```

Changes take effect on the **next login attempt** — no restart, no deploy.

`name` is what the WhatsApp message greets them by, so the OTP reads "Hi Asha" rather than
"Hi Team". Revoking someone blocks new logins immediately; an existing session survives until
it expires (`SESSION_TTL_HOURS`, default 12h).

#### Emergency logout and audit

Sessions are stateless signed cookies, so deactivating someone in `allowed_users` blocks new
logins but leaves their existing session valid until it expires (`SESSION_TTL_HOURS`, 12h).

**Bump `SESSION_EPOCH`** to kill every token instantly. It's baked into each token, so changing
it invalidates all of them — a global logout for one env-var change, no session store and no
per-request database read. Per-user revocation isn't worth a session table for a team this size.

Every login attempt — success, wrong code, non-allowlisted number — is written to `login_log`
with the IP. Render's logs rotate, so this is the only durable record of who signed in.

`POST /auth/request-otp` is unauthenticated, so it's also capped per-IP (`OTP_IP_LIMIT`,
default 10/hour) on top of the existing per-phone limit. The damage from abuse is burnt 11za
credits and a flagged WhatsApp sender, not compute.

#### The ALLOWED_PHONES fallback

`ALLOWED_PHONES` still exists as a **bootstrap**. On startup, if `allowed_users` is empty, it's
seeded from that variable. It's also the fallback if the table is unreadable, so a database
problem can't lock everyone out of the board.

Once the table has rows, the env var is ignored — **editing `ALLOWED_PHONES` will no longer
change who can log in.** Use SQL.

The startup log says which source is live and lists the loaded numbers masked to their last
four digits:

```
Allowed logins (allowed_users table): 3 — Asha:...0125, Ravi:...0829, Priya:...3426
``` Removing a number blocks new logins immediately;
an existing session dies when it expires (`SESSION_TTL_HOURS`, default 12h).

---

## The GoKwik webhook

### The URL to give GoKwik

GoKwik's Custom Webhook screen accepts only a receiving HTTPS URL — there is no field for
custom headers — so the shared secret travels in the query string:

```
https://abc.briyo.xyz/api/webhook/gokwik/abandoned-cart?secret=<WEBHOOK_SECRET>
```

Generate the secret with `openssl rand -hex 32` and set it as `WEBHOOK_SECRET`.

**Treat that whole URL as a credential** — it grants write access to the cart table. Don't
paste it into shared docs or tickets. To rotate: change `WEBHOOK_SECRET`, redeploy, then
update the URL in GoKwik's dashboard.

An `X-Webhook-Secret` header is also accepted, which is handy for `curl` testing.

Before handing the URL over, confirm it's live:

```bash
curl https://abc.briyo.xyz/api/webhook/gokwik/abandoned-cart
# -> {"ok":true,"message":"GoKwik abandoned-cart webhook receiver. POST here."}
```

### What it does with a delivery

- **Authenticates** the shared secret in constant time, `401` if wrong or missing.
- **Parses defensively.** The body is read as raw text and parsed by hand, so even a malformed
  delivery is stored rather than rejected by a JSON parser before the handler runs.
- **Deduplicates on `request_id`.** GoKwik retries; a repeat delivery updates the existing row
  instead of creating a second one. **An existing call status and notes are never overwritten
  by a retry** — only cart fields are refreshed, and only when the new payload actually has a
  value for them.
- **Keeps the full payload** in a `raw_payload` JSONB column, always.
- **Returns 200 even when the database write fails**, logging the payload. Webhook senders
  retry aggressively on non-2xx, and a retry storm is worse than reading logs.

### Field mapping

Key matching ignores case, spaces, underscores and hyphens, so `Customer Name`,
`customer_name` and `customerName` are the same key. GoKwik's report CSV and their webhook
JSON don't spell things identically, and this way both map.

| GoKwik field | Column |
| --- | --- |
| `ID` / `request_id` | `cart_id` (dedupe key) |
| `Customer Name` | `customer_name` |
| `Phone Number` | `phone` |
| `Email ID` | `email` |
| `Amount` | `total_price` |
| `MRP Total` | `mrp_total` |
| `Discount Total` | `discount_total` |
| `Abandoned Cart Link` / `abc_url` | `checkout_url` |
| `Created At` | `abandoned_at` |
| `Drop Stage` | `drop_stage` |
| `Drop Off Reasons` | `drop_reason` |
| `Risk Flag` | `risk_flag` |
| `Utm Source` | `utm_source` |
| `Customer Address` | `address` |
| `Line items` | parsed for display, kept in `raw_payload` |

Everything else — UTM campaign/medium, landing page, discount codes, customer type, platform,
exit discounts, remarks — stays in `raw_payload` and can be surfaced later without
re-collecting anything.

**Identity fields are read only from identity-bearing blocks.** GoKwik's `shipping` object is
the shipping *method* and contains `name: "Free Shipping"` and its own `price`. Both have
hijacked a field in production — the customer's name and the cart total — because those keys
are generic. Name, phone and email now search `customer` / `billing_address` /
`shipping_address` and never `shipping`, `totals` or `session`, and explicit `firstname` /
`lastname` are preferred over a bare `name`. The fixture used by `db:check` carries that trap
deliberately.

**Two GoKwik-specific quirks the parser handles:**

- **Dates are `D/M/YYYY h:mm AM/PM` with no timezone.** `7/9/2026` is 7 September, not
  9 July — `new Date()` would read it the American way and file carts two months out. They're
  parsed explicitly and treated as IST.
- **`Line items` is a single string**, `#Product(Variant)*2#Other(Variant)*1`, not an array.
  It's split on `#`, quantity read from `*N`, and the variant extracted by scanning for the
  matching bracket from the end — product names themselves contain brackets
  (`All Around Gut Guardian (Box) - …`), which defeats a plain regex. Where the variant just
  repeats the product name, only the variant is shown.

**If columns come through blank on real events**, that's a mapping gap, not data loss:

```sql
SELECT id, received_at, raw_payload FROM abandoned_carts ORDER BY received_at DESC LIMIT 5;
```

Add the real key names to the relevant array in `lib/normalize.js` and redeploy. Old rows can
be backfilled from `raw_payload` afterwards.

## Working a call list

### Callbacks

Setting a row to **Callback scheduled** reveals a date+time picker inline. Once set, the row
shows a badge: **Overdue** (red) when the time has passed, **Due today** (amber) otherwise, or
the scheduled time in grey. Sort by **Callback due soonest** and use the **Overdue callbacks**
toggle to work just those.

Moving a row to any other status clears its callback, so a stale reminder can't keep showing
as overdue after the cart is closed.

### Reason tags

Alongside the free-text notes, each row takes tags from a fixed vocabulary — Price objection,
Shipping time, Out of stock, Already purchased elsewhere, Not interested, Changed mind,
Product doubt/question, Other. They're stored in a `reason_tags TEXT[]` column and aggregated
in the **Why they abandoned** panel, which is the feedback loop for product and marketing.

The list is fixed deliberately: free text can't be counted. Anything that doesn't fit goes in
the notes field next to it.

### Who did what

Every status or note change records the signed-in user's name automatically from their
session — nobody picks it from a dropdown. Rows read *"Last updated by Priya, 2h ago"*, and
the **By caller** panel shows carts touched, recovered, recovery rate and recovered value per
teammate over the selected range.

### SLA alerting

Carts still at **Not called** after `SLA_STALE_HOURS` (default 6) are counted on every
dashboard load and shown as a red **Stale — never called** card.

An hourly job sends one WhatsApp digest to `OPS_PHONE` when the count crosses
`SLA_ALERT_THRESHOLD` — one message per run, never one per cart, and only when the backlog has
**grown** since the last alert, so an uncleared backlog doesn't re-alert every hour.

> **This needs its own 11za template.** Their API sends approved templates, not free text, so
> the digest requires `ELEVENZA_OPS_TEMPLATE_NAME` pointing at a template with a single body
> variable. Reusing `login_otp` would deliver "Your OTP is *4 carts have been sitting…*".
> **Without that variable set, the digest is written to the server log instead of being sent** —
> the feature degrades rather than misfires. Set `OPS_PHONE` blank to disable it entirely.

## Backfilling after a mapping fix

`raw_payload` is the source of truth, so a mapping bug is always recoverable:

```bash
npm run db:renormalize                      # dry run — shows exactly what would change
npm run db:renormalize -- --backup --apply  # snapshot the table, then write
npm run db:renormalize -- --redact --apply  # also strip PII keys from stored payloads
npm run db:renormalize -- --id=42           # one row
```

It re-derives **only** the mapped columns (`DERIVED_COLUMNS` in `lib/db.js`) and never touches
`status`, `notes`, `callback_at`, `reason_tags`, `updated_by` or `recovered_*` — a backfill
must not be able to erase a call log, and `db:check` asserts exactly that. Being a pure
function of `raw_payload`, running it twice is a no-op.

It deliberately does **not** reuse `insertCart`: that path is `COALESCE`-based so a webhook
retry can never blank a field, which also means it can never *correct* a wrong one. The two
write semantics are separate on purpose.

Rows whose body never parsed (`_unparsed_body`) are skipped rather than normalised to nulls.

### PII redaction

`REDACTED_KEYS` in `lib/normalize.js` strips `ip`, `user_agent`, `session_id`,
`shopifysessionid`, `domain_userid`, `gst_details_enc`, `mapped_email_*` and
`billing_address_details_pii` **before storage**. Everything `normalizePayload` reads is kept,
so backfill still works — `db:check` proves this by asserting the derived fields are identical
before and after redaction.

## Order-completed webhook (auto-recovery)

**Status: built, but not yet receiving anything.** GoKwik has to be asked to send this event —
same situation as the missing cart link on the abandoned-cart webhook.

```
POST https://abc.briyo.xyz/api/webhook/gokwik/order-completed?secret=<WEBHOOK_SECRET>
```

Same shared secret as the abandoned-cart webhook, so nothing new to configure on our side.

**What to ask GoKwik for:** whichever event they fire on a successful order / confirmed
payment — the counterpart to the abandoned-cart event you already have. The exact event name
and payload shape are unconfirmed, so field extraction is best-effort across plausible key
names and the full body is stored in `raw_payload` regardless. A payload missing a phone,
email or order id logs a **warning**, not an error, and still returns `200`.

On arrival it matches open carts by the **last 10 digits of the phone** or by **email**, and:

- upgrades **Not called**, **No answer**, **Callback scheduled** → **Called – Recovered**
- **never touches a manually-set Declined or Recovered cart** — a human's judgement wins
- records `updated_by = "Auto (GoKwik order match)"`, the order id/name and a timestamp
- writes an audit row to `auto_recovery_log` so a false match can be traced and reversed

To review or reverse auto-matches:

```sql
SELECT l.matched_at, l.order_name, l.matched_on, c.cart_id, c.customer_name, c.phone
FROM auto_recovery_log l JOIN abandoned_carts c ON c.id = l.cart_row_id
ORDER BY l.matched_at DESC;
```

## How the board handles volume

The date range is applied **server-side**, so the browser only ever holds one window's worth
of carts and every other filter and sort stays client-side over that array. That's deliberate:
paging would break value-sorting, the stats totals and the risk-then-value call ordering, which
are the point of the board.

`total` and `truncated` come back with every response, so the UI can say *"showing 500 of
1,240 — narrow the date range"*. The previous behaviour was an unconditional `LIMIT 500` that
silently dropped the oldest rows once volume passed it.

**Search ignores the window entirely** — "that customer from three weeks ago just rang back" is
the case it exists for. It matches name, email, cart id, and phone on digits only, so
`98123 45678` and `+919812345678` both hit. Escape clears it.

### Assignment

Each row has an **Owner** column. Pick a teammate from the dropdown, or hit **Take it** to
claim it yourself in one tap — the common case, and the whole point: three people working one
list otherwise ring the same customer.

Filter with **Assigned to me** or the assignee dropdown (which includes **Unassigned**, for
picking up what nobody has taken). Your own rows are marked with a green edge.

Assignment is stored as the member's **phone**, with the display name resolved at read time,
so renaming someone in the admin panel updates every cart they own rather than leaving stale
copies behind. Only active members can be assigned, so a cart can never be owned by someone
who can't sign in to see it.

Deliberately *not* a lock: assignment never blocks anyone from editing a row, and there's no
expiry to deadlock on when someone shuts their laptop. The 409 conflict guard remains the thing
that stops two people overwriting each other.

### What GoKwik already sent

Rows show a **GoKwik: msg sent / email sent** badge and a **Repeat buyer** count, read from
`message_enqueued`, `abc_email_sent` and `brand_order_count` in the payload.

This matters more than it looks: GoKwik runs its own recovery flows (and integrates Gupshup and
Limechat). Right now **every live cart has `message_enqueued: true`** — the customer has already
been messaged before anyone picks up the phone. A caller who knows that opens differently, and
it's the concrete reason this board sends nothing to customers automatically.

### Export

**Export CSV** downloads the current view — same date range or search, no `raw_payload`, and
nothing the board doesn't already show. Exports are logged with who ran them; it's the largest
data-egress path in the app and it carries customer PII.

Values starting `=`, `+`, `-` or `@` are prefixed with an apostrophe so an exported note can't
execute as a formula when someone opens it in Excel.

### Staying in sync

The board reloads every 60 seconds so a teammate's change appears without a manual refresh.
It skips the reload while a field is focused or a search is active — pulling data out from
under someone mid-sentence is exactly what the conflict guard exists to prevent.

### Save conflicts

Each save sends the `status_updated_at` the client last saw. If someone *else* has saved since,
the server returns `409` and the board says who — your text stays on screen, and saving again
goes through deliberately. Your own successive edits never conflict.

This is not row locking, and deliberately so: for a three-person team the cost of a locking
model (claims, expiry, release, "why can't I edit this") outweighs the occasional duplicate
call. The 409 only guards the genuinely destructive case — silently overwriting someone's notes.

## Is the board broken?

```bash
curl "https://abc.briyo.xyz/readyz?secret=<WEBHOOK_SECRET>"
```

Returns database version, cart count, how long since the last webhook, whether ingestion has
gone silent, the stale-cart count, and webhook failures in the last 24h. **`healthy` is the
one field to read first.**

This is deliberately separate from `/healthz`, which stays dependency-free: the keep-alive
pinger hits that one, and a database blip must never make the instance look unhealthy and stop
being kept warm.

### The silence alarm

If GoKwik stops sending, every other signal gets *quieter* — the stale-cart backlog drains and
the SLA alert stops firing, which looks identical to a team that has cleared its list. Nothing
else in the system would notice.

So an independent check runs on the same hourly timer: if no cart has arrived for
`INGEST_SILENCE_HOURS` (default **8**), one WhatsApp goes to `OPS_PHONE`. It has its own latch
separate from the stale-cart alert, re-alerts at most every 6 hours so a weekend outage doesn't
message hourly, and re-arms automatically when ingestion resumes.

The 8h default is measured, not guessed: the largest genuine gap in production so far is 3.3h
(overnight), and this store takes orders through the night.

"Never received anything" is deliberately **not** silence — a fresh deployment shouldn't alarm.

### Failed deliveries

The webhooks return `200` even when the database write fails, because GoKwik retries on non-2xx
and a retry storm is worse than a log dive. That used to mean the only record was Render's
rotating logs. Failures are now persisted to `webhook_failures` with the original body, counted
on `/readyz`, and replayable once the cause is fixed.

## Database

Create a free project at [neon.tech](https://neon.tech), copy the **pooled** connection string
(the host contains `-pooler`), and set it as `DATABASE_URL`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

Use the pooled string because Render may run more than one instance, each with its own
connection pool; Neon's pooler keeps that within the connection limit.

Two tables are created automatically on first use — `abandoned_carts` and `otp_state`. There's
no migration step.

**Verify the wiring in one command** once `DATABASE_URL` is set:

```bash
npm run db:check
```

It exercises every database path against the real database — insert, dedupe-on-retry,
status update, retry-preserves-status, and the full OTP create/verify/replay/cooldown cycle —
then deletes its own test rows. Run this before pointing GoKwik at the URL.
With `DATABASE_URL` unset the app runs in **mock mode** on in-memory sample data, so the UI,
login and webhook are all testable before Neon exists.
---

## How it works

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/webhook/gokwik/abandoned-cart` | shared secret | **Give this URL to GoKwik.** Receives cart events |
| `GET /api/webhook/gokwik/abandoned-cart` | none | Liveness check — confirms the URL is reachable |
| `GET /healthz` | none | Uptime-pinger target; touches no database |
| `GET /readyz?secret=` | shared secret | Diagnostics: DB, last webhook age, stale count, failures |
| `GET /api/carts?days=&q=` | session | Carts in the date window, or a search across all history |
| `POST /api/status` | session | `{id, status, notes}` — updates one row |
| `GET /api/config` | session | Mock-mode flag, status list, reason tags, SLA hours |
| `POST /api/webhook/gokwik/order-completed` | shared secret | Auto-marks matching carts Recovered — **not yet enabled by GoKwik** |
| `GET /api/carts.csv?days=&q=` | session | CSV of the current view, no `raw_payload` |
| `GET /admin` | **admin** | Member management page |
| `GET/POST /api/members`, `PATCH/DELETE /api/members/:phone` | **admin** | Add, rename, promote, deactivate, remove |
| `GET /api/reasons/summary?days=` | session | Reason-tag counts over the window |
| `GET /api/stats/by-caller?days=` | session | Per-teammate activity |
| `POST /auth/request-otp` | Sends a code to an allowlisted number |
| `POST /auth/verify-otp` | Exchanges a valid code for a session cookie |
| `POST /auth/logout` | Clears the session |
| `GET /auth/me` | Current session state (the only unauthenticated endpoint that returns anything) |

Phone numbers come from GoKwik's `customer.phone`, falling back to any address block in the
payload.

The WhatsApp link converts Indian numbers to `wa.me`'s `91XXXXXXXXXX` form: a bare 10-digit
mobile gets `91` prefixed, an already-country-coded number passes through, and a leading
trunk `0` is stripped. Anything else is passed through as digits.

### The concurrency limitation

Each save is a single-row `UPDATE`, so edits to different rows never interfere. Within one
row it is **last-write-wins**: if two people change the same cart within a second or two, the
later write wins silently. There's no locking or version check, deliberately — for a small
team working a daily call list that's the right trade.

### If saving fails

The red banner shows the server's error text and **your in-progress edit stays on screen** —
nothing is discarded, so you can fix the cause and blur the field again to retry. The row
shows `Not saved` until it succeeds.

If it mentions the database, check `DATABASE_URL` and that the Neon project isn't suspended
(free-tier projects idle out and take a few seconds to wake — the first request after that can
time out, the second succeeds).

---

## Deploying

Target domain: **`abc.briyo.xyz`**.

Hosted on **Render's free tier** — no credit card, custom domain, managed TLS, and a deploy on
every push to `main`. Config is in [`render.yaml`](render.yaml).

1. **Neon** — create the database first and copy the **pooled** connection string.
2. Render dashboard → **New** → **Blueprint** → connect `nerdshouse/abc-briyo`. It reads
   `render.yaml` and prompts for the five secret values:
   `DATABASE_URL`, `WEBHOOK_SECRET`, `SESSION_SECRET`, `ELEVENZA_AUTH_TOKEN`, `ALLOWED_PHONES`.
3. **Settings → Custom Domains** → add `abc.briyo.xyz`, then create the `CNAME` Render shows
   you. TLS is issued automatically.
4. Run `npm run db:check` locally against the same `DATABASE_URL` before going live.

### The one real catch: sleeping

**A free service sleeps after 15 minutes without traffic and takes about a minute to wake.**
For a webhook receiver that matters: if GoKwik posts a cart while the service is asleep, the
request may exceed their timeout.

Two things make this survivable, and one fixes it:

- The webhook is **idempotent** — it deduplicates on `request_id`, so if GoKwik retries a
  timed-out delivery, you get one row, not two.
- The webhook **returns 200 even when the database write fails**, so a slow start never
  triggers a retry storm.
- **It keeps itself warm.** The server pings its own public URL every 10 minutes
  (`lib/keepalive.js`), using `RENDER_EXTERNAL_URL`, which Render injects automatically. No
  external cron account, no configuration. `/healthz` is public, touches no database, and
  returns only `{ok, ts}`.

  | Variable | Default | Purpose |
  | --- | --- | --- |
  | `KEEPALIVE_ENABLED` | on | Set `false` to turn it off |
  | `KEEPALIVE_MINUTES` | `10` | Interval; must be under 15 to beat the idle timeout |
  | `KEEPALIVE_URL` | `RENDER_EXTERNAL_URL` | Override the target, e.g. to use the custom domain |

  **What this cannot do is wake a sleeping instance** — a sleeping instance isn't running to
  fire its own timer. It only prevents sleep in the first place. If the service ever does go
  down for long enough to sleep, the next visitor (or GoKwik delivery) pays the wake-up cost
  once and it stays warm after that. An external pinger like
  [cron-job.org](https://cron-job.org) is still the more robust belt-and-braces option, and
  the two can run together harmlessly.

### Watch the instance-hour budget

A free workspace gets **750 instance-hours per month across all free services**. The keep-alive
holds this service awake 24/7, which uses about **730** — it fits, but only just, and only for
*one* service. A second free service in the same workspace will exhaust the quota and Render
suspends **everything** until the next month. Keep this workspace to this one service.

If you need the headroom, set `KEEPALIVE_ENABLED=false` and accept the cold starts, or move to
a paid instance.

If the sleeping is intolerable or 730 hours is too tight, Render's cheapest paid instance
removes both limits.

### Give GoKwik the webhook URL

Once either option is live and `npm run db:check` passes:

```
https://abc.briyo.xyz/api/webhook/gokwik/abandoned-cart?secret=<WEBHOOK_SECRET>
```

Confirm it's reachable first — this needs no secret and no login:

```bash
curl https://abc.briyo.xyz/api/webhook/gokwik/abandoned-cart
```

### Why the OTP state is in Postgres

Render restarts and sleeps instances freely, and may run more than one. If OTP codes and
rate-limit counters lived in memory:

- a code issued by one instance would be unverifiable on another;
- a restart or a spin-down between "send code" and "enter code" would drop the pending code
  entirely — and free services spin down after 15 minutes, which is shorter than some people
  take to find their phone.

So `otp_state` is a Postgres table. Sessions don't need it — they're stateless signed cookies,
valid on any instance and across restarts. This is the one thing that must not be reverted to
in-memory storage.

## What this app does not do

- It never calls GoKwik's or Shopify's API. It only receives, and touches nothing on the
  storefront — including the existing GoKwik / Meta pixel setup.
- It doesn't message customers. The outreach links open your own apps; the only automated
  messages are the login OTP and the ops digest, both to your own team's numbers.
- It doesn't poll or push. New carts appear on the next **Refresh**.

## Status

**Working end to end in production:** GoKwik abandoned-cart ingestion, dedupe-on-retry,
WhatsApp OTP login, allowlist, the call board, callbacks, reason tags, caller attribution,
stale-cart card, custom domain with TLS, self keep-alive.

**Built but waiting on GoKwik:**

| | |
| --- | --- |
| Order-completed webhook | Endpoint is live at `/api/webhook/gokwik/order-completed`. GoKwik must be asked to send their order-success event to it. Until then, "Recovered" stays a manual status. |
| Cart recovery link | **Resolved.** Live payloads include `abc_url` and `checkout_url`; only GoKwik's *test* payload omitted them. |
| `Drop Stage` / `Risk Flag` | **Resolved.** Live payloads send both — `drop_stage` and `rto_risk_flag`. |

**Needs one setup step before it works:**

| | |
| --- | --- |
| Stale-cart WhatsApp digest | Needs an approved 11za template (`ELEVENZA_OPS_TEMPLATE_NAME`) and `OPS_PHONE`. Until then the digest is logged, not sent. The on-screen stale card works regardless. |

**Deliberately not built:** the automated first-touch customer nudge. See the note in the
project history — it needs an approved marketing template, an opt-out path, and a decision
about DND/consent before it should send anything to a customer.
