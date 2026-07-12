import { interactionConceptById, interactionConcepts, severityToTier, speciesCatalog, TIERS, type SocialReactionCardExtras, type Tier } from "@/contracts";
import type { FacetDef, FacetOption } from "./item-facets";

/**
 * Facet + chip config for the character / location / social-card libraries
 * (library-ux.plan.md §Follow-up pass), riding the same client-side machinery
 * as item-facets.ts: facets filter the loaded set instantly; the server's job
 * is only to ship the facet columns on the list payload.
 */

interface CharacterFacetCard {
  speciesId?: string | null;
  gender?: string | null;
  worldCount?: number;
}

interface LocationFacetCard {
  scale?: string | null;
  worldCount?: number;
}

interface SocialCardFacetCard {
  card?: SocialReactionCardExtras;
}

// The stored gender vocabulary splits androgynous/nonbinary by natal sex for
// image generation (identity.ts); browsing collapses each pair into one chip.
const GENDER_OPTIONS: readonly FacetOption[] = [
  { id: "female", label: "Female" },
  { id: "male", label: "Male" },
  { id: "androgynous", label: "Androgynous" },
  { id: "nonbinary", label: "Nonbinary" },
];

function genderMatches(value: string | undefined, optionId: string): boolean {
  return value === optionId || (value?.startsWith(`${optionId}_`) ?? false);
}

// "World usage" reads the soft source pointers worlds keep on their snapshot
// copies (world_cast.source_character_id etc.) — see world-instances.plan.md.
const WORLD_USAGE_OPTIONS: readonly FacetOption[] = [
  { id: "used", label: "In a world" },
  { id: "unused", label: "Unused" },
];

function worldUsage(count: number | undefined): string {
  return (count ?? 0) > 0 ? "used" : "unused";
}

function worldCountChip(count: number | undefined): { label: string }[] {
  return count && count > 0 ? [{ label: `${count} world${count === 1 ? "" : "s"}` }] : [];
}

export function characterFacetDefs<TCard extends CharacterFacetCard>(): FacetDef<TCard>[] {
  return [
    {
      id: "species",
      label: "Species",
      options: speciesCatalog.map((s) => ({ id: s.id, label: s.label })),
      value: (card) => card.speciesId ?? undefined,
    },
    {
      id: "gender",
      label: "Gender",
      options: GENDER_OPTIONS,
      value: (card) => card.gender ?? undefined,
      matches: genderMatches,
    },
    { id: "worlds", label: "Worlds", options: WORLD_USAGE_OPTIONS, value: (card) => worldUsage(card.worldCount) },
  ];
}

/** Species (when notable — a library of humans doesn't need saying) + world usage. */
export function characterCardChips(card: CharacterFacetCard): { label: string }[] {
  const species =
    card.speciesId && card.speciesId !== "human" ? speciesCatalog.find((s) => s.id === card.speciesId) : undefined;
  return [...(species ? [{ label: species.label }] : []), ...worldCountChip(card.worldCount)];
}

const SCALE_OPTIONS: readonly FacetOption[] = [
  { id: "intimate", label: "Intimate" },
  { id: "room", label: "Room" },
  { id: "hall", label: "Hall" },
  { id: "open", label: "Open" },
  { id: "expanse", label: "Expanse" },
];

export function locationFacetDefs<TCard extends LocationFacetCard>(): FacetDef<TCard>[] {
  return [
    { id: "scale", label: "Scale", options: SCALE_OPTIONS, value: (card) => card.scale ?? undefined },
    { id: "worlds", label: "Worlds", options: WORLD_USAGE_OPTIONS, value: (card) => worldUsage(card.worldCount) },
  ];
}

export function locationCardChips(card: LocationFacetCard): { label: string }[] {
  const scale = SCALE_OPTIONS.find((s) => s.id === card.scale);
  return [...(scale ? [{ label: scale.label }] : []), ...worldCountChip(card.worldCount)];
}

const TIER_LABELS: Record<Tier, string> = {
  odd: "Odd",
  disapproval: "Disapproval",
  shunning: "Shunning",
  ostracized: "Ostracized",
};

export function socialCardFacetDefs<TCard extends SocialCardFacetCard>(): FacetDef<TCard>[] {
  return [
    {
      id: "tier",
      label: "Severity",
      options: TIERS.map((t) => ({ id: t, label: TIER_LABELS[t] })),
      value: (card) => (card.card ? severityToTier(card.card.severity) : undefined),
    },
    {
      id: "trigger",
      label: "Trigger",
      options: interactionConcepts.map((c) => ({ id: c.id, label: c.label })),
      values: (card) => card.card?.triggers ?? [],
    },
  ];
}

/** Severity tier + the first trigger concepts (library-ux.plan.md: tier/trigger chips). */
export function socialCardChips(card: SocialCardFacetCard): { label: string }[] {
  if (!card.card) return [];
  const triggers = card.card.triggers.flatMap((id) => {
    const concept = interactionConceptById(id);
    return concept ? [{ label: concept.label }] : [];
  });
  return [{ label: TIER_LABELS[severityToTier(card.card.severity)] }, ...triggers.slice(0, 2)];
}
