import { z } from "zod";
import { attributeRuleSchema } from "../rules/attribute-rule";

/**
 * A species — a constrained variant of a body plan (ported from aionchat). It
 * names the body plan it uses, may add or remove body locations from that plan,
 * and carries per-attribute rules. Humanoid variants are data additions when
 * their body features already exist, and novel body plans are a later phase.
 * The structural `id` drives body realization; the optional `lore` field is the
 * model-facing presentation note surfaced to the narrator and image prompts.
 */
export const speciesDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Extra names used by deterministic forge inference before fuzzy fallback. */
  aliases: z.array(z.string().min(1)).readonly().optional(),
  bodyPlanId: z.string().min(1),
  /** Short internal/UI descriptor of what the species *is*. Not surfaced to models. */
  description: z.string().default(""),
  /**
   * Model-facing presentation note (optional). A brief backstory + how this
   * species looks and reads in *our* setting, distinct from the vanilla fantasy
   * default — surfaced to the narrator (engine/scene.ts canonical facts) and the
   * image models (images/prompts.ts) via `speciesPromptPhrase`. Keep it to a
   * sentence or two: it is emitted into prompts under a length budget. Empty ⇒
   * nothing extra is surfaced (the baseline `human` ships empty). Distinct from
   * `description`, which is the internal descriptor.
   */
  lore: z.string().default(""),
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

/**
 * Build one species definition (mirrors `defineAttributeGroup`): parses through
 * the schema so defaults (`description` / `lore` / `attributeRules`) apply and
 * the record is validated at module load. One file per species under
 * `./catalog/`, listed in `./catalog/index.ts` (docs/contracts.md §Body model).
 */
export function defineSpecies(def: z.input<typeof speciesDefinitionSchema>): SpeciesDefinition {
  return speciesDefinitionSchema.parse(def);
}
