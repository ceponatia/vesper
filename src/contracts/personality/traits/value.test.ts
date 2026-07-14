import { describe, expect, it } from "vitest";
import { effectiveTraitValue, traitPole, traitValueSchema, type TraitValue } from "./value";

const trait = (id: string, value: number): TraitValue => ({ id, value, source: "creation" });

describe("traitValueSchema degradation", () => {
  it("a malformed source degrades to low-precedence creation instead of rejecting", () => {
    const parsed = traitValueSchema.safeParse({ id: "social.warmth", value: 40, source: "bogus" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source).toBe("creation");
  });

  it("one malformed source in an array cannot reject the siblings (or the embedding profile)", () => {
    const arr = traitValueSchema.array().safeParse([
      { id: "social.warmth", value: 40, source: null },
      { id: "temperament.composure", value: -20, source: "manual" },
    ]);
    expect(arr.success).toBe(true);
    if (arr.success) {
      expect(arr.data[0]?.source).toBe("creation");
      expect(arr.data[1]?.source).toBe("manual");
    }
  });
});

describe("effectiveTraitValue", () => {
  it("reads the trait by id, neutral 0 when absent", () => {
    expect(effectiveTraitValue([trait("social.warmth", 55)], "social.warmth")).toBe(55);
    expect(effectiveTraitValue([], "social.warmth")).toBe(0);
  });
});

describe("traitPole (slice 5 — slider posture threshold)", () => {
  it("splits at the shared ±34 band boundary, mid ⇒ no steer", () => {
    expect(traitPole(60)).toBe("high");
    expect(traitPole(34)).toBe("high");
    expect(traitPole(33)).toBe("mid");
    expect(traitPole(0)).toBe("mid");
    expect(traitPole(-33)).toBe("mid");
    expect(traitPole(-34)).toBe("low");
    expect(traitPole(-70)).toBe("low");
  });
});
