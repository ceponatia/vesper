import { referenceCapacity, type ImageModel } from "@vesper/image-core";
import type { ImageFeature, ImageModelRequestFacts } from "./image-feature";

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
    validate: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] => {
      const { max } = referenceCapacity(model);
      if (request.referenceCount <= max) return [];
      if (max === 0) {
        return [`${model.label} takes no reference images, but this render carries ${request.referenceCount}.`];
      }
      return [
        `${model.label} accepts at most ${max} reference image(s), but this render carries ${request.referenceCount}.`,
      ];
    },
  };
}
