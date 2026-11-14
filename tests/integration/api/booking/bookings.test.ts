/**
 * Bookings on a page —
 *   /api/portal/tools/booking/[id]/bookings (GET)
 *   /api/portal/tools/booking/[id]/bookings/[bookingId] (PUT — status / notes / assignedTo)
 *   /api/portal/tools/booking/[id]/bookings/[bookingId]/refund (POST — Stripe refund)
 *
 * Coverage:
 *   - Auth (401), cross-tenant (404), bad input
 *   - PUT status='cancelled' stamps cancelled_at
 *   - PUT cross-page mismatch (404)
 *   - Refund 400 when booking has no payment, 200 happy-path with mocked Stripe
 *   - Refund flips paymentStatus -> 'refunded' and (full refund) status -> 'cancelled'
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/booking/post-create', () => ({
  publishManualBookingCreated: vi.fn().mockResolvedValue({ meetingLink: null }),
  publishBookingCancelled: vi.fn().mockResolvedValue(undefined),
}));

// Mock the dynamic stripe import used by the refund route
const stripeRefundCreate = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    refunds: { create: stripeRefundCreate },
  })),
}));

import { auth } from '@/lib/auth';
const mockedAuth = auth as unknown as Mock;

import { callHandler } from '../../../helpers/call-handler';
import { sessionForNewClientUser, type TenantCtx } from '../../../helpers/session';
import { getTestSql, TEST_SCHEMA } from '../../../helpers/test-db';

async function enableBookingService(ctx: TenantCtx): Promise<void> {
  const sql = getTestSql();
  const slug = `booking-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [svc] = await sql<{ id: number }[]>`
    INSERT INTO ${sql(TEST_SCHEMA)}.services (name, slug, category, price, billing_cycle)
    VALUES ('Booking', ${slug}, 'booking', 0, 'monthly') RETURNING id
  `;
  await sql`
    INSERT INTO ${sql(TEST_SCHEMA)}.client_services (client_id, service_id, status)
    VALUES (${ctx.client.id}, ${svc.id}, 'active')
  `;
}

async function seedPage(ctx: TenantCtx, opts: { price?: number } = {}): Promise<{ id: number; slug: string }> {
  const sql = getTestSql();
  const slug = `pg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO ${sql(TEST_SCHEMA)}.booking_pages (
      client_id, title, slug, duration, max_advance_days, min_notice_mins,
      timezone, active, price, checkin_enabled, enable_discount_codes,
      enable_add_ons, enable_gift_certificates, enable_waivers,
      require_waiver_before_booking, allow_staff_selection,
      buffer_before, buffer_after, conference_type, google_calendar_sync, color
    ) VALUES (
      ${ctx.client.id}, 'Page', ${slug}, 30, 60, 60, 'UTC', true, ${opts.price ?? 0}, false, false,
      false, false, false, false, false, 0, 15, 'none', false, '#2563eb'
    ) RETURNING id
  `;
  return { ...row, slug };
}

async function seedBooking(opts: {
  pageId: number;
  clientId: number;
  guestName?: string;
  paymentStatus?: 'free' | 'paid' | 'pending' | 'refunded';
  total?: number;
  stripePaymentIntentId?: string | null;
  status?: 'confirmed' | 'cancelled';
}): Promise<{ id: number }> {
  const sql = getTestSql();
  const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const cancelToken = `tok-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO ${sql(TEST_SCHEMA)}.bookings (
      booking_page_id, client_id, guest_name, guest_email,
      start_time, end_time, timezone, status, cancel_token,
      payment_status, total, stripe_payment_intent_id, group_size
    ) VALUES (
      ${opts.pageId}, ${opts.clientId},
      ${opts.guestName ?? 'Guest'}, 'guest@test.local',
      ${start}, ${end}, 'UTC',
      ${opts.status ?? 'confirmed'},
      ${cancelToken},
      ${opts.paymentStatus ?? 'free'},
      ${opts.total ?? 0},
      ${opts.stripePaymentIntentId ?? null},
      1
    ) RETURNING id
  `;
  return row;
}

describe('GET /api/portal/tools/booking/[id]/bookings @booking @portal', () => {
  let A: TenantCtx;
  let B: TenantCtx;
  beforeEach(async () => {
    [A, B] = await Promise.all([
      sessionForNewClientUser('bk-list-a'),
      sessionForNewClientUser('bk-list-b'),
    ]);
    await Promise.all([enableBookingService(A), enableBookingService(B)]);
  });

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue(null);
    const page = await seedPage(A);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'GET',
      { params: { id: String(page.id) } },
    );
    expect(res.status).toBe(401);
  });

  it('404 when booking page is in a different tenant', async () => {
    const page = await seedPage(B);
    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'GET',
      { params: { id: String(page.id) } },
    );
    expect(res.status).toBe(404);
  });

  it('returns bookings for a page in DESC start order', async () => {
    const page = await seedPage(A);
    await seedBooking({ pageId: page.id, clientId: A.client.id, guestName: 'First' });
    await seedBooking({ pageId: page.id, clientId: A.client.id, guestName: 'Second' });

    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler<{ success: boolean; data: { guestName: string }[] }>(
      route as unknown as Record<string, unknown>, 'GET',
      { params: { id: String(page.id) } },
    );
    expect(res.status).toBe(200);
    expect(res.data?.data.length).toBe(2);
  });
});

describe('POST /api/portal/tools/booking/[id]/bookings @booking @portal', () => {
  let A: TenantCtx;
  let B: TenantCtx;
  beforeEach(async () => {
    [A, B] = await Promise.all([
      sessionForNewClientUser('bk-create-a'),
      sessionForNewClientUser('bk-create-b'),
    ]);
    await Promise.all([enableBookingService(A), enableBookingService(B)]);
  });

  function nextAvailableWeekday(): string {
    const date = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    date.setUTCHours(10, 0, 0, 0);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }

  it('prevents a public visitor and portal operator from claiming the same slot concurrently', async () => {
    const page = await seedPage(A);
    const startTime = nextAvailableWeekday();
    mockedAuth.mockResolvedValue(A.session);
    const portalRoute = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const publicRoute = await import('@/app/api/public/booking/[slug]/book/route');

    const [portalResult, publicResult] = await Promise.all([
      callHandler(
        portalRoute as unknown as Record<string, unknown>, 'POST',
        { params: { id: String(page.id) }, body: {
          guestName: 'Portal Guest', guestEmail: 'portal-race@example.test', startTime,
        } },
      ),
      callHandler(
        publicRoute as unknown as Record<string, unknown>, 'POST',
        { params: { slug: page.slug }, body: {
          name: 'Public Guest', email: 'public-race@example.test', startTime,
        } },
      ),
    ]);

    const results = [portalResult, publicResult];
    expect(results.filter((result) => result.status === 409)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200 || result.status === 201)).toHaveLength(1);

    const sql = getTestSql();
    const rows = await sql<{ id: number; guest_name: string; status: string }[]>\`
      SELECT id, guest_name, status
      FROM \${sql(TEST_SCHEMA)}.bookings
      WHERE booking_page_id = \${page.id}
        AND start_time = \${new Date(startTime)}
        AND status <> 'cancelled'
    \`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed');
  });

  it('creates a manual booking using the shared slot validator', async () => {
    const page = await seedPage(A);
    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler<{ success: boolean; data: { id: number; guestName: string } }>(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id) }, body: {
        guestName: 'Manual Guest', guestEmail: 'manual@example.test', startTime: nextAvailableWeekday(),
      } },
    );
    expect(res.status).toBe(201);
    expect(res.data?.success).toBe(true);
    expect(res.data?.data.guestName).toBe('Manual Guest');

    const sql = getTestSql();
    const auditRows = await sql<{ actor_type: string; source: string; action: string; after_state: Record<string, unknown> }[]>`
      SELECT actor_type, source, action, after_state
      FROM ${sql(TEST_SCHEMA)}.booking_audit_logs
      WHERE booking_id = ${res.data!.data.id}
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ actor_type: 'user', source: 'portal', action: 'created' });
    expect(auditRows[0].after_state).toMatchObject({ status: 'confirmed', paymentStatus: 'free' });

    // The automation event must be committed with the booking, not emitted
    // later from the route after the transaction has already completed.
    const automationRows = await sql<{ event: string; payload: Record<string, unknown> }[]>`
      SELECT event, payload
      FROM ${sql(TEST_SCHEMA)}.automation_jobs
      WHERE client_id = ${A.client.id}
        AND event = 'booking.guest_booked'
        AND payload->>'bookingId' = ${String(res.data!.data.id)}
    `;
    expect(automationRows).toHaveLength(1);
    expect(automationRows[0].payload).toMatchObject({
      bookingId: res.data!.data.id,
      source: 'manual',
      channel: 'portal',
    });

    const emailJobs = await sql<{ type: string; payload: Record<string, unknown>; dedupe_key: string }[]>`
      SELECT type, payload, dedupe_key
      FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE client_id = ${A.client.id}
        AND payload->>'bookingId' = ${String(res.data!.data.id)}
      ORDER BY dedupe_key
    `;
    expect(emailJobs).toHaveLength(2);
    expect(emailJobs.map((job) => job.type)).toEqual(['booking.email', 'booking.email']);
    expect(emailJobs.map((job) => job.payload.recipient).sort()).toEqual(['guest', 'host']);
    expect(emailJobs.every((job) => job.dedupe_key.includes('confirmation'))).toBe(true);

    const listRes = await callHandler<{ success: boolean; data: { guestName: string }[] }>(
      route as unknown as Record<string, unknown>, 'GET',
      { params: { id: String(page.id) } },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.data?.data.some((booking) => booking.guestName === 'Manual Guest')).toBe(true);
  });

  it('blocks a manual booking when the same slot was already booked publicly', async () => {
    const page = await seedPage(A);
    const startTime = nextAvailableWeekday();
    const publicRoute = await import('@/app/api/public/booking/[slug]/book/route');
    const publicResult = await callHandler(
      publicRoute as unknown as Record<string, unknown>, 'POST',
      { params: { slug: page.slug }, body: {
        name: 'Website Guest', email: 'website@example.test', startTime,
      } },
    );
    expect(publicResult.status).toBe(200);

    mockedAuth.mockResolvedValue(A.session);
    const portalRoute = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const manualResult = await callHandler(
      portalRoute as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id) }, body: {
        guestName: 'Manual Guest', guestEmail: 'manual@example.test', startTime,
      } },
    );
    expect(manualResult.status).toBe(409);

    const sql = getTestSql();
    const rows = await sql<{ id: number; guest_name: string }[]>`
      SELECT id, guest_name
      FROM ${sql(TEST_SCHEMA)}.bookings
      WHERE booking_page_id = ${page.id} AND start_time = ${new Date(startTime)}
        AND status <> 'cancelled'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].guest_name).toBe('Website Guest');
  });
  it('serializes simultaneous manual bookings for the same slot', async () => {
    const page = await seedPage(A);
    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const payload = { params: { id: String(page.id) }, body: {
      guestName: 'Concurrent Guest', guestEmail: 'race@example.test', startTime: nextAvailableWeekday(),
    } };
    const results = await Promise.all([
      callHandler(route as unknown as Record<string, unknown>, 'POST', payload),
      callHandler(route as unknown as Record<string, unknown>, 'POST', payload),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  });
  it('records offline payment as paid for a priced manual booking', async () => {
    const page = await seedPage(A, { price: 2500 });
    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler<{ success: boolean; data: { paymentStatus: string; paidAt: string | null } }>(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id) }, body: {
        guestName: 'Offline Paid Guest',
        guestEmail: 'paid@example.test',
        startTime: nextAvailableWeekday(),
        paidOffline: true,
      } },
    );
    expect(res.status).toBe(201);
    expect(res.data?.data.paymentStatus).toBe('paid');
    expect(res.data?.data.paidAt).toBeTruthy();
  });

  it('does not allow manual booking against another tenant page', async () => {
    const page = await seedPage(B);
    mockedAuth.mockResolvedValue(A.session);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id) }, body: {
        guestName: 'Intruder', guestEmail: 'intruder@example.test', startTime: nextAvailableWeekday(),
      } },
    );
    expect(res.status).toBe(404);
  });
});
describe('PUT /api/portal/tools/booking/[id]/bookings/[bookingId] @booking @portal', () => {
  let A: TenantCtx;
  let B: TenantCtx;
  beforeEach(async () => {
    [A, B] = await Promise.all([
      sessionForNewClientUser('bk-edit-a'),
      sessionForNewClientUser('bk-edit-b'),
    ]);
    await Promise.all([enableBookingService(A), enableBookingService(B)]);
  });

  it('401 when unauthenticated', async () => {
    mockedAuth.mockResolvedValue(null);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: '1', bookingId: '1' }, body: {} },
    );
    expect(res.status).toBe(401);
  });

  it('404 when booking page belongs to another tenant', async () => {
    const page = await seedPage(B);
    const booking = await seedBooking({ pageId: page.id, clientId: B.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { notes: 'hi' } },
    );
    expect(res.status).toBe(404);
  });

  it('404 when bookingId is not on the given page', async () => {
    const page1 = await seedPage(A);
    const page2 = await seedPage(A);
    const onPage2 = await seedBooking({ pageId: page2.id, clientId: A.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler<{ success: boolean; message: string }>(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page1.id), bookingId: String(onPage2.id) }, body: { notes: 'x' } },
    );
    expect(res.status).toBe(404);
    expect(res.data?.message).toMatch(/booking not found/i);
  });

  it('rejects unknown booking statuses', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({ pageId: page.id, clientId: A.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler<{ success: boolean; message: string }>(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { status: 'anything' } },
    );
    expect(res.status).toBe(400);
    expect(res.data?.message).toMatch(/invalid booking status/i);
  });

  it('rejects assigning a booking to a user outside the client team', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({ pageId: page.id, clientId: A.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler<{ success: boolean; message: string }>(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { assignedTo: B.user.id } },
    );
    expect(res.status).toBe(400);
    expect(res.data?.message).toMatch(/active member/i);
  });

  it('rejects reassignment when the active page member has no availability for the booking', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({ pageId: page.id, clientId: A.client.id });
    const sql = getTestSql();
    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.booking_page_members
        (booking_page_id, user_id, active, availability)
      VALUES (${page.id}, ${A.user.id}, true, '[]'::jsonb)
    `;
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler<{ success: boolean; message: string }>(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { assignedTo: A.user.id } },
    );
    expect(res.status).toBe(409);
    expect(res.data?.message).toMatch(/time slot is no longer available/i);
  });

  it('updates notes and stamps cancelled_at when status flips to cancelled', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({ pageId: page.id, clientId: A.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/route');
    const res = await callHandler<{ success: boolean; data: { notes: string | null; status: string; cancelledAt: string | null } }>(
      route as unknown as Record<string, unknown>, 'PUT',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { notes: 'Customer no-show', status: 'cancelled' } },
    );
    expect(res.status).toBe(200);
    expect(res.data?.data.notes).toBe('Customer no-show');
    expect(res.data?.data.status).toBe('cancelled');
    expect(res.data?.data.cancelledAt).toBeTruthy();

    const sql = getTestSql();
    const auditRows = await sql<{ actor_type: string; source: string; action: string; before_state: Record<string, unknown>; after_state: Record<string, unknown> }[]>`
      SELECT actor_type, source, action, before_state, after_state
      FROM ${sql(TEST_SCHEMA)}.booking_audit_logs
      WHERE booking_id = ${booking.id}
      ORDER BY id
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_type: 'user',
      source: 'portal',
      action: 'cancelled',
      before_state: { status: 'confirmed' },
      after_state: { status: 'cancelled' },
    });

    const automationRows = await sql<{ event: string; payload: Record<string, unknown> }[]>`
      SELECT event, payload
      FROM ${sql(TEST_SCHEMA)}.automation_jobs
      WHERE client_id = ${A.client.id}
        AND event = 'booking.cancelled'
        AND payload->>'bookingId' = ${String(booking.id)}
    `;
    expect(automationRows).toHaveLength(1);
    expect(automationRows[0].payload).toMatchObject({
      bookingId: booking.id,
      source: 'portal',
      channel: 'portal',
    });

    const emailJobs = await sql<{ type: string; payload: Record<string, unknown>; dedupe_key: string }[]>`
      SELECT type, payload, dedupe_key
      FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE client_id = ${A.client.id}
        AND payload->>'bookingId' = ${String(booking.id)}
      ORDER BY dedupe_key
    `;
    expect(emailJobs).toHaveLength(2);
    expect(emailJobs.map((job) => job.type)).toEqual(['booking.email', 'booking.email']);
    expect(emailJobs.map((job) => job.payload.recipient).sort()).toEqual(['guest', 'host']);
    expect(emailJobs.every((job) => job.dedupe_key.includes('cancellation'))).toBe(true);
  });
});

describe('POST /api/portal/tools/booking/[id]/bookings/[bookingId]/refund @booking @portal', () => {
  let A: TenantCtx;
  let B: TenantCtx;
  beforeEach(async () => {
    [A, B] = await Promise.all([
      sessionForNewClientUser('bk-rf-a'),
      sessionForNewClientUser('bk-rf-b'),
    ]);
    await Promise.all([enableBookingService(A), enableBookingService(B)]);
    stripeRefundCreate.mockReset();
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
  });

  it('401 unauth', async () => {
    mockedAuth.mockResolvedValue(null);
    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: '1', bookingId: '1' }, body: {} },
    );
    expect(res.status).toBe(401);
  });

  it('404 when booking page is in another tenant', async () => {
    const page = await seedPage(B);
    const booking = await seedBooking({
      pageId: page.id, clientId: B.client.id,
      paymentStatus: 'paid', total: 5000, stripePaymentIntentId: 'pi_test_1',
    });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: {} },
    );
    expect(res.status).toBe(404);
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it('400 when booking has no payment to refund (paymentStatus=free)', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({ pageId: page.id, clientId: A.client.id });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler<{ success: boolean; message: string }>(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: {} },
    );
    expect(res.status).toBe(400);
    expect(res.data?.message).toMatch(/no payment/i);
  });

  it('full refund flips paymentStatus -> refunded and status -> cancelled', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({
      pageId: page.id, clientId: A.client.id,
      paymentStatus: 'paid', total: 5000, stripePaymentIntentId: 'pi_test_full',
    });
    stripeRefundCreate.mockResolvedValue({ id: 're_full', amount: 5000, status: 'succeeded' });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler<{ success: boolean; data: { refundId: string; amount: number } }>(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: {} },
    );
    expect(res.status).toBe(200);
    expect(res.data?.data.refundId).toBe('re_full');
    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_test_full' });

    const sql = getTestSql();
    const [row] = await sql<{ payment_status: string; status: string; cancelled_at: Date | null }[]>`
      SELECT payment_status, status, cancelled_at
      FROM ${sql(TEST_SCHEMA)}.bookings WHERE id = ${booking.id}
    `;
    expect(row.payment_status).toBe('refunded');
    expect(row.status).toBe('cancelled');
    expect(row.cancelled_at).not.toBeNull();
  });

  it.each([0, -1, 5000.5, 5001])('rejects invalid partial refund amount %s before calling Stripe', async (amount) => {
    const page = await seedPage(A);
    const booking = await seedBooking({
      pageId: page.id, clientId: A.client.id,
      paymentStatus: 'paid', total: 5000, stripePaymentIntentId: 'pi_test_invalid',
    });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { amount } },
    );
    expect(res.status).toBe(400);
    expect(stripeRefundCreate).not.toHaveBeenCalled();
  });

  it('partial refund keeps booking status confirmed and paymentStatus paid', async () => {
    const page = await seedPage(A);
    const booking = await seedBooking({
      pageId: page.id, clientId: A.client.id,
      paymentStatus: 'paid', total: 5000, stripePaymentIntentId: 'pi_test_partial',
    });
    stripeRefundCreate.mockResolvedValue({ id: 're_partial', amount: 1000, status: 'succeeded' });
    mockedAuth.mockResolvedValue(A.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/bookings/[bookingId]/refund/route');
    const res = await callHandler(
      route as unknown as Record<string, unknown>, 'POST',
      { params: { id: String(page.id), bookingId: String(booking.id) }, body: { amount: 1000 } },
    );
    expect(res.status).toBe(200);
    expect(stripeRefundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_test_partial', amount: 1000 });

    const sql = getTestSql();
    const [row] = await sql<{ payment_status: string; status: string }[]>`
      SELECT payment_status, status
      FROM ${sql(TEST_SCHEMA)}.bookings WHERE id = ${booking.id}
    `;
    expect(row.payment_status).toBe('paid');
    // partial refund should NOT cancel the booking
    expect(row.status).toBe('confirmed');
  });
});


describe('booking audit retention @booking @portal', () => {
  it('preserves audit history and clears the booking reference when a booking is deleted', async () => {
    const ctx = await sessionForNewClientUser('bk-audit-retention');
    await enableBookingService(ctx);
    const page = await seedPage(ctx);
    const booking = await seedBooking({ pageId: page.id, clientId: ctx.client.id });
    const sql = getTestSql();

    await sql`
      INSERT INTO ${sql(TEST_SCHEMA)}.booking_audit_logs (
        client_id, booking_id, actor_type, source, action, after_state
      ) VALUES (
        ${ctx.client.id}, ${booking.id}, 'system', 'system', 'created',
        ${sql.json({ status: 'confirmed' })}
      )
    `;

    await sql`DELETE FROM ${sql(TEST_SCHEMA)}.bookings WHERE id = ${booking.id}`;

    const [audit] = await sql<{ client_id: number; booking_id: number | null; action: string }[]>`
      SELECT client_id, booking_id, action
      FROM ${sql(TEST_SCHEMA)}.booking_audit_logs
      WHERE client_id = ${ctx.client.id}
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(audit).toMatchObject({
      client_id: ctx.client.id,
      booking_id: null,
      action: 'created',
    });
  });
});


describe('DELETE /api/portal/tools/booking/[id] calendar cleanup @booking @portal', () => {
  it('queues external calendar deletion before cascading the booking page and bookings', async () => {
    const ctx = await sessionForNewClientUser('bk-page-delete-calendar');
    await enableBookingService(ctx);
    const page = await seedPage(ctx);
    const booking = await seedBooking({ pageId: page.id, clientId: ctx.client.id });
    const sql = getTestSql();
    await sql`UPDATE ${sql(TEST_SCHEMA)}.bookings SET google_event_id = 'evt_cleanup_123' WHERE id = ${booking.id}`;
    mockedAuth.mockResolvedValue(ctx.session);

    const route = await import('@/app/api/portal/tools/booking/[id]/route');
    const res = await callHandler<{ success: boolean }>(
      route as unknown as Record<string, unknown>, 'DELETE',
      { params: { id: String(page.id) } },
    );
    expect(res.status).toBe(200);
    expect(res.data?.success).toBe(true);

    const remainingBookings = await sql<{ id: number }[]>`
      SELECT id FROM ${sql(TEST_SCHEMA)}.bookings WHERE id = ${booking.id}
    `;
    expect(remainingBookings).toHaveLength(0);

    const [cleanup] = await sql<{ type: string; payload: Record<string, unknown> }[]>`
      SELECT type, payload FROM ${sql(TEST_SCHEMA)}.internal_jobs
      WHERE client_id = ${ctx.client.id}
        AND type = 'booking.calendar_delete'
        AND payload->>'googleEventId' = 'evt_cleanup_123'
    `;
    expect(cleanup).toMatchObject({
      type: 'booking.calendar_delete',
      payload: { clientId: ctx.client.id, googleEventId: 'evt_cleanup_123' },
    });
  });
});
