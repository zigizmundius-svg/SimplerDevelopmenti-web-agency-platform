import type { BookingEmailData } from './booking-emails';
import {
  BASE_URL,
  FROM_EMAIL,
  brandAccent,
  bookingEmailHtml,
  esc,
  formatDateTime,
  formatTime,
  sendBookingEmail,
} from './booking-emails';

/**
 * Send a pre-booking reminder. Triggered by `/api/cron/booking-reminders` on
 * rows whose `reminder_sent_at` is NULL and whose `start_time` is inside the
 * send window (≈ 24h ahead). One reminder per booking — the cron updates
 * `reminder_sent_at` after a successful send so subsequent runs skip.
 *
 * Brand-aware via `data.brand` (callers should pass the result of
 * `loadBookingBrand(bookingPageId)`). Cancellation token is included so the
 * guest can still cancel from inside the reminder.
 */
export async function sendBookingReminder(data: BookingEmailData, idempotencyKey?: string): Promise<void> {
  const cancelUrl = data.cancelToken ? `${BASE_URL}/book/cancel?token=${data.cancelToken}` : null;
  const formattedStart = formatDateTime(data.startTime, data.timezone);
  const formattedEnd = formatTime(data.endTime, data.timezone);
  const accent = brandAccent(data.brand);
  const heading = data.brand?.textColor ?? '#111827';
  const fromBrandName = data.brand?.companyName ?? 'SimplerDevelopment';

  const html = bookingEmailHtml(`
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.18em;color:${accent};text-transform:uppercase;">Friendly reminder</p>
    <h1 style="margin:0 0 8px;font-size:24px;color:${heading};">Your appointment is coming up</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${esc(data.guestName)} — looking forward to seeing you ${formattedStart}.</p>

    <table role="presentation" width="100%" style="background:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:12px 20px;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">What</p>
          <p style="margin:0;font-size:16px;color:${heading};font-weight:600;">${esc(data.pageTitle)}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">When</p>
          <p style="margin:0;font-size:16px;color:${heading};font-weight:600;">${formattedStart}</p>
          <p style="margin:4px 0 0;font-size:14px;color:#6b7280;">${data.duration} minutes (until ${formattedEnd})</p>
        </td>
      </tr>
      ${data.meetingLink ? `<tr>
        <td style="padding:12px 20px;">
          <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;">Where</p>
          <a href="${esc(data.meetingLink)}" style="display:inline-block;padding:10px 24px;background:${accent};color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">Join Video Call</a>
        </td>
      </tr>` : ''}
    </table>

    ${cancelUrl ? `<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
      Can't make it?
      <a href="${cancelUrl}" style="color:${accent};text-decoration:none;">Cancel or reschedule</a>
    </p>` : ''}
  `, `Reminder: your ${data.pageTitle} appointment is ${formattedStart}`, data.brand);

  try {
    await sendBookingEmail({
      from: `${fromBrandName} <${FROM_EMAIL}>`,
      to: data.guestEmail,
      subject: `Reminder: ${data.pageTitle} — ${formattedStart}`,
      html,
    }, idempotencyKey);
  } catch (err) {
    console.error('Failed to send booking reminder email:', err);
    throw err; // Re-throw so the cron records a failure instead of a silent skip.
  }
}
