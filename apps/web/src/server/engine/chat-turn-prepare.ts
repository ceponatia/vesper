import {
  currentScenePlace,
  derivePlanSalience,
  garmentActorForCharacter,
  hasSalientPlan,
  unseenMilestoneReason,
  type DiagnosticSink,
} from "@/contracts";
import { log } from "../log";
import { QueryEmbeddings } from "../memory";
import { buildActionBeatCue } from "./chat-action-beat";
import { renderChatAffordanceCues } from "./chat-affordance-cues";
import { buildChatAffordanceRead } from "./chat-affordances";
import { buildChatRecognitionRead, type ChatRecognitionRead } from "./chat-recognition-adapter";
import { loadChatVisualMemory } from "./visual-memory-store";
import { appendCallbackEntry, chatCallbackEligible } from "./chat-callback";
import { chatSelfieOfferEligible, chatSelfieOpenerEligible, detectSelfieRequest, hasCommsSpans } from "./chat-selfie";
import { detectChatCue, detectSensoryFocus, mentionsCharacter, replyEndsInQuestion } from "./chat-intent";
import { retrieveChatCallback, retrieveChatMemory } from "./chat-memory";
import { applyChatAction } from "./chat-state";
import type { ChatScenario, ChatState } from "./chat-state/types";
import { loadMilestonesSeenAt } from "./chat-state/store";
import { resolveChatWardrobe, resolvePlayerWardrobe, type ResolvedChatWardrobe } from "./chat-wardrobe";
import { buildChatGarmentNarration, chatGarmentNarrationActors } from "./chat-garments";
import { loadVerbatimWindow } from "./chat-summary";
import { ENSEMBLE_QUIET_EXCHANGES } from "./prompts/character-chat";
import {
  chatAffordanceCuesEnabled,
  chatGarmentCuesEnabled,
  chatPhysicalConstraintsEnabled,
  chatRecognitionCuesEnabled,
} from "./prompts/constants";
import type { CharacterProfile } from "@/contracts";
import type { PlayerPersona } from "../players";
import type { ChatTurnMember, SubmitChatMessageInput, ChatExchangeKind } from "./chat-turn-types";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const INTIMATE_AROUSAL_FLOOR = 0.55;

