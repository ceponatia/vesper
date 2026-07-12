import { z } from "zod";
import { attributeValueSchema } from "../attributes/value";
import { calendarStartSchema, DEFAULT_CALENDAR_START } from "@/lib/clock";
import { meterDefinitionSchema } from "../meters/registry";
import { socialReactionCardSchema } from "../personality/cards";
import { drivesSchema } from "../personality/drives";
import { preferenceSchema } from "../personality/preference";
import { traitValueSchema } from "../personality/traits/value";
import { stageToBandIds } from "../relationships/bands";
import { authoredRelationshipRecordSchema } from "../relationships/record";
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

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

/**
 * The day-part vocabulary the schedule authoring surfaces speak
 * (chat-initiative.plan.md slice 4 — "rows, not a timetable grid"): the editor
 * offers these as row presets and the forge drafts in them; the stored shape
 * stays raw minutes, so hand-authored windows and the session movement engine
 * (`scheduleEntryAt` — wrap-past-midnight supported) are untouched.
 */
export const SCHEDULE_DAY_PARTS = [
  { id: "morning", label: "Morning", startMinute: 360, endMinute: 720 }, // 6:00am–12:00pm
  { id: "afternoon", label: "Afternoon", startMinute: 720, endMinute: 1080 }, // 12:00pm–6:00pm
  { id: "evening", label: "Evening", startMinute: 1080, endMinute: 1380 }, // 6:00pm–11:00pm
  { id: "night", label: "Night", startMinute: 1380, endMinute: 360 }, // 11:00pm–6:00am (wraps)
] as const;
export type ScheduleDayPartId = (typeof SCHEDULE_DAY_PARTS)[number]["id"];

export function scheduleDayPartById(id: string): (typeof SCHEDULE_DAY_PARTS)[number] | undefined {
  return SCHEDULE_DAY_PARTS.find((p) => p.id === id);
}

/** The day part whose window exactly matches this entry's minutes, if any (the editor's select state). */
export function matchScheduleDayPart(entry: Pick<ScheduleEntry, "startMinute" | "endMinute">): ScheduleDayPartId | null {
  const match = SCHEDULE_DAY_PARTS.find((p) => p.startMinute === entry.startMinute && p.endMinute === entry.endMinute);
  return match?.id ?? null;
}

