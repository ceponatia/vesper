import { z } from "zod";
import type { ResolvedImageAttemptShape } from "../render-intent";
import { identityBlurScore, toGrayscale, type RawPixels } from "../identity/identity-pack-quality";

/**
 * Advisory signals recorded beside a render's provenance (issue #249).
 *
 * These are ADVISORY, never a gate: a render carrying every advisory this
 * module can produce still succeeds and is still stored. Nothing here refuses
 * a render, substitutes a model, or blocks a save — it only annotates a
 * finished, successful render with a readable reason, the measurement behind
 * it, and what the owner might try next (retry the same composition, ask for a
 * new variation, or an explicit repair). The owner's own agree/disagree
 * reviews are the evidence that eventually promotes, narrows, or retires a
 * signal — never a threshold crossing by itself.
 *
 * Same split as `identity/identity-pack-quality.ts`: MEASURING is permanent,
 * JUDGING is not. Each evaluator below computes a measurement first — a plain
 * fact about the render, independent of any threshold — and only THEN checks
 * it against a named constant to decide whether an advisory is worth showing.
 * `RENDER_ADVISORY_VERSION` is what changes when a judgment threshold moves;
 * the measurement shape underneath does not have to.
 *
 * Two signals exist today, both local and deterministic (no network call, no
 * privacy exposure): `harmful_crop_loss` reads the shape/crop record #247
 * already writes on every render, and `blank_output` / `severe_blur` read
 * pixel statistics computed in-process from a small decoded thumbnail. A
 * face-count signal was considered and deferred: the production identity
 * detector is a deliberate null seam (`identity/identity-pack-detector.ts`,
 * a privacy stance) and the only image-understanding path in this codebase is
 * an off-machine VLM call that needs its own review before it can feed an
 * advisory. See `docs/images/render-advisories.md`.
 */

/** Bumped when a JUDGMENT threshold below changes meaning, never when a
 * measurement's shape changes — a stored advisory's `version` says which
 * threshold set produced it, the same role `IDENTITY_PACK_POLICY_VERSION`
 * plays for identity packs. */
export const RENDER_ADVISORY_VERSION = 1 as const;

export const renderAdvisoryCodes = ["harmful_crop_loss", "blank_output", "severe_blur"] as const;
export const renderAdvisoryCodeSchema = z.enum(renderAdvisoryCodes);
export type RenderAdvisoryCode = (typeof renderAdvisoryCodes)[number];

/** What an advisory may suggest trying next — text the UI names, never a call
 * this package or the render path makes on the owner's behalf. */
export const renderAdvisoryOffers = ["retry_same", "new_variation", "repair"] as const;
export const renderAdvisoryOfferSchema = z.enum(renderAdvisoryOffers);
export type RenderAdvisoryOffer = (typeof renderAdvisoryOffers)[number];

/**
 * The wire/persisted shape, read back loosely: `evidence` stays a record
 * rather than a per-code union so a stored row from an older or newer version
 * of this module still parses, degrading only the fields a reader does not
 * recognize rather than the whole entry (docs/resilience.md §1). The
 * application layer extends this with its own `review` field when it merges
 * the owner's verdict — that is an application concept, not a producer one, so
 * it is deliberately absent here.
 */
export const renderAdvisorySchema = z.object({
  version: z.literal(RENDER_ADVISORY_VERSION),
  code: renderAdvisoryCodeSchema,
  level: z.literal("advisory"),
  reason: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  offers: z.array(renderAdvisoryOfferSchema),
});
export const renderAdvisoryListSchema = z.array(renderAdvisorySchema);

/** The measurement behind a `harmful_crop_loss` judgment. */
export interface CropLossMeasurement {
  /** The share of the pre-crop frame's area the crop removed — computed from
   * the two ASPECT RATIOS the shape record already carries, never from pixel
   * counts: the pre-crop buffer's own pixel dimensions are not persisted (only
   * the post-crop `returned` size is), but the ratio identity
   * `1 - min(a,b)/max(a,b)` gives the exact area fraction a crop-to-ratio
   * removes regardless of resolution. */
  trimmedFraction: number;
  placement: "focal" | "top" | "center";
}

/**
 * The measurement behind a `blank_output` or `severe_blur` judgment.
 *
 * `measuredWidth`/`measuredHeight` are the thumbnail's OWN pixel size, not
 * necessarily `BLUR_MEASUREMENT_WIDTH` — a source narrower than that resize
 * width is left alone (`withoutEnlargement: true`). Recording them is what
 * keeps a stored `laplacianVariance` interpretable after the resize width or
 * floor is recalibrated: the raw number means nothing without the pixel
 * count it scaled with.
 */
export interface OutputPixelMeasurement {
  /** Variance of the grayscale pixel values themselves — near zero for a flat,
   * near-uniform fill. */
  grayVariance: number;
  /** Variance of the Laplacian response (`identityBlurScore`) — null when the
   * thumbnail was too small to convolve. */
  laplacianVariance: number | null;
  /** The thumbnail's actual pixel width, as measured. */
  measuredWidth: number;
  /** The thumbnail's actual pixel height, as measured. */
  measuredHeight: number;
}

export type RenderAdvisory =
  | {
      version: typeof RENDER_ADVISORY_VERSION;
      code: "harmful_crop_loss";
      level: "advisory";
      reason: string;
      evidence: CropLossMeasurement;
      offers: RenderAdvisoryOffer[];
    }
  | {
      version: typeof RENDER_ADVISORY_VERSION;
      code: "blank_output" | "severe_blur";
      level: "advisory";
      reason: string;
      evidence: OutputPixelMeasurement;
      offers: RenderAdvisoryOffer[];
    };

