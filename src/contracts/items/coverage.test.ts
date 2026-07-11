import { describe, expect, it } from "vitest";
import { coverageAncestors, expandCoverage, toggleCoverage } from "./coverage";

// toggleCoverage returns a *set* of body-location ids; the tree-walk order is an
// implementation detail, so compare order-agnostically (sort both sides).
const sameSet = (a: readonly string[], b: readonly string[]) =>
  expect([...a].sort()).toEqual([...b].sort());

describe("toggleCoverage (select-all cascade with carve-outs)", () => {
  it("checking a parent explodes to itself plus all descendants", () => {
    const result = toggleCoverage([], "torso");
    sameSet(result, ["torso", "neck", "shoulders", "chest", "back", "waist"]);
  });

  it("unchecking a child keeps the exploded siblings and drops the parent id", () => {
    const torso = toggleCoverage([], "torso");
    const result = toggleCoverage(torso, "chest");
    sameSet(result, ["neck", "shoulders", "back", "waist"]);
  });

  it("pelvis groups hips, groin and buttocks", () => {
    sameSet(toggleCoverage([], "pelvis"), ["pelvis", "hips", "groin", "buttocks"]);
  });

  it("ski mask: minimal head coverage minus eyes keeps hair, ears, nose and lips", () => {
    // a minimal ["head"] (forge output / legacy data) explodes on first toggle
    const result = toggleCoverage(["head"], "eyes");
    // face itself drops with eyes (an ancestor id would re-imply them), but its
    // remaining parts — nose, lips — stay covered, as a real ski mask covers them
    sameSet(result, ["hair", "ears", "nose", "lips"]);
  });

  it("re-checking a carved-out child restores just that subtree", () => {
    const skiMask = toggleCoverage(["head"], "eyes");
    sameSet(toggleCoverage(skiMask, "eyes"), ["hair", "eyes", "ears", "nose", "lips"]);
  });

  it("checking a child never drags its ancestors in (glasses cover eyes, not face)", () => {
    const glasses = toggleCoverage([], "eyes");
    expect(glasses).toEqual(["eyes"]);
    expect(expandCoverage(glasses).has("face")).toBe(false);
    expect(expandCoverage(glasses).has("head")).toBe(false);
  });

  it("toggling a leaf on and off round-trips", () => {
    const on = toggleCoverage([], "wrists");
    expect(on).toEqual(["wrists"]);
    expect(toggleCoverage(on, "wrists")).toEqual([]);
  });

  it("checking a mid-level node cascades to grandchildren", () => {
    sameSet(toggleCoverage([], "hands"), ["hands", "fingers"]);
  });

  it("preserves ids the registry does not know", () => {
    const result = toggleCoverage(["custom_tail_slot"], "neck");
    sameSet(result, ["neck", "custom_tail_slot"]);
  });

  it("exploded and minimal inputs evaluate to the same effective set", () => {
    expect(expandCoverage(["torso"])).toEqual(expandCoverage(toggleCoverage([], "torso")));
  });
});

describe("coverageAncestors", () => {
  it("walks the parent chain nearest-first", () => {
    expect(coverageAncestors("fingers")).toEqual(["hands", "arms"]);
    expect(coverageAncestors("eyes")).toEqual(["face", "head"]);
  });

  it("is empty for roots and unknown ids", () => {
    expect(coverageAncestors("torso")).toEqual([]);
    expect(coverageAncestors("custom_tail_slot")).toEqual([]);
  });
});
