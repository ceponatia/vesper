import {
  affordanceSubjectId,
  commitRecognitionMention,
  commitVisualNarratorCueMentions,
  garmentActorForCharacter,
  type AffordanceSubjectId,
  type DiagnosticSink,
} from "@/contracts";
import { log } from "../log";
import type { ChatRecognitionRead } from "./chat-recognition-adapter";
import { saveChatVisualMemory } from "./visual-memory-store";
import { saveChatVisualCues } from "./visual-cue-store";
import { mentionsCharacter, spokeInReply } from "./chat-intent";
import { runChatPersonalNotes } from "./chat-memory";
import { runChatPulse } from "./chat-state/pulse-agent";
import { settleEnsembleMember } from "./chat-state";
import type { ChatScenario, ChatState } from "./chat-state/types";
import { saveChatState } from "./chat-state/store";
import { savePreExchangeSnapshot } from "./chat-state/snapshots";
import type { ChatGarmentWardrobeChange } from "./chat-garments";
import type { VisualStateShadowBuild } from "@/server/visual-state";
import type { PlayerPersona } from "../players";
import type { ChatTurnMember, SubmitChatMessageInput, ChatExchangeKind } from "./chat-turn-types";
import type { FinalizeChatStateResult } from "./chat-state/finalize-types";

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function settleChatTurnMembers(args: {
  chatId: string;
  characterName: string;
  sink: DiagnosticSink;
  driftedState: ChatState;
  scenario: ChatScenario;
  others: ChatTurnMember[];
  input: Pick<SubmitChatMessageInput, "onSelfie">;
  promptMessageId: string | null;
  playerContent: string;
  assistantMessageId: string;
  effectiveKind: ChatExchangeKind;
  narratorInput: boolean;
  now: Date;
  player: PlayerPersona;
  agentPlayerContent: string;
  full: string;
  selfieTargetOther: ChatTurnMember | undefined;
  referencedOthers: ChatTurnMember[];
  finalized: FinalizeChatStateResult;
}) {
  const {
    chatId,
    characterName,
    sink,
    driftedState,
    scenario,
    others,
    input,
    promptMessageId,
    playerContent,
    assistantMessageId,
    effectiveKind,
    narratorInput,
    now,
    player,
    agentPlayerContent,
    full,
    selfieTargetOther,
    referencedOthers,
    finalized,
  } = args;

  // Ensemble members settle their own turn: the presence-gated tick from
  // prompt time, a referenced-only pulse (regard/mood/mindNote/weather), a
  // personal note-taker pass for every PRESENT member (followups ruling 10 —
  // loops/outfit/attributes/drives folded into their own row), the
  // deterministic per-member folds (ruling 11 — milestones + arc samples for
  // everyone who pulsed), the archivist's confirmed presence transition, and
  // the recency stamp — saved under the same prompt-row guard as the primary.
  //
  // Members settle CONCURRENTLY: each member's
  // legs read only their own row and write only their own row, and the whole settle
  // runs while the exchange lock is held — so settling a full roster one member at a
  // time stacked up to four back-to-back agent round-trips inside the lock window,
  // and a fast-typing player ate a 409 `chat_busy` for the difference. Errors stay
  // per-member (each iteration keeps its own try/catch), so one member's failure
  // still can't cost another's state.
  // Ensemble members whose look actually changed this exchange — reconciled
  // into the chat-wide garment store AFTER the concurrent settle, in one
  // sequential pass (the store is one jsonb field; concurrent
  // read-modify-writes of it would lose updates).
  const memberWornChanges: ChatGarmentWardrobeChange[] = [];
  // Whose wardrobe this exchange AUTHORITATIVELY rewrote — the reply-scene
  // leg's contact-start chronology veto. Collected from the settle's own
  // writers because
  // they are the only place the answer exists: the post-settle garment store
  // shows the FINAL clothes and cannot say when they changed, and a final
  // wardrobe does not prove which layers a touch mid-reply landed through.
  // The primary's and the player's folds join it from `finalized` below.
  const wardrobeChanged = new Set<AffordanceSubjectId>();
  // Who is on stage — computed ONCE for the whole settle, because every
  // member's whole-look evidence gate reads the same scene shape: with more
  // than one character present, a bare pronoun cannot pick a wardrobe owner
  // and only a name licenses a replacement (`outfitChangeEvidenceValidated`).
  const presentCharacterNames = [
    ...(driftedState.presence === "present" ? [characterName] : []),
    ...others.filter((o) => o.state.presence === "present").map((o) => o.name),
  ];
  await Promise.all(
    others.map(async (member) => {
      try {
        const preRegard = member.state.regard;
        const shouldPulse =
          effectiveKind !== "continue" &&
          !narratorInput &&
          Boolean(playerContent) &&
          referencedOthers.some((m) => m.characterId === member.characterId);
        const [pulsed, personal] = await Promise.all([
          shouldPulse
            ? runChatPulse({
                state: member.state,
                profile: member.profile,
                characterName: member.name,
                playerName: player.name,
                exchange: { player: agentPlayerContent, assistant: full },
                activeSocialCards: scenario.activeSocialCards,
                trace: { chatId, messageId: assistantMessageId },
                sink,
              })
            : Promise.resolve(null),
          member.state.presence === "present"
            ? runChatPersonalNotes({
                characterName: member.name,
                playerName: player.name,
                exchange: { player: agentPlayerContent, assistant: full },
                openLoops: member.state.openLoops,
                drives: member.state.drives,
                trace: { chatId, messageId: assistantMessageId },
                sink,
              })
            : Promise.resolve(null),
        ]);
        const isSelfieTarget = selfieTargetOther?.characterId === member.characterId;
        const memberState = settleEnsembleMember({
          state: pulsed ? pulsed.state : member.state,
          preRegard,
          pulsed: shouldPulse,
          personal: personal?.value ?? null,
          exchange: { player: agentPlayerContent, assistant: full },
          evidenceOwner: {
            names: [member.name, ...member.profile.aliases],
            isPlayer: false,
            otherNames: [
              player.name,
              ...presentCharacterNames.filter((n) => n.trim().toLowerCase() !== member.name.trim().toLowerCase()),
            ],
            presentCharacterCount: presentCharacterNames.length,
          },
          profile: member.profile,
          characterName: member.name,
          assistantMessageId,
          now,
          clockMinutes: scenario.clockMinutes,
          selfieRequestTarget: isSelfieTarget,
          sink,
        });
        const change = finalized.presenceChanges.find(
          (p) => p.name.trim().toLowerCase() === member.name.trim().toLowerCase(),
        );
        const confirmed = change?.presence;
        const active =
          mentionsCharacter(agentPlayerContent, member.name, member.profile.aliases) ||
          spokeInReply(full, member.name);
        const quietExchanges = active ? 0 : memberState.quietExchanges + 1;
        if (memberState.wornItemIds.join(",") !== member.state.wornItemIds.join(",")) {
          memberWornChanges.push({
            actorId: garmentActorForCharacter(member.characterId),
            preWornItemIds: member.state.wornItemIds,
            wornItemIds: memberState.wornItemIds,
          });
          wardrobeChanged.add(affordanceSubjectId(member.characterId));
        }
        const guardMessageId = promptMessageId ?? assistantMessageId;
        await saveChatState({
          chatId,
          characterId: member.characterId,
          promptMessageId: guardMessageId,
          state: {
            ...memberState,
            // Whereabouts: a present member's pending whereabouts
            // was spent on this exchange's return license; an away departure that named
            // where it went records the phrase (the set wins over the clear).
            ...(member.state.presence === "present" && member.state.whereabouts ? { whereabouts: "" } : {}),
            ...(confirmed ? { presence: confirmed } : {}),
            ...(confirmed === "away" && change?.where ? { whereabouts: change.where } : {}),
            quietExchanges,
          },
        });
        // Snapshot and state share the same guard: a deleted prompt can commit
        // neither half, and every roster member advances from one rollback boundary.
        await savePreExchangeSnapshot(
          chatId,
          member.characterId,
          member.preExchangeState,
          guardMessageId,
        );
        // The addressed member actually sent the photo (their pulse read it) —
        // queue the render with THEIR identity (ruling 12).
        if (isSelfieTarget && pulsed && !pulsed.state.lastPulseTrace.degraded && pulsed.state.lastPulseTrace.sentPhoto) {
          input.onSelfie?.({ assistantMessageId, characterId: member.characterId });
        }
      } catch (error) {
        log.error("engine.chat", "ensemble member state persist failed", {
          characterId: member.characterId,
          error: describeError(error),
        });
      }
    }),
  );
  return { memberWornChanges, wardrobeChanged };
}

