-- Expose the Civitai FLUX.2 Klein 4B sampling knobs the adapter already sends as
-- real Image Generator controls, on the EXISTING bench row. No new model
-- definition: the adapter and this row are the thing being changed.
--
-- WHY. Migration 0146 shipped the v2 workflow with a fixed sampling policy, and
-- the adapter hard-coded CFG 5 / 20 steps beside it. A 2026-09-16 controlled
-- comparison against the live endpoint — same seed, prompt, aspect and LoRA,
-- varying one knob at a time — showed that policy is wrong for a DISTILLED
-- checkpoint and that no single replacement is right for every render:
--
--   cfg 1  /  4 steps   2 Buzz   BFL's own reference recipe; clean single subject
--   cfg 1  /  8 steps   3 Buzz   resolves multi-subject anatomy 4 steps mangles
--   cfg 2.5 / 8 steps   5 Buzz   negative prompt finally bites; cleanest result
--   cfg 5  / 20 steps  12 Buzz   over-driven: stippled skin, twice the price
--
-- So the values become curated controls with the distilled defaults, rather than
-- one constant that is wrong half the time. The adapter refuses out-of-band
-- values instead of clamping them, matching the LoRA-scale rule already in force.
--
-- `negativePrompt` IS THE CAMELCASE SPELLING. Migration 0145 declared
-- `negative_prompt` for the retired website graph; the v2 endpoint discards that
-- spelling silently, exactly as it discards an invented field name, so a
-- snake_case binding renders without the operator's negative prompt and reports
-- success. The adapter's preflight now compares this field by presence as well
-- as value so a dropped negative prompt refuses the spend rather than paying for
-- a setting that did nothing.
--
-- The adapter additionally refuses a negative prompt at cfgScale 1: with no
-- unconditional branch there is nothing to steer away from, and the same seed
-- with and without one produced PIXEL-IDENTICAL output while the provider echoed
-- the field back both times. That is a runtime rule rather than a catalog one —
-- it constrains a PAIR of controls, which a per-field binding cannot express.
--
-- Written as a merge, not a replacement: `||` adds the three controls and
-- extends the two field lists while leaving every other key this row carries
-- untouched. The predicate is the absence of the new controls, so an operator
-- who has already curated them keeps their version and a re-run changes nothing.
UPDATE "image_models"
SET
  "advanced_capabilities" = "advanced_capabilities"
    || jsonb_build_object(
      'controls',
      ("advanced_capabilities" -> 'controls') || '{
        "guidance":{"field":"cfgScale","type":"number","minimum":1,"maximum":8},
        "steps":{"field":"steps","type":"integer","minimum":1,"maximum":40},
        "negativePrompt":{"field":"negativePrompt","type":"string"}
      }'::jsonb
    )
    || jsonb_build_object(
      'knownInputFields',
      ("advanced_capabilities" -> 'knownInputFields') || '["cfgScale","steps","negativePrompt"]'::jsonb
    )
    || jsonb_build_object(
      'providerInputs',
      ("advanced_capabilities" -> 'providerInputs') || '[
        {"field":"cfgScale","type":"number","required":false,"default":1,"minimum":1,"maximum":8,"description":"Classifier-free guidance. 1 is the distilled default and runs a single pass; above 1 doubles provider cost and is required for negativePrompt to have any effect.","reserved":true},
        {"field":"steps","type":"integer","required":false,"default":4,"minimum":1,"maximum":40,"description":"Denoising steps. 4 is the distilled default; 8 measurably improves multi-subject anatomy.","reserved":true},
        {"field":"negativePrompt","type":"string","required":false,"description":"Civitai Flux2 Klein negative prompt. camelCase only — the endpoint silently discards negative_prompt. Inert at cfgScale 1.","reserved":true}
      ]'::jsonb
    ),
  "updated_at" = now()
WHERE "id" = 'imgmdlcivklein4baaaaaaa'
  AND "slug" = 'civitai/flux-2-klein-4b'
  AND NOT ("advanced_capabilities" -> 'controls' ? 'guidance')
  AND NOT ("advanced_capabilities" -> 'controls' ? 'steps')
  AND NOT ("advanced_capabilities" -> 'controls' ? 'negativePrompt');
