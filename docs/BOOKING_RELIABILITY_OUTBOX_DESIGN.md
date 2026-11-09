# Booking reliability and transactional outbox design

Status: partially implemented on `platform/ru-adaptation`. Booking audit rows, automation journal rows, Google Calendar reconciliation jobs, and guest/host email jobs are now written in the shared booking transactions. Legacy Zoom operations remain best-effort.

## Scope

The next reliability pass covers booking creation, rescheduling, cancellation, payment webhooks, notifications, calendar/conference integrations, and automation events. The target is a PostgreSQL-backed modular monolith; do not introduce Redis or a separate broker for this stage.

## What already exists

- `internal_jobs` is a durable PostgreSQL queue with a unique optional `dedupe_key`, attempt count, lease expiry, retry backoff, and dead-letter state.
- `lib/jobs/index.ts` exposes `enqueueJob(params, db)`; importantly, the second argument accepts the caller's Drizzle database/transaction handle. A producer can therefore insert a job in the same transaction as its domain mutation.
- `app/api/cron/process-internal-jobs/route.ts` drains the queue every minute. The worker uses a pending-to-running compare-and-set claim, lease recovery, bounded batches, and retries.
- `internal_jobs` supports `pod.submit`, `email.campaign_send`, `automation.delayed_action`, `booking.calendar_sync`, and `booking.email`.
- `automation_jobs` is a separate automation-event journal. It is not a general-purpose outbox: it has no producer idempotency key and is not transactionally coupled to booking writes.
- `emitEvent()` remains fire-and-forget for non-booking domains. Booking create/reschedule/cancel and payment-confirmation transitions now insert their `automation_jobs` journal row inside the same transaction as the booking mutation, then dispatch the already-journaled event after commit. The existing retry cron remains the crash-recovery path.
- `lib/booking/post-create.ts` retains immediate Google Calendar/legacy Zoom fast paths for manual bookings; transactional queue jobs provide calendar recovery and all booking email delivery.
- Existing Zoom create/update/delete operations remain legacy best-effort paths and are not part of the durable queue.
- `agent_action_log` records MCP/automation/assistant tool activity; it is not a complete actor/channel audit trail for human booking operations.

## Reliability gaps confirmed

1. **Commit-to-enqueue gap:** booking state can commit while the process dies before any follow-up job/event is persisted.
2. **Lost integration work:** calendar, Zoom, and email failures in booking post-create/cancel paths are logged but not placed on a durable retry queue.
3. **Duplicate side effects:** retries can repeat non-idempotent external operations unless each operation has its own idempotency/reconciliation strategy.
4. **Automation duplication:** the event journal provides at-least-once replay, but no stable event identity is attached to the domain mutation; replay may execute non-idempotent automation actions twice.
5. **Incomplete actor history:** source labels exist in some event payloads, but there is no single append-only booking audit record that consistently captures actor, channel, action, before/after state, and request correlation.

## Recommended implementation

### 1. Reuse the existing PostgreSQL queue

Extend `InternalJobType` with narrowly scoped booking jobs, for example:
- `booking.created`
- `booking.rescheduled`
- `booking.cancelled`

Do not put these internal job payloads on `automation_jobs`: that journal is part of the tenant automation event surface and may be visible to rule builders or site webhook subscriptions.

### 2. Enqueue inside the domain transaction

The booking service should create the domain row and enqueue its follow-up job using the same transaction handle:

```ts
await db.transaction(async (tx) => {
  // validate + write booking
  // await enqueueJob({ clientId, type, payload, dedupeKey }, tx)
});
```

Use stable keys tied to the domain transition, not timestamps, e.g. `booking.created:<bookingId>` and a monotonically increasing transition/version for subsequent changes. A booking can be rescheduled or cancelled more than once, so `booking.rescheduled:<bookingId>` alone is not sufficient.

The job payload should contain identifiers and immutable transition metadata, not a copy of unnecessary personal data. The worker should re-read the tenant-scoped booking/page and verify the transition is still applicable.

### 3. Make each external effect independently safe

A single booking job may need multiple effects (calendar, conference link, guest email, host email, automation event). Track each effect separately, with a stable effect key and state. Use provider idempotency keys where supported. Where a provider does not support idempotency, reconcile by a stored provider event/resource ID before retrying.

Do not claim true exactly-once delivery: a process can die after a provider accepts a request but before the local success marker commits. The practical target is at-least-once execution with idempotent or reconcilable effects.

### 4. Separate required and optional effects

