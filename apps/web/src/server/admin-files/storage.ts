import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

const FILES_DIRECTORY = "admin-files";
const UPLOAD_TEMP_DIRECTORY = ".admin-files-upload-tmp";

export type AdminFileKind = "file" | "folder";

export interface AdminFileEntry {
  name: string;
  path: string;
  kind: AdminFileKind;
  size: number | null;
  modifiedAt: string;
}

export interface AdminFileDownload {
  absolutePath: string;
  name: string;
  size: number;
  modifiedAt: string;
}

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

async function storageRoots(): Promise<{ root: string; tempRoot: string }> {
  const configured = process.env.DATA_ROOT ?? path.join(process.cwd(), "data");
  const configuredDataRoot = path.resolve(configured);
  await fs.mkdir(configuredDataRoot, { recursive: true });
  const dataRoot = await fs.realpath(configuredDataRoot);

  const root = path.join(dataRoot, FILES_DIRECTORY);
  const tempRoot = path.join(dataRoot, UPLOAD_TEMP_DIRECTORY);
  await ensureDirectoryNotSymlink(root);
  await ensureDirectoryNotSymlink(tempRoot);
  return { root: await fs.realpath(root), tempRoot: await fs.realpath(tempRoot) };
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalidPath("path escapes the Files root");
  }
}

async function resolveManagedPath(relativePath: string): Promise<{ root: string; absolutePath: string; segments: string[] }> {
  const segments = validateRelativePath(relativePath);
  const { root } = await storageRoots();
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
      if (nodeErrorCode(error) === "ENOENT") break;
      throw error;
    }
  }

  return { root, absolutePath, segments };
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
}

export async function renameAdminEntry(relativePath: string, name: string): Promise<AdminFileEntry> {
  validateName(name);
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
    if (nodeErrorCode(error) === "ENAMETOOLONG") throw new AdminFilesError("invalid_path", "name is too long for this filesystem", 400);
    throw error;
  }

  const stat = await fs.lstat(target.absolutePath);
  return entryFromStat(name, targetRelative, stat);
}

export async function deleteAdminEntry(relativePath: string): Promise<void> {
  const target = await resolveManagedPath(relativePath);
  if (target.segments.length === 0) invalidPath("the Files root cannot be deleted");
  const stat = await lstatOrNull(target.absolutePath);
  if (stat === null) throw new AdminFilesError("not_found", "file or folder not found", 404);
  if (stat.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "symbolic links cannot be managed here", 409);

  if (stat.isFile()) {
    await fs.unlink(target.absolutePath);
    return;
  }
  if (!stat.isDirectory()) throw new AdminFilesError("unsupported_entry", "unsupported filesystem entry", 409);

  try {
    await fs.rmdir(target.absolutePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOTEMPTY" || nodeErrorCode(error) === "EEXIST") {
      throw new AdminFilesError("folder_not_empty", "folder is not empty; delete its contents first", 409);
    }
    throw error;
  }
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
  try {
    if (body === null) {
      await fs.writeFile(tempPath, new Uint8Array(), { flag: "wx" });
    } else {
      const output = createWriteStream(tempPath, { flags: "wx" });
      await body.pipeTo(Writable.toWeb(output));
    }
    await finalizeUpload(tempPath, target.absolutePath, overwrite);
  } catch (error) {
    if (error instanceof AdminFilesError) throw error;
    if (nodeErrorCode(error) === "ENOSPC") throw new AdminFilesError("storage_full", "the Files volume is out of space", 507);
    if (nodeErrorCode(error) === "ENAMETOOLONG") throw new AdminFilesError("invalid_path", "file name is too long for this filesystem", 400);
    throw new AdminFilesError("upload_failed", "upload did not complete", 500);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  const stat = await fs.lstat(target.absolutePath);
  return entryFromStat(name, targetRelative, stat);
}

export async function getAdminFileDownload(relativePath: string): Promise<AdminFileDownload> {
  const target = await resolveManagedPath(relativePath);
  if (target.segments.length === 0) invalidPath("a file path is required");
  const stat = await lstatOrNull(target.absolutePath);
  if (stat === null) throw new AdminFilesError("not_found", "file not found", 404);
  if (stat.isSymbolicLink()) throw new AdminFilesError("unsafe_path", "symbolic links cannot be downloaded", 409);
  if (!stat.isFile()) throw new AdminFilesError("not_file", "path is not a file", 400);

  const name = target.segments[target.segments.length - 1];
  if (name === undefined) invalidPath("a file path is required");
  return {
    absolutePath: target.absolutePath,
    name,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}
