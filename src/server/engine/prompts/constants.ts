/**
 * Prompt-text tunables (docs/prompts.md §Style rules). Binding numeric engine
 * constants (history depth, fact cap, …) live in ../constants.ts; re-exported
 * here so prompt code has one import site for everything it renders.
 */
export { CHARACTER_CHAT_HISTORY_TURNS, EPISODE_WINDOW, FACTS_CAP, NARRATIVE_HISTORY_TURNS, OPEN_THREADS_IN_CONTEXT } from "../constants";

/**
 * Narration *shape profiles* (narrator-prompt-focus.plan.md §1.1) — the length /
 * focus guidance that opens the prose-style rules. A global dev/code A/B knob, not
 * a per-world field: instead of one hard-coded "3–5 paragraphs" floor (which made a
 * quiet "hi" manufacture errands and extra speakers to fill it), narration length
 * is a named profile, threaded through the builders as `narrationShape` so the eval
 * harness can sweep both in one process and both are snapshot-tested. The live
 * default is resolved by `narrationShapeId()`; authors tune richness through the
 * authored Style directives instead (decision 2).
 */
export type NarrationShapeId = "concise_immersive" | "aggressive_concise";

/** All shape ids — the validation vocabulary for the dev toggle + route. */
export const NARRATION_SHAPE_IDS = ["concise_immersive", "aggressive_concise"] as const;

/** The shipped default: focus without losing the immersive register. */
export const DEFAULT_NARRATION_SHAPE: NarrationShapeId = "concise_immersive";

export const NARRATION_SHAPE_PROFILES: Record<NarrationShapeId, string> = {
  // Default: focus without losing the immersive register.
  concise_immersive:
    "Write one focused beat per turn. Match length to what the input calls for, never " +
    "padding to a target: a quiet or simple input gets a short reply; a normal scene beat " +
    "is usually a few rich paragraphs; expand further only when the moment earns it — a " +
    "first encounter, a room entry or scene transition, a consequence touching several " +
    "characters, or an explicit player ask. Keep the prose vivid. End on a natural " +
    "sentence; never trail off.",
  // Backup A/B variant — flip on to test a tighter feel.
  aggressive_concise:
    "Be brief and tightly scoped. Answer the player's input in as few sentences as it " +
    "honestly needs, then stop; expand into fuller description ONLY for a first encounter, " +
    "a scene transition, a multi-character consequence, or an explicit player ask. No " +
    "padding, no summary, no wrap-up. End on a natural sentence.",
};

// The live dev override (narrator-prompt-focus.plan.md §1.1 "Live dev toggle"): a
// server-side value flipped by the dev-only POST /api/dev/narration-shape route and
// read here by `narrationShapeId()`. undefined ⇒ no override (fall through to env /
// default). Dev-only and process-local — undefined in production (the route is 404
// there) and reset on a true restart, the intended experimentation surface. Kept on
// globalThis (var) so the override survives Next.js dev-server module reloads — the
// toggle exists for live prompt iteration, which is exactly what triggers HMR;
// without this, editing constants.ts / narrative.ts while A/B-ing would silently
// snap it back to the default. Same pattern as db/client.ts's pool + jobs.ts's runner.
declare global {
  // var declaration so the dev override survives Next.js dev-server module reloads
  var __vesperNarrationShape: NarrationShapeId | undefined;
}

/** Read the live dev override (null when unset). */
export function readDevNarrationShape(): NarrationShapeId | null {
  return globalThis.__vesperNarrationShape ?? null;
}

/** Set (or clear, with null) the live dev override. Dev-only caller. */
export function setDevNarrationShape(shape: NarrationShapeId | null): void {
  globalThis.__vesperNarrationShape = shape ?? undefined;
}

/**
 * The active narration shape. Resolution order: the live dev override → the
 * NARRATION_SHAPE env (headless / eval default) → DEFAULT_NARRATION_SHAPE. Per-call
 * callers (tests, eval harness) pass an explicit shape to the builders and skip this.
 */
export function narrationShapeId(): NarrationShapeId {
  const pick = readDevNarrationShape() ?? process.env.NARRATION_SHAPE; // dev override is undefined in prod
  return pick === "aggressive_concise" ? "aggressive_concise" : DEFAULT_NARRATION_SHAPE;
}

/** Max characters of player input echoed inside agent prompts. */
export const AGENT_INPUT_CAP = 2000;
/** Max characters of narration echoed inside agent prompts. */
export const AGENT_NARRATION_CAP = 8000;
