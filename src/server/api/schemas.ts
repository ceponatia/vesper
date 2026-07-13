import { z } from "zod";
import {
  ambientSchema,
  bodyLocationRegistry,
  characterProfileObjectSchema,
  characterProfileSchema,
  clothingLayerSchema,
  itemDefinitionSchema,
  itemKindSchema,
  socialReactionCardExtrasSchema,
} from "@/contracts";

/**
 * Request-body schemas for the library CRUD routes. PATCH bodies are partial
 * views of the same contracts the columns are typed with — a PATCH can never
 * write a value the contract would not accept.
 */

export const nameSchema = z.string().trim().min(1).max(200);
export const tagsSchema = z.array(z.string().trim().min(1).max(60)).max(50);

/**
 * Cross-account share scope for a shareable entity (auth.plan.md) — `public`
 * makes it discoverable + copyable, `private` is owner-only. Headroom for an
 * `unlisted` tier later. Distinct from lore-chunk/link visibility (those are
 * in-world concepts on different schemas).
 */
export const visibilitySchema = z.enum(["private", "public"]);
export type Visibility = z.infer<typeof visibilitySchema>;

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

// Canonical ambient lives in contracts (world/location); re-exported so the
// library route schemas keep importing it from here.
export { ambientSchema };

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
     * the default outfit preset (`profile.outfits[0]`, ux-improvements slice 8).
     */
    suggestedItems: z.array(itemDefinitionSchema).max(50).default([]),
  })
  .strict();
export type CharacterCreateBody = z.infer<typeof characterCreateSchema>;

export const characterPatchSchema = z.object({
  name: nameSchema.optional(),
  // The raw object shape — partial() needs a ZodObject; the legacy-outfit lift
  // only matters when READING stored rows, and a PATCH merges over a lifted read.
  profile: partialWithoutDefaults(characterProfileObjectSchema).optional(),
  tags: tagsSchema.optional(),
  /** Publish/un-publish toggle (auth.plan.md). */
  visibility: visibilitySchema.optional(),
  /** Persisted character-chat narrator pick (a NARRATIVE_MODELS id); empty ⇒ the chat default. */
  chatModel: z.string().trim().max(120).optional(),
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
  /** Publish/un-publish toggle (auth.plan.md). */
  visibility: visibilitySchema.optional(),
});
export type LocationPatchBody = z.infer<typeof locationPatchSchema>;

// --- items -------------------------------------------------------------------

/** The slice of ItemDefinition stored in items.definition (extras only). */
export const itemExtrasSchema = itemDefinitionSchema.pick({
  coverage: true,
  category: true,
  subtype: true,
  wearer: true,
  color: true,
  layer: true,
  opacity: true,
  sensory: true,
  fields: true,
});
export type ItemExtras = z.infer<typeof itemExtrasSchema>;

export function emptyItemExtras(): ItemExtras {
  return itemExtrasSchema.parse({});
}

export const itemCreateSchema = z
  .object({
    name: nameSchema,
    kind: itemKindSchema,
    description: z.string().default(""),
    tags: tagsSchema.default([]),
    definition: itemExtrasSchema.default(() => emptyItemExtras()),
  })
  // Clothing is never layerless: default new pieces to 1 · base so the editor
  // opens with a valid layer (a category template or the player adjusts it).
  .transform((body) =>
    body.kind === "clothing" && body.definition.layer === undefined
      ? { ...body, definition: { ...body.definition, layer: 1 as const } }
      : body,
  );
export type ItemCreateBody = z.infer<typeof itemCreateSchema>;

export const itemPatchSchema = z.object({
  name: nameSchema.optional(),
  kind: itemKindSchema.optional(),
  description: z.string().optional(),
  tags: tagsSchema.optional(),
  definition: partialWithoutDefaults(
    itemExtrasSchema.extend({
      // The client definition shape carries "no layer" as null; accept it as
      // an explicit clear (key present ⇒ merge unsets) instead of a 400.
      layer: clothingLayerSchema.nullable().transform((v) => v ?? undefined),
    }),
  ).optional(),
  /** Publish/un-publish toggle (auth.plan.md). */
  visibility: visibilitySchema.optional(),
});
export type ItemPatchBody = z.infer<typeof itemPatchSchema>;

/** Unknown body-location ids in a coverage list (registry-validated at save). */
export function invalidCoverageIds(coverage: readonly string[]): string[] {
  return coverage.filter((id) => bodyLocationRegistry.byId(id.trim().toLowerCase()) === undefined);
}

// --- social cards ------------------------------------------------------------

/**
 * The slice of a SocialReactionCard stored in `social_cards.definition` — the mechanical fields
 * only (defined once in contracts as `socialReactionCardExtrasSchema`). The card's
 * `label`/`description` map onto the row's `name`/`description` columns, and the row mints its
 * own `id`; the inline snapshot (world/character) recomposes the full card via
 * `cardFromLibraryParts` (social-reaction-cards.plan.md → deferred-slice build plan).
 */
export const socialCardExtrasSchema = socialReactionCardExtrasSchema;
export type SocialCardExtras = z.infer<typeof socialCardExtrasSchema>;

export function emptySocialCardExtras(): SocialCardExtras {
  return socialCardExtrasSchema.parse({});
}

export const socialCardCreateSchema = z.object({
  name: nameSchema,
  description: z.string().default(""),
  tags: tagsSchema.default([]),
  definition: socialCardExtrasSchema.default(() => emptySocialCardExtras()),
});
export type SocialCardCreateBody = z.infer<typeof socialCardCreateSchema>;

export const socialCardPatchSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().optional(),
  tags: tagsSchema.optional(),
  definition: partialWithoutDefaults(socialCardExtrasSchema).optional(),
  /** Publish/un-publish toggle (auth.plan.md). */
  visibility: visibilitySchema.optional(),
});
export type SocialCardPatchBody = z.infer<typeof socialCardPatchSchema>;
