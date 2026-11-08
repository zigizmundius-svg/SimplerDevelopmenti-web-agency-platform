# AI Web Agency — Russian adaptation plan

**Status:** source/architecture audit; no production changes.  
**Base upstream commit:** `2b6b7cc75ebb7872977f5487c2f05c5ca60c1c0c`  
**Working branch:** `platform/ru-adaptation`  
**Decision:** adopt SimplerDevelopment as a codebase foundation and adapt it selectively. Do not build a parallel platform from scratch.

## 1. Product target

A multi-tenant website and business-operations platform sold as a monthly service to Russian small businesses. Each tenant receives a public website and an authenticated client workspace; the agency operates a separate control plane.

Required capabilities:
- independent client companies/tenants and custom domains;
- public websites, CMS editing, preview and publishing;
- client portal with roles and self-service settings;
- agency console for tenants, sites, plans, modules, access and health;
- CRM and lead inbox;
- one shared booking calendar across public site, client portal and agency-assisted/manual booking;
- modular verticals (first pilot: auto service / GARAGE 27; later salons, sports sections and others);
- subscriptions/entitlements, usage limits, data export and a documented exit path.

## 2. Reuse decision

### Reuse after verification
- Next.js App Router, React, TypeScript, Bun workspace;
- PostgreSQL + Drizzle ORM and migrations;
- tenant/client model, membership and role infrastructure;
- CMS/site publishing and hostname resolution;
- separate internal admin and client portal surfaces;
- CRM, booking primitives, automation/event infrastructure;
- S3-compatible storage abstraction;
- test harness, tenancy gate and CI patterns.

### Do not assume production readiness
- Booking write-path parity is incomplete (section 6).
- Tenant isolation is largely application-scoped; universal PostgreSQL RLS is not established.
- The codebase is large and has a broad integration/runtime surface.
- Deployment documentation targets Vercel/Railway, not a validated Russian VPS profile.
- Vercel cron assumptions and external integrations (Stripe, Resend, AI APIs, Google/Microsoft, etc.) need explicit review.
- A passing tenancy suite does not prove every route, job, cache, export or file path is isolated.

All adaptation work stays on `platform/ru-adaptation` or later feature branches. Never commit to upstream or modify production/demo repositories during this audit.

## 3. Codebase map

| Domain | Existing entry points | Adoption |
|---|---|---|
| Agency admin | `app/admin/**`, `app/api/admin/**`, `lib/admin/auth.ts` | Reuse as agency control plane; verify staff gates. |
| Client portal | `app/portal/**`, `app/api/portal/**`, `lib/portal-auth.ts` | Reuse as tenant workspace; map roles to customer permissions. |
| Public sites | `app/sites/**`, CMS modules, `middleware.ts` | Reuse after hostname/cache isolation tests. |
| CRM | CRM schema/API/UI | Reuse lead/contact/deal foundation; configure per vertical. |
| Booking | `app/api/public/booking/**`, `app/api/portal/tools/booking/**`, `app/api/admin/portal/booking/**`, `lib/mcp/tools/bookings.ts` | Reuse only after shared mutation service and parity tests. |
| Database | `lib/db/schema/**`, `drizzle/**` | PostgreSQL/Drizzle base; audit tenant keys and cascades. |
| Background jobs | `app/api/cron/**`, `vercel.json` | Replace Vercel-specific scheduling before VPS deployment. |
| Realtime / agents | `packages/realtime-server/**`, `simplerdevelopment-agents/**` | Optional; leave disabled for MVP unless justified. |

Confirmed stack: Next.js 16, React 19, TypeScript 5, Bun 1.3.11, Drizzle, PostgreSQL/pgvector, NextAuth v5 beta, Vitest and Playwright. Keep Bun and the lockfile pinned; do not casually switch package managers.

## 4. Target architecture

Start as a **modular monolith**, not microservices.

