CREATE TABLE "sim_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"projection_kind" text NOT NULL,
	"sequence" bigint NOT NULL,
	"projection_schema_version" integer NOT NULL,
	"ruleset_version" text NOT NULL,
	"checksum" text NOT NULL,
	"source_first_sequence" bigint NOT NULL,
	"source_last_sequence" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_snapshots_branch_kind_sequence_unique" UNIQUE("branch_id","projection_kind","sequence"),
	CONSTRAINT "sim_snapshots_sequence_safe" CHECK ("sim_snapshots"."sequence" >= 0 AND "sim_snapshots"."sequence" <= 9007199254740991),
	CONSTRAINT "sim_snapshots_schema_version_positive" CHECK ("sim_snapshots"."projection_schema_version" > 0),
	CONSTRAINT "sim_snapshots_source_range_safe" CHECK ("sim_snapshots"."source_first_sequence" >= 0 AND "sim_snapshots"."source_first_sequence" <= "sim_snapshots"."source_last_sequence" AND "sim_snapshots"."source_last_sequence" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "origin_story_second" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "parent_branch_id" text;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "fork_sequence" bigint;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "parent_ruleset_version" text;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "parent_event_schema_version" integer;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "forked_by_principal_kind" text;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "forked_by_principal_id" text;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "fork_reason" text;--> statement-breakpoint
ALTER TABLE "sim_branches" ADD COLUMN "inherited_snapshot_checksum" text;--> statement-breakpoint
ALTER TABLE "sim_snapshots" ADD CONSTRAINT "sim_snapshots_branch_world_fk" FOREIGN KEY ("branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_snapshots_branch_idx" ON "sim_snapshots" USING btree ("branch_id","projection_kind","sequence");--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_parent_world_fk" FOREIGN KEY ("parent_branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_branches_parent_idx" ON "sim_branches" USING btree ("parent_branch_id");--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_origin_story_second_safe" CHECK ("sim_branches"."origin_story_second" >= 0 AND "sim_branches"."origin_story_second" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_fork_sequence_safe" CHECK ("sim_branches"."fork_sequence" IS NULL OR ("sim_branches"."fork_sequence" >= 0 AND "sim_branches"."fork_sequence" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_not_own_parent" CHECK ("sim_branches"."parent_branch_id" IS NULL OR "sim_branches"."parent_branch_id" <> "sim_branches"."id");--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_fork_shape" CHECK (("sim_branches"."parent_branch_id" IS NULL AND "sim_branches"."fork_sequence" IS NULL AND "sim_branches"."parent_ruleset_version" IS NULL AND "sim_branches"."parent_event_schema_version" IS NULL AND "sim_branches"."forked_by_principal_kind" IS NULL AND "sim_branches"."forked_by_principal_id" IS NULL AND "sim_branches"."fork_reason" IS NULL AND "sim_branches"."inherited_snapshot_checksum" IS NULL) OR ("sim_branches"."parent_branch_id" IS NOT NULL AND "sim_branches"."fork_sequence" IS NOT NULL AND "sim_branches"."parent_ruleset_version" IS NOT NULL AND "sim_branches"."parent_event_schema_version" IS NOT NULL AND "sim_branches"."forked_by_principal_kind" IS NOT NULL AND "sim_branches"."forked_by_principal_id" IS NOT NULL AND "sim_branches"."fork_reason" IS NOT NULL AND "sim_branches"."inherited_snapshot_checksum" IS NOT NULL));