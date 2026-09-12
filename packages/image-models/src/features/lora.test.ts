import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { loraFeature } from "./lora";

/**
 * `loraFeature()`'s two jobs: `isBound` answers whether the active probed
 * version carries a USABLE LoRA weights/scale pair, and `validate` explains
 * why not when a LoRA-bearing request meets a version that does not.
 *
 * Both consult the one shared pair-shape reading
 * (`resolveImageLoraBindingPair`, `@vesper/image-core`) that the render-side
 * mapper and final-wire invariant also consult — see that module's own tests
 * for the exhaustive shape matrix (absent sides, wrong element types,
 * mismatched arity). What is worth protecting HERE, at this layer, is that
 * the feature actually asks the shared function rather than a shallower
 * presence check, and that its refusal message names the specific problem
 * rather than a generic sentence.
 */

const feature = loraFeature();
const request = (usesLora: boolean) => ({ referenceCount: 1, usesLora });

function model(controls: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model-fixture",
    slug: "owner/fixture",
    label: "Fixture Model",
    canGenerate: true,
    canEdit: true,
    advancedCapabilities: { controls },
  });
}

describe("loraFeature", () => {
  it("is bound for the scalar pair every Qwen edit endpoint declares", () => {
    const bound = model({
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
    });
    expect(feature.isBound?.(bound)).toBe(true);
    expect(feature.validate?.(bound, request(true))).toEqual([]);
  });

  it("is bound for the array pair a FLUX.2 klein -base-lora endpoint declares", () => {
    const bound = model({
      loraWeights: { field: "lora_weights", type: "string", arity: "array" },
      loraScale: { field: "lora_scales", type: "number", arity: "array" },
    });
    expect(feature.isBound?.(bound)).toBe(true);
    expect(feature.validate?.(bound, request(true))).toEqual([]);
  });

  it("has nothing to refuse when the request does not use a LoRA, bound or not", () => {
    expect(feature.validate?.(model(), request(false))).toEqual([]);
  });

  it("names the missing side when only one field is declared", () => {
    const weightsOnly = model({ loraWeights: { field: "lora_weights", type: "string" } });
    expect(feature.isBound?.(weightsOnly)).toBe(false);
    expect(feature.validate?.(weightsOnly, request(true))).toEqual([
      "Fixture Model declares lora_weights but no LoRA scale binding, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);

    const scaleOnly = model({ loraScale: { field: "lora_scale", type: "number" } });
    expect(feature.isBound?.(scaleOnly)).toBe(false);
    expect(feature.validate?.(scaleOnly, request(true))).toEqual([
      "Fixture Model declares lora_scale but no LoRA weights binding, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("reports the generic sentence when neither field is declared", () => {
    expect(feature.isBound?.(model())).toBe(false);
    expect(feature.validate?.(model(), request(true))).toEqual([
      "Fixture Model carries no LoRA bindings at its probed version, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("names the shape mismatch when the two sides disagree on arity", () => {
    const mismatched = model({
      loraWeights: { field: "lora_weights", type: "string", arity: "array" },
      loraScale: { field: "lora_scale", type: "number" },
    });
    expect(feature.isBound?.(mismatched)).toBe(false);
    expect(feature.validate?.(mismatched, request(true))).toEqual([
      "Fixture Model declares array lora_weights but scalar lora_scale, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("is not bound when the two sides agree on arity but not on element type", () => {
    // A wrong element type on either side is not a pair `resolveImageLoraBindingPair`
    // recognizes, even though this feature's arity-mismatch message would not
    // otherwise distinguish it — it falls to the generic shape sentence.
    const wrongType = model({
      loraWeights: { field: "lora_weights", type: "number" },
      loraScale: { field: "lora_scale", type: "number" },
    });
    expect(feature.isBound?.(wrongType)).toBe(false);
    expect(feature.validate?.(wrongType, request(true))).toEqual([
      "Fixture Model declares lora_weights and lora_scale in a shape this render cannot use, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });
});
