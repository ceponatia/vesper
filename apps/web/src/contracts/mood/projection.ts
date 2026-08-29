import { conditionKey, type ActiveCondition } from "../conditions/condition";
import type { EvaluatedReaction } from "../personality/reactions";
import type { RelationshipStage } from "../relationships/stages";
import { stageAtLeast } from "./affinity";
import type { EmotionLabel } from "./emotion-label";

/**
 * `deriveEmotionLabel` — the pure labeled-emotion projection. A *read* over
 * already-computed state: no IO, no new stored state, and **total** (always returns
 * a label). The narrator keeps using the prose `deriveMoodDescriptor`; this is the
 * discrete-label sibling the avatar cue and a UI mood chip consume.
 *
 * Two timescales, one read: a **transient beat** (the latest social reaction)
 * wins briefly, else the **baseline** from the meter vector + affinity. All numbers
 * are *starting values* tuned in playtest — they live as named constants here,
 * mirroring `reactions.ts` / `modulation.ts` (logic is code; only the knobs are data).
 */

export interface EmotionInputs {
  /** Valence meter, 0..1 (0 low, 0.5 even, 1 bright). */
  mood: number;
  /** Arousal meter, 0..1. */
  arousal: number;
  /** Stress meter, 0..1. */
  stress: number;
  /** Energy meter, 0..1 (1 rested, 0 exhausted). */
  energy: number;
  /** Warmth toward the player — a stage id (`hostile`…`smitten`). */
  affinityStage: RelationshipStage["id"];
  /** Latest social-reaction result (the beat); absent ⇒ baseline only. */
  reaction?: EvaluatedReaction;
  /** Concept id behind `reaction` (e.g. `flirt`, `boundary_push`) — refines the beat. */
  reactionConcept?: string;
  /** Active conditions (tipsy / flustered / hurt …) — tint the baseline. */
  conditions: readonly ActiveCondition[];
  /** Scene is in an intimate frame — the gate for `aroused` (NOT wardrobe undress). */
  intimateContext: boolean;
  /** `social.dominance` trait, −100..100 — tilts a low-valence read angry vs sad. */
  dominance?: number;
}

export interface EmotionResult {
  emotion: EmotionLabel;
  /** Normalized distance from neutral, 0..1 — expression weight (slight smile → beam). */
  intensity: number;
}

// --- Tuning constants (starting values — tune in playtest) ---------------------

/** Activation axis: a weighted blend of drive / tension / charge. Sum ≈ 1. */
export const ACTIVATION_ENERGY_WEIGHT = 0.4;
export const ACTIVATION_STRESS_WEIGHT = 0.35;
export const ACTIVATION_AROUSAL_WEIGHT = 0.25;

/** Valence band cuts. */
export const VALENCE_HIGH = 0.65;
export const VALENCE_LOW = 0.4;

/** Activation band cuts. */
export const ACTIVATION_HIGH = 0.6;
export const ACTIVATION_LOW = 0.35;

/** Stress band cuts (low → calm baseline; high → on-edge). */
export const STRESS_LOW = 0.35;
export const STRESS_HIGH = 0.6;
/** A low-valence read needs this much arousal *and* high stress to read `afraid`. */
export const AROUSAL_HIGH = 0.55;

/** Gated override: `aroused` needs an intimate frame **and** this much arousal. */
export const AROUSED_AROUSAL_MIN = 0.6;

/** Affectionate baseline needs warmth at/above this stage. */
export const AFFECTIONATE_STAGE = "close";
/** A flirt beat reads `flustered` only below this stage (above it she's at ease). */
export const FLUSTERED_STAGE_CEILING = "warm";

/** A reaction with magnitude below this doesn't fire a beat. */
export const REACTION_BEAT_MIN_MAGNITUDE = 0.3;
/** Magnitude that maps a beat to full intensity (the curve caps likes at ~4). */
export const REACTION_BEAT_FULL_MAGNITUDE = 4;

/** `dominance` at/above this tilts a low-valence / disliked read toward `angry`. */
export const DOMINANCE_ANGER_MIN = 20;

/** Concept ids that read as a startle rather than their raw valence. */
const SURPRISE_CONCEPTS: ReadonlySet<string> = new Set(["boundary_push"]);
/** Concept ids that, at low–mid affinity, read `flustered`. */
const FLIRT_CONCEPTS: ReadonlySet<string> = new Set(["flirt", "compliment", "proposition"]);
/** Condition labels (normalized — see `conditionKey`) that directly tint the baseline. */
// "flushed" is the fluster action chip's own mint (engine/chat-state.ts applyChatAction) —
// the chip-label ↔ key agreement is pinned by that chip's test.
const FLUSTERED_CONDITION_LABELS: ReadonlySet<string> = new Set(["flustered", "bashful", "flushed"]);
const TIPSY_CONDITION_LABELS: ReadonlySet<string> = new Set(["tipsy", "drunk", "intoxicated"]);

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/** Derived activation scalar: how *charged* the state is, 0..1. */
export function activationOf(i: Pick<EmotionInputs, "energy" | "stress" | "arousal">): number {
  return clamp01(
    ACTIVATION_ENERGY_WEIGHT * clamp01(i.energy) +
      ACTIVATION_STRESS_WEIGHT * clamp01(i.stress) +
      ACTIVATION_AROUSAL_WEIGHT * clamp01(i.arousal),
  );
}

