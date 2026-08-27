import { describe, expect, it } from "vitest";
import { qwenImage2512, qwenImageEdit2511, qwenImageEditPlusLora } from "./families";
import { adapterForImageModel } from "./registry";

/**
 * Adapter resolution.
 *
 * The defect worth a permanent test is the version pin. A registry row's slug
 * may carry an `owner/name:version` suffix, and a lookup keyed on the raw slug
 * would return nothing for exactly the rows that were pinned for
 * reproducibility — no error, no diagnostic, just the family's prompt dialect
 * and cold-start budget quietly gone. The prefix case guards the same lookup
 * from the opposite direction: a differently-named sibling endpoint must not
 * inherit an adapter because its slug starts with a registered one.
 *
 * Null is asserted as the ORDINARY answer, not an error path: most registered
 * models have no adapter and must keep rendering exactly as they do today.
 */
describe("adapterForImageModel", () => {
  it("resolves every registered Qwen endpoint, pinned or bare", () => {
    expect(adapterForImageModel("qwen/qwen-image-edit-2511")).toBe(qwenImageEdit2511);
    expect(adapterForImageModel("qwen/qwen-image-edit-plus-lora")).toBe(qwenImageEditPlusLora);
    expect(adapterForImageModel("qwen/qwen-image-2512")).toBe(qwenImage2512);
    expect(
      adapterForImageModel(
        "qwen/qwen-image-edit-plus-lora:b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200",
      ),
    ).toBe(qwenImageEditPlusLora);
  });

  it("declares runtime LoRA capability on both Qwen edit endpoints", () => {
    // Replicate's current 2511 schema exposes lora_weights + lora_scale just as
    // the older 2509 wrapper does. The adapter is the family-level semantic
    // claim; the probed registry row still decides whether a concrete version
    // has the two provider bindings at render time.
    expect(qwenImageEdit2511.capabilities).toContain("lora");
    expect(qwenImageEditPlusLora.capabilities).toContain("lora");
    expect(qwenImage2512.capabilities).not.toContain("lora");
  });

  it.each(["bytedance/seedream-4.5", "qwen/qwen-image-edit-2511-turbo", ""])(
    "answers null for %s, which is the ordinary no-special-behavior case",
    (slug) => {
      expect(adapterForImageModel(slug)).toBeNull();
    },
  );
});
