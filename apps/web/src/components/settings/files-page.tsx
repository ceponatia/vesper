"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { adminFilesApi, meApi, type AdminFileEntry } from "@/lib/client/api";
import { useAsyncData } from "@/components/hooks/use-async";
import { PageContainer } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import type { MediaPreviewKind } from "@/lib/media-preview";
import {
  batchUploadLabel,
  conflictMessage,
  deleteConfirmTitle,
  deleteResultToast,
  formatBytes,
  formatDate,
  moveResultToast,
} from "./files-page-copy";
import { previewKindForEntry } from "./files-page-preview";
import {
  ADMIN_FILES_DRAG_TYPE,
  breadcrumbSegments,
  dragSourcePaths,
  hasFolder,
  isAllSelected,
  isBlockedDestination,
  isSelectionPartial,
  joinPath,
  parentPathFor,
  parseDragPayload,
  toggleAllSelection,
  toggleSelected,
  visibleSelection,
} from "./files-page-selection";
import { buildUploadPlan, type FileSystemEntryLike, type UploadPlan } from "./files-page-upload-plan";

/**
 * `/settings/files` (docs/admin-files.md): an owner-admin-only temporary file
 * share. This page owns multi-select, bulk delete/move, drag-and-drop upload
 * (including whole dropped folders), drag-onto-folder move, and every dialog
 * on the page — no native browser confirm or prompt dialog appears below.
 *
 * The pure selection math, display copy, and dropped-directory walk live in
 * the sibling `files-page-*.ts` modules beside their own `.test.ts` files:
 * Vitest here runs in `node` and cannot mount this component, so that is the
 * only coverage available for any of it (the `image-lab-copy.ts` precedent).
 */

interface UploadState {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  loaded: number;
  total: number;
}

interface PendingDeletePreview {
  files: number;
  folders: number;
  bytes: number;
  truncated: boolean;
}

interface PendingDelete {
  paths: string[];
  /** Whether the selection actually contains a folder — sent as `recursive` only then. */
  recursive: boolean;
  preview: PendingDeletePreview;
}

type ConflictChoice = "replace" | "skip" | "replaceAll";

interface PendingConflict {
  /** The colliding file's path relative to the drop/pick root (its name alone for a flat pick). */
  relativePath: string;
  resolve: (choice: ConflictChoice) => void;
}

/** The file currently open in the shared lightbox, and which element plays it. */
interface OpenFilePreview {
  path: string;
  name: string;
  media: MediaPreviewKind;
}

