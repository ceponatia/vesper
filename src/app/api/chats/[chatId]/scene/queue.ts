import { and, desc, eq, or, sql } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { startJob } from "@/server/api";
import { characterChatMessages, db, jobs } from "@/server/db";
import { loadChatState } from "@/server/engine";
import { renderCharacterSceneImage } from "@/server/images";
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
    const [pending] = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "chat_scene_image"),
          or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
          sql`${jobs.payload} ->> 'chatId' = ${args.chatId}`,
        ),
      )
      .limit(1);
    if (pending) return null;

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
    // equippable wardrobe.
    const chatState = await loadChatState(args.chatId, args.character.id);

    return await startJob({
      type: "chat_scene_image",
      payload: { chatId: args.chatId, characterId: args.character.id },
      run: async () => ({
        imageId: await renderCharacterSceneImage({
          characterId: args.character.id,
          userId: args.userId,
          name: args.character.name,
          profile,
          avatarImageId: args.character.avatarImageId,
          recentChat,
          outfit: chatState?.outfit ?? "",
          outfitExposed: chatState?.outfitExposed ?? false,
          meters: chatState?.meters,
          conditions: chatState?.conditions,
          chatId: args.chatId,
          anchorMessageId,
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
