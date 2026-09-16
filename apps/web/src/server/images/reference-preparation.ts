import sharp from "sharp";
import type { ImageModel } from "@vesper/image-core";
import { imageModelProvider } from "@vesper/image-models";
import type { PreparedReferenceBytes } from "@vesper/image-replicate";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { SHARP_DECODE_LIMITS, WEBP_QUALITY } from "./asset-storage";

/**
 * Reference preparation ahead of transport: the sharp pass every reference and
 * control image crosses in
 * `renderWithModel` before its bytes reach `@vesper/image-replicate`.
 *
 * It lives here rather than in a package because sharp execution is Node-only
 * application infrastructure (the `identity-pack-preparation.ts` precedent);
 * what the pass produces — bytes plus the media type and extension the
 * transport stamps on uploads and data URIs — is the package's
 * `PreparedReferenceBytes` contract.
 *
 * The pass normalizes rather than trusts: EXIF orientation is applied (a
 * provider reading raw pixels would render a sideways reference), metadata is
 * stripped (camera serials and GPS tags have no business reaching a provider),
 * and the bytes are re-encoded to a format the model accepts. Stored Vesper
 * assets are webp today, but masks and external control images may not be —
 * which is exactly why the media type is resolved here instead of hardcoded at
 * the transport. A buffer that already satisfies the target — clean webp, no
 * orientation to apply, no resize due — ships its ORIGINAL bytes
 * ({@link webpPassthrough}): re-encoding it would cost a generation of fidelity
 * to produce nothing the transport needs.
 */

/** The encodings preparation can produce. Not every provider reads all three. */
export type ReferenceImageFormat = "webp" | "jpeg" | "png";

/**
 * What preparation encodes toward for one model.
 *
 * Derived per model ({@link referencePreparationTarget}) so a provider's format
 * constraint has one seam to land in.
 */
export interface ReferencePreparationTarget {
  format: ReferenceImageFormat;
  /**
   * Longest-edge ceiling a provider limit demands, or null when none does.
   * Null for every model today — the seam exists so a real limit becomes a
   * data edit here, not so this module can invent one.
   */
  maxEdgePx: number | null;
  /**
   * Whether {@link format} is the only encoding the provider can render from.
   *
   * When true, preparation may not degrade to unconverted bytes in another
   * format ({@link prepareOneReference}): for such a provider an unprepared
   * reference is not a fidelity cost, it is the render.
   */
  formatRequired: boolean;
}

/**
 * The target for one model's references.
 *
 * `model.outputFormat` deliberately does not participate — it describes what the
 * model PRODUCES, not what it reads.
 *
 * Civitai is the exception to the webp default, and it is a SILENT one. Its
 * orchestration accepts a webp data URI at every checkpoint that could refuse
 * it — the upload ingests to a blob, the `whatif` preflight passes, the workflow
 * schedules — and then the render job ends `failed` with no error, no reason, no
 * blocked flag, and a full Buzz refund. Measured 2026-09-16 on Klein 4B: the
 * identical image, prompt, sampling, LoRA and seed submitted as two concurrent
 * workflows succeeded from a jpeg data URI (`5910720-20260916202815148`) and
 * failed from the webp original (`5910720-20260916202815077`). Three earlier
 * Image Generator runs had failed the same way while every direct jpeg probe of
 * the same endpoint succeeded, which is what isolated the encoding.
 *
 * jpeg rather than png because jpeg is what those successful renders used; png
 * is untested against this provider and an alpha-carrying reference has nothing
 * to preserve here anyway — the edit operation composites over opaque pixels.
 */
export function referencePreparationTarget(model: ImageModel): ReferencePreparationTarget {
  return imageModelProvider(model.slug) === "civitai"
    ? { format: "jpeg", maxEdgePx: null, formatRequired: true }
    : { format: "webp", maxEdgePx: null, formatRequired: false };
}

/** One image awaiting preparation, with the caller's name for what it is. */
export interface RenderReferenceInput {
  buffer: Buffer;
  /** A reference role or bound control field — diagnostic label, nothing more. */
  role: string;
}

export interface PreparedRenderReference extends PreparedReferenceBytes {
  role: string;
  /** Post-preparation pixel size; null when preparation degraded to the original bytes. */
  width: number | null;
  height: number | null;
}

/** Per-format transport facts, and whether flattening is needed at all. */
const FORMAT_FACTS: Record<ReferenceImageFormat, { mediaType: string; extension: string; acceptsAlpha: boolean }> = {
  webp: { mediaType: "image/webp", extension: "webp", acceptsAlpha: true },
  jpeg: { mediaType: "image/jpeg", extension: "jpg", acceptsAlpha: false },
  png: { mediaType: "image/png", extension: "png", acceptsAlpha: true },
};

/**
 * Prepare a list of reference images for transport, in order.
 *
 * Sequential on purpose: sharp already parallelizes each operation across its
 * own thread pool, and a render's references are a handful of images — queueing
 * them keeps peak memory at one decoded raster instead of several.
 *
 * A reference whose preparation FAILS degrades to its original bytes with a
 * warn diagnostic rather than failing the render (docs/resilience.md): an
 * unnormalized reference costs at worst some fidelity, a refused render costs
 * the image. The degraded media type is sniffed from the bytes' own magic
 * numbers, falling back to webp — the stored-asset format, and exactly what
 * every reference was labeled before preparation existed.
 *
 * That trade reverses when the target's format is REQUIRED: bytes a provider
 * cannot read are not a degraded render, they are a failed one, and Civitai
 * charges for the attempt before refunding it without ever saying why. So a
 * required-format target whose original bytes are in another encoding throws
 * instead, and the render fails where it can be read as a failure.
 */