- Required internal state transitions must commit atomically with the queued work.
- External integrations remain best-effort from the user's request perspective, but are retried durably and become visible as failed/dead-letter work for operators.
- A failed email/calendar call must never roll back a booking already committed.
- A retry must not re-open, re-cancel, or otherwise mutate booking state a second time.

### 5. Add booking audit events

Write an append-only booking audit record in the same transaction as each booking state transition. Minimum fields:
- tenant/client ID and booking ID;
- actor type and actor ID (user, guest/public token, system/webhook, MCP);
- channel/source (public site, client portal, agency panel, MCP, Stripe);
- action (created, rescheduled, status changed, cancelled, payment/refund transition);
- before/after snapshots limited to operational fields;
- request/correlation ID and timestamp.

Avoid storing payment secrets or unnecessary personal data in audit snapshots. Keep AI tool logs distinct from this domain audit.

## Implementation sequence

1. Add focused tests for the existing queue's transactional enqueue, dedupe behavior, lease reclaim, and retry/dead-letter transitions.
2. Add a booking transition/outbox schema and migration, or a dedicated effect ledger linked to `internal_jobs` if that is cleaner after reviewing migration conventions.
3. Refactor booking create/reschedule/cancel services to write audit + enqueue atomically.
4. Implement queue handlers and per-effect idempotency/reconciliation.
5. Convert Stripe webhook transitions to stable event/idempotency handling and test payment-vs-cancellation races.
6. Add operator visibility for failed/dead-letter booking effects.
7. Run unit, integration, typecheck, lint, and build in CI before considering the work release-ready.

## Explicit non-goals for this pass

- No Redis or external message broker.
- No production deployment, paid infrastructure, or real customer data.
- No merge to `main`; work remains on `platform/ru-adaptation` and the existing Draft PR.
- No claim of test success until workflows actually run and report success.


## Additional queue defect found during the follow-up review

The existing `drainInternalJobs()` reclaimed an expired `running` lease without incrementing `attempt_count`, allowing a repeatedly crashing handler to retry forever.

### Implemented on `platform/ru-adaptation`

- Lease recovery now increments `attempt_count` in the same SQL UPDATE that chooses `pending` or `dead_letter`.
- The retry delay is assigned in that same statement (60 seconds after the first expired lease, then 5 minutes); the maximum-attempt transition cannot be interleaved with a second cron tick.
- Each claimed worker now carries its exact lease-expiry timestamp as an ownership token. Completion/retry/dead-letter writes require both `status = running` and that exact token, so a stale worker cannot overwrite a row after another drainer has reclaimed it.
- The cron result counters only count a completion/failure transition when its guarded UPDATE actually changed a row.
- Added `tests/unit/jobs.test.ts` for bounded lease recovery, dead-letter counting, and the no-reclaim case. These are focused unit tests with a stubbed Drizzle surface; they do not replace a real PostgreSQL concurrency/integration test.

The implementation is committed but **not yet executed by Vitest, typecheck, or CI**. The next verification step is to run the new test and add a database-backed concurrent-drainer test before relying on this queue for booking effects.


## PostgreSQL migration and concurrency coverage

A second audit found that `lib/db/schema/jobs.ts` declared `internal_jobs`, but the only migration registered in `drizzle/meta/_journal.json` did not create it. A clean database built by replaying the migration set would therefore be missing the queue table.

