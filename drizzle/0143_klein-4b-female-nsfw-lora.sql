-- Seed a female-focused NSFW/anatomy LoRA for the FLUX.2 klein 4B LoRA
-- endpoint so it can be exercised explicitly in the admin Image Generator.
--
-- Source: Civitai model 2331032, version 2633618, published as
-- "NippleDiffusion - Flux2.Klein - General [4B] v2". The archived model card
-- identifies it as a LoRA for Flux.2 Klein 4B with no trigger words. The
-- mirrored safetensors is 92,440,448 bytes with sha256
-- 3a178706776a6c7964f2d47820e55b9d09a065285050cb33d8cee2ecad18075f.
-- The publisher declares the licence as "other"; this migration records the
-- catalogue version for bench testing and makes no production/licensing claim.
--
-- Store the bare Civitai MODEL-VERSION id, not a credential-bearing URL.
-- `resolveImageLoraArtifactLocator` turns it into Civitai's download URL and
-- `lora-credentials.ts` appends CIVITAI_API_TOKEN only at provider-send time.
-- This keeps the token out of the database, run records and diagnostics.
--
-- Compatibility is intentionally narrow. This row is for the registered
-- `black-forest-labs/flux-2-klein-4b-base-lora` endpoint and the exact probed
-- version whose array-shaped `lora_weights`/`lora_scales` contract Vesper knows.
-- A provider version change therefore requires explicit re-curation rather than
-- silently assuming these third-party weights still load correctly.
--
-- The publisher gives no recommended LoRA strength. 1.0 is therefore a PILOT
-- default, not a measured optimum, and 0.5-1.5 is deliberately a test band for
-- comparing weaker and stronger blends. Scale is refused rather than clamped.
--
-- `allowed_tasks = []` means Generator-only. The admin Generator does not apply
-- production task curation, while scene/Image Lab lanes fail closed. Once owner
-- grading establishes useful prompts/strengths, a later curation change may
-- widen the row deliberately.
INSERT INTO "image_loras" (
  "id", "label", "locator_type", "locator", "compatible_model_slugs", "compatible_version_ids",
  "default_scale", "minimum_scale", "maximum_scale", "trigger_words", "prompt_prefix",
  "prompt_suffix", "allowed_tasks", "enabled", "builtin"
) VALUES (
  'imglorklein4bnsfwfemale',
  'NippleDiffusion General [4B] v2 (female NSFW test)',
  'civitai_model_version',
  '2633618',
  '["black-forest-labs/flux-2-klein-4b-base-lora"]'::jsonb,
  '["c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc"]'::jsonb,
  1.0, 0.5, 1.5,
  '[]'::jsonb, NULL,
  NULL,
  '[]'::jsonb, true, true
)
ON CONFLICT ("id") DO NOTHING;
