import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/lib/db';
import { bookingPages, bookings } from '@/lib/db/schema';
import {
  loadBookingBrand,
  sendCancellationEmail,
  sendGuestConfirmation,
  sendHostCancellationNotification,
  sendHostNotification,
  sendRescheduleEmail,
  type BookingEmailData,
} from '@/lib/email/booking-emails';
import { resolveHostNotificationEmail } from '@/lib/booking/host-notification';

type Db = typeof defaultDb;
type EmailKind = 'confirmation' | 'cancellation' | 'reschedule';
type Recipient = 'guest' | 'host';

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** Deliver one recipient per job so a host failure cannot resend a guest email. */
export async function deliverBookingEmail(
  payload: Record<string, unknown>,
  db: Db = defaultDb,
): Promise<void> {
  const bookingId = payload.bookingId;
  const clientId = payload.clientId;
  const kind = payload.kind;
  const recipient = payload.recipient;
  if (typeof bookingId !== 'number' || !Number.isInteger(bookingId) || bookingId <= 0) {
    throw new Error('booking.email: payload.bookingId must be a positive integer');
  }
  if (typeof clientId !== 'number' || !Number.isInteger(clientId) || clientId <= 0) {
    throw new Error('booking.email: payload.clientId must be a positive integer');
  }
  if (!['confirmation', 'cancellation', 'reschedule'].includes(String(kind))) {
    throw new Error('booking.email: unsupported email kind');
  }
  if (recipient !== 'guest' && recipient !== 'host') {
    throw new Error('booking.email: recipient must be guest or host');
  }

  const [row] = await db.select({ booking: bookings, page: bookingPages })
    .from(bookings)
    .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
    .where(and(
      eq(bookings.id, bookingId),
      eq(bookings.clientId, clientId),
      eq(bookingPages.clientId, clientId),
    ))
    .limit(1);
  if (!row) return;

  const { booking, page } = row;
  const emailKind = kind as EmailKind;
  const idempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length > 0
    ? payload.idempotencyKey
    : undefined;

  // Skip stale notifications when a later state transition superseded them.
  if (emailKind === 'confirmation' && booking.status === 'cancelled') return;
  if (emailKind === 'cancellation' && booking.status !== 'cancelled') return;

  const timezone = booking.timezone || page.timezone || 'UTC';
  const brand = await loadBookingBrand(page.id);
  const hostEmail = recipient === 'host'
    ? await resolveHostNotificationEmail(booking.clientId, booking.assignedTo)
    : null;
  if (recipient === 'host' && !hostEmail) return;

  if (emailKind === 'reschedule') {
    const newStartTime = parseDate(payload.startTime, booking.startTime);
    const newEndTime = parseDate(payload.endTime, booking.endTime);
    // A later reschedule supersedes this notification; its own job will send.
    if (booking.status !== 'confirmed' || booking.startTime.getTime() !== newStartTime.getTime()) return;
    await sendRescheduleEmail({
      guestName: booking.guestName,
      guestEmail: booking.guestEmail,
      pageTitle: page.title,
      newStartTime,
      newEndTime,
      previousStartTime: parseDate(payload.previousStartTime, booking.previousStartTime || booking.startTime),
      timezone,
      cancelToken: booking.cancelToken,
      rescheduleToken: booking.rescheduleToken,
      bookingSlug: page.slug,
      duration: page.duration,
      meetingLink: booking.meetingLink,
      hostEmail: recipient === 'host' ? hostEmail : null,
      brand,
    }, recipient, idempotencyKey);
    return;
  }

  if (recipient === 'guest') {
    if (emailKind === 'confirmation') {
      const data: BookingEmailData = {
        guestName: booking.guestName,
        guestEmail: booking.guestEmail,
        pageTitle: page.title,
        startTime: booking.startTime,
        endTime: booking.endTime,
        timezone,
        cancelToken: booking.cancelToken,
        bookingSlug: page.slug,
        duration: page.duration,
        meetingLink: booking.meetingLink,
        bookingId: booking.id,
        createdAt: booking.createdAt,
        brand,
      };
      await sendGuestConfirmation(data, idempotencyKey);
    } else {
      await sendCancellationEmail(
        booking.guestEmail,
        booking.guestName,
        page.title,
        booking.startTime,
        timezone,
        page.slug,
        brand,
        idempotencyKey,
      );
    }
    return;
  }

  if (emailKind === 'confirmation') {
    await sendHostNotification(hostEmail!, {
      guestName: booking.guestName,
      guestEmail: booking.guestEmail,
      pageTitle: page.title,
      startTime: booking.startTime,
      endTime: booking.endTime,
      timezone,
      cancelToken: booking.cancelToken,
      bookingSlug: page.slug,
      duration: page.duration,
      meetingLink: booking.meetingLink,
      bookingId: booking.id,
      createdAt: booking.createdAt,
      brand,
    }, idempotencyKey);
  } else {
    await sendHostCancellationNotification({
      hostEmail: hostEmail!,
      guestName: booking.guestName,
      pageTitle: page.title,
      startTime: booking.startTime,
      timezone,
      idempotencyKey,
    });
  }
}
