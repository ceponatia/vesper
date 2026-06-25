import { z } from "zod";
import { attributeValueSchema } from "../attributes/value";
import { calendarStartSchema, DEFAULT_CALENDAR_START } from "@/lib/clock";
import { meterDefinitionSchema } from "../meters/registry";
import { socialReactionCardSchema } from "../personality/cards";
import { preferenceSchema } from "../personality/preference";
import { traitValueSchema } from "../personality/traits/value";
import { stageIdSchema } from "../relationships/stages";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";

/**
 * Cap on the authored `playerRelationship.note` — it pre-fills a chat premise, so
 * keep it a one-line setup, not a second bio (character-chat-state.spec.md §1.1).
 */
export const PLAYER_RELATIONSHIP_NOTE_MAX = 280;

export const scheduleEntrySchema = z.object({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
  locationName: z.string().min(1),
  activity: z.string().min(1),
  /** Weekday mask, 0 = Sunday … 6 = Saturday. Absent ⇒ every day (old entries parse unchanged). */
  days: z.array(z.number().int().min(0).max(6)).optional(),
});

export const characterProfileSchema = z.object({
  bio: z.string().default(""),
  personality: z.string().default(""),
  voice: z.string().optional(),
  speciesId: z.string().default("human"),
  /**
   * Optional heritage within the species (e.g. "dark_elf" inside "elf") — a pure
   * overlay realizeBody composes after the species. Absent ⇒ bare species, the
   * pre-heritage behavior (old rows parse unchanged). Validated loosely as a
   * string; a heritage id not belonging to the species is ignored at realize time.
   */
  heritageId: z.string().optional(),
  bodyPlanId: z.string().default(DEFAULT_BODY_PLAN_ID),
  /**
   * Body-config: which intimate region groups this character has (e.g.
   * ["vulva", "breasts"]). The explicit switch above the descriptive attribute
   * layer (Decision 1a) — the realized-body filter (species/realize.ts) reads it
   * to gate intimate anatomy and attributes. Default `[]` = no intimate anatomy,
   * exactly the engine's behavior before this field existed (degraded-safe).
   * Validated loosely as strings; unknown groups are ignored at realize time.
   */
  intimateRegions: z.array(z.string()).default([]),
  /**
   * Additive non-baseline body features this character has (e.g. wings, horns,
   * tail). When absent, realizeBody may use the species default feature groups;
   * when present, even an empty list is an explicit override.
   */
  bodyFeatures: z.array(z.string()).optional(),
  attributes: z.array(attributeValueSchema).default([]),
  /**
   * Disposition (docs/developer-notes/personality-and-state.spec.md §6): reusable
   * `tags` (which social-reaction cards key overrides on — inert until cards ship)
   * and `preferences` (bespoke likes/dislikes resolved against a classified social
   * act). Both default `[]` ⇒ a character with no disposition plays exactly as before.
   */
  tags: z.array(z.string()).default([]),
  preferences: z.array(preferenceSchema).default([]),
  /**
   * The character's own default social-reaction cards (social-reaction-cards.plan.md):
   * its *personal* lines/taboos, snapshot copies from the card library. They resolve in
   * the world-less character chat and, in a session, are tried **before** the world's
   * cards (the personal line beats society's). Default `[]` ⇒ no character cards.
   */
  socialCards: z.array(socialReactionCardSchema).default([]),
  /**
   * Atomic personality traits (personality-and-state.spec.md §3): numeric scalars
   * with registry-defined bands, carrying the `AttributeValue` provenance shape
   * (base/creation/manual). Default `[]` ⇒ a character with no traits surfaces no
   * disposition block and scales reactions by 1 — exactly today's behavior.
   */
  traits: z.array(traitValueSchema).default([]),
  /**
   * The character's authored default stance toward the player
   * (character-chat-state.spec.md §1.1). v1 seeds the **character chat**: `stage`
   * → the chat's starting affinity (`stageMidpoint`), and the one-line `note`
   * pre-fills the chat's default premise (§1.2). Default `stranger`/"" ⇒ affinity
   * 0 and no default premise ⇒ today's behavior. Stored as `playerRelationship`
   * (intrinsic stance toward the player, broader than chat) but shown on the
   * character-sheet **Chat** tab as **Starting Relationship**. Every part has a
   * `.catch` so a malformed value self-heals rather than failing the whole profile.
   */
  playerRelationship: z
    .object({
      stage: stageIdSchema.default("stranger"),
      note: z.string().max(PLAYER_RELATIONSHIP_NOTE_MAX).catch("").default(""),
    })
    .catch({ stage: "stranger", note: "" })
    .default({ stage: "stranger", note: "" }),
  aliases: z.array(z.string()).default([]),
  /** Item definition ids from the owner's library. */
  defaultOutfit: z.array(z.string()).default([]),
  schedule: z.array(scheduleEntrySchema).default([]),
});

export type CharacterProfile = z.infer<typeof characterProfileSchema>;

export function emptyCharacterProfile(): CharacterProfile {
  return characterProfileSchema.parse({});
}

export const worldStyleSchema = z.object({
  directives: z.array(z.string()).default([]),
  narratorGuidance: z.string().optional(),
  calendarStart: calendarStartSchema.default(DEFAULT_CALENDAR_START),
  /** Partial overrides per meter id; null disables the meter for this world. */
  meterOverrides: z.record(z.string(), meterDefinitionSchema.partial().nullable()).default({}),
  /**
   * The world's social fabric (social-reaction-cards.plan.md) — snapshot copies of taboo /
   * social-rule cards selected from the card library. Read live each turn (like the rest of
   * `style`); resolves player→target reactions and witnessed breaches. Replaces the former
   * freeform `norms`. Default `[]` ⇒ no social fabric (narrator plays it straight).
   */
  socialCards: z.array(socialReactionCardSchema).default([]),
});

export type WorldStyle = z.infer<typeof worldStyleSchema>;

export function emptyWorldStyle(): WorldStyle {
  return worldStyleSchema.parse({});
}

export const plotAnchorSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  priority: z.enum(["background", "active"]).default("background"),
});

export const worldFactionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  memberCharacterIds: z.array(z.string()).default([]),
  conflicts: z.array(z.object({ factionName: z.string(), notes: z.string().default("") })).default([]),
});

export const worldLoreSchema = z.object({
  synopsis: z.string().default(""),
  factions: z.array(worldFactionSchema).default([]),
  plotAnchors: z.array(plotAnchorSchema).default([]),
});

export type WorldLore = z.infer<typeof worldLoreSchema>;

export function emptyWorldLore(): WorldLore {
  return worldLoreSchema.parse({});
}

export const loreChunkTierSchema = z.enum(["always", "scene", "retrieval"]);
export const loreChunkVisibilitySchema = z.enum(["public", "secret"]);
export const loreChunkCategorySchema = z.enum([
  "history",
  "geography",
  "institution",
  "culture",
  "relationship",
  "secret",
  "tone",
]);
