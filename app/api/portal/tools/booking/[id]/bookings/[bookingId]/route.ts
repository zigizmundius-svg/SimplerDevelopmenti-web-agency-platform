import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { bookingPages, bookings } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { updateBookingRecord } from '@/lib/booking/service';
import { publishBookingCancelled } from '@/lib/booking/post-create';
import { getPortalClient } from '@/lib/portal-client';
import { authorizePortal, isAuthError } from '@/lib/portal-auth';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; bookingId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });

  // Service access check — match every sibling write route in the booking subtree
  const authResult = await authorizePortal({ action: 'write', requireService: 'booking' });
  if (isAuthError(authResult)) return authResult.response;

  const userId = parseInt(session.user.id, 10);
  const client = await getPortalClient(userId);
  if (!client) return NextResponse.json({ success: false, message: 'Client not found' }, { status: 404 });

  const { id, bookingId } = await params;
  const pageId = parseInt(id);

  // Verify the booking page belongs to this client
  const [page] = await db.select().from(bookingPages)
    .where(and(eq(bookingPages.id, pageId), eq(bookingPages.clientId, client.id)))
    .limit(1);

  if (!page) return NextResponse.json({ success: false, message: 'Booking page not found' }, { status: 404 });

  // Verify the booking belongs to this page
  const [booking] = await db.select().from(bookings)
    .where(and(eq(bookings.id, parseInt(bookingId)), eq(bookings.bookingPageId, pageId)))
    .limit(1);

  if (!booking) return NextResponse.json({ success: false, message: 'Booking not found' }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ success: false, message: 'Invalid JSON body' }, { status: 400 });
  }
  const { status, notes, assignedTo } = body;
  const allowedStatuses = ['confirmed', 'cancelled', 'completed', 'no_show'];

  if (status !== undefined && !allowedStatuses.includes(status)) {
    return NextResponse.json({ success: false, message: 'Invalid booking status' }, { status: 400 });
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return NextResponse.json({ success: false, message: 'Notes must be a string or null' }, { status: 400 });
  }
  if (assignedTo !== undefined && assignedTo !== null && (!Number.isInteger(assignedTo) || assignedTo <= 0)) {
    return NextResponse.json({ success: false, message: 'Invalid assignee' }, { status: 400 });
  }

  try {
    const updated = await updateBookingRecord({
      bookingId: booking.id,
      pageId,
      status,
      notes,
      assignedTo,
      actor: { actorType: 'user', actorId: userId, source: 'portal' },
    });
    if (status === 'cancelled' && booking.status !== 'cancelled') {
      await publishBookingCancelled({ page, booking: updated, actorUserId: userId, source: 'portal' });
    }
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    const statusCode = (error as { status?: number })?.status;
    if (statusCode === 400 || statusCode === 404 || statusCode === 409) {
      return NextResponse.json({ success: false, message: (error as Error).message }, { status: statusCode });
    }
    throw error;
  }
}
