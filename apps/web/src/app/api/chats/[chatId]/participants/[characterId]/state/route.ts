import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  CHAT_MIND_NOTE_MAX_CHARS,
  activeConditionSchema,
  characterProfileSchema,
  effectiveTraitValue,
  emptyCharacterProfile,
  relationshipTextureSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import {
  chatStateSnapshot,
  driftChatState,
  isSimRoutedAuthority,
  loadChatScenario,
  loadChatState,
  readChatEngineAuthority,
  readSimChatMeters,
  readSimChatRelationship,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { editChatParticipantState } from "@/server/engine/chat-state/focused-edit";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../../../owned";

type Params = { chatId: string; characterId: string };

const patchSchema = z
  .object({
    regard: z.number().int().min(-100).max(100).optional(),
    familiarity: z.number().int().min(0).max(100).optional(),
    relationship: relationshipTextureSchema.optional(),
    meters: z.record(z.string(), z.number()).optional(),
    conditions: z.array(activeConditionSchema).optional(),
    mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
    whereabouts: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one participant-state field is required");

function targetMember(owned: OwnedChat, characterId: string) {
  return owned.roster.find((member) => member.characterId === characterId) ?? null;
}

async function project(args: {
  chatId: string;
  characterId: string;
  primaryCharacterId: string;
  profile: ReturnType<typeof emptyCharacterProfile>;
  stored: Awaited<ReturnType<typeof loadChatState>>;
}) {
  const scenario = (await loadChatScenario(args.chatId)) ?? seedChatScenario(args.profile);
  const base = args.stored ?? seedChatState(args.profile);
  const drifted = args.stored
    ? driftChatState(base, args.profile, { advance: false, clockMinutes: scenario.clockMinutes })
    : base;
  const primary = args.characterId === args.primaryCharacterId;
  const [simMeters, simRelationship] = primary
    ? await Promise.all([readSimChatMeters(args.chatId), readSimChatRelationship(args.chatId)])
    : [null, null];
  const state = {
    ...drifted,
    ...(simMeters === null ? {} : { meters: { ...drifted.meters, ...simMeters } }),
    ...(simRelationship === null
      ? {}
      : { regard: simRelationship.regard, familiarity: simRelationship.familiarity }),
  };
  const snapshot = chatStateSnapshot(state, scenario, {
    dominance: effectiveTraitValue(args.profile.traits, "social.dominance"),
    intimateContext: true,
    persisted: args.stored !== null,
  });
  return {
    characterId: args.characterId,
    persisted: snapshot.persisted,
    regard: snapshot.regard,
    familiarity: snapshot.familiarity,
    regardBand: snapshot.regardBand,
    familiarityBand: snapshot.familiarityBand,
    relationship: snapshot.relationship,
    emotion: snapshot.emotion,
    meters: snapshot.meters,
    conditions: snapshot.conditions,
    mindNote: snapshot.mindNote,
    whereabouts: snapshot.whereabouts,
  };
}

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
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
        profile,
        stored: await loadChatState(chatId, characterId),
      }),
    );
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

    if (
      characterId === owned.participant.characterId &&
      isSimRoutedAuthority(await readChatEngineAuthority(chatId)) &&
      (body.value.regard !== undefined || body.value.familiarity !== undefined || body.value.meters !== undefined)
    ) {
      return jsonError(
        "sim_participant_state_managed_by_world",
        "this character's relationship scalars and meters are owned by the successor world",
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
    const stored = await editChatParticipantState({ chatId, characterId, profile, patch: body.value });
    return jsonOk(
      await project({
        chatId,
        characterId,
        primaryCharacterId: owned.participant.characterId,
        profile,
        stored,
      }),
    );
  },
);
