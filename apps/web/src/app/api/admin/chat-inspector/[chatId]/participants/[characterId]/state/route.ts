import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  CHAT_ARCHIVIST_MAX_OPEN_LOOPS,
  attributeValueSchema,
  characterProfileSchema,
  chatDrivesSchema,
  emptyCharacterProfile,
  traitValueSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { callbackHistorySchema, chatFeelingStateSchema, loadChatState, seedChatState, selfieHistorySchema } from "@/server/engine";
import { editChatParticipantInspectorState } from "@/server/engine/chat-state/focused-edit";
import { voiceExemplarsSchema } from "@/server/engine/chat-voice";
import { chatBusyResponse } from "@/app/api/chats/owned";
import { withSelfOwnedChat } from "../../../../owned";

type Params = { chatId: string; characterId: string };

const patchSchema = z
  .object({
    openLoops: z.array(z.string().trim().max(200)).max(CHAT_ARCHIVIST_MAX_OPEN_LOOPS).optional(),
    memoryQueries: z.array(z.string().trim().max(200)).max(6).optional(),
    surfacedCues: z.record(z.string(), z.string()).optional(),
    attributeOverlays: z.array(attributeValueSchema).optional(),
    traitOverlays: z.array(traitValueSchema).optional(),
    voiceExemplars: voiceExemplarsSchema.optional(),
    callbackHistory: callbackHistorySchema.optional(),
    feeling: chatFeelingStateSchema.optional(),
    selfieHistory: selfieHistorySchema.optional(),
    drives: chatDrivesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one inspector-state field is required");

function view(state: ReturnType<typeof seedChatState>) {
  return {
    openLoops: state.openLoops,
    memoryQueries: state.memoryQueries,
    surfacedCues: state.surfacedCues,
    attributeOverlays: state.attributeOverlays,
    traitOverlays: state.traitOverlays,
    voiceExemplars: state.voiceExemplars,
    callbackHistory: state.callbackHistory,
    feeling: state.feeling,
    selfieHistory: state.selfieHistory,
    drives: state.drives,
    lastPulseTrace: state.lastPulseTrace,
    lastMemoryTrace: state.lastMemoryTrace,
  };
}

function memberFor(owned: Parameters<Parameters<typeof withSelfOwnedChat<Params>>[0]>[1], characterId: string) {
  return owned.roster.find((member) => member.characterId === characterId) ?? null;
}

export const GET = withSelfOwnedChat<Params>(async (_user, owned, _req, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const member = memberFor(owned, characterId);
  if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
  const profile = parseOr(
    characterProfileSchema,
    member.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  return jsonOk(view((await loadChatState(chatId, characterId)) ?? seedChatState(profile)));
});

export const PATCH = withSelfOwnedChat<Params>(async (_user, owned, req: NextRequest, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const member = memberFor(owned, characterId);
  if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;
  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;
  const profile = parseOr(
    characterProfileSchema,
    member.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const state = await editChatParticipantInspectorState({ chatId, characterId, profile, patch: body.value });
  return jsonOk(view(state));
});
