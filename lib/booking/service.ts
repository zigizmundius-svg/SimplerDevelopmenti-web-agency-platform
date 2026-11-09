import { db } from '@/lib/db';
import { bookingPages, bookings, bookingAttendees, bookingPageMembers, clientMembers, bookingAuditLogs, automationJobs } from '@/lib/db/schema';
import { and, eq, ne, lte, gte, sql } from 'drizzle-orm';
import { isSlotWithinAvailability, type BookingQueryDb } from '@/lib/booking/availability';
import { checkSlotCapacity } from '@/lib/booking/capacity';
import { pickAssignee } from '@/lib/booking/assign';

type BookingPage = typeof bookingPages.$inferSelect;

export type BookingAuditContext = {
  actorType: 'guest' | 'user' | 'system' | 'webhook' | 'mcp';
  actorId?: number | null;
  source: 'public' | 'portal' | 'agency' | 'mcp' | 'stripe' | 'system';
  requestId?: string | null;
};

type BookingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function bookingAuditSnapshot(booking: typeof bookings.$inferSelect): Record<string, unknown> {
  // Deliberately excludes guest contact details, free-form notes, answers,
  // tokens, and payment identifiers. The audit trail stores operational state.
  return {
    status: booking.status,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone: booking.timezone,
    assignedTo: booking.assignedTo,
    paymentStatus: booking.paymentStatus,
    total: booking.total,
    groupSize: booking.groupSize,
  };
}

async function writeBookingAudit(
  tx: BookingTx,
  input: {
    clientId: number;
    bookingId: number;
    action: 'created' | 'rescheduled' | 'updated' | 'cancelled';
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
    actor?: BookingAuditContext;
  },
): Promise<void> {
  const actor = input.actor ?? { actorType: 'system' as const, source: 'system' as const };
  await tx.insert(bookingAuditLogs).values({
    clientId: input.clientId,
    bookingId: input.bookingId,
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    source: actor.source,
    action: input.action,
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? null,
    requestId: actor.requestId ?? null,
  });
}

/** A booking mutation and its automation journal row are committed together. */
type PendingBookingAutomation = {
  jobId: number;
  event: {
    event: string;
    clientId: number;
    userId: number;
    payload: Record<string, unknown>;
    timestamp: Date;
  };
};

async function writeBookingAutomationEvent(
  tx: BookingTx,
  input: {
    event: 'booking.guest_booked' | 'booking.rescheduled' | 'booking.cancelled' | 'booking.confirmed';
    page: BookingPage;
    booking: typeof bookings.$inferSelect;
    actor?: BookingAuditContext;
    beforeBooking?: typeof bookings.$inferSelect;
  },
): Promise<PendingBookingAutomation> {
  const { page, booking, actor } = input;
  const channel = actor?.source ?? 'system';
  // Preserve the legacy "manual" source consumed by existing automation rules,
  // while exposing the precise channel separately for newer integrations.
  const source = channel === 'portal' || channel === 'agency' ? 'manual' : channel;
  const payload: Record<string, unknown> = {
    bookingId: booking.id,
    bookingPageId: page.id,
    pageTitle: page.title,
    pageSlug: page.slug,
    guestName: booking.guestName,
    guestEmail: booking.guestEmail,
    guestPhone: booking.guestPhone,
    startTime: booking.startTime,
    endTime: booking.endTime,
    timezone: booking.timezone || page.timezone,
    groupSize: booking.groupSize,
    total: Number(booking.total ?? 0) / 100,
    paymentStatus: booking.paymentStatus,
    source,
    channel,
  };
  if (booking.answers) payload.answers = booking.answers;
  if (input.beforeBooking) {
    payload.previousStartTime = input.beforeBooking.startTime;
    payload.previousEndTime = input.beforeBooking.endTime;
  }
  if (input.event === 'booking.rescheduled') {
    payload.rescheduleCount = booking.rescheduleCount;
  }

  const [journal] = await tx.insert(automationJobs).values({
    clientId: booking.clientId,
    event: input.event,
    userId: actor?.actorId && actor.actorId > 0 ? actor.actorId : 0,
    payload,
    status: 'pending',
  }).returning({ id: automationJobs.id });

  return {
    jobId: journal.id,
    event: {
      event: input.event,
      clientId: booking.clientId,
      userId: actor?.actorId && actor.actorId > 0 ? actor.actorId : 0,
      payload,
      timestamp: new Date(),
    },
  };
}

