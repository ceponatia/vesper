import type { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, DiagnosticCollector, emptyCharacterProfile, splitStateCues } from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { CHAT_RATE_LIMIT, errorText, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";
import { characterChatMessages, characterChatSummaries, db, images } from "@/server/db";
import {
  buildCharacterChatSystemPrompt,
  CHARACTER_CHAT_SUMMARIZE_AT,
  chatCueInviteLine,
  deleteChatMemory,
  deleteChatState,
  detectChatCue,
  driftChatState,
  enqueueChatSummary,
  finalizeChatState,
  loadChatState,
  loadChatSummary,
  loadVerbatimWindow,
  narrationShapeId,
  persistChatState,
  retrieveChatMemory,
  seedChatState,
  streamCharacterChat,
  tryKeyedLock,
} from "@/server/engine";
import { log } from "@/server/log";
import { resolvePlayerPersona } from "@/server/players";
import { loadOwnedCharacter } from "./owned";

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

/** A synthetic, non-persisted cue that gives the model a turn to respond to when the character opens the scene. */
const OPENING_CUE = "(Open the scene. Speak first, in character.)";

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
  if (!rateLimit(`chat:${user.id}`, CHAT_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many chat messages; try again in a minute", 429);
  }

  // One exchange in flight per chat (codebase-review A6) — the session lane's CAS +
  // per-session queue equivalent. Without it, two concurrent POSTs each load + drift
  // the same state row and the finalizers land last-write-wins (one exchange's
  // affinity/mood/clock silently discarded). Held until the stream settles
  // (streamReply's onSettled); a second submit mid-stream is a double-send → 409.
  let releaseChatLock!: () => void;
  const chatLockGate = new Promise<void>((resolve) => {
    releaseChatLock = resolve;
  });
  const chatLock = tryKeyedLock(`chat_exchange:${user.id}:${id}`, () => chatLockGate);
  if (chatLock === null) {
    return jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409);
  }
  void chatLock; // resolves via releaseChatLock; never rejects

  try {
    return await runExchange(body.value, character);
  } catch (err) {
    releaseChatLock();
    throw err;
  }

  async function runExchange(
    input: z.infer<typeof sendBodySchema>,
    character: NonNullable<Awaited<ReturnType<typeof loadOwnedCharacter>>>,
  ): Promise<Response> {
    const opening = input.open === true;

    // Normal turn: mint the user line's id up front so the assistant persist can be
    // guarded against it (persistAssistantReply): if a concurrent clear or
    // single-message delete removes this row mid-stream, the reply is dropped rather
    // than orphaned. The opening beat has no player line, so no guard row.
    const promptMessageId = newId();
    if (!opening) {
      await db()
        .insert(characterChatMessages)
        .values({ id: promptMessageId, ownerId: user.id, characterId: id, role: "user", content: input.content ?? "" });
    }

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
  // The user's default player character (player-character.plan.md), so the
  // character addresses someone by name instead of a faceless "the user".
  const player = await resolvePlayerPersona(user.id);

  // Light chat state (character-chat-state.spec.md §5): load (or lazily seed from
  // the authored defaults), then recompute drift — between-visit recovery toward
  // rested + this exchange's within-visit tick. Pure; persisted once at turn end.
  const now = new Date();
  const sink = new DiagnosticCollector();
  const storedState = await loadChatState(user.id, id, sink);
  const driftedState = driftChatState(storedState ?? seedChatState(profile), now, profile, { advance: true });

  // RAG long-term memory (character-chat-primary.spec.md §2): recall the chat's own facts +
  // episodes, keyed on last turn's memory queries + this input. A failed leg degrades to []
  // with a diagnostic (never a failed reply); an opening beat has no input yet but may still
  // recall via stored queries. Runs before prompt build so hits ride in as a recall block.
  const memory = await retrieveChatMemory({
    ownerId: user.id,
    characterId: id,
    queries: driftedState.memoryQueries,
    input: opening ? "" : (input.content ?? ""),
    sink,
  });

  const system = buildCharacterChatSystemPrompt({
    name: character.name,
    profile,
    priorSummary: summaryState?.summary,
    memory,
    player: { name: player.name, persona: player.persona },
    state: {
      meters: driftedState.meters,
      affinity: driftedState.affinity,
      conditions: driftedState.conditions,
      mindNote: driftedState.mindNote,
      premise: driftedState.premise,
      surfacedCues: driftedState.surfacedCues,
      outfit: driftedState.outfit,
      outfitExposed: driftedState.outfitExposed,
      activeSocialCards: driftedState.activeSocialCards,
      attributeOverlays: driftedState.attributeOverlays,
    },
    opening,
    narrationShape: narrationShapeId("chat"),
    // One-turn cue invitation (§7): an opening beat has no player input to read.
    cueInvite: opening ? undefined : chatCueInviteLine(detectChatCue(input.content ?? ""), character.name),
  });
  // The opening beat has no player turn — give the model a synthetic (non-persisted)
  // cue to respond to so it produces the character's first line.
  const modelHistory = opening ? [...history, { role: "user" as const, content: OPENING_CUE }] : history;
  const gen = streamCharacterChat({ system, history: modelHistory, name: character.name, model: input.model });

  if (opening) {
    // Opening beat: persist only the character's line (no guard row exists), then
    // fold drift into the state — no pulse, since there was no player act to react to.
    return streamReply(
      gen,
      async (full) => {
        await db()
          .insert(characterChatMessages)
          .values({ ownerId: user.id, characterId: id, role: "assistant", content: full });
        try {
          // The opening beat shows state to the narrator too — record the bands surfaced so the
          // first real turn doesn't re-announce them (character-chat-state-narration.spec.md §5).
          const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
          await persistChatState(user.id, id, { ...driftedState, surfacedCues, lastInteractionAt: now });
        } catch (err) {
          log.error("api.chat", "chat-state opening persist failed", { error: errorText(err) });
        }
      },
      releaseChatLock,
    );
  }

  // Finalizer (turn end): persist the reply, then run the reaction pulse + fold
  // drift into the persisted state. The reply has already flushed to the client,
  // so this is invisible to perceived latency; a pulse failure degrades to
  // drift-only state and never affects the saved reply.
  return streamReply(
    gen,
    async (full) => {
      await persistAssistantReply({ ownerId: user.id, characterId: id, promptMessageId, content: full });
      try {
        await finalizeChatState({
          ownerId: user.id,
          characterId: id,
          promptMessageId,
          profile,
          characterName: character.name,
          playerName: player.name,
          driftedState,
          now,
          exchange: { player: input.content ?? "", assistant: full },
          retrieved: memory,
          sink,
        });
      } catch (err) {
        log.error("api.chat", "chat-state finalize failed", { error: errorText(err) });
      }
      if (sink.items.length) log.info("api.chat", "chat-state diagnostics", { codes: sink.items.map((d) => d.code) });
    },
    releaseChatLock,
  );
  }
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
 * DELETE /api/characters/:id/chat — the single **Clear Chat** (character-chat-primary.spec.md
 * §4, D4): one action that wipes EVERYTHING for this conversation. It supersedes the old
 * three-scope reset (all/chat/state) — testing showed no value in clearing chat or state alone.
 * It deletes, in order:
 *
 * - the transcript (`character_chat_messages`) and the running summary
 *   (`character_chat_summaries` — its watermark + recap are this chat's short-term memory);
 * - the light-state row (`deleteChatState`);
 * - the RAG long-term memory — this chat's facts + episodes (`deleteChatMemory`, §2);
 * - the scene-image prompt text (kind="scene"): the assets survive, but their prompts embed
 *   recent chat lines, so a cleared conversation must not leave old context visible in the
 *   gallery enlarge view. Only the derived `prompt` is reset (column default "").
 *
 * State + memory then re-seed lazily from the authored defaults on the next exchange.
 */
export const DELETE = withUser<Params>(async (user, _req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  if (!(await loadOwnedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);

  // One transaction (codebase-review A9): a crash mid-clear must not leave a
  // half-cleared conversation (transcript gone, memory still recalling it).
  await db().transaction(async (tx) => {
    await tx
      .delete(characterChatMessages)
      .where(and(eq(characterChatMessages.ownerId, user.id), eq(characterChatMessages.characterId, id)));
    await tx
      .delete(characterChatSummaries)
      .where(and(eq(characterChatSummaries.ownerId, user.id), eq(characterChatSummaries.characterId, id)));
    await deleteChatState(user.id, id, tx);
    await deleteChatMemory(user.id, id, tx);
    await tx
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
  });

  return jsonOk({ cleared: true });
});

/**
 * Wrap the reply generator in a plain-text streaming Response. Tokens are
 * enqueued as they arrive and accumulated; the full reply is persisted once the
 * stream finishes. A client disconnect flips `open` off but keeps draining so
 * the persisted reply is always whole (mirrors sse.streamTurnEvents).
 * `onSettled` runs once everything (drain + persist) has finished, on every
 * path — including an empty reply, where `persist` is skipped — so it is safe
 * to release the per-chat exchange lock there.
 */
function streamReply(gen: AsyncGenerator<string>, persist: (full: string) => Promise<void>, onSettled?: () => void): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let full = "";
      try {
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
      } finally {
        onSettled?.();
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
