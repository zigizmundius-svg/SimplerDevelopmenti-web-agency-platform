import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  bookingPages, bookings, bookingAddOns, bookingSelectedAddOns,
  discountCodes, giftCertificates, giftCertificateRedemptions,
  clientWebsites, storeSettings, products, productVariants,
} from '@/lib/db/schema';
import { eq, and, ne, gte, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { createCalendarEvent } from '@/lib/google-calendar';
import { createZoomMeeting } from '@/lib/zoom';
import { createBookingRecord, resolveDefaultBookingAssignee, updateBookingRecord, validateBookingSlot } from '@/lib/booking/service';
import { resolveApprovalContext } from '@/lib/mcp/approval-mode';

interface AttendeeInput {
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

function generateCheckinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 for readability
  let code = 'BK-';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // An approval reviewer is looking at an INACTIVE page (approving is what flips
  // active=true), so the active filter cannot be part of the lookup here.
  const [page] = await db.select().from(bookingPages)
    .where(eq(bookingPages.slug, slug))
    .limit(1);

  if (!page) return NextResponse.json({ success: false, message: 'Booking page not found' }, { status: 404 });

  // ─── Approval-mode shim (PUX-067/070) ──────────────────────────────────────
  // The reviewer walks the whole funnel — real availability, real staff, real
  // pricing — and reaches the confirmation screen, while NOTHING happens: no
  // booking row, no hold, no Stripe intent, no calendar event, no Zoom meeting,
  // no guest or host email, no discount-usage increment, no automation event.
  //
  // Returned deliberately WITHOUT `clientSecret`, which is what makes the widget
  // treat it as a free booking and go straight to `confirmed` rather than into
  // the payment step. No payment surface is reachable in approval mode.
  //
  // This must stay above the body parse and every write below it. The middleware
  // gate is what actually protects the data — this path is only reachable
  // because it is on the shim allowlist.
  const approval = await resolveApprovalContext('booking_page', page.id);
  if (approval && approval.clientId === page.clientId) {
    const previewStart = new Date();
    const previewEnd = new Date(previewStart.getTime() + (page.duration ?? 30) * 60_000);
    return NextResponse.json({
      success: true,
      approvalPreview: true,
      message: 'Draft preview — no booking was made.',
      data: {
        id: null,
        guestName: 'Draft preview',
        guestEmail: null,
        startTime: previewStart.toISOString(),
        endTime: previewEnd.toISOString(),
        timezone: page.timezone,
        status: 'preview',
        paymentStatus: 'preview',
        meetingLink: null,
        checkinCode: null,
      },
    });
  }

  // Past this point the caller is a real visitor, so the page must be live.
  if (!page.active) {
    return NextResponse.json({ success: false, message: 'Booking page not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ success: false, message: 'Invalid JSON body' }, { status: 400 });
  }
  const {
    name, email, phone, startTime, timezone, answers,
    groupSize: rawGroupSize,
    addOns: selectedAddOns, // Array<{ addOnId: number; quantity: number }>
    discountCode: rawDiscountCode,
    giftCertificateCode: rawGiftCertCode,
    staffId, // optional staff member ID when allowStaffSelection is enabled
    // Group / class bookings
    seats: rawSeats,
    attendees: rawAttendees, // AttendeeInput[]
  } = body;

  const isGroupBooking = page.bookingType === 'group';
  const attendees: AttendeeInput[] = Array.isArray(rawAttendees) ? rawAttendees : [];
  const seats = isGroupBooking
    ? Math.max(1, parseInt(String(rawSeats ?? attendees.length ?? 1)) || 1)
    : 1;

  if (typeof name !== 'string' || !name.trim()) return NextResponse.json({ success: false, message: 'Name is required' }, { status: 400 });
  if (typeof email !== 'string' || !email.trim()) return NextResponse.json({ success: false, message: 'Email is required' }, { status: 400 });
  if (phone !== undefined && phone !== null && typeof phone !== 'string') return NextResponse.json({ success: false, message: 'Phone must be a string' }, { status: 400 });
  if (timezone !== undefined && typeof timezone !== 'string') return NextResponse.json({ success: false, message: 'Timezone must be a string' }, { status: 400 });
  if (!startTime) return NextResponse.json({ success: false, message: 'Start time is required' }, { status: 400 });

  const slotStart = new Date(startTime);
  if (isNaN(slotStart.getTime())) {
    return NextResponse.json({ success: false, message: 'Invalid start time' }, { status: 400 });
  }

  const slotEnd = new Date(slotStart.getTime() + page.duration * 60 * 1000);
  const groupSize = Math.max(1, parseInt(String(rawGroupSize)) || 1);

  if (isGroupBooking) {
    if (attendees.length > 0 && attendees.length !== seats) {
      return NextResponse.json({ success: false, message: 'Number of attendees must match seat count' }, { status: 400 });
    }
    for (const attendee of attendees) {
      if (typeof attendee?.name !== 'string' || !attendee.name.trim() || typeof attendee?.email !== 'string' || !attendee.email.trim()) {
        return NextResponse.json({ success: false, message: 'Each attendee needs a name and email' }, { status: 400 });
      }
    }
  }
  // Resolve the assignee and reject unavailable slots before loading pricing
  // add-ons, discounts, or gift certificates. The shared create service repeats
  // this validation under the page lock immediately before inserting the booking.
  const hasVisitorStaffChoice = Boolean(staffId) && page.allowStaffSelection;
  const visitorSelectedStaff = hasVisitorStaffChoice ? Number(staffId) : null;
  if (hasVisitorStaffChoice && (!Number.isInteger(visitorSelectedStaff) || (visitorSelectedStaff ?? 0) <= 0)) {
    return NextResponse.json({ success: false, message: 'Invalid staff selection' }, { status: 400 });
  }
  const assignedTo = hasVisitorStaffChoice
    ? visitorSelectedStaff
    : await resolveDefaultBookingAssignee(page, slotStart);
  const autoAssignedUserId = visitorSelectedStaff
    ? null
    : (page.assignmentMode && page.assignmentMode !== 'fixed' ? assignedTo : null);
  const slotValidation = await validateBookingSlot({
    page, startTime: slotStart, requestedSeats: seats, groupSize, staffId: assignedTo,
  });
  if (!slotValidation.ok) {
    return NextResponse.json({ success: false, message: slotValidation.message }, { status: slotValidation.status });
  }

  // ─── CALCULATE TOTAL ──────────────────────────────────────────────────────

  // Base price
  let subtotal = (page.price || 0) * groupSize;

  // Resolve and price add-ons
  const addOnDetails: { addOnId: number; quantity: number; unitPrice: number; name: string }[] = [];
  if (page.enableAddOns && Array.isArray(selectedAddOns) && selectedAddOns.length > 0) {
    for (const sel of selectedAddOns) {
      const [addOn] = await db.select().from(bookingAddOns)
        .where(and(eq(bookingAddOns.id, sel.addOnId), eq(bookingAddOns.bookingPageId, page.id), eq(bookingAddOns.active, true)))
        .limit(1);
      if (!addOn) continue;

      const qty = Math.min(Math.max(1, sel.quantity || 1), addOn.maxQuantity || 10);
      let unitPrice = addOn.price || 0;
      let addOnName = addOn.name || 'Add-on';

      // Resolve product price if linked
      if (addOn.source === 'product' && addOn.productId) {
        const [product] = await db.select().from(products)
          .where(eq(products.id, addOn.productId)).limit(1);
        if (product) {
          unitPrice = product.price;
          addOnName = product.name;
          if (addOn.variantId) {
            const [variant] = await db.select().from(productVariants)
              .where(eq(productVariants.id, addOn.variantId)).limit(1);
            if (variant?.price) unitPrice = variant.price;
          }
        }
      }

      subtotal += unitPrice * qty;
      addOnDetails.push({ addOnId: addOn.id, quantity: qty, unitPrice, name: addOnName });
    }
  }

  // Apply discount code
  let discountTotal = 0;
  let appliedDiscountCode: string | null = null;

  if (page.enableDiscountCodes && rawDiscountCode) {
    let websiteId = page.websiteId;
    if (!websiteId) {
      const [site] = await db.select({ id: clientWebsites.id }).from(clientWebsites)
        .where(and(eq(clientWebsites.clientId, page.clientId), eq(clientWebsites.active, true)))
        .limit(1);
      websiteId = site?.id ?? null;
    }

    if (websiteId) {
      const [discount] = await db.select().from(discountCodes)
        .where(and(
          eq(discountCodes.websiteId, websiteId),
          eq(discountCodes.code, rawDiscountCode.toUpperCase()),
          eq(discountCodes.active, true),
          sql`${discountCodes.applicableTo} IN ('booking', 'both')`,
        ))
        .limit(1);

      if (discount) {
        const dNow = new Date();
        const valid = (!discount.startsAt || dNow >= discount.startsAt)
          && (!discount.expiresAt || dNow <= discount.expiresAt)
          && (!discount.maxUses || discount.usedCount < discount.maxUses)
          && (!discount.minOrderAmount || subtotal >= discount.minOrderAmount);

        if (valid) {
          appliedDiscountCode = discount.code;
          if (discount.discountType === 'percent') {
            discountTotal = Math.round(subtotal * (discount.amount / 10000));
          } else if (discount.discountType === 'fixed_amount') {
            discountTotal = Math.min(discount.amount, subtotal);
          }
        }
      }
    }
  }

  // Apply gift certificate
  let giftCertAmount = 0;
  let appliedGiftCertCode: string | null = null;

  if (page.enableGiftCertificates && rawGiftCertCode) {
    const [cert] = await db.select().from(giftCertificates)
      .where(and(
        eq(giftCertificates.code, rawGiftCertCode.toUpperCase()),
        eq(giftCertificates.status, 'active'),
        eq(giftCertificates.clientId, page.clientId),
        sql`${giftCertificates.redeemableAt} IN ('booking', 'both')`,
      ))
      .limit(1);

    if (cert && cert.remainingAmount > 0) {
      const afterDiscount = subtotal - discountTotal;
      giftCertAmount = Math.min(cert.remainingAmount, afterDiscount);
      appliedGiftCertCode = cert.code;
    }
  }

  const total = Math.max(0, subtotal - discountTotal - giftCertAmount);

  // ─── CREATE BOOKING ────────────────────────────────────────────────────────

  const cancelToken = crypto.randomUUID();
  const rescheduleToken = crypto.randomBytes(32).toString('hex');
  const checkinCode = page.checkinEnabled ? generateCheckinCode() : null;
  const needsPayment = total > 0;

  let booking: typeof bookings.$inferSelect;
  const attendeeRows = isGroupBooking
    ? (attendees.length > 0
      ? attendees.map(a => ({
          name: (a.name || '').trim(),
          email: (a.email || '').trim(),
          phone: a.phone?.trim() || null,
          notes: a.notes?.trim() || null,
          status: 'confirmed' as const,
        }))
      : Array.from({ length: seats }, (_, i) => ({
          name: i === 0 ? name.trim() : `${name.trim()} (+${i})`,
          email: email.trim(),
          phone: phone?.trim() || null,
          notes: null,
          status: 'confirmed' as const,
        })))
    : [];
  try {
    const created = await createBookingRecord({
      page,
      startTime: slotStart,
      timezone: timezone || page.timezone,
      staffId: assignedTo,
      groupSize,
      booking: {
        guestName: name.trim(),
        guestEmail: email.trim(),
        guestPhone: phone?.trim() || null,
        answers: answers || null,
        cancelToken,
        rescheduleToken,
        groupSize: isGroupBooking ? seats : groupSize,
        subtotal,
        discountTotal,
        total,
        discountCode: appliedDiscountCode,
        giftCertificateCode: appliedGiftCertCode,
        giftCertificateAmount: giftCertAmount,
        checkinCode,
        assignedTo,
        assignedUserId: autoAssignedUserId,
        paymentStatus: needsPayment ? 'pending' : 'free',
        status: 'confirmed',
      },
      attendees: attendeeRows,
      actor: { actorType: 'guest', source: 'public' },
    });
    booking = created.booking;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400 || status === 409 || (err as { code?: string })?.code === '23505') {
      return NextResponse.json(
        { success: false, message: status ? (err as Error).message : 'This time slot is no longer available' },
        { status: status || 409 },
      );
    }
    throw err;
  }

  // Save selected add-ons
  if (addOnDetails.length > 0) {
    await db.insert(bookingSelectedAddOns).values(
      addOnDetails.map(a => ({
        bookingId: booking.id,
        addOnId: a.addOnId,
        quantity: a.quantity,
        unitPrice: a.unitPrice,
        productName: a.name,
      }))
    );
  }

  // Redeem gift certificate (partial)
  if (appliedGiftCertCode && giftCertAmount > 0) {
    const [cert] = await db.select().from(giftCertificates)
      .where(and(
        eq(giftCertificates.code, appliedGiftCertCode),
        eq(giftCertificates.clientId, page.clientId),
      )).limit(1);
    if (cert) {
      const newRemaining = cert.remainingAmount - giftCertAmount;
      await db.update(giftCertificates)
        .set({
          remainingAmount: newRemaining,
          status: newRemaining <= 0 ? 'fully_redeemed' : 'active',
          updatedAt: new Date(),
        })
        .where(eq(giftCertificates.id, cert.id));

      await db.insert(giftCertificateRedemptions).values({
        giftCertificateId: cert.id,
        amount: giftCertAmount,
        context: 'booking',
        referenceId: booking.id,
        referenceType: 'booking',
      });
    }
  }

  // ─── PAYMENT ───────────────────────────────────────────────────────────────

  if (needsPayment) {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

    // Check if website has Stripe Connect (use connected account for payouts)
    let stripeParams: Parameters<typeof stripe.paymentIntents.create>[0] = {
      amount: total,
      currency: 'usd',
      metadata: {
        type: 'booking',
        bookingId: String(booking.id),
        bookingPageId: String(page.id),
        clientId: String(page.clientId),
      },
    };

    if (page.websiteId) {
      const [store] = await db.select().from(storeSettings)
        .where(and(eq(storeSettings.websiteId, page.websiteId), eq(storeSettings.enabled, true)))
        .limit(1);

      if (store?.stripeAccountId && store.stripeOnboardingComplete) {
        const platformFeePercent = store.platformFeePercent ? parseFloat(store.platformFeePercent) : 5;
        const applicationFee = Math.round(total * (platformFeePercent / 100));

        stripeParams = {
          ...stripeParams,
          currency: store.currency?.toLowerCase() || 'usd',
          application_fee_amount: applicationFee,
          transfer_data: { destination: store.stripeAccountId },
        };
      }
    }

    const paymentIntent = await stripe.paymentIntents.create(stripeParams);

    await db.update(bookings)
      .set({ stripePaymentIntentId: paymentIntent.id })
      .where(eq(bookings.id, booking.id));

    // Increment discount code usage
    if (appliedDiscountCode) {
      await db.update(discountCodes)
        .set({ usedCount: sql`${discountCodes.usedCount} + 1`, updatedAt: new Date() })
        .where(eq(discountCodes.code, appliedDiscountCode));
    }

    return NextResponse.json({
      success: true,
      data: {
        id: booking.id,
        clientSecret: paymentIntent.client_secret,
        total,
        paymentStatus: 'pending',
      },
    });
  }

  // ─── FREE BOOKING — send confirmations immediately ─────────────────────────

  // Increment discount code usage for free bookings too
  if (appliedDiscountCode) {
    await db.update(discountCodes)
      .set({ usedCount: sql`${discountCodes.usedCount} + 1`, updatedAt: new Date() })
      .where(eq(discountCodes.code, appliedDiscountCode));
  }

  const bookingTimezone = timezone || page.timezone;
  let meetingLink: string | null = null;

  if (page.googleCalendarSync || page.conferenceType === 'google_meet') {
    const result = await createCalendarEvent({
      clientId: page.clientId,
      bookingId: booking.id,
      title: page.title,
      startTime: slotStart,
      endTime: slotEnd,
      timezone: bookingTimezone,
      guestEmail: booking.guestEmail,
      guestName: booking.guestName,
      addGoogleMeet: page.conferenceType === 'google_meet',
    });
    if (result?.meetingLink) meetingLink = result.meetingLink;
  }

  if (page.conferenceType === 'zoom') {
    meetingLink = await createZoomMeeting({
      clientId: page.clientId,
      bookingId: booking.id,
      title: `${page.title} — ${booking.guestName}`,
      startTime: slotStart,
      duration: page.duration,
      timezone: bookingTimezone,
    });
    if (meetingLink) {
      await updateBookingRecord({
        bookingId: booking.id,
        pageId: page.id,
        meetingLink,
        actor: { actorType: 'guest', source: 'public' },
      }).catch((error) => console.warn('[booking] Could not persist legacy Zoom link:', error));
    }

    if (page.googleCalendarSync) {
      createCalendarEvent({
        clientId: page.clientId,
        bookingId: booking.id,
        title: page.title,
        description: meetingLink ? `Zoom: ${meetingLink}` : undefined,
        startTime: slotStart,
        endTime: slotEnd,
        timezone: bookingTimezone,
        guestEmail: booking.guestEmail,
        guestName: booking.guestName,
      }).catch(() => {});
    }
  }

  // Confirmation emails are queued transactionally by createBookingRecord.

  return NextResponse.json({
    success: true,
    data: {
      id: booking.id,
      guestName: booking.guestName,
      guestEmail: booking.guestEmail,
      startTime: booking.startTime,
      endTime: booking.endTime,
      timezone: booking.timezone,
      status: booking.status,
      paymentStatus: 'free',
      meetingLink,
      checkinCode,
    },
  });
}
