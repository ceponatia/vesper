import type { NextRequest } from "next/server";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { chatActionIdSchema, chatReplyFailureSchema, characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { resolveChatModelId } from "@/lib/narrative-models";
import { parseOr } from "@/lib/parse";
import {
  CHAT_RATE_LIMIT,
  drainingStreamResponse,
  jsonError,
  jsonOk,
  MESSAGE_CONTENT_MAX,
  rateLimit,
  readBody,
  withUser,
} from "@/server/api";
import { characterChats, characterChatMessages, characterChatState, db } from "@/server/db";
import {
  deleteChat,
  readChatEngineAuthority,
  readSimChatOutfit,
  readSimChatPresence,
  resolveChatWardrobe,
  runShadowChatExchange,
  runSimChatExchange,
  submitChatMessage,
  tryKeyedLock,
} from "@/server/engine";
import { loadOwnedChat } from "../owned";
import { queueChatScene } from "./scene/queue";

type Params = { chatId: string };

/**
 * One conversation (docs/character-chat/pipeline.md): GET reads the transcript; POST runs
 * one exchange through the engine pipeline (`submitChatMessage`) and streams the
 * reply as plain text (the reply persists server-side when the stream settles,
 * even after a client disconnect); PATCH renames / archives / restores; DELETE is
 * the one destructive verb (`deleteChat` — archive is the everyday action,
 * character-chat-standalone.spec.md §1.4).
 */

/**
 * Transcript page size (ux-improvements.plan.md slice 2). The GET returns the
 * newest page by default; `?before=<messageId>` keysets older pages so a
 * long-running chat never loses its own beginning. Ordering is the composite
 * `(createdAt, id)` — a total order, so paging is stable even across same-ms
 * inserts.
 */
const CHAT_PAGE_SIZE = 100;

const sendBodySchema = z
  .object({
    /**
     * Exchange kind (character-chat-standalone.spec.md §4): a normal player turn,
     * the opening beat ("Prompt character"), a "go on" continue beat, a tapped
     * "action_beat" chip (chat-action-beats.plan.md), "another take" on the last
     * reply, or an atomic "rerun" of a player line (data-loss-rerun fix).
     */
    kind: z.enum(["send", "open", "continue", "action_beat", "regenerate", "rerun"]).default("send"),
    content: z.string().trim().max(MESSAGE_CONTENT_MAX).optional(),
    /**
     * Composer register (chat-supporting-cast.plan.md §Narrator input) — send only:
     * "narrator" marks the line as story narration authored by the player as
     * storyteller (supporting-cast dialogue, offscreen developments), never their
     * own POV. Persisted on the line's meta; the prompt suspends the perception
     * partition for it and the reaction pulse skips (no player act).
     */
    inputMode: z.enum(["player", "narrator"]).default("player"),
    /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
    model: z.string().trim().min(1).max(120).optional(),
    /** "Has something to say" opener cue (spec §8.4) — only read for kind "continue". */
    cue: z.string().trim().max(200).optional(),
    /** Reopen-opener initiative (chat-initiative.plan.md) — only read for kind "continue". */
    initiative: z.boolean().optional(),
    /** Tapped action-chip id (chat-action-beats.plan.md) — required for kind "action_beat". */
    action: chatActionIdSchema.optional(),
    /** Target user-message id — required for kind "rerun" (the line to re-send from). */
    messageId: z.string().trim().min(1).max(120).optional(),
    /**
     * Player-attached photo ids for a send (chat-image-input.plan.md) — uploaded
     * first via POST …/attachments; validated + claimed against this chat's ready
     * `chat_upload` rows in the pipeline (foreign/unknown ids are dropped).
     */
    attachmentIds: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
  })
  // A photo-only send is legitimate (chat-image-input.plan.md) — showing something
  // IS the message; text is required only when nothing is attached.
  .refine((b) => b.kind !== "send" || (b.content?.length ?? 0) >= 1 || (b.attachmentIds?.length ?? 0) >= 1, {
    message: "content or attachments are required for a send",
    path: ["content"],
  })
  .refine((b) => b.kind !== "rerun" || (b.messageId?.length ?? 0) >= 1, {
    message: "messageId is required for a rerun",
    path: ["messageId"],
  })
  .refine((b) => b.kind !== "action_beat" || b.action !== undefined, {
    message: "action is required for an action beat",
    path: ["action"],
  });

const patchBodySchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    archived: z.boolean().optional(),
    /**
     * "Has something to say" seen-cursor (§8.4 v2): true stamps milestones_seen_at
     * = now. Sent once per conversation OPEN (mount) — deliberately not folded into
     * the transcript GET, which refetches after every exchange and would mark each
     * milestone seen the instant it lands.
     */
    seen: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.archived !== undefined || b.seen !== undefined, {
    message: "nothing to update",
  });

