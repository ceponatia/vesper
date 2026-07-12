import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveChatModelId } from "@/lib/narrative-models";
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
import { characterChats, characterChatMessages, db } from "@/server/db";
import { deleteChat, submitChatMessage } from "@/server/engine";
import { loadOwnedChat } from "../owned";
import { queueChatScene } from "./scene/queue";

type Params = { chatId: string };

/**
 * One conversation (docs/character-chat.md): GET reads the transcript; POST runs
 * one exchange through the engine pipeline (`submitChatMessage`) and streams the
 * reply as plain text (the reply persists server-side when the stream settles,
 * even after a client disconnect); PATCH renames / archives / restores; DELETE is
 * the one destructive verb (`deleteChat` — archive is the everyday action,
 * character-chat-standalone.spec.md §1.4).
 */

/** Cap on transcript rows returned (oldest-first after slice). */
const TRANSCRIPT_LIMIT = 500;

const sendBodySchema = z
  .object({
    /**
     * Exchange kind (character-chat-standalone.spec.md §4): a normal player turn,
     * the opening beat ("Prompt character"), a "go on" continue beat, "another take"
     * on the last reply, or an atomic "rerun" of a player line (data-loss-rerun fix).
     */
    kind: z.enum(["send", "open", "continue", "regenerate", "rerun"]).default("send"),
    content: z.string().trim().max(MESSAGE_CONTENT_MAX).optional(),
    /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
    model: z.string().trim().min(1).max(120).optional(),
    /** "Has something to say" opener cue (spec §8.4) — only read for kind "continue". */
    cue: z.string().trim().max(200).optional(),
    /** Reopen-opener initiative (chat-initiative.plan.md) — only read for kind "continue". */
    initiative: z.boolean().optional(),
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
  });

const patchBodySchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    archived: z.boolean().optional(),
  })
  .refine((b) => b.title !== undefined || b.archived !== undefined, { message: "nothing to update" });

/** GET /api/chats/:chatId — the transcript, oldest first. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  // Newest-first slice (so the cap keeps the most recent), reversed to display order.
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
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(TRANSCRIPT_LIMIT);

  return jsonOk({
    messages: rows.reverse(),
    chat: { id: owned.chat.id, title: owned.chat.title, archivedAt: owned.chat.archivedAt },
    character: {
      id: owned.character.id,
      name: owned.character.name,
      // The conversation page renders the portrait/scene panel and the narrator-model
      // menu from this envelope — one GET settles the whole screen.
      avatarImageId: owned.character.avatarImageId,
      chatModel: owned.character.chatModel,
    },
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

  const result = await submitChatMessage({
    chatId,
    memoryGroupId: owned.participant.memoryGroupId,
    character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    kind: body.value.kind,
    content: body.value.content,
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
    // "Auto at big moments" (slice 9): the engine signals, this route queues — a scene
    // render anchored to the exchange's reply, deduped against live renders.
    onBigMoment: ({ assistantMessageId }) => {
      void queueChatScene({ userId: user.id, chatId, character: owned.character, anchorMessageId: assistantMessageId });
    },
    // The reply sent a selfie (chat-selfies.plan.md): queue the subject's-own-camera
    // render anchored to it — same dedupe, always the identity-locked route.
    onSelfie: ({ assistantMessageId }) => {
      void queueChatScene({
        userId: user.id,
        chatId,
        character: owned.character,
        anchorMessageId: assistantMessageId,
        flavor: "selfie",
      });
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
