-- Allow the `body` reference role on the Civitai Qwen Image 2.1 `variant-standard`
-- profile (#671), so a reference view's full-body images reach the dialect that
-- words them (`qwen_21_instruction_edit`) instead of being dropped by the policy.
--
-- Data only: no table shape changes, so there is no schema snapshot.
--
-- The policy 0152 seeded allows `identity` and `style`. This appends `body` to
-- `allowedRoles` and to `roleOrder` (after the two it already ranks, so nothing it
-- ranks moves); `requiredRoles` is untouched, since a body image is optional and
-- is cut to the model's capacity like any optional reference. No model-level
-- capability gates the role: the planner consults a model only for its reference
-- capacity (`max_references`, 10 on this row) and its dedicated control inputs,
-- and `body` is not a control role. Every other profile keeps its policy, and a
-- reference view rendered on one drops its body images with an info diagnostic.
--
-- GUARDS. The row is matched by its lane-bearing model (the exact slug, the hosted
-- checkpoint `3352534` and `can_edit`, as 0152 keys it), its key and task, AND the
-- exact policy 0152 wrote (jsonb equality ignores key order). An operator who has
-- edited the policy since keeps their edit, and a missing row changes nothing.
-- Replaying the file changes nothing: once applied, the policy no longer matches.
--
-- DEPLOY ORDER. Fly runs this before the new release takes traffic. An instance
-- still on the previous release cannot parse a role it does not know, so it skips
-- this one profile row as invalid until it is replaced; a variant render or
-- reference-view build started on such an instance in that window fails its row
-- before spend, and is retried from the studio.

UPDATE "image_model_profiles" AS pr
SET
  "reference_policy" = '{"allowedRoles":["identity","style","body"],"requiredRoles":["identity"],"roleOrder":["identity","style","body"]}'::jsonb,
  "updated_at" = now()
FROM "image_models" AS m
WHERE pr."image_model_id" = m."id"
  AND m."slug" = 'civitai/qwen-image-2.1'
  AND m."probed_version_id" = '3352534'
  AND m."can_edit" = true
  AND pr."key" = 'variant-standard'
  AND pr."task" = 'variant'
  AND pr."reference_policy" = '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb;
