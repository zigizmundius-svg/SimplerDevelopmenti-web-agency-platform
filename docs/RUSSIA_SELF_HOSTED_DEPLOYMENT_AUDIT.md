# Russia-first self-hosted deployment audit

Status: preliminary repository audit, not a production deployment recipe.
Branch: `platform/ru-adaptation`.

## Verified repository facts

- The root app is Next.js 16.3.6 / React 19.3, with Bun 1.3.11 as package manager and Node 22.x declared in `package.json`.
- PostgreSQL is accessed through Drizzle and the `postgres` driver. The schema requires the PostgreSQL `vector` extension (documented in `.env.example`).
- `docker-compose.yml` is explicitly a local-development stack. It runs `next dev:docker`, bind-mounts the source tree, uses development credentials, starts Mailpit and MinIO, and publishes database, mail, storage, realtime and agents ports. It must not be reused as production configuration.
- No root `Dockerfile` or `docker-compose.prod.yml` exists on the audited branch.
- `next.config.ts` does not currently set Next.js `output: "standalone"`. The production image strategy must be tested against the monorepo/workspace dependencies before selecting standalone output or a full Bun/Node runtime image.
- The realtime collaboration server is a separate workspace package at `packages/realtime-server`; it has its own start/build scripts and shares PostgreSQL and two secrets with the app.
- The local compose stack references a separate `simplerdevelopment-agents` service directory. Its presence/build context and necessity for the Russian MVP must be verified independently before deployment.
- The inbound email worker is a Cloudflare Worker with an R2 bucket binding. This is an optional external deployment path, not part of the local compose stack.
- `vercel.json` currently declares Vercel region `iad1` and many scheduled cron routes. A self-hosted deployment must not rely on Vercel Cron; the required cron inventory, cadence, auth header and overlap/retry behavior need a replacement scheduler on the target host.
- `.env.example` documents optional connections to Upstash Redis, Resend, Stripe, Google APIs/OAuth, GitHub, Microsoft, LinkedIn, Zoom, Dropbox Sign, Cloudflare DNS, Brandfetch, Anthropic and OpenAI. These must be feature-gated and reviewed individually; they are not all required to boot the core app.

## Russia-first MVP deployment boundary

Initial deployment should keep the data plane in a verified Russian data centre and minimize outbound personal/customer data:

1. Main app and PostgreSQL (including `vector`) on the selected Russian host, subject to provider contract, data-centre location and personal-data processing review.
2. Private object storage for customer uploads, preferably in the same verified jurisdiction. Presigned URLs must use the correct browser-reachable S3 endpoint.
3. HTTPS reverse proxy and domain routing; do not expose PostgreSQL, Redis, object-store administration, or internal service ports publicly.
4. Durable backups stored separately from the live database, with restore tests before onboarding customers.
5. A host scheduler for only the cron routes needed by the MVP, sending `Authorization: Bearer <CRON_SECRET>`; the Vercel marker is not authentication.
6. SMTP/email delivery selected after provider and data-flow review. Email content should be minimized; notification failures must not roll back committed bookings.
7. Redis is optional for the core booking flow only after confirming all code paths and rate-limit fallback behavior. If enabled, use a controlled self-hosted or jurisdiction-verified instance.
8. Realtime collaboration, agents, inbound email, billing, AI integrations, OAuth providers, and automated DNS provisioning are not assumed prerequisites for the first Russian MVP. Enable only after separate tests and data-flow decisions.

## Production blockers before writing deployment manifests

- Confirm the exact Beget product, data-centre location, contract/processing terms, backup options, network limits, and whether the selected plan supports Docker/Compose and required persistent volumes. A hosting product name alone is not proof of 152-FZ compliance.
- Inspect every production-required environment variable and secret fallback. Generate unique secrets; remove local defaults and never commit real secrets.
- Determine the minimum set of cron jobs required for site provisioning, bookings, reminders, and durable internal jobs; translate those schedules into a managed host scheduler with logging and overlap protection.
- Verify all migration entry points and the safe release sequence. Do not run schema push in production; use reviewed migrations and a backup/restore checkpoint.
- Build and run the production image in CI, then test health checks, graceful shutdown, file uploads, presigned URLs, tenant subdomains, booking concurrency, and restart recovery.
- Establish resource sizing only after measuring the production build and representative workload; the development compose resource profile is not a sizing guide.
- Review outbound data destinations and disable optional integrations until their legal, operational and residency requirements are accepted.

## Release gate

No production deployment, DNS cutover, customer-data import, or merge to the default branch is authorized by this audit. First produce a tested self-host deployment bundle and a rollback/restore procedure on the draft branch; obtain explicit approval before production actions.
