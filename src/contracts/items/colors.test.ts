import { describe, expect, it } from "vitest";
import { colorFamilies, colorFamilyById, colorFamilySortIndex } from "./colors";

describe("color-family registry", () => {
  it("has unique ids and a swatch hex per family", () => {
    const ids = colorFamilies.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of colorFamilies) expect(family.swatch).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expect(colorFamilyById("Blue")?.id).toBe("blue");
    expect(colorFamilyById(" gold ")?.label).toBe("Gold");
    expect(colorFamilyById("chartreuse")).toBeUndefined();
  });

  it("sorts by registry position, unknown and absent last", () => {
    expect(colorFamilySortIndex("black")).toBe(0);
    expect(colorFamilySortIndex("blue")).toBeLessThan(colorFamilySortIndex("pink"));
    expect(colorFamilySortIndex("chartreuse")).toBeGreaterThan(colorFamilySortIndex("multicolor"));
    expect(colorFamilySortIndex(undefined)).toBeGreaterThan(colorFamilySortIndex("multicolor"));
  });
});
