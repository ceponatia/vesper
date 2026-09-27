import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  CHAT_SKIP_MINUTES,
  characterProfileSchema,
  chatSkipAmountSchema,
  diag,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  garmentActorForCharacter,
  regardBandForValue,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  applyTimeSkipToScenario,
  armMeanwhilePass,
  chatStateSnapshot,
  enqueueChatMeanwhile,
  garmentReadoutsFor,
  loadChatScenario,
  loadChatState,
  mirrorShadowTimeSkip,
  persistChatTimeSkip,
  readSimChatClock,
  reconcileActorWardrobes,
  resolveSeededOutfit,
  saveChatScenario,
  seedChatScenario,
  seedChatState,
  skipChatMember,
  type ChatGarmentWardrobeChange,
  type ChatState,
} from "@/server/engine";
import { log } from "@/server/log";
import { chatBusyResponse, loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Player time skip (D3/D8): the ONE between-scene time mechanism. The SHARED
 * scenario clock advances once (one story timeline for the whole roster), the
 * one-shot skip note is stamped on the scenario (worded by the primary's regard
 * band), and the skip records itself into the scenario's ring. Every member's
 * meters then integrate across the skipped minutes, crossing their routine (sleep
 * windows credited, washes landed) — away members too, because physiology is
 * presence-independent — and each PRESENT member also takes the
 * scene-boundary half: timed-condition expiry, the familiarity scene-budget
 * reset, feeling softening, rhythm dress. The clock and every member row commit
 * in ONE transaction, so a failed skip changes nothing. A chat with no state row
 * yet degrades to seed + skip — never a failed action.
 */

const skipBodySchema = z.object({ amount: chatSkipAmountSchema });

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const body = await readBody(req, skipBodySchema);
  if (!body.ok) return body.response;

  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) {
    return jsonError("chat_archived", "this conversation is archived; restore it to continue", 409);
  }
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;
  // Lanes stay separate: a sim-routed chat's time is the
  // world's storySecond — skips go through the sim advance_time admission, and
  // the legacy scenario clock must never advance underneath it.
  if ((await readSimChatClock(chatId)) !== null) {
    return jsonError("sim_routed", "this conversation's time belongs to its world — reload and skip again", 409);
  }

  const sink = new DiagnosticCollector();
  const primaryProfile = parseOr(
    characterProfileSchema,
    owned.character.profile ?? {},
    emptyCharacterProfile(),
    sink,
    "characters.profile",
  );
  const primaryStored = await loadChatState(chatId, owned.participant.characterId, sink);
  // This path persists a possibly-fresh seed — resolve the outfit marker first.
  const primaryBase = await resolveSeededOutfit(
    primaryStored ?? seedChatState(primaryProfile),
    user.id,
    primaryProfile,
    sink,
  );

  const scenario = (await loadChatScenario(chatId, sink)) ?? seedChatScenario(primaryProfile);
  const nextScenario = applyTimeSkipToScenario(
    scenario,
    body.value.amount,
    regardBandForValue(primaryBase.regard).id,
    new Date(),
  );

  // Every roster member's post-skip state, computed BEFORE anything is written
  // (the primary reuses its already-resolved state). `skipChatMember` integrates
  // each member's meters across the skipped minutes — present or away — and gives
  // only PRESENT members the scene-boundary half; a present member's rhythm dress
  // (a schedule row at the new clock naming a preset) re-dresses them for the
  // window.
  let primaryNext = primaryBase;
  const memberWrites: { characterId: string; state: ChatState }[] = [];
  // Rhythm auto-dress is a PRESET application, so it compiles to garment
  // transfers like every other worn-list write.
  // Collected here and reconciled in one pass after the commit — the store is one
  // jsonb field, so it takes one write, not one per member.
  const wardrobeChanges: ChatGarmentWardrobeChange[] = [];
  for (const member of owned.roster) {
    const isPrimary = member.characterId === owned.participant.characterId;
    const profile = isPrimary
      ? primaryProfile
      : parseOr(characterProfileSchema, member.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
    const base = isPrimary
      ? primaryBase
      : await resolveSeededOutfit(
          (await loadChatState(chatId, member.characterId, sink)) ?? seedChatState(profile),
          user.id,
          profile,
          sink,
        );
    const next = await resolveSeededOutfit(
      skipChatMember(base, body.value.amount, nextScenario.clockMinutes, profile, nextScenario.calendarStart),
      user.id,
      profile,
      sink,
    );
    memberWrites.push({ characterId: member.characterId, state: next });
    if (next.wornItemIds.join(",") !== base.wornItemIds.join(",")) {
      wardrobeChanges.push({
        actorId: garmentActorForCharacter(member.characterId),
        preWornItemIds: base.wornItemIds,
        wornItemIds: next.wornItemIds,
      });
    }
    if (isPrimary) primaryNext = next;
  }

  // The clock and every member row commit together or not at all: a failed skip
  // can never leave the shared clock past a member still at the old boundary.
  try {
    await persistChatTimeSkip(chatId, nextScenario, memberWrites);
  } catch (error) {
    log.error("engine.chat", "time skip did not commit", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError("time_skip_failed", "the time skip could not be saved; nothing changed — try again", 500);
  }

  // Detached follow-ups run only once the skip has landed.
  // R4 shadow: mirror the same minutes onto a shadow chat's branch (bounded
  // drain, detached) so the two clocks keep comparable deltas. No-op for
  // every other lane.
  void mirrorShadowTimeSkip(chatId, CHAT_SKIP_MINUTES[body.value.amount]);

  // The meanwhile pass: once the cumulative skipped
  // time since the last pass crosses the gate, ONE detached archivist-class job
  // advances the whole cast's off-screen lives. Fire-and-forget — the next exchange
  // proceeds on grounded improvisation if it hasn't landed (D3-safe: player-triggered).
  if (armMeanwhilePass(scenario.meanwhilePassAtMinutes, nextScenario.clockMinutes)) {
    void enqueueChatMeanwhile({
      chatId,
      ownerId: user.id,
      prevPassAtMinutes: scenario.meanwhilePassAtMinutes,
      clockMinutes: nextScenario.clockMinutes,
      skipNote: nextScenario.pendingSkipNote,
    });
  }

  // Fenced: a failed reconcile costs the store's freshness for these members,
  // never the skip itself (which has already landed above).
  let garmentStore = nextScenario.garments;
  if (wardrobeChanges.length > 0) {
    try {
      const garments = await reconcileActorWardrobes({
        store: nextScenario.garments,
        ownerId: user.id,
        atMinutes: nextScenario.clockMinutes,
        changes: wardrobeChanges,
        sink,
      });
      garmentStore = garments;
      await saveChatScenario(chatId, { ...nextScenario, garments });
    } catch (error) {
      sink.push(
        diag(
          "warn",
          "chat_garments.skip_reconcile_failed",
          `rhythm re-dress did not reach the garment store: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  return jsonOk({
    ...chatStateSnapshot(primaryNext, nextScenario, {
      dominance: effectiveTraitValue(primaryProfile.traits, "social.dominance"),
      intimateContext: true,
      profile: primaryProfile,
    }),
    // The snapshot this response replaces on the client also feeds the Character
    // sheet's presentation controls, so it carries
    // the primary's garment readout — a rhythm re-dress may have changed it.
    garments: garmentReadoutsFor(
      garmentStore,
      garmentActorForCharacter(owned.participant.characterId),
      nextScenario.clockMinutes,
    ),
    garmentDiagnostics: [],
  });
});
