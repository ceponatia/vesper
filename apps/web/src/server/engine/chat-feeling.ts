import { z } from "zod";
import { emotionLabelSchema, type ChatSkipAmount, type EmotionLabel, type RelationshipSample } from "@/contracts";
import { regardBandById } from "@/contracts/relationships/bands";

/**
 * Emotional weather: the pure half of persistent
 * feelings + regard momentum. The pulse proposes a feeling LABEL + CAUSE (never a
 * number); intensity derives deterministically from the social-reaction curve's outcome here,
 * decays per exchange (not clock minutes), and colors the prompt's mood line
 * while it lasts. A **bruise** — a strong regard drop landing while regard is
 * high — damps positive gains for ~10 exchanges (owner ruling), lifted early by
 * an accepted `apologize` act. The feeling also feeds back into reaction
 * magnitude, DAMPED (owner ruling 2026-07-11: at most ±10%, hard-capped, so a
 * hurt→worse-reads→more-hurt spiral can't run away).
 */

/** Per-exchange intensity decay — a feeling at full strength persists ~6–7 exchanges. */
export const CHAT_FEELING_DECAY_PER_EXCHANGE = 0.15;
/** Below this intensity the feeling clears (fading past notice). */
export const CHAT_FEELING_FLOOR = 0.2;
/** Exchanges a bruise damps positive regard gains (owner ruling: ~10). */
export const CHAT_BRUISE_EXCHANGES = 10;
/** The feeling-feedback cap on reaction magnitude (owner ruling: damped ±10%). */
export const CHAT_FEELING_BIAS_MAX = 0.1;
/** Warmth-streak multiplier: +10% per consecutive rising sample, capped ×1.5. */
export const CHAT_WARMTH_STREAK_STEP = 0.1;
export const CHAT_WARMTH_STREAK_CAP = 1.5;
/** Cap on the pulse-proposed feeling cause phrase. */
export const CHAT_FEELING_CAUSE_MAX_CHARS = 120;

/**
 * Emotional decay a time skip applies, in exchange-equivalent steps — deliberately
 * SLOWER than the beat-for-beat conversion (a strong feeling shouldn't evaporate
 * over "a few moments"; a night softens; days clear). Bruises tick down the same
 * steps.
 */
export const CHAT_FEELING_SKIP_STEPS: Record<ChatSkipAmount, number> = {
  moments: 1,
  hours: 3,
  overnight: 5,
  days: 99,
};

export const chatFeelingSchema = z.object({
  label: emotionLabelSchema,
  /** 0..1 — derived deterministically from the curve outcome, never model-proposed. */
  intensity: z.number().min(0).max(1).catch(0),
  /** Short phrase naming what caused it ("the broken promise about the gallery"). */
  cause: z.string().catch(""),
});
export type ChatFeeling = z.infer<typeof chatFeelingSchema>;

export const chatFeelingStateSchema = z.object({
  /** The persistent feeling coloring narration/pacing, or null (no standing weather). */
  current: chatFeelingSchema.nullable().catch(null).default(null),
  /** Damped-positive-gains window after a betrayal at high regard; null ⇒ none. */
  bruise: z
    .object({ remaining: z.number().int().min(0).catch(0) })
    .nullable()
    .catch(null)
    .default(null),
});
export type ChatFeelingState = z.infer<typeof chatFeelingStateSchema>;

export function emptyChatFeelingState(): ChatFeelingState {
  return { current: null, bruise: null };
}

/**
 * Feeling valence per EmotionLabel: +1 bright, −1 dark, 0 neutral/ambiguous.
 * Total over the locked 11-label vocabulary (contracts/mood) — the registry test
 * asserts totality so a future label addition can't silently read as 0.
 */
export const FEELING_VALENCE: Record<EmotionLabel, -1 | 0 | 1> = {
  neutral: 0,
  happy: 1,
  affectionate: 1,
  playful: 1,
  flustered: 0,
  concerned: -1,
  sad: -1,
  angry: -1,
  afraid: -1,
  surprised: 0,
  aroused: 1,
};

export function feelingValence(label: EmotionLabel): -1 | 0 | 1 {
  return FEELING_VALENCE[label] ?? 0;
}

/**
 * Deterministic intensity for a pulse feeling proposal: the curve's regard move is
 * the beat's measured charge. A proposal with no mechanical move (a confided grief
 * matches no preference) still lands moderate — the model saw an emotional beat
 * even when the curve had nothing to say about regard.
 */
export function proposalIntensity(regardDelta: number, deltaClamp: number): number {
  const share = deltaClamp > 0 ? Math.abs(regardDelta) / deltaClamp : 0;
  return Math.min(1, 0.35 + share * 0.65);
}

/**
 * Fold a pulse feeling proposal into the state (plan §Design 1): no proposal keeps
 * the current feeling; `neutral` explicitly CLEARS it (the exchange resolved the
 * weather); a same-label proposal refreshes to the higher intensity; a different
 * label replaces only at equal-or-greater intensity (a standing hurt outlasts a
 * weak new flicker). PURE.
 */