export async function prepareChatTurnRecall(args: {
  memoryGroupId: string;
  playerContent: string;
  driftedState: ChatState;
  others: ChatTurnMember[];
  ensembleActive: boolean;
  history: Awaited<ReturnType<typeof loadVerbatimWindow>>;
  narratorInput: boolean;
  characterId: string;
  characterName: string;
  profile: CharacterProfile;
  opening: boolean;
  sink: DiagnosticSink;
}) {
  const {
    memoryGroupId,
    playerContent,
    driftedState,
    others,
    ensembleActive,
    history,
    narratorInput,
    characterId,
    characterName,
    profile,
    opening,
    sink,
  } = args;

  // --- RAG recall: per-participant memory groups ---------------------------
  // 1-on-1 keeps the default k. An ensemble runs tier-1 legs only:
  // the primary always gets a leg; other members earn one while present and
  // recently active, each against their OWN group, with per-leg k tightened as
  // the active count grows — cost tracks the scene, not the roster.
  const activeOthers = others.filter(
    (o) => o.state.presence === "present" && o.state.quietExchanges < ENSEMBLE_QUIET_EXCHANGES,
  );
  const legLimit = ensembleActive ? Math.max(2, 5 - activeOthers.length) : undefined;
  // ONE embed for the whole turn: every retrieval leg
  // below searches over the same texts — the player's input plus each participant's
  // persisted `memoryQueries` — and each leg used to embed its own copy (the fact leg,
  // the episode leg, every member's pair of legs, and the callback picker's third read of
  // the input). This is the only agent-adjacent cost on the PRE-reply path, so it is the
  // one worth de-duplicating. A failed embed degrades each leg exactly as its own failure
  // would (facts → pinned-only, episodes → [], callback → null).
  const queryEmbeddings = await QueryEmbeddings.embed(
    [playerContent, ...driftedState.memoryQueries, ...activeOthers.flatMap((o) => o.state.memoryQueries)],
    sink,
  );
  const memory = await retrieveChatMemory({
    groupId: memoryGroupId,
    queries: driftedState.memoryQueries,
    input: playerContent,
    ...(legLimit !== undefined ? { limit: legLimit } : {}),
    embeddings: queryEmbeddings,
    sink,
  });
  const otherMemories = new Map(
    await Promise.all(
      activeOthers.map(
        async (o) =>
          [
            o.characterId,
            await retrieveChatMemory({
              groupId: o.memoryGroupId,
              queries: o.state.memoryQueries,
              input: playerContent,
              limit: legLimit ?? 3,
              embeddings: queryEmbeddings,
              sink,
            }),
          ] as const,
      ),
    ),
  );

  // Regex-first reads of the player's input, computed once and shared: the cue arm, the
  // sense-targeted focus, and the reply-discipline gates (over the window's last replies).
  const cueHint = playerContent ? detectChatCue(playerContent, { narratorInput }) : null;
  const intimateBeat = (cueHint?.intimate ?? false) || (driftedState.meters.arousal ?? 0) >= INTIMATE_AROUSAL_FLOOR;
  const recentReplies = history.filter((m) => m.role === "assistant").map((m) => m.content);

  // One-turn sense-targeted focus (scope guard): a smell/taste/touch/study beat aimed at
  // a body region / garment ⇒ assemble that RESOLVED member's authored values into a
  // focus block. Present-roster context makes group pronouns fail closed and prevents
  // a named action on one member from being rendered with another member's body data.
  const sensoryFocusCharacters = [
    ...(driftedState.presence === "present"
      ? [{ id: characterId, name: characterName, aliases: profile.aliases }]
      : []),
    ...others
      .filter((member) => member.state.presence === "present")
      .map((member) => ({ id: member.characterId, name: member.name, aliases: member.profile.aliases })),
  ];
  const sensoryFocus = playerContent
    ? (detectSensoryFocus(playerContent, { characters: sensoryFocusCharacters, narratorInput }) ?? undefined)
    : undefined;
  const sensoryFocusMember = sensoryFocus?.targetCharacterId
    ? sensoryFocusCharacters.find((member) => member.id === sensoryFocus.targetCharacterId)
    : undefined;
  const primarySensoryFocus =
    sensoryFocus &&
    (sensoryFocus.targetCharacterId === undefined || sensoryFocus.targetCharacterId === characterId)
      ? sensoryFocus
      : undefined;
  const firstExchange = !opening && !recentReplies.length;
  return { queryEmbeddings, memory, otherMemories, cueHint, intimateBeat, recentReplies, sensoryFocus, sensoryFocusMember, primarySensoryFocus, firstExchange };
}

