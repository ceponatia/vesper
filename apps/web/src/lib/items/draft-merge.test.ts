import { describe, expect, it } from "vitest";
import type { ItemDefinitionParts } from "@/lib/client/api";
import { mergeItemDraft } from "./draft-merge";

/**
 * ✦ Draft from description fills EMPTY fields only
 * (docs/authoring/manual-editing.md §The item editor). Falsified by a merge
 * that lets a proposal win over an authored value — the hair-occlusion
 * override is the case the issue named, and null is its empty state.
 */
const headscarf = (hairOcclusion: ItemDefinitionParts["hairOcclusion"]): ItemDefinitionParts => ({
  coverage: ["hair", "ears"],
  category: "headwear",
  subtype: "headscarf",
  wearer: null,
  color: null,
  hairOcclusion,
  layer: 2,
  opacity: "opaque",
  sensory: {},
  fields: {},
});

describe("mergeItemDraft", () => {
  it("never overwrites an authored hair-occlusion override; fills it only from empty", () => {
    expect(mergeItemDraft(headscarf("full"), { hairOcclusion: "partial" }).hairOcclusion).toBe("full");
    expect(mergeItemDraft(headscarf(null), { hairOcclusion: "partial" }).hairOcclusion).toBe("partial");
    // A proposal for an item that is not headwear once merged has nothing to override.
    expect(
      mergeItemDraft({ ...headscarf(null), category: "jewelry", subtype: null }, { hairOcclusion: "partial" })
        .hairOcclusion,
    ).toBeNull();
  });
});
