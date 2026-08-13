import { z } from "zod";

/**
 * One reusable attribute-applicability rule, shared by species and (later) body
 * plans (ported from aionchat). It narrows the broad attribute catalog for a
 * particular kind of body: which attributes are required / optional / forbidden,
 * with optional default and allow/disallow narrowing of the value set. The
 * concrete value validation stays in the attribute registry; this rule only
 * carries the constraint.
 */
export const attributeRuleApplicabilities = ["required", "optional", "forbidden"] as const;
export const attributeRuleApplicabilitySchema = z.enum(attributeRuleApplicabilities);
export type AttributeRuleApplicability = z.infer<typeof attributeRuleApplicabilitySchema>;

export const attributeRuleSchema = z.object({
  attributeId: z.string().min(1),
  applicability: attributeRuleApplicabilitySchema,
  /** A complete stored value this rule supplies as the default. */
  defaultValue: z.unknown().optional(),
  /** Values permitted when this rule narrows the broader catalog. */
  allowedValues: z.array(z.unknown()).readonly().optional(),
  /** Values removed from the broader inherited value set. */
  disallowedValues: z.array(z.unknown()).readonly().optional(),
  notes: z.string().min(1).optional(),
});

export type AttributeRule = z.infer<typeof attributeRuleSchema>;
