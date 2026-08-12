import { describe, expect, it } from "vitest";
import {
  deriveDetectorCrop,
  heuristicCropV1,
  identityCropOutputSide,
  isHeuristicEligibleSource,
  normalizedCropToSourcePixels,
  paddingBetween,
  squareSourcePixelCrop,
  validateIdentityCrop,
  type DeriveIdentityCropResult,
  type IdentityCropGeometry,
} from "./identity-pack-crop";
import { HEURISTIC_V1, IDENTITY_CROP_POLICY_V1 } from "./identity-pack-policy";

/**
 * GOLDEN GEOMETRY. Every expected rectangle below is a pinned promise, not a
 * convenience assertion: the crop a character's face reference gets must not move
 * without someone deciding it should. If a change here makes these fail, the fix is
 * an `IDENTITY_PACK_DERIVATION_VERSION` bump plus re-derivation of existing packs —
 * never an updated expectation.
 */

function expectOk(result: DeriveIdentityCropResult): IdentityCropGeometry {
  if (!result.ok) throw new Error(`expected a usable crop, got ${result.code}`);
  return result.geometry;
}

describe("heuristic_v1 geometry", () => {
  it("pins the 3:4 canonical portrait crop", () => {
    // 1024/768 = 1.33 → portrait-like, so the side is the full WIDTH and the top
    // offset is 8% of the height (81.92 → 82).
    expect(heuristicCropV1({ width: 768, height: 1024 })).toEqual({
      left: 0,
      top: 82,
      width: 768,
      height: 768,
    });
  });

  it("pins a 1:2 portrait — the tall end of the eligible window", () => {
    expect(heuristicCropV1({ width: 1024, height: 2048 })).toEqual({
      left: 0,
      top: 164,
      width: 1024,
      height: 1024,
    });
  });

  it("falls to the smaller dimension when the frame is barely taller than wide", () => {
    // 1000/900 = 1.11, below the portrait threshold, so the square is min(w, h).
    expect(heuristicCropV1({ width: 900, height: 1000 })).toEqual({
      left: 0,
      top: 80,
      width: 900,
      height: 900,
    });
  });

  it("centres horizontally and clamps the top offset away on a landscape frame", () => {
    // A 1200 square cannot move down inside a 1200-tall source, so the 96px offset
    // clamps to 0 rather than producing an out-of-bounds rectangle.
    expect(heuristicCropV1({ width: 1600, height: 1200 })).toEqual({
      left: 200,
      top: 0,
      width: 1200,
      height: 1200,
    });
  });

  it("still produces a legal rectangle for a ratio no eligible source would have", () => {
    expect(heuristicCropV1({ width: 500, height: 2000 })).toEqual({
      left: 0,
      top: 160,
      width: 500,
      height: 500,
    });
  });

  it("returns null for a degenerate source instead of a zero-area rectangle", () => {
    expect(heuristicCropV1({ width: 0, height: 1024 })).toBeNull();
    expect(heuristicCropV1({ width: Number.NaN, height: 1024 })).toBeNull();
  });

  it("gates eligibility on the portrait ratio window, not on legal coordinates", () => {
    expect(isHeuristicEligibleSource({ width: 768, height: 1024 })).toBe(true);
    expect(isHeuristicEligibleSource({ width: 1024, height: 2048 })).toBe(true);
    // Exactly on both bounds — the window is inclusive.
    expect(isHeuristicEligibleSource({ width: 1000, height: 1200 })).toBe(true);
    expect(isHeuristicEligibleSource({ width: 1000, height: 2200 })).toBe(true);
    // Nearly square, landscape, and banner-tall are all refused: the heuristic's
    // guess is only worth making on a plausible single-subject portrait.
    expect(isHeuristicEligibleSource({ width: 900, height: 1000 })).toBe(false);
    expect(isHeuristicEligibleSource({ width: 1600, height: 1200 })).toBe(false);
    expect(isHeuristicEligibleSource({ width: 500, height: 2000 })).toBe(false);
  });

  it("keeps the pinned constants the fixtures above assume", () => {
    expect(HEURISTIC_V1).toEqual({
      id: "heuristic_v1",
      minPortraitRatio: 1.2,
      maxPortraitRatio: 2.2,
      topOffsetFraction: 0.08,
    });
  });
});

