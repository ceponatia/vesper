import sharp from "sharp";
import { and, desc, eq } from "drizzle-orm";
import {
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
  type ImageLabControl,
  type ImageLabControlGenerator,
  type ImageLabControlKind,
  type ImageLabControlMeta,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { classifyImageFailure, runReplicatePreprocessor, type ReplicateImageResult, type ReplicatePreprocessorRequest } from "../ai";
import { db, images } from "../db";
import { createImageAsset, deleteOwnedImage, readImageBytes, SHARP_DECODE_LIMITS, type ImageRow } from "./assets";
import { saveOwnedImageBuffer } from "./route-safe";

/**
 * The Advanced Image Lab's control fixtures — the pose skeletons, depth maps and
 * edge maps a `control_probe` is run against
 * (qwen-advanced-image-subsystem.spec.md §"Control extraction").
 *
 * A fixture IS an image: a `lab_control` row with its provenance in
 * `images.meta`, riding the ordinary storage, the ordinary sweep and the
 * ordinary owner-scoped file route. Nothing here reaches a render lane, and a
 * fixture is never a player-visible asset — `lab_control` is a hidden kind.
 *
 * Three fixtures, two mechanisms. Pose and depth are PAID provider work: a
 * pinned preprocessor turns a portrait into a map, through the same Replicate
 * transport every render uses. Edge is computed in process with sharp, because
 * a Sobel pass costs nothing and paying a provider to run one would be a
 * strange bill to explain.
 *
 * The whole reason provenance is recorded rather than assumed: a probe that
 * reads `ignores_control` has to be able to rule out "the fixture was wrong"
 * before it rules on the model, and a hand-drawn skeleton and an extracted one
 * fail in different ways.
 */

/**
 * A pinned preprocessor, as a CONSTANT rather than a registry row.
 *
 * Preprocessors are lab tools, not player-facing image models: registering one
 * would put a skeleton renderer in every model picker in the app, hand it a
 * profile it has no use for, and invite a probe to rewrite its version. The pin
 * is deliberately unmovable — evidence extracted by "whatever the provider
 * called latest that hour" cannot be compared against evidence extracted last
 * week.
 */
export interface ImageLabPreprocessorPin {
  /** `owner/name` on Replicate. */
  slug: string;
  /** The exact version this lab runs, forever, until a human edits this file. */
  versionId: string;
  /** The provider's own key for the source image. */
  imageField: string;
  /** Literal extra inputs this version needs. */
  input?: Record<string, unknown>;
  /** The member of an object output carrying the map we asked for. */
  outputField?: string;
}

/**
 * Pose: OpenPose skeletons out of fofr's multi-preprocessor cog.
 *
 * Provenance: pinned 2026-08-10 from `GET /v1/models/fofr/controlnet-preprocessors`
 * (`latest_version.id`); its `openapi_schema` declares `image` (uri) in and an
 * array of uris out, with one boolean switch per preprocessor.
 *
 * EVERY switch is declared, and every one but `open_pose` is `false`, because
 * the cog defaults all fourteen to `true`: leaving them alone would run a dozen
 * preprocessors we did not ask for, bill for all of them, and return an
 * unlabelled array whose first element is whichever one the cog happened to
 * finish first. With one switch on, the array holds exactly the skeleton.
 */
export const IMAGE_LAB_POSE_PREPROCESSOR: ImageLabPreprocessorPin = {
  slug: "fofr/controlnet-preprocessors",
  versionId: "f6584ef76cf07a2014ffe1e9bdb1a5cfa714f031883ab43f8d4b05506625988e",
  imageField: "image",
  input: {
    open_pose: true,
    face_detector: false,
    canny: false,
    content: false,
    hed: false,
    leres: false,
    lineart: false,
    lineart_anime: false,
    midas: false,
    mlsd: false,
    normal_bae: false,
    pidi: false,
    sam: false,
  },
};

/**
 * Depth: Depth Anything v2, the estimator the spec names.
 *
 * Provenance: pinned 2026-08-10 from `GET /v1/models/chenxwh/depth-anything-v2`
 * (`latest_version.id`); its `openapi_schema` declares `image` (uri) in and an
 * OBJECT out with `grey_depth` and `color_depth` members, both uris.
 *
 * `grey_depth` is the one a control net reads — the colourized map is a human
 * visualization, and feeding it to a model as a depth control would be sending a
 * picture of a heat map rather than a depth map.
 */
export const IMAGE_LAB_DEPTH_PREPROCESSOR: ImageLabPreprocessorPin = {
  slug: "chenxwh/depth-anything-v2",
  versionId: "b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4",
  imageField: "image",
  outputField: "grey_depth",
};

/**
 * The preprocessor a control kind needs, or null when it needs none.
 *
 * EXHAUSTIVE over {@link ImageLabControlKind}, so a fourth fixture kind is a
 * compile error here rather than a silent "no preprocessor, must be local".
 */
export function imageLabPreprocessorFor(kind: ImageLabControlKind): ImageLabPreprocessorPin | null {
  switch (kind) {
    case "pose":
      return IMAGE_LAB_POSE_PREPROCESSOR;
    case "depth":
      return IMAGE_LAB_DEPTH_PREPROCESSOR;
    case "edge":
      return null;
  }
}

/** What produced a fixture of this kind through the extraction path. */
export function imageLabExtractionGenerator(kind: ImageLabControlKind): ImageLabControlGenerator {
  switch (kind) {
    case "pose":
      return "extracted_pose";
    case "depth":
      return "extracted_depth";
    case "edge":
      return "computed_edge";
  }
}

/**
 * One extraction's prediction budget. Generous relative to the work — a
 * preprocessor pass is seconds, not minutes — because a cold cog boot is the
 * slow part and paying for one that times out during boot is the worst of both
 * outcomes.
 */
const PREPROCESSOR_TIMEOUT_MS = 120_000;

/** How many fixtures the panel lists. A bench accumulates these slowly. */
const CONTROL_LIST_LIMIT = 200;

/**
 * Test-only override of the provider call; `null` restores the real
 * preprocessor. Process-local — the `setTrialRendererForTesting` seam shape, for
 * the same reason: the integration suite must be able to drive every extraction
 * outcome, undecodable output included, without a provider call.
 */
let injectedPreprocessor: ((request: ReplicatePreprocessorRequest) => Promise<ReplicateImageResult>) | null = null;

export function setImageLabPreprocessorForTesting(
  preprocessor: ((request: ReplicatePreprocessorRequest) => Promise<ReplicateImageResult>) | null,
): void {
  injectedPreprocessor = preprocessor;
}

function preprocessor(): (request: ReplicatePreprocessorRequest) => Promise<ReplicateImageResult> {
  return injectedPreprocessor ?? runReplicatePreprocessor;
}

/**
 * The Sobel pair, and their negations.
 *
 * Four convolutions rather than two because sharp's `convolve` clamps a
 * negative response to zero: `SOBEL_X` alone sees only one polarity of a
 * vertical edge, so a light-to-dark boundary would draw a line and its
 * dark-to-light neighbour would not. Adding all four responses recovers the
 * gradient magnitude closely enough for a control fixture, which is a line
 * drawing rather than a measurement.
 */
const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
const EDGE_KERNELS: readonly number[][] = [SOBEL_X, SOBEL_X.map(negate), SOBEL_Y, SOBEL_Y.map(negate)];

function negate(value: number): number {
  return -value;
}

/**
 * Where a summed gradient becomes a line. Low enough to keep a garment seam,
 * high enough that webp ringing and skin texture do not become a field of
 * static — an edge fixture full of noise controls nothing.
 */
const EDGE_THRESHOLD = 48;

/**
 * The edge map: grayscale, Sobel, threshold to white lines on black — the shape
 * every ControlNet edge conditioner expects.
 *
 * Exported so a pure test can run it over a generated buffer without a database
 * or a provider; the fixtures it produces are checked by decoding, never by
 * comparing bytes, because sharp's exact output moves with libvips versions.
 */
export async function computeImageLabEdgeMap(source: Buffer): Promise<Buffer> {
  const grey = await sharp(source, SHARP_DECODE_LIMITS).greyscale().png().toBuffer();
  const responses = await Promise.all(
    EDGE_KERNELS.map((kernel) =>
      sharp(grey, SHARP_DECODE_LIMITS)
        .convolve({ width: 3, height: 3, kernel: [...kernel] })
        .png()
        .toBuffer(),
    ),
  );
  const [first, ...rest] = responses;
  if (!first) throw new Error("edge map produced no convolution response");
  const summed = await sharp(first, SHARP_DECODE_LIMITS)
    .composite(rest.map((input) => ({ input, blend: "add" as const })))
    .png()
    .toBuffer();
  return await sharp(summed, SHARP_DECODE_LIMITS).greyscale().threshold(EDGE_THRESHOLD).png().toBuffer();
}

/** One owned image row, or null. The owner predicate is never optional here. */
async function ownedImageRow(imageId: string, ownerId: string): Promise<ImageRow | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

export interface RunImageLabControlExtractionInput {
  ownerId: string;
  /** The render a fixture is derived from. Owner-scoped; a foreign id is a miss. */
  sourceImageId: string;
  controlKinds: readonly ImageLabControlKind[];
  /** The admin's annotation, carried onto every fixture this call produces. */
  note?: string;
  sink?: DiagnosticSink;
}

/**
 * Extract one source image's fixtures — the body of one `lab_control_extract`
 * job (the route starts it; `src/server/images` cannot import `@/server/api`
 * without closing an import cycle, so the job seam lives at the route exactly as
 * it does for every other image lane).
 *
 * Every outcome is a RECORDED one. A kind that fails records its reason and the
 * next kind still runs, because an admin who asked for a skeleton and a depth
 * map should not lose the skeleton to the depth model having a bad afternoon.
 * Nothing here throws through the job runner.
 *
 * The return value becomes the job row's payload, which is why it is a plain
 * record: it is read by a human looking at `jobs`, not by code.
 */
export async function runImageLabControlExtraction(
  input: RunImageLabControlExtractionInput,
): Promise<Record<string, unknown>> {
  const { ownerId, sourceImageId, sink } = input;
  const source = await ownedImageRow(sourceImageId, ownerId);
  const bytes = source && source.status === "ready" ? await readImageBytes(source) : null;
  if (!bytes) {
    const code = imageLabDiagnosticCode("input_missing");
    sink?.push(
      diag("warn", code, "the source image for a control extraction could not be read", {
        context: { sourceImageId },
      }),
    );
    return { sourceImageId, extracted: [], failureCode: code };
  }

  const extracted: Record<string, unknown>[] = [];
  for (const controlKind of input.controlKinds) {
    extracted.push(await extractOneControl({ ...input, bytes, controlKind }));
  }
  return { sourceImageId, extracted };
}

interface ExtractOneControlInput extends RunImageLabControlExtractionInput {
  /** The source image's bytes, read once and reused across every requested kind. */
  bytes: Buffer;
  controlKind: ImageLabControlKind;
}

/**
 * One fixture.
 *
 * The two failure buckets are kept apart on purpose. A prediction that FAILED is
 * `render_failed` carrying the render classifier's own reading, because that is
 * a fact about the provider; bytes that came back and could not be decoded are
 * `preprocessor_output_invalid`, because that is a fact about the extractor. A
 * probe verdict re-examined months later needs to be able to tell "the depth
 * model was down" from "the depth model answered with something that was not an
 * image".
 *
 * No asset is written on either. The row is minted only once bytes exist and
 * have decoded, so a failed extraction leaves nothing for the sweep to reconcile.
 */
async function extractOneControl(input: ExtractOneControlInput): Promise<Record<string, unknown>> {
  const { ownerId, controlKind, sink } = input;
  const pin = imageLabPreprocessorFor(controlKind);
  const produced = pin === null ? await computeEdgeControl(input.bytes) : await runPreprocessorControl(pin, input.bytes);
  const provenance = produced.predictionId ? { predictionId: produced.predictionId } : {};

  if (!produced.ok) {
    return {
      ...extractionFailure(controlKind, produced.code, produced.message, sink, input.sourceImageId),
      ...(produced.renderFailure ? { renderFailure: produced.renderFailure } : {}),
      ...provenance,
    };
  }

  const meta: ImageLabControlMeta = {
    controlKind,
    generator: imageLabExtractionGenerator(controlKind),
    sourceImageId: input.sourceImageId,
    ...(pin ? { preprocessorSlug: pin.slug, preprocessorVersionId: pin.versionId } : {}),
    ...(input.note ? { reviewNote: input.note } : {}),
  };
  const stored = await storeControlFixture({ ownerId, meta, buffer: produced.buffer, sink });
  if (!stored) {
    return {
      ...extractionFailure(controlKind, "preprocessor_output_invalid", "the fixture could not be written", sink, input.sourceImageId),
      ...provenance,
    };
  }
  return { controlKind, imageId: stored.imageId, ...provenance };
}

/** Bytes for one fixture, or the reason there are none. */
type ProducedControlBytes =
  | { ok: true; buffer: Buffer; predictionId?: string }
  | {
      ok: false;
      code: "render_failed" | "preprocessor_output_invalid";
      message: string;
      predictionId?: string;
      /** The render classifier's reading — provider failures only. */
      renderFailure?: string;
    };

/** The local arm: sharp only, no provider, no spend. */
async function computeEdgeControl(bytes: Buffer): Promise<ProducedControlBytes> {
  try {
    return { ok: true, buffer: await computeImageLabEdgeMap(bytes) };
  } catch (err) {
    return { ok: false, code: "preprocessor_output_invalid", message: errorText(err) };
  }
}

/**
 * The provider arm, with the decode gate the spec demands: bytes the provider
 * called an image but sharp cannot read must not become a fixture, because the
 * failure would then surface as a broken tile in the panel weeks later instead
 * of as a reason here.
 */
async function runPreprocessorControl(pin: ImageLabPreprocessorPin, bytes: Buffer): Promise<ProducedControlBytes> {
  const result = await preprocessor()({
    slug: pin.slug,
    versionId: pin.versionId,
    image: bytes,
    imageField: pin.imageField,
    ...(pin.input ? { input: pin.input } : {}),
    ...(pin.outputField ? { outputField: pin.outputField } : {}),
    timeoutMs: PREPROCESSOR_TIMEOUT_MS,
  });
  const provenance = result.predictionId ? { predictionId: result.predictionId } : {};
  if (!result.ok || !result.image) {
    const message = result.error ?? `${pin.slug} returned no image`;
    return { ok: false, code: "render_failed", message, renderFailure: classifyImageFailure(message), ...provenance };
  }
  try {
    const metadata = await sharp(result.image, SHARP_DECODE_LIMITS).metadata();
    if (!metadata.width || !metadata.height) throw new Error("preprocessor output has no dimensions");
  } catch (err) {
    return { ok: false, code: "preprocessor_output_invalid", message: errorText(err), ...provenance };
  }
  return { ok: true, buffer: result.image, ...provenance };
}

/** The recorded shape of a failed extraction, plus its diagnostic. */
function extractionFailure(
  controlKind: ImageLabControlKind,
  code: "render_failed" | "preprocessor_output_invalid",
  message: string,
  sink: DiagnosticSink | undefined,
  sourceImageId: string,
): Record<string, unknown> {
  const failureCode = imageLabDiagnosticCode(code);
  sink?.push(diag("warn", failureCode, message.slice(0, 300), { context: { sourceImageId, controlKind } }));
  return { controlKind, failureCode, error: message.slice(0, 500) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface StoreControlFixtureInput {
  ownerId: string;
  meta: ImageLabControlMeta;
  buffer: Buffer;
  sink?: DiagnosticSink;
}

/**
 * Mint the `lab_control` row and write its bytes.
 *
 * The write goes through the OWNER-SCOPED adapter rather than the internal save,
 * even though the row was minted here with the same owner id one statement ago.
 * This module is the one a route's upload body reaches, and one save function
 * covering both of its write paths is worth more than the round trip the extra
 * ownership predicate costs — the alternative is two save functions in one file
 * and a reader having to work out which path is which.
 *
 * A write that does not reach `ready` removes the pending row rather than leaving
 * it `failed`: nothing points at it (the fixture id is only ever returned on
 * success), so a straggler would outlive every cleanup this lab has.
 */
async function storeControlFixture(input: StoreControlFixtureInput): Promise<ImageLabControl | null> {
  const asset = await createImageAsset({
    ownerId: input.ownerId,
    kind: "lab_control",
    prompt: `Advanced Image Lab ${input.meta.controlKind} fixture`,
    ...(input.meta.sourceImageId ? { sourceImageId: input.meta.sourceImageId } : {}),
    meta: { hidden: true, ...input.meta },
  });
  const saved = await saveOwnedImageBuffer(asset.id, input.ownerId, input.buffer, input.sink);
  if (saved?.status !== "ready") {
    await deleteOwnedImage(asset.id, input.ownerId, { kind: "lab_control" });
    return null;
  }
  return { imageId: saved.id, meta: input.meta, createdAt: saved.createdAt.toISOString() };
}

/**
 * Every fixture this admin owns, newest first — ids and metadata only, no bytes
 * and no URLs. The owner reads the pixels through the ordinary image file route,
 * exactly as the trial review UI does.
 *
 * A row whose meta will not parse is DROPPED rather than emptying the list
 * (docs/resilience.md §1, `parseRegistryRows`' rule): one unreadable fixture
 * costs its own tile, never the panel.
 */
export async function listImageLabControls(ownerId: string, sink?: DiagnosticSink): Promise<ImageLabControl[]> {
  const rows = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_control"), eq(images.status, "ready")))
    .orderBy(desc(images.createdAt))
    .limit(CONTROL_LIST_LIMIT);
  return rows.flatMap((row) => {
    const meta = parseOrNull(imageLabControlMetaSchema, row.meta, sink, "images.meta.lab_control");
    return meta ? [{ imageId: row.id, meta, createdAt: row.createdAt.toISOString() }] : [];
  });
}

export interface UploadImageLabControlInput {
  ownerId: string;
  controlKind: ImageLabControlKind;
  /** Decoded bytes from the route's data URL. */
  buffer: Buffer;
  /** What the skeleton was drawn over, when it was drawn over something. */
  sourceImageId?: string;
  note?: string;
  sink?: DiagnosticSink;
}

export type UploadImageLabControlResult = { ok: true; control: ImageLabControl } | { ok: false; error: string };

/**
 * Store a hand-authored fixture — a skeleton the admin drew.
 *
 * The generator is `hand_authored` and is NOT taken from the request: a client
 * that could name its own provenance could file a drawing as an extraction, and
 * provenance is exactly what a disputed probe verdict is re-examined against.
 *
 * `sourceImageId` is recorded but not resolved to a row. It is an annotation
 * ("drawn over the sofa shot"), and the FK-free `images.source_image_id` column
 * already treats it as one; a foreign id buys nothing, because nothing reads
 * bytes through it.
 */
export async function uploadImageLabControl(input: UploadImageLabControlInput): Promise<UploadImageLabControlResult> {
  const meta: ImageLabControlMeta = {
    controlKind: input.controlKind,
    generator: "hand_authored",
    ...(input.sourceImageId ? { sourceImageId: input.sourceImageId } : {}),
    ...(input.note ? { reviewNote: input.note } : {}),
  };
  const stored = await storeControlFixture({ ownerId: input.ownerId, meta, buffer: input.buffer, sink: input.sink });
  if (!stored) return { ok: false, error: "could not store that control fixture" };
  return { ok: true, control: stored };
}
