import { z } from "zod";
import {
  authoredRelationshipSchema,
  bodyLocationRegistry,
  clothingCategories,
  clothingCategoryById,
  clothingLayerSchema,
  diag,
  objectSubtypeById,
  objectSubtypes,
  emptyWorldLore,
  emptyWorldStyle,
  itemDefinitionSchema,
  itemKindSchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  relationshipStages,
  worldLoreSchema,
  worldNormSchema,
  worldStyleSchema,
  type AuthoredRelationship,
  type DiagnosticSink,
} from "@/contracts";
import { calendarStartSchema, DEFAULT_CALENDAR_START } from "@/lib/clock";
import { parseOr, parseOrNull } from "@/lib/parse";
import { generateChecked } from "@/server/ai";
import { findCharactersByName, type LibraryLookup } from "./library";
import {
  castRoleSchema,
  castTierSchema,
  emptyWorldDraft,
  locationAmbientSchema,
  locationScaleSchema,
  type WorldDraft,
  type WorldDraftCastSuggestion,
  type WorldDraftItemPlacement,
  type WorldDraftLocation,
  type WorldDraftLoreChunk,
} from "./drafts";

/**
 * World forge (docs/authoring.md §World forge): independent generateChecked
 * sections, parallel where independent. Premise/locations/cast run first;
 * lore and items consume the drafted location and cast names.
 */

export const worldForgeSections = ["premise", "locations", "lore", "cast", "items"] as const;
export const worldForgeSectionSchema = z.enum(worldForgeSections);
export type WorldForgeSection = (typeof worldForgeSections)[number];

/** Auto-generate count bounds for the intake dropdowns (UX-audit §1b). 0 ⇒ skip that family (import your own). */
export const FORGE_COUNT_MIN = 0;
export const FORGE_COUNT_MAX = 5;
export const DEFAULT_LOCATION_COUNT = 4;
export const DEFAULT_CHARACTER_COUNT = 3;

export interface WorldForgeContext {
  prompt: string;
  userId: string;
  sink?: DiagnosticSink;
  /** Current draft; lore and items sections read location/cast names from it. */
  draft?: WorldDraft;
  /** Character-library lookup; defaults to an ILIKE query against characters. */
  findCharacters?: LibraryLookup;
  /** How many locations to generate (UX-audit §1b); 0 ⇒ skip. Defaults to DEFAULT_LOCATION_COUNT. */
  locationCount?: number;
  /** How many new cast members to suggest; 0 ⇒ skip. Defaults to DEFAULT_CHARACTER_COUNT. */
  characterCount?: number;
}

