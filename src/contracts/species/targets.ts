import {
  attributeCategories,
  attributeRegistry,
  type AttributeCategory,
  type AttributeDefinition,
} from "../attributes";
import { bodyLocationRegistry } from "../body/locations";

/**
 * Colloquial body-reference resolution (the "look at her face" → fields rule of
 * docs/contracts/body.md §Colloquial body references). When a player references a body region
 * in prose, the game wants the *set* of attributes that region colloquially
 * covers — "face" means face + eyes + brows + lips here, not just `face.*`.
 *
 * This is **deterministic and pure**, deliberately not an LLM call: a body
 * reference resolves through the body-location tree (`expand` the subtree, then
 * gather every attribute bound to those locations via `bodyLocationId`) and the
 * attribute categories, with a small synonym map for colloquialisms that match
 * neither a location nor a category id directly. The result is *structural* —
 * filter it through a character's realized body (`realizeBody`) to drop
 * anatomy the character does not have (see `expandBodyTarget`'s predicate).
 */

function normalize(term: string): string {
  return term.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Colloquial references that match neither a body-location id/label nor a
 * category id — mapped to the locations and/or categories they cover in this
 * game. Natural matches (a location like "face"/"eyes", a category like "hair")
 * need no entry; this only fills the gaps (e.g. "mouth" is not modelled as a
 * location, and "figure" is not a category id).
 */
const COLLOQUIAL_TARGETS: Readonly<
  Record<string, { locations?: readonly string[]; categories?: readonly AttributeCategory[] }>
> = {
  mouth: { categories: ["lips", "teeth"] },
  figure: { categories: ["build"] },
  physique: { categories: ["build"] },
  body: { categories: ["build", "skin"] },
  appearance: { categories: ["build", "skin", "presentation"] },
  looks: { categories: ["build", "skin", "presentation"] },
};

// Term → location id, indexed by both the id and the human label so "upper
// arms" and "upper_arms" both resolve.
const locationByTerm = new Map<string, string>();
for (const loc of bodyLocationRegistry.all) {
  locationByTerm.set(normalize(loc.id), loc.id);
  locationByTerm.set(normalize(loc.label), loc.id);
}

const categoryIds = new Set<string>(attributeCategories);

export interface BodyTargetExpansion {
  /** The normalized term that resolved (location id, category id, or synonym). */
  readonly term: string;
  /** Location subtree ids gathered, when the target resolved to a location. */
  readonly locationIds: readonly string[];
  /** Attribute definitions the target expands to (structural — not yet realized-body filtered). */
  readonly definitions: readonly AttributeDefinition[];
}

/**
 * Resolve one colloquial body reference to the attributes it covers, or
 * `undefined` when the term matches nothing. Definitions are de-duplicated and
 * order-stable (location-subtree order, then category order).
 */
export function resolveBodyTarget(term: string): BodyTargetExpansion | undefined {
  const key = normalize(term);
  let locations: readonly string[] = [];
  let categories: readonly string[] = [];

  const colloquial = COLLOQUIAL_TARGETS[key];
  if (colloquial) {
    locations = colloquial.locations ?? [];
    categories = colloquial.categories ?? [];
  } else if (locationByTerm.has(key)) {
    locations = [locationByTerm.get(key) as string];
  } else if (categoryIds.has(key)) {
    categories = [key];
  } else {
    return undefined;
  }

  const locationIds: string[] = [];
  const definitions: AttributeDefinition[] = [];
  const seen = new Set<string>();
  const push = (def: AttributeDefinition) => {
    if (!seen.has(def.id)) {
      seen.add(def.id);
      definitions.push(def);
    }
  };

  for (const loc of locations) {
    for (const id of bodyLocationRegistry.expand(loc)) {
      locationIds.push(id);
      for (const def of attributeRegistry.forBodyLocation(id)) push(def);
    }
  }
  for (const category of categories) {
    for (const def of attributeRegistry.forCategory(category as AttributeCategory)) push(def);
  }
  return { term: key, locationIds, definitions };
}

/**
 * Like `resolveBodyTarget`, but filters the definitions through a predicate —
 * pass `realizeBody(...).isAttributeApplicable` so a "chest" reference on a
 * flat-chested character doesn't surface breast attributes, etc.
 */
export function expandBodyTarget(
  term: string,
  isApplicable?: (def: AttributeDefinition) => boolean,
): BodyTargetExpansion | undefined {
  const base = resolveBodyTarget(term);
  if (!base || !isApplicable) return base;
  return { ...base, definitions: base.definitions.filter(isApplicable) };
}

// Phrase index for free-text detection: human-readable phrases (label, spaced
// id, synonym, category) longest-first so "upper arms" wins over "arms".
interface TargetPhrase {
  readonly phrase: string;
  readonly term: string;
}
const targetPhrases: readonly TargetPhrase[] = (() => {
  const out: TargetPhrase[] = [];
  for (const key of Object.keys(COLLOQUIAL_TARGETS)) out.push({ phrase: key, term: key });
  for (const loc of bodyLocationRegistry.all) {
    out.push({ phrase: loc.id.replace(/_/g, " "), term: loc.id });
    out.push({ phrase: loc.label.toLowerCase(), term: loc.id });
  }
  for (const category of attributeCategories) out.push({ phrase: category, term: category });
  return out.sort((a, b) => b.phrase.length - a.phrase.length);
})();

/**
 * Scan free text for body references and return their expansions — the
 * deterministic alternative to an attribute-fetch agent. Whole-word, longest
 * phrase first, and a matched span is consumed so "her upper arms" yields
 * `upper_arms` only, not also `arms`. Each resolved target appears once.
 */
export function detectBodyTargets(text: string): BodyTargetExpansion[] {
  let haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const results: BodyTargetExpansion[] = [];
  const claimed = new Set<string>();
  for (const { phrase, term } of targetPhrases) {
    if (claimed.has(term)) continue;
    const needle = ` ${phrase.replace(/[^a-z0-9]+/g, " ")} `;
    const idx = haystack.indexOf(needle);
    if (idx === -1) continue;
    const expansion = resolveBodyTarget(term);
    if (!expansion) continue;
    results.push(expansion);
    claimed.add(term);
    // Consume the matched span (keep its bounding spaces) so a shorter phrase
    // contained in it can't also match.
    haystack = `${haystack.slice(0, idx + 1)}${" ".repeat(needle.length - 2)}${haystack.slice(idx + needle.length - 1)}`;
  }
  return results;
}
