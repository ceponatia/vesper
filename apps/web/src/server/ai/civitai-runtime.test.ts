import { describe, expect, it } from "vitest";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
import {
  CIVITAI_KLEIN_4B_VERSION_ID,
  CIVITAI_LORA_STRENGTH_FIELD,
  CIVITAI_LORA_VERSION_FIELD,
  civitaiKleinGraph,
  previewCivitaiKleinRequest,
} from "./civitai-runtime";

const MODEL = { slug: CIVITAI_FLUX2_KLEIN4B_SLUG };

describe("civitaiKleinGraph", () => {
  it("builds Civitai's pinned distilled 4B text-to-image graph", () => {
    expect(
      civitaiKleinGraph(MODEL, {
        prompt: "an adult woman in a studio portrait",
        aspect: "2:3",
        versionId: CIVITAI_KLEIN_4B_VERSION_ID,
        controlInput: { seed: 1234, negative_prompt: "blur" },
      }),
    ).toEqual({
      workflow: "txt2img",
      ecosystem: "Flux2Klein_4B",
      prompt: "an adult woman in a studio portrait",
      negativePrompt: "blur",
      quantity: 1,
      aspectRatio: "2:3",
      model: { id: 2612557 },
      seed: 1234,
    });
  });

  it("turns the curated Civitai download locator into a native LoRA resource without leaking its token", () => {
    const preview = previewCivitaiKleinRequest(MODEL, {
      prompt: "test",
      aspect: "1:1",
      versionId: CIVITAI_KLEIN_4B_VERSION_ID,
      controlInput: {
        [CIVITAI_LORA_VERSION_FIELD]:
          "https://civitai.com/api/download/models/2633618?token=super-secret-do-not-store",
        [CIVITAI_LORA_STRENGTH_FIELD]: 0.75,
      },
    });

    expect(preview.resources).toEqual([
      { id: 2633618, model: { type: "LORA" }, strength: 0.75 },
    ]);
    expect(JSON.stringify(preview)).not.toContain("super-secret-do-not-store");
    expect(JSON.stringify(preview)).not.toContain("api/download/models");
  });

  it("refuses an unparseable curated LoRA locator before a provider request", () => {
    expect(() =>
      civitaiKleinGraph(MODEL, {
        prompt: "test",
        aspect: null,
        controlInput: {
          [CIVITAI_LORA_VERSION_FIELD]: "not-a-version",
          [CIVITAI_LORA_STRENGTH_FIELD]: 1,
        },
      }),
    ).toThrow(/model-version id/i);
  });

  it("refuses aspect ratios outside Civitai's current Klein bucket list", () => {
    expect(() =>
      civitaiKleinGraph(MODEL, {
        prompt: "test",
        aspect: "9:16",
      }),
    ).toThrow(/does not support aspect ratio 9:16/i);
  });

  it("refuses a version pin other than Civitai's reviewed 4B checkpoint", () => {
    expect(() =>
      civitaiKleinGraph(MODEL, {
        prompt: "test",
        aspect: null,
        versionId: "wrong-version",
      }),
    ).toThrow(/pinned to Civitai version/i);
  });
});
