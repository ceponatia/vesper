CREATE TABLE "sim_journeys" (
	"branch_id" text NOT NULL,
	"journey_id" text NOT NULL,
	"actor_ids" jsonb NOT NULL,
	"origin_zone_id" text NOT NULL,
	"destination_zone_id" text NOT NULL,
	"route_link_ids" jsonb NOT NULL,
	"travel_mode" text NOT NULL,
	"departed_at" bigint,
	"earliest_arrival_at" bigint NOT NULL,
	"expected_arrival_at" bigint NOT NULL,
	"status" text NOT NULL,
	"current_link_index" integer DEFAULT 0 NOT NULL,
	"route_derivation_version" text NOT NULL,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_journeys_branch_journey_pk" PRIMARY KEY("branch_id","journey_id"),
	CONSTRAINT "sim_journeys_not_self_journey" CHECK ("sim_journeys"."origin_zone_id" <> "sim_journeys"."destination_zone_id"),
	CONSTRAINT "sim_journeys_arrival_order" CHECK ("sim_journeys"."expected_arrival_at" >= "sim_journeys"."earliest_arrival_at"),
	CONSTRAINT "sim_journeys_link_index_nonnegative" CHECK ("sim_journeys"."current_link_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sim_links" (
	"branch_id" text NOT NULL,
	"link_id" text NOT NULL,
	"from_zone_id" text NOT NULL,
	"to_zone_id" text NOT NULL,
	"modes" jsonb NOT NULL,
	"minimum_duration_seconds" bigint NOT NULL,
	"schedule" jsonb,
	"access_policy" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_links_branch_link_pk" PRIMARY KEY("branch_id","link_id"),
	CONSTRAINT "sim_links_not_self_loop" CHECK ("sim_links"."from_zone_id" <> "sim_links"."to_zone_id"),
	CONSTRAINT "sim_links_duration_safe" CHECK ("sim_links"."minimum_duration_seconds" > 0 AND "sim_links"."minimum_duration_seconds" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sim_locations" (
	"branch_id" text NOT NULL,
	"location_id" text NOT NULL,
	"kind" text NOT NULL,
	"coordinate_x" real,
	"coordinate_y" real,
	"default_access_policy" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_locations_branch_location_pk" PRIMARY KEY("branch_id","location_id"),
	CONSTRAINT "sim_locations_coordinate_shape" CHECK (("sim_locations"."coordinate_x" IS NULL) = ("sim_locations"."coordinate_y" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sim_physical_loci" (
	"branch_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"location_id" text,
	"zone_id" text,
	"since" bigint,
	"journey_id" text,
	"link_id" text,
	"entered_at" bigint,
	"earliest_exit_at" bigint,
	"updated_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_physical_loci_branch_actor_pk" PRIMARY KEY("branch_id","actor_id"),
	CONSTRAINT "sim_physical_loci_at_shape" CHECK ("sim_physical_loci"."kind" <> 'at' OR ("sim_physical_loci"."location_id" IS NOT NULL AND "sim_physical_loci"."zone_id" IS NOT NULL AND "sim_physical_loci"."since" IS NOT NULL AND "sim_physical_loci"."journey_id" IS NULL AND "sim_physical_loci"."link_id" IS NULL AND "sim_physical_loci"."entered_at" IS NULL AND "sim_physical_loci"."earliest_exit_at" IS NULL)),
	CONSTRAINT "sim_physical_loci_transit_shape" CHECK ("sim_physical_loci"."kind" <> 'in_transit' OR ("sim_physical_loci"."journey_id" IS NOT NULL AND "sim_physical_loci"."link_id" IS NOT NULL AND "sim_physical_loci"."entered_at" IS NOT NULL AND "sim_physical_loci"."earliest_exit_at" IS NOT NULL AND "sim_physical_loci"."location_id" IS NULL AND "sim_physical_loci"."zone_id" IS NULL AND "sim_physical_loci"."since" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sim_zones" (
	"branch_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"location_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_zone_id" text,
	"occupancy_limit" integer,
	"privacy_policy" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_zones_branch_zone_pk" PRIMARY KEY("branch_id","zone_id"),
	CONSTRAINT "sim_zones_not_own_parent" CHECK ("sim_zones"."parent_zone_id" IS NULL OR "sim_zones"."parent_zone_id" <> "sim_zones"."zone_id"),
	CONSTRAINT "sim_zones_occupancy_positive" CHECK ("sim_zones"."occupancy_limit" IS NULL OR "sim_zones"."occupancy_limit" > 0)
);
--> statement-breakpoint
ALTER TABLE "sim_journeys" ADD CONSTRAINT "sim_journeys_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_links" ADD CONSTRAINT "sim_links_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_links" ADD CONSTRAINT "sim_links_branch_from_zone_fk" FOREIGN KEY ("branch_id","from_zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_links" ADD CONSTRAINT "sim_links_branch_to_zone_fk" FOREIGN KEY ("branch_id","to_zone_id") REFERENCES "public"."sim_zones"("branch_id","zone_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_locations" ADD CONSTRAINT "sim_locations_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_physical_loci" ADD CONSTRAINT "sim_physical_loci_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_physical_loci" ADD CONSTRAINT "sim_physical_loci_branch_actor_fk" FOREIGN KEY ("branch_id","actor_id") REFERENCES "public"."sim_characters"("branch_id","character_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_zones" ADD CONSTRAINT "sim_zones_branch_id_sim_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."sim_branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_zones" ADD CONSTRAINT "sim_zones_branch_location_fk" FOREIGN KEY ("branch_id","location_id") REFERENCES "public"."sim_locations"("branch_id","location_id") ON DELETE cascade ON UPDATE no action;