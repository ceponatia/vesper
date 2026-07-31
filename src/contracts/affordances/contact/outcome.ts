import { diag, type DiagnosticSink } from "../../diagnostics";
import { CONTACT_COMMIT_UNACKNOWLEDGED } from "./diagnostics";
import type { ContactId } from "./identity";
import type { ContactLifecycleCommit, ContactResolutionStatus } from "./types";

/**
 * The contact core's half of the narrator seam — resolution → action-outcome
 * status (romantic-contact-affordances.spec.contact-core.md §"As built —
 * slice 3A").
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
 */
export type ContactPersistenceAcknowledgment =
  | {
      readonly kind: "persisted";
      readonly contactId: ContactId;
      readonly commitKind: ContactLifecycleCommit["kind"];
    }
  | { readonly kind: "not_persisted"; readonly reason: ContactPersistenceFailure };

export interface ContactActionOutcomeInput {
  readonly resolution: ContactResolutionStatus;
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

  const acknowledgment = input.acknowledgment;
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
  return "committed";
}
