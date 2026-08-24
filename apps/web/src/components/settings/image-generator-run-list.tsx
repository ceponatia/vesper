"use client";

import { useState } from "react";
import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import {
  imageGeneratorRunOutputImageIds,
  imageGeneratorRunOutputsOf,
} from "@/contracts/images/image-generator-outputs";
import { imageGeneratorApi, imageUrl, type ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { imageGeneratorStatusChip } from "./image-generator-copy";

/**
 * Every generator run, newest first — the bench's history.
 *
 * Failed rows stay visible on purpose: a refused run is a recorded outcome
 * with a reason on it, and duplicate-and-fix is exactly what the history is
 * for. Every row carries its id whole, because a run is cited by id wherever
 * its result is written up, and matching a row to a note's id should not
 * require opening each one.
 *
 * A bench accumulates far more rows than it keeps, so deleting is a list
 * action here rather than something reached only through a run's detail:
 * every row carries its own Delete, and the tick boxes clear a whole batch in
 * one confirmed call. Both doors end in the same dialog, and the dialog always
 * names how many records and how many rendered images are about to go — this
 * is a hard delete of provenance, and an undercounted confirmation would be
 * the one thing worse than no confirmation at all.
 *
 * Selection lives here rather than on the page: it is spent the moment the
 * delete resolves, and nothing above the list has a use for a half-made one.
 *
 * A run that rendered several images still shows ONE cover — the first output,
 * which is what its row's column names — plus a "×N" beside the status chip.
 * The row is a pointer to the detail; a strip of thumbnails here would compete
 * with the grid that answers the same question properly one click away.
 */

export interface ImageGeneratorRunListProps {
  runs: ImageGeneratorRun[];
  loading: boolean;
  error: ApiError | null;
  onReload: () => void;
  onSelect: (runId: string) => void;
}

/** What the confirm dialog is about to remove, resolved before it opens. */
interface PendingDelete {
  ids: string[];
  /** Rendered outputs among them — the second thing the dialog has to say. */
  outputs: number;
}

/**
 * What the confirm dialog says, so its two counts are always the real ones: a
 * bench fills up with refused runs that rendered nothing, and a dialog that
 * promised to remove images there would be describing a different delete.
 */
function deleteConfirmCopy({ ids, outputs }: PendingDelete): string {
  const subject = ids.length === 1 ? "This record" : `These ${String(ids.length)} records`;
  if (outputs === 0) {
    const verb = ids.length === 1 ? "is" : "are";
    const object = ids.length === 1 ? "it" : "them";
    return `${subject} ${verb} removed — no rendered image goes with ${object}. Input images are not touched.`;
  }
  const rendered = outputs === 1 ? "the hidden image" : `the ${String(outputs)} hidden images`;
  const who = ids.length === 1 ? "it" : "they";
  return `${subject} and ${rendered} ${who} rendered are removed. Input images are not touched.`;
}

/**
 * How many rendered images one row takes with it when deleted — the number the
 * confirmation has to be right about.
 *
 * A fan-out run stored one image per prediction and the `resultImageId` column
 * names only the first, so counting the column would promise to remove one
 * image and remove four. A run written before the fan-out existed has no
 * per-prediction record and the column is the whole answer.
 */
function renderedImageCount(run: ImageGeneratorRun): number {
  const stored = imageGeneratorRunOutputImageIds(imageGeneratorRunOutputsOf(run));
  if (stored.length > 0) return stored.length;
  return run.resultImageId === null ? 0 : 1;
}

/**
 * The "×N" a multi-image run wears beside its status, or null for the ordinary
 * one-image run. It names what the row actually HOLDS, and says so against what
 * was asked for when a prediction came back empty — a row that quietly showed
 * "×4" for two stored images would misdescribe both the bench and the delete.
 */
function outputBadge(run: ImageGeneratorRun): string | null {
  const outputs = imageGeneratorRunOutputsOf(run);
  if (outputs.length <= 1) return null;
  const stored = imageGeneratorRunOutputImageIds(outputs).length;
  return stored === outputs.length
    ? `×${String(stored)}`
    : `×${String(stored)} of ${String(outputs.length)}`;
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
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Ids the server has already dropped, hidden until the parent's refetch
  // lands. Without this the confirmed rows sit there through the reload, and a
  // hard delete that still shows its rows reads as one that did not happen.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  const visible = runs.filter((run) => !removed.has(run.id));

  const toggle = (runId: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });

  // Selection is read back through the rows on screen, never straight out of
  // the set: a reload can retire a row while its id is still ticked, and a
  // count or a delete built on that id would be about a run nobody can see.
  const selectedVisible = visible.filter((run) => selected.has(run.id));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((run) => run.id)));

  const askDelete = (ids: string[]) => {
    const chosen = new Set(ids);
    setPending({
      ids,
      outputs: visible.reduce((total, run) => (chosen.has(run.id) ? total + renderedImageCount(run) : total), 0),
    });
  };

  const confirmDelete = async () => {
    if (!pending) return;
    setDeleting(true);
    // One id still goes through the batch call: the list has one delete path,
    // so the single-row door cannot drift away from the multi-row one.
    const result = await imageGeneratorApi.runs.removeMany(pending.ids);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    const { deleted } = result.data;
    setPending(null);
    setSelected(new Set());
    setRemoved((previous) => new Set([...previous, ...pending.ids]));
    toast.push({ title: `Deleted ${String(deleted)} run${deleted === 1 ? "" : "s"}`, tone: "success" });
    onReload();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="prose-display text-lg">Runs</h2>
        {visible.length > 0 ? (
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-paper-400">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="accent-accent-500"
                aria-label="Select every run shown"
              />
              Select all
            </label>
            <span className="text-xs tabular-nums text-paper-500">{selectedVisible.length} selected</span>
            <Button
              size="sm"
              variant="danger"
              disabled={selectedVisible.length === 0}
              onClick={() => askDelete(selectedVisible.map((run) => run.id))}
            >
              Delete selected
            </Button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}
      {loading && visible.length === 0 ? <Skeleton className="h-24 w-full" /> : null}

      {visible.map((run) => {
        const chip = imageGeneratorStatusChip(run.status);
        const picked = selected.has(run.id);
        const badge = outputBadge(run);
        return (
          <div
            key={run.id}
            className={cx(
              "flex items-start gap-3 rounded-card border bg-ink-850 p-4 transition-colors",
              picked ? "border-accent-500/70" : "border-ink-600 hover:border-ink-500",
            )}
          >
            {/* The tick box is a sibling of the open-this-run button, never
                inside it: an input nested in a button is invalid, and clicking
                one would open the detail the admin was trying to tick. */}
            <label className="touch-target flex shrink-0 cursor-pointer items-center p-1">
              <input
                type="checkbox"
                checked={picked}
                onChange={() => toggle(run.id)}
                className="accent-accent-500"
                aria-label={`Select run ${run.id}`}
              />
            </label>

            <button
              type="button"
              onClick={() => onSelect(run.id)}
              className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
            >
              <RunThumb run={run} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-paper-200">
                    <code>{run.modelSlug}</code>
                  </h3>
                  <Tag tone={chip.tone}>{chip.label}</Tag>
                  {badge !== null ? <Tag>{badge}</Tag> : null}
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

            <Button size="sm" variant="quiet" onClick={() => askDelete([run.id])} aria-label={`Delete run ${run.id}`}>
              Delete
            </Button>
          </div>
        );
      })}

      {!loading && visible.length === 0 ? (
        <p className="text-sm text-paper-500">
          No runs yet. Pick a registered model above, write the exact prompt, and run it — the row that lands here
          records everything the request carried.
        </p>
      ) : null}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending !== null && pending.ids.length > 1 ? `Delete ${String(pending.ids.length)} runs?` : "Delete this run?"}
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="danger" busy={deleting} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        {pending !== null ? deleteConfirmCopy(pending) : null}
      </Dialog>
    </section>
  );
}
