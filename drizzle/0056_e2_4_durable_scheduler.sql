CREATE TABLE "sim_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"kind" text NOT NULL,
	"schema_version" integer NOT NULL,
	"due_story_second" bigint NOT NULL,
	"stable_order" bigint NOT NULL,
	"uniqueness_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"result_command_id" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_triggers_branch_uniqueness_unique" UNIQUE("branch_id","uniqueness_key"),
	CONSTRAINT "sim_triggers_branch_order_unique" UNIQUE("branch_id","stable_order"),
	CONSTRAINT "sim_triggers_schema_version_positive" CHECK ("sim_triggers"."schema_version" > 0),
	CONSTRAINT "sim_triggers_due_story_second_safe" CHECK ("sim_triggers"."due_story_second" >= 0 AND "sim_triggers"."due_story_second" <= 9007199254740991),
	CONSTRAINT "sim_triggers_stable_order_safe" CHECK ("sim_triggers"."stable_order" > 0 AND "sim_triggers"."stable_order" <= 9007199254740991),
	CONSTRAINT "sim_triggers_attempts_nonnegative" CHECK ("sim_triggers"."attempts" >= 0),
	CONSTRAINT "sim_triggers_processing_has_lease" CHECK ("sim_triggers"."state" <> 'processing' OR ("sim_triggers"."lease_owner" IS NOT NULL AND "sim_triggers"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sim_triggers" ADD CONSTRAINT "sim_triggers_branch_world_fk" FOREIGN KEY ("branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "sim_triggers_claim_idx" ON "sim_triggers" USING btree ("state","available_at","due_story_second","stable_order");
--> statement-breakpoint
CREATE INDEX "sim_triggers_branch_due_idx" ON "sim_triggers" USING btree ("branch_id","due_story_second","stable_order");
