import { describe, expect, it } from "vitest";
import { imageLoraSchema, imageModelSchema, type ImageLora, type ImageModel } from "@vesper/image-core";
import {
  CIVITAI_FLUX2_KLEIN4B_SLUG,
  FAL_QWEN3_EDIT_SLUG,
  FAL_QWEN3_TEXT_SLUG,
} from "@vesper/image-models";
import { imageLoraOptionLabel, imageModelOptionLabel } from "./image-model-option-label";

/**
 * Kills the long picker-label defect: model options must not expose registry
 * presentation suffixes or provider slugs, and a usable LoRA binding must win
 * over the same model's editing and generation capabilities.
 */

function model(overrides: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: "fixture-model",
    slug: "black-forest-labs/flux-2-klein-4b",
    label: "Flux 2 Klein 4B",
    canGenerate: true,
    canEdit: false,
    ...overrides,
  });
}

function lora(overrides: Record<string, unknown> = {}): ImageLora {
  return imageLoraSchema.parse({
    id: "fixture-lora",
    label: "Qwen Image 3 Ink Wash",
    locatorType: "huggingface_repo",
    locator: "artist/qwen-ink-wash-lora",
    compatibleModelSlugs: [FAL_QWEN3_EDIT_SLUG],
    defaultScale: 1,
    minimumScale: 0,
    maximumScale: 2,
    ...overrides,
  });
}

const loraWeights = { field: "lora_weights", type: "string" } as const;
const loraScale = { field: "lora_scale", type: "number" } as const;

describe("imageModelOptionLabel", () => {
  it("shows the curated Qwen name, generation use, and fal provider without its endpoint slug", () => {
    expect(
      imageModelOptionLabel(
        model({ slug: FAL_QWEN3_TEXT_SLUG, label: "Qwen Image 3 — Text to Image" }),
      ),
    ).toBe("Qwen Image 3 (TTS) - Fal.ai");
  });

  it("gives Edit precedence when a Replicate model can both generate and edit", () => {
    expect(
      imageModelOptionLabel(
        model({
          slug: "black-forest-labs/flux-2-klein-4b:active-version",
          label: "Flux 2 Klein 4B — Edit",
          canEdit: true,
        }),
      ),
    ).toBe("Flux 2 Klein 4B (Edit) - Replicate");
  });

  it("gives a usable LoRA pair the final use marker even on an editor", () => {
    expect(
      imageModelOptionLabel(
        model({
          label: "Flux 2 Klein 4B Base LoRA",
          canEdit: true,
          advancedCapabilities: { controls: { loraWeights, loraScale } },
        }),
      ),
    ).toBe("Flux 2 Klein 4B Base (LoRA) - Replicate");
  });

  it("names the Civitai LoRA lane from its curated model label and provider", () => {
    expect(
      imageModelOptionLabel(
        model({
          slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
          label: "FLUX.2 klein 4B (Civitai LoRA)",
          advancedCapabilities: { controls: { loraWeights, loraScale } },
        }),
      ),
    ).toBe("FLUX.2 klein 4B (LoRA) - Civitai");
  });

  it("does not advertise LoRA when only one binding of the pair is configured", () => {
    expect(
      imageModelOptionLabel(
        model({
          label: "Incomplete Adapter",
          canEdit: true,
          advancedCapabilities: { controls: { loraWeights } },
        }),
      ),
    ).toBe("Incomplete Adapter (Edit) - Replicate");
  });

  it("labels a registered row without generation, editing, or LoRA inputs as Unknown", () => {
    expect(
      imageModelOptionLabel(model({ label: "Metadata Only", canGenerate: false, canEdit: false })),
    ).toBe("Metadata Only (Unknown) - Replicate");
  });
});

describe("imageLoraOptionLabel", () => {
  it("removes a compatible model's repeated prefix while keeping the weights name", () => {
    const qwen = model({
      slug: `${FAL_QWEN3_EDIT_SLUG}:active-version`,
      label: "Qwen Image 3 — Edit",
      canEdit: true,
    });
    expect(imageLoraOptionLabel(lora(), [qwen])).toBe("Ink Wash");
    expect(imageLoraOptionLabel(lora({ label: "Landscape Lighting" }), [qwen])).toBe("Landscape Lighting");
  });

  it("shortens the seeded FLUX.2 RefControl weights using the compatible Base LoRA model's family name", () => {
    const kleinBaseLora = model({
      slug: "black-forest-labs/flux-2-klein-4b-base-lora",
      label: "FLUX.2 klein 4B Base LoRA",
      advancedCapabilities: { controls: { loraWeights, loraScale } },
    });
    const refControl = lora({
      label: "FLUX.2 klein 4B RefControl depth (pilot)",
      compatibleModelSlugs: ["black-forest-labs/flux-2-klein-4b-base-lora"],
    });
    expect(imageLoraOptionLabel(refControl, [kleinBaseLora])).toBe("RefControl depth (pilot)");
  });
});
