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

Edit `ALLOWED_PHONES` and restart. Entries are either a bare number or `Name:number` — the
name is passed to the template as `name`, so the message reads "Hi Asha" rather than "Hi Team".
Numbers are normalised, so `9812345678`, `+91 98123 45678` and `09812345678` are all the same
person. Removing a number blocks new logins immediately;
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

| GoKwik field | Column |
| --- | --- |
| `request_id` | `cart_id` (dedupe key) |
| `customer` (name / phone / email) | `customer_name`, `phone`, `email` |
| `totals.total` (falls back to `subtotal` / `grand_total`) | `total_price` |
| `currency` | `currency` |
| `item_count` (falls back to summing `items[].quantity`) | `item_count` |
| `abc_url` | `checkout_url` |
| `created_at` | `abandoned_at` |

`address`, `shipping`, `discounts`, `items` and `session` aren't given columns, but are kept
in `raw_payload` — line-item names on the board are read from there. The parser also probes
alternative key names and looks one level inside envelopes like `data` / `payload` / `cart`,
so a payload that differs from the documented shape still maps.

**If columns come through blank on real events**, that's a mapping gap, not data loss:

```sql
SELECT id, received_at, raw_payload FROM abandoned_carts ORDER BY received_at DESC LIMIT 5;
```

Add the real key names to the relevant array in `lib/normalize.js` and redeploy. Old rows can
be backfilled from `raw_payload` afterwards.

## Database

Create a free project at [neon.tech](https://neon.tech), copy the connection string, and set
it as `DATABASE_URL`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

The `abandoned_carts` table is created automatically on first use — there's no migration step.
With `DATABASE_URL` unset the app runs in **mock mode** on in-memory sample data, so the UI,
login and webhook are all testable before Neon exists.
---

## How it works

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/webhook/gokwik/abandoned-cart` | shared secret | **Give this URL to GoKwik.** Receives cart events |
| `GET /api/webhook/gokwik/abandoned-cart` | none | Liveness check — confirms the URL is reachable |
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

Any host that runs a long-lived Node process and holds env vars works. This app deliberately
does **not** fit serverless-with-no-disk platforms any worse or better than a VM — it keeps no
local state at all, so pick whatever's cheapest.

Target domain: **`abc.briyo.xyz`**.

**Render / Railway**

1. Push this repo to GitHub.
2. New → **Web Service** → connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Add the environment variables: `DATABASE_URL`, `WEBHOOK_SECRET`, `ALLOWED_PHONES`,
   `SESSION_SECRET`, `COOKIE_SECURE=true`, `ELEVENZA_AUTH_TOKEN`, `ELEVENZA_TEMPLATE_NAME`,
   `ELEVENZA_ORIGIN_WEBSITE`. The platform supplies `PORT` itself.
5. Add the custom domain `abc.briyo.xyz` in the platform's domain settings, then create the
   `CNAME` record it gives you at your DNS provider. Both Render and Railway issue the TLS
   certificate automatically once DNS resolves.
6. Deploy. Every push to `main` redeploys.

Set **`COOKIE_SECURE=true`** for this domain — it's served over HTTPS, and without that flag
the session cookie is sent unprotected. `trust proxy` is already enabled, so the app sees the
real protocol behind the platform's load balancer.

**A small VM**

```bash
git clone <your-repo> && cd cart-recovery-board
npm install --omit=dev
# put the env vars in /etc/environment, a systemd unit, or a .env file
npm start
```

Run it under systemd or pm2 so it restarts on reboot, and put nginx/Caddy in front for TLS.

### Before you expose it publicly

The board is behind OTP login, so it's safe to put on a public hostname — but two settings
matter:

- **Serve it over HTTPS and set `COOKIE_SECURE=true`.** Without TLS the session cookie
  travels in the clear. Render and Railway terminate TLS for you; on a VM use Caddy or nginx.
- **Set a real `SESSION_SECRET`.** Without one the server generates a random secret per
  process, which logs everyone out on each restart and breaks entirely across multiple instances.

**Run a single instance.** OTP codes and rate-limit counters are held in memory, so with two
or more instances behind a load balancer a code issued by one is unverifiable on another.
Sessions themselves are stateless signed cookies and would scale fine — it's only the
short-lived OTP state that pins this to one process. If you ever need to scale out, move the
`pending` and `requestLog` maps in `lib/otp.js` to Redis; nothing else changes.

---

## What this app does not do

- It never calls GoKwik's or Shopify's API. It only receives, and touches nothing on the
  storefront — including the existing GoKwik / Meta pixel setup.
- It doesn't send WhatsApp messages to customers or place calls; the outreach links just open
  your own apps. The only message it sends is the login OTP, to your own team's numbers.
- It doesn't poll or push. New carts appear on the next **Refresh**.
