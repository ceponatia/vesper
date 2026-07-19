CREATE TABLE "sim_narrative_cuts" (
	"branch_id" text NOT NULL,
	"cut_id" text NOT NULL,
	"engagement_id" text NOT NULL,
	"viewpoint_actor_id" text NOT NULL,
	"compiler_version" text NOT NULL,
	"semantic_hash" text NOT NULL,
	"branch_version" bigint NOT NULL,
	"from_sequence" bigint NOT NULL,
	"through_sequence" bigint NOT NULL,
	"from_story_second" bigint NOT NULL,
	"through_story_second" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_narrative_cuts_branch_cut_pk" PRIMARY KEY("branch_id","cut_id"),
	CONSTRAINT "sim_narrative_cuts_sequence_order" CHECK ("sim_narrative_cuts"."from_sequence" >= 0 AND "sim_narrative_cuts"."through_sequence" >= "sim_narrative_cuts"."from_sequence"),
	CONSTRAINT "sim_narrative_cuts_story_second_order" CHECK ("sim_narrative_cuts"."from_story_second" >= 0 AND "sim_narrative_cuts"."through_story_second" >= "sim_narrative_cuts"."from_story_second")
);
--> statement-breakpoint
CREATE TABLE "sim_soft_canon" (
	"branch_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"subject_ids" jsonb NOT NULL,
	"value" jsonb NOT NULL,
	"confidence_fixed_point" integer NOT NULL,
	"first_recorded_at" bigint NOT NULL,
	"last_recorded_at" bigint NOT NULL,
	"valid_until" bigint,
	"source_cut_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"status_changed_at" bigint,
	"status_cause_event_id" text,
	"rules_version" text NOT NULL,
	"derivation_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_soft_canon_branch_entry_pk" PRIMARY KEY("branch_id","entry_id"),
	CONSTRAINT "sim_soft_canon_confidence_range" CHECK ("sim_soft_canon"."confidence_fixed_point" >= 0 AND "sim_soft_canon"."confidence_fixed_point" <= 10000),
	CONSTRAINT "sim_soft_canon_recorded_order" CHECK ("sim_soft_canon"."first_recorded_at" >= 0 AND "sim_soft_canon"."last_recorded_at" >= "sim_soft_canon"."first_recorded_at")
);
--> statement-breakpoint
ALTER TABLE "sim_narrative_cuts" ADD CONSTRAINT "sim_narrative_cuts_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_soft_canon" ADD CONSTRAINT "sim_soft_canon_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_narrative_cuts_branch_engagement_idx" ON "sim_narrative_cuts" USING btree ("branch_id","engagement_id","through_sequence");--> statement-breakpoint
CREATE INDEX "sim_soft_canon_branch_scope_status_idx" ON "sim_soft_canon" USING btree ("branch_id","scope","status");