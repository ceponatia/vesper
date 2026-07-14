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
  /**
   * Rhythm auto-dress (ux-improvements slice 8.4, ruled: built with the slice):
   * an optional `profile.outfits` preset id — openers/pickup skips dress the
   * character for this window. Absent ⇒ the default preset; unknown ids
   * degrade to it too (`resolveOutfitPreset`).
   */
  outfitPresetId: z.string().optional(),
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

/** Cap on stored worked dialogue examples — a few, not a script. */
export const MICRO_EXEMPLARS_MAX = 3;

/**
 * A worked dialogue exemplar (character-fidelity slice 6): one situation cue paired
 * with how THIS character answers it — a few-shot that encodes disposition + voice +
 * age jointly, rendered near generation in the chat prefix. Structured (situation +
 * line), not one blob string, so the editor and forge can curate each row. Leaf
 * `.catch` so one malformed value degrades the row instead of failing the profile.
 */
export const microExemplarSchema = z.object({
  /** The charged moment the line answers, a short cue ("pushed to talk about her past"). */
  situation: z.string().catch("").default(""),
  /** The character's in-voice answer/beat. */
  line: z.string().catch("").default(""),
});
export type MicroExemplar = z.infer<typeof microExemplarSchema>;

/** Caps on the structured voice anchors (character-fidelity slice 7) — a small set, not a script. */
export const VOICE_PET_PHRASES_MAX = 6;
export const VOICE_NEVER_SAYS_MAX = 6;
export const VOICE_CADENCE_MAX = 240;

/**
 * Structured voice anchors (character-fidelity slice 7): the concrete, near-generation
 * levers for a consistent voice — pet phrases the character actually reaches for, a one-line
 * rhythm/cadence note, and a never-says list of words/registers off-limits for them. A small
 * structured shape with headroom (following the microExemplars pattern), rendered two ways:
 * in the stable prefix AND as a one-line tail re-anchor beside the mood pin, so voice sits
 * near generation across a long chat. Every field defaults empty ⇒ old rows parse unchanged
 * and render nothing. Leaf `.catch` so one malformed field degrades to empty rather than
 * failing the whole profile.
 */
export const voiceAnchorsSchema = z
  .object({
    /** Turns of phrase the character actually uses ("darling", "no promises"). */
    petPhrases: z.array(z.string()).catch([]).default([]),
    /** One line on rhythm/cadence ("clipped and dry; trails off when she deflects"). */
    cadence: z.string().catch("").default(""),
    /** Words/registers off-limits for this character (never "babe"; no corporate-speak). */
    neverSays: z.array(z.string()).catch([]).default([]),
  })
  .catch({ petPhrases: [], cadence: "", neverSays: [] })
  .default({ petPhrases: [], cadence: "", neverSays: [] })
  .transform((v) => ({
    petPhrases: v.petPhrases.map((p) => p.trim()).filter(Boolean).slice(0, VOICE_PET_PHRASES_MAX),
    cadence: v.cadence.trim().slice(0, VOICE_CADENCE_MAX),
    neverSays: v.neverSays.map((p) => p.trim()).filter(Boolean).slice(0, VOICE_NEVER_SAYS_MAX),
  }));
export type VoiceAnchors = z.infer<typeof voiceAnchorsSchema>;

/** Empty voice anchors — the render-nothing / not-yet-authored value. */
export function emptyVoiceAnchors(): VoiceAnchors {
  return { petPhrases: [], cadence: "", neverSays: [] };
}

/** Whether any voice anchor carries content (fill-merge "authored" test + prompt gates). PURE. */
export function hasVoiceAnchors(v: VoiceAnchors): boolean {
  return v.petPhrases.length > 0 || v.cadence.trim() !== "" || v.neverSays.length > 0;
}

/** One named look: a list of item definition ids from the owner's library. */
export const outfitPresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().catch("").default(""),
  items: z.array(z.string()).catch([]).default([]),
});
export type OutfitPreset = z.infer<typeof outfitPresetSchema>;

/**
 * Lift a legacy `defaultOutfit` id list into the first outfit preset (the lazy
 * migration for the slice-8 replace ruling): rows that already carry presets —
 * or carry nothing — pass through untouched, and zod's key-stripping drops the
 * dead `defaultOutfit` key on the next save.
 */
const liftLegacyDefaultOutfit = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const raw = value as Record<string, unknown>;
  const legacy = raw.defaultOutfit;
  const hasPresets = Array.isArray(raw.outfits) && raw.outfits.length > 0;
  if (hasPresets || !Array.isArray(legacy) || legacy.length === 0) return value;
  return { ...raw, outfits: [{ id: "everyday", name: "Everyday", items: legacy }] };
};

