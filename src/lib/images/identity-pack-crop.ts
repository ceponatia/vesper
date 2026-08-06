import type { ImageIdentityPackFailureCode, SourcePixelCrop } from "@/contracts/images/identity-pack";
import {
  HEURISTIC_V1,
  IDENTITY_CROP_POLICY_V1,
  type IdentityCropPolicy,
  type IdentityHeuristicPolicy,
} from "./identity-pack-policy";

/**
 * Pure identity-crop geometry
 * (docs/developer-notes/image-identity-packs.spec.derivation.md §"Crop geometry").
 *
 * Everything here is plain numbers in and plain numbers out: no decoding, no
 * detector, no file, no policy decision beyond the constants passed in. That is
 * what lets `identity-pack-crop.test.ts` pin the exact output rectangle for a set
 * of source shapes as golden fixtures — the crop a character's face reference gets
 * is a versioned promise, and a rectangle that moves without an
 * `IDENTITY_PACK_DERIVATION_VERSION` bump is a silent re-frame of every future render.
 *
 * All coordinates are integer source pixels in the stored orientation.
 */

/** A decoded source image's pixel size. */
export interface SourceDimensions {
  width: number;
  height: number;
}

/** Distance from a face box to each crop edge, in source pixels. Key names match
 * `ImageIdentityPackQuality.padding` so the quality record can be assembled without
 * a second translation. */
export interface IdentityCropPadding {
  topPx: number;
  rightPx: number;
  bottomPx: number;
  leftPx: number;
}

/**
 * A derived crop plus the evidence for whether it is honest.
 *
 * `requestedPaddingPx` is what the policy asked for; `achievedPaddingPx` is what
 * the source could actually give after clamping. The difference is the whole
 * question — a crop is not usable merely because its coordinates are legal, it has
 * to still contain the hairline and jaw the policy asked to preserve.
 */
export interface IdentityCropGeometry {
  crop: SourcePixelCrop;
  requestedPaddingPx: IdentityCropPadding;
  achievedPaddingPx: IdentityCropPadding;
  lostPaddingPx: IdentityCropPadding;
  /** Lost padding as a fraction of what was requested on that edge; 0 when nothing
   * was requested there. */
  lostPaddingFraction: IdentityCropPadding;
}

export type DeriveIdentityCropResult =
  | { ok: true; geometry: IdentityCropGeometry }
  | { ok: false; code: ImageIdentityPackFailureCode; geometry: IdentityCropGeometry | null };

/** Why a rectangle was rejected — diagnostic detail behind the persisted failure code. */
export const identityCropRejections = [
  "not_integer",
  "non_positive",
  "out_of_bounds",
  "not_square",
  "below_minimum",
] as const;
export type IdentityCropRejection = (typeof identityCropRejections)[number];

export type IdentityCropValidation =
  | { ok: true }
  | { ok: false; code: ImageIdentityPackFailureCode; reason: IdentityCropRejection };

/** Normalized (0–1) coordinates as a client submits them. */
export interface NormalizedCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function fractionLost(requested: number, lost: number): number {
  return requested > 0 ? lost / requested : 0;
}

/**
 * Distance from each face-box edge to the corresponding crop edge. Negative on an
 * edge where the face escapes the crop, which is left as-is: that is exactly the
 * evidence a `lostPaddingFraction` above 1 is built from.
 */
export function paddingBetween(crop: SourcePixelCrop, faceBox: SourcePixelCrop): IdentityCropPadding {
  return {
    topPx: faceBox.top - crop.top,
    rightPx: crop.left + crop.width - (faceBox.left + faceBox.width),
    bottomPx: crop.top + crop.height - (faceBox.top + faceBox.height),
    leftPx: faceBox.left - crop.left,
  };
}

/**
 * Resolve client-submitted normalized coordinates to integer source pixels.
 *
 * Rounding is all this does — bounds, squareness and minimum size are
 * `validateIdentityCrop`'s job, so a rejected manual crop can report WHICH rule it
 * broke instead of being silently corrected into a different rectangle than the
 * user framed. A non-finite input rounds to `NaN` and is caught there.
 */
export function normalizedCropToSourcePixels(crop: NormalizedCrop, source: SourceDimensions): SourcePixelCrop {
  return {
    left: Math.round(crop.left * source.width),
    top: Math.round(crop.top * source.height),
    width: Math.round(crop.width * source.width),
    height: Math.round(crop.height * source.height),
  };
}

/**
 * Force a rectangle to the square v1 stores, keeping its centre and staying inside
 * the source.
 *
 * A normalized square is not a pixel square on a non-square source: 0.5 of 769 and
 * 0.5 of 1025 round to sides that differ by a pixel. The manual-crop path snaps
 * with this rather than rejecting the user's frame over sub-pixel rounding.
 */
