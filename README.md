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
| `WEBHOOK_SECRET` | **yes** | Shared secret GoKwik must send. `openssl rand -hex 32` |
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

The allowlist lives in the **`allowed_users` table**, so changing the team needs no redeploy.
Run these in the Neon console:

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
| `GET /api/carts` | session | Stored carts, newest first |
| `POST /api/status` | session | `{id, status, notes}` — updates one row |
| `GET /api/config` | session | Mock-mode flag and the status list |
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
- **Keep it warm.** Point a free uptime pinger at `/healthz` every 10 minutes:

  | | |
  | --- | --- |
  | URL | `https://abc.briyo.xyz/healthz` |
  | Interval | 10 minutes |
  | Service | [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com), both free |

  `/healthz` is public, touches no database, and returns only `{ok, ts}`.

### Watch the instance-hour budget

A free workspace gets **750 instance-hours per month across all free services**. Keeping one
service awake 24/7 uses about **730**, which fits — but only just, and only for *one* service.
A second free service in the same workspace will exhaust the quota and Render suspends
**everything** until the next month. Keep this workspace to this one service.

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
- It doesn't send WhatsApp messages to customers or place calls; the outreach links just open
  your own apps. The only message it sends is the login OTP, to your own team's numbers.
- It doesn't poll or push. New carts appear on the next **Refresh**.
