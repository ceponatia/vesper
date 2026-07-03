ALTER TABLE "character_chat_state" ADD COLUMN "relationship_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "skip_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "pending_skip_note" text DEFAULT '' NOT NULL;