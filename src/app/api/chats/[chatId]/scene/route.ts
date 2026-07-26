import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { imageRenderRejection, jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, images } from "@/server/db";
import { loadOwnedChat } from "../../owned";
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
 */

/** POST body: no options today — character-chat scenes are single-reference (one subject). */
const sceneBodySchema = z.object({});

/**
 * GET /api/chats/:chatId/scene — this chat's scenes only, newest first, plus whether a
 * render job is live (`rendering`): the pending image row doesn't exist until the slow
 * composer step finishes, so the flag is what keeps the client polling through it.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

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
});

/** POST /api/chats/:chatId/scene — queue a scene render from the recent chat. */
export const POST = withUser<Params>(
  async (user, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const parsed = await readBody(req, sceneBodySchema);
    if (!parsed.ok) return parsed.response;
    const owned = await loadOwnedChat(chatId, user.id);
    if (!owned) return jsonError("not_found", "chat not found", 404);

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const jobId = await queueChatScene({ userId: user.id, chatId, character: owned.character });
    if (!jobId) {
      return jsonError("scene_busy", "a scene render is already in flight; wait for it to finish", 409);
    }
    return jsonOk({ jobId, chatId }, 202);
  },
  { limit: "image_generate" },
);
