ALTER TABLE "character_chat_state" ADD COLUMN "scene_auto" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "anchor_message_id" text;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "images_chat_idx" ON "images" USING btree ("chat_id");