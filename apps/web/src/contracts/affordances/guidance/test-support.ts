import { affordanceSubjectId, type AffordanceSubjectId } from "../core";
import { buildActionOutcome } from "./action-outcome";
import { guidanceFingerprint, guidanceOrderedPart, guidanceUnorderedPart } from "./fingerprint";
import type {
  GuidanceDisclosure,
  GuidancePriority,
  PhysicalActionOutcome,
  PhysicalActionStatus,
  PhysicalNarrationConstraint,
  PhysicalPremiseCorrection,
  PhysicalStateTransition,
  PhysicalTransitionRelevance,
} from "./types";

/**
 * Candidate builders for this layer's own tests.
 *
 * Deliberately NOT exported from `index.ts`: unlike the recognition fixtures
 * (which are calibration evidence), these are scaffolding — a neutral `probe`
 * vocabulary that exists so six test files can share one set of builders instead
 * of six copies of the same literals.
 *
 * Every builder computes a real fingerprint, because the properties under test
 * (deterministic order, stable tie-breaks, budget reporting) are properties OF
 * the fingerprint. A hand-written placeholder would test nothing.
 */

export const GUIDANCE_PROBE_SUBJECT_ID: AffordanceSubjectId = affordanceSubjectId("subject_guidance_probe");
export const GUIDANCE_PROBE_DOMAIN_ID = "probe";

export function probeConstraint(input: {
  readonly id: string;
  readonly priority?: GuidancePriority;
  readonly disclosure?: GuidanceDisclosure;
  readonly prohibited?: readonly string[];
  readonly allowed?: readonly string[];
  readonly loci?: readonly string[];
}): PhysicalNarrationConstraint {
  const priority = input.priority ?? "normal";
  const disclosure = input.disclosure ?? "consistency_only";
  const locusIds = input.loci ?? ["probe_locus"];
  const prohibitedClaimCodes = input.prohibited ?? [`${input.id}_forbidden`];
  const allowedClaimCodes = input.allowed ?? [];
  return {
    id: input.id,
    subjectIds: [GUIDANCE_PROBE_SUBJECT_ID],
    domainId: GUIDANCE_PROBE_DOMAIN_ID,
    locusIds,
    prohibitedClaimCodes,
    allowedClaimCodes,
    disclosure,
    priority,
    evidence: [],
    fingerprint: guidanceFingerprint([
      "constraint",
      GUIDANCE_PROBE_DOMAIN_ID,
      input.id,
      guidanceUnorderedPart(locusIds),
      guidanceUnorderedPart(prohibitedClaimCodes),
      guidanceUnorderedPart(allowedClaimCodes),
      disclosure,
      priority,
    ]),
  };
}

export function probeCorrection(input: {
  readonly id: string;
  readonly verdict?: PhysicalPremiseCorrection["verdict"];
  readonly disclosure?: PhysicalPremiseCorrection["disclosure"];
}): PhysicalPremiseCorrection {
  const verdict = input.verdict ?? "contradicted";
  const disclosure = input.disclosure ?? "consistency_only";
  return {
    id: input.id,
    source: "player_dialogue",
    claimCode: `${input.id}_claim`,
    verdict,
    truthCodes: [`${input.id}_truth`],
    disclosure,
    evidence: [],
    fingerprint: guidanceFingerprint(["correction", input.id, verdict, disclosure]),
  };
}

export function probeActionOutcome(input: {
  readonly actionId: string;
  readonly status?: PhysicalActionStatus;
  readonly disclosure?: GuidanceDisclosure;
  readonly mustResolve?: boolean;
}): PhysicalActionOutcome {
  return buildActionOutcome({
    actionId: input.actionId,
    status: input.status ?? "committed",
    resultCodes: [`${input.actionId}_result`],
    disclosure: input.disclosure ?? "consistency_only",
    ...(input.mustResolve === undefined ? {} : { narratorMustResolve: input.mustResolve }),
  });
}

export function probeTransition(input: {
  readonly id: string;
  readonly relevance?: PhysicalTransitionRelevance;
}): PhysicalStateTransition {
  const relevance = input.relevance ?? "action";
  const beforeCodes = [`${input.id}_before`];
  const afterCodes = [`${input.id}_after`];
  return {
    id: input.id,
    subjectIds: [GUIDANCE_PROBE_SUBJECT_ID],
    domainId: GUIDANCE_PROBE_DOMAIN_ID,
    locusIds: ["probe_locus"],
    beforeCodes,
    afterCodes,
    causeCodes: [`${input.id}_cause`],
    relevance,
    disclosure: "positive_detail_allowed",
    repeatKey: `probe:${input.id}`,
    evidence: [],
    fingerprint: guidanceFingerprint([
      "transition",
      GUIDANCE_PROBE_DOMAIN_ID,
      input.id,
      guidanceOrderedPart([...beforeCodes, ...afterCodes]),
      relevance,
    ]),
  };
}
