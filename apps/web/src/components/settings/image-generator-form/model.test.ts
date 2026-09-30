import { imageModelSchema, imageResolutionTiers, type ImageModel } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { controlDefaultFacts, generatorControlLabels, offeredResolutionTiers, reservedFieldHint } from "./model";

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

function descriptor(overrides: Record<string, unknown>) {
  return { field: "cfgScale", type: "number", required: false, reserved: true, ...overrides };
}

describe("controlDefaultFacts", () => {
  it("is empty for a model with no matching reserved descriptor and no reviewed policy", () => {
    expect(controlDefaultFacts(model(), null, "cfgScale")).toEqual({ defaultClause: null, note: null });
    expect(controlDefaultFacts(null, null, "cfgScale")).toEqual({ defaultClause: null, note: null });
    expect(controlDefaultFacts(model(), "guidance", undefined)).toEqual({ defaultClause: null, note: null });
  });

  it("states a descriptor default neutrally — the provider applies it, not Vesper", () => {
    const withDefault = model({
      advancedCapabilities: {
        controls: { guidance: { field: "cfgScale", type: "number" } },
        providerInputs: [descriptor({ default: 1 })],
      },
    });
    expect(controlDefaultFacts(withDefault, "guidance", "cfgScale").defaultClause).toBe("Default: 1.");
  });

  it("renders a string default unquoted", () => {
    const withStringDefault = model({
      advancedCapabilities: {
        controls: { resolutionTier: { field: "resolution", type: "enum", enumValues: ["1K", "2K"] } },
        providerInputs: [descriptor({ field: "resolution", type: "enum", default: "1K" })],
      },
    });
    expect(controlDefaultFacts(withStringDefault, null, "resolution").defaultClause).toBe("Default: 1K.");
  });

  it("keeps 0 and false — real defaults, not absence", () => {
    const withZero = model({
      advancedCapabilities: { controls: {}, providerInputs: [descriptor({ default: 0 })] },
    });
    expect(controlDefaultFacts(withZero, null, "cfgScale").defaultClause).toBe("Default: 0.");

    const withFalse = model({
      advancedCapabilities: {
        controls: {},
        providerInputs: [descriptor({ field: "disable_safety_checker", type: "boolean", default: false })],
      },
    });
    expect(controlDefaultFacts(withFalse, null, "disable_safety_checker").defaultClause).toBe("Default: false.");
  });

  it("omits the descriptor default for an empty string, an empty array, or an empty object", () => {
    // FLUX.2 klein's probed `negative_prompt` default is exactly this case —
    // "" is the schema's way of declaring no default, not a real value a
    // blank box would send.
    const withEmptyString = model({
      advancedCapabilities: {
        controls: { negativePrompt: { field: "negative_prompt", type: "string" } },
        providerInputs: [descriptor({ field: "negative_prompt", type: "string", default: "" })],
      },
    });
    expect(controlDefaultFacts(withEmptyString, "negativePrompt", "negative_prompt").defaultClause).toBeNull();

    const withEmptyArray = model({
      advancedCapabilities: { controls: {}, providerInputs: [descriptor({ default: [] })] },
    });
    expect(controlDefaultFacts(withEmptyArray, null, "cfgScale").defaultClause).toBeNull();

    const withEmptyObject = model({
      advancedCapabilities: { controls: {}, providerInputs: [descriptor({ default: {} })] },
    });
    expect(controlDefaultFacts(withEmptyObject, null, "cfgScale").defaultClause).toBeNull();
  });

  it("carries the row's own reviewed note regardless of which branch stated a default", () => {
    const noteOnly = model({
      advancedCapabilities: {
        controls: { resolutionTier: { field: "resolution", type: "enum", enumValues: ["1K", "2K"] } },
        providerInputs: [
          descriptor({
            field: "resolution",
            type: "enum",
            description:
              "1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.",
          }),
        ],
      },
    });
    expect(controlDefaultFacts(noteOnly, null, "resolution")).toEqual({
      defaultClause: null,
      note: "1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.",
    });
  });

  it("never reads a non-reserved descriptor for the same field", () => {
    // A field name can appear twice — once reserved (owned by a normalized
    // control), once not — only in a hand-built fixture; a real probe never
    // emits that. This still pins the reserved-only filter so a reserved
    // control's hint can never pick up an unrelated advanced-input note.
    const withUnreservedOnly = model({
      advancedCapabilities: {
        controls: {},
        providerInputs: [descriptor({ description: "not this one", reserved: false })],
      },
    });
    expect(controlDefaultFacts(withUnreservedOnly, null, "cfgScale")).toEqual({ defaultClause: null, note: null });
  });

  describe("a reviewed policy's own default", () => {
    // `qwen/qwen-image-edit-2511` is a REAL row in the reviewed table
    // (`packages/image-core/src/models/reviewed-profile-controls.ts`):
    // production runs it with `fastMode: false` because its provider default
    // optimizes speed on a surface where fidelity matters. This is the exact
    // P2-1 defect a reviewer caught: the row's probed `go_fast` descriptor
    // can carry `default: true` (drizzle/0119) while the actual run sends
    // `false` — so the hint must state the REVIEWED value, never the
    // descriptor's, whenever both exist.
    function qwenEdit2511(providerInputs: unknown[]) {
      return model({
        slug: "qwen/qwen-image-edit-2511",
        advancedCapabilities: {
          controls: { fastMode: { field: "go_fast", type: "boolean" } },
          providerInputs,
        },
      });
    }

    it("states Vesper's reviewed value, worded as a fact about what blank sends", () => {
      const row = qwenEdit2511([descriptor({ field: "go_fast", type: "boolean", reserved: true })]);
      expect(controlDefaultFacts(row, "fastMode", "go_fast").defaultClause).toBe("Blank sends Vesper's reviewed false.");
    });

    it("outranks the row's own descriptor default when both exist", () => {
      const row = qwenEdit2511([descriptor({ field: "go_fast", type: "boolean", default: true, reserved: true })]);
      // Not "Default: true." — a blank box on this row sends the reviewed
      // false, never the descriptor's probed true, so only one clause may
      // ever print.
      expect(controlDefaultFacts(row, "fastMode", "go_fast").defaultClause).toBe("Blank sends Vesper's reviewed false.");
    });

    it("never fires for a control the reviewed vocabulary has no word for, or a model with no reviewed policy", () => {
      const row = qwenEdit2511([descriptor({ field: "go_fast", type: "boolean", default: true, reserved: true })]);
      // Passing null (the caller's own choice for seed/editStrength/resolutionTier/LoRA)
      // skips the reviewed lookup even on a row that HAS a policy, falling
      // through to the descriptor default.
      expect(controlDefaultFacts(row, null, "go_fast").defaultClause).toBe("Default: true.");
      // An unreviewed model never reaches the reviewed branch regardless of
      // which control key is asked for.
      expect(controlDefaultFacts(model(), "fastMode", "cfgScale").defaultClause).toBeNull();
    });

    it("states an empty reviewed value in words, unlike an empty descriptor default", () => {
      // `aisha-ai-official/likereality-pony-v1` reviews `negativePrompt: ""`
      // ON PURPOSE (it displaces the wrapper's hidden "nsfw, naked" default),
      // so — unlike the descriptor branch's emptiness gate — this must still
      // print.
      const row = model({
        slug: "aisha-ai-official/likereality-pony-v1",
        advancedCapabilities: {
          controls: { negativePrompt: { field: "negative_prompt", type: "string" } },
          providerInputs: [],
        },
      });
      expect(controlDefaultFacts(row, "negativePrompt", "negative_prompt").defaultClause).toBe(
        "Blank sends Vesper's reviewed an empty value.",
      );
    });
  });
});

describe("reservedFieldHint", () => {
  it("composes controlDefaultFacts into one appendable, space-prefixed string", () => {
    const withBoth = model({
      advancedCapabilities: {
        controls: { resolutionTier: { field: "resolution", type: "enum", enumValues: ["1K", "2K"] } },
        providerInputs: [
          descriptor({
            field: "resolution",
            type: "enum",
            default: "1K",
            description:
              "1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.",
          }),
        ],
      },
    });
    expect(reservedFieldHint(withBoth, null, "resolution")).toBe(
      " Default: 1K. 1K ≈ 1 MP, 2K ≈ 4 MP and ~4× the Buzz; on an edit the output follows the reference’s aspect.",
    );
  });

  it("is empty when controlDefaultFacts has neither a default clause nor a note", () => {
    expect(reservedFieldHint(model(), null, "cfgScale")).toBe("");
    expect(reservedFieldHint(null, null, "cfgScale")).toBe("");
    expect(reservedFieldHint(model(), null, undefined)).toBe("");
  });
});
