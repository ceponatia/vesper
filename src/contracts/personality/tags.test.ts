import { describe, expect, it } from "vitest";
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
