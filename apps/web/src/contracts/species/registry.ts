import type { HeritageDefinition, SpeciesDefinition } from "./types";
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
 * The heritage/subtype record within a species. An absent or unknown id falls
 * back to the species' `defaultHeritageId` when one exists; species without a
 * default retain the original bare-species behavior.
 */
export function heritageFor(speciesId: string, heritageId: string | undefined): HeritageDefinition | undefined {
  const species = byId.get(speciesId);
  if (!species) return undefined;
  const explicit = heritageId ? species.heritages.find((h) => h.id === heritageId) : undefined;
  if (explicit) return explicit;
  return species.defaultHeritageId
    ? species.heritages.find((h) => h.id === species.defaultHeritageId)
    : undefined;
}

/** The heritages a species offers (empty array for a species with none). */
export function heritagesForSpecies(speciesId: string): readonly HeritageDefinition[] {
  return byId.get(speciesId)?.heritages ?? [];
}

/**
 * The species **name only** for image prompts (2026-06-19): the label (the
 * heritage label when a `heritageId` resolves), with the authored generic
 * `appearance` description deliberately **omitted**. An image prompt only needs
 * to name the species ("Succubus") — the morphology that the `appearance` text
 * describes (wings, horns, tail) is already carried by the character's feature
 * attributes, so repeating it is redundant and bloats the prompt. Same
 * ""/human-is-unmarked rules as `speciesLorePhrase`. This is the ONLY species
 * phrase image prompts use; the authored generic `appearance` reaches the
 * character forge through `speciesForgeDescriptor`, which reads
 * `species.appearance` directly.
 */
export function speciesLabelPhrase(speciesId: string, heritageId?: string): string {
  if (speciesId === DEFAULT_SPECIES_ID) return "";
  const species = byId.get(speciesId);
  if (!species) return "";
  return heritageFor(speciesId, heritageId)?.label ?? species.label;
}

/**
 * The species *cultural/identity* phrase for the narrator's canonical facts: the
 * label with the authored `lore` appended when present. Same "" / label-only
 * rules as `speciesLabelPhrase`. When a `heritageId` resolves, its label
 * replaces the species label and its `lore` **replaces** the species' (falling
 * back to the species' lore when the heritage has none) — the two split the old
 * single phrase by audience so neither consumer is fed text meant for the other.
 */
export function speciesLorePhrase(speciesId: string, heritageId?: string): string {
  if (speciesId === DEFAULT_SPECIES_ID) return "";
  const species = byId.get(speciesId);
  if (!species) return "";
  const heritage = heritageFor(speciesId, heritageId);
  const label = heritage?.label ?? species.label;
  const lore = (heritage?.lore.trim() ? heritage.lore : "") || species.lore;
  return lore ? `${label} — ${lore}` : label;
}

/**
 * The species/heritage *intimate disposition* note for the narrator, surfaced ONLY at
 * the intimate exposure tier (`buildIntimateDispositionBlock`): how members of this
 * kind tend to read as lovers. Returns the resolved **bare** text — unlike
 * `speciesLabelPhrase` / `speciesLorePhrase` it carries **no `Label — ` prefix**,
 * because the narrator block already names the character. "" for the default species
 * (human, the unmarked baseline), an unknown id, or an unauthored note. When a
 * `heritageId` resolves, its note **replaces** the species' (falling back to the
 * species' when the heritage has none) — the same merge rule `lore` uses. The
 * per-character `profile.intimacy` is appended on top of this by the block builder,
 * not here (the two layers merge at the surfacing site).
 */
export function speciesIntimacyNote(speciesId: string, heritageId?: string): string {
  if (speciesId === DEFAULT_SPECIES_ID) return "";
  const species = byId.get(speciesId);
  if (!species) return "";
  const heritage = heritageFor(speciesId, heritageId);
  const note = (heritage?.intimacy.trim() ? heritage.intimacy : "") || species.intimacy;
  return note.trim();
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
  // Heritage names also resolve their parent species, so "a drow ranger" infers
  // the elf species (then inferHeritageFromText narrows it to dark_elf). Exact
  // only — fuzzy stays on the species id/label (fuzzySpeciesTerms).
  return [
    species.id,
    species.label,
    ...(species.aliases ?? []),
    ...species.heritages.flatMap((h) => [h.id, h.label, ...(h.aliases ?? [])]),
  ];
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

/**
 * Deterministic heritage inference for forge prompts, scoped to a resolved
 * species: the first of its heritages whose id/label/alias appears as an exact
 * token phrase in the text ("dark elf" / "drow" → dark_elf). Exact-only — no
 * fuzzy fallback — since a heritage is a narrow refinement and a false positive
 * would silently rewrite the character's look. Undefined when the species has no
 * heritages or none is named.
 */
export function inferHeritageFromText(speciesId: string, text: string): HeritageDefinition | undefined {
  const heritages = byId.get(speciesId)?.heritages ?? [];
  if (heritages.length === 0) return undefined;
  const haystack = tokens(text);
  return heritages.find((h) =>
    [h.id, h.label, ...(h.aliases ?? [])].some((term) => findPhraseStart(haystack, term) !== undefined),
  );
}
