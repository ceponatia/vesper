import {
  emptyImageModelAdvancedCapabilities,
  imageModelSchema,
  type ImageModel,
  type ImageModelAdvancedCapabilities,
  type ImageModelControlBindings,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { guidanceFeature, loraFeature, negativePromptFeature, stepsFeature } from "../../features";
import { civitaiQwenImage21 } from "./image-2-1";
import { qwenEditFeatures } from "./shared";

/**
 * `civitaiQwenImage21` — Civitai's native Qwen Image 2.1 lane (#660).
 *
 * `capabilities` proves the composition matches the documented parameter set
 * exactly, in the documented order, and composes none of the four features
 * the lane's accepted-input schema declares nothing for (`fastMode`,
 * `outputFormat`, `outputQuality`, `safetyToggle`). `isBound` is exercised
 * against a fixture carrying the measured capability record (shared-facts.md,
 * 2026-09-30) to prove the composed features read the PROBED row rather than
 * assuming a binding. `validateRequest` proves the composed refusals
 * accumulate and read the selected row's capacity/binding, the same property
 * `flux/klein.test.ts` protects for the Civitai klein adapter.
 */

function withControls(controls: ImageModelControlBindings): ImageModelAdvancedCapabilities {
  return { ...emptyImageModelAdvancedCapabilities(), controls };
}

/** The measured capability record for `civitai/qwen-image-2.1` (shared-facts.md, 2026-09-30). */
function civitaiQwenImage21Row(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "civitai-qwen-image-2-1-fixture",
    slug: "civitai/qwen-image-2.1",
    label: "Qwen Image 2.1 (Civitai)",
    canGenerate: true,
    canEdit: true,
    referenceArity: "array",
    maxReferences: 10,
    advancedCapabilities: withControls({
      seed: { field: "seed", type: "integer" },
      guidance: { field: "cfgScale", type: "number", minimum: 0, maximum: 30 },
      steps: { field: "steps", type: "integer", minimum: 1, maximum: 60 },
      negativePrompt: { field: "negativePrompt", type: "string" },
      loraWeights: { field: "civitai_lora_version", type: "string" },
      loraScale: { field: "civitai_lora_strength", type: "number", minimum: 0, maximum: 4 },
    }),
    ...overrides,
  });
}

describe("civitaiQwenImage21 composition", () => {
  it("matches the documented 2.1 parameter set in the documented order", () => {
    expect(civitaiQwenImage21.capabilities).toEqual([
      "prompt",
      "multiReference",
      "aspectRatio",
      "seed",
      "guidance",
      "steps",
      "negativePrompt",
      "lora",
    ]);
  });

  it("composes none of the four features the lane's accepted-input schema declares nothing for", () => {
    expect(civitaiQwenImage21.capabilities).not.toContain("fastMode");
    expect(civitaiQwenImage21.capabilities).not.toContain("outputFormat");
    expect(civitaiQwenImage21.capabilities).not.toContain("outputQuality");
    expect(civitaiQwenImage21.capabilities).not.toContain("safetyToggle");
  });

  it("composes no preparePrompt and no executionHints", () => {
    expect(civitaiQwenImage21.preparePrompt).toBeUndefined();
    expect(civitaiQwenImage21.executionHints).toBeUndefined();
  });

  it("shares the family name but not the 20B edit endpoints' composition", () => {
    expect(civitaiQwenImage21.family).toBe("qwen-image");
    const editCapabilities = qwenEditFeatures().map((feature) => feature.id);
    expect(civitaiQwenImage21.capabilities).not.toEqual(editCapabilities);
    // The 20B edit endpoints take no guidance, no steps, and no negative
    // prompt at all; 2.1's true-CFG sampling composes all three.
    expect(editCapabilities).not.toContain("guidance");
    expect(editCapabilities).not.toContain("steps");
    expect(editCapabilities).not.toContain("negativePrompt");
  });
});

describe("civitaiQwenImage21 binding reads the probed row, not an assumption written into the adapter", () => {
  it("binds guidance, steps, negativePrompt, and the scalar LoRA pair from the measured capability record", () => {
    const row = civitaiQwenImage21Row();
    expect(guidanceFeature().isBound?.(row)).toBe(true);
    expect(stepsFeature().isBound?.(row)).toBe(true);
    expect(negativePromptFeature().isBound?.(row)).toBe(true);
    expect(loraFeature().isBound?.(row)).toBe(true);
  });

  it("reports every binding unbound on an unprobed row exposing none of them", () => {
    const row = civitaiQwenImage21Row({ advancedCapabilities: withControls({}) });
    expect(guidanceFeature().isBound?.(row)).toBe(false);
    expect(stepsFeature().isBound?.(row)).toBe(false);
    expect(negativePromptFeature().isBound?.(row)).toBe(false);
    expect(loraFeature().isBound?.(row)).toBe(false);
  });
});

describe("civitaiQwenImage21 request validation", () => {
  it("passes a within-capacity, LoRA-bearing request against the fully bound row", () => {
    const row = civitaiQwenImage21Row();
    expect(civitaiQwenImage21.validateRequest?.(row, { referenceCount: 10, usesLora: true })).toEqual([]);
  });

  it("accumulates the LoRA refusal when the row's LoRA pair is missing", () => {
    const row = civitaiQwenImage21Row({
      advancedCapabilities: withControls({
        guidance: { field: "cfgScale", type: "number" },
        steps: { field: "steps", type: "integer" },
        negativePrompt: { field: "negativePrompt", type: "string" },
      }),
    });
    expect(civitaiQwenImage21.validateRequest?.(row, { referenceCount: 1, usesLora: true })).toEqual([
      "Qwen Image 2.1 (Civitai) carries no LoRA bindings at its probed version, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("refuses an 11-reference request against the row's curated 10-reference cap", () => {
    const row = civitaiQwenImage21Row();
    expect(civitaiQwenImage21.validateRequest?.(row, { referenceCount: 11, usesLora: false })).toEqual([
      "Qwen Image 2.1 (Civitai) accepts at most 10 reference image(s), but this render carries 11.",
    ]);
  });

  it("accumulates both the reference-capacity and LoRA refusals for one request that trips both", () => {
    const row = civitaiQwenImage21Row({
      maxReferences: 10,
      advancedCapabilities: withControls({}),
    });
    expect(civitaiQwenImage21.validateRequest?.(row, { referenceCount: 11, usesLora: true })).toEqual([
      "Qwen Image 2.1 (Civitai) accepts at most 10 reference image(s), but this render carries 11.",
      "Qwen Image 2.1 (Civitai) carries no LoRA bindings at its probed version, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });
});
