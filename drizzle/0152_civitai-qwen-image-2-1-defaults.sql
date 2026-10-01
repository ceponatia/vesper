-- Make Civitai's Qwen Image 2.1 the global default for the `variant` task
-- (reference views and portrait variants share it) and the `scene` task.
--
-- Owner ruling 2026-10-01: the owner's bench renders on `civitai/qwen-image-2.1`
-- (raw prompts and reference edits) stand in for the graded comparison, and the
-- model becomes the variant and scene default. Every other variant and scene
-- profile stays enabled and selectable; only `is_default` moves.
--
-- Data only: no table shape changes, so there is no schema snapshot.
--
-- THE MODEL ROW. The reviewed ratings from that verdict: `edit_kind`
-- `multi_reference_compose` (one checkpoint composes one to ten references) and
-- `identity_preservation` `strong`. Both pass the identity-critical screen
-- `profileEligibility` applies to variant and scene work. `for_variant` and
-- `for_scene` open the two legacy surfaces the profiles below are offered
-- through; `for_portrait` is left as it stands. The operator warning, which the
-- profile pickers show before use, drops the bench-only claim 0151 wrote and
-- keeps the one live provider limit: Civitai has enabled no Qwen 2.1 LoRA, so
-- this row renders without one.
--
-- THE ASPECT DESCRIPTOR. 0151 described the `aspect_ratio` provider input as
-- refusing a chosen shape on an edit. A 2.1 edit sends no shape — the provider
-- sizes it from the reference — and Vesper crops the result to the chosen ratio,
-- so the descriptor the Image Generator shows as hint copy says that instead.
-- Only that one description changes: the rewrite keeps every other descriptor
-- and the list's order, and applies only while the row still carries 0151's
-- exact text.
--
-- THE TWO PROFILES. Key, task, operation and strategy are the coordinates the
-- prompt binding table matches (`variant-standard` / variant / edit /
-- instruction_edit and `scene-standard` / scene / edit / instruction_edit), and
-- each reference policy is the one the previous default carried. `control_defaults`
-- states only the 1K tier (owner ruling 2026-09-11: edit, reference-view and scene
-- production defaults run at 1K). Every sampling control is left blank, which the
-- lane resolves to the model's official recipe (cfgScale 1, 40 steps, euler,
-- simple — `resolveCivitaiQwen21Sampling`); no `aspectRatio` is stated, so the
-- lane's own target shape applies; no provider override is needed; the seed
-- policy is the default `random`.
--
-- `timeout_ms` is the profile ceiling, 900 s. A Civitai budget is spent mostly on
-- QUEUE time, and abandoning the poll neither cancels nor refunds the workflow
-- (docs/image-models/models/civitai-flux-2-klein-4b.md §Execution and
-- diagnostics): a five-minute budget discarded a billed image that finished at
-- 390 s. A production render already falls back to the Civitai transport's own
-- 900 s when a profile states null, but the plans the image lab and the identity
-- trial compile turn null into five minutes; stating the ceiling on the row gives
-- every caller the same deadline.
--
-- `sort` 0 lists both rows first in their task's picker, ahead of the previous
-- defaults (variant 1, scene 2).
--
-- GUARDS. Every statement keys on the lane-bearing row: the exact slug, the
-- hosted checkpoint `3352534` (the only stored version `civitaiLaneFor` gives a
-- transport lane) and `can_edit`. Where no such row exists — deleted, or
-- re-pinned to a version with no lane — nothing below changes, the current
-- defaults included, so a missing row can never leave variant or scene without a
-- default. The partial unique index `image_model_profiles_default_per_task`
-- admits one enabled default per task, so the other defaults are cleared before
-- the two rows are promoted; the migrator runs every statement in one
-- transaction. The clear works on whichever row holds the default, not on a row
-- this file expects, and it skips the two rows this file owns; each write
-- applies only where a column differs, so replaying the file changes nothing,
-- timestamps included.

WITH reviewed ("edit_kind", "identity_preservation", "operator_warning") AS (
  VALUES (
    'multi_reference_compose',
    'strong',
    'Civitai had enabled generation for no Qwen 2.1 LoRA as of 2026-09-30, so the provider refuses a LoRA selection at the free preflight: renders on this row run without one, and the combined curated-LoRA + reference result is unverified. Only a LoRA whose Civitai baseModel is "Qwen 2.1" is sent.'
  )
)
UPDATE "image_models"
SET
  "edit_kind" = reviewed."edit_kind",
  "identity_preservation" = reviewed."identity_preservation",
  "operator_warning" = reviewed."operator_warning",
  "for_variant" = true,
  "for_scene" = true,
  "updated_at" = now()
