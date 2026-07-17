CREATE TABLE "sim_action_definitions" (
	"branch_id" text NOT NULL,
	"action_definition_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_action_definitions_branch_action_pk" PRIMARY KEY("branch_id","action_definition_id"),
	CONSTRAINT "sim_action_definitions_version_positive" CHECK ("sim_action_definitions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sim_activities" (
	"branch_id" text NOT NULL,
	"activity_instance_id" text NOT NULL,
	"action_definition_id" text NOT NULL,
	"action_version" integer NOT NULL,
	"actor_ids" jsonb NOT NULL,
	"zone_id" text NOT NULL,
	"phase" text NOT NULL,
	"started_at" bigint,
	"expected_complete_at" bigint,
	"progress_fixed_point" integer DEFAULT 0 NOT NULL,
	"claims" jsonb NOT NULL,
	"source_command_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_activities_branch_activity_pk" PRIMARY KEY("branch_id","activity_instance_id"),
	CONSTRAINT "sim_activities_action_version_positive" CHECK ("sim_activities"."action_version" > 0),
	CONSTRAINT "sim_activities_progress_range" CHECK ("sim_activities"."progress_fixed_point" >= 0 AND "sim_activities"."progress_fixed_point" <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "sim_action_definitions" ADD CONSTRAINT "sim_action_definitions_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_activities" ADD CONSTRAINT "sim_activities_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_activities" ADD CONSTRAINT "sim_activities_branch_zone_fk" FOREIGN KEY ("branch_id","zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_activities_branch_phase_idx" ON "sim_activities" USING btree ("branch_id","phase");