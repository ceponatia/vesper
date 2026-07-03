import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  chatSkipAmountSchema,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { applyTimeSkip, chatStateSnapshot, loadChatState, persistChatState, seedChatState } from "@/server/engine";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Player time skip (character-chat-standalone.spec.md §8.1, D3/D8/D14): the ONE
 * between-scene time mechanism. Flavor-only v1 — the in-game clock advances (letting
 * running timed conditions expire through the existing clock-keyed filter), the
 * one-shot skip note is stamped for the next exchange, and the skip records itself
 * into the scaffolding ring. **Meters do not change.** A chat with no state row yet
 * degrades to seed + skip (spec §11) — never a failed action.
 */

const skipBodySchema = z.object({ amount: chatSkipAmountSchema });

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, skipBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) {
    return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
  }

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, owned.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const stored = await loadChatState(chatId, owned.participant.characterId, sink);
  const next = applyTimeSkip(stored ?? seedChatState(profile), body.value.amount, new Date());
  await persistChatState(chatId, owned.participant.characterId, next);
  return jsonOk(
    chatStateSnapshot(next, {
      dominance: effectiveTraitValue(profile.traits, "social.dominance"),
      intimateContext: true,
    }),
  );
});
