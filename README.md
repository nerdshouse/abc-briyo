# Briyo Supplements — Abandoned Cart Receiver

A small Next.js app that **passively receives** abandoned-cart webhooks from GoKwik, stores
them in Postgres, and shows them on a password-protected dashboard.

It does **not** talk to Shopify or to GoKwik's API. It only listens. Nothing here touches the
existing GoKwik / Meta pixel setup on the storefront.

| Piece | Path |
| --- | --- |
| Webhook receiver | `POST /api/webhook/gokwik/abandoned-cart` |
| Data API | `GET /api/carts?page=1&limit=50` |
| Dashboard | `/` |

Built for Vercel from the start: everything is a serverless function, storage is managed
Postgres (Neon), and there is no local disk usage anywhere.

---

## 1. Local setup

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000 — the browser will prompt for the Basic Auth credentials
(`DASHBOARD_USER` / `DASHBOARD_PASS`).

### Environment variables

| Variable | Purpose |
| --- | --- |
| `WEBHOOK_SECRET` | Shared secret GoKwik must send with each webhook. Generate with `openssl rand -hex 32`. |
| `DASHBOARD_USER` | Basic Auth username for the dashboard. |
| `DASHBOARD_PASS` | Basic Auth password for the dashboard. |
| `POSTGRES_URL` | Postgres connection string. Injected automatically by Vercel once you attach a database; see step 3. |

Vercel injects several other `POSTGRES_*` / `DATABASE_URL` variables alongside `POSTGRES_URL` —
they are harmless, and this app only reads `POSTGRES_URL`. See `.env.example`.

For local development against the deployed database, the easiest route is:

```bash
npx vercel link
npx vercel env pull .env.local
```

The `abandoned_carts` table is created automatically on first request — there is no
migration step to run.

---

## 2. Sending a test webhook

With the dev server running (or against your deployed URL), using the header form:

```bash
curl -i -X POST http://localhost:3000/api/webhook/gokwik/abandoned-cart \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{
    "cart_id": "TEST-1001",
    "first_name": "Asha",
    "last_name": "Rao",
    "phone": "+919812345678",
    "email": "asha@example.com",
    "total_price": "1299.00",
    "currency": "INR",
    "checkout_url": "https://briyo.in/checkout/abc123",
    "line_items": [{ "title": "Whey Protein 1kg", "quantity": 2 }],
    "created_at": "2026-09-07T10:00:00Z"
  }'
```

Or with the secret as a query param (use this if GoKwik cannot send custom headers):

```bash
curl -i -X POST "http://localhost:3000/api/webhook/gokwik/abandoned-cart?secret=$WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"cart_id":"TEST-1002","total_price":499,"currency":"INR"}'
```

Expected: `200 {"ok":true,"id":1}`. A wrong or missing secret returns `401`.

Reading it back (Basic Auth required):

```bash
curl -u "$DASHBOARD_USER:$DASHBOARD_PASS" http://localhost:3000/api/carts
```

---

## 3. Deploying: GitHub → Vercel

### 3a. Push to GitHub

If you have the GitHub CLI:

```bash
gh repo create nerdshouse/abandoned-cart --private --source=. --remote=origin --push
```

If the repo already exists and is empty:

```bash
git remote add origin https://github.com/nerdshouse/abandoned-cart.git
git push -u origin main
```

Manual alternative (no `gh`): create a new **empty** repo at
https://github.com/new (no README, no .gitignore, no licence), then run the two
commands above with your repo URL.

### 3b. Import into Vercel

1. Go to https://vercel.com/new.
2. Under **Import Git Repository**, pick `nerdshouse/abandoned-cart`. Click
   **Adjust GitHub App Permissions** first if the repo isn't listed.
3. Framework Preset auto-detects as **Next.js** — leave build settings at defaults.
4. **Don't set env vars yet** — the first build will fail without a database, which is
   expected. Click **Deploy**, let it finish (or fail), then continue below.

Every push to `main` auto-deploys from this point on. Pull requests get preview deployments.

### 3c. Attach Postgres

1. In the Vercel dashboard, open the project → **Storage** tab → **Create Database**.
2. Choose **Postgres (Neon)** → pick the free plan → select a region close to your
   customers (e.g. Mumbai / `ap-south-1`) → **Create**.
3. On the next screen, confirm the database is **connected to this project** for the
   Production, Preview and Development environments.

Vercel now injects `POSTGRES_URL` (and friends) into the project automatically. You do
not need to copy the connection string anywhere.

### 3d. Set the remaining env vars

Project → **Settings** → **Environment Variables**. Add three, each ticked for
**Production**, **Preview** and **Development**:

| Key | Value |
| --- | --- |
| `WEBHOOK_SECRET` | output of `openssl rand -hex 32` |
| `DASHBOARD_USER` | e.g. `briyo` |
| `DASHBOARD_PASS` | a strong password |

Then **Deployments** → the latest deployment → **⋯** → **Redeploy** so the new variables
are picked up.

### 3e. Give GoKwik the webhook URL

```
https://<your-project>.vercel.app/api/webhook/gokwik/abandoned-cart
```

with header `X-Webhook-Secret: <WEBHOOK_SECRET>`, or if they can only configure a plain
URL, append `?secret=<WEBHOOK_SECRET>` instead.

Verify it end to end with the `curl` from section 2 pointed at the deployed URL, then
load the dashboard at `https://<your-project>.vercel.app/`.

---

## 4. Important: GoKwik's payload field names are not confirmed

**The exact field names GoKwik sends have not been verified against their documentation.**
`lib/normalize.js` guesses, checking a list of plausible variants for each field
(`cart_id` / `checkoutId` / `token` / …, `total_price` / `amount` / `cartValue` / …), and
also looks one level inside common envelope keys like `data`, `payload` and `cart`.

Because of that:

- **Every event is stored twice** — once as parsed columns, and once in full as the
  `raw_payload` `jsonb` column. Nothing is ever discarded, even if the parser matches nothing.
- **If the dashboard shows mostly-blank columns on real events**, that is a mapping gap,
  not data loss. Inspect what actually arrived:

  ```sql
  SELECT id, created_at, raw_payload
  FROM abandoned_carts
  ORDER BY created_at DESC
  LIMIT 5;
  ```

  Run that in Vercel → Storage → your database → **Query**. Then add the real key names to
  the relevant array in `lib/normalize.js` and push — the fix deploys automatically.

- **Please confirm the payload schema with GoKwik directly.** Ask them for a sample
  abandoned-cart payload and the list of fields they send. Backfilling old rows afterwards is
  straightforward, since `raw_payload` still holds everything.

---

## 5. Security notes

- The dashboard and `/api/carts` are behind HTTP Basic Auth enforced in `middleware.js`,
  which runs server-side before the page or route handler — the PII is never served without
  credentials, not merely hidden in the UI.
- The webhook route is deliberately excluded from that middleware (GoKwik can't send Basic
  Auth); it is protected by the shared secret instead, compared without early-exit to avoid
  leaking it through response timing.
- The webhook returns `200` even if the database write fails, and logs the full payload —
  webhook senders retry aggressively on non-2xx, and a retry storm is worse than a log dive.
