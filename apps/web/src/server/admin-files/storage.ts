import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

const FILES_DIRECTORY = "admin-files";
const UPLOAD_TEMP_DIRECTORY = ".admin-files-upload-tmp";
const STALE_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The current Fly deployment is one Next process over one attached volume. Keep
 * destination-changing filesystem mutations serialized inside that process so
 * the check-before-rename paths cannot race another Files request into silently
 * replacing a just-created destination. Upload streaming itself stays outside
 * this lock; only its short publish step is serialized.
 */
let mutationTail: Promise<void> = Promise.resolve();
const activeUploadTemps = new Set<string>();

async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release: (() => void) | undefined;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

export type AdminFileKind = "file" | "folder";

export interface AdminFileEntry {
  name: string;
  path: string;
  kind: AdminFileKind;
  size: number | null;
  modifiedAt: string;
}

export interface AdminFileDownload {
  /** Open descriptor whose stat and bytes refer to the same inode. */
  handle: Awaited<ReturnType<typeof fs.open>>;
  name: string;
  size: number;
  modifiedAt: string;
}

/**
 * One entry's refusal inside a partial-success batch. `code` is an
 * {@link AdminFilesError} code, so a caller can branch on the same vocabulary
 * the single-entry actions answer with.
 */
export interface AdminFileFailure {
  path: string;
  code: string;
  message: string;
}

export interface AdminFilesBatchDeleteResult {
  /** What actually went, so the caller can report a truthful number. */
  deleted: number;
  failures: AdminFileFailure[];
}

export interface AdminFilesMoveResult {
  moved: number;
  /** The post-move entries, in success order. */
  entries: AdminFileEntry[];
  failures: AdminFileFailure[];
}

export interface AdminFilesDeletePreview {
  files: number;
  folders: number;
  bytes: number;
  /** The walk hit {@link DELETE_PREVIEW_MAX_ENTRIES}; the totals are a floor. */
  truncated: boolean;
}

/**
 * Ceiling on the entries one delete preview will walk. The preview exists to
 * word a confirmation, so a pathological tree must not turn a dialog into a
 * filesystem crawl — past this the caller says "more than this many" instead of
 * a number.
 */
export const DELETE_PREVIEW_MAX_ENTRIES = 10_000;

export class AdminFilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminFilesError";
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function invalidPath(message: string): never {
  throw new AdminFilesError("invalid_path", message, 400);
}

function validateName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    invalidPath("file and folder names must be a single safe path segment");
  }
}

function validateRelativePath(relativePath: string): string[] {
  if (relativePath === "") return [];
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    invalidPath("path must be relative to the Files root");
  }

  const segments = relativePath.split("/");
  for (const segment of segments) validateName(segment);
  return segments;
}

function relativePathFor(segments: readonly string[]): string {
  return segments.join("/");
}

function joinRelative(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

async function ensureDirectoryNotSymlink(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink()) {
      throw new AdminFilesError("unsafe_path", "Files storage cannot cross a symbolic link", 409);
    }
    if (!stat.isDirectory()) {
      throw new AdminFilesError("storage_unavailable", "Files storage path is not a directory", 500);
    }
  } catch (error) {
    if (error instanceof AdminFilesError) throw error;
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AdminFilesError("storage_unavailable", "Files storage path is not a safe directory", 500);
    }
  }
}

/**
 * A process exit cannot run an upload's finally block. Reclaim old invisible
 * `.part` files opportunistically on every later Files access. Active uploads
 * in this process are exempt even if their clocks are unusual; after a restart
 * that set is empty, so abandoned parts age out automatically.
 */
async function reclaimStaleUploadParts(tempRoot: string, now = Date.now()): Promise<void> {
  const staleBefore = now - STALE_UPLOAD_AGE_MS;
  const entries = await fs.readdir(tempRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith(".part")) continue;
    const absolutePath = path.join(tempRoot, entry.name);
    if (activeUploadTemps.has(absolutePath)) continue;

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (stat.mtimeMs <= staleBefore) {
      await fs.rm(absolutePath, { force: true, recursive: false });
    }
  }
}

