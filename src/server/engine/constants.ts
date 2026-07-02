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

/**
 * Short-term memory: how many recent raw user/assistant exchanges are replayed
 * verbatim for narrative voice continuity. Tune freely here — higher keeps the
 * model coherent across more recent turns (fewer "bizarre inconsistencies") at
 * the cost of more prompt tokens per turn; lower saves tokens but a short window
 * lets recent style drift (a run of solo/untagged turns flushing the tagged
 * dialogue examples is what caused the speaker-tag drift in docs/prompts.md).
 */
export const NARRATIVE_HISTORY_TURNS = 6;
/**
 * Character-chat harness (docs/developer-notes/character-chat.plan.md): the flat
 * message window replayed to the narrator in the Chat tab. Far larger than
 * NARRATIVE_HISTORY_TURNS because the harness has no episodes/RAG to lean on —
 * the window IS its only memory. A "turn" is one user+assistant exchange.
 */
export const CHARACTER_CHAT_HISTORY_TURNS = 40;
/**
 * Rolling chat summary (docs/developer-notes/character-chat-summary.plan.md).
 * When the unsummarized tail reaches CHARACTER_CHAT_SUMMARIZE_AT exchanges, a
 * detached `chat_summary` job folds the oldest exchanges into the running
 * summary, leaving CHARACTER_CHAT_VERBATIM_KEEP verbatim. The fold size is the
 * difference (≈20 exchanges). CHARACTER_CHAT_HISTORY_TURNS stays the verbatim
 * *ceiling* — the degraded floor when summarization is off/failed (= the old
 * flat-window behavior). The gap between SUMMARIZE_AT (35) and the ceiling (40)
 * is headroom: the one-call fold settles before the window could overflow. A
 * "turn"/"exchange" is one user+assistant pair (≈2 messages).
 */
export const CHARACTER_CHAT_SUMMARIZE_AT = 35;
/** Exchanges left verbatim after a fold (the rest fold into the running summary). */
export const CHARACTER_CHAT_VERBATIM_KEEP = 15;

/**
 * Character-chat light state (docs/developer-notes/character-chat-state.spec.md §3).
 * The chat has no in-world clock, so synthesise one. Within a visit each exchange
 * advances the chat clock CHAT_TICK_MINUTES and decays meters that far (the session
 * decay model, scaled tiny). Between visits, real elapsed time maps to a recovery
 * fraction over CHAT_RESET_MINUTES and meters lerp toward rested (initialMeters) —
 * so an idle character comes back freshly bathed and rested, not perpetually filthy.
 * (Affinity never decays — chat is a light, often-ephemeral test-bed, spec §10.)
 */
export const CHAT_TICK_MINUTES = 4;
/** Real minutes of absence that fully recover meters toward rested (≈ a few hours). */
export const CHAT_RESET_MINUTES = 180;
/** Run the reaction pulse every Nth exchange (1 = every exchange; batch later if cost bites). */
export const CHAT_PULSE_EVERY_N = 1;
/** Output-token cap for the pulse call — a concept id + a short mindNote; keep it cheap/fast. */
export const CHAT_PULSE_MAX_OUTPUT_TOKENS = 256;
/**
 * Timeout for the inline reaction pulse before degrading to drift-only state. It
 * runs in the stream finalizer AFTER the reply has flushed to the client, so this
 * budget only delays the controller.close() — invisible to perceived latency.
 */
export const CHAT_PULSE_TIMEOUT_MS = 4000;
/**
 * The chat archivist-lite (character-chat-primary.spec.md §2) runs in parallel with the
 * pulse in the same post-flush finalizer, so its budget also only delays controller.close().
 * It emits more than the pulse (an episode summary + facts + queries) so it gets a larger
 * token cap and a slightly longer timeout; a miss degrades to the summary+window path.
 */
export const CHAT_ARCHIVIST_MAX_OUTPUT_TOKENS = 700;
export const CHAT_ARCHIVIST_TIMEOUT_MS = 6000;
/**
 * Arousal a pulse-classified **intimate** act adds (slice 4): full for an intimate
 * concept (e.g. a proposition), half for courtship / physical-affection. Skipped
 * when the act is disliked. Clamped to [0,1] like every meter.
 */