/**
 * GET /api/chats/:chatId — the newest transcript page, oldest first, plus
 * `hasMore`/`nextBefore` for the "Load earlier" affordance
 * (docs/streaming-api.md §Pagination).
 */
export const GET = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  // Keyset cursor: the id of the oldest already-loaded message; pages are the
  // rows strictly before it in (createdAt, id) order.
  const beforeId = req.nextUrl.searchParams.get("before");
  let beforeFilter: SQL | undefined;
  if (beforeId !== null) {
    const [cursor] = await db()
      .select({ id: characterChatMessages.id, createdAt: characterChatMessages.createdAt })
      .from(characterChatMessages)
      .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.id, beforeId)));
    if (!cursor) return jsonError("invalid_query", "before must be a message id in this chat", 400);
    beforeFilter = or(
      lt(characterChatMessages.createdAt, cursor.createdAt),
      and(eq(characterChatMessages.createdAt, cursor.createdAt), lt(characterChatMessages.id, cursor.id)),
    );
  }

  // Newest-first slice (so the cap keeps the page nearest the cursor), reversed
  // to display order. One extra row probes hasMore without a count query.
  const rows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      takes: characterChatMessages.takes,
      meta: characterChatMessages.meta,
      createdAt: characterChatMessages.createdAt,
    })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), beforeFilter))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(CHAT_PAGE_SIZE + 1);

  const hasMore = rows.length > CHAT_PAGE_SIZE;
  const page = rows.slice(0, CHAT_PAGE_SIZE);

  // Roster presence + current outfit (multi-character-chat.plan.md; outfit chip —
  // ux-improvements slice 3): one read over the chat's state rows; a member with
  // no row yet is simply present (the seed default) in whatever they wear.
  const stateRows = await db()
    .select({
      characterId: characterChatState.characterId,
      presence: characterChatState.presence,
      wornItemIds: characterChatState.wornItemIds,
      outfit: characterChatState.outfit,
      outfitExposed: characterChatState.outfitExposed,
    })
    .from(characterChatState)
    .where(eq(characterChatState.chatId, chatId));
  const stateBy = new Map(stateRows.map((r) => [r.characterId, r]));
  // The roster outfit line renders the RESOLVED garments (chat-wardrobe-parity): worn item
  // ids → the rendered phrase via the shared seam, else the free-text overlay. One resolve
  // per member (≤4), on the once-per-open envelope.
  const outfitLabels = new Map<string, string>(
    await Promise.all(
      owned.roster.map(async (m): Promise<[string, string]> => {
        const row = stateBy.get(m.characterId);
        if (!row) return [m.characterId, ""];
        const profile = parseOr(characterProfileSchema, m.character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
        const wardrobe = await resolveChatWardrobe(
          { wornItemIds: Array.isArray(row.wornItemIds) ? (row.wornItemIds as string[]) : [], outfit: row.outfit, outfitExposed: row.outfitExposed },
          owned.chat.ownerId,
          profile,
        );
        return [m.characterId, wardrobe.garments];
      }),
    ),
  );

  return jsonOk({
    messages: page.reverse(),
    hasMore,
    // The cursor for the NEXT older page: the oldest message returned here.
    nextBefore: hasMore ? (page[0]?.id ?? null) : null,
    chat: {
      id: owned.chat.id,
      title: owned.chat.title,
      archivedAt: owned.chat.archivedAt,
      // Why the last exchange produced no reply (null when it replied) — the client's
      // post-exchange refetch turns this into the cause-specific failure popup.
      lastReplyFailure: parseOr(
        chatReplyFailureSchema.nullable(),
        owned.chat.lastReplyFailure ?? null,
        null,
        undefined,
        "character_chats.last_reply_failure",
      ),
    },
    character: {
      id: owned.character.id,
      name: owned.character.name,
      // The conversation page renders the portrait/scene panel and the narrator-model
      // menu from this envelope — one GET settles the whole screen.
      avatarImageId: owned.character.avatarImageId,
      chatModel: owned.character.chatModel,
    },
    // The full roster, sort-ordered (first = primary) — the roster panel's data.
    // R5 slices 3+5: for a sim-routed chat the PRIMARY's presence and outfit
    // are the mirror world's truth (loci + worn items), never legacy state.
    roster: await (async () => {
      const [simPresence, simOutfit] = await Promise.all([readSimChatPresence(chatId), readSimChatOutfit(chatId)]);
      return owned.roster.map((m) => ({
        characterId: m.characterId,
        name: m.character.name,
        avatarImageId: m.character.avatarImageId,
        sort: m.sort,
        presence:
          simPresence !== null && m.sort === 0
            ? simPresence.present
              ? ("present" as const)
              : ("away" as const)
            : (stateBy.get(m.characterId)?.presence ?? "present"),
        outfit:
          simOutfit !== null && m.sort === 0 ? simOutfit : (outfitLabels.get(m.characterId) ?? ""),
      }));
    })(),
  });
});

