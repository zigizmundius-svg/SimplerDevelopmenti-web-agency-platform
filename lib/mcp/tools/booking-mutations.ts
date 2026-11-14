/** Shared transactional booking mutations exposed through MCP. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { bookingPages, bookings } from '@/lib/db/schema';
import type { PortalMcpContext } from '@/lib/mcp-auth';
import { hasScope } from '@/lib/mcp-auth';
import { updateBookingRecord } from '@/lib/booking/service';
import { publishBookingCancelled } from '@/lib/booking/post-create';
import {
  json,
  denied,
  requireScope,
  serviceDenied,
  requireService,
  revalidateForWrite,
} from '../types';

export function registerBookingMutationTools(server: McpServer, ctx: PortalMcpContext): void {
  const clientId = ctx.client.id;

  hasScope(ctx.scopes, 'bookings:write') && server.registerTool(
    'bookings_cancel',
    {
      title: 'Cancel booking / appointment',
      description:
        'Cancel a booking. Marks status=cancelled, releases its slot, attempts to remove linked calendar/Zoom events, and sends cancellation notifications. This does NOT automatically refund payment.',
      inputSchema: {
        id: z.number(),
        reason: z.string().optional().describe('Internal note appended to booking.notes.'),
      },
    },
    async ({ id, reason }) => {
      if (!requireScope(ctx, 'bookings:write')) return denied('bookings:write');
      if (!(await requireService(clientId, 'booking'))) return serviceDenied('booking');
      const [existing] = await db.select().from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.clientId, clientId))).limit(1);
      if (!existing) return json({ error: 'Booking not found' });
      if (existing.status === 'cancelled') return json({ error: 'Booking already cancelled' });
      try {
        const prior = existing.notes?.trim();
        const row = await updateBookingRecord({
          bookingId: id,
          pageId: existing.bookingPageId,
          status: 'cancelled',
          actor: { actorType: 'mcp', source: 'mcp' },
          ...(reason ? { notes: prior ? `${prior}\n[cancelled] ${reason}` : `[cancelled] ${reason}` } : {}),
        });
        const [page] = await db.select().from(bookingPages)
          .where(and(eq(bookingPages.id, existing.bookingPageId), eq(bookingPages.clientId, clientId))).limit(1);
        if (page) await publishBookingCancelled({ page, booking: row });
        revalidateForWrite('portal');
        return json(row);
      } catch (error) {
        return json({ error: (error as Error).message });
      }
    }
  );

  hasScope(ctx.scopes, 'bookings:write') && server.registerTool(
    'bookings_update',
    {
      title: 'Update booking',
      description:
        'Edit booking details (status, notes, assignee and guest contact fields). Rescheduling is temporarily disabled here because time changes must pass the shared availability and capacity checks.',
      inputSchema: {
        id: z.number(),
        status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show']).optional(),
        notes: z.string().nullable().optional(),
        assignedTo: z.number().nullable().optional(),
        guestName: z.string().min(1).optional(),
        guestEmail: z.string().email().optional(),
        guestPhone: z.string().nullable().optional(),
      },
    },
    async (args) => {
      if (!requireScope(ctx, 'bookings:write')) return denied('bookings:write');
      if (!(await requireService(clientId, 'booking'))) return serviceDenied('booking');
      if ('startTime' in args || 'endTime' in args) {
        return json({ error: 'Rescheduling is temporarily disabled for this tool.' });
      }
      const { id, ...rest } = args;
      const [existing] = await db.select({
        id: bookings.id,
        bookingPageId: bookings.bookingPageId,
        status: bookings.status,
      }).from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.clientId, clientId))).limit(1);
      if (!existing) return json({ error: 'Booking not found' });
      try {
        const row = await updateBookingRecord({
          bookingId: id,
          pageId: existing.bookingPageId,
          status: rest.status,
          notes: rest.notes,
          assignedTo: rest.assignedTo,
          guestName: rest.guestName,
          guestEmail: rest.guestEmail,
          guestPhone: rest.guestPhone,
          actor: { actorType: 'mcp', source: 'mcp' },
        });
        if (rest.status === 'cancelled' && existing.status !== 'cancelled') {
          const [page] = await db.select().from(bookingPages)
            .where(and(eq(bookingPages.id, existing.bookingPageId), eq(bookingPages.clientId, clientId))).limit(1);
          if (page) await publishBookingCancelled({ page, booking: row });
        }
        revalidateForWrite('portal');
        return json(row);
      } catch (error) {
        return json({ error: (error as Error).message });
      }
    }
  );
}
