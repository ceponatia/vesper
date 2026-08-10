"use client";

import type { ImageLabExperiment } from "@/contracts";
import { imageUrl, type ApiError } from "@/lib/client/api";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import {
  imageLabControlKindLabel,
  imageLabExperimentKindLabel,
  imageLabStatusChip,
  imageLabVerdictChip,
} from "./image-lab-copy";

/**
 * Every experiment, newest first — the lab's evidence archive.
 *
 * Failed rows stay visible on purpose: a refused run is a recorded outcome with
 * a reason on it, which is exactly the kind of thing the bench exists to
 * accumulate. Nothing here disappears when it stops being interesting.
 */

export interface ImageLabExperimentListProps {
  experiments: ImageLabExperiment[];
  loading: boolean;
  error: ApiError | null;
  /** A create was accepted and its row has not surfaced in a refetch yet. */
  queued: boolean;
  onReload: () => void;
  onSelect: (experimentId: string) => void;
}

function ExperimentThumb({ experiment }: { experiment: ImageLabExperiment }) {
  const shell = "size-16 shrink-0 overflow-hidden rounded-card border border-ink-600 bg-ink-950";
  if (experiment.resultImageId !== null) {
    return (
      <div className={shell}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; next/image adds nothing here */}
        <img src={imageUrl(experiment.resultImageId)} alt="Experiment result" className="size-full object-cover" />
      </div>
    );
  }
  if (experiment.status === "failed") {
    return (
      <div className={`${shell} flex items-center justify-center text-[11px] text-danger-300`}>failed</div>
    );
  }
  return <Skeleton className="size-16 shrink-0 rounded-card" />;
}

export function ImageLabExperimentList({
  experiments,
  loading,
  error,
  queued,
  onReload,
  onSelect,
}: ImageLabExperimentListProps) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="prose-display text-lg">Experiments</h2>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}
      {loading && experiments.length === 0 ? <Skeleton className="h-24 w-full" /> : null}

      {/* The painting tile: up from the instant the create is accepted, so the
          stretch between the 201 and the row appearing in a refetch is never a
          screen that says nothing happened (PR #70's pattern). */}
      {queued ? (
        <div className="flex items-center gap-3 rounded-card border border-ink-600 bg-ink-850 p-4">
          <Skeleton className="size-16 shrink-0 rounded-card" />
          <div className="flex flex-col gap-1">
            <Tag>starting…</Tag>
            <p className="text-[11px] text-paper-500">The run has been accepted and is claiming its render.</p>
          </div>
        </div>
      ) : null}

      {experiments.map((experiment) => {
        const chip = imageLabStatusChip(experiment.status);
        const verdict = experiment.verdict === null ? null : imageLabVerdictChip(experiment.verdict);
        return (
          <button
            key={experiment.id}
            type="button"
            onClick={() => onSelect(experiment.id)}
            className="flex items-start gap-3 rounded-card border border-ink-600 bg-ink-850 p-4 text-left transition-colors hover:border-ink-500"
          >
            <ExperimentThumb experiment={experiment} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-paper-200">
                  {imageLabExperimentKindLabel(experiment.kind)}
                </h3>
                <Tag tone={chip.tone}>{chip.label}</Tag>
                {experiment.controlKind !== null ? (
                  <Tag tone="accent">{imageLabControlKindLabel(experiment.controlKind)}</Tag>
                ) : null}
                {verdict ? <Tag tone={verdict.tone}>{verdict.label}</Tag> : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-paper-500">
                <code>{experiment.modelSlug}</code> · created {new Date(experiment.createdAt).toLocaleString()}
              </p>
              {experiment.instruction.trim() !== "" ? (
                <p className="mt-1 truncate text-xs text-paper-400" title={experiment.instruction}>
                  {experiment.instruction}
                </p>
              ) : null}
            </div>
          </button>
        );
      })}

      {!loading && experiments.length === 0 && !queued ? (
        <p className="text-sm text-paper-500">
          No experiments yet. A control probe is the first one the plan asks for: identity reference, pose fixture, and
          a look at whether the output obeys it.
        </p>
      ) : null}
    </section>
  );
}
