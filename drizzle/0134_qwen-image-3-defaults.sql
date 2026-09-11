-- Promote Replicate's Qwen Image 3 generation into Vesper's registry.
--
-- Owner ruling 2026-09-11: ship BOTH official Alibaba endpoints, put them first
-- in the admin Image Generator, and make Qwen Image 3 Pro the default for the
-- Character Studio (portrait + variant) and scene tasks. Qwen Image 3 remains
-- offered as the cheaper sibling. Item/location/chat-place defaults are left on
-- their current profiles.
--
-- Both endpoints expose the same compact Replicate contract at the versions
-- recorded below: prompt required; one optional `image` URI; nine aspect ratios;
-- seed, negative_prompt, match_input_image and enable_prompt_expansion; one URI
-- output. Their adapters are deliberately separate code definitions even while
-- this first capability snapshot matches.
--
-- REFERENCE TRANSPORT: `data_url`, intentionally. The immediately preceding
-- Qwen Image 2 trial exposed a provider-side "unsupported file type" failure on
-- Vesper's uploaded Replicate-file URL path while prompt-only generation worked.
-- Replicate's prediction API accepts data URIs for URI inputs, and these models
-- have only one reference slot, so inline transport is the conservative first
-- production path until a fixed comparison proves uploaded-file URLs safe here.
--
-- PROMPT EXPANSION: provider default is true, but production profiles force it
-- false. Vesper's prompt program is already the authored/compiled instruction;
-- silently rewriting that instruction upstream would make prompt provenance lie.
-- The raw Admin Image Generator still exposes the field for controlled tests.

-- ---------------------------------------------------------------------------
-- Model rows
-- ---------------------------------------------------------------------------

INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlqwenimage3aaaaaaa',
  'alibaba/qwen-image-3',
  'Qwen Image 3',
  true, true, 'image', 'single', 'data_url', 1, 'aspect_ratio',
  '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  NULL::text,
  '{}'::jsonb,
  '8235a8d30fc32fd33a4e0e91d9cffaae6f2250fc56ff8e5736ca4a9c5b9f9fbc',
  'unknown', 'unknown', NULL::text,
  '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "negativePrompt": {"field":"negative_prompt","type":"string"}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "aspect_ratio",
      "enable_prompt_expansion",
      "image",
      "match_input_image",
      "negative_prompt",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"],"description":"Aspect ratio of the generated image","reserved":true},
      {"field":"enable_prompt_expansion","type":"boolean","required":false,"default":true,"description":"Automatically expand and optimize the prompt for better results","reserved":false},
      {"field":"image","type":"uri","required":false,"description":"Optional reference image for image editing, style transfer, or image-to-image generation","reserved":true},
      {"field":"match_input_image","type":"boolean","required":false,"default":false,"description":"When true and an image is provided, use the input image''s aspect ratio and resolution instead of the aspect_ratio parameter","reserved":false},
      {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Negative prompt to specify elements to avoid","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text prompt for image generation or editing","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed for reproducible generation. Range: 0-2147483647","reserved":true}
    ]
  }'::jsonb,
  true, true, true, true, 1
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3'
)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlqwenimage3proaaaa',
  'alibaba/qwen-image-3-pro',
  'Qwen Image 3 Pro',
  true, true, 'image', 'single', 'data_url', 1, 'aspect_ratio',
  '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  NULL::text,
  '{}'::jsonb,
  '2d41e651d91e3ff97dfd0f3f85c22ccc45e084f7edf843f701e49895f8398213',
  'unknown', 'unknown', NULL::text,
  '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "negativePrompt": {"field":"negative_prompt","type":"string"}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "aspect_ratio",
      "enable_prompt_expansion",
      "image",
      "match_input_image",
      "negative_prompt",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"],"description":"Aspect ratio of the generated image","reserved":true},
      {"field":"enable_prompt_expansion","type":"boolean","required":false,"default":true,"description":"Automatically expand and optimize the prompt for better results","reserved":false},
      {"field":"image","type":"uri","required":false,"description":"Optional reference image for image editing, style transfer, or image-to-image generation","reserved":true},
      {"field":"match_input_image","type":"boolean","required":false,"default":false,"description":"When true and an image is provided, use the input image''s aspect ratio and resolution instead of the aspect_ratio parameter","reserved":false},
      {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Negative prompt to specify elements to avoid","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text prompt for image generation or editing","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed for reproducible generation. Range: 0-2147483647","reserved":true}
    ]
  }'::jsonb,
  true, true, true, true, 0
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3-pro'
)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- If an operator already added either endpoint through the admin page, converge
-- that row instead of creating a second base-slug sibling. Preserve a non-empty
-- probe snapshot and an explicit version pin, but apply the owner-requested
-- surface/order/transport policy.
UPDATE "image_models"
SET
  "can_generate" = true,
  "can_edit" = true,
  "reference_field" = 'image',
  "reference_arity" = 'single',
  "reference_transport" = 'data_url',
  "max_references" = 1,
  "aspect_mode" = 'aspect_ratio',
  "supported_aspects" = '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  "probed_version_id" = COALESCE("probed_version_id", '8235a8d30fc32fd33a4e0e91d9cffaae6f2250fc56ff8e5736ca4a9c5b9f9fbc'),
  "for_portrait" = true,
  "for_variant" = true,
  "for_scene" = true,
  "builtin" = true,
  "sort" = 1,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3';