async function storageRoots(): Promise<{ root: string; tempRoot: string }> {
  const configured = process.env.DATA_ROOT ?? path.join(process.cwd(), "data");
  const configuredDataRoot = path.resolve(configured);
  await fs.mkdir(configuredDataRoot, { recursive: true });
  const dataRoot = await fs.realpath(configuredDataRoot);

  const root = path.join(dataRoot, FILES_DIRECTORY);
  const tempRoot = path.join(dataRoot, UPLOAD_TEMP_DIRECTORY);
  await ensureDirectoryNotSymlink(root);
  await ensureDirectoryNotSymlink(tempRoot);
  const realRoot = await fs.realpath(root);
  const realTempRoot = await fs.realpath(tempRoot);
  await reclaimStaleUploadParts(realTempRoot);
  return { root: realRoot, tempRoot: realTempRoot };
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalidPath("path escapes the Files root");
  }
}

interface ResolvedManagedPath {
  root: string;
  absolutePath: string;
  segments: string[];
}

/**
 * Validate one relative path against an ALREADY-resolved root.
 *
 * A batch resolves the root once and pins it for every entry in the request, so
 * one batch cannot straddle two roots and does not pay for the staging-area
 * sweep in {@link storageRoots} once per path.
 */
async function resolveWithinRoot(root: string, relativePath: string): Promise<ResolvedManagedPath> {
  const segments = validateRelativePath(relativePath);
  const absolutePath = path.join(root, ...segments);
  assertContained(root, absolutePath);

  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new AdminFilesError("unsafe_path", "Files paths cannot cross symbolic links", 409);
      }
    } catch (error) {
      if (error instanceof AdminFilesError) throw error;
      const code = nodeErrorCode(error);
      if (code === "ENOENT") break;
      // A path whose parent component is a FILE is a caller mistake, not a
      // server fault; without this the raw ENOTDIR escapes as a 500 and, in a
      // batch, takes the whole request down with it.
      if (code === "ENOTDIR") throw new AdminFilesError("not_directory", "a path component is not a folder", 400);
      throw error;
    }
  }

  return { root, absolutePath, segments };
}

async function resolveManagedPath(relativePath: string): Promise<ResolvedManagedPath> {
  const { root } = await storageRoots();
  return resolveWithinRoot(root, relativePath);
}

/**
 * Containment for a move, compared segment-by-segment rather than by string
 * prefix. A raw `startsWith` reads `a/b` as a prefix of `a/bc` and would refuse
 * that legal move — and, in the other direction, would happily treat an
 * unrelated sibling as a descendant.
 */
function segmentsStartWith(candidate: readonly string[], prefix: readonly string[]): boolean {
  if (candidate.length < prefix.length) return false;
  return prefix.every((segment, index) => candidate[index] === segment);
}

function segmentsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && segmentsStartWith(left, right);
}

/**
 * The partial-success rule, stated once: a per-entry {@link AdminFilesError}
 * becomes a failure row and the batch carries on, while anything else is a
 * genuine bug and is rethrown to fail the whole request rather than being
 * flattened into a row the caller would read as an ordinary refusal.
 */
function toFailure(relativePath: string, error: unknown): AdminFileFailure {
  if (error instanceof AdminFilesError) {
    return { path: relativePath, code: error.code, message: error.message };
  }
  throw error;
}

