-- Durable internal job queue.
--
-- IF NOT EXISTS is intentional: this table was also introduced by the
-- historical additive migration 9022_internal_jobs_manual.sql. A developer
-- database may already have that table before the Drizzle journal records this
-- migration. Keep both installation paths safe and converge on the same shape.

CREATE TABLE IF NOT EXISTS "internal_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer NOT NULL,
  "type" varchar(60) NOT NULL,
  "payload" json NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_retry_at" timestamp with time zone,
  "error" text,
  "dedupe_key" varchar(200),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "internal_jobs_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'internal_jobs_dedupe_key_unique'
      AND conrelid = 'public.internal_jobs'::regclass
  ) THEN
    ALTER TABLE "internal_jobs"
      ADD CONSTRAINT "internal_jobs_dedupe_key_unique" UNIQUE ("dedupe_key");
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "internal_jobs_due_idx"
  ON "internal_jobs" USING btree ("status", "next_retry_at");
