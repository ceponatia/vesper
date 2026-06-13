import { describe, expect, it } from "vitest";
import { coverageAncestors, expandCoverage, toggleCoverage } from "./coverage";

describe("toggleCoverage (select-all cascade with carve-outs)", () => {
  it("checking a parent explodes to itself plus all descendants", () => {
    const result = toggleCoverage([], "torso");
    expect(result).toEqual(["torso", "neck", "shoulders", "chest", "back", "waist"]);
  });

  it("unchecking a child keeps the exploded siblings and drops the parent id", () => {
    const torso = toggleCoverage([], "torso");
    const result = toggleCoverage(torso, "chest");
    expect(result).toEqual(["neck", "shoulders", "back", "waist"]);
  });

  it("pelvis groups hips, groin and buttocks", () => {
    expect(toggleCoverage([], "pelvis")).toEqual(["pelvis", "hips", "groin", "buttocks"]);
  });

  it("ski mask: minimal head coverage minus eyes keeps hair and ears", () => {
    // a minimal ["head"] (forge output / legacy data) explodes on first toggle
    const result = toggleCoverage(["head"], "eyes");
    // face drops with eyes — the tree has no finer face parts to keep
    expect(result).toEqual(["hair", "ears"]);
  });

  it("re-checking a carved-out child restores just that subtree", () => {
    const skiMask = toggleCoverage(["head"], "eyes");
    expect(toggleCoverage(skiMask, "eyes")).toEqual(["hair", "eyes", "ears"]);
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
    expect(toggleCoverage([], "hands")).toEqual(["hands", "fingers"]);
  });

  it("preserves ids the registry does not know", () => {
    const result = toggleCoverage(["tail"], "neck");
    expect(result).toEqual(["neck", "tail"]);
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
    expect(coverageAncestors("tail")).toEqual([]);
  });
});
