import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canCreateSymlinks, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import {
  AdminFilesError,
  adminFilesRoot,
  createAdminFolder,
  deleteAdminEntry,
  getAdminFileDownload,
  listAdminFiles,
  renameAdminEntry,
  uploadAdminFile,
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

describe("admin Files storage", () => {
  it("creates folders, streams arbitrary bytes, lists them, renames them, and deletes them", async () => {
    const folder = await createAdminFolder("", "phone share");
    expect(folder).toMatchObject({ name: "phone share", path: "phone share", kind: "folder" });

    const uploaded = await uploadAdminFile("phone share", "payload.bin", bytes(0, 255, 1, 2, 3));
    expect(uploaded).toMatchObject({ name: "payload.bin", path: "phone share/payload.bin", kind: "file", size: 5 });

    const listing = await listAdminFiles("phone share");
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ name: "payload.bin", size: 5 });

    const download = await getAdminFileDownload("phone share/payload.bin");
    expect([...await fs.readFile(download.absolutePath)]).toEqual([0, 255, 1, 2, 3]);

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
    let download = await getAdminFileDownload("same.bin");
    expect([...await fs.readFile(download.absolutePath)]).toEqual([1, 2, 3]);

    await uploadAdminFile("", "same.bin", bytes(9, 9), true);
    download = await getAdminFileDownload("same.bin");
    expect([...await fs.readFile(download.absolutePath)]).toEqual([9, 9]);
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

  it.skipIf(!symlinksAvailable)("rejects a symlink escape planted under the managed root", async () => {
    const root = await adminFilesRoot();
    const outside = path.join(temp.sandbox, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "linked"), "dir");

    await expect(listAdminFiles("linked")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(getAdminFileDownload("linked/secret.txt")).rejects.toMatchObject({ code: "unsafe_path" });
  });
});