/**
 * The trimmed-area fraction at or above which a crop is worth flagging.
 *
 * 0.15 sits above the ordinary aspect-ratio corrections this codebase performs
 * routinely — an 832x1216 model default trimmed to 3:4 removes only ~0.088 of
 * the frame and must NOT trigger — and below a crop that discards a real share
 * of what the model actually returned: a square render trimmed to 3:4 removes
 * exactly 0.25 and should. The threshold is a placeholder the owner's
 * agree/disagree reviews are meant to move; only `RENDER_ADVISORY_VERSION`
 * changes when it does.
 */
export const CROP_LOSS_ADVISORY_FRACTION = 0.15;

/**
 * Below this, a render's grayscale intensities are statistically
 * indistinguishable from one flat fill (variance under 4 is a standard
 * deviation under 2 of 255 levels) — the signature of an empty or solid-color
 * output, not merely a dim or low-contrast one.
 */
export const BLANK_OUTPUT_GRAY_VARIANCE_FLOOR = 4;

/**
 * The width the caller resizes a render's output to before measuring it
 * (`withoutEnlargement: true`, so a narrower source is left at its own size).
 * Named beside `SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR` because the two travel
 * together: that floor is calibrated at THIS resize width, and moving one
 * without the other silently changes what the floor means.
 */
export const BLUR_MEASUREMENT_WIDTH = 256;

/**
 * Below this, the Laplacian variance of the `BLUR_MEASUREMENT_WIDTH`-wide
 * measurement thumbnail reads as "no edges anywhere" rather than "soft edges
 * somewhere" — a smooth gradient with zero second-derivative response
 * measures at 0, while a genuinely sharp render's edges (a face, hair,
 * fabric) put it in the thousands at this same resize width. A placeholder
 * pending calibration against real output, same spirit as the identity
 * pack's v1 thresholds.
 */
export const SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR = 50;

/**
 * Crop-loss advisory from the render's own shape record — no pixels read.
 *
 * Null (no advisory, not even a sub-threshold measurement recorded) when: no
 * crop was performed (`shape.crop` absent — nothing was trimmed), or the
 * pre-crop aspect this render expected is unknown (`shape.expectedAspect`
 * null — "nothing could say what shape was coming" is not evidence of harm,
 * it is an absence of measurement, and the MEASURING/JUDGING split means an
 * absent measurement skips rather than fabricating a judgment). This mirrors
 * `evaluateIdentityPackIntrinsic`'s rule that a null measurement is skipped,
 * never treated as a failure.
 */
export function evaluateCropLoss(shape: ResolvedImageAttemptShape | null): RenderAdvisory | null {
  const crop = shape?.crop ?? null;
  if (!crop) return null;
  const expected = shape?.expectedAspect ?? null;
  if (expected === null || !(expected > 0)) return null;
  const target = crop.targetRatio;
  if (!(target > 0)) return null;

  const trimmedFraction = 1 - Math.min(expected, target) / Math.max(expected, target);
  if (trimmedFraction < CROP_LOSS_ADVISORY_FRACTION) return null;

  const evidence: CropLossMeasurement = { trimmedFraction, placement: crop.placement };
  return {
    version: RENDER_ADVISORY_VERSION,
    code: "harmful_crop_loss",
    level: "advisory",
    reason: "Fitting the requested frame trimmed a large share of what the model actually returned.",
    evidence,
    // Meaningless to retry verbatim — the same source would crop the same
    // way — so only a new composition is offered.
    offers: ["new_variation"],
  };
}

/**
 * Blank/blur advisory from the render's decoded output pixels.
 *
 * Null when the pixels cannot be measured at all (`toGrayscale` refuses a
 * buffer too small to be meaningful) — never a judgment on unmeasurable input.
 * Blank is checked before blur: a flat fill also has zero Laplacian variance,
 * and the honest statement about it is "nothing is there", not "it is out of
 * focus".
 */
export function evaluateOutputPixels(pixels: RawPixels): RenderAdvisory | null {
  const gray = toGrayscale(pixels);
  if (!gray || gray.length === 0) return null;

  const grayVariance = varianceOf(gray);
  const laplacianVariance = identityBlurScore(pixels);
  const evidence: OutputPixelMeasurement = {
    grayVariance,
    laplacianVariance,
    measuredWidth: pixels.width,
    measuredHeight: pixels.height,
  };

  if (grayVariance < BLANK_OUTPUT_GRAY_VARIANCE_FLOOR) {
    return {
      version: RENDER_ADVISORY_VERSION,
      code: "blank_output",
      level: "advisory",
      reason: "The render came back as a flat, near-uniform image with almost no visible detail.",
      evidence,
      offers: ["retry_same", "new_variation"],
    };
  }
  if (laplacianVariance !== null && laplacianVariance < SEVERE_BLUR_LAPLACIAN_VARIANCE_FLOOR) {
    return {
      version: RENDER_ADVISORY_VERSION,
      code: "severe_blur",
      level: "advisory",
      reason: "The render looks severely out of focus across the whole frame.",
      evidence,
      offers: ["retry_same", "new_variation"],
    };
  }
  return null;
}

/** Population variance of a grayscale sample - same `E[x^2] - E[x]^2` shape as
 * `identityBlurScore`'s own accumulation, clamped at 0 against float drift. */
function varianceOf(values: Float64Array): number {
  let sum = 0;
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / values.length;
  return Math.max(0, sumSquares / values.length - mean * mean);
}
