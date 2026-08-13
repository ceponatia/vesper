import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { canCreateSymlinks, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { absoluteImagePath, dataRoot, imageRelativePath, ImagePathError } from "./paths";

const symlinksAvailable = canCreateSymlinks();

// `subdir` matters here: the symlink cases plant siblings of the configured root
// (a real directory plus a link to it), which only works when the temp directory
// is the root's PARENT rather than the root itself.
let temp: TempDataRoot;
let sandbox: string;
let root: string;

beforeEach(async () => {
  temp = await withTempDataRoot("vesper-image-paths", { subdir: "data" });
  sandbox = temp.sandbox;
  root = temp.root;
});

afterEach(async () => {
  await temp.cleanup();
});

describe("canonical DATA_ROOT", () => {
  it.skipIf(!symlinksAvailable)("returns an absolute canonical path, including through a configured symlink", async () => {
    const real = path.join(sandbox, "real-data");
    const linked = path.join(sandbox, "linked-data");
    await fs.mkdir(real);
    await fs.symlink(real, linked, "dir");
    process.env.DATA_ROOT = linked;

    expect(dataRoot()).toBe(await fs.realpath(real));
    expect(path.isAbsolute(dataRoot())).toBe(true);
  });
});

describe("stored image path containment", () => {
  it("accepts a valid canonical image path", () => {
    const relative = imageRelativePath("owner-1", "image-1");
    expect(relative).toBe("images/owner-1/image-1.webp");
    expect(absoluteImagePath({ id: "image-1", ownerId: "owner-1", path: relative })).toBe(
      path.join(root, relative),
    );
  });

  it("rejects traversal and absolute database paths", () => {
    expect(() => absoluteImagePath({ path: "../outside.webp" })).toThrow(ImagePathError);
    expect(() => absoluteImagePath({ path: path.join(sandbox, "outside.webp") })).toThrow(ImagePathError);
  });

  it("rejects sibling-prefix tricks rather than comparing string prefixes", () => {
    const sibling = `${path.basename(root)}-evil`;
    expect(() => absoluteImagePath({ path: `../${sibling}/stolen.webp` })).toThrow("escapes DATA_ROOT");
  });

  it("rejects a noncanonical owner/id mapping even when it remains under DATA_ROOT", () => {
    expect(() =>
      absoluteImagePath({
        id: "image-1",
        ownerId: "owner-1",
        path: "images/owner-2/image-1.webp",
      }),
    ).toThrow("not canonical");
  });

  it("rejects unsafe owner and image id segments when constructing paths", () => {
    expect(() => imageRelativePath("../owner", "image-1")).toThrow(ImagePathError);
    expect(() => imageRelativePath("owner-1", "folder/image-1")).toThrow(ImagePathError);
  });

  it.skipIf(!symlinksAvailable)("blocks a directory symlink escape", async () => {
    const ownerDir = path.join(root, "images", "owner-1");
    const outside = path.join(sandbox, "outside");
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(ownerDir, "linked"), "dir");

    expect(() => absoluteImagePath({ path: "images/owner-1/linked/secret.webp" })).toThrow("symbolic link");
  });

  it.skipIf(!symlinksAvailable)("blocks a final-file symlink escape", async () => {
    const ownerDir = path.join(root, "images", "owner-1");
    const outside = path.join(sandbox, "outside.webp");
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(ownerDir, "image-1.webp"), "file");

    expect(() => absoluteImagePath({ path: "images/owner-1/image-1.webp" })).toThrow("symbolic link");
  });
});
