# Booking reliability and transactional outbox design

Status: design/audit only. No runtime behavior is changed by this document.

## Scope

The next reliability pass covers booking creation, rescheduling, cancellation, payment webhooks, notifications, calendar/conference integrations, and automation events. The target is a PostgreSQL-backed modular monolith; do not introduce Redis or a separate broker for this stage.

## What already exists

- `internal_jobs` is a durable PostgreSQL queue with a unique optional `dedupe_key`, attempt count, lease expiry, retry backoff, and dead-letter state.
- `lib/jobs/index.ts` exposes `enqueueJob(params, db)`; importantly, the second argument accepts the caller's Drizzle database/transaction handle. A producer can therefore insert a job in the same transaction as its domain mutation.
- `app/api/cron/process-internal-jobs/route.ts` drains the queue every minute. The worker uses a pending-to-running compare-and-set claim, lease recovery, bounded batches, and retries.
- `internal_jobs` currently supports `pod.submit`, `email.campaign_send`, and `automation.delayed_action`.
- `automation_jobs` is a separate automation-event journal. It is not a general-purpose outbox: it has no producer idempotency key and is not transactionally coupled to booking writes.
- `emitEvent()` is intentionally fire-and-forget. It inserts into `automation_jobs` asynchronously and dispatches handlers in-process. A process can terminate between a booking commit and the journal insert.
- `lib/booking/post-create.ts` currently performs Zoom/Google Calendar setup, guest/host email and automation emission after the booking transaction. Most integrations are best-effort; a failure is logged, not durably retried.
- Cancellation integrations are also invoked after the cancellation transaction and are best-effort.
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
