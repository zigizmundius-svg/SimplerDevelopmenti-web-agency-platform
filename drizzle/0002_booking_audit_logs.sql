CREATE TABLE "booking_audit_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "client_id" integer NOT NULL,
  "booking_id" integer NOT NULL,
  "actor_type" varchar(20) NOT NULL,
  "actor_id" integer,
  "source" varchar(40) NOT NULL,
  "action" varchar(30) NOT NULL,
  "before_state" json,
  "after_state" json,
  "request_id" varchar(128),
  "occurred_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "booking_audit_logs_client_id_clients_id_fk"
    FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE,
  CONSTRAINT "booking_audit_logs_booking_id_bookings_id_fk"
    FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE,
  CONSTRAINT "booking_audit_logs_actor_id_users_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX "booking_audit_logs_booking_idx"
  ON "booking_audit_logs" USING btree ("booking_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "booking_audit_logs_client_idx"
  ON "booking_audit_logs" USING btree ("client_id", "occurred_at");