export function squareSourcePixelCrop(crop: SourcePixelCrop, source: SourceDimensions): SourcePixelCrop {
  const side = Math.max(0, Math.floor(Math.min(crop.width, crop.height, source.width, source.height)));
  const centreX = crop.left + crop.width / 2;
  const centreY = crop.top + crop.height / 2;
  return {
    left: clampInt(Math.round(centreX - side / 2), 0, source.width - side),
    top: clampInt(Math.round(centreY - side / 2), 0, source.height - side),
    width: side,
    height: side,
  };
}

/**
 * The encoded output side for a crop: the storage ceiling caps it, and nothing
 * raises it. Enlarging a small crop to hit a round number would make a reference
 * look higher-resolution than the bytes behind it, which is precisely the lie the
 * effective-size evaluation exists to catch.
 */
export function identityCropOutputSide(
  cropSide: number,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): number {
  return Math.min(Math.floor(cropSide), policy.maximumOutputSidePx);
}

/**
 * Expand a detector face box into the square crop the policy describes.
 *
 * The sequence is: pad each edge by its fraction of the face box, square the
 * result by growing the SHORT axis (horizontally symmetric, vertically biased
 * upward by `squareGrowthTopShare`), clamp the side and position to the source,
 * then measure what the clamp cost.
 *
 * The clamp is why this returns evidence rather than just a rectangle. A face near
 * the frame edge produces perfectly legal coordinates whose hairline padding was
 * eaten entirely; that must fail as `no_usable_face` — the source cannot yield a
 * usable face reference — instead of shipping a clipped crop that nothing
 * downstream can tell apart from a good one.
 */
export function deriveDetectorCrop(
  faceBox: SourcePixelCrop,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): DeriveIdentityCropResult {
  if (!isPositiveSize(source) || !isPositiveSize(faceBox)) {
    return { ok: false, code: "invalid_crop", geometry: null };
  }
  if (!Number.isFinite(faceBox.left) || !Number.isFinite(faceBox.top)) {
    return { ok: false, code: "invalid_crop", geometry: null };
  }
  if (
    faceBox.left < 0 ||
    faceBox.top < 0 ||
    faceBox.left + faceBox.width > source.width ||
    faceBox.top + faceBox.height > source.height
  ) {
    return { ok: false, code: "invalid_crop", geometry: null };
  }

  const requested: IdentityCropPadding = {
    leftPx: Math.round(faceBox.width * policy.faceExpansionLeftFraction),
    rightPx: Math.round(faceBox.width * policy.faceExpansionRightFraction),
    topPx: Math.round(faceBox.height * policy.faceExpansionTopFraction),
    bottomPx: Math.round(faceBox.height * policy.faceExpansionBottomFraction),
  };

  const wantLeft = faceBox.left - requested.leftPx;
  const wantTop = faceBox.top - requested.topPx;
  const wantWidth = faceBox.width + requested.leftPx + requested.rightPx;
  const wantHeight = faceBox.height + requested.topPx + requested.bottomPx;

  // Exactly one axis grows: `side` is the larger of the two, so the other axis's
  // extra is zero and its bias term drops out.
  const side = Math.max(wantWidth, wantHeight);
  const extraHeight = side - wantHeight;
  const centreX = wantLeft + wantWidth / 2;
  const centreY = wantTop + wantHeight / 2 + extraHeight * (0.5 - policy.squareGrowthTopShare);

  const cropSide = Math.floor(Math.min(side, source.width, source.height));
  const crop: SourcePixelCrop = {
    left: clampInt(Math.round(centreX - cropSide / 2), 0, source.width - cropSide),
    top: clampInt(Math.round(centreY - cropSide / 2), 0, source.height - cropSide),
    width: cropSide,
    height: cropSide,
  };

  const achieved = paddingBetween(crop, faceBox);
  const lost: IdentityCropPadding = {
    topPx: Math.max(0, requested.topPx - achieved.topPx),
    rightPx: Math.max(0, requested.rightPx - achieved.rightPx),
    bottomPx: Math.max(0, requested.bottomPx - achieved.bottomPx),
    leftPx: Math.max(0, requested.leftPx - achieved.leftPx),
  };
  const geometry: IdentityCropGeometry = {
    crop,
    requestedPaddingPx: requested,
    achievedPaddingPx: achieved,
    lostPaddingPx: lost,
    lostPaddingFraction: {
      topPx: fractionLost(requested.topPx, lost.topPx),
      rightPx: fractionLost(requested.rightPx, lost.rightPx),
      bottomPx: fractionLost(requested.bottomPx, lost.bottomPx),
      leftPx: fractionLost(requested.leftPx, lost.leftPx),
    },
  };

  if (cropSide < policy.minimumOutputSidePx) {
    return { ok: false, code: "crop_too_small", geometry };
  }
  if (exceedsLostPadding(geometry.lostPaddingFraction, policy.maximumLostPaddingFraction)) {
    return { ok: false, code: "no_usable_face", geometry };
  }
  return { ok: true, geometry };
}

