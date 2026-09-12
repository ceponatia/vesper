import { describe, expect, it } from "vitest";
import { type ImageModel, imageModelSchema } from "@vesper/image-core";
import { sanitizedProviderRequest } from "./image-generator-provenance";

/**
 * `sanitizedProviderRequest` / `sanitizedControlValue` (pure, no database): the
 * sent-request half of the pre-spend provenance record
 * (`effectiveRequestRecord`'s `providerRequest` field). Exercised directly here
 * rather than through the full `EffectiveRequestInput` assembly, which needs a
 * compiled plan, a shape resolution and a version request this module does not
 * touch.
 *
 * The defect this suite kills: a FLUX.2 klein `-base-lora` endpoint's
 * `lora_scales` field is a NUMBER ARRAY (`[0.9]`), not an address, and the
 * sanitizer's catch-all ("anything that is not a recognized scalar shape is
 * `[omitted]`") swallowed it — a klein run's stored record said its own scale
 * was omitted, contradicting the recipe's claim that the record proves which
 * scale reached the provider. `lora_weights` needed the matching array
 * treatment on the LOCATOR side, so an array of one real URL does not survive
 * sanitization as one real URL either.
 */

function loraArrayModel(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model_klein_base_lora",
    slug: "black-forest-labs/flux-2-klein-4b-base-lora",
    label: "FLUX.2 Klein 4B (base, LoRA)",
    canGenerate: true,
    canEdit: true,
    referenceField: "images",
    referenceArity: "array",
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string", arity: "array" },
        loraScale: { field: "lora_scales", type: "number", arity: "array" },
      },
      knownInputFields: ["lora_weights", "lora_scales"],
    },
    ...overrides,
  });
}

function loraScalarModel(overrides: Partial<ImageModel> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "model_qwen_edit_2511",
    slug: "qwen/qwen-image-edit-2511",
    label: "Qwen Image Edit 2511",
    canGenerate: false,
    canEdit: true,
    referenceField: "image",
    referenceArity: "array",
    advancedCapabilities: {
      controls: {
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      },
      knownInputFields: ["lora_weights", "lora_scale"],
    },
    ...overrides,
  });
}

const NO_IMAGE_FIELDS = new Set<string>();

describe("sanitizedProviderRequest", () => {
  it("keeps an array-shaped LoRA scale instead of reporting it omitted (the klein array-scale case)", () => {
    const sanitized = sanitizedProviderRequest(loraArrayModel(), { lora_scales: [0.9] }, NO_IMAGE_FIELDS);
    expect(sanitized.lora_scales).toEqual([0.9]);
  });

  it("redacts an array-shaped LoRA locator element-wise, keeping the array's length (the klein array-locator case)", () => {
    const sanitized = sanitizedProviderRequest(
      loraArrayModel(),
      { lora_weights: ["https://cdn.example.invalid/klein-style.safetensors"] },
      NO_IMAGE_FIELDS,
    );
    expect(sanitized.lora_weights).toEqual(["[locator redacted]"]);
  });

  it("redacts a scalar LoRA locator the same way it always has (the Qwen scalar case, unchanged)", () => {
    const sanitized = sanitizedProviderRequest(
      loraScalarModel(),
      { lora_weights: "https://cdn.example.invalid/l.safetensors", lora_scale: 1.2 },
      NO_IMAGE_FIELDS,
    );
    expect(sanitized.lora_weights).toBe("[locator redacted]");
    // A scalar scale was never broken — recorded verbatim, same as any other number.
    expect(sanitized.lora_scale).toBe(1.2);
  });

  it("still reports an unrecognized non-array, non-string value as omitted (the existing catch-all, unregressed)", () => {
    const sanitized = sanitizedProviderRequest(loraScalarModel(), { weird_field: { foo: "bar" } }, NO_IMAGE_FIELDS);
    expect(sanitized.weird_field).toBe("[omitted]");
  });

  it("recurses into a nested array through the same rule, for any ordinary (non-LoRA) array field", () => {
    const sanitized = sanitizedProviderRequest(
      loraArrayModel(),
      { some_array_field: ["https://cdn.example.invalid/a.png", ["https://cdn.example.invalid/b.png", 3]] },
      NO_IMAGE_FIELDS,
    );
    expect(sanitized.some_array_field).toEqual(["[url redacted]", ["[url redacted]", 3]]);
  });
});
