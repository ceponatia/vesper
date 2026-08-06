import { describe, expect, it } from "vitest";
import type {
  DetectedFaceCandidate,
  IdentityPackIntrinsicPolicy,
  ImageIdentityPackQuality,
} from "@/contracts/images/identity-pack";
import {
  buildIdentityPackQuality,
  evaluateIdentityEffectiveSize,
  evaluateIdentityPackIntrinsic,
  evaluateIdentityProfilePolicy,
  identityBlurScore,
  selectIdentityFaceCandidate,
  type RawPixels,
} from "./identity-pack-quality";
import { INTRINSIC_POLICY_V1, PROFILE_POLICY_DEFAULTS_V1 } from "./identity-pack-policy";

const CROP = { left: 111, top: 51, width: 546, height: 546 };
const FACE_BOX = { left: 284, top: 220, width: 200, height: 260 };

function greyPixels(width: number, height: number, value: (x: number, y: number) => number): RawPixels {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = value(x, y);
  }
  return { data, width, height, channels: 1 };
}

function measuredBlur(pixels: RawPixels): number {
  const score = identityBlurScore(pixels);
  if (score === null) throw new Error("expected a measurable blur score");
  return score;
}

function candidate(confidence: number, left = 0): DetectedFaceCandidate {
  return { box: { left, top: 0, width: 100, height: 120 }, confidence };
}

function quality(overrides: Partial<ImageIdentityPackQuality> = {}): ImageIdentityPackQuality {
  return {
    algorithmVersion: "laplacian_v1",
    detectedFaces: 1,
    faceBox: FACE_BOX,
    faceWidthPx: 200,
    faceHeightPx: 260,
    faceAreaRatio: 0.17,
    blurScore: null,
    occlusionScore: null,
    padding: { topPx: 169, rightPx: 173, bottomPx: 117, leftPx: 173 },
    ...overrides,
  };
}

describe("blur scoring", () => {
  it("scores a flat image at exactly zero — a measurement, not an absence", () => {
    expect(identityBlurScore(greyPixels(8, 8, () => 128))).toBe(0);
    expect(identityBlurScore(greyPixels(8, 8, () => 0))).toBe(0);
  });

  it("scores a checkerboard far above a single hard edge, and an edge above flat", () => {
    const checker = measuredBlur(greyPixels(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255)));
    const edge = measuredBlur(greyPixels(8, 8, (x) => (x < 4 ? 0 : 255)));
    expect(checker).toBeCloseTo(1_040_400, 3);
    expect(edge).toBeCloseTo(21_675, 3);
    // The ordering is the contract; the absolute numbers only mean anything beside
    // the stored algorithm version.
    expect(checker).toBeGreaterThan(edge);
    expect(edge).toBeGreaterThan(0);
  });

  it("reads RGBA the same as grey and ignores alpha", () => {
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 8 * 8; i += 1) {
      const flip = (i % 8) + Math.floor(i / 8);
      const value = flip % 2 === 0 ? 0 : 255;
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      // Varying alpha must not move the score.
      rgba[i * 4 + 3] = i % 2 === 0 ? 0 : 255;
    }
    const score = measuredBlur({ data: rgba, width: 8, height: 8, channels: 4 });
    expect(score).toBeCloseTo(1_040_400, 3);
  });

  it("returns null when it could not measure, never a fabricated zero", () => {
    expect(identityBlurScore(greyPixels(2, 2, () => 128))).toBeNull();
    // Buffer shorter than the declared dimensions.
    expect(identityBlurScore({ data: new Uint8Array(4), width: 8, height: 8, channels: 1 })).toBeNull();
    expect(identityBlurScore({ data: new Uint8Array(64), width: 8, height: 8, channels: 0 })).toBeNull();
  });
});

