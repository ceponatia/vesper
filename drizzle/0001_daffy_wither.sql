CREATE TABLE "location_links" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"from_location_id" text NOT NULL,
	"to_location_id" text NOT NULL,
	"travel_minutes" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_links_owner_idx" ON "location_links" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "location_links_from_idx" ON "location_links" USING btree ("from_location_id");