import { and, eq, inArray } from "drizzle-orm";
import { db, images } from "../db";
import type { ImageKind, ImageFileRef } from "./asset-storage";
import { purgeImagesWhere } from "./asset-deletion";

/**
 * Hard-delete a chat's player-attached photos:
 * `kind: "chat_upload"` rows are player content, deleted WITH their message /
 * conversation — never Gallery survivors like scenes. With `anchorMessageIds`
 * only the attachments of those messages go (a snip / rerun successor sweep);
 * without, every upload in the chat goes — including never-sent orphans whose
 * `anchor_message_id` was never stamped (Clear Chat, deleteChat). Files unlink
 * best-effort (image_sweep reconciles stragglers). Returns the count removed.
 */
export async function deleteChatUploads(chatId: string, anchorMessageIds?: readonly string[]): Promise<number> {
  if (anchorMessageIds !== undefined && anchorMessageIds.length === 0) return 0;
  return purgeImagesWhere(
    anchorMessageIds
      ? and(eq(images.chatId, chatId), eq(images.kind, "chat_upload"), inArray(images.anchorMessageId, [...anchorMessageIds]))
      : and(eq(images.chatId, chatId), eq(images.kind, "chat_upload")),
  );
}

/**
 * Hard-delete a conversation's chat-private assets by kind (uploads, look/place
 * references — everything that must NOT survive the chat the way scenes do).
 * Files unlink best-effort; the sweep reconciles stragglers.
 */
export async function deleteChatAssets(chatId: string, kinds: readonly ImageKind[]): Promise<number> {
  if (kinds.length === 0) return 0;
  return purgeImagesWhere(and(eq(images.chatId, chatId), inArray(images.kind, [...kinds])));
}

/**
 * Validate + claim a message's attachments at send time:
 * keep only ids that are THIS chat's ready `chat_upload` rows (order preserved,
 * unknown/foreign ids dropped), and stamp `anchor_message_id` so the message's
 * delete paths can find them. Returns the surviving ids with their file paths
 * (the vision read wants both).
 */
export async function claimChatAttachments(
  chatId: string,
  messageId: string,
  imageIds: readonly string[],
): Promise<ImageFileRef[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path })
    .from(images)
    .where(
      and(
        inArray(images.id, [...imageIds]),
        eq(images.chatId, chatId),
        eq(images.kind, "chat_upload"),
        eq(images.status, "ready"),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const kept = imageIds.map((id) => byId.get(id)).filter((row): row is ImageFileRef => row !== undefined);
  if (kept.length) {
    await db()
      .update(images)
      .set({ anchorMessageId: messageId })
      .where(inArray(images.id, kept.map((row) => row.id)));
  }
  return kept;
}

/** The file paths for a message's already-claimed attachments (regenerate/rerun re-reads). */
export async function chatAttachmentPaths(chatId: string, imageIds: readonly string[]): Promise<ImageFileRef[]> {
  if (imageIds.length === 0) return [];
  const rows = await db()
    .select({ id: images.id, ownerId: images.ownerId, path: images.path })
    .from(images)
    .where(and(inArray(images.id, [...imageIds]), eq(images.chatId, chatId), eq(images.kind, "chat_upload"), eq(images.status, "ready")));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return imageIds.map((id) => byId.get(id)).filter((row): row is ImageFileRef => row !== undefined);
}
