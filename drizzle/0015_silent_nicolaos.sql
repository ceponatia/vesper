ALTER TABLE "character_chat_state" ADD COLUMN "outfit" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "outfit_exposed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "active_social_cards" jsonb DEFAULT '[]'::jsonb NOT NULL;