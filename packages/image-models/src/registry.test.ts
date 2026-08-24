import { describe, expect, it } from "vitest";
import { qwenImage2512, qwenImageEdit2511, qwenImageEditPlusLora } from "./families";
import { adapterForImageModel } from "./registry";

/**
 * Adapter resolution (image-model-adapters.plan.md §3).
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

  it.each(["bytedance/seedream-4.5", "qwen/qwen-image-edit-2511-turbo", ""])(
    "answers null for %s, which is the ordinary no-special-behavior case",
    (slug) => {
      expect(adapterForImageModel(slug)).toBeNull();
    },
  );
});
