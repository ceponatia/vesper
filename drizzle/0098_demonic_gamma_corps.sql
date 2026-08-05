CREATE TABLE "image_models" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"can_generate" boolean DEFAULT true NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"reference_field" text DEFAULT 'image' NOT NULL,
	"reference_arity" text DEFAULT 'array' NOT NULL,
	"max_references" integer DEFAULT 1 NOT NULL,
	"aspect_mode" text DEFAULT 'aspect_ratio' NOT NULL,
	"supported_aspects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_format" text,
	"extra_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"for_portrait" boolean DEFAULT false NOT NULL,
	"for_variant" boolean DEFAULT false NOT NULL,
	"for_scene" boolean DEFAULT false NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "image_models_slug_idx" ON "image_models" USING btree ("slug");--> statement-breakpoint
--
-- Seed the six starting models (image-model-registry.spec.md). Hand-appended to
-- the generated migration on purpose: the registry must be populated on a FRESH
-- database without anyone remembering to run `pnpm db:seed`, and `pnpm db:migrate`
-- is what the Fly deploy runs. Same practice as the baseline migration's
-- hand-preserved `CREATE EXTENSION vector` line — preserve this block if 0098 is
-- ever regenerated.
--
-- ON CONFLICT DO NOTHING keeps it idempotent, and keeps it from resurrecting a
-- row the owner deliberately deleted (owner ruling 4: seeded rows are ordinary
-- rows).
--
-- Every value is probed from Replicate on 2026-08-05 and documented per model in
-- docs/image-models/. Two things are NOT derivable from the API and are recorded
-- from each field's prose description instead: `max_references` (no model
-- declares maxItems) and, for qwen-image-edit-2511, a cap we chose.
--
-- `supported_aspects` is the model's shape menu, verbatim. The render path picks
-- the closest entry to what a lane wants and crops the rest, which is how
-- stable-diffusion-3.5-large (whose enum has no 3:4) still serves 3:4 portraits
-- and how the 1:1 item / 3:2 location lanes are served by the same code.
--
-- `disable_safety_checker` appears in extra_input ONLY for the three models whose
-- schema actually has that input; the render path overwrites its VALUE from
-- REPLICATE_SAFE_MODE but never adds the key to a model that lacks it, because
-- Replicate rejects unknown inputs.
INSERT INTO "image_models" (
  "id", "slug", "label", "can_generate", "can_edit", "reference_field", "reference_arity",
  "max_references", "aspect_mode", "supported_aspects", "output_format", "extra_input",
  "for_portrait", "for_variant", "for_scene", "builtin", "sort"
) VALUES
  (
    'imgmdlqwen2512aaaaaaaaaa', 'qwen/qwen-image-2512', 'Qwen Image 2512',
    true, true, 'image', 'single', 1, 'aspect_ratio',
    '["1:1","16:9","9:16","4:3","3:4"]'::jsonb, 'webp',
    '{"output_quality":95,"go_fast":true,"disable_safety_checker":true}'::jsonb,
    true, false, false, true, 10
  ),
  (
    'imgmdlqwenedit2511aaaaaa', 'qwen/qwen-image-edit-2511', 'Qwen Image Edit 2511',
    false, true, 'image', 'array', 3, 'aspect_ratio',
    '["1:1","16:9","9:16","4:3","3:4"]'::jsonb, 'webp',
    '{"output_quality":95,"go_fast":true,"disable_safety_checker":true}'::jsonb,
    false, true, true, true, 20
  ),
  (
    'imgmdlseedream45aaaaaaaa', 'bytedance/seedream-4.5', 'Seedream 4.5',
    true, true, 'image_input', 'array', 14, 'aspect_ratio',
    '["1:1","4:3","3:4","4:5","5:4","16:9","9:16","3:2","2:3","21:9","9:21"]'::jsonb, NULL,
    '{"size":"2K","max_images":1,"sequential_image_generation":"disabled","disable_safety_checker":true}'::jsonb,
    true, true, true, true, 30
  ),
  (
    'imgmdlseedream5liteaaaaa', 'bytedance/seedream-5-lite', 'Seedream 5 Lite',
    true, true, 'image_input', 'array', 14, 'aspect_ratio',
    '["1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9"]'::jsonb, 'png',
    '{"size":"2K","max_images":1,"sequential_image_generation":"disabled"}'::jsonb,
    true, true, true, true, 40
  ),
  (
    'imgmdlsd35largeaaaaaaaaa', 'stability-ai/stable-diffusion-3.5-large', 'Stable Diffusion 3.5 Large',
    true, true, 'image', 'single', 1, 'aspect_ratio',
    '["16:9","1:1","21:9","2:3","3:2","4:5","5:4","9:16","9:21"]'::jsonb, 'webp',
    '{}'::jsonb,
    true, false, false, true, 50
  ),
  (
    'imgmdlwan27imageproaaaaa', 'wan-video/wan-2.7-image-pro', 'Wan 2.7 Image Pro',
    true, true, 'images', 'array', 9, 'size',
    -- Deliberately EXCLUDES the 4096*… sizes the model also lists: Wan documents
    -- 4K as "only available for text-to-image", and the render path picks the
    -- largest exact match, so seeding them would silently break every edit.
    '["1024*1024","2048*2048","1280*720","720*1280","2048*1152","1152*2048","1024*768","768*1024","2048*1536","1536*2048"]'::jsonb, NULL,
    '{"num_outputs":1,"image_set_mode":false}'::jsonb,
    true, true, true, true, 60
  )
ON CONFLICT ("slug") DO NOTHING;