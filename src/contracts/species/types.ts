import { z } from "zod";
import { attributeRuleSchema } from "../rules/attribute-rule";

/**
 * A heritage — an optional refinement *within* a species (a Wood/Dark Elf inside
 * Elf, a Pixie/Sprite inside Faerie). It is a pure overlay on its parent species:
 * it never names a body plan or changes body locations (decision: heritage is
 * additive-only and stays inside the species' body plan). It may add feature
 * groups, override attribute rules per `attributeId` (heritage wins), and carry
 * its own model-facing `appearance` (combined with the species' look) and `lore`
 * (replaces the species' culture note). Realized via `realizeBody`'s `heritageId`
 * and surfaced through `speciesAppearancePhrase` / `speciesLorePhrase`.
 */
export const heritageDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Extra names used by deterministic forge inference (e.g. "drow" → dark_elf). */
  aliases: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Heritage-specific visual note, **combined** with the species' `appearance`
   * for the image models + forge (the species gives the base look, the heritage
   * the specifics). Empty ⇒ only the species look is surfaced.
   */
  appearance: z.string().default(""),
  /**
   * Heritage-specific cultural note for the narrator; **replaces** the species'
   * `lore` when present (heritage culture usually stands on its own). Empty ⇒
   * falls back to the species' lore.
   */
  lore: z.string().default(""),
  /** Additive feature groups switched on **on top of** the species defaults. */
  defaultFeatureGroups: z.array(z.string().min(1)).readonly().optional(),
  /** Per-attribute rules that **override** the species rule for the same `attributeId`. */
  attributeRules: z.array(attributeRuleSchema).readonly().default([]),
});

export type HeritageDefinition = z.infer<typeof heritageDefinitionSchema>;

/**
 * A species — a constrained variant of a body plan (ported from aionchat). It
 * names the body plan it uses, may add or remove body locations from that plan,
 * and carries per-attribute rules. Humanoid variants are data additions when
 * their body features already exist, and novel body plans are a later phase.
 * The structural `id` drives body realization; the optional model-facing notes
 * split by audience — `appearance` (generic visual look → image models + forge)
 * and `lore` (culture/identity → narrator). Optional `heritages` refine the
 * species further (Wood/Dark Elf) as additive overlays.
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
   * Generic, image-safe visual description of the species' default morphology —
   * what *any* member looks like (pointed ears, a greenish skin cast, wings /
   * horns / tail, broad stature), NOT one character's specific attribute values.
   * Surfaced to the image models (images/prompts.ts) and the character forge
   * (authoring/character-forge.ts) via `speciesAppearancePhrase`; the forge turns
   * this generic look into concrete per-character attribute values. Keep it to a
   * sentence — it shares the image prompt's length budget. Empty ⇒ only the label
   * is surfaced (human, the unmarked baseline, ships empty).
   */
  appearance: z.string().default(""),
  /**
   * Model-facing cultural/identity note (optional): a brief backstory + how this
   * species reads socially in *our* setting (temperament, standing, relations),
   * distinct from the vanilla fantasy default — surfaced to the narrator
   * (engine/scene.ts canonical facts) via `speciesLorePhrase`. Physical looks
   * belong in `appearance`, not here. Keep it to a few sentences: it is emitted
   * into prompts under a length budget. Empty ⇒ nothing extra is surfaced (the
   * baseline `human` ships empty). Distinct from `description`, the internal
   * descriptor.
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
  /**
   * Optional refinements within this species (Wood/Dark Elf, Pixie/Sprite). A
   * character picks at most one via `heritageId`; it overlays the species. Empty
   * ⇒ the species has no sub-groups.
   */
  heritages: z.array(heritageDefinitionSchema).readonly().default([]),
});

export type SpeciesDefinition = z.infer<typeof speciesDefinitionSchema>;

/**
 * Build one species definition (mirrors `defineAttributeGroup`): parses through
 * the schema so defaults (`description` / `appearance` / `lore` / `attributeRules` / `heritages`) apply and
 * the record is validated at module load. One file per species under
 * `./catalog/`, listed in `./catalog/index.ts` (docs/contracts/body.md §Body model).
 */
export function defineSpecies(def: z.input<typeof speciesDefinitionSchema>): SpeciesDefinition {
  return speciesDefinitionSchema.parse(def);
}
