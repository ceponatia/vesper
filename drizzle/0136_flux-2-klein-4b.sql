-- Register the three FLUX.2 klein 4B endpoints Replicate publishes
-- (`black-forest-labs/flux-2-klein-4b`, `…-4b-base`, `…-4b-base-lora`) as pinned,
-- capability-described built-in rows, so the admin Image Generator can select and
-- bench them (issue #566, part of #562).
--
-- THREE ROWS FOR THREE MODELS, not one row with variants. They share a
-- prompt/reference shape and differ exactly where it costs a render: the
-- distilled `-4b` declares `go_fast` and NO guidance; `-4b-base` declares both;
-- `-4b-base-lora` declares neither and carries the array-shaped LoRA pair
-- instead. A control sent to a field its version does not declare is a provider
-- rejection at spend time, which is why each row's capability record is derived
-- from its OWN version's schema and nothing is shared between them.
--
-- WHY A DATA MIGRATION. The ordinary route for a new endpoint is the admin add
-- path at /settings/image-models, which probes Replicate and writes the row. This
-- file exists for the other half of that: a FRESH database must come up with the
-- rows already present, because `pnpm db:migrate` is what the Fly deploy runs and
-- `pnpm db:seed` never touches image models. Same reason 0098, 0104, 0107, 0110,
-- 0119, 0132, 0133 and 0134 seed and patch this catalog by hand — drizzle-kit has
-- no schema change to diff here, so this migration carries no snapshot.
--
-- PROBED 2026-09-12 from `GET /v1/models/black-forest-labs/flux-2-klein-4b…`, at
-- the version ids named on each row below. Every mechanical value is what
-- `probeReplicateModel` (packages/image-replicate/src/probe.ts) yields for that
-- version's published Input schema, and each capability record is the literal
-- output of `deriveAdvancedCapabilities` over it — not hand-typed JSON. A
-- re-probe of an unchanged schema therefore produces the same record and the
-- admin version diff stays empty. `probe.test.ts` pins all three records against
-- the same derivation from the same captured schemas, so this file and those
-- literals move together or CI says so. Evidence state: `documented` — read from
-- the provider's published schema. NO PAID TRIAL HAS BEEN RUN against any of
-- these endpoints, and nothing below claims otherwise.
--
-- LABELS ARE CURATED, EVERYTHING ELSE IS DERIVED. The probe's own label for
-- `flux-2-klein-4b` is "Flux 2 Klein 4b"; the rows carry the publisher's
-- capitalisation instead. That creates no version diff: `label` sits outside
-- `imageModelReprobeFields` (apps/web/src/server/images/identity-trial-model-versions.ts),
-- so a re-probe never rewrites it.
--
-- BARE SLUGS, PIN IN `probed_version_id`. Replicate reports `is_official: true`
-- for all three, and `POST /models/{owner}/{name}/predictions` — the endpoint a
-- bare slug uses — is official-models-only. So the slugs stay bare like
-- `qwen/qwen-image-2` and `prunaai/p-image`, and the version pin lives in its own
-- column. `pinnedImageModelVersion`
-- (packages/image-core/src/render-kernel/compile-profile-plan.ts) returns the
-- probed id when the slug carries no `:version`, which is exactly the "runnable"
-- gate the Image Generator's model select reads — a row without it is offered
-- disabled as "no pinned version". A stored pin is what makes each GENERATOR RUN
-- explicit; it is not a claim that every bare-slug request anywhere is globally
-- pinned to it.
--
-- THE REFERENCE INPUT IS A FIVE-IMAGE ARRAY. All three declare `images` as an
-- array of URIs whose description says "Maximum 5 images", and no klein schema
-- declares `maxItems`. `referenceCap` reads that phrasing as of this change;
-- before it the same schema derived the conservative default of 3, which would
-- have refused the fourth and fifth reference the provider accepts.
-- `can_generate` is true because `required` lists only `prompt`, and `can_edit`
-- is true because a reference input exists at all — which says nothing about
-- whether a face survives (see the reviewed columns below).
--
-- `reference_transport = 'file'`, the default. Only Wan 2.7 needs `data:` URIs,
-- and that is learned by running a model rather than read from a schema; nothing
-- observed here says these endpoints reject Replicate's uploaded-file URLs.
--
-- `supported_aspects` IS ELEVEN VALUES, NOT TWELVE. The `aspect_ratio` enum's
-- twelfth member, `match_input_image`, is a provider SENTINEL meaning "copy the
-- first reference's proportions" — it is not a ratio, `parseAspectValue` returns
-- null for it, and `deriveAspect` therefore drops it. Storing it would let
-- `chooseAspect` pick a value that is not a shape. It stays in the
-- `aspect_ratio` DESCRIPTOR's `enumValues` below, because a descriptor describes
-- the provider's accepted set rather than Vesper's usable subset.
--
-- `output_format = 'webp'` IS VESPER'S CHOICE, NOT THE PROVIDER'S DEFAULT. The
-- schemas default `output_format` to `jpg`; `deriveOutputFormat` prefers `webp`
-- wherever the enum offers it, which is what every other seeded row with a
-- format input carries. The descriptor below therefore records `"default":
-- "jpg"` (the provider's) while the column records `webp` (ours) — the two
-- disagreeing is correct, not a transcription error.
--
-- `output_megapixels` IS A STRING ENUM AND STAYS A RAW INPUT. It is not a
-- resolution tier: `resolutionTier` derives from a `size` enum bearing tier
-- names like "2K", and these versions declare no `size` at all. So it is a
-- non-reserved `providerInputs` descriptor with STRING members, which the Image
-- Generator's Advanced section offers and validates against the declared set.
-- Its provider default of "1" means one megapixel unless an operator raises it.
--
-- `extra_input` PINS ONLY DECLARED KEYS. `disable_safety_checker` and
-- `output_quality: 95` are pinned on all three; `go_fast: true` is pinned on the
-- two that declare it and ABSENT on `-base-lora`, which does not — Replicate
-- rejects unknown inputs, so copying one sibling's bag onto another would fail
-- every render. `disable_safety_checker`'s stored `true` is a placeholder the
-- transport overwrites with the deployment's own `safetyCheckerDisabled` posture
-- (packages/image-replicate/src/payload.ts); a database row cannot switch safety
-- enforcement, and no per-run bypass exists. `go_fast: true` IS a real behavior
-- change: the provider defaults it to `false` on both endpoints, so these rows
-- render on the accelerated path by default, and the operator warning says so.
--
-- REVIEWED COLUMNS ARE `unknown`, which is a statement about Vesper's evidence,
-- not about the models. Nobody has graded these endpoints' output here, so
-- `edit_kind` and `identity_preservation` both take the permissive default: the
-- rows keep working as ordinary registered models and can be rated later, while
-- a re-probe is forbidden from overwriting either. The `operator_warning` says
-- the same where an operator actually sees it — the admin card and the pickers.
--
-- NO SURFACE FLAGS AND NO PROFILE ROWS, which is what makes onboarding alone
-- change no production default. `for_portrait`/`for_variant`/`for_scene` are all
-- false and this file writes no `image_model_profiles` row, so the player-facing
-- pickers — which offer profiles, not models — cannot reach these. The Image
-- Generator runs a registered row without a profile, so the admin bench gets them
-- and nothing else does. Every existing default is untouched.
--
-- THE 9B SIBLINGS ARE NOT REGISTERED HERE. `black-forest-labs/flux-2-klein-9b`
-- and its variants are published under a non-commercial licence (ruling #564),
-- while the 4B endpoints are Apache-2.0. Registering 9B is out of this
-- migration's scope and is not implied by these rows existing.
--
-- TWO GUARDS ON EACH STATEMENT, and they answer different questions:
--
--   1. `WHERE NOT EXISTS` on the BASE slug. An administrator may already have
--      added one of these endpoints through the admin page, where the add path
--      auto-pins and could have stored it as `black-forest-labs/flux-2-klein-4b:<version>`.
--      That row's slug is not equal to the bare one, so the unique index would
--      not catch it and a second row for one endpoint would appear in every
--      picker. `split_part` on ':' compares the provider path alone, and the
--      comparison is EQUALITY, so `…-4b` does not match `…-4b-base` or
--      `…-4b-base-lora` and the three statements cannot suppress one another.
--   2. `ON CONFLICT ("slug") DO NOTHING` keeps each statement idempotent against
--      the bare slug itself, so a re-run beside an existing bare row is a no-op
--      rather than an error.
--
-- Neither guard REPAIRS a pre-existing row, and that is deliberate. A hand-added
-- row that is stale — probed at an older version, or carrying a cap of 3 from
-- before the prose pattern above existed — satisfies NOT EXISTS and is left
-- exactly as it is. That preserves operator curation, which is the point, but it
-- means a no-op insert is NOT a fix: an operator who finds a stale klein row must
-- re-probe it from /settings/image-models (or activate the version named above)
-- so its capability record is read from the version its renders will run.
--
-- Neither guard can honour a DELETION. A row that no longer exists creates no
-- conflict and satisfies NOT EXISTS, so an administrator who registered one of
-- these by hand and then removed it before this file reached their database gets
-- the built-in row once when it does. The database records no tombstone, so no
-- predicate could tell that history from a database that never had the row — and
-- the seeded-row contract is what makes this acceptable rather than a defect:
-- seeded rows are ordinary rows (owner ruling 4), so the row is deletable again
-- exactly as it was the first time, and a migration runs once per database, so a
-- deletion made AFTER it stays deleted.

-- FLUX.2 klein 4B
--   The DISTILLED endpoint: it declares `go_fast` and no `guidance`.
--   Probed at version 8e9c42d77b10a2a41af823ac4500f7545be6ebc4e745830fc3f3de10de200542.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlklein4baaaaaaaaaaa',
  -- Official, so no version pin in the slug: the pin is `probed_version_id`.
  'black-forest-labs/flux-2-klein-4b',
  -- Curated label; the probe's own would be "Flux 2 Klein 4b".
  'FLUX.2 klein 4B',
  true, true, 'images', 'array', 'file', 5, 'aspect_ratio',
  -- The `aspect_ratio` enum in schema order, `match_input_image` dropped.
  -- Eleven shapes including a native 3:4.
  '["1:1","16:9","9:16","3:2","2:3","4:3","3:4","5:4","4:5","21:9","9:21"]'::jsonb,
  -- Vesper's preference; the schema's own default is `jpg`.
  'webp',
  '{"disable_safety_checker":true,"output_quality":95,"go_fast":true}'::jsonb,
  '8e9c42d77b10a2a41af823ac4500f7545be6ebc4e745830fc3f3de10de200542',
  'unknown', 'unknown',
  'Untried in Vesper: no reviewed edit kind and no identity rating yet, so it is offered on no production surface and reaches only the admin Image Generator. Output defaults to 1 megapixel (output_megapixels), which is smaller than the seeded Qwen and Seedream rows produce; raise it per run under Advanced Model Inputs. The schema declares disable_safety_checker, so the deployment''s own safety setting decides it — whether that checker is this endpoint''s only moderation is unobserved here. Accelerated sampling is pinned ON (go_fast), which is the opposite of the provider''s default and has not been compared against the unaccelerated path. This endpoint is guidance-distilled and declares no guidance input; ask -base for a guidance scale.',
  -- `deriveAdvancedCapabilities` over this version's probed schema.
  '{
    "controls": {
      "seed": {
        "field": "seed",
        "type": "integer"
      },
      "fastMode": {
        "field": "go_fast",
        "type": "boolean"
      }
    },
    "additionalImageInputs": [],
    "output": {
      "arity": "single",
      "supportsMultiple": false
    },
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "go_fast",
      "images",
      "output_format",
      "output_megapixels",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {
        "field": "aspect_ratio",
        "type": "enum",
        "required": false,
        "default": "1:1",
        "enumValues": [
          "1:1",
          "16:9",
          "9:16",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "21:9",
          "9:21",
          "match_input_image"
        ],
        "description": "Aspect ratio for the generated image. Use ''match_input_image'' to match the aspect ratio of the first input image.",
        "reserved": true
      },
      {
        "field": "disable_safety_checker",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Disable safety checker for generated images.",
        "reserved": true
      },
      {
        "field": "go_fast",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Run faster predictions with additional optimizations.",
        "reserved": true
      },
      {
        "field": "images",
        "type": "uri",
        "required": false,
        "default": [],
        "description": "List of input images for image-to-image generation. Maximum 5 images. Must be jpeg, png, gif, or webp.",
        "reserved": true
      },
      {
        "field": "output_format",
        "type": "enum",
        "required": false,
        "default": "jpg",
        "enumValues": [
          "webp",
          "jpg",
          "png"
        ],
        "description": "Format of the output images",
        "reserved": false
      },
      {
        "field": "output_megapixels",
        "type": "enum",
        "required": false,
        "default": "1",
        "enumValues": [
          "0.25",
          "0.5",
          "1",
          "2",
          "4"
        ],
        "description": "Resolution of the output image in megapixels",
        "reserved": false
      },
      {
        "field": "output_quality",
        "type": "integer",
        "required": false,
        "default": 95,
        "minimum": 0,
        "maximum": 100,
        "description": "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.",
        "reserved": true
      },
      {
        "field": "prompt",
        "type": "string",
        "required": true,
        "description": "Text prompt for image generation.",
        "reserved": true
      },
      {
        "field": "seed",
        "type": "integer",
        "required": false,
        "description": "Random seed. Set for reproducible generation",
        "reserved": true
      }
    ]
  }'::jsonb,
  false, false, false, true, 101
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'black-forest-labs/flux-2-klein-4b'
)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- FLUX.2 klein 4B Base
--   The ORDINARY base: the only one of the three declaring `guidance`.
--   Probed at version 2289efa5ebba21f5322ba1b73ac92bb6fec9f34bafc08e0c26f465dac6f8b465.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlklein4bbaseaaaaaaa',
  -- Official, so no version pin in the slug: the pin is `probed_version_id`.
  'black-forest-labs/flux-2-klein-4b-base',
  -- Curated label; the probe's own would be "Flux 2 Klein 4b Base".
  'FLUX.2 klein 4B Base',
  true, true, 'images', 'array', 'file', 5, 'aspect_ratio',
  -- The `aspect_ratio` enum in schema order, `match_input_image` dropped.
  -- Eleven shapes including a native 3:4.
  '["1:1","16:9","9:16","3:2","2:3","4:3","3:4","5:4","4:5","21:9","9:21"]'::jsonb,
  -- Vesper's preference; the schema's own default is `jpg`.
  'webp',
  '{"disable_safety_checker":true,"output_quality":95,"go_fast":true}'::jsonb,
  '2289efa5ebba21f5322ba1b73ac92bb6fec9f34bafc08e0c26f465dac6f8b465',
  'unknown', 'unknown',
  'Untried in Vesper: no reviewed edit kind and no identity rating yet, so it is offered on no production surface and reaches only the admin Image Generator. Output defaults to 1 megapixel (output_megapixels), which is smaller than the seeded Qwen and Seedream rows produce; raise it per run under Advanced Model Inputs. The schema declares disable_safety_checker, so the deployment''s own safety setting decides it — whether that checker is this endpoint''s only moderation is unobserved here. Accelerated sampling is pinned ON (go_fast), which is the opposite of the provider''s default and has not been compared against the unaccelerated path. This is the only klein 4B endpoint declaring guidance (1-10, provider default 4); no value has been evaluated here.',
  -- `deriveAdvancedCapabilities` over this version's probed schema.
  '{
    "controls": {
      "seed": {
        "field": "seed",
        "type": "integer"
      },
      "guidance": {
        "field": "guidance",
        "type": "number",
        "minimum": 1,
        "maximum": 10
      },
      "fastMode": {
        "field": "go_fast",
        "type": "boolean"
      }
    },
    "additionalImageInputs": [],
    "output": {
      "arity": "single",
      "supportsMultiple": false
    },
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "go_fast",
      "guidance",
      "images",
      "output_format",
      "output_megapixels",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {
        "field": "aspect_ratio",
        "type": "enum",
        "required": false,
        "default": "1:1",
        "enumValues": [
          "1:1",
          "16:9",
          "9:16",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "21:9",
          "9:21",
          "match_input_image"
        ],
        "description": "Aspect ratio for the generated image. Use ''match_input_image'' to match the aspect ratio of the first input image.",
        "reserved": true
      },
      {
        "field": "disable_safety_checker",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Disable safety checker for generated images.",
        "reserved": true
      },
      {
        "field": "go_fast",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Run faster predictions with additional optimizations.",
        "reserved": true
      },
      {
        "field": "guidance",
        "type": "number",
        "required": false,
        "default": 4,
        "minimum": 1,
        "maximum": 10,
        "description": "Classifier-free guidance scale. Higher values produce images more closely related to the prompt.",
        "reserved": true
      },
      {
        "field": "images",
        "type": "uri",
        "required": false,
        "default": [],
        "description": "List of input images for image-to-image generation. Maximum 5 images. Must be jpeg, png, gif, or webp.",
        "reserved": true
      },
      {
        "field": "output_format",
        "type": "enum",
        "required": false,
        "default": "jpg",
        "enumValues": [
          "webp",
          "jpg",
          "png"
        ],
        "description": "Format of the output images",
        "reserved": false
      },
      {
        "field": "output_megapixels",
        "type": "enum",
        "required": false,
        "default": "1",
        "enumValues": [
          "0.25",
          "0.5",
          "1",
          "2",
          "4"
        ],
        "description": "Resolution of the output image in megapixels",
        "reserved": false
      },
      {
        "field": "output_quality",
        "type": "integer",
        "required": false,
        "default": 95,
        "minimum": 0,
        "maximum": 100,
        "description": "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.",
        "reserved": true
      },
      {
        "field": "prompt",
        "type": "string",
        "required": true,
        "description": "Text prompt for image generation.",
        "reserved": true
      },
      {
        "field": "seed",
        "type": "integer",
        "required": false,
        "description": "Random seed. Set for reproducible generation",
        "reserved": true
      }
    ]
  }'::jsonb,
  false, false, false, true, 102
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'black-forest-labs/flux-2-klein-4b-base'
)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- FLUX.2 klein 4B Base LoRA
--   The LoRA arm: array-shaped `lora_weights`/`lora_scales`, no `go_fast`, no `guidance`.
--   Probed at version c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlklein4bbaseloraaaa',
  -- Official, so no version pin in the slug: the pin is `probed_version_id`.
  'black-forest-labs/flux-2-klein-4b-base-lora',
  -- Curated label; the probe's own would be "Flux 2 Klein 4b Base Lora".
  'FLUX.2 klein 4B Base LoRA',
  true, true, 'images', 'array', 'file', 5, 'aspect_ratio',
  -- The `aspect_ratio` enum in schema order, `match_input_image` dropped.
  -- Eleven shapes including a native 3:4.
  '["1:1","16:9","9:16","3:2","2:3","4:3","3:4","5:4","4:5","21:9","9:21"]'::jsonb,
  -- Vesper's preference; the schema's own default is `jpg`.
  'webp',
  '{"disable_safety_checker":true,"output_quality":95}'::jsonb,
  'c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc',
  'unknown', 'unknown',
  'Untried in Vesper: no reviewed edit kind and no identity rating yet, so it is offered on no production surface and reaches only the admin Image Generator. Output defaults to 1 megapixel (output_megapixels), which is smaller than the seeded Qwen and Seedream rows produce; raise it per run under Advanced Model Inputs. The schema declares disable_safety_checker, so the deployment''s own safety setting decides it — whether that checker is this endpoint''s only moderation is unobserved here. It declares the array-shaped lora_weights/lora_scales pair and neither go_fast nor guidance. No curated LoRA has been run against it, so whether Flux Klein-format weights behave as the provider describes is unobserved.',
  -- `deriveAdvancedCapabilities` over this version's probed schema.
  '{
    "controls": {
      "seed": {
        "field": "seed",
        "type": "integer"
      },
      "loraWeights": {
        "field": "lora_weights",
        "type": "string",
        "arity": "array"
      },
      "loraScale": {
        "field": "lora_scales",
        "type": "number",
        "arity": "array"
      }
    },
    "additionalImageInputs": [],
    "output": {
      "arity": "single",
      "supportsMultiple": false
    },
    "knownInputFields": [
      "aspect_ratio",
      "disable_safety_checker",
      "images",
      "lora_scales",
      "lora_weights",
      "output_format",
      "output_megapixels",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {
        "field": "aspect_ratio",
        "type": "enum",
        "required": false,
        "default": "1:1",
        "enumValues": [
          "1:1",
          "16:9",
          "9:16",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "21:9",
          "9:21",
          "match_input_image"
        ],
        "description": "Aspect ratio for the generated image. Use ''match_input_image'' to match the aspect ratio of the first input image.",
        "reserved": true
      },
      {
        "field": "disable_safety_checker",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Disable safety checker for generated images.",
        "reserved": true
      },
      {
        "field": "images",
        "type": "uri",
        "required": false,
        "default": [],
        "description": "List of input images for image-to-image generation. Maximum 5 images. Must be jpeg, png, gif, or webp.",
        "reserved": true
      },
      {
        "field": "lora_scales",
        "type": "array",
        "required": false,
        "description": "Scales for each LoRA as a list of floats. Must match the number of lora_weights. Defaults to 1.0 for each if not provided.",
        "reserved": true
      },
      {
        "field": "lora_weights",
        "type": "array",
        "required": false,
        "description": "LoRA weights as a list of URLs. Supports ComfyUI and native Flux Klein format LoRAs. ComfyUI LoRAs are automatically converted.",
        "reserved": true
      },
      {
        "field": "output_format",
        "type": "enum",
        "required": false,
        "default": "jpg",
        "enumValues": [
          "webp",
          "jpg",
          "png"
        ],
        "description": "Format of the output images",
        "reserved": false
      },
      {
        "field": "output_megapixels",
        "type": "enum",
        "required": false,
        "default": "1",
        "enumValues": [
          "0.25",
          "0.5",
          "1",
          "2",
          "4"
        ],
        "description": "Resolution of the output image in megapixels",
        "reserved": false
      },
      {
        "field": "output_quality",
        "type": "integer",
        "required": false,
        "default": 95,
        "minimum": 0,
        "maximum": 100,
        "description": "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs.",
        "reserved": true
      },
      {
        "field": "prompt",
        "type": "string",
        "required": true,
        "description": "Text prompt for image generation.",
        "reserved": true
      },
      {
        "field": "seed",
        "type": "integer",
        "required": false,
        "description": "Random seed. Set for reproducible generation",
        "reserved": true
      }
    ]
  }'::jsonb,
  false, false, false, true, 103
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'black-forest-labs/flux-2-klein-4b-base-lora'
)
ON CONFLICT ("slug") DO NOTHING;
