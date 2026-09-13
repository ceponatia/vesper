import { referenceCapacity, type ImageModel } from "@vesper/image-core";
import type { ImageFeature, ImageModelRequestFacts } from "./image-feature";

/**
 * The over-capacity refusal every reference-bearing feature reports the same
 * way: the row's normalized capacity said how many references a render may
 * carry, and the render asked for more. Extracted so `multiReferenceFeature`
 * and `sourceImageFeature` never drift into two slightly different sentences
 * for the same fact — `multiReferenceFeature` keeps the exact wording it had
 * before this helper existed.
 */
function overCapacityRefusal(model: ImageModel, request: ImageModelRequestFacts): string[] {
  const { max } = referenceCapacity(model);
  if (request.referenceCount <= max) return [];
  if (max === 0) {
    return [`${model.label} takes no reference images, but this render carries ${request.referenceCount}.`];
  }
  return [
    `${model.label} accepts at most ${max} reference image(s), but this render carries ${request.referenceCount}.`,
  ];
}

/**
 * The model accepts SEVERAL reference images in one render, so references can
 * be assigned distinct roles — identity here, location there — rather than
 * competing for one slot.
 *
 * Capacity is read from the record through `referenceCapacity`, which already
 * reconciles the stored cap with the model's arity and its ability to edit at
 * all. Restating the cap here would be a second copy of a number an operator
 * edits on the admin page.
 *
 * The refusal is all-or-nothing on purpose: a render that asked for
 * three references and silently sent two has dropped somebody's identity, and
 * it has done so in a way no output inspection reveals. Trimming is a decision
 * for whoever built the reference list, not one to make at the model boundary.
 */
export function multiReferenceFeature(): ImageFeature {
  return {
    id: "multiReference",
    semantic: "Accepts more than one reference image in a single render, each with its own role.",
    isBound: (model: ImageModel) => referenceCapacity(model).max > 1,
    validate: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] =>
      overCapacityRefusal(model, request),
  };
}

/**
 * The model REQUIRES a reference image — the source the render works from —
 * rather than rendering from a prompt alone. How many it may carry is the
 * row's normalized capacity (one, on the endpoint that composes it today).
 * This is a different semantic claim from `multiReferenceFeature`, not a
 * capacity-1 special case of it: `multiReference`'s claim is that several
 * images can each carry a distinct role (identity, location, …), which is
 * false at a cap of one, while `sourceImage`'s claim is that the render has
 * nothing to work from without that source image. The two are also not
 * opposite ends of one spectrum — `qwen/qwen-image-2512`'s single reference
 * input is OPTIONAL strength-based img2img, not a required source, so that
 * endpoint composes neither feature.
 *
 * `isBound` asks two things of the row: it must be able to edit at all, and
 * its normalized capacity must allow at least one reference. A
 * generation-only row (no `canEdit`) cannot bind this feature no matter what
 * `maxReferences` says.
 */
export function sourceImageFeature(): ImageFeature {
  return {
    id: "sourceImage",
    semantic: "Requires a reference image to work from, rather than rendering from a prompt alone.",
    isBound: (model: ImageModel) => model.canEdit && referenceCapacity(model).max >= 1,
    validate: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] => {
      if (!model.canGenerate && request.referenceCount === 0) {
        return [`${model.label} works from a source image, but this render carries none.`];
      }
      return overCapacityRefusal(model, request);
    },
  };
}
