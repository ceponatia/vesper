import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  appendMilestones,
  characterProfileSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";
import { loadChatState, persistChatState, seedChatState } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * "Mark this moment" (character-chat-standalone.spec.md §7.2): pin a player-chosen
 * milestone on any message. The label defaults to a trimmed excerpt of the marked
 * line, so the milestone reads as the moment itself.
 */

const markBodySchema = z.object({
  messageId: z.string().trim().min(1),
  label: z.string().trim().max(120).optional(),
});

/** Milestone labels stay a glanceable line, not a transcript quote. */
const LABEL_EXCERPT_CHARS = 80;

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, markBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const [message] = await db()
    .select({ id: characterChatMessages.id, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, body.value.messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!message) return jsonError("not_found", "message not found", 404);

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, owned.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const state = (await loadChatState(chatId, owned.participant.characterId, sink)) ?? seedChatState(profile);
  const excerpt = message.content.trim().replace(/\s+/g, " ").slice(0, LABEL_EXCERPT_CHARS);
  const label = body.value.label?.trim() || excerpt || "A marked moment";
  const next = {
    ...state,
    milestones: appendMilestones(state.milestones, [
      { at: new Date().toISOString(), kind: "player_marked" as const, label, messageId: message.id },
    ]),
  };
  await persistChatState(chatId, owned.participant.characterId, next);
  return jsonOk({ milestones: next.milestones });
});
