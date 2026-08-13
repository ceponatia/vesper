import { mergeAffordanceEvidence, type AffordanceEvidence } from "../core";
import { guidanceFingerprint, guidanceOrderedPart } from "./fingerprint";
import type { GuidanceDisclosure, PhysicalActionOutcome, PhysicalActionStatus } from "./types";

/**
 * The action-outcome adapter seam (narrator-physical-guidance.plan.md slice 1,
 * consumed by slice 3's contact resolver).
 *
 * A resolver decides feasibility, permission, consent, and actor control; this
 * function only stamps the result with a deterministic identity so it can be
 * ordered and reproduced on a retake. It adds no policy of its own except the
 * `narratorMustResolve` floor below.
 *
 * One obligation this seam cannot check and every producer owes it: `committed`
 * means the action HAPPENED and was durably recorded, not that a resolver would
 * have allowed it. A pre-commit conclusion mapped straight onto `committed`
 * hands the narrator a fact the store may never have written. The contact core
 * makes that explicit — `contact/outcome.ts` will not return `committed` without
 * a post-persistence acknowledgment — and any other producer joining this seam
 * inherits the same rule.
 */

/**
 * Statuses the narrator CANNOT render as a completed attempt.
 *
 * `committed` needs no mandate — the attempt happened, and describing it is the
 * beat the player already asked for. `unresolved` gets none either: the correct
 * output for "the resolver could not decide" is silence, not an explanation of
 * why the world is unsure.
 */
export function guidanceActionMustResolve(status: PhysicalActionStatus): boolean {
  switch (status) {
    case "rejected":
    case "explicit_transition_required":
    case "partially_committed":
      return true;
    case "committed":
    case "unresolved":
      return false;
  }
}

/** Every `PhysicalActionOutcome` field the resolver supplies; the fingerprint is derived. */
export interface PhysicalActionOutcomeInput {
  readonly actionId: string;
  readonly status: PhysicalActionStatus;
  readonly resultCodes: readonly string[];
  /**
   * Opt IN for a status that does not mandate resolution. This is a floor, not a
   * default: a rejected, partially committed, or transition-requiring outcome
   * resolves `true` whatever the caller passes, because "the narrator may skip
   * accounting for a blocked attempt" is the failure this layer exists to stop.
   */
  readonly narratorMustResolve?: boolean;
  readonly disclosure: GuidanceDisclosure;
  readonly evidence?: readonly AffordanceEvidence[];
}

export function buildActionOutcome(input: PhysicalActionOutcomeInput): PhysicalActionOutcome {
  const narratorMustResolve = guidanceActionMustResolve(input.status) || (input.narratorMustResolve ?? false);
  const resultCodes = [...input.resultCodes];
  return {
    actionId: input.actionId,
    status: input.status,
    resultCodes,
    narratorMustResolve,
    disclosure: input.disclosure,
    evidence: mergeAffordanceEvidence(input.evidence ?? []),
    fingerprint: guidanceFingerprint([
      "action_outcome",
      input.actionId,
      input.status,
      guidanceOrderedPart(resultCodes),
      input.disclosure,
      narratorMustResolve ? "must_resolve" : "optional",
    ]),
  };
}