/** Dispatch immediately after commit; the pending journal row is the crash-safe fallback. */
function dispatchBookingAutomation(pending: PendingBookingAutomation | null): void {
  if (!pending) return;
  void import('@/lib/automation')
    .then(({ dispatchJournaledEvent }) => dispatchJournaledEvent(pending.jobId, pending.event))
    .catch((error) => {
      console.error('[booking] Automation dispatch deferred to retry cron:', error);
    });
}

/** Resolve the same default staff assignment used by public booking when an
 * operator leaves the assignee blank. Explicit staff selection is preserved. */
export async function resolveDefaultBookingAssignee(
  page: BookingPage,
  startTime: Date,
): Promise<number | null> {
  if (page.allowStaffSelection) return null;

  if (page.assignmentMode && page.assignmentMode !== 'fixed') {
    return pickAssignee(page.id, startTime);
  }

  const members = Array.isArray(page.assignedMembers)
    ? (page.assignedMembers as number[]).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (members.length === 0) return null;
  if (members.length === 1) return members[0];

  const upcoming = await db.select({
    assignedTo: bookings.assignedTo,
    count: sql`count(*)::int`,
  }).from(bookings).where(and(
    eq(bookings.bookingPageId, page.id),
    ne(bookings.status, 'cancelled'),
    gte(bookings.startTime, new Date()),
  )).groupBy(bookings.assignedTo);

  const counts = new Map(upcoming.map((row) => [row.assignedTo, Number(row.count)]));
  return members.reduce((best, memberId) =>
    (counts.get(memberId) ?? 0) < (counts.get(best) ?? 0) ? memberId : best,
  members[0]);
}

export type BookingSlotValidation =
  | { ok: true; endTime: Date }
  | { ok: false; status: 400 | 409; message: string };

export async function validateBookingSlot(input: {
  page: BookingPage;
  startTime: Date;
  requestedSeats?: number;
  groupSize?: number;
  staffId?: number | null;
  now?: Date;
  queryDb?: BookingQueryDb;
  excludeBookingId?: number;
  skipTemporalValidation?: boolean;
}): Promise<BookingSlotValidation> {
  const { page, startTime } = input;
  const queryDb = input.queryDb ?? db;
  if (!Number.isFinite(startTime.getTime())) {
    return { ok: false, status: 400, message: 'Invalid start time' };
  }
  const now = input.now ?? new Date();
  const endTime = new Date(startTime.getTime() + page.duration * 60_000);

  if (!input.skipTemporalValidation && startTime < new Date(now.getTime() + page.minNoticeMins * 60_000)) {
    return { ok: false, status: 409, message: 'This time slot is no longer available' };
  }
  const maxDate = new Date(now);
  maxDate.setDate(maxDate.getDate() + page.maxAdvanceDays);
  if (!input.skipTemporalValidation && startTime > maxDate) {
    return { ok: false, status: 400, message: 'This date is too far in advance' };
  }
  if (input.staffId) {
    const [teamMember] = await queryDb.select({ userId: clientMembers.userId }).from(clientMembers)
      .where(and(
        eq(clientMembers.clientId, page.clientId),
        eq(clientMembers.userId, input.staffId),
      )).limit(1);
    if (!teamMember) {
      return { ok: false, status: 409, message: 'Selected staff member is not part of this client team' };
    }
    const [pageMember] = await queryDb.select({ userId: bookingPageMembers.userId })
      .from(bookingPageMembers)
      .where(and(
        eq(bookingPageMembers.bookingPageId, page.id),
        eq(bookingPageMembers.userId, input.staffId),
        eq(bookingPageMembers.active, true),
      ))
      .limit(1);
    if (!pageMember) {
      return { ok: false, status: 409, message: 'Selected staff member is not active on this booking page' };
    }
  }
  if (!(await isSlotWithinAvailability(page, startTime, input.staffId ?? null, queryDb))) {
    return { ok: false, status: 409, message: 'This time slot is no longer available' };
  }

  const seats = Math.max(1, Math.floor(input.requestedSeats ?? 1));
  if (page.bookingType === 'group') {
    const capacity = await checkSlotCapacity(page.id, startTime, seats, queryDb, input.excludeBookingId);
    if (!capacity.available) {
      return { ok: false, status: 409, message: `Only ${capacity.remaining} seats remaining for this slot` };
    }
  } else if (page.maxGuests) {
    const existing = await queryDb.select({ groupSize: bookings.groupSize })
      .from(bookings)
      .where(and(
        eq(bookings.bookingPageId, page.id),
        ne(bookings.status, 'cancelled'),
        eq(bookings.startTime, startTime),
        ...(input.excludeBookingId ? [ne(bookings.id, input.excludeBookingId)] : []),
      ));
    const booked = existing.reduce((sum, row) => sum + (row.groupSize ?? 1), 0);
    const remaining = page.maxGuests - booked;
    if (booked + Math.max(1, Math.floor(input.groupSize ?? 1)) > page.maxGuests) {
      return { ok: false, status: 409, message: `Only ${Math.max(0, remaining)} spots remaining` };
    }
  } else {
    const bufferStart = new Date(startTime.getTime() - page.bufferBefore * 60_000);
    const bufferEnd = new Date(endTime.getTime() + page.bufferAfter * 60_000);
    const conflicting = await queryDb.select({ id: bookings.id }).from(bookings)
      .where(and(
        eq(bookings.bookingPageId, page.id),
        ne(bookings.status, 'cancelled'),
        lte(bookings.startTime, bufferEnd),
        gte(bookings.endTime, bufferStart),
        ...(input.excludeBookingId ? [ne(bookings.id, input.excludeBookingId)] : []),
      ))
      .limit(1);
    if (conflicting.length) {
      return { ok: false, status: 409, message: 'This time slot is no longer available' };
    }
  }
  return { ok: true, endTime };
}

