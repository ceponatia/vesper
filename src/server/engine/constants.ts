/**
 * Engine tuning constants (docs/turn-engine.md). These are binding values:
 * the merge reducer, prompt builders, and job runner all reference them, and
 * tests assert the documented numbers.
 */

/** Clock advance when the simulant failed or returned nothing usable. */
export const FALLBACK_MINUTES_ADVANCED = 30;
/** Clamp bounds for simulant minutesAdvanced (docs/turn-engine.md §Merge). */
export const MIN_MINUTES_ADVANCED = 1;
export const MAX_MINUTES_ADVANCED = 480;
/** Declared rest ("I sleep until morning") gets its own clamp — a night, not a week (decision 38). */
export const REST_CLAMP_MINUTES = 960;
/** Registered actions per player turn before the narrator is told to end the beat. */
export const MAX_CHAINED_ACTIONS = 2;
/** Default traversal cost when a link has no travelMinutes. */
export const DEFAULT_LINK_TRAVEL_MINUTES = 1;
/** Default cross-area link cost (minutes) when not authored per link. */
export const DEFAULT_INTER_AREA_TRAVEL_MINUTES = 10;
/** Seeded daily schedule jitter bound (±minutes; decision 33). */
export const SCHEDULE_JITTER_MINUTES = 15;
/** Max affinity movement per edge per turn — story speed, not whiplash. */
export const AFFINITY_DELTA_CLAMP = 5;
/**
 * Soft cap on major-tier cast per session (decision 46) — warn, never block.
 * Defined in lib/cast-tiers.ts (pure) so the world editor's cast notice and
 * the spawn diagnostic share one count rule; re-exported here beside its
 * sibling tuning values.
 */
export { MAJOR_TIER_SOFT_CAP } from "@/lib/cast-tiers";
/** In-game minutes per affinity decay point (1 point per week toward 0; defaults doc §Affinity stages). */
export const AFFINITY_DECAY_WEEK_MINUTES = 7 * 24 * 60;

/** Raw user/assistant exchanges replayed for narrative voice continuity. */
export const NARRATIVE_HISTORY_TURNS = 2;
/** Most recent episode summaries always present in the turn context. */
export const EPISODE_WINDOW = 4;
/** Max items in the merged narrator facts channel (docs/memory.md). */
export const FACTS_CAP = 8;

/** Open threads untouched this many turns move to "cooling". */
export const THREAD_COOLING_TURNS = 8;
/** Top open threads riding in every turn context. */
export const OPEN_THREADS_IN_CONTEXT = 3;
/**
 * Cosine cutoff for collapsing a proposed thread into an existing one
 * (docs/story-threads.md). Conservative — matches the fact-supersede bar — so
 * only obvious duplicates merge; the director prompt is the primary dedup.
 */
export const THREAD_DEDUPE_MIN_SCORE = 0.86;
/** Max accumulated developments kept per thread (oldest dropped). */
export const THREAD_DEVELOPMENTS_CAP = 20;

/**
 * Max NPC↔NPC awareness lines in the turn context per turn (defaults doc §witness
 * matrix budget) — only non-obvious blindspots earn a line; a guard against
 * ensemble-scene prompt bloat.
 */
export const MAX_NPC_PAIR_AWARENESS_LINES = 4;

/** Heartbeats older than this mark a turn/job as abandoned (recovery). */
export const HEARTBEAT_STALE_MS = 60_000;
/** Heartbeat refresh cadence while streaming/processing. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** Minimum cosine similarity for embedding-fuzzy name grounding. */
export const FUZZY_RESOLVE_MIN = 0.75;
