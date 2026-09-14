-- Move Qwen Image Edit 2511's reviewed speed ruling from the raw provider
-- override to the normalized control the vocabulary has for it (issue #244).
--
-- Data-only and hand-written, like 0110 and 0122: there is no schema
-- transition, so this is journaled without a snapshot. `pnpm db:migrate` is
-- what the Fly deploy runs.
--
-- WHY. 0110 wrote `provider_overrides.go_fast = false` because no normalized
-- control named the field at the time. The `fastMode` control now binds to
-- `go_fast` on 2511's probed version, and a profile's raw overrides merge LAST,
-- over the mapped controls, so the raw spelling outranks a caller's own
-- `fastMode` request for the same setting with nothing dropped and nothing
-- refused. `packages/image-core/src/models/reviewed-profile-controls.ts` now
-- states the ruling as `controlDefaults.fastMode = false`; this statement brings
-- the seeded rows to the same spelling so the row and the table say one thing.
--
-- WHAT CHANGES IN THE PAYLOAD: nothing. `fastMode: false` maps through the
-- probed binding to `go_fast: false`, the value the override sent.
--
-- GUARDED AND IDEMPOTENT: only a row whose override is exactly the reviewed
-- `false` moves, and only when its control defaults do not already name
-- `fastMode`. An admin's deliberate `go_fast: true` override is left alone; a
-- second run matches nothing.
UPDATE "image_model_profiles" p
SET "control_defaults" = p."control_defaults" || '{"fastMode":false}'::jsonb,
    "provider_overrides" = p."provider_overrides" - 'go_fast'
FROM "image_models" m
WHERE p."image_model_id" = m."id"
  AND split_part(m."slug", ':', 1) = 'qwen/qwen-image-edit-2511'
  AND p."provider_overrides" -> 'go_fast' = 'false'::jsonb
  AND NOT (p."control_defaults" ? 'fastMode');
