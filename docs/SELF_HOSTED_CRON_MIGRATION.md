# Self-hosted cron migration plan

Status: inventory and design only. No scheduler is enabled by this document.

## Executive decision

The current deployment defines **48 scheduled HTTP routes** in `vercel.json`. A VPS does not execute Vercel Cron. When the application moves off Vercel, those schedules must be supplied by an external scheduler.

Do not create 48 independent systemd timers. Use one supervised dispatcher service and a single schedule registry. Keep the existing route handlers as the work units: the dispatcher calls the same HTTP endpoints with `Authorization: Bearer <CRON_SECRET>`. The handlers already centralize authorization through `lib/cron-auth.ts`; the Vercel marker `x-vercel-cron` is informational and is not an authentication mechanism.

The existing `process-internal-jobs` route is a queue worker, not a replacement for the 48-route scheduler. It drains `internal_jobs`; the scheduler is still responsible for invoking all scheduled routes.

## Current inventory

Source: `vercel.json` on `platform/ru-adaptation`. Cron expressions are interpreted in UTC. All entries invoke the route with GET, even where a route also exposes POST for manual compatibility.

| # | UTC cron | Route | Responsibility |
|---:|---|---|---|
| 1 | `17 3 * * *` | `/api/cron/expire-mcp-pendings` | Expire stale MCP approval/pending changes |
| 2 | `47 3 * * *` | `/api/cron/renew-gmail-watches` | Renew Gmail Pub/Sub watches |
| 3 | `13 4 * * *` | `/api/cron/renew-drive-watches` | Renew Google Drive change watches |
| 4 | `*/10 * * * *` | `/api/cron/drive-sync` | Sync queued Google Drive changes |
| 5 | `* * * * *` | `/api/cron/process-embeddings` | Drain Company Brain embedding queue |
| 6 | `5 6 * * *` | `/api/cron/brain-daily-notes` | Materialize daily Brain notes from tenant templates |
| 7 | `15 7 * * *` | `/api/cron/brain-empty-old-trash` | Purge Brain notes past retention |
| 8 | `30 8 * * *` | `/api/cron/brain-agent-per-tenant` | Run scheduled Brain workflow per entitled tenant |
| 9 | `0 12 * * *` | `/api/cron/failing-automations-notify` | Notify tenants about repeatedly failing automations |
| 10 | `0 13 * * *` | `/api/cron/approval-digest` | Send daily digest of pending MCP approvals |
| 11 | `0 13 * * *` | `/api/cron/process-survey-digests` | Send daily/weekly survey response digests |
| 12 | `30 10 * * 1` | `/api/cron/surveys-zero-responses` | Notify owners about surveys with no responses |
| 13 | `0 11 * * 1` | `/api/cron/stale-crm-deals` | Notify about stale open CRM deals |
| 14 | `7 * * * *` | `/api/cron/ticket-sla-breaches` | Detect support-ticket SLA breaches |
| 15 | `*/30 * * * *` | `/api/cron/stuck-booking-holds` | Detect bookings stuck in pending payment |
| 16 | `0 * * * *` | `/api/cron/booking-reminders` | Send booking reminders before appointments |
| 17 | `*/25 * * * *` | `/api/cron/renew-microsoft-subscriptions` | Renew Microsoft Teams transcript subscriptions |
| 18 | `*/5 * * * *` | `/api/cron/pm-recurrences` | Materialize due recurring project cards |
| 19 | `55 23 * * *` | `/api/cron/pm-column-snapshots` | Record daily cumulative-flow snapshots |
| 20 | `*/15 * * * *` | `/api/cron/process-survey-email-followups` | Send due survey email follow-ups |
| 21 | `*/15 * * * *` | `/api/cron/process-crm-sequences` | Process due CRM email-sequence steps |
| 22 | `*/5 * * * *` | `/api/cron/process-scheduled-posts` | Publish scheduled CMS posts |
| 23 | `*/5 * * * *` | `/api/cron/process-linkedin-posts` | Publish scheduled LinkedIn posts |
| 24 | `0 */6 * * *` | `/api/cron/process-contract-signature-reminders` | Send contract signature reminders |
| 25 | `*/30 * * * *` | `/api/cron/process-cart-abandonment` | Send abandoned-cart recovery messages |
| 26 | `* * * * *` | `/api/cron/process-journey-enrollments` | Advance due email-journey enrollments |
| 27 | `0 4 * * *` | `/api/cron/mcp-rollup` | Roll up previous-day MCP usage |
| 28 | `23 4 * * *` | `/api/cron/mcp-cleanup` | Delete raw MCP usage rows past retention |
| 29 | `15 4 * * *` | `/api/cron/resend-usage-sync` | Sync email-send usage into metering |
| 30 | `45 4 * * *` | `/api/cron/usage-rollup` | Roll up metered usage and report to Stripe |
| 31 | `15 5 * * *` | `/api/cron/usage-alerts` | Evaluate usage thresholds and notify |
| 32 | `30 5 * * *` | `/api/cron/purge-unverified` | Purge unverified self-service signups |
| 33 | `* * * * *` | `/api/cron/process-scheduled-automations` | Run due scheduled automation rules |
| 34 | `* * * * *` | `/api/cron/process-workflow-runs` | Drain workflow run steps |
| 35 | `* * * * *` | `/api/cron/process-automation-jobs` | Retry journaled automation events |
| 36 | `* * * * *` | `/api/cron/process-internal-jobs` | Drain durable internal background jobs |
| 37 | `* * * * *` | `/api/cron/plugin-runs-drain` | Drain queued content-tools plugin runs |
| 38 | `* * * * *` | `/api/cron/plugin-jobs-tick` | Enqueue due registered plugin jobs |
| 39 | `*/5 * * * *` | `/api/cron/process-playbook-waits` | Resume playbook steps whose wait has elapsed |
| 40 | `* * * * *` | `/api/cron/email-scheduled-send` | Enqueue/send scheduled email campaigns |
| 41 | `*/30 * * * *` | `/api/cron/email-ab-promote` | Promote email A/B winners after decision window |
| 42 | `7 * * * *` | `/api/cron/invoices-overdue` | Mark sent invoices past due as overdue |
| 43 | `0 6 2 * *` | `/api/cron/ai-credits-monthly-regrant` | Re-grant monthly AI credits to active subscriptions |
| 44 | `*/5 * * * *` | `/api/cron/eval-runs` | Drain AI evaluation run queue |
| 45 | `*/5 * * * *` | `/api/cron/eval-schedule` | Enqueue evaluations due by prompt schedule |
| 46 | `23 4 * * *` | `/api/cron/purge-agent-captures` | Purge encrypted agent captures after 90 days |
| 47 | `* * * * *` | `/api/cron/seo-crawl-tick` | Advance SEO crawl runs in bounded chunks |
| 48 | `15 7 * * *` | `/api/cron/seo-gsc-import` | Import Google Search Console history |

