import { z } from "zod";
import { attributeIdPatternSchema } from "../attributes/types";

export const conditionEffectSchema = z.object({
  attributeId: attributeIdPatternSchema,
  value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
});

export type ConditionEffect = z.infer<typeof conditionEffectSchema>;

export const conditionSeveritySchema = z.enum(["minor", "moderate", "severe"]);

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
  promptHint: z.string().optional(),
});

export type ActiveCondition = z.infer<typeof activeConditionSchema>;

export function isConditionExpired(condition: ActiveCondition, clockMinutes: number): boolean {
  if (condition.durationMinutes === undefined) return false;
  return clockMinutes >= condition.startedAtMinutes + condition.durationMinutes;
}
