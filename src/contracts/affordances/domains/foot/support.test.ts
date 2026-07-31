import { describe, expect, it } from "vitest";
import { toUnitInterval } from "../../core";
import { compileFootwearContact } from "./footwear";
import { footwearFixture } from "./fixtures";
import {
  footArticulationSetSchema,
  footInterdigitalClosure,
  footMovementRestrictionOf,
  footMovementRestrictionRank,
  footMovementRestrictions,
  footPoseClosureAt,
  footReadForSide,
  footSupportSetSchema,
  footToePoses,
  selectFootArticulation,
  type FootArticulationRead,
  type FootSupportRead,
  type FootToePose,
} from "./support";
import { footSides } from "./topology";

/**
 * Every branch of the restriction precedence, and the per-foot identity that
 * makes "left trapped, right free" representable at all.
 */

function articulation(overrides: Partial<FootArticulationRead> = {}): FootArticulationRead {
  return { side: "left", toes: "relaxed", arch: "neutral", evidence: [], ...overrides };
}

function support(overrides: Partial<FootSupportRead> = {}): FootSupportRead {
  return { side: "left", supportRole: "free", mobility: "free", evidence: [], ...overrides };
}

const rigidBoot = () =>
  compileFootwearContact([
    footwearFixture({ kind: "shoe", parts: ["upper", "toe_box"], rigidity: toUnitInterval(9_000) }),
  ]);

const softSock = () => compileFootwearContact([footwearFixture()]);

describe("one entry per foot", () => {
  it("refuses two support reads for the same foot rather than merging them", () => {
    // "The left foot is trapped" beside "the left foot is free" has no correct
    // resolution. Failing hands the standard degradation; merging or
    // last-write-wins would manufacture an answer nobody gave.
    expect(
      footSupportSetSchema.safeParse([
        { side: "left", supportRole: "weight_bearing", mobility: "trapped" },
        { side: "left", supportRole: "free", mobility: "free" },
      ]).success,
    ).toBe(false);
    expect(
      footSupportSetSchema.safeParse([
        { side: "left", supportRole: "weight_bearing", mobility: "trapped" },
        { side: "right", supportRole: "free", mobility: "free" },
      ]).success,
    ).toBe(true);
  });

  it("refuses two poses for the same foot rather than merging them", () => {
    expect(
      footArticulationSetSchema.safeParse([
        { side: "left", toes: "curled", arch: "neutral" },
        { side: "left", toes: "spread", arch: "extended" },
      ]).success,
    ).toBe(false);
    expect(
      footArticulationSetSchema.safeParse([
        { side: "left", toes: "curled", arch: "neutral" },
        { side: "right", toes: "spread", arch: "extended" },
      ]).success,
    ).toBe(true);
  });

  it("accepts an empty answer and a one-foot answer", () => {
    expect(footSupportSetSchema.safeParse([]).success).toBe(true);
    expect(footArticulationSetSchema.safeParse([{ side: "left", toes: "curled", arch: "neutral" }]).success).toBe(true);
  });
});

describe("a foot is left or right", () => {
  it("refuses a `center` foot in either payload", () => {
    // The contact core's shared side list carries `center` for surfaces that
    // have a middle. A foot does not, so this is not a coarser answer but a
    // wrong one: it fails the schema and degrades `invalid`, rather than
    // becoming a third foot that could also have counted as the second distinct
    // one in the agreement rule.
    expect(footSupportSetSchema.safeParse([{ side: "center", supportRole: "free", mobility: "free" }]).success).toBe(
      false,
    );
    expect(footArticulationSetSchema.safeParse([{ side: "center", toes: "curled", arch: "neutral" }]).success).toBe(
      false,
    );
  });

  it("refuses any other side, and still accepts the two real ones", () => {
    for (const side of ["middle", "both", "", "LEFT"]) {
      expect(footArticulationSetSchema.safeParse([{ side, toes: "curled", arch: "neutral" }]).success, side).toBe(
        false,
      );
    }
    for (const side of footSides) {
      expect(footArticulationSetSchema.safeParse([{ side, toes: "curled", arch: "neutral" }]).success, side).toBe(true);
      expect(footSupportSetSchema.safeParse([{ side, supportRole: "free", mobility: "free" }]).success, side).toBe(
        true,
      );
    }
  });

  it("has no place for an absent side either — a foot read is about a foot", () => {
    expect(footArticulationSetSchema.safeParse([{ toes: "curled", arch: "neutral" }]).success).toBe(false);
    expect(footSupportSetSchema.safeParse([{ supportRole: "free", mobility: "free" }]).success).toBe(false);
  });
});

