import { z } from "zod";
import { attributeRuleSchema } from "../rules/attribute-rule";

/**
 * A species — a constrained variant of a body plan (ported from aionchat). It
 * names the body plan it uses, may add or remove body locations from that plan,
 * and carries per-attribute rules. Humanoid variants are data additions when
 * their body features already exist, and novel body plans are a later phase.
 * The structural `id` is separate from the free-text
 * `identity.species_presentation` description (Decision 8).
 */
export const speciesDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Extra exact-match names used by deterministic forge inference. */
  aliases: z.array(z.string().min(1)).readonly().optional(),
  bodyPlanId: z.string().min(1),
  description: z.string().default(""),
  /**
   * Optional whitelist for a species that uses only part of its body plan's
   * locations. Absent ⇒ inherits the full body-plan location list (then minus
   * `disallowedBodyLocationIds`).
   */
  allowedBodyLocationIds: z.array(z.string().min(1)).readonly().optional(),
  /** Body locations removed from the inherited body-plan location list. */
  disallowedBodyLocationIds: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Additive feature groups switched on when a character uses this species and
   * has not supplied an explicit bodyFeatures override.
   */
  defaultFeatureGroups: z.array(z.string().min(1)).readonly().optional(),
  /** Per-attribute rules; `forbidden` ones are dropped from the realized body. */
  attributeRules: z.array(attributeRuleSchema).readonly().default([]),
});

export type SpeciesDefinition = z.infer<typeof speciesDefinitionSchema>;
