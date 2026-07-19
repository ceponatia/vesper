CREATE TABLE "sim_body_conditions" (
	"branch_id" text NOT NULL,
	"condition_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"key" text NOT NULL,
	"onset_at" bigint NOT NULL,
	"expires_at" bigint,
	"status" text NOT NULL,
	"end_basis" text,
	"source_event_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_body_conditions_branch_condition_pk" PRIMARY KEY("branch_id","condition_id"),
	CONSTRAINT "sim_body_conditions_end_basis_matches_status" CHECK (("sim_body_conditions"."status" = 'ended') = ("sim_body_conditions"."end_basis" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sim_body_meters" (
	"branch_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"value_fixed_point" integer NOT NULL,
	"baseline_fixed_point" integer NOT NULL,
	"last_integrated_at" bigint NOT NULL,
	"registry_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_body_meters_branch_actor_meter_pk" PRIMARY KEY("branch_id","actor_id","meter_key"),
	CONSTRAINT "sim_body_meters_value_fixed_point_range" CHECK ("sim_body_meters"."value_fixed_point" >= 0 AND "sim_body_meters"."value_fixed_point" <= 10000),
	CONSTRAINT "sim_body_meters_baseline_fixed_point_range" CHECK ("sim_body_meters"."baseline_fixed_point" >= 0 AND "sim_body_meters"."baseline_fixed_point" <= 10000),
	CONSTRAINT "sim_body_meters_last_integrated_safe" CHECK ("sim_body_meters"."last_integrated_at" >= 0 AND "sim_body_meters"."last_integrated_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_body_modifiers" (
	"branch_id" text NOT NULL,
	"modifier_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"operation" jsonb NOT NULL,
	"stacking_group" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_until" bigint,
	"visibility" text NOT NULL,
	"condition_id" text,
	"source_event_id" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_body_modifiers_branch_modifier_pk" PRIMARY KEY("branch_id","modifier_id"),
	CONSTRAINT "sim_body_modifiers_validity_order" CHECK ("sim_body_modifiers"."valid_until" IS NULL OR "sim_body_modifiers"."valid_until" > "sim_body_modifiers"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "sim_body_conditions" ADD CONSTRAINT "sim_body_conditions_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_body_meters" ADD CONSTRAINT "sim_body_meters_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_body_modifiers" ADD CONSTRAINT "sim_body_modifiers_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_body_modifiers" ADD CONSTRAINT "sim_body_modifiers_branch_condition_fk" FOREIGN KEY ("branch_id","condition_id") REFERENCES "public"."sim_body_conditions"("branch_id","condition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_body_conditions_branch_actor_status_idx" ON "sim_body_conditions" USING btree ("branch_id","actor_id","status");--> statement-breakpoint
CREATE INDEX "sim_body_modifiers_branch_actor_meter_idx" ON "sim_body_modifiers" USING btree ("branch_id","actor_id","meter_key");