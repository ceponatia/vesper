import { describe, expect, it } from "vitest";
import { qwenImage3CharacterPacks, qwenImage3ProCharacterPacks } from "./packs-qwen-3";

const EXPECTED = [
  ["portrait", "text_to_image_description"],
  ["variant", "instruction_edit"],
  ["scene", "instruction_edit"],
  ["scene", "text_to_image_description"],
] as const;

describe("Qwen Image 3 prompt-pack bindings", () => {
  it.each([
    ["alibaba/qwen-image-3", qwenImage3CharacterPacks],
    ["alibaba/qwen-image-3-pro", qwenImage3ProCharacterPacks],
  ] as const)("binds every character lane for %s", (modelSlug, packs) => {
    expect(packs.bindings).toHaveLength(4);
    expect(packs.bindings.map((binding) => [binding.task, binding.promptStrategy])).toEqual(EXPECTED);
    expect(packs.bindings.every((binding) => binding.modelSlug === modelSlug)).toBe(true);
    expect(packs.bindings.every((binding) => binding.status === "active")).toBe(true);
  });

  it("keeps regular and Pro pack identities independent for later tuning", () => {
    expect(qwenImage3CharacterPacks.positive.id).not.toBe(qwenImage3ProCharacterPacks.positive.id);
    expect(qwenImage3CharacterPacks.negative.id).not.toBe(qwenImage3ProCharacterPacks.negative.id);
    expect(qwenImage3CharacterPacks.bindings.map((binding) => binding.id)).not.toEqual(
      qwenImage3ProCharacterPacks.bindings.map((binding) => binding.id),
    );
  });
});
