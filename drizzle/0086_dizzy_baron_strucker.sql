CREATE TABLE "sim_time_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"target_story_second" bigint NOT NULL,
	"reached_story_second" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_time_jobs_seconds_safe" CHECK ("sim_time_jobs"."reached_story_second" >= 0 AND "sim_time_jobs"."reached_story_second" <= "sim_time_jobs"."target_story_second" AND "sim_time_jobs"."target_story_second" <= 9007199254740991),
	CONSTRAINT "sim_time_jobs_attempts_nonnegative" CHECK ("sim_time_jobs"."attempts" >= 0),
	CONSTRAINT "sim_time_jobs_processing_has_lease" CHECK ("sim_time_jobs"."state" <> 'processing' OR ("sim_time_jobs"."lease_owner" IS NOT NULL AND "sim_time_jobs"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sim_time_jobs" ADD CONSTRAINT "sim_time_jobs_branch_world_fk" FOREIGN KEY ("branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sim_time_jobs_one_active_per_branch" ON "sim_time_jobs" USING btree ("branch_id") WHERE state in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "sim_time_jobs_claim_idx" ON "sim_time_jobs" USING btree ("state","available_at","created_at");--> statement-breakpoint
CREATE INDEX "sim_time_jobs_branch_idx" ON "sim_time_jobs" USING btree ("branch_id","state");