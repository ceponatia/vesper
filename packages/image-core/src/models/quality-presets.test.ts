import { describe, expect, it } from "vitest";
import { imageModelSchema, type ImageModel } from "./image-models";
import { baseImageModelSlug, withReviewedImageQuality } from "./quality-presets";

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
    expect(baseImageModelSlug("nsfw-api/sdxl-pulid:abc123")).toBe("nsfw-api/sdxl-pulid");
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

  it("pins NSFW FLUX Dev off its 1024-square default", () => {
    // Its own default would lose a quarter of every frame to the 3:4 crop.
    const prepared = withReviewedImageQuality(
      model("aisha-ai-official/nsfw-flux-dev:version", { width: 1024, height: 1024, output_quality: 95 }),
    );
    expect(prepared.extraInput).toMatchObject({ width: 832, height: 1216, output_quality: 95 });
  });

  it("leaves a demoted community checkpoint on its wrapper defaults", () => {
    // Owner ruling (2026-08-16): Juggernaut, RealVis and Pony Realism left the
    // reviewed set. They are still addable from the admin screens, and an admin
    // who adds one now gets exactly what the wrapper ships with — no reviewed
    // dimensions, no cleared negative, and no object copy.
    for (const slug of [
      "lucataco/juggernaut-xl-v9:bea09c",
      "nsfw-api/realvis-hyper-lora:version",
      "nsfw-api/pony-realism-v2.3:version",
    ]) {
      const input = model(slug, { num_inference_steps: 5, negative_prompt: "bad anatomy" });
      expect(withReviewedImageQuality(input), slug).toBe(input);
    }
  });

  it("clears the Pony wrapper's `nsfw, naked` negative default", () => {
    // The provider default would suppress exactly the output this app renders,
    // and it is invisible in the payload because it is never sent.
    const prepared = withReviewedImageQuality(
      model("aisha-ai-official/likereality-pony-v1:version", { negative_prompt: "nsfw, naked" }),
    );
    expect(prepared.extraInput).toMatchObject({ width: 832, height: 1216, negative_prompt: "" });
  });

  it("pins PuLID to fidelity and off its 512-square default", () => {
    const prepared = withReviewedImageQuality(
      model("nsfw-api/sdxl-pulid:version", { width: 512, height: 512, method: "style" }),
    );
    expect(prepared.extraInput).toMatchObject({ width: 832, height: 1216, method: "fidelity" });
  });
});
