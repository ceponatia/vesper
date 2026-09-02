ALTER TABLE "events" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "chat_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_chat_id_character_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."character_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_chat_idx" ON "events" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "jobs_chat_idx" ON "jobs" USING btree ("chat_id");--> statement-breakpoint
-- Backfill (issue #196): a job whose payload names a chat that still exists gets
-- that chat as its first-class scope. A payload naming an already-deleted chat is
-- left unscoped on purpose — the FK would refuse it, and retention removes old
-- terminal rows anyway — so this statement can never fail on stale history.
UPDATE "jobs" j
SET "chat_id" = j."payload"->>'chatId'
WHERE j."chat_id" IS NULL
  AND j."payload"->>'chatId' IS NOT NULL
  AND EXISTS (SELECT 1 FROM "character_chats" c WHERE c."id" = j."payload"->>'chatId');
