import type { ChatState, ChatScenario } from "./types";
import type { ChatMemoryTrace } from "@/contracts";
import type { FinalizeChatStateInput, FinalizeChatStateResult } from "./finalize-types";
import { runFinalizationAgents } from "./finalize-agents";
import { writeFinalizationMemory } from "./memory-writes";
import { foldFinalizationNarrative } from "./narrative-fold";
import { foldFinalizationWardrobe } from "./wardrobe-fold";
import { foldFinalizationSurface } from "./surface-fold";
import { foldPrimaryPersonalFields, foldPrimaryProgression } from "./character-fold";
import { persistFinalization } from "./finalize-persist";
import { enqueueFinalization } from "./finalize-enqueue";

/**
 * Close the turn: run the post-turn fan-out — the reaction pulse ‖ the
 * archivist-lite — in PARALLEL on the drifted state + the
 * just-finished exchange, write the extracted long-term memory (episode + facts), then
 * fold in the relationship samples/milestones + next turn's memory queries and persist (guarded). Called
 * from the chat route's stream finalizer after `persistAssistantReply`, so the whole
 * fan-out only delays `controller.close()` — invisible to perceived latency, and any leg
 * degrades to a diagnostic without touching the already-flushed reply.
 */
export async function finalizeChatState(input: FinalizeChatStateInput): Promise<FinalizeChatStateResult> {
  const { pulse, archivist, minor, garmentHandles, scenePlaceName } = await runFinalizationAgents({
    profile: input.profile,
    driftedState: input.driftedState,
    characterName: input.characterName,
    scenario: input.scenario,
    playerName: input.playerName,
    characterId: input.characterId,
    skipPulse: input.skipPulse,
    exchange: input.exchange,
    pulseScope: input.pulseScope,
    chatId: input.chatId,
    assistantMessageId: input.assistantMessageId,
    sink: input.sink,
    roster: input.roster,
    priorSummary: input.priorSummary,
  });
  await writeFinalizationMemory({
    memoryGroupId: input.memoryGroupId,
    characterId: input.characterId,
    assistantMessageId: input.assistantMessageId,
    sink: input.sink,
    extraMemoryWrites: input.extraMemoryWrites,
  }, archivist);
  const { surfacedCues, attributeOverlays, voiceExemplars, openLoops } = foldPrimaryPersonalFields({
    driftedState: input.driftedState,
    sink: input.sink,
    scenario: input.scenario,
    assistantMessageId: input.assistantMessageId,
  }, archivist);
  const { sceneMemory, supportingCast, plans, planMerge, planAdvance } = foldFinalizationNarrative({
    scenario: input.scenario,
    playerName: input.playerName,
    characterName: input.characterName,
    roster: input.roster,
  }, archivist);
  const { outfitChanged, outfitPatch, garmentStore, wornItemIds, playerState, garmentTrace, lane } = await foldFinalizationWardrobe({
    sink: input.sink,
    roster: input.roster,
    characterName: input.characterName,
    profile: input.profile,
    ownerId: input.ownerId,
    driftedState: input.driftedState,
    exchange: input.exchange,
    playerName: input.playerName,
    playerPersona: input.playerPersona,
    scenario: input.scenario,
    characterId: input.characterId,
    garmentCueState: input.garmentCueState,
    affordanceCoverage: input.affordanceCoverage,
  }, archivist, garmentHandles, scenePlaceName);
  const { environmentFold, effectFold, transferSettled } = foldFinalizationSurface({
    scenario: input.scenario,
    driftedState: input.driftedState,
    sink: input.sink,
    contactMarkProposals: input.contactMarkProposals,
    surfaceTransfer: input.surfaceTransfer,
    characterId: input.characterId,
  }, archivist, garmentStore);
  const { familiarity, familiaritySceneGain, relationshipHistory, milestones, traitOverlays, selfieHistory, bigMoment, selfieKind, drives } = foldPrimaryProgression({
    preExchangeState: input.preExchangeState,
    driftedState: input.driftedState,
    now: input.now,
    skipPulse: input.skipPulse,
    scenario: input.scenario,
    assistantMessageId: input.assistantMessageId,
    characterName: input.characterName,
    playerName: input.playerName,
    profile: input.profile,
    sink: input.sink,
    selfie: input.selfie,
  }, pulse, archivist, minor, planMerge, planAdvance);
  const lastMemoryTrace: ChatMemoryTrace = {
    retrievedFacts: input.retrieved?.facts ?? [],
    retrievedEpisodes: input.retrieved?.episodes ?? [],
    episodeSummary: archivist.value?.episodeSummary ?? "",
    factsAdded: archivist.value?.facts.length ?? 0,
    memoryQueries: archivist.value?.memoryQueries ?? [],
    attributeChanges: (archivist.value?.attributeChanges ?? []).map((c) => `${c.attributeId}=${String(c.value)}`),
    retrievedDetail: input.retrieved?.detail ?? [],
    // Every garment proposal's fate: proposed →
    // resolved → applied / no_change / rejected + code. Riding the memory trace
    // puts it in the admin inspector's existing view AND inside the rollback
    // snapshot, so a retake discards the record along with the operations.
    garmentOperations: garmentTrace,
    garmentLane: lane,
    // The MEMORY trace's degraded flag tracks the leg that owns memory (the scribe): its
    // other fields — summary, facts, queries — all come from that leg, so a failed
    // continuity/character leg must not flag the memory read as degraded.
    degraded: archivist.legs.memory,
    // Character-consistency corrective: this exchange's slip note (or "") rides the
    // trace so NEXT turn's prompt build renders a one-turn corrective tail; rolls back safely.
    characterSlip: archivist.value?.characterSlip ?? "",
  };
  // Presence transitions: the archivist's
  // confirmed reads. The primary's own transition folds into THIS save; the
  // caller applies the others' to their member states.
  const presenceChanges = archivist.value?.presence ?? [];
  const selfChange = presenceChanges.find(
    (p) => p.name.trim().toLowerCase() === input.characterName.trim().toLowerCase(),
  );
  const selfPresence = selfChange?.presence;
  // Whereabouts: a member who was PRESENT with a
  // pending whereabouts just spent it on this exchange's return license — clear it;
  // an away departure that named where it went records the phrase.
  const whereabouts =
    input.driftedState.presence === "present" && input.driftedState.whereabouts ? "" : pulse.state.whereabouts;
  const settledState: ChatState = {
    ...pulse.state,
    whereabouts,
    ...(selfPresence ? { presence: selfPresence } : {}),
    ...(selfPresence === "away" && selfChange?.where ? { whereabouts: selfChange.where } : {}),
    familiarity,
    familiaritySceneGain,
    surfacedCues,
    memoryQueries: archivist.value?.memoryQueries ?? [],
    openLoops,
    attributeOverlays,
    traitOverlays,
    voiceExemplars,
    lastMemoryTrace,
    relationshipHistory,
    milestones,
    selfieHistory,
    drives,
    // A committed transfer's DEBITED source surface wins over the effect fold's:
    // the owner transaction removed the transferred material
    // from it and wrote the idempotency receipt onto that same value, so
    // persisting the fold's copy instead would un-remove what was moved AND drop
    // the receipt, letting the next retry transfer the same material again.
    bodySurface: transferSettled?.bodySurface ?? effectFold.surface,
    ...outfitPatch,
    // The worn list is a PROJECTION of the garment store, re-derived
    // after the reconcile AND the typed operations above so the column can never
    // become a second truth.
    wornItemIds,
  };
  // The scenario save: the merged scene memory, the ticked
  // clock the pipeline already applied, and the one-shot skip note clearing —
  // guarded like the state save.
  const settledScenario: ChatScenario = {
    // Both one-shot notes clear together: the exchange that rendered the skip
    // note also rendered the meanwhile note.
    ...input.scenario,
    sceneMemory,
    supportingCast,
    plans,
    playerState,
    // The transfer's layer owner is the credited half of the same equation as
    // `bodySurface` above; the two must come from ONE settlement or conservation
    // is only half-recorded.
    garments: transferSettled?.garments ?? garmentStore,
    environment: environmentFold.environment,
    // Mention history rides the scenario beside the weather it was read
    // against. Flag off ⇒ the prior memory passes through, exactly as the
    // garment cue map does.
    ...(input.affordanceCueState ? { affordanceCues: input.affordanceCueState } : {}),
    pendingSkipNote: "",
    pendingMeanwhileNote: "",
  };
  await persistFinalization({
    chatId: input.chatId,
    characterId: input.characterId,
    promptMessageId: input.promptMessageId,
    preExchangeState: input.preExchangeState,
    preExchangeScenario: input.preExchangeScenario,
  }, settledState, settledScenario, transferSettled);
  const { characterLookChanged, playerLookChanged } = enqueueFinalization({
    chatId: input.chatId,
    characterId: input.characterId,
    characterName: input.characterName,
    scenario: input.scenario,
  }, sceneMemory, garmentStore, outfitChanged, archivist.value?.attributeChanges.length ?? 0);
  return {
    bigMoment,
    selfieSend: selfieKind !== null,
    presenceChanges,
    // Two signals OR-ed per body, because they see different change vectors: the
    // worn-id comparison catches set changes on a wardrobe the look key cannot
    // see (an actor with no garment instances — the lazy-materialization and
    // legacy paths), while the look key catches STATE changes that move no id at
    // all — a soaked blouse, a displaced hem, a damage mark — which shift the
    // coverage a contact's material read would compose. Either one is a wardrobe
    // this reply authoritatively moved, and a same-reply contact start must not
    // date its material against it.
    wardrobeChanged: {
      character: wornItemIds.join(",") !== input.driftedState.wornItemIds.join(",") || characterLookChanged,
      player:
        playerState.wornItemIds.join(",") !== input.scenario.playerState.wornItemIds.join(",") ||
        playerLookChanged,
    },
  };
}

