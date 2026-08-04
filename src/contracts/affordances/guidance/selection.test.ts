import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { deepFreeze } from "../core";
import { compareGuidanceFingerprints } from "./fingerprint";
import {
  selectNarratorGuidance,
  GUIDANCE_MAX_CONSTRAINTS,
  GUIDANCE_MAX_CORRECTIONS,
  GUIDANCE_MAX_TRANSITIONS,
  GUIDANCE_SELECTION_OVER_BUDGET,
} from "./selection";
import { probeActionOutcome, probeConstraint, probeCorrection, probeTransition } from "./test-support";
import type { GuidanceCandidateInput, GuidanceFingerprinted } from "./types";

/**
 * Selection's two promises: the same candidates always produce the same guidance
 * (in any input order, in any process), and the budget never drops an action
 * outcome. A retake that re-ordered its constraints would re-order the prompt,
 * which is why the tie-break is a fingerprint and not input order.
 */

const fingerprints = (items: readonly GuidanceFingerprinted[]): readonly string[] =>
  items.map((item) => item.fingerprint);

const sortedFingerprints = (items: readonly GuidanceFingerprinted[]): readonly string[] =>
  [...fingerprints(items)].sort(compareGuidanceFingerprints);

const select = (candidates: GuidanceCandidateInput, collector?: DiagnosticCollector) =>
  selectNarratorGuidance({ candidates, ...(collector === undefined ? {} : { sink: collector }) });

describe("determinism", () => {
  const candidates: GuidanceCandidateInput = deepFreeze({
    constraints: [probeConstraint({ id: "c_one" }), probeConstraint({ id: "c_two", priority: "mandatory" })],
    corrections: [probeCorrection({ id: "r_one" })],
    actionOutcomes: [probeActionOutcome({ actionId: "a_one", status: "rejected" })],
    transitions: [probeTransition({ id: "t_one" })],
  });

  it("produces a deep-equal result on a second run over frozen input", () => {
    expect(select(candidates)).toEqual(select(candidates));
  });

  it("is independent of input order", () => {
    const shuffled: GuidanceCandidateInput = {
      constraints: [...(candidates.constraints ?? [])].reverse(),
      corrections: candidates.corrections,
      actionOutcomes: candidates.actionOutcomes,
      transitions: candidates.transitions,
    };
    expect(select(shuffled)).toEqual(select(candidates));
  });

  it("stamps the compiled version and reports no diagnostics when nothing is dropped", () => {
    const guidance = select(candidates);
    expect(guidance.version).toBe(1);
    expect(guidance.diagnostics).toEqual([]);
  });
});

describe("ordering", () => {
  it("ranks constraints mandatory → high → normal, then by fingerprint", () => {
    const normal = [probeConstraint({ id: "n_one" }), probeConstraint({ id: "n_two" })];
    const expectedNormal = [...normal]
      .sort((left, right) => compareGuidanceFingerprints(left.fingerprint, right.fingerprint))
      .map((constraint) => constraint.id);
    const guidance = select({
      constraints: [
        ...normal,
        probeConstraint({ id: "h_one", priority: "high" }),
        probeConstraint({ id: "m_one", priority: "mandatory" }),
      ],
    });
    // Four candidates, a budget of three: the tier order also decides what the
    // budget takes, so the surviving `normal` is the first by fingerprint.
    expect(guidance.constraints.map((constraint) => constraint.id)).toEqual(["m_one", "h_one", expectedNormal[0]]);
  });

  it("breaks equal-priority ties by fingerprint, not by arrival", () => {
    const tied = [
      probeConstraint({ id: "t_a" }),
      probeConstraint({ id: "t_b" }),
      probeConstraint({ id: "t_c" }),
    ];
    const forwards = select({ constraints: tied });
    const backwards = select({ constraints: [...tied].reverse() });
    expect(fingerprints(forwards.constraints)).toEqual(sortedFingerprints(tied));
    expect(fingerprints(backwards.constraints)).toEqual(sortedFingerprints(tied));
  });

  it("puts the outcomes the narrator must resolve first", () => {
    const guidance = select({
      actionOutcomes: [
        probeActionOutcome({ actionId: "committed_one", status: "committed" }),
        probeActionOutcome({ actionId: "blocked_one", status: "explicit_transition_required" }),
        probeActionOutcome({ actionId: "quiet_one", status: "unresolved" }),
        probeActionOutcome({ actionId: "blocked_two", status: "rejected" }),
      ],
    });
    expect(guidance.actionOutcomes.slice(0, 2).every((outcome) => outcome.narratorMustResolve)).toBe(true);
    expect(guidance.actionOutcomes.slice(2).some((outcome) => outcome.narratorMustResolve)).toBe(false);
  });

  it("ranks an action-relevant transition ahead of an attended one", () => {
    const guidance = select({
      transitions: [probeTransition({ id: "attended", relevance: "attention" }), probeTransition({ id: "acted" })],
    });
    // Both fit — the budget covers what one exchange can lawfully produce — so
    // this asserts the ORDER, which is what decides the loser once it does not.
    expect(guidance.transitions.map((transition) => transition.id)).toEqual(["acted", "attended"]);
  });
});

