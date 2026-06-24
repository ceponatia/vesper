import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  characterProfileSchema,
  chatActionIdSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  DiagnosticCollector,
  emptyCharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  applyChatAction,
  chatStateSnapshot,
  driftChatState,
  editChatState,
  loadChatState,
  persistChatState,
  seedChatState,
} from "@/server/engine";
import { loadOwnedCharacter } from "../owned";

type Params = { id: string };

/**
 * The character-chat light-state API (character-chat-state.spec.md §5 + slice 4), a
 * sibling of the plain-text reply stream so state never inlines into prose:
 *
 * - **GET** → the strip / premise-bar / state-tools snapshot, with the same
 *   drift-on-read the prompt build applies. No row ⇒ a rested seed from the
 *   authored defaults (today's behavior made visible).
 * - **PATCH** → an author edit (premise **Save** + the state-tools modal): upsert
 *   the provided fields (seeding the rest if absent), so the player can set the
 *   scene before the first message or tune disposition for testing.
 * - **POST `{ action }`** → a one-click test-bed action chip (offer a drink →
 *   intoxication↑, etc.), applied deterministically server-side.
 */

const editBodySchema = z.object({
  premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).optional(),
  affinity: z.number().int().min(-100).max(100).optional(),
  mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
  meters: z.record(z.string(), z.number()).optional(),
  conditions: z.array(activeConditionSchema).optional(),
});

const actionBodySchema = z.object({ action: chatActionIdSchema });

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const character = await loadOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const stored = await loadChatState(user.id, id, sink);
  const state = stored ? driftChatState(stored, new Date(), profile, { advance: false }) : seedChatState(profile);
  return jsonOk(chatStateSnapshot(state));
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const character = await loadOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);

  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const state = await editChatState({ ownerId: user.id, characterId: id, profile, patch: body.value });
  return jsonOk(chatStateSnapshot(state));
});

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const character = await loadOwnedCharacter(id, user.id);
  if (!character) return jsonError("not_found", "character not found", 404);

  const body = await readBody(req, actionBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const stored = await loadChatState(user.id, id, sink);
  // Apply the chip to the current (recovered) state, then persist.
  const current = stored ? driftChatState(stored, new Date(), profile, { advance: false }) : seedChatState(profile);
  const next = applyChatAction(current, body.value.action);
  await persistChatState(user.id, id, next);
  return jsonOk(chatStateSnapshot(next));
});
