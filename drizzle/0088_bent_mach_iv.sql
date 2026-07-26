CREATE TABLE "usage_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"window_start" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_owner_kind_window_idx" ON "usage_counters" USING btree ("owner_id","kind","window_start");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_owner_status_idx" ON "jobs" USING btree ("owner_id","status");--> statement-breakpoint
-- Backfill images.bytes from the meta.bytes that writeWebpAtomic has always recorded, so
-- the per-owner storage quota measures existing assets instead of starting every account
-- at zero. Hand-added to the generated file (same convention as 0000's CREATE EXTENSION).
-- Guarded on jsonb_typeof so a legacy row with a non-numeric meta.bytes is skipped rather
-- than aborting the migration, and clamped to int4 range.
UPDATE "images"
SET "bytes" = LEAST(GREATEST(("meta"->>'bytes')::bigint, 0), 2147483647)
WHERE "bytes" = 0
  AND jsonb_typeof("meta"->'bytes') = 'number';