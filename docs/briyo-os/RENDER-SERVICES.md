# Render services

Briyo OS runs on **one** Render web service. As of 10-10-2026 there is no second service and no standby.

| Service | Region | Domains | Deploys | Rollback |
|---|---|---|---|---|
| `abc-briyo-sg` | Singapore (Southeast Asia) | `abc.briyo.xyz` (internal app), `careers.briyo.xyz` (public careers site), `go.briyo.xyz` (affiliate referral redirects), plus `abc-briyo-sg.onrender.com` | Automatic on every push to `main` | Render dashboard → `abc-briyo-sg` → **Events** → **Rollback** on an earlier deploy |

- Build: `npm install`. Start: `node server.js`. Health check: `/healthz`.
- Environment variables are set in the Render dashboard only; see `.env.example` and the
  README for names. Values are never written in this repository.
- `render.yaml` is the original Blueprint. Its service name (`abc-briyo`) is not the live
  service's name; the live service was created separately as `abc-briyo-sg`.

## Removed: Oregon service `abc-briyo` (deleted 10-10-2026)

- Service `abc-briyo` (`srv-dafs1f5g1s2s73fube00`), Oregon (US West), free instance.
- Its only address was `abc-briyo.onrender.com`; it had no `briyo.xyz` domains and no disks.
- Auto-deploy was off and it was still on commit `5f2efc4` (04-10-2026). That build had no
  order attribution, commissions, financial snapshots, HR or recovery verification, and no
  PR #54 dependency security patch, so it was not a usable rollback for current production.
- It was deleted through Render's delete workflow, with the owner's approval. The GitHub
  repository, branches, the Neon database, production data, integrations and the Singapore
  service's configuration were not changed.
- After the deletion: `/healthz` returned HTTP 200 `{"ok":true}` on `abc-briyo-sg.onrender.com`,
  `abc.briyo.xyz`, `careers.briyo.xyz` and `go.briyo.xyz`; `abc-briyo.onrender.com` returns 404.

## Before adding a second service

Background jobs keep per-process state. SLA, ingest-silence and daily-summary alerts track
what they already sent in memory (`lib/sla-alert.js`), so a second instance on the same
database and alert settings sends every alert twice. On any standby set
`SLA_ALERTS_ENABLED=false`, `SHOPIFY_POLL_ENABLED=false` and `KEEPALIVE_ENABLED=false`, and
leave `SHOPIFY_ORDERS_POLL_ENABLED` unset or `false`.
