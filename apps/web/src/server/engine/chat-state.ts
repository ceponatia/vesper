import type { ChatState, ChatScenario } from "./chat-state/types";
import {
  type CharacterProfile,
  type PersonaProfile,
  type RetrievedMemoryDetail,
  type GarmentCueState,
  type AffordanceCueState,
  type EffectiveCoverageRead,
  type BodyMarkProposal,
  type DiagnosticSink,
  resolveTraits,
  traitRegistry,
  hasVoiceAnchors,
  type ChatPlan,
  planOthersLabel,
  describePlanWhen,
  currentScenePlace,
  buildGarmentHandleTable,
  garmentActorForCharacter,
  GARMENT_PLAYER_ACTOR,
  advancePlans,
  diag,
  splitStateCues,
  mergeSceneMemory,
  mergeSupportingCast,
  mergeChatPlans,
  garmentMutationLane,
  type ChatPlayerState,
  applyGarmentProposals,
  type GarmentOperationTraceEntry,
  applyEnvironmentProposal,
  applySurfaceWetnessProposals,
  parseSurfaceWetnessProposals,
  applySurfaceDepositProposals,
  parseSurfaceDepositProposals,
  applyBodyMarkProposals,
  type ChatSurfaceTraceEntry,
  tickFamiliarity,
  appendRelationshipSample,
  regardBandForValue,
  deriveExchangeMilestones,
  applyDriveUpdates,
  planInvolvesPlayer,
  appendMilestones,
  type ChatMemoryTrace,
  type ChatPersonalNotes,
  type Milestone,
} from "@/contracts";
import { type ChatSurfaceTransferInput, persistSurfaceTransferSettlement } from "./chat-state/surface-transfer";
import { lifeStageForAge, lifeStageThirdPersonLine } from "@/contracts/world/life-stage";
import { runChatPulse } from "./chat-state/pulse-agent";
import { runChatExtraction, writeChatMemory } from "./chat-memory";
import { applyChatAttributeOverlays, applyChatTraitOverlays } from "./chat-state/pulse-rules";
import { appendVoiceExemplar } from "./chat-voice";
import { newId } from "@/lib/ids";
import { foldOutfitProposal, foldPlayerOutfitProposal } from "./chat-state/outfit-fold";
import { syncGarmentsForExchange, garmentProjectionOr, chatGarmentLookChanged } from "./chat-garments";
import { applySurfaceTransferProposals } from "@/contracts/turns/chat-contact-transfer";
import { appendSelfieEntry } from "./chat-selfie";
import { saveChatState, saveChatScenario } from "./chat-state/store";
import { savePreExchangeSnapshot, savePreExchangeScenario } from "./chat-state/snapshots";
import { enqueueChatSceneSketch } from "./chat-scene-sketch";
import { enqueueChatLookImage } from "./chat-reference-enqueue";
import {
  type OutfitEvidenceExchange,
  type OutfitEvidenceOwner,
  matchOutfitPresetInText,
  outfitChangeEvidenceValidated,
} from "./chat-state/outfit-evidence";

export type { ChatPresence, ChatScenario, ChatState, ChatStateSnapshot } from "./chat-state/types";
export { chatStateSnapshot } from "./chat-state/readout";
export { seedChatScenario, seedChatState } from "./chat-state/seed";
export { applyTimeSkip, applyTimeSkipToScenario, driftChatState, rhythmOutfitPatch } from "./chat-state/time";
export {
  applyChatAction,
  applyChatAttributeOverlays,
  applyChatPulse,
  applyChatTraitOverlays,
  applyOpenerPulse,
} from "./chat-state/pulse-rules";

/**
 * Close the turn: run the post-turn fan-out — the reaction pulse ‖ the
 * archivist-lite — in PARALLEL on the drifted state + the
 * just-finished exchange, write the extracted long-term memory (episode + facts), then
 * fold in the relationship samples/milestones + next turn's memory queries and persist (guarded). Called
 * from the chat route's stream finalizer after `persistAssistantReply`, so the whole
 * fan-out only delays `controller.close()` — invisible to perceived latency, and any leg
 * degrades to a diagnostic without touching the already-flushed reply.
 */
