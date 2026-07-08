"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApiResult } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { EntityImage } from "@/components/ui/entity-image";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";

export interface EntityPickerEntry {
  id: string;
  name: string;
  /** Optional secondary line (kind, tags, …). */
  detail?: string;
  /** Thumbnail; `null` renders the monogram fallback, omit to skip the thumb column. */
  imageId?: string | null;
  /** Compact structured chips (category, color swatch, …). */
  chips?: { label: string; swatch?: string }[];
  /** Empty-query section (items group by category); flat list when absent. */
  group?: { id: string; label: string; order: number };
  /** Caller payload handed back on pick (e.g. the item kind). */
  data?: unknown;
}

/** A single-select facet row inside the picker; picking re-queries the search. */
export interface EntityPickerFacet {
  id: string;
  label: string;
  options: { id: string; label: string; swatch?: string }[];
}

export interface EntityPickerDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Search the library; q is the raw input (empty = recent/default list). */
  search: (q: string, facets: Record<string, string>) => Promise<ApiResult<EntityPickerEntry[]>>;
  /** Single-pick mode: called and closed on row click. Ignored when `multi` is set. */
  onPick?: (entry: EntityPickerEntry) => void;
  /** Multi-pick basket mode: rows toggle, the footer button confirms the set. */
  multi?: { confirm: (entries: EntityPickerEntry[]) => void; confirmLabel?: string };
  facets?: EntityPickerFacet[];
  /** Facet selections active when the dialog opens (e.g. the character's wearer). */
  initialFacets?: Record<string, string>;
  /** Ids already in use — shown disabled so a pick can't duplicate. */
  disabledIds?: ReadonlySet<string>;
  emptyText?: string;
  /** Thumbnail aspect: square (items/characters) vs wide (locations). */
  square?: boolean;
}

const DEBOUNCE_MS = 250;

/**
 * Search-and-pick dialog over a library endpoint (library-ux.plan.md §6):
 * thumbnails, facet chips, grouped empty-query browse, single or basket
 * multi-select. The shared picker behind every "add from library" flow.
 */
export function EntityPickerDialog({
  open,
  onClose,
  title,
  search,
  onPick,
  multi,
  facets,
  initialFacets,
  disabledIds,
  emptyText = "Nothing in the library matches.",
  square = true,
}: EntityPickerDialogProps) {
  const [q, setQ] = useState("");
  const [facetSel, setFacetSel] = useState<Record<string, string>>(initialFacets ?? {});
  const [selected, setSelected] = useState<ReadonlyMap<string, EntityPickerEntry>>(new Map());
  const [results, setResults] = useState<EntityPickerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per open, adjusted during render (no sync setState-in-effect):
  // each opening starts from a clean query/basket and the caller's facets.
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setQ("");
    setFacetSel(initialFacets ?? {});
    setSelected(new Map());
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const facetKey = JSON.stringify(facetSel);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void search(q, JSON.parse(facetKey) as Record<string, string>).then((result) => {
        if (cancelled) return;
        setLoading(false);
        if (result.ok) {
          setResults(result.data);
          setError(null);
        } else {
          setResults([]);
          setError(result.error.message);
        }
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, q, facetKey, search]);

  // Grouped sections only for the unqueried browse; a search goes flat
  // (relevance order beats section order once the user is looking for a name).
  const sections = useMemo(() => {
    if (q.trim() !== "" || results.every((r) => !r.group)) return null;
    const byGroup = new Map<string, { group: NonNullable<EntityPickerEntry["group"]>; entries: EntityPickerEntry[] }>();
    for (const entry of results) {
      const group = entry.group ?? { id: "other", label: "Other", order: 999 };
      const section = byGroup.get(group.id) ?? { group, entries: [] };
      section.entries.push(entry);
      byGroup.set(group.id, section);
    }
    return [...byGroup.values()].sort((a, b) => a.group.order - b.group.order);
  }, [q, results]);

  const toggle = (entry: EntityPickerEntry) => {
    if (multi) {
      setSelected((current) => {
        const next = new Map(current);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.set(entry.id, entry);
        return next;
      });
      return;
    }
    onPick?.(entry);
    onClose();
  };

  const renderRow = (entry: EntityPickerEntry) => {
    const taken = disabledIds?.has(entry.id) ?? false;
    const picked = selected.has(entry.id);
    return (
      <button
        key={entry.id}
        type="button"
        disabled={taken}
        aria-pressed={multi ? picked : undefined}
        onClick={() => toggle(entry)}
        className={cx(
          "flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-sm text-paper-200 transition-colors not-disabled:cursor-pointer disabled:opacity-50",
          picked
            ? "border-accent-500/60 bg-accent-500/10"
            : "border-ink-600 bg-ink-800 not-disabled:hover:border-ink-500 not-disabled:hover:bg-ink-750",
        )}
      >
        {entry.imageId !== undefined ? (
          <EntityImage
            imageId={entry.imageId}
            name={entry.name}
            className={cx("shrink-0 rounded text-[10px]", square ? "size-9" : "h-9 w-14")}
          />
        ) : null}
        <span className="min-w-0">
          <span className="block truncate">{entry.name}</span>
          {entry.detail ? <span className="block truncate text-xs text-paper-500">{entry.detail}</span> : null}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {entry.chips?.map((chip) => (
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
          {taken ? <Tag title="Already added">added</Tag> : null}
          {multi && picked ? <Tag tone="accent">✓</Tag> : null}
        </span>
      </button>
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} className="max-w-lg">
      <div className="flex flex-col gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or tag…" autoFocus />
        {facets?.map((facet) => (
          <div key={facet.id} className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 shrink-0 text-xs text-paper-500">{facet.label}</span>
            {facet.options.map((option) => {
              const active = facetSel[facet.id] === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() =>
                    setFacetSel((current) => {
                      const next = { ...current };
                      if (active) delete next[facet.id];
                      else next[facet.id] = option.id;
                      return next;
                    })
                  }
                  className={cx(
                    "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                    active
                      ? "border-accent-500/60 bg-accent-500/10 text-accent-300"
                      : "border-ink-500 text-paper-400 hover:text-paper-200",
                  )}
                >
                  {option.swatch ? (
                    <span aria-hidden className="size-2.5 rounded-full border border-ink-500" style={{ backgroundColor: option.swatch }} />
                  ) : null}
                  {option.label}
                </button>
              );
            })}
          </div>
        ))}
        {error ? <p className="text-xs text-danger-300">{error}</p> : null}
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {loading && results.length === 0 ? <p className="text-xs text-paper-500">Searching…</p> : null}
          {!loading && results.length === 0 && !error ? <p className="text-xs text-paper-500">{emptyText}</p> : null}
          {sections
            ? sections.map((section) => (
                <div key={section.group.id} className="flex flex-col gap-1">
                  <h3 className="mt-1.5 text-xs font-medium tracking-wide text-paper-400 uppercase first:mt-0">
                    {section.group.label}
                  </h3>
                  {section.entries.map(renderRow)}
                </div>
              ))
            : results.map(renderRow)}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>{multi ? "Cancel" : "Close"}</Button>
        {multi ? (
          <Button
            variant="primary"
            disabled={selected.size === 0}
            onClick={() => {
              multi.confirm([...selected.values()]);
              onClose();
            }}
          >
            {multi.confirmLabel ?? "Add"}
            {selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
