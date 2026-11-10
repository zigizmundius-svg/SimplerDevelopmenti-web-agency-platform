-- Lease used to prevent concurrent cron workers from sending the same
-- booking reminder. A stale claim is recoverable after the worker crashes.
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "reminder_claimed_at" timestamp;
