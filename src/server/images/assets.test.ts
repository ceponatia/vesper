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
  it("defaults to <cwd>/data and honors the DATA_ROOT override", () => {
    expect(dataRoot()).toBe(tmp);
    delete process.env.DATA_ROOT;
    expect(dataRoot()).toBe(path.join(process.cwd(), "data"));
  });

  it("derives the canonical relative path and resolves it against the root", () => {
    expect(imageRelativePath("owner1", "img1")).toBe("images/owner1/img1.webp");
    expect(absoluteImagePath({ path: "images/owner1/img1.webp" })).toBe(path.join(tmp, "images/owner1/img1.webp"));
  });
});

describe("writeWebpAtomic", () => {
  it("converts to webp, creates directories, and leaves no pending temp behind", async () => {
    const png = await sharp({
      create: { width: 8, height: 12, channels: 3, background: { r: 200, g: 80, b: 80 } },
    })
      .png()
      .toBuffer();
    const target = path.join(tmp, "images", "owner1", "img1.webp");

    const info = await writeWebpAtomic(target, png);
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
});
