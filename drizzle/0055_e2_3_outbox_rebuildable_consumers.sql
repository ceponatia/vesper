CREATE TABLE "sim_consumer_checkpoints" (
	"consumer_kind" text NOT NULL,
	"branch_id" text NOT NULL,
	"through_sequence" bigint DEFAULT 0 NOT NULL,
	"projection_schema_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_consumer_checkpoints_consumer_branch_pk" PRIMARY KEY("consumer_kind","branch_id"),
	CONSTRAINT "sim_consumer_checkpoints_sequence_safe" CHECK ("sim_consumer_checkpoints"."through_sequence" >= 0 AND "sim_consumer_checkpoints"."through_sequence" <= 9007199254740991),
	CONSTRAINT "sim_consumer_checkpoints_schema_version_positive" CHECK ("sim_consumer_checkpoints"."projection_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sim_item_transfer_feed" (
	"consumer_kind" text NOT NULL,
	"branch_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"source_sequence" bigint NOT NULL,
	"story_second" bigint NOT NULL,
	"actor_id" text NOT NULL,
	"item_id" text NOT NULL,
	"from_container_id" text NOT NULL,
	"to_container_id" text NOT NULL,
	"projection_schema_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_item_transfer_feed_consumer_branch_event_pk" PRIMARY KEY("consumer_kind","branch_id","source_event_id"),
	CONSTRAINT "sim_item_transfer_feed_branch_sequence_unique" UNIQUE("consumer_kind","branch_id","source_sequence"),
	CONSTRAINT "sim_item_transfer_feed_sequence_safe" CHECK ("sim_item_transfer_feed"."source_sequence" > 0 AND "sim_item_transfer_feed"."source_sequence" <= 9007199254740991),
	CONSTRAINT "sim_item_transfer_feed_story_second_safe" CHECK ("sim_item_transfer_feed"."story_second" >= 0 AND "sim_item_transfer_feed"."story_second" <= 9007199254740991),
	CONSTRAINT "sim_item_transfer_feed_schema_version_positive" CHECK ("sim_item_transfer_feed"."projection_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sim_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"world_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"first_sequence" bigint NOT NULL,
	"last_sequence" bigint NOT NULL,
	"consumer_kind" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_outbox_consumer_event_unique" UNIQUE("consumer_kind","branch_id","source_event_id"),
	CONSTRAINT "sim_outbox_sequence_range_safe" CHECK ("sim_outbox"."first_sequence" > 0 AND "sim_outbox"."first_sequence" <= "sim_outbox"."last_sequence" AND "sim_outbox"."last_sequence" <= 9007199254740991),
	CONSTRAINT "sim_outbox_schema_version_positive" CHECK ("sim_outbox"."schema_version" > 0),
	CONSTRAINT "sim_outbox_attempts_nonnegative" CHECK ("sim_outbox"."attempts" >= 0),
	CONSTRAINT "sim_outbox_processing_has_lease" CHECK ("sim_outbox"."state" <> 'processing' OR ("sim_outbox"."lease_owner" IS NOT NULL AND "sim_outbox"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sim_consumer_checkpoints" ADD CONSTRAINT "sim_consumer_checkpoints_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_branch_id_unique" UNIQUE("branch_id","id");--> statement-breakpoint
ALTER TABLE "sim_item_transfer_feed" ADD CONSTRAINT "sim_item_transfer_feed_branch_event_fk" FOREIGN KEY ("branch_id","source_event_id") REFERENCES "public"."sim_events"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_outbox" ADD CONSTRAINT "sim_outbox_branch_world_fk" FOREIGN KEY ("branch_id","world_id") REFERENCES "public"."sim_branches"("id","world_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_outbox" ADD CONSTRAINT "sim_outbox_branch_event_fk" FOREIGN KEY ("branch_id","source_event_id") REFERENCES "public"."sim_events"("branch_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_item_transfer_feed_branch_story_idx" ON "sim_item_transfer_feed" USING btree ("branch_id","story_second");--> statement-breakpoint
CREATE INDEX "sim_outbox_claim_idx" ON "sim_outbox" USING btree ("consumer_kind","state","available_at","first_sequence");--> statement-breakpoint
CREATE INDEX "sim_outbox_branch_sequence_idx" ON "sim_outbox" USING btree ("consumer_kind","branch_id","first_sequence");
