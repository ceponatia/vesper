ALTER TABLE "character_chat_state" ADD COLUMN "open_loops" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "origin" text DEFAULT 'extracted' NOT NULL;