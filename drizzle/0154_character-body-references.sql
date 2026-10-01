-- Body reference images for the reference views (#671): up to two full-body images
-- per character, each tagged clothed or unclothed, sent to the reference-view build
-- beside the identity pack for body shape, proportions and height only.
--
-- `character_body_references` holds them in two fixed slots. One CURRENT row per
-- (character, slot), held by a partial unique index, so a third image cannot be
-- stored; replacing or removing an image retires its row (`current = false`) and
-- the reference-view sweep collects the retired asset a week later. The image FK
-- cascades, so a purged image takes its row with it, and the character FK
-- cascades, so the whole set goes with the character. New and empty: nothing to
-- backfill.
--
-- `character_reference_views.body_reference_set` records the body-image set each
-- view was rendered against. NULLABLE with no default and NO backfill, on purpose:
-- NULL is the empty set, the honest answer for every existing row (all were
-- rendered from the portrait alone). A character that never adds a body image
-- therefore sees no change, and nothing already built or approved is invalidated
-- until its owner adds one.
CREATE TABLE "character_body_references" (
	"id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"slot" integer NOT NULL,
	"image_id" text NOT NULL,
	"tag" text NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_body_references_slot_range" CHECK ("character_body_references"."slot" IN (1, 2))
);
--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD COLUMN "body_reference_set" text;--> statement-breakpoint
ALTER TABLE "character_body_references" ADD CONSTRAINT "character_body_references_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_body_references" ADD CONSTRAINT "character_body_references_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_body_references_one_current_per_slot" ON "character_body_references" USING btree ("character_id","slot") WHERE current;