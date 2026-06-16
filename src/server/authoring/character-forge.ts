import { z } from "zod";
import {
  attributeRegistry,
  bodyLocationRegistry,
  DEFAULT_SPECIES_ID,
  inferSpeciesFromText,
  seedBodyConfigFromAttributes,
  isFeatureAttributeCategory,
  isIntimateAttributeCategory,
  realizeBody,
  speciesById,
  clothingCategories,
  clothingCategoryById,
  clothingLayerSchema,
  diag,
  itemDefinitionSchema,
  type AttributeDefinition,
  type AttributeValue,
  type CharacterProfile,
  type DiagnosticSink,
  type ItemDefinition,
  type RealizedBody,
  type SpeciesDefinition,
} from "@/contracts";
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
 * Character forge (docs/authoring.md §Character forge): three INDEPENDENT
 * generateChecked sections — profile, attributes, outfit — so each can
 * regenerate alone. The forge returns a draft; it never saves.
 */

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

function realizedBodyForForgeContext(context: CharacterForgeContext) {
  const species = speciesForForgeContext(context);
  if (!species) return undefined;
  return realizeBody({
    speciesId: species.id,
    bodyPlanId: context.draft?.profile.bodyPlanId ?? species.bodyPlanId,
    intimateRegions: context.draft?.profile.intimateRegions,
    bodyFeatures: context.draft?.profile.bodyFeatures,
  });
}

// ---------------------------------------------------------------------------
// Profile section
// ---------------------------------------------------------------------------

