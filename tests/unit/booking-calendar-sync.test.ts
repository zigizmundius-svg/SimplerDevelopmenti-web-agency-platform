import { beforeEach, describe, expect, it, vi } from 'vitest';

const calendar = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/google-calendar', () => ({
  createCalendarEvent: calendar.create,
  updateCalendarEvent: calendar.update,
  deleteCalendarEvent: calendar.remove,
}));

import { deleteBookingCalendarEvent, reconcileBookingCalendar } from '@/lib/jobs/booking-calendar-sync';

function row(overrides: {
  status?: string;
  startTime?: Date;
  googleEventId?: string | null;
} = {}) {
  const startTime = overrides.startTime ?? new Date('2026-12-01T10:00:00.000Z');
  return {
    booking: {
      id: 35,
      clientId: 7,
      status: overrides.status ?? 'confirmed',
      startTime,
      endTime: new Date(startTime.getTime() + 30 * 60_000),
      timezone: 'UTC',
      googleEventId: overrides.googleEventId ?? null,
      guestName: 'Guest',
      guestEmail: 'guest@example.test',
      meetingLink: null,
    },
    page: {
      title: 'Consultation',
      timezone: 'UTC',
      googleCalendarSync: true,
      conferenceType: 'none',
    },
  };
}

function sequentialDb(rows: Array<ReturnType<typeof row> | null>) {
  const select = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.innerJoin = () => builder;
    builder.where = () => builder;
    builder.limit = async () => [rows.shift() ?? null].filter(Boolean);
    return builder;
  });
  return { select } as never;
}

describe('reconcileBookingCalendar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendar.create.mockResolvedValue({ eventId: 'b13', meetingLink: null });
    calendar.update.mockResolvedValue(true);
    calendar.remove.mockResolvedValue(true);
  });

  it('deletes the event if the booking is cancelled while creation is in flight', async () => {
    const db = sequentialDb([row(), row({ status: 'cancelled' }), row({ status: 'cancelled' })]);

    await reconcileBookingCalendar({ bookingId: 35 }, db);

    expect(calendar.create).toHaveBeenCalledTimes(1);
    expect(calendar.remove).toHaveBeenCalledWith(7, 'b13');
  });

  it('repeats the update when the booking is rescheduled during the provider call', async () => {
    const firstStart = new Date('2026-12-01T10:00:00.000Z');
    const secondStart = new Date('2026-12-01T12:00:00.000Z');
    const db = sequentialDb([
      row({ startTime: firstStart, googleEventId: 'google-event-1' }),
      row({ startTime: secondStart, googleEventId: 'google-event-1' }),
      row({ startTime: secondStart, googleEventId: 'google-event-1' }),
    ]);

    await reconcileBookingCalendar({ bookingId: 35 }, db);

    expect(calendar.update).toHaveBeenCalledTimes(2);
    expect(calendar.update.mock.calls[1][0].startTime).toEqual(secondStart);
  });

  it('cleans up the deterministic event if the booking is deleted during creation', async () => {
    const db = sequentialDb([row(), null]);

    await reconcileBookingCalendar({ bookingId: 35 }, db);

    expect(calendar.create).toHaveBeenCalledTimes(1);
    expect(calendar.remove).toHaveBeenCalledWith(7, 'b13');
  });

  it('rejects malformed booking identifiers', async () => {
    await expect(reconcileBookingCalendar({ bookingId: '35' }, sequentialDb([])))
      .rejects.toThrow('payload.bookingId must be a positive integer');
  });
});


describe('deleteBookingCalendarEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendar.remove.mockResolvedValue(true);
  });

  it('deletes a previously linked event using the tenant calendar connection', async () => {
    await deleteBookingCalendarEvent({ clientId: 7, googleEventId: 'event-35' });

    expect(calendar.remove).toHaveBeenCalledWith(7, 'event-35');
  });

  it('throws when the provider cannot delete the event so the queue can retry', async () => {
    calendar.remove.mockResolvedValue(false);

    await expect(deleteBookingCalendarEvent({ clientId: 7, googleEventId: 'event-35' }))
      .rejects.toThrow('Google Calendar event deletion failed');
  });

  it('rejects incomplete cleanup payloads', async () => {
    await expect(deleteBookingCalendarEvent({ clientId: 7 }))
      .rejects.toThrow('payload.googleEventId must be a non-empty string');
    expect(calendar.remove).not.toHaveBeenCalled();
  });
});
