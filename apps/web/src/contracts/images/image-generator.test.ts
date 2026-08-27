import { describe, expect, it } from "vitest";
import type { ImageRenderControls } from "@vesper/image-core";
import {
  IMAGE_GENERATOR_MAX_PROVIDER_INPUTS,
  imageGeneratorControlsSchema,
  imageGeneratorCreateRunRequestSchema,
  imageGeneratorDiagnosticCode,
  imageGeneratorFailureCodes,
  imageGeneratorRunSchema,
} from "./image-generator";

/**
 * The Generator run contracts: the create-time contradictions the schema owns,
 * the failure-code spelling stored rows and diagnostics depend on, and the
 * read-back degradation the wire schema promises. Runtime facts (model, pin,
 * capacity, readable inputs) are runner checks and are covered by the runner's
 * integration suite, not here.
 */

describe("imageGeneratorCreateRunRequestSchema", () => {
  const base = { modelId: "imgmdlaaaaaaaaaaaaaaaaaa", prompt: "a lighthouse at dusk" };

  it("refuses two dedicated inputs on one role — the runner could not attribute the control", () => {
    const twice = imageGeneratorCreateRunRequestSchema.safeParse({
      ...base,
      inputs: {
        primary: [],
        dedicated: [
          { role: "pose", imageId: "img1aaaaaaaaaaaaaaaaaaaa" },
          { role: "pose", imageId: "img2aaaaaaaaaaaaaaaaaaaa" },
        ],
      },
    });
    expect(twice.success).toBe(false);

    // Distinct roles are the legitimate shape and must stay accepted.
    const distinct = imageGeneratorCreateRunRequestSchema.safeParse({
      ...base,
      inputs: {
        primary: [{ imageId: "img1aaaaaaaaaaaaaaaaaaaa", purpose: "identity" }],
        dedicated: [
          { role: "pose", imageId: "img2aaaaaaaaaaaaaaaaaaaa" },
          { role: "depth", imageId: "img3aaaaaaaaaaaaaaaaaaaa" },
        ],
      },
    });
    expect(distinct.success).toBe(true);
  });

  it("caps the provider-input bag, and accepts a bag exactly at the cap", () => {
    const bag = (count: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${String(index)}`, index]));
    expect(
      imageGeneratorCreateRunRequestSchema.safeParse({
        ...base,
        providerInputs: bag(IMAGE_GENERATOR_MAX_PROVIDER_INPUTS),
      }).success,
    ).toBe(true);
    expect(
      imageGeneratorCreateRunRequestSchema.safeParse({
        ...base,
        providerInputs: bag(IMAGE_GENERATOR_MAX_PROVIDER_INPUTS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("imageGeneratorControlsSchema", () => {
  it("round-trips every ImageRenderControls field — the run contract accepts the whole vocabulary", () => {
    // `Required<...>` is the drift alarm: a field added to the package's
    // controls contract fails this literal at compile time, so the Generator
    // learns about new normalized controls the moment they exist.
    const full: Required<ImageRenderControls> = {
      seed: 7,
      negativePrompt: "no fog",
      guidance: 3.5,
      steps: 20,
      editStrength: 0.5,
      outputCount: 1,
      coherentSet: false,
      fastMode: false,
      thinkingMode: false,
      resolution: "2K",
      width: 512,
      height: 768,
      lora: { id: "loraaaaaaaaaaaaaaaaaaaaa", scale: 1 },
    };
    expect(imageGeneratorControlsSchema.parse(full)).toEqual(full);
  });
});

describe("imageGeneratorDiagnosticCode", () => {
  it("spells every code in the image_generator namespace — stored rows pin this spelling", () => {
    for (const code of imageGeneratorFailureCodes) {
      expect(imageGeneratorDiagnosticCode(code)).toBe(`image_generator.${code}`);
    }
  });
});

describe("imageGeneratorRunSchema", () => {
  const settled = {
    id: "genrunaaaaaaaaaaaaaaaaaa",
    status: "succeeded",
    modelSlug: "vesper-test/generator",
    requestedVersionId: "versionaaaaaaaaaaaaaaaaa",
    executedVersionId: "versionaaaaaaaaaaaaaaaaa",
    prompt: "a lighthouse at dusk",
    finalPrompt: "a lighthouse at dusk",
    inputs: { primary: [{ imageId: "img1aaaaaaaaaaaaaaaaaaaa", purpose: "style" }], dedicated: [] },
    controls: { seed: 11 },
    providerInputs: { num_inference_steps: 28 },
    sourceRunId: null,
    resultImageId: "imgoutaaaaaaaaaaaaaaaaaa",
    failureCode: null,
    error: null,
    predictionId: "pred_gen_1",
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:01.000Z",
    finishedAt: "2026-08-23T00:00:09.000Z",
    attempt: { modelSlug: "vesper-test/generator", seed: 11 },
  };

  it("parses a settled run verbatim", () => {
    const run = imageGeneratorRunSchema.parse(settled);
    expect(run.inputs.primary[0]?.purpose).toBe("style");
    expect(run.attempt).toEqual({ modelSlug: "vesper-test/generator", seed: 11 });
  });

  it("degrades each malformed bag to its empty default without losing the run", () => {
    const run = imageGeneratorRunSchema.parse({
      ...settled,
      inputs: { primary: [{ imageId: 42 }] },
      controls: { seed: -5 },
      providerInputs: { recipe: { nested: true } },
      attempt: "not-a-record",
    });
    // The row survives; each unreadable bag costs exactly its own content.
    expect(run.id).toBe(settled.id);
    expect(run.inputs).toEqual({ primary: [], dedicated: [] });
    expect(run.controls).toEqual({});
    expect(run.providerInputs).toEqual({});
    expect(run.attempt).toBeNull();
  });
});
