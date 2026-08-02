import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, images, items, locations } from "../db";
import { isDemoMode, unwrapVeniceImage, veniceGenerateImage, veniceImageModelId } from "../ai";
import { logEvent } from "../events";
import { runInBatches } from "@/lib/batches";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { purgeImagesWhere, runImagePipeline } from "./assets";
import { monogramSvg } from "./monogram";
import { buildItemImagePrompt, buildLocationImagePrompt } from "./prompts";

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
 * Entity image pipeline (docs/images.md §Entity images): a single text→image
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
  const loaded =
    input.entityKind === "item"
      ? await loadItemPrompt(input.entityId, input.userId)
      : await loadLocationPrompt(input.entityId, input.userId);
  const prompt = loaded?.prompt ?? "";

  const { imageId } = await runImagePipeline({
    asset: {
      ownerId: input.userId,
      kind: "entity",
      entityKind: input.entityKind,
      entityId: input.entityId,
      prompt,
      meta: { model: demo ? "demo" : `venice/${veniceImageModelId()}`, demo },
    },
    // A missing entity still leaves a failed row behind — no event, no diagnostic.
    failedPrecondition: loaded ? null : `${input.entityKind} ${input.entityId} not found`,
    // Only reached once the entity loaded, so the name fallback never fires.
    produce: async () => ({
      ok: true,
      image: demo ? monogramSvg(loaded?.name ?? "") : await generateEntityBuffer(prompt, ASPECT[input.entityKind]),
    }),
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

interface LoadedPrompt {
  name: string;
  prompt: string;
}

async function loadItemPrompt(entityId: string, ownerId: string): Promise<LoadedPrompt | null> {
  const [row] = await db()
    .select({ name: items.name, description: items.description, kind: items.kind, definition: items.definition })
    .from(items)
    .where(and(eq(items.id, entityId), eq(items.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  const def = row.definition as { sensory?: { appearance?: unknown } } | null;
  const appearance = typeof def?.sensory?.appearance === "string" ? def.sensory.appearance : undefined;
  return {
    name: row.name,
    prompt: buildItemImagePrompt({ name: row.name, description: row.description, kind: row.kind, appearance }),
  };
}

async function loadLocationPrompt(entityId: string, ownerId: string): Promise<LoadedPrompt | null> {
  const [row] = await db()
    .select({
      name: locations.name,
      description: locations.description,
      scale: locations.scale,
      ambient: locations.ambient,
    })
    .from(locations)
    .where(and(eq(locations.id, entityId), eq(locations.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  const ambient = row.ambient as { light?: unknown } | null;
  const light = typeof ambient?.light === "string" ? ambient.light : undefined;
  return {
    name: row.name,
    prompt: buildLocationImagePrompt({ name: row.name, description: row.description, scale: row.scale, light }),
  };
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

async function generateEntityBuffer(prompt: string, aspectRatio: `${number}:${number}`): Promise<Buffer> {
  // Venice/Qwen text-to-image (Flux removal — scene-images.plan.md). Item and
  // location shots are SFW (product/establishing), but the backend is Venice
  // now; a missing key / API error throws and the caller marks the row failed.
  const result = await veniceGenerateImage({ prompt, aspectRatio });
  return unwrapVeniceImage(result, "venice generate returned no image");
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
 * ENTITY_IMAGE_BATCH_SIZE (docs/images.md §Entity images). Used by the library
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
