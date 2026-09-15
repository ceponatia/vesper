import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
  garmentOperationListSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonOk, readBody, withOwnedChat } from "@/server/api";
import { resolveChatPersona } from "@/server/players";
import {
  editPlayerWardrobe,
  loadChatScenario,
  playerWardrobeView,
  seedChatScenario,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../owned";

type Params = { chatId: string };

const patchSchema = z.object({
  wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
  outfitPresetId: z.string().max(120).optional(),
  overlay: z.string().optional(),
  garmentOperations: garmentOperationListSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one player-wardrobe field is required");

function primaryProfile(owned: OwnedChat) {
  return parseOr(
    characterProfileSchema,
    owned.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
}

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(primaryProfile(owned));
    const persona = await resolveChatPersona({ ownerId: user.id, chatId });
    return jsonOk(await playerWardrobeView({ scenario, ownerId: user.id, persona }));
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
    const persona = await resolveChatPersona({ ownerId: user.id, chatId });
    const sink = new DiagnosticCollector();
    const scenario = await editPlayerWardrobe({
      chatId,
      ownerId: user.id,
      profile: primaryProfile(owned),
      persona: persona.profile,
      patch: body.value,
      sink,
    });
    const diagnostics = sink.items
      .filter((item) => item.code.startsWith("garment_op."))
      .map((item) => ({ code: item.code, message: item.message }));
    return jsonOk(await playerWardrobeView({ scenario, ownerId: user.id, persona, diagnostics }));
  },
);