type BookingInsert = typeof bookings.$inferInsert;
type AttendeeInsert = typeof bookingAttendees.$inferInsert;

/**
 * Shared write path for public and authenticated manual bookings.
 * A transaction-scoped page lock serializes validation + insert for every slot
 * on the page, preventing group/maxGuests overbooking and overlapping 1:1 races
 * between callers that use this service.
 */
export async function createBookingRecord(input: {
  page: BookingPage;
  startTime: Date;
  booking: Omit<BookingInsert, 'bookingPageId' | 'clientId' | 'startTime' | 'endTime' | 'timezone' | 'slotExclusive'>;
  attendees?: Omit<AttendeeInsert, 'bookingId'>[];
  staffId?: number | null;
  groupSize?: number;
  timezone?: string;
  actor?: BookingAuditContext;
}): Promise<{ booking: typeof bookings.$inferSelect; endTime: Date }> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-page:${input.page.id}`}))`);
    const validation = await validateBookingSlot({
      page: input.page,
      startTime: input.startTime,
      requestedSeats: input.page.bookingType === 'group' ? input.booking.groupSize ?? 1 : 1,
      groupSize: input.groupSize,
      staffId: input.staffId,
      queryDb: tx,
    });
    if (!validation.ok) {
      const error = new Error(validation.message) as Error & { status: number };
      error.status = validation.status;
      throw error;
    }

    const slotExclusive = input.page.bookingType !== 'group' && !input.page.maxGuests;
    const [booking] = await tx.insert(bookings).values({
      ...input.booking,
      bookingPageId: input.page.id,
      clientId: input.page.clientId,
      startTime: input.startTime,
      endTime: validation.endTime,
      timezone: input.timezone || input.page.timezone,
      slotExclusive,
    }).returning();

    if (input.attendees?.length) {
      await tx.insert(bookingAttendees).values(
        input.attendees.map((attendee) => ({ ...attendee, bookingId: booking.id })),
      );
    }
    await writeBookingAudit(tx, {
      clientId: booking.clientId,
      bookingId: booking.id,
      action: 'created',
      afterState: bookingAuditSnapshot(booking),
      actor: input.actor,
    });
    const automation = await writeBookingAutomationEvent(tx, {
      event: 'booking.guest_booked',
      page: input.page,
      booking,
      actor: input.actor,
    });
    return { booking, endTime: validation.endTime, automation };
  });
  dispatchBookingAutomation(result.automation);
  return { booking: result.booking, endTime: result.endTime };
}

/**
 * Shared, serialized reschedule path used by public reschedule links.
 * It re-reads the booking/page inside the transaction and excludes the current
 * booking from capacity/conflict checks.
 */