async function lstatOrNull(absolutePath: string) {
  try {
    return await fs.lstat(absolutePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function entryFromStat(name: string, relativePath: string, stat: Awaited<ReturnType<typeof fs.lstat>>): AdminFileEntry {
  if (stat.isSymbolicLink()) {
    throw new AdminFilesError("unsafe_path", "Files storage contains a symbolic link", 409);
  }
  if (stat.isDirectory()) {
    return { name, path: relativePath, kind: "folder", size: null, modifiedAt: stat.mtime.toISOString() };
  }
  if (stat.isFile()) {
    return { name, path: relativePath, kind: "file", size: Number(stat.size), modifiedAt: stat.mtime.toISOString() };
  }
  throw new AdminFilesError("unsupported_entry", "Files storage contains an unsupported filesystem entry", 409);
}

export async function adminFilesRoot(): Promise<string> {
  return (await storageRoots()).root;
}

export async function listAdminFiles(relativeDirectory = ""): Promise<AdminFileEntry[]> {
  const resolved = await resolveManagedPath(relativeDirectory);
  const directoryStat = await lstatOrNull(resolved.absolutePath);
  if (directoryStat === null) throw new AdminFilesError("not_found", "folder not found", 404);
  if (!directoryStat.isDirectory()) throw new AdminFilesError("not_directory", "path is not a folder", 400);

  const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  const result: AdminFileEntry[] = [];
  for (const entry of entries) {
    const absoluteEntry = path.join(resolved.absolutePath, entry.name);
    const stat = await fs.lstat(absoluteEntry);
    const relativeEntry = joinRelative(relativeDirectory, entry.name);
    result.push(entryFromStat(entry.name, relativeEntry, stat));
  }

  result.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return result;
}

export async function createAdminFolder(relativeDirectory: string, name: string): Promise<AdminFileEntry> {
  validateName(name);
  return withMutationLock(async () => {
    const parent = await resolveManagedPath(relativeDirectory);
    const parentStat = await lstatOrNull(parent.absolutePath);
    if (parentStat === null) throw new AdminFilesError("not_found", "parent folder not found", 404);
    if (!parentStat.isDirectory()) throw new AdminFilesError("not_directory", "parent path is not a folder", 400);

    const relativeTarget = joinRelative(relativeDirectory, name);
    const target = await resolveManagedPath(relativeTarget);
    try {
      await fs.mkdir(target.absolutePath);
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
      if (nodeErrorCode(error) === "ENAMETOOLONG") throw new AdminFilesError("invalid_path", "folder name is too long for this filesystem", 400);
      throw error;
    }
    const stat = await fs.lstat(target.absolutePath);
    return entryFromStat(name, relativeTarget, stat);
  });
}

export async function renameAdminEntry(relativePath: string, name: string): Promise<AdminFileEntry> {
  validateName(name);
  return withMutationLock(async () => {
    const source = await resolveManagedPath(relativePath);
    if (source.segments.length === 0) invalidPath("the Files root cannot be renamed");

    const sourceStat = await lstatOrNull(source.absolutePath);
    if (sourceStat === null) throw new AdminFilesError("not_found", "file or folder not found", 404);
    if (sourceStat.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "symbolic links cannot be managed here", 409);

    const parentSegments = source.segments.slice(0, -1);
    const parentRelative = relativePathFor(parentSegments);
    const targetRelative = joinRelative(parentRelative, name);
    const target = await resolveManagedPath(targetRelative);
    if ((await lstatOrNull(target.absolutePath)) !== null) {
      throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
    }

    try {
      await fs.rename(source.absolutePath, target.absolutePath);
    } catch (error) {
      throwRenameError(error);
    }

    const stat = await fs.lstat(target.absolutePath);
    return entryFromStat(name, targetRelative, stat);
  });
}

/**
 * The `fs.rename` failure modes that are the caller's problem rather than a
 * bug, shared by rename and move so both answer with one vocabulary.
 *
 * EXDEV can only appear if something inside the managed tree is a separate
 * mount, which the single-volume deployment does not have; it is mapped anyway
 * so a future layout change degrades into an envelope instead of a 500. EINVAL
 * is the kernel's own "into its own subdirectory" refusal, kept as a backstop
 * behind the explicit segment check rather than as the primary guard.
 */
function throwRenameError(error: unknown): never {
  const code = nodeErrorCode(error);
  if (code === "ENAMETOOLONG") throw new AdminFilesError("invalid_path", "name is too long for this filesystem", 400);
  if (code === "EINVAL") throw new AdminFilesError("invalid_path", "a folder cannot move into itself or one of its own subfolders", 400);
  if (code === "ENOSPC") throw new AdminFilesError("storage_full", "the Files volume is out of space", 507);
  if (code === "EXDEV") throw new AdminFilesError("storage_unavailable", "the destination is on a different filesystem", 500);
  if (code === "ENOTEMPTY" || code === "EEXIST") {
    throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
  }
  throw error;
}

type RemovableKind = "file" | "folder";

/**
 * Classify one entry found inside a recursive delete, refusing everything this
 * system will not manage. The refusal contract lives here alone so the
 * validation pass and the removal pass cannot drift apart.
 */
function removableKind(stat: Awaited<ReturnType<typeof fs.lstat>>): RemovableKind {
  if (stat.isSymbolicLink()) {
    throw new AdminFilesError("unsafe_path", "the folder contains a symbolic link and was left in place", 409);
  }
  if (stat.isDirectory()) return "folder";
  if (stat.isFile()) return "file";
  throw new AdminFilesError(
    "unsupported_entry",
    "the folder contains an unsupported filesystem entry and was left in place",
    409,
  );
}

/**
 * Validation pass for a recursive delete: the WHOLE subtree is checked before a
 * single entry is unlinked, so a symbolic link at the bottom of a thousand-file
 * folder costs the owner an error rather than nine hundred and ninety-nine
 * files.
 *
 * `fs.rm(..., { recursive: true })` is deliberately not used anywhere on this
 * path. It would silently unlink exactly the entries this system refuses to
 * manage, and that refusal is the documented contract.
 */
async function assertSubtreeRemovable(absoluteDirectory: string): Promise<void> {
  for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
    const absoluteEntry = path.join(absoluteDirectory, entry.name);
    if (removableKind(await fs.lstat(absoluteEntry)) === "folder") {
      await assertSubtreeRemovable(absoluteEntry);
    }
  }
}

/**
 * Removal pass, depth-first. Every entry is re-classified rather than trusted
 * from the validation pass, so nothing but a plain file or folder is ever
 * unlinked even if the tree changed underneath us.
 */
async function removeSubtree(absoluteDirectory: string): Promise<void> {
  for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
    const absoluteEntry = path.join(absoluteDirectory, entry.name);
    const stat = await lstatOrNull(absoluteEntry);
    if (stat === null) continue;
    if (removableKind(stat) === "folder") {
      await removeSubtree(absoluteEntry);
      continue;
    }
    await unlinkIfPresent(absoluteEntry);
  }
  await removeEmptyDirectory(absoluteDirectory);
}

async function unlinkIfPresent(absolutePath: string): Promise<void> {
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
}

async function removeEmptyDirectory(absolutePath: string): Promise<void> {
  try {
    await fs.rmdir(absolutePath);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT") return;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new AdminFilesError("folder_not_empty", "folder is not empty; delete its contents first", 409);
    }
    throw error;
  }
}