/** Intensity from valence distance to the even keel (0.5), normalized to 0..1. */
function valenceIntensity(mood: number): number {
  return clamp01(Math.abs(clamp01(mood) - 0.5) / 0.5);
}

function hasCondition(conditions: readonly ActiveCondition[], labels: ReadonlySet<string>): boolean {
  return conditions.some((c) => labels.has(conditionKey(c)));
}

/** The transient beat: wins briefly when a strong reaction is present. */
function resolveBeat(i: EmotionInputs): EmotionResult | undefined {
  const r = i.reaction;
  if (!r || r.magnitude < REACTION_BEAT_MIN_MAGNITUDE) return undefined;
  const intensity = clamp01(r.magnitude / REACTION_BEAT_FULL_MAGNITUDE);
  const concept = i.reactionConcept;

  // 1. Surprise / boundary act → startled (overrides raw valence).
  if (concept && SURPRISE_CONCEPTS.has(concept)) return { emotion: "surprised", intensity };

  if (r.valence === "like") {
    // 3. Flirt / compliment at low–mid affinity → bashful.
    if (concept && FLIRT_CONCEPTS.has(concept) && !stageAtLeast(i.affinityStage, FLUSTERED_STAGE_CEILING)) {
      return { emotion: "flustered", intensity };
    }
    // 2. Strong positive → affectionate (if warm) / happy spike.
    return { emotion: stageAtLeast(i.affinityStage, AFFECTIONATE_STAGE) ? "affectionate" : "happy", intensity };
  }

  // 4. Negative → sad (low dominance) / angry (high dominance).
  return { emotion: (i.dominance ?? 0) >= DOMINANCE_ANGER_MIN ? "angry" : "sad", intensity };
}

/** The sustained baseline: valence × activation grid + gated overrides. */
function resolveBaseline(i: EmotionInputs): EmotionResult {
  const mood = clamp01(i.mood);
  const stress = clamp01(i.stress);
  const arousal = clamp01(i.arousal);
  const activation = activationOf(i);

  // Gated override: aroused (intimate frame + high arousal) — beats the valence grid.
  if (i.intimateContext && arousal >= AROUSED_AROUSAL_MIN) {
    return { emotion: "aroused", intensity: clamp01((arousal - AROUSED_AROUSAL_MIN) / (1 - AROUSED_AROUSAL_MIN)) };
  }

  // Condition tints.
  if (hasCondition(i.conditions, FLUSTERED_CONDITION_LABELS)) return { emotion: "flustered", intensity: 0.6 };
  if (hasCondition(i.conditions, TIPSY_CONDITION_LABELS) && mood >= VALENCE_LOW) {
    // Loosened: a tipsy, not-low mood reads playful/affectionate.
    return { emotion: stageAtLeast(i.affinityStage, AFFECTIONATE_STAGE) ? "affectionate" : "playful", intensity: 0.55 };
  }

  const intensity = valenceIntensity(mood);

  // High valence.
  if (mood > VALENCE_HIGH) {
    if (stageAtLeast(i.affinityStage, AFFECTIONATE_STAGE) && stress <= STRESS_LOW) {
      return { emotion: "affectionate", intensity };
    }
    if (activation >= ACTIVATION_HIGH) return { emotion: "playful", intensity };
    return { emotion: "happy", intensity };
  }

  // Low valence.
  if (mood < VALENCE_LOW) {
    if (stress >= STRESS_HIGH && arousal >= AROUSAL_HIGH) return { emotion: "afraid", intensity };
    if ((i.dominance ?? 0) >= DOMINANCE_ANGER_MIN) return { emotion: "angry", intensity };
    if (stress >= STRESS_HIGH) return { emotion: "concerned", intensity };
    return { emotion: "sad", intensity };
  }

  // Mid valence (the even keel).
  if (stress >= STRESS_HIGH) return { emotion: "concerned", intensity: clamp01(stress) };
  return { emotion: "neutral", intensity: clamp01(1 - activation) * 0.5 };
}

/** Resolve the discrete emotion + intensity. Total — always returns a label. */
export function deriveEmotionLabel(i: EmotionInputs): EmotionResult {
  return resolveBeat(i) ?? resolveBaseline(i);
}
