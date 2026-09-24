"use client";

import { useState, type ReactNode } from "react";
import type { ImageGeneratorUpload } from "@/contracts/images/image-generator-upload";
import { imageGeneratorApi, imageUrl, type ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cx } from "@/components/ui/cx";
import { ErrorState } from "@/components/ui/error-state";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * The Image Generator's own upload shelf (#635): every reference/control image
 * an admin filed directly to the bench through the reference picker's "upload
 * a file" path, never tied to any run. Before this panel these accumulated on
 * disk with no view or delete surface at all.
 *
 * The grid, tile shape, and inline delete-confirm are the Advanced Image Lab's
 * control-fixtures panel (`image-lab-fixtures-panel.tsx`), copied rather than
 * reinvented: a thumbnail shown whole, provenance and size as labelled facts,
 * and "Really delete? / Keep" resolved on the tile itself instead of behind a
 * modal that would cover the very image being judged.
 *
 * Clearing out a pile one tile at a time is its own chore, so the tiles also
 * carry tick boxes and the header the run list's "Select all / N selected /
 * Delete selected" bar. A batch is about many images at once rather than the
 * one under the cursor, so it confirms in the run list's dialog instead of on
 * a tile. An upload a run still uses is refused one by one, not the batch
 * with it: the rest go, and the refused ones stay ticked so the highlighted
 * tiles are exactly the ones still waiting on a run's delete.
 *
 * This panel owns no review state (an upload carries none) and no upload
 * form — uploading happens inline wherever the reference picker needs one;
 * this is only where an admin comes back to see what has piled up and clear
 * it out. The list and delete routes are filtered server-side by
 * `meta.source`, so a run's own rendered output can never appear or be
 * reachable here even though it shares the same hidden `generator_output`
 * kind.
 */

export interface ImageGeneratorUploadsPanelProps {
  uploads: ImageGeneratorUpload[];
  loading: boolean;
  error: ApiError | null;
  onReload: () => void;
  /** Uploads were deleted — the panel owns none of the list itself, so the
   * caller refetches it and clears the ids from anything still holding them. */
  onDeleted: (imageIds: readonly string[]) => void;
}

const uploadSourceLabel: Record<ImageGeneratorUpload["source"], string> = {
  generator_upload: "uploaded",
  admin_files_import: "from Files",
};

/** `1.2 MB` / `840 KB` / `12 B` — one decimal only below 10 of a unit, so the
 * label never claims more precision than a human glancing at a tile needs. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** What the batch confirmation says — the count it names is the one about to be sent. */
function bulkDeleteCopy(count: number): string {
  const subject = count === 1 ? "This upload and its file are" : `These ${String(count)} uploads and their files are`;
  return `${subject} removed. Any upload a run still uses as an input is kept instead — delete that run first.`;
}

export function ImageGeneratorUploadsPanel({
  uploads,
  loading,
  error,
  onReload,
  onDeleted,
}: ImageGeneratorUploadsPanelProps) {
  const toast = useToast();
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The ids the open confirmation names, fixed when it opened, so the delete
  // sent is the one the dialog counted even if a reload lands in between.
  const [pending, setPending] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Ids the server has already dropped, hidden until the caller's refetch
  // lands (the run list's idiom): a deleted tile that lingers through the
  // reload reads as a delete that did not happen.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  const visible = uploads.filter((upload) => !removed.has(upload.imageId));

  const toggle = (imageId: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(imageId)) next.add(imageId);
      return next;
    });

  // Selection is read back through the tiles on screen, never straight out of
  // the set: a reload can retire an upload while its id is still ticked, and a
  // count or a delete built on that id would be about an image nobody can see.
  const selectedVisible = visible.filter((upload) => selected.has(upload.imageId));
  const allSelected = visible.length > 0 && selectedVisible.length === visible.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((upload) => upload.imageId)));

  const markDeleted = (imageIds: readonly string[]) => {
    setRemoved((previous) => new Set([...previous, ...imageIds]));
    onDeleted(imageIds);
  };

  const confirmDelete = async () => {
    if (pending === null) return;
    setDeleting(true);
    const result = await imageGeneratorApi.uploads.removeMany(pending);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    const { deleted, inUse } = result.data;
    setPending(null);
    setSelected(new Set(inUse));
    if (deleted.length > 0) {
      markDeleted(deleted);
      toast.push({
        title: `Deleted ${String(deleted.length)} upload${deleted.length === 1 ? "" : "s"}`,
        tone: "success",
      });
    } else if (inUse.length === 0) {
      // Every id was already gone — another tab got there first. Refetch so
      // the tiles stop claiming otherwise.
      onReload();
    }
    if (inUse.length > 0) {
      toast.push({
        title: `Kept ${String(inUse.length)} upload${inUse.length === 1 ? "" : "s"} a run still uses`,
        description: "Still selected — delete the runs that use them first.",
      });
    }
  };

  return (
    <section className="rounded-card border border-ink-600 bg-ink-850 p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="prose-display text-lg">Reference uploads</h2>
          <p className="mt-1 text-sm text-paper-400">
            Reference and control images uploaded directly to this bench, outside of any run. Delete the ones you no
            longer need — the file on disk goes with the row.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {visible.length > 0 ? (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-paper-400">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-accent-500"
                  aria-label="Select every upload shown"
                />
                Select all
              </label>
              <span className="text-xs tabular-nums text-paper-500">{selectedVisible.length} selected</span>
              <Button
                size="sm"
                variant="danger"
                disabled={selectedVisible.length === 0}
                onClick={() => setPending(selectedVisible.map((upload) => upload.imageId))}
              >
                Delete selected
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={onReload}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}

      {loading && visible.length === 0 ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {visible.map((upload) => (
            <UploadCard
              key={upload.imageId}
              upload={upload}
              picked={selected.has(upload.imageId)}
              onToggle={() => toggle(upload.imageId)}
              onEnlarge={setEnlarged}
              onDeleted={(imageId) => markDeleted([imageId])}
            />
          ))}
          {visible.length === 0 ? (
            <p className="col-span-full text-sm text-paper-500">
              No standalone uploads yet. A file uploaded through the reference picker below shows up here.
            </p>
          ) : null}
        </div>
      )}

      <ImageLightbox imageId={enlarged} alt="Uploaded reference" onClose={() => setEnlarged(null)} />

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => void confirmDelete()}
        title={pending !== null && pending.length > 1 ? `Delete ${String(pending.length)} uploads?` : "Delete this upload?"}
        busy={deleting}
      >
        {pending !== null ? bulkDeleteCopy(pending.length) : null}
      </ConfirmDialog>
    </section>
  );
}

