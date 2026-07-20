CREATE TABLE "sim_household_members" (
	"branch_id" text NOT NULL,
	"household_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"ended_at_story_second" bigint,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_household_members_branch_household_actor_pk" PRIMARY KEY("branch_id","household_id","actor_id"),
	CONSTRAINT "sim_household_members_end_basis_matches_status" CHECK (("sim_household_members"."status" = 'ended') = ("sim_household_members"."ended_at_story_second" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sim_households" (
	"branch_id" text NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"residence_zone_ids" jsonb NOT NULL,
	"stock_access_policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_households_branch_household_pk" PRIMARY KEY("branch_id","household_id")
);
--> statement-breakpoint
CREATE TABLE "sim_material_lots" (
	"branch_id" text NOT NULL,
	"lot_key" text NOT NULL,
	"locus_kind" text NOT NULL,
	"household_id" text,
	"actor_id" text,
	"zone_id" text,
	"material_kind_key" text NOT NULL,
	"quantity_kind" text NOT NULL,
	"quantity_raw" bigint DEFAULT 0 NOT NULL,
	"registry_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_material_lots_branch_lot_pk" PRIMARY KEY("branch_id","lot_key"),
	CONSTRAINT "sim_material_lots_quantity_safe" CHECK ("sim_material_lots"."quantity_raw" >= 0 AND "sim_material_lots"."quantity_raw" <= 9007199254740991),
	CONSTRAINT "sim_material_lots_household_shape" CHECK ("sim_material_lots"."locus_kind" <> 'household' OR ("sim_material_lots"."household_id" IS NOT NULL AND "sim_material_lots"."actor_id" IS NULL AND "sim_material_lots"."zone_id" IS NULL)),
	CONSTRAINT "sim_material_lots_actor_shape" CHECK ("sim_material_lots"."locus_kind" <> 'actor' OR ("sim_material_lots"."actor_id" IS NOT NULL AND "sim_material_lots"."household_id" IS NULL AND "sim_material_lots"."zone_id" IS NULL)),
	CONSTRAINT "sim_material_lots_zone_shape" CHECK ("sim_material_lots"."locus_kind" <> 'zone' OR ("sim_material_lots"."zone_id" IS NOT NULL AND "sim_material_lots"."household_id" IS NULL AND "sim_material_lots"."actor_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sim_means_bands" (
	"branch_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"actor_id" text,
	"household_id" text,
	"band_key" text NOT NULL,
	"registry_version" text NOT NULL,
	"set_at_story_second" bigint NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_means_bands_branch_subject_pk" PRIMARY KEY("branch_id","subject_key"),
	CONSTRAINT "sim_means_bands_actor_shape" CHECK ("sim_means_bands"."subject_kind" <> 'actor' OR ("sim_means_bands"."actor_id" IS NOT NULL AND "sim_means_bands"."household_id" IS NULL)),
	CONSTRAINT "sim_means_bands_household_shape" CHECK ("sim_means_bands"."subject_kind" <> 'household' OR ("sim_means_bands"."household_id" IS NOT NULL AND "sim_means_bands"."actor_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sim_household_members" ADD CONSTRAINT "sim_household_members_household_fk" FOREIGN KEY ("branch_id","household_id") REFERENCES "public"."sim_households"("branch_id","household_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_household_members" ADD CONSTRAINT "sim_household_members_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_households" ADD CONSTRAINT "sim_households_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_material_lots" ADD CONSTRAINT "sim_material_lots_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_material_lots" ADD CONSTRAINT "sim_material_lots_household_fk" FOREIGN KEY ("branch_id","household_id") REFERENCES "public"."sim_households"("branch_id","household_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_material_lots" ADD CONSTRAINT "sim_material_lots_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_material_lots" ADD CONSTRAINT "sim_material_lots_zone_fk" FOREIGN KEY ("branch_id","zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_means_bands" ADD CONSTRAINT "sim_means_bands_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_means_bands" ADD CONSTRAINT "sim_means_bands_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sim_means_bands" ADD CONSTRAINT "sim_means_bands_household_fk" FOREIGN KEY ("branch_id","household_id") REFERENCES "public"."sim_households"("branch_id","household_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "sim_household_members_branch_actor_idx" ON "sim_household_members" USING btree ("branch_id","actor_id");--> statement-breakpoint
CREATE INDEX "sim_material_lots_household_kind_idx" ON "sim_material_lots" USING btree ("branch_id","household_id","material_kind_key");--> statement-breakpoint
CREATE INDEX "sim_material_lots_actor_kind_idx" ON "sim_material_lots" USING btree ("branch_id","actor_id","material_kind_key");--> statement-breakpoint
CREATE INDEX "sim_material_lots_zone_kind_idx" ON "sim_material_lots" USING btree ("branch_id","zone_id","material_kind_key");