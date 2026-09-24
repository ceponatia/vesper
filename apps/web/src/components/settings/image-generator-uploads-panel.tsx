"use client";

import { useState, type ReactNode } from "react";
import type { ImageGeneratorUpload } from "@/contracts/images/image-generator-upload";
import { imageGeneratorApi, imageUrl, type ApiError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
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
  /** An upload was deleted — the panel owns none of the list itself, so the
   * caller refetches it and clears the id from anything still holding it. */
  onDeleted: (imageId: string) => void;
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

export function ImageGeneratorUploadsPanel({
  uploads,
  loading,
  error,
  onReload,
  onDeleted,
}: ImageGeneratorUploadsPanelProps) {
  const [enlarged, setEnlarged] = useState<string | null>(null);

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
        <Button size="sm" onClick={onReload}>
          Refresh
        </Button>
      </div>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}

      {loading && uploads.length === 0 ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {uploads.map((upload) => (
            <UploadCard key={upload.imageId} upload={upload} onEnlarge={setEnlarged} onDeleted={onDeleted} />
          ))}
          {uploads.length === 0 ? (
            <p className="col-span-full text-sm text-paper-500">
              No standalone uploads yet. A file uploaded through the reference picker below shows up here.
            </p>
          ) : null}
        </div>
      )}

      <ImageLightbox imageId={enlarged} alt="Uploaded reference" onClose={() => setEnlarged(null)} />
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
  onEnlarge,
  onDeleted,
}: {
  upload: ImageGeneratorUpload;
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
    <figure className="flex flex-col overflow-hidden rounded-card border border-ink-600">
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
