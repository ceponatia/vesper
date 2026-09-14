import { describe, expect, it } from "vitest";
import type { ResolvedImageAttemptShape } from "../render-intent";
import type { RawPixels } from "../identity/identity-pack-quality";
import {
  BLANK_OUTPUT_GRAY_VARIANCE_FLOOR,
  CROP_LOSS_ADVISORY_FRACTION,
  RENDER_ADVISORY_VERSION,
  SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR,
  evaluateCropLoss,
  evaluateOutputPixels,
  type RenderAdvisory,
} from "./render-advisories";

/**
 * Kills two classes of defect: (1) a crop-loss threshold that fires on an
 * ordinary aspect-ratio correction — the 832x1216-to-3:4 case a real portrait
 * lane produces on nearly every render — which would turn "advisory" into
 * "noise on every render" and train the owner to ignore it; and (2) a
 * blank/blur evaluator that judges a measurement it could not actually take
 * (a too-small buffer, a missing shape), which would fabricate a verdict where
 * the honest answer is "unmeasured, skip".
 */

function requireAdvisory(advisory: RenderAdvisory | null): RenderAdvisory {
  if (!advisory) throw new Error("expected an advisory, got null");
  return advisory;
}

function shapeWithCrop(over: {
  expectedAspect: number | null;
  targetRatio: number;
  placement?: "focal" | "top" | "center";
}): ResolvedImageAttemptShape {
  return {
    mode: "target_ratio",
    requestedAspect: over.targetRatio,
    targetSource: "lane",
    sentField: "aspect_ratio",
    sentValue: `${over.targetRatio}`,
    expectedAspect: over.expectedAspect,
    returned: { width: 100, height: 100 },
    crop: {
      targetRatio: over.targetRatio,
      placement: over.placement ?? "top",
      rect: { left: 0, top: 0, width: 100, height: 100 },
      focalSource: "none",
    },
  };
}

describe("evaluateCropLoss", () => {
  it("does not trigger on an 832x1216 model default trimmed to 3:4 (~0.088 trimmed)", () => {
    const shape = shapeWithCrop({ expectedAspect: 832 / 1216, targetRatio: 3 / 4 });
    expect(evaluateCropLoss(shape)).toBeNull();
  });

  it("triggers on a square render trimmed to 3:4 (exactly 0.25 trimmed)", () => {
    const shape = shapeWithCrop({ expectedAspect: 1, targetRatio: 3 / 4, placement: "center" });
    const advisory = requireAdvisory(evaluateCropLoss(shape));
    expect(advisory.code).toBe("harmful_crop_loss");
    expect(advisory.version).toBe(RENDER_ADVISORY_VERSION);
    expect(advisory.level).toBe("advisory");
    expect(advisory.offers).toEqual(["new_variation"]);
    if (advisory.code !== "harmful_crop_loss") throw new Error("unreachable");
    expect(advisory.evidence.trimmedFraction).toBeCloseTo(0.25, 10);
    expect(advisory.evidence.placement).toBe("center");
  });

  it("sits exactly at the documented threshold boundary", () => {
    // 1 - min(a,b)/max(a,b) = CROP_LOSS_ADVISORY_FRACTION when target/expected
    // = 1 - CROP_LOSS_ADVISORY_FRACTION.
    const expected = 1 - CROP_LOSS_ADVISORY_FRACTION;
    const shape = shapeWithCrop({ expectedAspect: expected, targetRatio: 1 });
    requireAdvisory(evaluateCropLoss(shape));
  });

  it("skips (never judges) when no crop was performed", () => {
    const shape: ResolvedImageAttemptShape = {
      mode: "provider_default",
      requestedAspect: null,
      targetSource: "raw",
      sentField: null,
      sentValue: null,
      expectedAspect: null,
      returned: { width: 100, height: 100 },
      crop: null,
    };
    expect(evaluateCropLoss(shape)).toBeNull();
  });

  it("skips (never judges) when the pre-crop expected aspect is unknown", () => {
    const shape = shapeWithCrop({ expectedAspect: null, targetRatio: 3 / 4 });
    expect(evaluateCropLoss(shape)).toBeNull();
  });

  it("skips on a null shape", () => {
    expect(evaluateCropLoss(null)).toBeNull();
  });
});

function greyPixels(width: number, height: number, value: (x: number, y: number) => number): RawPixels {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = value(x, y);
  }
  return { data, width, height, channels: 1 };
}

describe("evaluateOutputPixels", () => {
  it("flags a flat, near-uniform fill as blank_output", () => {
    const pixels = greyPixels(8, 8, () => 128);
    const advisory = requireAdvisory(evaluateOutputPixels(pixels));
    expect(advisory.code).toBe("blank_output");
    expect(advisory.offers).toEqual(["retry_same", "new_variation"]);
    if (advisory.code !== "blank_output") throw new Error("unreachable");
    expect(advisory.evidence.grayVariance).toBeLessThan(BLANK_OUTPUT_GRAY_VARIANCE_FLOOR);
  });

  it("flags a smooth gradient (high tonal variance, zero Laplacian response) as severe_blur, not blank", () => {
    const width = 16;
    const pixels = greyPixels(width, width, (x) => Math.round((255 * x) / (width - 1)));
    const advisory = requireAdvisory(evaluateOutputPixels(pixels));
    expect(advisory.code).toBe("severe_blur");
    if (advisory.code !== "severe_blur") throw new Error("unreachable");
    expect(advisory.evidence.grayVariance).toBeGreaterThanOrEqual(BLANK_OUTPUT_GRAY_VARIANCE_FLOOR);
    expect(advisory.evidence.laplacianVariance).not.toBeNull();
    expect(advisory.evidence.laplacianVariance as number).toBeLessThan(SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR);
  });

  it("does not flag a sharp, high-contrast pattern", () => {
    const width = 16;
    const pixels = greyPixels(width, width, (x, y) => ((x + y) % 2 === 0 ? 255 : 0));
    expect(evaluateOutputPixels(pixels)).toBeNull();
  });

  it("skips (never judges) a buffer too small to convolve", () => {
    const pixels = greyPixels(2, 2, () => 128);
    expect(evaluateOutputPixels(pixels)).toBeNull();
  });
});
