import { describe, expect, it } from "vitest";
import { compareSets } from "./measure";

/**
 * The set-comparison instrument. Every count is over DISTINCT ids: either
 * side may legally repeat one, and differencing the raw arrays counted a
 * repeated id once per occurrence — which, subtracted from a set size, reported
 * less agreement than there was and could go negative.
 */
describe("compareSets", () => {
  it("counts distinct ids on both sides", () => {
    expect(compareSets(["a", "b"], ["b", "c"])).toEqual({
      resolvedCount: 2,
      projectedCount: 2,
      sharedCount: 1,
      resolvedOnly: ["a"],
      projectedOnly: ["c"],
    });
  });

  it("is unmoved by duplicates on either side", () => {
    expect(compareSets(["a", "a", "b"], ["b", "b"])).toEqual({
      resolvedCount: 2,
      projectedCount: 1,
      sharedCount: 1,
      resolvedOnly: ["a"],
      projectedOnly: [],
    });
  });

  it("never reports negative agreement", () => {
    // Three copies of one resolved-only id used to drive `sharedCount` to -1.
    const comparison = compareSets(["a", "a", "a", "b"], ["b"]);
    expect(comparison.sharedCount).toBe(1);
    expect(comparison.resolvedOnly).toEqual(["a"]);
  });

  it("agrees fully when both sides name the same distinct ids", () => {
    const comparison = compareSets(["a", "b", "a"], ["b", "a"]);
    expect(comparison.sharedCount).toBe(2);
    expect(comparison.resolvedOnly).toEqual([]);
    expect(comparison.projectedOnly).toEqual([]);
  });
});
