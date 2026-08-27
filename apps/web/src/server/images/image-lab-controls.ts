import sharp from "sharp";
import { and, desc, eq } from "drizzle-orm";
import {
  imageFailureHealthOutcome,
  type ImageFailureReason,
  type ImageLabControl,
  type ImageLabControlGenerator,
  type ImageLabControlKind,
  type ImageLabControlMeta,
  imageLabControlMetaSchema,
  imageLabDiagnosticCode,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import type { ReplicateImageResult, ReplicatePreprocessorRequest } from "@vesper/image-replicate";
import { classifyImageFailure, replicateClient } from "../ai";
import { db, images } from "../db";
import { createImageAsset, deleteOwnedImage, imageMeta, readImageBytes, SHARP_DECODE_LIMITS } from "./assets";
import { ownedImageRow } from "./owned-image-reads";
import type { ImageLabProviderOutcome, ImageLabRefusal, ImageLabRunPayload } from "./image-lab-store";
import { saveOwnedImageBuffer } from "./route-safe";

/**
 * The Advanced Image Lab's control fixtures — the pose skeletons, depth maps and
 * edge maps a `control_probe` is run against.
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
  return injectedPreprocessor ?? ((request) => replicateClient().runReplicatePreprocessor(request));
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

export interface RunImageLabControlExtractionInput {
  ownerId: string;
  /** The render a fixture is derived from. Owner-scoped; a foreign id is a miss. */
  sourceImageId: string;
  controlKinds: readonly ImageLabControlKind[];
  /** The admin's annotation, carried onto every fixture this call produces as its
   * `originNote` — what the extraction was for, which no later review overwrites. */
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
 * The return value becomes the job row's payload, which is why it is a mostly
 * plain record: it is read by a human looking at `jobs`, and by the route for
 * the one field the settled promise cannot carry — `providerOutcome`, since a
 * runner that records its own failures resolves whatever the provider did.
 */
export async function runImageLabControlExtraction(
  input: RunImageLabControlExtractionInput,
): Promise<ImageLabRunPayload> {
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
    return { sourceImageId, extracted: [], failureCode: code, providerOutcome: null };
  }

  const extracted: Record<string, unknown>[] = [];
  const outcomes: ImageLabProviderOutcome[] = [];
  for (const controlKind of input.controlKinds) {
    const one = await extractOneControl({ ...input, bytes, controlKind });
    extracted.push(one.record);
    outcomes.push(one.providerOutcome);
  }
  return { sourceImageId, extracted, providerOutcome: batchProviderOutcome(outcomes) };
}

/**
 * One report for a batch that may have called the provider several times.
 *
 * A failure WINS over a success, because the breaker exists to hear failures:
 * it counts consecutive ones, and a batch that reported the success and dropped
 * the failure would keep resetting a streak the lane is genuinely accumulating.
 * When no kind failed, one success is enough to say the lane answered, and a
 * batch that reached no provider at all (edge only) says nothing — a lane nobody
 * called cannot be shown to be healthy.
 */
function batchProviderOutcome(outcomes: readonly ImageLabProviderOutcome[]): ImageLabProviderOutcome {
  if (outcomes.includes(false)) return false;
  if (outcomes.includes(true)) return true;
  return null;
}

interface ExtractOneControlInput extends RunImageLabControlExtractionInput {
  /** The source image's bytes, read once and reused across every requested kind. */
  bytes: Buffer;
  controlKind: ImageLabControlKind;
}

