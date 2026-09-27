-- Base chat meter drift on elapsed story time (#299): each character state row
-- records the story minute its stored `meters` hold at, and drift integrates
-- from that stamp to the chat's clock on read. A re-read at one clock is then a
-- no-op, and an away character catches up when next read.
--
-- The column is added NULLABLE with no default, then backfilled. Every current
-- writer stamps it; NULL is left only for a row that a writer predating this
-- column inserts while the release rolls out, and the application reads NULL
-- as "holds at the first clock it meets". A NOT NULL default of 0 would instead
-- make such a row integrate its chat's whole history on first read.
--
-- BACKFILL (hand-written; drizzle-kit cannot express a cross-table update):
-- every existing row starts from its own chat's clock at migration time, so the
-- first read after the release integrates nothing that happened before it.
-- Guarded on IS NULL, so a re-run is a no-op and a row already stamped by the
-- new application is never rewound. Every state row has a chat (the chat_id
-- foreign key cascades), so the join leaves no existing row unmatched.
ALTER TABLE "character_chat_state" ADD COLUMN "meters_at_minutes" integer;--> statement-breakpoint
UPDATE "character_chat_state" AS "state"
SET "meters_at_minutes" = "chat"."clock_minutes"
FROM "character_chats" AS "chat"
WHERE "chat"."id" = "state"."chat_id"
  AND "state"."meters_at_minutes" IS NULL;