### Frequency distribution

- Every minute: 10 routes.
- Every 5 minutes: 6 routes.
- Every 10 minutes: 1 route.
- Every 15 minutes: 2 routes.
- Every 25 minutes: 1 route.
- Every 30 minutes: 3 routes.
- Hourly at minute 0: 1 route.
- Hourly at minute 7: 2 routes.
- Every 6 hours: 1 route.
- Remaining 21 routes: daily, weekly, or monthly schedules.

The counts above sum to 48. Some routes are network-bound and have explicit longer execution budgets (for example SEO GSC import); the dispatcher must not assume every endpoint finishes within one minute.

## Recommended self-hosted design

### 1. One dispatcher process, not 48 timers

Run one Node/Bun process under systemd, for example `simpler-cron-dispatcher.service`. It reads the same schedule registry as Vercel (initially `vercel.json`) and uses the already-installed `cron-parser` dependency to calculate due occurrences.

The dispatcher sends an internal HTTP GET to `CRON_BASE_URL + path`, defaulting to `http://127.0.0.1:3000`, with:

```http
Authorization: Bearer <CRON_SECRET>
```

Do not put the secret in URLs, logs, command-line arguments, or job payloads. Keep it in a root-readable environment file or secret manager. The app and dispatcher must use the same high-entropy secret.

