import type { SpeciesDefinition } from "./types";
import { speciesCatalog } from "./catalog";

/**
 * The species catalog now lives one-file-per-species under `./catalog/`; this
 * module derives the lookups from it (mirrors `attributes/registry.ts`). Adding
 * a species is a single new file listed in `./catalog/index.ts`.
 */
export { speciesCatalog };

export const DEFAULT_SPECIES_ID = "human";

const byId = new Map<string, SpeciesDefinition>();
for (const species of speciesCatalog) {
  if (byId.has(species.id)) throw new Error(`Duplicate species id: ${species.id}`);
  byId.set(species.id, species);
}

export function speciesById(id: string): SpeciesDefinition | undefined {
  return byId.get(id);
}

export function isSpeciesId(id: string): boolean {
  return byId.has(id);
}

/**
 * The species phrase surfaced to the narrator and image models. Returns "" for
 * the default species (human is the unmarked baseline — naming it is noise) or
 * an unknown id, otherwise the label with the authored `lore` appended when
 * present. One gate, shared by every prompt consumer (engine/scene.ts,
 * images/prompts.ts) so the surfacing rule stays identical and out of jscpd's
 * way. `lore` ships empty today, so the phrase is label-only until authored.
 */
export function speciesPromptPhrase(id: string): string {
  if (id === DEFAULT_SPECIES_ID) return "";
  const species = byId.get(id);
  if (!species) return "";
  return species.lore ? `${species.label} — ${species.lore}` : species.label;
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
