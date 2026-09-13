-- Register Replicate's open-weight FLUX.1 Kontext (`black-forest-labs/flux-kontext-dev`)
-- as a pinned, capability-described built-in row, so the admin Image Generator can
-- select and bench it (issue #574).
--
-- WHY A DATA MIGRATION. The ordinary route for a new endpoint is the admin add
-- path at /settings/image-models, which probes Replicate and writes the row. This
-- file exists for the other half of that: a FRESH database must come up with the
-- row already present, because `pnpm db:migrate` is what the Fly deploy runs and
-- `pnpm db:seed` never touches image models. Same reason 0098, 0104, 0107, 0110,
-- 0119, 0132, 0133, 0134, 0136, 0137 and 0138 seed and patch this catalog by hand
-- — drizzle-kit has no schema change to diff here, so this migration carries no
-- snapshot.
--
-- PROBED 2026-09-13 from `GET /v1/models/black-forest-labs/flux-kontext-dev`, at
-- the version named below. Every mechanical value is what `probeReplicateModel`
-- (packages/image-replicate/src/probe.ts) yields for that version's published
-- Input schema, and the capability record is the literal output of
-- `deriveAdvancedCapabilities` over it — not hand-typed JSON. A re-probe of an
-- unchanged schema therefore produces the same record and the admin version diff
-- stays empty. `probe.test.ts` pins the record against the same derivation from
-- the same captured schema, so this file and that literal move together or CI
-- says so. Evidence state: `documented` — read from the provider's published
-- schema. NO PAID TRIAL HAS BEEN RUN against this endpoint, and nothing below
-- claims otherwise.
--
-- IT IS NONE OF ITS THREE NEIGHBOURS, and the schemas say so rather than the
-- names. `black-forest-labs/flux-kontext-dev-lora` is a SEPARATE endpoint that
-- declares `lora_weights`, `lora_strength` and `megapixels`; this one declares
-- none of them, so a row that inherited the LoRA sibling's bindings would post
-- inputs this version rejects. `flux-kontext-pro` and `flux-kontext-max` are
-- hosted BFL API calls whose only moderation input is a `safety_tolerance` dial,
-- where this one exposes a real `disable_safety_checker`. `black-forest-labs/flux-dev`
-- is a different model whose reference input is strength-based repainting. None
-- of the three is registered by this file, and none inherits anything from this
-- row — the adapter registry keys on the exact base slug.
--
-- LABEL IS CURATED, EVERYTHING ELSE IS DERIVED. The probe's own label would be
-- "Flux Kontext Dev"; the row carries the publisher's capitalisation instead.
-- That creates no version diff: `label` sits outside `imageModelReprobeFields`
-- (apps/web/src/server/images/identity-trial-model-versions.ts), so a re-probe
-- never rewrites it.
--
-- BARE SLUG, PIN IN `probed_version_id`. Replicate reports `is_official: true`,
-- and `POST /models/{owner}/{name}/predictions` — the endpoint a bare slug uses —
-- is official-models-only. So the slug stays bare like `qwen/qwen-image-2` and
-- the three klein rows, and the version pin lives in its own column.
-- `pinnedImageModelVersion`
-- (packages/image-core/src/render-kernel/compile-profile-plan.ts) returns the
-- probed id when the slug carries no `:version`, which is exactly the "runnable"
-- gate the Image Generator's model select reads — a row without it is offered
-- disabled as "no pinned version". `GET …/versions` returns 404 for this model,
-- as it does for every official one, so the id below is `latest_version.id` read
-- from the model record itself.
--
-- THE ROW IS EDIT-ONLY, and that is derived rather than flagged. The Input
-- schema's `required` set is `["prompt", "input_image"]`, so `canGenerate` is
-- FALSE: there is no prompt-only mode, every render needs one source image, and
-- the row can never appear in a picker that asks a model to make an image from
-- nothing. `can_edit` is true because a reference input exists at all — which
-- says nothing about whether a face survives (see the reviewed columns below).
--
-- THE REFERENCE INPUT IS ONE URI NAMED `input_image`, resolved BY NAME. The
-- field joins the probe's preferred-reference list in the same change as this
-- file: before it, a Kontext-shaped schema resolved only through the
-- unnamed-field fallback scan, which takes the first URI-typed property it has
-- no name for — correct on today's property order, and decided by that order
-- rather than by the name, so a URI input added ahead of it in a later version
-- would silently take over the reference slot on the next re-probe.
-- `reference_arity` is `single` with `max_references` 1: the schema declares one
-- URI string, not a list, so a payload that wrapped the reference in an array
-- would be malformed.
--
-- `reference_transport = 'file'`, the default, and whether THIS wrapper accepts
-- Replicate's uploaded-file URLs is UNKNOWN until a run. Two registered rows
-- reject them — Wan 2.7 Image Pro and, as of 0138, Qwen Image 2 — because their
-- wrappers validate the file extension of what reaches the model container and
-- an upload arrives there without one. Nothing in a schema reveals that, and
-- nothing observed here says this endpoint behaves either way. If it fails the
-- same way, the fix is the owner-set `reference_transport` column, exactly as
-- 0138 was, and never a probe change.
--
-- `supported_aspects` IS ELEVEN VALUES, NOT TWELVE. The `aspect_ratio` enum's
-- twelfth member, `match_input_image`, is a provider SENTINEL meaning "copy the
-- input image's proportions" — it is not a ratio, `parseAspectValue` returns null
-- for it, and `deriveAspect` therefore drops it. Storing it would let
-- `chooseAspect` pick a value that is not a shape. It stays in the `aspect_ratio`
-- DESCRIPTOR's `enumValues` below, because a descriptor describes the provider's
-- accepted set rather than Vesper's usable subset — and here the sentinel is also
-- the provider's own DEFAULT, so a render that names no shape gets the source
-- image's proportions.
--
-- `output_format = 'webp'` MATCHES the provider's default here, unlike the klein
-- rows, whose schemas default to `jpg`. `deriveOutputFormat` prefers `webp`
-- wherever the enum offers it; this schema already defaults there, so the column
-- and the descriptor agree rather than disagreeing.
--
-- `extra_input` PINS ONLY DECLARED KEYS. `disable_safety_checker` and
-- `output_quality: 95` are both declared and both pinned; `go_fast` is NOT
-- declared by this version and is therefore absent, because Replicate rejects
-- unknown inputs and copying a sibling's bag onto this row would fail every
-- render. The stored `output_quality: 95` deliberately overrides the schema's own
-- default of 80, which is why the descriptor below records 80 while the column
-- records 95 — the two disagreeing is correct, not a transcription error.
-- `disable_safety_checker`'s stored `true` is a placeholder the transport
-- overwrites with the deployment's own `safetyCheckerDisabled` posture
-- (packages/image-replicate/src/payload.ts); a database row cannot switch safety
-- enforcement, and no per-run bypass exists.
--
-- THE WEIGHTS LICENCE IS NOT THE HOSTED-USE TERM, and the operator warning keeps
-- them apart. The FLUX.1 [dev] Non-Commercial License covers the WEIGHTS, and its
-- definition names FLUX.1 Kontext [dev] explicitly; commercial use of what
-- Replicate's hosted endpoint renders rests on Replicate's own published terms
-- instead. Vesper calls the hosted endpoint and nothing else. Registering this
-- row is not a licence to self-host or fine-tune these weights.
--
-- REVIEWED COLUMNS ARE `unknown`, which is a statement about Vesper's evidence,
-- not about the model. Nobody has graded this endpoint's output here, so
-- `edit_kind` and `identity_preservation` both take the permissive default: the
-- row keeps working as an ordinary registered model and can be rated later, while
-- a re-probe is forbidden from overwriting either. The `operator_warning` says
-- the same where an operator actually sees it — the admin card and the pickers.
--
-- NO SURFACE FLAGS AND NO PROFILE ROW, which is what makes onboarding alone
-- change no production default. `for_portrait`/`for_variant`/`for_scene` are all
-- false and this file writes no `image_model_profiles` row, so the player-facing
-- pickers — which offer profiles, not models — cannot reach it. The Image
-- Generator runs a registered row without a profile, so the admin bench gets it
-- and nothing else does. Every existing default is untouched.
--
-- THE LIVE CATALOG WAS READ BEFORE THIS FILE WAS WRITTEN (2026-09-13, read-only):
-- no row exists whose provider path begins `black-forest-labs/flux-kontext`. So
-- this is a guarded INSERT and nothing else — there is no stale row to correct,
-- and this file contains no UPDATE.
--
-- TWO GUARDS, and they answer different questions:
--
--   1. `WHERE NOT EXISTS` on the BASE slug. An administrator may already have
--      added this endpoint through the admin page, where the add path auto-pins
--      and could have stored it as `black-forest-labs/flux-kontext-dev:<version>`.
--      That row's slug is not equal to the bare one, so the unique index would
--      not catch it and a second row for one endpoint would appear in every
--      picker. `split_part` on ':' compares the provider path alone, and the
--      comparison is EQUALITY, so `flux-kontext-dev-lora`, `flux-kontext-pro`,
--      `flux-kontext-max`, `flux-dev` and the three klein rows are never matched.
--   2. `ON CONFLICT ("slug") DO NOTHING` keeps the statement idempotent against
--      the bare slug itself, so a re-run beside an existing bare row is a no-op
--      rather than an error.
--
-- Neither guard REPAIRS a pre-existing row, and that is deliberate. A hand-added
-- row that is stale — probed at an older version, or carrying a reference field
-- resolved before `input_image` was a preferred name — satisfies NOT EXISTS and
-- is left exactly as it is. That preserves operator curation, which is the point,
-- but it means a no-op insert is NOT a fix: an operator who finds a stale Kontext
-- row must re-probe it from /settings/image-models (or activate the version named
-- below) so its capability record is read from the version its renders will run.
--
-- Neither guard can honour a DELETION. A row that no longer exists creates no
-- conflict and satisfies NOT EXISTS, so an administrator who registered this
-- endpoint by hand and then removed it before this file reached their database
-- gets the built-in row once when it does. The database records no tombstone, so
-- no predicate could tell that history from a database that never had the row —
-- and the seeded-row contract is what makes this acceptable rather than a defect:
-- seeded rows are ordinary rows (owner ruling 4, recorded on 0108), so the row is
-- deletable again exactly as it was the first time, and a migration runs once per
-- database, so a deletion made AFTER it stays deleted.

-- FLUX.1 Kontext Dev
--   The open-weight Kontext: one required source image, no LoRA input, a real
--   safety-checker switch.
--   Probed at version 85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlfluxkontextdevaaaa',
  -- Official, so no version pin in the slug: the pin is `probed_version_id`.
  'black-forest-labs/flux-kontext-dev',
  -- Curated label; the probe's own would be "Flux Kontext Dev".
  'FLUX.1 Kontext Dev',
  -- `can_generate` FALSE: `input_image` is in the schema's `required` set.
  false, true, 'input_image', 'single', 'file', 1, 'aspect_ratio',
  -- The `aspect_ratio` enum in schema order, `match_input_image` dropped.
  -- Eleven shapes including a native 3:4.
  '["1:1","16:9","21:9","3:2","2:3","4:5","5:4","3:4","4:3","9:16","9:21"]'::jsonb,
  -- Also the schema's own default here, unlike the klein rows.
  'webp',
  '{"disable_safety_checker":true,"output_quality":95}'::jsonb,
  '85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59',
  'unknown', 'unknown',
  'Untried in Vesper: no reviewed edit kind and no identity rating yet, so it is offered on no production surface and reaches only the admin Image Generator. It is edit-only — the source image (input_image) is required, so every render needs one reference and there is no prompt-only mode. The schema declares disable_safety_checker, so the deployment''s own safety setting decides it; that switch removes this wrapper''s own NSFW classifier, and nothing observed here says whether a further check runs upstream of it. The open weights are published under Black Forest Labs'' FLUX.1 [dev] non-commercial licence, while commercial use of what this hosted endpoint renders rests on Replicate''s own terms instead — registering this row is not a licence to self-host or fine-tune these weights.',
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
        "minimum": 0,
        "maximum": 10
      },
      "steps": {
        "field": "num_inference_steps",
        "type": "integer",
        "minimum": 4,
        "maximum": 50
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
      "guidance",
      "input_image",
      "num_inference_steps",
      "output_format",
      "output_quality",
      "prompt",
      "seed"
    ],
    "providerInputs": [
      {
        "field": "aspect_ratio",
        "type": "enum",
        "required": false,
        "default": "match_input_image",
        "enumValues": [
          "1:1",
          "16:9",
          "21:9",
          "3:2",
          "2:3",
          "4:5",
          "5:4",
          "3:4",
          "4:3",
          "9:16",
          "9:21",
          "match_input_image"
        ],
        "description": "Aspect ratio of the generated image. Use ''match_input_image'' to match the aspect ratio of the input image.",
        "reserved": true
      },
      {
        "field": "disable_safety_checker",
        "type": "boolean",
        "required": false,
        "default": false,
        "description": "Disable NSFW safety checker",
        "reserved": true
      },
      {
        "field": "guidance",
        "type": "number",
        "required": false,
        "default": 2.5,
        "minimum": 0,
        "maximum": 10,
        "description": "Guidance scale for generation",
        "reserved": true
      },
      {
        "field": "input_image",
        "type": "uri",
        "required": true,
        "description": "Image to use as reference. Must be jpeg, png, gif, or webp.",
        "reserved": true
      },
      {
        "field": "num_inference_steps",
        "type": "integer",
        "required": false,
        "default": 30,
        "minimum": 4,
        "maximum": 50,
        "description": "Number of inference steps",
        "reserved": true
      },
      {
        "field": "output_format",
        "type": "enum",
        "required": false,
        "default": "webp",
        "enumValues": [
          "webp",
          "jpg",
          "png"
        ],
        "description": "Output image format",
        "reserved": false
      },
      {
        "field": "output_quality",
        "type": "integer",
        "required": false,
        "default": 80,
        "minimum": 0,
        "maximum": 100,
        "description": "Quality when saving the output images, from 0 to 100. 100 is best quality, 0 is lowest quality. Not relevant for .png outputs",
        "reserved": true
      },
      {
        "field": "prompt",
        "type": "string",
        "required": true,
        "description": "Text description of what you want to generate, or the instruction on how to edit the given image.",
        "reserved": true
      },
      {
        "field": "seed",
        "type": "integer",
        "required": false,
        "description": "Random seed for reproducible generation. Leave blank for random.",
        "reserved": true
      }
    ]
  }'::jsonb,
  false, false, false, true, 104
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'black-forest-labs/flux-kontext-dev'
)
ON CONFLICT ("slug") DO NOTHING;