function exceedsLostPadding(fraction: IdentityCropPadding, limit: number): boolean {
  return (
    fraction.topPx > limit || fraction.rightPx > limit || fraction.bottomPx > limit || fraction.leftPx > limit
  );
}

function isPositiveSize(box: { width: number; height: number }): boolean {
  return Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0;
}

/**
 * Whether the deterministic heuristic may be attempted on this source at all.
 *
 * A tall-but-not-absurd frame (1.2–2.2) is the shape a single-subject portrait
 * takes, so a centred square near the top is a guess worth measuring. A landscape
 * group shot or a 4:1 banner is not, and derivation fails closed rather than
 * cropping a confident rectangle out of somebody's shoulder.
 *
 * Passing this is permission to GUESS, never proof the guess was right — the
 * resulting crop still faces intrinsic and profile evaluation.
 */
export function isHeuristicEligibleSource(
  source: SourceDimensions,
  policy: IdentityHeuristicPolicy = HEURISTIC_V1,
): boolean {
  if (!isPositiveSize(source)) return false;
  const ratio = source.height / source.width;
  return ratio >= policy.minPortraitRatio && ratio <= policy.maxPortraitRatio;
}

/**
 * `heuristic_v1`: the largest square a portrait can spare, centred horizontally and
 * pinned just below the top edge where a head sits.
 *
 * The side is the full source WIDTH for a portrait-shaped frame (the face fills the
 * width; the height is what is spare) and the smaller dimension otherwise. The
 * result is clamped so an unusual ratio still yields a legal rectangle instead of a
 * special case — `isHeuristicEligibleSource` is what decides whether the guess is
 * allowed to be made.
 *
 * Every number here is pinned by golden fixtures. Changing one bumps
 * `IDENTITY_PACK_DERIVATION_VERSION`.
 */
export function heuristicCropV1(
  source: SourceDimensions,
  policy: IdentityHeuristicPolicy = HEURISTIC_V1,
): SourcePixelCrop | null {
  if (!isPositiveSize(source)) return null;
  const portraitLike = source.height / source.width >= policy.minPortraitRatio;
  const side = Math.floor(portraitLike ? source.width : Math.min(source.width, source.height));
  if (side <= 0) return null;
  return {
    left: clampInt(Math.round((source.width - side) / 2), 0, source.width - side),
    top: clampInt(Math.round(source.height * policy.topOffsetFraction), 0, source.height - side),
    width: side,
    height: side,
  };
}

/**
 * The hard geometry gate every crop passes, whoever proposed it.
 *
 * Order matters: shape problems report as `invalid_crop` and size problems as
 * `crop_too_small`, because those two codes differ in retryability — a
 * too-small crop stays refused until the SOURCE changes, while an invalid one is a
 * caller bug. A character owner's manual crop is checked here exactly as a
 * detector's is; a correction may fix framing, never bypass bounds.
 */
export function validateIdentityCrop(
  crop: SourcePixelCrop,
  source: SourceDimensions,
  policy: IdentityCropPolicy = IDENTITY_CROP_POLICY_V1,
): IdentityCropValidation {
  if (
    !Number.isInteger(crop.left) ||
    !Number.isInteger(crop.top) ||
    !Number.isInteger(crop.width) ||
    !Number.isInteger(crop.height)
  ) {
    return { ok: false, code: "invalid_crop", reason: "not_integer" };
  }
  if (crop.width <= 0 || crop.height <= 0) {
    return { ok: false, code: "invalid_crop", reason: "non_positive" };
  }
  if (
    crop.left < 0 ||
    crop.top < 0 ||
    crop.left + crop.width > source.width ||
    crop.top + crop.height > source.height
  ) {
    return { ok: false, code: "invalid_crop", reason: "out_of_bounds" };
  }
  if (crop.width !== crop.height) {
    return { ok: false, code: "invalid_crop", reason: "not_square" };
  }
  if (crop.width < policy.minimumOutputSidePx || crop.height < policy.minimumOutputSidePx) {
    return { ok: false, code: "crop_too_small", reason: "below_minimum" };
  }
  return { ok: true };
}
