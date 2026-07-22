/**
 * Engine tuning constants (docs/turn-engine.md). These are binding values:
 * the chat pipeline, prompt builders, and job runner reference them, and tests
 * assert the documented numbers.
 */

/** Narrator sampling temperature — the chat narrator stream's creativity knob. */
export const NARRATIVE_TEMPERATURE = 0.85;

/** Max affinity movement per edge per turn — story speed, not whiplash. */
export const AFFINITY_DELTA_CLAMP = 5;

/**
 * Character-chat harness (docs/developer-notes/character-chat.plan.md): the flat
 * message window replayed to the narrator in the Chat tab. The harness has no
 * episodes/RAG to lean on — the window IS its only memory. A "turn" is one
 * user+assistant exchange.
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
 * Character-chat light state (docs/developer-notes/character-chat-state.spec.md §3,
 * re-ruled by character-chat-standalone.spec.md §8, D3/D8). The chat clock is the
 * ONLY time model: within a visit each exchange advances it CHAT_TICK_MINUTES;
 * between visits no time passes at all — a player away for a week returns to a
 * scene where nothing moved. Player-chosen time skips (CHAT_SKIP_MINUTES) are the
 * one between-scene lever, and in v1 they are narrative flavor only: clock +
 * condition expiry + the skip note — meters untouched (D14). (Affinity never
 * decays, spec §10.)
 *
 * 4 → 1 (chat-clock-calendar.plan.md, owner ruling 2026-07-15): one exchange ≈ one
 * story minute, so ordinary conversation barely moves the visible clock and skips
 * are the primary time mover. Meter pacing did NOT follow the tick — see
 * CHAT_METER_DRIFT_MINUTES.
 */
export const CHAT_TICK_MINUTES = 1;
/**
 * Story-minutes of meter decay applied per exchange (the drift sweep, plan §1):
 * meter pacing is exchange-keyed in spirit — like the feeling's per-exchange decay
 * — so when the clock tick dropped 4 → 1 this kept the shipped per-exchange meter
 * feel instead of slowing it 4×. Deliberately decoupled from CHAT_TICK_MINUTES.
 */
export const CHAT_METER_DRIFT_MINUTES = 4;
/**
 * In-game minutes per player skip amount (spec §8.1) — moved to the contract
 * (chat-clock-calendar: the clock card previews landings client-side); re-exported
 * here beside its tuning siblings.
 */
export { CHAT_SKIP_MINUTES } from "@/contracts/turns/chat-skip";
/** Run the reaction pulse every Nth exchange (1 = every exchange; batch later if cost bites). */
export const CHAT_PULSE_EVERY_N = 1;
/** Output-token cap for the pulse call — a concept id + a short mindNote; keep it cheap/fast. */
export const CHAT_PULSE_MAX_OUTPUT_TOKENS = 256;
/**
 * Timeout for the inline reaction pulse before degrading to drift-only state. It
 * runs in the stream finalizer AFTER the reply has flushed to the client, so this
 * budget only delays the controller.close() — invisible to perceived latency (its
 * one real cost is holding the per-chat exchange lock a little longer, so a very
 * fast re-send can 409 `chat_busy`). Raised 4000→8000 (2026-07-15) alongside the
 * DeepSeek-4-Flash agent-model swap: the pulse was the tightest budget and the
 * single most-timed-out leg, so it gets the most headroom for a slow-but-alive route.
 *
 * TEMPORARY (2026-07-15, diagnostic): lifted to 60_000 — DeepSeek 4 Flash was still
 * timing out at 8/10s, which is abnormal for a tiny structured call, so we're letting
 * the agents run essentially unbounded to MEASURE their real latency (recorded as
 * agent-success events in the inspector). Not a real removal: a truly hung provider
 * would otherwise hold the exchange lock forever and wedge the chat, so a high ceiling
 * stays. REVERT to a sane budget once the real completion times are known.
 */
export const CHAT_PULSE_TIMEOUT_MS = 60_000;
/**
 * The post-turn extraction legs (chat-agent-improvements.plan.md slice 1b — formerly ONE
 * 700-token archivist call emitting all thirteen fields). Three focused legs now run in
 * parallel with each other and with the pulse in the same post-flush finalizer, so this
 * budget still only delays controller.close() — invisible to perceived latency — and each
 * leg's cap covers only ITS fields. A missed leg degrades just its own reads; all three
 * missing degrades to the summary+window path exactly as the single call used to.
 *
 * The scribe writes prose (an episode summary + up to 6 facts), so it keeps the largest
 * cap; continuity emits short structured proposals; the character leg emits short lists
 * plus one verbatim line.
 */
