import type {
  DetectedFaceCandidate,
  IdentityPackIntrinsicPolicy,
  IdentityPackProfilePolicy,
  IdentityReferenceRole,
  ImageIdentityCropMethod,
  ImageIdentityPackFailureCode,
  ImageIdentityPackQuality,
  ImageIdentityPackWarningCode,
  SourcePixelCrop,
} from "@/contracts/images/identity-pack";
import { paddingBetween } from "./identity-pack-crop";
import { IDENTITY_BLUR_ALGORITHM_VERSION, INTRINSIC_POLICY_V1 } from "./identity-pack-policy";

/**
 * Pure identity-pack measurement and evaluation
 * (docs/developer-notes/image-identity-packs.spec.derivation.md §"Intrinsic
 * quality measurement" and §"Versioned reference policy").
 *
 * The split this module enforces: MEASURING is permanent, JUDGING is not. A pack
 * stores what was observed — face box, padding, blur score, detected count — and
 * nothing about whether it passed. Verdicts are computed on read against a named
 * policy version, which is what lets a threshold change re-evaluate every existing
 * pack without rerunning a detector over every portrait in the library.
 *
 * Pixel data arrives already decoded (`{ data, width, height, channels }`, the
 * shape `sharp(...).raw().toBuffer({ resolveWithObject: true })` returns). Decoding
 * belongs to the server caller; this module stays free of `sharp` so the scoring
 * can be pinned by synthetic fixtures.
 */

/** Decoded raw pixels. `channels` is 1–2 (grey, optional alpha) or 3–4 (RGB(A)). */
export interface RawPixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
  channels: number;
}

/**
 * Variance of the Laplacian — the standard deterministic sharpness proxy. LOWER is
 * blurrier: a flat or out-of-focus region produces near-zero second derivatives
 * everywhere, so their variance collapses.
 *
 * Returns `null` when the image is too small to convolve or the buffer does not
 * match its declared dimensions, because "could not measure" and "measured zero"
 * are different facts and a fabricated 0 would read as maximum blur. That
 * distinction is why the whole quality contract is nullable.
 *
 * The absolute number means nothing on its own — it scales with resolution and
 * content — which is why it is stored beside `IDENTITY_BLUR_ALGORITHM_VERSION` and
 * compared only against thresholds calibrated on the same algorithm.
 */
export function identityBlurScore(pixels: RawPixels): number | null {
  const gray = toGrayscale(pixels);
  if (!gray) return null;

  const { width, height } = pixels;
  const at = (x: number, y: number): number => gray[y * width + x] ?? 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const response = at(x, y - 1) + at(x - 1, y) + at(x + 1, y) + at(x, y + 1) - 4 * at(x, y);
      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }
  if (count === 0) return null;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

function toGrayscale(pixels: RawPixels): Float64Array | null {
  const { data, width, height, channels } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(channels)) return null;
  if (width < 3 || height < 3 || channels < 1) return null;
  if (data.length < width * height * channels) return null;

  const gray = new Float64Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const base = i * channels;
    if (channels < 3) {
      gray[i] = data[base] ?? 0;
      continue;
    }
    // Rec. 601 luma. Alpha is ignored: a reference crop is opaque, and weighting by
    // it would make a transparent border read as a sharp edge.
    gray[i] = 0.299 * (data[base] ?? 0) + 0.587 * (data[base + 1] ?? 0) + 0.114 * (data[base + 2] ?? 0);
  }
  return gray;
}

/** Everything observed about one revision, before any of it is judged. */
export interface IdentityQualityObservations {
  crop: SourcePixelCrop;
  detectedFaces: number | null;
  faceBox: SourcePixelCrop | null;
  blurScore: number | null;
  occlusionScore: number | null;
  algorithmVersion?: string;
}

/**
 * Assemble the persisted measurement record from detector observations and the
 * final crop geometry.
 *
 * Derived fields stay `null` when their input is missing rather than defaulting:
 * a heuristic crop has no face box, so its face dimensions, area ratio and padding
 * are genuinely unknown — recording 0 would tell a later policy version that a
 * face was measured at zero pixels and block a pack that was never actually
 * examined.
 */
export function buildIdentityPackQuality(input: IdentityQualityObservations): ImageIdentityPackQuality {
  const { crop, faceBox } = input;
  const cropArea = crop.width * crop.height;
  const padding = faceBox ? paddingBetween(crop, faceBox) : null;
  return {
    algorithmVersion: input.algorithmVersion ?? IDENTITY_BLUR_ALGORITHM_VERSION,
    detectedFaces: input.detectedFaces,
    faceBox,
    faceWidthPx: faceBox ? faceBox.width : null,
    faceHeightPx: faceBox ? faceBox.height : null,
    faceAreaRatio: faceBox && cropArea > 0 ? (faceBox.width * faceBox.height) / cropArea : null,
    blurScore: input.blurScore,
    occlusionScore: input.occlusionScore,
    padding: {
      topPx: padding ? padding.topPx : null,
      rightPx: padding ? padding.rightPx : null,
      bottomPx: padding ? padding.bottomPx : null,
      leftPx: padding ? padding.leftPx : null,
    },
  };
}

