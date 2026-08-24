-- Make the built-in Qwen Image Edit 2511 row expose the runtime LoRA controls
-- its Replicate schema actually declares, so capability-driven surfaces such as
-- /settings/image-generator offer the curated LoRA picker on 2511 itself.
--
-- WHY A DATA MIGRATION. The probe already derives `lora_weights` and
-- `lora_scale`, but the long-lived built-in 2511 row was probed before that
-- derivation shipped and therefore carries a stale `advanced_capabilities`
-- snapshot. The Generator is deliberately driven by that snapshot rather than
-- by slug-specific UI exceptions, so leaving the row stale hides a provider
-- capability the selected version can use.
--
-- Verified 2026-08-24 against Replicate's published 2511 schema:
--   lora_weights: string, blank = no custom LoRA
--   lora_scale: number, minimum 0, maximum 4, default 1
-- The existing probe path derives the same two normalized bindings on a future
-- re-probe; this patch only brings already-deployed built-in rows up to that
-- state without forcing an unrelated provider-version promotion.
--
-- Preserve every other probed fact and every existing normalized control. The
-- known-input allowlist is widened too, so captured/replayed capability records
-- do not describe the LoRA fields as unknown provider keys.
UPDATE "image_models"
SET
  "advanced_capabilities" =
    COALESCE("advanced_capabilities", '{}'::jsonb)
    || jsonb_build_object(
      'controls',
      COALESCE("advanced_capabilities"->'controls', '{}'::jsonb)
      || '{
        "loraWeights": {"field":"lora_weights","type":"string"},
        "loraScale": {"field":"lora_scale","type":"number","minimum":0,"maximum":4}
      }'::jsonb
    )
    || jsonb_build_object(
      'knownInputFields',
      (
        SELECT jsonb_agg(field ORDER BY field)
        FROM (
          SELECT DISTINCT value AS field
          FROM jsonb_array_elements_text(
            COALESCE("image_models"."advanced_capabilities"->'knownInputFields', '[]'::jsonb)
          ) AS existing(value)
          UNION
          SELECT 'lora_weights'
          UNION
          SELECT 'lora_scale'
        ) AS fields
      )
    ),
  "updated_at" = now()
WHERE "slug" = 'qwen/qwen-image-edit-2511'
  AND (
    "advanced_capabilities"->'controls'->'loraWeights' IS NULL
    OR "advanced_capabilities"->'controls'->'loraScale' IS NULL
  );
--> statement-breakpoint
-- The built-in anatomy LoRA is named/trained for Qwen Image Edit 2511 but was
-- originally restricted to the 2509 plus-LoRA wrapper because that was the only
-- runtime-LoRA path Vesper believed Replicate exposed. Keep that wrapper valid,
-- and add 2511 now that its runtime bindings are verified. The exact old-value
-- guard preserves the repository rule that seeded rows are ordinary admin-owned
-- rows: a deployment whose operator already changed compatibility is left alone.
UPDATE "image_loras"
SET "compatible_model_slugs" = '["qwen/qwen-image-edit-plus-lora","qwen/qwen-image-edit-2511"]'::jsonb
WHERE "id" = 'imglorqwennsfwallinclv20'
  AND "compatible_model_slugs" = '["qwen/qwen-image-edit-plus-lora"]'::jsonb;
