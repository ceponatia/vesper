import { describe, expect, it } from "vitest";
import { qwenImage2512, qwenImage3Edit, qwenImage3TextToImage, qwenImageEdit2511 } from "./families";
import { adapterForImageModel } from "./registry";
import { FAL_QWEN3_EDIT_SLUG, FAL_QWEN3_TEXT_SLUG, imageModelProvider } from "./provider";

/**
 * Adapter resolution.
 *
 * Replicate rows may carry `owner/name:version`, while fal Qwen Image 3 rows are
 * exact operation endpoints with a third path segment. The registry must resolve
 * both forms without prefix inheritance: similarly named siblings are separate
 * endpoints and a retired Replicate Qwen 3 slug must not inherit fal behavior.
 */
describe("adapterForImageModel", () => {
  it("resolves every registered Qwen endpoint", () => {
    expect(adapterForImageModel("qwen/qwen-image-edit-2511")).toBe(qwenImageEdit2511);
    expect(adapterForImageModel("qwen/qwen-image-2512")).toBe(qwenImage2512);
    expect(adapterForImageModel("alibaba/qwen-image-3/text-to-image")).toBe(qwenImage3TextToImage);
    expect(adapterForImageModel("alibaba/qwen-image-3/edit")).toBe(qwenImage3Edit);
    expect(
      adapterForImageModel(
        "qwen/qwen-image-edit-2511:2ef4a1e6dbbd5b8f0d8f3cbbd3a1cbee0b1d4c0f6ee1c8ad5b7f2e0c9a3d4b1e",
      ),
    ).toBe(qwenImageEdit2511);
  });

  it("keeps fal generation and edit adapters distinct even while their first semantic sets match", () => {
    expect(qwenImage3TextToImage).not.toBe(qwenImage3Edit);
    expect(qwenImage3TextToImage.capabilities).toEqual(["prompt", "seed", "negativePrompt"]);
    expect(qwenImage3Edit.capabilities).toEqual(qwenImage3TextToImage.capabilities);
  });

  it("declares runtime LoRA capability on the 2511 edit endpoint and not the generators/editors that lack it", () => {
    expect(qwenImageEdit2511.capabilities).toContain("lora");
    expect(qwenImage2512.capabilities).not.toContain("lora");
    expect(qwenImage3TextToImage.capabilities).not.toContain("lora");
    expect(qwenImage3Edit.capabilities).not.toContain("lora");
  });

  it.each([
    "bytedance/seedream-4.5",
    "qwen/qwen-image-edit-2511-turbo",
    "qwen/qwen-image-2",
    "qwen/qwen-image-2:266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd",
    // Retired Replicate Qwen Image 3 identities must not inherit the fal endpoint adapters.
    "alibaba/qwen-image-3",
    "alibaba/qwen-image-3-pro",
    "",
  ])("answers null for %s, which is the ordinary no-special-behavior case", (slug) => {
    expect(adapterForImageModel(slug)).toBeNull();
  });
});

describe("imageModelProvider", () => {
  it("classifies only the two reviewed fal endpoints as fal", () => {
    expect(imageModelProvider(FAL_QWEN3_TEXT_SLUG)).toBe("fal");
    expect(imageModelProvider(FAL_QWEN3_EDIT_SLUG)).toBe("fal");
    expect(imageModelProvider("alibaba/qwen-image-3")).toBe("replicate");
    expect(imageModelProvider("qwen/qwen-image-2512:version")).toBe("replicate");
  });
});
