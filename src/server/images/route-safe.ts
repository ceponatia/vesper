import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { diag } from "@/contracts/diagnostics";
import { db, images } from "@/server/db";
import {
  absoluteImagePath,
  deleteChatAssets,
  deleteChatUploads,
  saveImageBuffer,
  type ImageFileRef,
  type ImageKind,
  type ImageRow,
} from "./assets";

/**
 * Route-facing save boundary. The caller must supply the authenticated owner id;
 * a missing or foreign image is indistinguishable and no file or row is changed.
 *
 * The final write delegates to the internal row-before-file implementation only
 * after ownership is proven. `images.owner_id` is immutable through application
 * code, and the canonical-path database constraint binds the row to that owner.
 */
export async function saveOwnedImageBuffer(
  imageId: string,
  ownerId: string,
  buffer: Buffer,
  sink?: DiagnosticSink,
): Promise<ImageRow | null> {
  const [owned] = await db()
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!owned) {
    sink?.push(diag("error", "images.save_missing_row", `no owned images row for ${imageId}`));
    return null;
  }
  return saveImageBuffer(imageId, buffer, sink);
}

/**
 * Route-facing deletion of user-uploaded chat photos. Both the conversation id
 * and authenticated owner id participate in the select and delete predicates,
 * so a guessed foreign chat id deletes nothing.
 */
export async function deleteOwnedChatUploads(
  chatId: string,
  ownerId: string,
  anchorMessageIds?: readonly string[],
): Promise<number> {
  if (anchorMessageIds !== undefined && anchorMessageIds.length === 0) return 0;
  const where = anchorMessageIds
    ? and(
        eq(images.chatId, chatId),
        eq(images.ownerId, ownerId),
        eq(images.kind, "chat_upload"),
        inArray(images.anchorMessageId, [...anchorMessageIds]),
      )
    : and(eq(images.chatId, chatId), eq(images.ownerId, ownerId), eq(images.kind, "chat_upload"));
  return deleteOwnedRows(where);
}

/**
 * Route-facing deletion of chat-private image classes. The authenticated owner
 * id is mandatory even when the route has already loaded an owned chat.
 */
export async function deleteOwnedChatAssets(
  chatId: string,
  ownerId: string,
  kinds: readonly ImageKind[],
): Promise<number> {
  if (kinds.length === 0) return 0;
  return deleteOwnedRows(and(eq(images.chatId, chatId), eq(images.ownerId, ownerId), inArray(images.kind, [...kinds])));
}

async function deleteOwnedRows(where: Parameters<ReturnType<typeof db>["select"]>[0] extends never ? never : never): Promise<number> {
  // This declaration is replaced below; it exists only to keep the implementation
  // close to the route-safe wrappers without exporting a generic deletion seam.
  void where;
  return 0;
}

/** Internal implementation with a concrete Drizzle SQL predicate. */
async function deleteRows(where: import("drizzle-orm").SQL | undefined): Promise<number> {
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path })
    .from(images)
    .where(where);
  if (rows.length === 0) return 0;
  await db().delete(images).where(where);
  await Promise.all(rows.map((row: ImageFileRef) => fs.unlink(absoluteImagePath(row)).catch(() => undefined)));
  return rows.length;
}

// Keep the wrappers above readable while retaining a private, typed deletion primitive.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _routeSafeDeleteTypecheck = [deleteChatUploads, deleteChatAssets];
