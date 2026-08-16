import type { ImageModel } from "./image-models";
import { reviewedImageQualityInputs } from "./reviewed-profile-controls";

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
 * reviewed settings Vesper wants. Until every reviewed model's task profiles
 * carry these settings AND its version is probed, this small built-in policy
 * corrects only settings that are safe without task, style, subject-count, or
 * morphology context.
 *
 * There is deliberately no universal negative block here. Text, logos, blur,
 * low-resolution media, unusual appendages, and absent body parts can all be
 * intentional. The reviewed community wrappers with non-empty provider defaults
 * are explicitly cleared so those hidden defaults cannot contradict Vesper's
 * authored state. Contextual negatives belong to task profiles.
 *
 * Exact provider slugs are intentional. We never send a guessed field to an
 * operator-added model, and pinned community slugs are normalized before the
 * lookup.
 *
 * The VALUES no longer live here. They are derived from
 * `reviewed-profile-controls.ts`, which states each reviewed setting once and
 * renders it into both the raw provider fields this overlay merges and the
 * normalized controls a task profile stores. The migration needs both spellings
 * live simultaneously — an override is removed only after parity is demonstrated
 * for it — and two hand-maintained copies of one table is precisely how a parity
 * migration ships a silent difference.
 */
const REVIEWED_QUALITY_INPUTS = reviewedImageQualityInputs;

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
