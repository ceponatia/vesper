"use client";

import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import { imageUrl, type ApiError } from "@/lib/client/api";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { imageGeneratorStatusChip } from "./image-generator-copy";

/**
 * Every generator run, newest first — the bench's history.
 *
 * Failed rows stay visible on purpose: a refused run is a recorded outcome
 * with a reason on it, and duplicate-and-fix is exactly what the history is
 * for. Every row carries its id whole, because a run is cited by id wherever
 * its result is written up, and matching a row to a note's id should not
 * require opening each one.
 */

export interface ImageGeneratorRunListProps {
  runs: ImageGeneratorRun[];
  loading: boolean;
  error: ApiError | null;
  onReload: () => void;
  onSelect: (runId: string) => void;
}

function RunThumb({ run }: { run: ImageGeneratorRun }) {
  const shell = "size-16 shrink-0 overflow-hidden rounded-card border border-ink-600 bg-ink-950";
  if (run.resultImageId !== null) {
    return (
      <div className={shell}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; next/image adds nothing here */}
        <img src={imageUrl(run.resultImageId)} alt="Run result" className="size-full object-cover" />
      </div>
    );
  }
  if (run.status === "failed") {
    return <div className={`${shell} flex items-center justify-center text-[11px] text-danger-300`}>failed</div>;
  }
  return <Skeleton className="size-16 shrink-0 rounded-card" />;
}

export function ImageGeneratorRunList({ runs, loading, error, onReload, onSelect }: ImageGeneratorRunListProps) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="prose-display text-lg">Runs</h2>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}
      {loading && runs.length === 0 ? <Skeleton className="h-24 w-full" /> : null}

      {runs.map((run) => {
        const chip = imageGeneratorStatusChip(run.status);
        return (
          <button
            key={run.id}
            type="button"
            onClick={() => onSelect(run.id)}
            className="flex items-start gap-3 rounded-card border border-ink-600 bg-ink-850 p-4 text-left transition-colors hover:border-ink-500"
          >
            <RunThumb run={run} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-paper-200">
                  <code>{run.modelSlug}</code>
                </h3>
                <Tag tone={chip.tone}>{chip.label}</Tag>
                {run.sourceRunId !== null ? <Tag>variant</Tag> : null}
              </div>
              <p className="mt-1 text-[11px] text-paper-500">
                created {new Date(run.createdAt).toLocaleString()}
              </p>
              {/* Same shape the detail header cites it in: the id whole, never
                  shortened — a trimmed id is not the id a note was written with. */}
              <p className="mt-1 text-[11px] text-paper-500">
                id <code className="break-all">{run.id}</code>
              </p>
              {run.prompt.trim() !== "" ? (
                <p className="mt-1 truncate text-xs text-paper-400" title={run.prompt}>
                  {run.prompt}
                </p>
              ) : null}
            </div>
          </button>
        );
      })}

      {!loading && runs.length === 0 ? (
        <p className="text-sm text-paper-500">
          No runs yet. Pick a registered model above, write the exact prompt, and run it — the row that lands here
          records everything the request carried.
        </p>
      ) : null}
    </section>
  );
}