--> statement-breakpoint
UPDATE "image_models"
SET
  "can_generate" = true,
  "can_edit" = true,
  "reference_field" = 'image',
  "reference_arity" = 'single',
  "reference_transport" = 'data_url',
  "max_references" = 1,
  "aspect_mode" = 'aspect_ratio',
  "supported_aspects" = '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  "probed_version_id" = COALESCE("probed_version_id", '2d41e651d91e3ff97dfd0f3f85c22ccc45e084f7edf843f701e49895f8398213'),
  "for_portrait" = true,
  "for_variant" = true,
  "for_scene" = true,
  "builtin" = true,
  "sort" = 0,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3-pro';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Task profiles and defaults
-- ---------------------------------------------------------------------------

-- The partial unique index permits exactly one enabled default per task. Clear
-- the three owner-requested task defaults first; item/location/chat-place/chat-
-- look stay untouched.
UPDATE "image_model_profiles"
SET "is_default" = false, "updated_at" = now()
WHERE "task" IN ('portrait', 'variant', 'scene') AND "is_default" = true;
--> statement-breakpoint

-- Cheaper Qwen Image 3 sibling: offered on all three character surfaces, default
-- on none. Prompt expansion is disabled so Vesper's stored compiled prompt is the
-- prompt the provider reads.
WITH chosen AS (
  SELECT "id"
  FROM "image_models"
  WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3'
  ORDER BY CASE WHEN "slug" = 'alibaba/qwen-image-3' THEN 0 ELSE 1 END, "sort", "id"
  LIMIT 1
), profiles(
  "id", "key", "label", "task", "operation", "prompt_strategy", "reference_policy", "sort"
) AS (VALUES
  ('imgprfqwen3portraitaaaaaa', 'portrait-standard', 'Qwen Image 3 Portrait', 'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb, 4),
  ('imgprfqwen3variantaaaaaaa', 'variant-standard', 'Qwen Image 3 Variant', 'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb, 5),
  ('imgprfqwen3sceneaaaaaaaaa', 'scene-standard', 'Qwen Image 3 Scene', 'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb, 6)
)
INSERT INTO "image_model_profiles" (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT
  p."id", chosen."id", p."key", p."label", p."task", p."operation", p."prompt_strategy",
  p."reference_policy", '{}'::jsonb,
  '{"enable_prompt_expansion":false,"match_input_image":false}'::jsonb,
  NULL::integer, true, false, true, p."sort"
FROM profiles p CROSS JOIN chosen
ON CONFLICT ("image_model_id", "key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "task" = EXCLUDED."task",
  "operation" = EXCLUDED."operation",
  "prompt_strategy" = EXCLUDED."prompt_strategy",
  "reference_policy" = EXCLUDED."reference_policy",
  "provider_overrides" = EXCLUDED."provider_overrides",
  "enabled" = true,
  "is_default" = false,
  "builtin" = true,
  "sort" = EXCLUDED."sort",
  "updated_at" = now();
--> statement-breakpoint

-- Qwen Image 3 Pro: same three task profiles, now the global defaults requested
-- for Character Studio and scene generation.
WITH chosen AS (
  SELECT "id"
  FROM "image_models"
  WHERE split_part("slug", ':', 1) = 'alibaba/qwen-image-3-pro'
  ORDER BY CASE WHEN "slug" = 'alibaba/qwen-image-3-pro' THEN 0 ELSE 1 END, "sort", "id"
  LIMIT 1
), profiles(
  "id", "key", "label", "task", "operation", "prompt_strategy", "reference_policy", "sort"
) AS (VALUES
  ('imgprfqwen3proportraitaaa', 'portrait-standard', 'Qwen Image 3 Pro Portrait', 'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb, 1),
  ('imgprfqwen3provariantaaaa', 'variant-standard', 'Qwen Image 3 Pro Variant', 'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb, 2),
  ('imgprfqwen3prosceneaaaaaa', 'scene-standard', 'Qwen Image 3 Pro Scene', 'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb, 3)
)
INSERT INTO "image_model_profiles" (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT
  p."id", chosen."id", p."key", p."label", p."task", p."operation", p."prompt_strategy",
  p."reference_policy", '{}'::jsonb,
  '{"enable_prompt_expansion":false,"match_input_image":false}'::jsonb,
  NULL::integer, true, true, true, p."sort"
FROM profiles p CROSS JOIN chosen
ON CONFLICT ("image_model_id", "key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "task" = EXCLUDED."task",
  "operation" = EXCLUDED."operation",
  "prompt_strategy" = EXCLUDED."prompt_strategy",
  "reference_policy" = EXCLUDED."reference_policy",
  "provider_overrides" = EXCLUDED."provider_overrides",
  "enabled" = true,
  "is_default" = true,
  "builtin" = true,
  "sort" = EXCLUDED."sort",
  "updated_at" = now();