export const CHAT_MEMORY_SCRIBE_MAX_OUTPUT_TOKENS = 500;
export const CHAT_CONTINUITY_MAX_OUTPUT_TOKENS = 400;
export const CHAT_CHARACTER_NOTES_MAX_OUTPUT_TOKENS = 350;
/** Shared per-leg timeout (they race each other, not a shared budget). Raised 6000→10000
 * (2026-07-15) with the DeepSeek-4-Flash swap — off the perceived-latency path, so the only
 * cost is a slightly longer exchange-lock hold; catches a slow-but-alive route instead of dropping the leg.
 * TEMPORARY (2026-07-15, diagnostic): lifted to 60_000 to MEASURE real latency — see CHAT_PULSE_TIMEOUT_MS. REVERT. */
export const CHAT_EXTRACTOR_TIMEOUT_MS = 60_000;
/**
 * The per-member personal pass (multi-character-chat.followups.md ruling 10): one small
 * focused call per PRESENT ensemble member after the shared archivist. Four fields only
 * (loops/outfit/attributes/drives), so a tighter cap; same off-reply-path latency budget.
 */
export const CHAT_PERSONAL_NOTES_MAX_OUTPUT_TOKENS = 400;
// Matched to CHAT_EXTRACTOR_TIMEOUT_MS — TEMPORARY 60_000 diagnostic (2026-07-15). REVERT with the others.
export const CHAT_PERSONAL_NOTES_TIMEOUT_MS = 60_000;
/**
 * The background location-sketch agent (chat-scene-fidelity.plan.md slice 2b) runs as a
 * DETACHED job — nothing waits on it — so it affords a roomier timeout than the post-flush
 * legs. A miss just leaves the place unsketched; the absent-sketch trigger re-fires.
 */
export const CHAT_SCENE_SKETCH_MAX_OUTPUT_TOKENS = 300;
export const CHAT_SCENE_SKETCH_TIMEOUT_MS = 15000;
/**
 * The meanwhile pass (chat-offscreen-life.plan.md): ONE archivist-class call per
 * qualifying big skip, DETACHED like the scene sketch — nothing waits on it, so it
 * affords a roomy timeout. A miss degrades to an ordinary skip (grounded
 * improvisation covers the gap) and the gate re-arms on the next qualifying skip.
 */
export const CHAT_MEANWHILE_MAX_OUTPUT_TOKENS = 600;
export const CHAT_MEANWHILE_TIMEOUT_MS = 25_000;
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

/**
 * Cap on browsable alternate takes per assistant reply (character-chat-standalone
 * spec §4.1) — the newest takes win; the oldest non-active entries evict first.
 */
export const CHAT_REPLY_TAKES_CAP = 4;

/**
 * Character-chat model-stream watchdogs (data-loss-rerun fix): a hung provider must
 * never hold the per-chat exchange lock indefinitely (the Aion 3.0 incident, 2026-07-09).
 * If no first token arrives within CHAT_STREAM_FIRST_TOKEN_MS, or the whole stream runs
 * past CHAT_STREAM_OVERALL_MS, the upstream call is aborted and the exchange settles
 * through the stop path — any partial persists (`meta.stopped`), the lock releases, and
 * the exchange records a `timeout` reply failure. Generous by design: these guard against
 * a wedged provider, not a merely-slow one (a real narration can take tens of seconds).
 *
 * The first-token budget MUST stay comfortably below Fly's ~60s proxy idle timeout:
 * until the first token, zero bytes have flowed on the response, so at ~60s the proxy
 * kills the connection. The watchdog has to win that race — a watchdog trip records an
 * accurate `timeout` failure for the popup, while a proxy kill is a silent client-side
 * connection drop that looks identical to a clean empty stream.
 */
export const CHAT_STREAM_FIRST_TOKEN_MS = 50_000;
export const CHAT_STREAM_OVERALL_MS = 300_000;

/**
 * Bounded wait for the per-chat exchange lock on an atomic rerun (data-loss-rerun
 * fix). A rerun first stops any in-flight reply for the chat (releasing its lock as it
 * settles), then waits up to this long to re-acquire the lock before touching the
 * transcript. If it still can't be had (a stuck settle), the rerun 409s `chat_busy` with
 * the transcript completely untouched — nothing is ever deleted before the lock is ours.
 */
export const CHAT_RERUN_LOCK_WAIT_MS = 8_000;

/** Heartbeat refresh cadence while a job is processing. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Hard cap on job execution attempts (security Cluster I6). `jobs.attempts`
 * increments atomically on every claim; once a job has been attempted this many
 * times it is abandoned (marked failed with a diagnostic) rather than re-run, so
 * a poison job orphaned-and-re-kicked can never loop forever (docs/resilience.md §5).
 */
export const MAX_JOB_ATTEMPTS = 3;
