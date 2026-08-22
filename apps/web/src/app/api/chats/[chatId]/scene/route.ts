import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { imageRenderRejection, jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import { db, images } from "@/server/db";
import { isSimRoutedAuthority, readChatEngineAuthority } from "@/server/engine";
import { loadOwnedChat, type OwnedChat } from "../../owned";
import { hasLiveChatSceneJob, queueChatScene } from "./queue";

type Params = { chatId: string };

/**
 * Scene images for a conversation (docs/character-chat/images.md; slice 9 — inline scene
 * moments). POST queues a sessionless scene render (a `chat_scene_image` job — the
 * api-side path, recovered by the detached-job sweep) centred on the recent chat and
 * anchored to the newest assistant line; GET lists this CHAT's scenes only —
 * sibling conversations with the same character never leak in (the cross-chat
 * view is the Gallery's job). Assets stay filed against the character too
 * (kind="scene", entityKind="character"), so they still surface in the Gallery.
 *
 * This route currently belongs to the character-chat visual pipeline. A successor-routed
 * conversation is refused at POST until the simulation side exposes a structured visual
 * wardrobe projection (item identity + coverage/presentation), because feeding the scene
 * renderer character-chat wardrobe state while narration reads simulation world truth can
 * produce two different outfits for the same moment.
 */

/**
 * POST body: no options today — who appears is derived, not requested. The cast
 * is the roster filtered to `presence: "present"` (see `queueChatScene`).
 */
const sceneBodySchema = z.object({});

/**
 * GET /api/chats/:chatId/scene — this chat's scenes only, newest first, plus whether a
 * render job is live (`rendering`): the pending image row doesn't exist until the slow
 * composer step finishes, so the flag is what keeps the client polling through it.
 */
export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;

    const [scenes, rendering] = await Promise.all([
      db()
        .select()
        .from(images)
        .where(
          and(
            eq(images.ownerId, user.id),
            eq(images.kind, "scene"),
            eq(images.entityKind, "character"),
            eq(images.entityId, owned.character.id),
            // Scoped to THIS conversation — a sibling chat's scenes (or un-chat-keyed
            // rows) belong to the Gallery, not here.
            eq(images.chatId, chatId),
          ),
        )
        .orderBy(desc(images.createdAt)),
      hasLiveChatSceneJob(chatId),
    ]);
    return jsonOk({ scenes, rendering });
  },
);

/** POST /api/chats/:chatId/scene — queue a scene render from the recent chat. */
export const POST = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const parsed = await readBody(req, sceneBodySchema);
    if (!parsed.ok) return parsed.response;

    if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
      return jsonError(
        "scene_visual_authority_unavailable",
        "scene images are temporarily unavailable for successor-world chats until image rendering can read their world-owned wardrobe state",
        409,
      );
    }

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const jobId = await queueChatScene({
      userId: user.id,
      chatId,
      character: owned.character,
      roster: owned.roster.map((member) => member.character),
    });
    if (!jobId) {
      return jsonError("scene_busy", "a scene render is already in flight; wait for it to finish", 409);
    }
    return jsonOk({ jobId, chatId }, 202);
  },
  { limit: "image_generate" },
);
