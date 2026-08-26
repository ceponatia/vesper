import { interactionConceptById } from "./interactions";
import type { Preference } from "./preference";
import { matchPreference } from "./reactions";
import { dispositionTagById } from "./tags";
import { traitRegistry } from "./traits";
import { effectiveTraitValue, type TraitValue } from "./traits/value";

/**
 * The disposition guardrail — refusing out-of-character player puppeting. When the
 * player's prose authors a *present NPC's* dialogue / affection / action, intake
 * classifies it into the shared concept vocabulary; this pure rule compares that
 * act's affective direction to the NPC's authored disposition and decides whether
 * it **contradicts** who she is (refuse + deflect) or is **consistent** (honour).
 *
 * Pure: no IO, no engine imports. Reads `tags` + `preferences` + the `warmth`
 * **trait** scalar (Slice 3); affinity + mood join once they exist. The guardrail
 * fires on *contradiction only* — consistent, in-disposition narration passes (a v1
 * leniency; the broader puppet-handling system is deferred — see
 * docs/developer-notes/npc-puppeting.deferred.md).
 */

/** A player-puppeted NPC behaviour from intake: a present NPC + the concept it amounts to. */
export interface NarratedNpcBehavior {
  /** Display name of the NPC whose behaviour the player authored. */
  npc: string;
  /** Interaction concept the puppeted behaviour classifies to; absent ⇒ unjudgeable (plain dialogue). */
  concept?: string;
}

export interface PuppetDisposition {
  tags: readonly string[];
  preferences: readonly Preference[];
  /** Atomic traits (Slice 3); the warmth scalar enriches the affective-direction check. */
  traits?: readonly TraitValue[];
}

export interface PuppetVerdict {
  /** True ⇒ the behaviour clashes with disposition; the narrator must refuse + deflect. */
  contradiction: boolean;
  /** Short machine reason — diagnostics + directive flavour ("" when honoured). */
  reason: string;
}

const HONOUR: PuppetVerdict = { contradiction: false, reason: "" };

/**
 * Decide whether a puppeted NPC behaviour contradicts disposition. Precedence
 * mirrors resolveSocialReaction (most specific wins): a bespoke preference on the
 * concept/family decides outright (a dislike ⇒ she wouldn't lavish it; an
 * authored like ⇒ explicit consent to puppet it), else the tag affective signal
 * (a won't-initiate family, or warm-act-onto-cold / hostile-act-onto-warm), else
 * the warmth **trait** band (same warm/cold logic on the scalar), else honour. An
 * unclassifiable behaviour (no concept — plain dialogue) is always honoured.
 */
export function checkPuppetContradiction(behavior: NarratedNpcBehavior, disposition: PuppetDisposition): PuppetVerdict {
  const conceptId = behavior.concept;
  if (!conceptId) return HONOUR;
  const concept = interactionConceptById(conceptId);
  if (!concept) return HONOUR;
  const { family, polarity } = concept;

  // 1. Bespoke preference (most specific) decides outright.
  const pref = matchPreference(conceptId, disposition.preferences);
  if (pref) return pref.valence === "dislike" ? { contradiction: true, reason: `dislikes ${conceptId}` } : HONOUR;

  // 2. Tag affective signal.
  for (const tagId of disposition.tags) {
    const tag = dispositionTagById(tagId);
    if (!tag) continue; // free-form tags carry no machine affect in v1
    if (family && tag.wontInitiate.includes(family)) {
      return { contradiction: true, reason: `${tagId} would not initiate ${family}` };
    }
    if (polarity === "warm" && tag.warmth === "cold") {
      return { contradiction: true, reason: `${tagId} is cold; the act is warm` };
    }
    if (polarity === "hostile" && tag.warmth === "warm") {
      return { contradiction: true, reason: `${tagId} is warm; the act is hostile` };
    }
  }

  // 3. Trait affective signal (Slice 3): the warmth scalar's band, read like a tag's
  //    warmth lean. A cold character won't spontaneously warm-puppet; a warm one won't
  //    spontaneously turn hostile. Absent/neutral warmth ⇒ no signal ⇒ honour.
  const warmthBand = traitRegistry.bandFor("temperament.warmth", effectiveTraitValue(disposition.traits ?? [], "temperament.warmth"))?.label;
  if (polarity === "warm" && warmthBand === "cold") {
    return { contradiction: true, reason: "cold disposition; the act is warm" };
  }
  if (polarity === "hostile" && warmthBand === "warm") {
    return { contradiction: true, reason: "warm disposition; the act is hostile" };
  }

  return HONOUR;
}
