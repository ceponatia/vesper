"use client";

import { useCallback, useMemo, useState } from "react";
import { clothingCategories, wearerTargets, type OutfitPreset } from "@/contracts";
import { itemsApi, type ApiResult, type ItemSummary } from "@/lib/client/api";
import { clothingSlots, slotCategoryOptions, type ClothingSlot } from "@/lib/clothing-slots";
import { useAsyncData } from "@/components/hooks/use-async";
import { itemCardChips, itemCardGroup } from "@/components/library/item-facets";
import { EntityPickerDialog, type EntityPickerEntry, type EntityPickerFacet } from "@/components/library/entity-picker";
import { Tag } from "@/components/ui/tag";
import { Textarea } from "@/components/ui/textarea";

/**
 * The chat Character sheet's structured wardrobe editor (chat-wardrobe-parity.plan.md
 * rung 3): per-body-location equip/remove over the conversation's worn item ids, plus a
 * preset switcher that dresses her in a named look and the free-text overlay/exposure
 * fallback. Reuses the outfit-editor's slot + picker primitives (`clothingSlots`,
 * `EntityPickerDialog`, `itemsApi`) rather than the session `participant-card` (which is
 * item-instance-coupled and dev-only). Controlled — the sheet owns the state and save.
 */
export interface ChatWardrobeEditorProps {
  wornItemIds: string[];
  outfitPresetId: string;
  /** Free-text overlay/fallback (ad-hoc + legacy looks). */
  outfit: string;
  outfitExposed: boolean;
  /** The character's authored outfit presets — the switcher's options. */
  presets: readonly OutfitPreset[];
  /** Default wearer facet for the add-picker (from identity.gender). */
  wearerHint?: "feminine" | "masculine";
  onChange: (patch: {
    wornItemIds?: string[];
    outfitPresetId?: string;
    outfit?: string;
    outfitExposed?: boolean;
  }) => void;
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

export function ChatWardrobeEditor({
  wornItemIds,
  outfitPresetId,
  outfit,
  outfitExposed,
  presets,
  wearerHint,
  onChange,
}: ChatWardrobeEditorProps) {
  const [pickerSlot, setPickerSlot] = useState<ClothingSlot | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Resolve the worn ids to their real items (bypasses the browse cap so a worn
  // garment always renders even after the library grows past the recent window).
  const wornKey = wornItemIds.join(",");
  const resolved = useAsyncData<ItemSummary[]>(
    () =>
      wornItemIds.length > 0
        ? itemsApi.listByIds(wornItemIds)
        : Promise.resolve<ApiResult<ItemSummary[]>>({ ok: true, data: [] }),
    [wornKey],
  );
  const byId = useMemo(() => {
    const map = new Map<string, ItemSummary>();
    for (const item of resolved.data ?? []) map.set(item.id, item);
    return map;
  }, [resolved.data]);

  const setWorn = (ids: string[]) => onChange({ wornItemIds: ids });
  const removeItem = (itemId: string) => setWorn(wornItemIds.filter((id) => id !== itemId));
  const applyPreset = (preset: OutfitPreset) => onChange({ wornItemIds: [...preset.items], outfitPresetId: preset.id });

  const searchClothing = useCallback(
    async (q: string, facets: Record<string, string>): Promise<ApiResult<EntityPickerEntry[]>> => {
      const result = await itemsApi.list({ kind: "clothing", q, category: facets.category, wearer: facets.wearer, color: facets.color });
      if (!result.ok) return result;
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

  // Worn ids bucketed into wardrobe slots by their item's category; unresolved /
  // uncategorized worn items land in the trailing "Other" section.
  const slotRows = new Map<string, string[]>();
  const other: string[] = [];
  for (const itemId of wornItemIds) {
    const category = byId.get(itemId)?.definition.category;
    const slot = clothingSlots.find((s) => category && s.categories.includes(category));
    if (slot) slotRows.set(slot.id, [...(slotRows.get(slot.id) ?? []), itemId]);
    else other.push(itemId);
  }

  const renderRow = (itemId: string) => {
    const item = byId.get(itemId);
    return (
      <li key={itemId} className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm">
        <span className={item ? "text-paper-100" : "text-paper-500 italic"}>{item?.name ?? "missing item"}</span>
        {item ? (
          <>
            {itemCardChips(item).map((chip) => (
              <Tag key={chip.label}>{chip.label}</Tag>
            ))}
            {item.definition.layer !== null ? <Tag>{layerLabels[item.definition.layer]}</Tag> : null}
            {item.definition.opacity === "sheer" ? <Tag>sheer</Tag> : null}
          </>
        ) : (
          <Tag tone="danger">not in library</Tag>
        )}
        <button
          type="button"
          onClick={() => removeItem(itemId)}
          className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
        >
          remove
        </button>
      </li>
    );
  };

  const withPresets = presets.filter((p) => p.items.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium tracking-wide text-paper-400 uppercase">Wardrobe</span>

      {withPresets.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-paper-500">Dress in:</span>
          {withPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={preset.id === outfitPresetId}
              onClick={() => applyPreset(preset)}
              className={
                preset.id === outfitPresetId
                  ? "cursor-pointer rounded-full border border-accent-500/60 bg-accent-500/10 px-2.5 py-0.5 text-xs text-accent-300"
                  : "cursor-pointer rounded-full border border-ink-500 px-2.5 py-0.5 text-xs text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200"
              }
            >
              {preset.name || "Unnamed"}
            </button>
          ))}
        </div>
      ) : null}

      {clothingSlots.map((slot) => {
        const rows = slotRows.get(slot.id) ?? [];
        return (
          <div key={slot.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <h4 className="text-[11px] font-medium tracking-wide text-paper-500 uppercase">{slot.label}</h4>
              <button
                type="button"
                onClick={() => openPicker(slot)}
                className="cursor-pointer rounded-md border border-ink-600 px-2 py-0.5 text-xs text-paper-400 transition-colors hover:border-accent-500/60 hover:text-accent-300"
              >
                + Add
              </button>
            </div>
            {rows.length > 0 ? <ul className="flex flex-col gap-1.5">{rows.map(renderRow)}</ul> : null}
          </div>
        );
      })}

      {other.length > 0 ? <ul className="flex flex-col gap-1.5">{other.map(renderRow)}</ul> : null}

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-paper-500">
          Also / instead (free text — a borrowed hoodie, an ad-hoc look; garments named here count as coverage)
        </span>
        <Textarea
          rows={2}
          value={outfit}
          onChange={(e) => onChange({ outfit: e.target.value })}
          placeholder="Narrated garments with no library item ride here alongside the worn list…"
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-paper-400">
        <input
          type="checkbox"
          checked={outfitExposed}
          onChange={(e) => onChange({ outfitExposed: e.target.checked })}
          className="size-4 accent-accent-500"
        />
        Reveal intimate anatomy in scene images (used when nothing is equipped; off lets coverage — worn or named
        above — decide)
      </label>

      <EntityPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={pickerSlot ? `Equip — ${pickerSlot.label}` : "Equip clothing"}
        search={searchClothing}
        multi={{
          confirm: (entries) => setWorn([...wornItemIds, ...entries.map((e) => e.id).filter((id) => !wornItemIds.includes(id))]),
          confirmLabel: "Equip",
        }}
        facets={pickerFacets}
        initialFacets={wearerHint ? { wearer: wearerHint } : undefined}
        disabledIds={new Set(wornItemIds)}
        emptyText="No clothing matches — check the wearer filter, or create the garment in the Items library."
      />
    </div>
  );
}
