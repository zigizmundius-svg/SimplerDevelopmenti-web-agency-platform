import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { createBookingRecord, resolveDefaultBookingAssignee } from '@/lib/booking/service';
import { publishManualBookingCreated } from '@/lib/booking/post-create';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPages, bookings, bookingPageMembers, clientMembers } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getPortalClient } from '@/lib/portal-client';
import { authorizePortal, isAuthError } from '@/lib/portal-auth';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  // Service access check — consistent with the booking list/create routes
  const authResult = await authorizePortal({ action: 'read', requireService: 'booking' });
  if (isAuthError(authResult)) return authResult.response;

  const userId = parseInt(session.user.id, 10);
  const client = await getPortalClient(userId);
  if (!client) return NextResponse.json({ success: false, message: 'Client not found' }, { status: 404 });

  const { id } = await params;
  const pageId = parseInt(id);

  // Verify the booking page belongs to this client
  const [page] = await db.select().from(bookingPages)
    .where(and(eq(bookingPages.id, pageId), eq(bookingPages.clientId, client.id)))
    .limit(1);

  if (!page) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });

  const pageBookings = await db
    .select()
    .from(bookings)
    .where(eq(bookings.bookingPageId, pageId))
    .orderBy(desc(bookings.startTime));

  return NextResponse.json({ success: true, data: pageBookings });
}
 
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const authResult = await authorizePortal({ action: 'write', requireService: 'booking' });
  if (isAuthError(authResult)) return authResult.response;

  const userId = parseInt(session.user.id, 10);
  const client = await getPortalClient(userId);
  if (!client) return NextResponse.json({ success: false, message: 'Client not found' }, { status: 404 });

  const { id } = await params;
  const pageId = Number.parseInt(id, 10);
  if (!Number.isInteger(pageId) || pageId <= 0) {
    return NextResponse.json({ success: false, message: 'Invalid booking page' }, { status: 400 });
  }
  const [page] = await db.select().from(bookingPages)
    .where(and(eq(bookingPages.id, pageId), eq(bookingPages.clientId, client.id)))
    .limit(1);
  if (!page) return NextResponse.json({ success: false, message: 'Not found' }, { status: 404 });
  if (!page.active) return NextResponse.json({ success: false, message: 'Booking page is inactive' }, { status: 409 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, message: 'Invalid JSON body' }, { status: 400 });
  }
  const guestName = typeof body.guestName === 'string' ? body.guestName.trim() : '';
  const guestEmail = typeof body.guestEmail === 'string' ? body.guestEmail.trim() : '';
  const guestPhone = typeof body.guestPhone === 'string' ? body.guestPhone.trim() : null;
  const startTime = new Date(body.startTime);
  const groupSize = Math.max(1, Number.parseInt(String(body.groupSize ?? 1), 10) || 1);
  const seats = page.bookingType === 'group' ? Math.max(1, Number.parseInt(String(body.seats ?? groupSize), 10) || 1) : 1;
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];

  if (!guestName || !guestEmail || !body.startTime || !Number.isFinite(startTime.getTime())) {
    return NextResponse.json({ success: false, message: 'Guest name, email and a valid start time are required' }, { status: 400 });
  }
  if (page.bookingType === 'group' && attendees.length > 0) {
    if (attendees.length !== seats || attendees.some((a: { name?: string; email?: string }) => !a?.name?.trim() || !a?.email?.trim())) {
      return NextResponse.json({ success: false, message: 'Each attendee needs a name and email, and attendee count must match seats' }, { status: 400 });
    }
  }

  let assignedTo = body.assignedTo == null || body.assignedTo === '' ? null : Number(body.assignedTo);
  if (assignedTo === null) assignedTo = await resolveDefaultBookingAssignee(page, startTime);
  if (assignedTo !== null) {
    if (!Number.isInteger(assignedTo) || assignedTo <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid assignee' }, { status: 400 });
    }
    const [teamMember] = await db.select({ userId: clientMembers.userId }).from(clientMembers)
      .where(and(eq(clientMembers.clientId, client.id), eq(clientMembers.userId, assignedTo))).limit(1);
    const [pageMember] = await db.select({ userId: bookingPageMembers.userId }).from(bookingPageMembers)
      .where(and(
        eq(bookingPageMembers.bookingPageId, page.id),
        eq(bookingPageMembers.userId, assignedTo),
        eq(bookingPageMembers.active, true),
      )).limit(1);
    if (!teamMember || !pageMember) {
      return NextResponse.json({ success: false, message: 'Assignee must be an active member of this booking page and client team' }, { status: 400 });
    }
  }

  const cancelToken = crypto.randomUUID();
  const rescheduleToken = crypto.randomBytes(32).toString('hex');
  const attendeeRows = page.bookingType === 'group'
    ? (attendees.length > 0
      ? attendees.map((a: { name: string; email: string; phone?: string; notes?: string }) => ({
          name: a.name.trim(), email: a.email.trim(), phone: a.phone?.trim() || null,
          notes: a.notes?.trim() || null, status: 'confirmed' as const,
        }))
      : Array.from({ length: seats }, (_, i) => ({
          name: i === 0 ? guestName : `${guestName} (+${i})`, email: guestEmail,
          phone: guestPhone, notes: null, status: 'confirmed' as const,
        })))
    : [];

  try {
    const created = await createBookingRecord({
      page, startTime, staffId: assignedTo, groupSize,
      booking: {
        guestName, guestEmail, guestPhone,
        notes: typeof body.notes === 'string' ? body.notes : null,
        cancelToken, rescheduleToken,
        groupSize: page.bookingType === 'group' ? seats : groupSize,
        subtotal: page.price * (page.bookingType === 'group' ? seats : groupSize),
        discountTotal: 0,
        total: page.price * (page.bookingType === 'group' ? seats : groupSize),
        paymentStatus: page.price > 0 ? (body.paidOffline === true ? 'paid' : 'pending') : 'free',
        paidAt: page.price > 0 && body.paidOffline === true ? new Date() : null,
        status: 'confirmed',
        assignedTo,
        assignedUserId: null,
        checkinCode: null,
      },
      attendees: attendeeRows,
    });
    const postCreate = await publishManualBookingCreated({ page, booking: created.booking, actorUserId: userId });
    return NextResponse.json({ success: true, data: { ...created.booking, meetingLink: postCreate.meetingLink } }, { status: 201 });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 400 || status === 409 || (err as { code?: string })?.code === '23505') {
      return NextResponse.json({ success: false, message: status ? (err as Error).message : 'This time slot is no longer available' }, { status: status || 409 });
    }
    throw err;
  }
}
