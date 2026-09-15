import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import { db, personas } from "@/server/db";
import { editPlayerPersona, loadChatScenario, seedChatScenario } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

const patchSchema = z.object({ personaId: z.string() });

function primaryProfile(owned: OwnedChat) {
  return parseOr(
    characterProfileSchema,
    owned.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
}

async function ownsPersona(ownerId: string, personaId: string): Promise<boolean> {
  if (!personaId.trim()) return true;
  const [row] = await db()
    .select({ id: personas.id })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)))
    .limit(1);
  return Boolean(row);
}

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(primaryProfile(owned));
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
    if (!(await ownsPersona(user.id, body.value.personaId))) {
      return jsonError("not_found", "persona not found", 404);
    }
    const scenario = await editPlayerPersona({
      chatId,
      profile: primaryProfile(owned),
      personaId: body.value.personaId,
    });
    return jsonOk({ personaId: scenario.playerState.personaId });
  },
);
