import { imageModelSchema, imageResolutionTiers, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { generatorControlLabels, offeredResolutionTiers, reservedFieldHint } from "./model";

/**
 * Owner ruling 2026-09-30: a normalized control's label IS the provider
 * field the active version binds it to, never a Vesper-authored name, and
 * the lookup is generic over every model — keyed by the binding's own
 * `field`, never a model slug. The defect this file kills: a hand-written
 * label ("Guidance") silently drifting from the field a request actually
 * sends (`cfgScale`, `guidance`, …), which a tester would have no way to
 * notice short of reading the network request.
 */

function model(overrides: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "fixture-model",
    slug: "civitai/qwen-image-2.1",
    label: "Qwen Image 2.1 (Civitai)",
    canGenerate: true,
    canEdit: true,
    ...overrides,
  });
}

describe("generatorControlLabels", () => {
  it("labels every bound control with its own provider field, not a normalized name", () => {
    const labels = generatorControlLabels({
      seed: { field: "seed", type: "integer" },
      guidance: { field: "cfgScale", type: "number", minimum: 0, maximum: 30 },
      steps: { field: "steps", type: "integer", minimum: 1, maximum: 60 },
      editStrength: { field: "strength", type: "number" },
      thinkingMode: { field: "reasoning", type: "boolean" },
      fastMode: { field: "go_fast", type: "boolean" },
      resolutionTier: { field: "resolution", type: "enum", enumValues: ["1K", "2K"] },
      negativePrompt: { field: "negativePrompt", type: "string" },
      loraWeights: { field: "civitai_lora_version", type: "string" },
      loraScale: { field: "civitai_lora_strength", type: "number" },
    });

    expect(labels).toEqual({
      seed: "seed",
      guidance: "cfgScale",
      steps: "steps",
      editStrength: "strength",
      thinkingMode: "reasoning",
      fastMode: "go_fast",
      resolutionTier: "resolution",
      negativePrompt: "negativePrompt",
      loraWeights: "civitai_lora_version",
      loraScale: "civitai_lora_strength",
    });
  });

  it("falls back to the normalized English name for a control this version does not bind", () => {
    // Every key absent is the shape a version with no advanced capabilities
    // parses to — the fallback exists only because nothing renders a control
    // whose binding is absent, so a caller reading this map directly (as
    // this test does) must still get a sensible string back.
    expect(generatorControlLabels({})).toEqual({
      seed: "Seed",
      guidance: "Guidance",
      steps: "Steps",
      editStrength: "Edit strength",
      thinkingMode: "Thinking mode",
      fastMode: "Fast mode",
      resolutionTier: "Resolution",
      negativePrompt: "Negative prompt",
      loraWeights: "LoRA",
      loraScale: "Scale",
    });
  });
});

describe("offeredResolutionTiers", () => {
  it("narrows to the binding's own enumValues", () => {
    expect(offeredResolutionTiers({ field: "resolution", type: "enum", enumValues: ["1K", "2K"] })).toEqual([
      "1K",
      "2K",
    ]);
  });

  it("offers every known tier when the binding declares no enum", () => {
    expect(offeredResolutionTiers({ field: "resolution", type: "enum" })).toEqual(imageResolutionTiers);
  });

  it("offers every known tier when there is no binding at all", () => {
    expect(offeredResolutionTiers(undefined)).toEqual(imageResolutionTiers);
  });
});

describe("reservedFieldHint", () => {
  it("is empty for a model with no matching reserved descriptor", () => {
    expect(reservedFieldHint(model(), "cfgScale")).toBe("");
    expect(reservedFieldHint(null, "cfgScale")).toBe("");
    expect(reservedFieldHint(model(), undefined)).toBe("");
  });

  it("states the concrete value the row sends when the box is blank", () => {
    const withDefault = model({
      advancedCapabilities: {
        controls: { guidance: { field: "cfgScale", type: "number" } },
        providerInputs: [{ field: "cfgScale", type: "number", required: false, default: 1, reserved: true }],
      },
    });
    expect(reservedFieldHint(withDefault, "cfgScale")).toBe(" Blank sends 1.");
  });

  it("appends the row's own reviewed note for the field, exactly as recorded", () => {
    const withNote = model({
      advancedCapabilities: {
        controls: { resolutionTier: { field: "resolution", type: "enum", enumValues: ["1K", "2K"] } },
        providerInputs: [
          {
            field: "resolution",
            type: "enum",
            required: false,
            default: "1K",
            reserved: true,
            description:
              "1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.",
          },
        ],
      },
    });
    expect(reservedFieldHint(withNote, "resolution")).toBe(
      ' Blank sends "1K". 1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.',
    );
  });

  it("never reads a non-reserved descriptor for the same field", () => {
    // A field name can appear twice — once reserved (owned by a normalized
    // control), once not — only in a hand-built fixture; a real probe never
    // emits that. This still pins the reserved-only filter so a reserved
    // control's hint can never pick up an unrelated advanced-input note.
    const withUnreservedOnly = model({
      advancedCapabilities: {
        controls: {},
        providerInputs: [{ field: "cfgScale", type: "number", required: false, description: "not this one", reserved: false }],
      },
    });
    expect(reservedFieldHint(withUnreservedOnly, "cfgScale")).toBe("");
  });
});
