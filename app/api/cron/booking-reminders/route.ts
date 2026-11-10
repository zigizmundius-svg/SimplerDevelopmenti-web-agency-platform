import { NextResponse } from 'next/server';
import { withCronHealth } from '@/lib/cron-health';
import { isAuthorizedCron } from '@/lib/cron-auth';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bookings, bookingPages } from '@/lib/db/schema';
import { sendBookingReminder } from '@/lib/email/booking-reminder';
import { loadBookingBrand } from '@/lib/email/booking-emails';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cron: send a single pre-booking reminder email to the guest ~24h before
 * the booking starts.
 *
 * Selection window:
 *   start_time IN (now + REMINDER_LEAD_HOURS_MIN, now + REMINDER_LEAD_HOURS_MAX]
 *   AND reminder_sent_at IS NULL
 *   AND status = 'confirmed'
 *
 * The window is wide on purpose so that even if the cron runs hourly, we
 * never miss a reminder. The de-dupe is enforced by the `reminder_sent_at`
 * column + the partial index on (start_time) WHERE reminder_sent_at IS NULL
 * defined in drizzle/0113_booking_reminder_sent_at.sql.
 *
 * Concurrency: each candidate is atomically claimed before sending. The
 * claim expires after 30 minutes so a crashed worker can be recovered by the
 * next cron tick. Successful sends stamp reminder_sent_at and clear the claim;
 * failures clear the claim immediately for retry.
 *
 * Auth: Vercel cron header OR `Authorization: Bearer ${CRON_SECRET}`.
 *
 * Schedule: every 60 minutes. (Vercel cron config lives outside this PR —
 * add `/api/cron/booking-reminders` with `0 * * * *` once this lands.)
 */

const REMINDER_LEAD_HOURS_MIN = 23; // skip reminders for bookings starting in <23h
const REMINDER_LEAD_HOURS_MAX = 25; // pick up bookings starting in 23–25h
const MS_PER_HOUR = 60 * 60 * 1000;
const REMINDER_CLAIM_LEASE_MS = 30 * 60 * 1000;

interface ReminderCandidate {
  bookingId: number;
  clientId: number;
  bookingPageId: number;
  guestName: string;
  guestEmail: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  cancelToken: string;
  meetingLink: string | null;
  pageTitle: string;
  pageSlug: string;
  duration: number;
}

async function _GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const now = new Date();
  const windowMin = new Date(now.getTime() + REMINDER_LEAD_HOURS_MIN * MS_PER_HOUR);
  const windowMax = new Date(now.getTime() + REMINDER_LEAD_HOURS_MAX * MS_PER_HOUR);

  // Only read candidate IDs here. A worker must win the database claim
  // before loading guest data or attempting delivery.
  const candidates = await db
    .select({ bookingId: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        isNull(bookings.reminderSentAt),
        gt(bookings.startTime, windowMin),
        lt(bookings.startTime, windowMax),
      ),
    );

  let sent = 0;
  let failed = 0;
  let claimedCount = 0;

  for (const candidate of candidates) {
    const claimAt = new Date();
    const staleClaimBefore = new Date(claimAt.getTime() - REMINDER_CLAIM_LEASE_MS);

    // This conditional UPDATE is the concurrency gate. PostgreSQL rechecks
    // the predicate after waiting on a row lock, so only one cron worker can
    // transition a booking from unclaimed/stale to claimed.
    const claimed = await db
      .update(bookings)
      .set({ reminderClaimedAt: claimAt })
      .where(
        and(
          eq(bookings.id, candidate.bookingId),
          eq(bookings.status, 'confirmed'),
          isNull(bookings.reminderSentAt),
          or(
            isNull(bookings.reminderClaimedAt),
            lt(bookings.reminderClaimedAt, staleClaimBefore),
          ),
          gt(bookings.startTime, windowMin),
          lt(bookings.startTime, windowMax),
        ),
      )
      .returning({ id: bookings.id });

    if (claimed.length === 0) continue;
    claimedCount++;

    try {
      // Re-read after claiming so the email uses the latest booking details.
      const [c] = await db
        .select({
          bookingId: bookings.id,
          clientId: bookings.clientId,
          bookingPageId: bookings.bookingPageId,
          guestName: bookings.guestName,
          guestEmail: bookings.guestEmail,
          startTime: bookings.startTime,
          endTime: bookings.endTime,
          timezone: bookings.timezone,
          cancelToken: bookings.cancelToken,
          meetingLink: bookings.meetingLink,
          pageTitle: bookingPages.title,
          pageSlug: bookingPages.slug,
          duration: bookingPages.duration,
        })
        .from(bookings)
        .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
        .where(
          and(
            eq(bookings.id, candidate.bookingId),
            eq(bookings.status, 'confirmed'),
            isNull(bookings.reminderSentAt),
            gt(bookings.startTime, windowMin),
            lt(bookings.startTime, windowMax),
          ),
        )
        .limit(1);

      if (!c) {
        await db
          .update(bookings)
          .set({ reminderClaimedAt: null })
          .where(and(eq(bookings.id, candidate.bookingId), eq(bookings.reminderClaimedAt, claimAt)));
        continue;
      }

      const brand = await loadBookingBrand(c.bookingPageId);
      await sendBookingReminder({
        guestName: c.guestName,
        guestEmail: c.guestEmail,
        pageTitle: c.pageTitle,
        startTime: c.startTime,
        endTime: c.endTime,
        timezone: c.timezone,
        cancelToken: c.cancelToken,
        bookingSlug: c.pageSlug,
        duration: c.duration,
        meetingLink: c.meetingLink,
        brand,
      });

      await db
        .update(bookings)
        .set({ reminderSentAt: new Date(), reminderClaimedAt: null })
        .where(
          and(
            eq(bookings.id, c.bookingId),
            eq(bookings.reminderClaimedAt, claimAt),
            isNull(bookings.reminderSentAt),
          ),
        );
      sent++;
    } catch (err) {
      failed++;
      console.error(`[booking-reminders] send failed for booking ${candidate.bookingId}`, err);
      // Release only our own claim. If the lease was recovered by another
      // worker, this stale worker must not clear the newer worker's claim.
      await db
        .update(bookings)
        .set({ reminderClaimedAt: null })
        .where(and(eq(bookings.id, candidate.bookingId), eq(bookings.reminderClaimedAt, claimAt)));
    }
  }

  const durationMs = Date.now() - t0;

  return NextResponse.json({
    success: true,
    data: {
      scanned: candidates.length,
      sent,
      failed,
      windowMin: windowMin.toISOString(),
      windowMax: windowMax.toISOString(),
      durationMs,
    },
  });
}

export const GET = withCronHealth(
  { name: 'api-cron:booking-reminders', area: 'api-cron' },
  _GET,
);
