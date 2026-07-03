import { z } from "zod";
import { stageForValue } from "./stages";

/**
 * Relationship history + milestones (character-chat-standalone.spec.md §7.2): the
 * visible arc of a chat relationship. Both live as capped jsonb rings on the chat
 * state row, appended by the exchange finalizer (and, for `player_marked`, by the
 * "mark this moment" action) — pure shapes + append/derive helpers here, IO in the
 * engine. They roll back with the pre-exchange snapshot for free ("another take"
 * undoes the sample/milestone its exchange recorded).
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
  affinity: z.number().catch(0),
  stage: z.string().catch("stranger"),
});
export type RelationshipSample = z.infer<typeof relationshipSampleSchema>;

export const milestoneKindSchema = z.enum([
  "first_exchange",
  "stage_up",
  "stage_down",
  "strong_reaction",
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

/** |affinityDelta| at or above this reads as a strong card-driven reaction milestone. */
export const STRONG_REACTION_DELTA = 4;

/**
 * Derive the milestones one settled exchange produced (spec §7.2). PURE:
 * - `first_exchange` when there was no stored state before it;
 * - `stage_up` / `stage_down` when the stage band crossed (both directions);
 * - `strong_reaction` when the pulse moved affinity by ≥ STRONG_REACTION_DELTA
 *   (the curve clamps at ±5, so this only fires on a genuinely charged beat).
 */
export function deriveExchangeMilestones(input: {
  at: string;
  messageId?: string;
  characterName: string;
  firstExchange: boolean;
  preAffinity: number;
  postAffinity: number;
  /** The pulse's signed affinity move this exchange (0 when skipped/degraded). */
  affinityDelta: number;
  /** The matched concept label for the strong-reaction milestone text, if any. */
  concept?: string | null;
}): Milestone[] {
  const out: Milestone[] = [];
  const { at, messageId } = input;
  if (input.firstExchange) {
    out.push({ at, kind: "first_exchange", label: `First words with ${input.characterName}`, messageId });
  }
  const pre = stageForValue(input.preAffinity);
  const post = stageForValue(input.postAffinity);
  if (pre.id !== post.id) {
    const up = input.postAffinity > input.preAffinity;
    out.push({
      at,
      kind: up ? "stage_up" : "stage_down",
      label: up ? `${pre.label} → ${post.label}` : `${pre.label} → ${post.label}`,
      messageId,
    });
  }
  if (Math.abs(input.affinityDelta) >= STRONG_REACTION_DELTA) {
    const warmed = input.affinityDelta > 0;
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
