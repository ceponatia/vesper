import { z } from "zod";
import { DEFAULT_SPECIES_ID, diag, canonicalTagId, dispositionTags, DRIVES_MAX, DRIVE_WANT_MAX_CHARS, DRIVE_WHY_MAX_CHARS, familiarityBandById, familiarityBands, interactionConceptIds, interactionFamilies, MICRO_EXEMPLARS_MAX, normalizeTag, axisRange, PLAYER_RELATIONSHIP_NOTE_MAX, RELATIONSHIP_HISTORY_TEXT_MAX, RELATIONSHIP_KIND_MAX, regardBandById, regardBands, scheduleDayPartById, traitRegistry, voiceAnchorsSchema, type CharacterProfile, type DiagnosticSink, type Drive, type MicroExemplar, type VoiceAnchors, type Preference, type ScheduleEntry, type SocialReactionCard, type TraitValue } from "@/contracts";
import { fnv1a32 } from "@/lib/hash";
import { generateChecked } from "@/server/ai";
import { FORGE_LEG_OPTIONS, type CharacterForgeContext, type CharacterSectionPatch } from "./types";
import { heritageForForgeContext, speciesForgeDescriptor, speciesForForgeContext } from "./context";
import { demoCharacterProfileSection } from "./demo";

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
 * mint none; the label-hash keeps demo-mode forges deterministic —
 * docs/resilience.md §6 — and label-dedup below guarantees uniqueness within the set).
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

export async function forgeProfileSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
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
