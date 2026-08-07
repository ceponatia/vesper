import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "@/contracts";
import { buildRegistryModelInput } from "../ai/replicate";
import {
  baseImageModelSlug,
  preparePromptForImageModel,
  QWEN_MULTI_REFERENCE_IDENTITY_LOCK,
  QWEN_SINGLE_REFERENCE_IDENTITY_LOCK,
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

  it("does not add guessed negatives to models whose defaults are already empty", () => {
    for (const slug of [
      "qwen/qwen-image-2512",
      "stability-ai/stable-diffusion-3.5-large",
      "nsfw-api/pony-realism-v2.3:version",
    ]) {
      const input = model(slug, { output_quality: 95 });
      expect(withReviewedImageQuality(input)).toBe(input);
      expect(input.extraInput).not.toHaveProperty("negative_prompt");
    }
  });

  it("turns off Qwen Edit's speed preset even when the probed row says true", () => {
    const input = model("qwen/qwen-image-edit-2511", { output_quality: 95, go_fast: true });
    const prepared = withReviewedImageQuality(input);
    expect(prepared).not.toBe(input);
    expect(prepared.extraInput).toEqual({ output_quality: 95, go_fast: false });
    expect(input.extraInput.go_fast).toBe(true); // the registry record is never mutated
  });

  it("uses full-step Juggernaut settings and clears its media-biased negative default", () => {
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
      negative_prompt: "",
      apply_watermark: false,
    });
    expect(buildRegistryModelInput(prepared, "portrait", [], null).negative_prompt).toBe("");
  });

  it("pins RealVis dimensions and clears its generic negative boilerplate", () => {
    const prepared = withReviewedImageQuality(
      model("nsfw-api/realvis-hyper-lora:version", {
        width: 512,
        height: 512,
        negative_prompt: "bad anatomy, extra limbs, text",
      }),
    );
    expect(prepared.extraInput).toMatchObject({
      width: 768,
      height: 1024,
      negative_prompt: "",
    });
    expect(buildRegistryModelInput(prepared, "portrait", [], null).negative_prompt).toBe("");
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

  it("rewrites EVERY copy of the legacy lock, so the rewrite is genuinely idempotent", () => {
    // The idempotency claim is load-bearing: `compileProfileRenderPlan` hashes
    // the prepared prompt and `renderWithModel` prepares again on the way out,
    // so a second pass that changed the text would make every identity-trial
    // cell refuse `cell_conflict` against its own compiled prompt. Under
    // `replace` a doubled lock kept its second copy, and the next pass rewrote
    // THAT one — the same function returning two different strings for one input.
    const doubled = `${LEGACY_LOCK} Then: ${LEGACY_LOCK} Change the setting.`;
    const once = preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), doubled, 1);
    expect(once).not.toContain(LEGACY_LOCK);
    expect(preparePromptForImageModel(model("qwen/qwen-image-edit-2511"), once, 1)).toBe(once);
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
