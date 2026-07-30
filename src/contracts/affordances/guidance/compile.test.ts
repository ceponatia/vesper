import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { deepFreeze } from "../core";
import { compileNarratorPhysicalGuidance } from "./compile";
import { assertNoResolverOnlyLeak, GUIDANCE_DISCLOSURE_WITHHELD } from "./disclosure";
import { GUIDANCE_MAX_CONSTRAINTS, GUIDANCE_SELECTION_OVER_BUDGET } from "./selection";
import { probeActionOutcome, probeConstraint, probeCorrection, probeTransition } from "./test-support";
import type { GuidanceCandidateInput } from "./types";

/**
 * The whole pipeline in one call: gate, then order, then budget.
 *
 * The ordering is the property under test as much as the output is — a gated
 * candidate must be gone BEFORE ranking, so no amount of priority can carry a
 * resolver-only fact into a prompt. `assertNoResolverOnlyLeak` is asserted on the
 * compiled result to prove the two halves agree.
 */

const mixed = (): GuidanceCandidateInput =>
  deepFreeze({
    constraints: [
      probeConstraint({ id: "hidden_cause", disclosure: "resolver_only", priority: "mandatory" }),
      probeConstraint({ id: "fence_one", priority: "high" }),
      probeConstraint({ id: "fence_two" }),
      probeConstraint({ id: "fence_three" }),
      probeConstraint({ id: "fence_four" }),
    ],
    corrections: [probeCorrection({ id: "premise_one" }), probeCorrection({ id: "premise_two" })],
    actionOutcomes: [
      probeActionOutcome({ actionId: "reach_one", status: "rejected" }),
      probeActionOutcome({ actionId: "touch_one", status: "committed" }),
    ],
    transitions: [probeTransition({ id: "changed_one" })],
  });

describe("compileNarratorPhysicalGuidance", () => {
  it("gates, orders, and budgets in one pass", () => {
    const collector = new DiagnosticCollector();
    const guidance = compileNarratorPhysicalGuidance({ ...mixed(), sink: collector });

    expect(guidance.version).toBe(1);
    // The resolver-only fence is gone even though it was the only `mandatory` one:
    // the gate ran before the ranker could prefer it.
    expect(guidance.constraints.map((constraint) => constraint.id)).not.toContain("hidden_cause");
    expect(guidance.constraints).toHaveLength(GUIDANCE_MAX_CONSTRAINTS);
    expect(guidance.constraints[0]?.id).toBe("fence_one");
    expect(guidance.corrections).toHaveLength(2);
    expect(guidance.actionOutcomes.map((outcome) => outcome.actionId)).toEqual(["reach_one", "touch_one"]);
    expect(guidance.transitions).toHaveLength(1);
    expect(assertNoResolverOnlyLeak(guidance)).toEqual([]);
  });

  it("reports the withheld candidate and the budget drop once each, on both views", () => {
    const collector = new DiagnosticCollector();
    const guidance = compileNarratorPhysicalGuidance({ ...mixed(), sink: collector });

    expect(collector.items).toEqual(guidance.diagnostics);
    expect(guidance.diagnostics.map((item) => item.code)).toEqual([
      GUIDANCE_DISCLOSURE_WITHHELD,
      GUIDANCE_SELECTION_OVER_BUDGET,
    ]);
    expect(collector.hasErrors).toBe(false);
  });

  it("reproduces the identical guidance on a second run — the retake property", () => {
    const first = compileNarratorPhysicalGuidance(mixed());
    const second = compileNarratorPhysicalGuidance(mixed());
    expect(second).toEqual(first);
    expect(second.constraints.map((constraint) => constraint.fingerprint)).toEqual(
      first.constraints.map((constraint) => constraint.fingerprint),
    );
  });

  it("is silent for empty input", () => {
    const collector = new DiagnosticCollector();
    expect(compileNarratorPhysicalGuidance({ sink: collector })).toEqual({
      version: 1,
      constraints: [],
      corrections: [],
      actionOutcomes: [],
      transitions: [],
      diagnostics: [],
    });
    expect(
      compileNarratorPhysicalGuidance({
        constraints: [],
        corrections: [],
        actionOutcomes: [],
        transitions: [],
        sink: collector,
      }).diagnostics,
    ).toEqual([]);
    expect(collector.items).toEqual([]);
  });

  it("needs no sink", () => {
    const guidance = compileNarratorPhysicalGuidance({ constraints: [probeConstraint({ id: "fence_one" })] });
    expect(guidance.constraints).toHaveLength(1);
  });
});
