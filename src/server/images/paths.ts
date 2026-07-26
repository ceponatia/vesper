import fs from "node:fs";
import path from "node:path";

export interface StoredImagePath {
  path: string;
  id?: string;
  ownerId?: string;
}

export class ImagePathError extends Error {
  readonly code = "invalid_image_path";

  constructor(message: string) {
    super(message);
    this.name = "ImagePathError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Resolve symlinks in the nearest existing ancestor, then append any missing
 * suffix. This keeps DATA_ROOT absolute and canonical even before its directory
 * has been created for the first image write.
 */
function canonicalizePossiblyMissing(absolutePath: string): string {
  let cursor = path.resolve(absolutePath);
  const missing: string[] = [];

  while (true) {
    try {
      const existing = fs.realpathSync.native(cursor);
      return path.join(existing, ...missing);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new ImagePathError(`DATA_ROOT could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new ImagePathError("DATA_ROOT has no resolvable ancestor");
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Runtime asset root. Always absolute and canonical; overridable for tests. */
export function dataRoot(): string {
  const configured = process.env.DATA_ROOT ?? path.join(process.cwd(), "data");
  return canonicalizePossiblyMissing(configured);
}

function assertPathSegment(label: string, value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new ImagePathError(`${label} is not a safe image path segment`);
  }
}

/** Canonical relative path stored on every images row. */
export function imageRelativePath(ownerId: string, imageId: string): string {
  assertPathSegment("ownerId", ownerId);
  assertPathSegment("imageId", imageId);
  return `images/${ownerId}/${imageId}.webp`;
}

function relativeIsContained(relative: string): boolean {
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertStrictlyContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relativeIsContained(relative)) {
    throw new ImagePathError("image path escapes DATA_ROOT");
  }
}

/**
 * Reject every existing symlink component beneath DATA_ROOT. This is stricter
 * than merely checking realpath containment and prevents a later in-root
 * symlink retarget from changing what a stored database path means.
 */
function assertNoSymlinkComponents(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new ImagePathError("image path crosses a symbolic link");
      }
    } catch (error) {
      if (error instanceof ImagePathError) throw error;
      if (errorCode(error) === "ENOENT") break;
      throw new ImagePathError(`image path could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Resolve an arbitrary relative data path while keeping it strictly under DATA_ROOT. */
export function absoluteDataPath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new ImagePathError("stored image path must be a relative POSIX path");
  }

  const root = dataRoot();
  const candidate = path.resolve(root, relativePath);
  assertStrictlyContained(root, candidate);
  assertNoSymlinkComponents(root, candidate);
  return candidate;
}

/**
 * Resolve a stored image row. Full rows additionally have their exact
 * `images/{ownerId}/{imageId}.webp` shape checked before any filesystem access.
 */
export function absoluteImagePath(image: StoredImagePath): string {
  if (image.id !== undefined && image.ownerId !== undefined) {
    const expected = imageRelativePath(image.ownerId, image.id);
    if (image.path !== expected) throw new ImagePathError("images.path is not canonical for its owner and image id");
  }
  return absoluteDataPath(image.path);
}

/** Validate an absolute target supplied to a low-level image writer. */
export function containedAbsoluteImagePath(absolutePath: string): string {
  if (!path.isAbsolute(absolutePath) || absolutePath.includes("\0")) {
    throw new ImagePathError("image write target must be an absolute path beneath DATA_ROOT");
  }
  const root = dataRoot();
  const candidate = path.resolve(absolutePath);
  assertStrictlyContained(root, candidate);
  assertNoSymlinkComponents(root, candidate);
  return candidate;
}

/** Filesystem directory scanned by image_sweep, safely owner-scoped when requested. */
export function imagesDirectoryPath(ownerId?: string): string {
  if (ownerId === undefined) return absoluteDataPath("images");
  assertPathSegment("ownerId", ownerId);
  return absoluteDataPath(`images/${ownerId}`);
}