/** The raw object shape — for structural uses (`.partial()` etc.); reads go
 *  through `characterProfileSchema`, whose preprocess lifts legacy rows. */
export const characterProfileObjectSchema = z.object({
  bio: z.string().default(""),
  personality: z.string().default(""),
  voice: z.string().optional(),
  /**
   * Worked dialogue exemplars (character-fidelity slice 6): 2–3 forge/redraft-drafted
   * examples of how the character answers a charged moment (a deflection, a boundary,
   * a tease), rendered as few-shots in the chat prefix so voice + disposition + age
   * anchor near generation. Element-wise `.catch` (docs/resilience.md §1) drops one bad
   * row alone; empty/blank rows filter out. `[]` ⇒ no block (old rows parse unchanged).
   */
  microExemplars: z
    .array(microExemplarSchema.nullable().catch(null))
    .catch([])
    .default([])
    .transform((rows) =>
      rows.filter(
        (r): r is MicroExemplar => r !== null && (r.situation.trim() !== "" || r.line.trim() !== ""),
      ),
    ),
  /**
   * Structured voice anchors (character-fidelity slice 7): pet phrases, a rhythm/cadence
   * note, and a never-says list — rendered in the chat prefix AND as a one-line tail
   * re-anchor beside the mood pin so voice stays consistent near generation. Self-healing
   * (leaf `.catch` per field); absent ⇒ empty ⇒ no block, old rows parse unchanged.
   */
  voiceAnchors: voiceAnchorsSchema,
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
  /**
   * Named outfit presets (ux-improvements.plan.md slice 8 — ruled: REPLACES the
   * old `defaultOutfit` id list): casual/work/date-night/sleep looks, each a
   * list of item definition ids from the owner's library. The FIRST preset is
   * the default — what the forge targets, the avatar wears, sessions seed, and
   * a chat starts in when Starting Outfit is blank. Legacy `defaultOutfit`
   * rows lift into a single "Everyday" preset at parse time (the schema
   * preprocess below) — lazy migration, no sweep; writers only write `outfits`.
   */
  outfits: z
    .array(outfitPresetSchema.nullable().catch(null))
    .catch([])
    .default([])
    .transform((presets) => presets.filter((p): p is OutfitPreset => p !== null)),
  // Element-wise catch (docs/resilience.md §1): one bad row — an editor row saved
  // with a blank activity/place — drops alone instead of failing the whole profile.
  schedule: z
    .array(scheduleEntrySchema.nullable().catch(null))
    .catch([])
    .default([])
    .transform((entries) => entries.filter((e): e is ScheduleEntry => e !== null)),
});

export const characterProfileSchema = z.preprocess(liftLegacyDefaultOutfit, characterProfileObjectSchema);

export type CharacterProfile = z.infer<typeof characterProfileSchema>;

export function emptyCharacterProfile(): CharacterProfile {
  return characterProfileSchema.parse({});
}

/**
 * Resolve an outfit preset: the named one when it exists, else the FIRST (the
 * default). Unknown/absent ids degrade to the default — never a hard failure.
 */
export function resolveOutfitPreset(
  profile: Pick<CharacterProfile, "outfits">,
  presetId?: string | null,
): OutfitPreset | undefined {
  if (presetId) {
    const named = profile.outfits.find((preset) => preset.id === presetId);
    if (named) return named;
  }
  return profile.outfits[0];
}

/** Item ids of the default (or named) preset — the `defaultOutfit` successor. */
export function outfitItems(profile: Pick<CharacterProfile, "outfits">, presetId?: string | null): string[] {
  return resolveOutfitPreset(profile, presetId)?.items ?? [];
}

/**
 * Append item ids into the default (first) preset, minting an "Everyday"
 * preset when none exists — the forge-suggestion / outfit-materialize path.
 */
export function withItemsInDefaultOutfit(profile: CharacterProfile, itemIds: readonly string[]): CharacterProfile {
  if (itemIds.length === 0) return profile;
  const first = profile.outfits[0];
  const outfits = first
    ? [{ ...first, items: [...new Set([...first.items, ...itemIds])] }, ...profile.outfits.slice(1)]
    : [{ id: "everyday", name: "Everyday", items: [...new Set(itemIds)] }];
  return { ...profile, outfits };
}

/**
 * Find a preset by its human name (the archivist's "changes into her work
 * clothes" matching): trimmed, case-insensitive; undefined when nothing fits.
 */
export function outfitPresetByName(
  profile: Pick<CharacterProfile, "outfits">,
  name: string,
): OutfitPreset | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return profile.outfits.find((preset) => preset.name.trim().toLowerCase() === needle);
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
