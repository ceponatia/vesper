import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canCreateSymlinks, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import {
  AdminFilesError,
  DELETE_PREVIEW_MAX_ENTRIES,
  adminFilesRoot,
  createAdminFolder,
  deleteAdminEntries,
  deleteAdminEntry,
  getAdminFileDownload,
  listAdminFiles,
  moveAdminEntries,
  previewAdminDelete,
  renameAdminEntry,
  uploadAdminFile,
  type AdminFilesBatchDeleteResult,
} from "./storage";

const symlinksAvailable = canCreateSymlinks();
let temp: TempDataRoot;

beforeEach(async () => {
  temp = await withTempDataRoot("vesper-admin-files");
});

afterEach(async () => {
  await temp.cleanup();
});

function bytes(...values: number[]): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(values)]).stream();
}

async function readDownload(relativePath: string): Promise<number[]> {
  const download = await getAdminFileDownload(relativePath);
  try {
    return [...await download.handle.readFile()];
  } finally {
    await download.handle.close().catch(() => undefined);
  }
}

describe("admin Files storage", () => {
  it("creates folders, streams arbitrary bytes, lists them, renames them, and deletes them", async () => {
    const folder = await createAdminFolder("", "phone share");
    expect(folder).toMatchObject({ name: "phone share", path: "phone share", kind: "folder" });

    const uploaded = await uploadAdminFile("phone share", "payload.bin", bytes(0, 255, 1, 2, 3));
    expect(uploaded).toMatchObject({ name: "payload.bin", path: "phone share/payload.bin", kind: "file", size: 5 });

    const listing = await listAdminFiles("phone share");
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ name: "payload.bin", size: 5 });
    expect(await readDownload("phone share/payload.bin")).toEqual([0, 255, 1, 2, 3]);

    const renamed = await renameAdminEntry("phone share/payload.bin", "renamed.dat");
    expect(renamed.path).toBe("phone share/renamed.dat");
    await deleteAdminEntry(renamed.path);
    await deleteAdminEntry("phone share");
    expect(await listAdminFiles("")).toEqual([]);
  });

  it("never silently overwrites an existing file, but replaces it when explicitly requested", async () => {
    await uploadAdminFile("", "same.bin", bytes(1, 2, 3));

    await expect(uploadAdminFile("", "same.bin", bytes(9, 9))).rejects.toMatchObject({
      code: "already_exists",
      status: 409,
    });
    expect(await readDownload("same.bin")).toEqual([1, 2, 3]);

    await uploadAdminFile("", "same.bin", bytes(9, 9), true);
    expect(await readDownload("same.bin")).toEqual([9, 9]);
  });

  it("serializes rename against a competing destination create so exactly one mutation wins", async () => {
    await uploadAdminFile("", "source.bin", bytes(1, 2, 3));

    const results = await Promise.allSettled([
      renameAdminEntry("source.bin", "destination.bin"),
      uploadAdminFile("", "destination.bin", bytes(9, 8, 7)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const destination = await readDownload("destination.bin");
    expect([[1, 2, 3], [9, 8, 7]]).toContainEqual(destination);
  });

  it("keeps download metadata and bytes pinned to one opened file across replacement", async () => {
    await uploadAdminFile("", "stable.bin", bytes(1, 2, 3, 4));
    const opened = await getAdminFileDownload("stable.bin");
    expect(opened.size).toBe(4);

    try {
      await uploadAdminFile("", "stable.bin", bytes(9, 9), true);
      expect([...await opened.handle.readFile()]).toEqual([1, 2, 3, 4]);
      expect(await readDownload("stable.bin")).toEqual([9, 9]);
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  });

  it("refuses to delete a non-empty folder", async () => {
    await createAdminFolder("", "keep");
    await uploadAdminFile("keep", "inside.txt", new Blob(["hello"]).stream());
    await expect(deleteAdminEntry("keep")).rejects.toMatchObject({
      code: "folder_not_empty",
      status: 409,
    });
  });

  it("rejects traversal, absolute paths, and separator-bearing names", async () => {
    await expect(listAdminFiles("../outside")).rejects.toBeInstanceOf(AdminFilesError);
    await expect(listAdminFiles("/etc")).rejects.toBeInstanceOf(AdminFilesError);
    await expect(listAdminFiles("C:\\Windows")).rejects.toBeInstanceOf(AdminFilesError);
    await expect(createAdminFolder("", "../escape")).rejects.toBeInstanceOf(AdminFilesError);
    await expect(renameAdminEntry("missing", "nested/name")).rejects.toBeInstanceOf(AdminFilesError);
  });

  it("does not publish a partial file when the upload stream fails", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection lost"));
      },
    });

    await expect(uploadAdminFile("", "broken.bin", broken)).rejects.toMatchObject({
      code: "upload_failed",
    });
    expect(await listAdminFiles("")).toEqual([]);
  });

  it("reclaims stale staged uploads left behind by a prior process", async () => {
    await adminFilesRoot();
    const tempRoot = path.join(temp.root, ".admin-files-upload-tmp");
    const stale = path.join(tempRoot, "stale.part");
    const fresh = path.join(tempRoot, "fresh.part");
    await fs.writeFile(stale, "abandoned");
    await fs.writeFile(fresh, "recent");

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo);

    await listAdminFiles("");
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(fresh)).isFile()).toBe(true);
  });

  it.skipIf(!symlinksAvailable)("rejects a symlink escape planted under the managed root", async () => {
    const root = await adminFilesRoot();
    const outside = path.join(temp.sandbox, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "linked"), "dir");

    await expect(listAdminFiles("linked")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(getAdminFileDownload("linked/secret.txt")).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("deletes a mixed batch, counts only what went, and reports one failure per refused path", async () => {
    await uploadAdminFile("", "gone.bin", bytes(1));
    await uploadAdminFile("", "dup.bin", bytes(2));
    await createAdminFolder("", "empty");
    await createAdminFolder("", "full");
    await uploadAdminFile("full", "inside.bin", bytes(3));

    const result = await deleteAdminEntries(["gone.bin", "dup.bin", "dup.bin", "empty", "full", "missing.bin", ""]);

    expect(result.deleted).toBe(3);
    // Failures follow the request's order, and the second copy of a duplicated
    // path finds the entry already gone rather than deleting it twice.
    expect(result.failures).toEqual([
      expect.objectContaining({ path: "dup.bin", code: "not_found" }),
      expect.objectContaining({ path: "full", code: "folder_not_empty" }),
      expect.objectContaining({ path: "missing.bin", code: "not_found" }),
      expect.objectContaining({ path: "", code: "invalid_path" }),
    ]);
    expect(await listAdminFiles("")).toEqual([expect.objectContaining({ name: "full", kind: "folder" })]);
  });

  it("refuses a non-empty folder until the caller asks for recursion, then takes the whole tree", async () => {
    await createAdminFolder("", "tree");
    await createAdminFolder("tree", "nested");
    await uploadAdminFile("tree", "top.bin", bytes(1, 2));
    await uploadAdminFile("tree/nested", "deep.bin", bytes(3));

    expect(await deleteAdminEntries(["tree"])).toEqual({
      deleted: 0,
      failures: [expect.objectContaining({ path: "tree", code: "folder_not_empty" })],
    });
    expect(await listAdminFiles("tree")).toHaveLength(2);

    expect(await deleteAdminEntries(["tree"], true)).toEqual({ deleted: 1, failures: [] });
    expect(await listAdminFiles("")).toEqual([]);
  });

  it("runs a whole batch under one lock acquisition, so a concurrent mutation still completes", async () => {
    // `withMutationLock` is a queue, not a reentrant mutex. If a batch entry
    // point ever re-enters it — by calling `deleteAdminEntry` or
    // `renameAdminEntry` from inside the batch — this test does not fail, it
    // HANGS: the batch waits on a lock only it can release, and every later
    // Files request in the process queues behind it forever. A timeout here
    // means someone re-entered the lock.
    await uploadAdminFile("", "one.bin", bytes(1));
    await uploadAdminFile("", "two.bin", bytes(2));

    const [removed, created] = await Promise.all([
      deleteAdminEntries(["one.bin", "two.bin"]),
      createAdminFolder("", "box"),
    ]);
    expect(removed).toEqual({ deleted: 2, failures: [] });
    expect(created.name).toBe("box");

    await uploadAdminFile("", "three.bin", bytes(3));
    const [moved, alsoCreated] = await Promise.all([
      moveAdminEntries(["three.bin"], "box"),
      createAdminFolder("", "later"),
    ]);
    expect(moved.moved).toBe(1);
    expect(alsoCreated.name).toBe("later");
  });

  it.skipIf(!symlinksAvailable)("leaves a subtree in place when a recursive delete meets a symbolic link", async () => {
    const root = await adminFilesRoot();
    const outside = path.join(temp.sandbox, "outside");
    await fs.mkdir(outside);
    await createAdminFolder("", "tree");
    await uploadAdminFile("tree", "keep.bin", bytes(1, 2, 3));
    const link = path.join(root, "tree", "linked");
    await fs.symlink(outside, link, "dir");

    expect(await deleteAdminEntries(["tree"], true)).toEqual({
      deleted: 0,
      failures: [expect.objectContaining({ path: "tree", code: "unsafe_path" })],
    });

    // The subtree is validated before anything is unlinked, so the refusal
    // costs the owner an error rather than the files that shared the folder.
    expect(await readDownload("tree/keep.bin")).toEqual([1, 2, 3]);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "leaves a subtree in place when a recursive delete meets an unsupported entry",
    async () => {
      const root = await adminFilesRoot();
      await createAdminFolder("", "odd");
      await uploadAdminFile("odd", "keep.bin", bytes(7));

      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path.join(root, "odd", "socket.sock"), resolve);
      });

      try {
        expect(await deleteAdminEntries(["odd"], true)).toEqual({
          deleted: 0,
          failures: [expect.objectContaining({ path: "odd", code: "unsupported_entry" })],
        });
        expect(await readDownload("odd/keep.bin")).toEqual([7]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a path routed through a file as one failure row rather than failing the batch",
    async () => {
      await uploadAdminFile("", "note.bin", bytes(1));
      await uploadAdminFile("", "loose.bin", bytes(2));

      // `lstat` of a path whose parent component is a FILE raises ENOTDIR, which
      // is not an `AdminFilesError`: unmapped, `toFailure` rethrows it and the
      // whole request answers 500, discarding the count of everything the batch
      // had already removed. Mapped, it is one row and the rest still runs.
      const result = await deleteAdminEntries(["note.bin/inside.bin", "loose.bin"]);

      expect(result).toEqual({
        deleted: 1,
        failures: [expect.objectContaining({ path: "note.bin/inside.bin", code: "not_directory" })],
      });
      expect(await readDownload("note.bin")).toEqual([1]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports a subtree it cannot read as one failure row and still deletes the rest of the batch",
    async () => {
      const root = await adminFilesRoot();
      await createAdminFolder("", "vault");
      await createAdminFolder("vault", "locked");
      await uploadAdminFile("vault/locked", "secret.bin", bytes(1, 2));
      await uploadAdminFile("", "loose.bin", bytes(3));
      const locked = path.join(root, "vault", "locked");

      let denial = "unset";
      let result: AdminFilesBatchDeleteResult | undefined;
      await fs.chmod(locked, 0o000);
      try {
        // Prove the fixture before the behaviour: mode bits deny nothing to
        // root, and the refusal below would then read as a regression rather
        // than as an environment that cannot stage an unreadable directory.
        denial = await fs.readdir(locked).then(
          () => "readable",
          (error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : "unknown"),
        );
        result = await deleteAdminEntries(["vault", "loose.bin"], true);
      } finally {
        // Restored before any assertion runs, so a failure cannot also break the
        // sandbox teardown and bury itself under an unrelated cleanup error.
        await fs.chmod(locked, 0o700);
      }

      expect(denial).toMatch(/^E(?:ACCES|PERM)$/u);
      // Raw, the EACCES escaped `toFailure`, failed the whole request with a 500
      // and threw away the count of what the batch had already removed.
      expect(result).toEqual({
        deleted: 1,
        failures: [expect.objectContaining({ path: "vault", code: "unsafe_path" })],
      });
      // The subtree is validated before anything is unlinked, so the refusal
      // costs the owner an error rather than the files that shared the tree.
      expect(await readDownload("vault/locked/secret.bin")).toEqual([1, 2]);
    },
  );

  it("moves entries into a folder and back out to the Files root", async () => {
    await createAdminFolder("", "box");
    await uploadAdminFile("", "note.bin", bytes(1));
    await createAdminFolder("", "sub");
    await uploadAdminFile("sub", "deep.bin", bytes(2));

    const intoBox = await moveAdminEntries(["note.bin", "sub"], "box");
    expect(intoBox.moved).toBe(2);
    expect(intoBox.failures).toEqual([]);
    expect(intoBox.entries.map((entry) => entry.path)).toEqual(["box/note.bin", "box/sub"]);
    expect(await readDownload("box/sub/deep.bin")).toEqual([2]);

    const toRoot = await moveAdminEntries(["box/note.bin"], "");
    expect(toRoot.moved).toBe(1);
    expect(toRoot.entries[0]).toMatchObject({ name: "note.bin", path: "note.bin", kind: "file" });
    expect(await readDownload("note.bin")).toEqual([1]);
  });

  it("refuses a folder moved into itself or its own descendant, and allows a same-prefix sibling", async () => {
    await createAdminFolder("", "a");
    await createAdminFolder("a", "b");
    await createAdminFolder("a", "bc");
    await createAdminFolder("a/b", "deep");

    const intoItself = await moveAdminEntries(["a"], "a");
    expect(intoItself).toMatchObject({ moved: 0, entries: [] });
    expect(intoItself.failures).toEqual([expect.objectContaining({ path: "a", code: "invalid_path" })]);

    const intoDescendant = await moveAdminEntries(["a/b"], "a/b/deep");
    expect(intoDescendant).toMatchObject({ moved: 0, entries: [] });
    expect(intoDescendant.failures).toEqual([expect.objectContaining({ path: "a/b", code: "invalid_path" })]);

    // `a/bc` is NOT inside `a/b`. Containment is compared as validated segment
    // arrays precisely so a raw string-prefix test cannot refuse this move.
    const sibling = await moveAdminEntries(["a/b"], "a/bc");
    expect(sibling.failures).toEqual([]);
    expect(sibling.entries.map((entry) => entry.path)).toEqual(["a/bc/b"]);
  });

  it("never overwrites a name at the destination and reports an entry already sitting there", async () => {
    await createAdminFolder("", "box");
    await uploadAdminFile("", "same.bin", bytes(1));
    await uploadAdminFile("box", "same.bin", bytes(9, 9));
    await uploadAdminFile("box", "settled.bin", bytes(5));

    const result = await moveAdminEntries(["same.bin", "box/settled.bin"], "box");

    expect(result).toMatchObject({ moved: 0, entries: [] });
    expect(result.failures).toEqual([
      expect.objectContaining({ path: "same.bin", code: "already_exists" }),
      expect.objectContaining({ path: "box/settled.bin", code: "already_in_destination" }),
    ]);
    expect(await readDownload("box/same.bin")).toEqual([9, 9]);
    expect(await readDownload("same.bin")).toEqual([1]);
  });

  it("fails the whole move request when the destination is missing or is not a folder", async () => {
    await uploadAdminFile("", "note.bin", bytes(1));

    await expect(moveAdminEntries(["note.bin"], "nowhere")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(moveAdminEntries(["note.bin"], "note.bin")).rejects.toMatchObject({
      code: "not_directory",
      status: 400,
    });
    expect(await readDownload("note.bin")).toEqual([1]);
  });

  it("previews exactly what a recursive delete then removes", async () => {
    await createAdminFolder("", "tree");
    await createAdminFolder("tree", "nested");
    await uploadAdminFile("tree", "top.bin", bytes(1, 2, 3));
    await uploadAdminFile("tree/nested", "deep.bin", bytes(4, 5));
    await uploadAdminFile("", "loose.bin", bytes(6));

    expect(await previewAdminDelete(["tree", "loose.bin"])).toEqual({
      files: 3,
      folders: 2,
      bytes: 6,
      truncated: false,
    });

    expect(await deleteAdminEntries(["tree", "loose.bin"], true)).toEqual({ deleted: 2, failures: [] });
    expect(await listAdminFiles("")).toEqual([]);
  });

  it("counts a duplicated or overlapping preview selection once and skips what it cannot walk", async () => {
    await createAdminFolder("", "tree");
    await uploadAdminFile("tree", "one.bin", bytes(1, 2));

    // The Files root is skipped because `delete_many` refuses it; a traversal
    // path and a missing path are skipped rather than failing the count.
    expect(await previewAdminDelete(["tree", "tree", "tree/one.bin", "", "../escape", "missing"])).toEqual({
      files: 1,
      folders: 1,
      bytes: 2,
      truncated: false,
    });
  });

  it("stops a preview at its entry ceiling, spending one budget across the whole selection", async () => {
    await createAdminFolder("", "alpha");
    await createAdminFolder("", "beta");
    await createAdminFolder("", "gamma");
    await uploadAdminFile("alpha", "one.bin", bytes(1, 2));
    await uploadAdminFile("beta", "two.bin", bytes(1, 2, 3));
    await uploadAdminFile("gamma", "three.bin", bytes(1, 2, 3, 4));

    // The ceiling is one budget for the request rather than one per path:
    // `alpha` and its file spend two of three, `beta` itself spends the third,
    // and nothing after that is counted — `beta`'s file and the whole of
    // `gamma` are absent from both the totals and the byte sum.
    expect(await previewAdminDelete(["alpha", "beta", "gamma"], 3)).toEqual({
      files: 1,
      folders: 2,
      bytes: 2,
      truncated: true,
    });

    // The ceiling is genuinely a parameter over the documented default, which
    // is the only value the route ever uses: the same selection counts whole.
    expect(DELETE_PREVIEW_MAX_ENTRIES).toBe(10_000);
    expect(await previewAdminDelete(["alpha", "beta", "gamma"])).toEqual({
      files: 3,
      folders: 3,
      bytes: 9,
      truncated: false,
    });
  });
});