describe("footPoseClosureAt — the one rule for a locus", () => {
  const curledLeft = articulation({ side: "left", toes: "curled" });
  const curledRight = articulation({ side: "right", toes: "curled" });
  const flexedRight = articulation({ side: "right", toes: "flexed" });
  const spreadRight = articulation({ side: "right", toes: "spread" });

  it("gives a sided locus its own foot's pose, and never the other foot's", () => {
    expect(footPoseClosureAt([curledLeft], "left")).toEqual({ closure: 1, toes: "curled" });
    expect(footPoseClosureAt([curledLeft], "right")).toEqual({ closure: 0 });
  });

  it("moves an unsided locus only when two distinct feet agree", () => {
    expect(footPoseClosureAt([curledLeft, curledRight])).toEqual({ closure: 1, toes: "curled" });
    // One foot says nothing about the other, and an unsided locus may BE the
    // other one (owner ruling, 2026-07-30).
    expect(footPoseClosureAt([curledLeft])).toEqual({ closure: 0 });
    expect(footPoseClosureAt([])).toEqual({ closure: 0 });
    expect(footPoseClosureAt([curledLeft, spreadRight])).toEqual({ closure: 0 });
  });

  it("names the pose only when the deciding feet name the same one", () => {
    // Curled and flexed both close the spaces, so the closure is agreed and the
    // pose is not: reporting one would describe a foot that may not be the one
    // being touched.
    expect(footPoseClosureAt([curledLeft, flexedRight])).toEqual({ closure: 1 });
  });

  it("counts feet, not entries — two reads of one foot are never two feet", () => {
    // The set schemas already refuse this; the rule does not lean on them, so a
    // hand-built frame cannot reach two-feet agreement with one foot either.
    expect(footPoseClosureAt([curledLeft, articulation({ side: "left", toes: "flexed" })])).toEqual({ closure: 0 });
  });

  it("treats a `center` locus as undistinguished, exactly like an absent side", () => {
    // No payload can carry a center FOOT, but a contact locus still carries the
    // shared vocabulary, so the narrowing has to be total.
    expect(footPoseClosureAt([curledLeft], "center")).toEqual({ closure: 0 });
    expect(footPoseClosureAt([curledLeft, curledRight], "center")).toEqual({ closure: 1, toes: "curled" });
  });
});

