import { describe, expect, it } from "vitest";
import { expectContiguousBands, expectUniqueIds } from "@/test/registry-invariants";
import {
  clampFamiliarity,
  clampRegard,
  FAMILIARITY_MAX,
  FAMILIARITY_MIN,
  FAMILIARITY_SCENE_CAP,
  FAMILIARITY_TRICKLE_CEILING,
  familiarityBandForValue,
  familiarityBandIdSchema,
  familiarityBandMidpoint,
  familiarityBands,
  REGARD_MAX,
  REGARD_MIN,
  regardBandForValue,
  regardBandIdSchema,
  regardBandMidpoint,
  regardBands,
  stageFamiliarity,
  stageToAxes,
  tickFamiliarity,
} from "./bands";
import { relationshipStages, stageMidpoint } from "./stages";

describe("regard bands", () => {
  it("ids are unique and cover [-100, 100] contiguously", () => {
    expectUniqueIds(regardBands, "regardBands");
    expectContiguousBands(regardBands, { min: REGARD_MIN, max: REGARD_MAX });
  });

  it("is the old stage ladder minus the familiarity-flavored rungs", () => {
    // Derived, not enumerated: the ladder is authored coldest-first, so its
    // declaration order IS its `min` order and a new rung slots in untouched.
    expect(regardBands.map((b) => b.id)).toEqual([...regardBands].sort((a, b) => a.min - b.min).map((b) => b.id));
    // Pinned anchors — the poles other systems name directly.
    expect(regardBands[0]?.id).toBe("hostile");
    expect(regardBands.at(-1)?.id).toBe("smitten");
    // The policy tripwire the split exists for: the two familiarity-flavored
    // rungs are the OTHER axis's vocabulary and must never reappear here.
    for (const rung of ["stranger", "acquaintance"]) {
      expect(regardBands.some((b) => b.id === rung), rung).toBe(false);
    }
    // Old acquaintance values (15..32) now read friendly-low.
    expect(regardBandForValue(24).id).toBe("friendly");
    expect(regardBandForValue(0).id).toBe("neutral");
  });

  it("band lookup clamps and self-heals", () => {
    expect(regardBandForValue(500).id).toBe("smitten");
    expect(regardBandForValue(-500).id).toBe("hostile");
    expect(clampRegard(3.7)).toBe(4);
    expect(regardBandIdSchema.parse("bogus")).toBe("neutral");
    expect(regardBandIdSchema.parse("cool")).toBe("cool");
    expect(regardBandMidpoint("nope")).toBe(0);
  });
});

describe("familiarity bands", () => {
  it("ids are unique and cover [0, 100] contiguously", () => {
    expectUniqueIds(familiarityBands, "familiarityBands");
    expectContiguousBands(familiarityBands, { min: FAMILIARITY_MIN, max: FAMILIARITY_MAX });
  });

  it("band lookup clamps and self-heals", () => {
    expect(familiarityBandForValue(0).id).toBe("strangers");
    expect(familiarityBandForValue(100).id).toBe("deeply_known");
    expect(familiarityBandForValue(-5).id).toBe("strangers");
    expect(clampFamiliarity(200)).toBe(100);
    expect(familiarityBandIdSchema.parse("bogus")).toBe("strangers");
    expect(familiarityBandMidpoint("nope")).toBe(0);
  });
});

describe("familiarity ratchet", () => {
  it("never moves down and trickle stops at the acquainted ceiling", () => {
    expect(FAMILIARITY_TRICKLE_CEILING).toBe(54); // top of `acquainted`
    // Trickle climbs toward the ceiling…
    expect(tickFamiliarity(53, "trickle", 0)).toBe(54);
    // …and no-ops at or past it.
    expect(tickFamiliarity(54, "trickle", 0)).toBe(54);
    expect(tickFamiliarity(80, "trickle", 0)).toBe(80);
  });

  it("moments push past the ceiling but respect the per-scene cap", () => {
    expect(tickFamiliarity(54, "moment", 0)).toBe(57);
    expect(tickFamiliarity(54, "moment", FAMILIARITY_SCENE_CAP - 1)).toBe(55); // 1 point of budget left
    expect(tickFamiliarity(54, "moment", FAMILIARITY_SCENE_CAP)).toBe(54); // budget spent
    expect(tickFamiliarity(99, "moment", 0)).toBe(100); // axis cap
  });
});

describe("stage → axes bridge", () => {
  it("every old stage maps to a real familiarity band", () => {
    for (const stage of relationshipStages) {
      const band = stageFamiliarity[stage.id];
      expect(band, `stage ${stage.id} unmapped`).toBeDefined();
      expect(familiarityBands.some((b) => b.id === band)).toBe(true);
    }
  });

  it("preserves the regard scalar and seeds familiarity at the mapped band midpoint", () => {
    const axes = stageToAxes("close");
    expect(axes.regard).toBe(stageMidpoint("close"));
    expect(familiarityBandForValue(axes.familiarity).id).toBe("familiar");
    // The motivating defaults: stranger is a true zero on both axes.
    expect(stageToAxes("stranger")).toEqual({ familiarity: familiarityBandMidpoint("strangers"), regard: 0 });
    // Unknown stage degrades to strangers/0, never a throw.
    expect(stageToAxes("bogus")).toEqual({ familiarity: 0, regard: 0 });
  });
});
