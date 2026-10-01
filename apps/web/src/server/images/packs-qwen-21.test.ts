import { describe, expect, it } from "vitest";
import { qwenImage21Bindings, qwenImage21NegativePack, qwenImage21PositivePack } from "./packs-qwen-21";

/**
 * `civitai/qwen-image-2.1`'s seeded bindings (#663/#664 slice S2) — the
 * binding SHAPE, mirroring `packs-qwen-3.test.ts`'s own coverage for the
 * other Qwen endpoint that seeds its own file. Dialect wording is
 * `dialect-qwen-21.test.ts`'s job in `@vesper/image-core`; this file owns only
 * "does this endpoint bind exactly the two lanes acceptance #2 names, and
 * nothing more".
 */
describe("civitai/qwen-image-2.1 prompt-pack bindings", () => {
  it("binds exactly variant-standard and scene-standard — no portrait, no chat-look", () => {
    expect(qwenImage21Bindings).toHaveLength(3);
    expect(qwenImage21Bindings.map((binding) => [binding.task, binding.profileKey, binding.promptStrategy])).toEqual([
      ["variant", "variant-standard", "instruction_edit"],
      ["scene", "scene-standard", "instruction_edit"],
      ["scene", "scene-standard", "text_to_image_description"],
    ]);
  });

  it("every row names the same model, dialect and pack pair, active", () => {
    for (const binding of qwenImage21Bindings) {
      expect(binding.modelSlug).toBe("civitai/qwen-image-2.1");
      expect(binding.promptDialectId).toBe("qwen_21_instruction_edit");
      expect(binding.status).toBe("active");
      expect(binding.positivePackVersionId).toBe(qwenImage21PositivePack.id);
      expect(binding.negativePackVersionId).toBe(qwenImage21NegativePack.id);
    }
  });

  it("the scene chain's two rungs share one pack pair, so the look cannot change with which rung wins", () => {
    const edit = qwenImage21Bindings.find(
      (binding) => binding.task === "scene" && binding.promptStrategy === "instruction_edit",
    );
    const generate = qwenImage21Bindings.find(
      (binding) => binding.task === "scene" && binding.promptStrategy === "text_to_image_description",
    );
    expect(edit).toBeDefined();
    expect(generate).toBeDefined();
    expect(generate?.id).not.toBe(edit?.id);
    expect(generate?.positivePackVersionId).toBe(edit?.positivePackVersionId);
    expect(generate?.negativePackVersionId).toBe(edit?.negativePackVersionId);
  });

  it("registers no negative block — the dialect's own unsupported transport makes one moot", () => {
    expect(qwenImage21NegativePack.manifest.enabledBlockIds).toEqual([]);
  });

  it("binding ids are unique", () => {
    const ids = qwenImage21Bindings.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
