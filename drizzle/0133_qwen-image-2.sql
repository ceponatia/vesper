-- Register Replicate's unified Qwen Image 2 endpoint (`qwen/qwen-image-2`) as a
-- pinned, capability-described built-in row, so the admin Image Generator can
-- select and bench it. It is a THIRD Qwen endpoint, not a rename: 2511 is the
-- instruction editor the scene lane runs and 2512 the generator arm the portrait
-- lane runs; this one publishes a single schema that does both (issue #555).
--
-- WHY A DATA MIGRATION. The ordinary route for a new endpoint is the admin add
-- path at /settings/image-models, which probes Replicate and writes the row. This
-- file exists for the other half of that: a FRESH database must come up with the
-- row already present, because `pnpm db:migrate` is what the Fly deploy runs and
-- `pnpm db:seed` never touches image models. Same reason 0098, 0104, 0107, 0110,
-- 0119 and 0132 seed and patch this catalog by hand — drizzle-kit has no schema
-- change to diff here.
--
-- PROBED 2026-09-10 from `GET /v1/models/qwen/qwen-image-2`, at version
-- 266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd. Every
-- mechanical value below is what `probeReplicateModel`
-- (packages/image-replicate/src/probe.ts) yields for that version's published
-- Input schema, and the capability record is the literal output of
-- `deriveAdvancedCapabilities` over it — not hand-typed JSON. A re-probe of an
-- unchanged schema therefore produces the same record and the admin version diff
-- stays empty. `probe.test.ts` pins the record against the same derivation, so
-- this file and that literal move together or CI says so.
--
-- BARE SLUG, PIN IN `probed_version_id`. Replicate reports `is_official: true`,
-- and `POST /models/{owner}/{name}/predictions` — the endpoint a bare slug uses —
-- is official-models-only. So the slug stays bare like `qwen/qwen-image-2512` and
-- `prunaai/p-image`, and the version pin lives in its own column.
-- `pinnedImageModelVersion` (packages/image-core/src/render-kernel/compile-profile-plan.ts)
-- returns the probed id when the slug carries no `:version`, which is exactly the
-- "runnable" gate the Image Generator's model select reads — a row without it is
-- offered disabled as "no pinned version". Backfilling the pin is what 0132 did
-- for the two Seedream rows for the same reason.
--
-- THE REFERENCE INPUT IS A SINGLE URI, and that is the one fact most likely to be
-- assumed wrong here. 2511 declares `image` as an ARRAY of URIs and takes three
-- numbered references; this endpoint declares `image` as ONE nullable URI string,
-- so the row is `reference_arity = 'single'` with `max_references = 1`. The field
-- NAME matching 2511's is a coincidence of provider naming, not shared transport.
-- `can_generate` is true because `required` lists only `prompt`, and `can_edit` is
-- true because a reference input exists at all — which says nothing about whether
-- a face survives (see the reviewed columns below).
--
-- `reference_transport = 'file'`, the default. Only Wan 2.7 needs `data:` URIs,
-- and that is learned by running a model rather than read from a schema; nothing
-- observed here says this endpoint rejects Replicate's uploaded-file URLs.
--
-- `extra_input` is EMPTY, and deliberately so. The schema declares no
-- `disable_safety_checker`, no `go_fast`, no `output_quality`, no
-- `apply_watermark` and no output-count input, so `deriveExtraInput` pins
-- nothing — Replicate rejects unknown inputs, so copying 2512's bag onto this row
-- would fail every render. `output_format` is NULL for the same reason: the
-- schema publishes no format enum. The output itself is a BARE URI STRING rather
-- than the array most of the documented models return.
--
-- REVIEWED COLUMNS ARE `unknown`, which is a statement about Vesper's evidence,
-- not about the model. Nobody has graded this endpoint's output here, so
-- `edit_kind` and `identity_preservation` both take the permissive default: the
-- row keeps working as an ordinary registered model and can be rated later, while
-- a re-probe is forbidden from overwriting either. The `operator_warning` says
-- the same thing where an operator actually sees it — the admin card and the
-- pickers — plus the two live caveats: the schema declares no safety switch, so
-- upstream moderation is unmeasured, and prompt expansion is ON by the provider's
-- own default.
--
-- NO SURFACE FLAGS AND NO PROFILE ROW, which is what makes onboarding alone
-- change no production default. `for_portrait`/`for_variant`/`for_scene` are all
-- false and this file writes no `image_model_profiles` row, so the player-facing
-- pickers — which offer profiles, not models — cannot reach it. The Image
-- Generator runs a registered row without a profile, so the admin bench gets it
-- and nothing else does. Every existing default (2512 for portraits, 2511 for
-- variant and scene) is untouched.
--
-- TWO GUARDS, and they answer different questions:
--
--   1. `WHERE NOT EXISTS` on the BASE slug. An administrator may already have
--      added this endpoint through the admin page, where the add path auto-pins
--      and could have stored it as `qwen/qwen-image-2:<version>`. That row's slug
--      is not equal to the bare one, so the unique index would not catch it and a
--      second row for one endpoint would appear in every picker. `split_part` on
--      ':' compares the provider path alone, and the comparison is equality, so
--      the sibling `qwen/qwen-image-2512` is not matched.
--   2. `ON CONFLICT ("slug") DO NOTHING` keeps the statement idempotent against
--      the bare slug itself, so a re-run beside an existing bare row is a no-op
--      rather than an error.
--
-- Neither guard can honour a DELETION. A row that no longer exists creates no
-- conflict and satisfies NOT EXISTS, so an administrator who registered this
-- endpoint by hand and then removed it before this file reached their database
-- gets the built-in row once when it does. The database records no tombstone,
-- so no predicate could tell that history from a database that never had the
-- row — and the seeded-row contract is what makes this acceptable rather than
-- a defect: seeded rows are ordinary rows (owner ruling 4), so the row is
-- deletable again exactly as it was the first time, and a migration runs once
-- per database, so a deletion made AFTER it stays deleted.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "reference_transport", "max_references", "aspect_mode", "supported_aspects", "output_format",
  "extra_input", "probed_version_id", "edit_kind", "identity_preservation", "operator_warning",
  "advanced_capabilities", "for_portrait", "for_variant", "for_scene", "builtin", "sort"
)
SELECT
  'imgmdlqwenimage2aaaaaaaa',
  -- Official, so no version pin in the slug: the pin is `probed_version_id`.
  'qwen/qwen-image-2',
  'Qwen Image 2',
  true, true, 'image', 'single', 'file', 1, 'aspect_ratio',
  -- The `aspect_ratio` enum verbatim, in the order the schema declares it. Nine
  -- shapes including a native 3:4, so the portrait lanes would need no crop.
  '["1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2"]'::jsonb,
  NULL::text,
  '{}'::jsonb,
  '266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd',
  'unknown', 'unknown',
  'Untried in Vesper: no reviewed edit kind and no identity rating yet, so it is offered on no production surface. Its schema declares no safety-checker switch, so whether the endpoint moderates upstream is unknown until a run is observed. Prompt expansion is on by the provider''s default (enable_prompt_expansion) — a raw provider input a controlled run should switch off.',
  -- `deriveAdvancedCapabilities` over the probed schema. Only `seed` and
  -- `negative_prompt` match a known control alias; the endpoint publishes no
  -- guidance, steps, strength, output-count, LoRA or fast-mode input, so those
  -- slots stay absent and nothing is sent to a field this version does not own.
  -- `output` is the contract's own default because the schema's Output is one
  -- URI. `reserved` marks the five fields the render path already writes
  -- (prompt, the aspect key, the primary reference, and the two control-bound
  -- fields), which leaves `enable_prompt_expansion` and `match_input_image` as
  -- the two raw provider inputs the Generator's Advanced section may offer —
  -- descriptors only, with no model-specific UI code anywhere.
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
      {"field":"negative_prompt","type":"string","required":false,"default":"","description":"Negative prompt to specify elements to avoid in the generated image","reserved":true},
      {"field":"prompt","type":"string","required":true,"description":"Text prompt for image generation or editing","reserved":true},
      {"field":"seed","type":"integer","required":false,"description":"Random seed for reproducible generation. Range: 0-2147483647","reserved":true}
    ]
  }'::jsonb,
  false, false, false, true, 100
WHERE NOT EXISTS (
  SELECT 1 FROM "image_models" WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-2'
)
ON CONFLICT ("slug") DO NOTHING;
