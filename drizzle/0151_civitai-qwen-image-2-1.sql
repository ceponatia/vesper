-- Seed Civitai's Qwen Image 2.1 lane as an admin Image Generator bench row.
-- Data only: no table shape changes and no profile is created, so no production
-- picker can reach this row.
--
-- THE LANE. Civitai Orchestration v2's comfy Qwen 2.1 lane: `engine: "comfy"`,
-- `ecosystem: "qwen"`, `model: "2.1"`. Zero references `createImage` at an
-- explicit width/height; one to ten references `editImage` with an `images`
-- list and a `resolution` pixel budget (the provider derives an edit's shape from
-- the reference). Measured with zero-Buzz what-if preflights on 2026-09-30; the
-- transport (`civitai-qwen21-runtime.ts`) owns the workflow and its echo check.
--
-- `probed_version_id` is the hosted checkpoint's Civitai MODEL-VERSION id
-- (model 2954443, version 3352534). The workflow omits `diffusionModel`, as
-- Civitai's own generator does for the hosted default, so the id is this row's
-- identity for provenance and LoRA compatibility rather than a value the
-- request sends.
--
-- CONTROLS are the lane's own field names. `guidance` binds `cfgScale` (true
-- CFG, 0-30), `steps` binds `steps` (1-60: the provider takes 150, and cost is
-- linear in steps), and the `resolution` TIER binds the `resolution` field with
-- 1K/2K; the transport turns the tier into a create size (with the aspect) or
-- an edit pixel budget. `sampler` and `scheduler` are non-reserved provider
-- inputs, so the Generator offers them as Advanced model inputs under those
-- names. Descriptor defaults are the values the transport sends when a control
-- is blank: the official recipe of cfgScale 1, 40 steps, euler, simple.
--
-- `civitai_lora_version` and `civitai_lora_strength` are Vesper transport
-- fields, not literal Civitai keys: the curated library row's model-version id
-- becomes a `urn:air:qwen21:lora:civitai:<modelId>@<versionId>` entry in the
-- workflow's `loras` map, and only after Civitai's metadata reports
-- `baseModel: "Qwen 2.1"`. The provider itself accepts a Qwen-Image 20B LoRA on
-- this lane, so that transport gate is the only family check.
--
-- Guarded twice, like 0145: `WHERE NOT EXISTS` leaves any existing row for the
-- slug untouched, and `ON CONFLICT DO NOTHING` covers the unique slug index.

INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlcivqwen21aaaaaaaa',
  'civitai/qwen-image-2.1',
  'Qwen Image 2.1 (Civitai)',
  true,
  true,
  'images',
  'array',
  'data_url',
  10,
  'aspect_ratio',
  '["1:1","4:3","3:4","3:2","2:3","16:9","9:16"]'::jsonb,
  NULL,
  '{}'::jsonb,
  '3352534',
  'unknown',
  'unknown',
  'Civitai Qwen Image 2.1 admin Image Generator bench lane only; no production profile points at this row. Account entitlement, the combined paid mature-content + curated-LoRA + reference-image result, and output quality are unverified. As of 2026-09-30 Civitai had enabled generation for no Qwen 2.1 LoRA, so a LoRA selection is refused by the provider as not enabled for generation. Only a LoRA whose Civitai baseModel is "Qwen 2.1" is sent; a Qwen-Image 20B LoRA is refused before spend. Zero references generate; one to ten edit.',
  '{
    "prompt":{"field":"prompt","maxChars":10000},
    "controls":{
      "seed":{"field":"seed","type":"integer"},
      "negativePrompt":{"field":"negativePrompt","type":"string"},
      "guidance":{"field":"cfgScale","type":"number","minimum":0,"maximum":30},
      "steps":{"field":"steps","type":"integer","minimum":1,"maximum":60},
      "resolutionTier":{"field":"resolution","type":"enum","enumValues":["1K","2K"]},
      "loraWeights":{"field":"civitai_lora_version","type":"string"},
      "loraScale":{"field":"civitai_lora_strength","type":"number","minimum":0,"maximum":4}
    },
    "additionalImageInputs":[],
    "output":{"arity":"single","supportsMultiple":false},
    "knownInputFields":["prompt","negativePrompt","cfgScale","steps","sampler","scheduler","seed","aspect_ratio","resolution","civitai_lora_version","civitai_lora_strength"],
    "providerInputs":[
      {"field":"prompt","type":"string","required":true,"description":"Civitai Qwen Image 2.1 prompt","reserved":true},
      {"field":"negativePrompt","type":"string","required":false,"description":"Inert at cfgScale 1 — raise cfgScale above 1 or leave this blank.","reserved":true},
      {"field":"cfgScale","type":"number","required":false,"default":1,"minimum":0,"maximum":30,"description":"1 = no guidance (the model''s official default); above 1 doubles the Buzz and is required for negativePrompt to have any effect.","reserved":true},
      {"field":"steps","type":"integer","required":false,"default":40,"minimum":1,"maximum":60,"description":"40 is the model''s official default; the provider''s own default is 25. Cost scales linearly with steps.","reserved":true},
      {"field":"sampler","type":"enum","required":false,"default":"euler","enumValues":["euler","euler_ancestral","euler_cfg_pp","euler_ancestral_cfg_pp","heun","heunpp2","dpm_2","dpm_2_ancestral","lms","dpm_fast","dpm_adaptive","dpmpp_2s_ancestral","dpmpp_2s_ancestral_cfg_pp","dpmpp_sde","dpmpp_sde_gpu","dpmpp_2m","dpmpp_2m_cfg_pp","dpmpp_2m_sde","dpmpp_2m_sde_gpu","dpmpp_3m_sde","dpmpp_3m_sde_gpu","ddpm","lcm","ipndm","ipndm_v","deis","ddim","uni_pc","uni_pc_bh2","res_multistep","er_sde"],"description":"euler is the official flow-matching sampler.","reserved":false},
      {"field":"scheduler","type":"enum","required":false,"default":"simple","enumValues":["normal","karras","exponential","sgm_uniform","simple","ddim_uniform","beta"],"reserved":false},
      {"field":"seed","type":"integer","required":false,"description":"Civitai workflow seed","reserved":true},
      {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","4:3","3:4","3:2","2:3","16:9","9:16"],"description":"Create only; an edit follows the reference''s aspect.","reserved":true},
      {"field":"resolution","type":"enum","required":false,"default":"1K","enumValues":["1K","2K"],"description":"1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference''s aspect.","reserved":true},
      {"field":"civitai_lora_version","type":"string","required":false,"description":"Curated Civitai LoRA model-version id; the transport sends it as a Qwen 2.1 AIR only when Civitai reports baseModel Qwen 2.1","reserved":true},
      {"field":"civitai_lora_strength","type":"number","required":false,"minimum":0,"maximum":4,"description":"Civitai Qwen Image 2.1 LoRA strength","reserved":true}
    ]
  }'::jsonb,
  false,
  false,
  false,
  true,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE "slug" = 'civitai/qwen-image-2.1'
)
ON CONFLICT ("slug") DO NOTHING;