export async function rescheduleBookingRecord(input: {
  bookingId: number;
  token: string;
  newStartTime: Date;
  timezone?: string;
  actor?: BookingAuditContext;
}): Promise<{
  booking: typeof bookings.$inferSelect;
  page: BookingPage;
  updated: typeof bookings.$inferSelect;
}> {
  const [bookingRef] = await db.select({ bookingPageId: bookings.bookingPageId })
    .from(bookings)
    .where(and(
      eq(bookings.id, input.bookingId),
      eq(bookings.rescheduleToken, input.token),
      eq(bookings.status, 'confirmed'),
    ))
    .limit(1);
  if (!bookingRef) {
    const error = new Error('Booking not found') as Error & { status: number };
    error.status = 404;
    throw error;
  }

  const result = await db.transaction(async (tx) => {
    // Lock the page before reading the mutable booking row. This serializes
    // reschedules against creates and against other reschedules on this page.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-page:${bookingRef.bookingPageId}`}))`);
    const [row] = await tx.select({ booking: bookings, page: bookingPages })
      .from(bookings)
      .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
      .where(and(
        eq(bookings.id, input.bookingId),
        eq(bookings.rescheduleToken, input.token),
        eq(bookings.status, 'confirmed'),
      ))
      .limit(1);
    if (!row) {
      const error = new Error('Booking not found or already changed') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    const { booking, page } = row;

    if (!page.rescheduleEnabled) {
      const error = new Error('Rescheduling is not enabled for this booking page') as Error & { status: number };
      error.status = 403;
      throw error;
    }
    const cutoff = new Date(Date.now() + page.rescheduleWindowHours * 60 * 60 * 1000);
    if (booking.startTime <= cutoff) {
      const error = new Error(`Bookings can only be rescheduled more than ${page.rescheduleWindowHours} hour(s) before the appointment`) as Error & { status: number };
      error.status = 409;
      throw error;
    }

    const validation = await validateBookingSlot({
      page,
      startTime: input.newStartTime,
      requestedSeats: booking.groupSize ?? 1,
      groupSize: booking.groupSize ?? 1,
      staffId: booking.assignedTo,
      excludeBookingId: booking.id,
      queryDb: tx,
    });
    if (!validation.ok) {
      const error = new Error(validation.message) as Error & { status: number };
      error.status = validation.status;
      throw error;
    }

    const [updated] = await tx.update(bookings).set({
      previousStartTime: booking.startTime,
      previousEndTime: booking.endTime,
      startTime: input.newStartTime,
      endTime: validation.endTime,
      timezone: input.timezone || booking.timezone || page.timezone,
      rescheduleCount: (booking.rescheduleCount ?? 0) + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(bookings.id, booking.id),
      eq(bookings.rescheduleToken, input.token),
      eq(bookings.status, 'confirmed'),
    )).returning();

    if (!updated) {
      const error = new Error('Booking changed before the reschedule could be saved') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    await writeBookingAudit(tx, {
      clientId: updated.clientId,
      bookingId: updated.id,
      action: 'rescheduled',
      beforeState: bookingAuditSnapshot(booking),
      afterState: bookingAuditSnapshot(updated),
      actor: input.actor,
    });
    const automation = await writeBookingAutomationEvent(tx, {
      event: 'booking.rescheduled',
      page,
      booking: updated,
      beforeBooking: booking,
      actor: input.actor,
    });
    return { booking, page, updated, automation };
  });
  dispatchBookingAutomation(result.automation);
  return { booking: result.booking, page: result.page, updated: result.updated };
}

/** Update non-time booking fields and validate staff reassignment under the
 * same page lock used by creation/rescheduling. */
export async function updateBookingRecord(input: {
  bookingId: number;
  pageId: number;
  status?: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  notes?: string | null;
  assignedTo?: number | null;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string | null;
  paymentStatus?: BookingInsert['paymentStatus'];
  paidAt?: Date | null;
  actor?: BookingAuditContext;
}): Promise<typeof bookings.$inferSelect> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-page:${input.pageId}`}))`);
    const [row] = await tx.select({ booking: bookings, page: bookingPages })
      .from(bookings)
      .innerJoin(bookingPages, eq(bookings.bookingPageId, bookingPages.id))
      .where(and(eq(bookings.id, input.bookingId), eq(bookings.bookingPageId, input.pageId)))
      .limit(1);
    if (!row) {
      const error = new Error('Booking not found') as Error & { status: number };
      error.status = 404;
      throw error;
    }
    const { booking, page } = row;
    if (input.assignedTo !== undefined && input.assignedTo !== null) {
      if (booking.status === 'cancelled') {
        const error = new Error('Cancelled bookings cannot be reassigned') as Error & { status: number };
        error.status = 409;
        throw error;
      }
      const [teamMember] = await tx.select({ userId: clientMembers.userId }).from(clientMembers)
        .where(and(eq(clientMembers.clientId, page.clientId), eq(clientMembers.userId, input.assignedTo))).limit(1);
      const [pageMember] = await tx.select({ userId: bookingPageMembers.userId }).from(bookingPageMembers)
        .where(and(
          eq(bookingPageMembers.bookingPageId, page.id),
          eq(bookingPageMembers.userId, input.assignedTo),
          eq(bookingPageMembers.active, true),
        )).limit(1);
      if (!teamMember || !pageMember) {
        const error = new Error('Assignee must be an active member of this booking page and client team') as Error & { status: number };
        error.status = 400;
        throw error;
      }
      const validation = await validateBookingSlot({
        page,
        startTime: booking.startTime,
        requestedSeats: booking.groupSize ?? 1,
        groupSize: booking.groupSize ?? 1,
        staffId: input.assignedTo,
        excludeBookingId: booking.id,
        queryDb: tx,
        skipTemporalValidation: true,
      });
      if (!validation.ok) {
        const error = new Error(validation.message) as Error & { status: number };
        error.status = validation.status;
        throw error;
      }
    }

    const updates: Partial<typeof bookings.$inferInsert> = { updatedAt: new Date() };
    if (input.status !== undefined) {
      updates.status = input.status;
      if (input.status === 'cancelled' && booking.status !== 'cancelled') updates.cancelledAt = new Date();
      if (input.status !== 'cancelled' && booking.status === 'cancelled') updates.cancelledAt = null;
    }
    if (input.notes !== undefined) updates.notes = input.notes;
    if (input.assignedTo !== undefined) updates.assignedTo = input.assignedTo;
    if (input.guestName !== undefined) updates.guestName = input.guestName;
    if (input.guestEmail !== undefined) updates.guestEmail = input.guestEmail;
    if (input.guestPhone !== undefined) updates.guestPhone = input.guestPhone;
    if (input.paymentStatus !== undefined) updates.paymentStatus = input.paymentStatus;
    if (input.paidAt !== undefined) updates.paidAt = input.paidAt;

    const [updated] = await tx.update(bookings).set(updates)
      .where(eq(bookings.id, booking.id)).returning();
    const action = updated.status === 'cancelled' && booking.status !== 'cancelled'
      ? 'cancelled'
      : 'updated';
    await writeBookingAudit(tx, {
      clientId: updated.clientId,
      bookingId: updated.id,
      action,
      beforeState: bookingAuditSnapshot(booking),
      afterState: bookingAuditSnapshot(updated),
      actor: input.actor,
    });
    const event = action === 'cancelled'
      ? 'booking.cancelled'
      : (booking.paymentStatus !== 'paid' && updated.paymentStatus === 'paid' ? 'booking.confirmed' : null);
    const automation = event
      ? await writeBookingAutomationEvent(tx, {
          event,
          page,
          booking: updated,
          beforeBooking: booking,
          actor: input.actor,
        })
      : null;
    return { booking: updated, automation };
  });
  dispatchBookingAutomation(result.automation);
  return result.booking;
}

