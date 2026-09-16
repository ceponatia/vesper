-- Advance only the untouched Civitai FLUX.2 Klein 4B admin bench row from
-- the retired website graph to the reviewed native v2 workflow. This is a data
-- migration: it changes no table shape and creates no production profile.
--
-- The native `4b` variant creates from no references and edits from one or two
-- data URLs in `images`. The same curated AIR LoRA and its selected strength may
-- accompany either operation. Mature-content, Yellow-Buzz, manual-upgrade, and
-- fixed sampling policy remain transport-owned rather than catalog controls.
--
-- The model predicate is intentionally complete: every value below is the 0145
-- baseline, and `created_at = updated_at` proves no admin write has curated the
-- row since it was inserted. A deleted, disabled, or independently edited row is
-- left unchanged. `migrated_model` is the dependency boundary: the LoRA cannot
-- advance unless this exact model UPDATE returned a row in this same statement,
-- and its last 0145 timestamp still equals the model row's original timestamp.
WITH migrated_model AS (
  UPDATE "image_models"
  SET
    "label" = 'FLUX.2 Klein 4B (Civitai v2)',
    "can_generate" = true,
    "can_edit" = true,
    "reference_field" = 'images',
    "reference_arity" = 'array',
    "reference_transport" = 'data_url',
    "max_references" = 2,
    "aspect_mode" = 'aspect_ratio',
    "supported_aspects" = '["1:1","2:3","3:2"]'::jsonb,
    "output_format" = NULL,
    "extra_input" = '{}'::jsonb,
    "probed_version_id" = '4b',
    "edit_kind" = 'unknown',
    "identity_preservation" = 'unknown',
    "operator_warning" = 'Civitai native Flux2 Klein v2 admin Image Generator bench lane. The combined paid mature-content, curated-LoRA, and reference-image result remains unverified; account entitlement and output quality remain unverified too. Zero references generate; one or two references edit. No production profile points at this row.',
    "advanced_capabilities" = '{
      "prompt":{"field":"prompt","maxChars":1000},
      "controls":{
        "seed":{"field":"seed","type":"integer"},
        "loraWeights":{"field":"civitai_lora_version","type":"string"},
        "loraScale":{"field":"civitai_lora_strength","type":"number"}
      },
      "additionalImageInputs":[],
      "output":{"arity":"single","supportsMultiple":false},
      "knownInputFields":["prompt","aspect_ratio","seed","civitai_lora_version","civitai_lora_strength"],
      "providerInputs":[
        {"field":"prompt","type":"string","required":true,"description":"Civitai Flux2 Klein v2 prompt","reserved":true},
        {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","2:3","3:2"],"reserved":true},
        {"field":"seed","type":"integer","required":false,"description":"Civitai workflow seed","reserved":true},
        {"field":"civitai_lora_version","type":"string","required":false,"description":"Curated Civitai LoRA locator; the transport derives an AIR identifier","reserved":true},
        {"field":"civitai_lora_strength","type":"number","required":false,"description":"Civitai Flux2 Klein LoRA strength","reserved":true}
      ]
    }'::jsonb,
    "for_portrait" = false,
    "for_variant" = false,
    "for_scene" = false,
    "updated_at" = now()
  WHERE "id" = 'imgmdlcivklein4baaaaaaa'
    AND "slug" = 'civitai/flux-2-klein-4b'
    AND "label" = 'FLUX.2 klein 4B (Civitai LoRA)'
    AND "can_generate" = true
    AND "can_edit" = false
    AND "reference_field" = 'image'
    AND "reference_arity" = 'array'
    AND "reference_transport" = 'file'
    AND "max_references" = 0
    AND "aspect_mode" = 'aspect_ratio'
    AND "supported_aspects" = '["1:1","2:3","3:2"]'::jsonb
    AND "output_format" IS NULL
    AND "extra_input" = '{}'::jsonb
    AND "probed_version_id" = '2612557'
    AND "edit_kind" = 'unknown'
    AND "identity_preservation" = 'unknown'
    AND "operator_warning" = 'Civitai native Flux2 Klein 4B distilled bench lane. Text-to-image only in Vesper for now; Civitai itself also supports Klein editing, but Vesper has not implemented that provider''s image-upload path. Every real submit is preceded by a zero-Buzz what-if check and is refused if resources are not ready, mature content is unavailable to the account, or Civitai would substitute a different checkpoint. No production profile points at this row.'
    AND "advanced_capabilities" = '{
      "prompt":{"field":"prompt","maxChars":6000},
      "controls":{
        "seed":{"field":"seed","type":"integer","minimum":0,"maximum":4294967295},
        "negativePrompt":{"field":"negative_prompt","type":"string"},
        "loraWeights":{"field":"civitai_lora_version","type":"string"},
        "loraScale":{"field":"civitai_lora_strength","type":"number","minimum":0,"maximum":4}
      },
      "additionalImageInputs":[],
      "output":{"arity":"single","supportsMultiple":false},
      "knownInputFields":["prompt","negative_prompt","seed","aspect_ratio","civitai_lora_version","civitai_lora_strength"],
      "providerInputs":[
        {"field":"prompt","type":"string","required":true,"description":"Civitai Flux2 Klein positive prompt","reserved":true},
        {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Civitai generation negative prompt","reserved":true},
        {"field":"seed","type":"integer","required":false,"minimum":0,"maximum":4294967295,"reserved":true},
        {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","2:3","3:2"],"reserved":true},
        {"field":"civitai_lora_version","type":"string","required":false,"description":"Curated Civitai LoRA model-version locator; converted to a graph resource by the Civitai transport","reserved":true},
        {"field":"civitai_lora_strength","type":"number","required":false,"minimum":0,"maximum":4,"description":"LoRA resource strength","reserved":true}
      ]
    }'::jsonb
    AND "for_portrait" = false
    AND "for_variant" = false
    AND "for_scene" = false
    AND "builtin" = true
    AND "sort" = 0
    AND "created_at" = "updated_at"
  RETURNING "id", "created_at"
)
UPDATE "image_loras" AS "lora"
SET
  "compatible_version_ids" = '["4b"]'::jsonb,
  "updated_at" = now()
FROM migrated_model
WHERE "lora"."id" = 'imglorklein4bnsfwfemale'
  AND "lora"."label" = 'NippleDiffusion General [4B] v2 (female NSFW test)'
  AND "lora"."locator_type" = 'civitai_model_version'
  AND "lora"."locator" = '2633618'
  AND "lora"."compatible_model_slugs" = '["civitai/flux-2-klein-4b"]'::jsonb
  AND "lora"."compatible_version_ids" = '["2612557"]'::jsonb
  AND "lora"."default_scale" = 1.0
  AND "lora"."minimum_scale" = 0.5
  AND "lora"."maximum_scale" = 1.5
  AND "lora"."trigger_words" = '[]'::jsonb
  AND "lora"."prompt_prefix" IS NULL
  AND "lora"."prompt_suffix" IS NULL
  AND "lora"."allowed_tasks" = '[]'::jsonb
  AND "lora"."enabled" = true
  AND "lora"."builtin" = true
  AND "lora"."updated_at" = migrated_model."created_at";
