/**
 * Reply-pacing hold (UI-only): how long the chat client keeps the "…" typing
 * indicator up before revealing the streamed reply, derived from the state
 * strip's snapshot. A guarded or cold character lets the message sit; a hurt one
 * hesitates; a warm or giddy one answers eagerly. Purely presentational — tokens
 * buffer client-side during the hold, so total time-to-full-reply grows by at
 * most the hold. Capped well below perceived-latency pain. PURE.
 */

/** Hard ceiling on the reveal hold — pacing must never read as a hang. */
export const REPLY_HOLD_MAX_MS = 1200;

/** Feeling labels that read dark (hesitation) vs bright (eagerness) for pacing. */
const DARK_FEELINGS = new Set(["sad", "angry", "afraid", "concerned"]);
const BRIGHT_FEELINGS = new Set(["happy", "affectionate", "playful", "aroused"]);

export interface ReplyPacingInput {
  /** The regard scalar (−100..100) from the state snapshot. */
  regard: number;
  /** The persistent feeling, when one is standing. */
  feeling?: { label: string; intensity: number } | null;
}

/**
 * The reveal hold in milliseconds. Cold regard (≤ the `cool` band) reads
 * reluctant; the neutral middle hesitates briefly; warm-or-better answers at
 * once. A standing dark feeling adds hesitation, a bright one trims it.
 */
export function replyRevealHoldMs(input: ReplyPacingInput | null): number {
  if (!input) return 0;
  let hold = 0;
  if (input.regard <= -15) hold += 700;
  else if (input.regard < 50) hold += 250;
  const feeling = input.feeling;
  if (feeling && feeling.intensity >= 0.4) {
    if (DARK_FEELINGS.has(feeling.label)) hold += 500;
    else if (BRIGHT_FEELINGS.has(feeling.label)) hold -= 200;
  }
  return Math.max(0, Math.min(REPLY_HOLD_MAX_MS, hold));
}
