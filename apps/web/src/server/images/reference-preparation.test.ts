import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { imageModelSchema } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";
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

const WEBP_TARGET: ReferencePreparationTarget = { format: "webp", maxEdgePx: null, formatRequired: false };
const JPEG_TARGET: ReferencePreparationTarget = { format: "jpeg", maxEdgePx: null, formatRequired: false };

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
  const row = (slug: string) =>
    imageModelSchema.parse({
      id: "m1",
      slug,
      label: "Model A",
      canGenerate: true,
      canEdit: true,
      outputFormat: "png",
    });

  it("is webp with no resize limit for a Replicate-native model", () => {
    // No binding declares a dimension limit yet, and `outputFormat` says what
    // the model PRODUCES, so it must not leak in.
    expect(referencePreparationTarget(row("owner/model-a"))).toEqual({
      format: "webp", maxEdgePx: null, formatRequired: false,
    });
  });

  it("is a REQUIRED jpeg for Civitai, which fails silently on webp", () => {
    // Measured 2026-09-16: the same image, prompt, sampling and LoRA rendered
    // from a jpeg data URI and failed — terminal `failed`, no reason, full
    // refund — from the webp original. Keyed on the provider rather than the
    // one slug because the constraint belongs to the orchestration endpoint.
    expect(referencePreparationTarget(row(CIVITAI_FLUX2_KLEIN4B_SLUG))).toEqual({
      format: "jpeg", maxEdgePx: null, formatRequired: true,
    });
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

  it("passes an already-clean webp through byte-identical — no decode, no generational loss", async () => {
    const clean = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 40, g: 90, b: 200 } } })
      .webp()
      .toBuffer();
    const reference = await prepareOne(clean, WEBP_TARGET);
    // The SAME object: a re-encode of stored webp bytes would cost a generation
    // of fidelity to produce nothing the transport needs.
    expect(reference.bytes).toBe(clean);
    expect(reference.mediaType).toBe("image/webp");
    expect(reference.extension).toBe("webp");
    expect(reference.width).toBe(8);
    expect(reference.height).toBe(12);
  });

  it("still rewrites a webp that carries an EXIF orientation", async () => {
    const oriented = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 200, g: 80, b: 80 } } })
      .webp()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const reference = await prepareOne(oriented, WEBP_TARGET);
    // A provider reading raw pixels would render it sideways, so the fast path
    // must refuse it: the orientation is applied and the tag dropped.
    expect(reference.bytes).not.toBe(oriented);
    expect(reference.width).toBe(12);
    expect(reference.height).toBe(8);
    expect((await sharp(reference.bytes).metadata()).orientation).toBeUndefined();
  });

  it("still converts a png — the fast path is webp-to-webp only", async () => {
    const png = await testPngBuffer();
    const reference = await prepareOne(png, WEBP_TARGET);
    expect(reference.bytes).not.toBe(png);
    expect(reference.mediaType).toBe("image/webp");
    expect((await sharp(reference.bytes).metadata()).format).toBe("webp");
  });

  it("still resizes a clean webp when the target demands it — and only then", async () => {
    const clean = await sharp({ create: { width: 8, height: 12, channels: 3, background: { r: 40, g: 90, b: 200 } } })
      .webp()
      .toBuffer();
    const shrunk = await prepareOne(clean, { format: "webp", maxEdgePx: 6 });
    expect(shrunk.bytes).not.toBe(clean);
    expect(shrunk.width).toBeLessThanOrEqual(6);
    expect(shrunk.height).toBeLessThanOrEqual(6);
    // A ceiling the image already fits under demands nothing: passthrough.
    const roomy = await prepareOne(clean, { format: "webp", maxEdgePx: 100 });
    expect(roomy.bytes).toBe(clean);
  });

  it("REFUSES to degrade when the target format is required and the bytes are not already in it", async () => {
    const sink = new DiagnosticCollector();
    const garbage = Buffer.from("not an image at all");
    // Civitai renders nothing from webp and says nothing about why, so shipping
    // unconverted bytes would buy a silent failure and a refund instead of a
    // render. The failure belongs where it can be read as one.
    await expect(
      prepareOne(garbage, { format: "jpeg", maxEdgePx: null, formatRequired: true }, sink),
    ).rejects.toThrow(/could not be encoded to jpeg/);
    expect(sink.items.map((entry) => ({ severity: entry.severity, code: entry.code }))).toEqual([
      { severity: "error", code: "image_model.reference_preparation_failed" },
    ]);
  });

  it("still degrades under a required format when the ORIGINAL bytes already satisfy it", async () => {
    const sink = new DiagnosticCollector();
    // A real JPEG truncated mid-stream: sharp cannot re-encode it, but what the
    // provider would receive is already the encoding it requires, so the
    // ordinary fidelity trade applies and the render proceeds.
    const truncated = (await orientedJpeg()).subarray(0, 40);
    const reference = await prepareOne(truncated, { format: "jpeg", maxEdgePx: null, formatRequired: true }, sink);
    expect(reference.bytes).toBe(truncated);
    expect(reference.mediaType).toBe("image/jpeg");
    expect(sink.items.map((entry) => entry.severity)).toEqual(["warn"]);
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