/** One fixture's recorded outcome, and what it proved about the provider lane. */
interface ExtractedControl {
  /** What the job payload records for this kind — read by a human, never by code. */
  record: Record<string, unknown>;
  providerOutcome: ImageLabProviderOutcome;
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
async function extractOneControl(input: ExtractOneControlInput): Promise<ExtractedControl> {
  const { ownerId, controlKind, sink } = input;
  const pin = imageLabPreprocessorFor(controlKind);
  const produced = pin === null ? await computeEdgeControl(input.bytes) : await runPreprocessorControl(pin, input.bytes);
  const provenance = produced.predictionId ? { predictionId: produced.predictionId } : {};
  const providerOutcome = producedProviderOutcome(pin, produced);

  if (!produced.ok) {
    return {
      record: {
        ...extractionFailure(controlKind, produced.code, produced.message, sink, input.sourceImageId),
        ...(produced.code === "render_failed" ? { renderFailure: produced.renderFailure } : {}),
        ...provenance,
      },
      providerOutcome,
    };
  }

  const meta: ImageLabControlMeta = {
    controlKind,
    generator: imageLabExtractionGenerator(controlKind),
    sourceImageId: input.sourceImageId,
    ...(pin ? { preprocessorSlug: pin.slug, preprocessorVersionId: pin.versionId } : {}),
    ...(input.note ? { originNote: input.note } : {}),
  };
  const stored = await storeControlFixture({ ownerId, meta, buffer: produced.buffer, sink });
  if (!stored) {
    return {
      record: {
        ...extractionFailure(controlKind, "preprocessor_output_invalid", "the fixture could not be written", sink, input.sourceImageId),
        ...provenance,
      },
      // The preprocessor did its half; the write is ours to answer for.
      providerOutcome,
    };
  }
  return { record: { controlKind, imageId: stored.imageId, ...provenance }, providerOutcome };
}

/**
 * What one kind's extraction proved about the provider lane.
 *
 * The EDGE pass reports nothing whatever it does: it is a sharp convolution in
 * this process, so a success is not evidence a provider is up and a failure is
 * not evidence one is down. A pinned kind reports what its prediction did —
 * bytes back is a lane that answered, even when those bytes turn out to be
 * undecodable (which is a fact about the extractor, the very reason the two
 * failures are recorded apart), and a failed prediction reports whatever the
 * shared classifier reads it as.
 */
function producedProviderOutcome(
  pin: ImageLabPreprocessorPin | null,
  produced: ProducedControlBytes,
): ImageLabProviderOutcome {
  if (pin === null) return null;
  if (produced.ok) return true;
  switch (produced.code) {
    case "render_failed":
      return imageFailureHealthOutcome(produced.renderFailure);
    case "preprocessor_output_invalid":
      return true;
  }
}

/** Bytes for one fixture, or the reason there are none. */
type ProducedControlBytes =
  | { ok: true; buffer: Buffer; predictionId?: string }
  | {
      ok: false;
      code: "render_failed";
      message: string;
      predictionId?: string;
      /** The render classifier's reading. Always present here: a failed
       * prediction is exactly what the classifier is for. */
      renderFailure: ImageFailureReason;
    }
  | { ok: false; code: "preprocessor_output_invalid"; message: string; predictionId?: string };

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

/**
 * The recorded shape of a failed extraction, plus its diagnostic.
 *
 * The record carries the BARE code and only the sink carries the dotted one —
 * the identity-pack trial's split. `image_lab.` is the diagnostic stream's
 * namespace, and a reader who has the record in hand already knows which lab
 * produced it.
 */
function extractionFailure(
  controlKind: ImageLabControlKind,
  code: "render_failed" | "preprocessor_output_invalid",
  message: string,
  sink: DiagnosticSink | undefined,
  sourceImageId: string,
): Record<string, unknown> {
  sink?.push(
    diag("warn", imageLabDiagnosticCode(code), message.slice(0, 300), {
      context: { sourceImageId, controlKind },
    }),
  );
  return { controlKind, failureCode: code, error: message.slice(0, 500) };
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
  /** The admin's annotation, stored as the fixture's `originNote` — how it was
   * drawn, which no later review overwrites. */
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
    ...(input.note ? { originNote: input.note } : {}),
  };
  const stored = await storeControlFixture({ ownerId: input.ownerId, meta, buffer: input.buffer, sink: input.sink });
  if (!stored) return { ok: false, error: "could not store that control fixture" };
  return { ok: true, control: stored };
}

// ---------------------------------------------------------------------------
// Review, deletion
// ---------------------------------------------------------------------------

export type ReviewImageLabControlResult =
  | { ok: true; control: ImageLabControl }
  | { ok: false; refusal: ImageLabRefusal };

/**
 * The reading the probe's own fixture check produces, spelled the same way.
 *
 * BARE in the envelope, dotted only in the sink — the identity-pack trial's
 * refusal shape. The envelope's code is the token a client narrows on, and a
 * client that had to strip a diagnostic namespace off it would be reading a
 * sink's spelling off a wire.
 */
function controlInvalid(message: string, sink: DiagnosticSink | undefined, controlId: string): ImageLabRefusal {
  sink?.push(diag("warn", imageLabDiagnosticCode("control_invalid"), message, { context: { controlId } }));
  return { code: "control_invalid", message };
}

