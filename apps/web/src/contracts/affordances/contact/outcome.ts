import { diag, type DiagnosticSink } from "../../diagnostics";
import { CONTACT_COMMIT_MISMATCHED, CONTACT_COMMIT_UNACKNOWLEDGED } from "./diagnostics";
import type { ContactEventRef, ContactId } from "./identity";
import type { ContactCommitOutcome } from "./lifecycle";
import type { ContactLifecycleCommit, ContactResolutionStatus } from "./types";

/**
 * The contact core's half of the narrator seam — resolution → action-outcome
 * status.
 *
 * ## Why this is a function and not a lookup table
 *
 * A resolution is a PRE-COMMIT conclusion. `committable` means the gate would
 * allow this contact, not that it happened: between the resolution and the
 * narrator there is a lifecycle fold and a durable write, and either can fail.
 * A constant map from `committable` to `committed` therefore hands the narrator
 * a fact the store may never have recorded — and the narrator's whole job is to
 * treat `committed` as something that definitely occurred.
 *
 * So `committed` is reachable ONLY through a `persisted` acknowledgment that the
 * lane produces after its write. Everything else about a committable resolution
 * — no acknowledgment, a failed write, a rolled-back turn — resolves
 * `unresolved`, which the seam renders as silence rather than as a claim.
 *
 * ## Why an acknowledgment is not enough on its own
 *
 * A structurally valid `persisted` value used to be sufficient, and "a write
 * happened" is not the claim the narrator hears. The narrator hears "THIS
 * action's contact is now current truth", and an acknowledgment can be true and
 * still not say that: it can name a different contact, report a commit kind this
 * action never produced, be the reply to an EARLIER write on the same contact
 * that a retry or a queued turn left lying around, or acknowledge the write that
 * ENDED the contact — a durable, successful, correctly-shaped write whose
 * meaning is the opposite of `committed`.
 *
 * The fix is to compare, not to trust: the caller passes what this action's fold
 * actually produced (`ContactCommitExpectation` — contact id, commit kind, the
 * lane event that stamped it, and the action's own id), and every field must
 * match the acknowledgment. Any mismatch is `unresolved` with an `error`. The
 * expectation is built from the outcome by `contactCommitExpectation`, so the
 * two halves cannot be assembled from different turns by hand.
 *
 * ## Why the output type is narrower than the seam's
 *
 * `PhysicalActionStatus` carries `partially_committed` for a future domain that
 * commits at some loci and not others. Contact has no such producer: a contact
 * either exists on a surface pair or does not. Leaving that value representable
 * here would make "half a touch" a value some adapter could pass through by
 * accident, so it is excluded by TYPE — `ContactActionOutcomeStatus` is the
 * four-value subset, and the generic vocabulary keeps its fifth for whoever
 * genuinely needs it.
 *
 * This layer never imports `guidance/` (the neutrality test forbids it); the
 * subset relationship is pinned by a test that reads both vocabularies.
 */

/**
 * The only statuses a contact attempt may report to the narrator seam. A strict
 * subset of the seam's `PhysicalActionStatus`.
 */
export const contactActionOutcomeStatuses = [
  "committed",
  "explicit_transition_required",
  "rejected",
  "unresolved",
] as const;
export type ContactActionOutcomeStatus = (typeof contactActionOutcomeStatuses)[number];

/** Why a committable contact was not durably recorded. */
export const contactPersistenceFailures = ["not_attempted", "write_failed", "rolled_back"] as const;
export type ContactPersistenceFailure = (typeof contactPersistenceFailures)[number];

/**
 * The lane's answer about what the store did with a committed contact.
 *
 * `persisted` carries the ids rather than a bare flag so the acknowledgment
 * cannot be forged from nothing — a caller that has one has been through the
 * fold and the write, and the contact it names is in the record it just made.
 *
 * `eventRef` and `actionId` are what bind it to ONE action. Without them a
 * perfectly genuine acknowledgment of last turn's write on the same contact,
 * with the same commit kind, is indistinguishable from this turn's; a retry, a
 * queued turn, or a rollback that left the earlier reply in hand would all read
 * as `committed` for a write that never happened.
 */
export type ContactPersistenceAcknowledgment =
  | {
      readonly kind: "persisted";
      readonly contactId: ContactId;
      readonly commitKind: ContactLifecycleCommit["kind"];
      /** The lane event the write was stamped with — this action's own. */
      readonly eventRef: ContactEventRef;
      /** The attempt this write belongs to (`ContactActionIntent.actionId`). */
      readonly actionId: string;
    }
  | { readonly kind: "not_persisted"; readonly reason: ContactPersistenceFailure };

/** A persisted acknowledgment, narrowed. */
type PersistedAcknowledgment = Extract<ContactPersistenceAcknowledgment, { kind: "persisted" }>;

/**
 * What THIS action's lifecycle fold actually produced. The thing an
 * acknowledgment is checked against.
 */
