import type { BodyLocation } from "./types";

/**
 * Intimate region groups — the vocabulary of the per-character **body-config**
 * (CharacterProfile.intimateRegions). A character "has" an intimate region only
 * when its group id is listed there; the realized-body filter (species/realize.ts)
 * reads this to gate both intimate body locations (via BodyLocation.intimateGroup)
 * and intimate attributes (via INTIMATE_ATTRIBUTE_CATEGORIES). An empty body-config
 * means no *configurable* intimate anatomy — exactly the engine's behavior before
 * this existed.
 *
 * The **anus** and **perineum** are deliberately NOT here: they are universal
 * anatomy present on every realized body (they carry no `intimateGroup`, so the
 * filter never gates them out), not per-character toggles. They are still
 * moderation-sensitive — they live in `intimate.ts` and are exposure-gated like
 * any below-waist region (their categories are in INTIMATE_ATTRIBUTE_CATEGORIES)
 * — they simply aren't something the author switches on or off.
 */
export const INTIMATE_REGION_GROUPS = ["breasts", "vulva", "penis", "testicles"] as const;
export type IntimateRegionGroup = (typeof INTIMATE_REGION_GROUPS)[number];

export function isIntimateRegionGroup(value: string): value is IntimateRegionGroup {
  return (INTIMATE_REGION_GROUPS as readonly string[]).includes(value);
}

/**
 * Attribute categories treated as intimate for **prompt moderation + exposure
 * gating** — withheld from chat unless the turn's focus targets the region, and
 * from images unless the caller opts in (`allowIntimate`) and the region reads
 * exposed. This is a SUPERSET of the toggleable `INTIMATE_REGION_GROUPS`:
 *
 *   - the four region groups (breasts · vulva · penis · testicles), which are
 *     body-config-gated (present only when the character switches the region on), plus
 *   - the **universal** intimate categories (anus · perineum), present on every
 *     realized body (like buttocks) yet still exposure-sensitive.
 *
 * The distinction matters at exactly one seam: body-config gating keys off
 * `isIntimateRegionGroup` (a toggle), NOT this set (see species/realize.ts), so
 * the universal categories are never gated out. A contracts test asserts every
 * entry is a real attribute category and that the region groups are ⊆ this set.
 */
export const INTIMATE_ATTRIBUTE_CATEGORIES = ["breasts", "vulva", "penis", "testicles", "anus", "perineum"] as const;
export type IntimateAttributeCategory = (typeof INTIMATE_ATTRIBUTE_CATEGORIES)[number];

export function isIntimateAttributeCategory(category: string): category is IntimateAttributeCategory {
  return (INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Explicit intimate anatomy, slotted under the everyday `groin` / `pelvis` /
 * `chest` parents. `coverageRelevant: false` — these are not garment slots; a
 * bottom covering `pelvis` (or a bra covering `chest`) already covers them via
 * `registry.expand`, so they never appear in the wardrobe coverage editor.
 * Each gated region carries an `intimateGroup` so the realized-body filter can
 * include or omit the whole sub-tree per character; the **anus** alone omits it
 * and is therefore universal (present on every body — see INTIMATE_REGION_GROUPS).
 */
export const humanoidIntimateLocations: readonly BodyLocation[] = [
  // Vulva group (external + internal)
  { id: "mons", label: "mons pubis", parentId: "groin", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "vulva", label: "vulva", parentId: "groin", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "labia_majora", label: "labia majora", parentId: "vulva", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "labia_minora", label: "labia minora", parentId: "vulva", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "clitoris", label: "clitoris", parentId: "vulva", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "vestibule", label: "vulvar vestibule", parentId: "vulva", coverageRelevant: false, intimateGroup: "vulva" },
  { id: "vagina", label: "vagina", parentId: "groin", coverageRelevant: false, intimateGroup: "vulva" },
  // Penis group
  { id: "penis", label: "penis", parentId: "groin", coverageRelevant: false, intimateGroup: "penis" },
  // Testicles group
  { id: "testicles", label: "testicles", parentId: "groin", coverageRelevant: false, intimateGroup: "testicles" },
  // Anus + perineum — universal anatomy (no `intimateGroup`, so the realized-body
  // filter always includes them). Touchable, exposure-gated regions; covered by
  // any garment over `pelvis` (coverageRelevant: false → covered via `expand`).
  // Their descriptive attributes are the universal `anus` / `perineum` categories,
  // exposure-gated in prompts via INTIMATE_ATTRIBUTE_CATEGORIES.
  { id: "anus", label: "anus", parentId: "pelvis", coverageRelevant: false },
  { id: "perineum", label: "perineum", parentId: "pelvis", coverageRelevant: false },
  // Breasts group
  { id: "breasts", label: "breasts", parentId: "chest", coverageRelevant: false, intimateGroup: "breasts" },
  { id: "nipples", label: "nipples", parentId: "breasts", coverageRelevant: false, intimateGroup: "breasts" },
];
