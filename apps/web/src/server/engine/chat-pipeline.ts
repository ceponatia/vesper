import { settleEnsembleMember } from "./chat-state/ensemble";
import { finalizeChatState } from "./chat-state/finalize";
import {
  and,
  eq,
  or,
} from "drizzle-orm";
import {
  affordanceSubjectId,
  characterProfileSchema,
  commitRecognitionMention,
  commitVisualNarratorCueMentions,
  compileNarratorPhysicalGuidance,
  CONTACT_EFFECT_OWNER_UNAVAILABLE,
  contactCommitEvents,
  contactMarkProposals,
  currentScenePlace,
  derivePermissionPolicyRead,
  derivePlanSalience,
  DiagnosticCollector,
  diag,
  effectiveTraitValue,
  emptyCharacterProfile,
  garmentActorForCharacter,
  formatScheduleRhythm,
  hasSalientPlan,
  samePlaceName,
  splitStateCues,
  switchScenePlace,
  teeSink,
  unseenMilestoneReason,
  withSceneContacts,
  type AffordanceSubjectId,
  type BodyMarkProposal,
  type ChatActionId,
  type ContactEndReason,
  type ContactLifecycleCommit,
  type ContactPersistenceAcknowledgment,
  type ContactRejectionReason,
  type ContactResolutionStatus,
  type ContactUnresolvedReason,
  type DiagnosticSink,
  type EffectiveCoverageRead,
  type PhysicalActionOutcome,
  type PhysicalStateTransition,
} from "@/contracts";
import type { NarratorPromptNode, NarratorRunProvenance } from "@/contracts/narrator-prompts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";
import type { NarratorCompletion } from "../ai";
import {
  characterChats,
  characterChatMessages,
  db,
} from "../db";
import {
  chatAttachmentPaths,
  claimChatAttachments,
  deleteChatUploads,
} from "../images";
import { log } from "../log";
import { QueryEmbeddings } from "../memory";
import { resolveChatPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { stopChatReply, streamExchange } from "./chat-reply-stream";
import { buildActionBeatCue } from "./chat-action-beat";
import {
  buildNarratorRunProvenance,
  currentReplyTakes,
  loadMessageAttachments,
  lastAssistantMessage,
  messageBefore,
  persistAssistantReply,
  pushReplyTake,
  resolveRerunTarget,
} from "./chat-reply-store";
import { renderChatAffordanceCues } from "./chat-affordance-cues";
import { buildChatAffordanceRead } from "./chat-affordances";
import {
  chatContactAcknowledgment,
  chatContactActionOutcome,
  chatContactUnresolvedPremise,
  type ChatContactPremiseKind,
  type ChatContactUnresolvedPremise,
} from "./chat-contact/presentation";
import { chatContactEventRef, CHAT_CONTACT_PLAYER_SUBJECT, type ChatContactAct } from "./chat-contact/identity";
import { chatContactMaterialAtCut } from "./chat-contact/material";
import { chatSceneAfterDiscontinuity, endAllChatContacts } from "./chat-contact/scene";
import { planChatContactTurn } from "./chat-contact-adapter";
import type { ChatContactPolicySource } from "./chat-contact/resolution";
import type { ChatContactRosterMember } from "./chat-contact/input-evidence";
import {
  appendChatContactEventsWithScene,
  CHAT_CONTACT_LEDGER_MISMATCH,
  deleteChatContactEventsForGuard,
} from "./chat-contact-events";
import {
  CHAT_PERMISSION_ROLLBACK_FAILED,
  deleteChatPermissionEventsForGuards,
  foldChatPermissionProjection,
  listChatPermissionEvents,
} from "./chat-permission-events";
import {
  beginChatNpcSceneDecision,
  chatNpcSceneDecisionMode,
  emptyChatNpcSceneSettleReport,
  finishChatNpcSceneDecision,
  type ChatNpcSceneDecisionHandle,
} from "./chat-npc-scene-decision";
import { runChatRomanticPermissionDecision } from "./chat-permission-decision";
import { loadChatPermissionStopTransitions } from "./chat-permission-guidance";
import { deleteChatNpcSceneDecision } from "./chat-npc-scene-envelope";
import {
  applyChatNpcContactEnding,
  chatReplyContactEventRef,
  detectChatNpcContactEnding,
  type ChatNpcEndingCharacter,
} from "./chat-contact-reply";
import { buildChatPhysicalGuidance } from "./chat-physical-guidance";
import { renderChatPhysicalGuidance } from "./chat-physical-guidance-render";
import { buildChatRecognitionRead, type ChatRecognitionRead } from "./chat-recognition-adapter";
import { loadChatVisualMemory, saveChatVisualMemory } from "./visual-memory-store";
import { loadChatVisualCues, saveChatVisualCues } from "./visual-cue-store";
import { chatVisualStateNarrationOn } from "./chat-visual-state-flag";
import {
  renderChatVisualStateLines,
  visualStateGarmentNames,
  type ChatVisualStateLines,
} from "./chat-visual-state-cues";
import { appendCallbackEntry, chatCallbackEligible } from "./chat-callback";
import { buildInitiativeCue } from "./chat-initiative";
import { loadChatRelationships } from "./chat-relationships";
import { chatSelfieOfferEligible, chatSelfieOpenerEligible, detectSelfieRequest, hasCommsSpans } from "./chat-selfie";
import { CHAT_ATTACHMENTS_MAX, describeChatPhotos } from "./chat-vision";
import {
  buildChatReplyGates,
  // chatCueInviteLine — retired (the sensory-allowance line supersedes its
  // sensory arms); re-import to roll back.
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSceneMovement,
  detectSensoryFocus,
  mentionsCharacter,
  replyEndsInQuestion,
  spokeInReply,
} from "./chat-intent";
import {
  reconcileMessageMemory,
  retrieveChatCallback,
  retrieveChatMemory,
  runChatPersonalNotes,
} from "./chat-memory";
import { runChatPulse } from "./chat-state/pulse-agent";
import { resolveSeededOutfit } from "./chat-state/outfit-fold";
import {
  applyChatAction,
  driftChatState,
  seedChatScenario,
  seedChatState,
  type ChatScenario,
  type ChatState,
} from "./chat-state";
import {
  loadChatScenario,
  loadChatState,
  loadMilestonesSeenAt,
  persistChatState,
  saveChatScenario,
  saveChatState,
} from "./chat-state/store";
import {
  loadPreExchangeScenario,
  loadPreExchangeState,
  rollbackScenario,
  savePreExchangeScenario,
  savePreExchangeSnapshot,
} from "./chat-state/snapshots";
import {
  resolveChatWardrobe,
  resolvePlayerWardrobe,
  type ResolvedChatWardrobe,
} from "./chat-wardrobe";
import {
  buildChatGarmentNarration,
  chatGarmentNarrationActors,
  reconcileActorWardrobes,
  type ChatGarmentWardrobeChange,
} from "./chat-garments";
import { enqueueChatSummary, loadChatSummary, loadVerbatimWindow } from "./chat-summary";
import {
  CHARACTER_CHAT_SUMMARIZE_AT,
  CHAT_TICK_MINUTES,
  CHAT_RERUN_LOCK_WAIT_MS,
} from "./constants";
import { acquireKeyedLockWithin, CHAT_LOCK_LABEL_REPLY, chatExchangeLockKey, tryKeyedLock } from "./keyed-lock";
import {
  buildCharacterChatPromptNodes,
  buildCharacterChatPromptParts,
  buildCharacterChatSystemPrompt,
  buildChatPromptPartsForRoster,
  buildChatTurnMessage,
  buildEnsembleChatPromptNodes,
  chatNotationNote,
  wrapNarratorInput,
  ENSEMBLE_QUIET_EXCHANGES,
  type CharacterChatPromptInput,
  type EnsembleMemberInput,
  type EnsemblePairInput,
  type EnsemblePromptExtras,
} from "./prompts/character-chat";
import {
  chatAffordanceCuesEnabled,
  chatContactActionsEnabled,
  chatContactEffectsEnabled,
  chatGarmentCuesEnabled,
  chatPhysicalConstraintsEnabled,
  chatPromptLayout,
  chatRecognitionCuesEnabled,
  chatRomanticPermissionEnabled,
  chatVisualStateShadowEnabled,
  narrationShapeId,
} from "./prompts/constants";
import {
  safeBuildVisualStateShadow,
  visualStateShadowLogSummary,
  type VisualStateShadowBuild,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { chatOwnerId, playerPromptSlice, promptStateSlice } from "./chat-prompt-input";

/**
 * The character-chat exchange pipeline (docs/character-chat/pipeline.md) — the chat lane's
 * `submitTurn` analogue.
 * Owns everything between "a validated send arrived" and "the reply stream settled":
 * the per-chat exchange lock, the user-line insert, summary + verbatim-window
 * assembly, state drift, RAG recall, prompt build, the model stream, and the settle
 * work (reply persistence + the post-turn fan-out). The HTTP route stays a thin
 * parse → auth → stream shell. Keyed on the conversation: the route
 * resolves chat + participant + character and hands their slices in.
 *
 * Six exchange kinds:
 * - **send** — the normal player turn.
 * - **open** — the opening beat ("Prompt character"): no player line, no fan-out.
 * - **continue** — "go on": no player line; the archivist runs (new narrative is
 *   worth remembering) but the reaction pulse is skipped (no player act).
 * - **action_beat** — a tapped action chip: no player
 *   line; the server builds a register-aware synthetic cue from the chip id and
 *   applies the chip's deterministic state effect to the drifted state PRE-narration
 *   (so the reply reflects it), rollback-safe via the pre-exchange snapshot. The
 *   pulse is skipped (no player act — like `continue`); the archivist runs. The chip
 *   id rides the reply's `meta.actionBeat` so a regenerate reproduces the cue + effect.
 * - **regenerate** — "another take" on the LAST assistant reply: state rolls back
 *   to the pre-exchange snapshot, the old take's memory is retracted, the reply
 *   row is updated in place with the old take kept browsable (`takes`).
 * - **rerun** — atomic "re-send this player line" (data-loss-rerun fix): stop any
 *   in-flight reply, re-acquire the lock (bounded wait), then in one transaction
 *   delete only the target user line's SUCCESSORS and reuse the target itself as the
 *   prompt guard — a fresh reply streams like a `send`. Nothing is deleted until the
 *   lock is held and the target validates, so a failed acquire leaves the transcript
 *   byte-identical. Only the latest exchange's prompt can rerun in place — its reply
 *   as sole successor, or NO successors when the reply never persisted (failed
 *   stream/timeout/empty). An older target requires conversation branching because
 *   the one-exchange snapshot cannot restore every discarded successor honestly.
 *   When a reply IS deleted, state mirrors regenerate and the reply's extracted
 *   memory is retracted; a failed-reply rerun starts from the live state instead
 *   (that exchange never settled, so there is nothing to roll back).
 */

export type ChatExchangeKind = "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";

export type { ChatContactPremiseKind } from "./chat-contact/presentation";

/**
 * One exchange's physical act, as the narrator was told about it.
 *
 * Deliberately a projection rather than the internals: the resolved outcome, the
 * premise the seam chose, and the rendered guidance lines — never the permission
 * ledger, the evidence chain, or the policy read. A consumer grading whether the
 * prose honoured the state needs what the state SAID; giving it the record
 * behind that would let a trial grade itself against facts the prompt never
 * carried.
 */
export interface ChatContactTurnRecord {
  /** Absent when the message produced no contact act at all. */
  readonly act?: {
    readonly kind: ChatContactAct["actionKind"];
    readonly gesture: string;
    readonly targetLocationId: string;
    readonly actionId: string;
  };
  /**
   * The resolver's own status, and its typed reason when it has one.
   *
   * Both carry their closed unions rather than `string`. This record is the
   * whole input to an instrument that gates a rollout ruling, and against a bare
   * `string` a misspelled expectation compiles, never matches, and reports a
   * lane defect that does not exist.
   *
   * `reason` spans BOTH reason vocabularies, because two different statuses
   * carry one: `rejected` names a rejection reason and `unresolved` names an
   * unresolved one. Narrowing this to the unresolved half would have made the
   * explicit-denial case — `rejected` / `permission_denied`, one of the six the
   * rerun must cover — untypeable.
   */
  readonly status?: ContactResolutionStatus;
  readonly reason?: ContactRejectionReason | ContactUnresolvedReason;
  /** The outcome's stable result codes — the same list the fingerprint folds. */
  readonly resultCodes: readonly string[];
  /** True only when the exchange durably recorded the contact. */
  readonly committed: boolean;
  /** The committed contact's id, when there is one. */
  readonly contactId?: string;
  /** Skin or through a layer, as RECORDED — absent unless the contact committed. */
  readonly directSkinContact?: boolean;
  /** Contacts this exchange ended, with the reason each ended for. */
  readonly ended: readonly { readonly contactId: string; readonly reason: string }[];
  /** Which unresolved gap earned a narrator line, when one did. */
  readonly premiseKind?: ChatContactPremiseKind;
  /** The exact physical-guidance lines handed to the narrator this turn. */
  readonly guidanceLines: readonly string[];
}

export interface SubmitChatMessageInput {
  /** The conversation (already authorized + not archived — the route owns both checks). */
  chatId: string;
  /** The participant's memory group — the RAG scope for recall + writes. */
  memoryGroupId: string;
  /** The (v1 single) participant character row slice. */
  character: { id: string; name: string; profile: unknown };
  /**
   * The full sort-ordered roster — the first entry
   * describes the same primary as `character`/`memoryGroupId`. Absent or length 1
   * ⇒ the 1-on-1 path, byte-identical prompts. Length > 1 ⇒ the ensemble frame:
   * per-member state (present members drift, away freeze), tier-1
   * memory legs, and per-member activity-recency stamping post-turn.
   */
  roster?: readonly { characterId: string; memoryGroupId: string; name: string; profile: unknown }[];
  kind: ChatExchangeKind;
  /** The player's line — required for `send`, ignored for the other kinds. */
  content?: string;
  /**
   * Composer register — `send` only:
   * "narrator" marks `content` as story narration authored by the player as
   * storyteller, never their own POV. Persisted on the user line's meta (the stored
   * text stays byte-verbatim); regenerate/rerun recover it from the stored line.
   */
  inputMode?: "player" | "narrator";
  /**
   * The target user-message id — required for `kind: "rerun"`, ignored otherwise. The
   * rerun snips this line's successors and re-runs from it (the line itself is reused,
   * never deleted or re-inserted).
   */
  targetMessageId?: string;
  /**
   * Bounded-wait budget (ms) for re-acquiring the lock on a `kind: "rerun"`, after
   * stopping any in-flight reply. Defaults to CHAT_RERUN_LOCK_WAIT_MS; overridable so a
   * caller (or a test of the contended path) can tune how long a rerun waits before
   * giving up with `chat_busy`.
   */
  rerunLockWaitMs?: number;
  /** Optional narrator-model override (a curated NARRATIVE_MODELS id). */
  model?: string;
  /**
   * "Has something to say" opener: the open loop the player tapped,
   * threaded as the continue beat's cue line so the character opens about exactly
   * that. Only read for `kind: "continue"`.
   */
  cue?: string;
  /**
   * Reopen-opener initiative — `continue` only: the
   * character reaches out first with a server-built cue (open loops + wants +
   * the "a life meanwhile" license, comms register when apart). Player-tapped;
   * generation is never background.
   */
  initiative?: boolean;
  /**
   * Action-beat chip — `action_beat` only: the tapped
   * chip id. The server builds a register-aware synthetic cue for it and applies the
   * chip's deterministic state effect to the primary's drifted state pre-narration —
   * so the reply reflects the shift — rollback-safe via the pre-exchange snapshot. No
   * player line is persisted; the id rides the reply's `meta.actionBeat`.
   */
  action?: ChatActionId;
  /**
   * Player-attached photo ids — `send` only. Validated +
   * claimed against this chat's ready `chat_upload` rows (foreign ids dropped), then
   * described by ONE batched vision call whose output rides the user line's meta.
   */
  attachmentIds?: readonly string[];
  /**
   * "Auto at big moments" hook: fired fire-and-forget after the finalizer
   * when the exchange landed a stage crossing / strong reaction AND the chat's
   * `sceneAuto` mode is "milestones". The route owns what happens (queue a scene
   * render anchored to this reply) — the engine only signals.
   */
  onBigMoment?: (info: { assistantMessageId: string }) => void;
  /**
   * Selfie hook: fired fire-and-forget after the finalizer
   * when the reply actually sent a photo (pulse-read + gate-armed). The route
   * queues the selfie render anchored to this reply. `characterId` names the
   * SENDER: in a group the addressed member sends it, so
   * the render must use that character, not always the primary.
   */
  onSelfie?: (info: { assistantMessageId: string; characterId: string }) => void;
  /**
   * Post-settle hook (the successor shadow leg): fired fire-and-forget
   * after the finalizer on EVERY successfully settled exchange. The route owns
   * what happens (the shadow comparison leg for `successor_shadow` chats); the
   * engine only signals. `content` is the player's line ("" for synthetic-cue
   * kinds) so the consumer never re-reads the transcript for it.
   */
  onSettled?: (info: { assistantMessageId: string; content: string }) => void;
  /**
   * Contact-turn observer: fired once, AFTER the physical-guidance block for this
   * exchange is rendered and BEFORE the reply streams, with what the narrator was
   * actually told about the player's physical act.
   *
   * It exists because the turn's guidance is deliberately not persisted — it is
   * recomputable from the same cut and the same message, which is what makes a
   * retake reproduce it. That equivalence holds only BEFORE the exchange folds
   * its commits, so a trial that re-derived the guidance afterwards would be
   * reading it against state the turn had already changed. Anything grading a
   * live romantic turn has to see the bytes the model saw, at the moment it saw
   * them.
   *
   * Read-only and fire-and-forget, like the other hooks here: a throwing observer
   * is logged and swallowed, never allowed to cost the exchange.
   */
  onContactTurn?: (record: ChatContactTurnRecord) => void;
  /**
   * Diagnostics observer: every diagnostic this exchange files is teed here as it
   * is pushed, alongside the pipeline's own collector (which still drives the
   * summary log line). The turn's degradation record is otherwise write-only —
   * the engine logs the codes and drops the sink — so this is the first-class
   * seam for the admin inspector and for integration tests that must assert a
   * live turn's codes rather than scraping the log.
   *
   * Diagnostics accrue through the settle step, which runs when the reply stream
   * completes: a caller reading this sink must drain `result.stream` first, or it
   * sees only the pre-stream half of the turn.
   */
  sink?: DiagnosticSink;
}

export type SubmitChatMessageResult =
  | {
      ok: false;
      code: "chat_busy" | "nothing_to_regenerate" | "invalid_rerun_target" | "rerun_requires_branch";
      message: string;
    }
  | { ok: true; stream: AsyncGenerator<string, void, unknown> };

/** A synthetic, non-persisted cue that gives the model a turn to respond to when the character opens the scene. */
const OPENING_CUE = "(Open the scene. Speak first, in character.)";
/** Synthetic cue for a "go on" continue beat — never persisted into history. */
const CONTINUE_CUE = "(Continue naturally from your last line — one more beat. Do not repeat yourself, and do not speak for the player.)";

/**
 * Arousal at/above which the beat counts as an "active intimate frame" for the check-in
 * gate (deliverable D), even absent an intimate cue in this exact input — the arousal
 * meter's "visibly affected" threshold (contracts/meters/registry.ts).
 */
const INTIMATE_AROUSAL_FLOOR = 0.55;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

/**
 * Run one chat exchange. Returns `chat_busy` if a reply is still streaming for this
 * chat (without the lock, two concurrent submits each load +
 * drift the same state row and the finalizers land last-write-wins). On success the
 * returned generator streams reply tokens; when it is drained to completion — the
 * route keeps draining even after a client disconnect (docs/resilience.md §5) — the
 * reply persists, the post-turn fan-out runs, and the exchange lock releases. The
 * lock is released on every path (including an assembly throw before streaming).
 */
export async function submitChatMessage(input: SubmitChatMessageInput): Promise<SubmitChatMessageResult> {
  const { chatId, memoryGroupId, kind } = input;
  const { id: characterId, name: characterName } = input.character;
  const lockKey = chatExchangeLockKey(chatId);

  let releaseChatLock!: () => void;
  const chatLockGate = new Promise<void>((resolve) => {
    releaseChatLock = resolve;
  });
  // Rerun is the ONE kind that reconciles with an in-flight reply instead of
  // bouncing off it (data-loss-rerun fix): stop that reply so its exchange settles
  // and drops the lock, then wait a bounded window to re-acquire — re-issuing the
  // stop on each poll so a reply that only just registered its abort is still cut.
  // Every other kind takes the immediate non-blocking lock (a 409 on contention).
  // Nothing in the transcript is touched until the lock is held (prepareExchange),
  // so a rerun that can't re-acquire returns chat_busy with the transcript intact.
  let chatLock: Promise<void> | null;
  if (kind === "rerun") {
    const acquired = await acquireKeyedLockWithin(lockKey, () => chatLockGate, {
      timeoutMs: input.rerunLockWaitMs ?? CHAT_RERUN_LOCK_WAIT_MS,
      onAttempt: () => void stopChatReply(chatId),
      label: CHAT_LOCK_LABEL_REPLY,
    });
    chatLock = acquired?.held ?? null;
  } else {
    chatLock = tryKeyedLock(lockKey, () => chatLockGate, CHAT_LOCK_LABEL_REPLY);
  }
  if (chatLock === null) {
    return { ok: false, code: "chat_busy", message: "a reply is still streaming for this chat; wait for it to finish" };
  }
  void chatLock; // resolves via releaseChatLock; never rejects

  try {
    return await prepareExchange();
  } catch (err) {
    releaseChatLock();
    throw err;
  }

  /** Pre-turn assembly: user line → window/summary → drift → recall → prompt → model stream. */
  async function prepareExchange(): Promise<SubmitChatMessageResult> {
    // The pipeline keeps its own collector (the summary log below reads `.items`)
    // and tees to the caller's observer when one was passed — so threading a sink
    // in adds a reader without changing what the turn records.
    const collected = new DiagnosticCollector();
    const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;

    // --- Resolve the exchange's rows per kind -------------------------------
    // send: mint + insert the user guard row and a fresh assistant row id.
    // open/continue: no user line; fresh assistant row id, no guard.
    // regenerate: reuse the LAST assistant row (its id is the provenance anchor);
    //   its prompting user line (when one exists) becomes the guard + player text.
    let promptMessageId: string | null = null;
    let playerContent = "";
    let assistantMessageId = newId();
    /** The synthetic cue appended to history when there is no player line this turn. */
    let syntheticCue: string | null = null;
    /** For regenerate: the current (soon-to-be-old) reply text on the row. */
    let regenerateTarget: { id: string; content: string; narratorRun?: NarratorRunProvenance } | null = null;
    let effectiveKind: ChatExchangeKind = kind;
    /** For rerun: the assistant successors deleted this exchange (their memory is retracted). */
    let rerunDeletedAssistantIds: string[] = [];
    /**
     * For rerun: true only when the rerun deleted the latest reply — the exchange the
     * stored anchor belongs to. A failed-reply rerun (no successors: the reply never
     * persisted, so the exchange never settled) leaves this false — state never
     * advanced and the anchor still belongs to the PREVIOUS exchange, so restoring it
     * would double-roll-back.
     */
    let rerunSnapshotApplies = false;
    /** Attached photos on this exchange's prompting line. */
    let attachmentFiles: { id: string; path: string }[] = [];
    let attachmentDescriptions: string[] | null = null;
    /** Narrator-mode input: the line is story narration, not the player's POV. */
    let narratorInput = kind === "send" && input.inputMode === "narrator";
    /**
     * For an action beat: the tapped chip. Set for a fresh
     * `action_beat`, or recovered from the reply's meta when regenerating one. Drives the
     * register-aware cue + the deterministic effect, both applied below once the recent
     * replies (the apart/co-present signal) and the drifted state are in hand.
     */
    let actionBeatId: ChatActionId | null = null;

    switch (kind) {
      case "send": {
        promptMessageId = newId();
        playerContent = input.content ?? "";
        // Claim attachments against this chat's ready uploads BEFORE the insert
        // (anchor_message_id carries no FK, so order is free) — foreign/unknown ids
        // drop silently, and the surviving ids ride the line's meta for the client.
        attachmentFiles = await claimChatAttachments(
          chatId,
          promptMessageId,
          (input.attachmentIds ?? []).slice(0, CHAT_ATTACHMENTS_MAX),
        );
        const sendMeta = {
          ...(attachmentFiles.length ? { attachments: { ids: attachmentFiles.map((f) => f.id) } } : {}),
          ...(narratorInput ? { inputMode: "narrator" } : {}),
        };
        await db()
          .insert(characterChatMessages)
          .values({
            id: promptMessageId,
            chatId,
            role: "user",
            content: playerContent,
            ...(Object.keys(sendMeta).length ? { meta: sendMeta } : {}),
          });
        break;
      }
      case "open": {
        syntheticCue = OPENING_CUE;
        break;
      }
      case "continue": {
        syntheticCue = CONTINUE_CUE;
        break;
      }
      case "action_beat": {
        // No player line: the chip id builds a register-aware cue + a deterministic
        // effect (both applied below). A missing/invalid id degrades to a plain continue.
        actionBeatId = input.action ?? null;
        if (!actionBeatId) {
          syntheticCue = CONTINUE_CUE;
          effectiveKind = "continue";
        }
        break;
      }
      case "regenerate": {
        const target = await lastAssistantMessage(chatId);
        if (!target) {
          releaseChatLock();
          return { ok: false, code: "nothing_to_regenerate", message: "there is no reply to regenerate yet" };
        }
        // `narratorRun` travels with the content it produced: when this take becomes
        // the first browsable historical entry below, it keeps its own provenance.
        regenerateTarget = {
          id: target.id,
          content: target.content,
          ...(target.narratorRun === undefined ? {} : { narratorRun: target.narratorRun }),
        };
        assistantMessageId = target.id;
        const prev = await messageBefore(chatId, target);
        if (prev?.role === "user") {
          promptMessageId = prev.id;
          playerContent = prev.content;
        } else if (target.actionBeat) {
          // The reply being regenerated was an action beat — reproduce its chip so the
          // register cue + deterministic effect land again (state rolls back to the
          // pre-effect snapshot first, so a retake re-applies exactly once, never doubles).
          actionBeatId = target.actionBeat;
          effectiveKind = "action_beat";
        } else {
          // The reply being regenerated was itself an opening/continue beat.
          syntheticCue = prev ? CONTINUE_CUE : OPENING_CUE;
          effectiveKind = prev ? "continue" : "open";
        }
        break;
      }
      case "rerun": {
        // Atomic snip (data-loss-rerun fix): under the lock we already hold, validate
        // and delete ONLY the target's successors in one transaction — nothing is
        // modified if the target is missing / not a player line. The target row itself
        // is reused as the prompt guard, never deleted or re-inserted. From here a rerun
        // behaves exactly like `send` (fresh assistant id, pulse runs, guarded persist);
        // effectiveKind stays "rerun" — neither "open" nor "continue" — so the
        // `opening`/`skipPulse` flags below both stay false.
        const resolved = await resolveRerunTarget(chatId, input.targetMessageId);
        if (!resolved.ok) {
          releaseChatLock();
          return { ok: false, code: resolved.code, message: resolved.message };
        }
        promptMessageId = resolved.target.id;
        playerContent = resolved.target.content;
        rerunDeletedAssistantIds = resolved.deletedAssistantIds;
        rerunSnapshotApplies = resolved.deletedAssistantIds.length > 0;
        // Snipped user lines take their attached photos with them — player content,
        // never Gallery survivors. Fire-and-forget: the transcript rows are already gone.
        if (resolved.deletedIds.length) void deleteChatUploads(chatId, resolved.deletedIds);
        break;
      }
    }

    // --- Attached photos -----------------------------------------------------
    // Regenerate/rerun reuse the prompting line's stored attachments (+ any stored
    // vision read); a fresh send described them here. ONE batched vision call per
    // message, persisted onto the line's meta so a retake never re-spends — but a
    // DEGRADED read is deliberately not persisted, so a later retake retries it.
    if (promptMessageId && kind !== "send") {
      const stored = await loadMessageAttachments(chatId, promptMessageId);
      attachmentFiles = await chatAttachmentPaths(chatId, stored.ids);
      // A stored read only holds if every attachment still resolves — else re-describe.
      attachmentDescriptions =
        stored.descriptions && attachmentFiles.length === stored.ids.length ? stored.descriptions : null;
      // A regenerate/rerun of a narrator-mode line keeps its register (the stored meta).
      narratorInput = stored.narrator;
    }
    if (attachmentFiles.length && !attachmentDescriptions) {
      const read = await describeChatPhotos({ files: attachmentFiles, sink });
      attachmentDescriptions = read.descriptions;
      if (!read.degraded && promptMessageId) {
        await db()
          .update(characterChatMessages)
          .set({ meta: { attachments: { ids: attachmentFiles.map((f) => f.id), descriptions: read.descriptions } } })
          .where(and(eq(characterChatMessages.id, promptMessageId), eq(characterChatMessages.chatId, chatId)));
      }
    }

    const opening = effectiveKind === "open";
    await db().update(characterChats).set({ lastMessageAt: new Date() }).where(eq(characterChats.id, chatId));

    /**
     * The exchange's rollback guard — the SAME id the state and scenario anchors take
     * (`finalizeChatState`'s `promptMessageId`), which is what lets a store recognize a
     * retake and recompute from the identical pre-exchange point instead of advancing
     * twice. Both halves are settled by the kind switch above, so it is hoisted here:
     * the contact ledger's retake delete runs beside the scenario rollback below, long
     * before the recognition memory reads it.
     */
    const exchangeGuardMessageId = promptMessageId ?? assistantMessageId;

    // --- State: load (or roll back), then drift -----------------------------
    // Regenerate restores the pre-exchange snapshot so the old take's
    // drift + pulse effects don't double-apply, and retracts the old take's
    // extracted memory so it can't prime the new one. A missing
    // snapshot degrades to no-rollback with a diagnostic — never a failed reply.
    // Restore the pre-exchange snapshot, or degrade to the current live state with a
    // diagnostic when no snapshot was recorded. Shared by regenerate and an
    // applicable rerun. A found `state: null` means the anchor was `{}` — a first
    // exchange with no prior state — so drift re-seeds from the authored defaults below,
    // exactly as the original first exchange did.
    const restoreOrDegrade = async (targetCharacterId: string): Promise<ChatState | null> => {
      const restored = await loadPreExchangeState(chatId, targetCharacterId);
      if (restored.found) return restored.state;
      sink.push(
        diag("warn", "chat_state.snapshot.missing", "no pre-exchange snapshot; regenerating without state rollback"),
      );
      return loadChatState(chatId, targetCharacterId, sink);
    };

    let storedState: ChatState | null;
    if (regenerateTarget) {
      storedState = await restoreOrDegrade(characterId);
      await reconcileMessageMemory(regenerateTarget.id, sink);
    } else if (kind === "rerun" && rerunSnapshotApplies) {
      // A successful rerun is necessarily the latest exchange: older targets are
      // rejected before mutation because this one-exchange anchor cannot restore them.
      // (A failed-reply rerun — no successors — skips the restore entirely: that
      // exchange never settled, so the live state IS the correct starting point.)
      storedState = await restoreOrDegrade(characterId);
      // Retract the extracted memory of every assistant reply this rerun deleted,
      // like regenerate does for the single old take.
      for (const deletedId of rerunDeletedAssistantIds) {
        await reconcileMessageMemory(deletedId, sink);
      }
    } else {
      storedState = await loadChatState(chatId, characterId, sink);
    }

    const profile = parseOr(
      characterProfileSchema,
      input.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const now = new Date();
    // Owner id hoisted above the state seed: resolveSeededOutfit swaps the seeded
    // outfit marker (raw item ids — also persisted verbatim by pre-fix rows) for
    // the readable garment phrase before the narrator or archivist see it.
    const owner = await chatOwnerId(chatId);

    // --- The exchange's narrator instructions --------------------------------
    // ONE instruction source, resolved here and frozen for the whole exchange.
    // "Here" is load-bearing twice over: the exchange lock is already held (this
    // whole function runs inside it), and no narrator prompt has been built yet, so
    // an owner saving revision N+1 in another browser tab while this reply streams
    // cannot reach the reply being written — nothing downstream re-reads the
    // template. Absent selection ⇒ production, byte-identical to the pre-Lab build.
    //
    // The sink is the turn's own, so a template that has been deleted or whose
    // revision will not load lands `narrator_prompt_override_unavailable` in this
    // exchange's diagnostics like every other degradation. The resolver never
    // throws: a prompt experiment can never dead-end a conversation.
    const instructionSource = await resolveNarratorInstructionSource(owner, chatId, sink);

    // --- The chat-wide scenario (followups ruling 8) --------------------------
    // Loaded once per exchange; regenerate/rerun roll it back with the state
    // (the clock tick, skip-note clear, scene merge and callback burn all undo —
    // but never the supporting cast; see rollbackScenario).
    let storedScenario = await loadChatScenario(chatId, sink);
    if (regenerateTarget || (kind === "rerun" && rerunSnapshotApplies)) {
      const anchor = await loadPreExchangeScenario(chatId);
      if (anchor) storedScenario = rollbackScenario(anchor, storedScenario);
      // The discarded take's contact ledger goes with its projection (romantic-contact
      // continuation 1). `rollbackScenario` restores the pre-exchange SCENE — the
      // active-contact projection housed in it — so the durable events that produced
      // the projection being thrown away have to go too, or the ledger would replay a
      // contact the scene no longer holds. Keyed by the exchange guard, which is the
      // same id the new take will write under: a retake that re-commits the same touch
      // re-inserts it, and one that does not leaves nothing behind.
      //
      // UNCONDITIONAL — deliberately outside the `CHAT_CONTACT_ACTIONS` gate. Pruning
      // the durable rows of a take that is being thrown away is hygiene of state that
      // already exists, not new behavior, so it does not belong to the flag that
      // decides whether new contact is produced. Gated, an on→off→retake sequence
      // would roll the projection back and strand the discarded take's rows under the
      // very key the next take writes — which the append's verification would then
      // read as a real divergence. A chat that never recorded a contact deletes zero.
      //
      // Contact-ledger cleanup below remains best-effort, but permission cleanup
      // cannot be: a stranded discarded grant would authorize later turns. The
      // permission prune therefore retries and refuses this retake if it still
      // cannot commit.
      // The discarded take's PERMISSION rows go with its contact rows:
      // the projection is a fold over these rows, so pruning them
      // IS the restoration — a discarded reply's grant, denial, or withdrawal
      // must not survive into the replacement take. UNCONDITIONAL like every
      // prune in this block, and for the same reason: hygiene of state that
      // already exists, never gated on the flag that produces new events.
      //
      // A stranded discarded grant can become authority again on a later turn.
      // Remove both possible guards in ONE SQL statement and refuse the retake
      // if it cannot commit; no replacement reply may land over permission
      // state that still belongs to the take it replaced.
      try {
        await deleteChatPermissionEventsForGuards(
          chatId,
          assistantMessageId === exchangeGuardMessageId
            ? [exchangeGuardMessageId]
            : [exchangeGuardMessageId, assistantMessageId],
        );
      } catch (error) {
        log.error("engine.chat", "chat permission ledger rollback failed", { error: describeError(error) });
        sink.push(
          diag(
            "error",
            CHAT_PERMISSION_ROLLBACK_FAILED,
            "discarded take's permission rows could not be removed; the retake is refused",
            { path: "chat.permission.rollback", context: { chatId } },
          ),
        );
        throw error;
      }
      try {
        await deleteChatContactEventsForGuard(chatId, exchangeGuardMessageId);
        // The discarded take's REPLY-SIDE rows — the NPC-authored endings — hang
        // off the assistant row rather than the exchange guard (chat-contact-reply.ts),
        // and a regenerate reuses that row in place, so no FK cascade prunes them.
        // The scenario rollback above restored the pre-ending projection; the rows
        // that produced the discarded ending must go with it, or the new take's
        // reply-side append would verify against another take's record. (A rerun
        // needs no such delete: it DELETES its assistant successors, and the guard
        // column's FK cascades their rows.)
        if (assistantMessageId !== exchangeGuardMessageId) {
          await deleteChatContactEventsForGuard(chatId, assistantMessageId);
        }
        // The discarded take's DECISION ENVELOPE goes with its reply-side rows
        // (actor-control step 3). It is keyed by the assistant row a regenerate
        // reuses IN PLACE, so no FK cascade prunes it, and the guarded
        // transaction's predicate 3 would refuse the regenerated take's new
        // envelope forever while the old tombstone held the unique key.
        // UNCONDITIONAL like both contact prunes above — no flag checks —
        // because pruning the durable record of a discarded take is hygiene of
        // state that already exists, and an on→off→retake sequence must not
        // strand it. (A rerun's deleted assistant successors cascade their
        // envelopes via the FK; deleting zero rows here is the ordinary answer.)
        await deleteChatNpcSceneDecision(chatId, assistantMessageId);
      } catch (error) {
        log.error("engine.chat", "chat contact ledger rollback failed", { error: describeError(error) });
      }
    }
    const preExchangeScenario = storedScenario;
    const baseScenario = storedScenario ?? seedChatScenario(profile);
    // ONE story clock, ticked once per exchange (never per member).
    const tickedClock = baseScenario.clockMinutes + CHAT_TICK_MINUTES;

    let driftedState = driftChatState(
      await resolveSeededOutfit(storedState ?? seedChatState(profile), owner, profile, sink),
      profile,
      { advance: true, clockMinutes: tickedClock },
    );

    // --- Scene memory: deterministic movement switch (pre-prompt) ------------
    // A movement/arrival in the player's input switches the current place BEFORE the prompt
    // builds, so THIS turn's Scene injection is right (a stub place is minted on first
    // mention); the archivist reconciles the rest post-turn. "Just changed" = a new current
    // place this turn, or a pending time skip (both call for re-establishing the setting once).
    const movedTo = playerContent ? detectSceneMovement(playerContent) : null;
    const preSceneCurrent = baseScenario.sceneMemory.current;
    const nextSceneMemory = movedTo ? switchScenePlace(baseScenario.sceneMemory, movedTo) : baseScenario.sceneMemory;
    const sceneChanged =
      (Boolean(nextSceneMemory.current) && !samePlaceName(preSceneCurrent, nextSceneMemory.current)) ||
      Boolean(baseScenario.pendingSkipNote);
    let scenario: ChatScenario = { ...baseScenario, clockMinutes: tickedClock, sceneMemory: nextSceneMemory };

    // --- Window + summary ----------------------------------------------------
    const summaryState = await loadChatSummary(chatId);
    const history = await loadVerbatimWindow(chatId, summaryState?.watermark ?? null);
    // The regenerated reply must not see itself: it is the newest message, so it
    // is the window's last row — drop it (its prompting user line stays).
    if (regenerateTarget && history.length && history.at(-1)?.role === "assistant") history.pop();

    if (history.length >= CHARACTER_CHAT_SUMMARIZE_AT * 2) {
      void enqueueChatSummary({ chatId });
    }

    // Who the player is in THIS chat: the chat's own
    // persona pick, else the owner's default, else their account name — so the
    // character addresses someone by name instead of a faceless "the user".
    const player = await resolveChatPersona({ ownerId: owner, chatId });

    // What the post-turn agents read as the player's turn: the message plus a
    // clearly-labeled note of what the attached photos showed — so a shown photo
    // can be classified (a gift, a confidence) and filed as ordinary perceived
    // facts. Prompt-side the photos ride their own tail block; never persisted.
    const describedPlayerContent = attachmentDescriptions?.length
      ? `${playerContent}\n\n[${player.name} attached ${attachmentDescriptions.length === 1 ? "a photo" : `${attachmentDescriptions.length} photos`} — as ${characterName} sees ${attachmentDescriptions.length === 1 ? "it" : "them"}: ${attachmentDescriptions.map((d, i) => `(${i + 1}) ${d}`).join(" ")}]`
      : playerContent;
    // Narrator-mode input: label the player half so the
    // post-turn agents read it as authored story events, never the player's own
    // speech/act. Prompt-side the wrap is `wrapNarratorInput` on the history line.
    const agentPlayerContent =
      narratorInput && playerContent
        ? `[${player.name} wrote this as STORYTELLER NARRATION — story events, not ${player.name}'s own words or actions]\n${describedPlayerContent}`
        : describedPlayerContent;

    // --- Ensemble roster -----------------------------------------------------
    // The members beyond the primary: load each one's state (seeding from their
    // authored defaults like a fresh 1-on-1), and tick ONLY present members —
    // presence gating the advance IS the away-freeze.
    const ensembleActive = (input.roster?.length ?? 0) > 1;
    const others = ensembleActive
      ? await Promise.all(
          (input.roster ?? [])
            .filter((m) => m.characterId !== characterId)
            .map(async (member) => {
              const memberProfile = parseOr(
                characterProfileSchema,
                member.profile ?? {},
                emptyCharacterProfile(),
                undefined,
                "characters.profile",
              );
              // Regenerate/rerun is roster-wide: every participant restores the same
              // exchange boundary before any drift or member-specific fan-out can run.
              const storedMember =
                regenerateTarget || (kind === "rerun" && rerunSnapshotApplies)
                  ? await restoreOrDegrade(member.characterId)
                  : await loadChatState(chatId, member.characterId, sink);
              const preExchangeState = storedMember;
              const seededMember = storedMember ?? seedChatState(memberProfile);
              const resolved = await resolveSeededOutfit(seededMember, owner, memberProfile, sink);
              const state = driftChatState(resolved, memberProfile, {
                advance: resolved.presence === "present",
                clockMinutes: tickedClock,
              });
              return {
                characterId: member.characterId,
                memoryGroupId: member.memoryGroupId,
                name: member.name,
                profile: memberProfile,
                preExchangeState,
                state,
              };
            }),
        )
      : [];

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
    const memberWardrobe = async (member: (typeof others)[number]): Promise<ResolvedChatWardrobe> => {
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

    // --- Affectionate contact (`CHAT_CONTACT_ACTIONS`, default OFF) ----------
    // The deterministic contact leg: end what this exchange ended, seed the
    // scene, fold the
    // movements the player wrote — a departure widening the distance and ending what
    // it separated, then an approach closing it — detect a plainly affectionate
    // hand-touch on a present roster member, resolve it against the scene owner's
    // reach and support reads, and — only if it is committable — fold it into the
    // active-contact projection and write the durable event before anything reaches
    // the prompt.
    //
    // Gated on THIS flag alone. Detection, the commit, the ledger row, and the scene
    // projection are authoritative state that must roll back with the exchange whether
    // or not any prompt reads them; only the OUTCOME's trip to the narrator waits on
    // `CHAT_PHYSICAL_CONSTRAINTS`, which owns the block it would ride in.
    //
    // **Persist before prompt, atomically, with the ledger as truth.**
    // `contactActionOutcomeStatus` will not say `committed` without an acknowledgment
    // of a durable write, so the append is awaited HERE and the acknowledgment is built
    // from its VERIFIED answer — a failed or mismatched write leaves the outcome
    // `unresolved`, which the seam renders as silence. The rows and the
    // `character_chats.scene` they fold into land in one transaction
    // (`appendChatContactEventsWithScene`), so the projection can no longer survive
    // without its record or the record without its projection. What is left is settle
    // re-writing the same column with the same value at the end of the exchange — a
    // no-op by construction — plus the ordinary rollback story: both halves hang off
    // the one exchange guard, and the retake delete above prunes the events of any take
    // whose projection was discarded.
    //
    // Fenced whole (docs/resilience.md): any failure degrades to no contact, no write,
    // and no outcome — which is the flag-off path — and never costs the exchange.
    let contactActionOutcomes: readonly PhysicalActionOutcome[] = [];
    let currentContactAttempt: { readonly actionId: string; readonly contactId?: string } | undefined;
    let contactUnresolvedPremise: ChatContactUnresolvedPremise | null = null;
    /** The contact-turn record minus its guidance lines — only assembled when observed. */
    let contactTurnFacts: Omit<ChatContactTurnRecord, "guidanceLines"> | null = null;
    // The current-cut coverage reads the contact leg derived, keyed by garment
    // actor. Threaded into the finalizer's `affordanceCoverage` so settlement
    // persists the EXACT objects the contact resolver consumed — never an
    // independent recompute.
    let contactCoverageCaptures: Readonly<Record<string, EffectiveCoverageRead>> = {};
    // The effect proposals this exchange's DURABLE contact derived
    // (`CHAT_CONTACT_EFFECTS`, default OFF). Held
    // here and committed at SETTLE through the body-surface owner transaction
    // inside `finalizeChatState`, never applied pre-prompt: the committed mark
    // becomes observable on the NEXT cut's reads, exactly the law that the
    // result of a proposal cannot be observed in the cut that proposed it.
    let contactEffectProposals: readonly BodyMarkProposal[] = [];
    if (chatContactActionsEnabled()) {
      try {
        const eventRef = chatContactEventRef(exchangeGuardMessageId);
        const storyMinute = Math.max(0, Math.trunc(scenario.clockMinutes));
        // --- The current cut's material answers (the settle-race fix) ----------
        // Coverage is derived from THIS exchange's resolved wardrobes, never read
        // from the previous settle's persisted capture: that capture lands in the
        // post-stream legs, so a touch sent quickly used to find "no capture yet"
        // for a body this very turn had already resolved — and, the mirror
        // hazard, an old capture could describe garments the current wardrobe no
        // longer wears. The affordance read's own capture is reused VERBATIM when
        // one was taken this turn (either guidance flag on), so the contact
        // resolver and the guidance consumers share one object; otherwise the
        // same pure garment stages derive it directly (`chatGarmentCoverageForCut`
        // — no cue selection, no prompt bytes). A derivation failure degrades to
        // `unavailable` for that body — silence with a diagnostic, never a stale
        // capture and never bare skin.
        //
        // The derivation itself is `chatContactMaterialAtCut`, shared with the
        // reply-scene decision leg's POST-settle cut: two different cuts, one
        // derivation, so neither leg can acquire a different answer to "is this
        // body dressed in something nobody modelled".
        //
        // PRESENT members only: an away character is not a body in the room, and the
        // seeded scene must never place one. Each carries their OWN material answer —
        // the current-cut coverage, the worn ids and the free-text look together, so
        // "the wardrobe says nothing is worn" and "nobody staged this wardrobe" stay
        // different answers. Ensemble members resolve their wardrobes HERE (cached,
        // reused by the prompt build below) — the primary-only fix would leave the
        // identical race standing for every named ensemble target.
        const presentMembers = [
          ...(driftedState.presence === "present"
            ? [{ characterId, name: characterName, aliases: profile.aliases, state: driftedState, wardrobe }]
            : []),
          ...(await Promise.all(
            others
              .filter((member) => member.state.presence === "present")
              .map(async (member) => ({
                characterId: member.characterId,
                name: member.name,
                aliases: member.profile.aliases,
                state: member.state,
                wardrobe: await memberWardrobe(member),
              })),
          )),
        ];
        const coverageCaptures: Record<string, EffectiveCoverageRead> = {};
        const contactRoster: ChatContactRosterMember[] = presentMembers.map((member) => {
          const actorId = garmentActorForCharacter(member.characterId);
          const captured =
            member.characterId === characterId && affordanceRead !== null ? affordanceRead.coverage : null;
          const { coverage, material } = chatContactMaterialAtCut({
            store: scenario.garments,
            actorId,
            ...(member.wardrobe.worn === undefined ? {} : { worn: member.wardrobe.worn }),
            visibility: member.wardrobe.partVisibility,
            environment: scenario.environment,
            clockMinutes: scenario.clockMinutes,
            captured,
            freeTextOutfit: member.state.outfit,
            wornItemIds: member.state.wornItemIds,
            sink,
          });
          if (coverage !== null) coverageCaptures[actorId] = coverage;
          return {
            subjectId: affordanceSubjectId(member.characterId),
            name: member.name,
            aliases: member.aliases,
            material,
          };
        });
        contactCoverageCaptures = coverageCaptures;

        // --- The two ends this exchange asserts, BEFORE anything is detected ---
        // A contact is a claim that two surfaces are in contact NOW, and both of these
        // are the world saying they are not:
        //
        // 1. A story-clock SKIP (owner ruling, 2026-07-31): any skip ends every active
        //    contact, reason `separated`. Hours do not pass with a hand left resting
        //    somewhere, and the alternative — carrying a touch across a time jump —
        //    would have the projection assert a contact nobody re-established. The
        //    signal is the scenario's one-shot `pendingSkipNote`, read here BEFORE the
        //    settle-time save consumes it (the skip route stamps it, this exchange is
        //    the one that sees it, and `saveChatScenario` clears it at settle).
        // 2. A place CHANGE this exchange (`movedTo`, the same detection that switched
        //    the scene memory above), reason `scene_changed`. Walking into another room
        //    is leaving the body you were touching behind. This is also the door a
        //    line like "I walk over to her desk" comes through — the contact detectors
        //    read it as furniture and state nothing, while the scene memory reads a
        //    move, and a held touch does not survive the mover either way.
        //
        // Order matters only in that a skip is the stronger, more specific truth: if
        // both fire, the skip empties the projection and the place change finds nothing
        // left to end. Ends are STATE, not attempted actions — they produce no narrator
        // outcome this pass — but they do advance the scene that rides the scenario.
        const endReasons: readonly ContactEndReason[] = [
          ...(scenario.pendingSkipNote.trim().length > 0 ? (["separated"] as const) : []),
          ...(movedTo ? (["scene_changed"] as const) : []),
        ];
        let endedScene = scenario.scene;
        const endedCommits: ContactLifecycleCommit[] = [];
        for (const reason of endReasons) {
          const ended = endAllChatContacts(endedScene, { reason, eventRef, storyTime: storyMinute, sink });
          endedScene = ended.scene;
          endedCommits.push(...ended.commits);
        }
        // --- The same discontinuities clear the pair relations -----------------
        // Owner ruling 2026-08-04: proximity and facing are valid only during
        // CONTINUOUS CO-PRESENCE in one place. Ending the contacts above while
        // keeping the distance is internally contradictory — it says the hand
        // came off AND that the two bodies are still within reach, with nothing
        // having moved. So the skip and the place change clear every pair, and a
        // member this cut says is offstage takes their own relations with them.
        //
        // Cleared is UNKNOWN, never a substituted band, and returning restores
        // nothing: a new distance needs explicit movement or placement evidence,
        // the same bar a first placement clears. The ordinary per-turn clock tick
        // is NOT a discontinuity — minutes passing inside one scene is what a
        // conversation is, and clearing on it would make reach permanently
        // unknown.
        //
        // The away half reads the PRE-prompt cut (last exchange's confirmed
        // presence), which is the cut every touch this exchange resolves
        // against. The reply-scene decision leg does its own post-settle pass for
        // the same rule, so an NPC-authored touch never sees a departure this
        // block could not have known about yet.
        endedScene = chatSceneAfterDiscontinuity(endedScene, {
          wholeScene: endReasons.length > 0,
          awaySubjects: [
            ...(driftedState.presence === "present" ? [] : [affordanceSubjectId(characterId)]),
            ...others
              .filter((member) => member.state.presence !== "present")
              .map((member) => affordanceSubjectId(member.characterId)),
          ],
        });

        // --- The permission owner's read (`CHAT_ROMANTIC_PERMISSION`, OFF) -----
        // Flag ON only: the chat's permission ledger is loaded ONCE per exchange
        // and folded into the active projection, and the resolver derives
        // the REAL policy read for any attempt whose kind requires a
        // grant. For a player attempt every
        // committed ledger event is chronologically effective — they all precede
        // the new attempt — so no cutoff is passed; the pure comparator exists
        // for same-reply ordering and is exercised in its own unit tests. Flag
        // OFF (or a permission-neutral kind) keeps the historical stub verbatim
        // inside the adapter, so today's bytes are untouched.
        let permissionPolicy: ChatContactPolicySource | undefined;
        if (chatRomanticPermissionEnabled()) {
          const permissionProjection = foldChatPermissionProjection(
            await listChatPermissionEvents(chatId, sink),
            sink,
          );
          permissionPolicy = (attempt) =>
            derivePermissionPolicyRead({
              projection: permissionProjection,
              permittedActorId: attempt.permittedActorId,
              grantingTargetId: attempt.grantingTargetId,
              actionKind: attempt.actionKind,
              playerSubjectId: CHAT_CONTACT_PLAYER_SUBJECT,
              attemptActionId: attempt.actionId,
            });
        }

        // The plan runs on the POST-hook scene: a touch this turn is resolved against a
        // world the skip or the room change has already emptied.
        const planned = planChatContactTurn({
          scene: endedScene,
          // The raw player line. An opening/continue beat has none, so nothing is
          // detected — a synthetic cue is not the player's body.
          message: playerContent,
          narratorInput,
          characters: contactRoster,
          eventRef,
          storyTime: storyMinute,
          ...(permissionPolicy === undefined ? {} : { permissionPolicy }),
          sink,
        });

        const { act, resolution } = planned;
        const commit = planned.commit;
        const committed = commit !== null && commit.status === "committed" ? commit : null;
        if (act !== null) {
          currentContactAttempt = {
            actionId: act.actionId,
            ...(committed === null ? {} : { contactId: committed.contact.contactId }),
          };
        }
        // The S3 presentation constraint: a concrete act whose reach the scene
        // could not establish stays `unresolved` — no row, no fold, no
        // acknowledgment — but the guidance block (when `CHAT_PHYSICAL_CONSTRAINTS`
        // is on) gets one typed premise fencing the prose from inventing the landing.
        contactUnresolvedPremise = chatContactUnresolvedPremise({ act, resolution, characters: contactRoster });
        // ONE combined, ordered commit list per exchange — hook ends, then the ends
        // the plan folded from the player's own act (the release's `withdrawn`, then
        // the departure's `separated`), then the touch (with whatever it had to end to
        // make room). The ledger's `sequence` indexes this WHOLE list, so a retry that
        // re-derives it lands on the identical (eventRef, sequence) keys; splitting the
        // exchange into two appends would restart the sequence and collide.
        const commits: readonly ContactLifecycleCommit[] = [
          ...endedCommits,
          ...planned.ended,
          ...(commit === null ? [] : contactCommitEvents(commit)),
        ];
        // The projection this exchange produced, folded before the write so both halves
        // can be handed to one transaction.
        const postScene = committed === null ? planned.scene : withSceneContacts(planned.scene, committed.state);
        let scene = postScene;
        let acknowledgment: ContactPersistenceAcknowledgment | undefined;
        // Whether the ledger ACCEPTED this exchange's rows. Distinct from
        // `acknowledgment`, which additionally requires this turn to have
        // committed a contact of its own: an exchange that only ENDS contacts
        // (a withdrawal) writes real rows and earns no acknowledgment, and
        // conflating the two would report those ends as never having happened.
        let commitsRecorded = commits.length === 0;
        if (commits.length > 0) {
          const appended = await appendChatContactEventsWithScene({
            chatId,
            guardMessageId: exchangeGuardMessageId,
            eventRef,
            storyMinute,
            commits,
            scene: postScene,
          });
          if (appended.status === "recorded") {
            commitsRecorded = true;
            // Only now, and only for a write this turn's own rows are provably part of.
            if (act !== null && committed !== null) {
              acknowledgment = chatContactAcknowledgment({ commit: committed, eventRef, actionId: act.actionId });
            }
          } else {
            // The ledger holds a DIFFERENT record under this exchange's keys, so the
            // transaction rolled back: no rows added, the scene column untouched. The
            // contact projection therefore may not advance past the record it caches —
            // it stays exactly where it loaded, while the seeding and any movement,
            // which the ledger never carried, still ride the scenario. No
            // acknowledgment, so the outcome below resolves `unresolved` (silence).
            scene = withSceneContacts(postScene, scenario.scene.contacts);
            sink.push(
              diag(
                "error",
                CHAT_CONTACT_LEDGER_MISMATCH,
                "contact ledger holds a different record under this exchange's keys; nothing written",
                {
                  path: "chat_contact_events",
                  context: { eventRef, sequences: appended.mismatched.map((key) => key.sequence) },
                },
              ),
            );
          }
        }
        // --- Contact effects (`CHAT_CONTACT_EFFECTS`, default OFF) ------------
        // The pure derivation: committed contact → effect
        // proposal. Gated on the ACKNOWLEDGMENT, not the plan — a proposal may
        // only be derived from a contact the ledger provably recorded, so the
        // rolled-back-append path (no acknowledgment) derives nothing, exactly
        // as it narrates nothing. Contact persists no mark and owns no timer:
        // the proposals ride to `finalizeChatState`, where the body-surface
        // owner validates and commits them into the PRIMARY character's state
        // row — the one surface owner this release implements. A proposal
        // addressed to any other body (the player, an ensemble member) has no
        // implemented destination owner and commits nothing, on the record.
        if (chatContactEffectsEnabled() && acknowledgment !== undefined && committed !== null) {
          const proposals = contactMarkProposals(committed.contact);
          const primarySubject = affordanceSubjectId(characterId);
          contactEffectProposals = proposals.filter((proposal) => proposal.targetSubjectId === primarySubject);
          if (proposals.length > contactEffectProposals.length) {
            sink.push(
              diag(
                "info",
                CONTACT_EFFECT_OWNER_UNAVAILABLE,
                "a contact-effect proposal targets a body with no implemented surface owner; nothing committed",
                {
                  path: "chat.contact_effects",
                  context: { proposed: proposals.length, owned: contactEffectProposals.length },
                },
              ),
            );
          }
        }
        // The seeded scene and any movement the player wrote ride the scenario even
        // when no contact resolved: where the bodies are is true regardless.
        scenario = { ...scenario, scene };
        if (act !== null && resolution !== null) {
          contactActionOutcomes = [
            chatContactActionOutcome({
              act,
              resolution,
              eventRef,
              ...(commit === null ? {} : { commit }),
              ...(acknowledgment === undefined ? {} : { acknowledgment }),
              sink,
            }),
          ];
        }
        // The observer's half of the record — everything but the guidance lines,
        // which are rendered further down. Assembled here because this is the only
        // scope holding the act and the fold.
        //
        // DURABILITY IS THE ACKNOWLEDGMENT'S TO REPORT, never the plan's. A
        // planned commit is what the resolver decided; `acknowledgment` is what
        // the ledger accepted, and the two part company on a mismatch — that path
        // rolls the scene back, writes no rows, and withholds the acknowledgment
        // precisely so the outcome resolves to silence. Reporting the plan here
        // would tell a consumer a contact exists that it could not find, and a
        // trial grading narration against it would be grading prose against a
        // contact nobody recorded. `outcomeCommitted` is the same signal the
        // narrator's own action outcome runs on, so the record and the prompt
        // cannot disagree about whether the touch happened.
        if (input.onContactTurn !== undefined) {
          const outcomeCommitted = contactActionOutcomes[0]?.status === "committed";
          const durable = outcomeCommitted && acknowledgment !== undefined ? committed : null;
          contactTurnFacts = {
            ...(act === null
              ? {}
              : {
                  act: {
                    kind: act.actionKind,
                    gesture: act.gesture,
                    targetLocationId: act.targetLocationId,
                    actionId: act.actionId,
                  },
                }),
            ...(resolution === null ? {} : { status: resolution.status }),
            ...(resolution !== null && "reason" in resolution ? { reason: resolution.reason } : {}),
            resultCodes: contactActionOutcomes[0]?.resultCodes ?? [],
            committed: durable !== null,
            ...(durable === null ? {} : { contactId: durable.contact.contactId }),
            ...(durable === null ? {} : { directSkinContact: durable.contact.transmission.directSkinContact }),
            // Ends are reported on the same terms: a rolled-back append ended
            // nothing, however many ends the plan carried into it.
            ended: commitsRecorded
              ? commits
                  .filter((entry) => entry.kind === "contact_ended")
                  .map((entry) => ({ contactId: String(entry.contactId), reason: String(entry.reason) }))
              : [],
            // The premise the narrator was HANDED, which is not the same as the
            // one the seam derived. `CHAT_PHYSICAL_CONSTRAINTS` owns whether
            // these bytes reach the prompt, so with that flag off the premise is
            // computed and then dropped — and reporting it here would tell a
            // trial the prose was fenced when nothing fenced it, which is the
            // exact failure the rerun exists to detect.
            ...(physicalConstraintsEnabled && contactUnresolvedPremise !== null
              ? { premiseKind: contactUnresolvedPremise.kind }
              : {}),
          };
        }
      } catch (error) {
        log.error("engine.chat", "chat contact leg failed", { error: describeError(error) });
      }
    }

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
    const commitRecognitionMemory = async (): Promise<void> => {
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
    };

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
    const commitVisualStateCues = async (): Promise<void> => {
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
    };

    const promptInput: CharacterChatPromptInput = {
      // The exchange's frozen narrator instructions.
      // This object reaches ONLY the three prose-narrator builds below —
      // every helper agent (pulse, extractors, notes, classifiers, scene composer,
      // meanwhile) assembles its own prompt from its own inputs and cannot see it.
      instructionSource,
      name: characterName,
      profile,
      priorSummary: summaryState?.summary,
      memory,
      player: playerPromptSlice(player, playerWardrobe),
      state: promptStateSlice(driftedState, scenario, wardrobe, profile, garmentNarration, bodyCues, visualStateLines),
      opening,
      narrationShape: narrationShapeId("chat"),
      // Chat scene memory: whether the setting changed this exchange (movement / time skip),
      // which flips the Scene block's directive from "don't re-establish" to "establish once".
      sceneChanged,
      // First exchange (no assistant reply yet; regenerating the first reply popped it above):
      // renders the one-turn establish-the-scene directive. Opening beats carry their own
      // scene-opening instruction instead.
      firstExchange,
      // The one-turn memory callback, already ring-burned above.
      callback,
      // Attached photos: the vision read, injected as
      // seen-channel content the perception partition's rule 16 governs.
      attachments: attachmentDescriptions?.length ? { descriptions: attachmentDescriptions } : undefined,
      // One-turn selfie license, armed above; "opener" is
      // the initiative beat's register-conditional arm.
      selfie: selfieRequested ? "request" : selfieOfferEligible ? "offer" : openerSelfieEligible ? "opener" : undefined,
      // One-turn cue invitation, now the continue-cue only: a "has something to say"
      // continue threads its tapped open loop here so the character opens about exactly the
      // right thing. The sensory arms were superseded by `sensoryAllowance` below.
      // The superseded arm (rollback):
      //   cueInvite: cueHint ? chatCueInviteLine(cueHint, characterName) : <the continue arm below>
      cueInvite: initiativeOpener
        ? buildInitiativeCue({
            characterName,
            playerName: player.name,
            openLoops: driftedState.openLoops,
            drives: driftedState.drives,
            skipPending: Boolean(scenario.pendingSkipNote.trim()),
            // Plans near this turn LEAD the opener material: "is
            // tonight still on?" / the cold open after being stood up.
            openPlans: derivePlanSalience(scenario.plans, scenario.clockMinutes, scenario.calendarStart),
            // The unseen shift + the authored daily rhythm.
            recentShift,
            rhythm: formatScheduleRhythm(profile.schedule),
            // Extraversion colors the opener's cadence (eager vs. reticent).
            extraversion: effectiveTraitValue(profile.traits, "social.extraversion"),
            // Off-screen life: established people ground improvised
            // beats, and a meanwhile-pass note REPLACES free invention for this gap.
            cast: scenario.supportingCast
              .slice(0, 3)
              .map((m) => `${m.name}${m.relation ? ` (${m.relation}${m.whereabouts ? ` — ${m.whereabouts}` : ""})` : ""}`)
              .join(", "),
            meanwhile: scenario.pendingMeanwhileNote,
          })
        : effectiveKind === "continue" && input.cue?.trim()
          ? `There is unfinished business you might open about: "${input.cue.trim()}" — bring it up naturally, in your own voice, if the moment allows.`
          : undefined,
      // The deterministic per-turn sensory allowance:
      // one binding line derived from the detectors already running this turn. Only real
      // player turns carry one — opening/continue beats fall to the rules' conservative default.
      sensoryAllowance: playerContent
        ? deriveChatSensoryAllowance({ cue: cueHint, sensoryFocus: sensoryFocus ?? null })
        : undefined,
      sensoryFocus,
      // Reply-discipline gates (deliverable D): hook-cadence + intimate check-in over the last
      // 1–2 assistant replies. Only for real player turns (a beat has no cadence to steer).
      gateNotes: playerContent
        ? buildChatReplyGates({ recentReplies, intimate: intimateBeat, name: characterName })
        : undefined,
      // Derived-fact tail note: the shared span
      // parser reads the current message's markup and renders a comms/OOC one-liner. The
      // raw message is never touched — this only feeds the prompt tail.
      notationNote: playerContent
        ? chatNotationNote(playerContent, { name: characterName, player: player.name, knownNames: [characterName] })
        : undefined,
      // Narrator-mode input: the one-turn tail note that
      // suspends the player-input perception rules for THIS message.
      narratorInput,
      // Physical consistency. Conditional spread,
      // the same discipline the cue block uses: absent when the flag is off, so the
      // prompt is byte-identical to the pre-feature build.
      ...(physicalGuidanceLines.length > 0 ? { physicalGuidance: physicalGuidanceLines } : {}),
    };

    // The relationship matrix: tier-1 pair lines for
    // present×present edges; tier-3 conditional lines for present→away edges
    // whose away endpoint is SALIENT — mentioned within the window (the recency
    // stamp keeps counting for away members) or flagged looming on the edge.
    let ensembleExtras: EnsemblePromptExtras | undefined;
    if (ensembleActive) {
      const matrix = await loadChatRelationships(chatId, sink);
      const membersById = new Map<string, { name: string; presence: ChatState["presence"]; quiet: number }>([
        [characterId, { name: characterName, presence: driftedState.presence, quiet: driftedState.quietExchanges }],
        ...others.map(
          (o) =>
            [o.characterId, { name: o.name, presence: o.state.presence, quiet: o.state.quietExchanges }] as const,
        ),
      ]);
      const pairs: EnsemblePairInput[] = [];
      const awayPairs: EnsemblePairInput[] = [];
      for (const edge of matrix) {
        const from = membersById.get(edge.fromCharacterId);
        const to = membersById.get(edge.toCharacterId);
        if (!from || !to) continue; // an endpoint left the roster — the row is inert
        if (from.presence === "present" && to.presence === "present") {
          pairs.push({ fromName: from.name, toName: to.name, record: edge.record });
        } else if (from.presence === "present" && to.presence === "away") {
          const salient = to.quiet < ENSEMBLE_QUIET_EXCHANGES || edge.record.looming;
          if (salient) awayPairs.push({ fromName: from.name, toName: to.name, record: edge.record });
        }
      }
      // The solo perks' group arms (followups ruling 12): each names the ONE
      // member it aims at, so the frame renders the license in third person.
      ensembleExtras = {
        // The same frozen source the 1-on-1 build gets: an ensemble reply follows the
        // owner's craft instructions while the roster, the presence law and the
        // `[Name]` tag contract stay exactly where they are.
        instructionSource,
        pairs,
        awayPairs,
        ...(selfieRequested
          ? { selfie: { kind: "request" as const, memberName: selfieTargetOther?.name ?? characterName } }
          : selfieOfferEligible
            ? { selfie: { kind: "offer" as const, memberName: characterName } }
            : {}),
        ...(ensembleCallback ? { callback: ensembleCallback } : {}),
        ...(sensoryFocus && sensoryFocusMember
          ? { sensoryFocus: { hint: sensoryFocus, memberName: sensoryFocusMember.name } }
          : {}),
      };
    }

    // The ensemble prompt inputs (roster > 1): the primary first, then the others,
    // each with their own state slice + memory leg and the presence/recency the
    // frame's tier compression keys on.
    const ensemble: EnsembleMemberInput[] | undefined = ensembleActive
      ? [
          {
            name: characterName,
            profile,
            state: promptStateSlice(driftedState, scenario, wardrobe, profile, garmentNarration),
            memory,
            presence: driftedState.presence,
            quietExchanges: driftedState.quietExchanges,
          },
          // Each present member resolves their OWN worn state — same
          // owner library, so the shared loader keys their garments too. Through the
          // shared cache: a member the contact leg already resolved this turn renders
          // from that SAME resolve rather than a second one.
          ...(await Promise.all(
            others.map(async (o) => ({
              name: o.name,
              profile: o.profile,
              state: promptStateSlice(o.state, scenario, await memberWardrobe(o), o.profile),
              memory: otherMemories.get(o.characterId),
              presence: o.state.presence,
              quietExchanges: o.state.quietExchanges,
            })),
          )),
        ]
      : undefined;

    // Prompt layout (default `system_tail`): the
    // experimental `turn_context` layout sends system = stable prefix only and moves the
    // volatile tail + the fenced current input into a final user message (the session
    // lane's shape), so system + history form an append-only cached prefix. Real player
    // turns only — opening/continue beats have no current input to compose around.
    // An ensemble always takes the classic layout (the A/B experiment is 1-on-1-scoped).
    // Narrator-mode lines carry their marker into the MODEL history only (the stored
    // rows stay byte-verbatim) — so past authored narration never re-reads as the
    // player's own words on later turns.
    const markedHistory = history.map((m) =>
      m.role === "user" && m.narrator ? { ...m, content: wrapNarratorInput(m.content, player.name) } : m,
    );
    let system: string;
    let modelHistory: typeof history;
    /**
     * The whole assembled narrator prompt — prefix AND tail, whatever transport
     * each carries. `assembledSystemHash` identifies the assembly, so it must not
     * change meaning when the `turn_context` layout moves the tail beside the
     * player's input; that is a placement decision, not a different prompt.
     */
    let assembledNarratorPrompt: string;
    if (ensemble) {
      const parts = buildChatPromptPartsForRoster(promptInput, ensemble, ensembleExtras);
      system = [parts.prefix, parts.tail].filter(Boolean).join("\n\n");
      assembledNarratorPrompt = system;
      modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
    } else if (chatPromptLayout() === "turn_context" && playerContent) {
      const parts = buildCharacterChatPromptParts(promptInput);
      system = parts.prefix;
      assembledNarratorPrompt = [parts.prefix, parts.tail].filter(Boolean).join("\n\n");
      // The window's last entry is the current player message (inserted before the window
      // loaded); it moves into the composed final message, so drop it from what we send.
      const priorHistory = markedHistory.at(-1)?.role === "user" ? markedHistory.slice(0, -1) : markedHistory;
      modelHistory = [
        ...priorHistory,
        {
          role: "user" as const,
          content: buildChatTurnMessage(
            parts.tail,
            narratorInput ? wrapNarratorInput(playerContent, player.name) : playerContent,
            player.name,
          ),
        },
      ];
    } else {
      system = buildCharacterChatSystemPrompt(promptInput);
      assembledNarratorPrompt = system;
      modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
    }

    /**
     * The classified node trees behind the prompt just built — the provenance's
     * per-authority weights and, on production, the hash of the instruction text a
     * test prompt would have replaced. Rebuilt rather than threaded because the
     * builders own the byte-pinned assembly and must keep owning it; this is a pure
     * tree walk with no IO, and it runs once, only on a reply that actually settled.
     */
    const narratorPromptNodes = (): readonly NarratorPromptNode[] => {
      const nodes = ensemble
        ? buildEnsembleChatPromptNodes(promptInput, ensemble, ensembleExtras)
        : buildCharacterChatPromptNodes(promptInput);
      return [...nodes.prefix, ...nodes.tail];
    };

    const abortController = new AbortController();
    // How the narrator generation actually finished (server/ai/narrator-completion.ts).
    // Set once, by the stream itself, when it runs to its own end — so a zero-text
    // exchange can be classified from real evidence instead of "no text and no
    // exception". Stays null on a player Stop or a watchdog trip, which own their
    // verdicts already.
    let narratorCompletion: NarratorCompletion | null = null;
    const gen = streamCharacterChat({
      system,
      history: modelHistory,
      name: characterName,
      onCompletion: (completion) => {
        narratorCompletion = completion;
      },
      // The reply's name vocabulary (server/ai/narrator-speaker-tags.ts). `speakers` is
      // exactly the renderer's tag vocabulary — the roster the chat bubble passes to the
      // segmenter — so a line-opening `[Name]` stays. Everyone else brackets can reach
      // (the player, the supporting cast) is `plain`: never a tag in ANY position, since
      // a bracketed name the segmenter doesn't know renders literally.
      names: {
        speakers: input.roster?.length ? input.roster.map((r) => r.name) : [characterName],
        plain: [player.name, ...scenario.supportingCast.map((m) => m.name)],
      },
      model: input.model,
      signal: abortController.signal,
    });

    // --- Settle work (runs once the reply has fully streamed) ----------------
    const settle = async (full: string, stopped: boolean): Promise<void> => {
      // What produced THIS take. The completion
      // record is best-effort: a player Stop or a watchdog trip leaves it null, and
      // those fields are then simply absent rather than guessed. The effective model
      // is the one the generation actually ran, not the id the request asked for.
      const narratorRun = buildNarratorRunProvenance({
        lane: "legacy_chat",
        modelId: narratorCompletion?.modelId ?? input.model ?? "",
        source: instructionSource,
        nodes: narratorPromptNodes(),
        assembled: assembledNarratorPrompt,
        ...(narratorCompletion === null
          ? {}
          : {
              attempts: narratorCompletion.attempts,
              finishReason: narratorCompletion.finishReason,
              ...(narratorCompletion.inputTokens === undefined ? {} : { inputTokens: narratorCompletion.inputTokens }),
              ...(narratorCompletion.outputTokens === undefined
                ? {}
                : { outputTokens: narratorCompletion.outputTokens }),
            }),
      });
      // The action-beat chip id rides the reply meta so a later regenerate reproduces
      // the cue + deterministic effect (recovered from the target's meta above).
      // `narratorRun` rides it too: `content` mirrors the active take, so the row's
      // meta is the row-level answer to "which prompt wrote what is showing?" — and
      // it is what the NEXT regenerate seeds the historical take's provenance from.
      const beatMeta = actionBeatId ? { actionBeat: actionBeatId, narratorRun } : { narratorRun };
      const meta = stopped ? { ...beatMeta, stopped: true } : beatMeta;
      if (regenerateTarget) {
        // Update the row in place: the old take stays browsable, the new one is
        // active. Row-existence is the guard — a delete landing
        // mid-stream makes this a no-op.
        const takes = await currentReplyTakes(chatId, regenerateTarget.id);
        if (takes === null) return; // row deleted mid-stream
        const next = pushReplyTake(takes, regenerateTarget.content, full, now.toISOString(), {
          // The take being displaced keeps the run that wrote it; a row from before
          // provenance existed has none, and that take is simply unlabelled.
          ...(regenerateTarget.narratorRun === undefined ? {} : { current: regenerateTarget.narratorRun }),
          fresh: narratorRun,
        });
        await db()
          .update(characterChatMessages)
          .set({ content: full, takes: next, meta })
          .where(and(eq(characterChatMessages.id, regenerateTarget.id), eq(characterChatMessages.chatId, chatId)));
      } else {
        await persistAssistantReply({
          id: assistantMessageId,
          chatId,
          speakerCharacterId: characterId,
          promptMessageId,
          content: full,
          meta,
        });
      }

      // --- NPC reply-scene decision leg: launch (actor-control step 3, SHADOW) --
      // Started HERE — after the reply row is durable, before the state fan-out —
      // so the one classifier call per reply runs BESIDE settlement and is awaited
      // only after the post-settle cut.
      // The digest is assembled from the PRE-settle cut on purpose (prompt-time
      // roster presence, the scene exactly as the player leg left it): the
      // authoritative presence/scene cut is reloaded fresh inside
      // `finishChatNpcSceneDecision`, never carried from here. Empty replies never
      // reach settle, so they never earn an envelope. Mode-gated: with both new
      // flags off the leg does not exist and the legacy reply-side ending block at
      // the settle tail runs byte-identically. Fenced whole (docs/resilience.md):
      // a failed launch leaves the handle null, which routes the tail to the
      // legacy block — the flag-off path — and never costs the settled reply.
      const npcSceneMode = chatNpcSceneDecisionMode();
      let npcSceneDecision: ChatNpcSceneDecisionHandle | null = null;
      if (npcSceneMode !== null) {
        try {
          npcSceneDecision = await beginChatNpcSceneDecision({
            chatId,
            assistantMessageId,
            reply: full,
            mode: npcSceneMode,
            ownerId: owner,
            // Stable roster order — the primary first, then the others exactly as
            // the roster handed them in; the order IS the `npc_N` ref assignment.
            // Each carries its PROFILE, which the post-settle wardrobe resolve a
            // contact start's material read needs — authored identity a settle
            // cannot move, unlike everything else the finish half reloads.
            roster: [
              {
                characterId,
                name: characterName,
                aliases: profile.aliases,
                presence: driftedState.presence,
                profile,
              },
              ...others.map((member) => ({
                characterId: member.characterId,
                name: member.name,
                aliases: member.profile.aliases,
                presence: member.state.presence,
                profile: member.profile,
              })),
            ],
            ...(player.profile === undefined ? {} : { playerPersona: player.profile }),
            scene: scenario.scene,
            sink,
          });
        } catch (error) {
          log.error("engine.chat", "npc scene decision launch failed", { error: describeError(error) });
        }
      }

      if (opening) {
        // Opening beat: fold drift into the state — no fan-out, there was no
        // player act and barely any narrative to archive. Record the surfaced
        // bands so the first real turn doesn't re-announce them, clear the
        // one-shot skip note this beat just rendered, and store the
        // rollback anchor so even an opening beat can be regenerated.
        try {
          const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
          await persistChatState(chatId, characterId, { ...driftedState, surfacedCues });
          await saveChatScenario(chatId, { ...scenario, pendingSkipNote: "", pendingMeanwhileNote: "" });
          await savePreExchangeSnapshot(chatId, characterId, storedState);
          await savePreExchangeScenario(chatId, preExchangeScenario);
        } catch (error) {
          log.error("engine.chat", "chat-state opening persist failed", { error: describeError(error) });
        }
        // An opening beat is a committed exchange with a real prompt, so what the
        // observer noticed on it counts — without this, the first real turn would
        // re-offer the same first-notice cue. The cue state advances with it, for
        // the same reason: an opening beat is a cut the narrator looked at.
        await commitRecognitionMemory();
        await commitVisualStateCues();
        // The common reply-scene leg runs for opening beats too — the opening
        // branch must call the common leg before returning — AFTER the opening's
        // own state and
        // scenario persists above, so the leg's fresh reload IS this beat's
        // settled cut, and it stays the beat's last scene writer (nothing after
        // this return touches the column). Internally fenced; a noop handle
        // (existing envelope) returns immediately, and flags-off leaves the
        // handle null so this line is unreached.
        // An opening beat writes no wardrobe at all, so its settle report is
        // explicitly empty rather than defaulted.
        if (npcSceneDecision !== null) {
          await finishChatNpcSceneDecision(npcSceneDecision, emptyChatNpcSceneSettleReport());
        }
        // The romantic-permission decision leg (permission spec step 3) runs
        // strictly AFTER the beat's last scene writer above: it never writes
        // the scene itself, and its append's withdrawal sweep must read the
        // settled column. Flag-gated and trigger-gated internally; fenced
        // whole — a failure is diagnostics and zero events, never a failed
        // opening beat.
        await runChatRomanticPermissionDecision({
          chatId,
          assistantMessageId,
          reply: full,
          roster: [
            { characterId, name: characterName, aliases: profile.aliases },
            ...others.map((member) => ({
              characterId: member.characterId,
              name: member.name,
              aliases: member.profile.aliases,
            })),
          ],
          sink,
        });
        return;
      }

      // Activity-recency stamping (slice 3, deterministic half): a member is
      // active this exchange when the player's turn named them (name/alias) or
      // the reply gave them a tagged spoken line. Counted for away members too —
      // there it is the tier-3 salience window ("mentioned within K exchanges").
      const primaryQuiet = ensembleActive
        ? mentionsCharacter(agentPlayerContent, characterName, profile.aliases) || spokeInReply(full, characterName)
          ? 0
          : driftedState.quietExchanges + 1
        : driftedState.quietExchanges;

      // Referenced-only pulse scoping (ruling 4): the pulse runs for the members
      // the player's turn addressed by name; when it names NO ONE, the primary —
      // the conversation's anchor — takes the one fallback pulse. Cost tracks the
      // action, never the roster.
      const primaryReferenced =
        !ensembleActive || mentionsCharacter(agentPlayerContent, characterName, profile.aliases);
      const referencedOthers = ensembleActive
        ? others.filter(
            (m) => m.state.presence === "present" && mentionsCharacter(agentPlayerContent, m.name, m.profile.aliases),
          )
        : [];

      // The coverage captures settlement persists: the contact leg's current-cut
      // reads, plus the affordance read's own capture (identical for the primary
      // whenever both exist — the leg reuses the read's object verbatim).
      const settledCoverage: Record<string, EffectiveCoverageRead> = {
        ...contactCoverageCaptures,
        ...(affordanceRead?.coverage
          ? { [garmentActorForCharacter(characterId)]: affordanceRead.coverage }
          : {}),
      };
      try {
        const finalized = await finalizeChatState({
          chatId,
          characterId,
          ownerId: owner,
          memoryGroupId,
          assistantMessageId,
          preExchangeState: storedState,
          // A selfie-armed initiative opener runs the pulse OPENER-scoped for its
          // sentPhoto read (chat-initiative slice 5); every other continue beat
          // still skips it (no player act to react to) — and so does a narrator-mode
          // input (authored story events are not a player act to classify).
          skipPulse:
            (effectiveKind === "continue" && !openerSelfieEligible) ||
            effectiveKind === "action_beat" ||
            narratorInput ||
            (!primaryReferenced && referencedOthers.length > 0),
          pulseScope: openerSelfieEligible ? "opener" : "full",
          promptMessageId: promptMessageId ?? assistantMessageId,
          profile,
          characterName,
          playerName: player.name,
          // The wardrobe pool the archivist's playerOutfit deltas resolve against;
          // undefined when the chat has no persona (the account-name fallback rung).
          playerPersona: player.profile,
          driftedState: ensembleActive ? { ...driftedState, quietExchanges: primaryQuiet } : driftedState,
          now,
          exchange: { player: agentPlayerContent, assistant: full },
          // The recap ledger grounds the memory scribe's fact names.
          priorSummary: summaryState?.summary,
          retrieved: memory,
          // A member-addressed selfie request (ruling 12) never burns the
          // PRIMARY's ring — the member's own settle handles it below. The
          // opener arm counts as an offer (same ring kind, same cooldown).
          selfie: selfieTargetOther
            ? { requested: false, offerEligible: false }
            : { requested: selfieRequested, offerEligible: selfieOfferEligible || openerSelfieEligible },
          scenario,
          preExchangeScenario,
          // The cue memory this exchange's prompt actually surfaced (slice 6) —
          // threaded rather than recomputed, exactly like `surfacedCues` records the
          // bands the narrator SAW. Absent when the flag is off, and the finalizer
          // then leaves the store's mention history untouched.
          ...(garmentNarration ? { garmentCueState: garmentNarration.nextCues } : {}),
          // The affordance cue memory this exchange's prompt surfaced (slice 5) —
          // threaded, never recomputed, for the same reason: it must record the cut
          // the narrator actually saw. Absent when the flag is off, and the finalizer
          // then leaves the scenario's stored memory untouched.
          //
          // Gated on the CUE flag, not on the read existing: `CHAT_PHYSICAL_CONSTRAINTS`
          // and `CHAT_RECOGNITION_CUES` can both make this read exist, and letting one
          // experiment advance another's repeat gate would make both uninterpretable.
          ...(chatAffordanceCuesEnabled() && affordanceRead
            ? { affordanceCueState: affordanceRead.nextCues }
            : {}),
          // The captured effective-coverage read (slice 6): CAPTURED with the
          // presentation cut, not reconstructed later, so narration, body
          // affordances, retakes, and images all share one answer about what is
          // still concealed. Keyed by garment actor handle; absent when this
          // actor's wardrobe is unmodelled. The contact leg's current-cut
          // captures (primary AND ensemble members) merge in under the same key
          // space — the exact objects the contact resolver consumed, threaded
          // rather than recomputed, so what settle persists is what the turn
          // used. When both sources cover the primary they are the identical
          // object by construction.
          ...(Object.keys(settledCoverage).length > 0 ? { affordanceCoverage: settledCoverage } : {}),
          // This exchange's contact-effect proposals (`CHAT_CONTACT_EFFECTS`):
          // derived by the contact leg from the DURABLE committed contact,
          // committed here by the body-surface owner transaction so the mark
          // rides the same state write, rollback snapshot, and retake cut as
          // the wetness it lives beside. Absent (the default) ⇒ the surface
          // fold's result persists untouched, byte-identical to today.
          ...(contactEffectProposals.length > 0 ? { contactMarkProposals: contactEffectProposals } : {}),
          // The ensemble context: the roster line
          // arms the archivist's presence field; every present witness's group
          // gets the same extraction filed as their own memory.
          roster: ensembleActive
            ? [
                { name: characterName, presence: driftedState.presence },
                ...others.map((o) => ({ name: o.name, presence: o.state.presence })),
              ]
            : undefined,
          extraMemoryWrites: ensembleActive
            ? others
                .filter((o) => o.state.presence === "present")
                .map((o) => ({ groupId: o.memoryGroupId, characterId: o.characterId }))
            : undefined,
          sink,
        });
        // The exchange has committed (`finalizeChatState` writes the rollback
        // anchors last, under the same prompting-message guard this uses), so the
        // observer's memory may advance — and only now. PRIMARY only, for the same
        // reason the cue block is: this is the subject the prompt described.
        await commitRecognitionMemory();
        await commitVisualStateCues();
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
        // Fold the members' new looks into the chat-wide garment
        // store. Sequential and after the settle, on the
        // scenario the finalizer just wrote — the members' own `worn_item_ids`
        // columns are already the projection (identical to what went in), so only
        // the store needs the write. Fenced: a failed reconcile costs the store's
        // freshness for these members, never the exchange.
        if (memberWornChanges.length > 0) {
          try {
            const settled = await loadChatScenario(chatId, sink);
            if (settled) {
              const garments = await reconcileActorWardrobes({
                store: settled.garments,
                ownerId: owner,
                atMinutes: settled.clockMinutes,
                changes: memberWornChanges,
                sink,
              });
              await saveChatScenario(chatId, { ...settled, garments });
            }
          } catch (error) {
            log.error("engine.chat", "ensemble garment reconcile failed", { error: describeError(error) });
          }
        }
        // --- The exchange's LAST scene writer ---------------------------------
        // One of two mutually exclusive blocks runs here, and the ordering is
        // the shared invariant: `finalizeChatState` and the garment reconcile
        // above both re-write `character_chats.scene` from the pre-ending
        // projection, so whichever block runs applies AFTER them, against the
        // settled column — nothing later in the exchange touches it, so the
        // ended projection cannot be overwritten by a settle step.
        //
        // With a decision mode on (actor-control step 3), the COMMON REPLY-SCENE
        // LEG takes the slot: it reloads the post-settle cut fresh (assistant
        // bytes, scene column, story minute, roster presence — never this
        // closure's stale `scenario`), awaits the classifier launched beside
        // settlement, evaluates tier-2 candidates DRY (shadow grants no new
        // authority), and records the durable decision envelope — with the
        // frozen floor's ending commits riding the SAME guarded transaction, so
        // the scene changes exactly as the legacy block below would have changed
        // it, atomically with its decision record. Internally fenced: any
        // failure degrades to "no envelope this exchange", never a failed reply.
        //
        // With both new flags off the handle is null and the legacy block runs
        // byte-identically — flag-off behavior is indistinguishable from HEAD.
        if (npcSceneDecision !== null) {
          // The primary's and the player's folds join the members' — every
          // authoritative wardrobe write of this exchange, in one veto set. The
          // reconcile above only MATERIALIZES what these folds decided, so its
          // own pass adds nothing new to report.
          if (finalized.wardrobeChanged.character) wardrobeChanged.add(affordanceSubjectId(characterId));
          if (finalized.wardrobeChanged.player) wardrobeChanged.add(CHAT_CONTACT_PLAYER_SUBJECT);
          await finishChatNpcSceneDecision(npcSceneDecision, { wardrobeChanged });
        } else if (chatContactActionsEnabled()) {
          // --- Reply-side NPC contact ending (chat-contact-reply.ts) ----------
          // The legacy block: the ends and the projection land in one verified
          // transaction under the reply-side event ref, guarded by the assistant
          // row itself: retaking or deleting the reply removes its ending
          // provenance, replaying it lands nowhere, and a conflicting record
          // fails closed with the projection unchanged. Gated on the contact
          // flag with the rest of the leg; fenced whole (docs/resilience.md) —
          // a failed ending costs nothing but itself.
          try {
            const npcRoster: ChatNpcEndingCharacter[] = [
              ...(driftedState.presence === "present"
                ? [{ subjectId: affordanceSubjectId(characterId), name: characterName, aliases: profile.aliases }]
                : []),
              ...others
                .filter((member) => member.state.presence === "present")
                .map((member) => ({
                  subjectId: affordanceSubjectId(member.characterId),
                  name: member.name,
                  aliases: member.profile.aliases,
                })),
            ];
            const ending = detectChatNpcContactEnding({ reply: full, characters: npcRoster });
            if (ending !== null) {
              const replyRef = chatReplyContactEventRef(assistantMessageId);
              const replyMinute = Math.max(0, Math.trunc(scenario.clockMinutes));
              const ended = applyChatNpcContactEnding({
                scene: scenario.scene,
                ending,
                eventRef: replyRef,
                storyTime: replyMinute,
                sink,
              });
              if (ended.commits.length > 0) {
                const appended = await appendChatContactEventsWithScene({
                  chatId,
                  guardMessageId: assistantMessageId,
                  eventRef: replyRef,
                  storyMinute: replyMinute,
                  commits: ended.commits,
                  scene: ended.scene,
                });
                if (appended.status === "recorded") {
                  scenario = { ...scenario, scene: ended.scene };
                } else {
                  sink.push(
                    diag(
                      "error",
                      CHAT_CONTACT_LEDGER_MISMATCH,
                      "reply-side contact ledger holds a different record under this reply's keys; ending not applied",
                      {
                        path: "chat_contact_events",
                        context: { eventRef: replyRef, sequences: appended.mismatched.map((key) => key.sequence) },
                      },
                    ),
                  );
                }
              }
            }
          } catch (error) {
            log.error("engine.chat", "chat reply-side contact ending failed", { error: describeError(error) });
          }
        }
        // --- Romantic-permission decision leg (permission spec step 3) --------
        // Strictly AFTER the exchange's last scene writer (whichever block above
        // ran): the leg never writes the scene column, and its atomic append's
        // withdrawal sweep reads the settled scene fresh inside
        // `appendChatPermissionEventsWithInvalidation` — so running here keeps
        // it clear of the scene CAS. Flag-gated and trigger-gated internally;
        // fenced whole (docs/resilience.md) — any failure is diagnostics and
        // zero permission events, never a failed reply.
        await runChatRomanticPermissionDecision({
          chatId,
          assistantMessageId,
          reply: full,
          roster: [
            { characterId, name: characterName, aliases: profile.aliases },
            ...others.map((member) => ({
              characterId: member.characterId,
              name: member.name,
              aliases: member.profile.aliases,
            })),
          ],
          ...(currentContactAttempt === undefined
            ? {}
            : {
                currentAttemptActionId: currentContactAttempt.actionId,
                ...(currentContactAttempt.contactId === undefined
                  ? {}
                  : { currentAttemptContactId: currentContactAttempt.contactId }),
              }),
          sink,
        });
        // Selfie first (more specific than a big-moment scene — the shared
        // one-live-render-per-chat dedupe keeps only whichever queues first).
        if (finalized.selfieSend) {
          input.onSelfie?.({ assistantMessageId, characterId });
        }
        // "Auto at big moments" (slice 9): opt-in per chat, fire-and-forget — a failed
        // or skipped render never touches the settled reply.
        if (finalized.bigMoment && scenario.sceneAuto === "milestones") {
          input.onBigMoment?.({ assistantMessageId });
        }
        // R4 shadow signal: every settled exchange, unconditional — the route
        // decides whether a shadow leg runs (authority-gated there).
        input.onSettled?.({ assistantMessageId, content: (input.content ?? "").trim() });
      } catch (error) {
        log.error("engine.chat", "chat-state finalize failed", { error: describeError(error) });
      }
      if (collected.items.length) {
        log.info("engine.chat", "chat-state diagnostics", { codes: collected.items.map((d) => d.code) });
      }
    };

    return {
      ok: true,
      stream: streamExchange(gen, {
        chatId,
        settle,
        abortController,
        completion: () => narratorCompletion,
        modelId: input.model ?? "",
        // The coordinator owns the lock; the stream releases it on every terminal path.
        release: releaseChatLock,
      }),
    };
  }
}
