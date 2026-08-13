import { type ImageModel, imageModelSchema, withReviewedImageQuality } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import { buildRegistryModelInput } from "./payload";

/**
 * The seam between the reviewed quality presets (`@vesper/image-core`) and the
 * Replicate payload builder.
 *
 * The presets clear provider negative-prompt defaults that would suppress
 * exactly the output this app renders, and those defaults are invisible in the
 * payload because they are never sent. The preset rules themselves are covered
 * in the package (`models/quality-presets.test.ts`); what is asserted here is
 * that a cleared negative actually SURVIVES into the provider input rather than
 * being reinstated by the builder.
 */

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

describe("reviewed quality presets reaching the provider payload", () => {
  it("keeps Juggernaut's media-biased negative default cleared", () => {
    const prepared = withReviewedImageQuality(
      model("lucataco/juggernaut-xl-v9:bea09c", {
        num_inference_steps: 5,
        guidance_scale: 2,
        apply_watermark: false,
      }),
    );
    expect(buildRegistryModelInput(prepared, "portrait", [], null, true).negative_prompt).toBe("");
  });

  it("keeps RealVis's generic negative boilerplate cleared", () => {
    const prepared = withReviewedImageQuality(
      model("nsfw-api/realvis-hyper-lora:version", {
        width: 512,
        height: 512,
        negative_prompt: "bad anatomy, extra limbs, text",
      }),
    );
    expect(buildRegistryModelInput(prepared, "portrait", [], null, true).negative_prompt).toBe("");
  });

  it("keeps the Pony wrapper's `nsfw, naked` negative default cleared", () => {
    const prepared = withReviewedImageQuality(
      model("aisha-ai-official/likereality-pony-v1:version", { negative_prompt: "nsfw, naked" }),
    );
    expect(buildRegistryModelInput(prepared, "portrait", [], null, true).negative_prompt).toBe("");
  });
});
