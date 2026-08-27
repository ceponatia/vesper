import { asc, eq } from "drizzle-orm";
import sharp from "sharp";
import type { output as ZodOutput, ZodType } from "zod";
import {
  chooseDimensions,
  IMAGE_TARGET_ASPECT,
  imageAspectInputField,
  type ImageModel,
  imageModelSchema,
  type ImageRenderDimensionFacts,
  type ImageRenderPolicy,
  type PlannedControlReference,
  providerDefaultDimensions,
  type ProviderExecutionPolicy,
  withReviewedImageQuality,
} from "@vesper/image-core";
import type {
  ProviderInputViolation,
  RenderControlReference,
  ReplicatePredictionAttempt,
  UnsentReferenceReport,
} from "@vesper/image-replicate";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { db, imageModels } from "../db";
import { replicateClient } from "../ai";
import { prepareModelPrompt } from "./model-adapters";
import { prepareRenderReferences, referencePreparationTarget } from "./reference-preparation";

/**
 * The image-model registry's server seam.
 *
 * It loads the rows, runs one model, and normalizes the result back to the shape
 * the caller asked for. Callers never name a provider — that moved into the
 * database when Venice was removed on 2026-08-05.
 *
 * WHICH model runs is no longer decided here. Choosing is the profile layer's
 * job (`./model-profiles`), and every lane reaches this module through
 * `renderImageIntent`, so a render is always a profile's configuration rather
 * than a surface's default model.
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

export interface RenderWithModelInput {
  model: ImageModel;
  prompt: string;
  references?: Buffer[];
  /**
   * The caller's names for each `references` entry, index-parallel — a plan's
   * sent-reference roles (`renderImageIntent`). Diagnostic labels only, never a
   * provider field: the transport's trim report names what was kept and what
   * was given up by these. A missing entry falls back to `"reference"`, which
   * is what every buffer was labeled before roles traveled.
   */
  referenceRoles?: string[];
  /**
   * Structural controls bound to their own provider inputs, already resolved
   * against this version's `additionalImageInputs` (`planImageRender`).
   *
   * Separate from `references` because they are separate provider fields, and
   * because they do not cross the reference-capacity trim: a `pose_image` input
   * is not competing for a slot in the `image` array. The binding decision is
   * passed through untouched, like `controlInput` and for the same reason — it
   * belongs to the one place that reads the capability record. Only the BYTES
   * are touched here, by the same preparation pass the references cross.
   */
  controlReferences?: PlannedControlReference[];
  /**
   * The shape this lane wants, as a width/height ratio. Defaults to Vesper's
   * 3:4; the entity lanes ask for 1 (items) and 1.5 (locations).
   *
   * `null` is the explicit NATIVE shape — write no aspect/size key, pick no
   * provider bucket for being nearest a Vesper target, and do not crop what
   * comes back. Absent still means 3:4, so every existing caller is unchanged;
   * only a caller that says `null` gets the model's own default shape.
   */
  targetRatio?: number | null;
  /**
   * The compile step's dimension-resolver inputs (`compileProfileRenderPlan`):
   * operation, the merged resolution/width/height controls, and whether a
   * custom pair actually mapped. Absent — the trial, the lab, any direct caller
   * — dimension negotiation is the pure `chooseAspect` result, exactly as
   * before the facts existed.
   */
  dimensionFacts?: ImageRenderDimensionFacts;
  /**
   * Provider-shaped control fields, already mapped against this version's
   * bindings (`compileProfileRenderPlan`). Passed straight through — this
   * wrapper deliberately knows nothing about control names, so the compile step
   * stays the single place a normalized control becomes a provider field.
   */
  controlInput?: Record<string, unknown>;
  /**
   * The `controlInput` fields a typed semantic control produced, passed through
   * to the transport's strict validator so it can extend typed-owner trust to
   * them (a curated LoRA's probed weights field) without trusting the raw
   * override bag's fields.
   */
  typedControlFields?: readonly string[];
  /** This run's prediction budget (a profile's `timeoutMs`); null uses env/default. */
  timeoutMs?: number | null;
  /** Execute exactly this provider version; null takes the slug's own resolution. */
  versionId?: string | null;
  /**
   * How strictly the transport treats what it was handed
   * (`ImageRenderPolicy`). Absent is production's answer — trim what does not
   * fit, let the provider judge the values — so no existing lane moves.
   */
  policy?: ImageRenderPolicy;
  /**
   * How this run's prediction is WATCHED: one budget, or a startup budget and a
   * render budget with startup retries (`ProviderExecutionPolicy`).
   *
   * Threaded through untouched, like `controlInput` and `policy`, and for the
   * same reason — the lane that decided how patient to be is not this wrapper.
   * Absent is the production answer and leaves the transport's legacy
   * single-budget shell exactly as it was; the bench lanes resolve one
   * (`benchExecutionPolicy`) and read the attempts it makes the result carry.
   */
  executionPolicy?: ProviderExecutionPolicy;
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
  /**
   * How many primary references the transport actually sent, passed through
   * untouched from `ReplicateImageResult` (where the counting rule is
   * recorded). `renderImageIntent` truncates its sent-roles provenance to this,
   * so a stored attempt never claims a budget-trimmed reference was sent.
   */
  sentReferenceCount?: number;
  /**
   * Under a `require_all` reference policy: the selected references the
   * transport refused to leave behind, passed through untouched. Present only
   * on that pre-spend refusal, which is how a caller tells it apart from a
   * provider failure — nothing was created, so nothing was spent.
   */
  unsentReferences?: UnsentReferenceReport[];
  /**
   * Under a `strict` provider-input policy: the ways the finished payload
   * contradicted the version's probed schema. Same pre-spend rule.
   */
  providerInputViolations?: ProviderInputViolation[];
  /**
   * The shape decision this render actually made — the provider field and value
   * written (or their absence, under a native-shape request), what ratio the
   * result was expected at, and whether the returned image was cropped.
   *
   * Recorded because a stored run that says "3:4" cannot otherwise prove
   * whether the provider was told `aspect_ratio: "3:4"`, told `size:
   * "1536*2048"`, or told nothing and had its answer trimmed afterwards.
   */
  shape?: RenderShapeOutcome;
  /** The returned image's own pixel dimensions, when they could be read. */
  outputDimensions?: { width: number; height: number };
  /**
   * Every prediction this render created, oldest first — passed through
   * untouched from `ReplicateImageResult`, where the rule is recorded: present
   * ONLY when the caller supplied an `executionPolicy`, because only then can
   * one render create more than one prediction.
   *
   * `predictionId`/`executedVersionId` above keep describing the FINAL attempt,
   * so every existing consumer reads exactly what it always did. A bench that
   * records this list is what makes "the queue never let it start" and "the
   * model ran and failed" tellable apart after the fact.
   */
  attempts?: ReplicatePredictionAttempt[];
}

