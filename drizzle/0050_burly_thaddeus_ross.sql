ALTER TABLE "character_chat_state" ADD COLUMN "whereabouts" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "pending_meanwhile_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "meanwhile_pass_at_minutes" integer DEFAULT 0 NOT NULL;