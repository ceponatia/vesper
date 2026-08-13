import { hasLiveChatJob } from "../db";
import { log } from "../log";
import { enqueueJob } from "./jobs";

/**
 * Enqueue-only half of the chat reference-image jobs (chat-scene-references.plan.md)
 * — split from the handlers (`chat-reference-images.ts`) so the exchange finalizer
 * (`chat-state.ts`) can fire them without a chat-state ↔ handler import cycle.
 * Deduped one-live-per-chat (`hasLiveChatJob`, staleness-bounded) like
 * `enqueueChatSceneSketch`; never throws.
 */

export interface EnqueueChatLookArgs {
  chatId: string;
  characterId: string;
}

/** Enqueue a look mint (outfit/appearance changed). A lost enqueue re-fires on the next change. */
export async function enqueueChatLookImage(args: EnqueueChatLookArgs): Promise<void> {
  try {
    if (await hasLiveChatJob("chat_look_image", args.chatId)) return;
    await enqueueJob({ type: "chat_look_image", payload: { ...args } });
  } catch (err) {
    log.warn("chat_look", "failed to enqueue look image", {
      chatId: args.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface EnqueueChatPlaceArgs {
  chatId: string;
  characterId: string;
  placeName: string;
}

/** Enqueue a place mint (first render in a sketched place). A lost enqueue re-fires on the next render there. */
export async function enqueueChatPlaceImage(args: EnqueueChatPlaceArgs): Promise<void> {
  try {
    if (await hasLiveChatJob("chat_place_image", args.chatId)) return;
    await enqueueJob({ type: "chat_place_image", payload: { ...args } });
  } catch (err) {
    log.warn("chat_place", "failed to enqueue place image", {
      chatId: args.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
