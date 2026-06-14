import { z } from "zod";

/**
 * Closed list of attribute categories. Extending the vocabulary starts here:
 * add the category, create its group file under ./groups/, register the group
 * in ./groups/index.ts. See docs/contracts.md.
 */
export const attributeCategories = [
  "identity",
  "build",
  "skin",
  "hair",
  "eyes",
  "face",
  "brows",
  "lips",
  "ears",
  "neck",
  "shoulders",
  "chest",
  "waist",
  "hips",
  "arms",
  "hands",
  "legs",
  "feet",
  // Intimate anatomy — gated per character by the body-config (see
  // body/locations intimate.ts: INTIMATE_ATTRIBUTE_CATEGORIES). Attributes in
  // these categories apply only to a character whose body-config switches the
  // matching region on.
  "breasts",
  "vulva",
  "penis",
  "testicles",
  "voice",
  "presentation",
  "movement",
] as const;

export const attributeCategorySchema = z.enum(attributeCategories);
export type AttributeCategory = z.infer<typeof attributeCategorySchema>;
