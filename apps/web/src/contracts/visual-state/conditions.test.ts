import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import type { ActiveCondition } from "../conditions/condition";
import { DiagnosticCollector } from "../diagnostics";
import { projectActiveConditionFeatures } from "./conditions";
import { VISUAL_STATE_VALUE_INVALID } from "./diagnostics";
import { VISUAL_STATE_FIXTURE_SUBJECT_ID } from "./fixtures";

const SUBJECT = VISUAL_STATE_FIXTURE_SUBJECT_ID;

function condition(overrides: Partial<ActiveCondition> = {}): ActiveCondition {
  return {
    id: "cond_1",
    label: "Blindfolded",
    severity: "moderate",
    startedAtMinutes: 10,
    durationMinutes: 120,
    attributeEffects: [],
    ...overrides,
  };
}

function project(conditions: readonly ActiveCondition[], atMinutes = 30, sink?: DiagnosticCollector) {
  return projectActiveConditionFeatures({ subjectId: SUBJECT, conditions, atMinutes, sink });
}

describe("projectActiveConditionFeatures", () => {
  it("projects an active condition at the subject locus, under its canonical key", () => {
    const sink = new DiagnosticCollector();
    const [feature] = project([condition()], 30, sink);
    expect(feature?.key).toBe(`${SUBJECT}/subject:${SUBJECT}/condition.active:blindfolded`);
    expect(feature?.layer).toBe("current");
    expect(feature?.stability).toBe("transient");
    expect(feature?.locus).toEqual({ kind: "subject", subjectId: SUBJECT });
    expect(feature?.value).toEqual({ condition: "blindfolded", severity: "moderate" });
    expect(feature?.sourceRef).toEqual({ kind: "body_condition", conditionId: "cond_1" });
    expectCleanSink(sink);
  });

  it("stamps when the condition began and when it will run out", () => {
    const [feature] = project([condition()]);
    expect(feature?.changedAtMinutes).toBe(10);
    expect(feature?.validUntilMinutes).toBe(130);
  });

  it("leaves the window open for a condition with no duration", () => {
    const [feature] = project([condition({ durationMinutes: undefined })]);
    expect(feature?.validUntilMinutes).toBeUndefined();
  });

  it("projects nothing for a condition the clock has expired", () => {
    const sink = new DiagnosticCollector();
    expect(project([condition()], 130, sink)).toEqual([]);
    expectCleanSink(sink);
  });

  it("normalizes the label exactly as the condition system's own match key does", () => {
    const [feature] = project([condition({ label: "  Hung Over " })]);
    expect(feature?.value).toEqual({ condition: "hung over", severity: "moderate" });
    // The aspect escapes the space; the tag spells it tag-legally.
    expect(feature?.key).toBe(`${SUBJECT}/subject:${SUBJECT}/condition.active:hung%20over`);
    expect(feature?.semanticTags).toEqual(["hung_over", "moderate"]);
  });

  it("collapses duplicate labels to one feature — they are one fact", () => {
    const features = project([
      condition({ id: "cond_late", label: "drunk", startedAtMinutes: 50, durationMinutes: undefined }),
      condition({ id: "cond_early", label: "Drunk", startedAtMinutes: 20, durationMinutes: undefined }),
    ]);
    expect(features).toHaveLength(1);
    expect(features[0]?.changedAtMinutes).toBe(20);
    expect(features[0]?.sourceRef).toEqual({ kind: "body_condition", conditionId: "cond_early" });
  });

  it("orders features by canonical key, not arrival order", () => {
    const features = project([
      condition({ id: "c2", label: "soaked", durationMinutes: undefined }),
      condition({ id: "c1", label: "blindfolded", durationMinutes: undefined }),
    ]);
    expect(features.map((feature) => (feature.value as { condition: string }).condition)).toEqual([
      "blindfolded",
      "soaked",
    ]);
  });

  it("degrades a label the value schema refuses, rather than truncating it", () => {
    const sink = new DiagnosticCollector();
    expect(project([condition({ label: "x".repeat(80) })], 30, sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_VALUE_INVALID, { times: 1 });
  });

  it("produces byte-equal output from the same conditions", () => {
    const rows = [condition(), condition({ id: "c9", label: "soaked", durationMinutes: undefined })];
    expect(JSON.stringify(project(rows))).toBe(JSON.stringify(project(rows)));
  });
});
