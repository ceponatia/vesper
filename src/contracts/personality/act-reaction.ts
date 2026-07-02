import { isTouchConcept, resolveTouchWelcomeness, touchMoodDeltas } from "../mood/events";
import { stageForValue } from "../relationships/stages";
import { interactionConceptById } from "./interactions";
import { socialTraitScale } from "./modulation";
import {
  evaluateSocialReaction,
  moodMeterToFactor,
  moodNudge,
  resolveSocialReaction,
  type DispositionSources,
  type EvaluatedReaction,
  type SocialAct,
} from "./reactions";
import type { TraitValue } from "./traits/value";

/**
 * The ONE §6 reaction sequence, shared by both lanes (character-chat-standalone.spec.md
 * §3 — the chat lane had forked it and drifted): resolve a classified social act against
 * the reactor's disposition; a match runs the affinity-/mood-/trait-aware curve into a
 * signed, clamped affinity delta + a mood nudge; an unmatched **touch** concept falls
 * back to affinity-stage welcome-ness (mood.spec §5 — the same hand on the arm reads as
 * tenderness from a partner and a violation from a stranger); anything else is no
 * reaction. Pure. The caller supplies its own per-turn clamp (an engine constant) and
 * applies the deltas to its own state shape (feeling edge vs chat affinity scalar).
 */

export type ActReactionOutcome =
  | {
      kind: "reaction";
      conceptId: string;
      evaluated: EvaluatedReaction;
      /** Signed, rounded, clamped to ±deltaClamp — ready to apply to the feeling edge / chat affinity. */
      affinityDelta: number;
      /** Signed mood-meter delta (0–1 scale), capped by the nudge curve. */
      moodDelta: number;
    }
  | {
      kind: "touch";
      /** Welcome-ness fallback deltas (0–1 meter scale), trait-damped. */
      moodDelta: number;
      stressDelta: number;
    }
  | { kind: "none" };

export function evaluateActReaction(input: {
  act: SocialAct;
  disposition: DispositionSources;
  /** The reactor's current feeling toward the actor (−100…100). */
  affinity: number;
  /** The reactor's current 0–1 mood meter (caller defaults a missing meter to neutral). */
  moodMeter: number;
  traits: readonly TraitValue[];
  /** Per-turn affinity clamp (an engine constant — this module stays tuning-free). */
  deltaClamp: number;
}): ActReactionOutcome {
  const reaction = resolveSocialReaction(input.act, input.disposition);

  if (!reaction) {
    if (!isTouchConcept(input.act.concept)) return { kind: "none" };
    const stageId = stageForValue(input.affinity).id;
    const welcomeness = resolveTouchWelcomeness({ affinityStage: stageId });
    const intimate = interactionConceptById(input.act.concept)?.intimate ?? false;
    const d = touchMoodDeltas(welcomeness, { intimate, traits: input.traits });
    return { kind: "touch", moodDelta: d.mood, stressDelta: d.stress };
  }

  const evaluated = evaluateSocialReaction(
    reaction,
    input.affinity,
    moodMeterToFactor(input.moodMeter),
    socialTraitScale(reaction, input.traits),
  );
  const signed = evaluated.valence === "dislike" ? -evaluated.magnitude : evaluated.magnitude;
  const affinityDelta = Math.max(-input.deltaClamp, Math.min(input.deltaClamp, Math.round(signed)));
  return { kind: "reaction", conceptId: reaction.conceptId, evaluated, affinityDelta, moodDelta: moodNudge(evaluated) };
}
