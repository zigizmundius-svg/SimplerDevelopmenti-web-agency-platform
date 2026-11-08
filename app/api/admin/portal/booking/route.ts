import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPages, bookings, clients, users, bookingPageMembers, clientMembers, clientServices, services } from '@/lib/db/schema';
import { eq, desc, gte, lte, count, and, sql } from 'drizzle-orm';
import { createBookingRecord, resolveDefaultBookingAssignee } from '@/lib/booking/service';
import { publishManualBookingCreated } from '@/lib/booking/post-create';

async function requireStaff() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const role = (session.user as { role?: string })?.role;
  if (role !== 'admin' && role !== 'employee') return null;
  return session;
}

// E2 perf — the prior aggregator grouped ALL bookings by bookingPageId with
// no time bound. On a tenant with months of historical bookings that scan
// dominates the request. Now we time-bound the booking count + upcoming
// list to the same 30-day window the UI renders. Both queries land on the
// new (start_time, status) and (booking_page_id) indexes from
// 0132_perf_admin_approvals_indexes.sql.
export async function POST(req: Request) {
  const session = await requireStaff();
  if (!session) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, message: 'Invalid JSON body' }, { status: 400 });
  }

  const pageId = Number(body.bookingPageId);
  if (!Number.isInteger(pageId) || pageId <= 0) {
    return NextResponse.json({ success: false, message: 'Valid bookingPageId is required' }, { status: 400 });
  }
  const [page] = await db.select().from(bookingPages)
    .where(eq(bookingPages.id, pageId))
    .limit(1);
  if (!page) return NextResponse.json({ success: false, message: 'Booking page not found' }, { status: 404 });
  if (!page.active) return NextResponse.json({ success: false, message: 'Booking page is inactive' }, { status: 409 });

  const [bookingEntitlement] = await db.select({ id: clientServices.id })
    .from(clientServices)
    .innerJoin(services, eq(clientServices.serviceId, services.id))
    .where(and(
      eq(clientServices.clientId, page.clientId),
      eq(clientServices.status, 'active'),
      eq(services.slug, 'booking'),
    ))
    .limit(1);
  if (!bookingEntitlement) {
    return NextResponse.json({ success: false, message: 'Client does not have an active booking service' }, { status: 403 });
  }

  const guestName = typeof body.guestName === 'string' ? body.guestName.trim() : '';
  const guestEmail = typeof body.guestEmail === 'string' ? body.guestEmail.trim() : '';
  const guestPhone = typeof body.guestPhone === 'string' ? body.guestPhone.trim() : null;
  const startTime = new Date(body.startTime);
  const seats = page.bookingType === 'group'
    ? Math.max(1, Number.parseInt(String(body.seats ?? 1), 10) || 1)
    : 1;
  const groupSize = Math.max(1, Number.parseInt(String(body.groupSize ?? 1), 10) || 1);

  if (!guestName || !guestEmail || !body.startTime || !Number.isFinite(startTime.getTime())) {
    return NextResponse.json({ success: false, message: 'Guest name, email and a valid start time are required' }, { status: 400 });
  }

  let assignedTo = body.assignedTo == null || body.assignedTo === '' ? null : Number(body.assignedTo);
  if (assignedTo === null) assignedTo = await resolveDefaultBookingAssignee(page, startTime);
  if (assignedTo !== null) {
    if (!Number.isInteger(assignedTo) || assignedTo <= 0) {
      return NextResponse.json({ success: false, message: 'Invalid assignee' }, { status: 400 });
    }
    const [teamMember] = await db.select({ userId: clientMembers.userId }).from(clientMembers)
      .where(and(eq(clientMembers.clientId, page.clientId), eq(clientMembers.userId, assignedTo))).limit(1);
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

  try {
    const created = await createBookingRecord({
      page,
      startTime,
      staffId: assignedTo,
      groupSize,
      booking: {
        guestName,
        guestEmail,
        guestPhone,
        notes: typeof body.notes === 'string' ? body.notes : null,
        cancelToken: crypto.randomUUID(),
        rescheduleToken: crypto.randomBytes(32).toString('hex'),
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
      attendees: page.bookingType === 'group'
        ? Array.from({ length: seats }, (_, i) => ({
            name: i === 0 ? guestName : `${guestName} (+${i})`,
            email: guestEmail,
            phone: guestPhone,
            notes: null,
            status: 'confirmed' as const,
          }))
        : [],
    });
    const postCreate = await publishManualBookingCreated({
      page,
      booking: created.booking,
      actorUserId: Number.parseInt(String(session.user.id), 10) || 0,
    });
    return NextResponse.json({ success: true, data: { ...created.booking, meetingLink: postCreate.meetingLink } }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 409 || (error as { code?: string })?.code === '23505') {
      return NextResponse.json({ success: false, message: (error as Error).message }, { status: status || 409 });
    }
    throw error;
  }
}

export async function GET() {
  if (!await requireStaff()) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  try {

  const now = new Date();
  const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Get all booking pages with client info
  const pages = await db
    .select({
      id: bookingPages.id,
      title: bookingPages.title,
      slug: bookingPages.slug,
      duration: bookingPages.duration,
      bookingType: bookingPages.bookingType,
      groupCapacity: bookingPages.groupCapacity,
      price: bookingPages.price,
      active: bookingPages.active,
      googleCalendarSync: bookingPages.googleCalendarSync,
      timezone: bookingPages.timezone,
      createdAt: bookingPages.createdAt,
      company: clients.company,
      clientName: users.name,
    })
    .from(bookingPages)
    .innerJoin(clients, eq(bookingPages.clientId, clients.id))
    .innerJoin(users, eq(clients.userId, users.id))
    .orderBy(desc(bookingPages.createdAt));

  // E2 — restrict booking counts to the same 30-day window the UI renders,
  // and use the (start_time, status) index for the upcoming partition.
  const bookingCounts = await db
    .select({
      bookingPageId: bookings.bookingPageId,
      total: count(),
      upcoming: sql<number>`sum(case when ${bookings.startTime} >= now() then 1 else 0 end)`,
    })
    .from(bookings)
    .where(and(
      gte(bookings.startTime, now),
      lte(bookings.startTime, thirtyDaysFromNow),
    ))
    .groupBy(bookings.bookingPageId);

  const countMap = new Map(bookingCounts.map(c => [c.bookingPageId, { total: c.total, upcoming: Number(c.upcoming) }]));

  const pagesWithCounts = pages.map(p => ({
    ...p,
    totalBookings: countMap.get(p.id)?.total ?? 0,
    upcomingBookings: countMap.get(p.id)?.upcoming ?? 0,
  }));

  // Get upcoming bookings (next 30 days)
  const upcomingBookings = await db
    .select({
      id: bookings.id,
      guestName: bookings.guestName,
      guestEmail: bookings.guestEmail,
      guestPhone: bookings.guestPhone,
      startTime: bookings.startTime,
      endTime: bookings.endTime,
      timezone: bookings.timezone,
      status: bookings.status,
      createdAt: bookings.createdAt,
      bookingPageTitle: bookingPages.title,
      company: clients.company,
      clientName: users.name,
    })
    .from(bookings)
    .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
    .innerJoin(clients, eq(bookings.clientId, clients.id))
    .innerJoin(users, eq(clients.userId, users.id))
    .where(and(
      gte(bookings.startTime, now),
      lte(bookings.startTime, thirtyDaysFromNow),
    ))
    .orderBy(bookings.startTime);

  const totalPages = pages.length;
  const activePages = pages.filter(p => p.active).length;
  const totalUpcoming = upcomingBookings.length;

  return NextResponse.json({
    success: true,
    pages: pagesWithCounts,
    upcomingBookings,
    stats: { totalPages, activePages, totalUpcoming },
  });
  } catch (error) {
    console.error('Booking API error:', error);
    return NextResponse.json({ success: false, message: String(error) }, { status: 500 });
  }
}
