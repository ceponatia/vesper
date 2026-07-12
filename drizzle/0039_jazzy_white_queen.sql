ALTER TABLE "chat_scenario_presets" ADD COLUMN "starting_relationship" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill (followups ruling 4): the legacy single-vocabulary starting_stage
-- becomes an authored relationship record via the stageToBandIds bridge
-- (contracts/relationships/bands.ts) — familiarity per stageFamiliarity,
-- regard = the stage id where it is a regard band, with the two evicted rungs
-- re-homed (stranger → neutral, acquaintance → friendly).
UPDATE "chat_scenario_presets" SET "starting_relationship" = jsonb_build_object(
  'familiarity', CASE "starting_stage"
    WHEN 'stranger' THEN 'strangers'
    WHEN 'hostile' THEN 'introduced'
    WHEN 'wary' THEN 'introduced'
    WHEN 'cool' THEN 'introduced'
    WHEN 'acquaintance' THEN 'introduced'
    WHEN 'friendly' THEN 'acquainted'
    WHEN 'warm' THEN 'acquainted'
    WHEN 'close' THEN 'familiar'
    WHEN 'cherished' THEN 'familiar'
    WHEN 'devoted' THEN 'deeply_known'
    WHEN 'smitten' THEN 'deeply_known'
    ELSE 'strangers' END,
  'regard', CASE "starting_stage"
    WHEN 'stranger' THEN 'neutral'
    WHEN 'acquaintance' THEN 'friendly'
    WHEN 'hostile' THEN 'hostile'
    WHEN 'wary' THEN 'wary'
    WHEN 'cool' THEN 'cool'
    WHEN 'friendly' THEN 'friendly'
    WHEN 'warm' THEN 'warm'
    WHEN 'close' THEN 'close'
    WHEN 'cherished' THEN 'cherished'
    WHEN 'devoted' THEN 'devoted'
    WHEN 'smitten' THEN 'smitten'
    ELSE 'neutral' END,
  'kind', '',
  'history', '',
  'looming', false)
WHERE "starting_relationship" = '{}'::jsonb;
