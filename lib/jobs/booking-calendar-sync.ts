import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/lib/db';
import { bookingPages, bookings } from '@/lib/db/schema';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '@/lib/google-calendar';

type Db = typeof defaultDb;

/**
 * Reconcile the provider calendar against the booking's CURRENT state.
 * Jobs intentionally carry only a booking ID, not stale time/guest snapshots:
 * out-of-order retries therefore converge on the latest booking state.
 */
export async function reconcileBookingCalendar(
  payload: Record<string, unknown>,
  db: Db = defaultDb,
): Promise<void> {
  const bookingId = payload.bookingId;
  if (typeof bookingId !== 'number' || !Number.isInteger(bookingId) || bookingId <= 0) {
    throw new Error('booking.calendar_sync: payload.bookingId must be a positive integer');
  }

  const [row] = await db.select({ booking: bookings, page: bookingPages })
    .from(bookings)
    .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  // A deleted booking has no external appointment to maintain.
  if (!row) return;

  const { booking, page } = row;
  const eventId = booking.googleEventId || `b${booking.id.toString(32)}`;

  if (booking.status === 'cancelled' || (!page.googleCalendarSync && page.conferenceType !== 'google_meet')) {
    if (!booking.googleEventId) return;
    const deleted = await deleteCalendarEvent(booking.clientId, eventId);
    if (!deleted) throw new Error(`Google Calendar delete failed for booking ${booking.id}`);
    return;
  }

  const timezone = booking.timezone || page.timezone || 'UTC';
  if (booking.googleEventId) {
    const updated = await updateCalendarEvent({
      clientId: booking.clientId,
      googleEventId: booking.googleEventId,
      startTime: booking.startTime,
      endTime: booking.endTime,
      timezone,
    });
    if (!updated) throw new Error(`Google Calendar update failed for booking ${booking.id}`);
    return;
  }

  const created = await createCalendarEvent({
    clientId: booking.clientId,
    bookingId: booking.id,
    title: page.title,
    description: booking.meetingLink?.includes('zoom.us') ? `Zoom: ${booking.meetingLink}` : undefined,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone,
    guestEmail: booking.guestEmail,
    guestName: booking.guestName,
    addGoogleMeet: page.conferenceType === 'google_meet',
  });
  if (!created?.eventId) {
    throw new Error(`Google Calendar create failed for booking ${booking.id}`);
  }
}
