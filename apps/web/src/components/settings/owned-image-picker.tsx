"use client";

import { useState } from "react";
import {
  adminFilesApi,
  ownedImagesApi,
  type ApiError,
  type OwnedImageSourceRecord,
} from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ImageChoiceGrid } from "./image-lab-pickers";

/**
 * The general owner-scoped image picker:
 * every ready image the source policy lists, not one character's portraits or
 * one chat's scenes. The Image Generator's inputs read it, and the lab reuses
 * it for the roles whose experiment contracts already accept a generic source
 * (the object and location references, fixture extraction).
 *
 * It renders `/api/admin/self/owned-images` — a kind filter, a thumbnail grid,
 * and createdAt paging behind a "Load more" — and answers with an image id.
 * Clicking the chosen tile again clears it (the lab render picker's idiom):
 * every caller has a legitimate "none", and a picker with no way back to empty
 * would hide it.
 *
 * Owner-admin bench callers may also import a raster from Admin Files. That
 * source is copied into the ordinary image registry first; this component still
 * answers only with an image id, so no Files path leaks into a render request.
 */

/**
 * The kinds the sources endpoint serves, spelled client-side because
 * components may not import the server allowlist. The server VALIDATES a kinds
 * filter rather than narrowing it, so a drifted entry here fails loudly as a
 * 400 instead of silently listing nothing.
 */
export const OWNED_IMAGE_PICKER_KINDS = [
  "avatar",
  "portrait_variant",
  "scene",
  "entity",
  "chat_upload",
  "chat_look",
  "chat_place",
  "lab_control",
  "lab_output",
  "generator_output",
] as const;
export type OwnedImagePickerKind = (typeof OWNED_IMAGE_PICKER_KINDS)[number];

const KIND_LABELS: Record<OwnedImagePickerKind, string> = {
  avatar: "avatar",
  portrait_variant: "portrait variant",
  scene: "chat scene",
  entity: "entity art",
  chat_upload: "chat upload",
  chat_look: "chat look",
  chat_place: "chat place",
  lab_control: "lab fixture",
  lab_output: "lab render",
  generator_output: "generator output",
};

/** A kind's label, degrading to the humanized identifier for one this list has not learned. */
export function ownedImageKindLabel(kind: string): string {
  const known = OWNED_IMAGE_PICKER_KINDS.find((candidate) => candidate === kind);
  return known !== undefined ? KIND_LABELS[known] : kind.replaceAll("_", " ");
}

/** One endpoint page — the server's own default, restated for the has-more read below. */
const PAGE_SIZE = 60;
const ADMIN_FILE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif"]);

