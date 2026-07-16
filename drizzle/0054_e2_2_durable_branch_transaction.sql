CREATE TABLE "sim_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"head_sequence" bigint DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"story_second" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_branches_id_world_unique" UNIQUE("id","world_id"),
	CONSTRAINT "sim_branches_head_sequence_safe" CHECK ("sim_branches"."head_sequence" >= 0 AND "sim_branches"."head_sequence" <= 9007199254740991),
	CONSTRAINT "sim_branches_version_safe" CHECK ("sim_branches"."version" >= 0 AND "sim_branches"."version" <= 9007199254740991),
	CONSTRAINT "sim_branches_story_second_safe" CHECK ("sim_branches"."story_second" >= 0 AND "sim_branches"."story_second" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_characters" (
	"branch_id" text NOT NULL,
	"character_id" text NOT NULL,
	"name" text NOT NULL,
	"observed_container_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_characters_branch_character_pk" PRIMARY KEY("branch_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "sim_commands" (
	"branch_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_id" text NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"expected_version" bigint NOT NULL,
	"principal_kind" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_commands_branch_idempotency_pk" PRIMARY KEY("branch_id","idempotency_key"),
	CONSTRAINT "sim_commands_expected_version_safe" CHECK ("sim_commands"."expected_version" >= 0 AND "sim_commands"."expected_version" <= 9007199254740991),
	CONSTRAINT "sim_commands_schema_version_positive" CHECK ("sim_commands"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sim_events" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"story_second" bigint NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"ruleset_version" text NOT NULL,
	"derivation_version" text,
	"command_id" text,
	"causation_id" text,
	"correlation_id" text NOT NULL,
	"actor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_id" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_events_sequence_safe" CHECK ("sim_events"."sequence" > 0 AND "sim_events"."sequence" <= 9007199254740991),
	CONSTRAINT "sim_events_story_second_safe" CHECK ("sim_events"."story_second" >= 0 AND "sim_events"."story_second" <= 9007199254740991),
	CONSTRAINT "sim_events_schema_version_positive" CHECK ("sim_events"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sim_holding_containers" (
	"branch_id" text NOT NULL,
	"holding_container_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"capacity" bigint NOT NULL,
	"accessible_to_actor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_holding_containers_branch_container_pk" PRIMARY KEY("branch_id","holding_container_id"),
	CONSTRAINT "sim_holding_containers_capacity_safe" CHECK ("sim_holding_containers"."capacity" >= 0 AND "sim_holding_containers"."capacity" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_item_holdings" (
	"branch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"holding_container_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_item_holdings_branch_item_pk" PRIMARY KEY("branch_id","item_id"),
	CONSTRAINT "sim_item_holdings_updated_sequence_safe" CHECK ("sim_item_holdings"."updated_sequence" >= 0 AND "sim_item_holdings"."updated_sequence" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_items" (
	"branch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_items_branch_item_pk" PRIMARY KEY("branch_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "sim_worlds" (
	"id" text PRIMARY KEY NOT NULL,
	"world_type_id" text NOT NULL,
	"seed" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sim_branches" ADD CONSTRAINT "sim_branches_world_id_sim_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."sim_worlds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_characters" ADD CONSTRAINT "sim_characters_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_commands" ADD CONSTRAINT "sim_commands_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_branch_world_fk" FOREIGN KEY ("branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_holding_containers" ADD CONSTRAINT "sim_holding_containers_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_item_fk" FOREIGN KEY ("branch_id","item_id") REFERENCES "public"."sim_items"("branch_id","item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_item_holdings" ADD CONSTRAINT "sim_item_holdings_container_fk" FOREIGN KEY ("branch_id","holding_container_id") REFERENCES "public"."sim_holding_containers"("branch_id","holding_container_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_items" ADD CONSTRAINT "sim_items_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_branches_world_idx" ON "sim_branches" USING btree ("world_id");--> statement-breakpoint
CREATE INDEX "sim_commands_branch_command_idx" ON "sim_commands" USING btree ("branch_id","command_id");--> statement-breakpoint
CREATE INDEX "sim_commands_status_idx" ON "sim_commands" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_events_branch_sequence_unique" ON "sim_events" USING btree ("branch_id","sequence");--> statement-breakpoint
CREATE INDEX "sim_events_branch_command_idx" ON "sim_events" USING btree ("branch_id","command_id");--> statement-breakpoint
CREATE INDEX "sim_events_type_idx" ON "sim_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "sim_item_holdings_container_idx" ON "sim_item_holdings" USING btree ("branch_id","holding_container_id");--> statement-breakpoint
CREATE INDEX "sim_worlds_status_idx" ON "sim_worlds" USING btree ("status");