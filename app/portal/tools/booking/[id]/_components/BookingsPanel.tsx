/**
 * Bookings tab — split into "Upcoming" (status=confirmed and start in the
 * future) and "Past & Cancelled" (everything else). Each upcoming row has
 * an inline reassign dropdown and a cancel button.
 */
'use client';

import { useState, type FormEvent } from 'react';
import type { Booking, PageMember } from '../_lib/types';

interface BookingsPanelProps {
  pageId: string;
  timezone: string;
  bookingType: 'individual' | 'group';
  price: number | null;
  onRefresh: () => Promise<void>;
  bookingsList: Booking[];
  pageMembers: PageMember[];
  onCancel: (bookingId: number) => void;
  onReassign: (bookingId: number, userId: number | null) => void;
}

function zonedDateTimeToIso(value: string, timeZone: string): string {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetUtc;

  // Resolve the wall-clock value in the booking page's IANA timezone.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const representedUtc = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute),
    );
    const difference = targetUtc - representedUtc;
    candidate += difference;
    if (difference === 0) break;
  }
  return new Date(candidate).toISOString();
}

export function BookingsPanel({
  pageId,
  timezone,
  bookingType,
  price,
  onRefresh,
  bookingsList,
  pageMembers,
  onCancel,
  onReassign,
}: BookingsPanelProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [startAt, setStartAt] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [seats, setSeats] = useState(1);
  const [paidOffline, setPaidOffline] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  async function createBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setCreateError('');
    try {
      const response = await fetch(`/api/portal/tools/booking/${pageId}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestName,
          guestEmail,
          guestPhone: guestPhone || null,
          startTime: zonedDateTimeToIso(startAt, timezone),
          assignedTo: assignedTo || null,
          seats: bookingType === 'group' ? seats : undefined,
          paidOffline,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        setCreateError(result.message || 'Could not create booking');
        return;
      }
      setShowCreate(false);
      setGuestName('');
      setGuestEmail('');
      setGuestPhone('');
      setStartAt('');
      setAssignedTo('');
      setSeats(1);
      setPaidOffline(false);
      await onRefresh();
    } catch {
      setCreateError('Could not create booking. Check the date and time.');
    } finally {
      setCreating(false);
    }
  }

  const now = new Date();
  const upcomingBookings = bookingsList
    .filter((b) => b.status === 'confirmed' && new Date(b.startTime) >= now)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const pastBookings = bookingsList
    .filter((b) => b.status !== 'confirmed' || new Date(b.startTime) < now)
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  return (
    <div className="space-y-6">
      {/* Upcoming */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="material-icons text-primary">event_upcoming</span>
            <h2 className="text-sm font-medium text-foreground">
              Upcoming ({upcomingBookings.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={() => { setShowCreate((value) => !value); setCreateError(''); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90"
          >
            <span className="material-icons text-sm">add</span>
            New booking
          </button>
        </div>
        {showCreate && (
          <form onSubmit={createBooking} className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-muted-foreground space-y-1">
                Guest name
                <input required value={guestName} onChange={(e) => setGuestName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground space-y-1">
                Guest email
                <input required type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground space-y-1">
                Phone (optional)
                <input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground space-y-1">
                Appointment time ({timezone})
                <input required type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              {bookingType === 'group' && (
                <label className="text-xs text-muted-foreground space-y-1">
                  Seats
                  <input required type="number" min={1} max={100} value={seats} onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
                </label>
              )}
              {pageMembers.some((member) => member.active) && (
                <label className="text-xs text-muted-foreground space-y-1">
                  Staff member
                  <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                    <option value="">Unassigned</option>
                    {pageMembers.filter((member) => member.active).map((member) => (
                      <option key={member.userId} value={member.userId}>{member.displayName || member.userName}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-xs text-muted-foreground">The appointment time is interpreted in {timezone}. Paid services remain pending unless you mark an offline payment as received.</p>
            {price != null && price > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={paidOffline} onChange={(e) => setPaidOffline(e.target.checked)} />
                Payment received outside the platform
              </label>
            )}
            {createError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{createError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground">Cancel</button>
              <button type="submit" disabled={creating} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50">
                {creating ? 'Creating…' : 'Create booking'}
              </button>
            </div>
          </form>
        )}
        {upcomingBookings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No upcoming bookings</p>
        ) : (
          <div className="divide-y divide-border">
            {upcomingBookings.map((b) => (
              <div key={b.id} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{b.guestName}</p>
                  <p className="text-xs text-muted-foreground">{b.guestEmail}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(b.startTime).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    {new Date(b.startTime).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    {' - '}
                    {new Date(b.endTime).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  {b.assignedTo &&
                    (() => {
                      const member = pageMembers.find((m) => m.userId === b.assignedTo);
                      return member ? (
                        <p className="text-xs mt-0.5 flex items-center gap-1">
                          <span
                            className="w-2 h-2 rounded-full inline-block"
                            style={{ backgroundColor: member.color || '#6b7280' }}
                          />
                          <span className="text-muted-foreground">
                            {member.displayName || member.userName}
                          </span>
                        </p>
                      ) : null;
                    })()}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {pageMembers.length > 0 && (
                    <select
                      value={b.assignedTo || ''}
                      onChange={(e) => {
                        const newAssignedTo = e.target.value ? parseInt(e.target.value) : null;
                        onReassign(b.id, newAssignedTo);
                      }}
                      className="px-2 py-1 bg-background border border-border rounded-lg text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="">Unassigned</option>
                      {pageMembers
                        .filter((m) => m.active)
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName || m.userName}
                          </option>
                        ))}
                    </select>
                  )}
                  <button
                    onClick={() => onCancel(b.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                  >
                    <span className="material-icons text-sm">cancel</span>
                    Cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Past */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-icons text-muted-foreground">history</span>
          <h2 className="text-sm font-medium text-foreground">
            Past & Cancelled ({pastBookings.length})
          </h2>
        </div>
        {pastBookings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No past bookings</p>
        ) : (
          <div className="divide-y divide-border">
            {pastBookings.map((b) => (
              <div key={b.id} className="py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{b.guestName}</p>
                  <p className="text-xs text-muted-foreground">{b.guestEmail}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(b.startTime).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    {new Date(b.startTime).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${
                    b.status === 'cancelled'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : b.status === 'completed'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : b.status === 'no_show'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                  }`}
                >
                  {b.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
