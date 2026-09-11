-- Move Qwen Image 3 from Replicate's unified regular/Pro rows to fal's actual
-- operation endpoints while leaving Qwen Image 2 and the older Qwen models on
-- Replicate.
--
-- fal publishes Qwen Image 3 as two live routes:
--   alibaba/qwen-image-3/text-to-image  -- prompt-only generation
--   alibaba/qwen-image-3/edit           -- instruction editing with 1-3 images
--
-- Owner ruling 2026-09-11:
-- - portrait creation defaults to the text-to-image route;
-- - portrait variants/reference views and scenes default to the edit route;
-- - edit/reference-view/scene production defaults to the 1K tier while testing;
-- - both routes expose 1K/2K to the Admin Image Generator;
-- - Vesper sends enable_safety_checker=false and enable_prompt_expansion=false;
-- - fal does not expose immutable weights/version hashes, so probed_version_id
--   stores a Vesper schema-capture marker, not a provider weights pin.
--
-- fal's `image_size` is a union of named presets or {width,height}. Vesper keeps
-- aspect and quality tier separate in its normalized controls: the ordinary
-- aspect resolver supplies 1:1/3:4/etc while the `resolutionTier` binding carries
-- 1K/2K. The fal transport combines those two facts into custom width/height.

-- ---------------------------------------------------------------------------
-- Repurpose the two 0134 Qwen 3 rows into the two real fal endpoint rows.
-- ---------------------------------------------------------------------------

UPDATE "image_models"
SET
  "slug" = 'alibaba/qwen-image-3/text-to-image',
  "label" = 'Qwen Image 3 — Text to Image',
  "can_generate" = true,
  "can_edit" = false,
  "reference_field" = 'image_urls',
  "reference_arity" = 'array',
  "reference_transport" = 'data_url',
  "max_references" = 0,
  "aspect_mode" = 'aspect_ratio',
  "supported_aspects" = '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  "output_format" = 'png',
  "extra_input" = '{"enable_safety_checker":false,"enable_prompt_expansion":false,"num_images":1,"output_format":"png"}'::jsonb,
  "probed_version_id" = 'fal-qwen3-text-schema-2026-09-11',
  "edit_kind" = 'none',
  "identity_preservation" = 'unknown',
  "operator_warning" = 'fal does not expose an immutable model-version hash; the recorded version is Vesper''s captured 2026-09-11 endpoint schema revision.',
  "advanced_capabilities" = '{
    "prompt":{"field":"prompt","maxChars":5000},
    "controls":{
      "seed":{"field":"seed","type":"integer","minimum":0,"maximum":2147483647},
      "negativePrompt":{"field":"negative_prompt","type":"string"},
      "resolutionTier":{"field":"image_size","type":"enum","enumValues":["1K","2K"]}
    },
    "additionalImageInputs":[],
    "output":{"arity":"array","supportsMultiple":true},
    "knownInputFields":["prompt","negative_prompt","image_size","enable_prompt_expansion","seed","enable_safety_checker","sync_mode","num_images","output_format"],
    "providerInputs":[
      {"field":"prompt","type":"string","required":true,"description":"Prompt for Qwen Image 3 generation","reserved":true},
      {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Elements to avoid","reserved":true},
      {"field":"image_size","type":"unknown","required":false,"description":"fal ImageSize; Vesper combines its 1K/2K tier with the selected aspect into width/height","reserved":true},
      {"field":"enable_prompt_expansion","type":"boolean","required":false,"default":true,"description":"fal prompt expansion; Vesper fixes this off","reserved":true},
      {"field":"seed","type":"integer","required":false,"minimum":0,"maximum":2147483647,"reserved":true},
      {"field":"enable_safety_checker","type":"boolean","required":false,"default":true,"description":"fal safety checker; Vesper requests false (account authorization may still be required by fal)","reserved":true},
      {"field":"sync_mode","type":"boolean","required":false,"default":false,"reserved":false},
      {"field":"num_images","type":"integer","required":false,"default":1,"minimum":1,"reserved":true},
      {"field":"output_format","type":"enum","required":false,"default":"png","enumValues":["jpeg","png","webp"],"reserved":true}
    ]
  }'::jsonb,
  "for_portrait" = true,
  "for_variant" = false,
  "for_scene" = false,
  "builtin" = true,
  "sort" = 1,
  "updated_at" = now()
WHERE "id" = 'imgmdlqwenimage3aaaaaaa'
  AND "slug" IN ('alibaba/qwen-image-3', 'alibaba/qwen-image-3/text-to-image');
--> statement-breakpoint

