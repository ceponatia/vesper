import { describe, expect, it } from "vitest";
import {
  isMinorAge,
  LIFE_STAGE_MAX_HUMAN_YEARS,
  LIFE_STAGES,
  lifeStageForAge,
  lifeStageThirdPersonLine,
} from "./life-stage";

describe("life-stage registry (character-fidelity.plan.md slices 1–2)", () => {
  it("covers 0..max contiguously with no gaps or overlaps", () => {
    let expected = 0;
    for (const band of LIFE_STAGES) {
      expect(band.min).toBe(expected);
      expect(band.max).toBeGreaterThanOrEqual(band.min);
      expected = band.max + 1;
    }
    expect(expected).toBe(LIFE_STAGE_MAX_HUMAN_YEARS + 1);
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

  it("flags exactly the below-adulthood bands as minors", () => {
    expect(LIFE_STAGES.filter((b) => b.minor).map((b) => b.id)).toEqual(["child", "teen"]);
    expect(isMinorAge("9")).toBe(true);
    expect(isMinorAge("17")).toBe(true);
    expect(isMinorAge("18")).toBe(false);
    expect(isMinorAge("ancient")).toBe(false);
    expect(isMinorAge("")).toBe(false);
  });

  it("only child/teen/elder carry register rules; the adult default carries no hint", () => {
    for (const band of LIFE_STAGES) {
      if (["child", "teen", "elder"].includes(band.id)) {
        expect(band.registerRules.length).toBeGreaterThan(0);
        expect(band.thirdPersonRule).not.toBe(""); // by-name surfaces get the compact form
      } else {
        expect(band.registerRules).toHaveLength(0);
        expect(band.thirdPersonRule).toBe("");
      }
    }
    expect(LIFE_STAGES.find((b) => b.id === "adult")?.promptHint).toBe("");
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
