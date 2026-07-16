import { describe, expect, it } from "vitest";
import {
  HARD_EFFECT_SCHEDULE_KINDS,
  hasHardEffectCandidate,
  inferScheduleKind,
} from "./classifier";
import { SCHEDULE_KIND_FIXTURES } from "./fixtures";

describe("inferScheduleKind shadow classifier", () => {
  it.each(SCHEDULE_KIND_FIXTURES)("$id: $activity", (fixture) => {
    const result = inferScheduleKind(fixture.activity);
    expect({ status: result.status, kind: result.kind }).toEqual({
      status: fixture.expectedStatus,
      kind: fixture.expectedKind,
    });
  });

  it("keeps the motivating shower-and-coffee compound ambiguous", () => {
    expect(inferScheduleKind("Shower and coffee")).toMatchObject({
      status: "ambiguous",
      kind: null,
      candidateKinds: ["hygiene", "meal"],
      unknownSegments: [],
    });
  });

  it("does not turn partial keyword prose into a work or sleep effect", () => {
    expect(inferScheduleKind("Prepare for work")).toMatchObject({
      status: "unknown",
      kind: null,
      matchedRuleIds: [],
    });
    expect(inferScheduleKind("Put the child to bed")).toMatchObject({
      status: "unknown",
      kind: null,
      matchedRuleIds: [],
    });
  });

  it("can accept a compound only when every segment resolves to the same kind", () => {
    expect(inferScheduleKind("Shower and brush teeth")).toMatchObject({
      status: "matched",
      kind: "hygiene",
      confidence: "medium",
      unknownSegments: [],
    });
  });

  it("queues ambiguous phrases that contain any hard-effect candidate", () => {
    expect(hasHardEffectCandidate(inferScheduleKind("Shower and coffee"))).toBe(true);
    expect(hasHardEffectCandidate(inferScheduleKind("Drive to the gym and work out"))).toBe(true);
    expect(hasHardEffectCandidate(inferScheduleKind("Work then meet Alex"))).toBe(false);
    expect(hasHardEffectCandidate(inferScheduleKind("Morning routine"))).toBe(false);
  });

  it("has no hard-effect false positives in the labeled corpus", () => {
    const falsePositives = SCHEDULE_KIND_FIXTURES.filter((fixture) => {
      const result = inferScheduleKind(fixture.activity);
      return (
        result.status === "matched" &&
        result.kind != null &&
        HARD_EFFECT_SCHEDULE_KINDS.has(result.kind) &&
        (fixture.expectedStatus !== "matched" || fixture.expectedKind !== result.kind)
      );
    });
    expect(falsePositives).toEqual([]);
  });
});
