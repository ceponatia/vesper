import { describe, expect, it } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  imageModelAdvancedCapabilitiesSchema,
  type ImageModelAdvancedCapabilities,
} from "@/contracts";
import { mapImageRenderControls, validateProviderOverrides } from "./image-control-mapping";

/**
 * The control mapper's whole contract is "never guess a field". These cases are
 * therefore mostly about what does NOT reach the payload, and about the drop
 * entry each omission leaves behind — an omission with no reason recorded is
 * indistinguishable from a control the operator never set.
 */

function capabilities(over: Partial<ImageModelAdvancedCapabilities> = {}): ImageModelAdvancedCapabilities {
  return imageModelAdvancedCapabilitiesSchema.parse({
    controls: {
      negativePrompt: { field: "negative_prompt", type: "string" },
      guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
      steps: { field: "num_inference_steps", type: "integer", minimum: 1, maximum: 50 },
      thinkingMode: { field: "thinking_mode", type: "boolean" },
      resolutionTier: { field: "size", type: "enum", enumValues: ["1K", "2K", "4K"] },
    },
    knownInputFields: ["negative_prompt", "guidance_scale", "num_inference_steps", "scheduler"],
    ...over,
  });
}

describe("mapImageRenderControls", () => {
  it("writes each control to the field the ACTIVE version declared for it", () => {
    const mapped = mapImageRenderControls({
      controls: { negativePrompt: "blurry", guidance: 5.5, steps: 30, thinkingMode: true, resolution: "2K" },
      capabilities: capabilities(),
    });
    expect(mapped.input).toEqual({
      negative_prompt: "blurry",
      guidance_scale: 5.5,
      num_inference_steps: 30,
      thinking_mode: true,
      size: "2K",
    });
    // The normalized view is what a caller records; the provider view is what it sends.
    expect(mapped.applied).toEqual({
      negativePrompt: "blurry",
      guidance: 5.5,
      steps: 30,
      thinkingMode: true,
      resolution: "2K",
    });
    expect(mapped.dropped).toEqual([]);
  });

  it("sends nothing at all for an unprobed capability set", () => {
    // The inert `{}` every seeded row carries: no bindings means no optional
    // control is sent, which is exactly what every lane does today.
    const mapped = mapImageRenderControls({
      controls: { negativePrompt: "blurry", guidance: 5 },
      capabilities: emptyImageModelAdvancedCapabilities(),
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([
      { control: "negativePrompt", reason: "no_binding" },
      { control: "guidance", reason: "no_binding" },
    ]);
  });

  it("drops a control the version does not bind rather than guessing a field name", () => {
    const mapped = mapImageRenderControls({
      controls: { guidance: 5, editStrength: 0.4 },
      capabilities: capabilities(),
    });
    expect(mapped.input).toEqual({ guidance_scale: 5 });
    expect("strength" in mapped.input).toBe(false);
    expect(mapped.dropped).toEqual([{ control: "editStrength", reason: "no_binding" }]);
  });

  it("drops an out-of-range value instead of clamping it into something nobody asked for", () => {
    const mapped = mapImageRenderControls({ controls: { guidance: 40 }, capabilities: capabilities() });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([{ control: "guidance", reason: "invalid" }]);
  });

  it("keeps integer and number bindings apart", () => {
    // 28.5 into an integer field is a provider validation failure, not a rounding.
    const fractional = mapImageRenderControls({ controls: { steps: 28.5 }, capabilities: capabilities() });
    expect(fractional.dropped).toEqual([{ control: "steps", reason: "invalid" }]);
    const whole = mapImageRenderControls({ controls: { steps: 28 }, capabilities: capabilities() });
    expect(whole.input).toEqual({ num_inference_steps: 28 });
  });

  it("rejects a value whose type the binding does not declare", () => {
    const mapped = mapImageRenderControls({
      controls: { thinkingMode: true },
      capabilities: capabilities({
        controls: { thinkingMode: { field: "thinking_mode", type: "string" } },
      }),
    });
    expect(mapped.dropped).toEqual([{ control: "thinkingMode", reason: "invalid" }]);
  });

  it("rejects an enum value the version never listed, and any enum with no listed values", () => {
    const wrongMember = mapImageRenderControls({ controls: { resolution: "3K" }, capabilities: capabilities() });
    expect(wrongMember.dropped).toEqual([{ control: "resolution", reason: "invalid" }]);

    // No declared members leaves no way to tell a member from a typo, and a
    // typo'd enum is a provider error at spend time — so it fails closed.
    const unlisted = mapImageRenderControls({
      controls: { resolution: "2K" },
      capabilities: capabilities({ controls: { resolutionTier: { field: "size", type: "enum" } } }),
    });
    expect(unlisted.input).toEqual({});
    expect(unlisted.dropped).toEqual([{ control: "resolution", reason: "invalid" }]);
  });

  it("reports seed, coherent sets, and LoRA as unsupported rather than unbound", () => {
    // "Vesper does not send this yet" is a different fact from "this version has
    // no field for it", and a reader of the drop list must be able to tell them apart.
    const mapped = mapImageRenderControls({
      controls: { seed: 42, coherentSet: true, lora: { id: "lora-1", scale: 0.8 } },
      capabilities: capabilities(),
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([
      { control: "seed", reason: "unsupported" },
      { control: "coherentSet", reason: "unsupported" },
      { control: "lora", reason: "unsupported" },
    ]);
  });

  it("sends nothing for an empty control set", () => {
    const mapped = mapImageRenderControls({ controls: {}, capabilities: capabilities() });
    expect(mapped).toEqual({ input: {}, applied: {}, dropped: [] });
  });
});

describe("validateProviderOverrides", () => {
  it("passes a known field through untouched", () => {
    const validated = validateProviderOverrides({ scheduler: "KarrasDPM" }, capabilities().knownInputFields, []);
    expect(validated).toEqual({ input: { scheduler: "KarrasDPM" }, dropped: [] });
  });

  it("fails closed when the probe has recorded no known fields", () => {
    // Empty is "nothing recorded", never "anything goes": a provider rejects
    // unknown inputs outright, so an unprobed row must forward none of them.
    const validated = validateProviderOverrides({ scheduler: "KarrasDPM", go_fast: false }, [], []);
    expect(validated.input).toEqual({});
    expect(validated.dropped).toEqual([
      { control: "go_fast", reason: "unknown_field" },
      { control: "scheduler", reason: "unknown_field" },
    ]);
  });

  it("refuses a reserved field even when the probe lists it as a known input", () => {
    // `prompt` and the reference field ARE known inputs — that is exactly why the
    // allowlist alone cannot protect them.
    const validated = validateProviderOverrides(
      { prompt: "hijacked", image: "https://example.invalid/x.webp", scheduler: "KarrasDPM" },
      ["prompt", "image", "scheduler"],
      ["prompt", "image", "aspect_ratio", "version", "disable_safety_checker"],
    );
    expect(validated.input).toEqual({ scheduler: "KarrasDPM" });
    expect(validated.dropped).toEqual([
      { control: "image", reason: "reserved" },
      { control: "prompt", reason: "reserved" },
    ]);
  });

  it("drops an unknown field and keeps the known ones from the same bag", () => {
    const validated = validateProviderOverrides(
      { scheduler: "KarrasDPM", made_up_field: 1 },
      capabilities().knownInputFields,
      [],
    );
    expect(validated.input).toEqual({ scheduler: "KarrasDPM" });
    expect(validated.dropped).toEqual([{ control: "made_up_field", reason: "unknown_field" }]);
  });

  it("orders its output by field name so two identical configurations hash identically", () => {
    // The resolved controls are hashed for drift detection; a key order that
    // depended on object literal order would make an unchanged profile look moved.
    const one = validateProviderOverrides({ b: 2, a: 1 }, ["a", "b"], []);
    const two = validateProviderOverrides({ a: 1, b: 2 }, ["a", "b"], []);
    expect(Object.keys(one.input)).toEqual(["a", "b"]);
    expect(Object.keys(two.input)).toEqual(["a", "b"]);
  });
});