export function FilesPage() {
  const me = useAsyncData(() => meApi.get(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const [pathValue, setPathValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const directory = useAsyncData(() => adminFilesApi.list(pathValue), [pathValue]);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<AdminFileEntry | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [movePaths, setMovePaths] = useState<string[]>([]);
  const [movingToParent, setMovingToParent] = useState(false);
  const [previewPaths, setPreviewPaths] = useState<string[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [openPreview, setOpenPreview] = useState<OpenFilePreview | null>(null);

  // Desktop-drop overlay: an enter/leave depth counter so crossing a child
  // element's own boundary (every row is one) cannot flicker the overlay off
  // mid-drag — only reaching zero nested "entered" elements means "left".
  const dragDepthRef = useRef(0);
  const [showDropOverlay, setShowDropOverlay] = useState(false);
  // Same-tab record of what a row's own drag is carrying, used only for the
  // hover highlight. The drop handlers below re-derive the authoritative list
  // from `dataTransfer` itself, which also works for a drag that began in
  // another tab (where this would stay empty).
  const [dragOverTargetPath, setDragOverTargetPath] = useState<string | null>(null);

  const isAdmin = me.data?.role === "admin";
  const entries = directory.data?.entries ?? [];
  const visibleError = actionError ?? directory.error?.message ?? me.error?.message ?? null;

  const breadcrumbs = useMemo(() => breadcrumbSegments(pathValue), [pathValue]);
  const parentPath = parentPathFor(pathValue);
  const selectedVisible = visibleSelection(entries, selected);
  const allSelected = isAllSelected(entries, selected);
  const partialSelected = isSelectionPartial(entries, selected);

  const navigate = (target: string) => {
    setActionError(null);
    setSelected(new Set());
    setOpenPreview(null);
    setPathValue(target);
  };

  const toggleRow = (path: string) => setSelected((previous) => toggleSelected(previous, path));
  const toggleAllRows = () => setSelected((previous) => toggleAllSelection(entries, previous));

  // --- Create / rename ------------------------------------------------------

  const createFolder = async (name: string): Promise<boolean> => {
    if (name.trim() === "") return false;
    setActionError(null);
    const result = await adminFilesApi.createFolder(pathValue, name.trim());
    if (!result.ok) {
      setActionError(result.error.message);
      return false;
    }
    directory.reload();
    return true;
  };

  const renameEntry = async (entry: AdminFileEntry, name: string): Promise<boolean> => {
    if (name.trim() === "" || name.trim() === entry.name) return false;
    setActionError(null);
    const result = await adminFilesApi.rename(entry.path, name.trim());
    if (!result.ok) {
      setActionError(result.error.message);
      return false;
    }
    directory.reload();
    return true;
  };

  // --- Delete: preview -> ConfirmDialog -> deleteMany ------------------------
  // Every delete, single row or bulk, goes through this one door
  // (`deleteMany` with one path for a row) so the one-row case cannot drift
  // from the multi-row one.

  const askDelete = async (paths: string[]) => {
    if (paths.length === 0) return;
    setActionError(null);
    setPreviewPaths(paths);
    const recursive = hasFolder(entries.filter((entry) => paths.includes(entry.path)));
    const result = await adminFilesApi.deletePreview(paths);
    setPreviewPaths(null);
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setPendingDelete({ paths, recursive, preview: result.data });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const result = await adminFilesApi.deleteMany(pendingDelete.paths, pendingDelete.recursive);
    setDeleting(false);
    if (!result.ok) {
      toast.push({ title: "Delete failed", description: result.error.message, tone: "error" });
      return;
    }
    setPendingDelete(null);
    setSelected(new Set());
    toast.push(deleteResultToast(result.data.deleted, result.data.failures));
    directory.reload();
  };

  // --- Move: picker, drag-onto-folder, and "Move to parent" ------------------

  const performMove = async (paths: string[], destination: string): Promise<boolean> => {
    setActionError(null);
    const result = await adminFilesApi.move(paths, destination);
    if (!result.ok) {
      toast.push({ title: "Move failed", description: result.error.message, tone: "error" });
      return false;
    }
    setSelected(new Set());
    toast.push(moveResultToast(result.data.moved, result.data.failures));
    directory.reload();
    return true;
  };

  const askMove = (paths: string[]) => {
    if (paths.length === 0) return;
    setMovePaths(paths);
    setMoveOpen(true);
  };

  const moveSelectedToParent = async () => {
    if (selectedVisible.length === 0) return;
    setMovingToParent(true);
    await performMove(
      selectedVisible.map((entry) => entry.path),
      parentPath,
    );
    setMovingToParent(false);
  };

  /** Drop-target handlers shared by every internal-move surface: a folder row, a breadcrumb, and "Up one folder". */
  function dropTargetHandlers(destination: string) {
    return {
      onDragEnter: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return;
        event.preventDefault();
        setDragOverTargetPath(destination);
      },
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return;
        event.preventDefault();
      },
      onDragLeave: () => setDragOverTargetPath((current) => (current === destination ? null : current)),
      onDrop: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation(); // claimed here so the table's own (desktop-upload) onDrop does not also fire
        setDragOverTargetPath(null);
        const paths = parseDragPayload(event.dataTransfer.getData(ADMIN_FILES_DRAG_TYPE));
        if (paths.length > 0 && !isBlockedDestination(destination, paths)) void performMove(paths, destination);
      },
    };
  }

  const onRowDragStart = (event: DragEvent, entryPath: string) => {
    const paths = dragSourcePaths(selected, entryPath);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(ADMIN_FILES_DRAG_TYPE, JSON.stringify(paths));
  };
  const onRowDragEnd = () => setDragOverTargetPath(null);

  // --- Upload: OS picker and desktop drag-and-drop ---------------------------

  const uploadOne = (path: string, file: File, overwrite: boolean, fileIndex: number, fileCount: number) =>
    adminFilesApi.upload({
      path,
      file,
      overwrite,
      onProgress: ({ loaded, total }) => setUpload({ fileName: file.name, fileIndex, fileCount, loaded, total }),
    });

  const askConflict = (relativePath: string): Promise<ConflictChoice> =>
    new Promise((resolve) => setConflict({ relativePath, resolve }));

  /**
   * Runs one upload batch — a flat OS-picker selection or a full dropped-tree
   * plan, uniformly. Folders are created parent-first, then files upload in
   * order; a same-name collision pauses the batch for the conflict dialog
   * rather than a blocking native dialog, and "Replace all" answers every
   * later collision in this same batch without asking again.
   */
  const runUploadPlan = async (plan: UploadPlan) => {
    setActionError(null);
    let replaceAll = false;
    try {
      for (const folderRelPath of plan.folders) {
        const parent = joinPath(pathValue, parentPathFor(folderRelPath));
        const name = folderRelPath.split("/").pop() ?? folderRelPath;
        const result = await adminFilesApi.createFolder(parent, name);
        // An existing destination folder is fine (owner ruling); any other
        // failure stops the batch rather than uploading into a tree that
        // never fully materialized.
        if (!result.ok && result.error.code !== "already_exists") {
          setActionError(`${folderRelPath}: ${result.error.message}`);
          return;
        }
      }

      for (let index = 0; index < plan.files.length; index += 1) {
        const item = plan.files[index];
        if (item === undefined) continue;
        const { relativePath, file } = item;
        const destPath = joinPath(pathValue, parentPathFor(relativePath));
        const fileIndex = index + 1;
        setUpload({ fileName: file.name, fileIndex, fileCount: plan.files.length, loaded: 0, total: file.size });

        let result = await uploadOne(destPath, file, false, fileIndex, plan.files.length);
        if (!result.ok && result.error.status === 409 && result.error.code === "already_exists") {
          const choice = replaceAll ? "replace" : await askConflict(relativePath);
          if (choice === "replaceAll") replaceAll = true;
          if (choice === "skip") continue;
          result = await uploadOne(destPath, file, true, fileIndex, plan.files.length);
        }
        if (!result.ok) {
          setActionError(`${relativePath}: ${result.error.message}`);
          break; // stop the batch; earlier successes stay visible after the reload below
        }
      }
    } finally {
      setUpload(null);
      directory.reload();
    }
  };

  const onPickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const plan: UploadPlan = { folders: [], files: Array.from(files).map((file) => ({ relativePath: file.name, file })) };
    void runUploadPlan(plan).finally(() => {
      if (inputRef.current) inputRef.current.value = "";
    });
  };

  /** `webkitGetAsEntry()` per dropped item, cast to the walk's minimal structural interface. */
  function collectDropEntries(dataTransfer: DataTransfer): FileSystemEntryLike[] {
    const collected: FileSystemEntryLike[] = [];
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry) collected.push(entry as unknown as FileSystemEntryLike);
    }
    return collected;
  }

  const handleExternalDrop = async (dataTransfer: DataTransfer) => {
    const dropped = collectDropEntries(dataTransfer);
    const plan: UploadPlan =
      dropped.length > 0
        ? await buildUploadPlan(dropped)
        : { folders: [], files: Array.from(dataTransfer.files).map((file) => ({ relativePath: file.name, file })) };
    if (plan.files.length === 0 && plan.folders.length === 0) return;
    await runUploadPlan(plan);
  };

  const onTableDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return; // an internal drag; a row/breadcrumb handles it
    event.preventDefault();
    dragDepthRef.current += 1;
    setShowDropOverlay(true);
  };
  const onTableDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return;
    event.preventDefault(); // required for the drop below to fire at all
  };
  const onTableDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setShowDropOverlay(false);
  };
  const onTableDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(ADMIN_FILES_DRAG_TYPE)) return; // an internal drag with nowhere valid to land here: no-op
    event.preventDefault();
    dragDepthRef.current = 0;
    setShowDropOverlay(false);
    void handleExternalDrop(event.dataTransfer);
  };

  if (me.loading && !me.data) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-40" />
      </PageContainer>
    );
  }

  if (!isAdmin) {
    return (
      <PageContainer>
        <h1 className="prose-display text-2xl">Files</h1>
        <p className="mt-2 text-sm text-paper-400">This page is only available to administrators.</p>
      </PageContainer>
    );
  }

  const uploadPercent = upload && upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;

  return (
    <PageContainer>
      <div className="mx-auto w-full max-w-5xl py-6 sm:py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="prose-display text-2xl text-paper-100">Files</h1>
            <p className="mt-1 max-w-2xl text-sm text-paper-400">
              Temporary owner-admin file sharing. Files live on Vesper&apos;s persistent Fly volume and are not part of the game data model.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setNewFolderOpen(true)}>New folder</Button>
            <Button variant="primary" onClick={() => inputRef.current?.click()} disabled={upload !== null}>
              Upload files
            </Button>
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              multiple
              onChange={(event) => onPickFiles(event.currentTarget.files)}
            />
          </div>
        </div>

        <div className="mt-6 flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-sm">
          <button
            type="button"
            className={cx(
              "rounded px-2 py-1 text-paper-300 transition-colors hover:bg-ink-700 hover:text-paper-100",
              dragOverTargetPath === "" && "bg-accent-500/10",
            )}
            onClick={() => navigate("")}
            {...dropTargetHandlers("")}
          >
            Files
          </button>
          {breadcrumbs.map((crumb) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <span className="text-paper-600">/</span>
              <button
                type="button"
                className={cx(
                  "max-w-48 truncate rounded px-2 py-1 text-paper-300 transition-colors hover:bg-ink-700 hover:text-paper-100",
                  dragOverTargetPath === crumb.path && "bg-accent-500/10",
                )}
                onClick={() => navigate(crumb.path)}
                {...dropTargetHandlers(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {pathValue ? (
          <div className="mt-2">
            <Button
              size="sm"
              variant="quiet"
              onClick={() => navigate(parentPath)}
              className={dragOverTargetPath === parentPath ? "bg-accent-500/10" : undefined}
              {...dropTargetHandlers(parentPath)}
            >
              ← Up one folder
            </Button>
          </div>
        ) : null}

        {upload ? (
          <div className="mt-4 rounded-md border border-ink-600 bg-ink-800 p-3 text-sm text-paper-300" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{batchUploadLabel(upload.fileIndex, upload.fileCount, upload.fileName)}</span>
              <span className="shrink-0 tabular-nums">{uploadPercent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-600">
              <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${uploadPercent}%` }} />
            </div>
          </div>
        ) : null}

        {visibleError ? (
          <div className="mt-4 rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-danger-300" role="alert">
            {visibleError}
          </div>
        ) : null}

        {selectedVisible.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ink-600 bg-ink-800 px-3 py-2">
            <span className="text-xs tabular-nums text-paper-500">{selectedVisible.length} selected</span>
            <Button
              size="sm"
              variant="danger"
              busy={previewPaths !== null}
              onClick={() => void askDelete(selectedVisible.map((entry) => entry.path))}
            >
              Delete selected
            </Button>
            <Button size="sm" onClick={() => askMove(selectedVisible.map((entry) => entry.path))}>
              Move to…
            </Button>
            {pathValue ? (
              <Button size="sm" variant="quiet" busy={movingToParent} onClick={() => void moveSelectedToParent()}>
                Move to parent
              </Button>
            ) : null}
          </div>
        ) : null}

        <div
          className={cx(
            "mt-4 overflow-hidden rounded-card border transition-colors",
            showDropOverlay ? "border-dashed border-accent-500 bg-accent-500/5" : "border-ink-600 bg-ink-800",
          )}
          onDragEnter={onTableDragEnter}
          onDragOver={onTableDragOver}
          onDragLeave={onTableDragLeave}
          onDrop={onTableDrop}
        >
          <div className="hidden grid-cols-[auto_minmax(0,1fr)_8rem_12rem_auto] items-center gap-3 border-b border-ink-600 px-4 py-2 text-xs font-medium uppercase tracking-wide text-paper-500 sm:grid">
            <label className="touch-target flex items-center p-1">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = partialSelected;
                }}
                onChange={toggleAllRows}
                disabled={entries.length === 0}
                className="accent-accent-500"
                aria-label="Select every row shown"
              />
            </label>
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span className="text-right">Actions</span>
          </div>

          {directory.loading ? (
            <div className="p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-paper-500">This folder is empty.</div>
          ) : (
            entries.map((entry) => {
              const isSelected = selected.has(entry.path);
              const isFolder = entry.kind === "folder";
              const mediaKind = previewKindForEntry(entry);
              const isDropTarget = isFolder && dragOverTargetPath === entry.path;
              const rowBusy = previewPaths?.includes(entry.path) ?? false;
              return (
                <div
                  key={entry.path}
                  draggable
                  onDragStart={(event) => onRowDragStart(event, entry.path)}
                  onDragEnd={onRowDragEnd}
                  {...(isFolder ? dropTargetHandlers(entry.path) : {})}
                  className={cx(
                    "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-ink-700 px-4 py-3 transition-colors last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_8rem_12rem_auto]",
                    isDropTarget && "bg-accent-500/10",
                  )}
                >
                  {/* The tick box is a sibling of the name control, never nested
                      inside it: the folder name is a <button> and the file name
                      is an <a>, and an <input> inside either is invalid markup
                      that would fire the wrong action on click. */}
                  <label className="touch-target flex shrink-0 cursor-pointer items-center p-1">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRow(entry.path)}
                      className="accent-accent-500"
                      aria-label={`Select ${entry.name}`}
                    />
                  </label>
                  <div className="min-w-0">
                    {isFolder ? (
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-sm font-medium text-paper-100 hover:text-accent-300"
                        onClick={() => navigate(entry.path)}
                      >
                        {entry.name}/
                      </button>
                    ) : mediaKind ? (
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-sm font-medium text-paper-100 hover:text-accent-300"
                        onClick={() => setOpenPreview({ path: entry.path, name: entry.name, media: mediaKind })}
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <a
                        className="block truncate text-sm font-medium text-paper-100 hover:text-accent-300"
                        href={adminFilesApi.downloadUrl(entry.path)}
                        draggable={false}
                      >
                        {entry.name}
                      </a>
                    )}
                    <div className="mt-1 text-xs text-paper-500 sm:hidden">
                      {formatBytes(entry.size)} · {formatDate(entry.modifiedAt)}
                    </div>
                  </div>
                  <div className="hidden text-xs text-paper-400 sm:block">{formatBytes(entry.size)}</div>
                  <div className="hidden text-xs text-paper-400 sm:block">{formatDate(entry.modifiedAt)}</div>
                  <div className="flex items-center justify-end gap-1">
                    {entry.kind === "file" ? (
                      <a
                        className="touch-target inline-flex h-7 items-center rounded-md px-2.5 text-xs text-paper-400 transition-colors hover:bg-ink-700 hover:text-paper-100"
                        href={adminFilesApi.downloadUrl(entry.path)}
                        draggable={false}
                      >
                        Download
                      </a>
                    ) : null}
                    <Button size="sm" variant="quiet" onClick={() => setRenameTarget(entry)}>
                      Rename
                    </Button>
                    <Button size="sm" variant="danger" busy={rowBusy} onClick={() => void askDelete([entry.path])}>
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {openPreview ? (
          <ImageLightbox
            imageId={null}
            open
            viewKey={openPreview.path}
            src={adminFilesApi.previewUrl(openPreview.path)}
            media={openPreview.media}
            alt={openPreview.name}
            caption={openPreview.name}
            onClose={() => setOpenPreview(null)}
          />
        ) : null}

        {newFolderOpen ? <NewFolderDialog onClose={() => setNewFolderOpen(false)} onCreate={createFolder} /> : null}

        {renameTarget ? (
          <RenameEntryDialog
            entry={renameTarget}
            onClose={() => setRenameTarget(null)}
            onRename={(name) => renameEntry(renameTarget, name)}
          />
        ) : null}

        {moveOpen ? (
          <MoveToDialog sourcePaths={movePaths} onClose={() => setMoveOpen(false)} onMove={(destination) => performMove(movePaths, destination)} />
        ) : null}

        {conflict ? (
          <UploadConflictDialog
            relativePath={conflict.relativePath}
            onSkip={() => {
              conflict.resolve("skip");
              setConflict(null);
            }}
            onReplace={() => {
              conflict.resolve("replace");
              setConflict(null);
            }}
            onReplaceAll={() => {
              conflict.resolve("replaceAll");
              setConflict(null);
            }}
          />
        ) : null}

        <ConfirmDialog
          open={pendingDelete !== null}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
          title={pendingDelete ? deleteConfirmTitle(pendingDelete.preview) : ""}
          busy={deleting}
        >
          {pendingDelete ? (
            <>
              <p>This cannot be undone.</p>
              {pendingDelete.preview.bytes > 0 ? <p className="mt-1">About {formatBytes(pendingDelete.preview.bytes)} total.</p> : null}
            </>
          ) : null}
        </ConfirmDialog>
      </div>
    </PageContainer>
  );
}

/** Mounts fresh per open, so `useState` seeds from an empty name with no effect (the `RenameDialog` shape). */
function NewFolderDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const ok = await onCreate(name.trim());
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="New folder"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" busy={saving} disabled={name.trim() === ""} onClick={() => void save()}>
            Create
          </Button>
        </>
      }
    >
      <Input value={name} maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="Folder name" autoFocus />
    </Dialog>
  );
}

/** Mounts fresh per open, so `useState` seeds from the entry's current name with no effect. */
function RenameEntryDialog({
  entry,
  onClose,
  onRename,
}: {
  entry: AdminFileEntry;
  onClose: () => void;
  onRename: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(entry.name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const ok = await onRename(name.trim());
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title={`Rename ${entry.kind === "folder" ? "folder" : "file"}`}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={name.trim() === "" || name.trim() === entry.name}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <Input value={name} maxLength={255} onChange={(event) => setName(event.target.value)} autoFocus />
    </Dialog>
  );
}

/**
 * The accessible half of the move feature (docs: drag-onto-folder is a
 * shortcut, this picker is not): navigate the tree from the Files root with
 * the existing `list` call, and confirm. Folders in the current selection can
 * never be entered or picked, since a folder must not move into itself or
 * into its own descendant.
 */
function MoveToDialog({
  sourcePaths,
  onClose,
  onMove,
}: {
  sourcePaths: string[];
  onClose: () => void;
  onMove: (destination: string) => Promise<boolean>;
}) {
  const [browsePath, setBrowsePath] = useState("");
  const listing = useAsyncData(() => adminFilesApi.list(browsePath), [browsePath]);
  const [moving, setMoving] = useState(false);

  const folders = (listing.data?.entries ?? []).filter((entry) => entry.kind === "folder");
  const crumbs = breadcrumbSegments(browsePath);
  const blocked = isBlockedDestination(browsePath, sourcePaths);

  const confirm = async () => {
    setMoving(true);
    const ok = await onMove(browsePath);
    setMoving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!moving) onClose();
      }}
      title="Move to…"
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button variant="primary" busy={moving} disabled={blocked} onClick={() => void confirm()}>
            Move here
          </Button>
        </>
      }
    >
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-ink-600 bg-ink-900/40 px-2 py-1 text-sm">
        <button type="button" className="rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100" onClick={() => setBrowsePath("")}>
          Files
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="flex items-center gap-1">
            <span className="text-paper-600">/</span>
            <button
              type="button"
              className="max-w-40 truncate rounded px-2 py-1 text-paper-300 hover:bg-ink-700 hover:text-paper-100"
              onClick={() => setBrowsePath(crumb.path)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <p className="mt-2 text-xs text-paper-500">
        Destination: <span className="text-paper-300">{browsePath === "" ? "Files (root)" : browsePath}</span>
      </p>

      {listing.error ? (
        <p className="mt-2 text-xs text-danger-300" role="alert">
          {listing.error.message}
        </p>
      ) : null}

      <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-ink-600">
        {listing.loading ? (
          <div className="p-4">
            <Skeleton className="h-8 w-full" />
          </div>
        ) : folders.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-paper-500">No subfolders here.</div>
        ) : (
          folders.map((folder) => {
            const folderBlocked = isBlockedDestination(folder.path, sourcePaths);
            return (
              <button
                key={folder.path}
                type="button"
                disabled={folderBlocked}
                onClick={() => setBrowsePath(folder.path)}
                className="flex w-full items-center justify-between border-b border-ink-700 px-3 py-2 text-left text-sm text-paper-200 last:border-b-0 hover:bg-ink-700 disabled:cursor-not-allowed disabled:text-paper-600 disabled:hover:bg-transparent"
              >
                <span className="truncate">{folder.name}/</span>
                {folderBlocked ? <span className="text-xs text-paper-600">selected</span> : null}
              </button>
            );
          })
        )}
      </div>
    </Dialog>
  );
}

/** The replace-on-upload conflict: Replace / Skip / Replace all, resolving the promise `askConflict` handed out. */
function UploadConflictDialog({
  relativePath,
  onSkip,
  onReplace,
  onReplaceAll,
}: {
  relativePath: string;
  onSkip: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onSkip}
      title="File already exists"
      footer={
        <>
          <Button onClick={onSkip}>Skip</Button>
          <Button onClick={onReplaceAll}>Replace all</Button>
          <Button variant="primary" onClick={onReplace}>
            Replace
          </Button>
        </>
      }
    >
      <p>{conflictMessage(relativePath)} Replace it, skip it, or replace every later collision in this upload too.</p>
    </Dialog>
  );
}
