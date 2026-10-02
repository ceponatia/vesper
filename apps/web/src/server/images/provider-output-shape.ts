import sharp from "sharp";
import { chooseCropPlacement, type ImageProfileTask } from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { SHARP_DECODE_LIMITS } from "./asset-storage";
import { cropToTargetAspect, type RenderCropOutcome } from "./models";

/**
 * The output-shape decision a render makes about a provider's original, made
 * again for bytes that reach Vesper by another road: a paid output recovered
 * after its download failed (`reference-view-recovery.ts`).
 *
 * `renderWithModel` (`models.ts`) owns the decision for a live render. When the
 * shape it asked the provider for could not promise the lane's ratio, it crops
 * the answer toward that ratio, placed by `chooseCropPlacement` — top-anchored
 * for a too-tall subject-bearing render, centred otherwise. A recovered output
 * never passed through that step, so storing it as fetched would keep a frame
 * the same render would have trimmed. This repeats the step from the facts the
 * failed render recorded (`meta.render.shape`): the ratio it wanted and the
 * ratio it expected back. The decision is the render's own:
 *
 * - a request that named no ratio (the model's own shape) is never cropped;
 * - an expected shape that already matches the ratio is trusted, uncropped;
 * - anything else — including an edit whose provider derives the shape from
 *   its reference, which expects nothing — is cropped from the decoded image,
 *   and an image already at the ratio comes back untouched.
 *
 * A crop that fails degrades to the uncropped image with the render's own
 * diagnostic, as it does for a live render: the uncropped image beats none.
 */

/** Ratio distance below which two shapes are the same — the exact-match tolerance `chooseDimensions` decides with. */
const SAME_SHAPE_TOLERANCE = 0.001;

export interface ProviderOutputShapeRequest {
  /** The ratio the render asked for, or null for the model's own shape — which is never cropped. */
  readonly targetRatio: number | null;
  /** The ratio the render expected back, or null when nothing could say. */
  readonly expectedAspect: number | null;
  /** The render's profile task. It decides only whether a too-tall trim anchors to the top. */
  readonly task?: ImageProfileTask;
  /** The model that rendered the bytes, for the crop-failure diagnostic. */
  readonly modelSlug?: string;
}

export interface ShapedProviderOutput {
  /** The bytes to store: the cropped image, or the original when no crop was needed or possible. */
  readonly image: Buffer;
  /** The crop actually performed — `meta.render.shape.crop`'s shape — or null when none was. */
  readonly crop: RenderCropOutcome | null;
  /** The original's own size before the crop, read only when a crop was attempted. */
  readonly providerSize: { width: number; height: number } | null;
  /** The stored image's own size, when it could be read. */
  readonly returned: { width: number; height: number } | null;
}

/** A buffer's own pixel size, or null when it does not decode. */
async function pixelSize(buffer: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const { width, height } = await sharp(buffer, SHARP_DECODE_LIMITS).metadata();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

/** Shape a provider's original exactly as a live render of the same request would have. */
export async function shapeProviderOutput(
  original: Buffer,
  request: ProviderOutputShapeRequest,
  sink?: DiagnosticSink,
): Promise<ShapedProviderOutput> {
  const target = request.targetRatio;
  const untouched = async (): Promise<ShapedProviderOutput> => ({
    image: original,
    crop: null,
    providerSize: null,
    returned: await pixelSize(original),
  });
  if (target === null) return untouched();
  if (request.expectedAspect !== null && Math.abs(request.expectedAspect - target) < SAME_SHAPE_TOLERANCE) return untouched();

  const before = await pixelSize(original);
  // The uncropped image beats no image: a crop that cannot run keeps the
  // original, with the render's own diagnostic.
  const uncropped = (reason: string): ShapedProviderOutput => {
    sink?.push(
      diag("warn", "image_model.crop_failed", "could not crop the render to the requested shape", {
        path: "image_models",
        context: {
          ...(request.modelSlug === undefined ? {} : { slug: request.modelSlug }),
          targetRatio: target,
          error: reason,
        },
      }),
    );
    return { image: original, crop: null, providerSize: null, returned: before };
  };
  if (before === null) return uncropped("could not read image dimensions");
  try {
    const placement = chooseCropPlacement({
      task: request.task,
      outputWidth: before.width,
      outputHeight: before.height,
      targetRatio: target,
      focal: null,
    });
    const shaped = await cropToTargetAspect(original, target, placement);
    // `cropToTargetAspect` returns the very same buffer when the image already
    // had the ratio; recording a crop that never happened would be a lie.
    const crop: RenderCropOutcome | null =
      shaped === original
        ? null
        : {
            targetRatio: target,
            placement: placement.kind === "focal" ? "focal" : placement.gravity,
            rect: placement.rect,
            focalSource: "none",
          };
    return { image: shaped, crop, providerSize: before, returned: await pixelSize(shaped) };
  } catch (error) {
    return uncropped(error instanceof Error ? error.message : String(error));
  }
}
