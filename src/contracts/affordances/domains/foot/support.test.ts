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
  footReadForSide,
  footSupportSetSchema,
  footToePoses,
  selectFootArticulation,
  type FootArticulationRead,
  type FootSupportRead,
  type FootToePose,
} from "./support";

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