/** Token-authorized public cancellation, serialized with other booking writes. */
export async function cancelBookingRecord(input: {
  token: string;
  rejectPast?: boolean;
  actor?: BookingAuditContext;
}): Promise<typeof bookings.$inferSelect> {
  const [ref] = await db.select({ id: bookings.id, bookingPageId: bookings.bookingPageId })
    .from(bookings).where(eq(bookings.cancelToken, input.token)).limit(1);
  if (!ref) {
    const error = new Error('Booking not found') as Error & { status: number };
    error.status = 404;
    throw error;
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booking-page:${ref.bookingPageId}`}))`);
    const [booking] = await tx.select().from(bookings)
      .where(and(eq(bookings.id, ref.id), eq(bookings.cancelToken, input.token)))
      .limit(1);
    if (!booking) {
      const error = new Error('Booking not found') as Error & { status: number };
      error.status = 404;
      throw error;
    }
    if (booking.status === 'cancelled') {
      const error = new Error('This booking has already been cancelled') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    if (input.rejectPast && booking.startTime < new Date()) {
      const error = new Error('Cannot cancel a past booking') as Error & { status: number };
      error.status = 400;
      throw error;
    }
    const [updated] = await tx.update(bookings)
      .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bookings.id, booking.id), ne(bookings.status, 'cancelled')))
      .returning();
    if (!updated) {
      const error = new Error('Booking was already changed') as Error & { status: number };
      error.status = 409;
      throw error;
    }
    await writeBookingAudit(tx, {
      clientId: updated.clientId,
      bookingId: updated.id,
      action: 'cancelled',
      beforeState: bookingAuditSnapshot(booking),
      afterState: bookingAuditSnapshot(updated),
      actor: input.actor,
    });
    const [page] = await tx.select().from(bookingPages)
      .where(eq(bookingPages.id, updated.bookingPageId)).limit(1);
    const automation = page
      ? await writeBookingAutomationEvent(tx, {
          event: 'booking.cancelled',
          page,
          booking: updated,
          beforeBooking: booking,
          actor: input.actor,
        })
      : null;
    return { booking: updated, automation };
  });
  dispatchBookingAutomation(result.automation);
  return result.booking;
}
