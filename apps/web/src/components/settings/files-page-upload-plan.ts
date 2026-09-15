/**
 * Walks a dropped desktop selection (files and/or whole folders) into a flat
 * upload plan, depth-first — the part of drag-and-drop upload that can be unit
 * tested. It is written against a minimal structural entry interface rather
 * than the DOM's own split `FileSystemFileEntry` / `FileSystemDirectoryEntry`
 * types so a `.test.ts` can drive it with plain fakes; `files-page.tsx` casts
 * a real `DataTransferItem.webkitGetAsEntry()` result to this shape at the one
 * place it crosses from the browser into this module.
 *
 * The 100-entry boundary this exists to prove: `FileSystemDirectoryReader
 * .readEntries()` returns at most 100 entries per call and must be called
 * repeatedly until it answers with an empty array — a single call silently
 * truncates any folder holding more than 100 direct children.
 */

export interface FileSystemDirectoryReaderLike {
  readEntries(
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: unknown) => void,
  ): void;
}

export interface FileSystemEntryLike {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Only meaningful when `isFile`; a real directory entry has no `file()` method to call. */
  file(successCallback: (file: File) => void, errorCallback?: (error: unknown) => void): void;
  /** Only meaningful when `isDirectory`; a real file entry has no `createReader()` method to call. */
  createReader(): FileSystemDirectoryReaderLike;
}

export interface UploadPlanFile {
  /** Slash-joined, relative to the dropped item's own root — e.g. "sub/dir/photo.png". */
  relativePath: string;
  file: File;
}

export interface UploadPlan {
  /** Relative folder paths to create, always parent-before-child. */
  folders: string[];
  files: UploadPlanFile[];
}

/** Every entry of one directory, making as many `readEntries` calls as it takes to exhaust it. */
async function readAllEntries(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function readFile(entry: FileSystemEntryLike): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function walk(entry: FileSystemEntryLike, prefix: string, plan: UploadPlan): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    plan.files.push({ relativePath, file: await readFile(entry) });
    return;
  }
  if (!entry.isDirectory) return; // neither flag set: not a shape this walk can act on

  plan.folders.push(relativePath);
  const children = await readAllEntries(entry.createReader());
  for (const child of children) {
    // Depth-first on purpose: a child's own subtree finishes before its sibling starts.
    await walk(child, relativePath, plan);
  }
}

/** Builds the flat plan for one or more entries dropped together at the same root. */
export async function buildUploadPlan(entries: readonly FileSystemEntryLike[]): Promise<UploadPlan> {
  const plan: UploadPlan = { folders: [], files: [] };
  for (const entry of entries) {
    await walk(entry, "", plan);
  }
  return plan;
}
