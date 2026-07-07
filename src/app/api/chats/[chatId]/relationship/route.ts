import {
  characterProfileSchema,
  DiagnosticCollector,
  emptyCharacterProfile,
  familiarityBandForValue,
  regardBandForValue,
  relationshipRegionLabel,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { loadChatState, loadChatSummary, seedChatState } from "@/server/engine";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The Relationship panel payload (character-chat-standalone.spec.md §7): the two
 * axis bands + scalars and their region label (relationship-model.plan.md), the
 * sampled arc (§7.2 — now regard over the slow familiarity ramp), milestones,
 * the rolling summary as "the story so far" (§7.3, read-only here — rebuild is
 * its own lever), and the open loops (§6.2). One GET settles the whole panel.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, owned.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const state = (await loadChatState(chatId, owned.participant.characterId, sink)) ?? seedChatState(profile);
  const summary = await loadChatSummary(chatId);
  const band = regardBandForValue(state.regard);
  const famBand = familiarityBandForValue(state.familiarity);
  return jsonOk({
    regardBand: { id: band.id, label: band.label },
    regard: state.regard,
    familiarityBand: { id: famBand.id, label: famBand.label },
    familiarity: state.familiarity,
    region: relationshipRegionLabel(state.familiarity, state.regard),
    relationship: state.relationship,
    history: state.relationshipHistory,
    milestones: state.milestones,
    storySoFar: summary?.summary ?? "",
    openLoops: state.openLoops,
    clockMinutes: state.clockMinutes,
  });
});