FROM reviewed
WHERE "image_models"."slug" = 'civitai/qwen-image-2.1'
  AND "image_models"."probed_version_id" = '3352534'
  AND "image_models"."can_edit" = true
  AND (
    "image_models"."edit_kind", "image_models"."identity_preservation", "image_models"."operator_warning",
    "image_models"."for_variant", "image_models"."for_scene"
  ) IS DISTINCT FROM (
    reviewed."edit_kind", reviewed."identity_preservation", reviewed."operator_warning", true, true
  );
--> statement-breakpoint

UPDATE "image_models"
SET
  "advanced_capabilities" = jsonb_set(
    "advanced_capabilities",
    '{providerInputs}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN descriptor."item" ->> 'field' = 'aspect_ratio'
            AND descriptor."item" ->> 'description' = 'Sizes a create. On an edit the provider sizes from the reference, and a chosen shape is refused rather than ignored.'
            THEN jsonb_set(
              descriptor."item",
              '{description}',
              to_jsonb('Sizes a create. On an edit the provider sizes from the reference; Vesper sends no shape and crops the result to the chosen ratio.'::text)
            )
          ELSE descriptor."item"
        END
        ORDER BY descriptor."ord"
      )
      FROM jsonb_array_elements("image_models"."advanced_capabilities" -> 'providerInputs')
        WITH ORDINALITY AS descriptor ("item", "ord")
    )
  ),
  "updated_at" = now()
WHERE "slug" = 'civitai/qwen-image-2.1'
  AND "probed_version_id" = '3352534'
  AND "can_edit" = true
  AND "advanced_capabilities" @> '{"providerInputs":[{"field":"aspect_ratio","description":"Sizes a create. On an edit the provider sizes from the reference, and a chosen shape is refused rather than ignored."}]}'::jsonb;
--> statement-breakpoint

UPDATE "image_model_profiles" AS pr
SET "is_default" = false, "updated_at" = now()
FROM "image_models" AS m
WHERE m."slug" = 'civitai/qwen-image-2.1'
  AND m."probed_version_id" = '3352534'
  AND m."can_edit" = true
  AND pr."task" IN ('variant', 'scene')
  AND pr."is_default" = true
  AND NOT (
    pr."image_model_id" = m."id"
    AND (pr."task", pr."key") IN (('variant', 'variant-standard'), ('scene', 'scene-standard'))
  );
--> statement-breakpoint

WITH chosen AS (
  SELECT "id"
  FROM "image_models"
  WHERE "slug" = 'civitai/qwen-image-2.1'
    AND "probed_version_id" = '3352534'
    AND "can_edit" = true
), profiles ("id", "key", "label", "task", "reference_policy") AS (VALUES
  ('imgprfcivqwen21variantaa', 'variant-standard', 'Qwen Image 2.1 Variant (Civitai)', 'variant',
   '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb),
  ('imgprfcivqwen21sceneaaaa', 'scene-standard', 'Qwen Image 2.1 Scene (Civitai)', 'scene',
   '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb)
)
INSERT INTO "image_model_profiles" AS stored (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT
  p."id", chosen."id", p."key", p."label", p."task", 'edit', 'instruction_edit',
  p."reference_policy", '{"resolution":"1K"}'::jsonb, '{}'::jsonb, 900000,
  true, true, true, 0
FROM profiles p CROSS JOIN chosen
ON CONFLICT ("image_model_id", "key") DO UPDATE SET
  "label" = EXCLUDED."label",
  "task" = EXCLUDED."task",
  "operation" = EXCLUDED."operation",
  "prompt_strategy" = EXCLUDED."prompt_strategy",
  "reference_policy" = EXCLUDED."reference_policy",
  "control_defaults" = EXCLUDED."control_defaults",
  "provider_overrides" = EXCLUDED."provider_overrides",
  "timeout_ms" = EXCLUDED."timeout_ms",
  "enabled" = EXCLUDED."enabled",
  "is_default" = EXCLUDED."is_default",
  "builtin" = EXCLUDED."builtin",
  "sort" = EXCLUDED."sort",
  "updated_at" = now()
WHERE (
  stored."label", stored."task", stored."operation", stored."prompt_strategy",
  stored."reference_policy", stored."control_defaults", stored."provider_overrides",
  stored."timeout_ms", stored."enabled", stored."is_default", stored."builtin", stored."sort"
) IS DISTINCT FROM (
  EXCLUDED."label", EXCLUDED."task", EXCLUDED."operation", EXCLUDED."prompt_strategy",
  EXCLUDED."reference_policy", EXCLUDED."control_defaults", EXCLUDED."provider_overrides",
  EXCLUDED."timeout_ms", EXCLUDED."enabled", EXCLUDED."is_default", EXCLUDED."builtin", EXCLUDED."sort"
);
