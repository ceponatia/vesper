import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
  garmentOperationListSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import { isSimRoutedAuthority, readChatEngineAuthority, resolveSeededOutfit } from "@/server/engine";
import { editParticipantWardrobe } from "@/server/engine/chat-state/focused-edit";
import { participantWardrobeView } from "@/server/engine/chat-state/focused-read";
import { seedChatScenario, seedChatState } from "@/server/engine/chat-state/seed";
import { loadChatScenario, loadChatState } from "@/server/engine/chat-state/store";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../../owned";

type Params = { chatId: string; characterId: string };

const patchSchema = z.object({
  wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
  outfitPresetId: z.string().max(120).optional(),
  outfit: z.string().optional(),
  outfitExposed: z.boolean().optional(),
  garmentOperations: garmentOperationListSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one wardrobe field is required");

function targetMember(owned: OwnedChat, characterId: string) {
  return owned.roster.find((member) => member.characterId === characterId) ?? null;
}

function profileFor(member: NonNullable<ReturnType<typeof targetMember>>) {
  return parseOr(characterProfileSchema, member.character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
}

async function readView(
  chatId: string,
  owned: OwnedChat,
  ownerId: string,
  characterId: string,
  diagnostics = [] as { code: string; message: string }[],
) {
  const member = targetMember(owned, characterId);
  if (!member) return null;
  const profile = profileFor(member);
  const stored = await loadChatState(chatId, characterId);
  const state = await resolveSeededOutfit(stored ?? seedChatState(profile), ownerId, profile);
  const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile);
  return participantWardrobeView({ characterId, state, scenario, ownerId, profile, diagnostics });
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, _req, ctx) => {
    const { chatId, characterId } = await ctx.params;
    const view = await readView(chatId, owned, user.id, characterId);
    return view ? jsonOk(view) : jsonError("not_found", "that character is not in this conversation", 404);
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

    const current = await readView(chatId, owned, user.id, characterId);
    if (!current) return jsonError("not_found", "that character is not in this conversation", 404);
    const changed =
      (body.value.garmentOperations?.length ?? 0) > 0 ||
      (body.value.wornItemIds !== undefined && !sameStrings(body.value.wornItemIds, current.wornItemIds)) ||
      (body.value.outfitPresetId !== undefined && body.value.outfitPresetId !== current.outfitPresetId) ||
      (body.value.outfit !== undefined && body.value.outfit !== current.outfit) ||
      (body.value.outfitExposed !== undefined && body.value.outfitExposed !== current.outfitExposed);
    if (!changed) return jsonOk(current);

    if (
      characterId === owned.participant.characterId &&
      isSimRoutedAuthority(await readChatEngineAuthority(chatId))
    ) {
      return jsonError(
        "sim_wardrobe_managed_by_world",
        "this character's clothing is owned by the successor world's material state; change it through world actions rather than character-chat wardrobe controls",
        409,
      );
    }

    const sink = new DiagnosticCollector();
    const { state, scenario } = await editParticipantWardrobe({
      chatId,
      characterId,
      ownerId: user.id,
      profile: profileFor(member),
      patch: body.value,
      sink,
    });
    const diagnostics = sink.items
      .filter((item) => item.code.startsWith("garment_op."))
      .map((item) => ({ code: item.code, message: item.message }));
    return jsonOk(await participantWardrobeView({
      characterId,
      state,
      scenario,
      ownerId: user.id,
      profile: profileFor(member),
      diagnostics,
    }));
  },
);
