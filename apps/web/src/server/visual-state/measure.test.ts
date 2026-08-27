import { describe, expect, it } from "vitest";
import { realizeBody, type AttributeValue } from "@/contracts";
import { compareSets, legacyNarratorAttributeIds } from "./measure";

/**
 * The legacy-comparison instrument: a
 * measurement replica of the guard chain `character-chat.ts` runs before
 * rendering its Attributes block. It must apply the same five guards —
 * apparent-age skip, unknown-definition skip, prompt exclusion, the intimate
 * sensory gate, and body applicability — or the disagreement measurement would
 * count guard differences as summary drift.
 */
describe("legacyNarratorAttributeIds", () => {
  const body = realizeBody({});

  it("keeps ordinary rendered attributes and sorts them", () => {
    const resolved: AttributeValue[] = [
      { id: "nose.size", value: "medium", source: "creation" },
      { id: "nose.shape", value: "crooked", source: "creation" },
    ];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual(["nose.shape", "nose.size"]);
  });

  it("skips the portrait-studio-only apparent age", () => {
    const resolved: AttributeValue[] = [{ id: "identity.apparent_age", value: "adult", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });

  it("skips unknown vocabulary — the prompt never leaks a raw id", () => {
    const resolved: AttributeValue[] = [{ id: "nose.not_a_real_attribute", value: "x", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });

  it("skips a value the prompt would elide", () => {
    // `promptValueWithNoneElided` drops "none" unless the definition opts in;
    // an empty string renders nothing either way.
    const resolved: AttributeValue[] = [{ id: "nose.shape", value: "", source: "creation" }];
    expect(legacyNarratorAttributeIds(resolved, body)).toEqual([]);
  });
});

/**
 * The disagreement instrument itself. Every count is over DISTINCT ids: either
 * side may legally repeat one, and differencing the raw arrays counted a
 * repeated id once per occurrence — which, subtracted from a set size, reported
 * less agreement than there was and could go negative.
 */
describe("compareSets", () => {
  it("counts distinct ids on both sides", () => {
    expect(compareSets(["a", "b"], ["b", "c"])).toEqual({
      legacyCount: 2,
      projectedCount: 2,
      sharedCount: 1,
      legacyOnly: ["a"],
      projectedOnly: ["c"],
    });
  });

  it("is unmoved by duplicates on either side", () => {
    expect(compareSets(["a", "a", "b"], ["b", "b"])).toEqual({
      legacyCount: 2,
      projectedCount: 1,
      sharedCount: 1,
      legacyOnly: ["a"],
      projectedOnly: [],
    });
  });

  it("never reports negative agreement", () => {
    // Three copies of one legacy-only id used to drive `sharedCount` to -1.
    const comparison = compareSets(["a", "a", "a", "b"], ["b"]);
    expect(comparison.sharedCount).toBe(1);
    expect(comparison.legacyOnly).toEqual(["a"]);
  });

  it("agrees fully when both sides name the same distinct ids", () => {
    const comparison = compareSets(["a", "b", "a"], ["b", "a"]);
    expect(comparison.sharedCount).toBe(2);
    expect(comparison.legacyOnly).toEqual([]);
    expect(comparison.projectedOnly).toEqual([]);
  });
});
