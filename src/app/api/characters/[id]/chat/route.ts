import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CHAT_RATE_LIMIT, drainingStreamResponse, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";
import { clearCharacterChat, submitChatMessage } from "@/server/engine";
import { loadOwnedCharacter } from "./owned";

type Params = { id: string };

/**
 * The character-chat transcript API (docs/character-chat.md): a sessionless 1-on-1
 * chat with a library character. GET reads the transcript; POST runs one exchange
 * through the engine pipeline (`submitChatMessage` — state drift, RAG recall, prompt
 * build, streamed reply, post-turn fan-out) and streams the reply as plain text (the
 * reply persists server-side when the stream settles, even after a client
 * disconnect); DELETE is the single Clear Chat (`clearCharacterChat`).
 */

/** Cap on transcript rows returned to the editor (oldest-first after slice). */
const TRANSCRIPT_LIMIT = 500;

const sendBodySchema = z
  .object({
    content: z.string().trim().max(4000).optional(),
    /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
    model: z.string().trim().min(1).max(120).optional(),
    /**
     * Opening beat (character-chat-state.spec.md slice 4 "Prompt Character"): no
     * player line — the character opens the scene from the premise + seeded warmth.
     */
    open: z.boolean().optional(),
  })
  .refine((b) => b.open === true || (b.content?.length ?? 0) >= 1, {
    message: "content is required unless open is true",
    path: ["content"],
  });

/** GET /api/characters/:id/chat — the full transcript, oldest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await loadOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

  // Newest-first slice (so the cap keeps the most recent), reversed to display order.
  const rows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      createdAt: characterChatMessages.createdAt,
    })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, user.id), eq(characterChatMessages.characterId, id)))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(TRANSCRIPT_LIMIT);

  return jsonOk({ messages: rows.reverse() });
});

/**
 * POST /api/characters/:id/chat — submit one exchange and stream the character's
 * reply as a plain-text token stream. All orchestration lives in the engine's
 * `submitChatMessage`; the shared draining Response keeps consuming the stream
 * after a client disconnect so the persisted reply is always whole.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, sendBodySchema);
  if (!body.ok) return body.response;

  const character = await loadOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);
  if (!rateLimit(`chat:${user.id}`, CHAT_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many chat messages; try again in a minute", 429);
  }

  const result = await submitChatMessage({
    ownerId: user.id,
    character: { id, name: character.name, profile: character.profile },
    content: body.value.content,
    model: body.value.model,
    open: body.value.open,
  });
  if (!result.ok) return jsonError(result.code, result.message, 409);

  return drainingStreamResponse({
    gen: result.stream,
    encode: (delta) => delta,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

/** DELETE /api/characters/:id/chat — the single Clear Chat (see `clearCharacterChat`). */
export const DELETE = withUser<Params>(async (user, _req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  if (!(await loadOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  await clearCharacterChat(user.id, id);
  return jsonOk({ cleared: true });
});
