import type { ImageModel } from "@/contracts";

/**
 * The only negative block safe without task, style, subject-count, or morphology
 * context. Anatomy terms can contradict authored missing digits, prosthetics, or
 * non-human appendages, so they wait for profile-aware composition.
 */
export const STATIC_PRODUCTION_NEGATIVE = "text, watermark, signature, logo, blurry, low resolution";

const LEGACY_PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_SINGLE_REFERENCE_IDENTITY_LOCK =
  "Image 1 is the identity reference. Preserve the exact face, hair, skin tone, body proportions, and apparent age. Change only what this instruction requests.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_MULTI_REFERENCE_IDENTITY_LOCK =
  "Use numbered references as assigned below. Preserve each person's exact face, hair, skin tone, build, and age; change only what this instruction requests.";

/**
 * The registry's raw probe defaults describe what a provider accepts, not the
 * reviewed settings Vesper wants. Until task profiles reach the render path,
 * this small built-in policy corrects the known harmful defaults at the one
 * shared render seam.
 *
 * Exact provider slugs are intentional. We never send a guessed field to an
 * operator-added model, and pinned community slugs are normalized before the
 * lookup. These overrides are expected to dissolve into profile controls once
 * image-model-capabilities slice 2/4 is live.
 */
const REVIEWED_QUALITY_INPUTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "qwen/qwen-image-2512": {
    negative_prompt: STATIC_PRODUCTION_NEGATIVE,
  },
  "qwen/qwen-image-edit-2511": {
    // This model currently serves only identity-critical variants/scenes. Its
    // provider default optimizes speed on the surface where fidelity matters.
    go_fast: false,
  },
  "stability-ai/stable-diffusion-3.5-large": {
    negative_prompt: STATIC_PRODUCTION_NEGATIVE,
  },
  "lucataco/juggernaut-xl-v9": {
    // Normal Juggernaut v9 is a full-step SDXL checkpoint. The Replicate cog's
    // 5-step / CFG-2 defaults are a fast wrapper preset, not the model's native
    // quality configuration.
    num_inference_steps: 35,
    guidance_scale: 5,
    scheduler: "KarrasDPM",
    width: 832,
    height: 1216,
    negative_prompt: STATIC_PRODUCTION_NEGATIVE,
  },
  "nsfw-api/pony-realism-v2.3": {
    negative_prompt: `${STATIC_PRODUCTION_NEGATIVE}, score_1, score_2, score_3`,
  },
  "nsfw-api/realvis-hyper-lora": {
    width: 768,
    height: 1024,
    negative_prompt: STATIC_PRODUCTION_NEGATIVE,
  },
};

/** Strip a pinned `owner/name:version` suffix without touching ordinary slugs. */
export function baseImageModelSlug(slug: string): string {
  return slug.split(":", 1)[0] ?? slug;
}

/**
 * Apply the reviewed transitional defaults after the row's `extraInput`, so a
 * stale probe default such as Qwen Edit's `go_fast: true` cannot undo the quality
 * ruling. The model record itself is not mutated.
 */
export function withReviewedImageQuality(model: ImageModel): ImageModel {
  const overrides = REVIEWED_QUALITY_INPUTS[baseImageModelSlug(model.slug)];
  if (!overrides) return model;
  return { ...model, extraInput: { ...model.extraInput, ...overrides } };
}

/**
 * Qwen Edit's own multi-image guidance asks callers to identify images by number
 * and say what should remain unchanged. Existing prompt builders still emit the
 * provider-neutral legacy lock, so rewrite only that exact sentence at the
 * model boundary. Other models and custom prompts remain byte-identical.
 */
export function preparePromptForImageModel(
  model: Pick<ImageModel, "slug">,
  prompt: string,
  referenceCount: number,
): string {
  if (baseImageModelSlug(model.slug) !== "qwen/qwen-image-edit-2511") return prompt;
  if (referenceCount <= 0 || !prompt.includes(LEGACY_PORTRAIT_IDENTITY_LOCK)) return prompt;
  const lock = referenceCount === 1 ? QWEN_SINGLE_REFERENCE_IDENTITY_LOCK : QWEN_MULTI_REFERENCE_IDENTITY_LOCK;
  return prompt.replace(LEGACY_PORTRAIT_IDENTITY_LOCK, lock);
}
