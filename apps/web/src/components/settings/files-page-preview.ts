import type { AdminFileEntry } from "@/lib/client/api";
import { mediaPreviewType, type MediaPreviewKind } from "@/lib/media-preview";

/**
 * Pure page logic for `files-page.tsx`'s inline preview (#595): whether a row
 * opens in the shared `ImageLightbox` on click instead of navigating to the
 * download route, and which media element plays it. Kept beside its
 * `.test.ts` for the same reason as this file's siblings — Vitest here runs
 * in `node` and cannot mount the component.
 *
 * `mediaPreviewType` reads only the file name, so on its own it cannot rule
 * out a folder — an admin can name a folder `movie.mp4`. Only a `file` row
 * whose name the allowlist recognizes is previewable; a folder is never
 * previewable regardless of what it is named.
 */
export function previewKindForEntry(entry: AdminFileEntry): MediaPreviewKind | null {
  if (entry.kind !== "file") return null;
  return mediaPreviewType(entry.name)?.kind ?? null;
}
