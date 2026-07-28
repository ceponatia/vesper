import { describe, expect, it } from "vitest";
import { expectCaseInsensitiveLookup, expectUniqueIds } from "@/test/registry-invariants";
import { colorFamilies, colorFamilyById, colorFamilySortIndex } from "./colors";

describe("color-family registry", () => {
  it("has unique ids and a swatch hex per family", () => {
    expectUniqueIds(colorFamilies, "colorFamilies");
    for (const family of colorFamilies) expect(family.swatch).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expectCaseInsensitiveLookup(
      colorFamilyById,
      [
        { raw: "Blue", id: "blue" },
        { raw: " gold ", id: "gold" },
      ],
      "chartreuse",
    );
  });

  it("sorts by registry position, unknown and absent last", () => {
    expect(colorFamilySortIndex("black")).toBe(0);
    expect(colorFamilySortIndex("blue")).toBeLessThan(colorFamilySortIndex("pink"));
    expect(colorFamilySortIndex("chartreuse")).toBeGreaterThan(colorFamilySortIndex("multicolor"));
    expect(colorFamilySortIndex(undefined)).toBeGreaterThan(colorFamilySortIndex("multicolor"));
  });
});
