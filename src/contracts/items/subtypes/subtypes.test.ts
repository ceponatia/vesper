import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../../body/locations";
import {
  clothingSubtypeById,
  clothingSubtypeLabel,
  clothingSubtypesByCategory,
  clothingSubtypesForCategory,
} from "./index";

describe("clothing subtypes registry", () => {
  it("ids are globally unique across every category vocabulary", () => {
    const ids = [...clothingSubtypesByCategory.values()].flatMap((list) => list.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every coverage template id is a registered body location", () => {
    for (const [category, list] of clothingSubtypesByCategory) {
      for (const subtype of list) {
        for (const id of subtype.coverage ?? []) {
          expect(bodyLocationRegistry.byId(id), `${category}/${subtype.id} → ${id}`).toBeDefined();
        }
      }
    }
  });

  it("face piercings anchor to the lips/nose locations", () => {
    expect(clothingSubtypeById("lip_ring")?.coverage).toEqual(["lips"]);
    expect(clothingSubtypeById("nose_stud")?.coverage).toEqual(["nose"]);
    expect(clothingSubtypeById("septum_ring")?.coverage).toEqual(["nose"]);
  });

  it("category lookup returns the vocabulary, empty for unsubtyped categories", () => {
    expect(clothingSubtypesForCategory("jewelry").length).toBeGreaterThan(0);
    expect(clothingSubtypesForCategory("top")).toEqual([]);
    expect(clothingSubtypesForCategory(null)).toEqual([]);
  });

  it("id lookup is case-insensitive and misses cleanly; labels lowercase for prompts", () => {
    expect(clothingSubtypeById(" Nose_Ring ")?.id).toBe("nose_ring");
    expect(clothingSubtypeById("tuxedo")).toBeUndefined();
    expect(clothingSubtypeLabel("masquerade_mask")).toBe("masquerade mask");
    expect(clothingSubtypeLabel(undefined)).toBeUndefined();
  });
});