/** What one render asked the provider for, shape-wise, and what it did afterwards. */
export interface RenderShapeOutcome {
  /** `provider_default` when the caller asked for no shape at all. */
  mode: "provider_default" | "target_ratio";
  /** The provider input the shape was written to, or null when none was written. */
  field: string | null;
  /** The value written to that field, or null when the payload carried no shape. */
  value: string | null;
  /** The ratio the request expected back, or null when nothing could say. */
  expectedAspect: number | null;
  /** The ratio the result was cropped to, or null when no crop was performed. */
  cropTarget: number | null;
}

/**
 * Run one model and hand back a buffer in the shape the lane asked for.
 *
 * The model first crosses the reviewed-quality seam, which corrects known
 * harmful provider defaults. It is intentionally small and dissolves into
 * profile controls as those controls gain transports — the profiles now reach
 * this path, but the controls they would carry (guidance, steps, negatives)
 * still have no probed bindings.
 *
 * This wrapper also owns shape negotiation. A lane says what ratio it wants —
 * and, when it compiled a profile plan, what dimensions the profile asked for —
 * and `chooseDimensions` finds the closest thing the model offers; anything
 * short of exact is centre-cropped here, toward the lane's ratio. That is what
 * lets Stable Diffusion 3.5 Large (no 3:4 in its enum) serve a portrait, and
 * the same code serve the item lane's 1:1, without either caller knowing which
 * models need help.
 *
 * A crop failure is not fatal — the uncropped image beats no image — so it
 * degrades with a diagnostic.
 *
 * `controlInput`, `timeoutMs` and `versionId` are threaded through untouched for
 * callers that compiled a profile plan (`compileProfileRenderPlan`). Absent
 * fields reach `runRegistryImageModel` as absent, and absent means "no overlay,
 * env budget, slug-resolved version" — which is what the production lanes still
 * get for the last two, because `renderImageIntent` deliberately passes neither
 * a version pin nor a forced budget. Only the identity trial pins.
 *
 * The prompt crosses the model family's own dialect step here
 * (`prepareModelPrompt` → the `@vesper/image-models` adapter) even when the
 * caller already compiled it. That is safe because a preparer is contractually
 * IDEMPOTENT — the Qwen editors replace the legacy identity lock with their
 * numbered-reference one, and a prompt that no longer contains the legacy
 * sentence passes through untouched — so a pre-compiled prompt arrives at the
 * provider exactly as it was hashed. A model with no adapter is the ordinary
 * case and its prompt is returned unchanged.
 *
 * Reference and control bytes cross `prepareRenderReferences` here, and here
 * only — this is the one choke point every render path shares, so preparing at
 * it is what guarantees no raw buffer reaches the transport from any lane. A
 * reference whose preparation fails degrades to its original bytes with a
 * diagnostic rather than failing the render.
 */
