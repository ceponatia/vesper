import type { DiagnosticSink } from "../diagnostics";
import { affordanceEvidence, type AffordanceEvidence, type AffordanceSubjectId } from "../affordances/core";
import type { ContactParticipantEligibilityRead } from "../affordances/contact/decisions";
import { resolveAdultEligibility, type AdultEligibilityInput, type AdultEligibilityResult } from "./resolve";

/**
 * The seam between authored declarations and the contact core
 * (adult-eligibility.spec.md §"Adapter seam"; romantic-contact-affordances plan slice 2).
 *
 * Direction is one-way and deliberate: `affordances/contact` is domain-neutral and
 * knows nothing about profiles, personas, ages, or libraries — it consumes a
 * `ContactParticipantEligibilityRead` that somebody else produced. This module is that
 * somebody. Putting the mapping here rather than inside `contact/` is what keeps the
 * core's `domain-neutrality.test.ts` honest and keeps profile vocabulary out of a layer
 * that both the foot and intimate domains share.
 *
 * Nothing wires this into the chat pipeline yet — slice 3 of the romantic-contact plan
 * owns that.
 */

/** One participant, identified for the read, with the two resolver inputs. */
export interface AdultEligibilityParticipant extends AdultEligibilityInput {
  readonly id: AffordanceSubjectId;
}

/**
 * Tag a stored profile with the subject id the contact read is keyed by.
 *
 * A `CharacterProfile` and a `PersonaProfile` are both structurally
 * `AdultEligibilityInput` already (same field names), so this only adds the id —
 * there is no mapping step that could be written wrong and silently produce
 * `unresolved`. Neither profile type is imported here: the dependency runs profiles →
 * eligibility, never back.
 */
export function adultEligibilityParticipant(
  id: AffordanceSubjectId,
  profile: AdultEligibilityInput,
): AdultEligibilityParticipant {
  return {
    id,
    adultEligibilityDeclaration: profile.adultEligibilityDeclaration,
    ...(profile.age === undefined ? {} : { age: profile.age }),
  };
}

/**
 * Combine per-participant verdicts into the contact core's read.
 *
 * The combination rule is the plan's, and it is not a majority vote: **every**
 * participant must be `eligible` for the set to be, **any** `ineligible` sinks it, and
 * everything else — including an empty participant list, which means the lane could not
 * say who was in the scene — is `unresolved`. The contact core treats `unresolved` as a
 * refusal for `romantic` and `intimate`, so "we could not ask" and "yes" stay different
 * answers all the way down.
 *
 * `not_required` is never produced here: eligibility being irrelevant is the action
 * kind's business (`contactActionRequiresAdultEligibility`), not this adapter's.
 */
export function contactParticipantEligibility(
  participants: readonly AdultEligibilityParticipant[],
  sink?: DiagnosticSink,
  path?: string,
): ContactParticipantEligibilityRead {
  const evidence: AffordanceEvidence[] = [];
  const results: AdultEligibilityResult[] = participants.map((participant) => {
    const result = resolveAdultEligibility(participant, sink, path);
    evidence.push(affordanceEvidence("adapter", `adult_eligibility:${participant.id}`, result));
    return result;
  });

  const status = results.some((r) => r === "ineligible")
    ? "ineligible"
    : results.length > 0 && results.every((r) => r === "eligible")
      ? "eligible"
      : "unresolved";

  if (results.length === 0) evidence.push(affordanceEvidence("adapter", "adult_eligibility", "no_participants"));

  return { status, participantIds: participants.map((p) => p.id), evidence };
}
