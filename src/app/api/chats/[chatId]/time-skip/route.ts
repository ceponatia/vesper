import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  chatSkipAmountSchema,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  regardBandForValue,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  applyTimeSkip,
  applyTimeSkipToScenario,
  armMeanwhilePass,
  chatStateSnapshot,
  enqueueChatMeanwhile,
  loadChatScenario,
  loadChatState,
  persistChatState,
  resolveSeededOutfit,
  saveChatScenario,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * Player time skip (character-chat-standalone.spec.md §8.1, D3/D8/D14): the ONE
 * between-scene time mechanism. Flavor-only v1 — the SHARED scenario clock advances
 * once (followups ruling 8: one story timeline for the whole roster), the one-shot
 * skip note is stamped on the scenario (worded by the primary's regard band), and
 * the skip records itself into the scenario's scaffolding ring. Each PRESENT
 * member then takes the per-character half — timed-condition expiry against the
 * advanced clock, the familiarity scene-budget reset, and feeling decay over the
 * skipped time. **Meters do not change.** A chat with no state row yet degrades to
 * seed + skip (spec §11) — never a failed action.
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
  await saveChatScenario(chatId, nextScenario);

  // The meanwhile pass (chat-offscreen-life.plan.md): once the cumulative skipped
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

  // The per-character half for every PRESENT roster member (the primary reuses
  // its already-resolved state; away members stay frozen — their conditions
  // expire against the shared clock on their next drift anyway).
  let primaryNext = primaryBase;
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
    if (base.presence !== "present") continue;
    // Profile in ⇒ rhythm auto-dress: a schedule row at the new clock naming a
    // preset re-dresses this member for the window (slice 8.4).
    const next = await resolveSeededOutfit(
      applyTimeSkip(base, body.value.amount, nextScenario.clockMinutes, profile, nextScenario.calendarStart),
      user.id,
      profile,
      sink,
    );
    await persistChatState(chatId, member.characterId, next);
    if (isPrimary) primaryNext = next;
  }

  return jsonOk(
    chatStateSnapshot(primaryNext, nextScenario, {
      dominance: effectiveTraitValue(primaryProfile.traits, "social.dominance"),
      intimateContext: true,
    }),
  );
});
