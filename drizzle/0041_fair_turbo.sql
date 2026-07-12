ALTER TABLE "character_chats" ADD COLUMN "premise" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "active_social_cards" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "scene_auto" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "scene_model" text DEFAULT 'reference' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "scene_memory" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "clock_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "pending_skip_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "skip_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chats" ADD COLUMN "pre_exchange_scenario" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill (followups ruling 8): the scenario moves off the primary's state
-- row — each chat inherits its sort-0 participant's values.
UPDATE "character_chats" c SET
  "premise" = s."premise",
  "active_social_cards" = s."active_social_cards",
  "scene_auto" = s."scene_auto",
  "scene_model" = s."scene_model",
  "scene_memory" = s."scene_memory",
  "clock_minutes" = s."clock_minutes",
  "pending_skip_note" = s."pending_skip_note",
  "skip_history" = s."skip_history"
FROM "chat_participants" p
JOIN "character_chat_state" s
  ON s."chat_id" = p."chat_id" AND s."character_id" = p."character_id"
WHERE p."chat_id" = c."id" AND p."sort" = 0;
