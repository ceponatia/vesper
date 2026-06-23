ALTER TABLE "item_instances" DROP CONSTRAINT "item_instances_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "session_locations" DROP CONSTRAINT "session_locations_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "session_participants" DROP CONSTRAINT "session_participants_character_id_characters_id_fk";
--> statement-breakpoint
ALTER TABLE "world_cast" DROP CONSTRAINT "world_cast_character_id_characters_id_fk";
--> statement-breakpoint
ALTER TABLE "world_items" DROP CONSTRAINT "world_items_item_id_items_id_fk";
--> statement-breakpoint
ALTER TABLE "world_locations" DROP CONSTRAINT "world_locations_location_id_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "source_character_id" text;--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "source_stamped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "world_cast" ADD COLUMN "avatar_image_id" text;--> statement-breakpoint
ALTER TABLE "world_items" ADD COLUMN "source_item_id" text;--> statement-breakpoint
ALTER TABLE "world_items" ADD COLUMN "source_stamped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "world_items" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "world_items" ADD COLUMN "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "world_locations" ADD COLUMN "source_location_id" text;--> statement-breakpoint
ALTER TABLE "world_locations" ADD COLUMN "source_stamped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "world_locations" ADD COLUMN "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "world_cast" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "world_items" DROP COLUMN "item_id";--> statement-breakpoint
ALTER TABLE "world_locations" DROP COLUMN "location_id";--> statement-breakpoint
ALTER TABLE "world_locations" DROP COLUMN "overrides";