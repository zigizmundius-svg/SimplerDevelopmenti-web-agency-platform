import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { bookings, bookingPages, bookingQuotes, giftCertificates } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createCalendarEvent } from '@/lib/google-calendar';
import { createZoomMeeting } from '@/lib/zoom';
import { updateBookingRecord } from '@/lib/booking/service';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_BOOKING_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeKey);

    const body = await req.text();
    const sig = req.headers.get('stripe-signature') ?? '';

    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as {
        id: string;
        metadata?: {
          type?: string;
          bookingId?: string;
          bookingPageId?: string;
          clientId?: string;
          giftCertificateId?: string;
          quoteId?: string;
        };
      };

      // Handle gift certificate purchase
      if (paymentIntent.metadata?.type === 'gift_certificate') {
        const certId = paymentIntent.metadata?.giftCertificateId
          ? parseInt(paymentIntent.metadata.giftCertificateId, 10)
          : null;
        if (certId) {
          await db.update(giftCertificates)
            .set({ status: 'active', paymentStatus: 'paid', updatedAt: new Date() })
            .where(eq(giftCertificates.id, certId));
        }
        return NextResponse.json({ received: true });
      }

      // Handle quote payment
      if (paymentIntent.metadata?.type === 'booking_quote') {
        const quoteId = paymentIntent.metadata?.quoteId
          ? parseInt(paymentIntent.metadata.quoteId, 10)
          : null;
        if (quoteId) {
          await db.update(bookingQuotes)
            .set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
            .where(eq(bookingQuotes.id, quoteId));
        }
        return NextResponse.json({ received: true });
      }

      if (paymentIntent.metadata?.type !== 'booking') {
        return NextResponse.json({ received: true });
      }

      const bookingId = paymentIntent.metadata?.bookingId
        ? parseInt(paymentIntent.metadata.bookingId, 10)
        : null;

      if (!bookingId) {
        return NextResponse.json({ received: true });
      }

      // Read the pending booking and its page before committing the paid
      // transition. Conference providers may persist a meetingLink as part of
      // event creation; the confirmation outbox must only be released after
      // that link is available, otherwise a fast worker can send an incomplete
      // confirmation email.
      const [booking] = await db.select().from(bookings)
        .where(eq(bookings.id, bookingId)).limit(1);

      if (!booking || booking.paymentStatus === 'paid' || booking.status === 'cancelled') {
        return NextResponse.json({ received: true }); // idempotent
      }

      // Get booking page for conference/calendar settings.
      const [page] = await db.select().from(bookingPages)
        .where(eq(bookingPages.id, booking.bookingPageId)).limit(1);

      if (!page) {
        await updateBookingRecord({
          bookingId: booking.id,
          pageId: booking.bookingPageId,
          paymentStatus: 'paid',
          paidAt: new Date(),
          actor: { actorType: 'webhook', source: 'stripe' },
        });
        return NextResponse.json({ received: true });
      }

      const bookingTimezone = booking.timezone || page.timezone;
      let meetingLink: string | null = null;

      // Create calendar event + meeting link
      if (page.googleCalendarSync || page.conferenceType === 'google_meet') {
        const result = await createCalendarEvent({
          clientId: page.clientId,
          bookingId: booking.id,
          title: page.title,
          startTime: booking.startTime,
          endTime: booking.endTime,
          timezone: bookingTimezone,
          guestEmail: booking.guestEmail,
          guestName: booking.guestName,
          addGoogleMeet: page.conferenceType === 'google_meet',
        });
        if (result?.meetingLink) meetingLink = result.meetingLink;
      }

      if (page.conferenceType === 'zoom') {
        // createZoomMeeting persists the link before returning. Reuse it on a
        // Stripe webhook retry so a crash between provider creation and the
        // paid-state transaction cannot create a duplicate legacy Zoom room.
        meetingLink = booking.meetingLink || await createZoomMeeting({
          clientId: page.clientId,
          bookingId: booking.id,
          title: `${page.title} — ${booking.guestName}`,
          startTime: booking.startTime,
          duration: page.duration,
          timezone: bookingTimezone,
        });

        if (page.googleCalendarSync) {
          createCalendarEvent({
            clientId: page.clientId,
            bookingId: booking.id,
            title: page.title,
            description: meetingLink ? `Zoom: ${meetingLink}` : undefined,
            startTime: booking.startTime,
            endTime: booking.endTime,
            timezone: bookingTimezone,
            guestEmail: booking.guestEmail,
            guestName: booking.guestName,
          }).catch(() => {});
        }
      }

      // Commit payment and the meeting link together. This transaction writes
      // the confirmation email jobs, so workers cannot observe "paid" before
      // the provider-generated meeting link has been persisted.
      await updateBookingRecord({
        bookingId: booking.id,
        pageId: booking.bookingPageId,
        paymentStatus: 'paid',
        paidAt: new Date(),
        ...(meetingLink ? { meetingLink } : {}),
        actor: { actorType: 'webhook', source: 'stripe' },
      });

      // Confirmation emails are enqueued by updateBookingRecord only after
      // conference creation has completed.


    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as {
        id: string;
        metadata?: { type?: string; bookingId?: string };
      };

      if (paymentIntent.metadata?.type !== 'booking') {
        return NextResponse.json({ received: true });
      }

      const bookingId = paymentIntent.metadata?.bookingId
        ? parseInt(paymentIntent.metadata.bookingId, 10)
        : null;

      if (bookingId) {
        const [booking] = await db.select({
          id: bookings.id,
          bookingPageId: bookings.bookingPageId,
          paymentStatus: bookings.paymentStatus,
          status: bookings.status,
        }).from(bookings).where(eq(bookings.id, bookingId)).limit(1);
        if (booking && booking.paymentStatus === 'pending' && booking.status === 'confirmed') {
          await updateBookingRecord({
            bookingId: booking.id,
            pageId: booking.bookingPageId,
            status: 'cancelled',
            paymentStatus: 'free',
            actor: { actorType: 'webhook', source: 'stripe' },
          });
        }
      }
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object as {
        payment_intent: string | null;
        amount: number;
        amount_refunded: number;
        metadata?: { type?: string; bookingId?: string };
      };

      // A charge.refunded event also fires for partial refunds. The current
      // booking schema has no partial-refund state, so preserve paid until
      // Stripe confirms that the cumulative refunded amount covers the charge.
      const piId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (piId && charge.amount_refunded >= charge.amount) {
        const [booking] = await db.select().from(bookings)
          .where(eq(bookings.stripePaymentIntentId, piId)).limit(1);
        if (booking) {
          await updateBookingRecord({
            bookingId: booking.id,
            pageId: booking.bookingPageId,
            paymentStatus: 'refunded',
            actor: { actorType: 'webhook', source: 'stripe' },
          });
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Booking webhook error:', err);
    return NextResponse.json({ error: 'Webhook error' }, { status: 400 });
  }
}
