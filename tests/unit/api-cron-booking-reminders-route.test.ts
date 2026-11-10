// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelectMock = vi.fn();
const dbUpdateMock = vi.fn();
const sendBookingReminderMock = vi.fn();
const loadBookingBrandMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
    update: (...args: unknown[]) => dbUpdateMock(...args),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  bookings: {
    id: 'bookings.id',
    status: 'bookings.status',
    reminderSentAt: 'bookings.reminderSentAt',
    reminderClaimedAt: 'bookings.reminderClaimedAt',
    startTime: 'bookings.startTime',
    bookingPageId: 'bookings.bookingPageId',
    clientId: 'bookings.clientId',
    guestName: 'bookings.guestName',
    guestEmail: 'bookings.guestEmail',
    endTime: 'bookings.endTime',
    timezone: 'bookings.timezone',
    cancelToken: 'bookings.cancelToken',
    meetingLink: 'bookings.meetingLink',
  },
  bookingPages: {
    id: 'bookingPages.id',
    title: 'bookingPages.title',
    slug: 'bookingPages.slug',
    duration: 'bookingPages.duration',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  gt: (...args: unknown[]) => ({ op: 'gt', args }),
  isNull: (...args: unknown[]) => ({ op: 'isNull', args }),
  lt: (...args: unknown[]) => ({ op: 'lt', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
}));

vi.mock('@/lib/cron-auth', () => ({
  isAuthorizedCron: () => true,
}));

vi.mock('@/lib/cron-health', () => ({
  withCronHealth: (_config: unknown, handler: (req: Request) => Promise<Response>) => handler,
}));

vi.mock('@/lib/email/booking-reminder', () => ({
  sendBookingReminder: (...args: unknown[]) => sendBookingReminderMock(...args),
}));

vi.mock('@/lib/email/booking-emails', () => ({
  loadBookingBrand: (...args: unknown[]) => loadBookingBrandMock(...args),
}));

const booking = {
  bookingId: 101,
  clientId: 7,
  bookingPageId: 11,
  guestName: 'Guest',
  guestEmail: 'guest@example.com',
  startTime: new Date('2026-11-11T12:00:00Z'),
  endTime: new Date('2026-11-11T13:00:00Z'),
  timezone: 'Europe/Riga',
  cancelToken: 'cancel-token',
  meetingLink: null,
  pageTitle: 'Consultation',
  pageSlug: 'consultation',
  duration: 60,
};

function configureDb({ claimWon = true } = {}) {
  const candidateWhere = vi.fn().mockResolvedValue([{ bookingId: 101 }]);
  const candidateFrom = vi.fn(() => ({ where: candidateWhere }));

  const detailLimit = vi.fn().mockResolvedValue([booking]);
  const detailWhere = vi.fn(() => ({ limit: detailLimit }));
  const detailJoin = vi.fn(() => ({ where: detailWhere }));
  const detailFrom = vi.fn(() => ({ innerJoin: detailJoin }));

  dbSelectMock
    .mockImplementationOnce(() => ({ from: candidateFrom }))
    .mockImplementationOnce(() => ({ from: detailFrom }));

  const updateSets: Record<string, unknown>[] = [];
  dbUpdateMock.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      updateSets.push(values);
      const wherePromise = Promise.resolve(undefined) as Promise<void> & {
        returning: () => Promise<Array<{ id: number }>>;
      };
      wherePromise.returning = vi.fn().mockResolvedValue(claimWon ? [{ id: 101 }] : []);
      return { where: () => wherePromise };
    },
  }));

  return { updateSets, detailLimit };
}

describe('GET /api/cron/booking-reminders', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    dbUpdateMock.mockReset();
    sendBookingReminderMock.mockResolvedValue(undefined);
    loadBookingBrandMock.mockResolvedValue({});
  });

  it('claims a booking before sending and clears the claim after success', async () => {
    const { updateSets } = configureDb();
    const { GET } = await import('@/app/api/cron/booking-reminders/route');

    const response = await GET(new Request('http://localhost/api/cron/booking-reminders'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(sendBookingReminderMock).toHaveBeenCalledTimes(1);
    expect(updateSets).toHaveLength(2);
    expect(updateSets[0]?.reminderClaimedAt).toBeInstanceOf(Date);
    expect(updateSets[1]?.reminderSentAt).toBeInstanceOf(Date);
    expect(updateSets[1]?.reminderClaimedAt).toBeNull();
    expect(json.data).toMatchObject({ scanned: 1, claimed: 1, sent: 1, failed: 0 });
  });

  it('does not send when another worker already owns the claim', async () => {
    const { detailLimit } = configureDb({ claimWon: false });
    const { GET } = await import('@/app/api/cron/booking-reminders/route');

    const response = await GET(new Request('http://localhost/api/cron/booking-reminders'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(detailLimit).not.toHaveBeenCalled();
    expect(sendBookingReminderMock).not.toHaveBeenCalled();
    expect(json.data).toMatchObject({ scanned: 1, claimed: 0, sent: 0, failed: 0 });
  });

  it('releases its claim when email delivery fails so a later cron tick can retry', async () => {
    const { updateSets } = configureDb();
    sendBookingReminderMock.mockRejectedValueOnce(new Error('Resend unavailable'));
    const { GET } = await import('@/app/api/cron/booking-reminders/route');

    const response = await GET(new Request('http://localhost/api/cron/booking-reminders'));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(updateSets).toHaveLength(2);
    expect(updateSets[1]).toEqual({ reminderClaimedAt: null });
    expect(json.data).toMatchObject({ scanned: 1, claimed: 1, sent: 0, failed: 1 });
  });
});
