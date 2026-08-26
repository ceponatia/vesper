"use client";

import { useState } from "react";
import type { NarratorPromptTemplateSummary } from "@/contracts/narrator-prompts";
import type { ApiError } from "@/lib/client/api";
import { timeAgo } from "@/lib/relative-time";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { usageCountLabel } from "./narrator-prompt-shared";

/**
 * The Prompt Lab's library pane (narrator-prompt-lab.plan.md §"Library pane"):
 * every saved prompt, with the three facts that decide which one to open —
 * which revision it is on, when it last changed, and how many conversations it
 * is currently steering.
 *
 * The search filters the list the page already holds rather than asking the
 * server: this is one owner's handful of experiments, and a round trip per
 * keystroke would buy nothing.
 */

export interface NarratorPromptLibraryProps {
  templates: NarratorPromptTemplateSummary[];
  loading: boolean;
  error: ApiError | null;
  /** The template open in the editor, or null while a new prompt is being written. */
  selectedId: string | null;
  onReload: () => void;
  onSelect: (templateId: string) => void;
  onNew: () => void;
}

function matches(template: NarratorPromptTemplateSummary, query: string): boolean {
  if (query === "") return true;
  return template.name.toLowerCase().includes(query) || template.notes.toLowerCase().includes(query);
}

export function NarratorPromptLibrary({
  templates,
  loading,
  error,
  selectedId,
  onReload,
  onSelect,
  onNew,
}: NarratorPromptLibraryProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const shown = templates.filter((template) => matches(template, query));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="prose-display text-lg">Saved prompts</h2>
        <Button size="sm" variant="primary" onClick={onNew}>
          New prompt
        </Button>
      </div>

      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name or hypothesis"
        aria-label="Search saved prompts"
        spellCheck={false}
      />

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}
      {loading && templates.length === 0 ? <Skeleton className="h-20 w-full" /> : null}

      <div className="flex flex-col gap-2">
        {shown.map((template) => {
          const selected = template.id === selectedId;
          const stamp = timeAgo(template.updatedAt);
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template.id)}
              aria-current={selected ? "true" : undefined}
              className={cx(
                "rounded-card border px-3 py-2.5 text-left transition-colors",
                selected
                  ? "border-accent-500 bg-ink-750"
                  : "border-ink-600 bg-ink-850 hover:border-ink-500 hover:bg-ink-800",
              )}
            >
              <span className="block truncate text-sm font-medium text-paper-200">{template.name}</span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-paper-500">
                <span>{`v${String(template.currentRevision)}`}</span>
                <span aria-hidden="true">·</span>
                <span>{stamp === "" ? "never saved" : stamp}</span>
                <span aria-hidden="true">·</span>
                <span>{usageCountLabel(template.usageCount)}</span>
              </span>
              {template.notes.trim() === "" ? null : (
                <span className="mt-1 block truncate text-xs text-paper-400">{template.notes}</span>
              )}
            </button>
          );
        })}
      </div>

      {!loading && templates.length === 0 ? (
        <p className="text-sm text-paper-500">
          No saved prompts yet. A prompt here replaces the narrator’s behavior instructions for one conversation at a
          time, so the first one is usually a small rewrite of something you already want to argue with.
        </p>
      ) : null}

      {templates.length > 0 && shown.length === 0 ? (
        <p className="text-sm text-paper-500">Nothing matches that search.</p>
      ) : null}
    </section>
  );
}