/**
 * Commit the exchange's observer memory. Called ONLY once the exchange has
 * actually settled — a failed or empty reply leaves the memory exactly as the
 * next take will need to find it.
 *
 * Notices are persisted even when nothing was said (`mentionCommit` null is a
 * no-op inside `commitRecognitionMention`): looking is what strengthens
 * recognition, and only the cue that entered the cut moves `lastMentionedAt`.
 * Fenced for the same reason the read is.
 */
export async function commitChatTurnRecognition(args: {
  memoryGroupId: string;
  owner: string;
  characterId: string;
  exchangeGuardMessageId: string;
  recognition: ChatRecognitionRead | null;
}): Promise<void> {
  const {
    memoryGroupId,
    owner,
    characterId,
    exchangeGuardMessageId,
    recognition,
  } = args;
  if (!recognition) return;
  try {
    await saveChatVisualMemory({
      memoryGroupId,
      viewpointId: owner,
      subjectId: characterId,
      promptingMessageId: exchangeGuardMessageId,
      next: commitRecognitionMention(
        recognition.selection.memoryAfterNotices,
        recognition.selection.mentionCommit,
      ),
    });
  } catch (error) {
    log.error("engine.chat", "chat visual memory persist failed", { error: describeError(error) });
  }
}

/**
 * Commit the exchange's narrator cue state — what was in view and what was
 * said about the families observer memory does not hold. Called at the same
 * settle points as the recognition commit, and never when the narration
 * flag is off (the shadow arm reads the state and ranks against it, but a
 * measurement run may not advance it).
 *
 * Visibility is persisted even when nothing was said: recording what was in
 * view is what makes the NEXT cut's newly-revealed answer correct, exactly
 * as a notice is for recognition, and only a cue that entered the cut moves
 * the cooldown. Fenced like every other optional write.
 */
export async function commitChatTurnVisualCues(args: {
  memoryGroupId: string;
  owner: string;
  characterId: string;
  exchangeGuardMessageId: string;
  visualStateNarrationOn: boolean;
  visualStateBuild: VisualStateShadowBuild | null;
}): Promise<void> {
  const {
    memoryGroupId,
    owner,
    characterId,
    exchangeGuardMessageId,
    visualStateNarrationOn,
    visualStateBuild,
  } = args;
  if (!visualStateNarrationOn || visualStateBuild === null) return;
  try {
    await saveChatVisualCues({
      memoryGroupId,
      viewpointId: owner,
      subjectId: characterId,
      promptingMessageId: exchangeGuardMessageId,
      next: commitVisualNarratorCueMentions(
        visualStateBuild.narrator.cueStateAfterVisibility,
        visualStateBuild.narrator.cueMentionCommits,
        visualStateBuild.narrator.spokenRepeatKeys,
      ),
    });
  } catch (error) {
    log.error("engine.chat", "chat visual cue state persist failed", { error: describeError(error) });
  }
}
