/**
 * Memory tuning knobs (docs/memory.md §Tuning knobs). All scores are pgvector
 * cosine similarity (`1 - (a <=> b)`). When tuning, the `events` rows
 * (`type: "retrieval"`) carry query, candidates, and scores for the inspector.
 */

/**
 * Same-subject facts at or above this similarity supersede the older row.
 * High on purpose: under-merging leaves a duplicate fact (harmless noise),
 * over-merging silently destroys knowledge.
 */
export const SUPERSEDE_MIN_SCORE = 0.86;

/**
 * Retrieval-tier lore must be clearly on-topic — the lore channel is small
 * (3 chunks) and an off-topic chunk derails the narrator more than no chunk.
 */
export const LORE_MIN_SCORE = 0.72;

/**
 * Episodic recall is deliberately loose: a vaguely related callback reads
 * better than the narrator having no memory at all.
 */
export const EPISODE_MIN_SCORE = 0.55;

/**
 * Fact-relevance floor (character-chat-standalone.spec.md §6.3 #1). Starting
 * floor pending the §6.3 #6 retrieval eval — the facts floor sits below the
 * episodes' 0.55 because facts are the primary recall channel and a dropped
 * fact costs more than a loose one. Pinned facts are exempt (§6.4).
 */
export const FACT_MIN_SCORE = 0.5;

/** Cap on force-included pinned facts per retrieval (spec §6.4 — they ride ahead of the top-k). */
export const PINNED_FACT_CAP = 8;

/** Standard reciprocal-rank-fusion constant: fused score = Σ 1/(RRF_K + rank) (spec §6.3 #2). */
export const RRF_K = 60;

/** Library fuzzy name resolution (merge grounding, forge dedup, search). */
export const FUZZY_MIN_SCORE = 0.75;

/**
 * Save-time outfit dedupe backstop: collapse a freshly-drafted garment into an
 * existing library item only when the names are near-identical. Higher than
 * FUZZY_MIN_SCORE on purpose — the outfit agent already makes the nuanced reuse
 * calls (docs/authoring.md); the server only catches obvious duplicates it
 * missed and must not merge two deliberately-distinct pieces (a crimson vs an
 * emerald gown).
 */
export const ITEM_DEDUPE_MIN_SCORE = 0.9;

/** Retrieval fan-out limits (docs/memory.md). */
export const EPISODE_RETRIEVAL_LIMIT = 5;
export const FACT_RETRIEVAL_LIMIT = 5;
export const LORE_RETRIEVAL_LIMIT = 3;

/**
 * The last N episode summaries always ride in the turn context (recency
 * window); RAG excludes those turn numbers so retrieval only surfaces what
 * recency cannot.
 */
export const EPISODE_WINDOW = 4;

/** Archivist fact drafts under this confidence are dropped before embedding. */
export const FACT_MIN_CONFIDENCE = 0.4;

/** Top-N active facts searched per draft when gating supersedence. */
export const SUPERSEDE_CANDIDATES = 3;
