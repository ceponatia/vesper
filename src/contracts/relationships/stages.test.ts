import { describe, expect, it } from "vitest";
import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  clampAffinity,
  relationshipStages,
  stageById,
  stageForValue,
  stageMidpoint,
} from "./stages";

describe("relationship stages", () => {
  it("ids are unique", () => {
    const ids = relationshipStages.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("bands cover [-100, 100] contiguously with no gaps or overlaps", () => {
    const sorted = [...relationshipStages].sort((a, b) => a.min - b.min);
    expect(sorted[0]?.min).toBe(AFFINITY_MIN);
    expect(sorted[sorted.length - 1]?.max).toBe(AFFINITY_MAX);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]?.min).toBe((sorted[i - 1]?.max ?? NaN) + 1);
    }
  });

  it("every integer in range maps to exactly one stage", () => {
    for (let v = AFFINITY_MIN; v <= AFFINITY_MAX; v++) {
      const matches = relationshipStages.filter((s) => v >= s.min && v <= s.max);
      expect(matches).toHaveLength(1);
    }
  });

  it("stageForValue picks the v1 boundaries", () => {
    expect(stageForValue(0).id).toBe("stranger");
    expect(stageForValue(-50).id).toBe("hostile");
    expect(stageForValue(-49).id).toBe("wary");
    expect(stageForValue(14).id).toBe("stranger");
    expect(stageForValue(15).id).toBe("acquaintance");
    expect(stageForValue(35).id).toBe("friendly");
    expect(stageForValue(60).id).toBe("close");
    expect(stageForValue(85).id).toBe("devoted");
  });

  it("clamps out-of-range values", () => {
    expect(stageForValue(500).id).toBe("devoted");
    expect(stageForValue(-500).id).toBe("hostile");
    expect(clampAffinity(3.7)).toBe(4);
  });

  it("stageMidpoint seeds from stage labels", () => {
    expect(stageMidpoint("stranger")).toBe(0);
    expect(stageMidpoint("close")).toBe(72);
    expect(stageMidpoint("unknown")).toBe(0);
    expect(stageById("devoted")?.label).toBe("Devoted");
  });
});
