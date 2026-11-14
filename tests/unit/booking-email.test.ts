import { beforeEach, describe, expect, it, vi } from 'vitest';

const email = vi.hoisted(() => ({
  loadBrand: vi.fn(),
  guestConfirmation: vi.fn(),
  cancellation: vi.fn(),
  hostCancellation: vi.fn(),
  hostNotification: vi.fn(),
  reschedule: vi.fn(),
  resolveHost: vi.fn(),
}));

vi.mock('@/lib/email/booking-emails', () => ({
  loadBookingBrand: email.loadBrand,
  sendGuestConfirmation: email.guestConfirmation,
  sendCancellationEmail: email.cancellation,
  sendHostCancellationNotification: email.hostCancellation,
  sendHostNotification: email.hostNotification,
  sendRescheduleEmail: email.reschedule,
}));

vi.mock('@/lib/db', () => ({ db: {} }));

vi.mock('@/lib/booking/host-notification', () => ({
  resolveHostNotificationEmail: email.resolveHost,
}));

import { deliverBookingEmail } from '@/lib/jobs/booking-email';

function bookingRow(overrides: {
  status?: string;
  startTime?: Date;
} = {}) {
  const startTime = overrides.startTime ?? new Date('2026-12-01T10:00:00.000Z');
  return {
    booking: {
      id: 35,
      clientId: 7,
      bookingPageId: 11,
      status: overrides.status ?? 'confirmed',
      startTime,
      endTime: new Date(startTime.getTime() + 30 * 60_000),
      timezone: 'UTC',
      guestName: 'Guest',
      guestEmail: 'guest@example.test',
      assignedTo: null,
      cancelToken: 'cancel-token',
      rescheduleToken: 'reschedule-token',
      previousStartTime: null,
      meetingLink: null,
    },
    page: {
      id: 11,
      clientId: 7,
      title: 'Consultation',
      slug: 'consultation',
      duration: 30,
      timezone: 'UTC',
    },
  };
}

function sequentialDb(result: ReturnType<typeof bookingRow> | null) {
  const select = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.innerJoin = () => builder;
    builder.where = () => builder;
    builder.limit = async () => (result ? [result] : []);
    return builder;
  });
  return { select } as never;
}

const basePayload = {
  bookingId: 35,
  clientId: 7,
  kind: 'confirmation',
  recipient: 'guest',
};

describe('deliverBookingEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    email.loadBrand.mockResolvedValue(null);
    email.guestConfirmation.mockResolvedValue(undefined);
    email.cancellation.mockResolvedValue(undefined);
    email.hostCancellation.mockResolvedValue(undefined);
    email.hostNotification.mockResolvedValue(undefined);
    email.reschedule.mockResolvedValue(undefined);
    email.resolveHost.mockResolvedValue('host@example.test');
  });

  it('does not send a stale confirmation after cancellation', async () => {
    await deliverBookingEmail(basePayload, sequentialDb(bookingRow({ status: 'cancelled' })));

    expect(email.loadBrand).not.toHaveBeenCalled();
    expect(email.guestConfirmation).not.toHaveBeenCalled();
  });

  it('passes the persisted idempotency key to the email provider wrapper', async () => {
    const idempotencyKey = 'booking-email/confirmation/35/guest/1785530400000/1796119200000';
    await deliverBookingEmail({ ...basePayload, idempotencyKey }, sequentialDb(bookingRow()));

    expect(email.guestConfirmation).toHaveBeenCalledTimes(1);
    expect(email.guestConfirmation.mock.calls[0][1]).toBe(idempotencyKey);
  });

  it('does not send a reschedule notification for an obsolete time', async () => {
    await deliverBookingEmail({
      ...basePayload,
      kind: 'reschedule',
      startTime: '2026-12-01T11:00:00.000Z',
      endTime: '2026-12-01T11:30:00.000Z',
    }, sequentialDb(bookingRow()));

    expect(email.reschedule).not.toHaveBeenCalled();
  });

  it('propagates provider failures so the durable job can retry', async () => {
    email.guestConfirmation.mockRejectedValue(new Error('Resend unavailable'));

    await expect(deliverBookingEmail(basePayload, sequentialDb(bookingRow())))
      .rejects.toThrow('Resend unavailable');
  });

  it('does not notify a host when no host notification address is configured', async () => {
    email.resolveHost.mockResolvedValue(null);

    await deliverBookingEmail({
      ...basePayload,
      recipient: 'host',
    }, sequentialDb(bookingRow()));

    expect(email.hostNotification).not.toHaveBeenCalled();
  });
});
