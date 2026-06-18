import { interactionConceptById } from "./interactions";
import type { Preference, PreferenceValence } from "./preference";

/**
 * Social-reaction resolution + the affinity-/mood-aware response curve
 * (docs/developer-notes/personality-and-state.spec.md §6). Pure: no IO, no engine
 * imports. The tuning constants live here, not in engine/constants.ts, because
 * `src/contracts` is IO-free and may not import server modules; the merge applies
 * its own per-turn ±AFFINITY_DELTA_CLAMP on top of whatever this returns.
 */

/** A classified social act from intake: a concept id aimed at a target character. */
export interface SocialAct {
  concept: string;
  target: string;
}

/** A matched, pre-curve reaction. */
export interface SocialReaction {
  conceptId: string;
  valence: PreferenceValence;
  /** Base magnitude, 1–10. */
  intensity: number;
  /** Preference hint ?? the concept's default flavour. */
  hint: string;
  /** Which disposition layer matched. (Only "preference" in v1.) */
  source: "preference" | "card";
}

/**
 * Placeholder for the deferred social-reaction card layer
 * (social-reaction-cards.plan.md). The card plan fills in the shape; v1 callers
 * pass `cards: []`.
 */
export interface SocialReactionCard {
  readonly id: string;
}

export interface DispositionSources {
  /** Canonical/free-form tags — cards key overrides on these (unused in v1). */
  tags: readonly string[];
  preferences: readonly Preference[];
  /** Deferred — empty in v1. */
  cards: readonly SocialReactionCard[];
}

/**
 * Resolve a classified social act against a character's disposition. Precedence
 * (pure override, most specific wins): bespoke preference → card tag-override →
 * card default → null (narrator plays it straight). v1 only has the bespoke layer
 * (cards: []), so this returns a preference match or null.
 */
export function resolveSocialReaction(act: SocialAct, sources: DispositionSources): SocialReaction | null {
  const pref = matchPreference(act.concept, sources.preferences);
  if (pref) {
    const concept = interactionConceptById(act.concept);
    return {
      conceptId: act.concept,
      valence: pref.valence,
      intensity: pref.intensity,
      hint: pref.hint ?? concept?.defaultHint ?? "",
      source: "preference",
    };
  }
  // Card layer is deferred (social-reaction-cards.plan.md); nothing to resolve in v1.
  return null;
}

/** Direct concept match beats a family match. */
function matchPreference(conceptId: string, preferences: readonly Preference[]): Preference | undefined {
  const direct = preferences.find((p) => p.target === conceptId);
  if (direct) return direct;
  const family = interactionConceptById(conceptId)?.family;
  return family ? preferences.find((p) => p.target === family) : undefined;
}

// ---------------------------------------------------------------------------
// The response curve — affinity- and mood-aware (spec §6).
// Tunable placeholders; tuned in playtest.
// ---------------------------------------------------------------------------

/** κ: goodwill → tolerance. At affinity +100, absorbs 4 intensity points. */
export const DISLIKE_TOLERANCE_K = 0.04;
/** λ: hostility amplifies a slight. At affinity −100, the sting roughly doubles. */
export const HOSTILITY_AMPLIFY = 1.0;
/** Diminishing returns on a like near the top. At affinity +100, ×0.4. */
export const LIKE_DAMPING = 0.6;
/** A small "pleasant surprise" bump when a hostile character is pleased. */
export const LIKE_SURPRISE = 1.5;
/** A single like can't be spammed to flip a hostile relationship. */
export const LIKE_CAP = 4;
/** Mood swings the magnitude by ±this fraction at full bad/good mood. */
export const MOOD_FACTOR_SPAN = 0.3;
/** v1 stub: callers pass this for mood until the mood slice ships. */
export const NEUTRAL_MOOD = 0;

export interface EvaluatedReaction {
  valence: PreferenceValence;
  /** Unsigned, post-curve, pre per-turn clamp (the merge clamps to ±AFFINITY_DELTA_CLAMP). */
  magnitude: number;
  /** Qualitative label for the narrator ("lets it slide", "stung"). */
  band: string;
  hint: string;
}

/**
 * Realize a resolved reaction's magnitude as a nonlinear function of current state.
 * `currentMood` is a neutral stub in v1 (NEUTRAL_MOOD); `traitScale` is 1 until the
 * trait slice computes it. Returns an **unsigned** magnitude; the merge signs it by
 * valence and clamps it.
 */
export function evaluateSocialReaction(
  reaction: SocialReaction,
  currentAffinity: number,
  currentMood: number = NEUTRAL_MOOD,
  traitScale = 1,
): EvaluatedReaction {
  const a = clamp(currentAffinity, -100, 100);
  const m0 = reaction.intensity;
  let magnitude: number;

  if (reaction.valence === "dislike") {
    const tolerance = DISLIKE_TOLERANCE_K * Math.max(0, a); // goodwill buys grace
    const raw = Math.max(0, m0 - tolerance); // deadband: a slip under tolerance ⇒ 0
    const hostility = 1 + HOSTILITY_AMPLIFY * (Math.max(0, -a) / 100); // thin ice amplifies
    magnitude = raw * hostility * moodFactor(currentMood, "dislike") * traitScale;
  } else {
    const damped = m0 * (1 - LIKE_DAMPING * (Math.max(0, a) / 100)); // diminishing returns
    const surprise = LIKE_SURPRISE * (Math.max(0, -a) / 100); // pleasant surprise when low
    const gain = (damped + surprise) * moodFactor(currentMood, "like") * traitScale;
    magnitude = Math.min(LIKE_CAP, gain); // capped: no flattery-spamming friendship
  }

  magnitude = Math.max(0, magnitude);
  return { valence: reaction.valence, magnitude, band: bandFor(reaction.valence, magnitude), hint: reaction.hint };
}

/** Bad mood sharpens dislikes and damps likes; good mood the reverse. Neutral ⇒ 1. */
function moodFactor(mood: number, valence: PreferenceValence): number {
  const m = clamp(mood, -1, 1);
  const sign = valence === "like" ? 1 : -1;
  return 1 + MOOD_FACTOR_SPAN * sign * m;
}

/** Qualitative reaction band for the narrator, from valence × magnitude. */
function bandFor(valence: PreferenceValence, magnitude: number): string {
  if (magnitude < 0.5) return valence === "dislike" ? "lets it slide" : "barely registers it";
  if (magnitude < 2) return valence === "dislike" ? "is mildly put off" : "is mildly pleased";
  if (magnitude < 4) return valence === "dislike" ? "is clearly displeased" : "is pleased";
  return valence === "dislike" ? "is stung" : "is delighted";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