export async function renderWithModel(
  input: RenderWithModelInput,
  sink?: DiagnosticSink,
): Promise<RenderWithModelResult> {
  // Absent means 3:4 (every production lane); an explicit `null` means the
  // model's own default shape, which is a different request from "unset".
  const targetRatio = input.targetRatio === undefined ? IMAGE_TARGET_ASPECT : input.targetRatio;
  const model = withReviewedImageQuality(input.model);
  const prompt = prepareModelPrompt(model, input.prompt, input.references?.length ?? 0);
  // Absent facts spread to nothing, and a factless request resolves to the pure
  // `chooseAspect` answer — the direct callers keep exactly their old shapes. A
  // native request skips the negotiation outright: nothing is bucketed toward a
  // target it never named.
  const dimensions =
    targetRatio === null
      ? providerDefaultDimensions()
      : chooseDimensions(model, { targetRatio, ...input.dimensionFacts });
  const aspectField = imageAspectInputField(model);
  const aspectValue = dimensions.input[aspectField];
  const preparationTarget = referencePreparationTarget(model);
  const references = input.references
    ? await prepareRenderReferences(
        // Each buffer travels under the caller's role for it, so a transport
        // trim report can say "location dropped" instead of "reference 2".
        input.references.map((buffer, index) => ({ buffer, role: input.referenceRoles?.[index] ?? "reference" })),
        preparationTarget,
        sink,
      )
    : undefined;
  // Control buffers cross the same pass with the field name as their label;
  // the binding itself (field, arity) is not this wrapper's to reinterpret.
  const controlReferences: RenderControlReference[] = [];
  for (const control of input.controlReferences ?? []) {
    controlReferences.push({
      field: control.field,
      arity: control.arity,
      buffers: await prepareRenderReferences(
        control.buffers.map((buffer) => ({ buffer, role: control.field })),
        preparationTarget,
        sink,
      ),
    });
  }
  const result = await replicateClient().runRegistryImageModel(
    model,
    {
      prompt,
      ...(references ? { references } : {}),
      ...(controlReferences.length ? { controlReferences } : {}),
      aspect: typeof aspectValue === "string" ? aspectValue : null,
      ...(input.controlInput ? { controlInput: input.controlInput } : {}),
      ...(input.typedControlFields?.length ? { typedControlFields: input.typedControlFields } : {}),
      ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.versionId ? { versionId: input.versionId } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.executionPolicy ? { executionPolicy: input.executionPolicy } : {}),
    },
    sink,
  );
  // Spread rather than assigned, so a run the provider never got a prediction id
  // (or never echoed a version, or never reached the transport's send) for
  // reports no field at all instead of an explicit undefined. The count is
  // compared against undefined, not truthiness: zero references sent is a real
  // count, absence means the transport never said.
  const shape = (cropTarget: number | null): RenderShapeOutcome => ({
    mode: targetRatio === null ? "provider_default" : "target_ratio",
    field: typeof aspectValue === "string" ? aspectField : null,
    value: typeof aspectValue === "string" ? aspectValue : null,
    expectedAspect: dimensions.expectedAspect,
    cropTarget,
  });
  const provenance = {
    ...(result.predictionId ? { predictionId: result.predictionId } : {}),
    ...(result.executedVersionId ? { executedVersionId: result.executedVersionId } : {}),
    ...(result.sentReferenceCount !== undefined ? { sentReferenceCount: result.sentReferenceCount } : {}),
    ...(result.unsentReferences ? { unsentReferences: result.unsentReferences } : {}),
    ...(result.providerInputViolations ? { providerInputViolations: result.providerInputViolations } : {}),
    // Spread on the same terms as everything above it: absent under no
    // execution policy, which is every production render, so a stored result
    // gains no new key it did not have.
    ...(result.attempts ? { attempts: result.attempts } : {}),
  };
  if (!result.ok || !result.image) {
    return { ok: false, ...provenance, shape: shape(null), error: result.error ?? `${model.slug} returned no image` };
  }
  // Crop when the expected shape misses the target, and also when nothing can
  // say what shape is coming — a model with no usable shape used its own
  // default, which is unlikely to match. A NATIVE request is exempt from both:
  // it named no target, so there is nothing for the result to miss.
  const skipCrop = targetRatio === null || (!dimensions.needsCrop && dimensions.expectedAspect !== null);
  if (skipCrop) {
    return { ok: true, ...provenance, shape: shape(null), ...(await outputDimensionsOf(result.image)), image: result.image };
  }
  try {
    const cropped = await cropToTargetAspect(result.image, targetRatio);
    return {
      ok: true,
      ...provenance,
      shape: shape(targetRatio),
      ...(await outputDimensionsOf(cropped)),
      image: cropped,
    };
  } catch (error) {
    sink?.push(
      diag("warn", "image_model.crop_failed", "could not crop the render to the requested shape", {
        path: "image_models",
        context: { slug: model.slug, targetRatio, error: error instanceof Error ? error.message : String(error) },
      }),
    );
    return { ok: true, ...provenance, shape: shape(null), ...(await outputDimensionsOf(result.image)), image: result.image };
  }
}

/**
 * The returned image's own pixel size, for the provenance record — spread into
 * the result, so an unreadable buffer contributes no field rather than a lie.
 *
 * Read here rather than inferred from the requested shape because those are
 * different facts: a model handed no shape at all answers at whatever size it
 * likes, and "what came back" is the only way a bench run can show it.
 */
async function outputDimensionsOf(buffer: Buffer): Promise<{ outputDimensions?: { width: number; height: number } }> {
  try {
    const { width, height } = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
    return width && height ? { outputDimensions: { width, height } } : {};
  } catch {
    return {};
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
