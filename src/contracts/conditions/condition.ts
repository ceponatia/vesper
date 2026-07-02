import { z } from "zod";
import { attributeIdPatternSchema } from "../attributes/types";

export const conditionEffectSchema = z.object({
  attributeId: attributeIdPatternSchema,
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
});

export type ConditionEffect = z.infer<typeof conditionEffectSchema>;

export const conditionSeveritySchema = z.enum(["minor", "moderate", "severe"]);

/**
 * How a condition impairs perception while active (presence-and-perception-spec
 * §Environment, decision 24): blindfolded ⇒ sight blocked, drunk ⇒ both reduced.
 * Optional — most conditions have none, and known labels (blindfolded, deaf, …)
 * map to effects without authoring (see contracts/perception/darkness.ts).
 */
export const senseEffectsSchema = z.object({
  sight: z.enum(["reduced", "blocked"]).optional(),
  hearing: z.enum(["reduced", "blocked"]).optional(),
});
export type SenseEffects = z.infer<typeof senseEffectsSchema>;

export const activeConditionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  severity: conditionSeveritySchema.optional(),
  /** Game clock (session clockMinutes) when the condition began. */
  startedAtMinutes: z.number().int().min(0),
  /** Engine expires the condition once the clock passes started + duration. */
  durationMinutes: z.number().int().positive().optional(),
  source: z
    .object({
      kind: z.enum(["narrative", "item", "environment", "manual"]),
      id: z.string().optional(),
    })
    .optional(),
  /** Overlaid while active with source "condition", sourceId = condition id. */
  attributeEffects: z.array(conditionEffectSchema).default([]),
  /** Perception impairment while active (presence-spec §Environment). */
  senseEffects: senseEffectsSchema.optional(),
  promptHint: z.string().optional(),
});

export type ActiveCondition = z.infer<typeof activeConditionSchema>;

/** Normalized (lowercased, trimmed) form of a condition label — the canonical match key. */
export function normalizeConditionLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Canonical matching key for an active condition: the **normalized label**.
 * Conditions are created app-wide with random `id`s (`newId()`) and the semantic
 * word in `label`, so every table keyed by condition vocabulary (catalog effects,
 * darkness sense effects, mood shifts/tints) must match on this — never on `c.id`.
 */
export function conditionKey(condition: Pick<ActiveCondition, "label">): string {
  return normalizeConditionLabel(condition.label);
}

export function isConditionExpired(condition: ActiveCondition, clockMinutes: number): boolean {
  if (condition.durationMinutes === undefined) return false;
  return clockMinutes >= condition.startedAtMinutes + condition.durationMinutes;
}
