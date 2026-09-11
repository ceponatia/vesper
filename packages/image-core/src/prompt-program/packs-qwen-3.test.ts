import { describe, expect, it } from "vitest";
import { qwenImage3EditCharacterPacks, qwenImage3TextCharacterPacks } from "./packs-qwen-3";

describe("fal Qwen Image 3 prompt-pack bindings", () => {
  it("binds the prompt-only endpoint only to portrait generation", () => {
    expect(qwenImage3TextCharacterPacks.bindings).toHaveLength(1);
    expect(qwenImage3TextCharacterPacks.bindings.map((binding) => [binding.task, binding.promptStrategy])).toEqual([
      ["portrait", "text_to_image_description"],
    ]);
    expect(
      qwenImage3TextCharacterPacks.bindings.every(
        (binding) => binding.modelSlug === "alibaba/qwen-image-3/text-to-image" && binding.status === "active",
      ),
    ).toBe(true);
  });

  it("binds the edit endpoint to variant and scene instruction edits", () => {
    expect(qwenImage3EditCharacterPacks.bindings).toHaveLength(2);
    expect(qwenImage3EditCharacterPacks.bindings.map((binding) => [binding.task, binding.promptStrategy])).toEqual([
      ["variant", "instruction_edit"],
      ["scene", "instruction_edit"],
    ]);
    expect(
      qwenImage3EditCharacterPacks.bindings.every(
        (binding) => binding.modelSlug === "alibaba/qwen-image-3/edit" && binding.status === "active",
      ),
    ).toBe(true);
  });

  it("keeps generation and edit pack identities independent for later tuning", () => {
    expect(qwenImage3TextCharacterPacks.positive.id).not.toBe(qwenImage3EditCharacterPacks.positive.id);
    expect(qwenImage3TextCharacterPacks.negative.id).not.toBe(qwenImage3EditCharacterPacks.negative.id);
  });
});
