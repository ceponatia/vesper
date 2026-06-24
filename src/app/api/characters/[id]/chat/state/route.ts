import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  CHAT_PREMISE_MAX_CHARS,
  DiagnosticCollector,
  emptyCharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  chatStateSnapshot,
  driftChatState,
  loadChatState,
  seedChatState,
  setChatPremise,
} from "@/server/engine";
import { loadOwnedCharacter } from "../owned";

type Params = { id: string };

/**
 * The character-chat light-state API (character-chat-state.spec.md §5), a sibling
 * of the plain-text reply stream so state never inlines into prose:
 *
 * - **GET** → the strip / premise-bar / state-tools snapshot, with the same
 *   drift-on-read the prompt build applies (so the UI shows current values after a
 *   gap even before the next send). No row ⇒ a rested seed from the authored
 *   defaults (today's behavior made visible).
 * - **PATCH `{ premise }`** → the premise **Save** action: upsert the row (seeding
 *   the rest if absent) so the player can set the scene before the first message.
 */

const premiseBodySchema = z.object({
  premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS),
});

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

  const body = await readBody(req, premiseBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  await setChatPremise({ ownerId: user.id, characterId: id, premise: body.value.premise, profile });

  const stored = await loadChatState(user.id, id, sink);
  const state = stored ? driftChatState(stored, new Date(), profile, { advance: false }) : seedChatState(profile, body.value.premise);
  return jsonOk(chatStateSnapshot(state));
});
