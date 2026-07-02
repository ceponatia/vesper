import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { CHAT_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, startJob, withUser } from "@/server/api";
import { characterChatMessages, db, images } from "@/server/db";
import { loadChatState } from "@/server/engine";
import { renderCharacterSceneImage } from "@/server/images";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Manual scene image for a conversation (docs/character-chat.md). POST queues a
 * sessionless scene render (a `chat_scene_image` job — the api-side path, recovered
 * by the detached-job sweep) centred on the recent chat; GET lists the character's
 * rendered scenes so the strip can poll for the new one. The asset stays filed
 * against the character (kind="scene", entityKind="character") until scene images
 * are chat-keyed, so it also surfaces in the Gallery under "Character chats".
 */

/** How many recent assistant lines the scene composer centres the shot on. */
const SCENE_CHAT_CONTEXT = 6;

/** POST body: no options today — character-chat scenes are single-reference (one subject). */
const sceneBodySchema = z.object({});

/** GET /api/chats/:chatId/scene — the participant character's chat scenes, newest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const scenes = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.ownerId, user.id),
        eq(images.kind, "scene"),
        eq(images.entityKind, "character"),
        eq(images.entityId, owned.character.id),
      ),
    )
    .orderBy(desc(images.createdAt));
  return jsonOk({ scenes });
});

/** POST /api/chats/:chatId/scene — queue a scene render from the recent chat. */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const parsed = await readBody(req, sceneBodySchema);
  if (!parsed.ok) return parsed.response;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (!rateLimit(`chat_scene:${user.id}`, CHAT_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many scene renders; try again in a minute", 429);
  }

  const profile = parseOr(
    characterProfileSchema,
    owned.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );

  const recent = await db()
    .select({ content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(SCENE_CHAT_CONTEXT);
  const recentChat = recent.map((r) => r.content).reverse();

  // The scene's outfit comes from the conversation's state (scenario modal free text +
  // exposed toggle), not the character's structured defaultOutfit — chat has no
  // equippable wardrobe.
  const chatState = await loadChatState(chatId, owned.participant.characterId);

  const jobId = await startJob({
    type: "chat_scene_image",
    payload: { chatId, characterId: owned.character.id },
    run: async () => ({
      imageId: await renderCharacterSceneImage({
        characterId: owned.character.id,
        userId: user.id,
        name: owned.character.name,
        profile,
        avatarImageId: owned.character.avatarImageId,
        recentChat,
        outfit: chatState?.outfit ?? "",
        outfitExposed: chatState?.outfitExposed ?? false,
        meters: chatState?.meters,
        conditions: chatState?.conditions,
      }),
    }),
  });
  return jsonOk({ jobId, chatId }, 202);
});
