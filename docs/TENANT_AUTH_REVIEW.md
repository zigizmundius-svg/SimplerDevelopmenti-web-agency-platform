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

## 1A. Follow-up verification on the adaptation branch

The follow-up source check confirms that the rollout switches are not enabled by default:

- `.env.example` leaves both `AUTH_ROLE_ENFORCE=` and `AUTH_SCOPE_ENFORCE=` empty.
- `lib/portal-auth.ts` therefore keeps opted-in portal role checks in observe/log-only mode unless `AUTH_ROLE_ENFORCE=1` is explicitly configured.
- The bearer-token OAuth scope check also logs insufficient scopes but allows the request unless `AUTH_SCOPE_ENFORCE=1` is explicitly configured. Existing legacy MCP keys with wildcard scopes are unaffected by this switch.
- Site-scoped portal authorization documents the same log-only rollout default for newly guarded routes.

**Release gate:** before any customer-facing deployment, inventory the routes using observe-mode role checks and bearer-token scope enforcement, add negative tests for each sensitive action, then explicitly configure both enforcement switches to `1` in every production environment. Do not flip either switch blindly before the route inventory and compatibility tests are complete. A blank environment value is not an acceptable production decision.

This is a static source/configuration finding; the active deployment environment was not inspected, so no claim is made about the values currently configured in any hosted environment.

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

### F-07 — impersonation cookie was not bound to its issuing staff identity

The signed impersonation payload contains `staffUserId`, but the original read helper only checked that the current caller had a staff role. It did not compare the payload identity with the authenticated session user. A valid cookie copied to another staff account could therefore select the original target tenant. The portal resolver and impersonation status/stop endpoints now pass the authenticated staff user ID to the shared verifier, which rejects a token minted for another identity. A unit regression test covers same-user acceptance, cross-user rejection and non-staff rejection.

**Remaining hardening:** add an auditable impersonation session record with reason/ticket, actor, target tenant, start/end and mutations; consider immediate revocation rather than relying only on the eight-hour signed-cookie TTL. This patch closes identity substitution; it does not implement those separate controls.

### F-08 — bearer credentials did not consistently revalidate account and tenant membership

The MCP request path already intersected a credential's consent allowlist with live `client_members` membership before building the tool server. The portal REST bearer path reused the credential's stored default client without the same live-membership check; role resolution could fall back to `viewer`, which still satisfies read access. The shared bearer resolvers also validated token status/expiry but did not reject a credential whose owning user had since been deactivated.

**Change on the adaptation branch:** portal API-key and OAuth-token resolution now requires the owning `users.active` record. `authorizePortal` additionally resolves the user's current role on the credential's client for every bearer REST request and denies access when the membership/ownership no longer exists. Session-based support impersonation is intentionally left on its separate path, preserving its viewer-style support access. Unit regressions cover inactive API-key/OAuth owners and removed bearer membership.

**Remaining hardening:** audit all non-`authorizePortal` REST handlers that resolve bearer credentials directly, and define whether user deactivation should also revoke stored credentials in the database or merely make them unusable. Runtime integration coverage is still required before release.


### F-09 — several website-management routes authenticated users but did not enforce tenant roles

A focused review of the website API surface found routes that checked only for a session and that the site belonged to one of the caller's clients. Because site resolution establishes tenant membership but does not establish a sufficient role, a low-privilege member could reach sensitive operations such as API-key management, custom-domain management, GitHub collaborator changes and website provisioning.

**Change on the adaptation branch:** the following actions now use `authorizePortalSite` with strict role enforcement (`observeRole: false`):
- list, create and revoke website API keys — admin role;
- add and verify custom domains — admin role;
- add GitHub repository collaborators — admin role;
- provision/re-provision a website — admin role;
- read website environments — live membership required, viewer+ allowed;
- list/create backups, copy/restore environment variables, and sync variables to Vercel — admin role;
- read/create/update/delete environment variables (which may contain secrets) — admin role;
- view deployment history — live membership required, viewer+ allowed;
- view deployment logs and raw HTTP request logs — admin role;
- publish one or all navigation drafts — admin role;
- list custom domains — live membership required, viewer+ allowed; add/remove/promote domains — admin role;
- read website branding — live membership required, viewer+ allowed; change branding — admin role;
- inspect deployment/infrastructure status — admin role.

Environment endpoints now resolve the environment by both its ID and the already-authorized website ID. They no longer rely on the active-client cookie helper, so a valid site deep link cannot accidentally resolve against a different active tenant. Deployment, logs, navigation, domains, branding and status endpoints also use the site-scoped resolver rather than trusting the active-client cookie.

The shared auth unit suite now includes regressions proving that a member is denied an admin site action and that a user with removed membership is denied site access.

