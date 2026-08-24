import { asc, eq } from "drizzle-orm";
import {
  evaluateImageLoraForRender,
  IMAGE_LORA_UNREACHABLE,
  type ImageExecutionContext,
  imageExecutionContextTask,
  type ImageLora,
  type ImageLoraCreateRequest,
  type ImageLoraRefusalCode,
  type ImageLoraRenderBinding,
  imageLoraScalesOrdered,
  imageLoraSchema,
  type ImageLoraSelection,
  type ImageLoraUpdateRequest,
  type ImageModel,
  isValidImageLoraLocator,
  redactImageLoraLocator,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { db, imageLoras } from "../db";
import { parseRegistryRows } from "./models";

/**
 * The LoRA library's server seam (image-model-capabilities.spec.md
 * §`image_loras`).
 *
 * Two jobs, and the split matters. The CRUD half is an ordinary owner-admin
 * registry: rows in, rows out, parsed at the trust boundary so one bad row costs
 * itself rather than the list. The RESOLUTION half is the only way a locator
 * reaches a render, and it exists so that the question "may these weights be sent
 * to this model?" is answered in exactly one place, before any provider work.
 *
 * The decision itself is pure (`evaluateImageLoraForRender` in `src/contracts`);
 * this module supplies the row, the model's probed bindings, and the diagnostic.
 * That division is what lets the whole decision table be tested without a
 * database — and it is why nothing here re-derives a compatibility rule.
 *
 * A refusal is REPORTED, never thrown: a LoRA that does not suit the model an
 * operator picked is an ordinary configuration state, and both callers have
 * somewhere honest to put it (the lab settles the row with the code; the render
 * intent fails the render before it spends).
 */

/** Every library row, label-ordered. One unparseable row is dropped, not the list. */
export async function listImageLoras(sink?: DiagnosticSink): Promise<ImageLora[]> {
  const rows = await db().select().from(imageLoras).orderBy(asc(imageLoras.label));
  return parseRegistryRows(
    rows,
    imageLoraSchema,
    {
      code: "image_lora.row_invalid",
      message: "an image_loras row failed to parse and was skipped",
      path: "image_loras",
    },
    sink,
  );
}

/**
 * One row by id, or null when it is missing OR unreadable.
 *
 * The two are deliberately one answer here. A row whose locator no longer passes
 * validation cannot be sent to a provider, so "there is no usable LoRA under this
 * id" is the truthful thing to tell a render — and the render path turns that into
 * `image_lora.unreachable_configuration`, which is exactly what an operator has to
 * fix.
 */
export async function loadImageLora(id: string): Promise<ImageLora | null> {
  const [row] = await db().select().from(imageLoras).where(eq(imageLoras.id, id)).limit(1);
  if (!row) return null;
  const parsed = imageLoraSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/** A mutation's result: the row as it now stands, or the typed reason it was refused. */
export type ImageLoraMutation =
  | { ok: true; lora: ImageLora }
  | { ok: false; code: "not_found" | "invalid"; message: string };

/**
 * Add one row. The request schema has already checked the locator and the scale
 * order, so the only remaining failure is the database's own check constraint —
 * which restates the same two rules and is the backstop, not the gate.
 */
export async function createImageLora(request: ImageLoraCreateRequest): Promise<ImageLora> {
  // Built here rather than read back from `returning()`: the id is ours to mint
  // (the model registry's own idiom), and a row assembled from a request that has
  // already passed this schema cannot fail to parse.
  const row = { id: newId(), ...request, builtin: false };
  await db().insert(imageLoras).values(row);
  return imageLoraSchema.parse(row);
}

/**
 * Edit one row.
 *
 * The cross-field invariants are re-checked against the MERGED row rather than
 * against the request, because a PATCH that raises only `minimumScale` is exactly
 * how a triple goes out of order — and a locator and its type can arrive in
 * different requests. Refusing here keeps the failure a 400 an operator can read,
 * instead of a constraint violation or, worse, a stored row that every render
 * then refuses.
 */
export async function updateImageLora(id: string, request: ImageLoraUpdateRequest): Promise<ImageLoraMutation> {
  const existing = await loadImageLora(id);
  if (!existing) return { ok: false, code: "not_found", message: "image lora not found" };
  if (Object.keys(request).length === 0) return { ok: true, lora: existing };

  const merged = { ...existing, ...request };
  if (!imageLoraScalesOrdered(merged)) {
    return {
      ok: false,
      code: "invalid",
      message: "minimumScale must be at most defaultScale, and defaultScale at most maximumScale",
    };
  }
  if (!isValidImageLoraLocator(merged.locatorType, merged.locator)) {
    return { ok: false, code: "invalid", message: `the locator does not match its ${merged.locatorType} type` };
  }

  await db().update(imageLoras).set(request).where(eq(imageLoras.id, id));
  return { ok: true, lora: (await loadImageLora(id)) ?? existing };
}

/**
 * Remove one row. Deleting a LoRA a profile or a lab experiment names is
 * deliberately allowed, on the model registry's own precedent: the stored
 * selection is a plain id, and a render that cannot resolve it refuses with
 * `image_lora.unreachable_configuration` rather than sending something else.
 */
export async function deleteImageLora(id: string): Promise<boolean> {
  const existing = await loadImageLora(id);
  if (!existing) return false;
  await db().delete(imageLoras).where(eq(imageLoras.id, id));
  return true;
}

/** The model, version and lane a selection is being judged against. */
export interface ImageLoraRenderContext {
  model: ImageModel;
  /** The version this render will execute, or null when nothing pins the row. */
  versionId: string | null;
  /**
   * WHERE this render is being run from ({@link ImageExecutionContext}) — a
   * lane, not a bare task.
   *
   * The bare task was the bug. Mechanical compatibility ("can these weights run
   * on this version?") and the row's production task curation ("may Vesper use
   * them for THIS job?") are different questions, and a task answers only the
   * second. The Image Generator has no task at all, so it borrowed one, and a
   * mechanically perfect LoRA was refused for breaking a curation rule about a
   * lane the bench is not in. The evaluator now applies task policy only where
   * the context says a lane exists (image-model-adapters.spec.md §"Execution
   * context").
   */
  execution: ImageExecutionContext;
}

export type ImageLoraResolution =
  | { ok: true; binding: ImageLoraRenderBinding }
  | { ok: false; code: ImageLoraRefusalCode; message: string };

/**
 * Resolve one selection into the binding a render may actually send.
 *
 * Called BEFORE any provider work by both callers, which is the whole point: a
 * LoRA refusal that arrived after the prediction started would have spent money
 * to learn something the library already knew. The lab pre-resolves and passes
 * the binding on the intent; `renderImageIntent` resolves for every other caller.
 *
 * The diagnostic carries the REDACTED locator (spec §`image_loras`), so a signed
 * URL's query parameters never reach a log line — and it is pushed here rather
 * than at each caller so a refusal is reported exactly once, in the vocabulary the
 * evaluator decided it in.
 */
export async function resolveImageLoraForRender(
  selection: ImageLoraSelection,
  context: ImageLoraRenderContext,
  sink?: DiagnosticSink,
): Promise<ImageLoraResolution> {
  // Both the lane and the task it implies, because a refusal read months later
  // has to say which rule refused: `generator_bench` carries no task at all, and
  // "task: item" on a bench row was exactly the fiction that hid the defect.
  const lane = { executionContext: context.execution.kind, task: imageExecutionContextTask(context.execution) };
  const lora = await loadImageLora(selection.id);
  if (!lora) {
    return refused(
      { ok: false, code: IMAGE_LORA_UNREACHABLE, message: `no usable LoRA library entry ${selection.id}` },
      { loraId: selection.id, slug: context.model.slug, ...lane },
      sink,
    );
  }

  const evaluated = evaluateImageLoraForRender({
    lora,
    modelSlug: context.model.slug,
    versionId: context.versionId,
    context: context.execution,
    ...(selection.scale === undefined ? {} : { requestedScale: selection.scale }),
    bindings: context.model.advancedCapabilities.controls,
  });
  if (evaluated.ok) return evaluated;
  return refused(
    evaluated,
    {
      loraId: lora.id,
      slug: context.model.slug,
      ...lane,
      versionId: context.versionId,
      locator: redactImageLoraLocator(lora.locator),
    },
    sink,
  );
}

/** Report one refusal and hand it back unchanged. */
function refused(
  resolution: Extract<ImageLoraResolution, { ok: false }>,
  context: Record<string, unknown>,
  sink?: DiagnosticSink,
): ImageLoraResolution {
  sink?.push(diag("warn", resolution.code, resolution.message, { path: "image_loras", context }));
  return resolution;
}
