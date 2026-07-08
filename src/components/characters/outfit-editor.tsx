"use client";

import { useCallback, useMemo, useState } from "react";
import { clothingCategories, wearerTargets, type ItemDefinition } from "@/contracts";
import { itemsApi, type ApiResult, type ItemSummary } from "@/lib/client/api";
import { clothingSlots, slotCategoryOptions, type ClothingSlot } from "@/lib/clothing-slots";
import { useAsyncData } from "@/components/hooks/use-async";
import { itemCardChips, itemCardGroup } from "@/components/library/item-facets";
import { EntityPickerDialog, type EntityPickerEntry, type EntityPickerFacet } from "@/components/library/entity-picker";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

export interface OutfitEditorProps {
  /** Item ids from the owner's library (CharacterProfile.defaultOutfit). */
  outfit: readonly string[];
  onChange: (outfit: string[]) => void;
  /** Forge-suggested item drafts not yet in the library (saved alongside). */
  suggestedItems: readonly ItemDefinition[];
  onChangeSuggested: (items: ItemDefinition[]) => void;
  /** Default wearer facet for the add-picker (from `identity.gender`); always overridable in the picker. */
  wearerHint?: "feminine" | "masculine";
}

const layerLabels = ["underwear", "base", "mid", "outer"] as const;

const wearerFacet: EntityPickerFacet = {
  id: "wearer",
  label: "Wearer",
  options: wearerTargets.map((w) => ({ id: w.id, label: w.label })),
};

function itemEntry(item: ItemSummary): EntityPickerEntry {
  return {
    id: item.id,
    name: item.name,
    imageId: item.imageId,
    chips: itemCardChips(item),
    group: itemCardGroup(item, "clothing") ?? undefined,
  };
}

/**
 * Default-outfit builder (library-ux.plan.md §6): the outfit reads as wardrobe
 * slots (tops / bottoms / underwear / footwear / accessories), each slot adding
 * from the shared EntityPicker pre-filtered to its categories and the
 * character's wearer target — so a long clothing library arrives as "the tops
 * that fit her", never the whole list.
 */
