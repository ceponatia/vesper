import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { affordancePerceptionView } from "../core";
import { buildConstraintCandidates } from "./constraint-candidates";
import {
  assertNoResolverOnlyLeak,
  filterGuidanceForConsumer,
  GUIDANCE_DISCLOSURE_LEAK,
  GUIDANCE_DISCLOSURE_WITHHELD,
} from "./disclosure";
import {
  GUIDANCE_PROBE_DOMAIN_ID,
  GUIDANCE_PROBE_SUBJECT_ID,
  probeActionOutcome,
  probeConstraint,
} from "./test-support";
import {
  emptyNarratorPhysicalGuidance,
  type GuidanceCandidates,
  type NarratorPhysicalGuidance,
  type PhysicalPremiseCorrection,
  type PhysicalStateTransition,
} from "./types";

/**
 * The gate, from both ends.
 *
 * A `resolver_only` candidate must be unreachable from a narrator prompt — for
 * every candidate kind, including the two whose TYPES already forbid it, because
 * a lane adapter can hand over a parsed shape the compiler never built. And a
 * leak that somehow reaches prompt-bound guidance must be an `error`, because by
 * that point the gate has already had its chance.
 */

/**
 * Adapter-shaped candidates: the type says a correction and a transition cannot
 * be `resolver_only`, so a test that only used the builders could not prove the
 * runtime check exists. These stand in for a lane's parsed input.
 */
const leaked = (): GuidanceCandidates => {
  const constraint = probeConstraint({ id: "hidden_cause", disclosure: "resolver_only" });
  const outcome = probeActionOutcome({ actionId: "hidden_action", disclosure: "resolver_only" });
  const untyped = { ...constraint, disclosure: "resolver_only" } as unknown;
  return {
    constraints: [constraint],
    corrections: [untyped as PhysicalPremiseCorrection],
    actionOutcomes: [outcome],
    transitions: [untyped as PhysicalStateTransition],
  };
};

describe("filterGuidanceForConsumer", () => {
  it("drops every resolver-only candidate for the narrator, one info diagnostic each", () => {
    const collector = new DiagnosticCollector();
    const gated = filterGuidanceForConsumer(leaked(), "narrator_prompt", collector);

    expect(gated).toEqual({ constraints: [], corrections: [], actionOutcomes: [], transitions: [] });
    expect(collector.items).toHaveLength(4);
    expect(collector.items.map((item) => item.code)).toEqual(Array(4).fill(GUIDANCE_DISCLOSURE_WITHHELD));
    expect(collector.items.map((item) => item.severity)).toEqual(Array(4).fill("info"));
    expect(collector.items.map((item) => item.context?.kind)).toEqual([
      "constraint",
      "correction",
      "action_outcome",
      "transition",
    ]);
    expect(collector.hasErrors).toBe(false);
  });

  it("keeps the prompt-safe candidates beside the withheld ones", () => {
    const collector = new DiagnosticCollector();
    const gated = filterGuidanceForConsumer(
      {
        constraints: [
          probeConstraint({ id: "hidden_cause", disclosure: "resolver_only" }),
          probeConstraint({ id: "stated_fence" }),
        ],
      },
      "narrator_prompt",
      collector,
    );
    expect(gated.constraints.map((constraint) => constraint.id)).toEqual(["stated_fence"]);
    expect(collector.items).toHaveLength(1);
  });

  it("passes everything to the resolver, silently", () => {
    const collector = new DiagnosticCollector();
    const candidates = leaked();
    const gated = filterGuidanceForConsumer(candidates, "resolver", collector);
    expect(gated).toEqual(candidates);
    expect(collector.items).toEqual([]);
  });

  it("normalizes absent lists without reporting anything", () => {
    const collector = new DiagnosticCollector();
    expect(filterGuidanceForConsumer({}, "narrator_prompt", collector)).toEqual({
      constraints: [],
      corrections: [],
      actionOutcomes: [],
      transitions: [],
    });
    expect(collector.items).toEqual([]);
  });
});

describe("assertNoResolverOnlyLeak", () => {
  it("returns nothing for clean guidance", () => {
    expect(assertNoResolverOnlyLeak(emptyNarratorPhysicalGuidance())).toEqual([]);
    expect(
      assertNoResolverOnlyLeak({
        ...emptyNarratorPhysicalGuidance(),
        constraints: [probeConstraint({ id: "stated_fence" })],
      }),
    ).toEqual([]);
  });

  it("returns one error per leaked candidate, naming its fingerprint", () => {
    const candidates = leaked();
    const guidance: NarratorPhysicalGuidance = { ...emptyNarratorPhysicalGuidance(), ...candidates };
    const leaks = assertNoResolverOnlyLeak(guidance);

    expect(leaks).toHaveLength(4);
    expect(leaks.every((leak) => leak.severity === "error")).toBe(true);
    expect(leaks.every((leak) => leak.code === GUIDANCE_DISCLOSURE_LEAK)).toBe(true);
    expect(leaks[0]?.context).toMatchObject({
      kind: "constraint",
      fingerprint: candidates.constraints[0]?.fingerprint,
    });
  });
});

describe("the perception half of the same law", () => {
  it("keeps the prohibition but not the cause when the locus is not visible", () => {
    const constraints = buildConstraintCandidates({
      subjectId: GUIDANCE_PROBE_SUBJECT_ID,
      domainId: GUIDANCE_PROBE_DOMAIN_ID,
      constraints: [
        { kind: "constraint", id: `${GUIDANCE_PROBE_DOMAIN_ID}.probe_state`, code: "bound", locationId: "probe_locus" },
      ],
      mappings: [
        { constraintCode: "bound", prohibitedClaimCodes: ["claim_forbidden"], truthClaimCodes: ["claim_truth"] },
      ],
      perception: affordancePerceptionView({ exposure: { probe_locus: "hidden" }, channels: { sight: "available" } }),
    });
    const gated = filterGuidanceForConsumer({ constraints }, "narrator_prompt");

    // It SURVIVES the gate — a fence over hidden state is exactly what the plan
    // asks for — but carries nothing the prompt could use to explain the cause.
    expect(gated.constraints).toHaveLength(1);
    expect(gated.constraints[0]?.prohibitedClaimCodes).toEqual(["claim_forbidden"]);
    expect(gated.constraints[0]?.allowedClaimCodes).toEqual([]);
  });
});
