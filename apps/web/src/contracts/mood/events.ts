import type { PreferenceValence } from "../personality/preference";
import { effectiveTraitValue, type TraitValue } from "../personality/traits/value";
import type { RelationshipStage } from "../relationships/stages";
import { stageAtLeast, stageAtMost } from "./affinity";
import type { AtmosphereLabel } from "./atmosphere";

/**
 * The event→mood table: generalizes the lone social-reaction nudge into typed event
 * kinds scaled by the coupling matrix (affinity / traits). Pure, like the reaction
 * curve — constants are *starting values* tuned in playtest; every path is clamped.
 *
 * Two application modes (the impulse-vs-standing distinction):
 * - **Impulse** events (a discrete act this turn) apply a one-time signed delta:
 *   `social_reaction` (exists, via `moodNudge`) and `touch` (here).
 * - **Standing** influences (a state that persists) shift the mood **baseline** so
 *   drift pulls toward an influenced target without compounding every turn:
 *   `scene_atmosphere` (here) — the consuming lane adds the shift onto its drift target.
 */
export type MoodEvent =
  | { kind: "social_reaction"; magnitude: number; valence: PreferenceValence } // impulse — exists (moodNudge)
  | { kind: "touch"; concept: string; intimate: boolean; welcomeness: Welcomeness } // impulse
  | { kind: "condition"; conditionId: string } // deferred
  | { kind: "scene_atmosphere"; atmosphere: AtmosphereLabel } // standing
  | { kind: "story_beat"; signal: "develop" | "resolve" | "betray" } // deferred
  | { kind: "presence"; companyStage: RelationshipStage["id"] } // deferred
  | { kind: "physical"; meter: "energy" | "hygiene"; value: number }; // deferred

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// Welcome / unwelcome touch (impulse) — mood.spec §5.
// ---------------------------------------------------------------------------

export type Welcomeness = "welcome" | "neutral" | "unwelcome";

/** Concept ids that count as physical contact (welcome-ness gated). Extensible. */
export const TOUCH_CONCEPTS: ReadonlySet<string> = new Set(["physical_affection"]);

export function isTouchConcept(conceptId: string): boolean {
  return TOUCH_CONCEPTS.has(conceptId);
}

/** A touch is welcome at/above this stage by default. */
export const TOUCH_WELCOME_STAGE = "warm";
/** A touch is unwelcome at/below this stage by default. */
export const TOUCH_UNWELCOME_STAGE = "cool";

/**
 * Resolve how a touch lands (mood.spec §5): an explicit like/dislike **preference on
 * the touch concept overrides**; otherwise the affinity stage decides — welcome at ≥
 * `warm`, unwelcome at ≤ `cool`, ambiguous between. The same hand on the arm reads as
 * tenderness from a partner and a violation from a stranger.
 */
export function resolveTouchWelcomeness(args: {
  affinityStage: RelationshipStage["id"];
  preference?: PreferenceValence;
}): Welcomeness {
  if (args.preference === "like") return "welcome";
  if (args.preference === "dislike") return "unwelcome";
  if (stageAtLeast(args.affinityStage, TOUCH_WELCOME_STAGE)) return "welcome";
  if (stageAtMost(args.affinityStage, TOUCH_UNWELCOME_STAGE)) return "unwelcome";
  return "neutral";
}

export interface TouchMoodDeltas {
  /** Signed mood-meter delta, 0..1 scale. */
  mood: number;
  /** Signed stress-meter delta, 0..1 scale. */
  stress: number;
}

/** Welcome lifts mood + eases stress; unwelcome drops mood + spikes stress; neutral is faint. */
export const TOUCH_WELCOME_MOOD = 0.05;
export const TOUCH_WELCOME_STRESS = -0.02;
export const TOUCH_NEUTRAL_MOOD = 0.01;
export const TOUCH_UNWELCOME_MOOD = -0.08;
export const TOUCH_UNWELCOME_STRESS = 0.06;
/** An `intimate` touch amplifies whichever way it lands (tenderer, or worse). */
export const TOUCH_INTIMATE_AMPLIFY = 1.4;
/** Composure steadies the upset; agreeableness softens the unwelcome drop. */
export const COMPOSURE_TOUCH_DAMP = 0.3;
export const AGREEABLENESS_TOUCH_DAMP = 0.3;
export const TOUCH_DAMP_MIN = 0.5;
export const TOUCH_DAMP_MAX = 1.5;

/**
 * Mood + stress deltas for a resolved touch, trait-damped. `composure`/`agreeableness`
 * (their positive poles) steady an unwelcome touch; their negative poles sharpen it.
 * A welcome touch lands its warmth largely undamped. Every output is bounded.
 */
export function touchMoodDeltas(
  welcomeness: Welcomeness,
  ctx: { intimate: boolean; traits: readonly TraitValue[] },
): TouchMoodDeltas {
  const amp = ctx.intimate ? TOUCH_INTIMATE_AMPLIFY : 1;
  if (welcomeness === "welcome") {
    return { mood: TOUCH_WELCOME_MOOD * amp, stress: TOUCH_WELCOME_STRESS * amp };
  }
  if (welcomeness === "neutral") {
    return { mood: TOUCH_NEUTRAL_MOOD, stress: 0 };
  }
  const composure = effectiveTraitValue(ctx.traits, "temperament.composure");
  const agreeableness = effectiveTraitValue(ctx.traits, "social.agreeableness");
  const damp = clamp(
    1 - COMPOSURE_TOUCH_DAMP * (composure / 100) - AGREEABLENESS_TOUCH_DAMP * (agreeableness / 100),
    TOUCH_DAMP_MIN,
    TOUCH_DAMP_MAX,
  );
  return { mood: TOUCH_UNWELCOME_MOOD * amp * damp, stress: TOUCH_UNWELCOME_STRESS * amp * damp };
}

// ---------------------------------------------------------------------------
// Standing influences — shift the mood baseline, NOT a per-turn delta (no compounding).
// Pure + tested here; a consuming lane wires them by adding the shift onto its drift target.
// ---------------------------------------------------------------------------

/** Scene-tone → resting-mood shift (before trait damping). */
export const ATMOSPHERE_MOOD_BASELINE_SHIFTS: Readonly<Record<AtmosphereLabel, number>> = {
  calm: 0,
  warm: 0.06,
  romantic: 0.08,
  hopeful: 0.06,
  tense: -0.08,
  ominous: -0.1,
  melancholy: -0.06,
};
/** A composed character's mood moves less with the room; +100 composure damps ~50%. */
export const COMPOSURE_ATMOSPHERE_DAMP = 0.5;

/**
 * Resting-mood shift from scene atmosphere, trait-damped by composure (mood.spec §5):
 * atmosphere *nudges* mood, it is not the character's emotion — a composed companion
 * holds calm in a tense room.
 */
export function atmosphereMoodBaselineShift(atmosphere: AtmosphereLabel, traits: readonly TraitValue[]): number {
  const base = ATMOSPHERE_MOOD_BASELINE_SHIFTS[atmosphere] ?? 0;
  const composure = effectiveTraitValue(traits, "temperament.composure");
  const damp = clamp(1 - COMPOSURE_ATMOSPHERE_DAMP * (composure / 100), 0, 1.5);
  return base * damp;
}