### Three access planes
1. **Agency staff:** tenant provisioning, subscriptions/entitlements, support access, domain and deployment health.
2. **Client members:** website content, leads, bookings, services, staff and settings, constrained by tenant role.
3. **Public visitors:** read published tenant content and submit narrowly scoped lead/booking commands.

Never trust a tenant ID, role, hostname or client selection supplied by the browser without resolving and authorizing it server-side.

### Tenant isolation
The upstream uses a client/account and membership model. Preserve it, but centralize tenant resolution and authorization. Every DB query, file operation, job, webhook, cache key and export must carry authorized tenant context.

Required defense-in-depth:
- tenant-scoped service/repository APIs and explicit tenant predicates;
- composite foreign keys or equivalent constraints where feasible;
- evaluate PostgreSQL RLS for high-risk tables if compatible with pooling/connection handling;
- cross-tenant negative tests for routes, jobs, MCP tools, exports, uploads and custom domains;
- audit events for agency impersonation/support access.

## 5. Russian infrastructure and data handling

### Provider decision is open
Selectel is a candidate, not an approved production choice. Yandex Cloud and VK Cloud remain alternatives. Do not create paid resources until deployment design, cost, backup/restore and data-location requirements are agreed.

### VPS deployment profile to validate
- Linux compute in a Russian data centre;
- PostgreSQL with required extensions;
- private S3-compatible object storage;
- reverse proxy and TLS;
- application containers;
- durable scheduler/worker for cron and queues;
- logs, health checks and error monitoring;
- encrypted automated backups with restore drills;
- secrets via environment/secret manager, never committed.

The current `docker-compose.yml` is a local development stack (app, PostgreSQL/pgvector, Mailpit, MinIO, realtime and agents), not hardened production. Railway documentation is not a Selectel/VPS deployment guide.

### Background jobs
The README documents Vercel cron jobs in `vercel.json`. Inventory each route, cadence, locking/idempotency and secret. Migrate to a durable scheduler/worker only with a job-by-job plan. Do not expose cron endpoints without strong authentication and replay protection.

### 152-FZ and personal data
Before real customer data is processed, obtain qualified legal review of 152-FZ and related obligations: data categories, purposes, operator/processor roles, notices/consent, retention/deletion, incident response, subcontractors, data location and cross-border transfers. Hosting in Russia alone does not prove compliance. Use synthetic records until legal and technical gates are passed.

### External integrations
Keep Stripe, Google/Microsoft OAuth, Resend, AI APIs, analytics and other external services disabled until individually approved for availability, contracts, data transfers and cost. Stripe is not a default Russian payment choice.

## 6. Booking — blocking integrity gap

See [BOOKING_WRITE_PATH_TRACE.md](BOOKING_WRITE_PATH_TRACE.md) for the source trace.

Confirmed findings:
- Public booking POST validates notice/advance windows, configured availability, capacity/conflicts and staff assignment.
- Client portal has booking list/calendar and status/notes/staff reassignment endpoints.
- The inspected client UI is a management/list surface, not a complete manual booking-create flow.
- Agency booking API/page is an aggregate/read surface, not a manual booking-create flow.
- MCP `bookings_update` can change start/end times directly without the public availability/capacity/conflict checks.
- Public exclusive 1:1 bookings use a database partial unique index as a race guard; preserve it.

### Required common domain service
Implement:
- `createBooking(command, actorContext)`
- `rescheduleBooking(bookingId, command, actorContext)`
- `cancelBooking(bookingId, command, actorContext)`
- `reassignBooking(bookingId, command, actorContext)`

Public website, client portal, agency console and MCP become thin adapters calling the same service. The service enforces tenant ownership, service/staff, working hours, date overrides, notice/advance, buffers, capacity, group bookings, timezone and conflicts. Mutations are transactional and retain DB-level race protection. Notifications, automation and calendar sync run after commit and are idempotent.

