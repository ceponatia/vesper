import { describe, expect, it } from "vitest";
import { expectCaseInsensitiveLookup, expectRefsResolve, expectUniqueIds } from "@/test/registry-invariants";
import { bodyLocationRegistry } from "../body/locations";
import { clothingCategories, clothingCategoryById } from "./clothing-categories";

describe("clothing categories registry", () => {
  it("has unique ids", () => {
    expectUniqueIds(clothingCategories, "clothingCategories");
  });

  it("every coverage template id is a registered body location", () => {
    expectRefsResolve(
      clothingCategories,
      (category) => category.coverage,
      (id) => bodyLocationRegistry.byId(id),
      (category, id) => `${category.id} → ${id}`,
    );
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expectCaseInsensitiveLookup(
      clothingCategoryById,
      [
        { raw: "Top", id: "top" },
        { raw: " eyewear ", id: "eyewear" },
      ],
      "tuxedo",
    );
  });

  it("templates avoid over-covering parents (no feet from pants, no face from headwear)", () => {
    const pants = clothingCategoryById("pants");
    expect(pants?.coverage).not.toContain("legs"); // legs would imply feet via expand
    const headwear = clothingCategoryById("headwear");
    expect(headwear?.coverage).not.toContain("head"); // head would imply face + eyes
  });
});
