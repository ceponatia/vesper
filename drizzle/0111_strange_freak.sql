CREATE TABLE "visual_reference_extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"character_id" text NOT NULL,
	"source_image_id" text,
	"source_hash" text NOT NULL,
	"extractor_id" text NOT NULL,
	"extractor_version" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_reference_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"extraction_id" text NOT NULL,
	"character_id" text NOT NULL,
	"slot_key" text NOT NULL,
	"target_owner" text NOT NULL,
	"kind_id" text NOT NULL,
	"locus_json" jsonb,
	"value_json" jsonb NOT NULL,
	"proposed_fingerprint" text NOT NULL,
	"confidence" integer NOT NULL,
	"evidence_region_json" jsonb,
	"baseline_json" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"edited_value_json" jsonb,
	"carried_from_proposal_id" text,
	"conflict_with_proposal_id" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visual_reference_extractions" ADD CONSTRAINT "visual_reference_extractions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_reference_extractions" ADD CONSTRAINT "visual_reference_extractions_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_reference_extractions" ADD CONSTRAINT "visual_reference_extractions_source_image_id_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_reference_proposals" ADD CONSTRAINT "visual_reference_proposals_extraction_id_visual_reference_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."visual_reference_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_reference_proposals" ADD CONSTRAINT "visual_reference_proposals_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_reference_proposals" ADD CONSTRAINT "visual_reference_proposals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visual_reference_extractions_character_idx" ON "visual_reference_extractions" USING btree ("character_id","created_at");--> statement-breakpoint
CREATE INDEX "visual_reference_proposals_extraction_idx" ON "visual_reference_proposals" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX "visual_reference_proposals_slot_idx" ON "visual_reference_proposals" USING btree ("character_id","slot_key","created_at");