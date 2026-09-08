# Abandoned Cart Recovery Board — Briyo Supplements

A single-page board that lists abandoned Shopify checkouts and tracks call / WhatsApp
outreach on each one. Status and notes are stored **in your Shopify store**, so the whole
team sees the same data on every device — no external database, no per-browser localStorage.

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
| `SHOPIFY_ACCESS_TOKEN` | yes (live) | Admin API access token from the custom app, starts with `shpat_` |
| `SHOPIFY_API_VERSION` | no | Defaults to `2024-10` |
| `PORT` | no | Defaults to `3000` |

---

## Shopify setup

### 1. Create the custom app

1. Shopify admin → **Settings** → **Apps and sales channels** → **Develop apps**.
2. **Allow custom app development** (one-time, needs store-owner permission) → **Create an app**.
   Name it e.g. `Cart Recovery Board`.
3. **Configuration** → **Admin API integration** → **Configure**.

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

Save the configuration, then **Install app**, then **API credentials** → reveal and copy the
**Admin API access token**. It's shown once. Put it in `.env` as `SHOPIFY_ACCESS_TOKEN`.

### 3. Verify

```bash
npm start
```

The log should print `Live: your-store.myshopify.com (API 2024-10)` rather than `MOCK MODE`.
Load the page — if the token or scopes are wrong you'll get a red banner naming the problem.

---

## How it works

| Endpoint | Purpose |
| --- | --- |
| `GET /api/carts` | Abandoned checkouts from the Admin GraphQL API, flattened for the UI |
| `GET /api/status` | The parsed status map from the shop metafield |
| `POST /api/status` | Accepts `{id, status, notes}` (read-merge-write) or a full `{statusMap}` |
| `GET /api/config` | Whether the server is in mock mode, plus the status list |

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

**Render / Railway**

1. Push this repo to GitHub.
2. New → **Web Service** → connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Add `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_API_VERSION` as environment
   variables. The platform supplies `PORT` itself — the server already reads it.
5. Deploy. Every push to `main` redeploys.

**A small VM**

```bash
git clone <your-repo> && cd cart-recovery-board
npm install --omit=dev
# put the env vars in /etc/environment, a systemd unit, or a .env file
npm start
```

Run it under systemd or pm2 so it restarts on reboot, and put nginx/Caddy in front for TLS.

### Before you expose it publicly

**This board shows customer names, emails and phone numbers, and there is no authentication
on it.** Anyone with the URL can read the list. Before putting it on a public hostname, put
something in front of it — HTTP Basic Auth in nginx, your host's access control, or a VPN /
IP allowlist. Running it on localhost or a private network needs nothing extra.

---

## What this app does not do

- It never writes to orders, customers, or checkouts — the only write is the status metafield.
- It doesn't send WhatsApp messages or place calls; the links just open your own apps.
- It doesn't poll. Click **Refresh** to re-fetch from Shopify.