const tileActionTones = {
  quiet: "text-paper-400 hover:text-paper-100",
  danger: "text-danger-300 hover:text-danger-200",
} as const;

/**
 * A tile-footer action — the fixtures panel's dense idiom, copied for the same
 * reason: `Button size="sm"` does not fit a tile at the six-column breakpoint.
 */
function TileAction({
  tone = "quiet",
  disabled,
  onClick,
  className,
  children,
}: {
  tone?: keyof typeof tileActionTones;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "cursor-pointer rounded px-1.5 py-0.5 text-[11px] hover:bg-ink-800 disabled:cursor-not-allowed disabled:text-paper-600 disabled:hover:bg-transparent",
        tileActionTones[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

/** One uploaded reference: the pixels shown whole, its provenance and size, and the one ruling an admin makes on it. */
function UploadCard({
  upload,
  picked,
  onToggle,
  onEnlarge,
  onDeleted,
}: {
  upload: ImageGeneratorUpload;
  picked: boolean;
  onToggle: () => void;
  onEnlarge: (imageId: string) => void;
  onDeleted: (imageId: string) => void;
}) {
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    const result = await imageGeneratorApi.uploads.remove(upload.imageId);
    setDeleting(false);
    setConfirmingDelete(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    toast.push({ title: "Upload deleted", tone: "success" });
    onDeleted(upload.imageId);
  };

  return (
    <figure
      className={cx(
        "flex flex-col overflow-hidden rounded-card border transition-colors",
        picked ? "border-accent-500/70" : "border-ink-600",
      )}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => onEnlarge(upload.imageId)}
          aria-label="Enlarge uploaded reference"
          className="block w-full cursor-pointer"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local asset route; shown whole, uncropped */}
          <img
            src={imageUrl(upload.imageId)}
            alt="Uploaded reference"
            className="aspect-square w-full bg-ink-950 object-contain"
          />
        </button>
        {/* The tick box overlays the enlarge button as a sibling, never inside
            it: an input nested in a button is invalid, and a click on it would
            open the lightbox instead of ticking. Backed so it reads on any image. */}
        <label className="touch-target absolute top-1.5 left-1.5 flex size-7 cursor-pointer items-center justify-center rounded-md border border-ink-600 bg-ink-900/80 backdrop-blur-sm">
          <input
            type="checkbox"
            checked={picked}
            onChange={onToggle}
            className="accent-accent-500"
            aria-label={`Select upload ${upload.originalName ?? upload.imageId}`}
          />
        </label>
      </div>
      <figcaption className="flex flex-1 flex-col gap-1 px-2 py-1.5 text-[11px] text-paper-400">
        <span className="flex flex-wrap items-center gap-1">
          <Tag>{uploadSourceLabel[upload.source]}</Tag>
          <span className="text-paper-600">{formatBytes(upload.bytes)}</span>
        </span>
        <span className="text-paper-600">{new Date(upload.createdAt).toLocaleDateString()}</span>
        {upload.originalName ? (
          <span className="truncate text-paper-500" title={upload.originalName}>
            {upload.originalName}
          </span>
        ) : null}

        {confirmingDelete ? (
          <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1">
            <TileAction tone="danger" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Really delete?"}
            </TileAction>
            <TileAction disabled={deleting} onClick={() => setConfirmingDelete(false)}>
              Keep
            </TileAction>
          </span>
        ) : (
          <span className="mt-auto flex items-center pt-1">
            <TileAction tone="danger" className="ml-auto" onClick={() => setConfirmingDelete(true)}>
              Delete
            </TileAction>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
