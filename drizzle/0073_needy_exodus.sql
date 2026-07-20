CREATE TABLE "sim_item_condition_meters" (
	"branch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"value_fixed_point" integer NOT NULL,
	"baseline_fixed_point" integer NOT NULL,
	"last_integrated_at" bigint NOT NULL,
	"registry_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_item_condition_meters_branch_item_meter_pk" PRIMARY KEY("branch_id","item_id","meter_key"),
	CONSTRAINT "sim_item_condition_meters_value_fixed_point_range" CHECK ("sim_item_condition_meters"."value_fixed_point" >= 0 AND "sim_item_condition_meters"."value_fixed_point" <= 10000),
	CONSTRAINT "sim_item_condition_meters_baseline_fixed_point_range" CHECK ("sim_item_condition_meters"."baseline_fixed_point" >= 0 AND "sim_item_condition_meters"."baseline_fixed_point" <= 10000),
	CONSTRAINT "sim_item_condition_meters_last_integrated_safe" CHECK ("sim_item_condition_meters"."last_integrated_at" >= 0 AND "sim_item_condition_meters"."last_integrated_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_item_condition_modifiers" (
	"branch_id" text NOT NULL,
	"modifier_id" text NOT NULL,
	"item_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"operation" jsonb NOT NULL,
	"stacking_group" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_until" bigint,
	"source_event_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_item_condition_modifiers_branch_modifier_pk" PRIMARY KEY("branch_id","modifier_id"),
	CONSTRAINT "sim_item_condition_modifiers_validity_order" CHECK ("sim_item_condition_modifiers"."valid_until" IS NULL OR "sim_item_condition_modifiers"."valid_until" > "sim_item_condition_modifiers"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "sim_items" ADD COLUMN "condition_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_item_condition_meters" ADD CONSTRAINT "sim_item_condition_meters_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_item_condition_modifiers" ADD CONSTRAINT "sim_item_condition_modifiers_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Drizzle cannot express FK deferrability (schema.ts comments on the
-- sim_item_condition_modifiers_item_fk constraint) — the 0069 precedent,
-- hand-applied here: a world/branch teardown cascades sim_items and
-- sim_item_condition_modifiers from the SAME sim_branches delete, and
-- Postgres does not order sibling cascades against each other, so a
-- non-deferred FK can fire before the row it references is (about to be)
-- gone too.
ALTER TABLE "sim_item_condition_modifiers" ADD CONSTRAINT "sim_item_condition_modifiers_item_fk" FOREIGN KEY ("branch_id","item_id") REFERENCES "public"."sim_items"("branch_id","item_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "sim_item_condition_modifiers_branch_item_meter_idx" ON "sim_item_condition_modifiers" USING btree ("branch_id","item_id","meter_key");