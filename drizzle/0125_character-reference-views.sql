CREATE TABLE "character_reference_views" (
	"id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"angle_id" text NOT NULL,
	"wardrobe" text NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"source_image_id" text,
	"source_content_hash" text NOT NULL,
	"image_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"generation_version" integer NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD CONSTRAINT "character_reference_views_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD CONSTRAINT "character_reference_views_source_image_id_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD CONSTRAINT "character_reference_views_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD CONSTRAINT "character_reference_views_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_reference_views_one_current_per_slot" ON "character_reference_views" USING btree ("character_id","angle_id","wardrobe") WHERE current;--> statement-breakpoint
CREATE INDEX "character_reference_views_slot_idx" ON "character_reference_views" USING btree ("character_id","angle_id","wardrobe","created_at");