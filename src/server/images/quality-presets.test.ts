import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "@/contracts";
import {
  baseImageModelSlug,
  COMMUNITY_ANATOMY_NEGATIVE,
  JUGGERNAUT_MINIMAL_NEGATIVE,
  preparePromptForImageModel,
  QWEN_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_SINGLE_REFERENCE_IDENTITY_LOCK,
  STATIC_PRODUCTION_NEGATIVE,
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

  it("uses only production steering where morphology is unknown", () => {
    for (const slug of ["qwen/qwen-image-2512", "stability-ai/stable-diffusion-3.5-large"]) {
      expect(withReviewedImageQuality(model(slug)).extraInput.negative_prompt).toBe(STATIC_PRODUCTION_NEGATIVE);
    }
    expect(STATIC_PRODUCTION_NEGATIVE).not.toMatch(
      /cartoon|anime|painting|illustration|multiple people|missing fingers|extra limbs|extra arms|extra legs|disfigured|mutated/i,
    );
  });

  it("uses compact anatomy steering only on reviewed community portrait pipelines", () => {
    expect(withReviewedImageQuality(model("nsfw-api/realvis-hyper-lora:version")).extraInput.negative_prompt).toBe(
      COMMUNITY_ANATOMY_NEGATIVE,
    );
    expect(COMMUNITY_ANATOMY_NEGATIVE).not.toMatch(/missing fingers|extra limbs|extra arms|extra legs|disfigured|mutated/i);
  });

  it("adds Pony's low-score negatives without changing the compact anatomy bank", () => {
    const negative = withReviewedImageQuality(model("nsfw-api/pony-realism-v2.3:version")).extraInput
      .negative_prompt;
    expect(negative).toBe(`${COMMUNITY_ANATOMY_NEGATIVE}, score_1, score_2, score_3`);
  });
});

describe("preparePromptForImageModel", () => {
  it("numbers the identity reference and states the edit delta for Qwen Edit", () => {
    const prompt = `${LEGACY_LOCK} Change the pose: standing by the window.`;
    const prepared = preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), prompt, 1);
    expect(prepared).toContain(QWEN_SINGLE_REFERENCE_IDENTITY_LOCK);
    expect(prepared).not.toContain(LEGACY_LOCK);
    expect(prepared).toContain("Change the pose: standing by the window.");
    expect(prepared.length).toBeLessThanOrEqual(prompt.length);
  });

  it("uses a role-aware numbered lock when Qwen receives several references", () => {
    const prompt = `${LEGACY_LOCK} 3 reference images provided — image 1 is Mira; image 2 is Jo; image 3 is the cafe.`;
    const prepared = preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), prompt, 3);
    expect(prepared).toContain(QWEN_MULTI_REFERENCE_IDENTITY_LOCK);
    expect(prepared).toContain("image 1 is Mira");
    expect(prepared.length).toBeLessThanOrEqual(prompt.length);
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
