-- Seed the reviewed quality settings onto task profiles — image-render-quality
-- slice 2, migration step 1 (image-render-quality.spec.md §"Migration off the
-- transitional policy").
--
-- Data-only and hand-written, like 0104 and 0107: drizzle-kit has no schema
-- change to diff here. `pnpm db:migrate` is what the Fly deploy runs and
-- `pnpm db:seed` never touches image models, so a fresh database must come up
-- with these controls already on the rows.
--
-- WHAT THIS CHANGES TODAY: NOTHING IN ANY PAYLOAD.
--
-- Every seeded `image_models` row still carries `advanced_capabilities = '{}'`,
-- so a normalized control has no probed binding to map through
-- (`no_binding`) and a provider override fails closed against an empty
-- `known_input_fields` (`unknown_field`). Both drops are recorded, both are
-- asserted in `apps/web/src/server/images/reviewed-profile-parity.test.ts`, and
-- meanwhile the transitional exact-slug overlay
-- (`packages/image-core/src/models/quality-presets.ts`) still delivers these same
-- settings through `extra_input` exactly as it does now. This is the same
-- deliberate two-speed rollout 0107 used: the row states the curated intent now,
-- the probe activates it.
--
-- WHY IT IS WORTH WRITING BEFORE THE PROBE. The reviewed policy is currently a
-- MODEL-wide constant, which the spec calls out as wrong the moment one model
-- serves two jobs: Qwen Edit's `go_fast: false` is a judgment about
-- identity-critical work, and a future text-repair profile on the same model must
-- be able to choose speed independently. Written per profile, that divergence is
-- a data edit. Written in the overlay, it is impossible.
--
-- MERGE DIRECTION IS `reviewed || existing`, so an operator's own value WINS on a
-- key collision. That is not politeness, it is parity: a profile's mapped control
-- already outranks the model row's `extra_input` in the payload
-- (`overlayControlInput` merges last), so an operator who set `steps` on a
-- profile is already beating the overlay today. It also makes the statement
-- idempotent — a second run finds its own keys present and changes nothing.
--
-- SLUG MATCHING uses `split_part(slug, ':', 1)`, mirroring `baseImageModelSlug`:
-- three of these six models are community checkpoints whose rows carry a
-- `:version` pin.
--
-- EVERY SLUG BELOW HAS A SEEDED ROW, so this statement is complete rather than
-- partly aspirational. Owner ruling (2026-08-16) scoped the reviewed set to the
-- Qwen family plus the 2026-08-10/11 additions and dropped Juggernaut XL v9,
-- RealVis Hyper LoRA and Pony Realism v2.3 — the three unseeded community
-- checkpoints an admin adds by hand. They keep their catalog pages in
-- docs/image-models/ and now run on their wrappers' own defaults.
UPDATE "image_model_profiles" p
SET "control_defaults" = v."controls" || p."control_defaults",
    "provider_overrides" = v."overrides" || p."provider_overrides"
FROM (VALUES
  -- Qwen Image Edit 2511 — all uses are identity-critical today, so quality mode
  -- rather than the wrapper's speed preset. `go_fast` has no normalized control,
  -- so it travels as the raw field, the same shape 0107 used for Qwen 2512.
  ('qwen/qwen-image-edit-2511',
   '{}'::jsonb,
   '{"go_fast":false}'::jsonb),
  -- NSFW FLUX Dev — its own default is a 1024x1024 square, so every render would
  -- lose a quarter of the frame to the 3:4 crop.
  ('aisha-ai-official/nsfw-flux-dev',
   '{"resolution":"custom","width":832,"height":1216}'::jsonb,
   '{}'::jsonb),
  -- LikeReality Pony v1 — the consequential clearing: this wrapper's default
  -- negative is literally "nsfw, naked", which suppresses the output an adult
  -- content app exists to render and silently contradicts the authored wardrobe
  -- and exposure state. `prepend_preprompt` stays at its default.
  ('aisha-ai-official/likereality-pony-v1',
   '{"negativePrompt":"","resolution":"custom","width":832,"height":1216}'::jsonb,
   '{}'::jsonb),
  -- SDXL PuLID — 512x512 is both off-shape and far below the canonical portrait.
  -- `method` is pinned because Vesper runs this model for identity preservation
  -- and never for style transfer.
  ('nsfw-api/sdxl-pulid',
   '{"resolution":"custom","width":832,"height":1216}'::jsonb,
   '{"method":"fidelity"}'::jsonb)
) AS v("base_slug", "controls", "overrides")
-- The `resolution: "custom"` beside every pinned pair is not decoration: the
-- compile step only lets `width`/`height` reach the control mapper when the tier
-- says `custom`, so a size pinned without it would be recorded as
-- `requires_custom_resolution` and never sent.
JOIN "image_models" m ON split_part(m."slug", ':', 1) = v."base_slug"
WHERE p."image_model_id" = m."id";
