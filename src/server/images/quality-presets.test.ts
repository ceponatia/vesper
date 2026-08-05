import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "@/contracts";
import {
  baseImageModelSlug,
  JUGGERNAUT_MINIMAL_NEGATIVE,
  preparePromptForImageModel,
  QWEN_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_SINGLE_REFERENCE_IDENTITY_LOCK,
  STYLE_NEUTRAL_QUALITY_NEGATIVE,
  withReviewedImageQuality,
} from "./quality-presets";

const LEGACY_LOCK =
  "Generate a new image of the exact same person shown in the reference image. Preserve face, hair color and style, skin tone, body proportions, and apparent age.";

function model(slug: string, extraInput: Record<string, unknown> = {}): ImageModel {
  return imageModelSchema.parse({
    id: `model-${slug}`,
    slug,
    label: slug,
    canGenerate: true,
    canEdit: true,
    extraInput,
  });
}

describe("baseImageModelSlug", () => {
  it("matches pinned community models by their provider path", () => {
    expect(baseImageModelSlug("lucataco/juggernaut-xl-v9:abc123")).toBe("lucataco/juggernaut-xl-v9");
    expect(baseImageModelSlug("qwen/qwen-image-edit-2511")).toBe("qwen/qwen-image-edit-2511");
  });
});

describe("withReviewedImageQuality", () => {
  it("leaves an unreviewed model byte-for-byte alone", () => {
    const input = model("owner/experimental", { custom: 1 });
    expect(withReviewedImageQuality(input)).toBe(input);
  });

  it("turns off Qwen Edit's speed preset even when the probed row says true", () => {
    const input = model("qwen/qwen-image-edit-2511", { output_quality: 95, go_fast: true });
    const prepared = withReviewedImageQuality(input);
    expect(prepared).not.toBe(input);
    expect(prepared.extraInput).toEqual({ output_quality: 95, go_fast: false });
    expect(input.extraInput.go_fast).toBe(true); // the registry record is never mutated
  });

  it("uses the full-step Juggernaut v9 settings on a pinned row", () => {
    const prepared = withReviewedImageQuality(
      model("lucataco/juggernaut-xl-v9:bea09c", {
        num_inference_steps: 5,
        guidance_scale: 2,
        apply_watermark: false,
      }),
    );
    expect(prepared.extraInput).toMatchObject({
      num_inference_steps: 35,
      guidance_scale: 5,
      scheduler: "KarrasDPM",
      width: 832,
      height: 1216,
      negative_prompt: JUGGERNAUT_MINIMAL_NEGATIVE,
      apply_watermark: false,
    });
  });

  it("uses a style-neutral negative bank on mixed-style models", () => {
    for (const slug of [
      "qwen/qwen-image-2512",
      "stability-ai/stable-diffusion-3.5-large",
      "nsfw-api/realvis-hyper-lora:version",
    ]) {
      expect(withReviewedImageQuality(model(slug)).extraInput.negative_prompt).toBe(STYLE_NEUTRAL_QUALITY_NEGATIVE);
    }
    expect(STYLE_NEUTRAL_QUALITY_NEGATIVE).not.toMatch(/cartoon|anime|painting|illustration|multiple people/i);
  });

  it("adds Pony's low-score negatives without changing the shared bank", () => {
    const negative = withReviewedImageQuality(model("nsfw-api/pony-realism-v2.3:version")).extraInput
      .negative_prompt;
    expect(negative).toBe(`${STYLE_NEUTRAL_QUALITY_NEGATIVE}, score_1, score_2, score_3`);
  });
});

describe("preparePromptForImageModel", () => {
  it("numbers the identity reference and states the edit delta for Qwen Edit", () => {
    const prompt = `${LEGACY_LOCK} Change the pose: standing by the window.`;
    const prepared = preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), prompt, 1);
    expect(prepared).toContain(QWEN_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(prepared).not.toContain(LEGACY_LOCK);
    expect(prepared).toContain("Change the pose: standing by the window.");
  });

  it("uses a role-aware numbered lock when Qwen receives several references", () => {
    const prepared = preparePromptForImageModel(
      model("qwen/qwen-image-edit-2511"),
      `${LEGACY_LOCK} 3 reference images provided — image 1 is Mira; image 2 is Jo; image 3 is the cafe.`,
      3,
    );
    expect(prepared).toContain(QWEN_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(prepared).toContain("image 1 is Mira");
  });

  it("does not rewrite another model or an unreferenced/custom Qwen prompt", () => {
    const prompt = `${LEGACY_LOCK} Change the setting.`;
    expect(preparePromptForImageModel(model("bytedance/seedream-4.5"), prompt, 1)).toBe(prompt);
    expect(preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), prompt, 0)).toBe(prompt);
    expect(preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), "Repair the lettering only.", 1)).toBe(
      "Repair the lettering only.",
    );
  });
});