describe("detector expansion", () => {
  it("pins the expanded square for a comfortably framed face", () => {
    const geometry = expectOk(
      deriveDetectorCrop({ left: 284, top: 220, width: 200, height: 260 }, { width: 768, height: 1024 }),
    );
    expect(geometry.crop).toEqual({ left: 111, top: 51, width: 546, height: 546 });
    // Requested padding is the policy fraction of the FACE BOX's own dimensions.
    expect(geometry.requestedPaddingPx).toEqual({ topPx: 169, rightPx: 110, bottomPx: 117, leftPx: 110 });
    // Squaring a 420x546 request widens it, so both side paddings come out generous.
    expect(geometry.achievedPaddingPx).toEqual({ topPx: 169, rightPx: 173, bottomPx: 117, leftPx: 173 });
    expect(geometry.lostPaddingPx).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });
    expect(geometry.lostPaddingFraction).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });
  });

  it("biases vertical growth upward when a wide face box has to become square", () => {
    const geometry = expectOk(
      deriveDetectorCrop({ left: 300, top: 300, width: 300, height: 200 }, { width: 1200, height: 1200 }),
    );
    expect(geometry.crop).toEqual({ left: 135, top: 44, width: 630, height: 630 });
    // 210px of extra height, split 60/40 in favour of the hairline: the top gains
    // 126 over its request, the chin 84.
    expect(geometry.achievedPaddingPx.topPx - geometry.requestedPaddingPx.topPx).toBe(126);
    expect(geometry.achievedPaddingPx.bottomPx - geometry.requestedPaddingPx.bottomPx).toBe(84);
    expect(geometry.lostPaddingPx).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });
  });

  it("refuses a face hugging the top edge rather than shipping a clipped hairline", () => {
    const result = deriveDetectorCrop(
      { left: 300, top: 10, width: 200, height: 260 },
      { width: 800, height: 1000 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("no_usable_face");
    // The evidence survives the refusal — the coordinates were perfectly legal, and
    // only the lost-padding accounting shows why they were not usable.
    expect(result.geometry?.crop).toEqual({ left: 127, top: 0, width: 546, height: 546 });
    expect(result.geometry?.achievedPaddingPx.topPx).toBe(10);
    expect(result.geometry?.lostPaddingPx.topPx).toBe(159);
    expect(result.geometry?.lostPaddingFraction.topPx).toBeCloseTo(159 / 169, 10);
  });

  it("clamps the square to the source and refuses when the clamp eats the padding", () => {
    const result = deriveDetectorCrop(
      { left: 50, top: 50, width: 400, height: 500 },
      { width: 500, height: 600 },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("no_usable_face");
    // A 1050px request clamped to the 500px source width.
    expect(result.geometry?.crop).toEqual({ left: 0, top: 0, width: 500, height: 500 });
    expect(result.geometry?.lostPaddingFraction.leftPx).toBeCloseTo(170 / 220, 10);
  });

  it("reports a below-minimum square as crop_too_small, with its geometry intact", () => {
    const result = deriveDetectorCrop(
      { left: 170, top: 170, width: 60, height: 70 },
      { width: 400, height: 400 },
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("crop_too_small");
    expect(result.geometry?.crop).toEqual({ left: 126, top: 124, width: 148, height: 148 });
    // Nothing was lost: the crop is honest, just too small to encode without
    // enlargement, which is a different (and non-retryable) failure.
    expect(result.geometry?.lostPaddingPx).toEqual({ topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 });
  });

  it("rejects a face box outside its source without inventing geometry", () => {
    const outside = deriveDetectorCrop(
      { left: 700, top: 100, width: 200, height: 200 },
      { width: 768, height: 1024 },
    );
    if (outside.ok) throw new Error("expected refusal");
    expect(outside.code).toBe("invalid_crop");
    expect(outside.geometry).toBeNull();

    const degenerate = deriveDetectorCrop(
      { left: 0, top: 0, width: 0, height: 0 },
      { width: 768, height: 1024 },
    );
    if (degenerate.ok) throw new Error("expected refusal");
    expect(degenerate.code).toBe("invalid_crop");
  });

  it("keeps the pinned policy constants the fixtures above assume", () => {
    expect(IDENTITY_CROP_POLICY_V1).toEqual({
      version: "derive_v1",
      faceExpansionLeftFraction: 0.55,
      faceExpansionRightFraction: 0.55,
      faceExpansionTopFraction: 0.65,
      faceExpansionBottomFraction: 0.45,
      squareGrowthTopShare: 0.6,
      minimumOutputSidePx: 256,
      maximumOutputSidePx: 1024,
      maximumLostPaddingFraction: 0.35,
    });
  });
});

describe("padding accounting", () => {
  it("measures each face edge against its crop edge", () => {
    expect(
      paddingBetween({ left: 111, top: 51, width: 546, height: 546 }, { left: 284, top: 220, width: 200, height: 260 }),
    ).toEqual({ topPx: 169, rightPx: 173, bottomPx: 117, leftPx: 173 });
  });

  it("goes negative when a face escapes its crop — evidence, not an error", () => {
    expect(
      paddingBetween({ left: 100, top: 100, width: 200, height: 200 }, { left: 50, top: 120, width: 100, height: 100 }),
    ).toMatchObject({ leftPx: -50 });
  });
});

describe("normalized coordinates and squaring", () => {
  it("rounds normalized coordinates to source pixels without correcting them", () => {
    expect(
      normalizedCropToSourcePixels({ left: 0.25, top: 0.1, width: 0.5, height: 0.5 }, { width: 768, height: 1024 }),
    ).toEqual({ left: 192, top: 102, width: 384, height: 512 });
  });

  it("keeps a full-frame crop at the exact source bounds", () => {
    expect(
      normalizedCropToSourcePixels({ left: 0, top: 0, width: 1, height: 1 }, { width: 768, height: 1024 }),
    ).toEqual({ left: 0, top: 0, width: 768, height: 1024 });
  });

  it("snaps a rounded rectangle to a centred square inside the source", () => {
    const pixels = normalizedCropToSourcePixels(
      { left: 0.25, top: 0.1, width: 0.5, height: 0.5 },
      { width: 768, height: 1024 },
    );
    expect(validateIdentityCrop(pixels, { width: 768, height: 1024 })).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "not_square",
    });
    const squared = squareSourcePixelCrop(pixels, { width: 768, height: 1024 });
    expect(squared).toEqual({ left: 192, top: 166, width: 384, height: 384 });
    expect(validateIdentityCrop(squared, { width: 768, height: 1024 })).toEqual({ ok: true });
  });

  it("clamps a snapped square back inside a source it would overhang", () => {
    const squared = squareSourcePixelCrop(
      { left: 700, top: 900, width: 400, height: 400 },
      { width: 768, height: 1024 },
    );
    expect(squared).toEqual({ left: 368, top: 624, width: 400, height: 400 });
    expect(validateIdentityCrop(squared, { width: 768, height: 1024 })).toEqual({ ok: true });
  });
});

