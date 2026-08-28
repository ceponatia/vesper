import { z } from "zod";
import {
  attributeRegistry,
  bodyLocationRegistry,
  DEFAULT_SPECIES_ID,
  heritageFor,
  inferHeritageFromText,
  inferSpeciesFromText,
  materializeRegistryDefaults,
  seedBodyConfigFromAttributes,
  isFeatureAttributeCategory,
  isIntimateAttributeCategory,
  realizeBody,
  speciesById,
  clothingCategories,
  clothingCategoryById,
  colorFamilyById,
  colorFamilyIds,
  clothingLayerSchema,
  diag,
  itemDefinitionSchema,
  canonicalTagId,
  dispositionTags,
  DRIVES_MAX,
  DRIVE_WANT_MAX_CHARS,
  DRIVE_WHY_MAX_CHARS,
  familiarityBandById,
  familiarityBands,
  interactionConceptIds,
  interactionFamilies,
  MICRO_EXEMPLARS_MAX,
  normalizeTag,
  axisRange,
  PLAYER_RELATIONSHIP_NOTE_MAX,
  RELATIONSHIP_HISTORY_TEXT_MAX,
  RELATIONSHIP_KIND_MAX,
  regardBandById,
  regardBands,
  scheduleDayPartById,
  traitRegistry,
  wearerTargetById,
  wearerTargets,
  type AttributeDefinition,
  type AttributeValue,
  type CharacterProfile,
  type DiagnosticSink,
  type Drive,
  type HeritageDefinition,
  type ItemDefinition,
  type MicroExemplar,
  voiceAnchorsSchema,
  type VoiceAnchors,
  type Preference,
  type RealizedBody,
  type ScheduleEntry,
  type SocialReactionCard,
  type SpeciesDefinition,
  type TraitValue,
} from "@/contracts";
import { fnv1a32 } from "@/lib/hash";
import { parseOrNull } from "@/lib/parse";
import { generateChecked } from "@/server/ai";
import {
  CANDIDATE_LIMIT,
  findItemsByName,
  listClothingCandidates,
  type ClothingCandidate,
  type ClothingCandidateLookup,
  type LibraryLookup,
} from "./library";
import { emptyCharacterDraft, type CharacterDraft } from "./drafts";

/**
 * Character forge (docs/authoring/character-forge.md): three INDEPENDENT
 * generateChecked sections — profile, attributes, outfit — so each can
 * regenerate alone. The forge returns a draft; it never saves.
 */

/**
 * Latency knobs shared by every forge leg (2026-08-16). The legs run on the
 * state model (DeepSeek 4 Flash) with reasoning OFF: they are the same genre
 * of closed-vocabulary structured JSON as the in-session agents, whose ruled
 * default is reasoning-off (lib/agent-reasoning.ts), and reasoning tokens on
 * the profile leg's large output were the forge's wall-clock (the legs run in
 * parallel, so the profile leg IS the forge's latency). The grounding passes
 * below and the human-reviewed draft absorb any marginal quality dip.
 * Latency-sorted routing for the same reason intake uses it: the floating
 * `~…-latest` alias has no PROVIDER_ORDER entry, and unconstrained routing
 * intermittently lands cold endpoints with multi-second TTFT.
 */
const FORGE_LEG_OPTIONS = { disableReasoning: true, lowLatencyRouting: true } as const;

export const characterForgeSections = ["profile", "attributes", "outfit"] as const;
export const characterForgeSectionSchema = z.enum(characterForgeSections);
export type CharacterForgeSection = (typeof characterForgeSections)[number];

export interface CharacterForgeContext {
  prompt: string;
  userId: string;
  sink?: DiagnosticSink;
  /** Current draft, for single-section regeneration context. */
  draft?: CharacterDraft;
  /** Item-library lookup; defaults to an ILIKE query against the items table. */
  findItems?: LibraryLookup;
  /** Wardrobe reuse candidates for the outfit agent; defaults to a DB query. */
  listCandidates?: ClothingCandidateLookup;
  /**
   * Set false to disable the demo fallbacks: failed sections degrade to empty
   * defaults instead of sample content. Use wherever the result is persisted
   * without human review (e.g. world-save cast generation) — demo content is
   * for editable drafts, not for rows written on someone's behalf.
   */
  useFallbacks?: boolean;
  /** Deterministic registry match from the forge prompt, shared by all sections. */
  inferredSpecies?: SpeciesDefinition;
}

/** A section's contribution to the draft; merged with applyCharacterSectionPatch. */
export interface CharacterSectionPatch {
  name?: string;
  tags?: string[];
  profile?: Partial<CharacterProfile>;
  suggestedItems?: ItemDefinition[];
}

export function applyCharacterSectionPatch(draft: CharacterDraft, patch: CharacterSectionPatch): CharacterDraft {
  return {
    name: patch.name ?? draft.name,
    tags: patch.tags ?? draft.tags,
    suggestedItems: patch.suggestedItems ?? draft.suggestedItems,
    profile: { ...draft.profile, ...(patch.profile ?? {}) },
  };
}

export interface ForgeCharacterInput {
  prompt: string;
  userId: string;
  sink?: DiagnosticSink;
  findItems?: LibraryLookup;
  listCandidates?: ClothingCandidateLookup;
  useFallbacks?: boolean;
}

export async function forgeCharacter(input: ForgeCharacterInput): Promise<CharacterDraft> {
  const context: CharacterForgeContext = { ...input, inferredSpecies: inferSpeciesFromText(input.prompt)?.species };
  const patches = await Promise.all(characterForgeSections.map((section) => forgeCharacterSection(section, context)));
  let draft = emptyCharacterDraft();
  for (const patch of patches) draft = applyCharacterSectionPatch(draft, patch);
  return draft;
}

export async function forgeCharacterSection(
  section: CharacterForgeSection,
  context: CharacterForgeContext,
): Promise<CharacterSectionPatch> {
  switch (section) {
    case "profile":
      return forgeProfileSection(context);
    case "attributes":
      return forgeAttributesSection(context);
    case "outfit":
      return forgeOutfitSection(context);
  }
}

function speciesForForgeContext(context: CharacterForgeContext): SpeciesDefinition | undefined {
  if (context.draft) return speciesById(context.draft.profile.speciesId) ?? context.inferredSpecies;
  return context.inferredSpecies ?? inferSpeciesFromText(context.prompt)?.species;
}

/**
 * The heritage/subtype within the resolved species — the draft's stored
 * `heritageId` when editing, else inferred from the prompt ("a drow ranger" →
 * dark_elf), then the species default when inference is silent. Scoped to the
 * resolved species so a selected overlay can never belong to a different one.
 */
function heritageForForgeContext(context: CharacterForgeContext): HeritageDefinition | undefined {
  const species = speciesForForgeContext(context);
  if (!species) return undefined;
  const draftId = context.draft?.profile.heritageId;
  if (draftId) return heritageFor(species.id, draftId);
  return inferHeritageFromText(species.id, context.prompt) ?? heritageFor(species.id, undefined);
}

function realizedBodyForForgeContext(context: CharacterForgeContext) {
  const species = speciesForForgeContext(context);
  if (!species) return undefined;
  return realizeBody({
    speciesId: species.id,
    heritageId: heritageForForgeContext(context)?.id,
    bodyPlanId: context.draft?.profile.bodyPlanId ?? species.bodyPlanId,
    intimateRegions: context.draft?.profile.intimateRegions,
    bodyFeatures: context.draft?.profile.bodyFeatures,
  });
}

/**
 * The species/heritage line shared by the profile and attribute prompts: the
 * label (with the heritage in parens) plus the combined generic appearance.
 * Empty `label`-only when nothing extra is authored.
 */
function speciesForgeDescriptor(
  species: SpeciesDefinition,
  heritage: HeritageDefinition | undefined,
): { label: string; look: string } {
  const label = heritage ? `${species.label} (${heritage.label} heritage)` : species.label;
  const look = [species.appearance, heritage?.appearance ?? ""].map((p) => p.trim()).filter(Boolean).join(" ");
  return { label, look: look ? ` ${look}` : "" };
}

// ---------------------------------------------------------------------------
// Profile section
// ---------------------------------------------------------------------------

