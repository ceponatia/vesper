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

/**
 * The library identity behind one participant — carried through the read so a
 * BLOCKED action can route the user to the surface that can actually fix it
 * (see `adultEligibilityEditorTarget` in blocker.ts). Optional: a lane that
 * cannot say (a synthetic subject, a fixture) simply omits it and the blocker
 * helper degrades to no link.
 */
export interface AdultEligibilityParticipantEntity {
  readonly kind: "character" | "persona";
  readonly entityId: string;
  /** True when the viewer does not own the row (a public/foreign character). */
  readonly foreign?: boolean;
}

/** One participant, identified for the read, with the two resolver inputs. */
export interface AdultEligibilityParticipant extends AdultEligibilityInput {
  readonly id: AffordanceSubjectId;
  readonly entity?: AdultEligibilityParticipantEntity;
}

/** One participant's preserved verdict — the per-participant half of the read. */
export interface AdultEligibilityVerdict {
  readonly id: AffordanceSubjectId;
  readonly result: AdultEligibilityResult;
  readonly entity?: AdultEligibilityParticipantEntity;
}

/**
 * The contact core's read, plus the preserved per-participant verdicts. The
 * core consumes only the base shape (it stays domain-neutral); the verdicts
 * exist so a blocked action knows WHICH participant failed and whether the fix
 * lives in the persona editor, the character editor, or a duplicate-to-edit of
 * a foreign character.
 */
export interface ContactParticipantEligibilityWithVerdicts extends ContactParticipantEligibilityRead {
  readonly verdicts: readonly AdultEligibilityVerdict[];
}

/**
 * Tag a stored profile with the subject id the contact read is keyed by.
 *
 * A `CharacterProfile` and a `PersonaProfile` are both structurally
 * `AdultEligibilityInput` already (same field names), so this only adds the id —
 * there is no mapping step that could be written wrong and silently produce
 * `unresolved`. Neither profile type is imported here: the dependency runs profiles →
 * eligibility, never back. The optional `entity` descriptor rides along for
 * blocked-action routing.
 */
export function adultEligibilityParticipant(
  id: AffordanceSubjectId,
  profile: AdultEligibilityInput,
  entity?: AdultEligibilityParticipantEntity,
): AdultEligibilityParticipant {
  return {
    id,
    adultEligibilityDeclaration: profile.adultEligibilityDeclaration,
    ...(profile.age === undefined ? {} : { age: profile.age }),
    ...(entity === undefined ? {} : { entity }),
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
 *
 * The per-participant verdicts are PRESERVED on the read (eligibility
 * follow-ups): the combined status says the action is blocked, the verdicts say
 * by whom — which is what lets a blocker link the persona editor for a failing
 * persona and the character editor (or duplicate-to-edit) for a failing
 * character instead of a dead-end message.
 */
export function contactParticipantEligibility(
  participants: readonly AdultEligibilityParticipant[],
  sink?: DiagnosticSink,
  path?: string,
): ContactParticipantEligibilityWithVerdicts {
  const evidence: AffordanceEvidence[] = [];
  const verdicts: AdultEligibilityVerdict[] = participants.map((participant) => {
    const result = resolveAdultEligibility(participant, sink, path);
    evidence.push(affordanceEvidence("adapter", `adult_eligibility:${participant.id}`, result));
    return { id: participant.id, result, ...(participant.entity === undefined ? {} : { entity: participant.entity }) };
  });

  const status = verdicts.some((v) => v.result === "ineligible")
    ? "ineligible"
    : verdicts.length > 0 && verdicts.every((v) => v.result === "eligible")
      ? "eligible"
      : "unresolved";

  if (verdicts.length === 0) evidence.push(affordanceEvidence("adapter", "adult_eligibility", "no_participants"));

  return { status, participantIds: participants.map((p) => p.id), evidence, verdicts };
}