export function applyWorldSectionPatch(draft: WorldDraft, patch: Partial<WorldDraft>): WorldDraft {
  const next = { ...draft };
  for (const key of Object.keys(patch) as (keyof WorldDraft)[]) {
    const value = patch[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

export interface ForgeWorldInput {
  prompt: string;
  userId: string;
  sink?: DiagnosticSink;
  findCharacters?: LibraryLookup;
  locationCount?: number;
  characterCount?: number;
}

export async function forgeWorld(input: ForgeWorldInput): Promise<WorldDraft> {
  const base: WorldForgeContext = { ...input };
  let draft = emptyWorldDraft();
  // A staged DAG so every section shares one canon (UX-audit M1):
  // 1) the world skeleton — premise + map (independent of each other),
  const skeleton = await Promise.all([forgeWorldSection("premise", base), forgeWorldSection("locations", base)]);
  for (const patch of skeleton) draft = applyWorldSectionPatch(draft, patch);
  // 2) the canonical cast, generated against the real premise + map (so members
  //    start in rooms that exist), then
  draft = applyWorldSectionPatch(draft, await forgeWorldSection("cast", { ...base, draft }));
  // 3) lore + items, which resolve their cross-references against that canonical
  //    cast + map — no phantom NPCs (Genzo) or items on people who don't exist.
  const dependentContext: WorldForgeContext = { ...base, draft };
  const dependent = await Promise.all([
    forgeWorldSection("lore", dependentContext),
    forgeWorldSection("items", dependentContext),
  ]);
  for (const patch of dependent) draft = applyWorldSectionPatch(draft, patch);
  return draft;
}

export async function forgeWorldSection(section: WorldForgeSection, context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  switch (section) {
    case "premise":
      return forgePremiseSection(context);
    case "locations":
      return forgeLocationsSection(context);
    case "lore":
      return forgeLoreSection(context);
    case "cast":
      return forgeCastSection(context);
    case "items":
      return forgeItemsSection(context);
  }
}

// ---------------------------------------------------------------------------
// Premise section
// ---------------------------------------------------------------------------

const premiseSectionSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  synopsis: z.string().default(""),
  directives: z.array(z.string()).default([]),
  narratorGuidance: z.string().default(""),
  calendarStart: calendarStartSchema.default(DEFAULT_CALENDAR_START),
  norms: z.array(worldNormSchema).default([]),
});

type PremiseSection = z.infer<typeof premiseSectionSchema>;

const PREMISE_SYSTEM =
  "You design roleplaying world premises. Be concrete and playable: a name, a short blurb, a story synopsis, style directives (tone, era, pacing, content notes), narrator guidance, a calendar start date, and 1-4 social norms with severities.";

function premisePrompt(context: WorldForgeContext): string {
  const lines = ["Design a world from this premise:", context.prompt];
  if (context.draft?.name) {
    lines.push("", `You are regenerating the premise of the draft currently named "${context.draft.name}". Keep the core idea.`);
  }
  lines.push("", 'Norm severities mean: "odd" raises eyebrows, "disapproval" costs standing, "outrage" provokes confrontation.');
  lines.push("Where the synopsis or narrator guidance must name the player character, write the literal token {{player}} — it resolves to the player's name at play time.");
  return lines.join("\n");
}

async function forgePremiseSection(context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  const { value } = await generateChecked({
    schema: premiseSectionSchema,
    system: PREMISE_SYSTEM,
    prompt: premisePrompt(context),
    temperature: 0.7,
    code: "forge.world.premise",
    sink: context.sink,
    fallback: demoWorldPremiseSection,
  });
  const section = value ?? demoWorldPremiseSection();
  // safeParse + schema defaults, never throw: a validation miss degrades the
  // section instead of 500ing the forge (docs/resilience.md §1).
  const style = parseOr(
    worldStyleSchema,
    {
      directives: section.directives,
      narratorGuidance: section.narratorGuidance.trim() || undefined,
      calendarStart: section.calendarStart,
      norms: section.norms,
    },
    emptyWorldStyle(),
    context.sink,
    "forge.world.premise.style",
  );
  const lore = parseOr(worldLoreSchema, { synopsis: section.synopsis }, emptyWorldLore(), context.sink, "forge.world.premise.lore");
  return { name: section.name.trim(), description: section.description.trim(), style, lore };
}

// ---------------------------------------------------------------------------
// Locations section + graph validation
// ---------------------------------------------------------------------------

const locationsSectionSchema = z.object({
  locations: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default(""),
        ambient: locationAmbientSchema.default({}),
        scale: locationScaleSchema.catch("room").default("room"),
        area: z.string().optional(),
        tags: z.array(z.string()).default([]),
        links: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** The most natural starting location for the player, by exact name. */
  playerStartName: z.string().optional(),
});

type LocationsSection = z.infer<typeof locationsSectionSchema>;

function normalizeName(value: string): string {
  // apostrophes join ("netmaker's" ≡ "netmakers"); other punctuation splits
  return value.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Resolve a model-written name against the canonical set: exact
 * (case-insensitive) → normalized (punctuation/whitespace) → unique
 * containment ("Dr. Thorne" ⊂ "Dr. Elias Thorne"). When nothing resolves,
 * `closest` carries the best token-overlap candidate for a "did you mean"
 * diagnostic.
 */
export function fuzzyResolveName(raw: string, canonical: readonly string[]): { match?: string; closest?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const exact = canonical.find((n) => n.toLowerCase() === trimmed.toLowerCase());
  if (exact) return { match: exact };

  const normalizedRaw = normalizeName(trimmed);
  if (!normalizedRaw) return {};
  const normalizedHits = canonical.filter((n) => normalizeName(n) === normalizedRaw);
  if (normalizedHits.length === 1) return { match: normalizedHits[0] };

  const containHits = canonical.filter((n) => {
    const nn = normalizeName(n);
    return nn.includes(normalizedRaw) || normalizedRaw.includes(nn);
  });
  if (containHits.length === 1) return { match: containHits[0] };

  const rawTokens = new Set(normalizedRaw.split(" "));
  let closest: string | undefined;
  let bestScore = 0;
  for (const name of canonical) {
    const score = normalizeName(name)
      .split(" ")
      .filter((t) => rawTokens.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      closest = name;
    }
  }
  return closest ? { closest } : {};
}

/**
 * Graph guardrails (docs/authoring.md): names unique, no orphan links,
 * connected. Violations degrade — duplicates and orphan links drop, stranded
 * components get a repair link to the first location — each with a diagnostic.
 */
export function validateLocationGraph(locations: readonly WorldDraftLocation[], sink?: DiagnosticSink): WorldDraftLocation[] {
  const code = "forge.world.locations";
  const named: WorldDraftLocation[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const name = location.name.trim();
    if (!name) {
      sink?.push(diag("warn", `${code}.unnamed`, "dropped a location with no name"));
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      sink?.push(diag("warn", `${code}.duplicate_name`, `dropped duplicate location "${name}"`));
      continue;
    }
    seen.add(name.toLowerCase());
    named.push({ ...location, name });
  }

  const canonicalNames = named.map((l) => l.name);
  const cleaned = named.map((location) => {
    const links: string[] = [];
    for (const raw of location.links) {
      const { match, closest } = fuzzyResolveName(raw, canonicalNames);
      if (!match) {
        const hint = closest ? ` (did you mean "${closest}"?)` : "";
        // Structured context lets the forge UI offer a one-click "Create location" (UX-audit M2).
        sink?.push(
          diag("warn", `${code}.orphan_link`, `dropped link "${location.name}" → "${raw}": no such location${hint}`, {
            context: { kind: "missing_location", missingLocation: raw.trim(), from: location.name },
          }),
        );
        continue;
      }
      const target = match;
      if (target.toLowerCase() !== raw.trim().toLowerCase()) {
        sink?.push(diag("info", `${code}.link_fuzzy_resolved`, `resolved link "${raw}" → "${target}"`));
      }
      if (target === location.name) {
        sink?.push(diag("info", `${code}.self_link`, `dropped self-link on "${location.name}"`));
        continue;
      }
      if (!links.includes(target)) links.push(target);
    }
    return { ...location, links };
  });

  if (cleaned.length > 1) {
    const components = connectedComponents(cleaned);
    const hubIndex = components[0]?.[0];
    const hub = hubIndex !== undefined ? cleaned[hubIndex] : undefined;
    if (hub && components.length > 1) {
      for (const component of components.slice(1)) {
        const strandedIndex = component[0];
        const stranded = strandedIndex !== undefined ? cleaned[strandedIndex] : undefined;
        if (!stranded) continue;
        hub.links = [...hub.links, stranded.name];
        sink?.push(
          diag("warn", `${code}.disconnected`, `linked stranded location "${stranded.name}" to "${hub.name}" to keep the map connected`),
        );
      }
    }
  }
  return cleaned;
}

function connectedComponents(locations: readonly WorldDraftLocation[]): number[][] {
  const indexByKey = new Map<string, number>();
  locations.forEach((location, i) => indexByKey.set(location.name.toLowerCase(), i));
  const adjacency: Set<number>[] = locations.map(() => new Set<number>());
  locations.forEach((location, i) => {
    for (const link of location.links) {
      const j = indexByKey.get(link.toLowerCase());
      if (j === undefined || j === i) continue;
      adjacency[i]?.add(j);
      adjacency[j]?.add(i);
    }
  });
  const visited = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < locations.length; start++) {
    if (visited.has(start)) continue;
    visited.add(start);
    const component: number[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      component.push(current);
      for (const next of adjacency[current] ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

const LOCATIONS_SYSTEM =
  "You map roleplaying worlds. Produce the requested number of distinct locations with sensory ambient detail and an undirected connection graph. Every location must be reachable from every other. Every links entry must be the EXACT name of another location in this same response — never link to a location you did not generate.";

function locationsPrompt(context: WorldForgeContext): string {
  const count = context.locationCount ?? DEFAULT_LOCATION_COUNT;
  const lines = ["World premise:", context.prompt];
  const synopsis = context.draft?.lore.synopsis;
  if (synopsis) lines.push("", "Synopsis:", synopsis);
  lines.push(
    "",
    `Produce exactly ${count} distinct location${count === 1 ? "" : "s"}.`,
    "Give each location a name, 2-3 sentence description, ambient { scent, sound, light }, lowercase tags, and links (names of adjacent locations).",
    'Also set scale per location — intimate (closet, car interior) | room (default) | hall (great hall, warehouse) | open (street, plaza) | expanse (beach, fields) — and, where locations group naturally (rooms of one building, one district), a shared lowercase area label like "harbor-inn" or "old-town".',
    "Set playerStartName to the exact name of the most natural starting location.",
    "",
    'Self-consistency example: if your locations are "Quay", "Tavern" and "Customs House", a valid links array for Quay is ["Tavern", "Customs House"] — every entry matches a generated name exactly.',
    "Before finishing, check every links entry against your own location names and fix any that do not match.",
  );
  return lines.join("\n");
}

async function forgeLocationsSection(context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  // 0 ⇒ author imports their own locations; produce an empty map (UX-audit §1b).
  if ((context.locationCount ?? DEFAULT_LOCATION_COUNT) === 0) return { locations: [], playerStartLocationName: undefined };
  const { value } = await generateChecked({
    schema: locationsSectionSchema,
    system: LOCATIONS_SYSTEM,
    prompt: locationsPrompt(context),
    temperature: 0.7,
    maxOutputTokens: 8192,
    code: "forge.world.locations",
    sink: context.sink,
    fallback: demoWorldLocationsSection,
  });
  const section = value ?? demoWorldLocationsSection();
  const locations = validateLocationGraph(section.locations, context.sink);
  if (locations.length === 0) {
    context.sink?.push(diag("warn", "forge.world.locations.empty", "locations section produced no usable locations"));
  }
  // Player start must name a surviving location; near-misses resolve fuzzily.
  let playerStartLocationName: string | undefined;
  if (section.playerStartName?.trim()) {
    const { match } = fuzzyResolveName(section.playerStartName, locations.map((l) => l.name));
    if (match) playerStartLocationName = match;
    else {
      context.sink?.push(
        diag("info", "forge.world.locations.player_start_unresolved", `playerStartName "${section.playerStartName}" did not match a generated location`),
      );
    }
  }
  return { locations, playerStartLocationName };
}

// ---------------------------------------------------------------------------
// Lore section
// ---------------------------------------------------------------------------

const loreSectionSchema = z.object({
  chunks: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        category: loreChunkCategorySchema.catch("history"),
        tier: loreChunkTierSchema.catch("scene"),
        visibility: loreChunkVisibilitySchema.catch("public"),
        unlockTags: z.array(z.string()).default([]),
        locationTags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

type LoreSection = z.infer<typeof loreSectionSchema>;

export function groundLoreChunks(section: LoreSection, sink?: DiagnosticSink): WorldDraftLoreChunk[] {
  const code = "forge.world.lore";
  const chunks = section.chunks.map((chunk) => ({
    ...chunk,
    unlockTags: normalizeTags(chunk.unlockTags),
    locationTags: normalizeTags(chunk.locationTags),
    manuallyUnlocked: false,
  }));
  const secrets = chunks.filter((c) => c.visibility === "secret");
  if (secrets.length === 0 && chunks.length > 0) {
    sink?.push(diag("info", `${code}.no_secrets`, "lore draft has no secret chunks; the world has no discovery arc"));
  }
  for (const secret of secrets) {
    if (secret.unlockTags.length === 0) {
      sink?.push(
        diag("info", `${code}.secret_without_unlock_tags`, `secret "${secret.title}" has no unlock tags; it can only be unlocked manually`),
      );
    }
  }
  return chunks;
}

function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

const LORE_SYSTEM =
  "You write world lore for a roleplaying engine: 8-20 chunks across categories (history, geography, institution, culture, relationship, secret, tone). Include 2-3 secret chunks with unlock tags — lowercase keywords that, when surfaced in play, reveal the secret. Tiers: always (every scene), scene (when relevant), retrieval (on demand).";

function lorePrompt(context: WorldForgeContext): string {
  const lines = ["World premise:", context.prompt];
  const synopsis = context.draft?.lore.synopsis;
  if (synopsis) lines.push("", "Synopsis:", synopsis);
  const locationNames = context.draft?.locations.map((l) => l.name) ?? [];
  if (locationNames.length > 0) {
    lines.push("", `World locations: ${locationNames.join(", ")}`, "Use locationTags (lowercase) to tie chunks to relevant locations.");
  }
  // The cast is canon by the time lore runs (forgeWorld phase 3): keep lore consistent
  // with it and never invent other named characters (UX-audit M1 — phantom-NPC fix).
  const castNames = context.draft?.castSuggestions.map((c) => c.name).filter(Boolean) ?? [];
  if (castNames.length > 0) {
    lines.push(
      "",
      `World cast (the only named characters — write lore consistent with them, and do not introduce other named people): ${castNames.join(", ")}`,
    );
  }
  lines.push("", "Where chunk text must name the player character, write the literal token {{player}} — it resolves to the player's name at play time.");
  return lines.join("\n");
}

async function forgeLoreSection(context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  const { value } = await generateChecked({
    schema: loreSectionSchema,
    system: LORE_SYSTEM,
    prompt: lorePrompt(context),
    temperature: 0.7,
    maxOutputTokens: 8192,
    code: "forge.world.lore",
    sink: context.sink,
    fallback: demoWorldLoreSection,
  });
  const section = value ?? demoWorldLoreSection();
  return { loreChunks: groundLoreChunks(section, context.sink) };
}

// ---------------------------------------------------------------------------
// Cast section
// ---------------------------------------------------------------------------

export const castSectionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        name: z.string().min(1),
        conceptNote: z.string().default(""),
        role: castRoleSchema.catch("npc"),
        tier: castTierSchema.catch("minor").default("minor"),
        startLocationName: z.string().optional(),
        /** Suggested edges toward other suggestions or "player"; unknown stage ids self-heal to "stranger" via the contract schema's `.catch`. */
        relationships: z.array(authoredRelationshipSchema).default([]),
      }),
    )
    .default([]),
});

type CastSection = z.infer<typeof castSectionSchema>;

/**
 * Match suggestions against the user's character library by name (simple
 * ILIKE); matches carry existingCharacterId, the rest stay new stubs. A failed
 * lookup degrades to all-stubs with a diagnostic.
 */
export async function matchCastSuggestions(
  suggestions: readonly Omit<WorldDraftCastSuggestion, "existingCharacterId">[],
  userId: string,
  findCharacters: LibraryLookup,
  sink?: DiagnosticSink,
): Promise<WorldDraftCastSuggestion[]> {
  const deduped: Omit<WorldDraftCastSuggestion, "existingCharacterId">[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const name = suggestion.name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    deduped.push({ ...suggestion, name });
  }
  let rows: ReadonlyArray<{ id: string; name: string }> = [];
  try {
    rows = await findCharacters(userId, deduped.map((s) => s.name));
  } catch (err) {
    sink?.push(
      diag("warn", "forge.world.cast.library_lookup_failed", `character library lookup failed: ${errorText(err)}`),
    );
  }
  const idByName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  return deduped.map((suggestion) => {
    const existingCharacterId = idByName.get(suggestion.name.toLowerCase());
    return existingCharacterId ? { ...suggestion, existingCharacterId } : { ...suggestion };
  });
}

/**
 * Ground suggested relationship entries (phase-2-plan T12): `toward` must
 * resolve to ANOTHER suggestion's name (case-insensitive, same fuzz as
 * location links) or the literal "player". Unresolved and self-targeted
 * entries drop with a diagnostic; resolved entries keep the canonical casing.
 * Unknown stage ids already self-healed to "stranger" via
 * authoredRelationshipSchema's `.catch` at parse time.
 */
export function groundCastRelationships<T extends { name: string; relationships: AuthoredRelationship[] }>(
  suggestions: readonly T[],
  sink?: DiagnosticSink,
): T[] {
  const code = "forge.world.cast";
  const names = suggestions.map((s) => s.name);
  return suggestions.map((suggestion, index) => {
    const otherNames = names.filter((_, i) => i !== index);
    const relationships: AuthoredRelationship[] = [];
    for (const entry of suggestion.relationships) {
      const raw = entry.toward.trim();
      let toward: string;
      if (raw.toLowerCase() === "player") {
        toward = "player";
      } else {
        const { match, closest } = fuzzyResolveName(raw, otherNames);
        if (!match) {
          const hint = closest ? ` (did you mean "${closest}"?)` : "";
          sink?.push(
            diag(
              "warn",
              `${code}.unresolved_toward`,
              `dropped relationship "${suggestion.name}" → "${raw}": not another suggested cast member or "player"${hint}`,
            ),
          );
          continue;
        }
        if (match.toLowerCase() !== raw.toLowerCase()) {
          sink?.push(diag("info", `${code}.toward_fuzzy_resolved`, `resolved relationship target "${raw}" → "${match}"`));
        }
        toward = match;
      }
      if (relationships.some((r) => r.toward.toLowerCase() === toward.toLowerCase())) {
        sink?.push(
          diag("info", `${code}.duplicate_relationship`, `"${suggestion.name}" suggested two relationships toward "${toward}"; kept the first`),
        );
        continue;
      }
      relationships.push({ toward, stage: entry.stage });
    }
    return { ...suggestion, relationships };
  });
}

const CAST_SYSTEM = [
  "You cast roleplaying worlds. Suggest the requested number of new characters that fit the premise: name, a one-sentence concept note, a role (companion = close to the player, npc = supporting), a tier (major = central with full simulation; minor = recurring supporting cast; extra = background), and where they start.",
  `Where the premise or the characters' concepts clearly support a bond, add relationships entries ({ toward, stage }): toward is the EXACT name of another character in this same response, or the literal "player". Stages: ${relationshipStages.map((s) => s.id).join(" | ")}.`,
  'Suggest only relationships the premise supports. Sparse is correct: no entry means strangers, so never write a "stranger" entry.',
  'When a character has a relationship, their conceptNote must NAME the bond kind in plain words ("her brother", "a coworker at the cannery", "they have never met") — that exact wording is read at spawn to decide what the character believes the player knows of them.',
].join("\n");

function castPrompt(context: WorldForgeContext): string {
  const count = context.characterCount ?? DEFAULT_CHARACTER_COUNT;
  const lines = ["World premise:", context.prompt, "", `Suggest exactly ${count} new character${count === 1 ? "" : "s"}.`];
  const synopsis = context.draft?.lore.synopsis;
  if (synopsis) lines.push("", "Synopsis:", synopsis);
  const locationNames = context.draft?.locations.map((l) => l.name).filter(Boolean) ?? [];
  if (locationNames.length > 0) {
    lines.push(
      "",
      `Locations in this world: ${locationNames.join(", ")}.`,
      "Set each character's startLocationName to the EXACT name of the location where they naturally spend their time (the innkeeper starts at the inn). Omit it only when nothing fits.",
    );
  }
  return lines.join("\n");
}

async function forgeCastSection(context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  // 0 ⇒ author imports/links their own cast; suggest none (UX-audit §1b).
  if ((context.characterCount ?? DEFAULT_CHARACTER_COUNT) === 0) return { castSuggestions: [] };
  const { value } = await generateChecked({
    schema: castSectionSchema,
    system: CAST_SYSTEM,
    prompt: castPrompt(context),
    temperature: 0.7,
    code: "forge.world.cast",
    sink: context.sink,
    fallback: demoWorldCastSection,
  });
  const section = value ?? demoWorldCastSection();
  const castSuggestions = await matchCastSuggestions(
    groundCastRelationships(section.suggestions, context.sink),
    context.userId,
    context.findCharacters ?? findCharactersByName,
    context.sink,
  );
  return { castSuggestions };
}

// ---------------------------------------------------------------------------
// Items section
// ---------------------------------------------------------------------------

const itemsSectionSchema = z.object({
  placements: z
    .array(
      z.object({
        itemName: z.string().min(1),
        kind: itemKindSchema.catch("object"),
        description: z.string().default(""),
        /** Clothing coverage template id (contracts/items/clothing-categories.ts). */
        category: z.string().optional().catch(undefined),
        /** Object subtype id (contracts/items/object-subtypes.ts). */
        subtype: z.string().optional().catch(undefined),
        coverage: z.array(z.string()).default([]),
        layer: clothingLayerSchema.optional().catch(undefined),
        tags: z.array(z.string()).default([]),
        locationName: z.string().optional(),
        castName: z.string().optional(),
        worn: z.boolean().catch(false),
      }),
    )
    .default([]),
});

type ItemsSection = z.infer<typeof itemsSectionSchema>;

/**
 * Ground placements against drafted location and cast names: unresolved
 * references are cleared (the item stays, unplaced) with a diagnostic; worn
 * requires a clothing item on a cast member.
 */
export function groundItemPlacements(
  section: ItemsSection,
  locationNames: readonly string[],
  castNames: readonly string[],
  sink?: DiagnosticSink,
): WorldDraftItemPlacement[] {
  const code = "forge.world.items";
  const placements: WorldDraftItemPlacement[] = [];
  for (const raw of section.placements) {
    const itemName = raw.itemName.trim();
    if (!itemName) {
      sink?.push(diag("warn", `${code}.unnamed`, "dropped an item placement with no name"));
      continue;
    }
    const category = raw.kind === "clothing" && raw.category ? clothingCategoryById(raw.category) : undefined;
    if (raw.kind === "clothing" && raw.category && !category) {
      sink?.push(diag("info", `${code}.unknown_category`, `ignored unknown clothing category "${raw.category}" on "${itemName}"`));
    }
    const subtype = raw.kind === "object" && raw.subtype ? objectSubtypeById(raw.subtype) : undefined;
    if (raw.kind === "object" && raw.subtype && !subtype) {
      sink?.push(diag("info", `${code}.unknown_subtype`, `ignored unknown object subtype "${raw.subtype}" on "${itemName}"`));
    }
    const coverage =
      raw.kind === "clothing"
        ? raw.coverage.filter((c) => {
            const known = bodyLocationRegistry.byId(c.trim().toLowerCase()) !== undefined;
            if (!known) {
              sink?.push(diag("warn", `${code}.invalid_coverage`, `dropped unknown body location "${c}" on "${itemName}"`));
            }
            return known;
          })
        : [];
    const definition = parseOrNull(
      itemDefinitionSchema,
      {
        kind: raw.kind,
        name: itemName,
        description: raw.description,
        category: category?.id,
        subtype: subtype?.id,
        // the category template anchors anything the model left unset
        coverage: coverage.length > 0 ? coverage : [...(category?.coverage ?? [])],
        layer: raw.kind === "clothing" ? (raw.layer ?? category?.layer ?? 1) : undefined,
        tags: raw.tags,
      },
      sink,
      `${code}.item`,
    );
    if (!definition) {
      sink?.push(diag("warn", `${code}.invalid_item`, `dropped item "${itemName}": failed item validation`, { context: { item: itemName } }));
      continue;
    }

    let locationName: string | undefined;
    if (raw.locationName?.trim()) {
      const { match, closest } = fuzzyResolveName(raw.locationName, locationNames);
      locationName = match;
      if (!match) {
        const hint = closest ? ` (did you mean "${closest}"?)` : "";
        sink?.push(
          diag("warn", `${code}.unresolved_location`, `cleared placement of "${itemName}": no location named "${raw.locationName}"${hint}`),
        );
      }
    }
    let castName: string | undefined;
    if (raw.castName?.trim()) {
      const { match, closest } = fuzzyResolveName(raw.castName, castNames);
      castName = match;
      if (!match) {
        const hint = closest ? ` (did you mean "${closest}"?)` : "";
        sink?.push(diag("warn", `${code}.unresolved_cast`, `cleared placement of "${itemName}": no cast member named "${raw.castName}"${hint}`));
      }
    }
    if (locationName && castName) {
      // Save-time placement is exactly-one; prefer the person over the place.
      sink?.push(diag("info", `${code}.ambiguous_placement`, `"${itemName}" placed on both a location and a cast member; kept the cast member`));
      locationName = undefined;
    }
    const worn = raw.worn && raw.kind === "clothing" && castName !== undefined;
    placements.push({ itemName, definition, locationName, castName, worn, quantity: 1 });
  }
  return placements;
}

const ITEMS_SYSTEM =
  "You furnish roleplaying worlds: notable items per location (furniture, tools, containers with contents) and a few possessions for cast members. Reference locations and cast strictly by the given names.";

function itemsPrompt(context: WorldForgeContext): string {
  const lines = ["World premise:", context.prompt];
  const locationNames = context.draft?.locations.map((l) => l.name) ?? [];
  const castNames = context.draft?.castSuggestions.map((c) => c.name) ?? [];
  if (locationNames.length > 0) {
    lines.push("", "Locations (use these exact names):");
    for (const name of locationNames) lines.push(`- ${name}`);
  }
  if (castNames.length > 0) {
    lines.push("", "Cast members (use these exact names):");
    for (const name of castNames) lines.push(`- ${name}`);
    lines.push(
      "",
      "Give each cast member 1-3 personal possessions, with castName set to their exact name.",
      "Clothing a cast member is currently wearing: kind clothing, their castName, worn true.",
      'An item that obviously belongs to someone ("…\'s coat") goes on that cast member, not a location.',
    );
  }
  lines.push(
    "",
    "Each placement: itemName, kind (clothing|object|container), description, tags, and exactly one of locationName or castName (worn only for clothing on a cast member).",
    `Clothing categories (set one per garment where it fits; it anchors coverage): ${clothingCategories.map((c) => c.id).join(", ")}`,
    `Object subtypes (set one per object where it fits): ${objectSubtypes.map((s) => s.id).join(", ")}`,
  );
  return lines.join("\n");
}

async function forgeItemsSection(context: WorldForgeContext): Promise<Partial<WorldDraft>> {
  const { value } = await generateChecked({
    schema: itemsSectionSchema,
    system: ITEMS_SYSTEM,
    prompt: itemsPrompt(context),
    temperature: 0.5,
    maxOutputTokens: 8192,
    code: "forge.world.items",
    sink: context.sink,
    fallback: demoWorldItemsSection,
  });
  const section = value ?? demoWorldItemsSection();
  const locationNames = context.draft?.locations.map((l) => l.name) ?? [];
  const castNames = context.draft?.castSuggestions.map((c) => c.name) ?? [];
  return { itemPlacements: groundItemPlacements(section, locationNames, castNames, context.sink) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Demo fallbacks: a deterministic hand-written sample world so the forge UX
// works keyless (docs/resilience.md §6), via the same generateChecked path.
// ---------------------------------------------------------------------------

export function demoWorldPremiseSection(): PremiseSection {
  return {
    name: "Greywater Harbor",
    description: "A fog-bound port town where every cargo manifest hides a second story.",
    synopsis:
      "Greywater Harbor lives by the tide and the tariff. Ships limp in through the fog season, the customs house stamps what it is paid to stamp, and the taverns toast the drowned every night at the turn of the tide. Beneath the routine, a smuggling ring is unravelling — and everyone on the quay holds one loose thread of it.",
    directives: [
      "Grounded, sensory prose; salt, tar, and lamplight.",
      "Era: gaslamp age of sail — no electricity, nothing faster than a horse or a schooner.",
      "Pacing: slow-burn slice of life with an undercurrent of smuggling intrigue.",
    ],
    narratorGuidance: "Let the weather and the tide set the rhythm of scenes; secrets surface slowly, in fragments.",
    calendarStart: { year: 1862, month: 10, day: 14, hour: 7, minute: 30 },
    norms: [
      {
        rule: "Unloading cargo without a customs stamp is a criminal offense",
        severity: "outrage",
        consequence: "Witnesses alert the customs watch; fines or arrest follow.",
      },
      {
        rule: "Refusing a toast to the drowned is deeply rude in harbor taverns",
        severity: "disapproval",
        consequence: "Locals turn cold and conversations dry up.",
      },
    ],
  };
}

export function demoWorldLocationsSection(): LocationsSection {
  return {
    locations: [
      {
        name: "Harbor Quay",
        description:
          "The working spine of Greywater: a long granite quay stacked with crates, coiled rope, and arguments. The tide bell hangs from a gallows-frame at its center.",
        ambient: { scent: "tar, kelp, and wet rope", sound: "gulls, winch-chains, creaking hulls", light: "pale fog-filtered daylight" },
        scale: "open" as const,
        area: "greywater-harbor",
        tags: ["docks", "outdoor", "quay"],
        links: ["The Brine Lantern", "Customs House", "Netmaker's Row"],
      },
      {
        name: "The Brine Lantern",
        description:
          "A low-beamed tavern wedged between two warehouses, its floorboards swollen with a century of spilled beer. The drowned are toasted here at every tide-turn.",
        ambient: { scent: "pipe smoke and sour ale", sound: "low talk and a badly tuned fiddle", light: "amber lantern glow" },
        scale: "hall" as const,
        area: "greywater-harbor",
        tags: ["tavern", "indoor", "social"],
        links: ["Harbor Quay"],
      },
      {
        name: "Customs House",
        description:
          "A square brick building with a brass-faced clock that runs four minutes fast. Inside, ledgers climb the walls and clerks climb over each other.",
        ambient: { scent: "ink, dust, and cold tea", sound: "scratching pens and the fast clock", light: "thin window light over green lampshades" },
        scale: "room" as const,
        area: "greywater-harbor",
        tags: ["office", "indoor", "authority"],
        links: ["Harbor Quay"],
      },
      {
        name: "Netmaker's Row",
        description:
          "A crooked lane of net-lofts and chandleries where half the harbor's gossip is knotted into the mending. Everything smells of hemp and fish scale.",
        ambient: { scent: "hemp, fish scale, and pitch", sound: "haggling and the snip of twine", light: "strings of work-lamps under awnings" },
        scale: "open" as const,
        area: "greywater-harbor",
        tags: ["market", "outdoor", "craft"],
        links: ["Harbor Quay", "Old Breakwater"],
      },
      {
        name: "Old Breakwater",
        description:
          "The ruined first breakwater, abandoned to the gulls after the Pelican wreck. Locals avoid it; the fog sits on it even in summer.",
        ambient: { scent: "cold stone and rotting weed", sound: "surf against broken granite", light: "gray, even in fair weather" },
        scale: "expanse" as const,
        area: "old-breakwater",
        tags: ["ruin", "outdoor", "secluded"],
        links: ["Netmaker's Row"],
      },
    ],
    playerStartName: "The Brine Lantern",
  };
}

export function demoWorldLoreSection(): LoreSection {
  return {
    chunks: [
      {
        title: "Fog Season",
        body: "From late autumn to first frost, fog owns Greywater. Ships navigate by the tide bell, and nothing that happens in the fog is anyone's business.",
        category: "geography",
        tier: "always",
        visibility: "public",
        unlockTags: [],
        locationTags: [],
      },
      {
        title: "The Founding of Greywater",
        body: "Greywater began as a wreckers' camp that went respectable when the customs crown bought its silence with a charter. The town has never quite forgotten either trade.",
        category: "history",
        tier: "retrieval",
        visibility: "public",
        unlockTags: [],
        locationTags: [],
      },
      {
        title: "The Tide Bell",
        body: "The bell on Harbor Quay is rung at every tide-turn. Ringing it out of turn is a distress call, and answering it is a duty older than the charter.",
        category: "culture",
        tier: "scene",
        visibility: "public",
        unlockTags: [],
        locationTags: ["quay"],
      },
      {
        title: "The Stamp Law",
        body: "No cargo moves off the quay without a customs stamp. The stamps are numbered, the numbers are logged, and the log is the closest thing Greywater has to scripture.",
        category: "institution",
        tier: "scene",
        visibility: "public",
        unlockTags: [],
        locationTags: ["authority", "docks"],
      },
      {
        title: "Toasting the Drowned",
        body: "At the turn of every tide, harbor taverns raise a glass to the drowned. Strangers who join the toast are accepted; strangers who refuse it are remembered.",
        category: "culture",
        tier: "scene",
        visibility: "public",
        unlockTags: [],
        locationTags: ["tavern"],
      },
      {
        title: "The Ledger Beneath the Floor",
        body: "Under the Brine Lantern's cellar boards lies a second ledger: every unstamped cargo of the last decade, in a neat clerk's hand. Whoever keeps it owns half the harbor's secrets.",
        category: "secret",
        tier: "retrieval",
        visibility: "secret",
        unlockTags: ["smuggling", "ledger"],
        locationTags: ["tavern"],
      },
      {
        title: "What Sank the Pelican",
        body: "The Pelican did not founder on the breakwater by accident. Her cargo was switched in the fog, her lanterns moved, and three families on the Row still split the profit of that night.",
        category: "secret",
        tier: "retrieval",
        visibility: "secret",
        unlockTags: ["pelican", "wreck"],
        locationTags: ["secluded", "craft"],
      },
      {
        title: "The Customs Master's Debt",
        body: "The customs master owes a gambling debt he cannot pay to a creditor he cannot name. The fast clock on the Customs House is his: he buys four minutes wherever he can.",
        category: "secret",
        tier: "retrieval",
        visibility: "secret",
        unlockTags: ["debt", "customs"],
        locationTags: ["authority"],
      },
    ],
  };
}

export function demoWorldCastSection(): CastSection {
  // Relationship entries follow the cast prompt's own rules: sparse (no entry
  // = strangers) and each bond named in plain words in the conceptNote — that
  // text is what the bond classifier reads at spawn (contracts/relationships).
  return {
    suggestions: [
      {
        name: "Maren Voss",
        conceptNote:
          "Weary harbor-master in her forties; an old friend of the player from the ferry years; dry humor, bad knee, knows every hull by its creak.",
        role: "companion",
        tier: "major" as const,
        startLocationName: "Harbor Quay",
        relationships: [{ toward: "player", stage: "friendly" }],
      },
      {
        name: "Tobben Crale",
        conceptNote: "Fastidious customs clerk drowning quietly in gambling debts he covers with other people's stamps.",
        role: "npc",
        tier: "minor" as const,
        startLocationName: "Customs House",
        relationships: [],
      },
      {
        name: "Issa Reed",
        conceptNote:
          "Young netmaker on the Row who hears everything and trades gossip for stories of elsewhere; wary of the customs clerk Tobben Crale.",
        role: "npc",
        tier: "minor" as const,
        startLocationName: "Netmaker's Row",
        relationships: [{ toward: "Tobben Crale", stage: "wary" }],
      },
    ],
  };
}

export function demoWorldItemsSection(): ItemsSection {
  return {
    placements: [
      {
        itemName: "Harbor ledger",
        kind: "object",
        description: "A thick, salt-stained ledger of arrivals, tariffs, and corrections in three different hands.",
        coverage: [],
        tags: ["record", "paper"],
        locationName: "Customs House",
        worn: false,
      },
      {
        itemName: "Tide bell",
        kind: "object",
        description: "A verdigrised bronze bell on a gallows-frame, rung at every tide-turn.",
        coverage: [],
        tags: ["landmark", "bronze"],
        locationName: "Harbor Quay",
        worn: false,
      },
      {
        itemName: "Crate of salted herring",
        kind: "container",
        description: "A stenciled crate, nailed shut, heavier than herring has any right to be.",
        coverage: [],
        tags: ["cargo", "container"],
        locationName: "Harbor Quay",
        worn: false,
      },
      {
        itemName: "Brass spyglass",
        kind: "object",
        description: "A dented brass spyglass with a cracked but serviceable lens.",
        coverage: [],
        tags: ["tool", "brass"],
        castName: "Maren Voss",
        worn: false,
      },
      {
        itemName: "Oilskin coat",
        kind: "clothing",
        description: "A heavy oilskin coat gone stiff at the cuffs, pockets full of chalk and twine.",
        coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
        layer: 3,
        tags: ["workwear", "weatherproof"],
        castName: "Maren Voss",
        worn: true,
      },
    ],
  };
}
