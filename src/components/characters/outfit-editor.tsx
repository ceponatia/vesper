"use client";

import { useCallback, useMemo, useState } from "react";
import { clothingCategories, wearerTargets, type ItemDefinition, type OutfitPreset } from "@/contracts";
import { itemsApi, type ApiResult, type ItemSummary } from "@/lib/client/api";
import { clothingSlots, slotCategoryOptions, type ClothingSlot } from "@/lib/clothing-slots";
import { useAsyncData } from "@/components/hooks/use-async";
import { itemCardChips, itemCardGroup } from "@/components/library/item-facets";
import { EntityPickerDialog, type EntityPickerEntry, type EntityPickerFacet } from "@/components/library/entity-picker";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

export interface OutfitEditorProps {
  /** Named outfit presets (CharacterProfile.outfits) — the FIRST is the default. */
  outfits: readonly OutfitPreset[];
  onChange: (outfits: OutfitPreset[]) => void;
  /** Forge-suggested item drafts not yet in the library (saved alongside). */
  suggestedItems: readonly ItemDefinition[];
  onChangeSuggested: (items: ItemDefinition[]) => void;
  /** Default wearer facet for the add-picker (from `identity.gender`); always overridable in the picker. */
  wearerHint?: "feminine" | "masculine";
}

/** Client-minted preset id — unique within one profile is all it needs. */
const mintPresetId = () => `p-${Math.random().toString(36).slice(2, 8)}`;

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
 * Outfit-preset builder (ux-improvements slice 8, on the library-ux §6 slot
 * design): a **preset switcher** (casual / work / date night / sleep — the
 * FIRST preset is the default the forge targets and the avatar/sessions/chat
 * wear) over the slot-based item editor (tops / bottoms / underwear / footwear
 * / accessories), each slot adding from the shared EntityPicker pre-filtered
 * to its categories and the character's wearer target.
 */
export function OutfitEditor({ outfits, onChange, suggestedItems, onChangeSuggested, wearerHint }: OutfitEditorProps) {
  // A characterless blank profile has no presets yet — the editor shows one
  // implicit "Everyday" preset that materializes into the profile on first edit.
  const presets: readonly OutfitPreset[] =
    outfits.length > 0 ? outfits : [{ id: "everyday", name: "Everyday", items: [] }];
  const [selectedId, setSelectedId] = useState(presets[0]?.id ?? "everyday");
  const selected = presets.find((p) => p.id === selectedId) ?? presets[0] ?? { id: "everyday", name: "Everyday", items: [] };
  const updateSelected = (patch: Partial<OutfitPreset>) => {
    onChange(presets.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)));
  };
  const outfit = selected.items;
  const setItems = (items: string[]) => updateSelected({ items });

  const addPreset = () => {
    const preset: OutfitPreset = { id: mintPresetId(), name: `Preset ${presets.length + 1}`, items: [] };
    onChange([...presets, preset]);
    setSelectedId(preset.id);
  };
  const duplicatePreset = () => {
    const copy: OutfitPreset = { id: mintPresetId(), name: `${selected.name || "Preset"} copy`, items: [...selected.items] };
    onChange([...presets, copy]);
    setSelectedId(copy.id);
  };
  const deletePreset = () => {
    const remaining = presets.filter((p) => p.id !== selected.id);
    onChange([...remaining]);
    setSelectedId(remaining[0]?.id ?? "everyday");
  };
  const makeDefault = () => {
    onChange([selected, ...presets.filter((p) => p.id !== selected.id)]);
  };

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
          onClick={() => setItems(outfit.filter((id) => id !== itemId))}
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

      {/* Preset switcher (slice 8): pickup skips and schedule day-parts dress by
          preset name; the FIRST preset is the default everywhere. */}
      <div className="flex flex-col gap-2 rounded-card border border-ink-600 bg-ink-850 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {presets.map((preset, index) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={preset.id === selected.id}
              onClick={() => setSelectedId(preset.id)}
              className={cx(
                "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                preset.id === selected.id
                  ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                  : "border-ink-500 text-paper-400 hover:text-paper-200",
              )}
            >
              {preset.name || "Unnamed"}
              {index === 0 ? <span className="ml-1 text-paper-500">· default</span> : null}
            </button>
          ))}
          <button
            type="button"
            onClick={addPreset}
            className="cursor-pointer rounded-full border border-dashed border-ink-500 px-2.5 py-0.5 text-xs text-paper-400 transition-colors hover:border-accent-500/50 hover:text-paper-200"
          >
            + New preset
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Preset name"
            value={selected.name}
            placeholder="casual, work, date night, sleep…"
            onChange={(e) => updateSelected({ name: e.target.value })}
            className="h-8 w-44 text-xs"
          />
          <Button size="sm" variant="quiet" onClick={duplicatePreset}>
            Duplicate
          </Button>
          {presets[0]?.id !== selected.id ? (
            <Button size="sm" variant="quiet" onClick={makeDefault} title="The default preset is what the avatar, sessions, and a fresh chat wear.">
              Make default
            </Button>
          ) : null}
          {presets.length > 1 ? (
            <Button size="sm" variant="quiet" onClick={deletePreset} className="text-danger-300">
              Delete preset
            </Button>
          ) : null}
        </div>
      </div>

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
          confirm: (entries) => setItems([...outfit, ...entries.map((e) => e.id).filter((id) => !outfit.includes(id))]),
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
