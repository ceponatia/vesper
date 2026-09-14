import type { AdminFileFailure } from "@/lib/client/api/admin-files";

/**
 * `files-page.tsx`'s display copy, kept pure and beside its `.test.ts`
 * (the `image-lab-copy.ts` precedent for UI Vitest cannot mount): byte/date
 * formatting, the delete confirmation's counted title, and the toast wording
 * for the two partial-success batch operations.
 */

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Folder";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && value >= 1024) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "KB";
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export interface DeletePreviewCounts {
  files: number;
  folders: number;
  truncated: boolean;
}

/**
 * The delete confirmation's title, worded from `delete_preview`'s counts —
 * never from how many rows were ticked, since one ticked folder can hold an
 * arbitrarily large tree. `truncated` names only the files count with a "+":
 * counting stopped early, so a folder breakdown at that point would be a
 * guess dressed as a fact.
 */
export function deleteConfirmTitle(preview: DeletePreviewCounts): string {
  if (preview.truncated) return `Delete ${preview.files.toLocaleString()}+ files?`;

  const parts: string[] = [];
  if (preview.folders > 0) parts.push(pluralize(preview.folders, "folder"));
  if (preview.files > 0 || preview.folders === 0) parts.push(pluralize(preview.files, "file"));
  return `Delete ${parts.join(" and ")}?`;
}

export interface ResultToast {
  title: string;
  description?: string;
  tone: "success" | "error";
}

/** The first failure of a partial-success batch, plus how many more there were. */
function firstFailureDetail(failures: readonly AdminFileFailure[]): string | undefined {
  const first = failures[0];
  if (first === undefined) return undefined;
  const suffix = failures.length > 1 ? ` (+${String(failures.length - 1)} more)` : "";
  return `${first.path}: ${first.message}${suffix}`;
}

/**
 * Toast for a `delete_many` response. `deleted` is one combined count with no
 * files/folders breakdown (unlike the preview), so the noun is the generic
 * "item" rather than echoing the confirmation's more specific wording — a
 * breakdown recomputed here could go stale the moment any path fails.
 */
export function deleteResultToast(deleted: number, failures: readonly AdminFileFailure[]): ResultToast {
  const detail = firstFailureDetail(failures);
  if (deleted === 0 && failures.length > 0) return { title: "Delete failed", description: detail, tone: "error" };
  const title = `Deleted ${pluralize(deleted, "item")}`;
  return detail ? { title, description: detail, tone: "error" } : { title, tone: "success" };
}

/** Toast for a `move` response — same shape as `deleteResultToast`, for the same reason. */
export function moveResultToast(moved: number, failures: readonly AdminFileFailure[]): ResultToast {
  const detail = firstFailureDetail(failures);
  if (moved === 0 && failures.length > 0) return { title: "Move failed", description: detail, tone: "error" };
  const title = `Moved ${pluralize(moved, "item")}`;
  return detail ? { title, description: detail, tone: "error" } : { title, tone: "success" };
}

/** The upload readout for one file within a batch: "Uploading 7 of 41: photo.png". */
export function batchUploadLabel(fileIndex: number, fileCount: number, fileName: string): string {
  return `Uploading ${String(fileIndex)} of ${String(fileCount)}: ${fileName}`;
}

/** The replace-on-upload conflict prompt's body copy for one file (identified by its relative path). */
export function conflictMessage(relativePath: string): string {
  return `“${relativePath}” already exists in this folder.`;
}
