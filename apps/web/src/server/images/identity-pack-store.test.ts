import { afterEach, describe, expect, it } from "vitest";
import {
  IDENTITY_PACK_DERIVATION_VERSION,
  IDENTITY_PACK_POLICY_VERSION,
  type ImageIdentityCropMethod,
  type ImageIdentityPackV1,
} from "@vesper/image-core";
import { projectIdentityPackPolicy, setIdentityIntrinsicPolicyForTesting } from "./identity-pack-store";

/**
 * `projectIdentityPackPolicy` is pure (no database, no filesystem) — the
 * re-judging logic itself, unlike the storage machinery around it, belongs to
 * a plain unit test rather than `.int.test.ts`.
 *
 * #667 follow-up: before `manualIntrinsicPolicy` was shared with this module,
 * every `ready` revision was re-judged against `intrinsicPolicy()` (the
 * AUTOMATIC 256px floor) regardless of its method, whenever its stamped
 * `policyVersion` differed from the current one. The first future policy-
 * version bump would have projected every already-accepted, enlarged manual
 * crop (128–255px) as `unusable`/`crop_too_small` — and every reference view,
 * portrait variant and scene anchor consuming that character would have
 * refused silently. These cases pin the fix: a manual crop below the
 * automatic floor stays usable on re-judge; an automatic one still does not.
 */

afterEach(() => {
  setIdentityIntrinsicPolicyForTesting(null);
});

/** A minimal, schema-shaped pack whose stamped `policyVersion` is always
 * OLDER than `IDENTITY_PACK_POLICY_VERSION` — the only state that makes
 * `projectIdentityPackPolicy` re-judge anything at all. */
function packFixture(method: ImageIdentityCropMethod, cropSide: number): ImageIdentityPackV1 {
  return {
    version: 1,
    id: "pack_1",
    characterId: "char_1",
    revision: 3,
    current: true,
    status: "ready",
    source: { imageId: "img_src", contentHash: "a".repeat(64), width: 768, height: 1024 },
    derivation: {
      schemaVersion: 1,
      derivationVersion: IDENTITY_PACK_DERIVATION_VERSION,
      // Deliberately not `IDENTITY_PACK_POLICY_VERSION`: that equality is the
      // gate `projectIdentityPackPolicy` checks before re-judging anything.
      policyVersion: "policy_v0",
      method,
      detectorVersion: method === "detector" ? "null_v1" : null,
      confidence: method === "detector" ? 0.95 : null,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    faceDetail: {
      imageId: "img_crop",
      crop: { left: 10, top: 10, width: cropSide, height: cropSide },
      outputWidth: cropSide,
      outputHeight: cropSide,
    },
    // No measurements: blur/occlusion/padding stay unarmed either way, so the
    // crop-size floor is the only thing these cases exercise.
    quality: null,
    warningCodes: [],
    failureCode: null,
    review: { actorUserId: null, reason: null, reviewedAt: null },
  };
}

describe("projectIdentityPackPolicy — manual floor (#667)", () => {
  it("still projects a manual crop below the automatic floor as usable", () => {
    const projection = projectIdentityPackPolicy(packFixture("manual", 154));
    expect(projection.blockedBy).toBeNull();
    expect(projection.pack.status).toBe("ready");
    expect(projection.pack.failureCode).toBeNull();
  });

  it("still projects an automatic crop below the automatic floor as unusable", () => {
    const projection = projectIdentityPackPolicy(packFixture("heuristic", 154));
    expect(projection.blockedBy).toBe("crop_too_small");
    expect(projection.pack.status).toBe("unusable");
    expect(projection.pack.failureCode).toBe("crop_too_small");
  });

  it("re-judges a manual crop under the MANUAL floor as unusable too", () => {
    // 100px clears neither floor — confirms the override lowers the floor
    // rather than disabling the check.
    const projection = projectIdentityPackPolicy(packFixture("manual", 100));
    expect(projection.blockedBy).toBe("crop_too_small");
    expect(projection.pack.status).toBe("unusable");
  });

  it("never re-judges a revision already stamped with the current policy version", () => {
    // A 100px heuristic crop would fail the size check immediately if this
    // were re-judged — the point is that it never reaches that check at all,
    // because its stamp already matches `IDENTITY_PACK_POLICY_VERSION`.
    const upToDate: ImageIdentityPackV1 = {
      ...packFixture("heuristic", 100),
      derivation: { ...packFixture("heuristic", 100).derivation, policyVersion: IDENTITY_PACK_POLICY_VERSION },
    };
    const projection = projectIdentityPackPolicy(upToDate);
    expect(projection.blockedBy).toBeNull();
    expect(projection.pack).toEqual(upToDate);
  });
});
