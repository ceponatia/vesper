import { z } from "zod";

/**
 * Relationship stages (docs/developer-notes/cast-tiers-and-affinity-spec.phase3.md):
 * the readable labels derived from an affinity scalar (−100..100). Stages —
 * never raw values — appear in prompts and gate behavior. Boundaries are data
 * (tune by editing this file).
 *
 * Widened from the original seven to eleven (personality-and-state.plan.md Slice 5 /
 * spec §4 "more levels") so progression reads less coarsely — the romance-leaning
 * positive half gets the extra granularity (`warm` between friendly and close,
 * `cherished` between close and devoted, `smitten` at the top), plus `cool` on the
 * cautious side. The original seven ids are retained (so `stranger` stays the neutral
 * default and authored seeds keep matching). `stranger` still straddles 0 (midpoint 0).
 */

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;

export const relationshipStageSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Inclusive bounds on the affinity scalar. */
  min: z.number().int(),
  max: z.number().int(),
});

export type RelationshipStage = z.infer<typeof relationshipStageSchema>;

export const relationshipStages: readonly RelationshipStage[] = [
  { id: "hostile", label: "Hostile", min: -100, max: -61 },
  { id: "wary", label: "Wary", min: -60, max: -36 },
  { id: "cool", label: "Cool", min: -35, max: -15 },
  { id: "stranger", label: "Stranger", min: -14, max: 14 },
  { id: "acquaintance", label: "Acquaintance", min: 15, max: 32 },
  { id: "friendly", label: "Friendly", min: 33, max: 49 },
  { id: "warm", label: "Warm", min: 50, max: 64 },
  { id: "close", label: "Close", min: 65, max: 78 },
  { id: "cherished", label: "Cherished", min: 79, max: 89 },
  { id: "devoted", label: "Devoted", min: 90, max: 96 },
  { id: "smitten", label: "Smitten", min: 97, max: 100 },
];

export function stageById(id: string): RelationshipStage | undefined {
  return relationshipStages.find((s) => s.id === id);
}

export function clampAffinity(value: number): number {
  return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, Math.round(value)));
}

export function stageForValue(value: number): RelationshipStage {
  const v = clampAffinity(value);
  const stage = relationshipStages.find((s) => v >= s.min && v <= s.max);
  // Boundaries cover [-100,100] contiguously (tested); fallback is defensive.
  return stage ?? { id: "stranger", label: "Stranger", min: -14, max: 14 };
}

/** Midpoint of a stage's band — used when seeding edges from an authored stage. */
export function stageMidpoint(id: string): number {
  const stage = stageById(id);
  if (!stage) return 0;
  return Math.round((stage.min + stage.max) / 2);
}
