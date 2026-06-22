import type { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { errorText, jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChatMessages, characterChatSummaries, characters, db, images } from "@/server/db";
import {
  buildCharacterChatSystemPrompt,
  CHARACTER_CHAT_SUMMARIZE_AT,
  enqueueChatSummary,
  loadChatSummary,
  loadVerbatimWindow,
  streamCharacterChat,
} from "@/server/engine";
import { log } from "@/server/log";

type Params = { id: string };

/**
 * The character-chat transcript API (docs/developer-notes/character-chat.plan.md):
 * a sessionless 1-on-1 chat with a library character, persisted to
 * `character_chat_messages`. GET reads the transcript, POST appends the user's
 * line and streams the character's reply (persisted server-side when it settles,
 * but only if its prompting line still exists — a clear mid-stream can't be
 * resurrected), DELETE clears the conversation and scrubs chat context out of the
 * surviving scene images. No session, pipeline, or RAG.
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

  // Mint the user line's id up front so the assistant persist can be guarded
  // against it (persistAssistantReply): if a concurrent clear or single-message
  // delete removes this row mid-stream, the reply is dropped rather than orphaned.
  const promptMessageId = newId();
  await db()
    .insert(characterChatMessages)
    .values({ id: promptMessageId, ownerId: user.id, characterId: id, role: "user", content: body.value.content });

  // The running summary covers everything up to its watermark; the verbatim
  // window is every message after it (includes the line just inserted). No
  // summary row ⇒ the old last-40 behavior, unchanged
  // (docs/developer-notes/character-chat-summary.plan.md).
  const summaryState = await loadChatSummary(user.id, id);
  const history = await loadVerbatimWindow(user.id, id, summaryState?.watermark ?? null);

  // The verbatim tail has grown to the fold trigger → fold the oldest exchanges
  // into the running summary. Fire-and-forget: a detached job that runs
  // concurrently with this reply and never adds latency to it.
  if (history.length >= CHARACTER_CHAT_SUMMARIZE_AT * 2) {
    void enqueueChatSummary({ ownerId: user.id, characterId: id });
  }

  const profile = parseOr(
    characterProfileSchema,
    character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const system = buildCharacterChatSystemPrompt({
    name: character.name,
    profile,
    priorSummary: summaryState?.summary,
  });
  const gen = streamCharacterChat({ system, history, name: character.name, model: body.value.model });

  return streamReply(gen, (full) =>
    persistAssistantReply({ ownerId: user.id, characterId: id, promptMessageId, content: full }),
  );
});

/**
 * Persist the assistant reply, but only if the user line that prompted it still
 * exists — an atomic `INSERT … SELECT … WHERE EXISTS`. The reply is written when
 * the stream settles (even after a client disconnect, docs/resilience.md §5), so
 * a clear (`DELETE /chat`) or a single-message delete that lands while the stream
 * is still draining would otherwise leave an orphan row in a "cleared"
 * conversation. Keying the guard on the prompting row makes the write no-op in
 * that race. `id` is JS-generated (cuid2 `$defaultFn`, no DB default), so it must
 * be supplied explicitly in the raw insert; `created_at` defaults in the DB.
 *
 * Exported as a test seam: a real mid-stream clear isn't deterministically
 * reproducible through the streaming Response, so the guard is covered directly.
 */
export async function persistAssistantReply(args: {
  ownerId: string;
  characterId: string;
  promptMessageId: string;
  content: string;
}): Promise<void> {
  await db().execute(sql`
    insert into ${characterChatMessages} (id, owner_id, character_id, role, content)
    select ${newId()}, ${args.ownerId}, ${args.characterId}, 'assistant', ${args.content}
    where exists (
      select 1 from ${characterChatMessages} where id = ${args.promptMessageId}
    )
  `);
}

/**
 * DELETE /api/characters/:id/chat — clear the conversation. The running summary
 * row is deleted too (the watermark + recap are this conversation's memory; a
 * cleared chat must not keep a hidden recap — correctness + privacy). The scene
 * images (kind="scene") survive, but their prompts embed recent chat lines
 * (renderCharacterSceneImage → recentNarration), so we reset the prompt text:
 * a cleared conversation must not leave old chat context visible (the gallery
 * enlarge view shows `prompt`), which would be both confusing and a privacy
 * residue. The asset stays; only its derived prompt is blanked (column default "").
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await loadOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  await db()
    .delete(characterChatMessages)
    .where(and(eq(characterChatMessages.ownerId, user.id), eq(characterChatMessages.characterId, id)));
  await db()
    .delete(characterChatSummaries)
    .where(and(eq(characterChatSummaries.ownerId, user.id), eq(characterChatSummaries.characterId, id)));
  await db()
    .update(images)
    .set({ prompt: "" })
    .where(
      and(
        eq(images.ownerId, user.id),
        eq(images.kind, "scene"),
        eq(images.entityKind, "character"),
        eq(images.entityId, id),
      ),
    );
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