/**
 * The unlocked core of a delete.
 *
 * {@link withMutationLock} is a queue, not a reentrant mutex: a batch that took
 * the lock and then called `deleteAdminEntry`, which takes it again, would wait
 * on itself and wedge every later Files request in the process. So the core is
 * factored out here and every public entry point — single and batch — acquires
 * the lock exactly once around it.
 */
async function deleteEntryUnlocked(root: string, relativePath: string, recursive: boolean): Promise<void> {
  const target = await resolveWithinRoot(root, relativePath);
  if (target.segments.length === 0) invalidPath("the Files root cannot be deleted");
  const stat = await lstatOrNull(target.absolutePath);
  if (stat === null) throw new AdminFilesError("not_found", "file or folder not found", 404);
  if (stat.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "symbolic links cannot be managed here", 409);

  if (stat.isFile()) {
    await fs.unlink(target.absolutePath);
    return;
  }
  if (!stat.isDirectory()) throw new AdminFilesError("unsupported_entry", "unsupported filesystem entry", 409);

  // Recursion is never implicit: a request that did not ask for it still meets
  // the original refusal.
  if (!recursive) {
    await removeEmptyDirectory(target.absolutePath);
    return;
  }

  await assertSubtreeRemovable(target.absolutePath);
  await removeSubtree(target.absolutePath);
}

