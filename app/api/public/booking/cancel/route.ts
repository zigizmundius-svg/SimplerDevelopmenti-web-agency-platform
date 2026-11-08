import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { bookings, bookingPages } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publishBookingCancelled } from '@/lib/booking/post-create';
import { cancelBookingRecord } from '@/lib/booking/service';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = body && typeof body === 'object' ? body.token : null;

  if (!token) {
    return NextResponse.json({ success: false, message: 'Cancel token is required' }, { status: 400 });
  }

  let booking: typeof bookings.$inferSelect;
  try {
    booking = await cancelBookingRecord({ token, rejectPast: true });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 400 || status === 404 || status === 409) {
      return NextResponse.json({ success: false, message: (error as Error).message }, { status });
    }
    throw error;
  }

  const [page] = await db.select().from(bookingPages)
    .where(eq(bookingPages.id, booking.bookingPageId))
    .limit(1);
  if (page) {
    await publishBookingCancelled({ page, booking, actorUserId: 0, source: 'public' });
  }

  return NextResponse.json({
    success: true,
    data: { message: 'Booking cancelled successfully' },
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ success: false, message: 'Token is required' }, { status: 400 });
  }

  const [booking] = await db.select({
    id: bookings.id,
    guestName: bookings.guestName,
    startTime: bookings.startTime,
    endTime: bookings.endTime,
    timezone: bookings.timezone,
    status: bookings.status,
    pageTitle: bookingPages.title,
  }).from(bookings)
    .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
    .where(eq(bookings.cancelToken, token))
    .limit(1);

  if (!booking) {
    return NextResponse.json({ success: false, message: 'Booking not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: booking });
}
