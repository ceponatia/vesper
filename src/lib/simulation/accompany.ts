import type { ActivityInstance } from "@/contracts/simulation/activities";
import { claimHoldingActivityPhases } from "@/contracts/simulation/activities";
import type { Commitment } from "@/contracts/simulation/commitments";
import { OPEN_COMMITMENT_STATUSES } from "./solo-cut";

/**
 * Walk-with-me acceptance policy (world-ui.plan.md slice 5, §14.2) — PURE. When
 * the player invites the co-present primary to travel together, the primary's
 * acceptance is NPC AGENCY via a bounded DETERMINISTIC policy (no model call, no
 * consent-ledger touch — §39 ruling 16): accept UNLESS
 *
 *   (a) a claim-holding activity occupies the primary's BODY right now (the same
 *       body-claim gate `resolveMoveActor` enforces — they're mid-something), or
 *   (b) a `firm`/`hard` commitment falls due before the walk's arrival plus a
 *       small buffer (leaving now would put a real obligation at risk).
 *
 * A decline returns an honest §14.4-style PUBLIC face built from PUBLIC facts
 * ONLY — the SAME public reason whether (a) or (b) blocks her, so the private
 * cause never leaks (a body claim vs. a commitment must read identically). A
 * future pass upgrades this seam to the §19.3 deliberator (bounded legal
 * candidates, deterministic fallback = decline); the decision shape here is
 * chosen to survive that upgrade.
 *
 * No IO, no env, no db (src/lib purity): the caller loads the activities,
 * commitments, and arrival estimate; this only decides accept/decline and
 * phrases the face (the primary's display name — never a raw id).
 */

/** A firm/hard commitment this near the arrival makes the primary decline the walk. */
export const ACCOMPANY_ARRIVAL_BUFFER_SECONDS = 300;

export interface AccompanyPolicyInput {
  primaryActorId: string;
  /** The primary's display name — the public face names them, never an id. */
  primaryName: string;
  /** The branch's live activities (the body-claim gate reads the primary's). */
  activities: readonly ActivityInstance[];
  /** The branch's commitments (the firm/hard-due gate reads the primary's). */
  commitments: readonly Commitment[];
  /** The story-second the walk would earliest-arrive at the destination (§17.1 lower bound). */
  arrivalStorySecond: number;
}

export type AccompanyDecision =
  | { accept: true }
  | { accept: false; publicReason: string; legalAlternatives: string[] };

/** True when a claim-holding activity holds the actor's BODY (the departure-blocking claim, §3.1). */
export function actorHoldsBodyClaim(actorId: string, activities: readonly ActivityInstance[]): boolean {
  return activities.some(
    (activity) =>
      activity.actorIds.some((id) => id === actorId) &&
      (claimHoldingActivityPhases as readonly string[]).includes(activity.phase) &&
      activity.claims.some((claim) => claim.kind === "body"),
  );
}

/** A firm/hard, still-open commitment whose deadline lands before arrival + the buffer. */
function firmCommitmentDueBeforeArrival(
  actorId: string,
  commitments: readonly Commitment[],
  arrivalStorySecond: number,
): boolean {
  const deadline = arrivalStorySecond + ACCOMPANY_ARRIVAL_BUFFER_SECONDS;
  return commitments.some(
    (commitment) =>
      commitment.actorId === actorId &&
      OPEN_COMMITMENT_STATUSES.has(commitment.status) &&
      (commitment.flexibility === "firm" || commitment.flexibility === "hard") &&
      commitment.window.latestArrival <= deadline,
  );
}

/** The one PUBLIC decline face — identical for a body claim and a due commitment (no private cause). */
function declineAccompany(primaryName: string): AccompanyDecision {
  return {
    accept: false,
    publicReason: `${primaryName} can't come with you right now.`,
    legalAlternatives: ["go on your own", "wait a while"],
  };
}

/**
 * The accept/decline decision for one walk-with-me invite. Deterministic and
 * exhaustive over the two decline conditions; every other case accepts.
 */
export function decideAccompany(input: AccompanyPolicyInput): AccompanyDecision {
  if (actorHoldsBodyClaim(input.primaryActorId, input.activities)) {
    return declineAccompany(input.primaryName);
  }
  if (firmCommitmentDueBeforeArrival(input.primaryActorId, input.commitments, input.arrivalStorySecond)) {
    return declineAccompany(input.primaryName);
  }
  return { accept: true };
}
