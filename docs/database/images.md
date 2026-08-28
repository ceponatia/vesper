# Image tables

Assets, the references a scene featured, the model registry and its profiles, identity packs, and
the two admin bench run records.

## Assets and references

- **`images`** — `owner_id`, `kind`
  (`avatar` / `portrait_variant` / `scene` / `entity` / `chat_upload` / `chat_look` /
  `chat_place` / `identity_face_crop` / `identity_trial_output` / `lab_control` / `lab_output` /
  `generator_output`). The chat kinds are chat-private and hard-deleted with the chat; which kinds
  are hidden derived assets, and what `HIDDEN_IMAGE_KINDS` subtracts from every user surface, is
  owned by [../images/asset-registry.md](../images/asset-registry.md). Also `entity_kind?`
  (`character`/`location`/`item` — set for `entity` images; always `character` for
  `avatar`/`portrait_variant`; app convention, not a constraint), `entity_id?`, `chat_id?` (→
  `character_chats`, SET NULL on chat delete — chat-scene keying, see
  [../images/pipelines/scene-images.md](../images/pipelines/scene-images.md)),
  `anchor_message_id?` (the assistant line a chat scene illustrates; plain text, no FK), `path`
  (relative to `data/`), `prompt`, `source_image_id?` (reference-edit lineage), `status`
  (`pending`/`ready`/`failed` — the row is written **before** the file), `meta` JSONB.
- **`image_references`** — `scene_image_id` (→ `images`, **FK-cascade**), `kind`
  (`character`/`location`/`style`/`pose`/`layout`), `entity_id?` (library character or location
  id; null for non-entity roles), `role?`, `source?`
  (`generated`/`uploaded`/`composite`/`entity`; null = unknown), `image_id?` (the reference asset
  actually fed to a provider; null when textual-only), `name`. One row per reference a scene image
  featured — the authoritative, queryable record the Gallery reads, superseding
  `images.meta.references`. `SceneVisualReference` is the render-input superset and
  `SceneReference` the Gallery projection
  (`packages/image-core/src/references/scene-reference.ts`).

## Model registry and profiles

- **`image_models`** — `slug` **unique** (the Replicate model path, optionally
  `owner/name:version`), `label`, `sort`, `builtin` (display provenance only — it does **not**
  gate deletion).
  - Probed from Replicate at save time: `can_generate`, `can_edit`, `reference_field`,
    `reference_arity`, `aspect_mode`, `supported_aspects` JSONB, `output_format?`, `extra_input`
    JSONB, `probed_version_id?` (the version those fields were read from).
  - Owner-set and **never** overwritten by a re-probe: `max_references` (no model declares
    `maxItems`), `reference_transport` (`file`/`data_url` — only found by running the model), the
    `for_portrait` / `for_variant` / `for_scene` surface toggles, and the reviewed judgments
    `edit_kind`
    (`none`/`instruction_edit`/`multi_reference_compose`/`identity_conditioned`/`img2img`/`unknown`),
    `identity_preservation` (`strong`/`moderate`/`weak`/`unknown`) and `operator_warning?`.
  - `advanced_capabilities` JSONB holds the probed control bindings, dedicated image inputs
    (`additionalImageInputs`), provider-input descriptors (`providerInputs`), and the
    `knownInputFields` allowlist, written atomically beside `probed_version_id` at create and
    re-probe; a row probed before a derivation existed keeps empty defaults until it is re-probed.

  Which models the app can run is **data, not a code union**, managed at `/settings/image-models`
  and seeded by migration ([../images/providers/registry.md](../images/providers/registry.md)).
- **`image_model_profiles`** — `image_model_id` (→ `image_models`, **FK-cascade**), `key`
  (**unique per model**), `label`, `task`
  (`portrait`/`variant`/`scene`/`item`/`location`/`chat_look`/`chat_place`/`text_repair`/`example_transform`/`image_set`),
  `operation` (`generate`/`edit`), `prompt_strategy`, `reference_policy` JSONB (allowed and
  required roles and their order), `control_defaults` JSONB (normalized controls plus a seed
  policy; never a stored numeric seed), `provider_overrides` JSONB, `timeout_ms?` (30s–15min,
  CHECK-bounded), `enabled`, `is_default`, `builtin`, `sort`. **How** a model should be used for
  one job, as opposed to what it accepts — one Seedream row can be an everyday 2K scene and a slow
  4K location. At most one enabled default per task, enforced by the partial unique index
  ([indexes.md](indexes.md)). See
  [../images/providers/profiles.md](../images/providers/profiles.md).

## Identity packs

- **`image_identity_packs`** — `character_id` (→ `characters`, **FK-cascade** — operational
  character data, which dies with the character), `revision` (**unique per character**),
  `current`, `status` (`pending`/`ready`/`unusable`/`failed`/`stale`/`superseded`),
  `source_image_id?` (→ `images`, SET NULL safety net — a null source is immediately unusable),
  `source_content_hash` (SHA-256 over the stored normalized bytes), `source_width` /
  `source_height`, `schema_version` / `derivation_version` / `policy_version`, `method?`
  (`detector`/`heuristic`/`manual`), `detector_version?`, `confidence?`, `face_crop_image_id?` (→
  `images`, SET NULL — the hidden `identity_face_crop` asset), `crop_json` / `quality_json` /
  `warning_codes_json` JSONB, `failure_code?` / `failure_message?`, `reviewed_by_user_id?` (→
  `users`, no cascade — the audit survives the reviewer), `review_reason?` / `reviewed_at?`. One
  durable identity reference per character: revisions are rows, and exactly one may be `current`
  (a partial unique index). See
  [../images/identity-packs.md](../images/identity-packs.md).