export async function finalizeChatState(input: {
  chatId: string;
  characterId: string;
  /** Chat owner — loads worn/pool items when the archivist proposes garment-level changes. */
  ownerId: string;
  /** The participant's memory group. */
  memoryGroupId: string;
  /** Provenance anchor: the assistant message row this exchange produced/updated. */
  assistantMessageId: string;
  /**
   * The STORED state as it stood before this exchange (null on a first exchange) —
   * persisted as the row's rollback snapshot so "another take" can undo the
   * exchange's drift + fan-out effects.
   */
  preExchangeState: ChatState | null;
  /**
   * Skip the reaction pulse (a "go on" continue beat has no player act to react
   * to); the archivist still runs — continued narrative is worth remembering.
   */
  skipPulse?: boolean;
  /**
   * Run the pulse OPENER-scoped: an initiative
   * opener with the selfie license armed needs the pulse's `sentPhoto` read (and
   * takes the mindNote refresh), but none of the curve's moves. Only meaningful
   * when `skipPulse` is false.
   */
  pulseScope?: "full" | "opener";
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  /**
   * The player's persona sheet — the wardrobe pool the
   * archivist's `playerOutfit` deltas resolve against. Absent when the chat resolved to
   * the bare account name (no persona), in which case the player has no clothes to move
   * and the fold is a no-op.
   */
  playerPersona?: PersonaProfile;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  /**
   * The rolling summary as it stood for this exchange: the memory scribe reads
   * its durable ledger so a pronoun-heavy beat files
   * a fact naming the person instead of a dangling referent. Scribe-only — the other legs
   * judge the exchange itself. Absent on an early chat ⇒ no block.
   */
  priorSummary?: string;
  /** What RAG retrieved for THIS turn (from the route's pre-turn recall), for the debug trace. */
  retrieved?: { facts: string[]; episodes: string[]; detail?: RetrievedMemoryDetail[] };
  /**
   * This turn's selfie arming: the player asked, and/or the
   * unprompted-offer gates held. The pulse's `sentPhoto` read only queues a render
   * when one of these armed it — a hallucinated "sending you a pic" on an unarmed
   * turn stays fiction.
   */
  selfie?: { requested: boolean; offerEligible: boolean };
  /**
   * The roster with live presence — arms the archivist's presence-transition
   * field. Absent/single ⇒ 1-on-1, unchanged.
   */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /**
   * Present ensemble members' memory scopes beyond the primary's — each
   * character's memory is their own, so the ONE extraction files to every
   * present witness's own group. Deduped against the primary's group here.
   */
  extraMemoryWrites?: readonly { groupId: string; characterId: string }[];
  /**
   * The chat-wide scenario, ALREADY ticked/movement-switched for this exchange:
   * finalize merges the archivist's scene proposal onto it, clears the one-shot
   * skip note, and persists it beside the state.
   */
  scenario: ChatScenario;
  /** The scenario as stored before this exchange — the rollback anchor's other half. */
  preExchangeScenario: ChatScenario | null;
  /**
   * The garment cue memory this exchange's prompt surfaced: repeat keys + the
   * bands they were reported in + last-changed stamps.
   * Persisted onto the store so it rides ONE rollback anchor with the garments it
   * describes — a retake restores mention history and wardrobe together or not at
   * all. Absent (the `CHAT_GARMENT_CUES` default) ⇒ the store's memory is untouched.
   */
  garmentCueState?: GarmentCueState;
  /**
   * The AFFORDANCE cue memory this exchange's prompt surfaced: repeat keys, the
   * band each was last
   * reported in, and the story time each band moved. Persisted onto the SCENARIO
   * beside `environment`, so it rides `pre_exchange_scenario` with the state the
   * read was taken from — a retake restores both or neither, which is what makes
   * the rebuilt read byte-identical. Absent (the `CHAT_AFFORDANCE_CUES` default)
   * ⇒ the stored memory rides through untouched, never cleared.
   */
  affordanceCueState?: AffordanceCueState;
  /**
   * The CAPTURED effective-coverage read this exchange derived, keyed by garment
   * actor handle (the owner ruling: "effective coverage is captured, not
   * reconstructed").
   *
   * Merged onto the garment store rather than stored beside it, so one JSONB
   * value — one rollback anchor — carries the garments AND the derived answer
   * about what they still conceal. Absent ⇒ the prior capture rides through.
   */
  affordanceCoverage?: Readonly<Record<string, EffectiveCoverageRead>>;
  /**
   * The contact-effect proposals this exchange's DURABLY committed contact
   * derived (`CHAT_CONTACT_EFFECTS`, default off).
   * The body-surface owner transaction validates and commits them into the
   * primary's surface state HERE — after the wetness fold, inside the same
   * guarded state write — so a committed mark rides one rollback anchor with
   * the surface it lives on, and a retake restores or removes it with the cut.
   * Absent (the default) ⇒ the surface fold's result persists untouched.
   */
  contactMarkProposals?: readonly BodyMarkProposal[];
  /**
   * This exchange's conserved surface transfer: the PROPOSALS, not a
   * settlement. The owner transaction runs inside finalize,
   * on the surface the surrounding folds just produced.
   *
   * That is deliberate and it is the whole reason this is a proposal input. A
   * caller cannot settle a transfer itself, because the surface it would settle
   * against does not exist outside this function: the wetness, deposit and
   * pressure-mark folds all run here, and a `source` computed before them would
   * either discard those folds when persisted or have to be merged back
   * afterwards — a merge with no correct answer, since both sides edit the same
   * deposit records. Computing the transfer here means the value that gets
   * debited is byte-for-byte the value that gets written.
   *
   * A COMMITTED transfer moves the settle's writes inside ONE database
   * transaction (`persistSurfaceTransferSettlement`), because the conservation
   * law spans two rows and cannot be proven across independent statements.
   * Absent — or present but committing nothing, which is every refusal and every
   * duplicate retry — ⇒ every write below runs exactly as it always has. That
   * is the whole of production today: transfer is fixture-only under the
   * conservation law's escape clause, so no live caller sets this and the hot
   * settle path is untouched (owner ruling 2026-08-26).
   */
  surfaceTransfer?: ChatSurfaceTransferInput;
  sink?: DiagnosticSink;
}): Promise<{
  /** True when this exchange landed a stage crossing or strong reaction (slice 9 "auto at big moments"). */
  bigMoment: boolean;
  /** True when the reply sent a selfie (pulse-read + gate-armed) — the route queues the render. */
  selfieSend: boolean;
  /** The archivist's confirmed presence transitions (ensemble only; [] otherwise). `where` = an away departure's destination phrase. */
  presenceChanges: readonly { name: string; presence: "present" | "away"; where?: string }[];
  /**
   * Did this exchange's folds actually rewrite the PRIMARY character's / the
   * PLAYER's worn list? Reported because only the writer knows: the store carries
   * the final clothes and nothing about when they changed, and the reply-scene
   * contact leg refuses to date a touch against a wardrobe that moved during the
   * same reply.
   *
   * The comparison is the PROJECTION's, not the proposal's — the same rule the
   * ensemble members' `memberWornChanges` uses — so the free-text outfit fold,
   * the typed garment operations, and the lazy materialization that first models
   * an actor all report alike. Materialization reporting a change is a
   * conservative false positive by design: it costs one reply's contact start on
   * the exchange that first models a wardrobe, and the alternative is a material
   * claim nobody can date.
   */
  wardrobeChanged: { character: boolean; player: boolean };
}> {
  // Character-fidelity slices 7-10: arm the archivist's voice reads (voiceExemplar /
  // characterSlip) with a compact voice reference, and its trait-shift proposals with the
  // character's DEVELOPABLE traits at their current (authored + evolved) band. Intimate
  // traits are fenced for a minor, mirroring the prompt-builder fence.
  const lifeStage = lifeStageForAge(input.profile.age);
  const minor = lifeStage?.minor ?? false;
  const evolvedTraits = resolveTraits(input.profile.traits, input.driftedState.traitOverlays);
  const developableTraits = evolvedTraits.flatMap((t) => {
    const def = traitRegistry.byId(t.id);
    if (!def || def.mutability !== "developable" || (minor && def.intimate)) return [];
    return [{ id: def.id, label: def.label, band: traitRegistry.bandFor(def.id, t.value)?.label ?? "" }];
  });
  const anchors = input.profile.voiceAnchors;
  const voiceReference =
    hasVoiceAnchors(anchors) || (lifeStage?.registerRules.length ?? 0) > 0
      ? {
          petPhrases: anchors.petPhrases,
          cadence: anchors.cadence,
          neverSays: anchors.neverSays,
          registerRule: lifeStageThirdPersonLine(lifeStage, input.characterName),
        }
      : undefined;

  // Plans coming due: the DETERMINISTIC transitions are knowable from
  // the already-ticked clock before the fan-out, so the pulse — which runs in PARALLEL with
  // the archivist — can see a just-missed commitment and propose the hurt (consequences stay
  // model-mediated, ruling C: no deterministic regard penalty). The real fold below re-runs
  // the advance AFTER the archivist's kept/canceled land (which may spare an overdue plan).
  const planLabelCtx = { nowMinutes: input.scenario.clockMinutes, calendarStart: input.scenario.calendarStart };
  const planPhrase = (p: ChatPlan): string => {
    const others = planOthersLabel(p, input.playerName);
    const when = describePlanWhen(p.when, planLabelCtx);
    return `"${p.what}"${others ? ` ${others}` : ""}${when ? ` (${when})` : ""}`;
  };
  // The grounded wardrobe lane: the exact
  // garment/part handles this exchange may address. Built from the store as it
  // stands BEFORE the fan-out, because that is what the extractor's prompt shows.
  // Empty (an unmodelled chat, a first exchange) ⇒ the field never arms and the
  // legacy free-text grammar stands — which is exactly the bridge.
  //
  // "Here" is the place the exchange STARTED in, not wherever the archivist's
  // scene proposal moved them: the enumeration and the `left_here` locus then mean
  // one and the same room, so a garment dropped this exchange is re-findable by
  // exactly the handles the model was just shown.
  const scenePlaceName = currentScenePlace(input.scenario.sceneMemory)?.name;
  const garmentHandles = buildGarmentHandleTable({
    store: input.scenario.garments,
    actors: [
      { actorId: garmentActorForCharacter(input.characterId), label: input.characterName },
      { actorId: GARMENT_PLAYER_ACTOR, label: input.playerName || "you", slug: "you" },
    ],
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
  });

  const preAdvance = advancePlans(input.scenario.plans, input.scenario.clockMinutes, input.playerName);
  const commitmentsDue =
    input.skipPulse || preAdvance.justMissed.length === 0
      ? undefined
      : { missed: preAdvance.justMissed.map(planPhrase), kept: [] as string[] };

  // The post-turn fan-out: the reaction pulse ‖ the three extraction legs (the memory
  // scribe, the continuity tracker, the character tracker), all in flight
  // together after the reply has already flushed.
  const [pulse, archivist] = await Promise.all([
    input.skipPulse
      ? Promise.resolve({ state: input.driftedState, degraded: false })
      : runChatPulse({
          state: input.driftedState,
          profile: input.profile,
          characterName: input.characterName,
          playerName: input.playerName,
          exchange: input.exchange,
          activeSocialCards: input.scenario.activeSocialCards,
          scope: input.pulseScope,
          commitmentsDue,
          trace: { chatId: input.chatId, messageId: input.assistantMessageId },
          sink: input.sink,
        }),
    runChatExtraction({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.driftedState.openLoops,
      drives: input.driftedState.drives,
      roster: input.roster,
      supportingCast: input.scenario.supportingCast.map((m) => ({ name: m.name, relation: m.relation })),
      // Open commitments the archivist can mark kept/canceled.
      openPlans: input.scenario.plans
        .filter((p) => p.status === "upcoming")
        .map((p) => ({ what: p.what, who: p.participants.join(", "), when: describePlanWhen(p.when, planLabelCtx) })),
      developableTraits,
      voiceReference,
      // The in-scope garment handles — present ⇒ the
      // continuity leg proposes typed operations instead of free-text garments.
      garmentHandles,
      // The recap's ledger grounds the scribe's facts in NAMES (a pronoun-heavy
      // beat used to file a dangling referent).
      priorSummary: input.priorSummary,
      // Failure telemetry only — never reaches a prompt (agent-failure.ts).
      trace: { chatId: input.chatId, messageId: input.assistantMessageId },
      sink: input.sink,
    }),
  ]);

  // Write the extracted long-term memory (episode + facts) under the chat scope. Off the
  // reply path; degrades internally (a failed leg / embedding just adds a diagnostic) —
  // and additionally fenced here, because a hard infra throw in the memory write must
  // not cost the pulse's state changes: `saveChatState` below always runs.
  try {
    await writeChatMemory({
      groupId: input.memoryGroupId,
      characterId: input.characterId,
      assistantMessageId: input.assistantMessageId,
      archivist: archivist.value,
      sink: input.sink,
    });
  } catch (error) {
    input.sink?.push(
      diag(
        "warn",
        "chat_state.memory.write_failed",
        `long-term memory write failed; state still persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  // Every present ensemble witness files the same extraction under their OWN
  // group (ruling 5) — separately fenced so one member's failed write never
  // costs another's, nor the state save below.
  const seenGroups = new Set([input.memoryGroupId]);
  for (const extra of input.extraMemoryWrites ?? []) {
    if (seenGroups.has(extra.groupId)) continue;
    seenGroups.add(extra.groupId);
    try {
      await writeChatMemory({
        groupId: extra.groupId,
        characterId: extra.characterId,
        assistantMessageId: input.assistantMessageId,
        archivist: archivist.value,
        sink: input.sink,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          "chat_state.memory.write_failed",
          `ensemble member memory write failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  // Record the meter bands the narrator saw THIS turn (from the drifted, pre-pulse meters)
  // as next turn's `prevBands`, so an unchanged state never re-fires a "just shifted" beat.
  // Carry the archivist's memory queries for the
  // next turn's RAG recall (drop them on a degraded archivist so stale queries don't linger),
  // and fold any proposed attribute change into the evolving narrative overlays.
  const surfacedCues = splitStateCues(input.driftedState.meters, input.driftedState.surfacedCues).nextBands;
  const attributeOverlays = archivist.value
    ? applyChatAttributeOverlays(input.driftedState.attributeOverlays, archivist.value.attributeChanges, input.sink)
    : input.driftedState.attributeOverlays;
  // Voice-exemplar ring: the archivist's picked in-voice line joins the ≤5 ring
  // (a "" pick / degraded archivist is a no-op via appendVoiceExemplar). Rolls back with the snapshot.
  const voiceExemplars = archivist.value
    ? appendVoiceExemplar(input.driftedState.voiceExemplars, archivist.value.voiceExemplar, input.scenario.clockMinutes)
    : input.driftedState.voiceExemplars;
  // Open loops are full-list-each-time — but a degraded leg emits an empty
  // list that must NOT wipe the standing loops; keep the prior list on degrade. Keyed on
  // the CHARACTER leg specifically: a failed scribe or continuity leg has
  // nothing to say about loops, and must not cost them.
  const openLoops =
    archivist.legs.character || !archivist.value ? input.driftedState.openLoops : archivist.value.openLoops;

  // Scene memory: reconcile the archivist's `scene` proposal onto the pre-turn memory (the
  // deterministic movement switch already applied to `scenario.sceneMemory` before the
  // prompt built). A degraded / empty proposal is a no-op, so the memory only ever accretes
  // what the fiction established — never re-establishing an unchanged setting.
  const sceneMemory = archivist.value
    ? mergeSceneMemory(input.scenario.sceneMemory, archivist.value.scene)
    : input.scenario.sceneMemory;

  // Supporting cast: same accrete-only shape as the
  // scene merge — a degraded/empty proposal is a no-op, and roster members + the
  // player can never be minted as cast entries (full characters stay full characters).
  const supportingCast = archivist.value
    ? mergeSupportingCast(input.scenario.supportingCast, archivist.value.cast, [
        input.playerName,
        input.characterName,
        ...(input.roster?.map((m) => m.name) ?? []),
      ])
    : input.scenario.supportingCast;

  // Plans: merge the archivist's struck/changed/canceled commitments
  // (new ids via `newId`), then advance deterministically as the ticked clock passes each
  // due-time — an overdue player plan the archivist did NOT resolve becomes `missed`, an
  // overdue NPC↔NPC plan is assumed kept (ruling E). A degraded archivist proposes nothing
  // but the plans still advance. Rolls back with the snapshot (ruling B).
  const planMerge = archivist.value
    ? mergeChatPlans(input.scenario.plans, archivist.value.plans, {
        nowMinutes: input.scenario.clockMinutes,
        mintId: newId,
        calendarStart: input.scenario.calendarStart,
      })
    : { plans: input.scenario.plans, archivistKept: [] as ChatPlan[] };
  const planAdvance = advancePlans(planMerge.plans, input.scenario.clockMinutes, input.playerName);
  const plans = planAdvance.plans;

  // Outfit change: the archivist proposes wardrobe changes two
  // ways, folded by `foldOutfitProposal`. A whole-outfit `description` naming an authored preset
  // ("her work clothes" → the "Work" preset) seeds the STRUCTURED worn list; an
  // unmatched description is a free-text full replacement. Garment-level `removed`/`added`
  // fold individual pieces against the loaded worn items + wardrobe pool. Empty
  // proposal / degraded archivist keeps the prior wardrobe; "another take" rolls it back via
  // the pre-exchange snapshot (wornItemIds/outfitPresetId ride `storedChatStateSchema`).
  //
  // Which of the two wardrobe-mutation paths runs is decided ONCE, for the whole
  // exchange: typed proposals win, and when they
  // are present the free-text folds are skipped entirely — so no actor is ever
  // mutated twice in one exchange.
  const lane = garmentMutationLane({
    garmentOperations: archivist.value?.garmentOperations ?? [],
    ...(archivist.value ? { outfit: archivist.value.outfit, playerOutfit: archivist.value.playerOutfit } : {}),
  });
  if (lane === "legacy") {
    input.sink?.push(
      diag(
        "info",
        "chat_garments.legacy_outfit_bridge",
        "no garment operations this exchange — folding the archivist's free-text outfit grammar through the legacy bridge",
      ),
    );
  }
  const outfitProposal = lane === "legacy" ? archivist.value?.outfit : undefined;
  const outfitChanged = Boolean(
    outfitProposal && (outfitProposal.description || outfitProposal.removed.length || outfitProposal.added.length),
  );
  // Either half of the exchange can state a whole-look change ("I peel off my
  // shirt" / "she tugs you out of your shirt" are the same event to the
  // archivist), so both are offered as evidence — but which half a quote came from
  // decides who "I"/"you" refers to, so they stay separate rather than joined.
  //
  // The scene shape decides the other half of the scoping: with a second body on
  // stage a bare pronoun cannot pick an owner, and the gate fails closed. The
  // roster carries the primary as its first entry (and is absent for 1-on-1), so
  // present OTHERS are what it contributes and the primary counts itself.
  const presentOthers = (input.roster ?? []).filter(
    (m) => m.presence === "present" && m.name.trim().toLowerCase() !== input.characterName.trim().toLowerCase(),
  );
  const presentOtherNames = presentOthers.map((m) => m.name);
  const presentCharacterCount = 1 + presentOthers.length;
  const outfitPatch = await foldOutfitProposal({
    profile: input.profile,
    ownerId: input.ownerId,
    state: input.driftedState,
    proposal: outfitProposal,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.characterName, ...input.profile.aliases],
      isPlayer: false,
      otherNames: [...presentOtherNames, input.playerName],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // The PLAYER's clothing — the same fold against the
  // persona's wardrobe. Chat-wide, so it lands on the scenario (and therefore on the
  // "another take" rollback snapshot) rather than the per-character state row. No
  // persona ⇒ no body to dress ⇒ a no-op.
  const playerOutfitPatch = await foldPlayerOutfitProposal({
    persona: input.playerPersona,
    ownerId: input.ownerId,
    playerState: input.scenario.playerState,
    proposal: lane === "legacy" ? archivist.value?.playerOutfit : undefined,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.playerName],
      isPlayer: true,
      otherNames: [input.characterName, ...input.profile.aliases, ...presentOtherNames],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // --- The garment store -----------------------------------------------------
  // The chat-wide store is the wardrobe TRUTH; the worn-id lists become its
  // projection. Both folds above still produce id lists — they are compiled here
  // into instance transfers (kept / re-donned with their condition / minted /
  // doffed to the wardrobe), never a free-text replacement of the wardrobe.
  //
  // Migration is lazy and happens on THIS write, never on a read: an
  // unseeded store first materializes from the PRE-fold worn sets, so a garment
  // this exchange took off exists at a locus rather than never having existed.
  const playerStateAfterFold: ChatPlayerState = { ...input.scenario.playerState, ...playerOutfitPatch };
  const garmentSync = await syncGarmentsForExchange({
    scenario: input.scenario,
    ownerId: input.ownerId,
    characterId: input.characterId,
    persona: input.playerPersona,
    preWornItemIds: input.driftedState.wornItemIds,
    postWornItemIds: outfitPatch.wornItemIds ?? input.driftedState.wornItemIds,
    playerStateAfterFold,
    sink: input.sink,
  });

  // --- Grounded garment operations (slice 5) ---------------------------------
  // The reconcile above lands first (so a garment this exchange's worn lists
  // added exists to be addressed), then the extractor's typed proposals apply in
  // FICTION ORDER on top, then the id projections are re-derived once. One store,
  // persisted once by the scenario save below — and discarded whole by a retake,
  // because it rides `pre_exchange_scenario` like every other scenario field.
  const proposals = lane === "operations" ? (archivist.value?.garmentOperations ?? []) : [];
  const garmentFold = applyGarmentProposals(proposals, {
    store: garmentSync.store,
    table: garmentHandles,
    atMinutes: input.scenario.clockMinutes,
    mintId: newId,
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
    sink: input.sink,
  });
  // Mention history rides the store (slice 6): the cue memory the PROMPT produced,
  // written onto the POST-fold store so one JSONB value carries the wardrobe and
  // what has already been said about it. Flag off ⇒ the prior memory passes through.
  // The CAPTURED effective-coverage read rides the same value for the same
  // reason: it is derived from these garments,
  // at this cut, and restoring it one exchange out of step with them would give
  // narration, images, and a retake three different answers about what is still
  // concealed. Absent (the `CHAT_AFFORDANCE_CUES` default, or an unmodelled
  // wardrobe) ⇒ the prior capture passes through, never cleared.
  const garmentStore =
    input.garmentCueState || input.affordanceCoverage
      ? {
          ...garmentFold.store,
          ...(input.garmentCueState ? { cues: input.garmentCueState } : {}),
          ...(input.affordanceCoverage
            ? { coverage: { ...garmentFold.store.coverage, ...input.affordanceCoverage } }
            : {}),
        }
      : garmentFold.store;
  const wornItemIds =
    garmentFold.applied > 0
      ? garmentProjectionOr(garmentStore, garmentActorForCharacter(input.characterId), garmentSync.wornItemIds)
      : garmentSync.wornItemIds;
  const playerState: ChatPlayerState =
    garmentFold.applied > 0
      ? {
          ...garmentSync.playerState,
          wornItemIds: garmentProjectionOr(
            garmentStore,
            GARMENT_PLAYER_ACTOR,
            garmentSync.playerState.wornItemIds,
          ),
        }
      : garmentSync.playerState;
  const garmentTrace: GarmentOperationTraceEntry[] = garmentFold.trace;

  // --- Scene environment + body surface ---
  // The same shape as the garment fold above: a pure apply over typed proposals,
  // a trace, and diagnostics — never a re-read of the narrator's prose.
  //
  // The ENVIRONMENT is chat-wide and lands on the scenario (one sky for the
  // roster, and it rolls back with `pre_exchange_scenario`); the SURFACE is
  // per-character and lands on the state row. Both folds run on a degraded
  // archivist too, as no-ops: an absent proposal leaves the standing weather
  // standing, and the surface fold still prunes anything that has dried to
  // nothing — which cannot change what any read returns.
  //
  // PRIMARY CHARACTER ONLY this release (owner ruling). The player's surface
  // would ride `ChatScenario` (one player, many characters, like `playerState`);
  // an ensemble member's would ride their own row through the per-member personal
  // pass — neither is wired, and the extraction field says so in as many words.
  const environmentFold = applyEnvironmentProposal({
    environment: input.scenario.environment,
    ...(archivist.value ? { proposal: archivist.value.environment } : {}),
    atMinutes: input.scenario.clockMinutes,
  });
  // The environment patch lands FIRST and the surface fold integrates against
  // the result, so an exchange that opens a downpour holds this exchange's
  // wetness rather than drying it under the sky it was standing in a moment ago.
  const surfaceFold = applySurfaceWetnessProposals({
    surface: input.driftedState.bodySurface,
    proposals: parseSurfaceWetnessProposals(
      archivist.value?.surfaceWetness ?? [],
      input.sink,
      "chat_archivist.surfaceWetness",
    ),
    atMinutes: input.scenario.clockMinutes,
    environment: environmentFold.environment,
    sink: input.sink,
  });
  // Deposits fold next, onto the wetness fold's result — the same owner, one
  // more module, and no flag: material on skin is ordinary authoritative body
  // state exactly as wetness is, and gating it behind the contact-effects
  // switch would make "she still has mud on her hands" unrememberable for the
  // continuity system that has nothing to do with contact.
  //
  // No environment argument, and no prune pass: a deposit does not leave a
  // surface on its own, so there is nothing for the clock to integrate and an
  // empty proposal list returns the wetness fold's surface by reference.
  const depositFold = applySurfaceDepositProposals({
    surface: surfaceFold.surface,
    proposals: parseSurfaceDepositProposals(
      archivist.value?.surfaceDeposits ?? [],
      input.sink,
      "chat_archivist.surfaceDeposits",
    ),
    atMinutes: input.scenario.clockMinutes,
    sink: input.sink,
  });
  // --- Contact-effect owner transaction (`CHAT_CONTACT_EFFECTS`, default off) ---
  // The pressure-mark commit: the body-surface owner
  // validates each proposal against its own vocabulary and commits at most one
  // mark per idempotency identity. Runs AFTER the wetness fold so both modules
  // land in one state value under one rollback anchor, and only when the
  // pipeline actually derived proposals — the absent case leaves the fold's
  // result untouched, byte-identical to a build without the flag.
  const effectFold =
    input.contactMarkProposals !== undefined && input.contactMarkProposals.length > 0
      ? applyBodyMarkProposals({
          surface: depositFold.surface,
          proposals: input.contactMarkProposals,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : { surface: depositFold.surface, trace: [] };
  // --- Conserved surface transfer ---
  // The second effect proof, and the one that spans owners: material leaves one
  // body's surface and lands on another body, or on a garment layer in between.
  //
  // It runs HERE, last in the fold chain and inside this function, because the
  // conservation law is a statement about exact quantities: the debit has to come
  // off the same surface value that gets persisted. `effectFold.surface` is that
  // value — it already carries this exchange's drying, deposits and pressure
  // marks — so settling against anything else (a copy loaded before the turn, say)
  // would either silently un-apply those folds on write or need a merge that has
  // no correct answer, both sides having edited the same deposit records.
  //
  // The layer side is `garmentStore` for the same reason: it is the post-fold,
  // about-to-be-persisted wardrobe, so an intermediate garment is credited on the
  // value the scenario write actually stores.
  const transferFold =
    input.surfaceTransfer !== undefined
      ? applySurfaceTransferProposals({
          proposals: input.surfaceTransfer.proposals,
          owners: {
            source: effectFold.surface,
            // Same character on both ends ⇒ ONE surface, and it must be the
            // folded one. The pure transaction warns it never assumes the pair
            // differs: handing it the caller's separately-loaded copy here would
            // fold the debit and the credit onto two stale objects and lose
            // whichever landed second.
            destination:
              input.surfaceTransfer.destination.characterId === input.characterId
                ? effectFold.surface
                : input.surfaceTransfer.destination.state.bodySurface,
            layers: garmentStore,
          },
          resolveLayer: input.surfaceTransfer.resolveLayer,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : undefined;
  // Nothing committed ⇒ nothing crossed an owner boundary, so there is no
  // cross-row invariant to protect and the ordinary write path is the correct
  // one. This covers every refusal AND the designed duplicate retry, which is
  // exactly the case that must NOT look like a second transfer.
  const transferSettled =
    input.surfaceTransfer !== undefined && transferFold !== undefined && transferFold.committed > 0
      ? {
          bodySurface: transferFold.owners.source,
          garments: transferFold.owners.layers,
          // Absent when the material never left this character's own body: one
          // row, already written above as `bodySurface`.
          destination:
            input.surfaceTransfer.destination.characterId === input.characterId
              ? undefined
              : {
                  characterId: input.surfaceTransfer.destination.characterId,
                  state: {
                    ...input.surfaceTransfer.destination.state,
                    bodySurface: transferFold.owners.destination,
                  },
                  preExchangeState: input.surfaceTransfer.destination.preExchangeState,
                },
        }
      : undefined;
  const surfaceTrace: ChatSurfaceTraceEntry[] = [
    ...environmentFold.trace,
    ...surfaceFold.trace,
    ...depositFold.trace,
    ...effectFold.trace,
    // Refusals included: a transfer that was rejected is a thing the inspector
    // needs to see, and it contributes no entries at all when nobody proposed one.
    ...(transferFold?.trace ?? []),
  ];
  if (surfaceTrace.length > 0) {
    input.sink?.push(
      diag(
        "info",
        "chat_surface.applied",
        surfaceTrace.map((entry) => `${entry.kind}:${entry.target} ${entry.outcome}`).join(", "),
      ),
    );
  }

  // The familiarity ratchet (owner ruling: moments + time). One trickle tick per
  // exchange (bounded by the acquainted ceiling), plus a moment tick when the
  // archivist recorded durable facts — a real disclosure or shared experience.
  // Both draw from the per-scene budget (`familiaritySceneGain`).
  const preFamiliarity = input.preExchangeState?.familiarity ?? input.driftedState.familiarity;
  let familiarity = pulse.state.familiarity;
  let familiaritySceneGain = pulse.state.familiaritySceneGain;
  const applyTick = (kind: "trickle" | "moment") => {
    const ticked = tickFamiliarity(familiarity, kind, familiaritySceneGain);
    familiaritySceneGain += ticked - familiarity;
    familiarity = ticked;
  };
  applyTick("trickle");
  if ((archivist.value?.facts.length ?? 0) > 0) applyTick("moment");

  // Relationship arc: sample when the exchange moved regard or crossed a
  // band (or it's the first exchange — the sparkline's baseline), and derive the
  // exchange's milestones. When the pulse was skipped (a "go on" beat) or degraded,
  // `lastPulseTrace` is stale/empty — treat the move as zero rather than re-reading it.
  const at = input.now.toISOString();
  // "First exchange" for the arc baseline + first_exchange milestone:
  // no relationship sample has been recorded yet. Robust to a state row that
  // pre-exists the first send — a premise Save, an opening beat, a pickup skip all
  // create the row, so keying on `preExchangeState === null` would miss them and
  // silently skip the baseline sample + milestone.
  const firstExchange = input.driftedState.relationshipHistory.length === 0;
  const preRegard = input.preExchangeState?.regard ?? input.driftedState.regard;
  const postRegard = pulse.state.regard;
  const pulseTrace = input.skipPulse || pulse.state.lastPulseTrace.degraded ? null : pulse.state.lastPulseTrace;
  const moved = postRegard !== preRegard || familiarity !== preFamiliarity;
  const relationshipHistory =
    moved || firstExchange
      ? appendRelationshipSample(input.driftedState.relationshipHistory, {
          at,
          clockMinutes: input.scenario.clockMinutes,
          regard: postRegard,
          band: regardBandForValue(postRegard).id,
          familiarity,
        })
      : input.driftedState.relationshipHistory;
  const exchangeMilestones = deriveExchangeMilestones({
    at,
    messageId: input.assistantMessageId,
    characterName: input.characterName,
    firstExchange,
    preRegard,
    postRegard,
    preFamiliarity,
    postFamiliarity: familiarity,
    regardDelta: pulseTrace?.regardDelta ?? 0,
    concept: pulseTrace?.concept ?? null,
  });
  // Drive movement: fold the archivist's driveUpdates
  // into the runtime set; a degraded archivist keeps the prior drives (the loops
  // rule). Newly-revealed secrets land as `secret_shared` milestones — the spoken
  // reveal itself files as an ordinary extracted fact (ruled: no special wiring).
  const driveResult = archivist.value
    ? applyDriveUpdates(input.driftedState.drives, archivist.value.driveUpdates)
    : { drives: input.driftedState.drives, revealed: [] };
  for (const revealedDrive of driveResult.revealed) {
    exchangeMilestones.push({
      at,
      kind: "secret_shared",
      label: `${input.characterName} shared a secret — ${revealedDrive.want}`,
      messageId: input.assistantMessageId,
    });
  }
  // Plan resolutions land milestones: a kept/missed plan
  // INVOLVING THE PLAYER mints `plan_kept`/`plan_missed` — callback-boosted like
  // `secret_shared`, so "remember our first real date" emerges from the callback system.
  // NPC↔NPC keeps (assume-kept) carry no player milestone (they reach the story as facts).
  for (const kept of planMerge.archivistKept) {
    if (!planInvolvesPlayer(kept, input.playerName)) continue;
    exchangeMilestones.push({ at, kind: "plan_kept", label: `Kept a plan — ${kept.what}`, messageId: input.assistantMessageId });
  }
  for (const missed of planAdvance.justMissed) {
    exchangeMilestones.push({ at, kind: "plan_missed", label: `Missed a plan — ${missed.what}`, messageId: input.assistantMessageId });
  }
  const milestones = appendMilestones(input.driftedState.milestones, exchangeMilestones);
  // Bounded personality evolution (slice 10): apply the archivist's developable-trait
  // nudges ONLY when a relationship milestone landed this exchange (first_exchange is
  // not an arc beat), clamped one band from the authored value. Off-milestone turns and a
  // degraded archivist leave the overlays untouched.
  const milestoneLanded = exchangeMilestones.some((m) => m.kind !== "first_exchange");
  const traitOverlays =
    archivist.value && milestoneLanded
      ? applyChatTraitOverlays(input.profile.traits, input.driftedState.traitOverlays, archivist.value.traitShifts, { minor }, input.sink)
      : input.driftedState.traitOverlays;
  // Selfie send: the pulse read the reply as actually sending
  // a photo AND a deterministic gate armed it. Recording the send here (the cooldown
  // ring) rides the same guarded state write; "another take" rolls it back.
  const selfieKind =
    pulseTrace?.sentPhoto && input.selfie
      ? input.selfie.requested
        ? ("request" as const)
        : input.selfie.offerEligible
          ? ("offer" as const)
          : null
      : null;
  const selfieHistory = selfieKind
    ? appendSelfieEntry(input.driftedState.selfieHistory, { kind: selfieKind, atClockMinutes: input.scenario.clockMinutes })
    : input.driftedState.selfieHistory;
  // "Big moment" (slice 9 auto scenes): a stage crossing or a strong card-driven
  // reaction — not the routine first exchange, which has barely a scene to render.
  const bigMoment = exchangeMilestones.some((m) => m.kind === "stage_up" || m.kind === "stage_down" || m.kind === "strong_reaction");
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
    drives: driveResult.drives,
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
  // The rollback anchors ride targeted follow-up UPDATEs (never the shared upsert
  // column list — an author edit must not clobber them): repeated "another take"s
  // keep rolling back to the same pre-exchange point. Guarded on the same prompting
  // message as saveChatState, so a mid-stream delete leaves neither half written.
  //
  // Two persistence shapes, one ruling (2026-08-26). A settle that COMMITTED a
  // transfer moves all of this into ONE transaction, because conservation demands
  // the debit and the credit commit together and they live in two different rows. Every
  // other exchange — which is all of them today, transfer being fixture-only —
  // keeps the four independent writes exactly as they were: this is the hot path,
  // and there is no cross-row invariant to protect when nothing moved between rows.
  if (transferSettled !== undefined) {
    await persistSurfaceTransferSettlement({
      chatId: input.chatId,
      characterId: input.characterId,
      promptMessageId: input.promptMessageId,
      state: settledState,
      scenario: settledScenario,
      preExchangeState: input.preExchangeState,
      preExchangeScenario: input.preExchangeScenario,
      ...(transferSettled.destination === undefined ? {} : { destination: transferSettled.destination }),
    });
  } else {
    await saveChatState({
      chatId: input.chatId,
      characterId: input.characterId,
      promptMessageId: input.promptMessageId,
      state: settledState,
    });
    await saveChatScenario(input.chatId, settledScenario, input.promptMessageId);
    await savePreExchangeSnapshot(input.chatId, input.characterId, input.preExchangeState, input.promptMessageId);
    await savePreExchangeScenario(input.chatId, input.preExchangeScenario, input.promptMessageId);
  }

  // Location sketch: a current place without a
  // sketch gets one from the detached background agent. Enqueued AFTER the state write so
  // the job reads the just-merged memory; fire-and-forget (a lost write re-fires here
  // while the sketch stays absent).
  const sketchPlace = currentScenePlace(sceneMemory);
  if (sketchPlace && !sketchPlace.sketch) {
    void enqueueChatSceneSketch({
      chatId: input.chatId,
      characterId: input.characterId,
      characterName: input.characterName,
      placeName: sketchPlace.name,
    });
  }
  // Current-look refresh: the fiction re-dressed
  // the character or landed a lasting appearance change — mint a fresh look anchor.
  // The job itself gates on image-active chats + key match (ruled), so this enqueue
  // is cheap and idempotent; fire-and-forget after the state write it reads.
  //
  // The garment term is OQ8's pre/post KEY COMPARISON (audit Part 2), not a
  // proposal count: the trigger used to be proposal-shaped, so anything that moved
  // the wardrobe without an archivist outfit proposal left the anchor silently
  // stale — and adding bands to `chatLookKey` alone could never fix that, because
  // the enqueue and the key are independent gates. Both are wired now, off the same
  // fingerprint (worn instance set + structural bands + wetness from `wet` up +
  // deposit/damage presence). A damp→dry drift moves neither.
  // Per-actor rather than one combined call, because the wardrobe-chronology
  // veto below needs to know WHOSE look moved — the image refresh only needs
  // "anyone's".
  const characterLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [garmentActorForCharacter(input.characterId)],
    atMinutes: input.scenario.clockMinutes,
  });
  const playerLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [GARMENT_PLAYER_ACTOR],
    atMinutes: input.scenario.clockMinutes,
  });
  const lookChanged = characterLookChanged || playerLookChanged;
  if (outfitChanged || lookChanged || (archivist.value?.attributeChanges.length ?? 0) > 0) {
    void enqueueChatLookImage({ chatId: input.chatId, characterId: input.characterId });
  }
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

/**
 * Fold one ensemble member's exchange results into their state (followups rulings
 * 10-11). PURE. Two halves:
 *
 * - **Deterministic folds for everyone who PULSED** (ruling 11): a relationship-history
 *   sample when regard moved (or their arc baseline), and the derived exchange
 *   milestones — emotional weather already landed inside the member's pulse.
 * - **The personal pass for every present member** (ruling 10): the four per-character
 *   fields (open loops, outfit, attribute overlays, drive movement) folded exactly the
 *   way `finalizeChatState` folds the shared archivist's for the primary; a revealed
 *   secret drive mints its `secret_shared` milestone. `null` (absent/degraded) keeps
 *   the prior fields.
 *
 * The primary never comes through here — `finalizeChatState` owns its richer fold.
 */
export function settleEnsembleMember(args: {
  /** The member's state AFTER their referenced-only pulse (untouched when not pulsed). */
  state: ChatState;
  /** Regard before the pulse — the sample/milestone trigger. */
  preRegard: number;
  /** Whether the referenced-only pulse ran for this member this exchange. */
  pulsed: boolean;
  /** The personal pass result; null keeps the member's prior personal fields. */
  personal: ChatPersonalNotes | null;
  /** This exchange's two halves — what the proposal's `changeEvidence` is checked against, per half. */
  exchange: OutfitEvidenceExchange;
  /**
   * THIS member as evidence owner. An ensemble is exactly the scene where a quote
   * of somebody else's genuine change would otherwise license this member's
   * whole-look replacement, so the count here is >1 and bare pronouns fail closed.
   */
  evidenceOwner: OutfitEvidenceOwner;
  /** The member's authored presets — what a whole-look `description` can name to re-seed the worn list. */
  profile: Pick<CharacterProfile, "outfits">;
  characterName: string;
  assistantMessageId: string;
  now: Date;
  /** The shared story clock (already ticked for this exchange). */
  clockMinutes: number;
  /**
   * True when a player selfie request addressed THIS member (ruling 12): if their
   * pulse read the reply as actually sending one, the send burns THEIR cooldown ring.
   */
  selfieRequestTarget?: boolean;
  sink?: DiagnosticSink;
}): ChatState {
  let next = args.state;
  const at = args.now.toISOString();
  const exchangeMilestones: Milestone[] = [];

  if (args.pulsed) {
    // Same triggers as the primary's fold: their arc baseline on the first-ever
    // sample, then a sample whenever the pulse moved regard (members' familiarity
    // holds — the ratchet's fact ticks stay primary-scoped).
    const firstExchange = next.relationshipHistory.length === 0;
    const moved = next.regard !== args.preRegard;
    if (moved || firstExchange) {
      next = {
        ...next,
        relationshipHistory: appendRelationshipSample(next.relationshipHistory, {
          at,
          clockMinutes: args.clockMinutes,
          regard: next.regard,
          band: regardBandForValue(next.regard).id,
          familiarity: next.familiarity,
        }),
      };
    }
    const trace = next.lastPulseTrace.degraded ? null : next.lastPulseTrace;
    exchangeMilestones.push(
      ...deriveExchangeMilestones({
        at,
        messageId: args.assistantMessageId,
        characterName: args.characterName,
        firstExchange,
        preRegard: args.preRegard,
        postRegard: next.regard,
        preFamiliarity: next.familiarity,
        postFamiliarity: next.familiarity,
        regardDelta: trace?.regardDelta ?? 0,
        concept: trace?.concept ?? null,
      }),
    );
  }

  if (args.personal) {
    // The description branch runs `foldOutfitProposal`'s rungs in order: an authored preset
    // named in the text re-seeds the structured worn list (rung 1), and only an ad-hoc look
    // falls back to free text. What stays ensemble-specific is the reach of that fallback —
    // this fold is PURE, with no item-loading seam, so garment-level removed/added remain the
    // primary's (IO-backed) path and the restatement diagnostic names no unworn garment.
    //
    // Gated exactly like `foldOutfitProposal`/`foldPlayerOutfitProposal` (owner ruling,
    // 2026-08-01): over a MODELLED worn list, a description carrying no exposure claim, no
    // garment delta and no verbatim clause from this exchange saying THIS member's clothes
    // moved is a restatement of the standing look — demoting the structured list to prose on
    // one is how a dressed member silently becomes unmodellable, and taking somebody else's
    // change clause as the licence is how one member's coat wipes another's whole outfit
    // (which is why the evidence is owner-scoped). A matched preset never reaches the gate
    // (an authored look is authoritative); deltas only SKIP it here, they remain the primary's
    // path.
    const proposal = args.personal.outfit;
    const matched = proposal.description ? matchOutfitPresetInText(args.profile, proposal.description) : undefined;
    const preset = matched && matched.items.length > 0 ? matched : undefined;
    const restatesWornList =
      !preset &&
      next.wornItemIds.length > 0 &&
      !proposal.exposed &&
      proposal.removed.length === 0 &&
      proposal.added.length === 0 &&
      !outfitChangeEvidenceValidated(proposal.changeEvidence, args.exchange, args.evidenceOwner);
    if (proposal.description && restatesWornList) {
      args.sink?.push(
        diag(
          "info",
          "chat_wardrobe.ensemble_outfit_restatement",
          "ensemble outfit description restates the structured worn list; keeping the modelled wardrobe",
        ),
      );
    }
    // The preset's items are COPIED, not aliased: this becomes the member's mutable worn
    // list, and the array belongs to the library profile.
    const outfitPatch: Partial<ChatState> = preset
      ? { wornItemIds: [...preset.items], outfitPresetId: preset.id, outfit: "", outfitExposed: false }
      : proposal.description && !restatesWornList
        ? { wornItemIds: [], outfitPresetId: "", outfit: proposal.description, outfitExposed: proposal.exposed }
        : {};
    const driveResult = applyDriveUpdates(next.drives, args.personal.driveUpdates);
    for (const revealedDrive of driveResult.revealed) {
      exchangeMilestones.push({
        at,
        kind: "secret_shared",
        label: `${args.characterName} shared a secret — ${revealedDrive.want}`,
        messageId: args.assistantMessageId,
      });
    }
    next = {
      ...next,
      // Full-list-each-time; a degraded pass never reaches here, so
      // an emitted [] is a real "everything resolved".
      openLoops: args.personal.openLoops,
      attributeOverlays: applyChatAttributeOverlays(next.attributeOverlays, args.personal.attributeChanges, args.sink),
      drives: driveResult.drives,
      ...outfitPatch,
    };
  }

  // The addressed member sent the requested photo (ruling 12): burn THEIR ring —
  // same guard as the primary's fold (a degraded pulse never reads a send).
  if (args.selfieRequestTarget && !next.lastPulseTrace.degraded && next.lastPulseTrace.sentPhoto) {
    next = {
      ...next,
      selfieHistory: appendSelfieEntry(next.selfieHistory, { kind: "request", atClockMinutes: args.clockMinutes }),
    };
  }

  return exchangeMilestones.length ? { ...next, milestones: appendMilestones(next.milestones, exchangeMilestones) } : next;
}