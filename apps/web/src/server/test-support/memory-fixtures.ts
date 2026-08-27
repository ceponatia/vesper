import type { FactDraft } from "@/contracts";
import type { FactDraftInput } from "@/server/memory";

/**
 * Builders for the memory suites (`memory.int.test.ts`, `facts.test.ts`).
 *
 * Both files hand-roll the same two shapes: the four-field draft base, and the
 * pinned player fact — the latter spread inline six times, each copy repeating
 * `subjectKind: "player"`, `confidence: 1`, `pinned: true` and
 * `origin: "player" as const` in full.
 */

/**
 * A `FactDraft` with the archivist defaults the suites assume. `confidence: 0.9`
 * is deliberately not the schema's `0.5` catch-value: these drafts stand in for
 * high-confidence extractions, and the retrieval assertions are written against
 * that.
 */
export function factDraft(over: Partial<FactDraft> & Pick<FactDraft, "subjectName" | "text">): FactDraft {
  return { kind: "knowledge", subjectKind: "character", tags: [], confidence: 0.9, ...over };
}

/**
 * The "remember this" draft: pinned, `origin: "player"`, full confidence — the
 * combination the supersedence asymmetry and the force-include path
 * both hinge on. Subject defaults to the player; `over` is applied last, so the
 * player-authored-fact-about-a-character case is `pinnedPlayerDraft(text, {
 * subjectName: "Mara", subjectKind: "character" })`.
 */
export function pinnedPlayerDraft(text: string, over: Partial<FactDraftInput> = {}): FactDraftInput {
  return {
    ...factDraft({ subjectName: "the player", subjectKind: "player", text, confidence: 1 }),
    pinned: true,
    origin: "player",
    ...over,
  };
}

/**
 * The canonical `pseudoEmbed` probe pair, load-bearing in both directions:
 *
 * - `subject` against ITSELF embeds to cosine 1, clearing `SUPERSEDE_MIN_SCORE`
 *   (0.86) — the "supersedes" side of the gate.
 * - `subject` against `offTopic` embeds near-orthogonal (|cos| < 0.3), far under
 *   both `SUPERSEDE_MIN_SCORE` and the retrieval floor `FACT_MIN_SCORE` (0.25) —
 *   the "does not supersede" and "off-topic query returns nothing" sides.
 *
 * `pseudoEmbed` is deterministic, so the relationship is a fixed property of
 * these two strings. Swapping in different prose can silently move a score
 * across a threshold and flip an assertion; change the pair only with the
 * threshold arithmetic re-checked.
 */
export const SIMILARITY_TEXTS = {
  subject: "Mara's hair is red.",
  offTopic: "The eastern gate collapsed during the siege.",
} as const;
