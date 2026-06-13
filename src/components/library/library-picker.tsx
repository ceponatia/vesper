"use client";

import { useEffect, useState } from "react";
import type { ApiResult } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tag } from "@/components/ui/tag";

export interface LibraryPickerEntry {
  id: string;
  name: string;
  /** Optional secondary line (kind, tags, …). */
  detail?: string;
  /** Caller payload handed back on pick (e.g. the item kind). */
  data?: unknown;
}

export interface LibraryPickerDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Search the library; q is the raw input (empty = recent/default list). */
  search: (q: string) => Promise<ApiResult<LibraryPickerEntry[]>>;
  onPick: (entry: LibraryPickerEntry) => void;
  /** Ids already in use — shown disabled so a pick can't duplicate. */
  disabledIds?: ReadonlySet<string>;
  emptyText?: string;
}

const DEBOUNCE_MS = 250;

/** Search-and-pick dialog over a library endpoint (cast/items import). */
export function LibraryPickerDialog({
  open,
  onClose,
  title,
  search,
  onPick,
  disabledIds,
  emptyText = "Nothing in the library matches.",
}: LibraryPickerDialogProps) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<LibraryPickerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void search(q).then((result) => {
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
  }, [open, q, search]);

  return (
    <Dialog open={open} onClose={onClose} title={title} className="max-w-md">
      <div className="flex flex-col gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or tag…" autoFocus />
        {error ? <p className="text-xs text-danger-300">{error}</p> : null}
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {loading && results.length === 0 ? <p className="text-xs text-paper-500">Searching…</p> : null}
          {!loading && results.length === 0 && !error ? <p className="text-xs text-paper-500">{emptyText}</p> : null}
          {results.map((entry) => {
            const taken = disabledIds?.has(entry.id) ?? false;
            return (
              <button
                key={entry.id}
                type="button"
                disabled={taken}
                onClick={() => {
                  onPick(entry);
                  onClose();
                }}
                className="flex items-center gap-2 rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-left text-sm text-paper-200 transition-colors not-disabled:cursor-pointer not-disabled:hover:border-ink-500 not-disabled:hover:bg-ink-750 disabled:opacity-50"
              >
                <span className="truncate">{entry.name}</span>
                {entry.detail ? <span className="truncate text-xs text-paper-500">{entry.detail}</span> : null}
                {taken ? (
                  <Tag className="ml-auto" title="Already in this world">
                    added
                  </Tag>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
