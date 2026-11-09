import type { bookingPages, bookings } from '@/lib/db/schema';
import { createCalendarEvent, deleteCalendarEvent } from '@/lib/google-calendar';
import { createZoomMeeting, deleteZoomMeeting } from '@/lib/zoom';

type BookingPage = typeof bookingPages.$inferSelect;
type Booking = typeof bookings.$inferSelect;

/**
 * Side effects for a booking created by an authenticated operator.
 * The database transaction has already committed before this function runs.
 * Each integration is best-effort: an email/calendar outage must not roll back
 * or make the operator believe the booking itself failed.
 */
export async function publishManualBookingCreated(input: {
  page: BookingPage;
  booking: Booking;
}): Promise<{ meetingLink: string | null }> {
  const { page, booking } = input;
  const timezone = booking.timezone || page.timezone || 'UTC';
  let meetingLink: string | null = booking.meetingLink ?? null;

  try {
    if (page.conferenceType === 'zoom') {
      meetingLink = await createZoomMeeting({
        clientId: page.clientId,
        bookingId: booking.id,
        title: `${page.title} — ${booking.guestName}`,
        startTime: booking.startTime,
        duration: page.duration,
        timezone,
      });
    }

    if (page.googleCalendarSync || page.conferenceType === 'google_meet') {
      const calendarResult = await createCalendarEvent({
        clientId: page.clientId,
        bookingId: booking.id,
        title: page.title,
        description: meetingLink ? `Zoom: ${meetingLink}` : undefined,
        startTime: booking.startTime,
        endTime: booking.endTime,
        timezone,
        guestEmail: booking.guestEmail,
        guestName: booking.guestName,
        addGoogleMeet: page.conferenceType === 'google_meet',
      });
      if (calendarResult?.meetingLink) meetingLink = calendarResult.meetingLink;
    }
  } catch (error) {
    console.error('[booking] Manual booking calendar/conference setup failed:', error);
  }

  // Confirmation emails are persisted by createBookingRecord's transaction.

  return { meetingLink };
}

/** Best-effort cancellation integrations after the shared cancellation
 * transaction commits. */
export async function publishBookingCancelled(input: {
  page: BookingPage;
  booking: Booking;
}): Promise<void> {
  const { page, booking } = input;
  if (booking.googleEventId) {
    await deleteCalendarEvent(booking.clientId, booking.googleEventId).catch((error) => {
      console.warn('[booking] Calendar cancellation failed:', error);
    });
  }
  if (booking.meetingLink?.includes('zoom.us')) {
    await deleteZoomMeeting(booking.clientId, booking.meetingLink).catch((error) => {
      console.warn('[booking] Zoom cancellation failed:', error);
    });
  }

  // Guest/host cancellation emails are persisted by cancelBookingRecord.


}
