import {
  emptyImageModelAdvancedCapabilities,
  imageModelSchema,
  type ImageModel,
  type ImageModelAdvancedCapabilities,
  type ImageModelControlBindings,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { fluxKleinBase, fluxKleinBaseLora, fluxKleinDistilled } from "./klein";

/**
 * The three klein variant compositions.
 *
 * `capabilities` proves each variant advertises exactly the schema-backed
 * feature matrix (`docs/image-models/features/README.md` §"FLUX.2 klein
 * composition") — no base-only guidance or fixed fast mode leaking onto the
 * LoRA endpoint, no LoRA leaking onto the two endpoints with no loading
 * input. `validateRequest` proves the composed refusals read the SELECTED
 * ROW's capacity/binding rather than a number or shape written into this
 * adapter — the same property `features/lora.test.ts` protects for the bare
 * feature, exercised here through a composed klein adapter as the issue
 * acceptance requires.
 */

/**
 * A probed capability record declaring exactly these control bindings and
 * nothing else. Spelled out rather than passed as a bare `{ controls }` literal
 * because `ImageModelAdvancedCapabilities` is the schema's OUTPUT type: every
 * defaulted member (`additionalImageInputs`, `output`, `knownInputFields`,
 * `providerInputs`) is required on it, so a partial literal is not a record
 * any row could actually hold — and `kleinRow` keeps its strict
 * `Partial<ImageModel>` parameter so a fixture that drifts from the row
 * contract fails the typecheck instead of being parsed into something else.
 */
function withControls(controls: ImageModelControlBindings): ImageModelAdvancedCapabilities {
  return { ...emptyImageModelAdvancedCapabilities(), controls };
}

function kleinRow(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "klein-fixture",
    slug: "black-forest-labs/flux-2-klein-fixture",
    label: "Klein Fixture",
    canGenerate: true,
    canEdit: true,
    referenceArity: "array",
    ...overrides,
  });
}

describe("klein variant composition", () => {
  it("matches the schema-backed feature matrix in the documented order", () => {
    expect(fluxKleinDistilled.capabilities).toEqual([
      "prompt",
      "multiReference",
      "aspectRatio",
      "seed",
      "fastMode",
      "outputFormat",
      "outputQuality",
      "safetyToggle",
    ]);
    expect(fluxKleinBase.capabilities).toEqual([
      "prompt",
      "multiReference",
      "aspectRatio",
      "seed",
      "fastMode",
      "guidance",
      "outputFormat",
      "outputQuality",
      "safetyToggle",
    ]);
    expect(fluxKleinBaseLora.capabilities).toEqual([
      "prompt",
      "multiReference",
      "aspectRatio",
      "seed",
      "lora",
      "outputFormat",
      "outputQuality",
      "safetyToggle",
    ]);
  });

  it("advertises no negativePrompt on any variant", () => {
    for (const variant of [fluxKleinDistilled, fluxKleinBase, fluxKleinBaseLora]) {
      expect(variant.capabilities).not.toContain("negativePrompt");
    }
  });

  it("keeps base-only guidance and fast mode off the LoRA endpoint, and LoRA off the endpoints with no loading input", () => {
    expect(fluxKleinBaseLora.capabilities).not.toContain("guidance");
    expect(fluxKleinBaseLora.capabilities).not.toContain("fastMode");
    expect(fluxKleinDistilled.capabilities).not.toContain("lora");
    expect(fluxKleinBase.capabilities).not.toContain("lora");
  });

  it("composes no preparePrompt and no executionHints for any variant", () => {
    for (const variant of [fluxKleinDistilled, fluxKleinBase, fluxKleinBaseLora]) {
      expect(variant.preparePrompt).toBeUndefined();
      expect(variant.executionHints).toBeUndefined();
    }
  });
});

describe("klein reference-capacity validation reads the selected row, not a number written into the adapter", () => {
  it("refuses a 3-reference request and passes a 2-reference request against a curated cap of 2", () => {
    const row = kleinRow({ maxReferences: 2 });
    expect(fluxKleinDistilled.validateRequest?.(row, { referenceCount: 3, usesLora: false })).toEqual([
      "Klein Fixture accepts at most 2 reference image(s), but this render carries 3.",
    ]);
    expect(fluxKleinDistilled.validateRequest?.(row, { referenceCount: 2, usesLora: false })).toEqual([]);
  });

  it("refuses a 6-reference request against a curated cap of 5 (nothing in the adapter says '5')", () => {
    const row = kleinRow({ maxReferences: 5 });
    expect(fluxKleinBase.validateRequest?.(row, { referenceCount: 6, usesLora: false })).toEqual([
      "Klein Fixture accepts at most 5 reference image(s), but this render carries 6.",
    ]);
    expect(fluxKleinBase.validateRequest?.(row, { referenceCount: 5, usesLora: false })).toEqual([]);
  });
});

describe("klein LoRA validation", () => {
  it("the distilled variant composes no lora feature, so ITS OWN validateRequest has nothing to say about a LoRA-bearing request; the refusal for that request comes from the application's library/mechanical LoRA-compatibility check (packages/image-core/src/loras/image-loras.ts), not from this adapter", () => {
    expect(fluxKleinDistilled.capabilities).not.toContain("lora");
    const row = kleinRow();
    expect(fluxKleinDistilled.validateRequest?.(row, { referenceCount: 0, usesLora: true })).toEqual([]);
  });

  it("refuses a LoRA-bearing request on the base-lora variant when the row declares no LoRA bindings", () => {
    const row = kleinRow();
    expect(fluxKleinBaseLora.validateRequest?.(row, { referenceCount: 0, usesLora: true })).toEqual([
      "Klein Fixture carries no LoRA bindings at its probed version, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("refuses a LoRA-bearing request on the base-lora variant when the row's pair disagrees on arity", () => {
    const row = kleinRow({
      advancedCapabilities: withControls({
        loraWeights: { field: "lora_weights", type: "string", arity: "array" },
        loraScale: { field: "lora_scale", type: "number" },
      }),
    });
    expect(fluxKleinBaseLora.validateRequest?.(row, { referenceCount: 0, usesLora: true })).toEqual([
      "Klein Fixture declares array lora_weights but scalar lora_scale, so this render's LoRA cannot be sent. Re-probe the model, or run the LoRA on a model that exposes both weights and scale.",
    ]);
  });

  it("passes a LoRA-bearing request on the base-lora variant with a valid array pair", () => {
    const row = kleinRow({
      advancedCapabilities: withControls({
        loraWeights: { field: "lora_weights", type: "string", arity: "array" },
        loraScale: { field: "lora_scales", type: "number", arity: "array" },
      }),
    });
    expect(fluxKleinBaseLora.validateRequest?.(row, { referenceCount: 0, usesLora: true })).toEqual([]);
  });
});