describe("crop validation", () => {
  const source = { width: 768, height: 1024 };

  it("accepts the heuristic crop it produced", () => {
    expect(validateIdentityCrop({ left: 0, top: 82, width: 768, height: 768 }, source)).toEqual({ ok: true });
  });

  it("names the rule a rejected crop broke", () => {
    expect(validateIdentityCrop({ left: 0, top: 0.5, width: 300, height: 300 }, source)).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "not_integer",
    });
    expect(validateIdentityCrop({ left: 0, top: 0, width: 0, height: 0 }, source)).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "non_positive",
    });
    expect(validateIdentityCrop({ left: 0, top: 300, width: 768, height: 768 }, source)).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "out_of_bounds",
    });
    expect(validateIdentityCrop({ left: -1, top: 0, width: 300, height: 300 }, source)).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "out_of_bounds",
    });
    expect(validateIdentityCrop({ left: 0, top: 0, width: 768, height: 700 }, source)).toEqual({
      ok: false,
      code: "invalid_crop",
      reason: "not_square",
    });
  });

  it("separates too-small from invalid, because only one of them is the caller's fault", () => {
    expect(validateIdentityCrop({ left: 0, top: 0, width: 255, height: 255 }, source)).toEqual({
      ok: false,
      code: "crop_too_small",
      reason: "below_minimum",
    });
    // Exactly at the floor is accepted — the minimum is inclusive.
    expect(validateIdentityCrop({ left: 0, top: 0, width: 256, height: 256 }, source)).toEqual({ ok: true });
  });
});

describe("output side", () => {
  it("caps at the storage ceiling and never enlarges below it", () => {
    expect(identityCropOutputSide(546)).toBe(546);
    expect(identityCropOutputSide(2048)).toBe(1024);
    expect(identityCropOutputSide(1024)).toBe(1024);
    // A 300px crop stays 300px: enlarging it would claim detail the bytes lack.
    expect(identityCropOutputSide(300)).toBe(300);
  });
});
