ALTER TABLE "character_chats" ADD COLUMN "player_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_persona_id" text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill: users.player_persona (the legacy inline blob) -> a personas row
-- (persona-library.plan.md slice 6). HAND-WRITTEN DML appended to a generated
-- migration — deliberately, and drizzle-kit will not clobber it: the snapshot
-- only tracks DDL, so future diffs are unaffected.
--
-- Why here and not a script: migration 0053 DROPs player_persona, and the Fly
-- deploy runs `pnpm db:migrate` unattended. A separate backfill script would be
-- one forgotten command away from dropping the column with the data still in it.
-- In-migration, the backfill and the drop can't be run out of order.
--
-- ids are gen_random_uuid()::text rather than the app's cuid2 (`newId()`), which
-- SQL can't produce. Nothing validates id FORMAT (idSchema is just a non-empty
-- string), only uniqueness — so backfilled rows are merely visually distinct.
-- ---------------------------------------------------------------------------
INSERT INTO "personas" ("id", "owner_id", "title", "name", "profile", "tags")
SELECT
  gen_random_uuid()::text,
  u."id",
  -- Title and name both start from the blob's name, falling back to the account
  -- name (the same fallback resolvePersonaFromRow used), then a last-resort
  -- literal so a blank account name can't write an empty title.
  COALESCE(NULLIF(btrim(u."player_persona"->>'name'), ''), NULLIF(btrim(u."name"), ''), 'Me'),
  COALESCE(NULLIF(btrim(u."player_persona"->>'name'), ''), NULLIF(btrim(u."name"), ''), 'Me'),
  jsonb_build_object('bio', COALESCE(u."player_persona"->>'persona', '')),
  '[]'::jsonb
FROM "users" u
WHERE COALESCE(NULLIF(btrim(u."player_persona"->>'name'), ''), '') <> ''
   OR COALESCE(NULLIF(btrim(u."player_persona"->>'persona'), ''), '') <> ''
-- A user who already hand-made a persona under this exact title keeps theirs.
ON CONFLICT ("owner_id", "title") DO NOTHING;--> statement-breakpoint

UPDATE "users" u
SET "default_persona_id" = p."id"
FROM "personas" p
WHERE p."owner_id" = u."id"
  AND u."default_persona_id" IS NULL
  AND p."title" = COALESCE(NULLIF(btrim(u."player_persona"->>'name'), ''), NULLIF(btrim(u."name"), ''), 'Me');
