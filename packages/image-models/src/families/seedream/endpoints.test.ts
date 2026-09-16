import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { seedream45, seedream5Lite } from "./endpoints";

/**
 * #336/#337 regression: treating both Seedream endpoints as one composition
 * advertises an output-format field 4.5 lacks or a safety field 5 Lite lacks.
 * The reference validator must read the selected row's capacity, so a re-probe
 * or curated capacity change cannot leave an adapter-local 14-image limit.
 */
function seedreamRow(maxReferences: number): ImageModel {
  return imageModelSchema.parse({
    id: "seedream-fixture",
    slug: "bytedance/seedream-4.5",
    label: "Seedream Fixture",
    canGenerate: true,
    canEdit: true,
    referenceArity: "array",
    maxReferences,
  });
}

describe("Seedream endpoint composition", () => {
  it("shares the core family and keeps output format and safety on their actual endpoints", () => {
    expect(seedream45.family).toBe("seedream");
    expect(seedream5Lite.family).toBe(seedream45.family);
    expect(seedream45.capabilities).toEqual(["prompt", "multiReference", "aspectRatio", "safetyToggle"]);
    expect(seedream5Lite.capabilities).toEqual(["prompt", "multiReference", "aspectRatio", "outputFormat"]);
  });

  it("uses the active row's normalized reference capacity on both endpoints", () => {
    const row = seedreamRow(2);
    for (const endpoint of [seedream45, seedream5Lite]) {
      expect(endpoint.validateRequest?.(row, { referenceCount: 2, usesLora: false })).toEqual([]);
      expect(endpoint.validateRequest?.(row, { referenceCount: 3, usesLora: false })).toEqual([
        "Seedream Fixture accepts at most 2 reference image(s), but this render carries 3.",
      ]);
    }
  });

  it("adds no prompt rewrite or execution budget that would change the existing request", () => {
    for (const endpoint of [seedream45, seedream5Lite]) {
      expect(endpoint.preparePrompt).toBeUndefined();
      expect(endpoint.executionHints).toBeUndefined();
    }
  });
});
