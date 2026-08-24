import type { ImageModel } from "./image-models";
import { reviewedImageQualityInputs } from "./reviewed-profile-controls";

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
