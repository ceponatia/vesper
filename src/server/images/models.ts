import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import {
  chooseAspect,
  imageModelSchema,
  imageModelsForSurface,
  resolveImageModel,
  IMAGE_TARGET_ASPECT,
  type ImageModel,
  type ImageModelSurface,
} from "@/contracts";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { db, imageModels } from "../db";
import { runRegistryImageModel } from "../ai";

/**
 * The image-model registry's server seam (image-model-registry.spec.md).
 *
 * Everything that renders an image goes through here: it loads the rows, picks
 * the one a surface should use, runs it, and normalizes the result back to
 * Vesper's 3:4 shape. Callers never name a provider or a model id — that moved
 * into the database when Venice was removed on 2026-08-05.
 */

/** Every registered model, sort-ordered. Rows are parsed at the trust boundary. */
export async function loadImageModels(sink?: DiagnosticSink): Promise<ImageModel[]> {
  const rows = await db().select().from(imageModels).orderBy(asc(imageModels.sort));
  return rows.flatMap((row) => {
    const parsed = imageModelSchema.safeParse(row);
    if (parsed.success) return [parsed.data];
    // One malformed row must not empty the picker (docs/resilience.md §1): drop
    // it individually and say which, so a bad admin edit is visible but survivable.
    sink?.push(
      diag("warn", "image_model.row_invalid", "an image_models row failed to parse and was skipped", {
        path: "image_models",
        context: { id: typeof row.id === "string" ? row.id : "unknown" },
      }),
    );
    return [];
  });
}

/** One model by id, unparsed rows dropped. Used by the admin update/delete routes. */
export async function loadImageModel(id: string): Promise<ImageModel | null> {
  const [row] = await db().select().from(imageModels).where(eq(imageModels.id, id)).limit(1);
  if (!row) return null;
  const parsed = imageModelSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/** The models offered on one surface — what a picker lists. */
export async function loadImageModelsForSurface(surface: ImageModelSurface): Promise<ImageModel[]> {
  return imageModelsForSurface(await loadImageModels(), surface);
}

/**
 * Resolve a stored pick for a surface. A pick that no longer exists — a deleted
 * row, or a legacy Venice key from before the registry — degrades to the
 * surface's default rather than failing the render (owner ruling 5).
 */
export async function resolveSurfaceModel(
  surface: ImageModelSurface,
  storedId: string | null | undefined,
  sink?: DiagnosticSink,
): Promise<ImageModel | null> {
  const models = await loadImageModels(sink);
  const resolved = resolveImageModel(models, surface, storedId);
  if (!resolved) {
    sink?.push(
      diag("error", "image_model.none_offered", "no image model is registered for this surface", {
        path: "image_models",
        context: { surface },
      }),
    );
    return null;
  }
  if (storedId && resolved.id !== storedId && resolved.slug !== storedId) {
    sink?.push(
      diag("warn", "image_model.pick_unavailable", "the stored image model is not offered here; using the default", {
        path: "image_models",
        context: { surface, storedId, used: resolved.slug },
      }),
    );
  }
  return resolved;
}

export interface RenderWithModelInput {
  model: ImageModel;
  prompt: string;
  references?: Buffer[];
  /**
   * The shape this lane wants, as a width/height ratio. Defaults to Vesper's
   * 3:4; the entity lanes ask for 1 (items) and 1.5 (locations).
   */
  targetRatio?: number;
}

export interface RenderWithModelResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

/**
 * Run one model and hand back a buffer in the shape the lane asked for.
 *
 * This wrapper exists for the shape negotiation. A lane says what ratio it
 * wants; `chooseAspect` finds the closest thing the model offers; anything
 * short of exact is centre-cropped here. That is what lets Stable Diffusion 3.5
 * Large (no 3:4 in its enum) serve a portrait, and the same code serve the item
 * lane's 1:1, without either caller knowing which models need help.
 *
 * A crop failure is not fatal — the uncropped image beats no image — so it
 * degrades with a diagnostic.
 */
export async function renderWithModel(
  input: RenderWithModelInput,
  sink?: DiagnosticSink,
): Promise<RenderWithModelResult> {
  const targetRatio = input.targetRatio ?? IMAGE_TARGET_ASPECT;
  const aspect = chooseAspect(input.model, targetRatio);
  const result = await runRegistryImageModel(
    input.model,
    {
      prompt: input.prompt,
      ...(input.references ? { references: input.references } : {}),
      aspect: aspect.value,
    },
    sink,
  );
  if (!result.ok || !result.image) {
    return { ok: false, error: result.error ?? `${input.model.slug} returned no image` };
  }
  // Crop when the model had no exact shape, and also when it offered none at
  // all — in that case it used its own default, which is unlikely to match.
  if (!aspect.needsCrop && aspect.value !== null) return { ok: true, image: result.image };
  try {
    return { ok: true, image: await cropToTargetAspect(result.image, targetRatio) };
  } catch (error) {
    sink?.push(
      diag("warn", "image_model.crop_failed", "could not crop the render to the requested shape", {
        path: "image_models",
        context: { slug: input.model.slug, targetRatio, error: error instanceof Error ? error.message : String(error) },
      }),
    );
    return { ok: true, image: result.image };
  }
}

/**
 * Centre-crop a buffer to a target ratio, trimming whichever axis is long.
 * Sharp's `extract` needs integers, so the offsets are floored — a one-pixel
 * bias toward the top-left that no viewer can see.
 *
 * Cropping only ever removes: an image already at the target comes back
 * untouched, and nothing is ever padded, since padding would introduce bars.
 */
export async function cropToTargetAspect(buffer: Buffer, targetRatio: number = IMAGE_TARGET_ASPECT): Promise<Buffer> {
  const image = sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error", animated: false });
  const { width, height } = await image.metadata();
  if (!width || !height) throw new Error("could not read image dimensions");

  const currentAspect = width / height;
  if (Math.abs(currentAspect - targetRatio) < 0.001) return buffer;

  const [cropWidth, cropHeight] =
    currentAspect > targetRatio
      ? [Math.round(height * targetRatio), height] // too wide — trim the sides
      : [width, Math.round(width / targetRatio)]; // too tall — trim top and bottom

  return image
    .extract({
      left: Math.floor((width - cropWidth) / 2),
      top: Math.floor((height - cropHeight) / 2),
      width: Math.min(cropWidth, width),
      height: Math.min(cropHeight, height),
    })
    .toBuffer();
}
