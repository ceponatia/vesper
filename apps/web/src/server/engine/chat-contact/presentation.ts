import {
  buildActionOutcome,
  contactActionOutcomeStatus,
  contactCommitExpectation,
  type CommittedContactOutcome,
  type ContactCommitOutcome,
  type ContactEventRef,
  type ContactPersistenceAcknowledgment,
  type ContactRejectionReason,
  type ContactRequirementCode,
  type ContactResolution,
  type ContactUnresolvedReason,
  type DiagnosticSink,
  type PhysicalActionOutcome,
} from "@/contracts";
import type { ChatContactAct } from "./identity";
import type { ChatContactRosterMember } from "./input-evidence";

/**
 * The acknowledgment a lane builds AFTER its durable write returned.
 *
 * It names this action's own commit, so `contactActionOutcomeStatus` can prove
 * the write it is being told about is the write this attempt made — a stale
 * reply from an earlier turn on the same contact, or the write that ENDED it,
 * both fail the comparison and produce silence.
 *
 * A `contact_continued` fold writes no row by design (the contact is unchanged
 * and already durable from the start event that created it), so acknowledging it
 * is correct rather than generous: what the narrator is told is that this
 * contact is current truth, and it is.
 */
export function chatContactAcknowledgment(input: {
  readonly commit: CommittedContactOutcome;
  readonly eventRef: ContactEventRef;
  readonly actionId: string;
}): ContactPersistenceAcknowledgment {
  return {
    kind: "persisted",
    contactId: input.commit.contact.contactId,
    commitKind: input.commit.commit.kind,
    eventRef: input.eventRef,
    actionId: input.actionId,
  };
}

// ---------------------------------------------------------------------------
// The result vocabulary
// ---------------------------------------------------------------------------

/** What a wordable result code is ABOUT, so the renderer can build one sentence from several. */
export type ChatContactPhraseKind = "gesture" | "locus" | "material" | "blocked" | "requirement";

export interface ChatContactPhrase {
  readonly kind: ChatContactPhraseKind;
  readonly phrase: string;
}

function locusCode(locationId: string): string {
  return `contact.locus.${locationId}`;
}

/**
 * Code → the phrase the prompt uses, or absent for a code this lane does not
 * word.
 *
 * Deliberately the same shape as the hair lexicon the constraint renderer reads:
 * codes are domain-owned and opaque to the guidance layer, the renderer words
 * what it can, and a code with no entry costs a clause rather than a line. The
 * unresolved codes have no entries at all — an unresolved outcome is SILENCE by
 * contract, so there is nothing for them to say.
 */
const CHAT_CONTACT_LEXICON: Readonly<Record<string, ChatContactPhrase>> = {
  // The gesture, as a present-tense verb phrase carrying its own preposition.
  "contact.gesture.rest": { kind: "gesture", phrase: "rests on" },
  "contact.gesture.pat": { kind: "gesture", phrase: "pats" },
  "contact.gesture.squeeze": { kind: "gesture", phrase: "closes lightly around" },
  // The romantic family. Same law as above: a present-tense verb phrase
  // carrying its own preposition, stating the contact and nothing about how it
  // is received — how the character answers a caress is not decided here.
  "contact.gesture.caress": { kind: "gesture", phrase: "caresses" },
  "contact.gesture.stroke": { kind: "gesture", phrase: "strokes" },
  "contact.gesture.cup": { kind: "gesture", phrase: "cups" },
  // The surface, named the way a sentence names it rather than the way the
  // registry ids it (`shoulders` is a pair; a hand lands on one).
  [locusCode("shoulders")]: { kind: "locus", phrase: "shoulder" },
  [locusCode("upper_arms")]: { kind: "locus", phrase: "upper arm" },
  [locusCode("arms")]: { kind: "locus", phrase: "arm" },
  [locusCode("forearms")]: { kind: "locus", phrase: "forearm" },
  [locusCode("hands")]: { kind: "locus", phrase: "hand" },
  [locusCode("back")]: { kind: "locus", phrase: "back" },
  [locusCode("head")]: { kind: "locus", phrase: "head" },
  [locusCode("hair")]: { kind: "locus", phrase: "hair" },
  // Romantic-only: the registry's coarse `face` is what `cheek` maps onto, and
  // "face" is the word that stays honest whichever noun the player wrote —
  // narrating a cheek when they wrote "face" would invent a narrower fact.
  [locusCode("face")]: { kind: "locus", phrase: "face" },
  // Material. `direct` has no phrase on purpose: a hand on a shoulder reads as
  // skin by default, so saying so would spend a clause volunteering a positive
  // detail — which is the one thing this block does not do.
  "contact.material.through": { kind: "material", phrase: "through the cloth over it" },
  // Refusals somebody actually gave.
  "contact.blocked.out_of_reach": { kind: "blocked", phrase: "they are too far apart for it" },
  "contact.blocked.actor_control_denied": { kind: "blocked", phrase: "that is not the player's body to move" },
  // Permission refusals. These had no producer until the romantic action lane
  // existed; they word the REFUSAL and never the record behind it — the prompt
  // is told the touch did not land, not what the ledger says about why.
  // Agentless on purpose: the target may be any character, so a phrase naming
  // "she" would misgender whoever the scene actually holds.
  "contact.blocked.permission_denied": { kind: "blocked", phrase: "that has not been allowed" },
  "contact.blocked.permission_withdrawn": { kind: "blocked", phrase: "that is no longer allowed" },
  "contact.blocked.permission_scope_missing": { kind: "blocked", phrase: "that has not been allowed" },
  // What the scene would have to do first.
  "contact.requires.reposition": { kind: "requirement", phrase: "the distance would have to be closed first" },
  "contact.requires.close_distance": { kind: "requirement", phrase: "the distance would have to be closed first" },
  "contact.requires.change_support": { kind: "requirement", phrase: "the player's weight would have to shift first" },
  "contact.requires.free_limb": { kind: "requirement", phrase: "the player's hand is not free" },
  "contact.requires.remove_material_layer": {
    kind: "requirement",
    phrase: "something in the way would have to come off first",
  },
  "contact.requires.open_closure": { kind: "requirement", phrase: "something fastened would have to be opened first" },
  "contact.requires.target_must_act": { kind: "requirement", phrase: "the touch would have to be met from the other side" },
};

