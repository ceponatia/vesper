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
    aliases: ["humans", "humanlike", "human-like"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description:
      "A natural humanoid species with ordinary human anatomy and broad individual variation. Which intimate anatomy a given character has is the per-character body-config, not the species.",
    attributeRules: [],
  },
  {
    id: "elf",
    label: "Elf",
    aliases: ["elves", "elven", "elfin", "elf-like", "half-elf", "half elf"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description: "A humanoid fantasy species with elven presentation. Specific traits, such as pointed ears, remain authored as attributes.",
    attributeRules: [],
  },
  {
    id: "dwarf",
    label: "Dwarf",
    aliases: ["dwarves", "dwarven", "dwarf-like"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description: "A humanoid fantasy species with dwarven presentation. Specific build, hair, and cultural traits remain authored as attributes.",
    attributeRules: [],
  },
  {
    id: "gnome",
    label: "Gnome",
    aliases: ["gnomes", "gnomish", "gnome-like"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description: "A humanoid fantasy species with gnomish presentation. Specific stature and style remain authored as attributes.",
    attributeRules: [],
  },
  {
    id: "faerie",
    label: "Faerie",
    aliases: ["faeries", "faery", "fae", "fairy", "fairies", "fair folk"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description:
      "A humanoid fantasy species whose default morphology includes wings. These are defaults, not hard requirements; bodyFeatures may override them per character.",
    defaultFeatureGroups: ["wings"],
    attributeRules: [],
  },
  {
    id: "orc",
    label: "Orc",
    aliases: ["orcs", "orcish", "ork", "orks", "orkish", "orc-like"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description: "A humanoid fantasy species with orcish presentation. Specific build, tusks, and coloration remain authored as attributes.",
    attributeRules: [],
  },
  {
    id: "goblin",
    label: "Goblin",
    aliases: ["goblins", "goblin-like", "goblinoid"],
    bodyPlanId: DEFAULT_BODY_PLAN_ID,
    description: "A humanoid fantasy species with goblin presentation. Specific stature, ears, and features remain authored as attributes.",
    attributeRules: [],
  },
  {
    id: "succubus",
    label: "Succubus",
    aliases: ["succubi", "succuba", "succubae", "succubus-like"],
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
  matchedText: string;
  matchKind: "exact" | "fuzzy";
}

const tokenPattern = /[a-z0-9]+/g;

function tokens(value: string): string[] {
  return value.toLowerCase().match(tokenPattern) ?? [];
}

function speciesTerms(species: SpeciesDefinition): string[] {
  return [species.id, species.label, ...(species.aliases ?? [])];
}

function fuzzySpeciesTerms(species: SpeciesDefinition): string[] {
  return [species.id, species.label];
}

interface SpeciesMatch {
  species: SpeciesDefinition;
  matchedTerm: string;
  matchedText: string;
  matchKind: "exact" | "fuzzy";
  start: number;
  distance: number;
}

function findPhraseStart(haystack: readonly string[], needleText: string): number | undefined {
  const needle = tokens(needleText);
  if (needle.length === 0 || needle.length > haystack.length) return undefined;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return start;
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const left = next[j - 1] ?? Number.POSITIVE_INFINITY;
      const up = prev[j] ?? Number.POSITIVE_INFINITY;
      const diagonal = prev[j - 1] ?? Number.POSITIVE_INFINITY;
      next[j] = Math.min(left + 1, up + 1, diagonal + cost);
    }
    prev = next;
  }
  return prev[b.length] ?? Number.POSITIVE_INFINITY;
}

function maxFuzzyDistance(term: string, token: string): number {
  if (term.length < 5) return 0;
  if (term.charAt(0) !== token.charAt(0)) return 0;
  if (Math.abs(term.length - token.length) > 1) return 0;
  if (term.length !== token.length) return term.length >= 6 ? 1 : 0;
  return 1;
}

function isAdjacentTransposition(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a.charAt(i) !== b.charAt(i)) diffs.push(i);
    if (diffs.length > 2) return false;
  }
  const [first, second] = diffs;
  return first !== undefined && second === first + 1 && a.charAt(first) === b.charAt(second) && a.charAt(second) === b.charAt(first);
}

function findBestFuzzyToken(haystack: readonly string[], needleText: string): { start: number; distance: number } | undefined {
  const needle = tokens(needleText);
  if (needle.length !== 1) return undefined;
  const [term] = needle;
  if (!term) return undefined;
  let best: { start: number; distance: number } | undefined;
  for (let start = 0; start < haystack.length; start++) {
    const token = haystack[start];
    if (!token) continue;
    const max = maxFuzzyDistance(term, token);
    if (max === 0) continue;
    const rawDistance = editDistance(term, token);
    const distance = rawDistance > max && isAdjacentTransposition(term, token) ? 1 : rawDistance;
    if (distance === 0 || distance > max) continue;
    if (!best || distance < best.distance || (distance === best.distance && start < best.start)) {
      best = { start, distance };
    }
  }
  return best;
}

function speciesMatches(haystack: readonly string[], species: SpeciesDefinition): SpeciesMatch[] {
  return speciesTerms(species).flatMap((term): SpeciesMatch[] => {
    const exactStart = findPhraseStart(haystack, term);
    if (exactStart !== undefined) {
      const exact: SpeciesMatch = {
        species,
        matchedTerm: term,
        matchedText: tokens(term).join(" "),
        matchKind: "exact",
        start: exactStart,
        distance: 0,
      };
      return [exact];
    }
    const fuzzy = fuzzySpeciesTerms(species).includes(term) ? findBestFuzzyToken(haystack, term) : undefined;
    if (!fuzzy) return [];
    const matchedText = haystack[fuzzy.start];
    if (!matchedText) return [];
    const fuzzyMatch: SpeciesMatch = {
      species,
      matchedTerm: term,
      matchedText,
      matchKind: "fuzzy",
      start: fuzzy.start,
      distance: fuzzy.distance,
    };
    return [fuzzyMatch];
  });
}

/**
 * Deterministic species inference for forge prompts. It uses exact token/phrase
 * matches first, then conservative edit-distance matching for single-token terms.
 * Feature-bearing/non-default species win over the default human record when both
 * are mentioned ("human-passing succubus"), because default human is already the
 * fallback when nothing matches.
 */
export function inferSpeciesFromText(text: string): InferredSpecies | undefined {
  const haystack = tokens(text);
  const matches = speciesCatalog.flatMap((species) => speciesMatches(haystack, species));
  matches.sort((a, b) => {
    const aDefault = a.species.id === DEFAULT_SPECIES_ID ? 1 : 0;
    const bDefault = b.species.id === DEFAULT_SPECIES_ID ? 1 : 0;
    const aExact = a.matchKind === "exact" ? 0 : 1;
    const bExact = b.matchKind === "exact" ? 0 : 1;
    return (
      aDefault - bDefault ||
      aExact - bExact ||
      a.distance - b.distance ||
      a.start - b.start ||
      b.matchedTerm.length - a.matchedTerm.length
    );
  });
  const match = matches[0];
  return match
    ? { species: match.species, matchedTerm: match.matchedTerm, matchedText: match.matchedText, matchKind: match.matchKind }
    : undefined;
}
