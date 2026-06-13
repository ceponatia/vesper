import { z } from "zod";
import { attributeCategories, attributeCategorySchema, type AttributeCategory } from "./categories";

export const attributeKinds = ["physical", "biological", "presentation", "cultural", "condition", "sensory"] as const;
export const attributeKindSchema = z.enum(attributeKinds);
export type AttributeKind = z.infer<typeof attributeKindSchema>;

export const attributeValueTypes = ["enum", "enum_list", "number", "text", "flag"] as const;
export const attributeValueTypeSchema = z.enum(attributeValueTypes);
export type AttributeValueType = z.infer<typeof attributeValueTypeSchema>;

export const attributeMutabilities = ["inherent", "mutable", "temporary"] as const;
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
   * Identity anchors are the attributes the forge infers first; they condition
   * the plausible-subset ranges for unset core visuals (docs/authoring.md
   * §Character forge). A flag rather than a hardcoded id list in the prompt
   * builder, so adding an anchor (era? regional origin?) stays a registry data
   * edit. Anchors constrain physical attributes only — never personality,
   * voice, behavior, or role.
   */
  identityAnchor: z.boolean().optional(),
});

export type AttributeDefinition = z.infer<typeof attributeDefinitionSchema>;

/** One attribute group per category; the group owns its definitions. */
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
