import { relationshipStages } from "../relationships/stages";

/**
 * Ordinal rank of a relationship stage (0 = `hostile` … 10 = `smitten`), used by the
 * emotion projection (warm-affinity → `affectionate`) and welcome/unwelcome
 * touch. Reading the *order* — not the raw affinity scalar — keeps the
 * warmth thresholds as stage ids (tunable in one place) rather than magic numbers.
 */
const STAGE_RANK: ReadonlyMap<string, number> = new Map(relationshipStages.map((s, i) => [s.id, i]));

const STRANGER_RANK = STAGE_RANK.get("stranger") ?? 3;

/** Rank of a stage id; an unknown id self-heals to `stranger`'s rank (neutral). */
export function stageRank(id: string): number {
  return STAGE_RANK.get(id) ?? STRANGER_RANK;
}

/** True when `id` is at or above `floor` in the stage order. */
export function stageAtLeast(id: string, floor: string): boolean {
  return stageRank(id) >= stageRank(floor);
}

/** True when `id` is at or below `ceiling` in the stage order. */
export function stageAtMost(id: string, ceiling: string): boolean {
  return stageRank(id) <= stageRank(ceiling);
}