const profileSectionSchema = z.object({
  name: z.string().default(""),
  bio: z.string().default(""),
  personality: z.string().default(""),
  voice: z.string().default(""),
  /** Intimate disposition — how the character reads as a lover; surfaced to the narrator ONLY at the intimate exposure tier. */
  intimacy: z.string().default(""),
  /** Worked dialogue exemplars — few-shots of the character's voice/manner. */
  microExemplars: z
    .array(z.object({ situation: z.string().default(""), line: z.string().default("") }))
    .default([]),
  /** Structured voice anchors — pet phrases, cadence, never-says. */
  voiceAnchors: z
    .object({
      petPhrases: z.array(z.string()).default([]),
      cadence: z.string().default(""),
      neverSays: z.array(z.string()).default([]),
    })
    .default({ petPhrases: [], cadence: "", neverSays: [] }),
  /** Real/chronological age, free text — the narrator's `profile.age`, distinct from the visual `identity.apparent_age` attribute. */
  age: z.string().default(""),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Disposition tags — social-reaction labels, distinct from the library tags above. */
  dispositionTags: z.array(z.string()).default([]),
  /** Bespoke likes/dislikes — grounded against the concept vocabulary. */
  preferences: z
    .array(
      z.object({
        target: z.string().default(""),
        valence: z.enum(["like", "dislike"]).catch("dislike"),
        intensity: z.number().catch(5),
        hint: z.string().optional(),
      }),
    )
    .default([]),
  /** Atomic trait scalars — grounded against the trait registry + clamped. */
  traits: z
    .array(
      z.object({
        id: z.string().default(""),
        value: z.number().catch(0),
      }),
    )
    .default([]),
  /** Character drives — desires & secrets; grounded against the band vocabulary. */
  drives: z
    .array(
      z.object({
        want: z.string().default(""),
        why: z.string().default(""),
        secrecy: z.enum(["open", "guarded", "secret"]).catch("open"),
        revealBand: z
          .object({
            axis: z.enum(["familiarity", "regard"]).catch("familiarity"),
            band: z.string().default(""),
          })
          .optional()
          .catch(undefined),
      }),
    )
    .default([]),
  /** Daily rhythm — day-part rows, grounded to minute windows. */
  schedule: z
    .array(
      z.object({
        dayPart: z.enum(["morning", "afternoon", "evening", "night"]).catch("morning"),
        activity: z.string().default(""),
        locationName: z.string().default(""),
        /** Weekday indices 0=Sunday…6=Saturday; absent ⇒ daily. */
        days: z.array(z.number().int().min(0).max(6)).optional().catch(undefined),
      }),
    )
    .default([]),
  /**
   * Starting relationship toward the player —
   * emitted only when the concept places the player in it; grounded against
   * the band vocabulary. `mask` speaks the human phrasing; grounding maps it
   * onto the stored presented lean (colder_than_felt → masks_warmth).
   */
  playerRelationship: z
    .object({
      familiarity: z.string().default(""),
      regard: z.string().default(""),
      kind: z.string().default(""),
      history: z.string().default(""),
      mask: z.enum(["none", "colder_than_felt", "warmer_than_felt"]).catch("none"),
      note: z.string().default(""),
    })
    .optional()
    .catch(undefined),
  /** Personal social cards — the character's own hard lines; grounded against the concept vocabulary. */
  cards: z
    .array(
      z.object({
        label: z.string().default(""),
        description: z.string().default(""),
        kind: z.enum(["social_rule", "taboo"]).catch("taboo"),
        severity: z.number().catch(40),
        triggers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

type ProfileSection = z.infer<typeof profileSectionSchema>;

/** Ground forge preference targets against the concept vocabulary; drop unknowns. */
function groundPreferences(raw: ProfileSection["preferences"], sink?: DiagnosticSink): Preference[] {
  const valid = new Set([...interactionConceptIds(), ...interactionFamilies()]);
  const out: Preference[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    const target = p.target.trim().toLowerCase();
    if (!valid.has(target)) {
      if (target) sink?.push(diag("info", "forge.character.profile.unknown_preference", `dropped preference target "${p.target}"`));
      continue;
    }
    const key = `${target}::${p.valence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = p.hint?.trim();
    out.push({ target, valence: p.valence, intensity: Math.min(10, Math.max(1, Math.round(p.intensity))), ...(hint ? { hint } : {}) });
  }
  return out;
}

/**
 * Ground forge micro-exemplars (character-fidelity slice 6): drop rows with no line,
 * trim both fields, cap at MICRO_EXEMPLARS_MAX. A row's situation may be blank (a
 * standalone voice sample); the line is what makes the row worth keeping.
 */
export function groundMicroExemplars(raw: ProfileSection["microExemplars"], sink?: DiagnosticSink): MicroExemplar[] {
  const out: MicroExemplar[] = [];
  for (const e of raw) {
    if (out.length >= MICRO_EXEMPLARS_MAX) {
      sink?.push(diag("info", "forge.character.profile.micro_exemplars_capped", `dropped voice example "${e.line}": over the ${MICRO_EXEMPLARS_MAX}-example cap`));
      break;
    }
    const line = e.line.trim();
    if (!line) continue;
    out.push({ situation: e.situation.trim(), line });
  }
  return out;
}

/**
 * Ground forge voice anchors (character-fidelity slice 7): the schema trims each field,
 * drops blanks, and caps the lists — so grounding is a boundary parse. Empty input ⇒ the
 * empty anchors (no block rendered).
 */
export function groundVoiceAnchors(raw: ProfileSection["voiceAnchors"]): VoiceAnchors {
  return voiceAnchorsSchema.parse(raw);
}

/** Ground forge trait scalars against the registry: drop unknown ids, clamp to the axis range. */
function groundTraitValues(raw: ProfileSection["traits"], sink?: DiagnosticSink): TraitValue[] {
  const out: TraitValue[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const id = t.id.trim();
    const def = traitRegistry.byId(id);
    if (!def) {
      if (id) sink?.push(diag("info", "forge.character.profile.unknown_trait", `dropped trait "${t.id}"`));
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const { min, max } = axisRange(def.axis);
    out.push({ id, value: Math.min(max, Math.max(min, Math.round(t.value))), source: "creation" });
  }
  return out;
}

/**
 * The highest reveal gate the FORGE may author per axis: familiarity
 * `familiar`, regard `close`. Left to its own devices the
 * model gates secrets at the top band ("deeply_known"), which a normal chat
 * arc never reaches — the payoff the secret exists for never fires. A band
 * past the ceiling demotes to the ruled default (familiarity ≥ familiar) with
 * a diagnostic. Humans can still pick any band in the editor.
 */
const FORGE_REVEAL_CEILING: Record<"familiarity" | "regard", string> = { familiarity: "familiar", regard: "close" };

function isExtremeRevealBand(axis: "familiarity" | "regard", band: string): boolean {
  const bands = axis === "regard" ? regardBands : familiarityBands;
  const idx = bands.findIndex((b) => b.id === band);
  const ceiling = bands.findIndex((b) => b.id === FORGE_REVEAL_CEILING[axis]);
  return idx > ceiling;
}

/**
 * Ground forge drives (owner rulings 2026-07-12):
 * empty wants drop, duplicates (by normalized want) drop, over-length text
 * truncates, and the concept-led secret budget is enforced — a second `secret`
 * demotes to `guarded` with a diagnostic rather than shipping two lie licenses.
 * A revealBand is secret-only; an unknown band id drops the gate (the ruled
 * default — familiarity ≥ familiar — then applies) instead of locking the
 * secret behind a band that doesn't exist, and a band past the forge ceiling
 * (deeply_known; cherished+) demotes the same way.
 */
export function groundDrives(raw: ProfileSection["drives"], sink?: DiagnosticSink): Drive[] {
  const out: Drive[] = [];
  const seen = new Set<string>();
  let hasSecret = false;
  for (const d of raw) {
    if (out.length >= DRIVES_MAX) {
      sink?.push(diag("info", "forge.character.profile.drives_capped", `dropped drive "${d.want}": over the ${DRIVES_MAX}-drive cap`));
      break;
    }
    const want = d.want.trim().slice(0, DRIVE_WANT_MAX_CHARS);
    if (!want) continue;
    const key = want.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let secrecy = d.secrecy;
    if (secrecy === "secret" && hasSecret) {
      sink?.push(diag("info", "forge.character.profile.extra_secret", `demoted drive "${want}" to guarded: one secret per character`));
      secrecy = "guarded";
    }
    if (secrecy === "secret") hasSecret = true;
    let revealBand: Drive["revealBand"];
    if (secrecy === "secret" && d.revealBand) {
      const band = d.revealBand.band.trim().toLowerCase();
      const known = d.revealBand.axis === "regard" ? regardBandById(band) : familiarityBandById(band);
      if (known && isExtremeRevealBand(d.revealBand.axis, band)) {
        sink?.push(
          diag(
            "info",
            "forge.character.profile.extreme_reveal_band",
            `demoted reveal band "${band}" on "${want}" to the default gate: a normal arc never reaches it`,
          ),
        );
      } else if (known) {
        revealBand = { axis: d.revealBand.axis, band };
      } else if (band) {
        sink?.push(diag("info", "forge.character.profile.unknown_reveal_band", `dropped reveal band "${d.revealBand.band}" on "${want}": not a ${d.revealBand.axis} band`));
      }
    }
    out.push({ want, why: d.why.trim().slice(0, DRIVE_WHY_MAX_CHARS), secrecy, ...(revealBand ? { revealBand } : {}) });
  }
  return out;
}

/** Cap on forge-drafted schedule entries — a rhythm sketch, not a timetable. */
const SCHEDULE_FORGE_MAX = 4;

/**
 * Ground forge day-part schedule rows into
 * stored minute windows: the day-part vocabulary maps to its minutes, rows
 * missing an activity or place drop, duplicates (same day part + day mask)
 * drop, and the set caps at SCHEDULE_FORGE_MAX.
 */
export function groundSchedule(raw: ProfileSection["schedule"], sink?: DiagnosticSink): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (out.length >= SCHEDULE_FORGE_MAX) {
      sink?.push(diag("info", "forge.character.profile.schedule_capped", `dropped schedule row "${row.activity}": over the ${SCHEDULE_FORGE_MAX}-row cap`));
      break;
    }
    const part = scheduleDayPartById(row.dayPart);
    const activity = row.activity.trim();
    const locationName = row.locationName.trim();
    if (!part || !activity || !locationName) continue;
    const days = row.days?.length && row.days.length < 7 ? [...new Set(row.days)].sort((a, b) => a - b) : undefined;
    const key = `${part.id}::${days?.join(",") ?? "all"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      startMinute: part.startMinute,
      endMinute: part.endMinute,
      activity,
      locationName,
      ...(days ? { days } : {}),
    });
  }
  return out;
}

/**
 * Ground the forge's starting-relationship draft
 * into the profile's authored record. Band ids ground against the vocabulary
 * (an unknown band self-heals to the axis default with a diagnostic), text
 * truncates at the storage caps, and the human-phrased `mask` maps onto the
 * stored presented lean. A draft that grounds to the all-default record —
 * nothing the concept actually established — returns undefined so the profile
 * keeps its blank default and the editor shows an untouched Chat tab.
 */
export function groundPlayerRelationship(
  raw: ProfileSection["playerRelationship"],
  sink?: DiagnosticSink,
): CharacterProfile["playerRelationship"] | undefined {
  if (!raw) return undefined;
  const groundBand = (axis: "familiarity" | "regard", value: string, fallback: string): string => {
    const band = value.trim().toLowerCase();
    if (!band) return fallback;
    const known = axis === "regard" ? regardBandById(band) : familiarityBandById(band);
    if (known) return band;
    sink?.push(
      diag("info", "forge.character.profile.unknown_relationship_band", `dropped ${axis} band "${value}" on the starting relationship: not a known band`),
    );
    return fallback;
  };
  const familiarity = groundBand("familiarity", raw.familiarity, "strangers");
  const regard = groundBand("regard", raw.regard, "neutral");
  const kind = raw.kind.trim().slice(0, RELATIONSHIP_KIND_MAX);
  const history = raw.history.trim().slice(0, RELATIONSHIP_HISTORY_TEXT_MAX);
  const note = raw.note.trim().slice(0, PLAYER_RELATIONSHIP_NOTE_MAX);
  const presented =
    raw.mask === "colder_than_felt"
      ? ({ lean: "masks_warmth", note: "" } as const)
      : raw.mask === "warmer_than_felt"
        ? ({ lean: "masks_dislike", note: "" } as const)
        : undefined;
  const untouched =
    familiarity === "strangers" && regard === "neutral" && !kind && !history && !note && presented === undefined;
  if (untouched) return undefined;
  return { familiarity, regard, kind, history, presented, looming: false, note } as CharacterProfile["playerRelationship"];
}

/** Cap on forge-drafted personal cards — hard lines, not a rulebook. */
const CARDS_FORGE_MAX = 2;

/**
 * Ground the forge's personal social cards:
 * triggers ground against the interaction-concept vocabulary (unknowns drop);
 * a trigger the drafted PREFERENCES already opine on drops too — a bespoke
 * preference resolves ahead of any card (contracts/personality/cards.ts), so
 * such a card would be dead weight (`card_trigger_shadowed`). A card left
 * with no label or no triggers drops whole; the set caps at CARDS_FORGE_MAX.
 * Severity clamps to 0–100. Ids derive from the normalized label (contracts
 * mint none; the label-hash keeps demo-mode forges deterministic — resilience
 * §6 — and label-dedup below guarantees uniqueness within the set).
 */
export function groundSocialCards(
  raw: ProfileSection["cards"],
  preferences: readonly Preference[],
  sink?: DiagnosticSink,
): SocialReactionCard[] {
  const conceptIds = new Set(interactionConceptIds());
  const opined = new Set(preferences.map((p) => p.target.trim().toLowerCase()));
  const out: SocialReactionCard[] = [];
  const seen = new Set<string>();
  for (const card of raw) {
    if (out.length >= CARDS_FORGE_MAX) {
      sink?.push(diag("info", "forge.character.profile.cards_capped", `dropped card "${card.label}": over the ${CARDS_FORGE_MAX}-card cap`));
      break;
    }
    const label = card.label.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    const triggers: string[] = [];
    for (const rawTrigger of card.triggers) {
      const trigger = normalizeEnumToken(rawTrigger);
      if (!conceptIds.has(trigger)) {
        sink?.push(diag("info", "forge.character.profile.unknown_card_trigger", `dropped trigger "${rawTrigger}" on card "${label}": not an interaction concept`));
        continue;
      }
      if (opined.has(trigger)) {
        sink?.push(
          diag("info", "forge.character.profile.card_trigger_shadowed", `dropped trigger "${trigger}" on card "${label}": a drafted preference already covers it and resolves first`),
        );
        continue;
      }
      if (!triggers.includes(trigger)) triggers.push(trigger);
    }
    if (triggers.length === 0) {
      sink?.push(diag("info", "forge.character.profile.card_without_triggers", `dropped card "${label}": no valid triggers survived grounding`));
      continue;
    }
    seen.add(key);
    const severity = Math.min(100, Math.max(0, Math.round(card.severity)));
    out.push({
      id: `card_${fnv1a32(key).toString(36)}`,
      label,
      description: card.description.trim(),
      kind: card.kind,
      triggers,
      severity,
      reactionOverrides: [],
    });
  }
  return out;
}

/** Normalize forge disposition tags, preferring a canonical id, free-form tolerated. */
function groundDispositionTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const norm = normalizeTag(t);
    if (!norm) continue;
    const tag = canonicalTagId(norm) ?? norm;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

const PROFILE_SYSTEM =
  "You draft characters for a roleplaying engine. Write grounded, specific, playable characters — concrete detail over generality. Return only the requested fields.";

function traitVocabulary(): string {
  return traitRegistry.definitions
    .map((d) => {
      const { min, max } = axisRange(d.axis);
      const terms = d.lexicon
        .slice(0, 6)
        .map((l) => l.term)
        .join(", ");
      return `  - ${d.id} (${min}..${max}): ${d.description}${terms ? ` [e.g. ${terms}]` : ""}`;
    })
    .join("\n");
}

function profilePrompt(context: CharacterForgeContext): string {
  const species = speciesForForgeContext(context);
  const conceptVocab = [...interactionConceptIds(), ...interactionFamilies()].join(", ");
  const canonicalTags = dispositionTags.map((t) => t.id).join(", ");
  const lines = [
    "Draft a character from this concept:",
    context.prompt,
    "",
    "Produce: a display name, a 2-4 sentence bio, a personality sketch (quirks, humor, flaws),",
    "voice notes (how they sound and speak), their real/chronological age (a plain number when human-scaled,",
    "or a phrase like \"ancient\" / \"over 300 years\" for long-lived beings — this is their TRUE age, which may",
    "differ from how old they look), any aliases or nicknames, and 3-6 lowercase library tags",
    "(for search/categorization).",
    "",
    "Also draft the character's INTIMATE DISPOSITION — a short, tasteful note on how they read as a lover:",
    "their temperament, instincts, and preferences once things turn intimate. The game surfaces this to the",
    "narrator ONLY after a scene has actually become intimate, never in ordinary play, so write it frankly and",
    "specifically, but keep it to a sentence or two.",
    "- intimacy: 1-2 sentences on how this character is as an intimate partner, or \"\" when the concept gives no basis for one.",
    "",
    "Then infer the character's social DISPOSITION from the personality (used by the game, not just prose):",
    `- dispositionTags: 2-5 short trait labels. Prefer these canonical tags where they fit: ${canonicalTags}. Free-form is allowed but prefer canonical.`,
    `- preferences: 1-4 clear likes/dislikes that follow from the personality, each {target, valence: like|dislike, intensity: 1-10, hint}. target MUST be one of these interaction concepts/families: ${conceptVocab}. hint is a short note on how they react. Omit weak or generic preferences — sparse and characterful is correct.`,
    "- traits: scalar readings of the character's temperament, each {id, value}. Map any personality words you used onto the closest trait (negative value = the first/low pole, positive = the second/high pole), then infer the rest from role, species, and vibe. Emit a value for every trait you have a read on; a 0 means genuinely middling. Trait vocabulary (the example words show where the poles sit):",
    traitVocabulary(),
    "",
    `Then write ${MICRO_EXEMPLARS_MAX} short WORKED EXAMPLES of how this character actually talks — micro-exemplars the narrator few-shots from, so the voice, disposition, and age land in the prose, not just in the sliders:`,
    `- microExemplars: 2-${MICRO_EXEMPLARS_MAX} entries, each {situation (a short cue for a charged moment — "pushed to talk about her past", "someone flirts too fast", "caught in a lie"), line (how THIS character answers it, in their own voice — a spoken line and/or a small beat, e.g. 'A dry look. "That's a long story, and you haven't earned it.")}.`,
    "  Pick moments that SHOW the character's manner — how they deflect, tease, set a boundary, or soften — not neutral small talk. Write the line exactly as they'd say it (diction, rhythm, age); keep each to a sentence or two.",
    "",
    "Then give the concrete VOICE ANCHORS — the small, mechanical levers that keep the voice consistent across a long chat (these anchor the narrator near generation, not just the sliders):",
    "- voiceAnchors: {petPhrases (0-6 turns of phrase this character actually reaches for — a greeting, a verbal tic, a way they hedge or tease, e.g. \"no promises\", \"be serious\"), cadence (one line on their rhythm — clipped vs. rambling, dry, breathless, where they trail off), neverSays (0-6 words or registers that would be OUT of character for them — a word they'd never use, corporate-speak, baby-talk)}.",
    "  Keep every entry true to the personality and AGE above. Omit any field the concept gives no basis for — sparse and characterful beats a filled grid.",
    "",
    "Then give the character DRIVES — the desires & secrets they actively pursue (the game steers scenes with these):",
    `- drives: 0-${DRIVES_MAX} entries, each {want (a short concrete phrase), why (one line of motive), secrecy, revealBand?}.`,
    "  secrecy: \"open\" (talks about it freely — it steers what they bring up), \"guarded\" (never volunteers it; comes out only if genuinely asked), or \"secret\" (actively protected — they deflect and will lie to keep it hidden until the relationship earns the reveal).",
    "  Emit at most ONE secret, and only when the concept genuinely supports a hidden past or concealed motive; most characters carry open/guarded drives only.",
    `  A secret MAY set revealBand {axis: "familiarity" | "regard", band} — the relationship band at which revealing becomes possible (familiarity bands: ${familiarityBands.map((b) => b.id).join(", ")}; regard bands: ${regardBands.map((b) => b.id).join(", ")}). Pick a MID-ARC gate the story can actually reach — familiarity "familiar" or regard "warm"/"close"; higher gates are demoted to the default. Omit revealBand for the default (familiarity reaches "familiar").`,
    "  When you write a secret, put its actual substance in the why — the concrete truth being hidden, not just that a truth exists — so the eventual reveal has something coherent to land on.",
    "  Wants should be pursuable in conversation and specific to this character (\"to reopen the gallery under her own name\", not \"to be happy\"). Omit drives the concept gives no basis for — sparse is correct.",
    "",
    "Then sketch the character's DAILY RHYTHM (where their ordinary days go — the game grounds \"what I've been up to\" beats and off-screen movement in it):",
    `- schedule: 0-${SCHEDULE_FORGE_MAX} rows, each {dayPart: "morning" | "afternoon" | "evening" | "night", activity (short concrete phrase), locationName (a plain place name), days?}.`,
    "  days (optional): weekday indices 0=Sunday…6=Saturday, only when the routine isn't daily (e.g. [1,2,3,4,5] for a weekday shift). Cover the parts of the day the concept actually speaks to — a work shift and one leisure anchor beat a filled grid. Omit rows the concept gives no basis for.",
    "",
    "ONLY IF the concept describes a relationship between this character and the player (the person they will talk to — often written as \"the player\" or \"you\"), set the STARTING RELATIONSHIP:",
    "- playerRelationship: {familiarity, regard, kind, history, mask, note}.",
    `  familiarity — how well they know each other (knowledge, not feeling), one of: ${familiarityBands.map((b) => b.id).join(", ")}.`,
    `  regard — how the character genuinely FEELS about the player underneath (the mask below is what they show), one of: ${regardBands.map((b) => b.id).join(", ")}.`,
    `  kind — the label both would use ("ex-fiancés, nine years estranged", "her favorite client"), ≤${RELATIONSHIP_KIND_MAX} chars. history — ONE line of shared past the narrator can lean on, ≤${RELATIONSHIP_HISTORY_TEXT_MAX} chars.`,
    "  mask — \"none\" (honest, the overwhelming default), \"colder_than_felt\" (performs less warmth than they feel), or \"warmer_than_felt\" (performs more warmth than they feel).",
    `  note — one line that pre-fills a new conversation's opening scene (the moment, not the relationship), ≤${PLAYER_RELATIONSHIP_NOTE_MAX} chars.`,
    "  Omit playerRelationship entirely when the concept doesn't place the player in it — strangers/neutral is the default and never needs writing.",
    "",
    "ONLY IF the concept names a hard social line — a taboo or a rule the character enforces (\"hates being haggled over her art\", \"never affection where the town can see\"):",
    `- cards: 0-${CARDS_FORGE_MAX} entries, each {label (short name), description (what the rule forbids and how breaching it lands), kind: "social_rule" | "taboo", severity: 0-100 (25 a quirk they note, 40 real disapproval, 60 they shut it down hard, 80+ relationship-threatening), triggers}.`,
    `  triggers MUST be interaction-concept ids from: ${interactionConceptIds().join(", ")}. A card governs those classified acts outright.`,
    "  Do NOT duplicate a preference: if a like/dislike above already covers the concept, skip the card — preferences win over cards anyway. Most characters need NO cards; sparse is correct.",
  ];
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const { label, look } = speciesForgeDescriptor(species, heritageForForgeContext(context));
    lines.push("", `Resolved structural species: ${label}.${look} Keep the draft consistent with that species.`);
  }
  if (context.draft?.name) {
    lines.push("", `You are regenerating the profile of the draft currently named "${context.draft.name}". Keep the core concept.`);
  }
  return lines.join("\n");
}

async function forgeProfileSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const { value } = await generateChecked({
    ...FORGE_LEG_OPTIONS,
    schema: profileSectionSchema,
    system: PROFILE_SYSTEM,
    prompt: profilePrompt(context),
    temperature: 0.7,
    code: "forge.character.profile",
    sink: context.sink,
    fallback: context.useFallbacks === false ? undefined : demoCharacterProfileSection,
  });
  const section = value ?? profileSectionSchema.parse({});
  const preferences = groundPreferences(section.preferences, context.sink);
  const profile: Partial<CharacterProfile> = {
    bio: section.bio.trim(),
    personality: section.personality.trim(),
    aliases: section.aliases.map((a) => a.trim()).filter((a) => a.length > 0),
    tags: groundDispositionTags(section.dispositionTags),
    preferences,
    traits: groundTraitValues(section.traits, context.sink),
    microExemplars: groundMicroExemplars(section.microExemplars, context.sink),
    voiceAnchors: groundVoiceAnchors(section.voiceAnchors),
    drives: groundDrives(section.drives, context.sink),
    schedule: groundSchedule(section.schedule, context.sink),
  };
  const playerRelationship = groundPlayerRelationship(section.playerRelationship, context.sink);
  if (playerRelationship) profile.playerRelationship = playerRelationship;
  const socialCards = groundSocialCards(section.cards, preferences, context.sink);
  if (socialCards.length > 0) profile.socialCards = socialCards;
  const voice = section.voice.trim();
  if (voice) profile.voice = voice;
  const intimacy = section.intimacy.trim();
  if (intimacy) profile.intimacy = intimacy;
  const age = section.age.trim();
  if (age) profile.age = age;
  const species = speciesForForgeContext(context);
  if (species) {
    const heritage = heritageForForgeContext(context);
    profile.speciesId = species.id;
    profile.heritageId = heritage?.id;
    profile.bodyPlanId = species.bodyPlanId;
    const groups = [...(species.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
    profile.bodyFeatures = groups.length > 0 ? [...new Set(groups)] : undefined;
  }
  return {
    name: section.name.trim(),
    tags: section.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
    profile,
  };
}

// ---------------------------------------------------------------------------
// Attributes section (registry-derived schema)
// ---------------------------------------------------------------------------

export interface RawAttributeEntry {
  id: string;
  value: string | string[] | number | boolean;
}

/** Model-emitted plausible subset for an unset [CORE] enum attribute. */
export interface RawAttributeRange {
  id: string;
  plausible: string[];
}

export interface AttributeSection {
  attributes: RawAttributeEntry[];
  ranges: RawAttributeRange[];
}

export function characterAttributeDefinitions(context?: CharacterForgeContext): readonly AttributeDefinition[] {
  const realizedBody = context ? realizedBodyForForgeContext(context) : undefined;
  // Anatomy-specific attributes are excluded from the forge vocabulary until
  // the forge can also infer the body-config that realizes them. Intimate
  // regions are seeded from gender below; additive feature groups enter only
  // when the prompt/draft resolves a feature-bearing species.
  return attributeRegistry.definitions.filter(
    (d) =>
      (d.appliesToEntityKinds ?? ["character"]).includes("character") &&
      !isIntimateAttributeCategory(d.category) &&
      (!isFeatureAttributeCategory(d.category) || (realizedBody?.isAttributeApplicable(d) ?? false)),
  );
}

/**
 * Built dynamically from the registry so the model only ever sees validated
 * vocabulary: ids are an enum of registered attribute ids. Values are still
 * grounded post-hoc with registry.parseValue (docs/authoring/README.md
 * §Guardrails).
 */
export function buildAttributeSectionSchema(context?: CharacterForgeContext): z.ZodType<AttributeSection> {
  const ids = characterAttributeDefinitions(context).map((d) => d.id as string);
  // The registry is never empty in practice; the string fallback keeps an
  // empty registry from producing an invalid z.enum([]).
  const idSchema = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string().min(1);
  return z.object({
    attributes: z
      .array(
        z.object({
          id: idSchema,
          value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
        }),
      )
      .default([]),
    ranges: z
      .array(
        z.object({
          id: idSchema,
          plausible: z
            .array(z.string())
            .describe("Plausible subset of the attribute's allowed values, conditioned on the identity anchors."),
        }),
      )
      .default([])
      .describe("For [CORE]/[RENDER] enum attributes you could not pin to a definite value: a plausible subset of allowed values."),
  });
}

function normalizeEnumToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Ground raw model output against the registry: invalid or unknown values are
 * dropped with a diagnostic, never saved. Survivors carry source "creation".
 * When a `realizedBody` is supplied, a definite enum value outside the resolved
 * species' narrowed set is also dropped (e.g. "rounded" ears on an elf) — the
 * gap is then refilled from the narrowed vocabulary by the species/core-visual
 * default passes, so the species invariant holds even if the model disobeys.
 */
export function groundAttributeValues(
  entries: readonly RawAttributeEntry[],
  sink?: DiagnosticSink,
  code = "forge.character.attributes",
  realizedBody?: RealizedBody,
): AttributeValue[] {
  const grounded: AttributeValue[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      sink?.push(diag("info", `${code}.duplicate_id`, `dropped duplicate attribute "${entry.id}"`));
      continue;
    }
    let parsed = attributeRegistry.parseValue(entry.id, entry.value);
    if (!parsed.ok && typeof entry.value === "string") {
      // Salvage common model slips: "Dark Brown" → "dark_brown".
      parsed = attributeRegistry.parseValue(entry.id, normalizeEnumToken(entry.value));
    }
    if (!parsed.ok && Array.isArray(entry.value)) {
      parsed = attributeRegistry.parseValue(entry.id, entry.value.map(normalizeEnumToken));
    }
    if (!parsed.ok) {
      sink?.push(
        diag("warn", `${code}.invalid_value`, `dropped attribute "${entry.id}": ${parsed.issues.join("; ")}`, {
          context: { id: entry.id, value: entry.value },
        }),
      );
      continue;
    }
    const def = attributeRegistry.byId(entry.id);
    if (realizedBody && def?.valueType === "enum" && typeof parsed.value === "string") {
      const allowed = realizedBody.allowedValuesFor(def);
      if (allowed && !allowed.includes(parsed.value)) {
        sink?.push(
          diag("warn", `${code}.species_disallowed_value`, `dropped "${entry.id}=${parsed.value}": not allowed for the resolved species`, {
            context: { id: entry.id, value: parsed.value },
          }),
        );
        continue;
      }
    }
    seen.add(entry.id);
    // parseValue success implies a registered id, which satisfies the pattern.
    grounded.push({ id: entry.id as AttributeValue["id"], value: parsed.value, source: "creation" });
  }
  return grounded;
}

/**
 * Ground model-emitted plausible ranges against the registry: a range on an
 * unknown id or a non-enum attribute drops whole, out-of-vocabulary members
 * drop individually (both `forge.character.attributes.invalid_range_member`),
 * and a range emptied by grounding drops entirely — fillVisualDefaults
 * then treats that attribute as unconstrained. Survivors map id → subset of
 * the attribute's allowedValues.
 */
export function groundAttributeRanges(
  ranges: readonly RawAttributeRange[],
  sink?: DiagnosticSink,
  code = "forge.character.attributes",
): Map<string, string[]> {
  const grounded = new Map<string, string[]>();
  for (const range of ranges) {
    if (grounded.has(range.id)) {
      sink?.push(diag("info", `${code}.duplicate_id`, `dropped duplicate range for "${range.id}"`));
      continue;
    }
    const def = attributeRegistry.byId(range.id);
    if (!def || def.valueType !== "enum" || !def.allowedValues || def.allowedValues.length === 0) {
      sink?.push(
        diag("warn", `${code}.invalid_range_member`, `dropped range for "${range.id}": not a registered enum attribute`, {
          context: { id: range.id, plausible: range.plausible },
        }),
      );
      continue;
    }
    const members: string[] = [];
    for (const raw of range.plausible) {
      const member = normalizeEnumToken(raw);
      if (!def.allowedValues.includes(member)) {
        sink?.push(
          diag("warn", `${code}.invalid_range_member`, `dropped out-of-vocabulary range member "${raw}" on "${range.id}"`, {
            context: { id: range.id, member: raw },
          }),
        );
        continue;
      }
      if (!members.includes(member)) members.push(member);
    }
    // A range emptied by grounding drops entirely — better unconstrained than
    // constrained to nothing (the member drops above already told the dev).
    if (members.length === 0) continue;
    grounded.set(range.id, members);
  }
  return grounded;
}

const ATTRIBUTES_SYSTEM = [
  "You translate a character concept into a fixed attribute vocabulary. Use only the listed attribute ids and allowed values.",
  "First infer the identity anchors (marked [ANCHOR]) — heritage, apparent age, gender — from any cue the text offers, and emit the ones it supports as attributes.",
  "Where the text states or strongly implies a value for any attribute, emit it as a definite attribute value.",
  "For each [CORE] or [RENDER] enum attribute you cannot pin to a definite value, emit a ranges entry instead: a plausible subset of its allowed values, conditioned on the identity anchors you inferred.",
  "Guardrails: identity anchors may constrain physical attributes only — coloring, features, build. Heritage must never feed personality, voice, behavior, or role suggestions. Ranges are soft priors that explicit text always overrides — when the text pins a value, emit the definite value and no range for that attribute. When the identity signal is weak, emit wide ranges or none.",
  "Attributes describe THIS PERSON'S body, not the setting's mood: never map scene or life-circumstance adjectives (a weathered town, a hard year, a gloomy harbor) onto skin, hair, or build unless the text says it of the body itself.",
  'Worked example — text overrides the prior: "a Latina engineer with dyed silver hair" gives identity.heritage = "Latina" and hair.color = "gray" as definite values (the dye job in the text beats the heritage prior — no hair.color range), while eyes.color, unstated, gets a range like ["brown", "dark_brown", "hazel"].',
  "For everything else, omit any attribute the concept gives no basis for — sparse is correct.",
].join("\n");

export function describeConstraint(def: AttributeDefinition, allowedValues?: readonly string[]): string {
  const allowed = allowedValues ?? def.allowedValues ?? [];
  // Choices carry their narrator gloss when authored — the same authored string the
  // read-side prompts render — so the forge picks the member that MEANS what it wants.
  const choice = (v: string): string => (def.narratorGuidance?.[v] ? `${v} (${def.narratorGuidance[v]})` : v);
  switch (def.valueType) {
    case "enum":
      return `one of: ${allowed.map(choice).join(" | ")}`;
    case "enum_list":
      return `list from: ${allowed.map(choice).join(" | ")}`;
    case "number": {
      const range = def.min !== undefined || def.max !== undefined ? ` ${def.min ?? ""}-${def.max ?? ""}` : "";
      return `number${range}${def.unit ? ` ${def.unit}` : ""}`;
    }
    case "text":
      return "short free text";
    case "flag":
      return "true or false";
  }
}

function attributesPrompt(context: CharacterForgeContext): string {
  const realizedBody = realizedBodyForForgeContext(context);
  let hasSpeciesTrait = false;
  const vocabulary = characterAttributeDefinitions(context)
    .map((def) => {
      const allowed = realizedBody?.allowedValuesFor(def);
      const required = realizedBody?.isAttributeRequired(def) ?? false;
      if (required) hasSpeciesTrait = true;
      const speciesDefault = realizedBody?.defaultValueFor(def);
      const defaultHint =
        required && typeof speciesDefault === "string" ? ` (species default: ${speciesDefault})` : "";
      const tags = `${def.coreVisual ? " [CORE]" : ""}${def.renderVisual ? " [RENDER]" : ""}${def.identityAnchor ? " [ANCHOR]" : ""}${required ? " [SPECIES]" : ""}`;
      return `- ${def.id}${tags} (${describeConstraint(def, allowed)})${defaultHint}: ${def.description}`;
    })
    .join("\n");
  const lines = [
    "Character concept:",
    context.prompt,
  ];
  const species = speciesForForgeContext(context);
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const { label, look } = speciesForgeDescriptor(species, heritageForForgeContext(context));
    lines.push(
      "",
      `Resolved structural species: ${label}.${look} Include its visible feature morphology when the vocabulary lists it; choose attribute values consistent with this generic look unless the concept says otherwise.`,
    );
  }
  if (hasSpeciesTrait) {
    lines.push(
      "",
      "Attributes marked [SPECIES] are inherent to the resolved species — emit a value within the (narrowed) allowed set shown; if unsure, the species default is used.",
    );
  }
  const bio = context.draft?.profile.bio;
  if (bio) lines.push("", "Drafted bio:", bio);
  lines.push(
    "",
    "Attribute vocabulary:",
    vocabulary,
    "",
    "Infer the [ANCHOR] attributes first. Emit definite values where the concept supports them; for each [CORE] or [RENDER] enum attribute left without a definite value, emit a ranges entry with the plausible subset of its allowed values given the anchors. Fill the others only where the concept supports them; omit the rest.",
  );
  return lines.join("\n");
}

async function forgeAttributesSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const { value } = await generateChecked({
    ...FORGE_LEG_OPTIONS,
    schema: buildAttributeSectionSchema(context),
    system: ATTRIBUTES_SYSTEM,
    prompt: attributesPrompt(context),
    code: "forge.character.attributes",
    sink: context.sink,
    fallback: context.useFallbacks === false ? undefined : demoCharacterAttributeSection,
  });
  const section = value ?? { attributes: [], ranges: [] };
  const realizedBody = realizedBodyForForgeContext(context);
  const grounded = groundAttributeValues(section.attributes, context.sink, undefined, realizedBody);
  const ranges = groundAttributeRanges(section.ranges, context.sink);
  // Species-required defaults first (e.g. elf ears.shape = "pointed") so the
  // core-visual pass treats them as already present, then the core-visual fill.
  const seeded = fillSpeciesRequiredDefaults(grounded, realizedBody, context.sink);
  const filled = fillVisualDefaults(seeded, context.prompt, context.sink, ranges, realizedBody);
  // Persisted-baseline facts (materializeDefault) ground here too, so a forged
  // draft shows them in the editor rather than acquiring them silently on save.
  // Fill-only — anything the model inferred (a prompt that mentioned her feet)
  // wins; the fixed default is the point for these, unlike the concept-varied
  // core-visual fills above.
  const attributes = materializeRegistryDefaults(
    filled,
    realizedBody === undefined
      ? {}
      : {
          isApplicable: (def) => realizedBody.isAttributeApplicable(def),
          allowedValuesFor: (def) => realizedBody.allowedValuesFor(def),
          ruleDefaultFor: (def) => realizedBody.defaultValueFor(def),
        },
  );
  // Seed the body-config declaratively from the attribute values' activatesGroups
  // (e.g. identity.gender) — a SEED, overridable in the editor. gender is now
  // coreVisual, so it is always present and the seed is reliable. Intimate
  // attribute values stay empty; the human authors them.
  const { intimateRegions } = seedBodyConfigFromAttributes(attributes);
  return { profile: { attributes, intimateRegions } };
}

/**
 * Seed species-required attribute defaults the model left unset. Unlike
 * fillVisualDefaults this is NOT limited to visual-flagged attributes: a
 * species `required` rule with a `defaultValue` (elf `ears.shape` = "pointed")
 * guarantees the trait is present on every member of that species. A value the
 * model already emitted for the id wins — present ids are never overwritten;
 * the species default only fills the gap. The default is validated against the
 * registry so a bad data edit surfaces as a diagnostic, not a stored bad value.
 */
export function fillSpeciesRequiredDefaults(
  values: readonly AttributeValue[],
  realizedBody: RealizedBody | undefined,
  sink?: DiagnosticSink,
): AttributeValue[] {
  const filled = [...values];
  if (!realizedBody) return filled;
  const present = new Set(values.map((v) => v.id));
  const added: string[] = [];
  for (const def of attributeRegistry.definitions) {
    if (present.has(def.id) || !realizedBody.isAttributeApplicable(def)) continue;
    if (!realizedBody.isAttributeRequired(def)) continue;
    const raw = realizedBody.defaultValueFor(def);
    if (raw === undefined) continue;
    const parsed = attributeRegistry.parseValue(def.id, raw);
    if (!parsed.ok) {
      sink?.push(
        diag("warn", "forge.character.attributes.species_default_invalid", `species default for "${def.id}" rejected: ${parsed.issues.join("; ")}`, {
          context: { id: def.id, value: raw },
        }),
      );
      continue;
    }
    filled.push({ id: def.id as AttributeValue["id"], value: parsed.value, source: "creation" });
    added.push(`${def.id}=${String(parsed.value)}`);
  }
  if (added.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.species_defaults", `seeded species-required defaults: ${added.join(", ")}`),
    );
  }
  return filled;
}

