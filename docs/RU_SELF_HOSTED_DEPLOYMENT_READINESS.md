# Russian self-hosted deployment readiness

Status: architecture audit and implementation checklist. This is not a deployment guide yet; no server, paid resource, production secret, or customer data has been provisioned.

## Executive assessment

The application can run as a Node/Bun web service with PostgreSQL, but the repository is **not yet a turnkey production VPS package**. The root `docker-compose.yml` is a local development stack, and there is no root production Dockerfile. The documented topology currently spans Vercel, Railway, and Cloudflare Workers. The current Vercel app region in `vercel.json` is `iad1` (US East). Moving only the Next.js process to a Russian VPS would leave other services and data flows outside that host.

The safe direction is a modular self-hosted deployment in which the core platform and primary data stores run in a Russian data centre, while optional external integrations are enabled only after their data flows, contracts, and legal basis are reviewed.

## What exists today

| Component | Current repository evidence | Readiness |
|---|---|---|
| Main Next.js app | Next.js 16, Bun scripts; `railway.json` uses Nixpacks, `bun run build` and `bun run start`; Vercel config exists | App runtime exists; no dedicated root production image/deployment bundle |
| Local Docker stack | Root `docker-compose.yml` starts app in dev mode, Postgres, Mailpit, MinIO, realtime and agents | Development only; do not expose as production stack |
| PostgreSQL | Postgres 16; pgvector used by Company Brain; `pg_trgm` and `pgcrypto` are also enabled in deployment instructions | Core dependency; backup/restore and production migration procedure need validation |
| Realtime collaboration | Separate Yjs service in `packages/realtime-server/`, with its own Dockerfile and Railway config | Container exists; needs a Russian host profile and same-DB network/security design |
| AI agents | Separate `simplerdevelopment-agents/` service with its own Dockerfile; app connects via `SD_AGENTS_URL` and internal secret | Optional for MVP; if enabled, deploy as a separate private service |
| Inbound email | Cloudflare Worker in `workers/email-inbound/`; attachments can be stored in Cloudflare R2 before forwarding to the API | External data flow; replace, relocate, or disable before Russian personal data enters this path |
| Object storage | S3-compatible configuration; MinIO used locally | Compatible with an S3 provider in Russia; public/presigned URL behavior must be tested |
| Outbound email | Resend integration; Mailpit is local development transport | Provider and data residency decision required before production |
| Rate limiting | Upstash Redis is optional; without it the limiter falls back to per-instance memory | Production should use a shared Redis-compatible store or another shared limiter |
| Scheduled jobs | 48 routes in `vercel.json`; all now require shared Bearer cron auth | Complete schedule inventory and dispatcher design: [Self-hosted Cron Migration](./SELF_HOSTED_CRON_MIGRATION.md) |
| Monitoring | Sentry is optional and only activates when its keys are configured | Production alerts, log retention, metrics and incident workflow still need configuration |
| DNS and domains | Cloudflare DNS automation is optional | Do not make Cloudflare a hard dependency for the Russian-hosted MVP; decide DNS provider and domain flow |
| Payments | Stripe webhooks and checkout integrations exist | No Russian payment provider adapter has been selected or implemented in this audit |

## Target topology for the first Russian-hosted pilot

Keep the first deployment simple. Use a modular monolith and private supporting services rather than introducing microservices for every domain.

```text
Internet
  |
  v
Reverse proxy (TLS, request limits, trusted host headers)
  |
  v
Next.js app (private app port)
  |---- PostgreSQL 16 + pgvector (private network, persistent volume)
  |---- S3-compatible object storage (private API + controlled public URL)
  |---- Redis-compatible shared limiter/cache (private network)
  |---- Cron dispatcher (private local HTTP + Bearer secret)
  |
  +---- Optional private Yjs realtime service
  |
  +---- Optional private agents service
  |
  +---- External providers only when explicitly enabled and reviewed
```

### MVP deployment profile

Required for the first pilot:

1. Main Next.js application.
2. PostgreSQL 16 with `vector`, `pg_trgm`, and `pgcrypto` extensions.
3. S3-compatible storage for uploaded media and generated assets.
4. Shared rate-limiting store (or a deliberately selected equivalent).
5. Email delivery path with a tested provider and verified sending domain.
6. Cron dispatcher for required scheduled tasks.
7. TLS reverse proxy, firewall, backups, monitoring, and a tested restore procedure.

Defer until a pilot feature needs them:

- Yjs realtime collaboration.
- AI agents service and external LLM providers.
- Inbound email ingestion and attachment processing.
- Google/Microsoft/LinkedIn/Dropbox Sign integrations.
- Stripe billing, until a payment provider appropriate for the Russian market is selected.
- Automated DNS provisioning through Cloudflare.

## Environment variable policy

The root `.env.example` contains 81 variables. Do not treat all 81 as mandatory. Keep a deployment manifest with three classes:

### Core platform secrets and URLs

- `DATABASE_URL`
- `AUTH_SECRET` and `NEXTAUTH_SECRET` (same strong value where both are read)
- `NEXTAUTH_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`
- `CRON_SECRET` (random 32-byte secret; required in every production environment)
- `ENCRYPTION_KEY` (64 hex characters / 32 bytes for stored integration API keys)
- `PORTAL_KMS_KEY` (32-byte base64 key for plugin signing-key encryption; do not allow the fixed development fallback in production)
- `OAUTH_STATE_SECRET` (random secret for OAuth state)
- `CHAT_TOKEN_SECRET` (explicit production secret for public chat visitor tokens)

