import type { SpeciesDefinition } from "./types";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";

/**
 * Species catalog. Humanoid variants are data edits here. Feature-bearing
 * species use `defaultFeatureGroups`; true structural body plans are a later
 * phase.
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
  {
    id: "succubus",
    label: "Succubus",
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description:
      "A humanoid fantasy species whose default morphology includes wings, horns, and a tail. These are defaults, not hard requirements; bodyFeatures may override them per character.",
    defaultFeatureGroups: ["wings", "horns", "tail"],
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
