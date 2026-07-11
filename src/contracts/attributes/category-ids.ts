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
  "nose",
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

/**
 * The attribute categories the character sheet's "Personality" tab owns (the
 * "Attributes" tab renders every other non-intimate category) — behavioral
 * texture rather than physical body. One flat `attributes` array backs both
 * tabs; this split is shared by the editor tabs and the sheet-forge scopes
 * (character-sheet-forge.plan.md), so it lives with the category vocabulary.
 */
export const PERSONALITY_ATTRIBUTE_CATEGORIES = ["voice", "presentation", "movement"] as const satisfies readonly AttributeCategory[];

const PERSONALITY_CATEGORY_SET = new Set<string>(PERSONALITY_ATTRIBUTE_CATEGORIES);

/** True for a Personality-tab category id ("voice" | "presentation" | "movement"). */
export function isPersonalityAttributeCategory(category: string): boolean {
  return PERSONALITY_CATEGORY_SET.has(category);
}

/** True when an attribute id (`<category>.<name>`) belongs to a Personality-tab category. */
export function isPersonalityAttributeId(id: string): boolean {
  return isPersonalityAttributeCategory(id.split(".", 1)[0] ?? "");
}
