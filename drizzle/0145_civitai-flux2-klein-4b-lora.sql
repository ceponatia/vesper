-- Add Civitai's native FLUX.2 Klein 4B distilled generation lane to the admin
-- Image Generator and move the existing NippleDiffusion pilot onto it.
--
-- WHY CIVITAI. The Replicate `black-forest-labs/flux-2-klein-4b-base-lora`
-- wrapper proved unsuitable for this experiment: even a no-LoRA render from that
-- endpoint produced a severely under-denoised image. Civitai's own current
-- Flux2-Klein generation graph pins the DISTILLED 4B checkpoint to model-version
-- 2612557 (`Flux2Klein_4B`), and its server handler explicitly turns selected
-- LoRA resources into the `loras` map for every Klein variant. That is the native
-- checkpoint/resource path we actually want to test.
--
-- The Civitai transport performs `orchestrator.whatIfFromGraph` before every real
-- submit. That query spends no Buzz and must report `ready=true`, no checkpoint
-- substitution, and (when a LoRA is selected) mature-content permission before
-- Vesper will submit the paid workflow. This row is therefore an admin bench
-- target only; production flags remain false and no profile points at it.
--
-- The row's `probed_version_id` is the Civitai MODEL-VERSION id, not a Replicate
-- hash. Unlike fal's schema-capture markers, 2612557 is the actual checkpoint
-- resource id sent in Civitai's generation graph and is also the exact value the
-- LoRA compatibility gate below names.
--
-- Civitai's public Flux2-Klein graph uses its SDXL/Flux 1024-ish aspect buckets.
-- Vesper advertises the five core shapes it has direct evidence for here rather
-- than copying Replicate's broader eleven-shape enum onto a different provider.
-- Additional shapes can be widened after the bench confirms them.
--
-- `civitai_lora_version` and `civitai_lora_strength` are Vesper transport fields,
-- not literal Civitai JSON keys. The ordinary normalized LoRA mapper writes the
-- curated row into those two bindings; `civitai-runtime.ts` converts the stored
-- Civitai download locator back to its numeric model-version id and sends it as
-- a generation-graph resource `{ id, model: { type: "LORA" }, strength }`.
-- This preserves the existing LoRA picker/control path without pretending a
-- Civitai model has Replicate's `lora_weights` input.

INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlcivklein4baaaaaaa',
  'civitai/flux-2-klein-4b',
  'FLUX.2 klein 4B (Civitai LoRA)',
  true,
  false,
  'image',
  'array',
  'file',
  0,
  'aspect_ratio',
  '["1:1","2:3","3:2","9:16","16:9"]'::jsonb,
  NULL,
  '{}'::jsonb,
  '2612557',
  'unknown',
  'unknown',
  'Civitai native Flux2 Klein 4B distilled bench lane. Text-to-image only in Vesper for now; Civitai itself also supports Klein editing, but Vesper has not implemented that provider''s image-upload path. Every real submit is preceded by a zero-Buzz what-if check and is refused if resources are not ready, mature content is unavailable to the account, or Civitai would substitute a different checkpoint. No production profile points at this row.',
  '{
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
      {"field":"aspect_ratio","type":"enum","required":false,"default":"1:1","enumValues":["1:1","2:3","3:2","9:16","16:9"],"reserved":true},
      {"field":"civitai_lora_version","type":"string","required":false,"description":"Curated Civitai LoRA model-version locator; converted to a graph resource by the Civitai transport","reserved":true},
      {"field":"civitai_lora_strength","type":"number","required":false,"minimum":0,"maximum":4,"description":"LoRA resource strength","reserved":true}
    ]
  }'::jsonb,
  false,
  false,
  false,
  true,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE "slug" = 'civitai/flux-2-klein-4b'
)
ON CONFLICT ("slug") DO NOTHING;

--> statement-breakpoint

-- Move only the exact pilot state seeded by 0143/0144. Seeded LoRA rows are
-- ordinary admin-owned rows, so an operator who already changed its locator or
-- model compatibility has made a newer curation decision and is left alone.
UPDATE "image_loras"
SET
  "locator_type" = 'civitai_model_version',
  "locator" = '2633618',
  "compatible_model_slugs" = '["civitai/flux-2-klein-4b"]'::jsonb,
  "compatible_version_ids" = '["2612557"]'::jsonb,
  "updated_at" = now()
WHERE "id" = 'imglorklein4bnsfwfemale'
  AND "compatible_model_slugs" = '["black-forest-labs/flux-2-klein-4b-base-lora"]'::jsonb
  AND "compatible_version_ids" = '["c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc"]'::jsonb
  AND (
    ("locator_type" = 'https_url'
      AND "locator" = 'https://huggingface.co/Sentinel7/flux2/resolve/main/2331032/2633618/nipplediffusion-f2-klein-4b.safetensors')
    OR
    ("locator_type" = 'civitai_model_version' AND "locator" = '2633618')
  );
