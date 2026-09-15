import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  characterProfileSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatPlansSchema,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  garmentActorForCharacter,
  garmentOperationListSchema,
  relationshipTextureSchema,
  socialReactionCardSchema,
  chatPlayerStateSchema,
  supportingCastSchema,
  type CharacterProfile,
} from "@/contracts";
import { calendarStartSchema } from "@/lib/clock";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import {
  chatStateSnapshot,
  garmentReadoutsFor,
  driftChatState,
  editChatState,
  isSimRoutedAuthority,
  loadChatScenario,
  loadChatState,
  readChatEngineAuthority,
  readSimChatClock,
  readSimChatMeters,
  readSimChatOutfit,
  readSimChatRelationship,
  resolveChatWardrobe,
  resolveSeededOutfit,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Aggregate compatibility read model. GET remains intentionally broad because
 * the conversation screen consumes one projection. PATCH is deprecated: new
 * first-party writes use `/scenario`, participant state/wardrobe, player state,
 * and admin inspector resources. Engine/debug fields are no longer accepted here.
 */
const editBodySchema = z
  .object({
    premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).optional(),
    regard: z.number().int().min(-100).max(100).optional(),
    familiarity: z.number().int().min(0).max(100).optional(),
    relationship: relationshipTextureSchema.optional(),
    mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
    meters: z.record(z.string(), z.number()).optional(),
    conditions: z.array(activeConditionSchema).optional(),
    wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
    outfitPresetId: z.string().max(120).optional(),
    outfit: z.string().optional(),
    outfitExposed: z.boolean().optional(),
    garmentOperations: garmentOperationListSchema.optional(),
    activeSocialCards: z.array(socialReactionCardSchema).optional(),
    sceneAuto: z.enum(["off", "milestones"]).optional(),
    sceneModel: z.string().trim().max(64).optional(),
    playerState: chatPlayerStateSchema.optional(),
    supportingCast: supportingCastSchema.optional(),
    plans: chatPlansSchema.optional(),
    calendarStart: calendarStartSchema.optional(),
    whereabouts: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one state field is required");

const snapshotOpts = (profile: CharacterProfile) => ({
  dominance: effectiveTraitValue(profile.traits, "social.dominance"),
  intimateContext: true,
});

function targetMember(owned: OwnedChat, req: NextRequest): { characterId: string; profile: unknown } | null {
  const characterId = new URL(req.url).searchParams.get("characterId");
  if (!characterId) return { characterId: owned.participant.characterId, profile: owned.character.profile };
  const member = owned.roster.find((m) => m.characterId === characterId);
  return member ? { characterId: member.characterId, profile: member.character.profile } : null;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const target = targetMember(owned, req);
    if (!target) return jsonError("not_found", "that character is not in this conversation", 404);

    const sink = new DiagnosticCollector();
    const profile = parseOr(characterProfileSchema, target.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
    const stored = await loadChatState(chatId, target.characterId, sink);
    const base = await resolveSeededOutfit(stored ?? seedChatState(profile), user.id, profile, sink);
    const scenario = (await loadChatScenario(chatId, sink)) ?? seedChatScenario(profile);
    const drifted = stored ? driftChatState(base, profile, { advance: false, clockMinutes: scenario.clockMinutes }) : base;
    const isPrimaryTarget = target.characterId === owned.participant.characterId;
    const [simMeters, simRelationship] = isPrimaryTarget
      ? await Promise.all([readSimChatMeters(chatId), readSimChatRelationship(chatId)])
      : [null, null];
    const state = {
      ...drifted,
      ...(simMeters === null ? {} : { meters: { ...drifted.meters, ...simMeters } }),
      ...(simRelationship === null ? {} : { regard: simRelationship.regard, familiarity: simRelationship.familiarity }),
    };
    const wardrobe = await resolveChatWardrobe(
      { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(target.characterId) },
      user.id,
      profile,
      sink,
    );
    const simOutfit = target.characterId === owned.participant.characterId ? await readSimChatOutfit(chatId) : null;
    return jsonOk({
      ...chatStateSnapshot(state, scenario, { ...snapshotOpts(profile), persisted: stored !== null }),
      outfitLabel: simOutfit ?? wardrobe.garments,
      garments: garmentReadoutsFor(
        scenario.garments,
        garmentActorForCharacter(target.characterId),
        scenario.clockMinutes,
      ),
      garmentDiagnostics: [],
      simClock: await readSimChatClock(chatId),
    });
  },
);

/** @deprecated First-party callers must use the focused chat-state resources. */
export const PATCH = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (user, owned, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const target = targetMember(owned, req);
    if (!target) return jsonError("not_found", "that character is not in this conversation", 404);
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;

    const body = await readBody(req, editBodySchema);
    if (!body.ok) return body.response;

    const profile = parseOr(characterProfileSchema, target.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    const simRouted = isSimRoutedAuthority(await readChatEngineAuthority(chatId));

    // Calendar ownership is chat-wide, regardless of which participant query
    // parameter a legacy caller happened to send.
    if (simRouted && body.value.calendarStart !== undefined) {
      return jsonError(
        "sim_calendar_managed_by_world",
        "this conversation's calendar is owned by the successor world; change the world calendar instead",
        409,
      );
    }

    if (target.characterId === owned.participant.characterId && simRouted) {
      if (body.value.regard !== undefined || body.value.familiarity !== undefined || body.value.meters !== undefined) {
        return jsonError(
          "sim_participant_state_managed_by_world",
          "this character's relationship scalars and meters are owned by the successor world",
          409,
        );
      }

      const current = await resolveSeededOutfit(
        (await loadChatState(chatId, target.characterId)) ?? seedChatState(profile),
        user.id,
        profile,
      );
      const wardrobeChanged =
        (body.value.garmentOperations?.length ?? 0) > 0 ||
        (body.value.wornItemIds !== undefined && !sameStrings(body.value.wornItemIds, current.wornItemIds)) ||
        (body.value.outfitPresetId !== undefined && body.value.outfitPresetId !== current.outfitPresetId) ||
        (body.value.outfit !== undefined && body.value.outfit !== current.outfit) ||
        (body.value.outfitExposed !== undefined && body.value.outfitExposed !== current.outfitExposed);
      if (wardrobeChanged) {
        return jsonError(
          "sim_wardrobe_managed_by_world",
          "this character's clothing is owned by the successor world's material state; change it through world actions rather than character-chat wardrobe controls",
          409,
        );
      }
    }

    const editSink = new DiagnosticCollector();
    const { state, scenario } = await editChatState({
      chatId,
      characterId: target.characterId,
      ownerId: user.id,
      profile,
      patch: body.value,
      sink: editSink,
    });
    const wardrobe = await resolveChatWardrobe(
      { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(target.characterId) },
      user.id,
      profile,
    );
    const simOutfit =
      target.characterId === owned.participant.characterId ? await readSimChatOutfit(chatId) : null;
    return jsonOk({
      ...chatStateSnapshot(state, scenario, snapshotOpts(profile)),
      outfitLabel: simOutfit ?? wardrobe.garments,
      garments: garmentReadoutsFor(
        scenario.garments,
        garmentActorForCharacter(target.characterId),
        scenario.clockMinutes,
      ),
      garmentDiagnostics: editSink.items
        .filter((d) => d.code.startsWith("garment_op."))
        .map((d) => ({ code: d.code, message: d.message })),
      simClock: await readSimChatClock(chatId),
    });
  },
);