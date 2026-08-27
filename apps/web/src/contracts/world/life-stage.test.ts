import { describe, expect, it } from "vitest";
import { expectContiguousBands } from "@/test/registry-invariants";
import {
  isMinorAge,
  LIFE_STAGE_MAX_HUMAN_YEARS,
  LIFE_STAGES,
  lifeStageForAge,
  lifeStageThirdPersonLine,
} from "./life-stage";

/** The age at which a character stops being fenced as a minor. */
const ADULTHOOD_YEARS = 18;

describe("life-stage registry", () => {
  it("covers 0..max contiguously with no gaps or overlaps", () => {
    expectContiguousBands(LIFE_STAGES, { min: 0, max: LIFE_STAGE_MAX_HUMAN_YEARS });
  });

  it("maps every in-range year to exactly one band", () => {
    for (let years = 0; years <= LIFE_STAGE_MAX_HUMAN_YEARS; years++) {
      const matches = LIFE_STAGES.filter((b) => years >= b.min && years <= b.max);
      expect(matches).toHaveLength(1);
      expect(lifeStageForAge(String(years))).toBe(matches[0]);
    }
  });

  it("resolves band boundaries (minor line at 17/18)", () => {
    expect(lifeStageForAge("12")?.id).toBe("child");
    expect(lifeStageForAge("13")?.id).toBe("teen");
    expect(lifeStageForAge("17")?.id).toBe("teen");
    expect(lifeStageForAge("18")?.id).toBe("young_adult");
    expect(lifeStageForAge("64")?.id).toBe("middle_aged");
    expect(lifeStageForAge("65")?.id).toBe("elder");
  });

  it("parses only bare human-scaled numerals — everything else degrades to no band", () => {
    expect(lifeStageForAge(" 15 ")?.id).toBe("teen"); // whitespace-tolerant like formatAge
    expect(lifeStageForAge("")).toBeUndefined();
    expect(lifeStageForAge("ancient")).toBeUndefined();
    expect(lifeStageForAge("312 years")).toBeUndefined();
    expect(lifeStageForAge("15 years old")).toBeUndefined();
    expect(lifeStageForAge("-5")).toBeUndefined();
    expect(lifeStageForAge(String(LIFE_STAGE_MAX_HUMAN_YEARS + 1))).toBeUndefined(); // fantasy-scaled
  });

  it("flags exactly the below-18 bands as minors", () => {
    // A POLICY tripwire, kept — but derived from the band boundaries rather than
    // naming ids, so renaming or splitting a band cannot quietly unfence it. The
    // 18 itself stays a literal: it IS the rule.
    for (const band of LIFE_STAGES) {
      expect(
        band.min < ADULTHOOD_YEARS === band.max < ADULTHOOD_YEARS,
        `${band.id} (${band.min}..${band.max}) straddles the adulthood line — its \`minor\` flag cannot be truthful`,
      ).toBe(true);
      expect(band.minor, `${band.id} (${band.min}..${band.max})`).toBe(band.max < ADULTHOOD_YEARS);
    }
    expect(
      LIFE_STAGES.some((b) => b.minor),
      "the ladder must still HAVE a minor band — an empty fence is not a passing fence",
    ).toBe(true);
    expect(isMinorAge("9")).toBe(true);
    expect(isMinorAge("17")).toBe(true);
    expect(isMinorAge("18")).toBe(false);
    expect(isMinorAge("ancient")).toBe(false);
    expect(isMinorAge("")).toBe(false);
  });

  it("register rules and the third-person rule travel together; the adult default carries no hint", () => {
    for (const band of LIFE_STAGES) {
      // Which bands constrain register is authoring vocabulary — that a band
      // authoring rules ALSO authors the compact by-name form is the contract.
      expect(band.registerRules.length > 0, `${band.id}`).toBe(band.thirdPersonRule !== "");
    }
    // Every minor band must constrain register: the fence, not a style choice.
    for (const band of LIFE_STAGES.filter((b) => b.minor)) {
      expect(band.registerRules.length, band.id).toBeGreaterThan(0);
    }
    // Pinned: `adult` is the unmarked default — no hint, no rules, nothing.
    const adult = LIFE_STAGES.find((b) => b.id === "adult");
    expect(adult?.promptHint).toBe("");
    expect(adult?.registerRules).toEqual([]);
    expect(adult?.thirdPersonRule).toBe("");
  });

  it("renders the third-person line with every {name} token replaced", () => {
    const teen = LIFE_STAGES.find((b) => b.id === "teen");
    const line = lifeStageThirdPersonLine(teen, "Mara");
    expect(line).toContain("Mara");
    expect(line).not.toContain("{name}");
    expect(lifeStageThirdPersonLine(undefined, "Mara")).toBe("");
    expect(lifeStageThirdPersonLine(LIFE_STAGES.find((b) => b.id === "adult"), "Mara")).toBe("");
  });
});
