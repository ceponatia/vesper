import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  DiagnosticCollector,
  characterProfileSchema,
  emptyCharacterProfile,
  garmentActorForCharacter,
  garmentOperationListSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import {
  garmentReadoutsFor,
  isSimRoutedAuthority,
  loadChatScenario,
  loadChatState,
  readChatEngineAuthority,
  readSimChatOutfit,
  resolveChatWardrobe,
  resolveSeededOutfit,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { editChatParticipantWardrobe } from "@/server/engine/chat-state/focused-edit";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../../owned";

type Params = { chatId: string; characterId: string };

const patchSchema = z
  .object({
    wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
    outfitPresetId: z.string().max(120).optional(),
    outfit: z.string().optional(),
    outfitExposed: z.boolean().optional(),
    garmentOperations: garmentOperationListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one wardrobe field is required");

function targetMember(owned: OwnedChat, characterId: string) {
  return owned.roster.find((member) => member.characterId === characterId) ?? null;
}

async function project(args: {
  chatId: string;
  characterId: string;
  primaryCharacterId: string;
  ownerId: string;
  profile: ReturnType<typeof emptyCharacterProfile>;
  state?: Awaited<ReturnType<typeof loadChatState>>;
  diagnostics?: { code: string; message: string }[];
}) {
  const stored = args.state ?? (await loadChatState(args.chatId, args.characterId));
  const state = await resolveSeededOutfit(stored ?? seedChatState(args.profile), args.ownerId, args.profile);
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  const wardrobe = await resolveChatWardrobe(
    { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(args.characterId) },
    args.ownerId,
    args.profile,
  );
  const simOutfit =
    args.characterId === args.primaryCharacterId ? await readSimChatOutfit(args.chatId) : null;
  return {
    characterId: args.characterId,
    wornItemIds: state.wornItemIds,
    outfitPresetId: state.outfitPresetId,
    outfit: state.outfit,
    outfitExposed: state.outfitExposed,
    outfitLabel: simOutfit ?? wardrobe.garments,
    garments: garmentReadoutsFor(
      scenario.garments,
      garmentActorForCharacter(args.characterId),
      scenario.clockMinutes,
    ),
    garmentDiagnostics: args.diagnostics ?? [],
  };
}

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, _req, ctx) => {
    const { chatId, characterId } = await ctx.params;
    const member = targetMember(owned, characterId);
    if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
    const profile = parseOr(
      characterProfileSchema,
      member.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    return jsonOk(
      await project({
        chatId,
        characterId,
        primaryCharacterId: owned.participant.characterId,
        ownerId: user.id,
        profile,
      }),
    );
  },
);

export const PATCH = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, req: NextRequest, ctx) => {
    const { chatId, characterId } = await ctx.params;
    const member = targetMember(owned, characterId);
    if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;
    const body = await readBody(req, patchSchema);
    if (!body.ok) return body.response;

    if (
      characterId === owned.participant.characterId &&
      isSimRoutedAuthority(await readChatEngineAuthority(chatId))
    ) {
      return jsonError(
        "sim_wardrobe_managed_by_world",
        "this character's clothing is owned by the successor world's material state; change it through world actions",
        409,
      );
    }

    const profile = parseOr(
      characterProfileSchema,
      member.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const sink = new DiagnosticCollector();
    const result = await editChatParticipantWardrobe({
      chatId,
      characterId,
      ownerId: user.id,
      profile,
      patch: body.value,
      sink,
    });
    return jsonOk(
      await project({
        chatId,
        characterId,
        primaryCharacterId: owned.participant.characterId,
        ownerId: user.id,
        profile,
        state: result.state,
        diagnostics: sink.items
          .filter((diagnostic) => diagnostic.code.startsWith("garment_op."))
          .map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
      }),
    );
  },
);
