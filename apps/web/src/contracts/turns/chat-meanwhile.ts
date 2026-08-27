import { z } from "zod";
import { normalizePlanKey, planInvolvesPlayer, type ChatPlan } from "./chat-plans";

/**
 * The meanwhile pass: when a time skip crosses the
 * gate, ONE detached archivist-class call proposes a few concrete off-screen
 * developments for the whole ensemble — a life beat consistent with a member's
 * rhythm, a drive progress notch, a supporting-cast beat, an NPC↔NPC interaction,
 * an outcome for a plan the player wasn't part of — plus refreshed whereabouts
 * for away members and ONE compact narrator note. Everything folds
 * deterministically into existing sinks (facts to the involved members' memory
 * groups, `applyDriveUpdates`, `mergeSupportingCast`, plan statuses); a degraded
 * result is an ordinary skip (developments [], note "").
 *
 * Pure — no IO, no clock read. D3-safe by construction: the pass is armed only by
 * a player-triggered skip and keys to STORY minutes.
 */

/** Story-minutes of skipped time that arm the pass (cumulative since the last pass — ruling A). */
export const MEANWHILE_GATE_MINUTES = 1440;
/** Developments per pass, regardless of skip size. */
export const MEANWHILE_MAX_DEVELOPMENTS = 3;
/** Whereabouts refreshes per pass (at most one per away member; lenient cap). */
export const MEANWHILE_MAX_WHEREABOUTS = 4;
export const MEANWHILE_EVENT_MAX_CHARS = 200;
export const MEANWHILE_NOTE_MAX_CHARS = 160;
/** Cap on a whereabouts phrase — a phrase, not a location model. */
export const WHEREABOUTS_MAX_CHARS = 120;

/**
 * True when a skip landing at `clockMinutes` should run the pass: at least one
 * story day of skipped time has accumulated since the last pass (or the chat's
 * start). Cumulative, so stacked overnight skips arm it too — not only `days`.
 */
export function armMeanwhilePass(lastPassAtMinutes: number, clockMinutes: number): boolean {
  return clockMinutes - Math.max(0, lastPassAtMinutes) >= MEANWHILE_GATE_MINUTES;
}

/**
 * One proposed off-screen development. `about` names who it happened to (1–2
 * roster/supporting-cast names — two names = an NPC↔NPC interaction, filed as a
 * relationship fact to both). The optional attachments bind it to existing
 * state: an exact drive `want` it progresses, a supporting-cast detail to
 * accrete, or an open NPC↔NPC plan it resolves.
 */
export const meanwhileDevelopmentSchema = z.object({
  about: z
    .array(z.string().trim().min(1).max(60))
    .catch([])
    .default([])
    .transform((names) => names.slice(0, 2)),
  event: z.string().trim().min(1).max(MEANWHILE_EVENT_MAX_CHARS),
  /** Exact `want` of a drive this progresses (the dossier lists them). */
  driveWant: z.string().trim().max(120).optional().catch(undefined),
  /** Fresh progress note for that drive ("heard back — they want revisions"). */
  driveProgress: z.string().trim().max(200).optional().catch(undefined),
  /** A durable supporting-cast detail to accrete ("started her new job"). */
  castDetail: z.string().trim().max(120).optional().catch(undefined),
  /** Exact `what` of an open plan (not involving the player) this resolves. */
  planWhat: z.string().trim().max(160).optional().catch(undefined),
  planOutcome: z.enum(["kept", "missed"]).optional().catch(undefined),
});
export type MeanwhileDevelopment = z.infer<typeof meanwhileDevelopmentSchema>;

export const meanwhileWhereaboutsSchema = z.object({
  name: z.string().trim().min(1).max(60),
  where: z.string().trim().min(1).max(WHEREABOUTS_MAX_CHARS),
});

/** The pass's structured output. Lenient at every leaf — a bad row drops, never the pass. */
export const chatMeanwhileSchema = z
  .object({
    developments: z
      .array(meanwhileDevelopmentSchema.nullable().catch(null))
      .catch([])
      .default([])
      .transform((rows) => rows.filter((r): r is MeanwhileDevelopment => r !== null).slice(0, MEANWHILE_MAX_DEVELOPMENTS)),
    whereabouts: z
      .array(meanwhileWhereaboutsSchema.nullable().catch(null))
      .catch([])
      .default([])
      .transform((rows) => rows.filter((r): r is z.infer<typeof meanwhileWhereaboutsSchema> => r !== null).slice(0, MEANWHILE_MAX_WHEREABOUTS)),
    /** ONE compact line for the narrator ("Nyx heard back about the commission; Kira's week ran long"). */
    note: z.string().trim().max(MEANWHILE_NOTE_MAX_CHARS).catch("").default(""),
  })
  .catch({ developments: [], whereabouts: [], note: "" });
export type ChatMeanwhile = z.infer<typeof chatMeanwhileSchema>;

/** The degraded default — an ordinary skip. */
export function degradedChatMeanwhile(): ChatMeanwhile {
  return { developments: [], whereabouts: [], note: "" };
}

/**
 * Apply the pass's plan outcomes (pure): a development naming an OPEN plan by
 * normalized `what` that does NOT involve the player resolves it kept/missed —
 * the meanwhile pass replacing ruling E's blind assume-kept default. Player
 * plans are never touched (their misses are the player's own story), unmatched
 * names drop. Returns the new list plus what resolved.
 */
export function applyMeanwhilePlanOutcomes(
  plans: readonly ChatPlan[],
  developments: readonly MeanwhileDevelopment[],
  playerName: string,
): { plans: ChatPlan[]; resolved: ChatPlan[] } {
  const outcomes = new Map<string, "kept" | "missed">();
  for (const dev of developments) {
    if (dev.planWhat && dev.planOutcome) outcomes.set(normalizePlanKey(dev.planWhat), dev.planOutcome);
  }
  if (!outcomes.size) return { plans: [...plans], resolved: [] };
  const resolved: ChatPlan[] = [];
  const next = plans.map((plan) => {
    if (plan.status !== "upcoming") return plan;
    const outcome = outcomes.get(normalizePlanKey(plan.what));
    if (!outcome || planInvolvesPlayer(plan, playerName)) return plan;
    const done = { ...plan, status: outcome };
    resolved.push(done);
    return done;
  });
  return { plans: next, resolved };
}
