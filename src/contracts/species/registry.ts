import type { SpeciesDefinition } from "./types";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";

/**
 * Species catalog. **Scaffolding only:** `human` is the single shipped species.
 * Adding a humanoid variant (elf, orc, …) is a data edit here — the realized-body
 * filter (realize.ts) already consumes the allow/disallow + attribute-rule seams,
 * so no engine change is needed. Novel body plans (tails, wings) are a later phase.
 */
export const speciesCatalog: readonly SpeciesDefinition[] = [
  {
    id: "human",
    label: "Human",
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description:
      "A natural humanoid species with ordinary human anatomy and broad individual variation. Which intimate anatomy a given character has is the per-character body-config, not the species.",
    attributeRules: [],
  },
];

export const DEFAULT_SPECIES_ID = "human";

const byId = new Map<string, SpeciesDefinition>(speciesCatalog.map((s) => [s.id, s]));

export function speciesById(id: string): SpeciesDefinition | undefined {
  return byId.get(id);
}

export function isSpeciesId(id: string): boolean {
  return byId.has(id);
}