describe("quality assembly", () => {
  it("derives face dimensions, area ratio and padding from the crop geometry", () => {
    const record = buildIdentityPackQuality({
      crop: CROP,
      detectedFaces: 1,
      faceBox: FACE_BOX,
      blurScore: 180.5,
      occlusionScore: null,
    });
    expect(record.algorithmVersion).toBe("laplacian_v1");
    expect(record.faceWidthPx).toBe(200);
    expect(record.faceHeightPx).toBe(260);
    expect(record.faceAreaRatio).toBeCloseTo(52_000 / (546 * 546), 10);
    expect(record.padding).toEqual({ topPx: 169, rightPx: 173, bottomPx: 117, leftPx: 173 });
    expect(record.occlusionScore).toBeNull();
  });

  it("leaves face-derived fields null for a heuristic crop instead of defaulting to zero", () => {
    const record = buildIdentityPackQuality({
      crop: CROP,
      detectedFaces: 0,
      faceBox: null,
      blurScore: 0,
      occlusionScore: null,
    });
    // 0 detected faces and a 0 blur score are REAL observations and survive intact;
    // the unmeasurable face geometry is null.
    expect(record.detectedFaces).toBe(0);
    expect(record.blurScore).toBe(0);
    expect(record.faceWidthPx).toBeNull();
    expect(record.faceAreaRatio).toBeNull();
    expect(record.padding).toEqual({ topPx: null, rightPx: null, bottomPx: null, leftPx: null });
  });
});

describe("candidate ruling", () => {
  it("accepts exactly one confident face", () => {
    const selection = selectIdentityFaceCandidate([candidate(0.9)]);
    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error("expected acceptance");
    expect(selection.primary.confidence).toBe(0.9);
    expect(selection.plausibleAdditional).toBe(0);
  });

  it("treats the primary floor as inclusive", () => {
    expect(selectIdentityFaceCandidate([candidate(0.8)]).ok).toBe(true);
    expect(selectIdentityFaceCandidate([candidate(0.79)]).ok).toBe(false);
  });

  it("refuses an empty or weak detection as no_usable_face", () => {
    const empty = selectIdentityFaceCandidate([]);
    if (empty.ok) throw new Error("expected refusal");
    expect(empty.code).toBe("no_usable_face");
    expect(empty.accepted).toBe(0);

    const weak = selectIdentityFaceCandidate([candidate(0.5)]);
    if (weak.ok) throw new Error("expected refusal");
    expect(weak.code).toBe("no_usable_face");
    // Still counted as plausible: it is why a later manual crop is the right fix.
    expect(weak.plausibleAdditional).toBe(1);
  });

  it("refuses two confident faces rather than picking one", () => {
    const selection = selectIdentityFaceCandidate([candidate(0.95), candidate(0.9, 400)]);
    if (selection.ok) throw new Error("expected refusal");
    expect(selection.code).toBe("ambiguous_faces");
    expect(selection.accepted).toBe(2);
  });

  it("refuses when a second face is merely plausible — the lower floor is the point", () => {
    const selection = selectIdentityFaceCandidate([candidate(0.95), candidate(0.4, 400)]);
    if (selection.ok) throw new Error("expected refusal");
    expect(selection.code).toBe("ambiguous_faces");
    expect(selection.accepted).toBe(1);
    expect(selection.plausibleAdditional).toBe(1);
  });

  it("ignores a background face below the additional floor", () => {
    const selection = selectIdentityFaceCandidate([candidate(0.95), candidate(0.1, 400)]);
    expect(selection.ok).toBe(true);
  });

  it("moves both floors with the policy version", () => {
    const permissive: IdentityPackIntrinsicPolicy = {
      ...INTRINSIC_POLICY_V1,
      detectorConfidenceFloor: 0.4,
      possibleAdditionalFaceFloor: 0.9,
    };
    const selection = selectIdentityFaceCandidate([candidate(0.5), candidate(0.2, 400)], permissive);
    expect(selection.ok).toBe(true);
  });
});

