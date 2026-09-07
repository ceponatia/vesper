import {
  compileNarratorPhysicalGuidance,
  DiagnosticCollector,
  garmentActorForCharacter,
  type CharacterProfile,
  type DiagnosticSink,
  type PhysicalActionOutcome,
  type PhysicalStateTransition,
} from "@/contracts";
import { log } from "../log";
import { buildChatAffordanceRead } from "./chat-affordances";
import type { ChatContactUnresolvedPremise } from "./chat-contact/presentation";
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import { loadChatPermissionStopTransitions } from "./chat-permission-guidance";
import { buildChatPhysicalGuidance } from "./chat-physical-guidance";
import { renderChatPhysicalGuidance } from "./chat-physical-guidance-render";
import { loadChatVisualMemory } from "./visual-memory-store";
import { loadChatVisualCues } from "./visual-cue-store";
import { chatVisualStateNarrationOn } from "./chat-visual-state-flag";
import {
  renderChatVisualStateLines,
  visualStateGarmentNames,
  type ChatVisualStateLines,
} from "./chat-visual-state-cues";
import type { detectSensoryFocus } from "./chat-intent";
import type { ChatScenario, ChatState } from "./chat-state/types";
import type { ResolvedChatWardrobe } from "./chat-wardrobe";
import { chatRomanticPermissionEnabled, chatVisualStateShadowEnabled } from "./prompts/constants";
import {
  safeBuildVisualStateShadow,
  visualStateShadowLogSummary,
  type VisualStateShadowBuild,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import type { PlayerPersona } from "../players";
import type { ChatTurnMember, ChatContactTurnRecord, SubmitChatMessageInput } from "./chat-turn-types";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function prepareChatTurnGuidance(args: {
  chatId: string;
  characterId: string;
  characterName: string;
  sink: DiagnosticSink;
  profile: CharacterProfile;
  owner: string;
  driftedState: ChatState;
  scenario: ChatScenario;
  others: ChatTurnMember[];
  memoryGroupId: string;
  input: Pick<SubmitChatMessageInput, "onContactTurn">;
  playerContent: string;
  assistantMessageId: string;
  narratorInput: boolean;
  exchangeGuardMessageId: string;
  player: PlayerPersona;
  primarySensoryFocus: Exclude<ReturnType<typeof detectSensoryFocus>, null> | undefined;
  wardrobe: ResolvedChatWardrobe;
  affordanceReadInput: Parameters<typeof buildChatAffordanceRead>[0];
  physicalConstraintsEnabled: boolean;
  affordanceRead: ReturnType<typeof buildChatAffordanceRead> | null;
  recognitionPerception: ReturnType<typeof buildChatAffordanceRead> | null;
  contactActionOutcomes: readonly PhysicalActionOutcome[];
  contactUnresolvedPremise: ChatContactUnresolvedPremise | null;
  contactTurnFacts: Omit<ChatContactTurnRecord, "guidanceLines"> | null;
}) {
  const {
    chatId,
    characterId,
    characterName,
    sink,
    profile,
    owner,
    driftedState,
    scenario,
    others,
    memoryGroupId,
    input,
    playerContent,
    assistantMessageId,
    narratorInput,
    exchangeGuardMessageId,
    player,
    primarySensoryFocus,
    wardrobe,
    affordanceReadInput,
    physicalConstraintsEnabled,
    affordanceRead,
    recognitionPerception,
    contactActionOutcomes,
    contactUnresolvedPremise,
    contactTurnFacts,
  } = args;

  // --- Pending revocation stop (`chat-permission-guidance.ts`) -------------
  // A withdrawal that ended contact lands AFTER the reply it was read from
  // (the decision leg runs at settle) or between exchanges (an override), so
  // THIS reply is the "next narrator cut" that must portray the stop.
  //
  // Permission authority composes with the contact lane, never with the
  // optional general-constraints experiment. A pending stop therefore uses
  // the shared compiler/renderer even when `CHAT_PHYSICAL_CONSTRAINTS` is
  // off. With no pending stop, that flag still owns every ordinary physical
  // guidance byte. The stop read is binding: if it fails, the exchange fails
  // before producing a reply rather than consuming the only delivery window.
  let permissionStopTransitions: readonly PhysicalStateTransition[] = [];
  if (chatRomanticPermissionEnabled()) {
    try {
      permissionStopTransitions = await loadChatPermissionStopTransitions({
        chatId,
        // The current exchange's assistant row — fresh (matches nothing) or
        // the regenerate's reused row, whose content is being replaced and so
        // must not count as having narrated the stop.
        assistantMessageId,
        sink,
      });
    } catch (error) {
      log.error("engine.chat", "chat permission stop guidance failed", { error: describeError(error) });
      throw error;
    }
  }

  // --- Narrator physical guidance (slice 2, `CHAT_PHYSICAL_CONSTRAINTS`, OFF) ---
  // Constraints from the committed cut above, plus the high-confidence false
  // premises in THIS message. Fenced whole for the same reason every optional read
  // is (docs/resilience.md): a guidance failure degrades to no block, which is the
  // flag-off prompt, and never costs the exchange.
  //
  // Nothing is persisted: the selection is recomputable from the same cut and the
  // same message, so the existing rollback anchors already make a retake reproduce
  // it — and the stop transitions above are a fold over durable rows the retake
  // prunes, so they reproduce with everything else.
  let physicalGuidanceLines: readonly string[] = [];
  if ((physicalConstraintsEnabled && affordanceRead !== null) || permissionStopTransitions.length > 0) {
    try {
      // General constraints take the full affordance path only under their
      // own flag. A mandatory stop with that experiment off takes the
      // transition-only arm through the same compiler and renderer.
      const guidance = physicalConstraintsEnabled && affordanceRead
        ? buildChatPhysicalGuidance({
            read: affordanceRead.read,
            perception: affordanceRead.request.perception,
            committed: affordanceRead.committed,
            subjectId: characterId,
            characterName,
            playerName: player.name,
            // The raw current message — the span parser reads its own markup. An
            // opening/continue beat has no player line, so nothing is premise-checked.
            message: playerContent,
            narratorInput,
            // The turn's sense-targeted beat, already detected above: one of the four
            // relevance signals that decide whether a true fence is worth its bytes.
            sensoryFocus: primarySensoryFocus ?? null,
            // This turn's resolved contact, when the contact flag produced one. A
            // conditional spread, so a contact-flag-off turn compiles the exact bytes
            // it compiled before the leg existed.
            ...(contactActionOutcomes.length > 0 ? { actionOutcomes: contactActionOutcomes } : {}),
            // The pending revocation stops — the transition tier's producer. Same
            // conditional-spread discipline: absent, the compile is byte-identical.
            ...(permissionStopTransitions.length > 0 ? { transitions: permissionStopTransitions } : {}),
            sink,
          })
        : compileNarratorPhysicalGuidance({ transitions: permissionStopTransitions, sink });
      physicalGuidanceLines = renderChatPhysicalGuidance({
        guidance,
        characterName,
        possessive: `${characterName}'s`,
        // The unestablished-reach premise (S3): presentation only, and owned by
        // THIS flag — the underlying attempt stays `unresolved` either way, and
        // with the flag off these bytes do not exist.
        ...(physicalConstraintsEnabled && contactUnresolvedPremise !== null ? { unresolvedPremise: contactUnresolvedPremise } : {}),
        // The stop line's display names: the roster plus the reserved player
        // subject. Presentation only, and only when a stop is in play.
        ...(permissionStopTransitions.length > 0
          ? {
              subjectNames: {
                [String(CHAT_CONTACT_PLAYER_SUBJECT)]: "the player",
                [characterId]: characterName,
                ...Object.fromEntries(others.map((member) => [member.characterId, member.name] as const)),
              },
            }
          : {}),
        sink,
      });
    } catch (error) {
      log.error("engine.chat", "chat physical guidance failed", { error: describeError(error) });
      if (permissionStopTransitions.length > 0) throw error;
    }
  }

  // The contact-turn record ships here — after the guidance exists, before the
  // model sees it. Fire-and-forget: a throwing observer costs a log line and
  // nothing else, because a trial watching a turn may not break it.
  if (input.onContactTurn !== undefined && contactTurnFacts !== null) {
    try {
      input.onContactTurn({ ...contactTurnFacts, guidanceLines: physicalGuidanceLines });
    } catch (error) {
      log.error("engine.chat", "contact turn observer failed", { error: describeError(error) });
    }
  }

  // --- Visual state (slice 6 shadow + slice 7 narration cue state) ---------
  // `CHAT_VISUAL_STATE_SHADOW` (OFF) runs the lane-neutral projection BESIDE
  // the turn for measurement only: nothing it computes reaches the prompt, the
  // reply, chat state, or observer memory (its DB touches are read-only
  // loads), and any failure degrades to a log line (docs/resilience.md). Its
  // diagnostics ride a PRIVATE collector so even the turn's own diagnostic
  // record is byte-identical with the flag on. It reads the same committed cut
  // the narrator writes from: the drifted state, the ticked scenario, this
  // turn's resolved wardrobe, and the post-contact-leg scene.
  //
  // The per-chat VISUAL-STATE NARRATION switch (off by default) makes the same
  // build COMMITTABLE: its
  // narrator cue state is written with the exchange at settle, so a mentioned
  // family cools down and a family merely in view stops reading as newly
  // revealed. That is why the narration arm runs on the turn's own path rather
  // than deferred — a deferred build cannot be captured with the cut it
  // describes, and a cue advance for an exchange that never landed is exactly
  // the retake impurity the two-generation store exists to prevent.
  let visualStateBuild: VisualStateShadowBuild | null = null;
  /** The rendered pair the prompt carries. Null unless this chat's switch is on and the selection spoke. */
  let visualStateLines: ChatVisualStateLines | null = null;
  // PER CHAT, not per deploy (owner ruling 2026-08-17). Fenced: a failed read
  // answers "off", which leaves the prompt byte-identical to today.
  const visualStateNarrationOn = await chatVisualStateNarrationOn(chatId).catch((error: unknown) => {
    log.error("engine.chat", "visual-state narration switch read failed", { error: describeError(error) });
    return false;
  });
  if (chatVisualStateShadowEnabled() || visualStateNarrationOn) {
    const runVisualState = async (): Promise<VisualStateShadowBuild | null> => {
      try {
        const shadowSink = new DiagnosticCollector();
        // Reuse this turn's affordance read when another flag already took one;
        // otherwise take the identical read with the shadow's own sink so the
        // turn's collector stays untouched.
        const shadowRead =
          affordanceRead ?? recognitionPerception ?? buildChatAffordanceRead({ ...affordanceReadInput, sink: shadowSink });
        const [shadowMemory, shadowCues] = await Promise.all([
          loadChatVisualMemory({
            memoryGroupId,
            viewpointId: owner,
            subjectId: characterId,
            promptingMessageId: exchangeGuardMessageId,
            sink: shadowSink,
          }),
          // Loaded on BOTH arms. Ranking against the stored cue state is a
          // read, so the shadow measures real repetition and real
          // newly-revealed counts; only the WRITE waits on the narration flag.
          loadChatVisualCues({
            memoryGroupId,
            viewpointId: owner,
            subjectId: characterId,
            promptingMessageId: exchangeGuardMessageId,
            sink: shadowSink,
          }),
        ]);
        const playerSubject = String(CHAT_CONTACT_PLAYER_SUBJECT);
        const shadowInput: VisualStateShadowInput = {
          lane: "character_chat",
          scope: { kind: "chat", memoryGroupId },
          cutId: exchangeGuardMessageId,
          atMinutes: scenario.clockMinutes,
          subjectId: characterId,
          attributes: profile.attributes,
          attributeOverlays: driftedState.attributeOverlays,
          conditions: driftedState.conditions,
          realize: {
            ...(profile.speciesId === undefined ? {} : { speciesId: profile.speciesId }),
            ...(profile.heritageId === undefined ? {} : { heritageId: profile.heritageId }),
            ...(profile.bodyPlanId === undefined ? {} : { bodyPlanId: profile.bodyPlanId }),
            ...(profile.intimateRegions === undefined ? {} : { intimateRegions: profile.intimateRegions }),
            ...(profile.bodyFeatures === undefined ? {} : { bodyFeatures: profile.bodyFeatures }),
          },
          garments: {
            store: scenario.garments,
            actorId: garmentActorForCharacter(characterId),
            ...(wardrobe.worn === undefined
              ? {}
              : { layersByGarmentId: new Map(wardrobe.worn.map((row) => [row.garmentId, row.layer])) }),
            freshCoverage: shadowRead.coverage,
          },
          playerSubjectId: playerSubject,
          sceneSubjectId: "scene",
          bodySurface: driftedState.bodySurface,
          environment: scenario.environment,
          sceneRelations: {
            scene: scenario.scene,
            subjectsByParticipant: new Map([
              [characterId, characterId],
              [playerSubject, playerSubject],
              ...others.map((member) => [member.characterId, member.characterId] as const),
            ]),
          },
          observations: shadowRead.read.observations,
          perception: shadowRead.request.perception,
          observerId: owner,
          observer: { kind: "player_viewpoint", viewpointId: owner },
          memory: shadowMemory,
          cues: shadowCues,
          ...(wardrobe.worn === undefined
            ? {}
            : { wornGarmentIds: [...new Set(wardrobe.worn.map((row) => row.garmentId))] }),
          sink: shadowSink,
        };
        const shadow = safeBuildVisualStateShadow(shadowInput, shadowSink);
        if (shadow !== null) {
          log.info("engine.chat", "visual-state shadow", {
            chatId,
            // Which arm produced this line: the deferred measurement run, or
            // the committable narration run. A trial row cannot be read
            // without it, since only one of the two advances the cue state.
            narration: visualStateNarrationOn,
            ...visualStateShadowLogSummary(shadow),
            codes: shadowSink.items.map((entry) => entry.code),
          });
        } else {
          log.warn("engine.chat", "visual-state shadow degraded to nothing", {
            chatId,
            codes: shadowSink.items.map((entry) => entry.code),
          });
        }
        return shadow;
      } catch (error) {
        log.error("engine.chat", "visual-state shadow failed", { error: describeError(error) });
        return null;
      }
    };
    if (visualStateNarrationOn) {
      visualStateBuild = await runVisualState();
      // The prompt half of slice 7. The subject is the primary character —
      // the one the prompt describes — and the digest is theirs; a snapshot
      // that spans the player and the roster still narrates one body here,
      // matching every other cue block in this pipeline.
      const digest = visualStateBuild?.narrator.digests.find((entry) => entry.subjectId === characterId);
      if (visualStateBuild !== null && digest !== undefined) {
        try {
          visualStateLines = renderChatVisualStateLines({
            digest,
            subject: {
              characterName,
              possessive: `${characterName}'s`,
              subjectId: characterId,
              playerSubjectId: String(CHAT_CONTACT_PLAYER_SUBJECT),
            },
            garmentNames: visualStateGarmentNames(visualStateBuild.snapshot),
          });
        } catch (error) {
          // A rendering failure costs the block, never the turn — the same
          // fence the shadow build carries (docs/resilience.md).
          log.error("engine.chat", "visual-state cue render failed", { error: describeError(error) });
        }
      }
    } else {
      // DEFERRED off the turn's critical path: measurement only, and the
      // player waits for none of it. The closure captures the cut this turn
      // already committed, so it still measures the same moment — it just
      // stops charging the affordance read and the two loads to reply
      // latency. The successor lane defers its shadow the same way.
      void runVisualState();
    }
  }
  return { physicalGuidanceLines, visualStateBuild, visualStateLines, visualStateNarrationOn };
}
