# Booking write-path trace

**Branch:** `platform/ru-adaptation`  
**Source baseline:** upstream `main` at `2b6b7cc75ebb7872977f5487c2f05c5ca60c1c0c`  
**Current branch head:** updated continuously; verify the branch ref for the latest SHA  
**Method:** static source inspection. Runtime tests have not been executed.

## 1. Public website — create booking

Entry point: `app/api/public/booking/[slug]/book/route.ts`

The public POST:
- resolves a booking page by slug;
- requires the page to be active (except a separate approval-preview shim);
- validates guest name/email and start time;
- derives end time from configured duration;
- checks minimum notice and maximum advance;
- checks configured availability via `lib/booking/availability.ts`;
- checks group capacity via `lib/booking/capacity.ts`, legacy maxGuests capacity, or 1:1 conflicts with buffers;
- handles add-ons, discounts, gift certificates, attendees, payment and side effects later in the handler.

This is the most complete booking creation path found. It is a large route with pricing/payment and external side effects, so it should not be copied wholesale into staff booking creation.

## 2. Client portal — appointment management

List endpoint: `app/api/portal/tools/booking/[id]/bookings/route.ts`  
Update endpoint: `app/api/portal/tools/booking/[id]/bookings/[bookingId]/route.ts`  
Calendar endpoint: `app/api/portal/tools/booking/calendar/route.ts`

The list route verifies the booking page belongs to the authenticated tenant before listing that page's bookings. The update route verifies the page and booking belong to the same tenant/page, then updates status, notes and assigned staff. It does not create a booking or reschedule its time.

The UI `app/portal/tools/booking/[id]/_components/BookingsPanel.tsx` exposes cancellation, reassignment and a manual appointment form. The form interprets the selected wall-clock time in the booking page's IANA timezone, supports group seats and optional staff selection.

Important distinction: `app/portal/tools/booking/new/page.tsx` creates a **booking page / appointment type** by POSTing to `/api/portal/tools/booking`; it does not create an appointment in a time slot.

The portal calendar is at `app/portal/tools/booking/calendar/page.tsx`. The inspected UI displays bookings and filters by staff; no create-appointment flow was found in this calendar page.

## 3. Agency console — appointment management

Read surface:
- `app/api/admin/portal/booking/route.ts` exposes GET aggregation for booking pages and upcoming bookings.
- `app/admin/booking/page.tsx` displays booking pages and upcoming bookings.

The agency booking API now exposes a staff-only POST for manual creation, and `app/admin/booking/page.tsx` provides a create form. The endpoint checks staff role, page activity, active booking entitlement, and eligible client/page membership for explicit staff assignment. Group seat count is supported.

## 4. MCP integration

Entry point: `lib/mcp/tools/bookings.ts`.

Upstream `bookings_update` accepted `startTime` and `endTime` and wrote them directly, without invoking public availability, capacity or conflict checks. This was a rescheduling bypass.

### Mitigation now present in our branch
- The MCP tool schema no longer advertises `startTime` / `endTime`.
- The handler explicitly rejects those fields if supplied directly.
- Unit test updated to assert no time mutation occurs.

This is a temporary fail-closed mitigation, not a replacement for the shared booking domain service. See [BOOKING_MCP_RESCHEDULE_GUARD.md](BOOKING_MCP_RESCHEDULE_GUARD.md).

## 5. Additional portal update hardening now present in our branch

The client portal booking update route now:
- accepts only `confirmed`, `cancelled`, `completed`, `no_show` status values;
- accepts notes only as string or null;
- accepts assignee only as a positive integer or null;
- verifies a non-null assignee belongs to the current client's team and is an active member of this booking page;
- stamps `cancelledAt` only when status transitions into cancelled.

Integration tests were added for invalid statuses and assigning a booking to a user outside the tenant team. These tests have not yet been run.

## 6. Shared booking service now implemented in this branch

New module: `lib/booking/service.ts`.

- `validateBookingSlot` centralizes min notice, max advance, timezone-aware availability, date overrides, per-staff availability, group capacity, legacy `maxGuests`, and individual overlap/buffer checks.
- `createBookingRecord` is used by public booking, authenticated client-portal manual creation and agency staff manual creation. It inserts the booking and group attendees in one transaction.
- A transaction-scoped PostgreSQL advisory lock is taken per booking page before the final validation and insert. This serializes create operations on a page, including group-capacity and overlapping individual slots. Availability, date-override, member and capacity queries use the transaction connection. The lock only coordinates writes routed through this service.
- `rescheduleBookingRecord` routes public token-based rescheduling through the same validator and page lock. It excludes the booking being moved from capacity/conflict checks, re-reads its state after acquiring the lock, and validates the assigned staff member's availability.
- `updateBookingRecord` serializes portal and MCP status/notes/contact/assignee changes; a reassignment is checked against active client-team membership, active page membership, and that member's schedule before the update.
- `cancelBookingRecord` serializes token-based public cancellation with create/reschedule writes. The portal and MCP status-cancel operations use `updateBookingRecord`.
- The public reschedule route enforces the configured duration; callers cannot choose arbitrary end times.
- The client booking-page editor and agency booking console both have manual-create forms. Date/time input is interpreted in the booking page's IANA timezone. Paid services default to pending payment; an operator can mark an offline payment as received, setting `paymentStatus=paid` and `paidAt`. No card payment is initiated by these manual paths. Both paths now invoke a shared post-create handler for the automation journal, guest/host email, Google Calendar and Zoom/Meet integrations (all integrations are best-effort after the booking transaction commits).
- Agency creation is restricted to staff sessions and checks that the client has an active `booking` service entitlement.
- When the operator leaves staff blank, manual creation resolves the configured default/round-robin assignment; an explicit staff choice is checked against active page membership and client-team membership.
- A shared post-create handler emits the durable automation journal event and best-effort sends guest/host email, creates Google Calendar/Meet or Zoom events, and returns the meeting link. These effects run after the booking transaction commits.
- Integration tests were added for client-portal manual creation, cross-tenant denial, listing the created booking, and two simultaneous manual requests competing for one slot. Agency creation and public rescheduling still need dedicated regression tests. The tests are authored but have not been executed in this environment.

