import type { bookingPages, bookings } from '@/lib/db/schema';
import { createCalendarEvent, deleteCalendarEvent } from '@/lib/google-calendar';
import { createZoomMeeting, deleteZoomMeeting } from '@/lib/zoom';
import { emitEvent } from '@/lib/automation';
import { sendGuestConfirmation, sendHostNotification, sendCancellationEmail, loadBookingBrand } from '@/lib/email/booking-emails';
import { resolveHostNotificationEmail } from '@/lib/booking/host-notification';

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
  actorUserId: number;
}): Promise<{ meetingLink: string | null }> {
  const { page, booking, actorUserId } = input;
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

  emitEvent('booking.guest_booked', page.clientId, actorUserId, {
    bookingId: booking.id,
    bookingPageId: page.id,
    pageTitle: page.title,
    pageSlug: page.slug,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    guestPhone: booking.guestPhone,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone,
    groupSize: booking.groupSize,
    total: Number(booking.total ?? 0) / 100,
    paymentStatus: booking.paymentStatus,
    answers: booking.answers,
    source: 'manual',
  });

  const emailData = {
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    pageTitle: page.title,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone,
    cancelToken: booking.cancelToken,
    bookingSlug: page.slug,
    duration: page.duration,
    meetingLink,
    brand: await loadBookingBrand(page.id).catch(() => null),
  };

  void sendGuestConfirmation(emailData).catch((error) => {
    console.warn('[booking] Manual guest confirmation failed:', error);
  });

  void (async () => {
    const hostEmail = await resolveHostNotificationEmail(page.clientId, booking.assignedTo).catch(() => null);
    if (hostEmail) await sendHostNotification(hostEmail, emailData);
  })().catch((error) => {
    console.warn('[booking] Manual host notification failed:', error);
  });

  return { meetingLink };
}

/** Best-effort cancellation integrations after the shared cancellation
 * transaction commits. */
export async function publishBookingCancelled(input: {
  page: BookingPage;
  booking: Booking;
  actorUserId: number;
  source: 'public' | 'portal' | 'agency' | 'mcp';
}): Promise<void> {
  const { page, booking, actorUserId, source } = input;
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

  const brand = await loadBookingBrand(page.id).catch(() => null);
  void sendCancellationEmail(
    booking.guestEmail,
    booking.guestName,
    page.title,
    booking.startTime,
    booking.timezone || page.timezone || 'UTC',
    page.slug,
    brand,
  ).catch((error) => {
    console.warn('[booking] Guest cancellation email failed:', error);
  });

  const hostEmail = await resolveHostNotificationEmail(page.clientId, booking.assignedTo).catch(() => null);
  if (hostEmail) {
    try {
      const { resend } = await import('@/lib/email/index');
      await resend.emails.send({
        from: `SimplerDevelopment <${process.env.RESEND_FROM_EMAIL || 'bookings@simplerdevelopment.com'}>`,
        to: hostEmail,
        subject: `Booking Cancelled: ${booking.guestName} — ${page.title}`,
        html: `<p><strong>${booking.guestName}</strong> cancelled their ${page.title} appointment on ${new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: booking.timezone || page.timezone || 'UTC' }).format(booking.startTime)}.</p>`,
      });
    } catch (error) {
      console.warn('[booking] Host cancellation email failed:', error);
    }
  }

  emitEvent('booking.cancelled', booking.clientId, actorUserId, {
    bookingId: booking.id,
    bookingPageId: page.id,
    pageTitle: page.title,
    pageSlug: page.slug,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    startTime: booking.startTime,
    timezone: booking.timezone,
    source,
  });
}