### Required only when the corresponding feature is enabled

- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or an approved shared Redis alternative.
- `WORKSPACE_TENANT_SECRETS_KEY` when Google Workspace credentials are stored.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the related AI and embedding features.
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, webhook secrets, or a replacement mail adapter for email features.
- `S3_*` credentials and endpoints for production file storage.
- `REALTIME_*` only when the realtime service is enabled.
- `SD_AGENTS_*` only when the agents service is enabled.
- Provider-specific OAuth, e-signature, social publishing, billing, DNS and analytics credentials only when that integration is deliberately enabled.

Never copy local development fallbacks from `docker-compose.yml` into production. In particular, MinIO `minioadmin/minioadmin` credentials, local Postgres credentials, Mailpit, and local realtime fallback secrets are development conveniences only.

## Production blockers and decisions

| Area | Finding | Required action before go-live |
|---|---|---|
| App packaging | No root production Dockerfile; local compose starts `next dev` | Create a production image or reproducible host build/start procedure; pin runtime and build dependencies |
| Deployment topology | Current architecture uses Vercel + Railway + Cloudflare Worker | Decide which services move to the Russian host and which remain external |
| Database migrations | Deployment notes describe manual production migration and historical migration-tracker drift | Reconcile the production Drizzle tracker; require backup, reviewed SQL, migration lock and post-migration verification |
| Tenant isolation | Most isolation is enforced in application code, not PostgreSQL RLS | Continue route/query audit; add defense-in-depth where feasible before broad customer onboarding |
| Secrets at rest | Previous audit found some integration refresh tokens/API keys not consistently encrypted at rest | Complete token-storage audit and encrypt sensitive integration credentials before enabling those providers |
| Session revocation | JWT/session revocation may remain effective only after token expiry | Define short session lifetime and revocation strategy; test logout, member removal and role change |
| Rate limiting | In-memory fallback is per process | Configure a shared store; test multi-instance behavior and failure policy |
| Email and inbound data | Resend and Cloudflare Worker/R2 are external processors | Map message bodies, addresses and attachments; choose provider/region and disable unsafe flows |
| Storage | S3 endpoint and browser-facing public endpoint can differ | Verify signed URL host, TLS, bucket policy, CORS, file-size/type limits, backup and deletion |
| Backups | A working database volume is not a backup | Set encrypted off-host backups, retention, restore drills, RPO/RTO and alerting |
| Observability | Sentry and other telemetry are optional | Configure structured logs, metrics, alerts, error reporting and retention |
| Cron | Vercel schedules do not run automatically on a VPS | Implement and test the durable dispatcher described in the cron migration document |
| 152-FZ / cross-border processing | Russian hosting alone does not prove compliance | Map every personal-data flow, processor, backup and cross-border transfer; obtain legal review and configure operational controls |

## Migration and launch sequence

1. **Freeze the target feature set.** Start with site/content, leads/basic CRM, booking/calendar and essential notifications. Keep optional AI/social/meeting integrations disabled unless the pilot needs them.
2. **Choose the Russian infrastructure provider.** Compare Selectel, Yandex Cloud and VK Cloud for compute, managed/self-hosted PostgreSQL, S3 storage, Redis, network, backup and support. No provider has been selected or provisioned yet.
3. **Create the production app image/build.** Keep secrets out of image layers; run as a non-root user; expose only the reverse proxy; add health/readiness checks and graceful shutdown.
4. **Provision private data services.** PostgreSQL, Redis and object storage must not be exposed publicly. Apply least-privilege database and bucket credentials.
5. **Reconcile migrations.** Validate clean install from the Drizzle journal, upgrade from the current schema, backup/restore, and rollback procedure. Do not use `drizzle-kit push` as the production migration strategy.
6. **Configure secrets.** Generate independent high-entropy values, store them outside Git, document permissions, rotation and recovery.
7. **Deploy supporting services only if required.** Realtime and agents must use private addresses and authenticated service-to-service calls.
8. **Configure email and payment providers.** Verify domain, SPF, DKIM, DMARC, webhooks, retries and data-processing location. Add a Russian payment adapter if needed; do not assume Stripe is suitable for the target business.
9. **Install the cron dispatcher in shadow mode.** Compare due occurrences with `vercel.json`; then test auth, retry, overlap, restart, timeout and catch-up behavior in staging.
10. **Run security and restore drills.** Test cross-tenant access, account removal, secret rotation, backup restoration, failed deploy rollback and queue recovery.
11. **Pilot with synthetic/test data first.** Enable real customer data only after the data-flow and legal review is signed off.
12. **Cut over one scheduler at a time.** Never leave Vercel Cron and the VPS dispatcher both actively executing the same production schedules without the shared durable run ledger.

## Explicit non-actions in this audit

- No Selectel/Yandex/VK account or paid resource was created.
- No production database, domain, DNS, email provider or storage bucket was provisioned.
- No real customer/personal data was copied.
- No deployment, PR merge, or production schedule cutover was performed.