### 2. Durable dispatch ledger before production

Do not rely only on in-memory timers. Add a PostgreSQL ledger, proposed name `cron_dispatch_runs`, with:

- `id`, `route_path`, `scheduled_for` (UTC), unique on (`route_path`, `scheduled_for`);
- `status`: pending / running / completed / failed;
- `attempt_count`, `lease_until`, `started_at`, `finished_at`;
- `http_status`, `duration_ms`, `last_error`, `created_at`.

The scheduler inserts each due occurrence with `ON CONFLICT DO NOTHING`. Workers claim pending rows with `FOR UPDATE SKIP LOCKED` or compare-and-set updates and a lease. This prevents two dispatcher instances from executing the same scheduled occurrence at the same time and allows abandoned leases to be reclaimed after a process crash.

The dispatcher must use a route-specific timeout. Do not let a 300-second SEO import block the rest of the queue. Start with a small bounded concurrency (for example 4) and tune from measured duration and database/provider load.

### 3. Retry and missed-run policy must be explicit

A request timeout does not prove that the route did no work: it may have completed side effects before the connection was lost. Therefore delivery is **at least once**, not exactly once. Existing route-level CAS guards, unique constraints, queue leases, and idempotency keys reduce duplicates but do not prove every route is safe to replay.

Before enabling automatic catch-up, classify every route:

- **Queue-drain tick**: usually collapse missed minute ticks into one current invocation; the durable queue is expected to contain the backlog.
- **Windowed digest / reminder / metering task**: inspect its selection window and watermark; replay only if the route can safely catch up without duplicate sends or skipped periods.
- **Daily/weekly/monthly maintenance**: define whether a missed occurrence should run once on recovery, be skipped, or require operator action.
- **External provider calls**: verify provider idempotency and persist an operation key before retrying.

Until that route-by-route review is complete, the safe default is to record missed occurrences and alert rather than replay every historical tick automatically.

### 4. Operational controls

- systemd: `Restart=always`, bounded restart delay, dedicated unprivileged service user, `NoNewPrivileges=true`, `PrivateTmp=true`, filesystem protections where compatible.
- Health: expose dispatcher heartbeat and queue counts; alert on no heartbeat, oldest pending age, repeated 401/5xx, dead-letter count, and route duration spikes.
- Logs: structured JSON with route path, scheduled UTC timestamp, run ID, duration, status, attempt number; redact authorization headers and secrets.
- Security: keep cron endpoints behind the normal application auth guard; firewall the app port so only the reverse proxy and localhost dispatcher can reach it where practical. The Bearer secret remains required even on loopback.
- Shutdown: stop claiming new work, wait a bounded grace period for active HTTP calls, then release/requeue leases safely.
- Backups: include the dispatch ledger in normal PostgreSQL backup/restore tests.
- Rotation: rotate `CRON_SECRET` in the app and dispatcher together; verify a health invocation before retiring the old secret.

## Migration sequence

1. Keep Vercel Cron as the active scheduler while the app is still deployed there.
2. Build the dispatcher and ledger behind a disabled/dry-run switch; verify all 48 parsed schedules against `vercel.json`.
3. Run in shadow mode and compare due occurrences without making HTTP requests.
4. Test authenticated dispatch against a staging instance, including 401 on forged `x-vercel-cron`, timeout, retry, overlap, restart, and missed-run scenarios.
5. Enable the dispatcher on the VPS only after the app, database, secrets, backups, monitoring, and restore procedure are ready.
6. Disable Vercel Cron for the production deployment at the cutover point. Never run both schedulers actively against the same production database unless the durable unique dispatch ledger is in place and shared.
7. Observe at least one full daily and weekly cycle before calling the migration complete.

## Current code facts and cautions