const profileSectionSchema = z.object({
  name: z.string().default(""),
  bio: z.string().default(""),
  personality: z.string().default(""),
  voice: z.string().default(""),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

type ProfileSection = z.infer<typeof profileSectionSchema>;

const PROFILE_SYSTEM =
  "You draft characters for a roleplaying engine. Write grounded, specific, playable characters — concrete detail over generality. Return only the requested fields.";

function profilePrompt(context: CharacterForgeContext): string {
  const species = speciesForForgeContext(context);
  const lines = [
    "Draft a character from this concept:",
    context.prompt,
    "",
    "Produce: a display name, a 2-4 sentence bio, a personality sketch (quirks, humor, flaws),",
    "voice notes (how they sound and speak), any aliases or nicknames, and 3-6 lowercase tags.",
  ];
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const look = species.appearance ? ` ${species.appearance}` : "";
    lines.push("", `Resolved structural species: ${species.label}.${look} Keep the draft consistent with that species.`);
  }
  if (context.draft?.name) {
    lines.push("", `You are regenerating the profile of the draft currently named "${context.draft.name}". Keep the core concept.`);
  }
  return lines.join("\n");
}

async function forgeProfileSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const { value } = await generateChecked({
    schema: profileSectionSchema,
    system: PROFILE_SYSTEM,
    prompt: profilePrompt(context),
    temperature: 0.7,
    code: "forge.character.profile",
    sink: context.sink,
    fallback: context.useFallbacks === false ? undefined : demoCharacterProfileSection,
  });
  const section = value ?? profileSectionSchema.parse({});
  const profile: Partial<CharacterProfile> = {
    bio: section.bio.trim(),
    personality: section.personality.trim(),
    aliases: section.aliases.map((a) => a.trim()).filter((a) => a.length > 0),
  };
  const voice = section.voice.trim();
  if (voice) profile.voice = voice;
  const species = speciesForForgeContext(context);
  if (species) {
    profile.speciesId = species.id;
    profile.bodyPlanId = species.bodyPlanId;
    profile.bodyFeatures = species.defaultFeatureGroups ? [...species.defaultFeatureGroups] : undefined;
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

function characterAttributeDefinitions(context?: CharacterForgeContext): readonly AttributeDefinition[] {
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
 * grounded post-hoc with registry.parseValue (docs/authoring.md §Guardrails).
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
      .describe("For [CORE] enum attributes you could not pin to a definite value: a plausible subset of allowed values."),
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
 * and a range emptied by grounding drops entirely — fillCoreVisualDefaults
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
  "For each [CORE] enum attribute you cannot pin to a definite value, emit a ranges entry instead: a plausible subset of its allowed values, conditioned on the identity anchors you inferred.",
  "Guardrails: identity anchors may constrain physical attributes only — coloring, features, build. Heritage must never feed personality, voice, behavior, or role suggestions. Ranges are soft priors that explicit text always overrides — when the text pins a value, emit the definite value and no range for that attribute. When the identity signal is weak, emit wide ranges or none.",
  'Worked example — text overrides the prior: "a Latina engineer with dyed silver hair" gives identity.heritage = "Latina" and hair.color = "gray" as definite values (the dye job in the text beats the heritage prior — no hair.color range), while eyes.color, unstated, gets a range like ["brown", "dark_brown", "hazel"].',
  "For everything else, omit any attribute the concept gives no basis for — sparse is correct.",
].join("\n");

function describeConstraint(def: AttributeDefinition, allowedValues?: readonly string[]): string {
  const allowed = allowedValues ?? def.allowedValues ?? [];
  switch (def.valueType) {
    case "enum":
      return `one of: ${allowed.join(" | ")}`;
    case "enum_list":
      return `list from: ${allowed.join(" | ")}`;
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
      const tags = `${def.coreVisual ? " [CORE]" : ""}${def.identityAnchor ? " [ANCHOR]" : ""}${required ? " [SPECIES]" : ""}`;
      return `- ${def.id}${tags} (${describeConstraint(def, allowed)})${defaultHint}: ${def.description}`;
    })
    .join("\n");
  const lines = [
    "Character concept:",
    context.prompt,
  ];
  const species = speciesForForgeContext(context);
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const look = species.appearance ? ` ${species.appearance}` : "";
    lines.push(
      "",
      `Resolved structural species: ${species.label}.${look} Include its visible feature morphology when the vocabulary lists it; choose attribute values consistent with this generic look unless the concept says otherwise.`,
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
    "Infer the [ANCHOR] attributes first. Emit definite values where the concept supports them; for each [CORE] enum attribute left without a definite value, emit a ranges entry with the plausible subset of its allowed values given the anchors. Fill the others only where the concept supports them; omit the rest.",
  );
  return lines.join("\n");
}

async function forgeAttributesSection(context: CharacterForgeContext): Promise<CharacterSectionPatch> {
  const { value } = await generateChecked({
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
  const attributes = fillCoreVisualDefaults(seeded, context.prompt, context.sink, ranges, realizedBody);
  // Seed the body-config declaratively from the attribute values' activatesGroups
  // (e.g. identity.gender) — a SEED, overridable in the editor. gender is now
  // coreVisual, so it is always present and the seed is reliable. Intimate
  // attribute values stay empty; the human authors them.
  const { intimateRegions } = seedBodyConfigFromAttributes(attributes);
  return { profile: { attributes, intimateRegions } };
}

/** FNV-1a over the seed text — deterministic, dependency-free. */
function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Seed species-required attribute defaults the model left unset. Unlike
 * fillCoreVisualDefaults this is NOT limited to coreVisual attributes: a
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
 * Tier-3 fill (docs/authoring.md §Character forge): every registry attribute
 * flagged coreVisual that the model left unset gets a default picked from its
 * surviving plausible range when one exists — falling through to the full
 * allowedValues when none does — seeded by (concept, attribute id). Seeded
 * rather than random on purpose — different concepts get varied defaults (an
 * LLM asked to "pick randomly" converges on brown/brown), while the same
 * input still forges the same draft (demo-mode determinism,
 * docs/resilience.md §6). A definite value always beats a range for the same
 * id — present ids are never filled. Enum-only: a default we can't pick from
 * a closed list isn't a default worth inventing.
 */
export function fillCoreVisualDefaults(
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
    if (!def.coreVisual || present.has(def.id)) continue;
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
    const pick = pool[hashSeed(`${seedText}::${def.id}`) % pool.length];
    if (!pick) continue;
    filled.push({ id: def.id, value: pick, source: "creation" });
    added.push(`${def.id}=${pick}`);
  }
  if (added.length > 0) {
    sink?.push(
      diag("info", "forge.character.attributes.core_defaults", `filled core visual defaults: ${added.join(", ")}`),
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
  return { profile: { defaultOutfit: [...new Set([...reuseIds, ...defaultOutfit])] }, suggestedItems: suggested };
}

/**
 * Library matching (docs/authoring.md): name-matched garments reference the
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
    aliases: ["Voss", "the harbor-master"],
    tags: ["harbor", "gruff", "mentor", "working-class"],
  };
}

export function demoCharacterAttributeSection(): AttributeSection {
  const candidates: RawAttributeEntry[] = [
    { id: "identity.gender", value: "female" },
    { id: "identity.apparent_age", value: "forties" },
    { id: "hair.color", value: "auburn" },
    { id: "hair.length", value: "shoulder_length" },
    { id: "hair.texture", value: "wavy" },
    { id: "hair.style", value: "loose braid pinned up against the wind" },
    { id: "eyes.color", value: "gray_green" },
    { id: "build.frame", value: "stocky" },
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
