import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { absoluteImagePath, dataRoot, imageRelativePath, writeWebpAtomic } from "./assets";
import { monogramSvg } from "./monogram";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vesper-images-"));
  process.env.DATA_ROOT = tmp;
});

afterEach(async () => {
  delete process.env.DATA_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
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
  async function png(): Promise<Buffer> {
    return sharp({
      create: { width: 8, height: 12, channels: 3, background: { r: 200, g: 80, b: 80 } },
    })
      .png()
      .toBuffer();
  }

  it("converts to webp, creates directories, and leaves no pending temp behind", async () => {
    const target = path.join(tmp, "images", "owner1", "img1.webp");

    const info = await writeWebpAtomic(target, await png());
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
    await expect(writeWebpAtomic(outside, await png())).rejects.toThrow("escapes DATA_ROOT");
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it("does not follow a pre-planted pending-file symlink", async () => {
    const ownerDir = path.join(tmp, "images", "owner1");
    const target = path.join(ownerDir, "img1.webp");
    const pending = path.join(ownerDir, "img1.pending.webp");
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.webp`);
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(outside, "untouched");
    await fs.symlink(outside, pending, "file");

    await expect(writeWebpAtomic(target, await png())).rejects.toThrow("symbolic link");
    expect(await fs.readFile(outside, "utf8")).toBe("untouched");
  });
});
