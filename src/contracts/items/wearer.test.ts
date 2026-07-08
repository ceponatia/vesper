import { describe, expect, it } from "vitest";
import { wearerMatchesFilter, wearerTargetById, wearerTargets } from "./wearer";

describe("wearer-target registry", () => {
  it("has unique ids", () => {
    const ids = wearerTargets.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expect(wearerTargetById("Feminine")?.label).toBe("Women's");
    expect(wearerTargetById("androgynous")).toBeUndefined();
  });

  it("absent and unisex match every filter — unisex is additive, never a silo", () => {
    for (const filter of ["feminine", "masculine", "unisex"]) {
      expect(wearerMatchesFilter(undefined, filter)).toBe(true);
      expect(wearerMatchesFilter("", filter)).toBe(true);
      expect(wearerMatchesFilter("unisex", filter)).toBe(true);
    }
  });

  it("a gendered value matches only its own filter (plus none it isn't)", () => {
    expect(wearerMatchesFilter("feminine", "feminine")).toBe(true);
    expect(wearerMatchesFilter("feminine", "masculine")).toBe(false);
    expect(wearerMatchesFilter("Masculine", "masculine")).toBe(true);
    expect(wearerMatchesFilter("masculine", "unisex")).toBe(false);
  });

  it("an unknown stored value degrades to match-everything, not match-nothing", () => {
    expect(wearerMatchesFilter("androgynous", "feminine")).toBe(true);
  });
});
