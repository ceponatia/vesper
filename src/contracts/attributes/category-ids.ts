import { z } from "zod";

/**
 * Closed list of attribute category ids — the `<category>.<name>` id prefix and
 * the taxonomy key. Each id maps to one file under ./categories/ that defines
 * the category's attributes (its definition bundle, built by
 * `defineAttributeGroup`). Extending the vocabulary starts here: add the
 * category id, create its file under ./categories/, register it in
 * ./categories/index.ts. See docs/contracts/attributes.md.
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
  "teeth",
  "ears",
  "horns",
  "neck",
  "shoulders",
  "chest",
  "wings",
  "waist",
  "hips",
  "tail",
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
