import type { IdentityPackIntrinsicPolicy, IdentityPackProfilePolicy } from "@/contracts/images/identity-pack";

/**
 * Every tunable identity-pack number, in one versioned place
 * (docs/developer-notes/image-identity-packs.spec.derivation.md §"Crop geometry"
 * and §"Versioned reference policy").
 *
 * The concentration is the whole point. A crop fraction that lives in a detector
 * adapter and a minimum size that lives in a route cannot be re-run against a
 * fixed corpus, and nobody can answer "which numbers produced this crop?" a month
 * later. Here, one import names the constants and the version strings that stamp
 * them onto every revision.
 *
 * Which version to bump when you change something:
 *
 * - `IDENTITY_PACK_DERIVATION_VERSION` — any change that would make the crop BYTES
 *   come out differently: the expansion fractions, the square rule, the heuristic
 *   offset, the storage ceiling. Existing crops become stale and are re-derived.
 * - `IDENTITY_PACK_POLICY_VERSION` — any change to a THRESHOLD in
 *   `INTRINSIC_POLICY_V1` or the profile defaults. Stored measurements are
 *   re-judged; no crop is re-derived.
 * - `IDENTITY_PACK_SCHEMA_VERSION` — the serialized contract shape itself changed.
 *
 * Changing a geometry constant without the matching derivation-version bump is
 * caught by the golden fixtures in `identity-pack-crop.test.ts`, which exist so
 * that "the crop moved" is always a deliberate act.
 *
 * The v1 numbers are deliberately conservative placeholders: the fixed trial
 * corpus (`image-identity-packs.spec.trial.md`) calibrates them, and until it has,
 * a refused reference is cheaper than a stranger's face in a render.
 */

/** The serialized pack contract's version (`ImageIdentityPackV1.version`). */
export const IDENTITY_PACK_SCHEMA_VERSION = 1;

/** Stamped on every revision; changing it invalidates existing crop bytes. */
export const IDENTITY_PACK_DERIVATION_VERSION = "derive_v1";

/** Stamped on every revision; changing it re-judges existing measurements. */
export const IDENTITY_PACK_POLICY_VERSION = "policy_v1";

/** Names the algorithm behind `ImageIdentityPackQuality.blurScore`. The raw score
 * is comparable only across revisions carrying the same label. */
export const IDENTITY_BLUR_ALGORITHM_VERSION = "laplacian_v1";

/**
 * How a detector face box becomes a square crop.
 *
 * The expansion fractions are of the FACE BOX's own dimensions, so the same policy
 * frames a small distant face and a large close one the same way. Top is the
 * largest (0.65) because a clipped hairline is the failure a reference reader
 * notices first; bottom (0.45) buys jaw, chin and a little neck without turning
 * the crop into a torso shot.
 *
 * `squareGrowthTopShare` is the vertical-centre shift the spec calls for, expressed
 * where it actually acts: when a wide requested rectangle has to grow taller to
 * become square, 60% of the added height goes above the face. Symmetric growth
 * (0.5) would spend half the new pixels on shoulders.
 *
 * `maximumLostPaddingFraction` is what makes an edge-hugging face fail instead of
 * quietly shipping a clipped reference: if clamping to the source eats more than a
 * third of the padding requested on ANY edge, the crop is refused.
 */
export interface IdentityCropPolicy {
  version: string;
  faceExpansionLeftFraction: number;
  faceExpansionRightFraction: number;
  faceExpansionTopFraction: number;
  faceExpansionBottomFraction: number;
  squareGrowthTopShare: number;
  /** Below this, the crop cannot be encoded without enlargement — refuse instead. */
  minimumOutputSidePx: number;
  /** Stored crops are downscaled to this ceiling, never enlarged to reach it. */
  maximumOutputSidePx: number;
  maximumLostPaddingFraction: number;
}

export const IDENTITY_CROP_POLICY_V1: IdentityCropPolicy = {
  version: IDENTITY_PACK_DERIVATION_VERSION,
  faceExpansionLeftFraction: 0.55,
  faceExpansionRightFraction: 0.55,
  faceExpansionTopFraction: 0.65,
  faceExpansionBottomFraction: 0.45,
  squareGrowthTopShare: 0.6,
  minimumOutputSidePx: 256,
  maximumOutputSidePx: 1024,
  maximumLostPaddingFraction: 0.35,
};

/**
 * The deterministic fallback used when no detector accepted a face.
 *
 * The ratio window is an ELIGIBILITY precondition, not a claim that the face is
 * inside the resulting square: a 1.2–2.2 tall image is plausibly a single-subject
 * portrait, so the guess is worth making and then measuring. Outside that window
 * (a landscape group shot, a 4:1 banner) the guess is not worth making at all and
 * derivation fails closed with `no_usable_face`.
 *
 * `topOffsetFraction` places the square just below the top of the frame, where a
 * portrait's head sits. It is pinned by golden tests; tuning it bumps
 * `IDENTITY_PACK_DERIVATION_VERSION`.
 */
export interface IdentityHeuristicPolicy {
  id: string;
  minPortraitRatio: number;
  maxPortraitRatio: number;
  topOffsetFraction: number;
}

export const HEURISTIC_V1: IdentityHeuristicPolicy = {
  id: "heuristic_v1",
  minPortraitRatio: 1.2,
  maxPortraitRatio: 2.2,
  topOffsetFraction: 0.08,
};

/**
 * Thresholds applied to a pack's own measurements.
 *
 * The four blur/occlusion thresholds are `null` at v1 — the checks are DEFINED but
 * not armed, because nobody has looked at enough real scores to say where the line
 * is. Null means "not enabled at this policy version", which is why the fields are
 * nullable rather than set to 0 (which would mean "block at any score").
 *
 * `possibleAdditionalFaceFloor` (0.3) sits far below `detectorConfidenceFloor`
 * (0.8) on purpose: a face too weak to be the subject is still strong enough to
 * make the identity ambiguous, and guessing between two people is the one failure
 * this system must never commit silently.
 */
export const INTRINSIC_POLICY_V1: IdentityPackIntrinsicPolicy = {
  version: IDENTITY_PACK_POLICY_VERSION,
  detectorConfidenceFloor: 0.8,
  possibleAdditionalFaceFloor: 0.3,
  minimumCropWidthPx: 256,
  minimumCropHeightPx: 256,
  blurWarningThreshold: null,
  blurBlockThreshold: null,
  occlusionWarningThreshold: null,
  occlusionBlockThreshold: null,
  minimumBoundaryPaddingPx: 8,
};

/**
 * The profile-layer defaults a render profile inherits until it declares its own.
 *
 * 96px is roughly where a face stops carrying enough detail to be a useful
 * identity reference at all, measured in the pixels the PROVIDER sees rather than
 * the ones we stored. `allowHeuristic` starts permissive because refusing every
 * heuristic crop before the trial would leave the feature with nothing to measure.
 */
export const PROFILE_POLICY_DEFAULTS_V1: IdentityPackProfilePolicy = {
  minimumEffectiveFaceWidthPx: 96,
  minimumEffectiveFaceHeightPx: 96,
  allowHeuristic: true,
  allowAdminOverride: true,
};
