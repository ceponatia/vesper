import { z } from "zod";

/**
 * Shared value provenance for registry-backed scalar systems — character
 * attributes (`contracts/attributes`) and personality traits
 * (`contracts/personality`). Sources are ordered low → high; a higher source
 * wins when two values target the same id. Lifted out of the attribute registry
 * (docs/contracts/attributes.md §Values with provenance) so traits inherit base/creation/manual
 * overlays for free — one last-write-wins implementation, two consumers.
 *
 * Extensible: add a source, slot it into SOURCE_PRECEDENCE, update docs.
 */
export const provenanceSources = [
  "base",
  "creation",
  "narrative",
  "condition",
  "injury",
  "item",
  "magic",
  "environment",
  "manual",
] as const;

export const provenanceSourceSchema = z.enum(provenanceSources);
export type ProvenanceSource = z.infer<typeof provenanceSourceSchema>;

/** Higher wins when two values target the same id. */
export const SOURCE_PRECEDENCE: Record<ProvenanceSource, number> = {
  base: 0,
  creation: 1,
  narrative: 2,
  condition: 3,
  injury: 3,
  item: 3,
  magic: 3,
  environment: 3,
  manual: 4,
};

/** Minimal shape a provenance-resolvable value shares (id + source). */
export interface Provenanced {
  id: string;
  source: ProvenanceSource;
}

/**
 * Effective view: overlays shadow base values by id, last-write-wins by source
 * precedence (ties: later entry wins). Generic over any provenanced value, so
 * attribute values and trait values resolve through this one function.
 */
export function resolveProvenance<T extends Provenanced>(base: readonly T[], overlays: readonly T[]): T[] {
  const effective = new Map<string, T>();
  for (const value of [...base, ...overlays]) {
    const current = effective.get(value.id);
    if (!current || SOURCE_PRECEDENCE[value.source] >= SOURCE_PRECEDENCE[current.source]) {
      effective.set(value.id, value);
    }
  }
  return [...effective.values()];
}