/** POST /api/chats/:chatId — submit one exchange and stream the reply as plain text. */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, sendBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
  if (!rateLimit(`chat:${user.id}`, CHAT_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many chat messages; try again in a minute", 429);
  }

  // R3 admission wiring (engine.rollout.plan.md): a sim-routed chat's PLAIN
  // send becomes a successor turn — the one place the lanes fork, decided by
  // the chat's authority flag and nothing else. The reply comes back in the
  // same plain-text shape the client already streams, and the post-exchange
  // transcript refetch shows both persisted lines. Every other kind (open /
  // continue / action_beat / regenerate / rerun), attachments, and action
  // chips stay legacy: a successor retake is a branch fork, never an
  // in-place rerender (recorded boundary — rides R5).
  const plainSend =
    body.value.kind === "send" &&
    (body.value.content ?? "").trim().length > 0 &&
    (body.value.attachmentIds === undefined || body.value.attachmentIds.length === 0) &&
    body.value.action === undefined;
  const simAuthority = plainSend ? await readChatEngineAuthority(chatId) : null;
  const simRouted =
    simAuthority !== null &&
    simAuthority.authority !== "legacy_chat" &&
    simAuthority.authority !== "successor_shadow" &&
    simAuthority.simBranchId !== null &&
    simAuthority.simPlayerActorId !== null &&
    simAuthority.simPrimaryActorId !== null;
  if (simRouted) {
    let releaseSimLock!: () => void;
    const simLockGate = new Promise<void>((resolve) => {
      releaseSimLock = resolve;
    });
    // The same per-chat exchange lock the legacy pipeline takes — one reply
    // in flight per conversation regardless of lane.
    const simLock = tryKeyedLock(`chat_exchange:${chatId}`, () => simLockGate);
    if (simLock === null) {
      return jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409);
    }
    // Stream shape matters more than content here: the successor turn takes
    // 30-60s of model time with nothing to say, and fly-proxy cuts a response
    // that has sent zero bytes for ~60s (the "reply only appears on refresh"
    // symptom — it had persisted server-side). First byte goes out
    // immediately and an invisible zero-width-space heartbeat every 8s keeps
    // the pipe warm; the prose lands as one chunk; a failure records the
    // ordinary lastReplyFailure so the client's existing popup explains it.
    const encoder = new TextEncoder();
    const message = (body.value.content ?? "").trim();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("\u200B"));
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode("\u200B"));
          } catch {
            clearInterval(heartbeat);
          }
        }, 8_000);
        void (async () => {
          try {
            const sim = await runSimChatExchange({
              chatId,
              userId: user.id,
              speakerCharacterId: owned.character.id,
              speakerName: owned.character.name,
              message,
            });
            if (sim.ok) {
              controller.enqueue(encoder.encode(sim.prose));
            } else {
              await db()
                .update(characterChats)
                .set({
                  lastReplyFailure: {
                    code: "unknown",
                    detail: `successor turn: ${sim.message}`,
                    model: "",
                    at: new Date().toISOString(),
                  },
                })
                .where(eq(characterChats.id, chatId));
            }
          } catch (err) {
            await db()
              .update(characterChats)
              .set({
                lastReplyFailure: {
                  code: "unknown",
                  detail: `successor turn crashed: ${err instanceof Error ? err.message : String(err)}`,
                  model: "",
                  at: new Date().toISOString(),
                },
              })
              .where(eq(characterChats.id, chatId))
              .catch(() => undefined);
          } finally {
            clearInterval(heartbeat);
            releaseSimLock();
            try {
              controller.close();
            } catch {
              // already closed by a client disconnect
            }
          }
        })();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  const result = await submitChatMessage({
    chatId,
    memoryGroupId: owned.participant.memoryGroupId,
    character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    // The full roster (multi-character-chat.plan.md): length 1 keeps the 1-on-1
    // path byte-identical; more flips the pipeline to the ensemble frame.
    roster: owned.roster.map((m) => ({
      characterId: m.characterId,
      memoryGroupId: m.memoryGroupId,
      name: m.character.name,
      profile: m.character.profile,
    })),
    kind: body.value.kind,
    content: body.value.content,
    inputMode: body.value.inputMode,
    // The rerun target (kind "rerun"): the player line to re-send from. The pipeline
    // snips only its successors and reuses the line itself — nothing is deleted here.
    targetMessageId: body.value.messageId,
    // Player-attached photos (chat-image-input.plan.md) — send only.
    attachmentIds: body.value.attachmentIds,
    // A headless POST without a model must agree with the UI (spec §9): default to
    // the character's own narrator pick, not MODEL_DEFAULTS.narrative.
    model: body.value.model ?? resolveChatModelId(owned.character.chatModel),
    cue: body.value.cue,
    initiative: body.value.initiative,
    // Tapped action chip (chat-action-beats.plan.md) — the engine builds its
    // register-aware cue and applies the paired deterministic effect pre-narration.
    action: body.value.action,
    // "Auto at big moments" (slice 9): the engine signals, this route queues — a scene
    // render anchored to the exchange's reply, deduped against live renders.
    onBigMoment: ({ assistantMessageId }) => {
      void queueChatScene({ userId: user.id, chatId, character: owned.character, anchorMessageId: assistantMessageId });
    },
    // The reply sent a selfie (chat-selfies.plan.md): queue the subject's-own-camera
    // render anchored to it — same dedupe, always the identity-locked route. The
    // engine names the SENDER (followups ruling 12): in a group the addressed
    // member sends it, so the render uses their identity, not always the primary's.
    onSelfie: ({ assistantMessageId, characterId: senderId }) => {
      const sender = owned.roster.find((m) => m.characterId === senderId)?.character ?? owned.character;
      void queueChatScene({
        userId: user.id,
        chatId,
        character: sender,
        anchorMessageId: assistantMessageId,
        flavor: "selfie",
      });
    },
    // R4 shadow (engine.rollout.plan.md): after a plain send settles on a
    // `successor_shadow` chat, the comparison leg runs detached — the runner
    // re-reads authority and no-ops for every other lane, so this stays one
    // cheap read per settled exchange.
    onSettled: ({ assistantMessageId, content }) => {
      if (body.value.kind !== "send" || content.length === 0) return;
      void runShadowChatExchange({ chatId, userId: user.id, assistantMessageId, content });
    },
  });
  if (!result.ok) return jsonError(result.code, result.message, result.code === "chat_busy" ? 409 : 400);

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

/** PATCH /api/chats/:chatId — rename, archive, or restore. */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  await db()
    .update(characterChats)
    .set({
      ...(body.value.title !== undefined ? { title: body.value.title } : {}),
      ...(body.value.archived !== undefined ? { archivedAt: body.value.archived ? new Date() : null } : {}),
      ...(body.value.seen ? { milestonesSeenAt: new Date() } : {}),
    })
    .where(eq(characterChats.id, chatId));
  return jsonOk({ id: chatId });
});

/** DELETE /api/chats/:chatId — hard delete (see engine `deleteChat`). */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  await deleteChat({ id: owned.chat.id, ownerId: owned.chat.ownerId });
  return jsonOk({ deleted: true });
});
