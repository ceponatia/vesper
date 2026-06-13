import { z } from "zod";
import {
  bodyLocationRegistry,
  characterProfileSchema,
  itemDefinitionSchema,
  itemKindSchema,
} from "@/contracts";

/**
 * Request-body schemas for the library CRUD routes. PATCH bodies are partial
 * views of the same contracts the columns are typed with — a PATCH can never
 * write a value the contract would not accept.
 */

export const nameSchema = z.string().trim().min(1).max(200);
export const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(50);

/**
 * All-optional view of an object schema with `.default()`s stripped. Zod 4
 * fires defaults even through `.partial()`, which would make a PATCH merge
 * (`{ ...current, ...patch }`) silently reset unsent fields to their
 * defaults — exactly the wrong semantics for partial updates.
 */
export function partialWithoutDefaults<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodType<Partial<z.infer<z.ZodObject<T>>>> {
  const entries = Object.entries(schema.shape).map(([key, value]) => {
    let inner = value as z.ZodType;
    while (inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType;
    return [key, inner.optional()];
  });
  return z.object(Object.fromEntries(entries)) as unknown as z.ZodType<Partial<z.infer<z.ZodObject<T>>>>;
}

export const ambientSchema = z.object({
  scent: z.string().max(500).optional(),
  sound: z.string().max(500).optional(),
  light: z.string().max(500).optional(),
});

// --- characters --------------------------------------------------------------

// Strict: an unconverted draft shape posted here must fail loudly, never save
// with fields silently stripped (docs/authoring.md §Saving drafts).
export const characterCreateSchema = z
  .object({
    name: nameSchema,
    profile: characterProfileSchema.default(() => characterProfileSchema.parse({})),
    tags: tagsSchema.default([]),
    /**
     * Forge outfit suggestions (docs/authoring.md): materialized as library
     * items on save — reused by name when one already exists — and appended to
     * profile.defaultOutfit.
     */
    suggestedItems: z.array(itemDefinitionSchema).max(50).default([]),
  })
  .strict();
export type CharacterCreateBody = z.infer<typeof characterCreateSchema>;

export const characterPatchSchema = z.object({
  name: nameSchema.optional(),
  profile: partialWithoutDefaults(characterProfileSchema).optional(),
  tags: tagsSchema.optional(),
});
export type CharacterPatchBody = z.infer<typeof characterPatchSchema>;

// --- locations ---------------------------------------------------------------

/** Spatial size class; mirrors the locations.scale column and contracts/perception/proximity. */
export const locationScaleSchema = z.enum(["intimate", "room", "hall", "open", "expanse"]);
const areaSchema = z.string().trim().max(100);

export const locationCreateSchema = z.object({
  name: nameSchema,
  description: z.string().default(""),
  ambient: ambientSchema.default({}),
  tags: tagsSchema.default([]),
  scale: locationScaleSchema.default("room"),
  area: areaSchema.optional(),
});
export type LocationCreateBody = z.infer<typeof locationCreateSchema>;

export const locationPatchSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().optional(),
  ambient: ambientSchema.optional(),
  tags: tagsSchema.optional(),
  scale: locationScaleSchema.optional(),
  /** null clears the area label. */
  area: areaSchema.nullable().optional(),
  /** The desired set of connected library-location ids (undirected); reconciled server-side. */
  links: z.array(z.string().min(1)).optional(),
});
export type LocationPatchBody = z.infer<typeof locationPatchSchema>;

// --- items -------------------------------------------------------------------

/** The slice of ItemDefinition stored in items.definition (extras only). */
export const itemExtrasSchema = itemDefinitionSchema.pick({
  coverage: true,
  category: true,
  subtype: true,
  layer: true,
  opacity: true,
  sensory: true,
  fields: true,
});
export type ItemExtras = z.infer<typeof itemExtrasSchema>;

export function emptyItemExtras(): ItemExtras {
  return itemExtrasSchema.parse({});
}

export const itemCreateSchema = z.object({
  name: nameSchema,
  kind: itemKindSchema,
  description: z.string().default(""),
  tags: tagsSchema.default([]),
  definition: itemExtrasSchema.default(() => emptyItemExtras()),
});
export type ItemCreateBody = z.infer<typeof itemCreateSchema>;

export const itemPatchSchema = z.object({
  name: nameSchema.optional(),
  kind: itemKindSchema.optional(),
  description: z.string().optional(),
  tags: tagsSchema.optional(),
  definition: partialWithoutDefaults(itemExtrasSchema).optional(),
});
export type ItemPatchBody = z.infer<typeof itemPatchSchema>;

/** Unknown body-location ids in a coverage list (registry-validated at save). */
export function invalidCoverageIds(coverage: readonly string[]): string[] {
  return coverage.filter((id) => bodyLocationRegistry.byId(id.trim().toLowerCase()) === undefined);
}