export type IdentityCandidateSelection =
  | { ok: true; primary: DetectedFaceCandidate; plausibleAdditional: number }
  | {
      ok: false;
      code: Extract<ImageIdentityPackFailureCode, "no_usable_face" | "ambiguous_faces">;
      accepted: number;
      plausibleAdditional: number;
    };

/**
 * Choose the one face a crop may be built from, or refuse.
 *
 * The service never picks the largest, most central, or most confident face out of
 * a crowd — doing so would put a stranger's face in every future render of that
 * character, silently. So: exactly one candidate above the primary floor and no
 * OTHER candidate plausible enough to create doubt, or the answer is
 * `ambiguous_faces` and a human decides.
 *
 * The second floor is much lower than the first on purpose. A 0.4-confidence face
 * in the background is not a subject, but it is easily enough to make "which person
 * is this pack about?" a real question.
 */
export function selectIdentityFaceCandidate(
  candidates: readonly DetectedFaceCandidate[],
  policy: IdentityPackIntrinsicPolicy = INTRINSIC_POLICY_V1,
): IdentityCandidateSelection {
  const accepted = candidates.filter((candidate) => candidate.confidence >= policy.detectorConfidenceFloor);
  const plausible = candidates.filter(
    (candidate) => candidate.confidence >= policy.possibleAdditionalFaceFloor,
  );
  const primary = accepted[0];
  if (!primary) {
    return { ok: false, code: "no_usable_face", accepted: 0, plausibleAdditional: plausible.length };
  }
  const plausibleAdditional = plausible.filter((candidate) => candidate !== primary).length;
  if (accepted.length > 1 || plausibleAdditional > 0) {
    return { ok: false, code: "ambiguous_faces", accepted: accepted.length, plausibleAdditional };
  }
  return { ok: true, primary, plausibleAdditional: 0 };
}

export interface IdentityIntrinsicEvaluationInput {
  method: ImageIdentityCropMethod | null;
  crop: SourcePixelCrop | null;
  quality: ImageIdentityPackQuality | null;
  adminOverride?: boolean;
}

export interface IdentityPackIntrinsicEvaluation {
  policyVersion: string;
  blockers: ImageIdentityPackFailureCode[];
  warnings: ImageIdentityPackWarningCode[];
}

/**
 * Judge stored measurements against a policy version — the read-time half of
 * "`quality.accepted` is not persisted as eternal truth".
 *
 * A null threshold means the check is not armed at this policy version and is
 * skipped entirely; it is NOT a zero. A null MEASUREMENT is likewise skipped rather
 * than treated as a failure, because a pack derived before a metric existed must
 * not become retroactively unusable — the trial calibrates thresholds, and only
 * then does an unarmed check start blocking anything.
 *
 * Blur and occlusion blocks report as `no_usable_face`: the vocabulary has no
 * "too blurry" code, and the honest statement is that this source cannot yield a
 * usable face reference (the same thing the UI tells the owner either way).
 */
