import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageModelSchema } from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { testPngBuffer } from "@/server/test-support";
import {
  prepareRenderReferences,
  type ReferencePreparationTarget,
  referencePreparationTarget,
} from "./reference-preparation";

/**
 * Fixtures are built with sharp, like `png-fixtures.ts`, because every
 * assertion here is about what a REAL raster comes out as — orientation tags,
 * alpha channels and EXIF blocks cannot be faked with a hand-written header.
 */

const WEBP_TARGET: ReferencePreparationTarget = { format: "webp", maxEdgePx: null };
const JPEG_TARGET: ReferencePreparationTarget = { format: "jpeg", maxEdgePx: null };

/** An 8×12 JPEG whose EXIF says "rotate 90°" — displayed correctly it is 12×8. */
async function orientedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 200, g: 80, b: 80 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

/** A fully transparent red square — the flatten discriminator: white if flattened, red if merely stripped. */
async function transparentPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
}

async function prepareOne(buffer: Buffer, target: ReferencePreparationTarget, sink?: DiagnosticCollector) {
  const [reference] = await prepareRenderReferences([{ buffer, role: "identity" }], target, sink);
  if (!reference) throw new Error("preparation returned nothing");
  return reference;
}

describe("referencePreparationTarget", () => {
  it("is webp with no resize limit for every model today", () => {
    // No binding declares an accepted-format list or a dimension limit yet; the
    // function is the seam those facts will land in, not a per-model branch.
    // `outputFormat` says what the model PRODUCES, so it must not leak in.
    const model = imageModelSchema.parse({
      id: "m1",
      slug: "owner/model-a",
      label: "Model A",
      canGenerate: true,
      canEdit: true,
      outputFormat: "png",
    });
    expect(referencePreparationTarget(model)).toEqual({ format: "webp", maxEdgePx: null });
  });
});

describe("prepareRenderReferences", () => {
  it("applies EXIF orientation, so the provider sees upright pixels", async () => {
    const reference = await prepareOne(await orientedJpeg(), WEBP_TARGET);
    // The 8×12 raster carries "rotate 90°": applied, it becomes 12×8.
    expect(reference.width).toBe(12);
    expect(reference.height).toBe(8);
    const meta = await sharp(reference.bytes).metadata();
    expect(meta.width).toBe(12);
    expect(meta.orientation).toBeUndefined();
  });

  it("strips metadata and encodes to the target format", async () => {
    const reference = await prepareOne(await orientedJpeg(), WEBP_TARGET);
    expect(reference.mediaType).toBe("image/webp");
    expect(reference.extension).toBe("webp");
    expect(reference.role).toBe("identity");
    const meta = await sharp(reference.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
  });

  it("keeps alpha for an alpha-capable target", async () => {
    const reference = await prepareOne(await transparentPng(), WEBP_TARGET);
    // A mask's transparency is signal; webp can carry it, so it survives.
    expect((await sharp(reference.bytes).metadata()).hasAlpha).toBe(true);
  });

  it("flattens onto white ONLY when the target cannot carry alpha", async () => {
    const reference = await prepareOne(await transparentPng(), JPEG_TARGET);
    const meta = await sharp(reference.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBeFalsy();
    // The fixture is fully transparent RED: a white pixel proves the flatten
    // ran; a red one would mean the alpha channel was dropped, not composited.
    const pixels = await sharp(reference.bytes).raw().toBuffer();
    expect(pixels[0]).toBeGreaterThan(240);
    expect(pixels[1]).toBeGreaterThan(240);
    expect(pixels[2]).toBeGreaterThan(240);
  });

  it("degrades an unreadable reference to its ORIGINAL bytes with a warn diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const garbage = Buffer.from("not an image at all");
    const reference = await prepareOne(garbage, WEBP_TARGET, sink);
    // The same object, not a copy: degraded means untouched.
    expect(reference.bytes).toBe(garbage);
    expect(reference.width).toBeNull();
    expect(reference.height).toBeNull();
    expect(reference.role).toBe("identity");
    // Unrecognizable bytes fall back to the stored-asset default — exactly the
    // label every reference carried before preparation existed.
    expect(reference.mediaType).toBe("image/webp");
    expect(sink.items.map((entry) => ({ severity: entry.severity, code: entry.code }))).toEqual([
      { severity: "warn", code: "image_model.reference_preparation_failed" },
    ]);
  });

  it("sniffs the degraded media type from the bytes' own magic numbers", async () => {
    const sink = new DiagnosticCollector();
    // A real PNG truncated mid-stream: the header is honest, the pixels gone.
    const truncated = (await testPngBuffer()).subarray(0, 24);
    const reference = await prepareOne(truncated, WEBP_TARGET, sink);
    expect(reference.bytes).toBe(truncated);
    expect(reference.mediaType).toBe("image/png");
    expect(reference.extension).toBe("png");
    expect(sink.items.map((entry) => entry.code)).toEqual(["image_model.reference_preparation_failed"]);
  });

  it("prepares a list in order, one result per input", async () => {
    const results = await prepareRenderReferences(
      [
        { buffer: await testPngBuffer(), role: "identity" },
        { buffer: await transparentPng(), role: "pose_image" },
      ],
      WEBP_TARGET,
    );
    expect(results.map((reference) => reference.role)).toEqual(["identity", "pose_image"]);
    expect(results.every((reference) => reference.mediaType === "image/webp")).toBe(true);
  });
});
