ALTER TABLE "character_chat_state" ADD COLUMN "familiarity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "familiarity_scene_gain" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "character_chat_state" ADD COLUMN "relationship_record" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Hand-written (relationship-model.plan.md slice 2, owner-ruled rename): the feeling
-- axis keeps its values under its new name. Kept out of drizzle's diff on purpose —
-- the snapshot was updated to match, so future generates see no drift.
ALTER TABLE "character_chat_state" RENAME COLUMN "affinity" TO "regard";--> statement-breakpoint
-- Seed the new knowledge axis for existing rows from the old conflated ladder
-- (the stageFamiliarity bridge, at band midpoints): devoted/smitten ⇒ deeply known,
-- close/cherished ⇒ familiar, friendly/warm ⇒ acquainted, old acquaintance ⇒
-- introduced, stranger/neutral ⇒ strangers, and the hostile side ⇒ introduced
-- (you've interacted enough to be disliked).
UPDATE "character_chat_state" SET "familiarity" = CASE
  WHEN "regard" >= 90 THEN 90
  WHEN "regard" >= 65 THEN 67
  WHEN "regard" >= 33 THEN 42
  WHEN "regard" >= 15 THEN 20
  WHEN "regard" >= -14 THEN 5
  ELSE 20
END;--> statement-breakpoint
-- relationship_history ring: {affinity, stage} samples become {regard, band, familiarity}
-- (band re-homes the two evicted rungs; familiarity backfills 0 — the ramp starts now).
UPDATE "character_chat_state" SET "relationship_history" = (
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'at', e->'at',
      'clockMinutes', e->'clockMinutes',
      'regard', coalesce(e->'regard', e->'affinity', '0'::jsonb),
      'band', to_jsonb(CASE coalesce(e->>'band', e->>'stage', 'neutral')
        WHEN 'stranger' THEN 'neutral'
        WHEN 'acquaintance' THEN 'friendly'
        ELSE coalesce(e->>'band', e->>'stage', 'neutral') END),
      'familiarity', coalesce(e->'familiarity', '0'::jsonb)
    )), '[]'::jsonb)
  FROM jsonb_array_elements("relationship_history") e
) WHERE jsonb_array_length("relationship_history") > 0;--> statement-breakpoint
-- pre_exchange_state rollback anchors survive the rename too ("another take" on a
-- pre-migration exchange must not silently lose its target).
UPDATE "character_chat_state"
SET "pre_exchange_state" = ("pre_exchange_state" - 'affinity') || jsonb_build_object('regard', "pre_exchange_state"->'affinity')
WHERE "pre_exchange_state" ? 'affinity';