/** "6:00am" / "2:30pm" — minute-of-day for the custom-window editor rows and window descriptions. */
export function formatScheduleMinute(minute: number): string {
  const bounded = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(bounded / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const mins = bounded % 60;
  return `${hour12}${mins ? `:${String(mins).padStart(2, "0")}` : ""}${hour24 < 12 ? "am" : "pm"}`;
}

const WEEKDAY_ABBREV = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "mornings" for a preset window, else "6:00am–2:30pm"; a day mask appends "(Mon/Wed/Fri)". */
export function describeScheduleWindow(entry: ScheduleEntry): string {
  const part = matchScheduleDayPart(entry);
  const window = part ? `${part}s` : `${formatScheduleMinute(entry.startMinute)}–${formatScheduleMinute(entry.endMinute)}`;
  const days = entry.days?.length ? ` (${entry.days.map((d) => WEEKDAY_ABBREV[d] ?? "?").join("/")})` : "";
  return `${window}${days}`;
}

/**
 * One compact rhythm line for prompts (the initiative opener's "a life
 * meanwhile" grounding): "mornings: waiting tables at the Dockside Café;
 * evenings: sketching at the pier". Empty for an empty schedule. PURE.
 */
export function formatScheduleRhythm(schedule: readonly ScheduleEntry[], max = 4): string {
  return schedule
    .slice(0, max)
    .map((entry) => {
      const place = entry.locationName.trim();
      const activity = entry.activity.trim();
      return `${describeScheduleWindow(entry)}: ${activity}${place ? ` at ${place}` : ""}`;
    })
    .join("; ");
}

export const characterProfileSchema = z.object({
  bio: z.string().default(""),
  personality: z.string().default(""),
  voice: z.string().optional(),
  /**
   * The character's real / chronological age, free text — a basic-info field the
   * **narrator** reads, deliberately separate from the visual
   * `identity.apparent_age` attribute the **portrait studio** reads (the two
   * aren't always aligned: a 500-year-old who reads late-thirties). Free text so
   * fantasy ages ("ancient", "312 years", "immortal") sit alongside a plain
   * number; `formatAge` reads a bare number as years. Default "" ⇒ old rows parse
   * unchanged and surface no age line (degraded-safe).
   */
  age: z.string().default(""),
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
   * Character drives (character-drives.plan.md): ≤3 authored wants with secrecy
   * levels — the inner life chat state seeds from and the drive prompt law reads.
   */
  drives: drivesSchema,
  /**
   * Atomic personality traits (personality-and-state.spec.md §3): numeric scalars
   * with registry-defined bands, carrying the `AttributeValue` provenance shape
   * (base/creation/manual). Default `[]` ⇒ a character with no traits surfaces no
   * disposition block and scales reactions by 1 — exactly today's behavior.
   */
  traits: z.array(traitValueSchema).default([]),
  /**
   * The character's authored default stance toward the player
   * (character-chat-state.spec.md §1.1; relationship-model.plan.md slice 2): the
   * AUTHORED relationship record — two band picks + kind/history/mask texture —
   * that seeds a new chat's live scalars at band midpoints, plus the one-line
   * `note` that pre-fills the chat's default premise (§1.2). The legacy
   * `{stage, note}` shape heals in the preprocess (old `stage` maps through
   * `stageToBandIds`). Default strangers/neutral/"" ⇒ zeroed axes and no default
   * premise ⇒ today's behavior. Stored as `playerRelationship` (intrinsic stance
   * toward the player, broader than chat) but shown on the character-sheet
   * **Chat** tab as **Starting Relationship**. Every part has a `.catch` so a
   * malformed value self-heals rather than failing the whole profile.
   */
  playerRelationship: z.preprocess(
    (value) => {
      if (typeof value !== "object" || value === null) return value;
      const legacy = value as Record<string, unknown>;
      if (typeof legacy.stage !== "string" || "familiarity" in legacy || "regard" in legacy) return value;
      const bands = stageToBandIds(legacy.stage);
      return { ...legacy, familiarity: bands.familiarity, regard: bands.regard };
    },
    authoredRelationshipRecordSchema
      .extend({ note: z.string().max(PLAYER_RELATIONSHIP_NOTE_MAX).catch("").default("") })
      .catch({ familiarity: "strangers", regard: "neutral", kind: "", history: "", presented: undefined, looming: false, note: "" })
      .default({ familiarity: "strangers", regard: "neutral", kind: "", history: "", presented: undefined, looming: false, note: "" }),
  ),
  aliases: z.array(z.string()).default([]),
  /** Item definition ids from the owner's library. */
  defaultOutfit: z.array(z.string()).default([]),
  // Element-wise catch (docs/resilience.md §1): one bad row — an editor row saved
  // with a blank activity/place — drops alone instead of failing the whole profile.
  schedule: z
    .array(scheduleEntrySchema.nullable().catch(null))
    .catch([])
    .default([])
    .transform((entries) => entries.filter((e): e is ScheduleEntry => e !== null)),
});

export type CharacterProfile = z.infer<typeof characterProfileSchema>;

export function emptyCharacterProfile(): CharacterProfile {
  return characterProfileSchema.parse({});
}

/**
 * Present a character's real `age` (free text) for the narrator. A bare number
 * is read as years ("312" → "312 years old"); any phrasing the author wrote
 * ("ancient", "centuries old", "immortal", "312 years") is used verbatim. Empty
 * for a blank age. Shared by every narrator surface so the phrasing stays
 * consistent (engine/scene.ts canonical facts + character-chat identity block).
 */
export function formatAge(age: string): string {
  const trimmed = age.trim();
  if (!trimmed) return "";
  return /^\d+$/.test(trimmed) ? `${trimmed} years old` : trimmed;
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
