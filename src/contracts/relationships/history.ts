import { z } from "zod";
import { familiarityBandForValue, regardBandForValue } from "./bands";

/**
 * Relationship history + milestones (character-chat-standalone.spec.md §7.2): the
 * visible arc of a chat relationship. Both live as capped jsonb rings on the chat
 * state row, appended by the exchange finalizer (and, for `player_marked`, by the
 * "mark this moment" action) — pure shapes + append/derive helpers here, IO in the
 * engine. They roll back with the pre-exchange snapshot for free ("another take"
 * undoes the sample/milestone its exchange recorded).
 *
 * v2 (relationship-model.plan.md): samples carry the REGARD scalar + band (the
 * volatile axis — familiarity's slow ratchet gets its own milestone kind, not a
 * per-exchange sample). The `stage_up`/`stage_down` milestone kind ids are kept as
 * stored wire ids (rings already contain them); they now mean regard-band
 * crossings.
 */

/** Cap on history samples (~200 keeps the sparkline cheap and the row bounded). */
export const RELATIONSHIP_HISTORY_CAP = 200;
/** Cap on recorded milestones. */
export const MILESTONES_CAP = 100;

export const relationshipSampleSchema = z.object({
  /** ISO timestamp of the exchange that moved the needle. */
  at: z.string().catch(""),
  /** In-game clock at the sample (the fiction's own axis). */
  clockMinutes: z.number().catch(0),
  regard: z.number().catch(0),
  band: z.string().catch("neutral"),
  /** The slow axis, sampled alongside regard so the panel can draw both lines. */
  familiarity: z.number().catch(0),
});
export type RelationshipSample = z.infer<typeof relationshipSampleSchema>;

export const milestoneKindSchema = z.enum([
  "first_exchange",
  "stage_up",
  "stage_down",
  "familiarity_up",
  "strong_reaction",
  "secret_shared",
  "player_marked",
]);
export type MilestoneKind = z.infer<typeof milestoneKindSchema>;

export const milestoneSchema = z.object({
  at: z.string().catch(""),
  kind: milestoneKindSchema.catch("player_marked"),
  label: z.string().catch(""),
  messageId: z.string().optional(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

/** Append a sample, keeping the newest RELATIONSHIP_HISTORY_CAP entries. PURE. */
export function appendRelationshipSample(
  history: readonly RelationshipSample[],
  sample: RelationshipSample,
): RelationshipSample[] {
  return [...history, sample].slice(-RELATIONSHIP_HISTORY_CAP);
}

/** Append milestones, keeping the newest MILESTONES_CAP entries. PURE. */
export function appendMilestones(current: readonly Milestone[], added: readonly Milestone[]): Milestone[] {
  if (!added.length) return [...current];
  return [...current, ...added].slice(-MILESTONES_CAP);
}

/** |regardDelta| at or above this reads as a strong card-driven reaction milestone. */
export const STRONG_REACTION_DELTA = 4;

/**
 * The newest milestone the player hasn't been shown yet (chat-initiative.plan.md
 * slice 2 — the §8.4 v2 marker key): landed after the per-chat seen-cursor and
 * worth reaching out about. `first_exchange` never counts — "we spoke once" is
 * not a reason to reopen. Returns the milestone's label, or null. PURE.
 * (Ruled 2026-07-12: the marker keys on loops + milestones only — real time
 * since the last exchange is deliberately NOT a signal, per D3.)
 */
export function unseenMilestoneReason(milestones: readonly Milestone[], seenAt: Date): string | null {
  for (let i = milestones.length - 1; i >= 0; i--) {
    const m = milestones[i];
    if (!m || m.kind === "first_exchange") continue;
    const at = new Date(m.at).getTime();
    if (Number.isFinite(at) && at > seenAt.getTime()) return m.label || null;
  }
  return null;
}

/**
 * Derive the milestones one settled exchange produced (spec §7.2). PURE:
 * - `first_exchange` when there was no stored state before it;
 * - `stage_up` / `stage_down` when the REGARD band crossed (both directions);
 * - `familiarity_up` when the ratchet crossed a familiarity band ("She let you in");
 * - `strong_reaction` when the pulse moved regard by ≥ STRONG_REACTION_DELTA
 *   (the curve clamps at ±5, so this only fires on a genuinely charged beat).
 */
export function deriveExchangeMilestones(input: {
  at: string;
  messageId?: string;
  characterName: string;
  firstExchange: boolean;
  preRegard: number;
  postRegard: number;
  /** The familiarity scalar before/after the exchange's ratchet ticks (equal ⇒ no crossing check). */
  preFamiliarity?: number;
  postFamiliarity?: number;
  /** The pulse's signed regard move this exchange (0 when skipped/degraded). */
  regardDelta: number;
  /** The matched concept label for the strong-reaction milestone text, if any. */
  concept?: string | null;
}): Milestone[] {
  const out: Milestone[] = [];
  const { at, messageId } = input;
  if (input.firstExchange) {
    out.push({ at, kind: "first_exchange", label: `First words with ${input.characterName}`, messageId });
  }
  const pre = regardBandForValue(input.preRegard);
  const post = regardBandForValue(input.postRegard);
  if (pre.id !== post.id) {
    out.push({
      at,
      kind: input.postRegard > input.preRegard ? "stage_up" : "stage_down",
      label: `${pre.label} → ${post.label}`,
      messageId,
    });
  }
  if (input.preFamiliarity !== undefined && input.postFamiliarity !== undefined) {
    const preFam = familiarityBandForValue(input.preFamiliarity);
    const postFam = familiarityBandForValue(input.postFamiliarity);
    if (postFam.id !== preFam.id && input.postFamiliarity > input.preFamiliarity) {
      out.push({ at, kind: "familiarity_up", label: `${input.characterName} let you in — ${postFam.label.toLowerCase()}`, messageId });
    }
  }
  if (Math.abs(input.regardDelta) >= STRONG_REACTION_DELTA) {
    const warmed = input.regardDelta > 0;
    out.push({
      at,
      kind: "strong_reaction",
      label: input.concept
        ? `${warmed ? "Moved by" : "Stung by"} ${input.concept.replaceAll("_", " ")}`
        : warmed
          ? "A moment that landed"
          : "A moment that stung",
      messageId,
    });
  }
  return out;
}