UPDATE "image_models"
SET
  "slug" = 'alibaba/qwen-image-3/edit',
  "label" = 'Qwen Image 3 — Edit',
  "can_generate" = false,
  "can_edit" = true,
  "reference_field" = 'image_urls',
  "reference_arity" = 'array',
  "reference_transport" = 'data_url',
  "max_references" = 3,
  "aspect_mode" = 'aspect_ratio',
  "supported_aspects" = '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  "output_format" = 'png',
  "extra_input" = '{"enable_safety_checker":false,"enable_prompt_expansion":false,"num_images":1,"output_format":"png"}'::jsonb,
  "probed_version_id" = 'fal-qwen3-edit-schema-2026-09-11',
  "edit_kind" = 'instruction_edit',
  "identity_preservation" = 'unknown',
  "operator_warning" = 'fal does not expose an immutable model-version hash; the recorded version is Vesper''s captured 2026-09-11 endpoint schema revision.',
  "advanced_capabilities" = '{
    "prompt":{"field":"prompt","maxChars":5000},
    "controls":{
      "seed":{"field":"seed","type":"integer","minimum":0,"maximum":2147483647},
      "negativePrompt":{"field":"negative_prompt","type":"string"},
      "resolutionTier":{"field":"image_size","type":"enum","enumValues":["1K","2K"]}
    },
    "additionalImageInputs":[],
    "output":{"arity":"array","supportsMultiple":true},
    "knownInputFields":["prompt","negative_prompt","image_size","enable_prompt_expansion","seed","enable_safety_checker","sync_mode","num_images","output_format","image_urls"],
    "providerInputs":[
      {"field":"prompt","type":"string","required":true,"description":"Edit instruction for Qwen Image 3","reserved":true},
      {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Elements to avoid","reserved":true},
      {"field":"image_size","type":"unknown","required":false,"description":"fal ImageSize; Vesper combines its 1K/2K tier with the selected aspect into width/height","reserved":true},
      {"field":"enable_prompt_expansion","type":"boolean","required":false,"default":true,"description":"fal prompt expansion; Vesper fixes this off","reserved":true},
      {"field":"seed","type":"integer","required":false,"minimum":0,"maximum":2147483647,"reserved":true},
      {"field":"enable_safety_checker","type":"boolean","required":false,"default":true,"description":"fal safety checker; Vesper requests false (account authorization may still be required by fal)","reserved":true},
      {"field":"sync_mode","type":"boolean","required":false,"default":false,"reserved":false},
      {"field":"num_images","type":"integer","required":false,"default":1,"minimum":1,"reserved":true},
      {"field":"output_format","type":"enum","required":false,"default":"png","enumValues":["jpeg","png","webp"],"reserved":true},
      {"field":"image_urls","type":"array","required":true,"description":"One to three ordered reference images","reserved":true}
    ]
  }'::jsonb,
  "for_portrait" = false,
  "for_variant" = true,
  "for_scene" = true,
  "builtin" = true,
  "sort" = 0,
  "updated_at" = now()
WHERE "id" = 'imgmdlqwenimage3proaaaa'
  AND "slug" IN ('alibaba/qwen-image-3-pro', 'alibaba/qwen-image-3/edit');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Collapse the former six unified-model profiles into the three operations that
-- fal actually exposes. The partial default index is protected by clearing the
-- affected defaults before promoting the surviving rows.
-- ---------------------------------------------------------------------------

UPDATE "image_model_profiles"
SET "is_default" = false, "updated_at" = now()
WHERE "task" IN ('portrait', 'variant', 'scene') AND "is_default" = true;
--> statement-breakpoint

-- Text endpoint: portrait generation only, at 1K by default.
UPDATE "image_model_profiles"
SET
  "label" = 'Qwen Image 3 Portrait (fal)',
  "task" = 'portrait',
  "operation" = 'generate',
  "prompt_strategy" = 'text_to_image_description',
  "reference_policy" = '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
  "control_defaults" = jsonb_set(COALESCE("control_defaults", '{}'::jsonb), '{resolution}', '"1K"'::jsonb, true),
  "provider_overrides" = '{}'::jsonb,
  "enabled" = true,
  "is_default" = true,
  "builtin" = true,
  "sort" = 1,
  "updated_at" = now()
WHERE "id" = 'imgprfqwen3portraitaaaaaa'
  AND "image_model_id" = 'imgmdlqwenimage3aaaaaaa';
--> statement-breakpoint

DELETE FROM "image_model_profiles"
WHERE "id" IN ('imgprfqwen3variantaaaaaaa', 'imgprfqwen3sceneaaaaaaaaa')
  AND "image_model_id" = 'imgmdlqwenimage3aaaaaaa';
--> statement-breakpoint

-- Edit endpoint: variant/reference-view and scene work, 1K by default.
DELETE FROM "image_model_profiles"
WHERE "id" = 'imgprfqwen3proportraitaaa'
  AND "image_model_id" = 'imgmdlqwenimage3proaaaa';
--> statement-breakpoint

UPDATE "image_model_profiles"
SET
  "label" = 'Qwen Image 3 Variant (fal)',
  "task" = 'variant',
  "operation" = 'edit',
  "prompt_strategy" = 'instruction_edit',
  "reference_policy" = '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
  "control_defaults" = jsonb_set(COALESCE("control_defaults", '{}'::jsonb), '{resolution}', '"1K"'::jsonb, true),
  "provider_overrides" = '{}'::jsonb,
  "enabled" = true,
  "is_default" = true,
  "builtin" = true,
  "sort" = 1,
  "updated_at" = now()
WHERE "id" = 'imgprfqwen3provariantaaaa'
  AND "image_model_id" = 'imgmdlqwenimage3proaaaa';
--> statement-breakpoint

UPDATE "image_model_profiles"
SET
  "label" = 'Qwen Image 3 Scene (fal)',
  "task" = 'scene',
  "operation" = 'edit',
  "prompt_strategy" = 'instruction_edit',
  "reference_policy" = '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
  "control_defaults" = jsonb_set(COALESCE("control_defaults", '{}'::jsonb), '{resolution}', '"1K"'::jsonb, true),
  "provider_overrides" = '{}'::jsonb,
  "enabled" = true,
  "is_default" = true,
  "builtin" = true,
  "sort" = 2,
  "updated_at" = now()
WHERE "id" = 'imgprfqwen3prosceneaaaaaa'
  AND "image_model_id" = 'imgmdlqwenimage3proaaaa';
