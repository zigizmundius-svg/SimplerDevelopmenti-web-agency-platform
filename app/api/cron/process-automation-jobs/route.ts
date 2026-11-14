import { NextResponse } from 'next/server';
import { withCronHealth } from '@/lib/cron-health';
import { isAuthorizedCron } from '@/lib/cron-auth';
import { db } from '@/lib/db';
import { automationJobs } from '@/lib/db/schema';
import { and, asc, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { runHandlers } from '@/lib/automation/event-bus';
// Side-effect import: registers the automation engine handlers in THIS process
// so the cron can re-run a dropped event through the same handler set.
import '@/lib/automation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cron: retry automation events whose in-process dispatch was dropped.
 *
 * emitEvent() journals every event to automation_jobs (pending) and marks it
 * 'completed' once handlers finish in-process. If the process died first (e.g.
 * a serverless cold-start), the row stays 'pending'; this cron re-runs it,
 * giving at-least-once delivery + retries instead of the old fire-and-forget.
 *
 * Per tick:
 *  1. Reclaim expired leases atomically; crashed attempts count toward the
 *     three-attempt cap and exhausted rows move to dead_letter.
 *  2. Claim due 'pending' rows older than GRACE_MS (so we never race the
 *     in-process dispatch still handling a fresh event), CAS pending→running
 *     with a lease, re-run handlers, and only complete/retry while the exact
 *     lease token is still owned.
 */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS: Record<number, number> = { 1: 60_000, 2: 5 * 60_000 };
const GRACE_MS = 90_000;        // let in-process dispatch finish before retrying
const LEASE_MS = 10 * 60_000;   // a claimed job must complete within this or be reclaimed

async function _GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }
  const now = new Date();

  // PASS 1: reclaim expired leases atomically. Expired workers consume an
  // attempt; after MAX_ATTEMPTS the event is dead-lettered instead of being
  // retried forever. A single UPDATE prevents two cron ticks racing this step.
  await db
    .update(automationJobs)
    .set({
      status: sql`CASE WHEN ${automationJobs.attemptCount} + 1 >= ${MAX_ATTEMPTS} THEN 'dead_letter' ELSE 'pending' END`,
      attemptCount: sql<number>`${automationJobs.attemptCount} + 1`,
      nextRetryAt: sql<Date | null>`CASE
        WHEN ${automationJobs.attemptCount} + 1 >= ${MAX_ATTEMPTS} THEN NULL
        ELSE NOW() + CASE WHEN ${automationJobs.attemptCount} + 1 = 1
          THEN INTERVAL '60 seconds' ELSE INTERVAL '300 seconds' END
      END`,
      error: 'Worker lease expired before completion',
    })
    .where(and(eq(automationJobs.status, 'running'), lt(automationJobs.nextRetryAt, now)));

  // PASS 2: claim due pending jobs past the grace window.
  const graceCutoff = new Date(now.getTime() - GRACE_MS);
  const due = await db
    .select()
    .from(automationJobs)
    .where(
      and(
        eq(automationJobs.status, 'pending'),
        lt(automationJobs.createdAt, graceCutoff),
        or(isNull(automationJobs.nextRetryAt), lte(automationJobs.nextRetryAt, now)),
      ),
    )
    .orderBy(asc(automationJobs.createdAt))
    .limit(100);

  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (const job of due) {
    // CAS claim → running with an exact lease ownership token.
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    const claimed = await db
      .update(automationJobs)
      .set({ status: 'running', nextRetryAt: leaseUntil })
      .where(and(eq(automationJobs.id, job.id), eq(automationJobs.status, 'pending')))
      .returning({ id: automationJobs.id, attemptCount: automationJobs.attemptCount });
    if (claimed.length === 0) continue; // another worker took it
    const claimedAttemptCount = claimed[0].attemptCount;

    const ownsLease = and(
      eq(automationJobs.id, job.id),
      eq(automationJobs.status, 'running'),
      eq(automationJobs.nextRetryAt, leaseUntil),
    );

    try {
      await runHandlers({
        event: job.event,
        clientId: job.clientId,
        userId: job.userId,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        timestamp: job.createdAt,
      });
      const completed = await db
        .update(automationJobs)
        .set({ status: 'completed', processedAt: new Date(), nextRetryAt: null, error: null })
        .where(ownsLease)
        .returning({ id: automationJobs.id });
      if (completed.length > 0) processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = claimedAttemptCount + 1;
      if (attempts >= MAX_ATTEMPTS) {
        const updated = await db
          .update(automationJobs)
          .set({ status: 'dead_letter', attemptCount: attempts, error: message, nextRetryAt: null })
          .where(ownsLease)
          .returning({ id: automationJobs.id });
        if (updated.length > 0) deadLettered++;
      } else {
        const updated = await db
          .update(automationJobs)
          .set({
            status: 'pending',
            attemptCount: attempts,
            error: message,
            nextRetryAt: new Date(Date.now() + (BACKOFF_MS[attempts] ?? BACKOFF_MS[2])),
          })
          .where(ownsLease)
          .returning({ id: automationJobs.id });
        if (updated.length > 0) failed++;
      }
    }
  }

  return NextResponse.json({ success: true, processed, failed, deadLettered });
}

export const GET = withCronHealth(
  { name: 'api-cron:process-automation-jobs', area: 'api-cron' },
  _GET,
);
