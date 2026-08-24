import { describe, expect, it } from "vitest";
import {
  emptyImageModelAdvancedCapabilities,
  imageInputBindingSchema,
  imageModelAdvancedCapabilitiesSchema,
  imageProviderInputDescriptorSchema,
  imageUriBindingSchema,
} from "./image-model-capabilities";

describe("imageModelAdvancedCapabilitiesSchema", () => {
  it("parses the empty object every row stores today into an inert capability set", () => {
    // The migration writes `'{}'::jsonb` on all six seeded rows and the probe does
    // not fill it until a later slice, so `{}` must be a valid "send no optional
    // control" value rather than a parse failure that empties the picker.
    expect(imageModelAdvancedCapabilitiesSchema.parse({})).toEqual(emptyImageModelAdvancedCapabilities());
  });

  it("assumes one output until a probe proves otherwise", () => {
    const { output, controls, additionalImageInputs, knownInputFields } = imageModelAdvancedCapabilitiesSchema.parse({});
    expect(output).toEqual({ arity: "single", supportsMultiple: false });
    expect(controls).toEqual({});
    expect(additionalImageInputs).toEqual([]);
    expect(knownInputFields).toEqual([]);
  });

  it("does not share its defaulted collections between two parsed rows", () => {
    // zod hands a default straight through without cloning, so a literal default
    // would make a probe writing to one model's allowlist rewrite every model's.
    const first = imageModelAdvancedCapabilitiesSchema.parse({});
    first.knownInputFields.push("prompt");
    first.additionalImageInputs.push({
      roleHint: "mask",
      binding: { field: "mask", arity: "single", required: false },
    });
    first.providerInputs.push({ field: "recipe", type: "string", required: false, reserved: false });
    expect(imageModelAdvancedCapabilitiesSchema.parse({}).knownInputFields).toEqual([]);
    expect(imageModelAdvancedCapabilitiesSchema.parse({}).additionalImageInputs).toEqual([]);
    expect(imageModelAdvancedCapabilitiesSchema.parse({}).providerInputs).toEqual([]);
  });

  it("reads a record probed before descriptors existed as offering no advanced fields", () => {
    // Every row probed before this slice stores controls/knownInputFields with
    // no providerInputs key; those rows must keep parsing, with an empty
    // descriptor list meaning "nothing to offer" rather than a failed parse.
    const parsed = imageModelAdvancedCapabilitiesSchema.parse({
      controls: { seed: { field: "seed", type: "integer" } },
      knownInputFields: ["prompt", "seed"],
    });
    expect(parsed.providerInputs).toEqual([]);
    expect(parsed.controls.seed?.field).toBe("seed");
  });

  it("keeps a probed control's own field name so the mapper never guesses one", () => {
    // One model calls it `cfg` and another `guidance`; the alias is resolved once,
    // by the probe, and stored verbatim.
    const parsed = imageModelAdvancedCapabilitiesSchema.parse({
      prompt: { field: "prompt", maxChars: 5000, recommendedChars: 1200 },
      controls: {
        guidance: { field: "cfg", type: "number", minimum: 1, maximum: 10 },
        steps: { field: "num_inference_steps", type: "integer", minimum: 1, maximum: 50 },
        loraScale: { field: "lora_scale", type: "number" },
      },
      knownInputFields: ["prompt", "cfg", "num_inference_steps", "lora_scale"],
    });
    expect(parsed.controls.guidance).toEqual({ field: "cfg", type: "number", minimum: 1, maximum: 10 });
    expect(parsed.controls.steps?.field).toBe("num_inference_steps");
    expect(parsed.prompt).toEqual({ field: "prompt", maxChars: 5000, recommendedChars: 1200 });
    // An unbound control stays absent — absent is what makes the mapper omit the key.
    expect(parsed.controls.thinkingMode).toBeUndefined();
  });

  it("records an extra image input under the role Vesper would feed it", () => {
    const parsed = imageModelAdvancedCapabilitiesSchema.parse({
      additionalImageInputs: [
        { roleHint: "mask", binding: { field: "mask", arity: "single", required: false } },
        { roleHint: "depth", binding: { field: "control_images", arity: "array", required: false, maxItems: 2 } },
      ],
    });
    expect(parsed.additionalImageInputs.map((entry) => entry.roleHint)).toEqual(["mask", "depth"]);
    expect(parsed.additionalImageInputs[1]?.binding.maxItems).toBe(2);
  });

  it("rejects an unregistered role hint rather than storing an unmappable input", () => {
    const result = imageModelAdvancedCapabilitiesSchema.safeParse({
      additionalImageInputs: [{ roleHint: "sketch", binding: { field: "sketch", arity: "single", required: false } }],
    });
    expect(result.success).toBe(false);
  });
});

describe("imageInputBindingSchema", () => {
  it("accepts a binding with no declared range, because plenty of schemas state it in prose", () => {
    const parsed = imageInputBindingSchema.parse({ field: "seed", type: "integer" });
    expect(parsed.minimum).toBeUndefined();
    expect(parsed.maximum).toBeUndefined();
  });

  it("refuses a type outside the registered primitives", () => {
    // `float` is not a JSON-schema primitive; accepting it would let a probe store
    // something the control mapper cannot decide how to send.
    expect(imageInputBindingSchema.safeParse({ field: "cfg", type: "float" }).success).toBe(false);
  });

  it("refuses an unnamed field", () => {
    expect(imageInputBindingSchema.safeParse({ field: "", type: "number" }).success).toBe(false);
  });
});

describe("imageProviderInputDescriptorSchema", () => {
  it("insists required and reserved are stated, never defaulted", () => {
    // Whether the provider demands the field, and whether the render path owns
    // it, are the two facts the Generator's advanced form is built on — a probe
    // that cannot determine them must say so rather than default.
    expect(imageProviderInputDescriptorSchema.safeParse({ field: "recipe", type: "string" }).success).toBe(false);
    expect(
      imageProviderInputDescriptorSchema.safeParse({ field: "recipe", type: "string", required: false }).success,
    ).toBe(false);
    expect(
      imageProviderInputDescriptorSchema.safeParse({ field: "recipe", type: "string", required: false, reserved: false })
        .success,
    ).toBe(true);
  });
});

describe("imageUriBindingSchema", () => {
  it("insists the probe says whether the model demands the image", () => {
    // Whether the model refuses to run without this input decides if a profile
    // using it can exist, so it must be stated, never defaulted.
    expect(imageUriBindingSchema.safeParse({ field: "mask", arity: "single" }).success).toBe(false);
    expect(imageUriBindingSchema.safeParse({ field: "mask", arity: "single", required: true }).success).toBe(true);
  });

  it("carries accepted formats, because a mask need not be WebP like Vesper's assets", () => {
    const parsed = imageUriBindingSchema.parse({
      field: "mask",
      arity: "single",
      required: false,
      acceptedFormats: ["png"],
    });
    expect(parsed.acceptedFormats).toEqual(["png"]);
  });
});
