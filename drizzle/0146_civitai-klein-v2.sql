-- Move the Civitai FLUX.2 Klein 4B bench row from the retired website graph to
-- the documented v2 native workflow. This is a data migration: the table shape
-- is unchanged, but the row selects a different provider contract.
--
-- `4b` is the v2 Flux2 Klein variant selector, not immutable checkpoint
-- 2612557. The native workflow selects `createImage` without references and
-- `editImage` with one or two references. Both operations accept data URLs in
-- `images` and the same AIR-to-strength LoRA map. The old three aspect buckets
-- remain the curated Vesper choices; each resolves to dimensions within v2's
-- documented 512--2048, divisible-by-16 bounds.
--
-- Mature support is documented by Civitai's v2 workflow but is not an account
-- entitlement or output-quality measurement. The transport sends
-- `allowMatureContent: true` and `currencies: ["yellow"]` for both its free
-- what-if and the real request, then reports permission, resource, and payment
-- failures before any paid submission.
--
-- The predicate deliberately matches every material value that 0145 seeded.
-- An administrator who changed the row is making a newer curation decision, so
-- this statement skips that row rather than overwriting it. A missing row is
-- also left absent: this release does not resurrect an intentionally removed
-- bench lane.
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
  "probed_version_id" = '4b',
  "operator_warning" = 'Civitai native Flux2 Klein v2 admin bench lane. Vesper requests documented mature-content support with Yellow Buzz only; a permitted Civitai token and Yellow balance are required. Account entitlement and output quality remain unverified. Zero references generate; one or two references edit, and a curated compatible LoRA may accompany either operation. No production profile points at this row.',
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
WHERE "slug" = 'civitai/flux-2-klein-4b'
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
  AND "for_scene" = false;

--> statement-breakpoint

-- Match only the 0145 target written by the obsolete website-graph path. A
-- changed locator, model set, or version set is administrator curation and is
-- deliberately skipped. The updated selector is `4b`; the LoRA stays pinned to
-- its curated Civitai model/version identity for the v2 AIR map.
UPDATE "image_loras"
SET
  "compatible_model_slugs" = '["civitai/flux-2-klein-4b"]'::jsonb,
  "compatible_version_ids" = '["4b"]'::jsonb,
  "updated_at" = now()
WHERE "id" = 'imglorklein4bnsfwfemale'
  AND "locator_type" = 'civitai_model_version'
  AND "locator" = '2633618'
  AND "compatible_model_slugs" = '["civitai/flux-2-klein-4b"]'::jsonb
  AND "compatible_version_ids" = '["2612557"]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM "image_models" AS "model"
    WHERE "model"."slug" = 'civitai/flux-2-klein-4b'
      AND "model"."probed_version_id" = '4b'
  );
