import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { errorText, jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChatMessages, characters, db } from "@/server/db";
import {
  buildCharacterChatSystemPrompt,
  CHARACTER_CHAT_HISTORY_TURNS,
  streamCharacterChat,
  type ChatTurn,
} from "@/server/engine";
import { log } from "@/server/log";

type Params = { id: string };

/**
 * The character-chat transcript API (docs/developer-notes/character-chat.plan.md):
 * a sessionless 1-on-1 chat with a library character, persisted to
 * `character_chat_messages`. GET reads the transcript, POST appends the user's
 * line and streams the character's reply (persisted server-side when it
 * settles), DELETE clears the conversation. No session, pipeline, or RAG.
 */

/** Cap on transcript rows returned to the editor (oldest-first after slice). */
const TRANSCRIPT_LIMIT = 500;

const sendBodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
  /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
  model: z.string().trim().min(1).max(120).optional(),
});

/** Resolve an owned character to the fields the chat needs, or null. */
async function loadOwnedCharacter(characterId: string, ownerId: string) {
  const [row] = await db()
    .select({ id: characters.id, name: characters.name, profile: characters.profile })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

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
 * POST /api/characters/:id/chat — append the user's message, then stream the
 * character's reply as a plain-text token stream. The assistant reply is
 * persisted when the stream settles, even if the client disconnects mid-stream
 * (the generator is drained server-side regardless — docs/resilience.md §5).
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, sendBodySchema);
  if (!body.ok) return body.response;

  const character = await loadOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);

  await db()
    .insert(characterChatMessages)
    .values({ ownerId: user.id, characterId: id, role: "user", content: body.value.content });

  // Load the recent window (newest-first slice, reversed to oldest-first); this
  // includes the line just inserted. streamCharacterChat re-windows defensively.
  const recent = await db()
    .select({ role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, user.id), eq(characterChatMessages.characterId, id)))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(CHARACTER_CHAT_HISTORY_TURNS * 2);
  const history: ChatTurn[] = recent.reverse();

  const profile = parseOr(
    characterProfileSchema,
    character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const system = buildCharacterChatSystemPrompt({ name: character.name, profile });
  const gen = streamCharacterChat({ system, history, name: character.name, model: body.value.model });

  return streamReply(gen, (full) =>
    db()
      .insert(characterChatMessages)
      .values({ ownerId: user.id, characterId: id, role: "assistant", content: full })
      .then(() => undefined),
  );
});

/** DELETE /api/characters/:id/chat — clear the conversation (rows only; images survive). */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await loadOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  await db()
    .delete(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, user.id), eq(characterChatMessages.characterId, id)));
  return jsonOk({ cleared: true });
});

/**
 * Wrap the reply generator in a plain-text streaming Response. Tokens are
 * enqueued as they arrive and accumulated; the full reply is persisted once the
 * stream finishes. A client disconnect flips `open` off but keeps draining so
 * the persisted reply is always whole (mirrors sse.streamTurnEvents).
 */
function streamReply(gen: AsyncGenerator<string>, persist: (full: string) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let full = "";
      try {
        for await (const delta of gen) {
          full += delta;
          if (!open) continue; // client gone: keep draining to capture the whole reply
          try {
            controller.enqueue(encoder.encode(delta));
          } catch {
            open = false; // consumer cancelled — writes are best-effort from here
          }
        }
      } catch (err) {
        log.warn("api.chat", "reply stream failed", { error: errorText(err) });
      }
      if (full.trim()) {
        try {
          await persist(full);
        } catch (err) {
          log.error("api.chat", "failed to persist assistant reply", { error: errorText(err) });
        }
      }
      if (open) {
        try {
          controller.close();
        } catch {
          // already closed by a consumer cancel — nothing to do
        }
      }
    },
    cancel() {
      // Client abort is a display problem only; start() drains the generator
      // and persists the assistant reply regardless.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
