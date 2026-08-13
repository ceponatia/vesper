import type { BodyLocation } from "./types";

/**
 * Additive humanoid feature groups. Unlike intimate region groups, these are
 * visible, non-explicit morphology: a character has them only when their
 * bodyFeatures list switches the group on. Species may supply defaults, but the
 * stored character config remains overridable.
 */
export const FEATURE_GROUPS = ["wings", "horns", "tail"] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export function isFeatureGroup(value: string): value is FeatureGroup {
  return (FEATURE_GROUPS as readonly string[]).includes(value);
}

/**
 * Feature attribute categories. Every group here should have at least one
 * feature-tagged body location and its descriptive attributes should bind to
 * that location so realizeBody can gate them consistently.
 */
export const FEATURE_ATTRIBUTE_CATEGORIES = ["wings", "horns", "tail"] as const;
export type FeatureAttributeCategory = (typeof FEATURE_ATTRIBUTE_CATEGORIES)[number];

export function isFeatureAttributeCategory(category: string): category is FeatureAttributeCategory {
  return (FEATURE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Additive features on the humanoid plan. These are not wardrobe slots in v1:
 * clothes do not cover them through the normal coverage editor, and feature
 * accommodation such as tail-holes or wing-slits is a later wardrobe pass.
 */
export const humanoidFeatureLocations: readonly BodyLocation[] = [
  { id: "horns", label: "horns", parentId: "head", coverageRelevant: false, featureGroup: "horns" },
  { id: "wings", label: "wings", parentId: "back", coverageRelevant: false, featureGroup: "wings" },
  { id: "tail", label: "tail", parentId: "pelvis", coverageRelevant: false, featureGroup: "tail" },
];