- **`image_identity_lora_bindings`** — `identity_pack_id` (→ `image_identity_packs`,
  **FK-cascade**), `lora_id` (→ `image_loras`, **FK-cascade**), `base_checkpoint`,
  `dataset_fingerprint`, `dataset_image_count`, `training_recipe_id`, `training_recipe_revision`,
  `rank` (CHECK 1–128), `trigger_token?`, `training_run_ref?`, `state`
  (`experimental`/`active`/`retired`). Which trained character LoRA came from which identity pack
  **revision**, and under what training; several bindings per pack are normal and at most one may
  be `active`. See [../images/providers/loras.md](../images/providers/loras.md).
- **`image_identity_pack_trial_runs`** — `owner_id` (→ `users`, cascade), `label`, `status`
  (`draft`/`running`/`review`/`complete`), `config_json` JSONB — the validated create-request
  snapshot, so a later registry or profile edit can never change what a finished run claims it
  tested. One bounded admin comparison of identity-reference strategies over a character ×
  profile × strategy × fixture grid; the three tables below FK-cascade with their run. See
  [../images/identity-packs.md](../images/identity-packs.md) §The fixed-trial harness.
- **`image_identity_pack_trial_cells`** — `run_id` (→ runs, **FK-cascade**), `cell_key`
  (**unique per run** — the deterministic `character:profile:fixture:strategy:variant` plan key;
  plain ascending order is the execution order), `status`
  (`planned`/`running`/`rendered`/`failed`/`refused`), `spec_json` / `result_json?` JSONB,
  `output_image_id?` (→ `images`, SET NULL — a deleted output makes the cell unreviewable, not
  invalid), `claim_token?` / `claimed_at?` — the durable execution claim (compare-and-set
  `planned` → `running` → terminal), so a restart mid-pass cannot pay the provider twice for one
  cell's evidence.
- **`image_identity_pack_trial_grades`** — `run_id` / `cell_a_id` / `cell_b_id` (all
  **FK-cascade**), `pair_id` (**unique per run** — insert-once, so a double submission fails
  loudly instead of averaging), `left_is_a` (the persisted blind left/right ↔ A/B mapping,
  unblinded only in aggregation), `grades_json` JSONB, `reviewed_by_user_id?` (→ `users`, no
  cascade — the audit survives the reviewer).
- **`image_identity_pack_trial_verdicts`** — `run_id` (**FK-cascade**), `profile_id` +
  `identity_strategy` (**unique per run** — one ruling per slot, upserted, replacing a jsonb
  verdict array whose read-modify-write let two admins ruling on different slots silently lose
  one), `verdict` (`promoted`/`retained_current`/`experimental_admin_only`/`rejected`), `reason`
  (required), `policy_version`, `override_incomplete_review` (the admin ruled before every
  reviewable pair was graded — unrecoverable once more grades arrive, so stored on the ruling),
  `decided_by_user_id` (→ `users`, no cascade, **not null** — a ruling with no actor is not an
  audit record), `decided_at`.

## Bench run records

- **`image_lab_experiments`** — the Advanced Image Lab's durable experiment record
  ([../image-lab/README.md](../image-lab/README.md)): `owner_id` (→ `users`, **FK-cascade**),
  `kind` (`control_probe` / `baseline_portrait` / `baseline_scene`, and the other registered
  kinds), `character_id?` / `chat_id?` (SET NULL), `model_slug`, `requested_version_id?` /
  `executed_version_id?`, `profile_id?` (a plain snapshot, no FK — a deleted profile must not
  erase what a finished baseline ran), `instruction` + `final_prompt`, `inputs` JSONB (the ordered
  role-tagged image list), `control_image_id?` / `result_image_id?` (→ `images`, SET NULL),
  `control_kind?`, `settings` JSONB, `status` (`pending`/`running`/`succeeded`/`failed`),
  `failure_code?`, `verdict?` + `verdict_note?` (probe kinds), `prediction_id?`, `started_at?` /
  `finished_at?`, `meta` JSONB; indexed `(owner_id, created_at)` for the lab listing.
- **`image_generator_runs`** — the Image Generator's immutable one-attempt run record
  ([../image-generator/README.md](../image-generator/README.md)): `owner_id` (→ `users`,
  **FK-cascade**), `status` (`pending`/`running`/`succeeded`/`failed`), `model_slug` (a registry
  snapshot), `requested_version_id?` (the pin, written by the runner before spend) /
  `executed_version_id?` (the provider echo), `prompt` + `final_prompt?`, `inputs` / `controls` /
  `provider_inputs` JSONB, `source_run_id?` (self-FK, SET NULL — duplicate and variant lineage),
  `result_image_id?` (→ `images`, SET NULL — the hidden `generator_output` render),
  `failure_code?` (`image_generator.*` plus verbatim shared-layer codes), `error?`,
  `prediction_id?`, `meta` JSONB (the version request, the sanitized effective request and the
  capability snapshot frozen before spend, then the attempt and result records), `started_at?` /
  `finished_at?`; indexed `(owner_id, created_at)` for the run listing. A settled run is never
  re-run; the `generator_image` job renders it, claiming the row with a conditional
  `pending → running` update so one delivery cannot be paid for twice.
