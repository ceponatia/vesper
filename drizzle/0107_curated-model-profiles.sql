-- Seed the seven curated model-specific profiles — capabilities slice 7
-- (image-model-capabilities.spec.md §"Model-specific seeded profiles", with the
-- owner's descopes applied; see the profile-by-profile notes below).
--
-- Data-only and hand-written, like 0104: drizzle-kit has no schema change to
-- diff here. `pnpm db:migrate` is what the Fly deploy runs and `pnpm db:seed`
-- never touches image models, so a fresh database must come up with these rows
-- already present.
--
-- ON CONFLICT DO NOTHING keeps the insert idempotent AND keeps it from
-- resurrecting a row the owner deliberately deleted (owner ruling 4: seeded rows
-- are ordinary rows). SELECT ... WHERE EXISTS for the same reason as 0100/0104:
-- a profile pointing at an owner-deleted model would violate the FK and take the
-- whole deploy down with it; guarded, a deleted model simply gets no profiles.
--
-- NOTHING RESOLVES DIFFERENTLY AT SEED TIME. Every row is `enabled` but not
-- `is_default`, and every `sort` is above every existing profile (the 0100/0104
-- rows end at 95; these start at 110), so:
--
--   - every task keeps resolving to its current "… Standard" default, and
--   - a stored legacy MODEL pick still lands on that model's lowest-sort profile
--     — its existing Standard row — never on one of these.
--
-- A curated row only runs when a player or admin picks it (the slice-D pickers),
-- or when an admin re-defaults a task to it.
--
-- CONTROL TIMING is deliberate and two-speed. `control_defaults` keys that map
-- through the version's probed bindings — `steps`, `guidance`, `negativePrompt`,
-- and `resolution` on the aspect-ratio Seedreams (their `size` tier is an
-- ordinary control binding) — drop as recorded `no_binding` until an admin
-- re-probes or pins a version, because every model row still carries
-- `advanced_capabilities = '{}'`. `resolution` on the SIZE-mode model (Wan)
-- takes effect immediately through `chooseDimensions`, no probe involved.
-- `provider_overrides` are refused (`unknown_field`, fail-closed) until
-- `knownInputFields` is probed. All of that is the designed rollout: the row
-- states the curated intent now; the probe activates it.
--
-- Values come from the per-model probes in docs/image-models/, not invention:
-- Qwen 2512's `num_inference_steps` is 20–50 (default 40) and `go_fast` is a raw
-- boolean field; SD 3.5's `cfg` is 1–10 (default 5); Seedream 4.5's `size` tiers
-- are 2K/4K/custom and 5 Lite's are 2K/3K; Wan's 3:4 pairs are 768*1024 and
-- 1536*2048.
--
-- WHAT IS DELIBERATELY NOT HERE (owner descopes, so the absence is a decision,
-- not an oversight):
--   - No LoRA "House Style" profile — parked in deferred.plan.md; the ordinary
--     lane model takes no LoRA.
--   - No Coherent-Set / image-set profiles — image sets are descoped.
--   - No Text Repair / Example Transformation profiles — those prompt strategies
--     refuse to compile (`compilePromptForStrategy`) and no lane supplies their
--     reference pairs; a profile whose render always refuses is a broken picker
--     entry.
--   - No Remix profiles (Qwen 2512 / SD 3.5) — the portrait lane sends no source
--     reference, so an edit-operation portrait profile is unreachable.
--   - No `multi_reference_compose` on scene profiles — the scene lane's own
--     prompt builder numbers its references, and the slice-1 ruling keeps scene
--     profiles on `instruction_edit`; curated scene rows differ by reference
--     policy and resolution instead.
--   - No "Portrait Balanced" (Qwen 2512) and no "Stylized Portrait Balanced"
--     (SD 3.5) — both would duplicate the models' existing Standard rows
--     byte for byte.
--   - No Wan generate profiles. "Generate 2K Thinking" would duplicate Wan's
--     Portrait Standard (`thinking_mode` already defaults true and the 2K 3:4
--     pair is already what `chooseAspect` sends), and "Generate 4K Thinking"
--     cannot deliver: the 4096 pairs are deliberately absent from the row's
--     `supported_aspects` (0098 — they break every edit), so a 4K tier would
--     quietly render 1536*2048 while the label promises 4K.
INSERT INTO "image_model_profiles" (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT v.* FROM (VALUES
  -- Qwen Image 2512. Fast trades steps for latency (provider default 40, floor
  -- 20; `go_fast` is already true in the row's `extra_input`, so no override is
  -- needed and normalized controls are preferred). Quality turns `go_fast` off —
  -- reachable only as the raw field, hence the one provider override in this
  -- seed — and runs the step ceiling.
  ('imgprf2512portfastaaaaaa', 'imgmdlqwen2512aaaaaaaaaa', 'portrait-fast', 'Portrait Fast',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{"steps":28}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 110),
  ('imgprf2512portqualityaaa', 'imgmdlqwen2512aaaaaaaaaa', 'portrait-quality', 'Portrait Quality',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{"steps":50}'::jsonb, '{"go_fast":false}'::jsonb, NULL::integer, true, false, true, 111),
  -- Seedream 4.5. The ensemble row is the multi-character scene pick: same
  -- `instruction_edit` and role order as Standard, but `maxPerRole` states the
  -- ensemble shape — up to four identities and two objects, one location, one
  -- style (Standard carries no caps at all; these are curation, and the 14-slot
  -- reference capacity still truncates). Location 4K is the slow, opt-in
  -- establishing-shot generator for the location anchor task; it stays
  -- non-default so the anchor lane keeps resolving Qwen 2512 until an admin
  -- deliberately re-defaults.
  ('imgprfs45ensemble2kaaaaa', 'imgmdlseedream45aaaaaaaa', 'ensemble-scene-2k', 'Ensemble Scene 2K',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"],"maxPerRole":{"identity":4,"location":1,"style":1,"object":2}}'::jsonb,
   '{"resolution":"2K"}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 130),
  ('imgprfs45location4kaaaaa', 'imgmdlseedream45aaaaaaaa', 'location-4k', 'Location 4K',
   'location', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{"resolution":"4K"}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 131),
  -- Seedream 5 Lite — the identity-strong, slow quality pick at its top tier
  -- (its `size` enum is 2K/3K; there is no 4K).
  ('imgprfs5lscene3kaaaaaaaa', 'imgmdlseedream5liteaaaaa', 'quality-scene-3k', 'Quality Scene 3K',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{"resolution":"3K"}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 140),
  -- Stable Diffusion 3.5 Large — the deliberate stylization pick: high `cfg`
  -- (provider range 1–10, default 5) plus a curated artifact-cleanup negative.
  -- The Standard row stays byte-identical for everyone who does not choose this;
  -- the negative is an opt-in curation, which is exactly the conflict-checked
  -- profile the model doc's negative-prompt ruling defers to.
  ('imgprfsd35highguidanceaa', 'imgmdlsd35largeaaaaaaaaa', 'stylized-portrait-high-guidance', 'Stylized Portrait High Guidance',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{"guidance":8,"negativePrompt":"blurry, out of focus, low detail, jpeg artifacts, watermark, signature, deformed hands, extra fingers"}'::jsonb,
   '{}'::jsonb, NULL::integer, true, false, true, 150),
  -- Wan 2.7 Image Pro — the explicit multi-reference edit row. `instruction_edit`
  -- per the slice-1 scene ruling; the 2K tier resolves through the SIZE branch of
  -- `chooseDimensions` to the 1536*2048 pair the model doc records. The
  -- moderation caveat lives on the model row's `operator_warning`, not here, and
  -- no profile claims to bypass moderation.
  ('imgprfwan27multiedit2kaa', 'imgmdlwan27imageproaaaaa', 'multi-reference-edit-2k', 'Multi-Reference Edit 2K',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{"resolution":"2K"}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 160)
) AS v(
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
WHERE EXISTS (SELECT 1 FROM "image_models" m WHERE m."id" = v."image_model_id")
ON CONFLICT DO NOTHING;
