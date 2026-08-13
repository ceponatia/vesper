import { z } from "zod";

/**
 * Composition-fallback telemetry (drain-hardening.diagnostics.md — C15).
 *
 * The successor turn loop is deliberately resilient: when a composed step fails (a scene
 * won't end, a move is refused, a drain won't converge, a beat won't write), the choreography
 * DEGRADES — the player still gets a turn, just a lesser one (a plain solo render, a
 * "traveled alone" instead of "together"). That resilience is correct, and it is also a
 * blindfold: a leg that degrades on every travel looks exactly like normal play. The only
 * trace is a `log.warn` line nobody reads (the archivist timed out for DAYS behind exactly
 * this kind of silence — see agent-failure.ts).
 *
 * So each degradation now leaves a record on TWO surfaces (ruling 1):
 * - a durable `events` row (`type = "composition_fallback"`) for the admin tally — is a leg
 *   degrading? how often? — mirroring the agent-failure log; and
 * - a **public-safe code** in the affected message's persisted meta, so opening a suspicious
 *   beat shows what degraded. Meta rides the player-visible payload, so it carries the stable
 *   CODE only — never the private `detail` (ruling 2, admin-only). The detail lives solely in
 *   the events row.
 *
 * Pure: the vocabulary, the record shape, the tally. No IO.
 */

/**
 * The closed set of degradation codes — stable, so a tally is meaningful. A code names WHAT
 * fell back; the `site` names WHERE. Extending the vocabulary is a data edit here.
 */
export const compositionFallbackCodes = [
  /** A scene-end command was not accepted; the choreography took its interrupt/degrade path. */
  "end_engagement_fallback",
  /** A player move was refused; the turn rendered a plain solo cut instead of a departure. */
  "move_rejected_solo_render",
  /** Walk-with-me: the primary's move did not land, so the player traveled alone. */
  "traveled_alone",
  /** After a shared arrival the co-present scene did not reopen; rendered solo. */
  "scene_reopen_failed",
  /** A drain hit its divergence cap (the loop ran away) — stopped without reaching the target. */
  "drain_diverged",
  /** A drain stopped short of its target honestly (A5) — how far time actually moved is reported. */
  "drain_short",
  /** A drain stopped at a transiently-backed-off trigger (A6) — settles once the backoff elapses. */
  "drain_backoff",
  /** A terminally-failed (poison) trigger sits in the drained window (A6 sibling) — never hidden. */
  "trigger_failed",
  /** After a travel drain an actor was still in transit (A7) — the arrival settles on a later beat. */
  "still_in_transit",
  /** A world beat could not be written after its command already committed. */
  "beat_write_degraded",
] as const;
export const compositionFallbackCodeSchema = z.enum(compositionFallbackCodes).catch("drain_short");
export type CompositionFallbackCode = (typeof compositionFallbackCodes)[number];

/** Which choreography the degradation happened in — the tally's second axis. */
export const compositionFallbackSites = [
  "departure",
  "accompany",
  "travel",
  "advance_time",
  "do_activity",
  "arrival",
  "beat",
] as const;
export const compositionFallbackSiteSchema = z.enum(compositionFallbackSites).catch("departure");
export type CompositionFallbackSite = (typeof compositionFallbackSites)[number];

/** One recorded degradation — the `events` row payload (`type = "composition_fallback"`). */
export const compositionFallbackSchema = z.object({
  site: compositionFallbackSiteSchema,
  code: compositionFallbackCodeSchema,
  /** The conversation this degradation belongs to (the inspector's filter). */
  chatId: z.string().nullish().catch(null).transform((v) => v ?? null),
  /** The beat/reply this degradation is attached to, when known. */
  messageId: z.string().nullish().catch(null).transform((v) => v ?? null),
  /** The private cause — events-row ONLY, never surfaced to a player (ruling 2). Truncated. */
  detail: z.string().catch(""),
  at: z.string().catch(""),
});
export type CompositionFallback = z.infer<typeof compositionFallbackSchema>;

/** Human label per code — what a degradation actually means, for the admin readout. */
const CODE_LABELS: Record<CompositionFallbackCode, string> = {
  end_engagement_fallback: "Scene-end fell back",
  move_rejected_solo_render: "Move refused → solo render",
  traveled_alone: "Traveled alone (partner didn't come)",
  scene_reopen_failed: "Scene didn't reopen after arrival",
  drain_diverged: "Drain diverged (ran away)",
  drain_short: "Drain stopped short",
  drain_backoff: "Drain paused on a retrying trigger",
  trigger_failed: "Poison trigger in window",
  still_in_transit: "Still in transit after arrival drain",
  beat_write_degraded: "World beat not written",
};

const codeSet = new Set<string>(compositionFallbackCodes);

export function compositionFallbackCodeLabel(code: string): string {
  // Membership, not the `.catch`-ing schema: `safeParse` always succeeds (it falls back), so
  // an unknown code must echo verbatim rather than borrow the fallback's label.
  return codeSet.has(code) ? CODE_LABELS[code as CompositionFallbackCode] : code;
}

/** Human label per site — which composed flow degraded. */
const SITE_LABELS: Record<CompositionFallbackSite, string> = {
  departure: "Departure (walk away)",
  accompany: "Walk-with-me",
  travel: "Travel chip",
  advance_time: "Time skip",
  do_activity: "Activity chip",
  arrival: "Arrival check",
  beat: "World beat",
};

const siteSet = new Set<string>(compositionFallbackSites);

export function compositionFallbackSiteLabel(site: string): string {
  return siteSet.has(site) ? SITE_LABELS[site as CompositionFallbackSite] : site;
}

/** One line of a tally, newest-first counts. */
export const compositionFallbackTallyRowSchema = z.object({
  key: z.string().catch(""),
  count: z.number().int().nonnegative().catch(0),
});
export type CompositionFallbackTallyRow = z.infer<typeof compositionFallbackTallyRowSchema>;

/** Tally a list of fallbacks by code and by site. PURE. */
export function tallyCompositionFallbacks(fallbacks: readonly CompositionFallback[]): {
  total: number;
  byCode: CompositionFallbackTallyRow[];
  bySite: CompositionFallbackTallyRow[];
} {
  const count = (pick: (f: CompositionFallback) => string): CompositionFallbackTallyRow[] => {
    const map = new Map<string, number>();
    for (const fallback of fallbacks) {
      const key = pick(fallback);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, n]) => ({ key, count: n }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  return { total: fallbacks.length, byCode: count((f) => f.code), bySite: count((f) => f.site) };
}
