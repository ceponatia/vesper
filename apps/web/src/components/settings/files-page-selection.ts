import type { AdminFileEntry } from "@/lib/client/api";

/**
 * Pure page logic for `files-page.tsx`: the selection set, path/breadcrumb
 * math, and the drag-and-drop-onto-folder rules. Kept dependency-free (aside
 * from the entry shape) so it can be driven directly from `.test.ts` — Vitest
 * here runs in `node` and cannot mount the component itself.
 */

/**
 * The page's own drag payload marker. Presence in `dataTransfer.types` is how
 * a row-to-folder drag is told apart from a desktop file/folder drop — never a
 * React state flag, which would misjudge a drag that began in another browser
 * tab as an external one (or the reverse).
 */
export const ADMIN_FILES_DRAG_TYPE = "application/vnd.vesper.admin-files-paths+json";

/** True when `candidate` is `ancestor` itself, or nested under it (`ancestor/…`). */
export function isPathWithin(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

/** The immediate parent of a relative path; `""` (the Files root) for a root-level entry. */
export function parentPathFor(pathValue: string): string {
  const segments = pathValue.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

/**
 * Appends one path segment under `base`; either side may be `""` (the Files root).
 *
 * The empty `segment` is the case the upload path actually hits: a plan entry at
 * the top of a dropped selection has `parentPathFor(...) === ""`, and joining
 * that onto the current folder once produced `"sub/"` — a trailing separator the
 * server validates segment-by-segment and refuses as `invalid_path`, so every
 * upload below the Files root failed.
 */
export function joinPath(base: string, segment: string): string {
  if (segment === "") return base;
  return base ? `${base}/${segment}` : segment;
}

/** One `{ name, path }` breadcrumb per segment of a relative folder path. */
export function breadcrumbSegments(pathValue: string): { name: string; path: string }[] {
  const segments = pathValue.split("/").filter(Boolean);
  return segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
}

/** Toggles one path in a selection set, returning a new set — never mutates `selected`. */
export function toggleSelected(selected: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (!next.delete(path)) next.add(path);
  return next;
}

/**
 * Selection read back through the rows actually on screen, never straight out
 * of the set: a reload can retire a row while its path is still ticked, and a
 * count or a bulk action built on that path would be about a row nobody can
 * see anymore.
 */
export function visibleSelection(entries: readonly AdminFileEntry[], selected: ReadonlySet<string>): AdminFileEntry[] {
  return entries.filter((entry) => selected.has(entry.path));
}

/** Select-all's own checked condition: every visible row ticked, and at least one exists. */
export function isAllSelected(entries: readonly AdminFileEntry[], selected: ReadonlySet<string>): boolean {
  return entries.length > 0 && visibleSelection(entries, selected).length === entries.length;
}

/** Select-all's own indeterminate condition: some, but not all, visible rows ticked. */
export function isSelectionPartial(entries: readonly AdminFileEntry[], selected: ReadonlySet<string>): boolean {
  const count = visibleSelection(entries, selected).length;
  return count > 0 && count < entries.length;
}

/** Select-all's toggle: clears a full (or partial) selection, otherwise selects every visible row. */
export function toggleAllSelection(entries: readonly AdminFileEntry[], selected: ReadonlySet<string>): ReadonlySet<string> {
  return isAllSelected(entries, selected) ? new Set() : new Set(entries.map((entry) => entry.path));
}

/** Whether any entry in the list is a folder — decides whether a delete must ask for `recursive`. */
export function hasFolder(entries: readonly AdminFileEntry[]): boolean {
  return entries.some((entry) => entry.kind === "folder");
}

/** A drag starting on an unselected row acts on that row alone, never the wider selection. */
export function dragSourcePaths(selected: ReadonlySet<string>, rowPath: string): string[] {
  return selected.has(rowPath) ? [...selected] : [rowPath];
}

/**
 * Whether a drag in flight has nowhere to land on `destination`.
 *
 * An empty `paths` does NOT mean "block": a same-tab drag always seeds at
 * least the dragged row (`dragSourcePaths` never returns an empty array), so
 * empty here can only mean a drag that began in another browser tab —
 * `dataTransfer` carries this page's custom MIME type, but `getData` stays
 * unreadable until the drop itself. Refusing it would skip `preventDefault`
 * on every dragover, and the browser would then never deliver the drop that
 * could parse the authoritative payload out of `dataTransfer`. An unknown
 * payload must read as "allow and let the drop decide" — `onDrop` already
 * re-validates with {@link isBlockedDestination} once the real paths are
 * readable, so nothing legitimate is left unchecked.
 */
export function isBlockedDragDestination(destination: string, paths: readonly string[]): boolean {
  return paths.length > 0 && isBlockedDestination(destination, paths);
}

/**
 * True when `candidatePath` can never be a valid move destination for
 * `sourcePaths` — it equals one of them, or is nested under one of them. A
 * move is a containment problem: a folder must not move into itself or into
 * its own descendant, and this guards both the "Move to…" picker's disabled
 * rows and the drag-onto-folder highlight/drop.
 */
export function isBlockedDestination(candidatePath: string, sourcePaths: readonly string[]): boolean {
  if (sourcePaths.some((source) => isPathWithin(candidatePath, source))) return true;
  // A destination every source already sits in is a no-op the server can only
  // answer with `already_in_destination`, which would surface as an error toast
  // for a gesture that asked for nothing. A mixed selection is still a real
  // move, so only the all-of-them case is blocked.
  return sourcePaths.every((source) => parentPathFor(source) === candidatePath);
}

/**
 * Reads the page's own drag payload back out of a drop event's `DataTransfer`.
 * Returns `[]` for anything that isn't the array-of-strings shape this page
 * writes — a defensive parse at a trust boundary, per `docs/resilience.md`,
 * rather than a thrown exception on a malformed or foreign payload.
 */
export function parseDragPayload(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
  } catch {
    return [];
  }
}
