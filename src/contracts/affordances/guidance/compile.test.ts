import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { deepFreeze } from "../core";
import { compileNarratorPhysicalGuidance } from "./compile";
import {
  assertNoResolverOnlyLeak,
  GUIDANCE_DISCLOSURE_INVALID,
  GUIDANCE_DISCLOSURE_WITHHELD,
} from "./disclosure";
import { GUIDANCE_MAX_CONSTRAINTS, GUIDANCE_SELECTION_OVER_BUDGET } from "./selection";
import { probeActionOutcome, probeConstraint, probeCorrection, probeTransition } from "./test-support";
import type { GuidanceCandidateInput, PhysicalNarrationConstraint } from "./types";

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

  it("suppresses ONLY the invalid candidate and compiles its valid siblings", () => {
    // The disclosure gate is per-candidate fail-closed, not per-block: the bad candidate
    // is dropped with an `error`, and everything beside it compiles untouched.
    //
    // This is not a softening of the law — it is what makes the law safe once slice 3
    // lands. A mandatory action outcome says whether contact HAPPENED, and dropping the
    // whole block because some unrelated constraint carried a value an adapter mangled
    // would leave the narrator free to invent the answer. Suppressing one candidate
    // withholds one fact; suppressing the block withholds the authoritative one.
    const collector = new DiagnosticCollector();
    // The shape only an adapter's parse of a persisted or remote candidate can produce —
    // the compile-time union is exactly what the runtime gate distrusts, so the cast is
    // the point of the fixture rather than a shortcut around it.
    const rogue = {
      ...probeConstraint({ id: "rogue_fence", priority: "mandatory" }),
      disclosure: "narrator_prompt_allowed",
    } as unknown as PhysicalNarrationConstraint;
    const guidance = compileNarratorPhysicalGuidance({
      constraints: [rogue, probeConstraint({ id: "fence_one", priority: "high" })],
      actionOutcomes: [probeActionOutcome({ actionId: "reach_one", status: "rejected" })],
      sink: collector,
    });

    // The invalid candidate is gone even though it outranked every sibling.
    expect(guidance.constraints.map((constraint) => constraint.id)).toEqual(["fence_one"]);
    // …and the mandatory outcome — the one slice 3 cannot afford to lose — survived.
    expect(guidance.actionOutcomes.map((outcome) => outcome.actionId)).toEqual(["reach_one"]);
    expect(guidance.actionOutcomes[0]?.narratorMustResolve).toBe(true);

    const invalid = guidance.diagnostics.filter((item) => item.code === GUIDANCE_DISCLOSURE_INVALID);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.severity).toBe("error");
    expect(invalid[0]?.context).toMatchObject({ kind: "constraint", disclosure: "narrator_prompt_allowed" });
    // The render seam's second layer sees nothing wrong, because nothing wrong survived
    // into the compiled guidance — which is precisely why the block still renders.
    expect(assertNoResolverOnlyLeak(guidance)).toEqual([]);
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
