import { z } from "zod";

/**
 * Relationship stages (docs/developer-notes/cast-tiers-and-affinity-spec.phase3.md):
 * the readable labels derived from an affinity scalar (−100..100). Stages —
 * never raw values — appear in prompts and gate behavior. Boundaries are data
 * (v1 values from multi-character-v1-defaults.phase3.md); tune by editing this file.
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
  { id: "hostile", label: "Hostile", min: -100, max: -50 },
  { id: "wary", label: "Wary", min: -49, max: -15 },
  { id: "stranger", label: "Stranger", min: -14, max: 14 },
  { id: "acquaintance", label: "Acquaintance", min: 15, max: 34 },
  { id: "friendly", label: "Friendly", min: 35, max: 59 },
  { id: "close", label: "Close", min: 60, max: 84 },
  { id: "devoted", label: "Devoted", min: 85, max: 100 },
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
