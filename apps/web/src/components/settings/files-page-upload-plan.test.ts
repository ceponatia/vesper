import { describe, expect, it } from "vitest";
import { buildUploadPlan, type FileSystemDirectoryReaderLike, type FileSystemEntryLike } from "./files-page-upload-plan";

/** A fake `FileSystemDirectoryReader` that hands out pre-baked batches, one `readEntries` call at a time. */
class FakeDirectoryReader implements FileSystemDirectoryReaderLike {
  calls = 0;
  constructor(private readonly batches: readonly FileSystemEntryLike[][]) {}

  readEntries(successCallback: (entries: FileSystemEntryLike[]) => void): void {
    const batch = this.batches[this.calls] ?? [];
    this.calls += 1;
    successCallback([...batch]);
  }
}

function fakeFile(name: string, content = "x"): FileSystemEntryLike {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (success) => success(new File([content], name)),
    createReader: () => {
      throw new Error(`${name} is a file; it has no directory reader`);
    },
  };
}

function fakeDir(name: string, reader: FileSystemDirectoryReaderLike): FileSystemEntryLike {
  return {
    name,
    isFile: false,
    isDirectory: true,
    file: () => {
      throw new Error(`${name} is a directory; it has no file() to call`);
    },
    createReader: () => reader,
  };
}

describe("buildUploadPlan", () => {
  it("plans a flat file with no folders, using its own name as the relative path", async () => {
    const plan = await buildUploadPlan([fakeFile("photo.png")]);
    expect(plan.folders).toEqual([]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.relativePath).toBe("photo.png");
    expect(plan.files[0]?.file.name).toBe("photo.png");
  });

  it("plans several root-level entries dropped together, files and a folder alike", async () => {
    const reader = new FakeDirectoryReader([[fakeFile("inside.txt")], []]);
    const plan = await buildUploadPlan([fakeFile("a.txt"), fakeDir("sub", reader), fakeFile("b.txt")]);
    expect(plan.folders).toEqual(["sub"]);
    expect(plan.files.map((f) => f.relativePath).sort()).toEqual(["a.txt", "b.txt", "sub/inside.txt"]);
  });

  it("recreates a nested tree with parent folders ordered before their children", async () => {
    const innerReader = new FakeDirectoryReader([[fakeFile("leaf.txt")], []]);
    const outerReader = new FakeDirectoryReader([[fakeDir("child", innerReader)], []]);
    const plan = await buildUploadPlan([fakeDir("parent", outerReader)]);
    expect(plan.folders).toEqual(["parent", "parent/child"]);
    expect(plan.files.map((f) => f.relativePath)).toEqual(["parent/child/leaf.txt"]);
  });

  it("keeps calling readEntries past the 100-per-call boundary until it answers empty", async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => fakeFile(`file-${String(i)}.txt`));
    const secondBatch = [fakeFile("file-100.txt")];
    const reader = new FakeDirectoryReader([firstBatch, secondBatch, []]);
    const plan = await buildUploadPlan([fakeDir("bigdir", reader)]);

    // A single `readEntries` call would silently stop at 100 — this is the boundary the walk exists to cross.
    expect(reader.calls).toBe(3);
    expect(plan.files).toHaveLength(101);
    const paths = new Set(plan.files.map((f) => f.relativePath));
    expect(paths.has("bigdir/file-0.txt")).toBe(true);
    expect(paths.has("bigdir/file-99.txt")).toBe(true);
    expect(paths.has("bigdir/file-100.txt")).toBe(true);
  });

  it("plans an empty folder as a folder to create with no files under it", async () => {
    const reader = new FakeDirectoryReader([[]]);
    const plan = await buildUploadPlan([fakeDir("empty", reader)]);
    expect(plan.folders).toEqual(["empty"]);
    expect(plan.files).toEqual([]);
  });

  it("resolves with no folders or files for an empty drop", async () => {
    const plan = await buildUploadPlan([]);
    expect(plan).toEqual({ folders: [], files: [] });
  });
});
