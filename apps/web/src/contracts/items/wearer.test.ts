import { describe, expect, it } from "vitest";
import { expectCaseInsensitiveLookup, expectUniqueIds } from "@/test/registry-invariants";
import { wearerMatchesFilter, wearerTargetById, wearerTargets } from "./wearer";

describe("wearer-target registry", () => {
  it("has unique ids", () => {
    expectUniqueIds(wearerTargets, "wearerTargets");
  });

  it("looks up case-insensitively and misses cleanly", () => {
    expectCaseInsensitiveLookup(
      wearerTargetById,
      [
        { raw: "Feminine", id: "feminine" },
        { raw: " Unisex ", id: "unisex" },
      ],
      "androgynous",
    );
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