export interface ContactCommitExpectation {
  readonly contactId: ContactId;
  readonly commitKind: ContactLifecycleCommit["kind"];
  readonly eventRef: ContactEventRef;
  readonly actionId: string;
}

/**
 * Build the expectation from the fold's own outcome.
 *
 * `undefined` for a refused outcome — nothing was committed, so there is nothing
 * an acknowledgment could correctly name, and the caller gets the same
 * `unresolved` it would get for a missing acknowledgment.
 */
export function contactCommitExpectation(input: {
  readonly outcome: ContactCommitOutcome;
  readonly eventRef: ContactEventRef;
  readonly actionId: string;
}): ContactCommitExpectation | undefined {
  if (input.outcome.status !== "committed") return undefined;
  return {
    contactId: input.outcome.contact.contactId,
    commitKind: input.outcome.commit.kind,
    eventRef: input.eventRef,
    actionId: input.actionId,
  };
}

/** How an acknowledgment failed to name this action's own commit. */
export const contactAcknowledgmentMismatches = [
  "contact_id",
  "commit_kind",
  "event_ref",
  "action_id",
  "commit_ended_the_contact",
] as const;
export type ContactAcknowledgmentMismatch = (typeof contactAcknowledgmentMismatches)[number];

/**
 * The first field on which a durable acknowledgment and this action's commit
 * disagree, or `undefined` when they are the same write.
 *
 * `commit_ended_the_contact` is last and is not a disagreement at all: the two
 * sides agree, and what they agree on is that the durable write ENDED this
 * contact. That is a successful write and the opposite of `committed`, so it can
 * never reach the narrator as one — the seam's `committed` means "this contact
 * is current truth", and an ended contact is not even assignable to
 * `CommittedContactRead`.
 */
function acknowledgmentMismatch(
  expected: ContactCommitExpectation,
  acknowledgment: PersistedAcknowledgment,
): ContactAcknowledgmentMismatch | undefined {
  if (acknowledgment.contactId !== expected.contactId) return "contact_id";
  if (acknowledgment.commitKind !== expected.commitKind) return "commit_kind";
  if (acknowledgment.eventRef !== expected.eventRef) return "event_ref";
  if (acknowledgment.actionId !== expected.actionId) return "action_id";
  if (acknowledgment.commitKind === "contact_ended") return "commit_ended_the_contact";
  return undefined;
}

export interface ContactActionOutcomeInput {
  readonly resolution: ContactResolutionStatus;
  /**
   * What this action's fold produced, from `contactCommitExpectation`. Required
   * in practice for a committable resolution; absent is a pipeline bug.
   */
  readonly expected?: ContactCommitExpectation;
  /** Required in practice for a committable resolution; absent is a pipeline bug. */
  readonly acknowledgment?: ContactPersistenceAcknowledgment;
  readonly sink?: DiagnosticSink;
}

/**
 * Translate one resolution, plus what the store did about it, into the status
 * the narrator seam receives.
 *
 * Total and pure. The three non-committable statuses pass through unchanged —
 * they are answers the fiction can carry and nothing about persistence changes
 * them.
 */
export function contactActionOutcomeStatus(input: ContactActionOutcomeInput): ContactActionOutcomeStatus {
  switch (input.resolution) {
    case "rejected":
      return "rejected";
    case "explicit_transition_required":
      return "explicit_transition_required";
    case "unresolved":
      return "unresolved";
    case "committable":
      break;
  }

  const { expected, acknowledgment } = input;
  if (expected === undefined) {
    input.sink?.push(
      diag(
        "error",
        CONTACT_COMMIT_UNACKNOWLEDGED,
        "a committable contact was reported to the narrator with no lifecycle commit behind it",
      ),
    );
    return "unresolved";
  }
  if (acknowledgment === undefined) {
    input.sink?.push(
      diag(
        "error",
        CONTACT_COMMIT_UNACKNOWLEDGED,
        "a committable contact was reported to the narrator before anything acknowledged the write",
      ),
    );
    return "unresolved";
  }
  if (acknowledgment.kind === "not_persisted") {
    input.sink?.push(
      diag("warn", CONTACT_COMMIT_UNACKNOWLEDGED, "a committable contact was not durably recorded", {
        context: { reason: acknowledgment.reason },
      }),
    );
    return "unresolved";
  }

  const mismatch = acknowledgmentMismatch(expected, acknowledgment);
  if (mismatch !== undefined) {
    input.sink?.push(
      diag("error", CONTACT_COMMIT_MISMATCHED, "a durable acknowledgment did not name this action's own commit", {
        context: {
          mismatch,
          expectedContactId: expected.contactId,
          acknowledgedContactId: acknowledgment.contactId,
          expectedCommitKind: expected.commitKind,
          acknowledgedCommitKind: acknowledgment.commitKind,
          expectedEventRef: expected.eventRef,
          acknowledgedEventRef: acknowledgment.eventRef,
          expectedActionId: expected.actionId,
          acknowledgedActionId: acknowledgment.actionId,
        },
      }),
    );
    return "unresolved";
  }
  return "committed";
}