/**
 * The unlocked core of a move.
 *
 * A move is a containment problem rather than a rename: the destination is
 * compared against the source as validated SEGMENT ARRAYS, because a string
 * prefix test reads `a/b` as a prefix of `a/bc`.
 */
async function moveEntryUnlocked(
  root: string,
  relativePath: string,
  destinationSegments: readonly string[],
): Promise<AdminFileEntry> {
  const source = await resolveWithinRoot(root, relativePath);
  if (source.segments.length === 0) invalidPath("the Files root cannot be moved");

  const sourceStat = await lstatOrNull(source.absolutePath);
  if (sourceStat === null) throw new AdminFilesError("not_found", "file or folder not found", 404);
  if (sourceStat.isSymbolicLink()) {
    throw new AdminFilesError("unsafe_path", "symbolic links cannot be managed here", 409);
  }

  const parentSegments = source.segments.slice(0, -1);
  if (segmentsEqual(parentSegments, destinationSegments)) {
    throw new AdminFilesError("already_in_destination", "the entry is already in that folder", 409);
  }
  if (segmentsStartWith(destinationSegments, source.segments)) {
    invalidPath("a folder cannot move into itself or one of its own subfolders");
  }

  const name = source.segments[source.segments.length - 1];
  if (name === undefined) invalidPath("a file or folder path is required");
  const targetRelative = joinRelative(relativePathFor(destinationSegments), name);
  const target = await resolveWithinRoot(root, targetRelative);
  if ((await lstatOrNull(target.absolutePath)) !== null) {
    throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
  }

  try {
    await fs.rename(source.absolutePath, target.absolutePath);
  } catch (error) {
    throwRenameError(error);
  }

  const stat = await fs.lstat(target.absolutePath);
  return entryFromStat(name, targetRelative, stat);
}

export async function deleteAdminEntry(relativePath: string): Promise<void> {
  return withMutationLock(async () => {
    const { root } = await storageRoots();
    await deleteEntryUnlocked(root, relativePath, false);
  });
}

/**
 * Delete a set of entries in one request, recursively only when the caller
 * explicitly asks.
 *
 * The whole batch runs under ONE lock acquisition, which is what keeps a
 * concurrent upload from publishing into a folder halfway through its removal.
 */
export async function deleteAdminEntries(
  relativePaths: readonly string[],
  recursive = false,
): Promise<AdminFilesBatchDeleteResult> {
  return withMutationLock(async () => {
    const { root } = await storageRoots();
    const failures: AdminFileFailure[] = [];
    let deleted = 0;

    // A duplicate path needs no bookkeeping: the first pass removes the entry,
    // and the later copies find nothing and report `not_found` on their own.
    for (const relativePath of relativePaths) {
      try {
        await deleteEntryUnlocked(root, relativePath, recursive);
        deleted += 1;
      } catch (error) {
        failures.push(toFailure(relativePath, error));
      }
    }

    return { deleted, failures };
  });
}

/**
 * Move a set of entries into one destination folder.
 *
 * A missing or non-folder destination fails the WHOLE request rather than
 * reporting itself once per path, because it is one fact about the request and
 * not a property of any entry in it. The destination is resolved once, up
 * front: an earlier move in the same batch cannot invalidate it, because moving
 * an ancestor of the destination is exactly the self-descendant case the
 * containment check refuses.
 */
