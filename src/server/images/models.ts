import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import type { output as ZodOutput, ZodType } from "zod";
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
import { preparePromptForImageModel, withReviewedImageQuality } from "./quality-presets";

/**
 * The image-model registry's server seam (image-model-registry.spec.md).
 *
 * Everything that renders an image goes through here: it loads the rows, picks
 * the one a surface should use, runs it, and normalizes the result back to
 * Vesper's 3:4 shape. Callers never name a provider or a model id — that moved
 * into the database when Venice was removed on 2026-08-05.
 */

/**
 * What a skipped registry row reports: its diagnostic code, the operator-facing
 * message, and the table name (which doubles as the diagnostic `path`). Passed in
 * rather than derived, because a caller naming its own table is the one thing
 * `parseRegistryRows` cannot know and the one thing that makes the diagnostic
 * actionable.
 */
export interface RegistryRowDiagnostic {
  code: string;
  message: string;
  path: string;
}

/**
 * Parse the rows of one registry table, dropping a row that fails rather than the
 * whole list (docs/resilience.md §1). A bad admin edit, or a column written by a
 * newer deploy, must not empty a picker — and the row that failed has to be
 * nameable, hence the id in the context.
 *
 * Shared by `loadImageModels` and `loadImageModelProfiles` instead of written
 * twice. The rule is identical in both (per-row `safeParse`, warn with the row id,
 * keep going), and a resilience rule that gets copy-pasted is one that eventually
 * diverges in whichever copy nobody edits. It also happens to be exactly the shape
 * `pnpm jscpd` fails a PR over.
 *
 * `rows` is typed only for the `id` it reports on, so any registry table whose
 * primary key is a text id can use it without a cast.
 */
export function parseRegistryRows<TSchema extends ZodType>(
  rows: readonly { readonly id: string }[],
  schema: TSchema,
  invalid: RegistryRowDiagnostic,
  sink?: DiagnosticSink,
): ZodOutput<TSchema>[] {
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    if (parsed.success) return [parsed.data];
    sink?.push(diag("warn", invalid.code, invalid.message, { path: invalid.path, context: { id: row.id } }));
    return [];
  });
}

/** Every registered model, sort-ordered. Rows are parsed at the trust boundary. */
export async function loadImageModels(sink?: DiagnosticSink): Promise<ImageModel[]> {
  const rows = await db().select().from(imageModels).orderBy(asc(imageModels.sort));
  return parseRegistryRows(
    rows,
    imageModelSchema,
    {
      code: "image_model.row_invalid",
      message: "an image_models row failed to parse and was skipped",
      path: "image_models",
    },
    sink,
  );
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
  /**
   * Provider-shaped control fields, already mapped against this version's
   * bindings (`compileProfileRenderPlan`). Passed straight through — this
   * wrapper deliberately knows nothing about control names, so the compile step
   * stays the single place a normalized control becomes a provider field.
   */
  controlInput?: Record<string, unknown>;
  /** This run's prediction budget (a profile's `timeoutMs`); null uses env/default. */
  timeoutMs?: number | null;
  /** Execute exactly this provider version; null takes the slug's own resolution. */
  versionId?: string | null;
}

export interface RenderWithModelResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  /**
   * The provider's prediction id when one exists, on success AND failure — the
   * provenance handle a caller records so a stored render can be traced back to
   * the provider's own record of it.
   */
  predictionId?: string;
  /**
   * The version the provider says it ACTUALLY ran, when it echoes one. Passed
   * through untouched from `ReplicateImageResult`, where the reason it exists is
   * recorded: a pin states intent, and only this states outcome.
   */
  executedVersionId?: string;
}

/**
 * Run one model and hand back a buffer in the shape the lane asked for.
 *
 * The model first crosses the reviewed-quality seam. That seam corrects known
 * harmful provider defaults and rewrites the provider-neutral identity lock into
 * Qwen Edit's numbered-reference dialect without teaching every lane about model
 * slugs. It is intentionally small and will be replaced by task profiles once
 * those profiles actually reach this path.
 *
 * This wrapper also owns shape negotiation. A lane says what ratio it wants;
 * `chooseAspect` finds the closest thing the model offers; anything short of
 * exact is centre-cropped here. That is what lets Stable Diffusion 3.5 Large (no
 * 3:4 in its enum) serve a portrait, and the same code serve the item lane's 1:1,
 * without either caller knowing which models need help.
 *
 * A crop failure is not fatal — the uncropped image beats no image — so it
 * degrades with a diagnostic.
 *
 * `controlInput`, `timeoutMs` and `versionId` are threaded through untouched
 * for callers that resolved a profile themselves (`compileProfileRenderPlan`).
 * Every existing lane — avatar, variants, scene, chat-look, entity — passes
 * none of them, so their payload, their prediction budget and their version
 * resolution are byte-identical to before: absent fields reach
 * `runRegistryImageModel` as absent, and absent means "no overlay, env budget,
 * slug-resolved version".
 *
 * The prompt crosses `preparePromptForImageModel` here even when the caller
 * already compiled it. That is safe because the rewrite is IDEMPOTENT — it
 * replaces the legacy identity lock with a Qwen-dialect one, and a prompt that
 * no longer contains the legacy sentence passes through untouched — so a
 * pre-compiled prompt arrives at the provider exactly as it was hashed.
 */
export async function renderWithModel(
  input: RenderWithModelInput,
  sink?: DiagnosticSink,
): Promise<RenderWithModelResult> {
  const targetRatio = input.targetRatio ?? IMAGE_TARGET_ASPECT;
  const model = withReviewedImageQuality(input.model);
  const prompt = preparePromptForImageModel(model, input.prompt, input.references?.length ?? 0);
  const aspect = chooseAspect(model, targetRatio);
  const result = await runRegistryImageModel(
    model,
    {
      prompt,
      ...(input.references ? { references: input.references } : {}),
      aspect: aspect.value,
      ...(input.controlInput ? { controlInput: input.controlInput } : {}),
      ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.versionId ? { versionId: input.versionId } : {}),
    },
    sink,
  );
  // Spread rather than assigned, so a run the provider never got a prediction id
  // (or never echoed a version) for reports no field at all instead of an
  // explicit undefined.
  const provenance = {
    ...(result.predictionId ? { predictionId: result.predictionId } : {}),
    ...(result.executedVersionId ? { executedVersionId: result.executedVersionId } : {}),
  };
  if (!result.ok || !result.image) {
    return { ok: false, ...provenance, error: result.error ?? `${model.slug} returned no image` };
  }
  // Crop when the model had no exact shape, and also when it offered none at
  // all — in that case it used its own default, which is unlikely to match.
  if (!aspect.needsCrop && aspect.value !== null) return { ok: true, ...provenance, image: result.image };
  try {
    return { ok: true, ...provenance, image: await cropToTargetAspect(result.image, targetRatio) };
  } catch (error) {
    sink?.push(
      diag("warn", "image_model.crop_failed", "could not crop the render to the requested shape", {
        path: "image_models",
        context: { slug: model.slug, targetRatio, error: error instanceof Error ? error.message : String(error) },
      }),
    );
    return { ok: true, ...provenance, image: result.image };
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
