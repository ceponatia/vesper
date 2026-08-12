import type { ImageModel } from "./image-models";

const LEGACY_PORTRAIT_IDENTITY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_SINGLE_REFERENCE_IDENTITY_LOCK =
  "Image 1 is the identity reference. Preserve the exact face, hair, skin tone, body proportions, and apparent age. Change only what this instruction requests.";

/** Kept no longer than the legacy lock so the edit path's fitted prompt stays fitted. */
export const QWEN_MULTI_REFERENCE_IDENTITY_LOCK =
  "Use numbered references as assigned below. Preserve each person's exact face, hair, skin tone, build, and apparent age; change only requested details.";

/**
 * The registry's raw probe defaults describe what a provider accepts, not the
 * reviewed settings Vesper wants. Until task profiles reach the render path,
 * this small built-in policy corrects only settings that are safe without task,
 * style, subject-count, or morphology context.
 *
 * There is deliberately no universal negative block here. Text, logos, blur,
 * low-resolution media, unusual appendages, and absent body parts can all be
 * intentional. The two reviewed community wrappers with non-empty provider
 * defaults are explicitly cleared so those hidden defaults cannot contradict
 * Vesper's authored state. Contextual negatives belong to task profiles.
 *
 * Exact provider slugs are intentional. We never send a guessed field to an
 * operator-added model, and pinned community slugs are normalized before the
 * lookup. These overrides are expected to dissolve into profile controls once
 * image-model-capabilities slice 2/4 is live.
 */
const REVIEWED_QUALITY_INPUTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "qwen/qwen-image-edit-2511": {
    // This model currently serves only identity-critical variants/scenes. Its
    // provider default optimizes speed on the surface where fidelity matters.
    go_fast: false,
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
    // The wrapper's default forbids several rendering media. Start from the
    // checkpoint creator's recommended little/no-negative baseline instead.
    negative_prompt: "",
  },
  "nsfw-api/realvis-hyper-lora": {
    width: 768,
    height: 1024,
    // Replaces the wrapper's long generic anatomy/style boilerplate. A later
    // profile may add conflict-checked terms using the actual visual intent.
    negative_prompt: "",
  },
  "aisha-ai-official/nsfw-flux-dev": {
    // The wrapper defaults to a 1024×1024 square, so every render would be
    // cropped to 3:4 and lose a quarter of the frame. 832×1216 is the portrait
    // bucket this architecture is trained on; `cropToTargetAspect` trims the
    // remainder, exactly as for Juggernaut above.
    width: 832,
    height: 1216,
  },
  "aisha-ai-official/likereality-pony-v1": {
    width: 832,
    height: 1216,
    // The wrapper's provider default is literally `"nsfw, naked"` — a hidden
    // negative that suppresses the output this app exists to produce and
    // silently contradicts the authored wardrobe and exposure state. The Pony
    // score-tag preamble is separate and stays on (`prepend_preprompt`).
    negative_prompt: "",
  },
  "nsfw-api/sdxl-pulid": {
    // 512×512 is the wrapper's default: both off-shape and far below the
    // 768×1024 canonical portrait.
    width: 832,
    height: 1216,
    // Vesper runs this model for identity preservation, never style transfer.
    // Pinned so a changed provider default cannot move it off `fidelity`.
    method: "fidelity",
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
 *
 * The rewrite is IDEMPOTENT, and that is load-bearing rather than incidental:
 * `compileProfileRenderPlan` hashes the prepared prompt and `renderWithModel`
 * prepares again on the way out, so a second pass that changed the text would
 * make every identity-trial cell refuse `cell_conflict` against its own compiled
 * prompt. `replaceAll` rather than `replace` is what makes the claim TRUE: a
 * prompt that somehow carried the legacy sentence twice kept its second copy
 * under `replace`, and the next pass would rewrite that one instead — the same
 * function returning two different strings for one input.
 */
export function preparePromptForImageModel(
  model: Pick<ImageModel, "slug">,
  prompt: string,
  referenceCount: number,
): string {
  if (baseImageModelSlug(model.slug) !== "qwen/qwen-image-edit-2511") return prompt;
  if (referenceCount <= 0 || !prompt.includes(LEGACY_PORTRAIT_IDENTITY_LOCK)) return prompt;
  const lock = referenceCount === 1 ? QWEN_SINGLE_REFERENCE_IDENTITY_LOCK : QWEN_MULTI_REFERENCE_IDENTITY_LOCK;
  return prompt.replaceAll(LEGACY_PORTRAIT_IDENTITY_LOCK, lock);
}