export async function moveAdminEntries(
  relativePaths: readonly string[],
  destination: string,
): Promise<AdminFilesMoveResult> {
  return withMutationLock(async () => {
    const { root } = await storageRoots();
    const target = await resolveWithinRoot(root, destination);
    const targetStat = await lstatOrNull(target.absolutePath);
    if (targetStat === null) throw new AdminFilesError("not_found", "destination folder not found", 404);
    if (targetStat.isSymbolicLink()) {
      throw new AdminFilesError("unsafe_path", "symbolic links cannot be managed here", 409);
    }
    if (!targetStat.isDirectory()) {
      throw new AdminFilesError("not_directory", "destination is not a folder", 400);
    }

    const entries: AdminFileEntry[] = [];
    const failures: AdminFileFailure[] = [];
    for (const relativePath of relativePaths) {
      try {
        entries.push(await moveEntryUnlocked(root, relativePath, target.segments));
      } catch (error) {
        failures.push(toFailure(relativePath, error));
      }
    }

    return { moved: entries.length, entries, failures };
  });
}

/** `lstat` that reports an unreadable entry as absent — the preview counts, it does not police. */
async function lstatOrSkip(absolutePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(absolutePath);
  } catch {
    return null;
  }
}

async function readdirOrNull(absolutePath: string): Promise<string[] | null> {
  try {
    return await fs.readdir(absolutePath);
  } catch {
    return null;
  }
}

/** Path validation that reports a rejected path as absent, for the same reason. */
async function resolveOrNull(root: string, relativePath: string): Promise<ResolvedManagedPath | null> {
  try {
    return await resolveWithinRoot(root, relativePath);
  } catch {
    return null;
  }
}

interface PreviewWalk {
  /** Mutable accumulator; `truncated` flips when the ceiling is reached. */
  totals: AdminFilesDeletePreview;
  /** Absolute paths already counted, so a duplicated or nested selection counts once. */
  counted: Set<string>;
  /** Entry ceiling, spent as ONE budget across every path in the request. */
  limit: number;
}

async function countSubtreeInto(
  walk: PreviewWalk,
  absolutePath: string,
  stat: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<void> {
  const { totals } = walk;
  if (totals.files + totals.folders >= walk.limit) {
    totals.truncated = true;
    return;
  }
  // Duplicate and overlapping selections are counted once, so the confirmation
  // states what a delete would actually remove rather than how many times the
  // caller named it.
  if (walk.counted.has(absolutePath)) return;
  walk.counted.add(absolutePath);

  if (stat.isFile()) {
    totals.files += 1;
    totals.bytes += Number(stat.size);
    return;
  }
  if (!stat.isDirectory()) return;
  totals.folders += 1;

  const children = await readdirOrNull(absolutePath);
  if (children === null) return;
  for (const child of children) {
    if (totals.truncated) return;
    const absoluteChild = path.join(absolutePath, child);
    const childStat = await lstatOrSkip(absoluteChild);
    if (childStat === null || childStat.isSymbolicLink()) continue;
    await countSubtreeInto(walk, absoluteChild, childStat);
  }
}

/**
 * Sum what a recursive delete of `relativePaths` would remove, for the
 * confirmation that precedes it.
 *
 * Deliberately outside {@link withMutationLock}: this is a read, and holding
 * the process-wide mutation lock across a ten-thousand-entry walk would stall
 * every concurrent upload and rename behind a dialog. A path that cannot be
 * walked is skipped rather than failing the call — the safety checks live in
 * {@link deleteAdminEntries}, and this is only a count.
 *
 * `maxEntries` is the walk's ceiling, spent as one budget across the whole
 * selection. The route always takes the default; it is a parameter so the
 * truncation branch can be crossed by a handful of entries rather than by
 * writing {@link DELETE_PREVIEW_MAX_ENTRIES} real files.
 */
export async function previewAdminDelete(
  relativePaths: readonly string[],
  maxEntries = DELETE_PREVIEW_MAX_ENTRIES,
): Promise<AdminFilesDeletePreview> {
  const { root } = await storageRoots();
  const walk: PreviewWalk = {
    totals: { files: 0, folders: 0, bytes: 0, truncated: false },
    counted: new Set<string>(),
    limit: maxEntries,
  };

  for (const relativePath of relativePaths) {
    if (walk.totals.truncated) break;

    const resolved = await resolveOrNull(root, relativePath);
    if (resolved === null) continue;
    // The Files root is never deletable, so counting its contents would promise
    // a removal `delete_many` refuses.
    if (resolved.segments.length === 0) continue;

    const stat = await lstatOrSkip(resolved.absolutePath);
    if (stat === null || stat.isSymbolicLink()) continue;
    await countSubtreeInto(walk, resolved.absolutePath, stat);
  }

  return walk.totals;
}

async function finalizeUpload(tempPath: string, targetPath: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    const existing = await lstatOrNull(targetPath);
    if (existing?.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "cannot replace a symbolic link", 409);
    if (existing?.isDirectory()) throw new AdminFilesError("already_exists", "a folder with that name already exists", 409);
    await fs.rename(tempPath, targetPath);
    return;
  }

  try {
    // Hard-linking the completed temp file is an atomic no-clobber publish on
    // the same volume. Unlinking the temp name afterward leaves one inode at the
    // requested destination without ever exposing a partial upload.
    await fs.link(tempPath, targetPath);
    await fs.unlink(tempPath);
  } catch (error) {
    if (nodeErrorCode(error) === "EEXIST") {
      throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
    }
    throw error;
  }
}

