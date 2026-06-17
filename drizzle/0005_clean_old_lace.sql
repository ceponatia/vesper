CREATE TABLE "character_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"character_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD CONSTRAINT "character_chat_messages_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD CONSTRAINT "character_chat_messages_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_chat_messages_owner_character_idx" ON "character_chat_messages" USING btree ("owner_id","character_id","created_at");