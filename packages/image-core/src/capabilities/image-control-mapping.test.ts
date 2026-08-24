import { describe, expect, it } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  imageModelAdvancedCapabilitiesSchema,
  type ImageModelAdvancedCapabilities,
  type ImageModelControlBindings,
} from "./image-model-capabilities";
import { filterReservedInputFields, mapImageRenderControls, validateProviderOverrides } from "./image-control-mapping";

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
      fastMode: { field: "go_fast", type: "boolean" },
      resolutionTier: { field: "size", type: "enum", enumValues: ["1K", "2K", "4K"] },
    },
    knownInputFields: ["negative_prompt", "guidance_scale", "num_inference_steps", "scheduler"],
    ...over,
  });
}

/** The live Qwen LoRA pair, as the probe records it from the version's schema. */
function loraCapabilities(over: Partial<ImageModelControlBindings> = {}): ImageModelAdvancedCapabilities {
  return capabilities({
    controls: {
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      ...over,
    },
  });
}

describe("mapImageRenderControls", () => {
  it("writes each control to the field the ACTIVE version declared for it", () => {
    const mapped = mapImageRenderControls({
      // `fastMode: false` rather than true on purpose: the wrappers that expose
      // an accelerated path default it ON, so refusing it is the request that
      // has to survive. A mapper that skipped falsy values would drop it here
      // and the render would quietly run fast anyway.
      controls: {
        negativePrompt: "blurry",
        guidance: 5.5,
        steps: 30,
        thinkingMode: true,
        fastMode: false,
        resolution: "2K",
      },
      capabilities: capabilities(),
    });
    expect(mapped.input).toEqual({
      negative_prompt: "blurry",
      guidance_scale: 5.5,
      num_inference_steps: 30,
      thinking_mode: true,
      go_fast: false,
      size: "2K",
    });
    // The normalized view is what a caller records; the provider view is what it sends.
    expect(mapped.applied).toEqual({
      negativePrompt: "blurry",
      guidance: 5.5,
      steps: 30,
      thinkingMode: true,
      fastMode: false,
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

  it("reports coherent sets and an UNRESOLVED LoRA as unsupported rather than unbound", () => {
    // "Vesper does not send this yet" is a different fact from "this version has
    // no field for it", and a reader of the drop list must be able to tell them apart.
    // A bare `controls.lora` is a REQUEST for a library row, and this module has no
    // library — sending its id, or guessing a locator from it, is the fabrication
    // the drop exists to prevent. A seed is neither: it left the unsupported list
    // with its transport and now drops like any other unbound control.
    const mapped = mapImageRenderControls({
      controls: { seed: 42, coherentSet: true, lora: { id: "lora-1", scale: 0.8 } },
      capabilities: capabilities(),
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([
      { control: "coherentSet", reason: "unsupported" },
      { control: "lora", reason: "unsupported" },
      { control: "seed", reason: "no_binding" },
    ]);
  });

  it("maps a seed through the version's seed binding and validates its range", () => {
    const caps = capabilities({
      controls: { seed: { field: "seed", type: "integer", minimum: 0, maximum: 100 } },
    });
    const inRange = mapImageRenderControls({ controls: { seed: 42 }, capabilities: caps });
    expect(inRange.input).toEqual({ seed: 42 });
    expect(inRange.applied).toEqual({ seed: 42 });
    expect(inRange.dropped).toEqual([]);

    // Out of range is a drop, never a clamp — same rule as every numeric control.
    const outOfRange = mapImageRenderControls({ controls: { seed: 101 }, capabilities: caps });
    expect(outOfRange.input).toEqual({});
    expect(outOfRange.dropped).toEqual([{ control: "seed", reason: "invalid" }]);
  });

  it("drops a seed as no_binding on an unprobed capability set", () => {
    const mapped = mapImageRenderControls({
      controls: { seed: 7 },
      capabilities: emptyImageModelAdvancedCapabilities(),
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([{ control: "seed", reason: "no_binding" }]);
  });

  it("sends a RESOLVED LoRA's locator and scale, and records neither the locator nor a second entry", () => {
    const mapped = mapImageRenderControls({
      controls: { lora: { id: "lora-1", scale: 0.8 } },
      capabilities: loraCapabilities(),
      resolvedLora: { id: "lora-1", locator: "owner/style-lora", scale: 0.8 },
    });
    expect(mapped.input).toEqual({ lora_weights: "owner/style-lora", lora_scale: 0.8 });
    // `applied` is what a caller stores and reports, and a signed URL's query string
    // has no business in a saved record — so the id and the scale go, the locator
    // never does.
    expect(mapped.applied).toEqual({ lora: { id: "lora-1", scale: 0.8 } });
    expect(mapped.dropped).toEqual([]);
  });

  it("drops the whole LoRA once when the version binds neither field", () => {
    // Once, not twice: the pair is all-or-nothing (a locator with no scale beside it
    // runs at the model's own strength), and two entries would read as two problems.
    const mapped = mapImageRenderControls({
      controls: {},
      capabilities: capabilities(),
      resolvedLora: { id: "lora-1", locator: "owner/style-lora", scale: 0.8 },
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([{ control: "lora", reason: "no_binding" }]);
  });

  it("drops the whole LoRA when the version binds only one of the two fields", () => {
    const mapped = mapImageRenderControls({
      controls: {},
      capabilities: loraCapabilities({ loraScale: undefined }),
      resolvedLora: { id: "lora-1", locator: "owner/style-lora", scale: 0.8 },
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([{ control: "lora", reason: "no_binding" }]);
  });

  it("drops a scale the version's own binding refuses instead of clamping it", () => {
    const mapped = mapImageRenderControls({
      controls: {},
      capabilities: loraCapabilities(),
      resolvedLora: { id: "lora-1", locator: "owner/style-lora", scale: 9 },
    });
    expect(mapped.input).toEqual({});
    expect(mapped.dropped).toEqual([{ control: "lora", reason: "invalid" }]);
  });

  it("sends nothing for an empty control set", () => {
    const mapped = mapImageRenderControls({ controls: {}, capabilities: capabilities() });
    expect(mapped).toEqual({ input: {}, applied: {}, appliedFields: {}, dropped: [] });
  });

  it("records the provider field each applied control was written to", () => {
    // `appliedFields` is what lets the compile step's reserved filter remove the
    // matching normalized entry without a second copy of the alias table.
    const mapped = mapImageRenderControls({
      controls: { guidance: 5, resolution: "2K" },
      capabilities: capabilities(),
    });
    expect(mapped.appliedFields).toEqual({ guidance: ["guidance_scale"], resolution: ["size"] });

    const lora = mapImageRenderControls({
      controls: {},
      capabilities: loraCapabilities(),
      resolvedLora: { id: "lora-1", locator: "owner/style-lora", scale: 0.8 },
    });
    expect(lora.appliedFields).toEqual({ lora: ["lora_weights", "lora_scale"] });
  });
});

describe("filterReservedInputFields", () => {
  it("drops a MAPPED control that landed on a render-path field, with the reason recorded", () => {
    // The case that motivates this: a size-mode model's shape key is `size`, and
    // `resolutionTier` is commonly probed as `size` too. The mapper cannot know —
    // it sees bindings, not the model row — so the collision is caught here,
    // before the value enters a payload the caller is about to fingerprint.
    const mapped = mapImageRenderControls({
      controls: { resolution: "2K", guidance: 5 },
      capabilities: capabilities(),
    });
    const filtered = filterReservedInputFields(mapped.input, ["prompt", "image", "size", "version"]);
    expect(filtered.input).toEqual({ guidance_scale: 5 });
    expect(filtered.dropped).toEqual([{ control: "size", reason: "reserved" }]);
  });

  it("passes an uncontested payload through and reports nothing", () => {
    const filtered = filterReservedInputFields({ guidance_scale: 5 }, ["prompt", "image", "aspect_ratio"]);
    expect(filtered).toEqual({ input: { guidance_scale: 5 }, dropped: [] });
  });

  it("orders its output by field name so two identical payloads hash identically", () => {
    // Same reason `validateProviderOverrides` sorts: the resolved controls are
    // fingerprinted for drift detection, and an order that depended on the
    // mapper's traversal would make an unchanged profile look moved.
    const one = filterReservedInputFields({ b: 2, a: 1 }, []);
    const two = filterReservedInputFields({ a: 1, b: 2 }, []);
    expect(Object.keys(one.input)).toEqual(["a", "b"]);
    expect(Object.keys(two.input)).toEqual(["a", "b"]);
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
