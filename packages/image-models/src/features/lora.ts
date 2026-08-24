import type { ImageModel } from "@vesper/image-core";
import type { ImageFeature, ImageModelRequestFacts } from "./image-feature";

/**
 * The model can load an external LoRA for one render.
 *
 * Both halves are required to call this bound, and that pairing is the point.
 * A LoRA is weights AND the strength they are applied at; a version exposing
 * only one of the two cannot carry a library row's curated band, and a render
 * that sent weights with no scale would run at whatever the wrapper defaults
 * to — a different image than the one the library row describes, with nothing
 * in the record saying so.
 *
 * The refusal here is the CHEAP one: this pairing of model and request cannot
 * work, said before planning and long before spend. It does not replace the
 * compile step's final-wire invariant (spec §"Compile-step wire invariant"),
 * which catches the harder failure — a plan that RECORDS a LoRA whose fields
 * never reached the payload — at the one layer where the payload exists.
 * Across the whole retained provider history no prediction had ever carried
 * LoRA weights while every unit test passed (plan §1), so the two checks answer
 * genuinely different questions and both are wanted.
 */
export function loraFeature(): ImageFeature {
  const isBound = (model: ImageModel): boolean => {
    const { loraWeights, loraScale } = model.advancedCapabilities.controls;
    return loraWeights !== undefined && loraScale !== undefined;
  };

  return {
    id: "lora",
    semantic: "Loads one external LoRA, at a chosen strength, for a single render.",
    isBound,
    validate: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] => {
      if (!request.usesLora || isBound(model)) return [];
      return [
        `${model.label} carries no LoRA bindings at its probed version, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.`,
      ];
    },
  };
}
