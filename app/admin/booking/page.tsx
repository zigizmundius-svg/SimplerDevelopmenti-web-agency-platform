'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';

interface BookingPage {
  id: number;
  title: string;
  slug: string;
  duration: number;
  bookingType: 'individual' | 'group';
  groupCapacity: number | null;
  price: number | null;
  active: boolean;
  googleCalendarSync: boolean;
  timezone: string;
  createdAt: string;
  company: string | null;
  clientName: string;
  totalBookings: number;
  upcomingBookings: number;
}

interface UpcomingBooking {
  id: number;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  startTime: string;
  endTime: string;
  timezone: string;
  status: string;
  createdAt: string;
  bookingPageTitle: string;
  company: string | null;
  clientName: string;
}

interface Stats {
  totalPages: number;
  activePages: number;
  totalUpcoming: number;
}

function bookingStatusBadge(status: string) {
  const colors: Record<string, string> = {
    confirmed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    completed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    no_show: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function formatDateTime(d: string) {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function zonedDateTimeToIso(value: string, timeZone: string): string {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetUtc;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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

export default function AdminBookingPage() {
  const [tab, setTab] = useState<'pages' | 'upcoming'>('pages');
  const [pages, setPages] = useState<BookingPage[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingBooking[]>([]);
  const [stats, setStats] = useState<Stats>({ totalPages: 0, activePages: 0, totalUpcoming: 0 });
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [bookingPageId, setBookingPageId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [startAt, setStartAt] = useState('');
  const [seats, setSeats] = useState(1);
  const [paidOffline, setPaidOffline] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/portal/booking');
      const data = await response.json();
      setPages(data.pages ?? []);
      setUpcoming(data.upcomingBookings ?? []);
      setStats(data.stats ?? { totalPages: 0, activePages: 0, totalUpcoming: 0 });
      setBookingPageId((current) => data.pages?.some((item: BookingPage) => item.active && String(item.id) === current)
        ? current
        : String(data.pages?.find((item: BookingPage) => item.active)?.id ?? ''));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedPage = pages.find((item) => String(item.id) === bookingPageId);
    if (!selectedPage) {
      setCreateError('Choose a booking page');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const response = await fetch('/api/admin/portal/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingPageId: selectedPage.id,
          guestName,
          guestEmail,
          guestPhone: guestPhone || null,
          startTime: zonedDateTimeToIso(startAt, selectedPage.timezone),
          seats: selectedPage.bookingType === 'group' ? seats : undefined,
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
      setSeats(1);
      setPaidOffline(false);
      await refresh();
    } catch {
      setCreateError('Could not create booking. Check the date and time.');
    } finally {
      setCreating(false);
    }
  }

  const statCards = [
    { label: 'Total Pages', value: stats.totalPages, icon: 'calendar_month' },
    { label: 'Active Pages', value: stats.activePages, icon: 'event_available' },
    { label: 'Upcoming Bookings', value: stats.totalUpcoming, icon: 'event_upcoming' },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Booking</h1>
          <p className="text-muted-foreground mt-1">Manage booking pages and view upcoming appointments.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setShowCreate(true); setCreateError(''); }}
            disabled={pages.filter((item) => item.active).length === 0}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground disabled:opacity-40"
          >
            New booking
          </button>
          {(['pages', 'upcoming'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              {t === 'pages' ? 'Pages' : 'Upcoming'}
            </button>
          ))}
        </div>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form onSubmit={createBooking} className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Create booking</h2>
              <button type="button" onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">✕</button>
            </div>
            <label className="block text-xs text-muted-foreground space-y-1">
              Booking page
              <select required value={bookingPageId} onChange={(e) => setBookingPageId(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {pages.filter((item) => item.active).map((item) => (
                  <option key={item.id} value={item.id}>{item.company ?? item.clientName} — {item.title}</option>
                ))}
              </select>
            </label>
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
                Appointment time
                <input required type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              </label>
              {pages.find((item) => String(item.id) === bookingPageId)?.bookingType === 'group' && (
                <label className="text-xs text-muted-foreground space-y-1">
                  Seats
                  <input required type="number" min={1} max={pages.find((item) => String(item.id) === bookingPageId)?.groupCapacity ?? 100} value={seats} onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
                </label>
              )}
            </div>
            {pages.find((item) => String(item.id) === bookingPageId)?.price != null && (pages.find((item) => String(item.id) === bookingPageId)?.price ?? 0) > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={paidOffline} onChange={(e) => setPaidOffline(e.target.checked)} />
                Payment received outside the platform
              </label>
            )}
            {createError && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{createError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground">Cancel</button>
              <button type="submit" disabled={creating || !pages.some((item) => String(item.id) === bookingPageId && item.active)} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50">
                {creating ? 'Creating…' : 'Create booking'}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">
          <span className="material-icons animate-spin text-3xl">autorenew</span>
          <p className="mt-2">Loading booking data...</p>
        </div>
      ) : (
        <>
          {tab === 'pages' && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {statCards.map(c => (
                  <div key={c.label} className="bg-card border border-border rounded-xl p-4">
                    <div className="flex items-center gap-3">
                      <span className="material-icons text-2xl text-muted-foreground">{c.icon}</span>
                      <div>
                        <p className="text-2xl font-bold text-foreground">{c.value}</p>
                        <p className="text-xs text-muted-foreground">{c.label}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {pages.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-12 text-center">
                  <span className="material-icons text-5xl text-muted-foreground">calendar_month</span>
                  <h3 className="mt-4 font-semibold text-foreground">No booking pages</h3>
                  <p className="text-muted-foreground mt-1 text-sm">Booking pages will appear here once clients create them.</p>
                </div>
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Title</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Client</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Duration</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Calendar Sync</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Bookings</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Upcoming</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pages.map(page => (
                        <tr key={page.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3 font-medium text-foreground">{page.title}</td>
                          <td className="px-4 py-3 text-muted-foreground">{page.company ?? page.clientName}</td>
                          <td className="px-4 py-3 text-muted-foreground">{page.duration} mins</td>
                          <td className="px-4 py-3">
                            {page.googleCalendarSync ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                                <span className="material-icons text-sm mr-1">sync</span>
                                Synced
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">--</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              page.active
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                            }`}>
                              {page.active ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{page.totalBookings}</td>
                          <td className="px-4 py-3 text-muted-foreground">{page.upcomingBookings}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {tab === 'upcoming' && (
            <>
              {upcoming.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-12 text-center">
                  <span className="material-icons text-5xl text-muted-foreground">event_busy</span>
                  <h3 className="mt-4 font-semibold text-foreground">No upcoming bookings</h3>
                  <p className="text-muted-foreground mt-1 text-sm">Upcoming bookings for the next 30 days will appear here.</p>
                </div>
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 border-b border-border">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Date / Time</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Guest Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Guest Email</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Booking Page</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Client</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {upcoming.map(booking => (
                        <tr key={booking.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(booking.startTime)}</td>
                          <td className="px-4 py-3 font-medium text-foreground">{booking.guestName}</td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">{booking.guestEmail}</td>
                          <td className="px-4 py-3 text-muted-foreground">{booking.bookingPageTitle}</td>
                          <td className="px-4 py-3 text-muted-foreground">{booking.company ?? booking.clientName}</td>
                          <td className="px-4 py-3">{bookingStatusBadge(booking.status)}</td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">{booking.guestPhone ?? '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
