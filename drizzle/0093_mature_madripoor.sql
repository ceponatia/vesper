CREATE TABLE "chat_contact_events" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"guard_message_id" text NOT NULL,
	"event_ref" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"contact_id" text NOT NULL,
	"story_minute" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "scene" jsonb;--> statement-breakpoint
ALTER TABLE "chat_contact_events" ADD CONSTRAINT "chat_contact_events_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_contact_events" ADD CONSTRAINT "chat_contact_events_guard_message_id_character_chat_messages_id_fk" FOREIGN KEY ("guard_message_id") REFERENCES "public"."character_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_contact_events_event_sequence_unique" ON "chat_contact_events" USING btree ("chat_id","event_ref","sequence");--> statement-breakpoint
CREATE INDEX "chat_contact_events_chat_guard_idx" ON "chat_contact_events" USING btree ("chat_id","guard_message_id");--> statement-breakpoint
CREATE INDEX "chat_contact_events_chat_created_idx" ON "chat_contact_events" USING btree ("chat_id","created_at");