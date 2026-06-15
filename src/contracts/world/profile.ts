import { z } from "zod";
import { attributeValueSchema } from "../attributes/value";
import { calendarStartSchema, DEFAULT_CALENDAR_START } from "@/lib/clock";
import { meterDefinitionSchema } from "../meters/registry";
import { DEFAULT_BODY_PLAN_ID } from "../body/plans";

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
  aliases: z.array(z.string()).default([]),
  /** Item definition ids from the owner's library. */
  defaultOutfit: z.array(z.string()).default([]),
  schedule: z.array(scheduleEntrySchema).default([]),
});

export type CharacterProfile = z.infer<typeof characterProfileSchema>;

export function emptyCharacterProfile(): CharacterProfile {
  return characterProfileSchema.parse({});
}

export const worldNormSchema = z.object({
  rule: z.string().min(1),
  severity: z.enum(["odd", "disapproval", "outrage"]).catch("odd"),
  consequence: z.string().default(""),
});

export type WorldNorm = z.infer<typeof worldNormSchema>;

export const worldStyleSchema = z.object({
  directives: z.array(z.string()).default([]),
  narratorGuidance: z.string().optional(),
  calendarStart: calendarStartSchema.default(DEFAULT_CALENDAR_START),
  /** Partial overrides per meter id; null disables the meter for this world. */
  meterOverrides: z.record(z.string(), meterDefinitionSchema.partial().nullable()).default({}),
  norms: z.array(worldNormSchema).default([]),
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
