-- The 2509 plus-LoRA wrapper is retired: no adapter, dialect or prompt-pack
-- binding names `qwen/qwen-image-edit-plus-lora` any more, so a render that
-- resolved it would answer `unbound` rather than compile. Drop it from the
-- built-in anatomy LoRA's compatibility list, leaving the endpoint the row is
-- named and trained for. The exact old-value guard preserves the repository
-- rule that seeded rows are ordinary admin-owned rows: a deployment whose
-- operator already changed compatibility is left alone.
UPDATE "image_loras"
SET "compatible_model_slugs" = '["qwen/qwen-image-edit-2511"]'::jsonb
WHERE "id" = 'imglorqwennsfwallinclv20'
  AND "compatible_model_slugs" = '["qwen/qwen-image-edit-plus-lora","qwen/qwen-image-edit-2511"]'::jsonb;
