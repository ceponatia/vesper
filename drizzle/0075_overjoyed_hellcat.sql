CREATE TABLE "sim_household_restock_routines" (
	"branch_id" text NOT NULL,
	"household_id" text NOT NULL,
	"material_kind_key" text NOT NULL,
	"target_quantity_raw" bigint NOT NULL,
	"low_water_threshold_raw" bigint NOT NULL,
	"cadence_seconds" integer NOT NULL,
	"funding" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_household_restock_routines_branch_household_kind_pk" PRIMARY KEY("branch_id","household_id","material_kind_key"),
	CONSTRAINT "sim_household_restock_routines_threshold_order" CHECK ("sim_household_restock_routines"."low_water_threshold_raw" <= "sim_household_restock_routines"."target_quantity_raw"),
	CONSTRAINT "sim_household_restock_routines_cadence_positive" CHECK ("sim_household_restock_routines"."cadence_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "sim_household_restock_routines" ADD CONSTRAINT "sim_household_restock_routines_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_household_restock_routines" ADD CONSTRAINT "sim_household_restock_routines_household_fk" FOREIGN KEY ("branch_id","household_id") REFERENCES "public"."sim_households"("branch_id","household_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_household_members" ADD CONSTRAINT "sim_household_members_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;