export async function prepareRenderReferences(
  inputs: readonly RenderReferenceInput[],
  target: ReferencePreparationTarget,
  sink?: DiagnosticSink,
): Promise<PreparedRenderReference[]> {
  const prepared: PreparedRenderReference[] = [];
  for (const input of inputs) {
    prepared.push(await prepareOneReference(input, target, sink));
  }
  return prepared;
}

async function prepareOneReference(
  input: RenderReferenceInput,
  target: ReferencePreparationTarget,
  sink?: DiagnosticSink,
): Promise<PreparedRenderReference> {
  const facts = FORMAT_FACTS[target.format];
  try {
    // The cheap fast path: a stored Vesper asset is ALREADY a normalized webp,
    // and re-encoding it costs a decode, a lossy re-encode, and a generation of
    // fidelity for nothing. When the bytes are webp, no EXIF orientation needs
    // applying, and the target demands neither a format change nor a resize,
    // the ORIGINAL bytes ship with the metadata's own dimensions. Everything
    // else — another format, an orientation to apply, a resize, an animated
    // buffer the full pass would flatten — takes the full pipeline below.
    const passthrough = await webpPassthrough(input, target);
    if (passthrough) return passthrough;
    // `.rotate()` with no argument applies the EXIF orientation and drops the
    // tag; encoding without `.withMetadata()` is what strips everything else.
    let pipeline = sharp(input.buffer, SHARP_DECODE_LIMITS).rotate();
    if (target.maxEdgePx !== null) {
      pipeline = pipeline.resize({
        width: target.maxEdgePx,
        height: target.maxEdgePx,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    // Flatten ONLY when the target cannot carry alpha: a mask's transparency is
    // signal, and discarding it for a format that keeps it would be data loss
    // for tidiness. White matches what a provider compositing a transparent
    // reference over a light canvas expects; black would read as ink.
    if (!facts.acceptsAlpha) pipeline = pipeline.flatten({ background: "#ffffff" });
    const { data, info } = await encodeReference(pipeline, target.format).toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      mediaType: facts.mediaType,
      extension: facts.extension,
      role: input.role,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    const sniffed = sniffImageMediaType(input.buffer);
    if (target.formatRequired && sniffed?.mediaType !== facts.mediaType) {
      sink?.push(
        diag("error", "image_model.reference_preparation_failed", "a reference could not be encoded to the format this provider requires", {
          path: "image_models",
          context: { role: input.role, format: target.format, error: error instanceof Error ? error.message : String(error) },
        }),
      );
      throw new Error(`Reference "${input.role}" could not be encoded to ${target.format}, which this model requires`);
    }
    sink?.push(
      diag("warn", "image_model.reference_preparation_failed", "a reference could not be prepared; sending its original bytes", {
        path: "image_models",
        context: { role: input.role, error: error instanceof Error ? error.message : String(error) },
      }),
    );
    return {
      bytes: input.buffer,
      mediaType: sniffed?.mediaType ?? "image/webp",
      extension: sniffed?.extension ?? "webp",
      role: input.role,
      width: null,
      height: null,
    };
  }
}

/**
 * The already-prepared answer, or null when the full pipeline must run.
 *
 * One metadata sniff, no decode. Every condition is a "nothing to do" check:
 * webp target, webp bytes, a single frame (the full pass flattens animation via
 * `animated: false`, so passing an animated buffer through would CHANGE what the
 * provider sees relative to today), no EXIF orientation to apply (absent or the
 * identity `1`), real dimensions to report, and no resize demanded by the
 * target's edge ceiling. Any metadata the buffer carries stays — these are
 * Vesper's own stored bytes, already stripped at storage time, and a
 * generational re-encode is the greater loss. A sniff that throws falls through
 * to the full pipeline, whose own catch owns degradation.
 */
async function webpPassthrough(
  input: RenderReferenceInput,
  target: ReferencePreparationTarget,
): Promise<PreparedRenderReference | null> {
  if (target.format !== "webp") return null;
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input.buffer, SHARP_DECODE_LIMITS).metadata();
  } catch {
    return null;
  }
  if (meta.format !== "webp" || (meta.pages ?? 1) > 1) return null;
  if (meta.orientation !== undefined && meta.orientation !== 1) return null;
  const { width, height } = meta;
  if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) return null;
  if (target.maxEdgePx !== null && (width > target.maxEdgePx || height > target.maxEdgePx)) return null;
  return {
    bytes: input.buffer,
    mediaType: FORMAT_FACTS.webp.mediaType,
    extension: FORMAT_FACTS.webp.extension,
    role: input.role,
    width,
    height,
  };
}

/** The encoder for one target format, at `writeWebpAtomic`'s storage quality —
 * preparation must not cost more fidelity than storage does. PNG is lossless
 * and takes no quality. */
function encodeReference(pipeline: sharp.Sharp, format: ReferenceImageFormat): sharp.Sharp {
  switch (format) {
    case "webp":
      return pipeline.webp({ quality: WEBP_QUALITY });
    case "jpeg":
      return pipeline.jpeg({ quality: WEBP_QUALITY });
    case "png":
      return pipeline.png();
  }
}

/**
 * Magic-number sniff for the degraded path only — the formats models accept,
 * nothing more. Null means "unrecognized", which the caller maps to the stored
 * default rather than guessing here.
 */
function sniffImageMediaType(buffer: Buffer): { mediaType: string; extension: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mediaType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
    return { mediaType: "image/webp", extension: "webp" };
  }
  return null;
}
