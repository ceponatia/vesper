import type { ImageProfileTask } from "./image-model-profiles";

/**
 * Where a crop's window actually goes.
 *
 * Everything the render path needs to run `sharp#extract` is here — a caller
 * never re-derives an offset from a placement, it reads `rect`. `kind` and
 * (for `explicit`) `gravity` are provenance: what a stored render's
 * `meta.render.shape.crop` should say ABOUT the rect, not a second way to
 * compute it.
 */
export type CropPlacement =
  | { kind: "focal"; rect: CropRect }
  | { kind: "explicit"; gravity: "top" | "center"; rect: CropRect };

/** One `sharp#extract`-shaped window, in the OUTPUT image's own pixel space. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A subject's bounding box within the OUTPUT image, in pixels — what a future
 * face/subject detector would supply.
 *
 * No production detector exists today: the identity pipeline's own detector
 * seam (`identity/identity-pack-detector.ts`) is a deliberate null — a privacy
 * stance, not a gap to fill — and the scene camera stores framing as an enum
 * id, never coordinates. This type is the wiring a future, explicitly
 * authorized detector would fill in; every caller in this codebase passes
 * `null`.
 */
export interface ImageFocalBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a focal box came from, for provenance. `"none"` is every render today. */
export type ImageFocalSource = "none" | "detector";

export interface ChooseCropPlacementInput {
  /**
   * The render's task, when known — absent for a caller with no profile
   * context (a direct trial or lab render). Only used to decide whether a
   * too-tall trim anchors to the top; every other decision is task-independent.
   */
  task?: ImageProfileTask;
  /** The image's own pixel size BEFORE cropping. */
  outputWidth: number;
  outputHeight: number;
  /** The width/height ratio the crop is trying to reach. */
  targetRatio: number;
  /** A known subject location, or `null` when none was supplied. */
  focal: ImageFocalBox | null;
}

/** Ratio distance below which no crop is needed at all. Mirrors `image-models.ts`. */
const EXACT_RATIO_TOLERANCE = 0.001;

/** Tasks whose render puts a face or subject near the top of the frame. */
const SUBJECT_BEARING_TASKS = new Set<ImageProfileTask>(["portrait", "variant", "scene", "chat_look"]);

interface TrimmedSize {
  cropWidth: number;
  cropHeight: number;
  /** Which axis a crop would actually trim; `"none"` when the shape already matches. */
  axis: "width" | "height" | "none";
}

/** The crop window's SIZE for a target ratio — the axis-agnostic half of the decision. */
function trimmedSize(outputWidth: number, outputHeight: number, targetRatio: number): TrimmedSize {
  const currentAspect = outputWidth / outputHeight;
  if (Math.abs(currentAspect - targetRatio) < EXACT_RATIO_TOLERANCE) {
    return { cropWidth: outputWidth, cropHeight: outputHeight, axis: "none" };
  }
  if (currentAspect > targetRatio) {
    // Too wide — trim the sides.
    return { cropWidth: Math.min(Math.round(outputHeight * targetRatio), outputWidth), cropHeight: outputHeight, axis: "width" };
  }
  // Too tall — trim top and bottom.
  return { cropWidth: outputWidth, cropHeight: Math.min(Math.round(outputWidth / targetRatio), outputHeight), axis: "height" };
}

/**
 * Slide a `windowSize` window along one axis so it contains as much of a span
 * `[start, start + spanSize)` as it can, clamped to `[0, total - windowSize]`.
 *
 * Centers on the span first, then nudges to cover its near edge and its far
 * edge in turn — the same "keep the subject in frame" rule a phone camera's
 * region-of-interest crop uses. A span wider than the window itself is
 * centered as closely as the window allows; there is no placement that fits
 * all of it.
 */
function axisOffset(start: number, spanSize: number, total: number, windowSize: number): number {
  const maxStart = Math.max(0, total - windowSize);
  const clamp = (value: number) => Math.min(Math.max(value, 0), maxStart);

  let offset = clamp(start + spanSize / 2 - windowSize / 2);
  if (start < offset) offset = clamp(start);
  if (start + spanSize > offset + windowSize) offset = clamp(start + spanSize - windowSize);
  return offset;
}

/**
 * Where to place a crop window that trims an image down to `targetRatio`.
 *
 * Pure — it never reads or writes a pixel, only decides a rectangle. The
 * caller (`renderWithModel`) reads the image's own dimensions, calls this, and
 * hands the answer to `cropToTargetAspect`, which performs exactly the
 * `rect` this returns.
 *
 * Two regimes:
 *
 * - **A focal box is known.** The crop window slides along the axis actually
 *   being trimmed to contain it (clamped to the image) — the other axis is
 *   never trimmed in a single-pass crop, so it is always centered. This is the
 *   wiring for a detector this codebase does not run yet; every caller passes
 *   `focal: null` today.
 * - **No focal box.** A too-TALL trim (cropping top and bottom) anchors to the
 *   TOP for a subject-bearing task (`portrait | variant | scene | chat_look` —
 *   heads sit near the top of those compositions), and centers for everything
 *   else (`item | location | chat_place`, or no task at all). A too-WIDE trim
 *   always centers, whatever the task: it trims the sides, which is background
 *   far more often than it is a face.
 *
 * A shape that already matches `targetRatio` answers with the whole image as
 * its own "window" (`axis: "none"`), so a caller that always builds a
 * placement never has to special-case the no-crop-needed answer itself.
 */
export function chooseCropPlacement(input: ChooseCropPlacementInput): CropPlacement {
  const { outputWidth, outputHeight, targetRatio, focal, task } = input;
  const { cropWidth, cropHeight, axis } = trimmedSize(outputWidth, outputHeight, targetRatio);

  if (focal) {
    const left =
      axis === "width"
        ? axisOffset(focal.left, focal.width, outputWidth, cropWidth)
        : Math.floor((outputWidth - cropWidth) / 2);
    const top =
      axis === "height"
        ? axisOffset(focal.top, focal.height, outputHeight, cropHeight)
        : Math.floor((outputHeight - cropHeight) / 2);
    return { kind: "focal", rect: { left: Math.floor(left), top: Math.floor(top), width: cropWidth, height: cropHeight } };
  }

  const anchorTop = axis === "height" && task !== undefined && SUBJECT_BEARING_TASKS.has(task);
  const gravity: "top" | "center" = anchorTop ? "top" : "center";
  const top = gravity === "top" ? 0 : Math.floor((outputHeight - cropHeight) / 2);
  const left = Math.floor((outputWidth - cropWidth) / 2);
  return { kind: "explicit", gravity, rect: { left, top, width: cropWidth, height: cropHeight } };
}
