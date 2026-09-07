import { prepareChatTurnRecall, prepareChatTurnBeats, prepareChatTurnPresentation } from "./chat-turn-prepare";
import { commitChatTurnRecognition, commitChatTurnVisualCues, settleChatTurnMembers } from "./chat-turn-settle";
import type { SubmitChatMessageInput, SubmitChatMessageResult } from "./chat-turn-types";
import { prepareChatTurnContact } from "./chat-turn-contact";
import { prepareChatTurnGuidance } from "./chat-turn-guidance";
import { prepareChatTurnPrompt } from "./chat-turn-prompt";
import { and, eq, or } from "drizzle-orm";
import {
  affordanceSubjectId,
  characterProfileSchema,
  contactMarkProposals,
  derivePlanSalience,
  DiagnosticCollector,
  diag,
  effectiveTraitValue,
  emptyCharacterProfile,
  garmentActorForCharacter,
  formatScheduleRhythm,
  samePlaceName,
  splitStateCues,
  switchScenePlace,
  teeSink,
  type ChatActionId,
  type DiagnosticSink,
  type EffectiveCoverageRead,
} from "@/contracts";
import type { NarratorRunProvenance } from "@/contracts/narrator-prompts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";
import type { NarratorCompletion } from "../ai";
import { characterChats, characterChatMessages, db } from "../db";
import { chatAttachmentPaths, claimChatAttachments, deleteChatUploads } from "../images";
import { log } from "../log";
import { resolveChatPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { stopChatReply, streamExchange } from "./chat-reply-stream";
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
import { CHAT_CONTACT_PLAYER_SUBJECT } from "./chat-contact/identity";
import {
  appendChatContactEventsWithScene,
  CHAT_CONTACT_LEDGER_MISMATCH,
  deleteChatContactEventsForGuard,
} from "./chat-contact-events";
import { CHAT_PERMISSION_ROLLBACK_FAILED, deleteChatPermissionEventsForGuards } from "./chat-permission-events";
import {
  beginChatNpcSceneDecision,
  chatNpcSceneDecisionMode,
  emptyChatNpcSceneSettleReport,
  finishChatNpcSceneDecision,
  type ChatNpcSceneDecisionHandle,
} from "./chat-npc-scene-decision";
import { runChatRomanticPermissionDecision } from "./chat-permission-decision";
import { deleteChatNpcSceneDecision } from "./chat-npc-scene-envelope";
import {
  applyChatNpcContactEnding,
  chatReplyContactEventRef,
  detectChatNpcContactEnding,
  type ChatNpcEndingCharacter,
} from "./chat-contact-reply";
import { buildInitiativeCue } from "./chat-initiative";
import { CHAT_ATTACHMENTS_MAX, describeChatPhotos } from "./chat-vision";
import {
  buildChatReplyGates,
  deriveChatSensoryAllowance,
  detectSceneMovement,
  mentionsCharacter,
  spokeInReply,
} from "./chat-intent";
import { reconcileMessageMemory } from "./chat-memory";
import { resolveSeededOutfit } from "./chat-state/outfit-fold";
import {
  driftChatState,
  finalizeChatState,
  seedChatScenario,
  seedChatState,
  type ChatScenario,
  type ChatState,
} from "./chat-state";
import { loadChatScenario, loadChatState, persistChatState, saveChatScenario } from "./chat-state/store";
import {
  loadPreExchangeScenario,
  loadPreExchangeState,
  rollbackScenario,
  savePreExchangeScenario,
  savePreExchangeSnapshot,
} from "./chat-state/snapshots";
import { reconcileActorWardrobes } from "./chat-garments";
import { enqueueChatSummary, loadChatSummary, loadVerbatimWindow } from "./chat-summary";
import { CHARACTER_CHAT_SUMMARIZE_AT, CHAT_TICK_MINUTES, CHAT_RERUN_LOCK_WAIT_MS } from "./constants";
import { acquireKeyedLockWithin, CHAT_LOCK_LABEL_REPLY, chatExchangeLockKey, tryKeyedLock } from "./keyed-lock";
import { chatNotationNote, type CharacterChatPromptInput } from "./prompts/character-chat";
import { chatAffordanceCuesEnabled, chatContactActionsEnabled, narrationShapeId } from "./prompts/constants";
import { chatOwnerId, playerPromptSlice, promptStateSlice } from "./chat-prompt-input";
import type { ChatExchangeKind } from "./chat-turn-types";

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

export type { ChatExchangeKind, ChatContactPremiseKind, ChatContactTurnRecord, SubmitChatMessageInput, SubmitChatMessageResult } from "./chat-turn-types";

/** A synthetic, non-persisted cue that gives the model a turn to respond to when the character opens the scene. */
const OPENING_CUE = "(Open the scene. Speak first, in character.)";
/** Synthetic cue for a "go on" continue beat — never persisted into history. */
const CONTINUE_CUE = "(Continue naturally from your last line — one more beat. Do not repeat yourself, and do not speak for the player.)";

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

    const { queryEmbeddings, memory, otherMemories, cueHint, intimateBeat, recentReplies, sensoryFocus, sensoryFocusMember, primarySensoryFocus, firstExchange } = await prepareChatTurnRecall({
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
    });

    const { driftedState: beatState, syntheticCue: beatCue, selfieRequested, selfieTargetOther, selfieOfferEligible, initiativeOpener, openerSelfieEligible, callback, ensembleCallback, recentShift } = await prepareChatTurnBeats({
      chatId,
      characterName,
      sink,
      memoryGroupId,
      input,
      playerContent,
      syntheticCue,
      effectiveKind,
      attachmentDescriptions,
      narratorInput,
      actionBeatId,
      profile,
      driftedState,
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
    });

    driftedState = beatState;
    syntheticCue = beatCue;

    const { wardrobe, playerWardrobe, memberWardrobe, garmentNarration, affordanceReadInput, physicalConstraintsEnabled, affordanceRead, recognitionPerception, recognition, bodyCues } = await prepareChatTurnPresentation({
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
    });

    const { scenario: contactScenario, contactActionOutcomes, currentContactAttempt, contactUnresolvedPremise, contactTurnFacts, contactCoverageCaptures, contactEffectProposals } = await prepareChatTurnContact({
      chatId,
      characterId,
      characterName,
      sink,
      profile,
      owner,
      driftedState,
      scenario,
      others,
      input,
      playerContent,
      narratorInput,
      exchangeGuardMessageId,
      movedTo,
      wardrobe,
      memberWardrobe,
      physicalConstraintsEnabled,
      affordanceRead,
    });

    scenario = contactScenario;

    const { physicalGuidanceLines, visualStateBuild, visualStateLines, visualStateNarrationOn } = await prepareChatTurnGuidance({
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
    });

    const commitRecognitionMemory = () => commitChatTurnRecognition({ memoryGroupId, owner, characterId, exchangeGuardMessageId, recognition });
    const commitVisualStateCues = () => commitChatTurnVisualCues({ memoryGroupId, owner, characterId, exchangeGuardMessageId, visualStateNarrationOn, visualStateBuild });

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

    const { system, modelHistory, assembledNarratorPrompt, narratorPromptNodes } = await prepareChatTurnPrompt({
      chatId,
      characterId,
      characterName,
      sink,
      profile,
      driftedState,
      scenario,
      others,
      promptInput,
      playerContent,
      syntheticCue,
      narratorInput,
      history,
      player,
      ensembleActive,
      memory,
      otherMemories,
      sensoryFocus,
      sensoryFocusMember,
      selfieRequested,
      selfieTargetOther,
      selfieOfferEligible,
      ensembleCallback,
      wardrobe,
      memberWardrobe,
      garmentNarration,
    });

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
        const { memberWornChanges, wardrobeChanged } = await settleChatTurnMembers({
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
        });

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
