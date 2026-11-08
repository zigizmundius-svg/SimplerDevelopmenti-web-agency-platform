# Integration and background-job inventory

**Branch:** `platform/ru-adaptation`  
**Sources:** upstream `.env.example`, `vercel.json`, `docker-compose.yml`, `package.json` at `2b6b7cc75ebb7872977f5487c2f05c5ca60c1c0c`.  
**Status:** configuration inventory, not a runtime verification.

## 1. Configuration surface

The upstream `.env.example` declares 81 variables in 11 groups. This is a useful inventory of the platform's integration surface; it is not a list of values we should populate.

| Group | Variables / purpose | AI Web Agency decision |
|---|---|---|
| Core | Database, auth/session secrets, app/site URLs, signup toggle, auth enforcement flags, cron secret | Required; generate new secrets for our own deployment. Never copy upstream/example credentials. |
| Rate limiting | Upstash Redis URL/token | Select a Redis-compatible deployment or implement/verify a safe shared limiter; do not silently rely on per-process fallback in production. |
| Plugin/signing | Portal KMS, tenant-secret encryption, general encryption key, plugin bypass flags | Keep cryptographic keys mandatory where feature paths use them; bypass flags must remain off. |
| AI | Anthropic, OpenAI, chat token secret | Disable AI features for MVP until provider/data/cost approval; keep visitor token secret independent. |
| Agent/MCP services | Mastra URL/secret, MCP URL/API key | Disable standalone agent service for MVP; scope and tenant-bind any future tokens. |
| Realtime | JWT/internal secrets and service URL | Disable unless a real-time collaborative feature is in the paid MVP. |
| Email | Mailpit local transport; Resend API and webhook secrets | Mailpit only in development; select a production email provider after Russian availability/legal review. |
| Billing | Stripe keys and three webhook secrets | Do not use Stripe by default for Russian billing; choose a locally viable payment/acquiring provider and adapt the billing adapter. |
| File storage | S3 endpoint, browser endpoint, region, bucket, access keys, size/type limits | Required for hosted media; use private bucket, short-lived signed URLs, strict upload validation and backups. |
| OAuth / external | Google login/workspace/calendar/drive, GitHub OAuth/App, Microsoft Teams, LinkedIn, Zoom, Dropbox Sign, Google API, Brandfetch, Cloudflare | Disable by default; enable only provider-by-provider after availability, security, contract and data-transfer review. |
| Contact overrides | Contact, billing and support inboxes, agency client ID | Replace with our own operational addresses/IDs; do not inherit vendor defaults. |

**Secret rule:** do not put real credentials in GitHub files, commits, screenshots or chat. Provision secrets only in the selected deployment's secret manager/environment settings. Rotate every secret if it has ever been exposed.

## 2. External services and dependencies

### Core runtime
- PostgreSQL 16 + pgvector in the local compose file; pgvector is needed by Company Brain/RAG, so confirm whether it remains necessary if AI is disabled.
- Bun 1.3.11 and a Bun lockfile; Node 22 engine declaration.
- Next.js 16 / React 19.
- S3-compatible media storage.
- Redis-compatible rate limiting is optional in the example config but needs a deliberate production decision.

### Optional features to keep off initially
- AI models, embeddings and agent workers;
- realtime Yjs service;
- email campaign/marketing features;
- social publishing and LinkedIn;
- Google/Microsoft workspace integrations;
- Zoom meetings;
- Dropbox Sign / e-sign;
- Stripe billing and e-commerce/booking payments;
- external enrichment/brand APIs and Cloudflare DNS automation.

### Development-only services
The compose stack includes PostgreSQL, app, Mailpit, MinIO, realtime and agent containers. Mailpit and MinIO defaults are local-development conveniences, not production security settings. Do not expose MinIO's sample credentials or public bucket policy to the internet.

## 3. Scheduled work — migration inventory

The upstream `vercel.json` defines **48 cron routes**. This is a material deployment dependency: simply running the Next.js app on a VPS will not run these jobs. Each route must be classified as keep, adapt, disable or replace, then moved to a durable scheduler with authenticated invocation, locking, idempotency, observability and tenant scoping.