describe("intrinsic evaluation", () => {
  it("blocks a missing crop and a below-minimum crop with distinct codes", () => {
    expect(
      evaluateIdentityPackIntrinsic({ method: null, crop: null, quality: null }).blockers,
    ).toEqual(["invalid_crop"]);
    expect(
      evaluateIdentityPackIntrinsic({
        method: "detector",
        crop: { left: 0, top: 0, width: 200, height: 200 },
        quality: null,
      }).blockers,
    ).toEqual(["crop_too_small"]);
  });

  it("passes a healthy detector crop clean, and stamps the policy version", () => {
    const evaluation = evaluateIdentityPackIntrinsic({ method: "detector", crop: CROP, quality: quality() });
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.warnings).toEqual([]);
    expect(evaluation.policyVersion).toBe("policy_v1");
  });

  it("warns on a heuristic crop and on an admin override, without blocking either", () => {
    const evaluation = evaluateIdentityPackIntrinsic({
      method: "heuristic",
      crop: CROP,
      quality: quality({ faceBox: null, padding: { topPx: null, rightPx: null, bottomPx: null, leftPx: null } }),
      adminOverride: true,
    });
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.warnings).toEqual(["heuristic_crop", "manual_admin_override"]);
  });

  it("treats zero padding as measured, not missing", () => {
    const evaluation = evaluateIdentityPackIntrinsic({
      method: "detector",
      crop: CROP,
      quality: quality({ padding: { topPx: 0, rightPx: 20, bottomPx: 0, leftPx: 20 } }),
    });
    expect(evaluation.warnings).toEqual(["tight_hairline_padding", "tight_jaw_padding"]);
  });

  it("skips a null padding measurement rather than reading it as zero", () => {
    const evaluation = evaluateIdentityPackIntrinsic({
      method: "detector",
      crop: CROP,
      quality: quality({ padding: { topPx: null, rightPx: null, bottomPx: null, leftPx: null } }),
    });
    expect(evaluation.warnings).toEqual([]);
  });

  it("leaves blur and occlusion inert at policy_v1, even at a zero score", () => {
    const evaluation = evaluateIdentityPackIntrinsic({
      method: "detector",
      crop: CROP,
      quality: quality({ blurScore: 0, occlusionScore: 1 }),
    });
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.warnings).toEqual([]);
  });

  it("warns and blocks once the trial arms the thresholds", () => {
    const armed: IdentityPackIntrinsicPolicy = {
      ...INTRINSIC_POLICY_V1,
      version: "policy_v2",
      blurWarningThreshold: 100,
      blurBlockThreshold: 20,
      occlusionWarningThreshold: 0.2,
      occlusionBlockThreshold: 0.6,
    };
    const mild = evaluateIdentityPackIntrinsic(
      { method: "detector", crop: CROP, quality: quality({ blurScore: 50, occlusionScore: 0.3 }) },
      armed,
    );
    expect(mild.blockers).toEqual([]);
    expect(mild.warnings).toEqual(["mild_blur", "partial_occlusion"]);
    expect(mild.policyVersion).toBe("policy_v2");

    const severe = evaluateIdentityPackIntrinsic(
      { method: "detector", crop: CROP, quality: quality({ blurScore: 10, occlusionScore: 0.7 }) },
      armed,
    );
    // One code, not two: the block is "this source yields no usable face", however
    // many measurements agree.
    expect(severe.blockers).toEqual(["no_usable_face"]);
    expect(severe.warnings).toEqual([]);
  });

  it("skips an unmeasured metric instead of failing the pack over it", () => {
    const armed: IdentityPackIntrinsicPolicy = {
      ...INTRINSIC_POLICY_V1,
      blurWarningThreshold: 100,
      blurBlockThreshold: 20,
    };
    const evaluation = evaluateIdentityPackIntrinsic(
      { method: "detector", crop: CROP, quality: quality({ blurScore: null }) },
      armed,
    );
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.warnings).toEqual([]);
  });
});