export const CHAT_AROUSAL_INTIMATE = 0.18;
/** Duration (chat-clock minutes) of a condition added by an action chip before it self-expires. */
export const CHAT_ACTION_CONDITION_MINUTES = 90;
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
/**
 * Age at which a detached api-side job (`startJob` — running, never heartbeated)
 * is failed by the recovery sweep (codebase-review D4). Generous, because these
 * jobs run in-process with no heartbeat to distinguish slow from dead: an image
 * render can legitimately take minutes, and a survivor that settles after being
 * swept just overwrites the row with its real outcome.
 */
export const API_JOB_STALE_MS = 15 * 60_000;
/** Heartbeat refresh cadence while streaming/processing. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Background recovery-sweep cadence (engine/recovery.ts, started from
 * instrumentation.ts). On-submit recovery can't reach a session whose UI is
 * blocked while wedged (e.g. a process restart orphaned its post-turn job),
 * so a periodic heartbeat-based sweep self-heals it. With HEARTBEAT_STALE_MS a
 * restart-orphaned session recovers within ~stale + one sweep (~60–90s).
 */
export const RECOVERY_SWEEP_INTERVAL_MS = 30_000;

/**
 * Hard cap on job execution attempts (security Cluster I6). `jobs.attempts`
 * increments atomically on every claim; once a job has been attempted this many
 * times it is abandoned (marked failed with a diagnostic) rather than re-run, so
 * a poison job orphaned-and-re-kicked by recovery can never loop forever. A
 * gating (post_turn/reconcile) job that exhausts its attempts still drains the
 * queue, so the session returns to `ready` — a poison job degrades a turn, it
 * never wedges play (docs/resilience.md §5).
 */
export const MAX_JOB_ATTEMPTS = 3;

/** Minimum cosine similarity for embedding-fuzzy name grounding. */
export const FUZZY_RESOLVE_MIN = 0.75;

/** Give-up budget (turns) for a director-staged movement intent that never arrives. */
export const STAGED_INTENT_DEFAULT_BUDGET = 6;
/** Max NPC-initiated pending messages kept in runtime — surface-once, a runaway guard. */
export const PENDING_COMMS_CAP = 8;

/**
 * Pre-narrator intake (docs/developer-notes/pre-narrator-agents.spec.md):
 * the LLM intake call runs concurrent with retrieval before narration. If it
 * exceeds this budget the turn proceeds on the regex `detectIntent` fallback
 * (which is then aborted, silently — see engine/intake.ts) — a second or two of
 * added time-to-first-token is acceptable; a stalled turn is not.
 *
 * Raised 1500→3000 (pre-narrator-agents.followups.md §2a/§5): the original 1500
 * was tuned to the spec's 400–1200ms estimate, but a reasoning-disabled call on
 * the curated agent models lands in ~1.5–2.5s in the common case (the old default
 * also *mandated* reasoning, which blew the budget outright). This is the
 * product latency knob (spec Open-question A) — finalize on real per-turn HUD
 * telemetry, not synthetic probes; the silent fallback covers the slow tail.
 */
export const INTAKE_TIMEOUT_MS = 3000;
/** Output-token cap for the intake call — the brief is small; keep it cheap/fast. */
export const INTAKE_MAX_OUTPUT_TOKENS = 512;

/**
 * A turn submitted while the previous turn is still in its post-turn "processing"
 * window waits up to this long for the session to return to "ready" before
 * 409ing (UX-audit M3): the lock lingers ~8–10s after the stream's `done`, so a
 * back-to-back / API-driven turn would otherwise hit a spurious session_busy. An
 * actively "narrating" turn is never waited on — that is the caller's own race.
 */
export const TURN_READY_WAIT_MS = 12_000;
/** Poll interval while waiting out the post-turn window. */
export const TURN_READY_POLL_MS = 400;
