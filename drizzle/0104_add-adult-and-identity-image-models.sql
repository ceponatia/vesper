-- Register four more Replicate image models and their task profiles (owner
-- request 2026-08-11): three adult text-to-image checkpoints and one
-- identity-adapter model for scenes.
--
-- Data-only and hand-written, like 0095: drizzle-kit has no schema change to
-- diff here. It follows 0098's model seed and 0100's profile seed for the same
-- reason those were hand-appended — `pnpm db:migrate` is what the Fly deploy
-- runs, and `pnpm db:seed` never touches image models — so a fresh database must
-- come up with these rows already present.
--
-- ON CONFLICT DO NOTHING keeps both inserts idempotent AND keeps them from
-- resurrecting a row the owner deliberately deleted (owner ruling 4: seeded rows
-- are ordinary rows).
--
-- Every mechanical value below was probed from Replicate on 2026-08-11 through
-- the same endpoint `probeReplicateModel` reads, and is documented per model in
-- docs/image-models/.
--
-- THE REFERENCE-CAPABILITY SPLIT, which is what decides the surface toggles:
-- only `nsfw-api/sdxl-pulid` declares a reference-image input at all. The other
-- three publish no URI-typed input whatsoever, so they are text-to-image only
-- and can be offered on the new-portrait surface and nowhere else — the variant
-- and scene surfaces both require `can_edit` (`imageModelOffersSurface`), and a
-- scene render without the avatar reference defeats the point of a scene image
-- (owner ruling 2026-07-29).
--
-- THREE OF THE FOUR ARE COMMUNITY MODELS, so their slugs carry a version pin:
-- the bare-slug endpoint is official-models-only and 404s for everything else,
-- which is the same auto-pinning the admin add path applies. `prunaai/p-image`
-- is official and keeps its bare slug, tracking Replicate's latest version.
--
-- `extra_input` carries only keys each schema actually declares — Replicate
-- rejects unknown inputs — so only p-image gets `disable_safety_checker`, whose
-- VALUE the render path overrides from REPLICATE_SAFE_MODE. The shape and
-- negative-prompt corrections the three width/height models need are NOT here:
-- they live in `REVIEWED_QUALITY_INPUTS` (src/server/images/quality-presets.ts)
-- beside the identical corrections for Juggernaut and RealVis, which is the one
-- place reviewed runtime overrides are written.
--
-- Reviewed ratings are deliberately conservative. `edit_kind = 'none'` on the
-- three generators is a statement of fact (no reference input exists).
-- sdxl-pulid carries `unknown` for BOTH ratings: the `edit_kind` vocabulary has
-- no term for an identity adapter, and no trial has measured whether its faces
-- survive. `unknown` is the permissive default, so it passes the
-- identity-critical gate and can be graded later.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "for_portrait", "for_variant", "for_scene", "builtin", "sort"
) VALUES
  (
    'imgmdlnsfwfluxdevaaaaaaa',
    'aisha-ai-official/nsfw-flux-dev:fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa',
    'NSFW FLUX Dev',
    true, false, 'image', 'array', 'file', 0, 'aspect_ratio',
    -- No `aspect_ratio` and no `size` input: shape is free width/height integers,
    -- sent from the reviewed quality policy.
    '[]'::jsonb, NULL,
    '{}'::jsonb,
    'fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa',
    'none', 'unknown',
    'Community FLUX fine-tune, untried in Vesper. Text-to-image only — it publishes no reference input, so it cannot hold a character''s face across renders.',
    true, false, false, true, 70
  ),
  (
    'imgmdllikerealityponyaaa',
    'aisha-ai-official/likereality-pony-v1:f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2',
    'LikeReality Pony v1',
    true, false, 'image', 'array', 'file', 0, 'aspect_ratio',
    '[]'::jsonb, NULL,
    '{}'::jsonb,
    'f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2',
    'none', 'unknown',
    'Community Pony/SDXL fine-tune, untried in Vesper. Text-to-image only — no reference input. Its provider default negative prompt is "nsfw, naked"; the reviewed quality policy clears it.',
    true, false, false, true, 80
  ),
  (
    'imgmdlsdxlpulidaaaaaaaaa',
    'nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5',
    'SDXL PuLID',
    -- `can_generate` is true because only `prompt` is required, but the
    -- new-portrait surface is deliberately left off: bare-prompt this is an
    -- ordinary SDXL generator, and its purpose here is identity-guided work.
    true, true, 'reference_image', 'single', 'file', 1, 'aspect_ratio',
    '[]'::jsonb, NULL,
    '{}'::jsonb,
    '83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5',
    'unknown', 'unknown',
    'PuLID identity adapter with 283 lifetime Replicate runs and no Vesper trial — likeness is unmeasured. Single reference only, so scene renders never reach the multi-reference rung. Its depth_image ControlNet input is never sent.',
    false, true, true, true, 90
  ),
  (
    'imgmdlprunapimageaaaaaaa',
    -- Official, so no version pin: this row tracks Replicate's latest version.
    'prunaai/p-image',
    'Pruna P-Image',
    true, false, 'image', 'array', 'file', 0, 'aspect_ratio',
    '["1:1","16:9","9:16","4:3","3:4","3:2","2:3"]'::jsonb, NULL,
    -- The one model here that declares a safety toggle, and the only one with a
    -- native 3:4 aspect — no crop needed.
    '{"disable_safety_checker":true}'::jsonb,
    '79bbabc34e1dc2c55b09a5a8a220d7792f77234c5aded9b074bdf6bf783a2f65',
    'none', 'unknown',
    'Sub-second generation, the speed and cost baseline. No LoRA is configured on this row; its lora_weights input is unused.',
    true, false, false, true, 95
  )
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- One profile per surface each model is offered on, so a picked model resolves
-- its own profile instead of silently falling through to the task default
-- (`image_profile.pick_unavailable`). None is `is_default` — the Qwen pair keeps
-- every global default — and all carry empty control defaults and no timeout
-- override, matching the seeded 17.
--
-- The two sdxl-pulid profiles carry `instruction_edit` like every other seeded
-- edit profile: the lane still chooses its reference mode at render time, and
-- the production strategies add nothing to the lane's own prompt text.
--
-- SELECT ... WHERE EXISTS rather than a bare VALUES insert, so a profile is only
-- written when its model row is actually present — the model insert above skips
-- rows the owner previously deleted, and a profile pointing at a missing model
-- would violate the foreign key and fail the whole migration.
INSERT INTO "image_model_profiles" (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT v.* FROM (VALUES
  ('imgprfnsfwfluxportraitaa', 'imgmdlnsfwfluxdevaaaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 70),
  ('imgprfponyv1portraitaaaa', 'imgmdllikerealityponyaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 80),
  ('imgprfpulidvariantaaaaaa', 'imgmdlsdxlpulidaaaaaaaaa', 'variant-standard', 'Variant Standard',
   'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 90),
  ('imgprfpulidsceneaaaaaaaa', 'imgmdlsdxlpulidaaaaaaaaa', 'scene-standard', 'Scene Standard',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 91),
  ('imgprfpimageportraitaaaa', 'imgmdlprunapimageaaaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 95)
) AS v(
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
WHERE EXISTS (SELECT 1 FROM "image_models" m WHERE m."id" = v."image_model_id")
ON CONFLICT DO NOTHING;
