ALTER TABLE "character_reference_views" ADD COLUMN "review_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_reference_views" ADD COLUMN "feedback" jsonb;