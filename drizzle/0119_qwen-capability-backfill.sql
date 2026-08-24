-- Backfill the probed capability record on the three Qwen rows, so the
-- capability-driven surfaces offer the controls those endpoints actually
-- publish.
--
-- WHY A DATA MIGRATION. Every seeded `image_models` row still carries
-- `advanced_capabilities = '{}'` (0110), and 0118 filled in only 2511's two
-- LoRA bindings. An empty record is not neutral: it is what the Image
-- Generator's form is built from, and what the control mapper resolves field
-- names through. So an empty one correctly renders a FLAT model — no seed, no
-- steps, no guidance, no edit strength — on endpoints that publish every one
-- of them.
-- The control vocabulary was never the gap; the rows were.
--
-- An operator can reach the same state from /settings/image-models by
-- re-probing each row, and that stays the ordinary path. This patch exists so a
-- FRESH database comes up correct without anyone remembering to, the same
-- reason 0098, 0104, 0107 and 0110 seed their data by hand.
--
-- VERIFIED 2026-08-24 against each model's published Replicate input schema and
-- cross-checked field for field — types, defaults, ranges, enum members —
-- against the per-version input tables in docs/image-models/models/. The
-- records below are not hand-typed JSON: they are the output of
-- `deriveAdvancedCapabilities` (packages/image-replicate/src/probe.ts) run over
-- those schemas, so a later re-probe of an unchanged schema produces the same
-- record and the admin version diff stays empty.
--
-- TWO GUARDS ON EVERY STATEMENT, and both carry weight:
--
--   1. The row must still sit at a provider version this record describes —
--      0118's rule. A row an operator has re-pinned since describes some other
--      schema, and projecting today's field truth onto it is precisely the
--      drift that pinning exists to prevent.
--   2. The row must not already carry `providerInputs`. Only a probe that ran
--      the descriptor derivation writes that key, so its presence means a real
--      probe of this row's own version has already answered the question with
--      better evidence than this file has. Its ABSENCE is what identifies the
--      pre-derivation snapshots this patch is for, and it makes every statement
--      idempotent by construction.
--
-- The record is written WHOLE rather than merged into. `providerInputs` marks
-- every field the render path owns, and that set is computed FROM the control
-- bindings — so a merge that added bindings while keeping an older descriptor
-- list would leave `go_fast` bound as a control and described as unreserved, a
-- disagreement no probe could ever produce.
--
-- Owner-curated columns are untouched: `supported_aspects`, `max_references`,
-- `edit_kind`, `identity_preservation` and `operator_warning` are reviewed
-- judgments no schema can state. `probed_version_id` is left alone too, because
-- this file is not a probe and knows nothing about the row's version that the
-- row does not already say.
--
-- Qwen Image 2512 — the generator arm, and the widest control set in the
-- catalog: seed, negative prompt, guidance (0–10), steps (20–50), edit strength
-- (0–1), the accelerated sampling path, and the custom width/height pair
-- (256–2048). It publishes no LoRA input and no output-count input, so neither
-- slot is bound.
--
-- `negative_prompt` binds because the schema declares it, and that is the
-- correct MECHANICAL answer even though this endpoint ignores the field
-- (docs/image-models/models/qwen-image-2512.md §"Negative-prompt ruling"). A
-- binding says what an input is called; whether it steers is a reviewed
-- judgment, and the reviewed layers already carry that one — the prompt dialect
-- drops exclusions as `endpoint_ignores_negative_field`, and the model adapter
-- deliberately withholds the negative-prompt feature. Withholding the binding
-- here as well would hide a third copy of the judgment in a registry row, where
-- the next re-probe would silently undo it.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "negativePrompt": {"field":"negative_prompt","type":"string"},
      "guidance": {"field":"guidance","type":"number","minimum":0,"maximum":10},
      "steps": {"field":"num_inference_steps","type":"integer","minimum":20,"maximum":50},
      "editStrength": {"field":"strength","type":"number","minimum":0,"maximum":1},
      "fastMode": {"field":"go_fast","type":"boolean"},
      "customWidth": {"field":"width","type":"integer","minimum":256,"maximum":2048},
      "customHeight": {"field":"height","type":"integer","minimum":256,"maximum":2048}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "go_fast",
      "guidance",
      "height",
      "image",
      "negative_prompt",
      "num_inference_steps",
      "output_format",
      "output_quality",
      "prompt",
      "seed",
      "strength",
      "width"
    ],
    "providerInputs": [
      {"field":"aspect_ratio","type":"enum","required":false,"default":"16:9","enumValues":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","custom"],"description":"Aspect ratio for the generated image.","reserved":true},
      {"field":"disable_safety_checker","type":"boolean","required":false,"default":false,"description":"Disable safety checker for generated images.","reserved":true},
      {"field":"go_fast","type":"boolean","required":false,"default":true,"description":"Use the model with additional optimizations for faster generation.","reserved":true},
      {"field":"guidance","type":"number","required":false,"default":4,"minimum":0,"maximum":10,"description":"Guidance for generated image. Use higher values for stronger prompt adherence.","reserved":true},
      {"field":"height","type":"integer","required":false,"minimum":256,"maximum":2048,"description":"Height of the generated image. Only used when aspect_ratio=custom. Must be a multiple of 16.","reserved":true},
      {"field":"image","type":"uri","required":false,"description":"Input image for image2image generation. The aspect ratio of your output will match this image.","reserved":true},
      {"field":"negative_prompt","type":"string","required":false,"default":" ","description":"Negative prompt for image generation.","reserved":true},
      {"field":"num_inference_steps","type":"integer","required":false,"default":40,"minimum":20,"maximum":50,"description":"Number of denoising steps. Use less steps for faster generation.","reserved":true},
      {"field":"output_format","type":"enum","required":false,"default":"webp","enumValues":["webp","jpg","png"],"description":"Format of the output images.","reserved":false},
      {"field":"output_quality","type":"integer","required":false,"default":95,"minimum":0,"maximum":100,"description":"Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text prompt for image generation.","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed. Set for reproducible generation.","reserved":true},
      {"field":"strength","type":"number","required":false,"default":0.8,"minimum":0,"maximum":1,"description":"Strength for image2image generation. 1.0 corresponds to full destruction of information in image.","reserved":true},
      {"field":"width","type":"integer","required":false,"minimum":256,"maximum":2048,"description":"Width of the generated image. Only used when aspect_ratio=custom. Must be a multiple of 16.","reserved":true}
    ]
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-2512'
  -- The version this repository recorded the row at (docs/image-models/models/qwen-image-2512.md),
  -- and the version this statement's record was read from. Any other pin is a row this file cannot speak for.
  AND (
    "probed_version_id" IS NULL
    OR "probed_version_id" = '47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6'
    OR "probed_version_id" = '9eb53ec91c15dda5adac7688b9762e0be703f01ba1e49bbe6be7cdf7680de5d3'
  )
  AND (
    "advanced_capabilities"->'providerInputs' IS NULL
    OR "advanced_capabilities"->'providerInputs' = '[]'::jsonb
  );
--> statement-breakpoint
-- Qwen Image Edit 2511 — the current instruction editor. Four controls: a seed,
-- the accelerated sampling path, and the LoRA pair 0118 already verified. No
-- `strength`, no `num_inference_steps`, no guidance under any spelling and no
-- `negative_prompt` appear in this schema at all; on an instruction editor the
-- edit intensity IS the instruction and the references.
--
-- This REPLACES 0118's partial snapshot rather than adding to it. 0118 wrote the
-- two LoRA bindings and widened the known-input allowlist, which was the whole
-- of what that patch had verified; a descriptor list has to be derived from the
-- same control bindings it describes, so the two cannot be written separately.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "fastMode": {"field":"go_fast","type":"boolean"},
      "loraWeights": {"field":"lora_weights","type":"string"},
      "loraScale": {"field":"lora_scale","type":"number","minimum":0,"maximum":4}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "go_fast",
      "image",
      "lora_scale",
      "lora_weights",
      "output_format",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {"field":"aspect_ratio","type":"enum","required":false,"default":"match_input_image","enumValues":["1:1","16:9","9:16","4:3","3:4","match_input_image"],"description":"Aspect ratio for the generated image.","reserved":true},
      {"field":"disable_safety_checker","type":"boolean","required":false,"default":false,"description":"Disable safety checker for generated images.","reserved":true},
      {"field":"go_fast","type":"boolean","required":false,"default":true,"description":"Run faster predictions with additional optimizations.","reserved":true},
      {"field":"image","type":"uri","required":true,"description":"Images to use as reference. Must be jpeg, png, gif, or webp.","reserved":true},
      {"field":"lora_scale","type":"number","required":false,"default":1,"minimum":0,"maximum":4,"description":"Strength applied to the selected LoRA.","reserved":true},
      {"field":"lora_weights","type":"string","required":false,"default":"","description":"LoRA weights to apply. Pass a Hugging Face repo slug (for example ''owner/model'') or a direct .safetensors URL. Leave blank to run without a LoRA.","reserved":true},
      {"field":"output_format","type":"enum","required":false,"default":"webp","enumValues":["webp","jpg","png"],"description":"Format of the output images.","reserved":false},
      {"field":"output_quality","type":"integer","required":false,"default":95,"minimum":0,"maximum":100,"description":"Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text instruction on how to edit the given image.","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed. Set for reproducible generation.","reserved":true}
    ]
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-edit-2511'
  -- The version 0118 and the model page record the row at,
  -- and the version this statement's record was read from.
  AND (
    "probed_version_id" IS NULL
    OR "probed_version_id" = 'a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729'
    OR "probed_version_id" = '4e2f23e2ebd73b51d0659cb0c2252a77347bfa278ca69b5faf4cc63c0171e6fc'
  )
  AND (
    "advanced_capabilities"->'providerInputs' IS NULL
    OR "advanced_capabilities"->'providerInputs' = '[]'::jsonb
  );
