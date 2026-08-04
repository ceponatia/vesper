CREATE TABLE "chat_permission_events" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"guard_message_id" text,
	"event_ref" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"source_kind" text NOT NULL,
	"permitted_actor_id" text NOT NULL,
	"granting_target_id" text NOT NULL,
	"scope" text NOT NULL,
	"story_minute" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_permission_events" ADD CONSTRAINT "chat_permission_events_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_permission_events" ADD CONSTRAINT "chat_permission_events_guard_message_id_character_chat_messages_id_fk" FOREIGN KEY ("guard_message_id") REFERENCES "public"."character_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_permission_events_event_sequence_unique" ON "chat_permission_events" USING btree ("chat_id","event_ref","sequence");--> statement-breakpoint
CREATE INDEX "chat_permission_events_chat_guard_idx" ON "chat_permission_events" USING btree ("chat_id","guard_message_id");--> statement-breakpoint
CREATE INDEX "chat_permission_events_chat_created_idx" ON "chat_permission_events" USING btree ("chat_id","created_at");