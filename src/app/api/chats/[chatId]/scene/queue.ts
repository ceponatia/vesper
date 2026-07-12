import { and, desc, eq, or, sql } from "drizzle-orm";
import { characterProfileSchema, currentScenePlace, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { startJob } from "@/server/api";
import { characterChatMessages, db, jobs } from "@/server/db";
import { enqueueChatPlaceImage, loadChatState, resolveSeededOutfit } from "@/server/engine";
import { chatLookKey, renderCharacterSceneImage } from "@/server/images";
import { log } from "@/server/log";

/** How many recent assistant lines the scene composer centres the shot on. */
export const SCENE_CHAT_CONTEXT = 6;

export interface QueueChatSceneArgs {
  userId: string;
  chatId: string;
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null };
  /**
   * The assistant message the scene illustrates (slice 9). The auto path passes the
   * exchange's reply id; a manual render falls back to the newest assistant line.
   */
  anchorMessageId?: string;
  /**
   * "selfie" (chat-selfies.plan.md): render the subject's-own-camera framing on the
   * always-reference route with the retry-once failure policy. Shares the same
   * one-live-render-per-chat dedupe as scenes.
   */
  flavor?: "selfie";
}

/**
 * Whether a scene render job is live (queued/running) for this chat. Doubles as the
 * queue dedupe check and the GET route's `rendering` flag — the client polls on it
 * through the composer step, BEFORE the pending image row exists (the
 * painting-forever fix: without it the strip's placeholder never resolved until a
 * manual refresh).
 */
export async function hasLiveChatSceneJob(chatId: string): Promise<boolean> {
  const [live] = await db()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, "chat_scene_image"),
        or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
        sql`${jobs.payload} ->> 'chatId' = ${chatId}`,
      ),
    )
    .limit(1);
  return live !== undefined;
}

/**
 * Queue one chat scene render (`chat_scene_image` on the api-side startJob path,
 * recovered by the detached-job sweep) — shared by the manual POST …/scene route and
 * the slice-9 "auto at big moments" hook on the exchange pipeline. Assembles the same
 * context both ways: the recent assistant lines, the conversation's outfit/exposed
 * scenario fields, and the live meters/conditions. Never throws (the auto path is
 * fire-and-forget off a settled reply): failures log + return null.
 */
export async function queueChatScene(args: QueueChatSceneArgs): Promise<string | null> {
  try {
    // At most one live render per chat — auto can never stack renders (the same
    // check-then-insert dedupe shape as enqueueChatSummary).
    if (await hasLiveChatSceneJob(args.chatId)) return null;

    const profile = parseOr(
      characterProfileSchema,
      args.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const recent = await db()
      .select({ id: characterChatMessages.id, content: characterChatMessages.content })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, args.chatId), eq(characterChatMessages.role, "assistant")))
      .orderBy(desc(characterChatMessages.createdAt))
      .limit(SCENE_CHAT_CONTEXT);
    const recentChat = recent.map((r) => r.content).reverse();
    const anchorMessageId = args.anchorMessageId ?? recent[0]?.id;

    // The scene's outfit comes from the conversation's state (scenario modal free text +
    // exposed toggle), not the character's structured defaultOutfit — chat has no
    // equippable wardrobe. The seeded outfit MARKER (raw item ids) is resolved to the
    // garment phrase here like every other state consumer.
    const stored = await loadChatState(args.chatId, args.character.id);
    const chatState = stored ? await resolveSeededOutfit(stored, args.userId, profile) : null;

    // The setting comes from chat scene memory (chat-scene-fidelity.plan.md slice 2):
    // the current place's agent-written sketch when it exists, else its established
    // name + details. Empty memory keeps the DEFAULT_CHAT_ROOM placeholder.
    const place = chatState ? currentScenePlace(chatState.sceneMemory) : null;
    const room = place
      ? place.sketch?.trim() || [place.name, place.details.join("; ")].filter(Boolean).join(" — ")
      : undefined;

    // Chat reference anchors (chat-scene-references.plan.md): the outfit-true look
    // key the render resolves against the cached `chat_look`, and the LAZY place
    // mint — a sketched current place without an image gets one queued on the
    // first render there (fire-and-forget; this render still ships without it).
    const lookKey = chatState ? chatLookKey(chatState) : undefined;
    if (place?.sketch && !place.imageId) {
      void enqueueChatPlaceImage({ chatId: args.chatId, characterId: args.character.id, placeName: place.name });
    }

    return await startJob({
      type: "chat_scene_image",
      payload: { chatId: args.chatId, characterId: args.character.id, ...(args.flavor ? { flavor: args.flavor } : {}) },
      run: async () => ({
        imageId: await renderCharacterSceneImage({
          characterId: args.character.id,
          userId: args.userId,
          name: args.character.name,
          profile,
          avatarImageId: args.character.avatarImageId,
          room,
          timeOfDay: chatState?.sceneMemory.timeOfDay,
          recentChat,
          outfit: chatState?.outfit ?? "",
          outfitExposed: chatState?.outfitExposed ?? false,
          meters: chatState?.meters,
          conditions: chatState?.conditions,
          sceneModel: chatState?.sceneModel,
          chatId: args.chatId,
          anchorMessageId,
          flavor: args.flavor,
          lookKey,
          place: place?.imageId ? { name: place.name, imageId: place.imageId } : undefined,
        }),
      }),
    });
  } catch (error) {
    log.warn("chat_scene", "failed to queue chat scene", {
      chatId: args.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
