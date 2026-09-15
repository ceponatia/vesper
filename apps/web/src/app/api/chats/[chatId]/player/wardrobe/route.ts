import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  DiagnosticCollector,
  GARMENT_PLAYER_ACTOR,
  characterProfileSchema,
  emptyCharacterProfile,
  garmentOperationListSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonOk, readBody, withOwnedChat } from "@/server/api";
import { garmentReadoutsFor, loadChatScenario, seedChatScenario } from "@/server/engine";
import { editChatPlayerWardrobe } from "@/server/engine/chat-state/focused-edit";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../owned";

type Params = { chatId: string };

const patchSchema = z
  .object({
    wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
    outfitPresetId: z.string().max(120).optional(),
    overlay: z.string().optional(),
    garmentOperations: garmentOperationListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one player wardrobe field is required");

function view(scenario: Exclude<Awaited<ReturnType<typeof loadChatScenario>>, null>, diagnostics: { code: string; message: string }[] = []) {
  return {
    wornItemIds: scenario.playerState.wornItemIds,
    seeded: scenario.playerState.seeded,
    outfitPresetId: scenario.playerState.outfitPresetId,
    overlay: scenario.playerState.overlay,
    garments: garmentReadoutsFor(scenario.garments, GARMENT_PLAYER_ACTOR, scenario.clockMinutes),
    garmentDiagnostics: diagnostics,
  };
}

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
    return jsonOk(view(scenario));
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
    const sink = new DiagnosticCollector();
    const scenario = await editChatPlayerWardrobe({
      chatId,
      ownerId: user.id,
      profile,
      patch: body.value,
      sink,
    });
    return jsonOk(
      view(
        scenario,
        sink.items
          .filter((diagnostic) => diagnostic.code.startsWith("garment_op."))
          .map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
      ),
    );
  },
);
