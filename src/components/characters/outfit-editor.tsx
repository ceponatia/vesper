"use client";

import { useMemo } from "react";
import type { ItemDefinition } from "@/contracts";
import { itemsApi, type ApiResult, type ItemSummary } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { ErrorState } from "@/components/ui/error-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";

export interface OutfitEditorProps {
  /** Item ids from the owner's library (CharacterProfile.defaultOutfit). */
  outfit: readonly string[];
  onChange: (outfit: string[]) => void;
  /** Forge-suggested item drafts not yet in the library (saved alongside). */
  suggestedItems: readonly ItemDefinition[];
  onChangeSuggested: (items: ItemDefinition[]) => void;
}

const layerLabels = ["underwear", "base", "mid", "outer"] as const;

/** Default-outfit builder: picks clothing from the item library by id. */
export function OutfitEditor({ outfit, onChange, suggestedItems, onChangeSuggested }: OutfitEditorProps) {
  // The clothing browse list (capped) powers the "add" dropdown.
  const library = useAsyncData(() => itemsApi.list({ kind: "clothing" }), []);
  // Resolve the *referenced* outfit ids directly — bypassing the browse cap — so a
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
    for (const item of library.data ?? []) map.set(item.id, item);
    return map;
  }, [library.data, referenced.data]);

  // Skeleton only on the first load of each leg — `useAsyncData` keeps prior data
  // across reloads, so editing the outfit never flashes the skeleton.
  if (library.loading || (referenced.loading && referenced.data === null)) return <Skeleton className="h-32" />;

  return (
    <div className="flex flex-col gap-5">
      {library.error ? <ErrorState error={library.error} onRetry={() => library.reload()} /> : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium tracking-wide text-paper-400 uppercase">Default outfit</h3>
        {outfit.length === 0 ? <p className="text-sm text-paper-500">Nothing worn by default.</p> : null}
        <ul className="flex flex-col gap-1.5">
          {outfit.map((itemId) => {
            const item = byId.get(itemId);
            return (
              <li
                key={itemId}
                className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm"
              >
                <span className={item ? "text-paper-100" : "text-paper-500 italic"}>
                  {item?.name ?? "missing item"}
                </span>
                {item ? <Tag>{item.kind}</Tag> : <Tag tone="danger">not in library</Tag>}
                <button
                  type="button"
                  onClick={() => onChange(outfit.filter((id) => id !== itemId))}
                  className="ml-auto cursor-pointer text-xs text-paper-500 hover:text-danger-300"
                >
                  remove
                </button>
              </li>
            );
          })}
        </ul>
        <Select
          value=""
          aria-label="Add outfit item"
          onChange={(e) => {
            if (e.target.value && !outfit.includes(e.target.value)) onChange([...outfit, e.target.value]);
          }}
          className="h-8 max-w-72 text-xs text-paper-400"
        >
          <option value="">+ Add from item library…</option>
          {(library.data ?? [])
            .filter((item) => !outfit.includes(item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
      </div>

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
