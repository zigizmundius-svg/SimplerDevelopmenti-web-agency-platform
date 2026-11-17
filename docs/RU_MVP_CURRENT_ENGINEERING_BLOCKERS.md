# Russian MVP — current engineering blockers and verified status

**Branch:** `platform/ru-adaptation`  
**Reviewed commit:** `84e2ff45ff247e8e7387aa8f33f2166b37b0eafe`  
**Scope:** static repository/configuration review plus GitHub Actions results. No local clone, Russian VPS, production database, or live provider account was available in this review. No production deployment has been performed.

## 1. Verified CI status for the reviewed commit

GitHub reports 27 check runs: 19 successful and 8 skipped; no failed or queued checks remain.

Successful checks include:
- Typecheck;
- lint and repository checks;
- four unit-test shards / unit tests;
- tenancy regression;
- critical end-to-end tests (3/3);
- security end-to-end tests;
- e2e build;
- schema-drift preflight;
- Gitleaks secret scan.

Eight skipped checks are workflow/path-matrix skips, not failures. This is strong evidence for the tested code paths, but it is not a full production acceptance test and does not validate a Russian-hosted deployment.

## 2. Confirmed packaging and runtime gaps

- The root `docker-compose.yml` is explicitly a development stack: it runs `next dev`, mounts the source tree, uses local development credentials, and exposes development services. It must not be used as the production deployment file.
- No root production Dockerfile or production Compose profile is present in the repository root. Existing Dockerfiles for supporting subprojects do not package the main Next.js application.
- `railway.json` defines a Railway/Nixpacks build and start flow; it is not a Russian VPS deployment recipe.
- `next.config.ts` does not enable Next.js standalone output. Before writing a production image, the monorepo/workspace tracing requirements and runtime assets must be tested. Do not add `output: "standalone"` blindly.
- Next.js build config sets `typescript.ignoreBuildErrors: true`. The CI TypeScript check currently passes separately, so the production pipeline must retain a mandatory independent typecheck gate; a successful `next build` alone is not a type-safety signal.
- Build config wraps Sentry only when credentials exist. Sentry should remain disabled in the Russian MVP until its telemetry/data processing and endpoint availability are explicitly approved.

## 3. Database migration and extension gates

The application expects PostgreSQL with `vector`, `pg_trgm`, and `pgcrypto`. The repository's schema-sync workflow provisions a temporary PostgreSQL 18 + pgvector instance and explicitly creates all three extensions there. A selected Russian database must be tested for the same extension versions and permissions before it is approved.

The Drizzle journal currently lists four generated migration entries (baseline plus three numbered migrations), while the repository also contains numerous separately named manual SQL migrations in the 9000 range. The local Compose boot sequence explicitly runs both Drizzle migrations and `scripts/apply-local-manual-migrations.ts`. Therefore, a clean-database and upgrade-database rehearsal must include both mechanisms; running only `drizzle-kit migrate` is not enough evidence of schema completeness.

The production schema-sync workflow is additive-only and triggers on pushes to `main`; it is not a general replacement for a reviewed migration plan on a self-hosted Russian instance. Before pilot data is loaded:
1. create a clean disposable PostgreSQL database with the intended major version;
2. install/enable required extensions;
3. apply generated migrations and the manual migration runner in documented order;
4. run schema-drift checks and the full relevant test suite;
5. rehearse backup, restore, and upgrade from a prior schema snapshot.

No migration should be run against a real customer database during this preparation.

## 4. External integrations to keep out of the Russian MVP by default

The environment template and source architecture show optional integrations for:
- Stripe billing and checkout;
- Resend outbound/inbound email event handling;
- Upstash Redis rate limiting;
- Cloudflare Worker/R2 inbound-email and object-storage paths;
- Google and Microsoft OAuth/workspace/calendar/drive features;
- LinkedIn publishing;
- Sentry telemetry;
- external GitHub and DNS automation.

These are not all core requirements for the first pilot. Keep them disabled until a Russian-compatible provider/adapter, data flow, account availability, webhook delivery, and operational fallback have been tested. Do not substitute a foreign provider merely because the code already contains an adapter.

The MVP should prioritize: Russian-hosted core app and database, tenant-isolated sites/content, lead capture, booking/calendar, admin panel, Russian email/SMS notification path, file storage in Russia, backups, monitoring, and a self-hosted scheduler.

## 5. Security release gates still open

- `AUTH_ROLE_ENFORCE` and `AUTH_SCOPE_ENFORCE` are blank in `.env.example`. The tenant/auth review documents observe/log-only behavior for guarded routes unless enforcement is explicitly enabled. Before production, inventory every observe-mode caller, add negative tests for sensitive operations, then enable enforcement explicitly and verify the live configuration.
- The focused security work in the branch is substantial, but the review itself says the route audit is not complete across all route handlers and non-HTTP surfaces (jobs, webhooks, MCP, exports and server actions).
- Do not globally enable the switches before the route inventory and compatibility tests are complete; equally, do not accept blank values as a production configuration.
- Tenant isolation currently relies primarily on application-level scoping. Database RLS remains a possible defense-in-depth task, not a feature to enable without verifying pooled-connection context setup/reset.

## 6. Deployment decision

The repository is progressing and CI is green for the reviewed commit, but it is **not yet ready for a production Russian VPS deployment**.

Next engineering sequence:
1. complete the route/action authorization inventory and negative-test coverage;
2. reconcile and rehearse generated plus manual DB migrations on a clean PostgreSQL instance;
3. settle the Russian provider based on written confirmation of compute, PostgreSQL extensions, storage location, backups, network and support;
4. build and CI-test a production image for the actual monorepo;
5. implement the durable self-hosted scheduler for the 48 routes already inventoried;
6. configure Russian mail/SMS/payment adapters and shared rate limiting;
7. perform staging smoke, restore, booking concurrency, tenant-isolation and security tests before any real customer data is introduced.

**Safety rule:** do not merge the draft PR, deploy, provision paid infrastructure, or load real customer data without the owner's explicit approval.

## 7. Additional CRM authorization findings and fixes on the adaptation branch

A focused source review of the portal CRM CSV routes found two issues:

- `POST /api/portal/crm/import` checked only that the user had a session, a selected client and a CRM subscription. It did not apply the shared portal role gate, so a low-privilege viewer could reach a bulk-write path.
- `GET /api/portal/crm/export` scoped database reads to the selected tenant, but did not pass through the shared CRM entitlement gate. This allowed CRM export even when the module entitlement was absent.
- CSV export also emitted user-controlled values without neutralizing spreadsheet formula prefixes. A contact/company/deal field beginning with `=`, `+`, `-` or `@` could be interpreted as a formula by spreadsheet software.

**Fixes committed to `platform/ru-adaptation`:**
- Import now uses `authorizePortal({ action: 'write', requireService: 'crm' })`, requiring a live portal role with write permission and an active CRM entitlement.
- Export now uses `authorizePortal({ action: 'read', requireService: 'crm' })`, preserving viewer-level read access while enforcing the module entitlement.
- CSV values with a formula marker (including after leading whitespace) are prefixed with an apostrophe before normal CSV escaping.
- Unit tests were updated to mock the shared authorizer and cover unauthorized/denied import, missing export entitlement, and spreadsheet formula neutralization.

These changes are committed but must still pass the new head's GitHub Actions checks. They are source-level changes; no local test execution was possible in this environment. Continue auditing the remaining CRM mutations, booking routes and the wider 875-route API surface for equivalent gaps.