describe("effective provider size", () => {
  it("scales the stored face box into the provider's actual reference pixels", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "face_detail",
      faceBox: FACE_BOX,
      referenceRegion: { width: 546, height: 546 },
      effectiveReference: { width: 1024, height: 1024 },
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    expect(evaluation.measured).toBe(true);
    expect(evaluation.effectiveFaceWidthPx).toBe(375);
    expect(evaluation.effectiveFaceHeightPx).toBe(488);
    expect(evaluation.belowEffectiveFaceFloor).toBe(false);
    expect(evaluation.warnings).toEqual([]);
  });

  it("catches a face that only looks big enough before the provider downsamples it", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "face_detail",
      faceBox: FACE_BOX,
      referenceRegion: { width: 546, height: 546 },
      effectiveReference: { width: 256, height: 256 },
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    // A 200px face inside a 546px crop is 94px once the provider squeezes the
    // reference to 256 — under the 96px floor, despite a 1024px stored file.
    expect(evaluation.effectiveFaceWidthPx).toBe(94);
    expect(evaluation.effectiveFaceHeightPx).toBe(122);
    expect(evaluation.belowEffectiveFaceFloor).toBe(true);
    expect(evaluation.warnings).toEqual(["small_effective_face"]);
  });

  it("measures the canonical role against the whole source, not the crop", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "canonical_identity",
      faceBox: FACE_BOX,
      referenceRegion: { width: 768, height: 1024 },
      effectiveReference: { width: 512, height: 512 },
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    expect(evaluation.effectiveFaceWidthPx).toBe(133);
    expect(evaluation.effectiveFaceHeightPx).toBe(130);
    expect(evaluation.belowEffectiveFaceFloor).toBe(false);
  });

  it("warns rather than refusing when the provider's resize behavior is unknown", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "face_detail",
      faceBox: FACE_BOX,
      referenceRegion: { width: 546, height: 546 },
      effectiveReference: null,
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    expect(evaluation.measured).toBe(false);
    expect(evaluation.effectiveReferenceWidthPx).toBeNull();
    expect(evaluation.effectiveFaceWidthPx).toBeNull();
    expect(evaluation.belowEffectiveFaceFloor).toBe(false);
    expect(evaluation.warnings).toEqual(["small_effective_face"]);
  });

  it("stays quiet about the required canonical role when resize behavior is unknown", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "canonical_identity",
      faceBox: FACE_BOX,
      referenceRegion: { width: 768, height: 1024 },
      effectiveReference: null,
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    expect(evaluation.warnings).toEqual([]);
    expect(evaluation.measured).toBe(false);
  });

  it("cannot verify a face-detail role with no stored face box", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "face_detail",
      faceBox: null,
      referenceRegion: { width: 546, height: 546 },
      effectiveReference: { width: 1024, height: 1024 },
      policy: PROFILE_POLICY_DEFAULTS_V1,
    });
    expect(evaluation.measured).toBe(false);
    // The provider dimensions are still recorded — they are known; the face is not.
    expect(evaluation.effectiveReferenceWidthPx).toBe(1024);
    expect(evaluation.effectiveFaceWidthPx).toBeNull();
    expect(evaluation.warnings).toEqual(["small_effective_face"]);
  });

  it("moves the floor with the profile policy", () => {
    const evaluation = evaluateIdentityEffectiveSize({
      role: "face_detail",
      faceBox: FACE_BOX,
      referenceRegion: { width: 546, height: 546 },
      effectiveReference: { width: 256, height: 256 },
      policy: { ...PROFILE_POLICY_DEFAULTS_V1, minimumEffectiveFaceWidthPx: 64, minimumEffectiveFaceHeightPx: 64 },
    });
    expect(evaluation.belowEffectiveFaceFloor).toBe(false);
    expect(evaluation.warnings).toEqual([]);
  });
});

describe("profile policy gates", () => {
  it("lets a detector crop through untouched", () => {
    expect(
      evaluateIdentityProfilePolicy({
        method: "detector",
        adminOverride: false,
        policy: PROFILE_POLICY_DEFAULTS_V1,
      }),
    ).toEqual({ allowed: true, warnings: [] });
  });

  it("allows a heuristic crop but never silently", () => {
    expect(
      evaluateIdentityProfilePolicy({
        method: "heuristic",
        adminOverride: false,
        policy: PROFILE_POLICY_DEFAULTS_V1,
      }),
    ).toEqual({ allowed: true, warnings: ["heuristic_crop"] });
  });

  it("refuses a heuristic crop for a profile that forbids guessing", () => {
    expect(
      evaluateIdentityProfilePolicy({
        method: "heuristic",
        adminOverride: false,
        policy: { ...PROFILE_POLICY_DEFAULTS_V1, allowHeuristic: false },
      }).allowed,
    ).toBe(false);
  });

  it("marks an admin override on the render, and refuses it where it is not allowed", () => {
    expect(
      evaluateIdentityProfilePolicy({
        method: "manual",
        adminOverride: true,
        policy: PROFILE_POLICY_DEFAULTS_V1,
      }),
    ).toEqual({ allowed: true, warnings: ["manual_admin_override"] });
    expect(
      evaluateIdentityProfilePolicy({
        method: "manual",
        adminOverride: true,
        policy: { ...PROFILE_POLICY_DEFAULTS_V1, allowAdminOverride: false },
      }).allowed,
    ).toBe(false);
  });
});