Implemented:
- Added `drizzle/0001_internal_jobs.sql` with the table, tenant FK, unique dedupe key, and due-work index.
- Registered the migration as journal entry 1.
- Added `tests/integration/api/internal-jobs.test.ts`, which inserts expired leases into PostgreSQL and runs two drainers concurrently through independent database pools (not the app's single-connection pool). It asserts exactly one retryable lease is reclaimed and exactly one exhausted lease is dead-lettered, with the expected attempt counts.
- The same integration file checks that concurrent repeated `enqueueJob()` calls with one dedupe key produce exactly one row.

This integration test has been committed but has **not yet run**. The CI workflow currently has no reported run for the branch; do not treat the test as verified until CI or a controlled local test database reports its result.


## Booking audit foundation — implemented, verification pending

The first implementation slice adds `booking_audit_logs` and migration
`0002_booking_audit_logs.sql`. The table records tenant, booking, actor type,
optional actor user ID, source channel, action, operational before/after state,
request correlation ID, and timestamp. It is indexed by booking/time and
tenant/time.

The shared booking service writes the audit row in the SAME PostgreSQL
transaction as:
- booking creation;
- public rescheduling;
- non-time updates, including payment/status changes;
- cancellation.

The operational snapshot intentionally excludes guest email/phone, free-form
notes, answers, cancellation/reschedule tokens, and payment-provider IDs.

Actor attribution is wired for public creation/reschedule/cancel, client-portal
manual creation/update/refund, agency manual creation, MCP cancellation/update,
and Stripe webhook transitions. Service calls without explicit context are
recorded as `system` / `system` rather than left unaudited.

Integration assertions were added for portal-created and portal-cancelled
bookings, including actor/channel and before/after state. They have NOT been
executed yet; the latest commit currently has no reported GitHub Actions runs.

### Transactional booking automation journal — implemented, verification pending

The shared booking service now inserts a row into `automation_jobs` in the same
transaction as the booking mutation for:
- `booking.guest_booked` on public and manual creation;
- `booking.rescheduled` on public rescheduling;
- `booking.cancelled` on cancellation/status transitions, including MCP and
  Stripe-driven cancellation;
- `booking.confirmed` when payment transitions from pending to paid.

After commit, the service asks the automation engine to dispatch that exact
journal row in-process. If the process stops before dispatch/completion, the
existing `process-automation-jobs` cron can replay the still-pending row after
its grace window. Legacy post-commit booking event emissions were removed from
the public routes and post-create helpers to avoid duplicate automation runs.
The legacy `source: 'manual'` value is preserved for portal/agency booking
creation; the precise channel is also included separately.

Integration assertions now check that portal creation and cancellation each
produce exactly one matching automation journal row. These tests are
committed but have NOT been executed.

### Booking effects queue — implemented, verification pending

The existing PostgreSQL `internal_jobs` queue now handles:
- `booking.calendar_sync`: transactionally enqueued by booking create, reschedule, cancellation, and payment-confirmation transitions. The worker reads the booking's current state and reconciles Google Calendar, so delayed jobs do not replay stale time snapshots. Deterministic Google event IDs protect create retries; missing/cancelled bookings are handled without restoring stale appointments.
- `booking.email`: transactionally enqueued for guest and host separately on eligible booking confirmation, reschedule, and cancellation events. Payloads contain booking/client IDs and event timing only; guest contact data and tokens are loaded from the tenant-scoped booking row at delivery time. Separate recipient jobs prevent a failed host email from forcing a guest email to be resent.
- Resend failures are propagated to the queue, including API responses that resolve with an `error` field instead of throwing. The queue retries with backoff and moves exhausted work to `dead_letter`.

Public paid bookings deliberately do not create calendar events or send confirmation emails before Stripe confirms payment. The payment transition enqueues those effects. Existing fast-path calendar calls remain in place where they provide immediate feedback; the queued reconciliation is the durable recovery path. New Zoom setup remains out of MVP. Existing Zoom create/update/delete paths are retained as legacy best-effort behavior and are not yet durable.

This is at-least-once delivery, not exactly-once. If Resend accepts a message and the worker dies before marking the job complete, a retry can send a duplicate because provider-side idempotency is not currently wired. Calendar creation is protected by the stable event ID; calendar updates are idempotent patches. Operator-facing dead-letter visibility and retry controls remain to be built.



### Operator visibility — implemented, verification pending

Agency staff can inspect the latest 150 internal jobs at `/admin/internal-jobs`, filter by state, see attempt counts, next retry/processed timestamps, and the last error. Dead-letter jobs can be manually returned to pending; the retry action resets the attempt counter and error state. The API is protected by the existing staff-role gate. The UI does not expose job payloads or guest contact data.

## Dispatch concurrency note

The in-process dispatcher and retry cron must compete for the same atomic `pending -> running` claim. A dispatcher may complete or release a row only while it still owns the exact lease timestamp. The cron also applies the three-attempt cap to expired leases and uses the attempt count returned by the successful claim when calculating retry/dead-letter state. Delivery remains at-least-once, so external handlers must be idempotent.


## Calendar side-effect idempotency

Google Calendar booking event creation now uses a deterministic event ID derived from the booking's database ID (base32hex, valid for Google Calendar event IDs). If Google creates the event but the application fails before saving `googleEventId`, a retry receives a conflict and reads the already-created event instead of inserting a duplicate. Google Meet conference creation also uses a stable request ID. Deleting an event that is already absent is treated as success.

Calendar create/update/delete operations are now reconciled by the `booking.calendar_sync` internal job. Booking emails are dispatched by separate `booking.email` jobs per recipient. Both job families are enqueued in the same transaction as the booking state change. These paths are implemented but remain unverified by typecheck, Vitest, and CI.
