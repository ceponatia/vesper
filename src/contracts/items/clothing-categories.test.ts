import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../body/locations";
import { clothingCategories, clothingCategoryById } from "./clothing-categories";

describe("clothing categories registry", () => {
  it("has unique ids", () => {
    const ids = clothingCategories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every coverage template id is a registered body location", () => {
    for (const category of clothingCategories) {
      for (const id of category.coverage) {
        expect(bodyLocationRegistry.byId(id), `${category.id} → ${id}`).toBeDefined();
      }
    }
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expect(clothingCategoryById("Top")?.id).toBe("top");
    expect(clothingCategoryById(" eyewear ")?.id).toBe("eyewear");
    expect(clothingCategoryById("tuxedo")).toBeUndefined();
  });

  it("templates avoid over-covering parents (no feet from pants, no face from headwear)", () => {
    const pants = clothingCategoryById("pants");
    expect(pants?.coverage).not.toContain("legs"); // legs would imply feet via expand
    const headwear = clothingCategoryById("headwear");
    expect(headwear?.coverage).not.toContain("head"); // head would imply face + eyes
  });
});
