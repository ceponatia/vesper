import { diag, type DiagnosticSink } from "../../diagnostics";
import {
  affordanceEvidence,
  affordanceExposureAt,
  mergeAffordanceEvidence,
  type AffordanceConstraint,
  type AffordanceEvidence,
  type AffordanceExposure,
  type AffordancePerceptionView,
  type AffordanceSubjectId,
} from "../core";
import { guidanceFingerprint, guidanceUnorderedPart } from "./fingerprint";
import type { GuidancePriority, PhysicalNarrationConstraint } from "./types";

/**
 * The mapping seam: existing affordance constraints → guidance candidates,
 * WITHOUT the shared layer learning a domain.
 *
 * A domain resolution says only "this code is currently true at this locus"
 * (`AffordanceConstraint`). Which narrator claims that code forbids, and which
 * committed truth it licenses, is domain knowledge — so it arrives as DATA in a
 * `ConstraintClaimMapping` table the domain owns. This module knows nothing
 * about any code it copies; it decides only two things, both perception law:
 *
 * - **Whether a candidate exists at all.** An unmapped constraint, or a mapping
 *   with nothing to say, produces no candidate and one `info` diagnostic.
 *   Missing data never becomes guidance.
 * - **Whether the committed truth may be stated.** Fully visible loci license
 *   `allowedClaimCodes`; anything less — hinted, hidden, or a locus the lane
 *   cannot answer for — keeps the prohibition and drops the cause: a negative
 *   instruction about hidden state must be phrased without explaining the
 *   hidden cause.
 *
 * `positive_detail_allowed` is never produced here. A constraint is a fence;
 * positive detail rides the transition path and has its own gates.
 */

/**
 * One constraint produced no guidance. `info`, not `warn`: a domain legitimately
 * resolves constraints that no narrator lexicon covers yet, and conservative
 * silence is the designed outcome. `context.reason` separates the two causes
 * (`unmapped`, `no_claim_codes`).
 */
export const GUIDANCE_CONSTRAINT_UNMAPPED = "guidance.constraint.unmapped";

/**
 * A domain's declaration of what one of its constraint codes means to a
 * narrator. Owned and unit-tested by the domain; opaque here.
 */
export interface ConstraintClaimMapping {
  /** The domain's own `AffordanceConstraint.code` (`bound`, `covered`, …). */
  readonly constraintCode: string;
  /**
   * Scope the mapping to one body location. A mapping WITH a location beats a
   * code-only mapping for the same code, so a domain can state a general rule
   * and refine it per locus.
   */
  readonly locationId?: string;
  /** Claim codes the narrator must not make while this constraint holds. */
  readonly prohibitedClaimCodes: readonly string[];
  /** Committed-truth codes the prompt MAY state — if, and only if, the loci are visible. */
  readonly truthClaimCodes: readonly string[];
  /** Ranking tier inside the constraint budget. Defaults to `normal`. */
  readonly priority?: GuidancePriority;
}

interface LocusExposure {
  readonly locusId: string;
  readonly exposure: AffordanceExposure;
}

/**
 * The most specific mapping for one constraint: a locus-scoped mapping wins over
 * a code-only one, and a mapping scoped to a DIFFERENT locus never matches.
 */
function matchMapping(
  constraint: AffordanceConstraint,
  mappings: readonly ConstraintClaimMapping[],
): ConstraintClaimMapping | undefined {
  const matches = mappings.filter(
    (mapping) =>
      mapping.constraintCode === constraint.code &&
      (mapping.locationId === undefined || mapping.locationId === constraint.locationId),
  );
  return matches.find((mapping) => mapping.locationId !== undefined) ?? matches[0];
}

/** The resolution's own locus, else the mapping's scope, else domain-wide. */
function constraintLoci(constraint: AffordanceConstraint, mapping: ConstraintClaimMapping): readonly string[] {
  if (constraint.locationId !== undefined) return [constraint.locationId];
  return mapping.locationId === undefined ? [] : [mapping.locationId];
}

/**
 * Fully visible loci are the ONLY case that licenses the committed truth.
 *
 * A domain-wide constraint (no loci) fails closed with the rest: there is no
 * exposure to check, so the cause stays out of the prompt. That is the core
 * perception convention — "unknown is not probably fine, it is a lane that
 * cannot answer" (`core/perception.ts`) — and it costs only the positive half of
 * an instruction whose prohibition still ships.
 */
function licensesTruth(loci: readonly LocusExposure[]): boolean {
  return loci.length > 0 && loci.every((locus) => locus.exposure === "visible");
}

export function buildConstraintCandidates(input: {
  readonly subjectId: AffordanceSubjectId;
  readonly domainId: string;
  readonly constraints: readonly AffordanceConstraint[];
  readonly mappings: readonly ConstraintClaimMapping[];
  readonly perception: AffordancePerceptionView;
  /** Provenance from the read that produced the constraints. */
  readonly evidence?: readonly AffordanceEvidence[];
  readonly sink?: DiagnosticSink;
}): readonly PhysicalNarrationConstraint[] {
  const candidates: PhysicalNarrationConstraint[] = [];
  const seen = new Set<string>();

  const skip = (constraint: AffordanceConstraint, reason: string, message: string): void => {
    input.sink?.push(
      diag("info", GUIDANCE_CONSTRAINT_UNMAPPED, message, {
        path: "guidance.constraint",
        context: { domainId: input.domainId, constraintId: constraint.id, code: constraint.code, reason },
      }),
    );
  };

  for (const constraint of input.constraints) {
    const mapping = matchMapping(constraint, input.mappings);
    if (mapping === undefined) {
      skip(constraint, "unmapped", `No claim mapping for constraint code "${constraint.code}"`);
      continue;
    }

    const loci = constraintLoci(constraint, mapping).map((locusId) => ({
      locusId,
      exposure: affordanceExposureAt(input.perception, locusId),
    }));
    const locusIds = loci.map((locus) => locus.locusId);
    const prohibitedClaimCodes = [...mapping.prohibitedClaimCodes];
    const allowedClaimCodes = licensesTruth(loci) ? [...mapping.truthClaimCodes] : [];

    if (prohibitedClaimCodes.length === 0 && allowedClaimCodes.length === 0) {
      skip(constraint, "no_claim_codes", `Claim mapping for "${constraint.code}" yields no narrator instruction`);
      continue;
    }

    const priority = mapping.priority ?? "normal";
    const fingerprint = guidanceFingerprint([
      "constraint",
      input.domainId,
      input.subjectId,
      constraint.id,
      constraint.code,
      guidanceUnorderedPart(locusIds),
      guidanceUnorderedPart(prohibitedClaimCodes),
      guidanceUnorderedPart(allowedClaimCodes),
      "consistency_only",
      priority,
    ]);
    // Two identical constraints carry identical information; a repeat would only
    // consume a budget slot that a different fence could have used.
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    candidates.push({
      id: [constraint.id, constraint.code, ...locusIds].join(":"),
      subjectIds: [input.subjectId],
      domainId: input.domainId,
      locusIds,
      prohibitedClaimCodes,
      allowedClaimCodes,
      disclosure: "consistency_only",
      priority,
      evidence: mergeAffordanceEvidence(
        input.evidence ?? [],
        [affordanceEvidence("state", constraint.id, constraint.code)],
        loci.map((locus) => affordanceEvidence("coverage", locus.locusId, locus.exposure)),
      ),
      fingerprint,
    });
  }

  return candidates;
}
