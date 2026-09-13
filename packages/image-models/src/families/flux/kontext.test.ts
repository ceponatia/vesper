import {
  emptyImageModelAdvancedCapabilities,
  imageModelSchema,
  type ImageModel,
  type ImageModelAdvancedCapabilities,
  type ImageModelControlBindings,
} from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { sourceImageFeature, stepsFeature } from "../../features";
import { fluxKontextDev } from "./kontext";

/**
 * FLUX.1 Kontext Dev composition.
 *
 * `capabilities` proves the adapter advertises exactly the schema-backed
 * feature list (`docs/image-models/features/README.md` §"FLUX.1 Kontext
 * composition") — no `multiReference`, `fastMode`, `negativePrompt`, or `lora`
 * leaking in, and no `preparePrompt`/`executionHints` invented.
 * `validateRequest` proves the composed refusals read the SELECTED ROW's
 * capacity/flags rather than a number written into this adapter, mirroring
 * `klein.test.ts`'s protection of the same property for the klein family.
 */

/**
 * A probed capability record declaring exactly these control bindings and
 * nothing else. Spelled out rather than a partial `{ controls }` literal
 * because `ImageModelAdvancedCapabilities` is the schema's OUTPUT type — see
 * `klein.test.ts`'s `withControls` for the full rationale.
 */
function withControls(controls: ImageModelControlBindings): ImageModelAdvancedCapabilities {
  return { ...emptyImageModelAdvancedCapabilities(), controls };
}

/**
 * The dev endpoint's shape: edit-only, single required reference, no
 * generation-from-nothing path. Overridable per test so `canGenerate: true`
 * and `canEdit: false` variants can be exercised without a second helper.
 */
function kontextRow(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "kontext-dev-fixture",
    slug: "black-forest-labs/flux-kontext-dev",
    label: "Kontext Dev Fixture",
    canGenerate: false,
    canEdit: true,
    referenceArity: "single",
    maxReferences: 1,
    ...overrides,
  });
}

describe("FLUX.1 Kontext Dev composition", () => {
  it("matches the schema-backed feature list in the documented order", () => {
    expect(fluxKontextDev.capabilities).toEqual([
      "prompt",
      "sourceImage",
      "aspectRatio",
      "seed",
      "guidance",
      "steps",
      "outputFormat",
      "outputQuality",
      "safetyToggle",
    ]);
  });

  it("composes no multiReference, fastMode, negativePrompt, or lora", () => {
    expect(fluxKontextDev.capabilities).not.toContain("multiReference");
    expect(fluxKontextDev.capabilities).not.toContain("fastMode");
    expect(fluxKontextDev.capabilities).not.toContain("negativePrompt");
    expect(fluxKontextDev.capabilities).not.toContain("lora");
  });

  it("composes no preparePrompt and no executionHints", () => {
    expect(fluxKontextDev.preparePrompt).toBeUndefined();
    expect(fluxKontextDev.executionHints).toBeUndefined();
  });
});

describe("FLUX.1 Kontext Dev source-image validation reads the selected row, not a number written into the adapter", () => {
  it("refuses a 0-reference request with the source-image sentence", () => {
    const row = kontextRow();
    expect(fluxKontextDev.validateRequest?.(row, { referenceCount: 0, usesLora: false })).toEqual([
      "Kontext Dev Fixture works from a source image, but this render carries none.",
    ]);
  });

  it("passes a 1-reference request", () => {
    const row = kontextRow();
    expect(fluxKontextDev.validateRequest?.(row, { referenceCount: 1, usesLora: false })).toEqual([]);
  });

  it("refuses a 2-reference request with the over-capacity sentence naming 1 and 2", () => {
    const row = kontextRow();
    expect(fluxKontextDev.validateRequest?.(row, { referenceCount: 2, usesLora: false })).toEqual([
      "Kontext Dev Fixture accepts at most 1 reference image(s), but this render carries 2.",
    ]);
  });

  it("passes a 0-reference request on a row that can generate from nothing", () => {
    const row = kontextRow({ canGenerate: true });
    expect(fluxKontextDev.validateRequest?.(row, { referenceCount: 0, usesLora: false })).toEqual([]);
  });
});

describe("FLUX.1 Kontext Dev LoRA validation", () => {
  it("composes no lora feature, so a LoRA-bearing request draws no refusal from THIS adapter; that refusal, if any, comes from the library's mechanical LoRA-compatibility check (packages/image-core/src/loras/image-loras.ts), not from this composition", () => {
    expect(fluxKontextDev.capabilities).not.toContain("lora");
    const row = kontextRow();
    expect(fluxKontextDev.validateRequest?.(row, { referenceCount: 1, usesLora: true })).toEqual([]);
  });
});

describe("sourceImage isBound", () => {
  it("is false on a row that cannot edit", () => {
    const row = kontextRow({ canEdit: false });
    expect(sourceImageFeature().isBound?.(row)).toBe(false);
  });

  it("is false on an EDITABLE row whose curated capacity is zero", () => {
    // The second half of the claim, and the only case that separates the real
    // rule from a `model.canEdit`-only reading: `referenceCapacity` already
    // answers 0 for a row that cannot edit, so the case above passes either
    // way. `maxReferences` is a CURATED column — `imageModelProbeFields`
    // (apps/web/src/server/images/identity-trial-model-versions.ts) never
    // rewrites it on a re-probe — so an operator can leave an editable row
    // with no reference slot at all, and a feature whose whole claim is "this
    // render has nothing to work from without one source image" is not bound
    // on it.
    const row = kontextRow({ maxReferences: 0 });
    expect(row.canEdit).toBe(true);
    expect(sourceImageFeature().isBound?.(row)).toBe(false);
  });

  it("is true on the fixture row", () => {
    const row = kontextRow();
    expect(sourceImageFeature().isBound?.(row)).toBe(true);
  });
});

describe("steps isBound", () => {
  it("is false when the active row has no normalized steps control binding", () => {
    const row = kontextRow();
    expect(stepsFeature().isBound?.(row)).toBe(false);
  });

  it("is true when the active row's advancedCapabilities.controls.steps is bound", () => {
    const row = kontextRow({
      advancedCapabilities: withControls({
        steps: { field: "num_inference_steps", type: "integer", minimum: 4, maximum: 50 },
      }),
    });
    expect(stepsFeature().isBound?.(row)).toBe(true);
  });
});
