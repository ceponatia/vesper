import { describe, expect, it } from "vitest";
import { clothingCategories } from "@/contracts";
import { clothingSlots, slotCategoryOptions, slotForCategory, wearerHintForGender } from "./clothing-slots";

describe("clothing slots", () => {
  it("every mapped category exists in the registry, and none is claimed twice", () => {
    const seen = new Set<string>();
    for (const slot of clothingSlots) {
      for (const category of slot.categories) {
        expect(clothingCategories.some((c) => c.id === category)).toBe(true);
        expect(seen.has(category)).toBe(false);
        seen.add(category);
      }
    }
  });

  it("resolves a category to its slot; unknown/absent land nowhere", () => {
    expect(slotForCategory("dress")?.id).toBe("tops");
    expect(slotForCategory("footwear")?.id).toBe("feet");
    expect(slotForCategory("not-a-category")).toBeUndefined();
    expect(slotForCategory(null)).toBeUndefined();
    expect(slotForCategory(undefined)).toBeUndefined();
  });

  it("slotCategoryOptions keeps registry order and labels", () => {
    const tops = clothingSlots.find((s) => s.id === "tops");
    if (!tops) throw new Error("missing tops slot");
    const options = slotCategoryOptions(tops);
    expect(options.map((o) => o.id)).toEqual(clothingCategories.filter((c) => tops.categories.includes(c.id)).map((c) => c.id));
    expect(options.every((o) => o.label.length > 0)).toBe(true);
  });

  it("wearer hint maps only the unambiguous presentations", () => {
    expect(wearerHintForGender("female")).toBe("feminine");
    expect(wearerHintForGender("male")).toBe("masculine");
    expect(wearerHintForGender("androgynous_born_female")).toBeUndefined();
    expect(wearerHintForGender(undefined)).toBeUndefined();
  });
});
