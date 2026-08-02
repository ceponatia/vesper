CREATE TABLE "chat_npc_scene_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"assistant_message_id" text NOT NULL,
	"reply_hash" text NOT NULL,
	"digest_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"mode" text NOT NULL,
	"story_minute" integer NOT NULL,
	"status" text NOT NULL,
	"base_scene_hash" text NOT NULL,
	"result_scene_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_npc_scene_decisions" ADD CONSTRAINT "chat_npc_scene_decisions_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_npc_scene_decisions" ADD CONSTRAINT "chat_npc_scene_decisions_assistant_message_id_character_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."character_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_npc_scene_decisions_assistant_unique" ON "chat_npc_scene_decisions" USING btree ("chat_id","assistant_message_id");--> statement-breakpoint
CREATE INDEX "chat_npc_scene_decisions_chat_created_idx" ON "chat_npc_scene_decisions" USING btree ("chat_id","created_at");