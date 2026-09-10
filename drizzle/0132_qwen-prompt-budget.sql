-- Declare the Qwen family's ADVISORY prompt budget on the two rows Vesper runs
-- it on, so the render fitter has something to trim optional detail toward.
--
-- WHY A DATA MIGRATION. `imagePromptBudgetFromBinding`
-- (packages/image-core/src/render-intent/prompt-segments.ts) reads the budget
-- off the row's probed prompt binding, and an ABSENT budget means NO FITTING —
-- every optional claim is emitted, in canonical order. That is the correct
-- default for a limit nobody has measured, and it is why a 323-word,
-- 2021-character scene prompt reached Qwen Image Edit 2511 with every fine
-- detail in it (#544 D8). The rows were the gap, not the fitter.
--
-- WHY THE PROBE CANNOT SUPPLY IT. `deriveAdvancedCapabilities`
-- (packages/image-replicate/src/probe.ts) derives control bindings and provider
-- input descriptors from the Replicate schema, and writes NO `prompt` member at
-- all: a JSON schema states that a `prompt` field exists and what type it is,
-- never how long a prompt this model answers well to. The length guidance is
-- published prose about the model family, so it is owner-curated data — the
-- same category as `supported_aspects`, `max_references` and
-- `identity_preservation`, which 0119 deliberately left alone.
--
-- KNOWN CONSEQUENCE, recorded rather than worked around: because the probe does
-- not derive `prompt`, re-pinning either row through /settings/image-models
-- (`activateCandidateVersion` → `imageModelReprobeFields`) REPLACES
-- `advanced_capabilities` wholesale and drops this budget. That is a real gap in
-- the probe path, not something a migration can close; it is noted on #544 so
-- the seam gets an owner.
--
-- THE NUMBER. 1300 characters is a VESPER ADVISORY: set from the Qwen-Image
-- family's broader published prompt guidance and tuned against graded trials,
-- not a length either endpoint prescribes. The ~200-word figure that circulates
-- for this family is what the 2512 text-to-image prompt-rewriting helper aims
-- its rewrites at; the image-edit guidance asks for direct, specific
-- instructions and preservation clarity and states no length at all (issue #544,
-- owner report and GPT review of 2026-09-10). It is written as
-- `recommendedChars` and NOT as `maxChars`, and the distinction is the whole
-- point of the two fields: `maxChars` is a provider ceiling whose breach is an
-- error, and it is the only limit allowed to compress a MANDATORY segment.
-- Provider guidance is not a ceiling — going over it degrades quality, it does
-- not fail the call — so it may only pull OPTIONAL material down. Vesper has
-- measured no ceiling for either endpoint (#243 owns measured budgets), so
-- neither row gets one.
--
-- THREE GUARDS ON EACH STATEMENT:
--
--   1. The row must still sit at a provider version this file can speak for —
--      0118's and 0119's rule. The prompt FIELD NAME is schema truth, and a row
--      an operator re-pinned since may name it something else; that row is left
--      to its own probe.
--   2. `advanced_capabilities` must be a JSON object, so a row holding some
--      other JSON shape is skipped rather than erroring the migration.
--   3. `recommendedChars` must not already be set. That makes the statement
--      idempotent by construction and means an administrator who curated a
--      different number keeps it.
--
-- The write is a MERGE, not a replacement: `||` at the top level replaces only
-- the `prompt` member, and the inner `||` adds only `recommendedChars` to
-- whatever prompt binding is already there. `controls`, `providerInputs`,
-- `knownInputFields`, `output` and `additionalImageInputs` are untouched, and a
-- `maxChars` somebody measured later survives this file running again.
--
-- Qwen Image Edit 2511 — the chat scene lane's instruction editor, and the
-- endpoint #544 measured.
UPDATE "image_models"
SET
  "advanced_capabilities" =
    "advanced_capabilities"
    || jsonb_build_object(
      'prompt',
      COALESCE("advanced_capabilities"->'prompt', '{"field":"prompt"}'::jsonb)
        || '{"recommendedChars":1300}'::jsonb
    ),
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-edit-2511'
  -- The version 0118, 0119 and docs/image-models/models/qwen-image-edit-2511.md
  -- record the row at, and the second version 0119 already accepted for it.
  AND (
    "probed_version_id" IS NULL
    OR "probed_version_id" = 'a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729'
    OR "probed_version_id" = '4e2f23e2ebd73b51d0659cb0c2252a77347bfa278ca69b5faf4cc63c0171e6fc'
  )
  AND jsonb_typeof("advanced_capabilities") = 'object'
  AND "advanced_capabilities"->'prompt'->'recommendedChars' IS NULL;
--> statement-breakpoint
-- Qwen Image 2512 — the generator arm of the same family, which the guidance is
-- written about. It follows 2511 rather than waiting for its own trial: the
-- budget only ever trims OPTIONAL claims and reports the trim in provenance, so
-- the worst case on an untried endpoint is a shorter prompt that provenance
-- explains, and leaving one arm of a family unbudgeted is how the two lanes
-- start disagreeing about what a Qwen prompt looks like.
UPDATE "image_models"
SET
  "advanced_capabilities" =
    "advanced_capabilities"
    || jsonb_build_object(
      'prompt',
      COALESCE("advanced_capabilities"->'prompt', '{"field":"prompt"}'::jsonb)
        || '{"recommendedChars":1300}'::jsonb
    ),
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'qwen/qwen-image-2512'
  -- The version docs/image-models/models/qwen-image-2512.md records the row at,
  -- and the second version 0119 already accepted for it.
  AND (
    "probed_version_id" IS NULL
    OR "probed_version_id" = '47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6'
    OR "probed_version_id" = '9eb53ec91c15dda5adac7688b9762e0be703f01ba1e49bbe6be7cdf7680de5d3'
  )
  AND jsonb_typeof("advanced_capabilities") = 'object'
  AND "advanced_capabilities"->'prompt'->'recommendedChars' IS NULL;
--> statement-breakpoint
-- Seedream admin Image Generator activation (owner request 2026-09-10).
--
-- These two built-in rows are ALREADY Replicate models; 0098 retired the old
-- Venice path and seeded `bytedance/seedream-4.5` and
-- `bytedance/seedream-5-lite`. What the later capability work never backfilled
-- was `probed_version_id`, so controlled benches such as the Image Generator
-- correctly show "no pinned version" and refuse to spend against a floating
-- provider revision.
--
-- Both version ids below are the exact Replicate versions recorded by the model
-- pages from the 2026-08-05 probes. Their schemas still expose the documented
-- prompt + 1-14 `image_input` reference workflow. The capability record is
-- backfilled only when the old seeded row still has the inert `{}` value; an
-- administrator's non-empty capability record is preserved. The pin itself is
-- written only to the exact seeded id+slug while it is still null, so a later
-- manual re-pin is never overwritten.
--
-- Seedream 4.5. Besides making the row selectable, the backfill exposes its
-- actual size/custom-dimension controls to the capability-driven Generator.
UPDATE "image_models"
SET
  "probed_version_id" = '9fe3b8282dcb9d9063b05e33210a1432801f7c5a6641db944baefcec4886761a',
  "advanced_capabilities" = CASE
    WHEN "advanced_capabilities" = '{}'::jsonb THEN '{
      "controls": {
        "outputCount": {"field":"max_images","type":"integer","minimum":1,"maximum":15},
        "sequentialMode": {"field":"sequential_image_generation","type":"enum","enumValues":["disabled","auto"]},
        "customWidth": {"field":"width","type":"integer","minimum":1024,"maximum":4096},
        "customHeight": {"field":"height","type":"integer","minimum":1024,"maximum":4096},
        "resolutionTier": {"field":"size","type":"enum","enumValues":["2K","4K","custom"]}
      },
      "additionalImageInputs": [],
      "output": {"arity":"single","supportsMultiple":false},
      "knownInputFields": [
        "aspect_ratio",
        "disable_safety_checker",
        "height",
        "image_input",
        "max_images",
        "prompt",
        "sequential_image_generation",
        "size",
        "width"
      ],
      "providerInputs": [
        {"field":"aspect_ratio","type":"enum","required":false,"default":"match_input_image","enumValues":["match_input_image","1:1","4:3","3:4","4:5","5:4","16:9","9:16","3:2","2:3","21:9","9:21"],"reserved":true},
        {"field":"disable_safety_checker","type":"boolean","required":false,"default":false,"reserved":true},
        {"field":"height","type":"integer","required":false,"default":2048,"minimum":1024,"maximum":4096,"reserved":true},
        {"field":"image_input","type":"uri","required":false,"default":[],"reserved":true},
        {"field":"max_images","type":"integer","required":false,"default":1,"minimum":1,"maximum":15,"reserved":true},
        {"field":"prompt","type":"string","required":true,"reserved":true},
        {"field":"sequential_image_generation","type":"enum","required":false,"default":"disabled","enumValues":["disabled","auto"],"reserved":true},
        {"field":"size","type":"enum","required":false,"default":"2K","enumValues":["2K","4K","custom"],"reserved":true},
        {"field":"width","type":"integer","required":false,"default":2048,"minimum":1024,"maximum":4096,"reserved":true}
      ]
    }'::jsonb
    ELSE "advanced_capabilities"
  END,
  "updated_at" = now()
WHERE "id" = 'imgmdlseedream45aaaaaaaa'
  AND "slug" = 'bytedance/seedream-4.5'
  AND "probed_version_id" IS NULL;
--> statement-breakpoint
-- Seedream 5 Lite. Its schema has no safety-checker switch and no custom size;
-- the only raw provider field not owned by the normalized render plumbing is
-- `output_format`, so the Generator may expose PNG/JPEG through Advanced.
UPDATE "image_models"
SET
  "probed_version_id" = 'eeb2857d94c49a5bcbc9d6c6057416e1d3b1a2735a16e08e4def9bf7ee22ec71',
  "advanced_capabilities" = CASE
    WHEN "advanced_capabilities" = '{}'::jsonb THEN '{
      "controls": {
        "outputCount": {"field":"max_images","type":"integer","minimum":1,"maximum":15},
        "sequentialMode": {"field":"sequential_image_generation","type":"enum","enumValues":["disabled","auto"]},
        "resolutionTier": {"field":"size","type":"enum","enumValues":["2K","3K"]}
      },
      "additionalImageInputs": [],
      "output": {"arity":"single","supportsMultiple":false},
      "knownInputFields": [
        "aspect_ratio",
        "image_input",
        "max_images",
        "output_format",
        "prompt",
        "sequential_image_generation",
        "size"
      ],
      "providerInputs": [
        {"field":"aspect_ratio","type":"enum","required":false,"default":"match_input_image","enumValues":["match_input_image","1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9"],"reserved":true},
        {"field":"image_input","type":"uri","required":false,"default":[],"reserved":true},
        {"field":"max_images","type":"integer","required":false,"default":1,"minimum":1,"maximum":15,"reserved":true},
        {"field":"output_format","type":"enum","required":false,"default":"png","enumValues":["png","jpeg"],"reserved":false},
        {"field":"prompt","type":"string","required":true,"reserved":true},
        {"field":"sequential_image_generation","type":"enum","required":false,"default":"disabled","enumValues":["disabled","auto"],"reserved":true},
        {"field":"size","type":"enum","required":false,"default":"2K","enumValues":["2K","3K"],"reserved":true}
      ]
    }'::jsonb
    ELSE "advanced_capabilities"
  END,
  "updated_at" = now()
WHERE "id" = 'imgmdlseedream5liteaaaaa'
  AND "slug" = 'bytedance/seedream-5-lite'
  AND "probed_version_id" IS NULL;
