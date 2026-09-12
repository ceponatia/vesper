import { resolveImageLoraBindingPair, type ImageInputBinding, type ImageModel } from "@vesper/image-core";
import type { ImageFeature, ImageModelRequestFacts } from "./image-feature";

/**
 * The model can load an external LoRA for one render.
 *
 * Both halves are required to call this bound, and that pairing is the point.
 * A LoRA is weights AND the strength they are applied at; a version exposing
 * only one of the two — or exposing them in two DIFFERENT shapes, a scalar
 * `lora_weights` beside an array `lora_scales`, say — cannot carry a library
 * row's curated band, and a render that sent weights with no matching scale
 * would run at whatever the wrapper defaults to — a different image than the
 * one the library row describes, with nothing in the record saying so.
 * `isBound` therefore consults the same shared pair-shape reading
 * (`resolveImageLoraBindingPair`, `@vesper/image-core`) as the render-side
 * mapper and final-wire invariant, so this cheap check and the expensive one
 * downstream can never disagree about which versions carry a usable pair.
 *
 * The refusal here is the CHEAP one: this pairing of model and request cannot
 * work, said before planning and long before spend. It does not replace the
 * compile step's final-wire invariant, which catches the harder failure — a
 * plan that RECORDS a LoRA whose fields
 * never reached the payload — at the one layer where the payload exists.
 * Across the whole retained provider history no prediction had ever carried
 * LoRA weights while every unit test passed, so the two checks answer
 * genuinely different questions and both are wanted.
 */
export function loraFeature(): ImageFeature {
  const isBound = (model: ImageModel): boolean => {
    const { loraWeights, loraScale } = model.advancedCapabilities.controls;
    return resolveImageLoraBindingPair(loraWeights, loraScale) !== null;
  };

  return {
    id: "lora",
    semantic: "Loads one external LoRA, at a chosen strength, for a single render.",
    isBound,
    validate: (model: ImageModel, request: ImageModelRequestFacts): readonly string[] => {
      if (!request.usesLora || isBound(model)) return [];
      const { loraWeights, loraScale } = model.advancedCapabilities.controls;
      return [
        `${model.label} ${loraBindingMismatchDetail(loraWeights, loraScale)}, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.`,
      ];
    },
  };
}

/**
 * Names the missing side, or the shape mismatch, for the refusal sentence —
 * never the generic "carries no LoRA bindings" when there is a more specific
 * fact to report. Read alongside {@link resolveImageLoraBindingPair}, whose
 * null cases this mirrors one-for-one.
 */
function loraBindingMismatchDetail(
  weights: ImageInputBinding | undefined,
  scale: ImageInputBinding | undefined,
): string {
  if (!weights && !scale) return "carries no LoRA bindings at its probed version";
  if (!weights) return `declares ${scale?.field} but no LoRA weights binding`;
  if (!scale) return `declares ${weights.field} but no LoRA scale binding`;
  const weightsArity = arityWord(weights);
  const scaleArity = arityWord(scale);
  if (weightsArity !== scaleArity) {
    return `declares ${weightsArity} ${weights.field} but ${scaleArity} ${scale.field}`;
  }
  return `declares ${weights.field} and ${scale.field} in a shape this render cannot use`;
}

/** `"single"` reads as "scalar" in the refusal sentence — the vocabulary an operator reviewing a probe already uses. */
function arityWord(binding: ImageInputBinding): string {
  return binding.arity === "array" ? "array" : "scalar";
}
