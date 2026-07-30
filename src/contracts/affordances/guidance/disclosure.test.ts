import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import { affordancePerceptionView } from "../core";
import { buildConstraintCandidates } from "./constraint-candidates";
import {
  assertNoResolverOnlyLeak,
  filterGuidanceForConsumer,
  GUIDANCE_DISCLOSURE_INVALID,
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
  type PhysicalNarrationConstraint,
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

/**
 * A candidate whose disclosure is not in the vocabulary AT ALL — not a secret,
 * just a value nothing in this repo can produce: a lane adapter's parse of a
 * persisted or remote shape (slice 6), a store written by an older release, a
 * typo'd literal on the far side of a boundary.
 *
 * The cast lives only here. The production types stay closed, and that is exactly
 * the point: a closed union binds the producers the compiler can see, so the gate
 * has to be a RUNTIME allowlist or an unknown value would be prompt-safe by
 * default. `disclosure` is typed `unknown` so a non-string can be passed too.
 */
const outOfUnion = (disclosure: unknown, id = "rogue_disclosure"): PhysicalNarrationConstraint =>
  ({ ...probeConstraint({ id }), disclosure }) as unknown as PhysicalNarrationConstraint;

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

  it("fails closed on a disclosure outside the vocabulary, with an error naming the bad value", () => {
    const collector = new DiagnosticCollector();
    const rogue = outOfUnion("narrator_prompt_allowed");
    const gated = filterGuidanceForConsumer(
      { constraints: [rogue, probeConstraint({ id: "stated_fence" })] },
      "narrator_prompt",
      collector,
    );

    // Allowlist, not denylist: an unrecognized value is dropped exactly like a
    // secret would be, instead of sailing through a `!== "resolver_only"` test.
    expect(gated.constraints.map((constraint) => constraint.id)).toEqual(["stated_fence"]);
    expect(collector.items).toHaveLength(1);
    expect(collector.items[0]?.code).toBe(GUIDANCE_DISCLOSURE_INVALID);
    expect(collector.items[0]?.severity).toBe("error");
    expect(collector.items[0]?.message).toContain("narrator_prompt_allowed");
    expect(collector.items[0]?.message).toContain(rogue.fingerprint);
    expect(collector.items[0]?.context).toMatchObject({
      kind: "constraint",
      fingerprint: rogue.fingerprint,
      disclosure: "narrator_prompt_allowed",
    });
    expect(collector.hasErrors).toBe(true);
  });

  it("treats a missing or non-string disclosure as invalid, and never throws formatting it", () => {
    const collector = new DiagnosticCollector();
    const gated = filterGuidanceForConsumer(
      { constraints: [outOfUnion(undefined, "absent"), outOfUnion(7, "numeric")] },
      "narrator_prompt",
      collector,
    );
    expect(gated.constraints).toEqual([]);
    expect(collector.items.map((item) => item.code)).toEqual([
      GUIDANCE_DISCLOSURE_INVALID,
      GUIDANCE_DISCLOSURE_INVALID,
    ]);
    expect(collector.items.map((item) => item.context?.disclosure)).toEqual(["undefined", "7"]);
  });

  it("still passes an out-of-union disclosure to the resolver, silently", () => {
    const collector = new DiagnosticCollector();
    const candidates = { constraints: [outOfUnion("whatever")] };
    const gated = filterGuidanceForConsumer(candidates, "resolver", collector);
    // The resolver owns its own validation; this gate is the narrator's, not everyone's.
    expect(gated.constraints).toEqual(candidates.constraints);
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

  it("errors on any non-allowlisted disclosure, not just resolver_only", () => {
    const rogue = outOfUnion("public");
    const leaks = assertNoResolverOnlyLeak({ ...emptyNarratorPhysicalGuidance(), constraints: [rogue] });

    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.severity).toBe("error");
    expect(leaks[0]?.code).toBe(GUIDANCE_DISCLOSURE_INVALID);
    expect(leaks[0]?.message).toContain("public");
    expect(leaks[0]?.context).toMatchObject({
      kind: "constraint",
      fingerprint: rogue.fingerprint,
      disclosure: "public",
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
