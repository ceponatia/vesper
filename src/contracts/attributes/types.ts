import { z } from "zod";
import { attributeCategories, attributeCategorySchema, type AttributeCategory } from "./category-ids";

export const attributeKinds = ["physical", "biological", "presentation", "cultural", "condition", "sensory"] as const;
export const attributeKindSchema = z.enum(attributeKinds);
export type AttributeKind = z.infer<typeof attributeKindSchema>;

export const attributeValueTypes = ["enum", "enum_list", "number", "text", "flag"] as const;
export const attributeValueTypeSchema = z.enum(attributeValueTypes);
export type AttributeValueType = z.infer<typeof attributeValueTypeSchema>;

// `inherent` — structural identity the narrative may not rewrite (eye color, gender,
// species, bone structure); only a human author (`manual`) or an explicit supernatural
// transformation (`magic`) may change it (see `overlaySourceMayChange` in value.ts).
// `mutable` — legitimately changes over play (haircut, dye, tattoo, weight). A former
// `temporary` tier was dropped (zero members, no consumer): transient live state rides
// the arousal meter + conditions, not a mutability tier.
export const attributeMutabilities = ["inherent", "mutable"] as const;
export const attributeMutabilitySchema = z.enum(attributeMutabilities);
export type AttributeMutability = z.infer<typeof attributeMutabilitySchema>;

export const attributeEntityKinds = ["character", "item", "location"] as const;
export const attributeEntityKindSchema = z.enum(attributeEntityKinds);
export type AttributeEntityKind = z.infer<typeof attributeEntityKindSchema>;

export type AttributeIdPattern = `${AttributeCategory}.${string}`;

export const attributeIdPatternSchema = z.custom<AttributeIdPattern>(
  (value) => {
    if (typeof value !== "string") return false;
    const dot = value.indexOf(".");
    if (dot <= 0 || dot === value.length - 1) return false;
    const category = value.slice(0, dot);
    const name = value.slice(dot + 1);
    return (
      (attributeCategories as readonly string[]).includes(category) &&
      /^[a-z][a-z0-9_]*$/.test(name)
    );
  },
  { message: "Attribute id must be <category>.<snake_case_name> with a known category, e.g. hair.color" },
);

export const attributeDefinitionSchema = z.object({
  id: attributeIdPatternSchema,
  label: z.string().min(1),
  kind: attributeKindSchema,
  category: attributeCategorySchema,
  valueType: attributeValueTypeSchema,
  description: z.string().min(1),
  mutability: attributeMutabilitySchema,
  allowedValues: z.array(z.string().min(1)).readonly().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().min(1).optional(),
  bodyLocationId: z.string().min(1).optional(),
  appliesToBodyPlans: z.array(z.string().min(1)).readonly().optional(),
  excludesBodyPlans: z.array(z.string().min(1)).readonly().optional(),
  appliesToEntityKinds: z.array(attributeEntityKindSchema).readonly().optional(),
  aliases: z.array(z.string().min(1)).readonly().optional(),
  promptHints: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Core visual attributes are always filled at character creation: the forge
   * asks the model for a best-guess inference, and anything still unset gets a
   * seeded default from allowedValues (enum only). Mark sparingly — every flag
   * here removes a "sparse is correct" attribute.
   */
  coreVisual: z.boolean().optional(),
  /**
   * How this attribute surfaces in a **full-body** image prompt relative to
   * clothing (docs/images.md §Scene images). A waist-up avatar portrait conveys
   * the face and upper body but nothing of the figure below it, so a scene
   * render supplements the reference with body detail:
   * - `"shape"`: silhouette/proportion that reads *through* clothing (breast
   *   size, waist, hips, leg build) — described regardless of coverage.
   * - `"skin"`: surface detail only visible when the region is uncovered
   *   (nipples, leg hair, toenails) — described only when that region is
   *   bare/sheer.
   * Absent ⇒ the attribute is not pulled into the reveal-driven body line (it
   * still flows through the normal appearance summary where applicable). This is
   * consumed by the scene render today; avatars keep strict exposure gating.
   */
  imageReveal: z.enum(["shape", "skin"]).optional(),
  /**
   * Identity anchors are the attributes the forge infers first; they condition
   * the plausible-subset ranges for unset core visuals (docs/authoring.md
   * §Character forge). A flag rather than a hardcoded id list in the prompt
   * builder, so adding an anchor (era? regional origin?) stays a registry data
   * edit. Anchors constrain physical attributes only — never personality,
   * voice, behavior, or role.
   */
  identityAnchor: z.boolean().optional(),
  /**
   * Enum members that are valid vocabulary but must never be chosen as an
   * *automatic* default — neither the forge's tier-3 unconstrained fallback
   * fill (character-forge.ts §fillCoreVisualDefaults) nor the picker's initial
   * value when a human adds the attribute (attribute-helpers.ts
   * §defaultValueFor). The model or a human may still select them explicitly.
   * Used so minor apparent ages exist for background characters while an
   * unspecified character never silently defaults to one.
   */
  autoDefaultExcludes: z.array(z.string().min(1)).readonly().optional(),
  /**
   * Declarative body-config activation — a creation-time SEED, never a lock.
   * When this (enum) attribute takes one of these values at character creation,
   * the listed groups are added to the character's body-config: intimate region
   * groups (`CharacterProfile.intimateRegions`) and/or additive feature groups
   * (`CharacterProfile.bodyFeatures`). Keyed by enum member; unlisted members
   * seed nothing. The body-config is authoritative and fully editable
   * thereafter — so `identity.gender = "male"` seeds penis/testicles but a male
   * character can still be given a vulva in the editor (no anatomy lock). Group
   * ids are validated by `seedBodyConfigFromAttributes` against the body-config
   * vocab (INTIMATE_REGION_GROUPS / FEATURE_GROUPS). The body-config starts
   * empty, so "deactivate X" is simply "no value activates X".
   */
  activatesGroups: z
    .record(
      z.string(),
      z.object({
        intimateRegions: z.array(z.string().min(1)).readonly().optional(),
        bodyFeatures: z.array(z.string().min(1)).readonly().optional(),
      }),
    )
    .optional(),
});

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

/**
 * The definition bundle for one attribute category — one file under
 * `./categories/` per category, built by `defineAttributeGroup`. "Group" here
 * means *this bundle of definitions*, NOT a body section: anatomical sections
 * (head, torso, pelvis …) are body **locations** (`contracts/body/locations`),
 * which attributes link into via `bodyLocationId`.
 */
export interface AttributeGroup {
  category: AttributeCategory;
  definitions: readonly AttributeDefinition[];
}

export function defineAttributeGroup(category: AttributeCategory, definitions: readonly AttributeDefinition[]): AttributeGroup {
  for (const def of definitions) {
    if (def.category !== category) {
      throw new Error(`Attribute ${def.id} declares category ${def.category} inside the ${category} group`);
    }
  }
  return { category, definitions };
}
