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
 * The **anus** is deliberately NOT here: it is universal anatomy present on every
 * realized body (it carries no `intimateGroup`, so the filter never gates it
 * out), not a per-character toggle. It is still moderation-sensitive — it lives
 * in `intimate.ts` and is exposure-gated like any below-waist region — it simply
 * isn't something the author switches on or off.
 */
export const INTIMATE_REGION_GROUPS = ["breasts", "vulva", "penis", "testicles"] as const;
export type IntimateRegionGroup = (typeof INTIMATE_REGION_GROUPS)[number];

export function isIntimateRegionGroup(value: string): value is IntimateRegionGroup {
  return (INTIMATE_REGION_GROUPS as readonly string[]).includes(value);
}

/**
 * Attribute categories that are intimate anatomy (a subset of INTIMATE_REGION_GROUPS —
 * "anus" is modelled as a touchable region with no descriptive attributes yet).
 * An attribute in one of these categories is only applicable to a character whose
 * body-config switches the matching group on. A contracts test asserts every entry
 * is a real attribute category.
 */
export const INTIMATE_ATTRIBUTE_CATEGORIES = ["breasts", "vulva", "penis", "testicles"] as const;
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
  // Anus — universal anatomy (no `intimateGroup`, so the realized-body filter
  // always includes it). A touchable, exposure-gated region with no descriptive
  // attributes yet; covered by any garment over `pelvis`.
  { id: "anus", label: "anus", parentId: "pelvis", coverageRelevant: false },
  // Breasts group
  { id: "breasts", label: "breasts", parentId: "chest", coverageRelevant: false, intimateGroup: "breasts" },
  { id: "nipples", label: "nipples", parentId: "breasts", coverageRelevant: false, intimateGroup: "breasts" },
];