/** The phrase for one result code, or `undefined` for a code this lane cannot word. */
export function chatContactPhrase(code: string): ChatContactPhrase | undefined {
  return CHAT_CONTACT_LEXICON[code];
}

function blockedCode(reason: ContactRejectionReason): string {
  return `contact.blocked.${reason}`;
}

function requirementCode(code: ContactRequirementCode): string {
  return `contact.requires.${code}`;
}

function unresolvedCode(reason: ContactUnresolvedReason | "not_recorded"): string {
  return `contact.unresolved.${reason}`;
}

/**
 * The result codes for one resolved attempt, in a stable order.
 *
 * Order is identity here: `buildActionOutcome` folds the list into the
 * fingerprint every selection tie and every retake comparison rests on, so the
 * locus always leads and the qualifiers follow.
 */
function chatContactResultCodes(input: {
  readonly act: ChatContactAct;
  readonly resolution: ContactResolution;
  readonly committed: boolean;
}): readonly string[] {
  const locus = locusCode(input.act.targetLocationId);
  const resolution = input.resolution;
  switch (resolution.status) {
    case "committable":
      return input.committed
        ? [
            locus,
            `contact.gesture.${input.act.gesture}`,
            resolution.access.transmission.directSkinContact ? "contact.material.direct" : "contact.material.through",
          ]
        : [locus, unresolvedCode("not_recorded")];
    case "rejected":
      return [locus, blockedCode(resolution.reason)];
    case "explicit_transition_required":
      return [locus, ...resolution.requirements.map((requirement) => requirementCode(requirement.code))];
    case "unresolved":
      return [locus, unresolvedCode(resolution.reason)];
  }
}

// ---------------------------------------------------------------------------
// The narrator seam
// ---------------------------------------------------------------------------

export interface ChatContactOutcomeInput {
  readonly act: ChatContactAct;
  readonly resolution: ContactResolution;
  /** The fold, when there was one. */
  readonly commit?: ContactCommitOutcome;
  readonly eventRef: ContactEventRef;
  /** What the store did. Absent ⇒ nothing was written ⇒ the outcome is `unresolved`. */
  readonly acknowledgment?: ContactPersistenceAcknowledgment;
  readonly sink?: DiagnosticSink;
}

/**
 * One resolved attempt as the narrator-guidance seam receives it.
 *
 * `consistency_only` is the disclosure for every contact outcome, and the choice
 * is not incidental. `positive_detail_allowed` is for a fact that has cleared
 * viewpoint, channel, exposure, and policy gates and may be offered as
 * description; a contact outcome is not offered at all — it is a resolved
 * limitation on what the narration may say happened, which is precisely what
 * `consistency_only` licenses. It also keeps the block's register intact: this
 * layer states truths and fences claims, and never invites a detail.
 *
 * The outcome is built for EVERY resolved status, including `unresolved`. The
 * seam renders that one as silence, but the candidate still carries the
 * fingerprint and the codes the inspector and the eval harness read — a gap the
 * developer can see is worth more than one that looks like nothing happened.
 */
