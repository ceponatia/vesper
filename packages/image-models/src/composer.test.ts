import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { defineImageModel, type ImageModelQuirk } from "./composer";
import type { ImageFeature } from "./features";

/**
 * The composer's merge contract (image-model-adapters.spec.md §"Composer and
 * Qwen family").
 *
 * Two defects are worth a permanent test here, and both are silent:
 *
 * - **A quirk's hook quietly overwritten by another quirk's.** A last-wins (or
 *   first-wins) merge produces an adapter that looks composed and behaves as if
 *   one of its quirks was never written — a prompt dialect that stops firing
 *   with nothing in any log to say so. The refusal has to happen at DEFINITION
 *   time, because that is the only moment a developer is present.
 * - **Refusals lost by an overwriting merge.** Feature validation accumulates
 *   on purpose: a caller must see every reason a pairing cannot work, not the
 *   first one somebody happened to list.
 *
 * Nothing here re-tests that the adapter has the right TypeScript shape — `tsc`
 * owns that, in this package's own project.
 */

const model: ImageModel = imageModelSchema.parse({
  id: "model-fixture",
  slug: "owner/fixture",
  label: "Fixture",
  canGenerate: true,
  canEdit: true,
});

const request = { referenceCount: 1, usesLora: false } as const;

function refusingFeature(id: string, reason: string): ImageFeature {
  return { id, semantic: `test feature ${id}`, validate: () => [reason] };
}

describe("defineImageModel", () => {
  it("accumulates every feature's refusals, then the quirk's, and publishes the feature ids", () => {
    const adapter = defineImageModel({
      family: "test",
      features: [refusingFeature("first", "first refusal"), refusingFeature("second", "second refusal")],
      quirks: [{ id: "quirk", validateRequest: () => ["quirk refusal"] }],
    });

    expect(adapter.capabilities).toEqual(["first", "second"]);
    expect(adapter.validateRequest?.(model, request)).toEqual(["first refusal", "second refusal", "quirk refusal"]);
  });

  it("takes each optional hook from the one quirk that claims it, and leaves unclaimed hooks absent", () => {
    const dialect: ImageModelQuirk = { id: "dialect", preparePrompt: (_model, prompt) => `${prompt}!` };
    const timing: ImageModelQuirk = { id: "timing", executionHints: { startupBudgetMs: 1_000 } };

    const composed = defineImageModel({ family: "test", features: [], quirks: [dialect, timing] });
    expect(composed.preparePrompt?.(model, "prompt", 1)).toBe("prompt!");
    expect(composed.executionHints).toEqual({ startupBudgetMs: 1_000 });
    // Nothing validates, so there is no validator — a caller reading a hook it
    // did not compose must see absence, not an inert function that never refuses.
    expect(composed.validateRequest).toBeUndefined();

    const bare = defineImageModel({ family: "test", features: [] });
    expect(bare.preparePrompt).toBeUndefined();
    expect(bare.executionHints).toBeUndefined();
  });

  it("refuses two quirks claiming the same hook, naming both", () => {
    const define = (): unknown =>
      defineImageModel({
        family: "test",
        features: [],
        quirks: [
          { id: "house-dialect", preparePrompt: (_model, prompt) => prompt },
          { id: "family-dialect", preparePrompt: (_model, prompt) => `${prompt} extra` },
        ],
      });

    expect(define).toThrow(/house-dialect/);
    expect(define).toThrow(/family-dialect/);
    expect(define).toThrow(/preparePrompt/);
  });

  it("refuses the same feature composed twice", () => {
    // `capabilities` is read as a set of claims; a repeated entry claims one
    // capability twice, which means nothing and hides a copy-paste.
    expect(() =>
      defineImageModel({
        family: "test",
        features: [refusingFeature("seed", "a"), refusingFeature("seed", "b")],
      }),
    ).toThrow(/seed/);
  });
});
