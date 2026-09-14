-- Backfill the probed capability record on the three seeded COMMUNITY rows, so a
-- fresh database renders them the way production does.
--
-- DATA ONLY — no schema change, and therefore no snapshot.
--
-- WHY. 0104 seeds NSFW FLUX Dev, LikeReality Pony v1 and SDXL PuLID with
-- `advanced_capabilities` at its column default of `{}`, and 0119's backfill
-- covered the Qwen rows only. An empty record is not neutral: it is what the
-- control mapper resolves field names through, so every one of these models'
-- REVIEWED settings — the 832x1216 portrait pair, PuLID's `cfg` of 7, the
-- cleared Pony negative — resolves to no field and is dropped, and PuLID's
-- `method`/`face_weight` overrides fail closed against an empty
-- `known_input_fields`.
--
-- That was survivable while a transitional overlay rewrote the model row at the
-- render boundary for these exact slugs. #244 removed it and made the task
-- profile the one owner of those settings, so the bindings the profile maps
-- through are now load-bearing: without this record a fresh deployment renders
-- PuLID at the wrapper's 512 square with `method: style` at four-fifths identity
-- strength, and Pony with the "nsfw, naked" negative the reviewed ruling exists
-- to clear — visible only as a recorded `no_binding` drop, after the spend.
--
-- An operator can reach the same state from /settings/image-models by re-probing
-- each row, and that stays the ordinary path. This patch exists so a fresh
-- database comes up correct without anyone remembering to, the same reason 0098,
-- 0104, 0107, 0110 and 0119 seed their data by hand.
--
-- VERIFIED 2026-09-13 against the live registry through the admin API: every
-- record below is the one production holds for that row today, transcribed
-- verbatim rather than re-derived, so this file cannot introduce a difference
-- between a fresh database and the deployment it is modelled on. `providerInputs`
-- is `[]` on all three because these rows were probed before the descriptor
-- derivation existed; that is production's state, and a re-probe is what fills
-- it in — this file does not invent one.
--
-- TWO GUARDS ON EVERY STATEMENT:
--
--   1. The row must still sit at the version this record was read from — matched
--      on `split_part(slug, ':', 1)` (`baseImageModelSlug`'s own rule, as 0110
--      uses) with the pin checked on both the slug and `probed_version_id`. A row
--      an operator has re-pinned describes some other schema, and projecting
--      today's field truth onto it is the drift pinning exists to prevent.
--   2. The row must not already carry `controls`. Only a real probe writes that
--      key, so its presence means the question has been answered with better
--      evidence than this file has — and its absence is what makes every
--      statement idempotent by construction.
--
-- `probed_version_id` is deliberately NOT written: 0104 already seeds it to the
-- exact pin each record was read from, so this file has nothing to add and uses
-- it as a guard instead. Owner-curated columns (`supported_aspects`,
-- `max_references`, `edit_kind`, `identity_preservation`, `operator_warning`)
-- are reviewed judgments no schema can state, and are untouched.

-- NSFW FLUX Dev — a bare width/height generator. No `aspect_ratio` and no `size`
-- input at all, which is why the reviewed policy states its shape as the custom
-- pair: the row's `supported_aspects` is empty and `chooseAspect` has nothing to
-- offer, so 832x1216 reaches the payload through `customWidth`/`customHeight` or
-- it does not reach it.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "customWidth": {"field":"width","type":"integer","minimum":1,"maximum":4096},
      "customHeight": {"field":"height","type":"integer","minimum":1,"maximum":4096}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "guidance_scale",
      "height",
      "prompt",
      "seed",
      "steps",
      "width"
    ],
    "providerInputs": []
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'aisha-ai-official/nsfw-flux-dev'
  AND split_part("slug", ':', 2) IN ('', 'fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa')
  AND ("probed_version_id" IS NULL OR "probed_version_id" = 'fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa')
  AND "advanced_capabilities"->'controls' IS NULL;
--> statement-breakpoint
-- LikeReality Pony v1 — the widest known-field list in the catalog (adetailer,
-- refiner and upscale families), of which the reviewed policy uses exactly two:
-- `negative_prompt`, to clear the wrapper's own "nsfw, naked" default, and the
-- width/height pair. The negative binding is what makes that clearing possible:
-- with no binding the profile's empty string reaches nothing and the provider
-- restores its own hidden default, which is the state this file exists to end.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "negativePrompt": {"field":"negative_prompt","type":"string"},
      "customWidth": {"field":"width","type":"integer","minimum":1,"maximum":4096},
      "customHeight": {"field":"height","type":"integer","minimum":1,"maximum":4096}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "adetailer_face",
      "adetailer_face_negative_prompt",
      "adetailer_face_prompt",
      "adetailer_hand",
      "adetailer_hand_negative_prompt",
      "adetailer_hand_prompt",
      "adetailer_person",
      "adetailer_person_negative_prompt",
      "adetailer_person_prompt",
      "cfg_scale",
      "clip_skip",
      "guidance_rescale",
      "height",
      "model",
      "negative_prompt",
      "pag_scale",
      "prepend_preprompt",
      "prompt",
      "refiner",
      "refiner_prompt",
      "refiner_strength",
      "scheduler",
      "seed",
      "steps",
      "upscale",
      "vae",
      "width"
    ],
    "providerInputs": []
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'aisha-ai-official/likereality-pony-v1'
  AND split_part("slug", ':', 2) IN ('', 'f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2')
  AND ("probed_version_id" IS NULL OR "probed_version_id" = 'f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2')
  AND "advanced_capabilities"->'controls' IS NULL;
--> statement-breakpoint
-- SDXL PuLID — the identity adapter, and the row with the most reviewed surface:
-- `cfg` (1-20) carries the reviewed guidance of 7, the pair (64-1536) carries
-- 832x1216, and `method`/`face_weight` ride the profile's provider overrides,
-- which fail CLOSED against an empty `known_input_fields`. Without this record a
-- fresh database runs this model at the wrapper's 512 square, `method: style`
-- and four-fifths identity strength — every likeness observation the 2026-08-29
-- ruling was made to correct.
UPDATE "image_models"
SET
  "advanced_capabilities" = '{
    "controls": {
      "seed": {"field":"seed","type":"integer"},
      "negativePrompt": {"field":"negative_prompt","type":"string"},
      "guidance": {"field":"cfg","type":"number","minimum":1,"maximum":20},
      "customWidth": {"field":"width","type":"integer","minimum":64,"maximum":1536},
      "customHeight": {"field":"height","type":"integer","minimum":64,"maximum":1536}
    },
    "additionalImageInputs": [],
    "output": {"arity":"single","supportsMultiple":false},
    "knownInputFields": [
      "cfg",
      "depth_image",
      "depth_strength",
      "face_weight",
      "height",
      "method",
      "negative_prompt",
      "prompt",
      "reference_image",
      "sampler_name",
      "scheduler",
      "seed",
      "steps",
      "width"
    ],
    "providerInputs": []
  }'::jsonb,
  "updated_at" = now()
WHERE split_part("slug", ':', 1) = 'nsfw-api/sdxl-pulid'
  AND split_part("slug", ':', 2) IN ('', '83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5')
  AND ("probed_version_id" IS NULL OR "probed_version_id" = '83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5')
  AND "advanced_capabilities"->'controls' IS NULL;
