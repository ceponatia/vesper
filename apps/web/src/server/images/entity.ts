import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, images, items, locations } from "../db";
import { isDemoMode } from "../ai";
import { logEvent } from "../events";
import { runInBatches } from "@/lib/batches";
import { parseAspectValue } from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { purgeImagesWhere, runImagePipeline } from "./assets";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { monogramSvg } from "./monogram";
import { buildEntityPromptProgram, isEntityPromptRefusal } from "./entity-prompt-program";

export type EntityImageKind = "item" | "location";

export interface GenerateEntityImageInput {
  entityKind: EntityImageKind;
  entityId: string;
  userId: string;
  sink?: DiagnosticSink;
}

/** Item is square (catalog tile); location is a 3:2 landscape (its card is 3:2). */
const ASPECT: Record<EntityImageKind, `${number}:${number}`> = { item: "1:1", location: "3:2" };

/**
 * Entity image pipeline (docs/images/pipelines.md §Entity images): a single text→image
 * generation composed from the item/location's own fields, stored as a `kind:
 * "entity"` asset and set as the row's `imageId`. There is no gallery — a
 * regenerate replaces the old image (the previous asset is reclaimed). No
 * reference edit, no variants. Runs on the shared reserve → generate →
 * save-or-fail → log shell (`runImagePipeline`); generation failure marks the
 * row failed and returns its id, callers never catch. Demo mode paints a
 * monogram.
 */
export async function generateEntityImage(input: GenerateEntityImageInput): Promise<string> {
  const demo = isDemoMode();
  // Entity images have no picker of their own — each kind has its OWN task whose
  // default profile is seeded on the general-purpose text-to-image model the
  // lane used when it borrowed the portrait surface.
  const resolved = demo ? null : await resolveImageProfileForTask(input.entityKind, null, input.sink);
  const model = resolved?.model ?? null;
  // Demo mode paints a monogram and never reaches a provider, so it needs the
  // entity's NAME and nothing else — compiling a prompt program for it would be
  // a database read and a full compile in service of a letter on a coloured tile.
  //
  // This DOES change what a demo row records: it used to store the prompt the
  // old paragraph builder produced, and now stores an empty one. That is forced
  // rather than chosen. A prompt program compiles against a resolved model's
  // dialect and pack binding, and demo mode has no model to resolve — so the
  // only way to keep a prompt on these rows would be to keep the paragraph
  // builder alive purely for demo, which is the fallback path this lane exists
  // to delete. A demo row now says, accurately, that no prompt was built.
  const program =
    model === null
      ? await loadEntityName(input.entityKind, input.entityId, input.userId)
      : await buildEntityPromptProgram({
          entityKind: input.entityKind,
          entityId: input.entityId,
          ownerId: input.userId,
          model,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        });
  const compiled = program !== null && !isEntityPromptRefusal(program) ? program : null;
  const prompt = compiled?.prompt ?? "";

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "entity",
      entityKind: input.entityKind,
      entityId: input.entityId,
      prompt,
      meta: { model: demo ? "demo" : `replicate/${model?.slug ?? "none"}`, demo, ...(compiled?.meta ?? {}) },
    },
    // A missing entity still leaves a failed row behind — no event, no diagnostic.
    // A prompt-program refusal is louder: the row carries the reason, because a
    // lane pointed at an endpoint with no registered dialect is a configuration
    // problem an operator has to see rather than a render that quietly stops.
    failedPrecondition:
      program === null
        ? `${input.entityKind} ${input.entityId} not found`
        : isEntityPromptRefusal(program)
          ? program.refusal
          : demo || model
            ? null
            : "no image model is registered for entity images",
    // Only reached once the entity loaded, so the name fallback never fires.
    // Item and location shots are SFW (product / establishing) and are the one
    // lane that does NOT want 3:4 — items are square, locations landscape. The
    // registry serves them through the same shape negotiation as everything
    // else: the ratio is requested, the closest offered shape is used, and any
    // remainder is cropped. A failure still THROWS (this lane's ruled failure
    // shape), so provenance is recorded only on success.
    produce: async () => {
      if (demo || !resolved) return { ok: true, image: monogramSvg(compiled?.name ?? "") };
      const result = await renderImageIntent(
        {
          profile: resolved,
          prompt,
          references: [],
          target: { aspectRatio: parseAspectValue(ASPECT[input.entityKind]) ?? 1 },
          // The compiled exclusions ride the normalized control, so they reach the
          // provider only through the version's own probed `negative_prompt`
          // binding and are recorded as a dropped control otherwise. Null means
          // this version exposes no field, and no key is invented for it.
          ...(compiled?.negativePrompt === null || compiled?.negativePrompt === undefined
            ? {}
            : { controls: { negativePrompt: compiled.negativePrompt } }),
        },
        input.sink,
      );
      if (!result.ok || !result.image) throw new Error(result.error ?? `${resolved.model.slug} returned no image`);
      return { ok: true, image: result.image, ...renderAttemptMeta(result.attempt) };
    },
    onReady: async (asset) => {
      await setEntityImage(input.entityKind, input.entityId, input.userId, asset.id);
      await reclaimOldImages(input.entityKind, input.entityId, input.userId, asset.id);
    },
    onSettled: ({ imageId: id, status, startedMs }) =>
      void logEvent("image.entity", {
        imageId: id,
        entityKind: input.entityKind,
        entityId: input.entityId,
        status,
        demo,
        durationMs: Date.now() - startedMs,
      }),
    onThrown: ({ imageId: id, message }) =>
      void logEvent("image.entity", {
        imageId: id,
        entityKind: input.entityKind,
        entityId: input.entityId,
        status: "failed",
        error: message.slice(0, 300),
      }),
    failureDiagnostic: {
      code: "images.entity.generate_failed",
      context: { entityKind: input.entityKind, entityId: input.entityId },
    },
    sink: input.sink,
  });
  return imageId;
}

