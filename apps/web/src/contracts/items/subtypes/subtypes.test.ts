import { describe, expect, it } from "vitest";
import { expectRefsResolve, expectUniqueIds } from "@/test/registry-invariants";
import { bodyLocationRegistry } from "../../body/locations";
import {
  clothingSubtypeById,
  clothingSubtypeLabel,
  clothingSubtypesByCategory,
  clothingSubtypesForCategory,
} from "./index";

/** Every subtype in every category vocabulary, tagged with the category it came from. */
const allSubtypes = [...clothingSubtypesByCategory].flatMap(([category, list]) =>
  list.map((subtype) => ({ ...subtype, category })),
);

describe("clothing subtypes registry", () => {
  it("ids are globally unique across every category vocabulary", () => {
    expectUniqueIds(allSubtypes, "clothingSubtypesByCategory");
  });

  it("every coverage template id is a registered body location", () => {
    expectRefsResolve(
      allSubtypes,
      (subtype) => subtype.coverage ?? [],
      (id) => bodyLocationRegistry.byId(id),
      (subtype, id) => `${subtype.category}/${subtype.id} → ${id}`,
    );
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
