import { describe, expect, it } from "vitest";
import { expectContiguousBands, expectUniqueIds } from "@/test/registry-invariants";
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
    expectUniqueIds(relationshipStages, "relationshipStages");
  });

  it("bands cover [-100, 100] contiguously with no gaps or overlaps", () => {
    expectContiguousBands(relationshipStages, { min: AFFINITY_MIN, max: AFFINITY_MAX });
  });

  it("every integer in range maps to exactly one stage — and stageForValue returns that one", () => {
    // Derived from the registry rather than probed at hand-listed boundaries:
    // the lookup is proven to honor whatever the bands say, so retuning a
    // boundary (or authoring a new stage) needs no edit here, while a broken
    // comparison in stageForValue still fails at the very first integer.
    for (let v = AFFINITY_MIN; v <= AFFINITY_MAX; v++) {
      const matches = relationshipStages.filter((s) => v >= s.min && v <= s.max);
      expect(matches, `affinity ${v}`).toHaveLength(1);
      expect(stageForValue(v), `affinity ${v}`).toBe(matches[0]);
    }
  });

  it("keeps the Slice 5 widening: `stranger` straddles zero and runs to 14", () => {
    // Pinned on purpose — this is the policy the widening exists for
    // (stages.ts header), not a derivable consequence of the ladder's shape.
    expect(stageForValue(0).id).toBe("stranger");
    expect(stageForValue(14).id).toBe("stranger");
    expect(stageForValue(15).id).toBe("acquaintance");
  });

  it("clamps out-of-range values", () => {
    expect(stageForValue(500).id).toBe("smitten");
    expect(stageForValue(-500).id).toBe("hostile");
    expect(clampAffinity(3.7)).toBe(4);
  });

  it("stageMidpoint lands inside its own band, and heals an unknown id to 0", () => {
    for (const stage of relationshipStages) {
      const mid = stageMidpoint(stage.id);
      expect(stageForValue(mid).id, `${stage.id} midpoint ${mid}`).toBe(stage.id);
    }
    // Pinned: `stranger` seeds a fresh bond at a TRUE zero — bands.ts §stageToAxes
    // and every authored default read this exact number by name.
    expect(stageMidpoint("stranger")).toBe(0);
    expect(stageMidpoint("unknown")).toBe(0);
    expect(stageById("devoted")?.label).toBe("Devoted");
  });
});
