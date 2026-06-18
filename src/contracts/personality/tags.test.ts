import { describe, expect, it } from "vitest";
import { interactionFamilies } from "./interactions";
import { canonicalTagId, dispositionTags, dispositionTagSchema, normalizeTag } from "./tags";

describe("disposition tags", () => {
  it("ids are unique, normalized, and every tag validates", () => {
    const ids = dispositionTags.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tag of dispositionTags) {
      expect(() => dispositionTagSchema.parse(tag)).not.toThrow();
      expect(tag.id).toBe(normalizeTag(tag.id)); // canonical ids are already normalized
    }
  });

  it("every tag declares a valid warmth lean and wontInitiate references real families", () => {
    const families = new Set(interactionFamilies());
    const warmthValues = new Set(["cold", "neutral", "warm"]);
    for (const tag of dispositionTags) {
      expect(warmthValues.has(tag.warmth)).toBe(true);
      for (const family of tag.wontInitiate) expect(families.has(family)).toBe(true);
    }
  });

  it("normalizeTag lowercases, hyphenates, and strips", () => {
    expect(normalizeTag("  Foot Fetish Positive! ")).toBe("foot-fetish-positive");
    expect(normalizeTag("Hot_Tempered")).toBe("hot-tempered");
  });

  it("canonicalTagId resolves near-misses to the canonical id, else undefined", () => {
    expect(canonicalTagId("Foot fetish positive")).toBe("foot-fetish-positive");
    expect(canonicalTagId("bratty")).toBe("bratty");
    expect(canonicalTagId("totally-made-up")).toBeUndefined();
  });
});
