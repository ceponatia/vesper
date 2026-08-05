CREATE TABLE "image_model_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"image_model_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"task" text NOT NULL,
	"operation" text NOT NULL,
	"prompt_strategy" text NOT NULL,
	"reference_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"control_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_ms" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_model_profiles_timeout_bounds" CHECK ("image_model_profiles"."timeout_ms" is null or ("image_model_profiles"."timeout_ms" >= 30000 AND "image_model_profiles"."timeout_ms" <= 900000))
);
--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "probed_version_id" text;--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "edit_kind" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "identity_preservation" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "operator_warning" text;--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "advanced_capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "image_models" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "image_model_profiles" ADD CONSTRAINT "image_model_profiles_image_model_id_image_models_id_fk" FOREIGN KEY ("image_model_id") REFERENCES "public"."image_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "image_model_profiles_model_key_unique" ON "image_model_profiles" USING btree ("image_model_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "image_model_profiles_default_per_task" ON "image_model_profiles" USING btree ("task") WHERE is_default and enabled;--> statement-breakpoint
--
-- Record the reviewed capability ratings on the six seeded models and seed the 17
-- built-in task profiles (image-model-capabilities.spec.md §"Extensions to
-- `image_models`", §`image_model_profiles`).
--
-- Hand-appended to the generated migration on purpose, for exactly the reason
-- 0098's model seed was: `pnpm db:migrate` is what the Fly deploy runs, so a FRESH
-- database must come up with a rated registry and a working profile set, and
-- `pnpm db:seed` never touches image models at all. Preserve this block if 0100 is
-- ever regenerated.
--
-- ON CONFLICT DO NOTHING keeps the insert idempotent across promotions AND keeps it
-- from resurrecting a row the owner deliberately deleted (owner ruling 4: seeded
-- rows are ordinary rows). No conflict target: the bare form covers both the
-- composite (model, key) unique and the partial one-default-per-task index, which a
-- named target could not do in one statement.
--
-- Nothing below changes a rendered image. Every profile describes what its lane
-- resolves TODAY, and no lane calls the profile layer yet.
--
-- The ratings are an UPDATE rather than part of a fresh INSERT because 0098 already
-- seeded these rows on every existing database and the new columns land as
-- `unknown`. Matching on `slug` (as 0099 does) so an owner-deleted or re-created
-- row is simply not updated.
--
-- `img2img`/`weak` is a statement about mechanism, not quality: qwen-image-2512 and
-- stable-diffusion-3.5-large repaint from noise through an optional `image` +
-- `strength` pair, so the subject feeds the noise instead of being preserved and the
-- run can hand back a plausible stranger. Both are portrait-only today
-- (`for_variant`/`for_scene` false, and no identity-critical profile is seeded on
-- either), so the rating costs nothing now and is what stops a future scene profile
-- from silently replacing the character the scene is about.
UPDATE "image_models"
SET "edit_kind" = 'img2img', "identity_preservation" = 'weak'
WHERE "slug" = 'qwen/qwen-image-2512';--> statement-breakpoint
-- The one model rated `strong` on the strength of following an instruction and
-- keeping the face: it is the default variant/scene/chat-look model today.
UPDATE "image_models"
SET "edit_kind" = 'instruction_edit', "identity_preservation" = 'strong'
WHERE "slug" = 'qwen/qwen-image-edit-2511';--> statement-breakpoint
UPDATE "image_models"
SET "edit_kind" = 'multi_reference_compose', "identity_preservation" = 'moderate'
WHERE "slug" = 'bytedance/seedream-4.5';--> statement-breakpoint
-- Observed carrying a face through a full scene change
-- (docs/developer-notes/images/seedream-5-lite.trial.md), which is what `strong`
-- means here — a judgment from looking at output, never a schema read.
UPDATE "image_models"
SET "edit_kind" = 'multi_reference_compose', "identity_preservation" = 'strong'
WHERE "slug" = 'bytedance/seedream-5-lite';--> statement-breakpoint
UPDATE "image_models"
SET "edit_kind" = 'img2img', "identity_preservation" = 'weak'
WHERE "slug" = 'stability-ai/stable-diffusion-3.5-large';--> statement-breakpoint
-- `identity_preservation` is deliberately LEFT at the `unknown` default: nobody has
-- rated Wan's face retention, and `unknown` is the permissive value, so the model
-- keeps serving the variant and scene surfaces it serves today rather than being
-- demoted by a rating that does not exist. The warning is operator-facing copy, not
-- a failure class — upstream moderation an operator needs told about before choosing
-- the model, not after a rejected render.
UPDATE "image_models"
SET "edit_kind" = 'multi_reference_compose',
    "operator_warning" = 'Upstream moderation cannot be disabled and has refused ordinary character references.'
WHERE "slug" = 'wan-video/wan-2.7-image-pro';--> statement-breakpoint
--
-- The 17 built-in profiles.
--
-- `SELECT ... FROM (VALUES ...) WHERE EXISTS` rather than a bare VALUES insert
-- because a profile's `image_model_id` is a foreign key: if the owner had deleted
-- the model a row hangs off, a bare insert would raise on the FK and take the whole
-- migration — and therefore the deploy — down with it. Guarded, a deleted model
-- simply gets no profiles.
--
-- `timeout_ms` is cast (`NULL::integer`) because Postgres resolves an untyped NULL
-- in a VALUES list to `text`, which the integer column would then reject.
--
-- Reference policies, by task. `POL_NONE` (nothing allowed, nothing required) is
-- what a generate task wants; the identity tasks allow an identity plus a style
-- reference and require the identity. The scene policy allows identity, location,
-- style and object but requires NOTHING on purpose: the scene ladder's `generate`
-- rung runs with zero references today, and requiring identity would break it.
--
-- `scene` profiles carry `instruction_edit`, not `multi_reference_compose`, even on
-- the array models. The lane still decides multi-vs-single at render time; threading
-- that through the strategy is a later slice, and doing it here would be a render
-- change.
--
-- The anchor tasks with no picker of their own (`item`, `location`, `chat_place`
-- borrow portrait's resolution; `chat_look` borrows scene's) are seeded ONLY on the
-- model their lane resolves today, so nothing new becomes eligible.
INSERT INTO "image_model_profiles" (
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
SELECT v.* FROM (VALUES
  -- Qwen Image 2512 — the portrait/item/location/chat-place generator, and the
  -- global default for all four of those tasks.
  ('imgprf2512portraitaaaaaa', 'imgmdlqwen2512aaaaaaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 10),
  ('imgprf2512itemaaaaaaaaaa', 'imgmdlqwen2512aaaaaaaaaa', 'item-standard', 'Item Standard',
   'item', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 13),
  ('imgprf2512locationaaaaaa', 'imgmdlqwen2512aaaaaaaaaa', 'location-standard', 'Location Standard',
   'location', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 14),
  ('imgprf2512chatplaceaaaaa', 'imgmdlqwen2512aaaaaaaaaa', 'chat-place-standard', 'Chat Place Standard',
   'chat_place', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 16),
  -- Qwen Image Edit 2511 — the instruction editor every identity-critical lane
  -- resolves to today, so it holds the variant/scene/chat-look defaults.
  ('imgprf2511variantaaaaaaa', 'imgmdlqwenedit2511aaaaaa', 'variant-standard', 'Variant Standard',
   'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 21),
  ('imgprf2511sceneaaaaaaaaa', 'imgmdlqwenedit2511aaaaaa', 'scene-standard', 'Scene Standard',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 22),
  ('imgprf2511chatlookaaaaaa', 'imgmdlqwenedit2511aaaaaa', 'chat-look-standard', 'Chat Look Standard',
   'chat_look', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, true, true, 25),
  -- Seedream 4.5 — an alternative on all three legacy surfaces, default on none.
  ('imgprfs45portraitaaaaaaa', 'imgmdlseedream45aaaaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 30),
  ('imgprfs45variantaaaaaaaa', 'imgmdlseedream45aaaaaaaa', 'variant-standard', 'Variant Standard',
   'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 31),
  ('imgprfs45sceneaaaaaaaaaa', 'imgmdlseedream45aaaaaaaa', 'scene-standard', 'Scene Standard',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 32),
  -- Seedream 5 Lite.
  ('imgprfs5lportraitaaaaaaa', 'imgmdlseedream5liteaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 40),
  ('imgprfs5lvariantaaaaaaaa', 'imgmdlseedream5liteaaaaa', 'variant-standard', 'Variant Standard',
   'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 41),
  ('imgprfs5lsceneaaaaaaaaaa', 'imgmdlseedream5liteaaaaa', 'scene-standard', 'Scene Standard',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 42),
  -- Stable Diffusion 3.5 Large — portrait only. Its `img2img`/`weak` rating means an
  -- identity-critical profile here would be refused by `profileEligibility` anyway.
  ('imgprfsd35portraitaaaaaa', 'imgmdlsd35largeaaaaaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 50),
  -- Wan 2.7 Image Pro — carries the operator warning above, not a rating that would
  -- exclude it: it stays offered on the surfaces it is ticked for today.
  ('imgprfwan27portraitaaaaa', 'imgmdlwan27imageproaaaaa', 'portrait-standard', 'Portrait Standard',
   'portrait', 'generate', 'text_to_image_description', '{"allowedRoles":[],"requiredRoles":[],"roleOrder":[]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 60),
  ('imgprfwan27variantaaaaaa', 'imgmdlwan27imageproaaaaa', 'variant-standard', 'Variant Standard',
   'variant', 'edit', 'instruction_edit', '{"allowedRoles":["identity","style"],"requiredRoles":["identity"],"roleOrder":["identity","style"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 61),
  ('imgprfwan27sceneaaaaaaaa', 'imgmdlwan27imageproaaaaa', 'scene-standard', 'Scene Standard',
   'scene', 'edit', 'instruction_edit', '{"allowedRoles":["identity","location","style","object"],"requiredRoles":[],"roleOrder":["identity","location","style","object"]}'::jsonb,
   '{}'::jsonb, '{}'::jsonb, NULL::integer, true, false, true, 62)
) AS v(
  "id", "image_model_id", "key", "label", "task", "operation", "prompt_strategy",
  "reference_policy", "control_defaults", "provider_overrides", "timeout_ms",
  "enabled", "is_default", "builtin", "sort"
)
WHERE EXISTS (SELECT 1 FROM "image_models" m WHERE m."id" = v."image_model_id")
ON CONFLICT DO NOTHING;