export function evaluateIdentityPackIntrinsic(
  input: IdentityIntrinsicEvaluationInput,
  policy: IdentityPackIntrinsicPolicy = INTRINSIC_POLICY_V1,
): IdentityPackIntrinsicEvaluation {
  const blockers: ImageIdentityPackFailureCode[] = [];
  const warnings: ImageIdentityPackWarningCode[] = [];

  const { crop, quality } = input;
  if (!crop) {
    pushUnique(blockers, "invalid_crop");
  } else if (crop.width < policy.minimumCropWidthPx || crop.height < policy.minimumCropHeightPx) {
    pushUnique(blockers, "crop_too_small");
  }

  if (quality) {
    const { blurScore, occlusionScore, padding } = quality;
    if (blurScore !== null) {
      if (policy.blurBlockThreshold !== null && blurScore < policy.blurBlockThreshold) {
        pushUnique(blockers, "no_usable_face");
      } else if (policy.blurWarningThreshold !== null && blurScore < policy.blurWarningThreshold) {
        pushUnique(warnings, "mild_blur");
      }
    }
    if (occlusionScore !== null) {
      if (policy.occlusionBlockThreshold !== null && occlusionScore > policy.occlusionBlockThreshold) {
        pushUnique(blockers, "no_usable_face");
      } else if (
        policy.occlusionWarningThreshold !== null &&
        occlusionScore > policy.occlusionWarningThreshold
      ) {
        pushUnique(warnings, "partial_occlusion");
      }
    }
    if (padding.topPx !== null && padding.topPx < policy.minimumBoundaryPaddingPx) {
      pushUnique(warnings, "tight_hairline_padding");
    }
    if (padding.bottomPx !== null && padding.bottomPx < policy.minimumBoundaryPaddingPx) {
      pushUnique(warnings, "tight_jaw_padding");
    }
  }

  if (input.method === "heuristic") pushUnique(warnings, "heuristic_crop");
  if (input.adminOverride === true) pushUnique(warnings, "manual_admin_override");

  return { policyVersion: policy.version, blockers, warnings };
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

/** Pixel dimensions of an image region — either a crop or a whole source. */
export interface PixelSize {
  width: number;
  height: number;
}

export interface IdentityEffectiveSizeInput {
  role: IdentityReferenceRole;
  /** The stored face box, in source pixels. */
  faceBox: SourcePixelCrop | null;
  /**
   * The SOURCE-pixel region the sent reference covers: the crop for `face_detail`,
   * the whole portrait for `canonical_identity`. The stored encode size cancels out
   * of the ratio, so it is not needed here.
   */
  referenceRegion: PixelSize | null;
  /** What the provider actually feeds the model, or null when its resize behavior
   * has not been reviewed. */
  effectiveReference: PixelSize | null;
  policy: IdentityPackProfilePolicy;
}

export interface IdentityEffectiveSizeEvaluation {
  /** True only when real effective face dimensions were computed. */
  measured: boolean;
  effectiveReferenceWidthPx: number | null;
  effectiveReferenceHeightPx: number | null;
  effectiveFaceWidthPx: number | null;
  effectiveFaceHeightPx: number | null;
  /** Measured below the profile floor. The caller decides what that costs: an
   * optional role is omitted, a required one makes the profile ineligible. */
  belowEffectiveFaceFloor: boolean;
  warnings: ImageIdentityPackWarningCode[];
}

/**
 * Scale the stored face box into the pixels the provider will actually see.
 *
 * Uploading a 1024px file does not mean the model sees 1024px. The chain from
 * source to provider is `crop → stored encode → provider resize`, and the stored
 * encode cancels, so the honest ratio is provider-input over source-region: a
 * 512px face inside a 1024px crop that the provider squeezes to 512 is a 256px
 * face, and the floor is checked THERE.
 *
 * When resize behavior is unknown the answer is a warning, not a refusal, and only
 * for the optional `face_detail` role — refusing every unreviewed profile would
 * disable face detail everywhere before the trial has a single measurement to work
 * from, while warning records the doubt where the trial can find it. The required
 * canonical role is not warned about, because a warning fired on literally every
 * render is not a signal.
 */
export function evaluateIdentityEffectiveSize(
  input: IdentityEffectiveSizeInput,
): IdentityEffectiveSizeEvaluation {
  const { effectiveReference, referenceRegion, faceBox, policy } = input;
  const unverifiable = (): IdentityEffectiveSizeEvaluation => ({
    measured: false,
    effectiveReferenceWidthPx: effectiveReference ? effectiveReference.width : null,
    effectiveReferenceHeightPx: effectiveReference ? effectiveReference.height : null,
    effectiveFaceWidthPx: null,
    effectiveFaceHeightPx: null,
    belowEffectiveFaceFloor: false,
    warnings: input.role === "face_detail" ? ["small_effective_face"] : [],
  });

  if (!effectiveReference || !referenceRegion || !faceBox) return unverifiable();
  if (referenceRegion.width <= 0 || referenceRegion.height <= 0) return unverifiable();

  const effectiveFaceWidthPx = Math.round(
    faceBox.width * (effectiveReference.width / referenceRegion.width),
  );
  const effectiveFaceHeightPx = Math.round(
    faceBox.height * (effectiveReference.height / referenceRegion.height),
  );
  const belowEffectiveFaceFloor =
    effectiveFaceWidthPx < policy.minimumEffectiveFaceWidthPx ||
    effectiveFaceHeightPx < policy.minimumEffectiveFaceHeightPx;

  return {
    measured: true,
    effectiveReferenceWidthPx: effectiveReference.width,
    effectiveReferenceHeightPx: effectiveReference.height,
    effectiveFaceWidthPx,
    effectiveFaceHeightPx,
    belowEffectiveFaceFloor,
    warnings: belowEffectiveFaceFloor ? ["small_effective_face"] : [],
  };
}

export interface IdentityProfilePolicyInput {
  method: ImageIdentityCropMethod | null;
  adminOverride: boolean;
  policy: IdentityPackProfilePolicy;
}

export interface IdentityProfilePolicyEvaluation {
  allowed: boolean;
  warnings: ImageIdentityPackWarningCode[];
}

/**
 * The profile's non-numeric gates: may this profile use a guessed crop, and may an
 * admin override its thresholds.
 *
 * Both stay VISIBLE when permitted rather than silently allowed — an override that
 * leaves no warning on the render is an override nobody can audit afterwards, which
 * is the whole reason the pack records the actor and reason too.
 */
export function evaluateIdentityProfilePolicy(
  input: IdentityProfilePolicyInput,
): IdentityProfilePolicyEvaluation {
  const { method, adminOverride, policy } = input;
  const warnings: ImageIdentityPackWarningCode[] = [];
  if (method === "heuristic") {
    if (!policy.allowHeuristic) return { allowed: false, warnings };
    warnings.push("heuristic_crop");
  }
  if (adminOverride) {
    if (!policy.allowAdminOverride) return { allowed: false, warnings };
    warnings.push("manual_admin_override");
  }
  return { allowed: true, warnings };
}
