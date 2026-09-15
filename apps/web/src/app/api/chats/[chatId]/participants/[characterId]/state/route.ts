import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  characterProfileSchema,
  emptyCharacterProfile,
  relationshipTextureSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  WHEREABOUTS_MAX_CHARS,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import {
  driftChatState,
  isSimRoutedAuthority,
  readChatEngineAuthority,
  readSimChatMeters,
  readSimChatRelationship,
} from "@/server/engine";
import { editParticipantState } from "@/server/engine/chat-state/focused-edit";
import { participantStateView } from "@/server/engine/chat-state/focused-read";
import { seedChatScenario, seedChatState } from "@/server/engine/chat-state/seed";
import { loadChatScenario, loadChatState } from "@/server/engine/chat-state/store";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../../owned";

type Params = { chatId: string; characterId: string };

const patchSchema = z.object({
  regard: z.number().int().min(-100).max(100).optional(),
  familiarity: z.number().int().min(0).max(100).optional(),
  relationship: relationshipTextureSchema.optional(),
  meters: z.record(z.string(), z.number()).optional(),
  conditions: z.array(activeConditionSchema).optional(),
  mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
  whereabouts: z.string().trim().max(WHEREABOUTS_MAX_CHARS).optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one participant-state field is required");

function targetMember(owned: OwnedChat, characterId: string) {
  return owned.roster.find((member) => member.characterId === characterId) ?? null;
}

function profileFor(member: NonNullable<ReturnType<typeof targetMember>>) {
  return parseOr(characterProfileSchema, member.character.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
}

async function readView(chatId: string, owned: OwnedChat, characterId: string) {
  const member = targetMember(owned, characterId);
  if (!member) return null;
  const profile = profileFor(member);
  const stored = await loadChatState(chatId, characterId);
  const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile);
  const base = stored ?? seedChatState(profile);
  const drifted = stored ? driftChatState(base, profile, { advance: false, clockMinutes: scenario.clockMinutes }) : base;
  const primary = characterId === owned.participant.characterId;
  const [simMeters, simRelationship] = primary
    ? await Promise.all([readSimChatMeters(chatId), readSimChatRelationship(chatId)])
    : [null, null];
  const state = {
    ...drifted,
    ...(simMeters === null ? {} : { meters: { ...drifted.meters, ...simMeters } }),
    ...(simRelationship === null ? {} : { regard: simRelationship.regard, familiarity: simRelationship.familiarity }),
  };
  return participantStateView({ characterId, state, scenario, profile, persisted: stored !== null });
}

const sameRecord = (a: Record<string, number>, b: Record<string, number>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
    const { chatId, characterId } = await ctx.params;
    const view = await readView(chatId, owned, characterId);
    return view ? jsonOk(view) : jsonError("not_found", "that character is not in this conversation", 404);
  },
);

export const PATCH = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, req: NextRequest, ctx) => {
    const { chatId, characterId } = await ctx.params;
    const member = targetMember(owned, characterId);
    if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;
    const body = await readBody(req, patchSchema);
    if (!body.ok) return body.response;

    const patch = { ...body.value };
    const primary = characterId === owned.participant.characterId;
    if (primary && isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
      const current = await readView(chatId, owned, characterId);
      if (!current) return jsonError("not_found", "that character is not in this conversation", 404);
      const changed =
        (patch.regard !== undefined && patch.regard !== current.regard) ||
        (patch.familiarity !== undefined && patch.familiarity !== current.familiarity) ||
        (patch.meters !== undefined && !sameRecord(patch.meters, current.meters));
      if (changed) {
        return jsonError(
          "sim_participant_state_managed_by_world",
          "this character's relationship scalars and meters are owned by the successor world; change them through world-authoritative actions instead",
          409,
        );
      }
      delete patch.regard;
      delete patch.familiarity;
      delete patch.meters;
      if (Object.keys(patch).length === 0) return jsonOk(current);
    }

    await editParticipantState({ chatId, characterId, profile: profileFor(member), patch });
    const view = await readView(chatId, owned, characterId);
    return view ? jsonOk(view) : jsonError("not_found", "that character is not in this conversation", 404);
  },
);
