import { z } from "zod";
import { provenanceSourceSchema, resolveProvenance } from "../../registry";

/**
 * A stored trait value (docs/developer-notes/personality-and-state.spec.md §3/§8).
 * Reuses the attribute value's provenance shape so `base`/`creation` (forge),
 * `manual` (editor), and later `narrative` (a director-proposed arc) compose with
 * the same last-write-wins precedence — via the shared `resolveProvenance`.
 *
 * `id` is validated loosely (the registry is the source of truth for the canonical
 * set); an unknown id is simply skipped when traits are resolved/surfaced, so a
 * stale value never rejects the whole array. `value` is range-validated by the
 * registry's `parseValue`, not here, to keep the stored shape resilient.
 */
export const traitValueSchema = z.object({
  id: z.string().min(1),
  value: z.number(),
  // Leaf-.catch (resilience §3): a malformed source degrades to the low-precedence
  // "creation" instead of rejecting the whole embedding profile at the JSONB boundary.
  source: provenanceSourceSchema.catch("creation"),
  sourceId: z.string().min(1).optional(),
  note: z.string().optional(),
});

export type TraitValue = z.infer<typeof traitValueSchema>;

/** Effective trait view: overlays shadow base values by id, last-write-wins by precedence. */
export function resolveTraits(base: readonly TraitValue[], overlays: readonly TraitValue[]): TraitValue[] {
  return resolveProvenance(base, overlays);
}

/** Highest-precedence effective value for a trait id (resolved overlays), else 0 (neutral). */
export function effectiveTraitValue(traits: readonly TraitValue[], id: string): number {
  return resolveTraits(traits, []).find((t) => t.id === id)?.value ?? 0;
}
