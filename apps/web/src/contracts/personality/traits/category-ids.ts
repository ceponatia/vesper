import { z } from "zod";

/**
 * Closed list of personality-trait category ids — the `<category>.<name>` id
 * prefix and the grouping key. Deliberately small; `intimate` is the fenced,
 * exposure-gated subset (the mechanical arousal/jealousy drivers), mirroring
 * `attributes/categories/intimate`.
 */
export const traitCategories = ["temperament", "social", "intimate"] as const;
export const traitCategorySchema = z.enum(traitCategories);
export type TraitCategory = z.infer<typeof traitCategorySchema>;

/** Categories whose trait bands surface only at the intimate exposure tier. */
export const INTIMATE_TRAIT_CATEGORY: TraitCategory = "intimate";