export function OutfitEditor({ outfit, onChange, suggestedItems, onChangeSuggested, wearerHint }: OutfitEditorProps) {
  // Resolve the referenced outfit ids directly — bypassing the browse cap — so a
  // stored reference always renders its real item even after the library grows past
  // the cap. (The items aren't deleted; they just rank past the most-recent window.)
  const outfitKey = outfit.join(",");
  const referenced = useAsyncData<ItemSummary[]>(
    () =>
      outfit.length > 0
        ? itemsApi.listByIds(outfit)
        : Promise.resolve<ApiResult<ItemSummary[]>>({ ok: true, data: [] }),
    [outfitKey],
  );
  const byId = useMemo(() => {
    const map = new Map<string, ItemSummary>();
    for (const item of referenced.data ?? []) map.set(item.id, item);
    return map;
  }, [referenced.data]);

  const [pickerSlot, setPickerSlot] = useState<ClothingSlot | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const searchClothing = useCallback(
    async (q: string, facets: Record<string, string>): Promise<ApiResult<EntityPickerEntry[]>> => {
      const result = await itemsApi.list({
        kind: "clothing",
        q,
        category: facets.category,
        wearer: facets.wearer,
        color: facets.color,
      });
      if (!result.ok) return result;
      // A slot spans several categories; until one is picked in the facet row,
      // scope the server's kind-wide list down to the slot client-side.
      const scoped =
        pickerSlot && !facets.category
          ? result.data.filter((item) => item.definition.category !== null && pickerSlot.categories.includes(item.definition.category))
          : result.data;
      return { ok: true, data: scoped.map(itemEntry) };
    },
    [pickerSlot],
  );

  const pickerFacets: EntityPickerFacet[] = [
    {
      id: "category",
      label: "Category",
      options: pickerSlot ? slotCategoryOptions(pickerSlot) : clothingCategories.map((c) => ({ id: c.id, label: c.label })),
    },
    wearerFacet,
  ];

  const openPicker = (slot: ClothingSlot | null) => {
    setPickerSlot(slot);
    setPickerOpen(true);
  };

  if (referenced.loading && referenced.data === null) return <Skeleton className="h-32" />;

  // Outfit rows sorted into wardrobe slots by their item's category; unresolved
  // or uncategorized references land in the trailing "Other" section.
  const slotRows = new Map<string, string[]>();
  const other: string[] = [];
  for (const itemId of outfit) {
    const category = byId.get(itemId)?.definition.category;
    const slot = clothingSlots.find((s) => category && s.categories.includes(category));
    if (!slot) {
      other.push(itemId);
      continue;
    }
    slotRows.set(slot.id, [...(slotRows.get(slot.id) ?? []), itemId]);
  }

  const renderRow = (itemId: string) => {
    const item = byId.get(itemId);
    return (
      <li
        key={itemId}
        className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm"
      >
        <span className={item ? "text-paper-100" : "text-paper-500 italic"}>{item?.name ?? "missing item"}</span>
        {item ? (
          <>
            {itemCardChips(item).map((chip) => (
              <Tag key={chip.label}>
                {chip.swatch ? (
                  <span
                    aria-hidden
                    className="mr-1 inline-block size-2 rounded-full border border-ink-500 align-middle"
                    style={{ backgroundColor: chip.swatch }}
                  />
                ) : null}
                {chip.label}
              </Tag>
            ))}
            {item.definition.layer !== null ? <Tag>{layerLabels[item.definition.layer]}</Tag> : null}
          </>
        ) : (
          <Tag tone="danger">not in library</Tag>
        )}
        <button
          type="button"
          onClick={() => onChange(outfit.filter((id) => id !== itemId))}
          className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
        >
          remove
        </button>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-5">
      {referenced.error ? <ErrorState error={referenced.error} onRetry={() => referenced.reload()} /> : null}

      {clothingSlots.map((slot) => {
        const rows = slotRows.get(slot.id) ?? [];
        return (
          <div key={slot.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">{slot.label}</h3>
              <button
                type="button"
                onClick={() => openPicker(slot)}
                className="cursor-pointer rounded-md border border-ink-600 px-2 py-0.5 text-xs text-paper-400 transition-colors hover:border-accent-500/60 hover:text-accent-300"
              >
                + Add
              </button>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-paper-500">Nothing worn.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">{rows.map(renderRow)}</ul>
            )}
          </div>
        );
      })}

      {other.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Other</h3>
          <ul className="flex flex-col gap-1.5">{other.map(renderRow)}</ul>
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => openPicker(null)}
          className="cursor-pointer rounded-md border border-ink-600 px-2.5 py-1 text-xs text-paper-400 transition-colors hover:border-accent-500/60 hover:text-accent-300"
        >
          + Add from the whole wardrobe…
        </button>
      </div>

      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerSlot ? `Add — ${pickerSlot.label}` : "Add clothing"}
        search={searchClothing}
        multi={{
          confirm: (entries) => onChange([...outfit, ...entries.map((e) => e.id).filter((id) => !outfit.includes(id))]),
          confirmLabel: "Add to outfit",
        }}
        facets={pickerFacets}
        initialFacets={wearerHint ? { wearer: wearerHint } : undefined}
        disabledIds={new Set(outfit)}
        emptyText="No clothing matches — check the wearer filter, or create the garment in the Items library."
      />

      {suggestedItems.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">
            Suggested new items
          </h3>
          <p className="text-xs text-paper-500">
            Forge suggestions with no library match — saved as new items with this character.
          </p>
          <ul className="flex flex-col gap-1.5">
            {suggestedItems.map((item, index) => (
              <li
                key={`${item.name}-${index}`}
                className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm"
              >
                <span className="text-paper-100">{item.name}</span>
                <Tag tone="ai">suggested</Tag>
                {item.layer !== undefined ? <Tag>{layerLabels[item.layer]}</Tag> : null}
                {item.coverage.length > 0 ? (
                  <span className="truncate text-xs text-paper-500">{item.coverage.join(", ")}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onChangeSuggested(suggestedItems.filter((_, i) => i !== index))}
                  className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
                >
                  discard
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