describe("budgets", () => {
  it("keeps three constraints and reports the drop", () => {
    const collector = new DiagnosticCollector();
    const constraints = ["one", "two", "three", "four"].map((id) => probeConstraint({ id }));
    const guidance = select({ constraints }, collector);

    expect(guidance.constraints).toHaveLength(GUIDANCE_MAX_CONSTRAINTS);
    const dropped = sortedFingerprints(constraints).slice(GUIDANCE_MAX_CONSTRAINTS);
    expect(collector.items).toEqual(guidance.diagnostics);
    expect(collector.items[0]).toMatchObject({
      severity: "info",
      code: GUIDANCE_SELECTION_OVER_BUDGET,
      context: { kind: "constraint", max: GUIDANCE_MAX_CONSTRAINTS, dropped },
    });
    expect(collector.hasErrors).toBe(false);
  });

  it("keeps two corrections", () => {
    const collector = new DiagnosticCollector();
    const corrections = ["one", "two", "three"].map((id) => probeCorrection({ id }));
    const guidance = select({ corrections }, collector);
    expect(guidance.corrections).toHaveLength(GUIDANCE_MAX_CORRECTIONS);
    expect(fingerprints(guidance.corrections)).toEqual(sortedFingerprints(corrections).slice(0, 2));
    expect(collector.items[0]?.context).toMatchObject({ kind: "correction" });
  });

  it("carries a whole exchange's worth of transitions without a drop", () => {
    // The lawful maximum one exchange can produce. Every transition in this tier
    // is a binding stop today, so a drop here is a required instruction lost —
    // the producer's emission window closes on the next reply, so nothing
    // dropped is ever rendered later.
    const collector = new DiagnosticCollector();
    const transitions = Array.from({ length: GUIDANCE_MAX_TRANSITIONS }, (_, index) =>
      probeTransition({ id: `t_${index}` }),
    );
    const guidance = select({ transitions }, collector);
    expect(guidance.transitions).toHaveLength(GUIDANCE_MAX_TRANSITIONS);
    expect(collector.items).toEqual([]);
  });

  it("still budgets past the lawful maximum, and says so", () => {
    const collector = new DiagnosticCollector();
    const transitions = Array.from({ length: GUIDANCE_MAX_TRANSITIONS + 1 }, (_, index) =>
      probeTransition({ id: `t_${index}` }),
    );
    const guidance = select({ transitions }, collector);
    expect(guidance.transitions).toHaveLength(GUIDANCE_MAX_TRANSITIONS);
    expect(collector.items[0]).toMatchObject({
      code: GUIDANCE_SELECTION_OVER_BUDGET,
      context: { kind: "transition", max: GUIDANCE_MAX_TRANSITIONS },
    });
  });

  it("never drops an action outcome, however many arrive", () => {
    const collector = new DiagnosticCollector();
    const actionOutcomes = ["one", "two", "three", "four", "five"].map((actionId) =>
      probeActionOutcome({ actionId, status: "rejected" }),
    );
    const guidance = select({ actionOutcomes }, collector);
    expect(guidance.actionOutcomes).toHaveLength(actionOutcomes.length);
    expect(collector.items).toEqual([]);
  });

  it("compiles absent lists to empty lists with no diagnostics", () => {
    const collector = new DiagnosticCollector();
    const guidance = select({}, collector);
    expect(guidance).toEqual({
      version: 1,
      constraints: [],
      corrections: [],
      actionOutcomes: [],
      transitions: [],
      diagnostics: [],
    });
    expect(collector.items).toEqual([]);
  });
});
