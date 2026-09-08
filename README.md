# Abandoned Cart Recovery Board — Briyo Supplements

A single-page board that lists abandoned Shopify checkouts and tracks call / WhatsApp
outreach on each one. Status and notes are stored **in your Shopify store**, so the whole
team sees the same data on every device — no external database, no per-browser localStorage.

Access is gated by **WhatsApp OTP login**: you enter your mobile number, receive a one-time
code on WhatsApp via 11za, and only allowlisted numbers can get in.

- **Frontend:** plain HTML / CSS / vanilla JS (no framework, no build step)
- **Backend:** minimal Node + Express, proxies Shopify server-side
- **Storage:** one JSON blob in a Shopify shop metafield (`cart_recovery_board.status_map`)

The Admin API token never reaches the browser.

---

## Quick start

```bash
npm install
cp .env.example .env    # optional — see "Mock mode" below
npm start
```

Open http://localhost:3000.

### Mock mode

If `SHOPIFY_ACCESS_TOKEN` or `SHOPIFY_STORE_DOMAIN` is unset, the board starts in **mock
mode**: five sample carts, an in-memory status map, and a yellow banner saying so. The UI is
fully usable this way, which is handy for styling or a demo before the Shopify app exists.
Status changes in mock mode reset when the server restarts.

---

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | yes (live) | `briyo-supplements.myshopify.com` — no `https://`, no trailing slash |
| `SHOPIFY_CLIENT_ID` | yes (live) | Dev Dashboard app client ID — the current method |
| `SHOPIFY_CLIENT_SECRET` | yes (live) | Dev Dashboard app client secret |
| `SHOPIFY_ACCESS_TOKEN` | alternative | Permanent `shpat_` token, only from a pre-2026 legacy custom app. Takes precedence if set. |
| `SHOPIFY_API_VERSION` | no | Defaults to `2026-07`. Shopify supports each version ~12 months — bump this yearly. |
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

## Shopify setup

### 1. Create the app

**Legacy custom apps can no longer be created.** Since 1 January 2026 the store admin's
"Develop apps" page won't make new ones, so there is no permanent `shpat_` token to copy.
Apps are now created in the **Dev Dashboard** and authenticate with a *client credentials
grant*: the server swaps a client ID and secret for a token that lasts 24 hours and refreshes
it automatically. That's handled for you in `lib/shopify.js` — you only supply the two values.

1. Go to **[dev.shopify.com](https://dev.shopify.com)** → your organization → **Apps** →
   **Create app**.
2. **App settings** → copy the **Client ID** and **Client secret** into `.env` as
   `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`.
3. Set the app's **scopes** (next section), then **install it on the store**.

> The client credentials grant only works when **the app and the store are in the same
> Shopify organization**. Both must appear under the same org in the Dev Dashboard, otherwise
> the token request fails with a permissions error.

If you already have a **legacy custom app from before 2026**, it keeps working: set
`SHOPIFY_ACCESS_TOKEN` to its permanent token instead and skip the client credentials entirely.
The server prefers that variable when it's present.

### 2. Scopes

| Scope | Why |
| --- | --- |
| `read_orders` | Required by the `abandonedCheckouts` query. This is the documented scope. |

Two caveats worth knowing before you hit a wall:

- **`read_orders` only covers the last 60 days of orders.** If you need to read older
  abandoned checkouts, you must also request `read_all_orders`, which Shopify grants only
  after you request access and explain why. For a daily call list, 60 days is plenty.
- **The metafield write has no dedicated scope.** There is no `write_metafields` scope in
  the Admin API. Shopify's rule for `metafieldsSet` is "the same access level needed to
  mutate the owner resource" — and they don't publish a scope name for the `Shop` owner.
  In practice a custom app writing shop-owned metafields on its own store generally works
  with the scopes above. **If it doesn't**, the board surfaces the exact `userErrors` from
  Shopify in the red banner and the server log; see "If saving fails" below.

### 3. Verify

```bash
npm start
```

The log should print `Shopify: live (…) via client credentials (Dev Dashboard app)` rather
than `MOCK MODE`, followed by `Shopify token acquired, valid ~24h` and the scopes Shopify
actually granted — check `read_orders` is among them.
Load the page — if the token or scopes are wrong you'll get a red banner naming the problem.

---

## How it works

| Endpoint | Purpose |
| --- | --- |
| `GET /api/carts` | Abandoned checkouts from the Admin GraphQL API, flattened for the UI |
| `GET /api/status` | The parsed status map from the shop metafield |
| `POST /api/status` | Accepts `{id, status, notes}` (read-merge-write) or a full `{statusMap}` |
| `GET /api/config` | Whether the server is in mock mode, plus the status list |
| `POST /auth/request-otp` | Sends a code to an allowlisted number |
| `POST /auth/verify-otp` | Exchanges a valid code for a session cookie |
| `POST /auth/logout` | Clears the session |
| `GET /auth/me` | Current session state (the only unauthenticated endpoint that returns anything) |

Phone numbers come from `billingAddress.phone`, **not** `customer.phone` — the latter is
almost always null on abandoned checkouts.

The WhatsApp link converts Indian numbers to `wa.me`'s `91XXXXXXXXXX` form: a bare 10-digit
mobile gets `91` prefixed, an already-country-coded number passes through, and a leading
trunk `0` is stripped. Anything else is passed through as digits.

### The concurrency limitation

Status and notes live in **one JSON blob** in a single metafield. A save is a read-merge-write:
the server re-reads the map, updates just the row you touched, and writes the whole thing back.

That means edits to *different* rows are safe, but it is **last-write-wins per row**: if two
people change the same row within a second or two of each other, the later write silently
wins. For a small team working a daily call list this is fine, and deliberately not
over-engineered — there's no locking or version check. If the team grows to the point where
that bites, that's the signal to move the status map to a real database.

### If saving fails

The red banner shows Shopify's own error text and **your in-progress edit stays on screen** —
nothing is discarded, so you can fix the cause and blur the field again to retry. The row
shows `Not saved` until it succeeds.

If the message mentions access or permissions, it's the metafield-scope caveat above. Options,
cheapest first:

1. Re-open the custom app's API config, save it again, and reinstall — scope changes need a reinstall.
2. Add broader scopes (e.g. `write_products`) and retry, to confirm it's a scope issue at all.
3. Fall back to storing the map elsewhere (a small SQLite/Postgres table); only `readStatusMap`
   and `writeStatusMap` in `lib/shopify.js` would need to change — nothing else in the app knows
   where the data lives.

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
4. Add the environment variables: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`,
   `SHOPIFY_API_VERSION`, `ALLOWED_PHONES`, `SESSION_SECRET`, `COOKIE_SECURE=true`,
   `ELEVENZA_AUTH_TOKEN`, `ELEVENZA_TEMPLATE_NAME`. The platform supplies `PORT` itself.
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

- It never writes to orders, customers, or checkouts — the only write is the status metafield.
- It doesn't send WhatsApp messages to customers or place calls; the outreach links just open
  your own apps. The only message it sends is the login OTP, to your own team's numbers.
- It doesn't poll. Click **Refresh** to re-fetch from Shopify.
