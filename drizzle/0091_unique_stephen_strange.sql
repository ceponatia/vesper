ALTER TABLE "character_chat_state" ADD COLUMN "body_surface" jsonb;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "environment" jsonb;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "affordance_cues" jsonb;