/**
 * Tier-3 fill (docs/authoring/character-forge.md §The three-tier fill): every
 * registry attribute flagged coreVisual OR renderVisual (the render-consistency tier: silhouette
 * + face structure a scene render would
 * otherwise re-invent per image) that the model left unset gets a default
 * picked from its surviving plausible range when one exists — falling through
 * to the full allowedValues when none does — seeded by (concept, attribute
 * id). Seeded rather than random on purpose — different concepts get varied
 * defaults (an LLM asked to "pick randomly" converges on brown/brown), while
 * the same input still forges the same draft (demo-mode determinism,
 * docs/resilience.md §6). A definite value always beats a range for the same
 * id — present ids are never filled. Enum-only: a default we can't pick from
 * a closed list isn't a default worth inventing.
 */
export function fillVisualDefaults(
  values: readonly AttributeValue[],
  seedText: string,
  sink?: DiagnosticSink,
  ranges?: ReadonlyMap<string, readonly string[]>,
  realizedBody?: RealizedBody,
): AttributeValue[] {
  const present = new Set(values.map((v) => v.id));
  const filled = [...values];
  const added: string[] = [];
  const unconstrained: string[] = [];
  for (const def of characterAttributeDefinitions()) {
    if ((!def.coreVisual && !def.renderVisual) || present.has(def.id)) continue;
    if (def.valueType !== "enum" || !def.allowedValues || def.allowedValues.length === 0) continue;
    // Pick within the resolved species' narrowed set when one applies, so a
    // core-visual default (e.g. orc build.height) can't fall outside the
    // species' band. Falls back to the definition's own values.
    const baseAllowed = realizedBody?.allowedValuesFor(def) ?? def.allowedValues;
    if (baseAllowed.length === 0) continue;
    // A model range is a soft prior over the definition; intersect it with the
    // species band so an off-species range member can't be picked.
    const rawRange = ranges?.get(def.id);
    const range = rawRange ? rawRange.filter((v) => baseAllowed.includes(v)) : undefined;
    const constrained = range !== undefined && range.length > 0;
    let pool: readonly string[] = constrained ? range : baseAllowed;
    if (!constrained) {
      unconstrained.push(def.id);
      // No signal at all: pick from the (species-narrowed) vocabulary minus
      // members the registry marks as never-auto-default (e.g. minor apparent
      // ages). A human or the model can still set those explicitly; we just
      // never seed one. Fall back to the full pool if exclusion would empty it.
      const excl = def.autoDefaultExcludes;
      if (excl && excl.length > 0) {
        const filtered = baseAllowed.filter((v) => !excl.includes(v));
        if (filtered.length > 0) pool = filtered;
      }
    }
    const pick = pool[fnv1a32(`${seedText}::${def.id}`) % pool.length];
    if (!pick) continue;
    filled.push({ id: def.id, value: pick, source: "creation" });
    added.push(`${def.id}=${pick}`);
  }
  if (added.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.visual_defaults", `filled visual defaults: ${added.join(", ")}`),
    );
  }
  if (unconstrained.length > 0) {
    sink?.push(
      diag(
        "info",
        "forge.character.attributes.unconstrained_default",
        `no plausible range for ${unconstrained.join(", ")}: picked from the full vocabulary`,
        { context: { ids: unconstrained } },
      ),
    );
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Outfit section
// ---------------------------------------------------------------------------

const outfitItemSchema = z.object({
  name: z.string().min(1),
  /** Reuse an existing wardrobe item by its candidate id instead of defining a new garment. */
  reuseId: z.string().optional().catch(undefined),
  description: z.string().default(""),
  /** Coverage template id (contracts/items/clothing-categories.ts); anchors coverage + layer. */
  category: z.string().optional().catch(undefined),
  /** Wearer-target id (contracts/items/wearer.ts): who the garment is cut for. */
  wearer: z.string().optional().catch(undefined),
  /** Primary color: family id (contracts/items/colors.ts) + optional free-text shade. */
  color: z
    .object({ family: z.string().min(1), shade: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  layer: clothingLayerSchema.optional().catch(undefined),
  coverage: z.array(z.string()).default([]),
  opacity: z.enum(["opaque", "sheer"]).catch("opaque"),
  sensory: z
    .object({
      appearance: z.string().optional(),
      scent: z.string().optional(),
      tactile: z.string().optional(),
    })
    .default({}),
  tags: z.array(z.string()).default([]),
});

const outfitSectionSchema = z.object({
  outfit: z.array(outfitItemSchema).default([]),
});

export type OutfitSection = z.infer<typeof outfitSectionSchema>;
export type OutfitItem = z.infer<typeof outfitItemSchema>;

export interface OutfitReusePartition {
  /** Existing library item ids the agent chose to reuse (deduped, in order). */
  reuseIds: string[];
  /** Entries with no valid reuse, to be grounded as new garments. */
  fresh: OutfitSection;
}

/**
 * Split the agent's outfit into reuse references and fresh garments. A reuseId
 * naming a real candidate becomes a library reference; an unknown reuseId
 * (the model hallucinated it) degrades to a fresh garment grounded from its own
 * fields, with a diagnostic (docs/resilience.md §1) — never a failed forge.
 */
export function partitionOutfitReuse(
  section: OutfitSection,
  candidateIds: ReadonlySet<string>,
  sink?: DiagnosticSink,
  code = "forge.character.outfit",
): OutfitReusePartition {
  const reuseIds: string[] = [];
  const fresh: OutfitItem[] = [];
  for (const item of section.outfit) {
    const reuseId = item.reuseId?.trim();
    if (reuseId) {
      if (candidateIds.has(reuseId)) {
        if (!reuseIds.includes(reuseId)) reuseIds.push(reuseId);
        continue;
      }
      sink?.push(
        diag("warn", `${code}.unknown_reuse`, `ignored unknown reuse id "${reuseId}" on "${item.name}"; drafting it as a new garment`, {
          context: { item: item.name, reuseId },
        }),
      );
    }
    fresh.push(item);
  }
  return { reuseIds, fresh: { outfit: fresh } };
}

/**
 * Validate coverage against the body-location registry (unknown ids drop with
 * a diagnostic), then re-validate each constructed definition — a garment that
 * fails the item schema drops with a diagnostic instead of throwing
 * (docs/resilience.md §1).
 */
export function groundOutfitItems(section: OutfitSection, sink?: DiagnosticSink, code = "forge.character.outfit"): ItemDefinition[] {
  const items: ItemDefinition[] = [];
  for (const item of section.outfit) {
    const category = item.category ? clothingCategoryById(normalizeEnumToken(item.category)) : undefined;
    if (item.category && !category) {
      sink?.push(diag("info", `${code}.unknown_category`, `ignored unknown clothing category "${item.category}" on "${item.name}"`));
    }
    const wearer = item.wearer ? wearerTargetById(normalizeEnumToken(item.wearer)) : undefined;
    if (item.wearer && !wearer) {
      sink?.push(diag("info", `${code}.unknown_wearer`, `ignored unknown wearer target "${item.wearer}" on "${item.name}"`));
    }
    const colorFamily = item.color ? colorFamilyById(normalizeEnumToken(item.color.family)) : undefined;
    if (item.color && !colorFamily) {
      sink?.push(diag("info", `${code}.unknown_color`, `ignored unknown color family "${item.color.family}" on "${item.name}"`));
    }
    const coverage: string[] = [];
    for (const raw of item.coverage) {
      const locationId = normalizeEnumToken(raw);
      if (!bodyLocationRegistry.byId(locationId)) {
        sink?.push(
          diag("warn", `${code}.invalid_coverage`, `dropped unknown body location "${raw}" on "${item.name}"`, {
            context: { item: item.name, bodyLocationId: raw },
          }),
        );
        continue;
      }
      if (!coverage.includes(locationId)) coverage.push(locationId);
    }
    const parsed = parseOrNull(
      itemDefinitionSchema,
      {
        kind: "clothing",
        name: item.name,
        description: item.description,
        // the category template anchors anything the model left unset
        category: category?.id,
        wearer: wearer?.id,
        color: colorFamily ? { family: colorFamily.id, shade: item.color?.shade } : undefined,
        coverage: coverage.length > 0 ? coverage : [...(category?.coverage ?? [])],
        layer: item.layer ?? category?.layer ?? 1,
        opacity: item.opacity,
        sensory: item.sensory,
        tags: item.tags,
      },
      sink,
      `${code}.item`,
    );
    if (!parsed) {
      sink?.push(diag("warn", `${code}.invalid_item`, `dropped garment "${item.name}": failed item validation`, { context: { item: item.name } }));
      continue;
    }
    items.push(parsed);
  }
  return items;
}

const OUTFIT_SYSTEM =
  "You design a character's default outfit for a roleplaying engine. Each garment lists which body locations it covers and which layer it sits on. Layers: 0 underwear, 1 base, 2 mid, 3 outerwear.";

function outfitPrompt(context: CharacterForgeContext, candidates: readonly ClothingCandidate[]): string {
  const locationIds = bodyLocationRegistry.all
    .filter((l) => l.coverageRelevant)
    .map((l) => l.id)
    .join(", ");
  const lines = [
    "Character concept:",
    context.prompt,
  ];
  const bio = context.draft?.profile.bio;
  if (bio) lines.push("", "Drafted bio:", bio);
  lines.push(
    "",
    `Valid coverage body locations: ${locationIds}`,
    `Clothing categories (set one per garment where it fits; it anchors coverage): ${clothingCategories.map((c) => c.id).join(", ")}`,
    `Wearer target (set per garment): ${wearerTargets.map((w) => w.id).join(", ")} — match the character's presentation; use unisex for anything not gender-cut.`,
    `Primary color (set per garment): "color": { "family": one of ${colorFamilyIds.join(", ")}; "shade": the precise hue in a word or two, e.g. "aqua", "olive" }.`,
    "",
    "Cover only what the garment really covers. A t-shirt covers chest, back, shoulders, waist, upper_arms — never forearms or hands. Note that arms includes hands and torso includes neck, so prefer the specific parts.",
  );
  if (candidates.length > 0) {
    lines.push(
      "",
      'You may reuse a wardrobe item this character already owns instead of inventing one: set that garment\'s "reuseId" to the listed id. Prefer reusing an existing generic basic that fits (any t-shirt, jeans, sweater, plain footwear) — minor colour or detail differences do not matter. Define a NEW garment (leave reuseId unset) for a signature or character-defining piece, or when nothing listed fits.',
      "",
      "Existing wardrobe you can reuse:",
      ...candidates.map((c) => {
        const coverage = c.coverage.length > 0 ? ` — covers ${c.coverage.join(", ")}` : "";
        const layer = c.layer === undefined ? "" : ` (layer ${c.layer})`;
        return `- ${c.id}: ${c.name}${layer}${coverage}`;
      }),
    );
  }
  lines.push(
    "",
    "Suggest 3-6 garments for the character's everyday default outfit, with a short sensory description each.",
  );
  return lines.join("\n");
}

async function forgeOutfitSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const listCandidates = context.listCandidates ?? listClothingCandidates;
  let candidates: ClothingCandidate[] = [];
  try {
    candidates = await listCandidates(context.userId, CANDIDATE_LIMIT);
  } catch (err) {
    context.sink?.push(
      diag("warn", "forge.character.outfit.candidates_failed", `wardrobe candidate lookup failed: ${errorText(err)}`),
    );
  }
  if (candidates.length >= CANDIDATE_LIMIT) {
    context.sink?.push(
      diag(
        "info",
        "forge.character.outfit.candidates_capped",
        `offered the ${CANDIDATE_LIMIT} most-recent wardrobe items as reuse candidates; older items were not shown to the agent`,
      ),
    );
  }

  const { value } = await generateChecked({
    ...FORGE_LEG_OPTIONS,
    schema: outfitSectionSchema,
    system: OUTFIT_SYSTEM,
    prompt: outfitPrompt(context, candidates),
    temperature: 0.5,
    code: "forge.character.outfit",
    sink: context.sink,
    fallback: context.useFallbacks === false ? undefined : demoCharacterOutfitSection,
  });
  const section = value ?? outfitSectionSchema.parse({});
  const { reuseIds, fresh } = partitionOutfitReuse(section, new Set(candidates.map((c) => c.id)), context.sink);
  const items = groundOutfitItems(fresh, context.sink);
  const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(
    items,
    context.userId,
    context.findItems ?? findItemsByName,
    context.sink,
  );
  // Explicit reuses lead; library name-matches on fresh garments follow (deduped).
  // The forge drafts the DEFAULT preset (outfits[0], ux-improvements slice 8).
  const presetItems = [...new Set([...reuseIds, ...defaultOutfit])];
  return {
    profile: { outfits: presetItems.length > 0 ? [{ id: "everyday", name: "Everyday", items: presetItems }] : [] },
    suggestedItems: suggested,
  };
}

/**
 * Library matching (docs/authoring/character-forge.md §The outfit agent):
 * name-matched garments reference the
 * existing library item id in defaultOutfit; unmatched ones become new item
 * drafts flagged "suggested". A failed lookup degrades to all-suggested.
 */
export async function matchOutfitAgainstLibrary(
  items: readonly ItemDefinition[],
  userId: string,
  findItems: LibraryLookup,
  sink?: DiagnosticSink,
): Promise<{ defaultOutfit: string[]; suggested: ItemDefinition[] }> {
  if (items.length === 0) return { defaultOutfit: [], suggested: [] };
  let rows: ReadonlyArray<{ id: string; name: string }> = [];
  try {
    rows = await findItems(userId, items.map((i) => i.name));
  } catch (err) {
    sink?.push(
      diag("warn", "forge.character.outfit.library_lookup_failed", `item library lookup failed: ${errorText(err)}`),
    );
  }
  const idByName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const defaultOutfit: string[] = [];
  const suggested: ItemDefinition[] = [];
  for (const item of items) {
    const libraryId = idByName.get(item.name.toLowerCase());
    if (libraryId) {
      if (!defaultOutfit.includes(libraryId)) defaultOutfit.push(libraryId);
    } else {
      suggested.push({ ...item, tags: item.tags.includes("suggested") ? item.tags : [...item.tags, "suggested"] });
    }
  }
  return { defaultOutfit, suggested };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Demo fallbacks (docs/resilience.md §6): deterministic hand-written sample so
// the forge UX works keyless, routed through the same generateChecked path.
// ---------------------------------------------------------------------------

export function demoCharacterProfileSection(): ProfileSection {
  return {
    name: "Maren Voss",
    bio: "Maren Voss has run the Greywater Harbor quay for eleven years, since the night her predecessor sailed out drunk and never came back. She knows every hull by its creak and every captain by their lies. A dock crane took her left knee's best years; the limp slows her walk but never her ledger.",
    personality:
      "Dry, watchful, unhurried. Keeps a soft spot for green deckhands and a colder shelf for smooth talkers. Allergic to paperwork, flattery, and being thanked.",
    voice: "Low and gravelled; clipped harbor slang; says less than she knows and means more than she says.",
    intimacy:
      "Guarded and unshowy about it, the way she is everywhere else — slow to let the walls down, but steady, unhurried, and quietly generous once she trusts you that far.",
    microExemplars: [
      { situation: "thanked warmly for a kindness", line: 'She waves it off before you finish. "Don\'t. It\'s a job, not a favor."' },
      { situation: "a smooth talker lays on the flattery", line: 'A flat look over the ledger. "You want something. Get to it or get off my quay."' },
      { situation: "a green deckhand admits they\'re scared", line: 'A long pause, then, quieter: "Good. Means you\'re paying attention. Now tie it off proper."' },
    ],
    voiceAnchors: {
      petPhrases: ["off my quay", "tie it off proper", "means you're paying attention"],
      cadence: "Clipped and low; short sentences, long pauses; trails off rather than softens.",
      neverSays: ["gushing praise", "corporate jargon", "please and thank-you niceties"],
    },
    age: "52",
    aliases: ["Voss", "the harbor-master"],
    tags: ["harbor", "gruff", "mentor", "working-class"],
    dispositionTags: ["stoic", "proud", "gentle"],
    preferences: [
      { target: "compliment", valence: "dislike", intensity: 6, hint: "flattery makes her wary; she'd rather be useful than admired" },
      { target: "confide", valence: "like", intensity: 5, hint: "a green deckhand trusting her with something real softens her" },
    ],
    traits: [
      { id: "temperament.warmth", value: -20 },
      { id: "temperament.composure", value: 60 },
      { id: "temperament.confidence", value: 55 },
      { id: "temperament.optimism", value: -15 },
      { id: "social.extraversion", value: -40 },
      { id: "social.agreeableness", value: -25 },
      { id: "social.guardedness", value: 45 },
      { id: "social.dominance", value: 40 },
    ],
    drives: [
      {
        want: "to keep her dock crews employed through the slow season",
        why: "the harbor keeps people fed or it keeps nothing",
        secrecy: "open",
      },
      {
        want: "to learn what really happened the night her predecessor sailed out",
        why: "she countersigned the log that called the weather clear",
        secrecy: "secret",
        revealBand: { axis: "familiarity", band: "familiar" },
      },
    ],
    schedule: [
      { dayPart: "morning", activity: "walking the quay and checking moorings", locationName: "Greywater Harbor" },
      { dayPart: "afternoon", activity: "working the ledgers and berth disputes", locationName: "the harbor office" },
      { dayPart: "evening", activity: "one slow pint at a corner table", locationName: "the Rusted Anchor", days: [5, 6] },
    ],
    playerRelationship: {
      familiarity: "acquainted",
      regard: "friendly",
      kind: "the green deckhand she's taken under her wing",
      history: "You crewed a season under her eye; she signed off your papers and never said she was glad you stayed.",
      mask: "colder_than_felt",
      note: "Early fog on the quay; Maren is checking moorings and pretends not to notice you falling into step beside her.",
    },
    cards: [
      {
        label: "Not on her quay",
        description: "The working dock is no place for a show — affection where the crews can see gets one flat look and a job handed to whoever's idle.",
        kind: "social_rule",
        severity: 35,
        triggers: ["public_display"],
      },
    ],
  };
}

export function demoCharacterAttributeSection(): AttributeSection {
  const candidates: RawAttributeEntry[] = [
    { id: "identity.gender", value: "female" },
    { id: "identity.apparent_age", value: "forties" },
    { id: "hair.color", value: "auburn" },
    { id: "hair.length", value: "shoulder_length" },
    { id: "hair.texture", value: "wavy" },
    { id: "hair.density", value: "medium" },
    { id: "hair.strand_thickness", value: "thick" },
    { id: "hair.condition", value: "dry" },
    { id: "hair.arrangement", value: "braid" },
    { id: "hair.style", value: "loose braid pinned up against the wind" },
    { id: "eyes.color", value: "gray_green" },
    { id: "build.frame", value: "sturdy" },
    { id: "skin.tone", value: "tan" },
    { id: "skin.texture", value: "weathered" },
  ];
  // A weathered dockworker reads as solidly built; the unset core visual gets
  // a range so the demo path exercises the range-constrained seeded fill.
  const rangeCandidates: RawAttributeRange[] = [
    { id: "build.height", plausible: ["average", "above_average", "tall"] },
  ];
  // The sample spans groups that may not be registered yet; filtering against
  // the live registry keeps demo output diagnostic-free as vocabulary grows.
  return {
    attributes: candidates.filter((c) => attributeRegistry.parseValue(c.id, c.value).ok),
    ranges: rangeCandidates
      .map((r) => ({
        id: r.id,
        plausible: r.plausible.filter((m) => attributeRegistry.byId(r.id)?.allowedValues?.includes(m) ?? false),
      }))
      .filter((r) => r.plausible.length > 0),
  };
}

export function demoCharacterOutfitSection(): OutfitSection {
  return {
    outfit: [
      {
        name: "Salt-stained oilskin coat",
        description: "A heavy oilskin coat gone stiff at the cuffs, pockets full of chalk and twine.",
        layer: 3,
        coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
        opacity: "opaque",
        sensory: { scent: "brine and lanolin", tactile: "stiff, waxy canvas" },
        tags: ["workwear", "weatherproof"],
      },
      {
        name: "Gray wool fisherman's sweater",
        description: "Thick cabled wool, darned at both elbows in mismatched yarn.",
        layer: 2,
        coverage: ["chest", "back", "waist", "upper_arms", "forearms"],
        opacity: "opaque",
        sensory: { tactile: "coarse, warm wool" },
        tags: ["workwear", "warm"],
      },
      {
        name: "Canvas work trousers",
        description: "Faded duck canvas with a folding rule sheathed along one thigh.",
        layer: 1,
        coverage: ["pelvis", "thighs", "calves"],
        opacity: "opaque",
        sensory: {},
        tags: ["workwear"],
      },
      {
        name: "Scuffed leather boots",
        description: "Tall harbor boots resoled twice, laces tarred against the wet.",
        layer: 1,
        coverage: ["feet", "ankles"],
        opacity: "opaque",
        sensory: { scent: "leather and tar" },
        tags: ["workwear", "footwear"],
      },
    ],
  };
}
