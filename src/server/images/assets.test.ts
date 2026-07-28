import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { canCreateSymlinks, testPngBuffer, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { absoluteImagePath, dataRoot, imageRelativePath, writeWebpAtomic } from "./assets";
import { monogramSvg } from "./monogram";

const symlinksAvailable = canCreateSymlinks();

let sandbox: TempDataRoot;
let tmp: string;

beforeEach(async () => {
  sandbox = await withTempDataRoot("vesper-images");
  tmp = sandbox.root;
});

afterEach(async () => {
  await sandbox.cleanup();
});

describe("dataRoot / paths", () => {
  it("defaults to an absolute <cwd>/data path and honors the DATA_ROOT override", () => {
    expect(dataRoot()).toBe(tmp);
    expect(path.isAbsolute(dataRoot())).toBe(true);
    delete process.env.DATA_ROOT;
    expect(dataRoot()).toBe(path.resolve(process.cwd(), "data"));
  });

  it("derives the canonical relative path and resolves it against the root", () => {
    expect(imageRelativePath("owner1", "img1")).toBe("images/owner1/img1.webp");
    expect(absoluteImagePath({ path: "images/owner1/img1.webp" })).toBe(path.join(tmp, "images/owner1/img1.webp"));
  });
});

describe("writeWebpAtomic", () => {
  it("converts to webp, creates directories, and leaves no pending temp behind", async () => {
    const target = path.join(tmp, "images", "owner1", "img1.webp");

    const info = await writeWebpAtomic(target, await testPngBuffer());
    expect(info).toMatchObject({ width: 8, height: 12 });
    expect(info.bytes).toBeGreaterThan(0);

    const written = await fs.readFile(target);
    expect((await sharp(written).metadata()).format).toBe("webp");
    const siblings = await fs.readdir(path.dirname(target));
    expect(siblings).toEqual(["img1.webp"]);
  });

  it("rasterizes SVG monograms (the demo-mode pipeline input)", async () => {
    const target = path.join(tmp, "images", "owner1", "mono.webp");
    const info = await writeWebpAtomic(target, monogramSvg("Mira Vale"));
    expect(info.width).toBe(768);
    expect(info.height).toBe(1024);
  });

  it("rejects garbage input without leaving partial files", async () => {
    const target = path.join(tmp, "images", "owner1", "bad.webp");
    await expect(writeWebpAtomic(target, Buffer.from("not an image"))).rejects.toThrow();
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("rejects writes outside DATA_ROOT", async () => {
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside`, "escape.webp");
    await expect(writeWebpAtomic(outside, await testPngBuffer())).rejects.toThrow("escapes DATA_ROOT");
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it.skipIf(!symlinksAvailable)("does not follow a pre-planted pending-file symlink", async () => {
    const ownerDir = path.join(tmp, "images", "owner1");
    const target = path.join(ownerDir, "img1.webp");
    const pending = path.join(ownerDir, "img1.pending.webp");
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.webp`);
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(outside, "untouched");
    await fs.symlink(outside, pending, "file");

    await expect(writeWebpAtomic(target, await testPngBuffer())).rejects.toThrow("symbolic link");
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });
});
