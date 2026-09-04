ALTER TABLE "character_reference_views" ADD COLUMN "verdict" text;--> statement-breakpoint
-- Backfill the verdict from the two places a ruling was previously legible.
--
-- WHY. `status` is the only record a pre-column row has of the owner's ruling,
-- and it is destroyed by supersession: the next attempt on a slot overwrites
-- the retired row's status with `superseded`, so a rejection and an approval
-- become the same word. Reading it back afterwards is impossible, which is why
-- the column exists. These two statements recover every ruling that is still
-- legible at the moment the column lands, so the slot histories the studio
-- shows are not uniformly blank on their first read.
--
-- A row that was ALREADY superseded before this migration ran cannot be
-- recovered by anything: its ruling was overwritten, no other column recorded
-- it, and the retention sweep collects its bytes within the window anyway. It
-- reads as unreviewed, which is the honest answer for a ruling nothing knows.
--
-- Both statements are idempotent and guarded on `verdict IS NULL`, so a re-run
-- writes nothing and neither can overturn a verdict written by the application.
UPDATE "character_reference_views" SET "verdict" = 'rejected' WHERE "status" = 'rejected' AND "verdict" IS NULL;--> statement-breakpoint
UPDATE "character_reference_views" SET "verdict" = 'approved' WHERE "status" = 'ready' AND "reviewed_at" IS NOT NULL AND "verdict" IS NULL;