export async function prepareChatTurnBeats(args: {
  chatId: string;
  characterName: string;
  sink: DiagnosticSink;
  memoryGroupId: string;
  input: Pick<SubmitChatMessageInput, "initiative">;
  playerContent: string;
  syntheticCue: string | null;
  effectiveKind: ChatExchangeKind;
  attachmentDescriptions: string[] | null;
  narratorInput: boolean;
  actionBeatId: SubmitChatMessageInput["action"] | null;
  profile: CharacterProfile;
  driftedState: ChatState;
  sceneChanged: boolean;
  scenario: ChatScenario;
  player: PlayerPersona;
  ensembleActive: boolean;
  others: ChatTurnMember[];
  queryEmbeddings: Awaited<ReturnType<typeof QueryEmbeddings.embed>>;
  intimateBeat: boolean;
  recentReplies: string[];
  sensoryFocus: Exclude<ReturnType<typeof detectSensoryFocus>, null> | undefined;
  firstExchange: boolean;
}) {
  const {
    chatId,
    characterName,
    sink,
    memoryGroupId,
    input,
    playerContent,
    effectiveKind,
    attachmentDescriptions,
    narratorInput,
    actionBeatId,
    profile,
    sceneChanged,
    scenario,
    player,
    ensembleActive,
    others,
    queryEmbeddings,
    intimateBeat,
    recentReplies,
    sensoryFocus,
    firstExchange,
  } = args;
  let {
    driftedState,
    syntheticCue,
  } = args;

  // --- Action beat ---------------------------------------------------------
  // A tapped chip is a narrated one-beat exchange. Build its register-aware cue —
  // apart ⇒ answer as a text, co-present ⇒ in-scene, derived from the last reply's
  // comms spans (the same signal the selfie offer reads) — and apply the chip's
  // deterministic effect to the drifted state BEFORE the prompt builds, so the reply
  // reflects the shift. The pre-exchange snapshot (storedState) is the PRE-effect
  // anchor, so a regenerate rolls back and re-applies the effect exactly once.
  if (actionBeatId) {
    syntheticCue = buildActionBeatCue({
      chipId: actionBeatId,
      characterName,
      playerName: player.name,
      apart: hasCommsSpans(recentReplies.at(-1) ?? ""),
    });
    driftedState = applyChatAction(driftedState, actionBeatId, scenario.clockMinutes);
  }

  // --- Perk targeting ------------------------------------------------------
  // The "addressed" member: a group perk aims at whoever the player's message
  // names. The primary wins when named; otherwise the first PRESENT other
  // member named; nobody named ⇒ undefined (the perk falls to the lead).
  const addressedOther =
    ensembleActive && playerContent && !mentionsCharacter(playerContent, characterName, profile.aliases)
      ? others.find((o) => o.state.presence === "present" && mentionsCharacter(playerContent, o.name, o.profile.aliases))
      : undefined;

  // --- Selfie arming -------------------------------------------------------
  // Request: the player asked for a photo (any register — their call). Offer:
  // APART-ONLY (owner ruling — the comms register is the "not in the same place"
  // signal) + warm regard + the cooldown ring. Either arms a one-turn license
  // line; the post-turn pulse decides whether the reply actually sent one.
  // Group scenes: a request routes to the addressed member —
  // unaddressed falls to the lead; offers stay lead-gated.
  // Narrator-mode input arms no selfie: "she asks for a photo" in authored narration
  // is story fabric, not the player requesting one (and the skipped pulse could never
  // confirm a send anyway).
  const selfieRequested = playerContent && !narratorInput ? detectSelfieRequest(playerContent) : false;
  const selfieTargetOther = selfieRequested ? addressedOther : undefined;
  const selfieOfferEligible =
    !selfieRequested && !narratorInput && Boolean(playerContent) &&
    chatSelfieOfferEligible({
      regard: driftedState.regard,
      clockMinutes: scenario.clockMinutes,
      selfieHistory: driftedState.selfieHistory,
      playerComms: hasCommsSpans(playerContent),
      lastReplyComms: hasCommsSpans(recentReplies.at(-1) ?? ""),
    });
  // Opener selfie: a warm reopen opener may
  // attach the "thinking of you" photo — warm + cooldown here; the apart
  // condition lives in the license line ("if you open as a text"), and the
  // opener-scoped pulse's `sentPhoto` read decides post-turn whether one
  // actually sent (an in-scene opener never "sends", so nothing queues).
  const initiativeOpener = effectiveKind === "continue" && Boolean(input.initiative);
  const openerSelfieEligible =
    initiativeOpener &&
    chatSelfieOpenerEligible({
      regard: driftedState.regard,
      clockMinutes: scenario.clockMinutes,
      selfieHistory: driftedState.selfieHistory,
    });

  // --- Memory callback: the unprompted "remember when" cue -----------------
  // Gate first (pure, no cost), then pay one embedding + one query to pick an old,
  // milestone-boosted, topic-DISTANT episode. An offered callback burns into the ring
  // immediately — it rides this exchange's ordinary state write, so "another take"
  // rolls the burn back with the snapshot and the retake gets the same opportunity.
  // Group scenes: the memory belongs to ONE member — the addressed one,
  // else the most-recently-active present member — drawn from THEIR group and gated
  // on THEIR ring. (A member burn rides their ordinary save; member rings aren't
  // rollback-managed, so a retake simply skips the already-burned episode.)
  let callback: { summary: string } | undefined;
  let ensembleCallback: { summary: string; memberName: string; regard: number } | undefined;
  const callbackSourceOther = ensembleActive
    ? (addressedOther ??
      others.reduce<(typeof others)[number] | undefined>((best, o) => {
        if (o.state.presence !== "present") return best;
        if (o.state.quietExchanges >= driftedState.quietExchanges) return best; // ties → the primary
        return !best || o.state.quietExchanges < best.state.quietExchanges ? o : best;
      }, undefined))
    : undefined;
  const callbackState = callbackSourceOther?.state ?? driftedState;
  if (
    playerContent &&
    chatCallbackEligible({
      clockMinutes: scenario.clockMinutes,
      callbackHistory: callbackState.callbackHistory,
      firstExchange,
      pendingSkipNote: scenario.pendingSkipNote,
      sceneChanged,
      intimateBeat,
      hasSensoryFocus: Boolean(sensoryFocus),
      lastReplyEndsInQuestion: replyEndsInQuestion(recentReplies.at(-1) ?? ""),
      // The crowded-turn arms: the tail's flavor slot
      // is single-occupancy, and the callback is what yields — decided HERE, before the
      // ring burns, so a deferred callback is never spent unseen.
      hasAttachments: Boolean(attachmentDescriptions?.length),
      narratorInput,
      photoBeat: selfieRequested || selfieOfferEligible || openerSelfieEligible,
      // A commitment near this turn owns the beat — the callback yields.
      planSalient: hasSalientPlan(derivePlanSalience(scenario.plans, scenario.clockMinutes, scenario.calendarStart)),
    })
  ) {
    const chosen = await retrieveChatCallback({
      groupId: callbackSourceOther?.memoryGroupId ?? memoryGroupId,
      input: playerContent,
      milestones: callbackState.milestones,
      usedRefs: callbackState.callbackHistory.map((e) => e.ref),
      // The input's vector is already in hand from the recall legs (slice 3).
      embeddings: queryEmbeddings,
      sink,
    });
    if (chosen) {
      if (ensembleActive) {
        ensembleCallback = {
          summary: chosen.summary,
          memberName: callbackSourceOther?.name ?? characterName,
          regard: callbackState.regard,
        };
      } else {
        callback = { summary: chosen.summary };
      }
      const burned = appendCallbackEntry(callbackState.callbackHistory, {
        ref: chosen.ref,
        atClockMinutes: scenario.clockMinutes,
      });
      if (callbackSourceOther) {
        callbackSourceOther.state = { ...callbackSourceOther.state, callbackHistory: burned };
      } else {
        driftedState = { ...driftedState, callbackHistory: burned };
      }
    }
  }
  // An initiative opener may
  // acknowledge what shifted since the player last OPENED the chat — the
  // seen-cursor names which milestones are still fresh for her. One indexed
  // read, initiative beats only.
  const recentShift = initiativeOpener
    ? unseenMilestoneReason(driftedState.milestones, (await loadMilestonesSeenAt(chatId)) ?? new Date())
    : null;
  return { driftedState, syntheticCue, selfieRequested, selfieTargetOther, selfieOfferEligible, initiativeOpener, openerSelfieEligible, callback, ensembleCallback, recentShift };
}

