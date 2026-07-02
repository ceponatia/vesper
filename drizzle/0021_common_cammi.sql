CREATE TABLE "character_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"chat_id" text NOT NULL,
	"character_id" text NOT NULL,
	"memory_group_id" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_participants_chat_id_character_id_pk" PRIMARY KEY("chat_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "chat_scenario_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"premise" text DEFAULT '' NOT NULL,
	"outfit" text DEFAULT '' NOT NULL,
	"outfit_exposed" boolean DEFAULT false NOT NULL,
	"social_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starting_stage" text DEFAULT 'stranger' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD COLUMN "speaker_character_id" text;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "episodes" ADD COLUMN "chat_memory_group_id" text;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "chat_memory_group_id" text;--> statement-breakpoint
ALTER TABLE "character_chats" ADD CONSTRAINT "character_chats_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_scenario_presets" ADD CONSTRAINT "chat_scenario_presets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_chats_owner_recency_idx" ON "character_chats" USING btree ("owner_id","last_message_at");--> statement-breakpoint
CREATE INDEX "chat_participants_character_idx" ON "chat_participants" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "chat_scenario_presets_owner_idx" ON "chat_scenario_presets" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD CONSTRAINT "character_chat_messages_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_messages" ADD CONSTRAINT "character_chat_messages_speaker_character_id_characters_id_fk" FOREIGN KEY ("speaker_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD CONSTRAINT "character_chat_state_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_chat_summaries" ADD CONSTRAINT "character_chat_summaries_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_chat_messages_chat_idx" ON "character_chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
-- Backfill (character-chat-standalone.spec.md §1.6): one conversation per legacy
-- (owner, character) pair, deterministic ids (md5 of the pair) so participants,
-- transcript, summary, state, and memory rows can all join without app code.
INSERT INTO "character_chats" ("id", "owner_id", "title", "created_at", "last_message_at")
SELECT md5(p.owner_id || ':' || p.character_id), p.owner_id, '', now(), now()
FROM (
  SELECT DISTINCT owner_id, character_id FROM "character_chat_messages"
  UNION SELECT DISTINCT owner_id, character_id FROM "character_chat_state"
  UNION SELECT DISTINCT owner_id, character_id FROM "character_chat_summaries"
  UNION SELECT DISTINCT owner_id, character_id FROM "facts" WHERE character_id IS NOT NULL AND owner_id IS NOT NULL
  UNION SELECT DISTINCT owner_id, character_id FROM "episodes" WHERE character_id IS NOT NULL AND owner_id IS NOT NULL
) p;--> statement-breakpoint
UPDATE "character_chats" c SET last_message_at = m.max_at
FROM (SELECT owner_id, character_id, max(created_at) AS max_at FROM "character_chat_messages" GROUP BY owner_id, character_id) m
WHERE c.id = md5(m.owner_id || ':' || m.character_id);--> statement-breakpoint
INSERT INTO "chat_participants" ("chat_id", "character_id", "memory_group_id", "sort")
SELECT c.id, split_part(pair.pair, ':', 2), c.id, 0
FROM (
  SELECT DISTINCT owner_id || ':' || character_id AS pair, owner_id, character_id FROM "character_chat_messages"
  UNION SELECT DISTINCT owner_id || ':' || character_id, owner_id, character_id FROM "character_chat_state"
  UNION SELECT DISTINCT owner_id || ':' || character_id, owner_id, character_id FROM "character_chat_summaries"
  UNION SELECT DISTINCT owner_id || ':' || character_id, owner_id, character_id FROM "facts" WHERE character_id IS NOT NULL AND owner_id IS NOT NULL
  UNION SELECT DISTINCT owner_id || ':' || character_id, owner_id, character_id FROM "episodes" WHERE character_id IS NOT NULL AND owner_id IS NOT NULL
) pair
JOIN "character_chats" c ON c.id = md5(pair.owner_id || ':' || pair.character_id);--> statement-breakpoint
UPDATE "character_chat_messages" SET chat_id = md5(owner_id || ':' || character_id);--> statement-breakpoint
UPDATE "character_chat_messages" SET speaker_character_id = character_id WHERE role = 'assistant';--> statement-breakpoint
UPDATE "character_chat_summaries" SET chat_id = md5(owner_id || ':' || character_id);--> statement-breakpoint
UPDATE "character_chat_state" SET chat_id = md5(owner_id || ':' || character_id);--> statement-breakpoint
UPDATE "facts" SET chat_memory_group_id = md5(owner_id || ':' || character_id) WHERE character_id IS NOT NULL AND owner_id IS NOT NULL;--> statement-breakpoint
UPDATE "episodes" SET chat_memory_group_id = md5(owner_id || ':' || character_id) WHERE character_id IS NOT NULL AND owner_id IS NOT NULL;