**Scope limitation:** the page lock coordinates code paths that use `createBookingRecord`, `rescheduleBookingRecord`, `updateBookingRecord` and `cancelBookingRecord`. Public create, client manual create, agency manual create, public reschedule, portal/MCP updates, public cancellation, payment transitions and portal refunds now use these operations. Payment success/failure and refund state transitions now use `updateBookingRecord` under the page lock. The check-in endpoint still updates check-in metadata directly, which does not affect slot availability or capacity. Webhook delivery idempotency and external integration retries still need production verification. The post-create helper is best-effort, not an outbox with retry/idempotency for email/calendar/Zoom. Public, portal and MCP cancellation now share a post-cancellation integration helper; external effects remain best-effort and do not yet have an outbox retry/idempotency layer. Durable actor/channel audit records are still pending; the automation journal payload identifies manual source and actor user ID.

## 7. Architectural conclusion

Current surfaces:
- public visitor creation and rescheduling call the shared booking service;
- client portal manual creation uses the same service and is available in the booking-page editor;
- agency manual creation uses the same service through a staff-only endpoint and agency console form;
- portal status/notes/reassignment uses `updateBookingRecord`, with staff schedule validation on reassignment;
- public token rescheduling uses the same service.

A shared write service now exists for public creation, authenticated client-portal manual creation, agency-assisted manual creation, and public rescheduling. Both client and agency panels now expose manual-create forms.

## 8. Required implementation target

Extend the domain layer with explicit operations and typed actor context:

```ts
createBooking(command, actorContext)
rescheduleBooking(bookingId, command, actorContext)
cancelBooking(bookingId, command, actorContext)
reassignBooking(bookingId, command, actorContext)
```

The domain layer must:
- load the booking page under the authorized tenant;
- validate booking service entitlement for portal/staff actors;
- enforce service duration, working hours, page/member availability, date overrides, min notice, max advance, timezone, staff eligibility, buffers, group capacity and conflict rules;
- execute mutations transactionally;
- preserve and strengthen DB-level race protection for exclusive slots and group capacity;
- write actor/channel audit metadata;
- enqueue notifications, calendar sync and automation only after commit, with idempotency.

Route handlers should become thin adapters. Public booking, client portal and agency staff creation currently share the create service; public rescheduling shares the validator and lock. MCP time mutation remains disabled until a dedicated MCP reschedule command is routed through the service; MCP status/notes/assignee updates and cancellation now use the shared booking service; cancellation also invokes the shared post-cancel integration handler.

## 9. Acceptance criteria

1. Public booking, client manual booking and public rescheduling use the same slot validator.
2. Client manual booking appears in the portal and agency calendar reads from the shared bookings table.
3. Agency-assisted creation uses the same validation and staff authorization; the endpoint also checks the tenant's active booking entitlement.
4. MCP reschedule remains disabled until routed through the service.
5. Page-scoped transaction locks serialize create/reschedule operations that use the service.
6. Assignment is limited to eligible active tenant/page staff in the portal route.
7. Manual post-create automation event includes source and actor user ID; portal/MCP reassignment and status changes use the shared update service. A dedicated immutable audit record is still pending.
8. Cross-tenant negative tests cover public and portal create paths; reassignment also checks active membership and schedule.
9. Manual client and agency bookings trigger guest/host email and calendar/conference integrations after commit; integrations remain best-effort and lack a retryable outbox.
10. Client editor and agency booking console both expose manual appointment creation, including group seats.

## 10. Follow-up hardening (branch changes)

- Agency manual booking now persists the UI's offline-payment confirmation as `paymentStatus='paid'` with `paidAt`; otherwise paid services remain pending.
- MCP cancellation no longer writes directly to the bookings table. It uses `updateBookingRecord`, preserves the cancellation reason, and invokes the shared cancellation side effects.
- The shared slot validator now requires an explicitly assigned staff member to be an active `booking_page_members` entry as well as a member of the client team. This check is independent of date overrides.
- Zoom meetings are updated best-effort when a public reschedule moves a Zoom-backed booking. Google Calendar remains best-effort as before.
- Refund API rejects non-positive, fractional, unsafe, or over-total amounts. Since the current schema has no partial-refund status, partial refunds preserve `paymentStatus='paid'`; only a full refund sets `refunded` and cancels the booking. The Stripe `charge.refunded` webhook uses cumulative `amount_refunded` to distinguish partial from full refunds.
- Regression tests were adjusted for shared MCP cancellation and partial/invalid refund behavior. These tests have not yet been executed; CI is still not reporting a run for the branch head.