export function chatContactActionOutcome(input: ChatContactOutcomeInput): PhysicalActionOutcome {
  const expected =
    input.commit === undefined
      ? undefined
      : contactCommitExpectation({
          outcome: input.commit,
          eventRef: input.eventRef,
          actionId: input.act.actionId,
        });
  const status = contactActionOutcomeStatus({
    resolution: input.resolution.status,
    ...(expected === undefined ? {} : { expected }),
    ...(input.acknowledgment === undefined ? {} : { acknowledgment: input.acknowledgment }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  return buildActionOutcome({
    actionId: input.act.actionId,
    status,
    resultCodes: chatContactResultCodes({
      act: input.act,
      resolution: input.resolution,
      committed: status === "committed",
    }),
    disclosure: "consistency_only",
    evidence: input.resolution.evidence,
  });
}

// ---------------------------------------------------------------------------
// The unresolved premise
// ---------------------------------------------------------------------------

/**
 * Which unresolved reasons earn a presentation line, and what each one is ABOUT.
 *
 * An `unresolved` outcome is silence by contract, and that stays true for both:
 * no ledger row, no scene fold, no acknowledgment, and the outcome's own wording
 * is still empty. What two live trials showed is that silence alone does not
 * stop the PROSE from inventing the landing — the player wrote a touch, the
 * guidance said nothing, and the reply depicted it happening.
 *
 * - `reach` — `geometry_unavailable`, the typed "no pose/reach owner could place
 *   these two surfaces". The gap is whether the hand could get there.
 * - `permission` — `permission_unresolved`, an interpersonal contact whose
 *   permission owner gave no answer. The gap is whether the contact is the
 *   player's to make.
 *
 * Keeping BOTH in one discriminated seam is deliberate: the property that makes
 * this safe is that the list of unresolved reasons earning a line is decided in
 * exactly one place, against the resolution's own typed reason, and every other
 * reason — material, support, control, agency — still renders nothing.
 *
 * Each states only its own gap. Neither claims the target is far away, pulled
 * back, or refused: those are positive facts the scene does not own, and the
 * reasons that DO own them (`out_of_reach`, `permission_denied`,
 * `permission_withdrawn`, the reposition requirements) keep their existing typed
 * handling instead of degrading to this.
 */
export type ChatContactPremiseKind = "reach" | "permission";

export interface ChatContactUnresolvedPremise {
  /** What the scene could not establish. */
  readonly kind: ChatContactPremiseKind;
  /** The resolved target's display name — "Sabrina". */
  readonly targetName: string;
  /** The written surface ("shoulder"), when the lexicon can word the locus. */
  readonly locus?: string;
}

/**
 * The unresolved reasons that earn a line, mapped to what the line is about.
 *
 * A lookup rather than a switch so that adding a reason is a data edit that
 * cannot silently mislabel an existing one, and so an unlisted reason is
 * `undefined` — silence — by construction.
 */
const CHAT_CONTACT_PREMISE_KINDS: Readonly<Partial<Record<ContactUnresolvedReason, ChatContactPremiseKind>>> = {
  geometry_unavailable: "reach",
  permission_unresolved: "permission",
};

/**
 * The premise this turn's resolved attempt earns, or `null`.
 *
 * Typed end to end: the trigger is the resolution's own `unresolved` reason,
 * never a diagnostic string.
 */
export function chatContactUnresolvedPremise(input: {
  readonly act: ChatContactAct | null;
  readonly resolution: ContactResolution | null;
  readonly characters: readonly ChatContactRosterMember[];
}): ChatContactUnresolvedPremise | null {
  const { act, resolution } = input;
  if (act === null || resolution === null) return null;
  if (resolution.status !== "unresolved") return null;
  const kind = CHAT_CONTACT_PREMISE_KINDS[resolution.reason];
  if (kind === undefined) return null;
  const target = input.characters.find((member) => member.subjectId === act.targetSubject);
  if (target === undefined) return null;
  const locus = chatContactPhrase(locusCode(act.targetLocationId));
  return {
    kind,
    targetName: target.name,
    ...(locus === undefined ? {} : { locus: locus.phrase }),
  };
}