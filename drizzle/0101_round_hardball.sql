CREATE TABLE "image_identity_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"revision" integer NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_image_id" text,
	"source_content_hash" text NOT NULL,
	"source_width" integer NOT NULL,
	"source_height" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"derivation_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"method" text,
	"detector_version" text,
	"confidence" real,
	"face_crop_image_id" text,
	"crop_json" jsonb,
	"quality_json" jsonb,
	"warning_codes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"reviewed_by_user_id" text,
	"review_reason" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "image_identity_packs" ADD CONSTRAINT "image_identity_packs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_packs" ADD CONSTRAINT "image_identity_packs_source_image_id_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_packs" ADD CONSTRAINT "image_identity_packs_face_crop_image_id_images_id_fk" FOREIGN KEY ("face_crop_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_identity_packs" ADD CONSTRAINT "image_identity_packs_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_packs_one_current_per_character" ON "image_identity_packs" USING btree ("character_id") WHERE current;--> statement-breakpoint
CREATE UNIQUE INDEX "image_identity_packs_character_revision_unique" ON "image_identity_packs" USING btree ("character_id","revision");--> statement-breakpoint
CREATE INDEX "image_identity_packs_derivation_idx" ON "image_identity_packs" USING btree ("character_id","source_content_hash","schema_version","derivation_version","revision");