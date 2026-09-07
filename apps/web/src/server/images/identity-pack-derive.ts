import sharp from "sharp";
import {
  buildIdentityPackQuality,
  deriveDetectorCrop,
  type DetectedFaceCandidate,
  evaluateIdentityPackIntrinsic,
  HEURISTIC_V1,
  heuristicCropV1,
  IDENTITY_CROP_POLICY_V1,
  IDENTITY_PACK_DERIVATION_VERSION,
  identityBlurScore,
  identityCropOutputSide,
  identityFaceDetector,
  type ImageIdentityCropMethod,
  type ImageIdentityPackFailureCode,
  type ImageIdentityPackQuality,
  type ImageIdentityPackStatus,
  type ImageIdentityPackWarningCode,
  isHeuristicEligibleSource,
  selectIdentityFaceCandidate,
  type SourceDimensions,
  type SourcePixelCrop,
  validateIdentityCrop,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import { createImageAsset, failImage, saveImageBuffer, SHARP_DECODE_LIMITS } from "./asset-storage";
import { errorMessage, intrinsicPolicy, type ResolvedSource } from "./identity-pack-store";

/**
 * Derivation: detector → candidate ruling → crop geometry → encode → measure →
 * hidden asset. Bounded local work, run outside every transaction.
 *
 * The service's invariants and its row/contract layer are in
 * `./identity-pack-store.ts`; promoting what this module produces is
 * `./identity-pack-promotion.ts`.
 */

/* ------------------------------------------------------------------------ *
 * Derivation                                                                *
 * ------------------------------------------------------------------------ */

/** The columns a finished derivation writes onto its reserved revision. */
export interface RevisionPatch {
  status: Extract<ImageIdentityPackStatus, "ready" | "unusable" | "failed">;
  method: ImageIdentityCropMethod | null;
  detectorVersion: string | null;
  confidence: number | null;
  faceCropImageId: string | null;
  crop: SourcePixelCrop | null;
  quality: ImageIdentityPackQuality | null;
  warningCodes: ImageIdentityPackWarningCode[];
  failureCode: ImageIdentityPackFailureCode | null;
  failureMessage: string | null;
  /** Non-null only on a human-authored revision (a manual crop or a recorded override). */
  review: { actorUserId: string; reason: string | null } | null;
}

/** The refusals derivation itself can reach — each has a matching diagnostic code. */
type CropRefusalCode = Extract<
  ImageIdentityPackFailureCode,
  "no_usable_face" | "ambiguous_faces" | "invalid_crop" | "crop_too_small"
>;

/**
 * A revision that produced no usable reference. `crop_write_failed` and
 * `derivation_failed` are `failed` (the machinery broke); everything else is
 * `unusable` (this source cannot yield a face reference). Measurements taken
 * before the refusal are carried through in `over` — a blocked pack that
 * recorded WHY is what lets a later policy version re-judge it.
 */
export function refusedRevision(
  code: ImageIdentityPackFailureCode,
  message: string,
  over: Partial<RevisionPatch> = {},
): RevisionPatch {
  return {
    status: code === "crop_write_failed" || code === "derivation_failed" ? "failed" : "unusable",
    method: null,
    detectorVersion: null,
    confidence: null,
    faceCropImageId: null,
    crop: null,
    quality: null,
    warningCodes: [],
    failureCode: code,
    failureMessage: message.slice(0, 500),
    review: null,
    ...over,
  };
}

interface DeriveInput {
  ownerId: string;
  characterId: string;
  packId: string;
  source: ResolvedSource;
  sink: DiagnosticSink | undefined;
}

/**
 * Detector → candidate ruling → crop geometry → encode → measure → evaluate →
 * hidden asset. Runs outside every transaction.
 *
 * Ordering is load-bearing. The crop image row is reserved only once the
 * rectangle is valid AND the measurements clear the intrinsic policy, so a
 * refused revision never leaves a hidden file nobody will use; and the buffer is
 * measured before it is stored, because the blur score describes the bytes a
 * provider will see, not the source they came from.
 */
export async function deriveRevision(input: DeriveInput): Promise<RevisionPatch> {
  const { source, sink, characterId } = input;
  const detector = identityFaceDetector();

  let candidates: DetectedFaceCandidate[];
  try {
    candidates = await detector.detect(source.buffer);
  } catch (err) {
    const message = errorMessage(err);
    log.warn("images", "identity face detector threw; revision failed", {
      characterId,
      detector: detector.version,
      error: message.slice(0, 300),
    });
    return refusedRevision("derivation_failed", message);
  }

  const plan = planIdentityCrop(candidates, source.dimensions, detector.version);
  if (!plan.ok) {
    pushRefusal(sink, plan.code, plan.message, characterId);
    return refusedRevision(plan.code, plan.message);
  }

  let encoded: EncodedCrop;
  try {
    encoded = await encodeAndMeasureCrop(source.buffer, plan.crop);
  } catch (err) {
    const message = errorMessage(err);
    log.warn("images", "identity crop encode/measure threw; revision failed", {
      characterId,
      error: message.slice(0, 300),
    });
    return refusedRevision("derivation_failed", message, { method: plan.method, crop: plan.crop });
  }

  const quality = buildIdentityPackQuality({
    crop: plan.crop,
    detectedFaces: plan.detectedFaces,
    faceBox: plan.faceBox,
    blurScore: encoded.blurScore,
    occlusionScore: plan.occlusionScore,
  });
  const evaluation = evaluateIdentityPackIntrinsic({ method: plan.method, crop: plan.crop, quality }, intrinsicPolicy());
  // Measurements are kept whatever the verdict — that is the point of storing
  // them rather than a boolean: a threshold change must be able to re-judge
  // this revision.
  const measured: Partial<RevisionPatch> = {
    method: plan.method,
    detectorVersion: plan.detectorVersion,
    confidence: plan.confidence,
    crop: plan.crop,
    quality,
    warningCodes: evaluation.warnings,
  };

  const blocker = evaluation.blockers[0];
  if (blocker !== undefined) {
    const code = narrowCropCode(blocker);
    const message = `intrinsic policy ${evaluation.policyVersion} blocked the crop: ${evaluation.blockers.join(", ")}`;
    pushRefusal(sink, code, message, characterId);
    return refusedRevision(code, message, measured);
  }

  const stored = await storeHiddenCropAsset({
    ownerId: input.ownerId,
    characterId,
    packId: input.packId,
    source,
    crop: plan.crop,
    buffer: encoded.buffer,
    sink,
  });
  if (!stored.ok) return refusedRevision("crop_write_failed", stored.message, measured);

  return {
    status: "ready",
    method: plan.method,
    detectorVersion: plan.detectorVersion,
    confidence: plan.confidence,
    faceCropImageId: stored.imageId,
    crop: plan.crop,
    quality,
    warningCodes: evaluation.warnings,
    failureCode: null,
    failureMessage: null,
    review: null,
  };
}

interface HiddenCropAssetInput {
  ownerId: string;
  characterId: string;
  packId: string;
  source: ResolvedSource;
  crop: SourcePixelCrop;
  buffer: Buffer;
  sink: DiagnosticSink | undefined;
}

/**
 * Reserve the hidden crop row, write its file, or report the failure — the one
 * copy of that sequence, shared by automatic derivation and the manual editor so
 * the two can never drift on what a face-crop asset records.
 *
 * The meta block is the crop's provenance,
 * deliberately duplicating what the pack row already says: the pack row is the
 * authority, and this is what lets an operator reading `images` alone tell a
 * derived internal input from a user's portrait. A write failure fails the row
 * rather than leaving a `pending` one behind — the pack must never end up ready
 * with a missing file.
 */
export async function storeHiddenCropAsset(
  input: HiddenCropAssetInput,
): Promise<{ ok: true; imageId: string } | { ok: false; message: string }> {
  const { ownerId, characterId, packId, source, crop, sink } = input;
  const asset = await createImageAsset({
    ownerId,
    kind: "identity_face_crop",
    entityKind: "character",
    entityId: characterId,
    sourceImageId: source.imageRow.id,
    meta: {
      hidden: true,
      identityPackId: packId,
      identityRole: "face_detail",
      sourceContentHash: source.contentHash,
      crop,
      derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
    },
  });
  const saved = await saveImageBuffer(asset.id, input.buffer, sink);
  if (saved?.status !== "ready") {
    const message = "identity face crop could not be written";
    await failImage(asset.id, message);
    sink?.push(
      diag("warn", "images.identity_pack.crop_write_failed", message, {
        context: { characterId, packId, imageId: asset.id },
      }),
    );
    return { ok: false, message };
  }
  return { ok: true, imageId: asset.id };
}

export interface EncodedCrop {
  buffer: Buffer;
  blurScore: number | null;
}

/**
 * Cut, encode and measure one rectangle. Both proposers (detector/heuristic and
 * the manual editor) go through this, in this order, because the blur score must
 * describe the bytes a provider will actually receive rather than the source they
 * were cut from. Throws only on a genuine sharp failure; the callers convert that
 * into a failed revision.
 */
export async function encodeAndMeasureCrop(sourceBuffer: Buffer, crop: SourcePixelCrop): Promise<EncodedCrop> {
  const outputSide = identityCropOutputSide(crop.width, IDENTITY_CROP_POLICY_V1);
  const buffer = await extractIdentityCrop(sourceBuffer, crop, outputSide);
  return { buffer, blurScore: await measureBlur(buffer) };
}

type CropPlan =
  | {
      ok: true;
      crop: SourcePixelCrop;
      method: ImageIdentityCropMethod;
      detectorVersion: string | null;
      confidence: number | null;
      faceBox: SourcePixelCrop | null;
      occlusionScore: number | null;
      detectedFaces: number;
    }
  | { ok: false; code: CropRefusalCode; message: string };

/**
 * Which rectangle this revision gets, or why it gets none.
 *
 * Three outcomes, in the order the spec rules them:
 *
 * - **one confident face and nothing else plausible** → the versioned detector
 *   expansion, which refuses rather than clipping when the source cannot give
 *   back the hairline and jaw padding it asked for;
 * - **more than one plausible face** → `ambiguous_faces`. The service never
 *   picks the largest, most central or most confident face out of a crowd,
 *   because doing so would put a stranger's face in every future render of that
 *   character, silently, and nobody would know to look;
 * - **nothing seen at all** → the deterministic heuristic, and ONLY then. A
 *   detector that saw a face it could not confirm is evidence against guessing:
 *   a centred square would be a guess made against the one observation available.
 */
function planIdentityCrop(
  candidates: readonly DetectedFaceCandidate[],
  source: SourceDimensions,
  detectorVersion: string,
): CropPlan {
  const detectedFaces = candidates.length;
  const selection = selectIdentityFaceCandidate(candidates, intrinsicPolicy());

  if (selection.ok) {
    const derived = deriveDetectorCrop(selection.primary.box, source, IDENTITY_CROP_POLICY_V1);
    if (!derived.ok) {
      return {
        ok: false,
        code: narrowCropCode(derived.code),
        message: `detector crop refused for a ${source.width}x${source.height} source`,
      };
    }
    return {
      ok: true,
      crop: derived.geometry.crop,
      method: "detector",
      detectorVersion,
      confidence: selection.primary.confidence,
      faceBox: selection.primary.box,
      occlusionScore: selection.primary.occlusionScore ?? null,
      detectedFaces,
    };
  }

  if (selection.code === "ambiguous_faces") {
    return {
      ok: false,
      code: "ambiguous_faces",
      message: `${selection.accepted} confident and ${selection.plausibleAdditional} additional plausible faces — a human must choose`,
    };
  }
  if (selection.plausibleAdditional > 0) {
    return {
      ok: false,
      code: "no_usable_face",
      message: `${selection.plausibleAdditional} unconfirmed face(s) seen; the heuristic would guess against the evidence`,
    };
  }
  if (!isHeuristicEligibleSource(source, HEURISTIC_V1)) {
    return {
      ok: false,
      code: "no_usable_face",
      message: `a ${source.width}x${source.height} source is not portrait-shaped enough for the ${HEURISTIC_V1.id} fallback`,
    };
  }
  const crop = heuristicCropV1(source, HEURISTIC_V1);
  if (!crop) return { ok: false, code: "no_usable_face", message: `${HEURISTIC_V1.id} produced no rectangle` };
  const validation = validateIdentityCrop(crop, source, IDENTITY_CROP_POLICY_V1);
  if (!validation.ok) {
    return { ok: false, code: narrowCropCode(validation.code), message: `${HEURISTIC_V1.id} crop rejected: ${validation.reason}` };
  }
  return {
    ok: true,
    crop,
    method: "heuristic",
    detectorVersion: null,
    confidence: null,
    faceBox: null,
    occlusionScore: null,
    detectedFaces,
  };
}

/**
 * The pure geometry and policy layers type their refusals as the whole failure
 * vocabulary; only these four can actually come out of them. Anything else would
 * be a contract change, and reading it as `invalid_crop` keeps the diagnostic
 * honest instead of inventing a code.
 */
function narrowCropCode(code: ImageIdentityPackFailureCode): CropRefusalCode {
  switch (code) {
    case "no_usable_face":
    case "ambiguous_faces":
    case "invalid_crop":
    case "crop_too_small":
      return code;
    case "source_missing":
    case "source_not_ready":
    case "source_unreadable":
    case "source_changed":
    case "crop_write_failed":
    case "derivation_failed":
      return "invalid_crop";
  }
}

/** One diagnostic per refusal, on the stable `images.identity_pack.*` codes. */
function pushRefusal(sink: DiagnosticSink | undefined, code: CropRefusalCode, message: string, characterId: string): void {
  sink?.push(diag("warn", `images.identity_pack.${code}`, message, { context: { characterId } }));
}

/**
 * Cut the crop and encode it at the stored ceiling.
 *
 * `withoutEnlargement` is the load-bearing option: a small crop stays small.
 * Upscaling it to a rounder number would make the reference LOOK higher
 * resolution than the bytes behind it, which is exactly the lie the
 * effective-size evaluation exists to catch downstream.
 */
async function extractIdentityCrop(sourceBuffer: Buffer, crop: SourcePixelCrop, outputSide: number): Promise<Buffer> {
  return sharp(sourceBuffer, SHARP_DECODE_LIMITS)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(outputSide, outputSide, { fit: "cover", withoutEnlargement: true })
    .toBuffer();
}

/** Blur is scored on the ENCODED crop — the bytes a provider actually receives. */
async function measureBlur(cropBuffer: Buffer): Promise<number | null> {
  const { data, info } = await sharp(cropBuffer, SHARP_DECODE_LIMITS).raw().toBuffer({ resolveWithObject: true });
  return identityBlurScore({ data, width: info.width, height: info.height, channels: info.channels });
}