export async function prepareChatTurnPresentation(args: {
  characterId: string;
  characterName: string;
  sink: DiagnosticSink;
  memoryGroupId: string;
  owner: string;
  profile: CharacterProfile;
  driftedState: ChatState;
  scenario: ChatScenario;
  player: PlayerPersona;
  exchangeGuardMessageId: string;
}) {
  const {
    characterId,
    characterName,
    sink,
    memoryGroupId,
    owner,
    profile,
    driftedState,
    scenario,
    player,
    exchangeGuardMessageId,
  } = args;

  // Structured wardrobe: resolve the drifted worn state into its
  // rendered garment phrase + coverage-computed exposure — the ONE seam the prompt, scene
  // image, and look key share (reusing the session renderers, never re-forking them).
  // The garment store is the worn truth once this actor is modelled;
  // an unmodelled actor falls back to the projection column, unchanged.
  const wardrobe = await resolveChatWardrobe(
    { ...driftedState, garments: scenario.garments, garmentActorId: garmentActorForCharacter(characterId) },
    owner,
    profile,
    sink,
  );
  // The player's own wardrobe — same seam, so the
  // narrator knows what it can take off them. Empty without a persona.
  const playerWardrobe = await resolvePlayerWardrobe(
    scenario.playerState,
    owner,
    player.profile,
    sink,
    scenario.garments,
  );
  // Each ensemble member's resolved wardrobe, ONCE per exchange, lazily. Two
  // consumers share the cache: the contact leg derives each present member's
  // current-cut coverage from it, and the ensemble prompt build renders the
  // same resolve — without the cache the two would resolve independently with
  // no guarantee of agreeing about what a body has on.
  const memberWardrobes = new Map<string, ResolvedChatWardrobe>();
  const memberWardrobe = async (member: ChatTurnMember): Promise<ResolvedChatWardrobe> => {
    const cached = memberWardrobes.get(member.characterId);
    if (cached !== undefined) return cached;
    const resolved = await resolveChatWardrobe(
      { ...member.state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(member.characterId) },
      owner,
      member.profile,
      sink,
    );
    memberWardrobes.set(member.characterId, resolved);
    return resolved;
  };
  // The garment digest + cue block (`CHAT_GARMENT_CUES`, default OFF). Built from the store as it stands BEFORE the fan-out — the cut the
  // narrator is actually writing from — and re-derived identically by the finalizer,
  // which persists the cue memory the same way `surfacedCues` is persisted.
  const narrationPlaceName = currentScenePlace(scenario.sceneMemory)?.name;
  const garmentNarration = chatGarmentCuesEnabled()
    ? buildChatGarmentNarration({
        store: scenario.garments,
        atMinutes: scenario.clockMinutes,
        ...(narrationPlaceName === undefined ? {} : { placeName: narrationPlaceName }),
        actors: chatGarmentNarrationActors({
          characterId,
          characterName,
          playerName: player.name,
          characterVisibility: wardrobe.partVisibility,
          playerVisibility: playerWardrobe.partVisibility,
        }),
      })
    : null;
  // The affordance cue block (`CHAT_AFFORDANCE_CUES`, default OFF). Same committed pre-fan-out cut as the
  // garment narration above — the drifted state row, the ticked scenario, the
  // wardrobe rows this turn already resolved — because that is exactly what the
  // two rollback anchors restore, so "another take" rebuilds an identical read.
  // Flag off ⇒ this whole seam is unreached: no adapter call, no projection, and
  // the finalizer leaves `scenario.affordanceCues` alone.
  //
  // Hoisted rather than inlined because slice 7 has a SECOND caller: recognition
  // needs this read's perception view even when the cue flag is off, and two
  // copies of a thirteen-field request would be two places to forget a field.
  const affordanceReadInput = {
    subjectId: characterId,
    attributes: profile.attributes,
    attributeOverlays: driftedState.attributeOverlays,
    conditions: driftedState.conditions,
    // Absent on the free-text wardrobe path — unknown coverage fails closed.
    ...(wardrobe.worn === undefined
      ? {}
      : {
          wardrobe: {
            worn: wardrobe.worn,
            partVisibility: wardrobe.partVisibility,
            hairOcclusion: wardrobe.hairOcclusion,
          },
        }),
    // The garment domain (slice 6) reads the SAME store the wardrobe rows
    // and the garment cue block were resolved from — one cut, three
    // consumers — and is simply not run when this actor is unmodelled.
    garments: scenario.garments,
    garmentActorId: garmentActorForCharacter(characterId),
    bodySurface: driftedState.bodySurface,
    environment: scenario.environment,
    clockMinutes: scenario.clockMinutes,
    previousCues: scenario.affordanceCues,
    sink,
  };
  // Constraint-first narrator guidance (`CHAT_PHYSICAL_CONSTRAINTS`, default
  // OFF) reads the SAME cut. Hoisted here
  // because it is also the second reason to take the read at all.
  const physicalConstraintsEnabled = chatPhysicalConstraintsEnabled();
  const affordanceRead =
    chatAffordanceCuesEnabled() || physicalConstraintsEnabled ? buildChatAffordanceRead(affordanceReadInput) : null;
  // PRIMARY ONLY, and that is a prompt invariant rather than a scoping choice:
  // these cues lean on the character's own Attributes block for the appearance
  // they decorate, and this prompt carries exactly one. (The ensemble builder
  // renders no state section at all, so a roster member cannot receive one by
  // accident — same as the garment cue block.)
  // Gated on the CUE flag alone, never on `affordanceRead` being non-null: the
  // guidance flag can now make the read exist, and it must not thereby switch a
  // closed experiment back on (nor may it spend the cue memory — see the
  // `affordanceCueState` thread in the finalizer, which stays cue-flag-only).
  const affordanceCues = chatAffordanceCuesEnabled() && affordanceRead
    ? renderChatAffordanceCues({
        cues: affordanceRead.read.cues,
        attributes: affordanceRead.attributes,
        possessive: `${characterName}'s`,
        garmentNames: affordanceRead.garmentNames,
        // The `CHAT_GARMENT_CUES` boundary (see chat-affordance-cues.ts): with
        // both flags on, the wardrobe block owns the garment's wetness BAND and
        // this block yields its surface line for the same garment rather than
        // saying one detail twice.
        spokenGarmentIds: new Set(garmentNarration?.wetnessGarmentIds ?? []),
      })
    : [];

  // --- Recognizable features (slice 7, `CHAT_RECOGNITION_CUES`, default OFF) --
  // At most ONE additional cue line — a detail about this body that is currently
  // perceptible, salient, and either new, changed, long unseen, in play, or
  // weighted by something the observer witnessed — plus the observer-memory
  // commit that makes its cooldown work.
  //
  // The exchange's rollback guard (`exchangeGuardMessageId`, hoisted above) is what
  // lets this store recognize a retake and recompute from the identical
  // pre-exchange memory instead of advancing the notice counts a second time.
  //
  // PERCEPTION SOURCE ONLY when the cue flag is off. The recognition read needs
  // an exposure/channel view and only the affordance adapter builds one, so it
  // is built here — but its `nextCues` and `coverage` are DELIBERATELY dropped:
  // those persist under `CHAT_AFFORDANCE_CUES` alone, and letting one flag write
  // the other's state would make the two experiments uninterpretable.
  const recognitionPerception = chatRecognitionCuesEnabled()
    ? (affordanceRead ?? buildChatAffordanceRead(affordanceReadInput))
    : null;
  // Fenced whole: an optional read may never cost an exchange (docs/resilience.md).
  // Any failure — a missing row, a bad projection, an unreachable database —
  // degrades to no cue and untouched memory, exactly like the flag being off.
  let recognition: ChatRecognitionRead | null = null;
  if (recognitionPerception) {
    try {
      recognition = buildChatRecognitionRead({
        subjectId: characterId,
        characterName,
        possessive: `${characterName}'s`,
        // The resolved values the affordance read was taken over — overlays
        // already applied, so the cue can never disagree with the read it rides.
        attributes: recognitionPerception.attributes.values,
        perception: recognitionPerception.request.perception,
        memory: await loadChatVisualMemory({
          memoryGroupId,
          // The player is the observer in this lane, and the chat owner IS the
          // player. Their memory follows the MEMORY GROUP, not the chat.
          viewpointId: owner,
          subjectId: characterId,
          promptingMessageId: exchangeGuardMessageId,
          sink,
        }),
        clockMinutes: scenario.clockMinutes,
        sink,
      });
    } catch (error) {
      log.error("engine.chat", "chat recognition read failed", { error: describeError(error) });
    }
  }
  // Appended after the physical cues, same block: the affordance lines are what
  // is happening to this body right now, and a recognizable feature is standing
  // truth — it reads as the added detail rather than competing for the beat.
  const bodyCues = recognition?.cueLine ? [...affordanceCues, recognition.cueLine] : affordanceCues;
  return { wardrobe, playerWardrobe, memberWardrobe, garmentNarration, affordanceReadInput, physicalConstraintsEnabled, affordanceRead, recognitionPerception, recognition, bodyCues };
}