export function applyFeelingProposal(
  state: ChatFeelingState,
  proposal: { label: EmotionLabel; cause: string } | null,
  intensity: number,
): ChatFeelingState {
  if (!proposal) return state;
  if (proposal.label === "neutral") {
    return state.current ? { ...state, current: null } : state;
  }
  const cause = proposal.cause.trim().slice(0, CHAT_FEELING_CAUSE_MAX_CHARS);
  const current = state.current;
  if (current && current.label === proposal.label) {
    return { ...state, current: { label: current.label, intensity: Math.max(current.intensity, intensity), cause: cause || current.cause } };
  }
  if (current && intensity < current.intensity) return state;
  return { ...state, current: { label: proposal.label, intensity, cause } };
}

/**
 * One-or-more exchanges of emotional time: the feeling decays
 * CHAT_FEELING_DECAY_PER_EXCHANGE per step (clearing below the floor) and the
 * bruise ticks down one exchange per step (clearing at zero). PURE.
 */
export function decayFeelingState(state: ChatFeelingState, steps = 1): ChatFeelingState {
  if (steps <= 0 || (!state.current && !state.bruise)) return state;
  let current = state.current;
  if (current) {
    const intensity = current.intensity - CHAT_FEELING_DECAY_PER_EXCHANGE * steps;
    current = intensity >= CHAT_FEELING_FLOOR ? { ...current, intensity } : null;
  }
  let bruise = state.bruise;
  if (bruise) {
    const remaining = bruise.remaining - steps;
    bruise = remaining > 0 ? { remaining } : null;
  }
  return { current, bruise };
}

/**
 * Warmth-streak multiplier over the relationship-history ring: consecutive
 * rising-regard samples at the tail each add CHAT_WARMTH_STREAK_STEP, capped at
 * CHAT_WARMTH_STREAK_CAP. Samples only append when an axis moved, so the streak
 * reads sustained warming, not idle turns. PURE.
 */
export function warmthStreakMultiplier(history: readonly RelationshipSample[]): number {
  let streak = 0;
  for (let i = history.length - 1; i > 0 && streak < 5; i--) {
    const prev = history[i - 1];
    const cur = history[i];
    if (!prev || !cur || cur.regard <= prev.regard) break;
    streak++;
  }
  return Math.min(CHAT_WARMTH_STREAK_CAP, 1 + streak * CHAT_WARMTH_STREAK_STEP);
}

/**
 * The combined regard-delta modifier (plan §Design 2 + the curve-feedback ruling):
 * 1. Feeling feedback, damped — valence × intensity × ±10%: amplifies a delta that
 *    AGREES with the standing feeling, damps one that fights it.
 * 2. Warmth streak (positive deltas only) — sustained warming compounds, cap ×1.5.
 * 3. Bruise (positive deltas only) — gains halve while it lasts.
 * The result re-rounds and re-clamps to ±deltaClamp, and a nonzero delta is never
 * scaled to zero (a landed act still registers at minimum ±1). PURE.
 */
export function scaleRegardDelta(input: {
  delta: number;
  feeling: ChatFeelingState;
  history: readonly RelationshipSample[];
  deltaClamp: number;
}): { delta: number; scale: number } {
  if (input.delta === 0) return { delta: 0, scale: 1 };
  let scale = 1;
  const feeling = input.feeling.current;
  if (feeling) {
    const bias = feelingValence(feeling.label) * feeling.intensity * CHAT_FEELING_BIAS_MAX;
    scale *= 1 + bias * Math.sign(input.delta);
  }
  if (input.delta > 0) {
    scale *= warmthStreakMultiplier(input.history);
    if ((input.feeling.bruise?.remaining ?? 0) > 0) scale *= 0.5;
  }
  const scaled = Math.round(input.delta * scale);
  const preserved = scaled === 0 ? Math.sign(input.delta) : scaled;
  const clamped = Math.max(-input.deltaClamp, Math.min(input.deltaClamp, preserved));
  return { delta: clamped, scale };
}

/** Regard at/above the `warm` band floor counts as "high" for bruise purposes. */
const BRUISE_REGARD_MIN = regardBandById("warm")?.min ?? 50;
/** |applied delta| at/above this (the strong-reaction bar) can bruise. */
export const BRUISE_DELTA_MIN = 4;

/**
 * A strong regard DROP landing while regard was high opens (or refreshes) a
 * bruise — trust rebuilt slowly (plan §Design 2). PURE.
 */
export function maybeBruise(preRegard: number, appliedDelta: number, state: ChatFeelingState): ChatFeelingState {
  if (appliedDelta > -BRUISE_DELTA_MIN || preRegard < BRUISE_REGARD_MIN) return state;
  return { ...state, bruise: { remaining: CHAT_BRUISE_EXCHANGES } };
}

/**
 * An accepted apology halves the bruise's remaining life (owner ruling — the
 * `apologize` concept, not `reassure`; comfort is not repair). PURE.
 */
export function halveBruise(state: ChatFeelingState): ChatFeelingState {
  const remaining = state.bruise?.remaining ?? 0;
  if (remaining <= 0) return state;
  const halved = Math.floor(remaining / 2);
  return { ...state, bruise: halved > 0 ? { remaining: halved } : null };
}
