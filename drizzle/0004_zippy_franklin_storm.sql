CREATE TABLE "image_references" (
	"id" text PRIMARY KEY NOT NULL,
	"scene_image_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text,
	"role" text,
	"source" text,
	"image_id" text,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_references" ADD CONSTRAINT "image_references_scene_image_id_images_id_fk" FOREIGN KEY ("scene_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_references_scene_idx" ON "image_references" USING btree ("scene_image_id");--> statement-breakpoint
CREATE INDEX "image_references_entity_idx" ON "image_references" USING btree ("kind","entity_id");