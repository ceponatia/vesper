import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  attributeValueSchema,
  characterProfileSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatDrivesSchema,
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
  chatFeelingStateSchema,
  chatStateSnapshot,
  garmentReadoutsFor,
  selfieHistorySchema,
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
 * Aggregate state is now primarily a compatibility READ projection. PATCH stays
 * temporarily for external callers while first-party UI writes are dispatched to
 * focused resources. Inspector/debug fields are deliberately rejected here.
 */
const editBodySchema = z.object({
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
  // Accepted only so legacy callers receive a deliberate migration error rather
  // than having zod silently strip the field before we can explain its new home.
  openLoops: z.array(z.string().trim().max(200)).max(6).optional(),
  memoryQueries: z.array(z.string().trim().max(200)).max(6).optional(),
  surfacedCues: z.record(z.string(), z.string()).optional(),
  attributeOverlays: z.array(attributeValueSchema).optional(),
  sceneAuto: z.enum(["off", "milestones"]).optional(),
  sceneModel: z.string().trim().max(64).optional(),
  callbackHistory: z.array(z.object({ ref: z.string().max(80), atClockMinutes: z.number() })).max(20).optional(),
  feeling: chatFeelingStateSchema.optional(),
  selfieHistory: selfieHistorySchema.optional(),
  drives: chatDrivesSchema.optional(),
  playerState: chatPlayerStateSchema.optional(),
  supportingCast: supportingCastSchema.optional(),
  plans: chatPlansSchema.optional(),
  calendarStart: calendarStartSchema.optional(),
  whereabouts: z.string().trim().max(120).optional(),
});

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

const sameRecord = (a: Record<string, number>, b: Record<string, number>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function hasInspectorMutation(value: z.infer<typeof editBodySchema>): boolean {
  return (
    value.openLoops !== undefined ||
    value.memoryQueries !== undefined ||
    value.surfacedCues !== undefined ||
    value.attributeOverlays !== undefined ||
    value.callbackHistory !== undefined ||
    value.feeling !== undefined ||
    value.selfieHistory !== undefined ||
    value.drives !== undefined
  );
}

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
    if (hasInspectorMutation(body.value)) {
      return jsonError(
        "inspector_state_moved",
        "engine/debug state is no longer writable through the gameplay state endpoint; use the admin self-inspector participant-state resource",
        410,
      );
    }

    const profile = parseOr(characterProfileSchema, target.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    const patch = { ...body.value };

    if (
      target.characterId === owned.participant.characterId &&
      isSimRoutedAuthority(await readChatEngineAuthority(chatId))
    ) {
      if (patch.calendarStart !== undefined) {
        return jsonError(
          "sim_calendar_managed_by_world",
          "this conversation's calendar is owned by the successor world; change the world calendar rather than the legacy chat scenario anchor",
          409,
        );
      }

      const stored = (await loadChatState(chatId, target.characterId)) ?? seedChatState(profile);
      const current = await resolveSeededOutfit(stored, user.id, profile);
      const [simMeters, simRelationship] = await Promise.all([
        readSimChatMeters(chatId),
        readSimChatRelationship(chatId),
      ]);
      const effectiveMeters = simMeters === null ? current.meters : { ...current.meters, ...simMeters };
      const effectiveRegard = simRelationship?.regard ?? current.regard;
      const effectiveFamiliarity = simRelationship?.familiarity ?? current.familiarity;
      const worldOwnedChanged =
        (patch.regard !== undefined && patch.regard !== effectiveRegard) ||
        (patch.familiarity !== undefined && patch.familiarity !== effectiveFamiliarity) ||
        (patch.meters !== undefined && !sameRecord(patch.meters, effectiveMeters));
      if (worldOwnedChanged) {
        return jsonError(
          "sim_participant_state_managed_by_world",
          "this character's relationship scalars and meters are owned by the successor world; change them through world-authoritative actions instead",
          409,
        );
      }
      // Unchanged world-owned values are compatibility noise from whole-form
      // submitters. Strip them rather than persisting shadow state the read path masks.
      delete patch.regard;
      delete patch.familiarity;
      delete patch.meters;

      const wardrobeChanged =
        (patch.garmentOperations?.length ?? 0) > 0 ||
        (patch.wornItemIds !== undefined && !sameStrings(patch.wornItemIds, current.wornItemIds)) ||
        (patch.outfitPresetId !== undefined && patch.outfitPresetId !== current.outfitPresetId) ||
        (patch.outfit !== undefined && patch.outfit !== current.outfit) ||
        (patch.outfitExposed !== undefined && patch.outfitExposed !== current.outfitExposed);
      if (wardrobeChanged) {
        return jsonError(
          "sim_wardrobe_managed_by_world",
          "this character's clothing is owned by the successor world's material state; change it through world actions rather than character-chat wardrobe controls",
          409,
        );
      }
      delete patch.wornItemIds;
      delete patch.outfitPresetId;
      delete patch.outfit;
      delete patch.outfitExposed;
      delete patch.garmentOperations;
    }

    const editSink = new DiagnosticCollector();
    const { state, scenario } = await editChatState({
      chatId,
      characterId: target.characterId,
      ownerId: user.id,
      profile,
      patch,
      sink: editSink,
    });
    const wardrobe = await resolveChatWardrobe(
      { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(target.characterId) },
      user.id,
      profile,
    );
    const simOutfit = target.characterId === owned.participant.characterId ? await readSimChatOutfit(chatId) : null;
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