function isAdminFileImage(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && ADMIN_FILE_IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function parentAdminFilesPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Mounted only while the Files chooser is open, so closed pickers do no Files I/O. */
function AdminFilesImageBrowser({
  onImported,
  onClose,
}: {
  onImported: (imageId: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const directory = useAsyncData(() => adminFilesApi.list(path), [path]);
  const toast = useToast();

  const importImage = async (filePath: string) => {
    setImporting(filePath);
    const result = await adminFilesApi.importImage(filePath);
    setImporting(null);
    if (!result.ok) {
      toast.push({ title: "Files import failed", description: result.error.message, tone: "error" });
      return;
    }
    onImported(result.data.imageId);
    toast.push({
      title: "Reference imported",
      description: "Vesper copied the Files image into the reusable image library.",
      tone: "success",
    });
  };

  const entries = directory.data?.entries ?? [];
  const folders = entries.filter((entry) => entry.kind === "folder");
  const images = entries.filter((entry) => entry.kind === "file" && isAdminFileImage(entry.name));

  return (
    <div className="rounded-card border border-ink-700 bg-ink-950/40 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] tracking-wide text-paper-500 uppercase">Files</p>
          <p className="truncate text-xs text-paper-300">{path === "" ? "/" : `/${path}`}</p>
        </div>
        {path !== "" ? (
          <Button size="sm" variant="quiet" onClick={() => setPath(parentAdminFilesPath(path))}>
            Up
          </Button>
        ) : null}
        {path !== "" ? (
          <Button size="sm" variant="quiet" onClick={() => setPath("")}>
            Root
          </Button>
        ) : null}
        <Button size="sm" variant="quiet" onClick={onClose}>
          Close
        </Button>
      </div>

      {directory.error ? <ErrorState error={directory.error} onRetry={() => directory.reload()} /> : null}
      {directory.loading && !directory.data ? <Skeleton className="h-24 w-full" /> : null}

      {!directory.loading && directory.data ? (
        <div className="flex flex-col gap-3">
          {folders.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {folders.map((entry) => (
                <Button key={entry.path} size="sm" variant="quiet" onClick={() => setPath(entry.path)}>
                  {entry.name}/
                </Button>
              ))}
            </div>
          ) : null}

          {images.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  disabled={importing !== null}
                  onClick={() => void importImage(entry.path)}
                  className="overflow-hidden rounded-card border border-ink-700 bg-ink-900 text-left transition-colors hover:border-ink-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- authorized Files preview route, not a static asset */}
                  <img
                    src={adminFilesApi.previewUrl(entry.path)}
                    alt=""
                    className="aspect-square w-full bg-ink-950 object-cover"
                  />
                  <span className="block truncate px-2 py-1.5 text-xs text-paper-300">
                    {importing === entry.path ? "Importing…" : entry.name}
                  </span>
                </button>
              ))}
            </div>
          ) : folders.length === 0 ? (
            <p className="text-xs text-paper-500">No PNG, JPEG, WebP, or AVIF images in this folder.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AdminFilesImageSource({ onImported }: { onImported: (imageId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="quiet" onClick={() => setOpen(true)}>
          Choose from Files
        </Button>
      </div>
    );
  }
  return (
    <AdminFilesImageBrowser
      onClose={() => setOpen(false)}
      onImported={(imageId) => {
        onImported(imageId);
        setOpen(false);
      }}
    />
  );
}

export interface OwnedImagePickerProps {
  label: string;
  hint?: string;
  /**
   * Restrict the listing to these kinds; omit to offer every picker-eligible
   * kind. With more than one on offer the picker shows its own filter.
   */
  kinds?: readonly string[];
  value: string | null;
  /**
   * `imageId` is null when the chosen tile is clicked again (clearing the
   * pick). `source` rides along on a selection for callers that want a display
   * label without a second fetch; plain setState setters ignore it.
   */
  onChange: (imageId: string | null, source?: OwnedImageSourceRecord) => void;
  /** One image this caller's question rules out — shown greyed with the reason,
   * never dropped, so an admin who knows the image exists reads the rule
   * instead of a broken list. */
  excluded?: { imageId: string; reason: string } | null;
  /** Copy for an empty listing, in the caller's own nouns. */
  emptyHint?: string;
  /**
   * Admin benches default to Files as an additional source. Set false for a
   * constrained workflow such as Face Repair whose source kinds carry meaning.
   */
  allowAdminFiles?: boolean;
}

export function OwnedImagePicker({
  label,
  hint,
  kinds,
  value,
  onChange,
  excluded = null,
  emptyHint,
  allowAdminFiles = true,
}: OwnedImagePickerProps) {
  const offeredKinds = kinds ?? OWNED_IMAGE_PICKER_KINDS;
  const [kindFilter, setKindFilter] = useState("");
  const fetchKinds = kindFilter !== "" ? [kindFilter] : kinds;
  const kindKey = (fetchKinds ?? []).join(",");

  const first = useAsyncData(() => ownedImagesApi.list({ kinds: fetchKinds, limit: PAGE_SIZE }), [kindKey]);
  // Pages past the first, appended by "Load more". Kept apart from the hook's
  // own data so a silent refetch of page one cannot drop what was paged in.
  const [extra, setExtra] = useState<OwnedImageSourceRecord[]>([]);
  // A short page has been seen — the listing is complete however round its length.
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);

  // A filter change starts a new listing (render-adjust, never a setState
  // inside an effect): the pages belong to the query that fetched them.
  const [prevKindKey, setPrevKindKey] = useState(kindKey);
  if (kindKey !== prevKindKey) {
    setPrevKindKey(kindKey);
    setExtra([]);
    setExhausted(false);
    setMoreError(null);
  }

  // Merged listing, deduped by id. The compound (createdAt, id) cursor makes
  // page-boundary duplicates impossible on a stable listing; what the dedupe
  // actually guards is a refetched page one (the error state's retry) meeting
  // rows "Load more" already appended — and it keeps grid keys unique
  // whatever the server answers.
  const firstRows = first.data ?? [];
  const rows: OwnedImageSourceRecord[] = [];
  const seen = new Set<string>();
  for (const row of [...firstRows, ...extra]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      rows.push(row);
    }
  }
  // Gated on page one not currently loading: right after a filter change
  // `first.data` still holds the OLD query's page, and paging on from its last
  // row would append the new filter's rows behind a stale cursor — a mixed
  // listing no one asked for.
  const hasMore = !exhausted && !first.loading && firstRows.length === PAGE_SIZE;

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (last === undefined || last.createdAt === "" || loadingMore || first.loading) return;
    setLoadingMore(true);
    const result = await ownedImagesApi.list({
      kinds: fetchKinds,
      limit: PAGE_SIZE,
      before: last.createdAt,
      beforeId: last.id,
    });
    setLoadingMore(false);
    if (!result.ok) {
      setMoreError(result.error);
      return;
    }
    setMoreError(null);
    setExtra((previous) => [...previous, ...result.data]);
    if (result.data.length < PAGE_SIZE) setExhausted(true);
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        <div className="flex flex-col gap-2">
          {allowAdminFiles ? (
            <AdminFilesImageSource
              onImported={(imageId) => {
                onChange(imageId);
                first.reload({ silent: true });
              }}
            />
          ) : null}
          {offeredKinds.length > 1 ? (
            <Select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="w-56"
              aria-label={`Filter ${label} by kind`}
            >
              <option value="">All kinds</option>
              {offeredKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {ownedImageKindLabel(kind)}
                </option>
              ))}
            </Select>
          ) : null}
          {first.error !== null && rows.length === 0 ? (
            <ErrorState error={first.error} onRetry={() => first.reload()} />
          ) : first.loading && rows.length === 0 ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <ImageChoiceGrid
              choices={rows.map((row) => {
                const exclusionReason = excluded !== null && row.id === excluded.imageId ? excluded.reason : null;
                return {
                  imageId: row.id,
                  label: ownedImageKindLabel(row.kind),
                  // The reason takes the detail line's place — a tile that cannot
                  // be picked has one thing worth saying about it.
                  detail:
                    exclusionReason ??
                    (row.prompt || (row.createdAt !== "" ? new Date(row.createdAt).toLocaleDateString() : null)),
                  disabled: exclusionReason !== null,
                };
              })}
              value={value}
              onChange={(imageId) => {
                if (imageId === value) {
                  onChange(null);
                  return;
                }
                onChange(imageId, rows.find((row) => row.id === imageId));
              }}
              emptyHint={emptyHint ?? "No ready images of this kind yet."}
            />
          )}
        </div>
      </Field>
      {moreError !== null ? (
        <p className="text-xs text-danger-300" role="alert">
          {`Couldn’t load more images — ${moreError.message}`}
        </p>
      ) : null}
      {hasMore ? (
        <div>
          <Button size="sm" busy={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