- `lib/cron-auth.ts` fails closed: missing `CRON_SECRET` returns unauthorized; only the exact Bearer value is accepted.
- All 48 cron routes are expected to use the shared auth helper after the recent security hardening. A stale route comment may still mention the Vercel header; comments do not change runtime behavior, but should be corrected.
- `process-internal-jobs` has a 60-second route budget and drains at most 50 durable jobs per tick. Its job queue is separate from this scheduler.
- `seo-crawl-tick` and `seo-gsc-import` have longer network-bound work; route-specific timeouts are required.
- Some integrations (Google, Microsoft, LinkedIn, Resend, Stripe, Dropbox Sign, AI providers) are optional or may be unconfigured. The scheduler should preserve each route's existing safe no-op behavior and report its result rather than treating every skipped response as an outage.
- No cron-dispatcher service, migration, VPS resource, or production schedule has been created or enabled by this audit.

## Route-level replay-safety audit (2026-11-11)

The 48-route schedule inventory is internally consistent with `vercel.json` (48/48 paths and schedules match). A first-pass review of high-impact routes found the following recovery properties. This is deliberately a conservative classification: a timeout or process crash can occur after an external side effect has succeeded but before the database records success.

| Route | Current protection | Recovery risk | Required VPS policy |
|---|---|---|---|
| `/api/cron/booking-reminders` | Per-booking database claim with a 30-minute lease; stable Resend idempotency key `booking-reminder/<bookingId>`; claim released on handled failure | If delivery succeeds but the worker dies before `reminder_sent_at` is written, a later lease recovery may retry. Provider idempotency is bounded by Resend's retention window, so this is not exactly-once delivery. | Keep bounded retries; alert on repeated claims/failures; do not claim exactly-once semantics. |
| `/api/cron/email-scheduled-send` (tenant campaigns) | Enqueues a deduplicated `email.campaign_send` job; worker resumes from `email_campaign_sends` and queue has lease/backoff/dead-letter handling | Durable queue path is substantially safer than inline sending. | Drain `internal_jobs` reliably and monitor dead letters. |
| `/api/cron/email-scheduled-send` (agency/global campaigns) | Sends inline because `internal_jobs.client_id` is non-nullable | A process interruption can leave the campaign without the tenant queue's resume/retry guarantees. | Treat as a separate migration item; do not blindly replay after an ambiguous timeout. Move to a system-owned durable queue or add an explicit resumable send ledger before relying on VPS retries. |
| `/api/cron/process-linkedin-posts` | Compare-and-set transition `scheduled → publishing` prevents concurrent workers from publishing the same row. | There is no stale-`publishing` lease recovery. A worker crash can strand a row permanently. If LinkedIn accepted the post but the response/database write was lost, automatic retry could create a duplicate; the current API client does not send a provider idempotency key. | Do not automatically reset stale rows to `scheduled`. Add a stale-attempt reconciliation state/process: inspect provider outcome first, then mark published or allow an operator-approved retry. Alert on rows remaining `publishing` beyond the request timeout plus safety margin. |
| `/api/cron/ai-credits-monthly-regrant` | Checks the ledger for a non-signup grant in the current UTC month before granting. | The check and `grantMonthlyCredits` are not one transaction; balance increment and ledger insert are separate writes. Concurrent cron invocations (or a monthly subscription webhook racing the cron) can both pass the check and grant twice. | Block concurrent execution per client/month and make the period grant atomic with a database-enforced idempotency key/unique constraint. Do not enable catch-up/retry until this is fixed. |
| `/api/cron/usage-rollup` | Recomputes absolute period totals; upserts a unique per-client/period/resource audit row and pushes Stripe action `set`. | Repeated runs for the same period are designed to converge on the same total. | Safe candidate for retry after verifying Stripe meter semantics and alerting on per-client errors. |

### Dispatcher implications

1. A generic HTTP timeout policy is insufficient. Route execution budgets and replay behavior must be configured per route.
2. For queue-drain routes, collapse missed ticks into one current invocation; the durable queue is the backlog. Do not replay every missed minute as a burst.
3. For externally visible publishing or credit grants, use route-specific reconciliation/idempotency before automatic retry. An HTTP 5xx/timeout does not prove that no side effect occurred.
4. The first production dispatcher release should run only routes classified as safe or explicitly operator-gated. The LinkedIn and monthly AI-credit findings above are blockers for unattended automatic replay.
5. This review is a first-pass audit of high-impact paths, not proof that all 48 handlers are replay-safe. Complete the remaining route-by-route classification before enabling automatic catch-up.
