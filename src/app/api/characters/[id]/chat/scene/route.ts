import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, startJob, withUser } from "@/server/api";
import { characterChatMessages, characters, db, images } from "@/server/db";
import { renderCharacterSceneImage } from "@/server/images";

type Params = { id: string };

/**
 * Manual scene image for the character-chat tab
 * (docs/developer-notes/character-chat.plan.md). POST queues a sessionless
 * scene render (a `scene_image` job, no session id) centred on the recent chat;
 * GET lists the chat's rendered scenes so the tab can poll for the new one. The
 * asset is filed against the character (kind="scene", entityKind="character"),
 * so it also surfaces in the Gallery under "Character chats".
 */

/** How many recent assistant lines the scene composer centres the shot on. */
const SCENE_CHAT_CONTEXT = 6;

/** POST body: the optional image-model pick (Flux/Qwen) from the chat picker. */
const sceneBodySchema = z.object({
  model: z.enum(["flux", "qwen"]).optional(),
});

/** GET /api/characters/:id/chat/scene — the character's chat scenes, newest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!character) return jsonError("not_found", "character not found", 404);

  const scenes = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.ownerId, user.id),
        eq(images.kind, "scene"),
        eq(images.entityKind, "character"),
        eq(images.entityId, id),
      ),
    )
    .orderBy(desc(images.createdAt));
  return jsonOk({ scenes });
});

/** POST /api/characters/:id/chat/scene — queue a scene render from the recent chat. */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, sceneBodySchema);
  if (!body.ok) return body.response;
  const [character] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile, avatarImageId: characters.avatarImageId })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!character) return jsonError("not_found", "character not found", 404);

  const profile = parseOr(
    characterProfileSchema,
    character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );

  const recent = await db()
    .select({ content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.ownerId, user.id),
        eq(characterChatMessages.characterId, id),
        eq(characterChatMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(SCENE_CHAT_CONTEXT);
  const recentChat = recent.map((r) => r.content).reverse();

  const jobId = await startJob({
    type: "scene_image",
    payload: { characterId: id },
    run: async () => ({
      imageId: await renderCharacterSceneImage({
        characterId: id,
        userId: user.id,
        name: character.name,
        profile,
        avatarImageId: character.avatarImageId,
        imageModel: body.value.model,
        recentChat,
      }),
    }),
  });
  return jsonOk({ jobId, characterId: id }, 202);
});
