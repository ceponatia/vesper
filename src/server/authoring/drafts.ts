import { z } from "zod";
import {
  authoredRelationshipSchema,
  characterProfileSchema,
  emptyCharacterProfile,
  emptyItemDefinition,
  emptyWorldLore,
  emptyWorldStyle,
  itemDefinitionSchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  worldLoreSchema,
  worldStyleSchema,
} from "@/contracts";

/**
 * Forge drafts (docs/authoring.md): plain JSON the AI fills and the human
 * edits. Every field is defaulted so a partial draft is always schema-valid —
 * a failed forge section simply leaves its slice at the default.
 */

export const castRoleSchema = z.enum(["companion", "npc"]);
export type CastRole = z.infer<typeof castRoleSchema>;

export const characterDraftSchema = z.object({
  name: z.string().default(""),
  profile: characterProfileSchema.default(() => emptyCharacterProfile()),
  tags: z.array(z.string()).default([]),
  /** Unmatched outfit suggestions, tagged "suggested"; saved as new library items. */
  suggestedItems: z.array(itemDefinitionSchema).default([]),
});

export type CharacterDraft = z.infer<typeof characterDraftSchema>;

export function emptyCharacterDraft(): CharacterDraft {
  return characterDraftSchema.parse({});
}

export const locationAmbientSchema = z.object({
  scent: z.string().optional(),
  sound: z.string().optional(),
  light: z.string().optional(),
});

export type LocationAmbient = z.infer<typeof locationAmbientSchema>;

export const locationScaleSchema = z.enum(["intimate", "room", "hall", "open", "expanse"]);
export type LocationScale = z.infer<typeof locationScaleSchema>;

export const worldDraftLocationSchema = z.object({
  /** Present when the draft row mirrors a saved library location (edit page); forge drafts omit it. */
  locationId: z.string().min(1).optional(),
  name: z.string().default(""),
  description: z.string().default(""),
  ambient: locationAmbientSchema.default({}),
  /** Spatial size class (proximity-spec §Location scale). */
  scale: locationScaleSchema.catch("room").default("room"),
  /** Map-grouping label ("apartment-102", "downtown") — drives default travel times; not a container. */
  area: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Names of other draft locations this one connects to (undirected). */
  links: z.array(z.string()).default([]),
});

export type WorldDraftLocation = z.infer<typeof worldDraftLocationSchema>;

export const worldDraftLoreChunkSchema = z.object({
  title: z.string().default(""),
  body: z.string().default(""),
  category: loreChunkCategorySchema.catch("history"),
  tier: loreChunkTierSchema.catch("scene"),
  visibility: loreChunkVisibilitySchema.catch("public"),
  unlockTags: z.array(z.string()).default([]),
  locationTags: z.array(z.string()).default([]),
  /** Carried through edit-page saves; forge drafts leave it false. */
  manuallyUnlocked: z.boolean().default(false),
});

export type WorldDraftLoreChunk = z.infer<typeof worldDraftLoreChunkSchema>;

export const castTierSchema = z.enum(["major", "minor", "extra"]);
export type CastTier = z.infer<typeof castTierSchema>;

export const worldDraftCastSuggestionSchema = z.object({
  /** Set when the suggestion matched a character in the user's library. */
  existingCharacterId: z.string().min(1).optional(),
  name: z.string().default(""),
  conceptNote: z.string().default(""),
  role: castRoleSchema.catch("npc"),
  /** Simulation/narration depth (cast-tiers-and-affinity-spec). */
  tier: castTierSchema.catch("minor").default("minor"),
  /** Draft location name where this character starts (the innkeeper starts at the inn). */
  startLocationName: z.string().optional(),
  /** Directed edges toward other cast names or "player"; saved to world_cast.relationships and seeded at spawn. */
  relationships: z.array(authoredRelationshipSchema).default([]),
});

export type WorldDraftCastSuggestion = z.infer<typeof worldDraftCastSuggestionSchema>;

export const worldDraftItemPlacementSchema = z.object({
  itemName: z.string().default(""),
  definition: itemDefinitionSchema.default(() => emptyItemDefinition()),
  /** Placement by draft location name; cleared (with a diagnostic) when unresolvable. */
  locationName: z.string().min(1).optional(),
  /** Placement on a cast suggestion by name. */
  castName: z.string().min(1).optional(),
  worn: z.boolean().default(false),
  quantity: z.number().int().min(1).max(20).default(1),
});

export type WorldDraftItemPlacement = z.infer<typeof worldDraftItemPlacementSchema>;

export const worldDraftSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  style: worldStyleSchema.default(() => emptyWorldStyle()),
  lore: worldLoreSchema.default(() => emptyWorldLore()),
  locations: z.array(worldDraftLocationSchema).default([]),
  loreChunks: z.array(worldDraftLoreChunkSchema).default([]),
  castSuggestions: z.array(worldDraftCastSuggestionSchema).default([]),
  itemPlacements: z.array(worldDraftItemPlacementSchema).default([]),
  /** Draft location name where the player starts (decision 47); unset ⇒ spawn anchors to the companion. */
  playerStartLocationName: z.string().optional(),
  /** Default player character chosen up front (UX-audit §1a); unset/null ⇒ observer. */
  playerCharacterId: z
    .string()
    .min(1)
    .nullish()
    .transform((v) => v ?? undefined),
});

export type WorldDraft = z.infer<typeof worldDraftSchema>;

export function emptyWorldDraft(): WorldDraft {
  return worldDraftSchema.parse({});
}
