/**
 * Trusted image mutation surface.
 *
 * These helpers intentionally omit an owner predicate and must never be imported
 * by request route modules. Approved callers are limited to:
 *
 * - image generation services under `src/server/images/`, which create the image
 *   row and immediately write that same freshly minted id;
 * - the chat rerun pipeline after the authenticated chat route has resolved the
 *   conversation; and
 * - `deleteChat`, which re-reads `(chatId, ownerId)` before running its cascade.
 *
 * Route-facing code must import the owner-scoped alternatives from the ordinary
 * `@/server/images` barrel instead.
 */
export {
  deleteChatAssets as internalDeleteChatAssets,
  deleteChatUploads as internalDeleteChatUploads,
  saveImageBuffer as internalSaveImageBuffer,
} from "./assets";