export async function uploadAdminFile(
  relativeDirectory: string,
  name: string,
  body: ReadableStream<Uint8Array> | null,
  overwrite = false,
): Promise<AdminFileEntry> {
  validateName(name);
  const parent = await resolveManagedPath(relativeDirectory);
  const parentStat = await lstatOrNull(parent.absolutePath);
  if (parentStat === null) throw new AdminFilesError("not_found", "upload folder not found", 404);
  if (!parentStat.isDirectory()) throw new AdminFilesError("not_directory", "upload path is not a folder", 400);

  const targetRelative = joinRelative(relativeDirectory, name);
  const target = await resolveManagedPath(targetRelative);
  const existing = await lstatOrNull(target.absolutePath);
  if (existing?.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "cannot replace a symbolic link", 409);
  if (existing !== null && !overwrite) {
    throw new AdminFilesError("already_exists", "a file or folder with that name already exists", 409);
  }
  if (existing?.isDirectory()) {
    throw new AdminFilesError("already_exists", "a folder with that name already exists", 409);
  }

  const { tempRoot } = await storageRoots();
  const tempPath = path.join(tempRoot, `${randomUUID()}.part`);
  activeUploadTemps.add(tempPath);
  try {
    if (body === null) {
      await fs.writeFile(tempPath, new Uint8Array(), { flag: "wx" });
    } else {
      const output = createWriteStream(tempPath, { flags: "wx" });
      await body.pipeTo(Writable.toWeb(output));
    }
    await withMutationLock(() => finalizeUpload(tempPath, target.absolutePath, overwrite));
  } catch (error) {
    if (error instanceof AdminFilesError) throw error;
    if (nodeErrorCode(error) === "ENOSPC") throw new AdminFilesError("storage_full", "the Files volume is out of space", 507);
    if (nodeErrorCode(error) === "ENAMETOOLONG") throw new AdminFilesError("invalid_path", "file name is too long for this filesystem", 400);
    throw new AdminFilesError("upload_failed", "upload did not complete", 500);
  } finally {
    activeUploadTemps.delete(tempPath);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  const stat = await fs.lstat(target.absolutePath);
  return entryFromStat(name, targetRelative, stat);
}

export async function getAdminFileDownload(relativePath: string): Promise<AdminFileDownload> {
  const target = await resolveManagedPath(relativePath);
  if (target.segments.length === 0) invalidPath("a file path is required");

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    // O_NOFOLLOW closes the final-component symlink race between containment
    // validation and open on the Linux production filesystem.
    handle = await fs.open(target.absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") throw new AdminFilesError("not_found", "file not found", 404);
    if (nodeErrorCode(error) === "ELOOP") throw new AdminFilesError("unsafe_path", "symbolic links cannot be downloaded", 409);
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AdminFilesError("not_file", "path is not a file", 400);
    const name = target.segments[target.segments.length - 1];
    if (name === undefined) invalidPath("a file path is required");
    return {
      handle,
      name,
      size: Number(stat.size),
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