/**
 * Record the admin's review of one fixture — the gate the Stage 0 protocol puts
 * in front of every trial ("extract a pose skeleton and a depth map … review
 * both in the fixtures panel").
 *
 * The check is worth a stored fact rather than a habit because of what it lets a
 * later reading rule out: a probe that comes back `ignores_control` has to be
 * able to eliminate "the fixture was wrong" before it says anything about the
 * model, and an unreviewed skeleton makes that elimination impossible.
 *
 * `reviewedAt` is stamped from THIS clock, never from the request, for the
 * reason the generator is not taken from an upload body: a caller that could
 * name its own review time could file today's glance as last week's review.
 *
 * The stored bag is MERGED, not replaced. `images.meta` is shared — a ready row
 * also carries the encode metadata the save path wrote — so assigning the
 * fixture's own fields over it would make a review a lossy write wearing an
 * annotation's clothes. The merge is also what carries the create path's
 * `originNote` through untouched, which is the point of the two notes being two
 * fields: ruling on a fixture must not erase the record of what it was made
 * for, because "the fixture was wrong" and "the fixture was for something else"
 * are different readings of the same `ignores_control` verdict. On a row that
 * predates the split — creation note stranded in `reviewNote`, no `reviewedAt`
 * — the same write ADOPTS that string as the `originNote` before stamping the
 * ruling over it, which is the whole migration those rows need and the last
 * moment anything can perform it.
 *
 * Null when the image is not this owner's, indistinguishable from never having
 * existed, so the route never confirms a foreign image. An image that IS this
 * owner's and still cannot say what fixture it is refuses with
 * `control_invalid`, exactly as `checkControlBinding` refuses one at run time.
 */
export async function reviewImageLabControl(
  ownerId: string,
  controlId: string,
  reviewNote: string,
  sink?: DiagnosticSink,
): Promise<ReviewImageLabControlResult | null> {
  const row = await ownedImageRow(controlId, ownerId);
  if (!row) return null;
  if (row.kind !== "lab_control") {
    return {
      ok: false,
      refusal: controlInvalid(`image ${controlId} is a ${row.kind}, not a lab control fixture`, sink, controlId),
    };
  }
  const stored = parseOrNull(imageLabControlMetaSchema, row.meta, sink, "images.meta.lab_control");
  if (!stored) {
    return {
      ok: false,
      refusal: controlInvalid(`control image ${controlId} has no readable fixture metadata`, sink, controlId),
    };
  }

  // The pre-split shape: a creation note stranded in `reviewNote`, with no
  // `reviewedAt` beside it and no `originNote` of its own. This write is the one
  // path left that could overwrite that string, so it adopts it instead. A row
  // written since the split cannot match — an unreviewed one carries no
  // `reviewNote`, a reviewed one carries `reviewedAt`, and a fixture that named
  // its own origin keeps what it named.
  const stranded =
    stored.reviewedAt === undefined && stored.originNote === undefined ? stored.reviewNote : undefined;

  const meta: ImageLabControlMeta = {
    ...stored,
    ...(stranded ? { originNote: stranded } : {}),
    reviewedAt: new Date().toISOString(),
    reviewNote,
  };
  const [updated] = await db()
    .update(images)
    .set({ meta: { ...imageMeta(row.meta), ...meta } })
    .where(and(eq(images.id, controlId), eq(images.ownerId, ownerId)))
    .returning();
  if (!updated) return null;
  return { ok: true, control: { imageId: updated.id, meta, createdAt: updated.createdAt.toISOString() } };
}

/**
 * Retire one fixture — the owner-scoped delete every lab asset goes through,
 * with the kind guard the experiment's own output delete carries, so an id typo
 * on a fixtures endpoint can never take an avatar with it.
 *
 * An experiment that CITED this fixture is deliberately left standing. Its
 * `control_image_id` is `on delete set null`, so the row keeps its kind, its
 * ordered inputs, its settings, the prompt that was sent and the verdict that
 * was ruled — which is the point: an experiment is the record of a render that
 * happened, and retiring the skeleton afterwards does not un-happen it.
 * Refusing to delete a referenced fixture would instead make bench equipment
 * permanently unretireable the moment it was used once.
 *
 * False when the fixture is not this owner's, absent, or not a `lab_control` —
 * one answer for all three, so the route never confirms a foreign image.
 */
export async function deleteImageLabControl(ownerId: string, controlId: string): Promise<boolean> {
  return await deleteOwnedImage(controlId, ownerId, { kind: "lab_control" });
}
