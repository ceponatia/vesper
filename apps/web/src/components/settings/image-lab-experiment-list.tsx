"use client";

import { useEffect, useRef } from "react";
import type { ImageLabExperiment } from "@vesper/image-core";
import { imageUrl, type ApiError } from "@/lib/client/api";
import { cx } from "@/components/ui/cx";
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
 *
 * Every row carries its id, because a lab record is cited by id everywhere the
 * bench's output is written down — a ruling, a note — and matching a row to the
 * id in a note should not require opening each one.
 */

export interface ImageLabExperimentListProps {
  experiments: ImageLabExperiment[];
  loading: boolean;
  error: ApiError | null;
  /** A create was accepted and its row has not surfaced in a refetch yet. */
  queued: boolean;
  /** The experiment the last create produced: ringed, and scrolled to when it lands. */
  createdId: string | null;
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
  createdId,
  onReload,
  onSelect,
}: ImageLabExperimentListProps) {
  const createdRef = useRef<HTMLButtonElement>(null);
  // A create's row lands a refetch later, below a form the admin is still
  // looking at. Bring it on screen the moment it arrives — once per created id:
  // keyed on the landed id (not a boolean) so a second create scrolls even when
  // a racing status poll fetched its row before the mark moved, while the silent
  // polls that follow a landing never re-yank the page out from under someone.
  const landedCreatedId =
    createdId !== null && experiments.some((experiment) => experiment.id === createdId) ? createdId : null;
  useEffect(() => {
    if (landedCreatedId === null) return;
    createdRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [landedCreatedId]);

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
        const justCreated = experiment.id === createdId;
        return (
          <button
            key={experiment.id}
            ref={justCreated ? createdRef : undefined}
            type="button"
            onClick={() => onSelect(experiment.id)}
            className={cx(
              "flex items-start gap-3 rounded-card border bg-ink-850 p-4 text-left transition-colors",
              justCreated ? "border-accent-500 ring-1 ring-accent-500/40" : "border-ink-600 hover:border-ink-500",
            )}
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
                {/* Said in words as well as in the ring: the mark that leads an
                    admin to the run they just paid for cannot rest on colour
                    alone, and this row's other chips are all words too. */}
                {justCreated ? <Tag tone="accent">just created</Tag> : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-paper-500">
                <code>{experiment.modelSlug}</code> · created {new Date(experiment.createdAt).toLocaleString()}
              </p>
              {/* Same shape the detail header cites it in: the id whole, never
                  shortened — a trimmed id is not the id a note was written with. */}
              <p className="mt-1 text-[11px] text-paper-500">
                id <code className="break-all">{experiment.id}</code>
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
