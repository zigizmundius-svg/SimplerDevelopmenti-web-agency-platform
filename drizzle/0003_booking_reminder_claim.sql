-- Lease used to prevent concurrent cron workers from sending the same
-- booking reminder. A stale claim is recoverable after the worker crashes.
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "reminder_claimed_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_reminder_due_idx"
  ON "bookings" USING btree ("start_time")
  WHERE "status" = 'confirmed' AND "reminder_sent_at" IS NULL;
