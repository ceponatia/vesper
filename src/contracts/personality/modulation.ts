import type { MeterDefinition } from "../meters/registry";
import type { SocialReaction } from "./reactions";
import { effectiveTraitValue, resolveTraits, type TraitValue } from "./traits/value";

/**
 * Trait modulation (docs/developer-notes/personality-and-state.spec.md §5): pure
 * functions mapping a character's trait values → the coefficients the merge applies.
 * This is §5's "f(traits)" — kept deterministic in the merge, never decided by an
 * agent (resilience.md §3). Wires the **social-reaction `traitScale`** (the seam Slice 1
 * stubbed at 1, Slice 3), the **meter baseline/recovery** coefficients (Slice 4), and the
 * **affinity gain asymmetry + decay retention** coefficients (Slice 5).
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

// ---------------------------------------------------------------------------
// Meter dynamics — trait-derived baselines + recovery (spec §4).
// ---------------------------------------------------------------------------

/** Optimism ±100 shifts the mood resting point ±this around 0.5 (so +100 ⇒ ~0.75). */
export const MOOD_BASELINE_SPAN = 0.25;
/** Libido +100 lifts the arousal resting point up to +this (low/negative libido rests at 0). */
export const AROUSAL_BASELINE_SPAN = 0.2;
/** Libido +100 slows arousal recovery to ×(1 − this); −100 speeds it to ×(1 + this). */
export const AROUSAL_RECOVERY_FACTOR = 0.5;
/** Composure +100 speeds stress recovery to ×(1 + this); −100 slows it to ×(1 − this). */
export const STRESS_RECOVERY_FACTOR = 0.5;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Resolve a character's traits into per-character meter dynamics (spec §4): the
 * global `MeterDefinition` is the no-trait default; traits shift the resting
 * baseline (mood←optimism, arousal←libido) and recovery rate (arousal←libido,
 * stress←composure). Empty traits ⇒ the defs unchanged ⇒ exactly today's drift.
 */
export function personalizeMeters(defs: readonly MeterDefinition[], traits: readonly TraitValue[]): MeterDefinition[] {
  if (traits.length === 0) return [...defs];
  const optimism = effectiveTraitValue(traits, "temperament.optimism");
  const libido = effectiveTraitValue(traits, "intimate.libido");
  const composure = effectiveTraitValue(traits, "temperament.composure");
  const recoveryOf = (def: MeterDefinition) => def.recoveryPerHour ?? Math.abs(def.perHour);
  return defs.map((def) => {
    switch (def.id) {
      case "mood":
        return { ...def, baseline: clamp01((def.baseline ?? 0.5) + MOOD_BASELINE_SPAN * (optimism / 100)) };
      case "arousal":
        return {
          ...def,
          baseline: clamp01(Math.max(0, AROUSAL_BASELINE_SPAN * (libido / 100))),
          recoveryPerHour: Math.max(0, recoveryOf(def) * (1 - AROUSAL_RECOVERY_FACTOR * (libido / 100))),
        };
      case "stress":
        return { ...def, recoveryPerHour: Math.max(0, recoveryOf(def) * (1 + STRESS_RECOVERY_FACTOR * (composure / 100))) };
      default:
        return def;
    }
  });
}

// ---------------------------------------------------------------------------
// Affinity dynamics — trait-scaled gain asymmetry + decay retention (spec §4/§5).
// These ride the *simulant's* raw, event-grounded affinity deltas (the unrecognized
// edges; recognized social acts are scaled by `socialTraitScale` in the curve instead)
// and the time-driven decay. Empty traits ⇒ unit factors ⇒ exactly today's behavior.
// ---------------------------------------------------------------------------

/** At full warmth (+100) a positive affinity move lands ~30% harder; at full coldness, ~30% softer. */
export const WARMTH_GAIN_AMP = 0.3;
/** At full agreeableness (+100) a positive move lands ~20% harder; contrariness softens it. */
export const AGREEABLENESS_GAIN_AMP = 0.2;
/** At full guardedness (+100) a positive move is damped ~40%; openness (−100) amplifies it. */
export const GUARDEDNESS_GAIN_DAMP = 0.4;
/** At full composure (+100) a loss stings ~30% less; volatility (−100) sharpens it ~30%. */
export const COMPOSURE_LOSS_DAMP = 0.3;
/** Hard bounds on the gain scale so no trait combo runs away (the ±clamp is the final guard). */
export const AFFINITY_GAIN_SCALE_MIN = 0.4;
export const AFFINITY_GAIN_SCALE_MAX = 1.8;

/**
 * Scale a simulant affinity delta by how this particular character metabolises events
 * (spec §4 gain/loss asymmetry). **Gains** (delta > 0): `warmth`/`agreeableness` amplify,
 * `guardedness` damps — a guarded character warms slowly, a warm one quickly. **Losses**
 * (delta < 0): `composure` damps the sting, volatility sharpens it. Returns the *scaled*
 * delta (pre-clamp; the merge still clamps to ±AFFINITY_DELTA_CLAMP). No relevant traits ⇒
 * the delta unchanged ⇒ exactly today's behavior.
 */
export function scaleAffinityGain(rawDelta: number, traits: readonly TraitValue[]): number {
  if (rawDelta === 0 || traits.length === 0) return rawDelta;
  const resolved = resolveTraits(traits, []);
  const value = (id: string) => resolved.find((t) => t.id === id)?.value ?? 0;

  let scale = 1;
  if (rawDelta > 0) {
    scale += WARMTH_GAIN_AMP * (value("temperament.warmth") / 100);
    scale += AGREEABLENESS_GAIN_AMP * (value("social.agreeableness") / 100);
    scale -= GUARDEDNESS_GAIN_DAMP * (value("social.guardedness") / 100);
  } else {
    scale -= COMPOSURE_LOSS_DAMP * (value("temperament.composure") / 100);
  }
  const clamped = Math.min(AFFINITY_GAIN_SCALE_MAX, Math.max(AFFINITY_GAIN_SCALE_MIN, scale));
  return rawDelta * clamped;
}

/** A warm, even-keeled (loyal) character retains regard; +100 on both lifts the decay floor up to this fraction of the gap to the stage boundary. */
export const WARMTH_DECAY_RETENTION = 0.4;
export const COMPOSURE_DECAY_RETENTION = 0.4;
/** Cap on retention so even the most constant character still drifts, just slowly. */
export const AFFINITY_DECAY_RETENTION_MAX = 0.7;

/**
 * How strongly a character resists affinity decay (spec §4 "a loyal character decays
 * slower / toward a higher floor than a fickle one"). `warmth` + `composure` raise it;
 * `≥ 0` only (fickle/cold/volatile characters decay at the baseline rate to the stage
 * boundary — they are never *faster* than baseline, which keeps decay stage-preserving).
 * The merge reads this as the fraction of the gap between the value and its stage's
 * zero-side boundary that the decay floor sits above the boundary, so a constant
 * character's regard ebbs far more slowly. Empty/low traits ⇒ 0 ⇒ today's behavior.
 */
export function affinityDecayRetention(traits: readonly TraitValue[]): number {
  if (traits.length === 0) return 0;
  const warmth = effectiveTraitValue(traits, "temperament.warmth");
  const composure = effectiveTraitValue(traits, "temperament.composure");
  const raw = WARMTH_DECAY_RETENTION * (warmth / 100) + COMPOSURE_DECAY_RETENTION * (composure / 100);
  return Math.min(AFFINITY_DECAY_RETENTION_MAX, Math.max(0, raw));
}
