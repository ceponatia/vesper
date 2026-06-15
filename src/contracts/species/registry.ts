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
    aliases: ["humans"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description:
      "A natural humanoid species with ordinary human anatomy and broad individual variation. Which intimate anatomy a given character has is the per-character body-config, not the species.",
    attributeRules: [],
  },
  {
    id: "succubus",
    label: "Succubus",
    aliases: ["succubi"],
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

export interface InferredSpecies {
  species: SpeciesDefinition;
  matchedTerm: string;
}

const tokenPattern = /[a-z0-9]+/g;

function tokens(value: string): string[] {
  return value.toLowerCase().match(tokenPattern) ?? [];
}

function speciesTerms(species: SpeciesDefinition): string[] {
  return [species.id, species.label, ...(species.aliases ?? [])];
}

function findPhraseStart(haystack: readonly string[], needleText: string): number | undefined {
  const needle = tokens(needleText);
  if (needle.length === 0 || needle.length > haystack.length) return undefined;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return start;
  }
  return undefined;
}

/**
 * Deterministic species inference for forge prompts. It intentionally uses exact
 * token/phrase matches against registry ids, labels, and aliases: "succubus"
 * and "succubi" match; "succubuslike" does not. Feature-bearing species win
 * over the default human record when both are mentioned ("human-passing
 * succubus"), because default human is already the fallback when nothing matches.
 */
export function inferSpeciesFromText(text: string): InferredSpecies | undefined {
  const haystack = tokens(text);
  const matches = speciesCatalog.flatMap((species) =>
    speciesTerms(species).flatMap((term) => {
      const start = findPhraseStart(haystack, term);
      return start === undefined ? [] : [{ species, matchedTerm: term, start }];
    }),
  );
  matches.sort((a, b) => {
    const aDefault = a.species.id === DEFAULT_SPECIES_ID ? 1 : 0;
    const bDefault = b.species.id === DEFAULT_SPECIES_ID ? 1 : 0;
    return aDefault - bDefault || a.start - b.start || b.matchedTerm.length - a.matchedTerm.length;
  });
  const match = matches[0];
  return match ? { species: match.species, matchedTerm: match.matchedTerm } : undefined;
}
