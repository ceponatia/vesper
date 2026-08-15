-- Seed the curated LoRA the intimate-scene route asks for
-- (intimate-scene-lora.spec.md §Persistence): "Qwen Image Edit 2511 NSFW all
-- inclusive" v2.0 — Civitai model 2700552, version 3160956.
--
-- Data-only and hand-written, like 0104 and 0107: drizzle-kit has no schema
-- change to diff here. It is a migration rather than a seed script because
-- `pnpm db:migrate` is what the Fly deploy runs and `pnpm db:seed` never touches
-- the image registries, so a fresh database must come up with this row present.
--
-- ON CONFLICT DO NOTHING keeps the insert idempotent AND keeps it from
-- resurrecting a row the owner deliberately deleted (owner ruling 4: seeded rows
-- are ordinary rows — an admin may retune this one's band, switch it off, or
-- remove it, and the render path degrades to the stock scene model when it does).
--
-- WHY THIS ROW EXISTS. ~45 owner-graded probe renders settled that the staged
-- prompts are right and the stock scene model is the ceiling: `qwen-image-edit-2511`
-- obeys every compositional instruction and cannot draw explicit anatomy. This
-- LoRA, on the LoRA-capable Qwen edit wrapper, rendered every acceptance act on
-- the same prompts (finished/scene-composition.spec.md §Probe results).
--
-- THE LOCATOR IS THE PUBLIC DOWNLOAD ADDRESS AND CARRIES NO CREDENTIAL. Civitai
-- gates adult downloads behind an account, so the render path appends the
-- deployment's `CIVITAI_API_TOKEN` as a `token` query parameter at the moment the
-- binding maps to provider input (`lora-credentials.ts`, the one reader). The
-- token therefore never lands in this table, in an image row, or in a log line —
-- and without it every intimate render simply degrades to today's behavior.
--
-- `compatible_model_slugs` names the wrapper's BASE slug: compatibility is judged
-- base-slug to base-slug, so the registered row's version pin may change without
-- this row chasing it. `compatible_version_ids` stays EMPTY on purpose — that
-- list means "this LoRA does not survive a version change", which the probe gave
-- no reason to claim, and a non-empty list would refuse any render that cannot
-- state its version. `allowed_tasks` is `scene` alone: fail-closed, matching the
-- contract's reading of an empty list, and the admin lab adopts it (slice 2) by
-- widening this field rather than by a second row.
--
-- The band is 0.5–1.5 around the probed default of 1. Scale is refused, never
-- clamped, so the band is a statement about which strengths are known-good rather
-- than a slider's convenience range.
INSERT INTO "image_loras" (
  "id", "label", "locator_type", "locator", "compatible_model_slugs", "compatible_version_ids",
  "default_scale", "minimum_scale", "maximum_scale", "trigger_words", "prompt_prefix",
  "prompt_suffix", "allowed_tasks", "enabled", "builtin"
) VALUES (
  'imglorqwennsfwallinclv20',
  'Qwen Image Edit 2511 NSFW all inclusive v2.0',
  'https_url',
  'https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor',
  '["qwen/qwen-image-edit-plus-lora"]'::jsonb,
  '[]'::jsonb,
  1, 0.5, 1.5,
  -- No trigger words and no prompt additions: the probe's `lora` arm rendered the
  -- pipeline's own staged prompt UNCHANGED, which is the only reason its results
  -- are evidence about the weights. A prefix or a trigger here would make every
  -- production prompt differ from the one that was graded.
  '[]'::jsonb, NULL,
  NULL,
  '["scene"]'::jsonb, true, true
)
ON CONFLICT ("id") DO NOTHING;
