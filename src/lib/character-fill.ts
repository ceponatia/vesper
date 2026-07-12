import {
  DEFAULT_BODY_PLAN_ID,
  DEFAULT_SPECIES_ID,
  DRIVES_MAX,
  type AttributeValue,
  type CharacterProfile,
  type Drive,
  type ItemDefinition,
  type Preference,
  type TraitValue,
} from "@/contracts";

/**
 * Sheet-fill merge policy (character-sheet-forge.plan.md): the in-sheet Forge
 * completes a partially-authored character WITHOUT overwriting anything already
 * entered. Pure and shared — the server applies it as the authoritative
 * post-generation filter (prompt discipline is an optimization; this merge is
 * the guarantee), and the client re-applies it over the response so edits made
 * while the request was in flight also win over generated content.
 *
 * The contract, field by field:
 * - free-text scalars (name, bio, personality, voice, age): non-empty ⇒ fixed,
 *   whoever wrote them — predictable beats clever. The per-tab Re-draft is the
 *   tool that rewrites text.
 * - lists (library tags, disposition tags, aliases): additive — existing
 *   entries are never removed or edited; new ones append (deduped).
 * - attributes / traits (provenance-carrying): existing ids are never touched
 *   (manual OR creation); only missing ids fill in.
 * - preferences: target-exclusive — a target the sheet already has an opinion
 *   on is never contradicted or duplicated.
 * - drives: additive up to the 3-drive cap (owner ruling 2026-07-12) —
 *   authored drives never change; generated ones (deduped by want) fill the
 *   remaining slots.
 * - species cluster (speciesId/heritageId/bodyPlanId/bodyFeatures): adopted
 *   from the generated draft only while still at the blank-create default —
 *   filling the species IS the feature on an untouched sheet, but any authored
 *   body intent freezes the whole cluster.
 * - outfit cluster (defaultOutfit + suggestedItems): all-or-nothing — an
 *   outfit is a coherent set, so any authored garment keeps the whole cluster
 *   (no generated extras that double up coverage).
 * - playerRelationship, socialCards, schedule: never filled (the forge does
 *   not generate them); always the base's.
 */

/** The draft shape both the server and client drafts satisfy structurally. */
export interface FillableDraft {
  name: string;
  tags: string[];
  suggestedItems: ItemDefinition[];
  profile: CharacterProfile;
}

/**
 * The blank-create placeholder ("Untitled character", entity-library.tsx) is
 * fillable — a fresh sheet shouldn't keep its stand-in name while everything
 * else forges. Any other non-empty name is player-authored and fixed.
 */
export function isPlaceholderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || /^untitled( character)?$/i.test(trimmed);
}

/**
 * True while the body/species cluster is still exactly the blank-create
 * default — the only state in which the fill may adopt a generated species.
 * `bodyFeatures === undefined` matters: even an empty array is an explicit
 * authored override (contracts/world/profile.ts).
 */
export function isSpeciesUnset(profile: CharacterProfile): boolean {
  return (
    profile.speciesId === DEFAULT_SPECIES_ID &&
    profile.heritageId === undefined &&
    profile.bodyPlanId === DEFAULT_BODY_PLAN_ID &&
    profile.bodyFeatures === undefined
  );
}

const keepText = (base: string, incoming: string): string => (base.trim() !== "" ? base : incoming);

const keepOptionalText = (base: string | undefined, incoming: string | undefined): string | undefined =>
  base !== undefined && base.trim() !== "" ? base : incoming;

/** Additive string-list union: base order first, incoming appended, deduped case-insensitively. */
function unionText(base: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(base.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""));
  const out = [...base];
  for (const entry of incoming) {
    const key = entry.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Additive by-id union for provenance-carrying values: existing ids are never touched. */
function unionById<T extends { id: string }>(base: readonly T[], incoming: readonly T[]): T[] {
  const present = new Set(base.map((v) => v.id));
  return [...base, ...incoming.filter((v) => !present.has(v.id))];
}

/** Additive, target-exclusive preference union: an already-opined target never changes. */
function unionPreferences(base: readonly Preference[], incoming: readonly Preference[]): Preference[] {
  const present = new Set(base.map((p) => p.target.trim().toLowerCase()));
  return [...base, ...incoming.filter((p) => !present.has(p.target.trim().toLowerCase()))];
}

/** Additive drive union up to the cap: authored drives lead untouched; generated ones (deduped by want) fill the rest. */
function unionDrives(base: readonly Drive[], incoming: readonly Drive[]): Drive[] {
  const present = new Set(base.map((d) => d.want.trim().toLowerCase()));
  const out = [...base];
  for (const drive of incoming) {
    if (out.length >= DRIVES_MAX) break;
    const key = drive.want.trim().toLowerCase();
    if (key === "" || present.has(key)) continue;
    present.add(key);
    out.push(drive);
  }
  return out;
}

/**
 * Fill-merge a generated draft into the authored base. `incoming` is a fully
 * generated draft (typically the base plus the forge legs' contributions);
 * everything the base already authored survives byte-identical.
 */
export function mergeFillDraft<T extends FillableDraft>(base: T, incoming: FillableDraft): T {
  const speciesUnset = isSpeciesUnset(base.profile);
  const outfitAuthored = base.profile.defaultOutfit.length > 0 || base.suggestedItems.length > 0;
  const attributes: AttributeValue[] = unionById(base.profile.attributes, incoming.profile.attributes);
  const traits: TraitValue[] = unionById(base.profile.traits, incoming.profile.traits);
  return {
    ...base,
    name: isPlaceholderName(base.name) && incoming.name.trim() !== "" ? incoming.name : base.name,
    tags: unionText(base.tags, incoming.tags),
    suggestedItems: outfitAuthored ? base.suggestedItems : incoming.suggestedItems,
    profile: {
      ...base.profile,
      bio: keepText(base.profile.bio, incoming.profile.bio),
      personality: keepText(base.profile.personality, incoming.profile.personality),
      voice: keepOptionalText(base.profile.voice, incoming.profile.voice),
      age: keepText(base.profile.age, incoming.profile.age),
      speciesId: speciesUnset ? incoming.profile.speciesId : base.profile.speciesId,
      heritageId: speciesUnset ? incoming.profile.heritageId : base.profile.heritageId,
      bodyPlanId: speciesUnset ? incoming.profile.bodyPlanId : base.profile.bodyPlanId,
      bodyFeatures: speciesUnset ? incoming.profile.bodyFeatures : base.profile.bodyFeatures,
      intimateRegions:
        base.profile.intimateRegions.length > 0 ? base.profile.intimateRegions : incoming.profile.intimateRegions,
      attributes,
      tags: unionText(base.profile.tags, incoming.profile.tags),
      preferences: unionPreferences(base.profile.preferences, incoming.profile.preferences),
      drives: unionDrives(base.profile.drives, incoming.profile.drives),
      traits,
      aliases: unionText(base.profile.aliases, incoming.profile.aliases),
      defaultOutfit: outfitAuthored ? base.profile.defaultOutfit : incoming.profile.defaultOutfit,
    },
  };
}
