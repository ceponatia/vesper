import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { sha256Hex } from "./redact.mjs";

const MEDIA_TYPES = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * `sha256` hashes the file bytes; `pixelSha256` hashes the decoded pixels.
 * Civitai embeds a per-image UUID in the JPEG's EXIF block, so two renders
 * with identical pixels never share a file hash (T1.1, 2026-09-17) — the
 * pixel hash is the determinism metric.
 */
export async function fileInfo(file) {
  const bytes = readFileSync(file);
  const meta = await sharp(bytes).metadata();
  const raw = await sharp(bytes).removeAlpha().raw().toBuffer();
  return {
    file,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    pixelSha256: sha256Hex(raw),
    width: meta.width ?? null,
    height: meta.height ?? null,
    format: meta.format ?? null,
    mediaType: MEDIA_TYPES[meta.format] ?? null,
  };
}

/**
 * Prepare one reference fixture as a JPEG. Civitai's Klein lane fails
 * silently on webp references (#626), so every reference the harness sends is
 * re-encoded here. `maxEdgePx` bounds the long edge (never enlarging unless
 * `allowEnlargement`), and an optional `crop` (source pixels) is applied first.
 */
export async function prepareReference(key, spec, outDir) {
  mkdirSync(outDir, { recursive: true });
  const source = readFileSync(spec.source);
  let pipeline = sharp(source).rotate();
  if (spec.crop) pipeline = pipeline.extract(spec.crop);
  if (spec.maxEdgePx) {
    pipeline = pipeline.resize({
      width: spec.maxEdgePx,
      height: spec.maxEdgePx,
      fit: "inside",
      withoutEnlargement: spec.allowEnlargement !== true,
    });
  }
  const quality = spec.quality ?? 92;
  const encoded = await pipeline.jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
  const meta = await sharp(encoded).metadata();
  const file = path.join(outDir, `${key}.jpg`);
  writeFileSync(file, encoded);
  return {
    key,
    file,
    source: spec.source,
    sourceSha256: sha256Hex(source),
    sha256: sha256Hex(encoded),
    bytes: encoded.length,
    width: meta.width,
    height: meta.height,
    mediaType: "image/jpeg",
    quality,
    crop: spec.crop ?? null,
    maxEdgePx: spec.maxEdgePx ?? null,
    dataUrl: `data:image/jpeg;base64,${encoded.toString("base64")}`,
  };
}

/** 64-bit difference hash (9x8 grayscale), hex encoded. */
export async function dhash(bytesOrFile) {
  const input = Buffer.isBuffer(bytesOrFile) ? bytesOrFile : readFileSync(bytesOrFile);
  const { data } = await sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits += left > right ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export function hammingHex(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Determinism / A-B comparison of two images. */
export async function compareImages(fileA, fileB) {
  const a = readFileSync(fileA);
  const b = readFileSync(fileB);
  const shaA = sha256Hex(a);
  const shaB = sha256Hex(b);
  const rawA = await sharp(a).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawB = await sharp(b).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sameDimensions = rawA.info.width === rawB.info.width && rawA.info.height === rawB.info.height && rawA.info.channels === rawB.info.channels;
  let pixelIdentical = false;
  let meanAbsDiff = null;
  let maxAbsDiff = null;
  let differingPixelShare = null;
  if (sameDimensions) {
    let sum = 0;
    let max = 0;
    let differing = 0;
    const channels = rawA.info.channels;
    for (let i = 0; i < rawA.data.length; i += channels) {
      let pixelDiff = 0;
      for (let c = 0; c < channels; c += 1) {
        const d = Math.abs(rawA.data[i + c] - rawB.data[i + c]);
        sum += d;
        if (d > max) max = d;
        if (d > pixelDiff) pixelDiff = d;
      }
      if (pixelDiff > 0) differing += 1;
    }
    meanAbsDiff = sum / rawA.data.length;
    maxAbsDiff = max;
    differingPixelShare = differing / (rawA.data.length / channels);
    pixelIdentical = max === 0;
  }
  const hashA = await dhash(a);
  const hashB = await dhash(b);
  return {
    a: { file: fileA, sha256: shaA, width: rawA.info.width, height: rawA.info.height, dhash: hashA },
    b: { file: fileB, sha256: shaB, width: rawB.info.width, height: rawB.info.height, dhash: hashB },
    sameSha256: shaA === shaB,
    sameDimensions,
    pixelIdentical,
    meanAbsDiff,
    maxAbsDiff,
    differingPixelShare,
    dhashDistance: hammingHex(hashA, hashB),
  };
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Labelled contact sheet grouped by one experimental variable. Each cell is a
 * `{ file, label }`; missing files render as a grey placeholder so a failed arm
 * stays visible in the grid instead of shifting the others.
 */
export async function contactSheet({ cells, out, columns = 4, cellWidth = 416, cellHeight = 624, labelHeight = 44, title = "" }) {
  const titleHeight = title ? 48 : 0;
  const rows = Math.ceil(cells.length / columns);
  const width = columns * cellWidth;
  const height = titleHeight + rows * (cellHeight + labelHeight);
  const composites = [];
  if (title) {
    const svg = `<svg width="${width}" height="${titleHeight}"><rect width="100%" height="100%" fill="#111"/><text x="12" y="32" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="#fff">${escapeXml(title)}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  for (const [index, cell] of cells.entries()) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const left = col * cellWidth;
    const top = titleHeight + row * (cellHeight + labelHeight);
    let tile;
    if (cell.file) {
      try {
        let pipeline = sharp(readFileSync(cell.file));
        if (cell.crop) {
          // crop as fractions of the source: { left, top, width, height } in 0..1
          const meta = await pipeline.metadata();
          const left = Math.round((cell.crop.left ?? 0) * meta.width);
          const top = Math.round((cell.crop.top ?? 0) * meta.height);
          const width = Math.min(meta.width - left, Math.round((cell.crop.width ?? 1) * meta.width));
          const height = Math.min(meta.height - top, Math.round((cell.crop.height ?? 1) * meta.height));
          pipeline = pipeline.extract({ left, top, width, height });
        }
        tile = await pipeline
          .resize({ width: cellWidth, height: cellHeight, fit: "contain", background: "#202020" })
          .png()
          .toBuffer();
      } catch {
        tile = null;
      }
    }
    if (!tile) {
      tile = await sharp({ create: { width: cellWidth, height: cellHeight, channels: 3, background: "#3a3a3a" } }).png().toBuffer();
    }
    composites.push({ input: tile, left, top });
    const lines = String(cell.label ?? "").split("\n").slice(0, 2);
    const text = lines.map((line, i) => `<text x="8" y="${18 + i * 18}" font-family="DejaVu Sans Mono, monospace" font-size="14" fill="#fff">${escapeXml(line)}</text>`).join("");
    const svg = `<svg width="${cellWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#000"/>${text}</svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + cellHeight });
  }
  mkdirSync(path.dirname(out), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: "#000" } }).composite(composites).png().toFile(out);
  return { out, width, height, cells: cells.length };
}
