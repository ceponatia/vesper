import { describe, expect, it } from "vitest";
import {
  IDENTITY_CROP_POLICY_V1,
  identityPackSummaryStatuses,
  imageIdentityPackFailureCodes,
  imageIdentityPackWarningCodes,
} from "@vesper/image-core";
import {
  identityCropTooSmallCopy,
  identityManualCropEnlargementNotice,
  identityPackCodeCopy,
  identityPackStatusChip,
  identityPackStatusHint,
} from "./identity-pack-copy";

/**
 * The copy map is the ONLY place a stored code becomes English, so "every code has
 * copy" is a real invariant rather than a style check: a vocabulary addition that
 * lands without copy would otherwise reach an owner as a bare identifier.
 */

describe("identityPackCodeCopy", () => {
  it("gives every warning and failure code distinct, non-empty copy", () => {
    const codes = [...imageIdentityPackWarningCodes, ...imageIdentityPackFailureCodes];
    const seen = new Set(
      codes.map((code) => {
        const copy = identityPackCodeCopy(code);
        expect(copy.length).toBeGreaterThan(20);
        return copy;
      }),
    );
    expect(seen.size).toBe(codes.length);
  });

  it("tells the user what to DO about a blocking failure", () => {
    for (const code of ["no_usable_face", "ambiguous_faces", "crop_too_small"] as const) {
      expect(identityPackCodeCopy(code).toLowerCase()).toMatch(/crop|bigger|portrait/);
    }
  });
});

describe("identityCropTooSmallCopy (#667)", () => {
  it("names the actual floor it was measured against", () => {
    expect(identityCropTooSmallCopy(128)).toContain("128");
    expect(identityCropTooSmallCopy(256)).toContain("256");
    expect(identityCropTooSmallCopy(128)).not.toBe(identityCropTooSmallCopy(256));
  });
});

describe("identityManualCropEnlargementNotice (#667)", () => {
  it("discloses the enlargement below the automatic floor", () => {
    const notice = identityManualCropEnlargementNotice(150);
    expect(notice).not.toBeNull();
    expect(notice).toContain("150");
    expect(notice).toContain(String(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx));
  });

  it("says nothing at or above the automatic floor", () => {
    expect(identityManualCropEnlargementNotice(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx)).toBeNull();
    expect(identityManualCropEnlargementNotice(600)).toBeNull();
  });
});

describe("identityPackStatusChip", () => {
  it("labels every summary status, including the no-pack case", () => {
    for (const status of identityPackSummaryStatuses) {
      const chip = identityPackStatusChip(status);
      expect(chip.label.length).toBeGreaterThan(0);
      expect(identityPackStatusHint(status).length).toBeGreaterThan(0);
    }
  });

  it("marks the states that need the owner's attention", () => {
    expect(identityPackStatusChip("unusable").tone).toBe("danger");
    expect(identityPackStatusChip("failed").tone).toBe("danger");
    expect(identityPackStatusChip("ready").tone).toBe("ok");
  });
});