**Remaining work:** this was a focused high-impact slice, not a complete audit of all 877 route handlers in the repository. Continue reviewing the remaining website, CMS, store and integration routes for session-only checks, and classify each operation before applying a role. Do not globally enable `AUTH_ROLE_ENFORCE` until the remaining observe-mode callers have been inventoried and compatibility-tested.

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


### F-10 — custom-code publication could lose concurrent drafts

The portal and MCP approval surfaces previously had separate custom-code publication implementations. Both read draft values and then wrote live values/cleared draft metadata in a separate statement. A concurrent editor save between those statements could be cleared without ever becoming live. The MCP approval path also bypassed the shared publication helper.

**Change on the adaptation branch:** custom-code publication now locks the site row with `SELECT … FOR UPDATE` inside a database transaction, promotes the locked draft, clears draft metadata in the same transaction, and revalidates the site cache only after commit. The portal endpoint and MCP `site:publish` approval now call the same helper. The helper accepts the owning client ID, and both its read and write predicates include the tenant ID when the caller supplies it.

**Verification:** the full CI suite passed on commit `9c33979`, including build, typecheck, unit shards, tenancy regression, and security/critical E2E. A follow-up edge-case hardening and dedicated helper tests were added afterward; those newest commits still require their own CI result.


### F-11 — custom-code publish preflight could become stale before the row lock

The portal publish endpoint checked for a draft using the site snapshot returned during authorization, then called the transactional publisher. A second editor could discard or publish that draft between the preflight and the transaction. Without a second check under the row lock, the publisher could promote null/stale draft fields over the live code.

**Change on the adaptation branch:** the shared publisher now selects both draft and live columns under `FOR UPDATE` and revalidates that a real, changed draft still exists before issuing the update. The portal endpoint maps this stale-request condition to HTTP 409 instead of treating it as a successful publish. The publisher also preserves live CSS/JS fields when only the other field has a draft; an empty-string draft remains an intentional clear. MCP approval writes now preserve empty strings consistently with the portal editor. Dedicated unit tests cover stale/no-draft rejection, locked promotion, partial-field preservation, and tenant-scoped not-found behavior.

**Remaining verification:** wait for CI on the latest adaptation-branch commit; do not release until the new test and build pass.


### F-12 — CMS routes relied on site membership without enforcing portal roles

A focused CMS audit found a broad pattern: many routes authenticated a session and resolved a site through `resolveClientSite`, but did not enforce the caller's tenant role. A viewer could therefore reach mutation handlers for posts, revisions, categories, tags, taxonomies, custom fields, content-type templates, media, email templates and tracking configuration. Website custom-code discard and content-type CSS/JS endpoints also lacked the strict admin role gate already present on the main site-code editor.

**Change on the adaptation branch:** the CMS route handlers now call `authorizePortalSite` with `observeRole: false` and explicit action levels. Reads use `read`; ordinary content and metadata mutations use `write`; custom code and tracking configuration use `admin`; deleting a website uses `owner`. The focused slice covers posts and revisions, categories/tags, taxonomies and terms, content types and custom fields/templates, media, email templates, block templates, AI restyling/branding generation, website settings and tracking. Custom-code discard is now admin-only and its database write includes both website ID and client ID.

**Remaining verification:** add route-level negative tests for representative viewer/member denials, inspect all remaining CMS routes (including HTML/ZIP upload and any routes not in the changed list), and run full CI on the latest branch head. Do not turn on global role enforcement based only on this slice.

### F-13 — post category/tag association IDs were not checked against the post's website

Post create/update handlers scoped the post itself to the current website but accepted category and tag IDs from the request body without verifying those IDs belonged to that same website. The join tables do not carry a tenant key, so a caller could attach another website's taxonomy rows to its post.

**Change on the adaptation branch:** a shared validator checks that all supplied category and tag IDs are positive integers and resolve within the current website before either post creation or update proceeds. Duplicate IDs are normalized before comparison. Cross-site or malformed references fail with HTTP 400. Unit tests cover cross-site IDs, invalid input, duplicate normalization and empty associations.

### F-14 — global built-in taxonomy terms were mutable through tenant routes

Taxonomy lookup intentionally allowed site-owned taxonomies and global built-ins for display. The same resolver was also used by create/update/delete term handlers, which meant a tenant could mutate terms attached to a global taxonomy shared by other tenants.

**Change on the adaptation branch:** tenant term mutations now reject global built-in taxonomies and allow writes only when the taxonomy is owned by the current website. Parent-term IDs on create/update are also checked against that same taxonomy, preventing cross-taxonomy parent links. Global built-ins remain readable.

### F-15 — email templates could reference another tenant's branding profile

Email-template creation accepted an explicit branding profile ID and loaded the profile by ID alone. The update route also accepted a profile ID without checking its owning client.

**Change on the adaptation branch:** explicit and updated email-template branding profile references are now checked against the website's owning client before being stored or rendered. Seeded email templates and the website branding updater also constrain linked profile reads/writes to the owning client.
