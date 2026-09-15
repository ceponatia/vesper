import type { NextRequest } from "next/server";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import { editChatPlayerState, loadChatScenario, seedChatScenario } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

const patchSchema = z.object({ personaId: z.string() }).strict();

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const profile = parseOr(
      characterProfileSchema,
      owned.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile);
    return jsonOk({ personaId: scenario.playerState.personaId });
  },
);

export const PATCH = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;
    const body = await readBody(req, patchSchema);
    if (!body.ok) return body.response;

    const profile = parseOr(
      characterProfileSchema,
      owned.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const scenario = await editChatPlayerState({
      chatId,
      ownerId: user.id,
      profile,
      personaId: body.value.personaId,
    });
    if (!scenario) return jsonError("not_found", "persona not found", 404);
    return jsonOk({ personaId: scenario.playerState.personaId });
  },
);
