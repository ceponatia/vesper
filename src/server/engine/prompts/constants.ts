/**
 * Prompt-text tunables (docs/prompts.md §Style rules). Binding numeric engine
 * constants (history depth, fact cap, …) live in ../constants.ts; re-exported
 * here so prompt code has one import site for everything it renders.
 */
export { CHARACTER_CHAT_HISTORY_TURNS, EPISODE_WINDOW } from "../constants";

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

/** Builder-level fallback when no `narrationShape` is threaded (tests / safety). The
 *  *runtime* per-lane resting defaults live in NARRATION_LANE_DEFAULTS below. */
export const DEFAULT_NARRATION_SHAPE: NarrationShapeId = "concise_immersive";

/**
 * Per-lane resting default shape profile (narrator-prompt-focus.plan.md decision 1,
 * re-ruled 2026-06-29). Run 2 of the behavioral eval
 * (narrator-prompt-focus.eval-results.md) found a per-model split the single global
 * default couldn't serve: the **session** narrator (Aion 2.0) prefers
 * `concise_immersive` (83% pairwise + best voice), while the **chat** default (GLM 5.2)
 * prefers `aggressive_concise` (71%). The live dev override still forces BOTH lanes when
 * set (the global A/B toggle); this is only the default the resolver falls through to.
 */
export type NarrationLane = "session" | "chat";
export const NARRATION_LANE_DEFAULTS: Record<NarrationLane, NarrationShapeId> = {
  session: "concise_immersive",
  chat: "aggressive_concise",
};

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
 * The active narration shape for a lane. Resolution order: the live dev override
 * (global — forces both lanes when set) → the NARRATION_SHAPE env (headless / eval
 * default) → the per-lane resting default (NARRATION_LANE_DEFAULTS). Per-call callers
 * (tests, eval harness) pass an explicit shape to the builders and skip this.
 */
export function narrationShapeId(lane: NarrationLane): NarrationShapeId {
  const override = readDevNarrationShape() ?? process.env.NARRATION_SHAPE; // undefined in prod
  if (override === "concise_immersive" || override === "aggressive_concise") return override;
  return NARRATION_LANE_DEFAULTS[lane];
}

/**
 * The chat prompt LAYOUT switch (narrator-prompt-consolidation.plan.md slice 5) —
 * experimental, default-off. `system_tail` (today's layout): the volatile tail rides
 * the system prompt, ahead of the history in token order, so each turn's tail change
 * re-processes the whole history. `turn_context`: the session lane's shape — system =
 * stable prefix only; the tail + fenced current input ride a final user message
 * (`buildChatTurnMessage`), making system + history an append-only cached prefix.
 * Env-only (no dev route yet); flip the default only after the eval A/B.
 */
export type ChatPromptLayout = "system_tail" | "turn_context";
export function chatPromptLayout(): ChatPromptLayout {
  return process.env.CHAT_PROMPT_LAYOUT === "turn_context" ? "turn_context" : "system_tail";
}

/**
 * The GARMENT NARRATION switch (clothing-state-graph.plan.md slice 6) —
 * experimental, default-off, exactly like `CHAT_PROMPT_LAYOUT` above and for the
 * same reason: the slice carries a live-model tuning gate ("tune contradiction,
 * repetition, concrete-detail, and extraction accuracy before enabling by
 * default") and that eval spend is owner-gated.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no authoritative wardrobe digest, no garment cue block, no garment notes
 * on the scene-image prompt. ON adds all three. Env-only, no dev route.
 *
 * Note what is NOT behind it: OQ8's pre/post look-key comparison ships either
 * way. That is a correctness fix — the enqueue was proposal-triggered, so a
 * structural wardrobe change could leave the `chat_look` anchor silently stale
 * (audit wrong-assumption 4) — not a prompt experiment.
 */
export function chatGarmentCuesEnabled(): boolean {
  return process.env.CHAT_GARMENT_CUES === "on";
}

/**
 * The AFFORDANCE NARRATION switch (body-attribute-affordances.plan.md slice 5) —
 * experimental, default-off, the same shape and the same reason as
 * `CHAT_GARMENT_CUES` above: slice 5 is explicitly a *trial* ("compare
 * contradiction rate, repetition, specificity, and prose naturalness with the
 * current appearance path"), and that live-model comparison is owner-gated.
 *
 * OFF (the default, and anything other than `on`) is today's behavior to the
 * byte: no affordance read is taken at all — no adapter call, no cue rendering,
 * no cue block on the narrator prompt — and `character_chats.affordance_cues`
 * rides through untouched rather than being cleared. ON adds exactly one block:
 * the ≤2 ranked, perception-safe, repeat-gated physical cues for this exchange,
 * plus the cue-memory write that makes the repeat gate work. Env-only, no dev route.
 *
 * Note what is NOT behind it: the slice-4 owners themselves. The environment and
 * body-surface extraction, their folds, and the rollback anchors all ship
 * unconditionally — they are authoritative state, not a prompt experiment, and the
 * cue memory has to roll back with them whether or not anything reads it.
 */
export function chatAffordanceCuesEnabled(): boolean {
  return process.env.CHAT_AFFORDANCE_CUES === "on";
}

/** Max characters of player input echoed inside agent prompts. */
export const AGENT_INPUT_CAP = 2000;
/** Max characters of narration echoed inside agent prompts. */
export const AGENT_NARRATION_CAP = 8000;
