import {
  clothingCategories,
  clothingSubtypeById,
  colorFamilies,
  objectSubtypes,
  wearerMatchesFilter,
  wearerTargets,
} from "@/contracts";
import type { ItemDefinitionParts } from "@/lib/client/api";

/**
 * Facet + grouping config for the items library (library-ux.plan.md §3).
 * Facets filter the loaded set client-side (instant chips, exact counts within
 * the fetch); the server-side facet params exist for pickers and fixed
 * pre-filters, where cap-correctness matters more than interactivity.
 */

export interface FacetOption {
  id: string;
  label: string;
  /** Color chip dot (hex) — color facet only. */
  swatch?: string;
}

export interface FacetDef<TCard> {
  id: string;
  label: string;
  /** Offered only while this type bucket is active (undefined = every bucket). */
  forBucket?: string;
  options: readonly FacetOption[];
  value: (card: TCard) => string | undefined;
  /** Match override (wearer's absent/unisex semantics); default is equality. */
  matches?: (cardValue: string | undefined, optionId: string) => boolean;
}

export interface CardGroup {
  id: string;
  label: string;
  order: number;
}

interface ItemFacetCard {
  kind?: string;
  definition?: ItemDefinitionParts;
}

const layerOptions: readonly FacetOption[] = [
  { id: "0", label: "Underwear" },
  { id: "1", label: "Base" },
  { id: "2", label: "Mid" },
  { id: "3", label: "Outer" },
];

export function itemFacetDefs<TCard extends ItemFacetCard>(): FacetDef<TCard>[] {
  return [
    {
      id: "category",
      label: "Category",
      forBucket: "clothing",
      options: clothingCategories.map((c) => ({ id: c.id, label: c.label })),
      value: (card) => card.definition?.category ?? undefined,
    },
    {
      id: "subtype",
      label: "Subtype",
      forBucket: "object",
      options: objectSubtypes.map((s) => ({ id: s.id, label: s.label })),
      value: (card) => card.definition?.subtype ?? undefined,
    },
    {
      id: "wearer",
      label: "Wearer",
      forBucket: "clothing",
      options: wearerTargets.map((w) => ({ id: w.id, label: w.label })),
      value: (card) => card.definition?.wearer ?? undefined,
      matches: (value, optionId) => wearerMatchesFilter(value, optionId),
    },
    {
      id: "layer",
      label: "Layer",
      forBucket: "clothing",
      options: layerOptions,
      value: (card) => (card.definition?.layer === null || card.definition?.layer === undefined ? undefined : String(card.definition.layer)),
    },
    {
      id: "color",
      label: "Color",
      options: colorFamilies.map((c) => ({ id: c.id, label: c.label, swatch: c.swatch })),
      value: (card) => card.definition?.color?.family ?? undefined,
    },
  ];
}

/**
 * Grouped "closet" sections for the unfiltered browse: Clothing → by
 * category, Object → by subtype; containers stay flat.
 */
export function itemCardGroup(card: ItemFacetCard, bucket: string): CardGroup | null {
  if (bucket === "clothing") {
    const id = card.definition?.category ?? "";
    const index = clothingCategories.findIndex((c) => c.id === id);
    if (index === -1) return { id: "uncategorized", label: "Uncategorized", order: 99 };
    const category = clothingCategories[index];
    return category ? { id: category.id, label: category.label, order: index } : null;
  }
  if (bucket === "object") {
    const id = card.definition?.subtype ?? "";
    const index = objectSubtypes.findIndex((s) => s.id === id);
    if (index === -1) return { id: "other", label: "Other", order: 99 };
    const subtype = objectSubtypes[index];
    return subtype ? { id: subtype.id, label: subtype.label, order: index } : null;
  }
  return null;
}

/** Compact facet chips for an item card/row (category or subtype + color). */
export function itemCardChips(card: ItemFacetCard): { label: string; swatch?: string }[] {
  const chips: { label: string; swatch?: string }[] = [];
  const category = card.definition?.category ? clothingCategories.find((c) => c.id === card.definition?.category) : undefined;
  const subtype = card.definition?.subtype ? objectSubtypes.find((s) => s.id === card.definition?.subtype) : undefined;
  // Accessory clothing shows its type instead of the broad category (a "nose
  // ring" chip beats "Jewelry"); other clothing keeps the category chip.
  const clothingSubtype = clothingSubtypeById(card.definition?.subtype);
  if (category && clothingSubtype) chips.push({ label: clothingSubtype.label });
  else if (category) chips.push({ label: category.label });
  else if (subtype) chips.push({ label: subtype.label });
  const family = card.definition?.color?.family ? colorFamilies.find((c) => c.id === card.definition?.color?.family) : undefined;
  if (family) chips.push({ label: card.definition?.color?.shade || family.label, swatch: family.swatch });
  return chips;
}