--> statement-breakpoint
-- Qwen Image Edit Plus LoRA — the older 2509-generation wrapper, field for field
-- the same schema as 2511. The input DESCRIPTIONS differ in wording, which is
-- why the record in this statement is not a copy of the one above.
--
-- It is an admin-registered row rather than a seeded one, so on a fresh database
-- this statement matches nothing; it is here for the deployment that registered
-- the wrapper before the descriptor derivation existed. Its slug carries a
-- version pin, which is why every statement in this file matches on
-- `split_part` — `baseImageModelSlug`'s own rule — and leaves the version
-- question to the guard.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "fastMode": {"field":"go_fast","type":"boolean"},
      "loraWeights": {"field":"lora_weights","type":"string"},
      "loraScale": {"field":"lora_scale","type":"number","minimum":0,"maximum":4}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "go_fast",
      "image",
      "lora_scale",
      "lora_weights",
      "output_format",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {"field":"aspect_ratio","type":"enum","required":false,"default":"match_input_image","enumValues":["1:1","16:9","9:16","4:3","3:4","match_input_image"],"description":"Aspect ratio for the generated image","reserved":true},
      {"field":"disable_safety_checker","type":"boolean","required":false,"default":false,"description":"Disable safety checker for generated images.","reserved":true},
      {"field":"go_fast","type":"boolean","required":false,"default":true,"description":"Run faster predictions with additional optimizations.","reserved":true},
      {"field":"image","type":"uri","required":true,"description":"Images to use as reference. Must be jpeg, png, gif, or webp.","reserved":true},
      {"field":"lora_scale","type":"number","required":false,"default":1,"minimum":0,"maximum":4,"description":"Strength applied to the selected LoRA.","reserved":true},
      {"field":"lora_weights","type":"string","required":false,"default":"","description":"LoRA weights to apply. Pass a Hugging Face repo slug (for example ''owner/model'') or a direct .safetensors/zip/tar URL such as ''https://huggingface.co/flymy-ai/qwen-image-lora/resolve/main/pytorch_lora_weights.safetensors''. Leave blank to run without a LoRA.","reserved":true},
      {"field":"output_format","type":"enum","required":false,"default":"webp","enumValues":["webp","jpg","png"],"description":"Format of the output images","reserved":false},
      {"field":"output_quality","type":"integer","required":false,"default":95,"minimum":0,"maximum":100,"description":"Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text instruction on how to edit the given image.","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed. Set for reproducible generation","reserved":true}
    ]
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-edit-plus-lora'
  -- The pinned version the registered row carries,
  -- and the version this statement's record was read from.
  AND (
    "probed_version_id" IS NULL
    OR "probed_version_id" = 'b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200'
    OR "probed_version_id" = '552bc9e29a4259a6d19c71a2a1566bd23d407d9a814dd074c5bb081917a15401'
  )
  AND (
    "advanced_capabilities"->'providerInputs' IS NULL
    OR "advanced_capabilities"->'providerInputs' = '[]'::jsonb
  );
