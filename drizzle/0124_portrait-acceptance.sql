ALTER TABLE "characters" ADD COLUMN "accepted_avatar_image_id" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (issue #314): every character that already has a portrait starts with
-- that portrait ACCEPTED, so deploying this changes no character's identity
-- source, invalidates no identity pack, and starts no derivation. A character
-- with no portrait has nothing to accept and stays null on both columns.
UPDATE "characters" SET "accepted_avatar_image_id" = "avatar_image_id", "accepted_at" = now() WHERE "avatar_image_id" IS NOT NULL;
