import type { SocialReaction } from "./reactions";
import { resolveTraits, type TraitValue } from "./traits/value";

/**
 * Trait modulation (docs/developer-notes/personality-and-state.spec.md §5): pure
 * functions mapping a character's trait values → the coefficients the merge applies.
 * This is §5's "f(traits)" — kept deterministic in the merge, never decided by an
 * agent (resilience.md §3). v1 wires the **social-reaction `traitScale`** (the seam
 * Slice 1 stubbed at 1); meter baseline/recovery and affinity gain/decay coefficients
 * join here in Slices 4–5.
 *
 * Constants are tunable placeholders (like the response-curve constants in
 * `reactions.ts`); they live here because `src/contracts` is IO-free and may not
 * import server constants. The merge still clamps the final delta.
 */

/** At full agreeableness (+100) a dislike stings ~40% less; at full contrariness (−100), ~40% more. */
export const AGREEABLENESS_DISLIKE_DAMP = 0.4;
/** Composure damps the sting of a slight the same way, a touch gentler. */
export const COMPOSURE_DISLIKE_DAMP = 0.3;
/** At full possessiveness (+100) a jealousy trigger stings ~80% harder. */
export const POSSESSIVENESS_JEALOUSY_AMP = 0.8;
/** Hard bounds on the social scale so no trait combo runs away (the ±clamp is the final guard). */
export const TRAIT_SCALE_MIN = 0.4;
export const TRAIT_SCALE_MAX = 1.8;

/**
 * The per-character scale the social-reaction curve multiplies onto a reaction's
 * magnitude (`evaluateSocialReaction`'s `traitScale`). v1 scales **dislikes**
 * (agreeableness + composure soften them; their negative poles sharpen them) and
 * **jealousy triggers** (possessiveness amplifies). Likes are unscaled in v1.
 * Returns 1 for a character with no relevant traits ⇒ exactly Slice 1's behavior.
 */
export function socialTraitScale(reaction: SocialReaction, traits: readonly TraitValue[]): number {
  if (traits.length === 0) return 1;
  const resolved = resolveTraits(traits, []);
  const value = (id: string) => resolved.find((t) => t.id === id)?.value ?? 0;

  let scale = 1;
  if (reaction.valence === "dislike") {
    scale *= 1 - AGREEABLENESS_DISLIKE_DAMP * (value("social.agreeableness") / 100);
    scale *= 1 - COMPOSURE_DISLIKE_DAMP * (value("temperament.composure") / 100);
  }
  if (reaction.conceptId === "jealousy_trigger") {
    const possessiveness = value("intimate.possessiveness");
    if (possessiveness > 0) scale *= 1 + POSSESSIVENESS_JEALOUSY_AMP * (possessiveness / 100);
  }
  return Math.min(TRAIT_SCALE_MAX, Math.max(TRAIT_SCALE_MIN, scale));
}