| Route | Schedule (UTC as configured) | Initial decision |
|---|---:|---|
| `/api/cron/expire-mcp-pendings` | 17 3 * * * | Disable with MCP or migrate if approval workflow retained |
| `/api/cron/renew-gmail-watches` | 47 3 * * * | Disable until Google Workspace approved |
| `/api/cron/renew-drive-watches` | 13 4 * * * | Disable until Google Drive approved |
| `/api/cron/drive-sync` | */10 * * * * | Disable until Drive approved |
| `/api/cron/process-embeddings` | * * * * * | Disable if RAG/AI not in MVP |
| `/api/cron/brain-daily-notes` | 5 6 * * * | Disable with Company Brain |
| `/api/cron/brain-empty-old-trash` | 15 7 * * * | Disable with Company Brain |
| `/api/cron/brain-agent-per-tenant` | 30 8 * * * | Disable with agent service |
| `/api/cron/failing-automations-notify` | 0 12 * * * | Retain only if automations retained |
| `/api/cron/approval-digest` | 0 13 * * * | Retain only if approvals retained |
| `/api/cron/process-survey-digests` | 0 13 * * * | Defer surveys |
| `/api/cron/surveys-zero-responses` | 30 10 * * 1 | Defer surveys |
| `/api/cron/stale-crm-deals` | 0 11 * * 1 | Optional CRM workflow |
| `/api/cron/ticket-sla-breaches` | 7 * * * * | Defer tickets/projects |
| `/api/cron/stuck-booking-holds` | */30 * * * * | Keep only if booking holds retained; verify lock/idempotency |
| `/api/cron/booking-reminders` | 0 * * * * | Keep after booking and Russian notification provider are approved |
| `/api/cron/renew-microsoft-subscriptions` | */25 * * * * | Disable until Microsoft integration approved |
| `/api/cron/pm-recurrences` | */5 * * * * | Defer projects |
| `/api/cron/pm-column-snapshots` | 55 23 * * * | Defer projects |
| `/api/cron/process-survey-email-followups` | */15 * * * * | Defer surveys/email |
| `/api/cron/process-crm-sequences` | */15 * * * * | Defer CRM sequences |
| `/api/cron/process-scheduled-posts` | */5 * * * * | Defer social publishing |
| `/api/cron/process-linkedin-posts` | */5 * * * * | Disable until LinkedIn approved |
| `/api/cron/process-contract-signature-reminders` | 0 */6 * * * | Defer e-sign |
| `/api/cron/process-cart-abandonment` | */30 * * * * | Defer storefront |
| `/api/cron/process-journey-enrollments` | * * * * * | Defer marketing journeys |
| `/api/cron/mcp-rollup` | 0 4 * * * | Disable with MCP |
| `/api/cron/mcp-cleanup` | 23 4 * * * | Disable with MCP |
| `/api/cron/resend-usage-sync` | 15 4 * * * | Disable until Resend selected |
| `/api/cron/usage-rollup` | 45 4 * * * | Keep if usage billing retained |
| `/api/cron/usage-alerts` | 15 5 * * * | Keep if usage billing retained |
| `/api/cron/purge-unverified` | 30 5 * * * | Review account retention policy; likely retain |
| `/api/cron/process-scheduled-automations` | * * * * * | Defer until core automations approved |
| `/api/cron/process-workflow-runs` | * * * * * | Defer workflows |
| `/api/cron/process-automation-jobs` | * * * * * | Defer workflows |
| `/api/cron/process-internal-jobs` | * * * * * | Inspect shared internal job dependencies |
| `/api/cron/plugin-runs-drain` | * * * * * | Disable until plugin runtime approved |
| `/api/cron/plugin-jobs-tick` | * * * * * | Disable until plugin runtime approved |
| `/api/cron/process-playbook-waits` | */5 * * * * | Defer playbooks |
| `/api/cron/email-scheduled-send` | * * * * * | Defer campaigns; use selected email provider |
| `/api/cron/email-ab-promote` | */30 * * * * | Defer campaigns |
| `/api/cron/invoices-overdue` | 7 * * * * | Retain only after local billing/invoice policy defined |
| `/api/cron/ai-credits-monthly-regrant` | 0 6 2 * * | Disable if AI credits not offered |
| `/api/cron/eval-runs` | */5 * * * * | Disable unless agent evaluation retained |
| `/api/cron/eval-schedule` | */5 * * * * | Disable unless agent evaluation retained |
| `/api/cron/purge-agent-captures` | 23 4 * * * | Disable with agent capture feature |
| `/api/cron/seo-crawl-tick` | * * * * * | Optional; review crawl resource limits |
| `/api/cron/seo-gsc-import` | 15 7 * * * | Disable until Google Search Console approved |

**Important:** the schedule strings are taken from the repository config; verify timezone semantics in the chosen scheduler and explicitly set the intended timezone. Do not assume all 48 jobs are needed for our MVP.

## 4. Required job contract before VPS migration

For every retained job, record:
- owner/domain and whether it is required for MVP;
- schedule, timezone, expected duration and overlap policy;
- auth mechanism (internal secret or signed job token);
- tenant scope and maximum batch size;
- lock/lease strategy so two workers cannot process the same work;
- idempotency key and retry/backoff behavior;
- dead-letter/failure alerting and structured logs;
- safe pause/resume and manual replay procedure.

A system cron that simply curls public endpoints is not sufficient without request authentication, replay protection, lock semantics and monitoring.

## 5. Next step

Create a minimal deployment profile only after the MVP job list is agreed. For the first pilot, likely retain only core account cleanup, booking reminders/holds (once booking is repaired), and any CRM/usage jobs explicitly required by the chosen commercial model. Disable the rest at configuration level and verify that the app still builds and starts without those external credentials.
