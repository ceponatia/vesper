ALTER TABLE "character_chat_messages" ADD COLUMN "takes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "pre_exchange_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "source_message_id" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "source_message_id" text;