### Booking acceptance tests
1. Public booking blocks the slot in client and agency calendars immediately.
2. Client manual booking and agency-assisted booking use identical validation.
3. MCP cannot reschedule into unavailable or occupied time.
4. Concurrent exclusive bookings cannot both succeed.
5. Group capacity, staff availability, buffers, overrides and timezone rules match across channels.
6. Tenant A cannot mutate or reference tenant B's booking, staff or page.
7. Cancellation releases capacity only under defined status rules.
8. Notifications/calendar sync/automation emit once after commit.
9. Staff mutations record actor, tenant, channel and before/after values.

Do not sell booking as production-ready until these tests pass.

## 7. MVP for the first pilot

**Phase A — foundation**
- boot locally with documented Docker/Bun setup;
- establish reproducible test DB and baseline CI;
- map/harden tenant resolution, roles and route guards;
- define Russian deployment and operations runbooks;
- disable unneeded external integrations and scheduled jobs.

**Phase B — client website and operations**
- tenant provisioning and site/domain assignment;
- client portal and roles;
- website edit, preview and publish;
- services, prices, staff and hours;
- lead inbox/basic CRM;
- shared booking service and calendar parity;
- audit log, backups, data export and health view.

**Phase C — commercial platform**
- plans, entitlements and usage metering;
- Russian-market payment integration;
- onboarding and tenant self-service;
- GARAGE 27 vertical module, then other industries;
- monitoring, support and offboarding.

Do not bring AI agents, realtime collaboration, complex marketing automation, e-commerce or every upstream module into the first pilot without a validated need.

## 8. Security/release gates

Before real customer deployment:
- inspect authentication/session lifetime, revocation and MFA;
- verify staff and tenant guards on every API route/server action;
- test rate limiting and behavior without Redis;
- verify encryption at rest for all OAuth/API credentials and key rotation;
- audit uploads, private object permissions and signed URL expiry;
- verify webhook signatures, replay protection and idempotency;
- audit cron authorization and job locks;
- test custom domains, cache keys and tenant isolation;
- run secret scanning, dependency audit and backup/restore drills;
- review agency impersonation and immutable audit trail;
- run unit, integration, tenancy, security and critical e2e suites.

Known investigation topics (not assumed fixed): JWT/session revocation delay; rate-limit fallback when Redis is absent; any credential fields not using encrypted column helpers; tenant scoping in jobs/caches; Vercel-specific cron/runtime assumptions.

## 9. License and upstream policy

The repository declares Apache-2.0. Commercial use and modification are allowed subject to license conditions, including retaining required notices and marking modified files appropriately. Re-check LICENSE/NOTICE before redistribution. Keep upstream attribution and a record of local changes.

Track upstream security fixes; do not blindly merge; keep local changes small/reviewable and rerun release gates after each sync.

## 10. Immediate execution checklist

1. Finish source audit of tenant resolution, auth guards, schema ownership, jobs and secrets.
2. Create a tenant-surface inventory: route, actor, tenant source, guard, DB scope and test.
3. Create an integration inventory: required/optional/disabled, data shared and Russian availability.
4. Produce provider-neutral VPS design and cost comparison before provisioning.
5. Implement shared booking service and manual booking creation in client/agency UI.
6. Add cross-channel booking and cross-tenant regression tests.
7. Only then stage with synthetic data.

## 11. Explicit audit-stage exclusions

No paid cloud/VPS/database/bucket creation; no production deployment or DNS changes; no real personal data; no live payment/SMS/email/AI credentials; no upstream PR; no edits to existing AI Web Agency production/demo repositories; no claim of 152-FZ compliance without legal and technical validation.

## 12. Decision

**Adopt SimplerDevelopment as the codebase foundation, not as an unmodified finished product.** Its portal, website/CMS, CRM, tenant model, PostgreSQL/Drizzle stack and booking primitives are substantial leverage. Blocking work remains: booking parity, full tenancy/security verification, Russian infrastructure and job scheduling, integration policy and a deliberately smaller MVP. Close those blockers before feature expansion.
