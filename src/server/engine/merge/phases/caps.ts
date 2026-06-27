/**
 * Per-array caps on simulant (LLM) output before it drives DB writes
 * (docs/resilience.md §3, "trust nothing"). `maxOutputTokens` is the only
 * *implicit* bound today, so a token-cap bump would silently lift the ceiling
 * on how many rows one turn writes inside the merge transaction. These are
 * applied by `.slice(0, MAX_*)` at each consumption point in the phases —
 * graceful (keep the first N, drop the tail), mirroring ITEM_NOTE_CAP /
 * INNER_NOTE_MAX_FACTS. They are NOT schema `.max()`es: simulantResultSchema
 * degrades whole-object (generateChecked returns the schema default on any
 * parse failure), so a rejecting `.max()` would drop ALL events to the degraded
 * fallback. Values are generous — a legitimate turn never approaches them; the
 * cap only fires on a runaway/adversarial flood.
 */
export const MAX_MOVEMENTS = 50;
export const MAX_ITEM_EVENTS = 50;
export const MAX_METER_ADJUSTMENTS = 50;
export const MAX_CONDITION_EVENTS = 50;
export const MAX_ATTRIBUTE_CHANGES = 50;
export const MAX_ACTIVITY_UPDATES = 50;
export const MAX_AFFINITY_ADJUSTMENTS = 50;
export const MAX_COMMS_EVENTS = 50;
/** Bound on proposed threads embedded for semantic dedup (one batch, two vecs each). */
export const MAX_THREAD_PROPOSALS = 50;
