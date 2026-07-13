import fs from "node:fs/promises";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, images, items, locations } from "../db";
import { describeProviderError, isDemoMode, veniceGenerateImage, veniceImageModelId } from "../ai";
import { logEvent } from "../events";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { absoluteImagePath, createImageAsset, failImage, saveImageBuffer } from "./assets";
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
 * reference edit, no variants. Generation failure marks the row failed and
 * returns its id; callers never catch. Demo mode paints a monogram.
 */
export async function generateEntityImage(input: GenerateEntityImageInput): Promise<string> {
  const demo = isDemoMode();
  const loaded =
    input.entityKind === "item"
      ? await loadItemPrompt(input.entityId, input.userId)
      : await loadLocationPrompt(input.entityId, input.userId);

  const asset = await createImageAsset({
    ownerId: input.userId,
    kind: "entity",
    entityKind: input.entityKind,
    entityId: input.entityId,
    prompt: loaded?.prompt ?? "",
    meta: { model: demo ? "demo" : `venice/${veniceImageModelId()}`, demo },
  });

  if (!loaded) {
    await failImage(asset.id, `${input.entityKind} ${input.entityId} not found`);
    return asset.id;
  }

  const started = Date.now();
  try {
    const buffer = demo ? monogramSvg(loaded.name) : await generateEntityBuffer(loaded.prompt, ASPECT[input.entityKind]);
    const saved = await saveImageBuffer(asset.id, buffer, input.sink);
    if (saved?.status === "ready") {
      await setEntityImage(input.entityKind, input.entityId, input.userId, asset.id);
      await reclaimOldImages(input.entityKind, input.entityId, input.userId, asset.id);
    }
    void logEvent(null, "image.entity", {
      imageId: asset.id,
      entityKind: input.entityKind,
      entityId: input.entityId,
      status: saved?.status ?? "failed",
      demo,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const message = describeProviderError(err);
    await failImage(asset.id, message);
    input.sink?.push(
      diag("warn", "images.entity.generate_failed", message.slice(0, 300), {
        context: { entityKind: input.entityKind, entityId: input.entityId, imageId: asset.id },
      }),
    );
    void logEvent(null, "image.entity", {
      imageId: asset.id,
      entityKind: input.entityKind,
      entityId: input.entityId,
      status: "failed",
      error: message.slice(0, 300),
    });
  }
  return asset.id;
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
  const where = and(
    eq(images.ownerId, ownerId),
    eq(images.entityKind, kind),
    eq(images.entityId, id),
    ne(images.id, keepId),
  );
  const rows = await db().select({ id: images.id, path: images.path }).from(images).where(where);
  if (rows.length === 0) return;
  await db().delete(images).where(where);
  for (const row of rows) {
    void fs.unlink(absoluteImagePath(row)).catch(() => undefined); // image_sweep reconciles stragglers
  }
}

async function generateEntityBuffer(prompt: string, aspectRatio: `${number}:${number}`): Promise<Buffer> {
  // Venice/Qwen text-to-image (Flux removal — scene-images.plan.md). Item and
  // location shots are SFW (product/establishing), but the backend is Venice
  // now; a missing key / API error throws and the caller marks the row failed.
  const result = await veniceGenerateImage({ prompt, aspectRatio });
  if (!result.ok || !result.image) throw new Error(result.error ?? "venice generate returned no image");
  return result.image;
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
  let done = 0;
  for (let i = 0; i < ids.length; i += ENTITY_IMAGE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + ENTITY_IMAGE_BATCH_SIZE);
    await Promise.all(
      chunk.map((entityId) =>
        generateEntityImage({ entityKind, entityId, userId, sink })
          .then(() => {
            done += 1;
          })
          .catch(() => undefined),
      ),
    );
  }
  return done;
}