describe("footMovementRestrictionOf — every branch", () => {
  it("reports nothing limiting a free, untouched, unshod foot", () => {
    expect(footMovementRestrictionOf({ inContact: false, articulation: articulation() })).toBe("unrestricted");
  });

  it("reports contact when a hand is on it and nothing stronger applies", () => {
    expect(footMovementRestrictionOf({ inContact: true, articulation: articulation() })).toBe("contact");
  });

  it("reports the obstruction the pose owner declared", () => {
    expect(
      footMovementRestrictionOf({ inContact: false, articulation: articulation({ obstructed: true }) }),
    ).toBe("obstruction");
  });

  it.each(["fixed", "trapped"] as const)("reports support for a %s foot", (mobility) => {
    expect(
      footMovementRestrictionOf({ support: support({ mobility }), inContact: false, articulation: articulation() }),
    ).toBe("support");
  });

  it("reports support for a weight-bearing foot even when it is otherwise free to move", () => {
    expect(
      footMovementRestrictionOf({
        support: support({ supportRole: "weight_bearing", mobility: "free" }),
        inContact: false,
        articulation: articulation(),
      }),
    ).toBe("support");
  });

  it("leaves a merely `limited` partial-support foot unrestricted", () => {
    expect(
      footMovementRestrictionOf({
        support: support({ supportRole: "partial", mobility: "limited" }),
        inContact: false,
        articulation: articulation(),
      }),
    ).toBe("unrestricted");
  });

  it("blames rigid footwear over the support, the contact, and the obstruction", () => {
    expect(
      footMovementRestrictionOf({
        support: support({ mobility: "trapped" }),
        footwear: rigidBoot(),
        inContact: true,
        articulation: articulation({ obstructed: true }),
      }),
    ).toBe("footwear");
  });

  it("blames the support over the contact and the obstruction", () => {
    expect(
      footMovementRestrictionOf({
        support: support({ mobility: "trapped" }),
        footwear: softSock(),
        inContact: true,
        articulation: articulation({ obstructed: true }),
      }),
    ).toBe("support");
  });

  it("blames the obstruction over the contact", () => {
    expect(
      footMovementRestrictionOf({
        footwear: softSock(),
        inContact: true,
        articulation: articulation({ obstructed: true }),
      }),
    ).toBe("obstruction");
  });

  it("ranks the vocabulary most-binding-first", () => {
    expect(footMovementRestrictions.map((entry) => footMovementRestrictionRank(entry))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("per-foot identity", () => {
  it("keeps a trapped left foot and a free right foot apart", () => {
    const supports = [support({ side: "left", mobility: "trapped" }), support({ side: "right" })];
    expect(footReadForSide(supports, "left")?.mobility).toBe("trapped");
    expect(footReadForSide(supports, "right")?.mobility).toBe("free");
    expect(footReadForSide(supports, "center")).toBeUndefined();
    expect(footReadForSide(supports, undefined)).toBeUndefined();
  });

  it("reports the two feet's restrictions independently", () => {
    const left = articulation({ side: "left" });
    const right = articulation({ side: "right" });
    const supports = [support({ side: "left", mobility: "trapped" }), support({ side: "right" })];
    expect(
      footMovementRestrictionOf({ support: footReadForSide(supports, "left"), inContact: false, articulation: left }),
    ).toBe("support");
    expect(
      footMovementRestrictionOf({ support: footReadForSide(supports, "right"), inContact: false, articulation: right }),
    ).toBe("unrestricted");
  });
});

describe("selectFootArticulation", () => {
  const left = articulation({ side: "left", toes: "relaxed" });
  const right = articulation({ side: "right", toes: "curled" });

  it("says nothing when no foot is posed", () => {
    expect(selectFootArticulation({ articulations: [], supports: [], inContact: false })).toBeUndefined();
  });

  it("prefers the foot the committed contact is on", () => {
    expect(
      selectFootArticulation({
        articulations: [left, right],
        supports: [],
        contactSide: "right",
        inContact: true,
      }),
    ).toBe(right);
  });

  it("falls back to the more restricted foot when nothing is being touched", () => {
    expect(
      selectFootArticulation({
        articulations: [left, right],
        supports: [support({ side: "right", mobility: "trapped" })],
        inContact: false,
      }),
    ).toBe(right);
  });

  it("breaks a tie on the core's side order, whichever order the lane listed them", () => {
    expect(selectFootArticulation({ articulations: [right, left], supports: [], inContact: false })).toBe(left);
    expect(selectFootArticulation({ articulations: [left, right], supports: [], inContact: false })).toBe(left);
  });

  it("ignores a contact side no foot was posed for", () => {
    expect(
      selectFootArticulation({ articulations: [left], supports: [], contactSide: "right", inContact: true }),
    ).toBe(left);
  });
});

describe("footInterdigitalClosure", () => {
  it("closes on a curled or flexed foot and opens on a spread one", () => {
    expect(footInterdigitalClosure(articulation({ toes: "curled" }))).toBe(1);
    expect(footInterdigitalClosure(articulation({ toes: "flexed" }))).toBe(1);
    expect(footInterdigitalClosure(articulation({ toes: "spread" }))).toBe(-1);
  });

  it("leaves every other pose, and an absent pose, at the structural default", () => {
    for (const toes of footToePoses.filter((pose: FootToePose) => !["curled", "flexed", "spread"].includes(pose))) {
      expect(footInterdigitalClosure(articulation({ toes })), toes).toBe(0);
    }
    expect(footInterdigitalClosure(undefined)).toBe(0);
  });
});
