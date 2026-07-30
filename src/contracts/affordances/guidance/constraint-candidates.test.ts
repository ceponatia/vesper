import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "../../diagnostics";
import {
  affordanceEvidence,
  affordancePerceptionView,
  deepFreeze,
  emptyAffordancePerceptionView,
  type AffordanceConstraint,
  type AffordanceExposure,
} from "../core";
import {
  buildConstraintCandidates,
  GUIDANCE_CONSTRAINT_UNMAPPED,
  type ConstraintClaimMapping,
} from "./constraint-candidates";
import { GUIDANCE_PROBE_DOMAIN_ID, GUIDANCE_PROBE_SUBJECT_ID } from "./test-support";

/**
 * The mapping seam's two jobs: refuse to invent guidance from unmapped data, and
 * decide — by exposure alone — whether the committed truth may be stated.
 *
 * The second is plan §5's hard rule in its narrowest form: a fence over a fact
 * the observer cannot perceive still ships, but it ships WITHOUT the cause. The
 * prohibition is what stops a contradiction; the cause is what would leak.
 */

const constraint = (input: { code: string; locationId?: string; id?: string }): AffordanceConstraint =>
  deepFreeze({
    kind: "constraint",
    id: input.id ?? `${GUIDANCE_PROBE_DOMAIN_ID}.probe_state`,
    code: input.code,
    ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
  });

const mapping = (input: Partial<ConstraintClaimMapping> & { constraintCode: string }): ConstraintClaimMapping => ({
  prohibitedClaimCodes: ["claim_forbidden"],
  truthClaimCodes: ["claim_truth"],
  ...input,
});

const perceived = (exposure: Record<string, AffordanceExposure>) =>
  affordancePerceptionView({ exposure, channels: { sight: "available" } });

const build = (input: {
  constraints: readonly AffordanceConstraint[];
  mappings: readonly ConstraintClaimMapping[];
  exposure?: Record<string, AffordanceExposure>;
  collector?: DiagnosticCollector;
}) =>
  buildConstraintCandidates({
    subjectId: GUIDANCE_PROBE_SUBJECT_ID,
    domainId: GUIDANCE_PROBE_DOMAIN_ID,
    constraints: input.constraints,
    mappings: input.mappings,
    perception: input.exposure === undefined ? emptyAffordancePerceptionView() : perceived(input.exposure),
    evidence: [affordanceEvidence("adapter", "probe.read")],
    ...(input.collector === undefined ? {} : { sink: input.collector }),
  });

describe("buildConstraintCandidates", () => {
  it("maps a matched constraint into a candidate carrying the domain's claim codes", () => {
    const collector = new DiagnosticCollector();
    const candidates = build({
      constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
      mappings: [mapping({ constraintCode: "bound", priority: "high" })],
      exposure: { probe_locus: "visible" },
      collector,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      domainId: GUIDANCE_PROBE_DOMAIN_ID,
      subjectIds: [GUIDANCE_PROBE_SUBJECT_ID],
      locusIds: ["probe_locus"],
      prohibitedClaimCodes: ["claim_forbidden"],
      disclosure: "consistency_only",
      priority: "high",
    });
    expect(candidates[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    expect(collector.items).toEqual([]);
  });

  it("carries the committed truth only when every locus is visible", () => {
    const visible = build({
      constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
      mappings: [mapping({ constraintCode: "bound" })],
      exposure: { probe_locus: "visible" },
    });
    expect(visible[0]?.allowedClaimCodes).toEqual(["claim_truth"]);
  });

  it.each<AffordanceExposure | "absent">(["hinted", "hidden", "unknown", "absent"])(
    "keeps the prohibition but drops the cause when a locus reads %s",
    (exposure) => {
      const candidates = build({
        constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
        mappings: [mapping({ constraintCode: "bound" })],
        exposure: exposure === "absent" ? {} : { probe_locus: exposure },
      });
      expect(candidates[0]?.prohibitedClaimCodes).toEqual(["claim_forbidden"]);
      expect(candidates[0]?.allowedClaimCodes).toEqual([]);
      expect(candidates[0]?.disclosure).toBe("consistency_only");
    },
  );

  it("fails closed for a domain-wide constraint with no locus to check", () => {
    const candidates = build({
      constraints: [constraint({ code: "bound" })],
      mappings: [mapping({ constraintCode: "bound" })],
    });
    expect(candidates[0]?.locusIds).toEqual([]);
    expect(candidates[0]?.allowedClaimCodes).toEqual([]);
  });

  it("records the exposure it judged on as coverage evidence", () => {
    const candidates = build({
      constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
      mappings: [mapping({ constraintCode: "bound" })],
      exposure: { probe_locus: "hidden" },
    });
    expect(candidates[0]?.evidence).toEqual([
      { kind: "adapter", ref: "probe.read" },
      { kind: "state", ref: `${GUIDANCE_PROBE_DOMAIN_ID}.probe_state`, detail: "bound" },
      { kind: "coverage", ref: "probe_locus", detail: "hidden" },
    ]);
  });

  it("produces no candidate and one info diagnostic for an unmapped constraint", () => {
    const collector = new DiagnosticCollector();
    const candidates = build({
      constraints: [constraint({ code: "unknown_code", locationId: "probe_locus" })],
      mappings: [mapping({ constraintCode: "bound" })],
      exposure: { probe_locus: "visible" },
      collector,
    });

    expect(candidates).toEqual([]);
    expect(collector.items).toHaveLength(1);
    expect(collector.items[0]).toMatchObject({
      severity: "info",
      code: GUIDANCE_CONSTRAINT_UNMAPPED,
      context: { reason: "unmapped", code: "unknown_code" },
    });
    expect(collector.hasErrors).toBe(false);
  });

  it("produces no candidate when a mapping has nothing to say", () => {
    const collector = new DiagnosticCollector();
    const candidates = build({
      constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
      mappings: [mapping({ constraintCode: "bound", prohibitedClaimCodes: [], truthClaimCodes: [] })],
      exposure: { probe_locus: "visible" },
      collector,
    });
    expect(candidates).toEqual([]);
    expect(collector.items[0]).toMatchObject({ context: { reason: "no_claim_codes" } });
  });

  it("does not match a mapping scoped to another locus, and prefers the specific one", () => {
    const mappings = [
      mapping({ constraintCode: "bound", prohibitedClaimCodes: ["general"] }),
      mapping({ constraintCode: "bound", locationId: "other_locus", prohibitedClaimCodes: ["other"] }),
      mapping({ constraintCode: "bound", locationId: "probe_locus", prohibitedClaimCodes: ["specific"] }),
    ];
    const candidates = build({
      constraints: [constraint({ code: "bound", locationId: "probe_locus" })],
      mappings,
      exposure: { probe_locus: "visible" },
    });
    expect(candidates[0]?.prohibitedClaimCodes).toEqual(["specific"]);
  });

  it("drops a repeated constraint rather than spending two budget slots on one fence", () => {
    const candidates = build({
      constraints: [
        constraint({ code: "bound", locationId: "probe_locus" }),
        constraint({ code: "bound", locationId: "probe_locus" }),
      ],
      mappings: [mapping({ constraintCode: "bound" })],
      exposure: { probe_locus: "visible" },
    });
    expect(candidates).toHaveLength(1);
  });

  it("compiles empty input to empty output with no diagnostics", () => {
    const collector = new DiagnosticCollector();
    expect(build({ constraints: [], mappings: [], collector })).toEqual([]);
    expect(collector.items).toEqual([]);
  });
});