/**
 * The entity's display name, for the demo path's monogram.
 *
 * Returns null for a missing row, which is the same signal
 * `buildEntityPromptProgram` gives, so the pipeline's not-found branch reads one
 * way regardless of whether a model was resolved.
 */
async function loadEntityName(
  kind: EntityImageKind,
  entityId: string,
  ownerId: string,
): Promise<{ name: string; prompt: string; negativePrompt: null; meta: Record<string, unknown> } | null> {
  const table = kind === "item" ? items : locations;
  const [row] = await db()
    .select({ name: table.name })
    .from(table)
    .where(and(eq(table.id, entityId), eq(table.ownerId, ownerId)))
    .limit(1);
  return row ? { name: row.name, prompt: "", negativePrompt: null, meta: {} } : null;
}

async function setEntityImage(kind: EntityImageKind, id: string, ownerId: string, imageId: string): Promise<void> {
  if (kind === "item") {
    await db().update(items).set({ imageId }).where(and(eq(items.id, id), eq(items.ownerId, ownerId)));
  } else {
    await db().update(locations).set({ imageId }).where(and(eq(locations.id, id), eq(locations.ownerId, ownerId)));
  }
}

/**
 * Single-image-per-entity: after a fresh generation succeeds, drop every other
 * image row for this entity (a prior canonical, plus any lingering failed
 * attempts) and unlink their files — there is no gallery to preserve them.
 */
async function reclaimOldImages(kind: EntityImageKind, id: string, ownerId: string, keepId: string): Promise<void> {
  await purgeImagesWhere(
    and(eq(images.ownerId, ownerId), eq(images.entityKind, kind), eq(images.entityId, id), ne(images.id, keepId)),
  );
}

/** How many entity images generate concurrently in a batch (user spec). */
export const ENTITY_IMAGE_BATCH_SIZE = 5;

/**
 * The owner's items/locations that still lack an image — the batch candidates.
 * `opts.ids` intersects with a caller-supplied scope (the library sends the
 * ids visible under the active type/search filter, so "Generate images"
 * covers exactly the selected bucket); omit it to mean every missing entity.
 */
export async function missingEntityImageIds(
  entityKind: EntityImageKind,
  ownerId: string,
  opts?: { ids?: readonly string[] },
): Promise<string[]> {
  const table = entityKind === "item" ? items : locations;
  const scope = opts?.ids;
  if (scope && scope.length === 0) return [];
  const conds = [eq(table.ownerId, ownerId), isNull(table.imageId)];
  if (scope) conds.push(inArray(table.id, [...scope]));
  const rows = await db()
    .select({ id: table.id })
    .from(table)
    .where(and(...conds));
  return rows.map((r) => r.id);
}

/**
 * Generate images for many entities in parallel batches of
 * ENTITY_IMAGE_BATCH_SIZE (docs/images/pipelines.md §Entity images). Used by the library
 * "Generate images" button and new-world auto-generation. A single failure
 * never aborts the batch — each entity degrades independently. Returns how many
 * completed. Run inside a background job so it survives client navigation.
 */
export async function generateEntityImagesBatch(
  entityKind: EntityImageKind,
  ids: readonly string[],
  userId: string,
  sink?: DiagnosticSink,
): Promise<number> {
  return runInBatches(ids, ENTITY_IMAGE_BATCH_SIZE, (entityId) =>
    generateEntityImage({ entityKind, entityId, userId, sink }),
  );
}
