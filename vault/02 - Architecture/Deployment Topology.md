---
type: architecture
domain: platform
status: active
date: 2026-06-09
sources:
  - vercel.json
  - next.config.ts
  - .nixpacks.toml
  - packages/realtime-server/railway.toml
  - packages/realtime-server/Dockerfile
  - workers/email-inbound/wrangler.toml
  - sentry.server.config.ts
  - sentry.edge.config.ts
  - instrumentation.ts
  - scripts/verify-db-target.ts
---

# Deployment Topology

The platform is split across three runtime environments: a Vercel-hosted Next.js application, a Railway-hosted Yjs realtime server, and a Cloudflare Workers email ingestion layer.

---

## What Runs Where

### Vercel — Next.js application

The main application (`app/`) deploys to Vercel. Config in `vercel.json`:

- **Framework:** nextjs
- **Build command:** `next build`
- **Install command:** `bun install --frozen-lockfile`
- **Region:** `iad1` (US East)
- **TypeScript in-build check:** disabled in `next.config.ts` (`typescript.ignoreBuildErrors: true`) — the repo is ~357k lines and in-build type-checking exhausts the heap. Types are enforced instead by `tsc --noEmit` in the pre-push hook and CI.
- **Static generation workers:** capped at 4 CPUs via `next.config.ts` `experimental.cpus: 4` to avoid exhausting Postgres connections during build.
- **Sentry integration:** `next.config.ts` wraps the config with `withSentryConfig` when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are all present. Local builds without these env vars behave normally. Runtime init in `sentry.server.config.ts` (Node runtime) and `sentry.edge.config.ts` (edge runtime), both gated on `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` being set and `NODE_ENV=production`. `instrumentation.ts` registers the correct Sentry config based on `NEXT_RUNTIME` and exports `onRequestError = Sentry.captureRequestError`.
- **Security headers:** applied in `next.config.ts`. `X-Frame-Options: SAMEORIGIN` is applied to `/portal/**`, `/admin/**`, and `/api/**` but intentionally omitted from `/sites/**` so the visual editor can embed tenant site previews in an iframe cross-origin.

### Railway — Yjs realtime server

`packages/realtime-server/` is a standalone Yjs WebSocket server deployed to Railway. It provides collaborative editing (block editor, pitch decks, email campaigns) and an internal HTTP write channel for MCP fan-out.

- **Config:** `packages/realtime-server/railway.toml`
- **Builder:** Dockerfile (`packages/realtime-server/Dockerfile`)
- **Base image:** `node:20-alpine`
- **Entry point:** `node --enable-source-maps node_modules/.bin/tsx src/server.ts`
- **Default port:** `3030` (overridable via `REALTIME_PORT`; Railway also injects `PORT`)
- **Health check:** `GET /health`, timeout 30 s, restart on failure (max 5 retries)
- **Required env (set in Railway service):**
  - `REALTIME_JWT_SECRET` — shared with the Next.js app
  - `REALTIME_INTERNAL_SECRET` — shared with MCP / internal write channel
  - `DATABASE_URL` — same Postgres instance as the main app; the realtime server writes snapshots to `posts.content`, `pitch_decks.slides`, and `email_campaigns.block_content`
- **nixpacks:** `.nixpacks.toml` at repo root sets `[phases.install] cmds = ["npm ci --legacy-peer-deps"]` for any nixpacks-based builds, but the realtime server uses its own Dockerfile.

### Cloudflare Workers — email inbound

`workers/email-inbound/` is a Cloudflare Worker that receives inbound email, optionally streams attachments to R2, then forwards the parsed payload to the main API.

- **Config:** `workers/email-inbound/wrangler.toml`
- **Entry:** `workers/email-inbound/src/index.ts`
- **Compatibility date:** 2024-09-01
- **Forward target:** `https://www.simplerdevelopment.com/api/email/inbound` (set via `vars.API_URL`)
- **Auth secret:** `INBOUND_EMAIL_SECRET` — set via `wrangler secret put INBOUND_EMAIL_SECRET` (not in config)
- **R2 bucket:** `brain-email-attachments` (binding: `ATTACHMENTS`) — meeting deck PDFs and other attachments sent to `brain+<token>@…` are streamed here; the API stores the R2 key on `brain_meetings.source_metadata`

---

## Cron Inventory

The live source of truth is `vercel.json`, which currently defines 48 scheduled routes in UTC. The old short list in this architecture note became incomplete as the platform grew.

See [Self-hosted Cron Migration](../../docs/SELF_HOSTED_CRON_MIGRATION.md) for the complete 48-route inventory, frequency distribution, authentication requirements, and the proposed VPS dispatcher design.

## Russian Self-hosting Readiness

The current production topology is not a single-server deployment:

- The Next.js application currently targets Vercel.
- The Yjs realtime server is a separate Railway service and has its own Dockerfile.
- Inbound email ingestion is a Cloudflare Worker.
- The repository's root `docker-compose.yml` is explicitly a local development stack: it starts the app in dev mode, uses local Mailpit/MinIO, and contains development-only fallback credentials. It is not a production compose file.
- There is no root production Dockerfile in the current tree. A production app image/build and service unit still need to be designed and tested.
- The separate agents service has its own Dockerfile and must be included in any target topology only if the selected product features require it.

A Russia-hosted target therefore requires an explicit decision for each component, not just moving the Next.js app:

1. Main app + PostgreSQL/pgvector.
2. Realtime server and its database connectivity.
3. Agents service and its internal authentication/network boundary.
4. S3-compatible media storage.
5. Email delivery and inbound-email handling.
6. Cron dispatcher and durable run ledger.
7. DNS/TLS, backups, monitoring, restore and incident access.

For the Russian market, review where personal data is collected, stored, processed, backed up, and forwarded by every external provider. A Russian VPS alone does not establish 152-FZ compliance. Do not enable real client data or production integrations until this data-flow review and the applicable legal controls are complete.

The VPS cron design is documented separately in [Self-hosted Cron Migration](../../docs/SELF_HOSTED_CRON_MIGRATION.md). No infrastructure has been provisioned by this audit.

---

## Environment Boundaries and Safety Rails

### Staging vs production databases

`scripts/verify-db-target.ts` is prepended to `bun run db:migrate` and `bun run db:push`. It reads `DATABASE_URL` and refuses destructive commands if the URL matches known prod host substrings (see `$PROD_DATABASE_URL` patterns) or if `RAILWAY_ENVIRONMENT_NAME=production`. The check can be bypassed with `ALLOW_PROD=1`.

Staging points at `$STAGING_DATABASE_URL`. `.env.local` must use `override: true` when loading — without it, bun's pre-injected `.env` value silently wins.

**Vercel deploy does NOT run migrations.** Before merging staging → main, the new migration SQL must be hand-applied against the production Postgres. The Drizzle migration tracker is also currently out of sync with disk in prod.

### Sentry environments

`sentry.server.config.ts` and `sentry.edge.config.ts` both read `SENTRY_ENVIRONMENT` (falling back to `NODE_ENV`) and only enable themselves when `NODE_ENV=production`. Traces are sampled at 10% by default (overridable via `SENTRY_TRACES_SAMPLE_RATE`).

---

## Build Pipeline Summary

```
bun install --frozen-lockfile
next build
  └─ Sentry plugin (source map upload + release tracking) — only when SENTRY_AUTH_TOKEN + ORG + PROJECT set
  └─ tsc --noEmit runs in pre-push hook / CI (not in-build — OOM risk on 357k-line repo)
```

---

## Related Notes

- [[Cron Jobs & Workers]]
- [[Deployment]]
- [[Chat, Realtime & Voice]]
