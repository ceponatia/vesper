import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  attributeValueSchema,
  characterProfileSchema,
  chatDrivesSchema,
  emptyCharacterProfile,
  traitValueSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { chatBusyResponse } from "@/app/api/chats/owned";
import { withSelfOwnedChat } from "@/app/api/admin/chat-inspector/owned";
import { callbackHistorySchema } from "@/server/engine/chat-callback";
import { chatFeelingStateSchema } from "@/server/engine/chat-feeling";
import { selfieHistorySchema } from "@/server/engine/chat-selfie";
import { voiceExemplarsSchema } from "@/server/engine/chat-voice";
import { editInspectorState } from "@/server/engine/chat-state/focused-edit";
import { inspectorStateView } from "@/server/engine/chat-state/focused-read";
import { seedChatState } from "@/server/engine/chat-state/seed";
import { loadChatState } from "@/server/engine/chat-state/store";

type Params = { chatId: string; characterId: string };

const patchSchema = z.object({
  openLoops: z.array(z.string().trim().max(200)).max(6).optional(),
  memoryQueries: z.array(z.string().trim().max(200)).max(6).optional(),
  surfacedCues: z.record(z.string(), z.string()).optional(),
  attributeOverlays: z.array(attributeValueSchema).optional(),
  traitOverlays: z.array(traitValueSchema).optional(),
  voiceExemplars: voiceExemplarsSchema.optional(),
  callbackHistory: callbackHistorySchema.optional(),
  feeling: chatFeelingStateSchema.optional(),
  selfieHistory: selfieHistorySchema.optional(),
  drives: chatDrivesSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one inspector field is required");

export const GET = withSelfOwnedChat<Params>(async (_user, owned, _req, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const member = owned.roster.find((candidate) => candidate.characterId === characterId);
  if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
  const profile = parseOr(
    characterProfileSchema,
    member.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const state = (await loadChatState(chatId, characterId)) ?? seedChatState(profile);
  return jsonOk(inspectorStateView(state));
});

export const PATCH = withSelfOwnedChat<Params>(async (_user, owned, req: NextRequest, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const member = owned.roster.find((candidate) => candidate.characterId === characterId);
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
  const state = await editInspectorState({ chatId, characterId, profile, patch: body.value });
  return jsonOk(inspectorStateView(state));
});
