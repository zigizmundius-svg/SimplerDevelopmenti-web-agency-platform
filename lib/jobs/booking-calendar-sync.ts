import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/lib/db';
import { bookingPages, bookings } from '@/lib/db/schema';
import { createCalendarEvent, deleteCalendarEvent, updateCalendarEvent } from '@/lib/google-calendar';

type Db = typeof defaultDb;
type BookingCalendarRow = {
  booking: typeof bookings.$inferSelect;
  page: typeof bookingPages.$inferSelect;
};

async function loadBooking(db: Db, bookingId: number): Promise<BookingCalendarRow | null> {
  const [row] = await db.select({ booking: bookings, page: bookingPages })
    .from(bookings)
    .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
    .where(and(
      eq(bookings.id, bookingId),
      eq(bookings.clientId, bookingPages.clientId),
    ))
    .limit(1);
  return row ?? null;
}

function desiredStateKey(row: BookingCalendarRow): string {
  const { booking, page } = row;
  return JSON.stringify({
    status: booking.status,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone: booking.timezone,
    googleEventId: booking.googleEventId,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    meetingLink: booking.meetingLink,
    pageTitle: page.title,
    pageTimezone: page.timezone,
    googleCalendarSync: page.googleCalendarSync,
    conferenceType: page.conferenceType,
  });
}

/**
 * Reconcile the provider calendar against the booking's CURRENT state.
 * Jobs carry only a booking ID, not stale time/guest snapshots. The bounded
 * read/perform/re-read loop also closes races with a cancellation or second
 * reschedule that commits while a provider request is in flight.
 */
export async function reconcileBookingCalendar(
  payload: Record<string, unknown>,
  db: Db = defaultDb,
): Promise<void> {
  const bookingId = payload.bookingId;
  if (typeof bookingId !== 'number' || !Number.isInteger(bookingId) || bookingId <= 0) {
    throw new Error('booking.calendar_sync: payload.bookingId must be a positive integer');
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadBooking(db, bookingId);
    if (!row) return;

    const { booking, page } = row;
    const eventId = booking.googleEventId || `b${booking.id.toString(32)}`;
    const enabled = page.googleCalendarSync || page.conferenceType === 'google_meet';

    if (booking.status === 'cancelled' || !enabled) {
      // Use the deterministic ID even when googleEventId was not persisted:
      // Google may have accepted the insert immediately before a DB failure.
      if (booking.googleEventId || enabled) {
        const deleted = await deleteCalendarEvent(booking.clientId, eventId);
        if (!deleted) throw new Error(`Google Calendar delete failed for booking ${booking.id}`);
      }
    } else {
      const timezone = booking.timezone || page.timezone || 'UTC';
      if (booking.googleEventId) {
        const updated = await updateCalendarEvent({
          clientId: booking.clientId,
          googleEventId: booking.googleEventId,
          startTime: booking.startTime,
          endTime: booking.endTime,
          timezone,
          title: page.title,
          guestName: booking.guestName,
          guestEmail: booking.guestEmail,
          description: booking.meetingLink?.includes('zoom.us')
            ? `Zoom: ${booking.meetingLink}`
            : `Booking with ${booking.guestName} (${booking.guestEmail})`,
        });
        if (!updated) throw new Error(`Google Calendar update failed for booking ${booking.id}`);
      } else {
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
    }

    const latest = await loadBooking(db, bookingId);
    if (!latest) {
      // Booking was deleted while the provider call was in flight. Clean up
      // the deterministic event so deletion cannot leave an orphan behind.
      const deleted = await deleteCalendarEvent(booking.clientId, eventId);
      if (!deleted) throw new Error(`Google Calendar cleanup failed for deleted booking ${booking.id}`);
      return;
    }
    if (desiredStateKey(latest) === desiredStateKey(row)) return;
  }

  throw new Error(`Booking ${bookingId} changed repeatedly during calendar reconciliation`);
}
