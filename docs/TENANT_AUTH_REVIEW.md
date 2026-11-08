# Tenant and authorization review — source findings

**Branch:** `platform/ru-adaptation`  
**Reviewed source:** upstream `main` at `2b6b7cc75ebb7872977f5487c2f05c5ca60c1c0c`  
**Status:** focused static source review; no runtime security test has been executed in this environment.

## 1. Existing guardrails worth retaining

- `.claude/rules/tenancy.md` explicitly requires tenant filters on all tenant-owned reads/writes, rejects URL/parameter tenant identity as authoritative, requires `bun test:tenancy` after data-access changes, and requires entitlement gates for paid-module writes.
- `lib/portal-client.ts` resolves a user's available client accounts and intersects the `sd-active-client` preference with that accessible set. The cookie is a preference, not by itself proof of membership.
- Staff impersonation is handled separately and re-fetches the staff role from the database before accepting the signed impersonation token.
- `getPortalClientForCredentials` intentionally excludes impersonation, preventing a support-view context from minting durable credentials for a tenant the staff member does not belong to.
- `lib/portal-auth.ts` centralizes portal role levels: viewer < member < admin < owner; it also supports OAuth bearer scopes and service/feature entitlement checks.
- `scripts/run-tenancy.sh` deliberately ignores ambient `DATABASE_URL`, pins tests to `DATABASE_URL_TEST` or a local test DB, and avoids accidental execution against a remote database.
- Public booking tenancy tests verify slug resolution and tenant stamping for bookings/attendees.

## 2. Findings requiring adaptation decisions

### F-01 — role enforcement has a log-only rollout mode
`authorizePortal` supports `observeRole`. For routes that opt into it, an insufficient role is logged but allowed unless `AUTH_ROLE_ENFORCE=1`. This is an intentional migration mechanism, but it is unsafe as an implicit production default for a new SaaS unless the environment is explicitly configured and verified.

**Required action:** inventory every call with `observeRole: true`; classify the action and data sensitivity; set enforcement explicitly in every production/staging environment; add a startup/configuration assertion or fail-closed policy for the AI Web Agency deployment. Add tests proving viewer/member cannot perform admin/owner operations.

### F-02 — staff role vocabularies differ across admin guards
`lib/admin/auth.ts` exposes:
- `requireStaffSession`: allows `admin` and `employee`;
- `requireAdminOrEditor`: allows `admin` and `editor`.

This may reflect legacy distinctions between page and API surfaces, but it is a real policy inconsistency until every caller is mapped. A person may pass one staff gate and fail another depending on which role string they hold.

**Required action:** build a complete caller inventory for both helpers and all custom staff checks; define one canonical staff role matrix (agency owner/admin/operator/support/read-only); migrate guards and tests to that matrix. Do not simply broaden all roles.

### F-03 — client selection and impersonation are powerful trust boundaries
The active-client cookie is validated against accessible clients, which is good. Impersonation intentionally short-circuits normal membership resolution for staff support sessions, which makes correct staff-role verification, signed token validation, expiry, revocation and audit logging critical.

**Required action:** test forged/expired/revoked impersonation tokens, non-staff attempts, inaccessible tenant IDs, and credential issuance during impersonation. Require reason/ticket, actor, target tenant, start/end and mutations in an audit log. Support view should be read-only by default; write access must be explicit and time-limited.

### F-04 — entitlement checks are separate from tenant authorization
The tenancy rules explicitly require paid-module entitlement gates in addition to tenant scoping. A tenant member can be properly authenticated and still must not gain an unpurchased module.

**Required action:** map every module write route to its entitlement check and plan policy. Agency override paths must be explicit, scoped and audited. Add negative tests for expired/unsubscribed tenants.

### F-05 — application-level scoping remains the primary isolation boundary
The inspected rules and resolver demonstrate strong application-level conventions, but this review has not established universal database RLS. A missed tenant predicate in a route/job remains a high-impact risk.

**Required action:** inventory all tenant-owned tables and their tenant key; review all direct DB queries, server actions, cron jobs, webhooks, exports, caches, uploads and MCP tools. Evaluate PostgreSQL RLS on high-risk tables only after confirming transaction/session context is safely set and reset with the actual connection pool.

### F-06 — session lifetime and revocation require a deliberate policy
`lib/auth.ts` configures JWT sessions with a seven-day max age and daily idle refresh. This is not inherently a vulnerability, but staff access, membership removal, password reset, account suspension and impersonation revocation need a clear revocation strategy.

**Required action:** test that disabled users and removed tenant members lose access promptly, including bearer tokens and long-lived sessions. Define shorter staff-session lifetime and reauthentication for sensitive agency actions if supported by the product risk model.

## 3. Tenant surface inventory — required columns

Before production, build and maintain a machine-reviewable inventory with one row per route/action:
- method and route/server-action name;
- surface: public, client portal, agency, MCP, webhook or cron;
- actor type and authentication method;
- tenant source and server-side resolution function;
- required role/action and OAuth scope;
- entitlement/feature gate;
- tenant-owned tables read/written;
- file/cache/external side effects;
- idempotency and audit behavior;
- positive test and cross-tenant negative test.

The inventory must include background work and non-HTTP surfaces, not just `app/api/**`.

## 4. Required regression suite

1. User with two clients cannot access a third by changing cookie, query, route param or request body.
2. Removed member loses portal access without waiting for a stale preference cookie.
3. Viewer cannot mutate; member cannot administer; admin cannot perform owner-only actions.
4. Role rollout cannot silently remain log-only in production.
5. Agency employee/support cannot reach tenant data without a valid support context.
6. Impersonation cannot mint a durable key/token for an unowned tenant.
7. Tenant A cannot read or mutate tenant B's records through REST, MCP, exports, jobs or webhooks.
8. Expired/revoked API keys and OAuth grants fail closed.
9. A tenant without an entitlement cannot write to the paid module.
10. Cache and custom-domain resolution never serve tenant A content to tenant B's host.

## 5. Release recommendation

Do not rewrite the upstream auth system wholesale. Preserve the existing central resolvers and guards, but first normalize role vocabulary, make role enforcement fail-closed for the new deployment, audit every caller and add cross-surface tests. No real customer data should enter the fork until these checks and the separate 152-FZ/legal review are complete.
