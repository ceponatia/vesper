import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  characterProfileSchema,
  chatActionIdSchema,
  DiagnosticCollector,
  diag,
  effectiveTraitValue,
  emptyCharacterProfile,
  formatScheduleRhythm,
  samePlaceName,
  splitStateCues,
  switchScenePlace,
  unseenMilestoneReason,
  type ChatActionId,
  type ChatReplyFailure,
  type ChatReplyFailureCode,
} from "@/contracts";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { classifyProviderError } from "../ai";
import { characterChats, characterChatMessages, chatParticipants, db, images } from "../db";
import { chatAttachmentPaths, claimChatAttachments, deleteChatAssets, deleteChatUploads } from "../images";
import { log } from "../log";
import { QueryEmbeddings } from "../memory";
import { resolvePlayerPersona } from "../players";
import { streamCharacterChat } from "./character-chat";
import { buildActionBeatCue } from "./chat-action-beat";
import { appendCallbackEntry, chatCallbackEligible } from "./chat-callback";
import { buildInitiativeCue } from "./chat-initiative";
import { loadChatRelationships } from "./chat-relationships";
import { chatSelfieOfferEligible, chatSelfieOpenerEligible, detectSelfieRequest, hasCommsSpans } from "./chat-selfie";
import { CHAT_ATTACHMENTS_MAX, describeChatPhotos } from "./chat-vision";
import {
  buildChatReplyGates,
  // chatCueInviteLine — retired by narrator-prompt-consolidation slice 4 (the sensory-allowance
  // line supersedes its sensory arms); re-import to roll back.
  deriveChatSensoryAllowance,
  detectChatCue,
  detectSceneMovement,
  detectSensoryFocus,
  mentionsCharacter,
  replyEndsInQuestion,
  spokeInReply,
} from "./chat-intent";
import {
  deleteChatMemory,
  reconcileMessageMemory,
  retrieveChatCallback,
  retrieveChatMemory,
  runChatMemoryScribe,
  runChatPersonalNotes,
  writeChatMemory,
} from "./chat-memory";
import {
  applyChatAction,
  driftChatState,
  finalizeChatState,
  loadChatScenario,
  loadChatState,
  loadMilestonesSeenAt,
  loadPreExchangeScenario,
  loadPreExchangeState,
  persistChatState,
  rollbackScenario,
  runChatPulse,
  saveChatScenario,
  saveChatState,
  savePreExchangeScenario,
  savePreExchangeSnapshot,
  resolveSeededOutfit,
  seedChatScenario,
  seedChatState,
  settleEnsembleMember,
  type ChatScenario,
  type ChatState,
} from "./chat-state";
import { resolveChatWardrobe, type ResolvedChatWardrobe } from "./chat-wardrobe";
import { enqueueChatSummary, loadChatSummary, loadVerbatimWindow } from "./chat-summary";
import {
  CHARACTER_CHAT_SUMMARIZE_AT,
  CHAT_TICK_MINUTES,
  CHAT_REPLY_TAKES_CAP,
  CHAT_RERUN_LOCK_WAIT_MS,
  CHAT_STREAM_FIRST_TOKEN_MS,
  CHAT_STREAM_OVERALL_MS,
} from "./constants";
import { acquireKeyedLockWithin, tryKeyedLock } from "./keyed-lock";
import {
  buildCharacterChatPromptParts,
  buildCharacterChatSystemPrompt,
  buildChatPromptPartsForRoster,
  buildChatTurnMessage,
  chatNotationNote,
  wrapNarratorInput,
  ENSEMBLE_QUIET_EXCHANGES,
  type CharacterChatPromptInput,
  type EnsembleMemberInput,
  type EnsemblePairInput,
  type EnsemblePromptExtras,
} from "./prompts/character-chat";
import { chatPromptLayout, narrationShapeId } from "./prompts/constants";

/**
 * The character-chat exchange pipeline (docs/character-chat/pipeline.md) — the chat lane's
 * `submitTurn` analogue (character-chat-standalone.spec.md §3, codebase-review D1).
 * Owns everything between "a validated send arrived" and "the reply stream settled":
 * the per-chat exchange lock, the user-line insert, summary + verbatim-window
 * assembly, state drift, RAG recall, prompt build, the model stream, and the settle
 * work (reply persistence + the post-turn fan-out). The HTTP route stays a thin
 * parse → auth → stream shell. Keyed on the conversation (spec §1): the route
 * resolves chat + participant + character and hands their slices in.
 *
 * Six exchange kinds (spec §4):
 * - **send** — the normal player turn.
 * - **open** — the opening beat ("Prompt character"): no player line, no fan-out.
 * - **continue** — "go on": no player line; the archivist runs (new narrative is
 *   worth remembering) but the reaction pulse is skipped (no player act).
 * - **action_beat** — a tapped action chip (chat-action-beats.plan.md): no player
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
 *   byte-identical. State mirrors regenerate (snapshot rollback when the target is the
 *   last exchange's prompt, else no-rollback + diagnostic); deleted assistant
 *   successors have their extracted memory retracted.
 */

export type ChatExchangeKind = "send" | "open" | "continue" | "action_beat" | "regenerate" | "rerun";

export interface SubmitChatMessageInput {
  /** The conversation (already authorized + not archived — the route owns both checks). */
  chatId: string;
  /** The participant's memory group (spec §1.3) — the RAG scope for recall + writes. */
  memoryGroupId: string;
  /** The (v1 single) participant character row slice. */
  character: { id: string; name: string; profile: unknown };
  /**
   * The full sort-ordered roster (multi-character-chat.plan.md) — the first entry
   * describes the same primary as `character`/`memoryGroupId`. Absent or length 1
   * ⇒ the 1-on-1 path, byte-identical prompts. Length > 1 ⇒ the ensemble frame:
   * per-member state (present members drift, away freeze — ruling 6), tier-1
   * memory legs (ruling 5), and per-member activity-recency stamping post-turn.
   */
  roster?: readonly { characterId: string; memoryGroupId: string; name: string; profile: unknown }[];
  kind: ChatExchangeKind;
  /** The player's line — required for `send`, ignored for the other kinds. */
  content?: string;
  /**
   * Composer register (chat-supporting-cast.plan.md §Narrator input) — `send` only:
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
   * "Has something to say" opener (spec §8.4): the open loop the player tapped,
   * threaded as the continue beat's cue line so the character opens about exactly
   * that. Only read for `kind: "continue"`.
   */
  cue?: string;
  /**
   * Reopen-opener initiative (chat-initiative.plan.md) — `continue` only: the
   * character reaches out first with a server-built cue (open loops + wants +
   * the "a life meanwhile" license, comms register when apart). Player-tapped;
   * generation is never background (D3).
   */
  initiative?: boolean;
  /**
   * Action-beat chip (chat-action-beats.plan.md) — `action_beat` only: the tapped
   * chip id. The server builds a register-aware synthetic cue for it and applies the
   * chip's deterministic state effect to the primary's drifted state pre-narration —
   * so the reply reflects the shift — rollback-safe via the pre-exchange snapshot. No
   * player line is persisted; the id rides the reply's `meta.actionBeat`.
   */
  action?: ChatActionId;
  /**
   * Player-attached photo ids (chat-image-input.plan.md) — `send` only. Validated +
   * claimed against this chat's ready `chat_upload` rows (foreign ids dropped), then
   * described by ONE batched vision call whose output rides the user line's meta.
   */
  attachmentIds?: readonly string[];
  /**
   * "Auto at big moments" hook (slice 9): fired fire-and-forget after the finalizer
   * when the exchange landed a stage crossing / strong reaction AND the chat's
   * `sceneAuto` mode is "milestones". The route owns what happens (queue a scene
   * render anchored to this reply) — the engine only signals.
   */
  onBigMoment?: (info: { assistantMessageId: string }) => void;
  /**
   * Selfie hook (chat-selfies.plan.md): fired fire-and-forget after the finalizer
   * when the reply actually sent a photo (pulse-read + gate-armed). The route
   * queues the selfie render anchored to this reply. `characterId` names the
   * SENDER (followups ruling 12): in a group the addressed member sends it, so
   * the render must use that character, not always the primary.
   */
  onSelfie?: (info: { assistantMessageId: string; characterId: string }) => void;
}

export type SubmitChatMessageResult =
  | { ok: false; code: "chat_busy" | "nothing_to_regenerate" | "invalid_rerun_target"; message: string }
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
// Reply takes (spec §4.1) — alternate generations browsable on the message row
// ---------------------------------------------------------------------------

const replyTakeSchema = z.object({ id: z.string(), content: z.string(), createdAt: z.string() });
export const replyTakesSchema = z.object({
  takes: z.array(replyTakeSchema).catch([]),
  activeId: z.string().catch(""),
});
export type ReplyTakes = z.infer<typeof replyTakesSchema>;

export const emptyReplyTakes = (): ReplyTakes => ({ takes: [], activeId: "" });

/**
 * Record a fresh take (PURE): the row's current content becomes a browsable entry
 * (seeded lazily on the first regenerate), the new take is appended and made
 * active, and the list is capped at CHAT_REPLY_TAKES_CAP — evicting the oldest
 * non-active entries first.
 */
export function pushReplyTake(
  prior: ReplyTakes,
  currentContent: string,
  newContent: string,
  nowIso: string,
): ReplyTakes {
  let takes = [...prior.takes];
  if (takes.length === 0) {
    takes.push({ id: newId(), content: currentContent, createdAt: nowIso });
  }
  const fresh = { id: newId(), content: newContent, createdAt: nowIso };
  takes.push(fresh);
  while (takes.length > CHAT_REPLY_TAKES_CAP) {
    const evictAt = takes.findIndex((t) => t.id !== fresh.id);
    if (evictAt === -1) break;
    takes.splice(evictAt, 1);
  }
  return { takes, activeId: fresh.id };
}

/**
 * Make one recorded take the displayed reply: the row's `content` is updated to
 * mirror it (spec §4.1 — transcript reads stay one-column). Returns the take's
 * content, or null when the message/take doesn't exist. Display-only: state and
 * memory keep reflecting the last GENERATED take (regenerate to re-run effects).
 */
export async function switchReplyTake(chatId: string, messageId: string, takeId: string): Promise<string | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  const takes = parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
  const target = takes.takes.find((t) => t.id === takeId);
  if (!target) return null;
  await db()
    .update(characterChatMessages)
    .set({ content: target.content, takes: { ...takes, activeId: target.id } })
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)));
  return target.content;
}

// ---------------------------------------------------------------------------
// Stop (spec §4.2) — abort the in-flight reply, keep what streamed
// ---------------------------------------------------------------------------

/** In-flight reply aborts by chat id — in-process, like the exchange lock itself. */
const inflightReplyAborts = new Map<string, AbortController>();

/**
 * Cut the in-flight reply short: the model stream aborts server-side, the
 * accumulated prefix persists as the reply (`meta.stopped`), and the fan-out
 * runs over the truncated text. Returns false when nothing is streaming.
 */
export function stopChatReply(chatId: string): boolean {
  const controller = inflightReplyAborts.get(chatId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export interface StreamTimeoutOptions {
  /** No first token within this many ms ⇒ abort (a wedged provider that never speaks). */
  firstTokenMs: number;
  /** The whole stream running past this many ms ⇒ abort (a provider that trickles forever). */
  overallMs: number;
  /** Abort the upstream call (wired to the exchange's AbortController). */
  onAbort: () => void;
  /** Record the watchdog trip (a log/diagnostic); the reply still settles via the stop path. */
  onTimeout?: (reason: "first_token" | "overall") => void;
}

/**
 * Guard a reply token stream with two watchdogs (data-loss-rerun fix): a first-token
 * timeout and an overall cap. On a trip it calls `onAbort` (aborting the upstream call)
 * and ends the stream — the caller's settle path then persists any partial with
 * `meta.stopped` and releases the chat lock, so a hung provider can never wedge the
 * conversation (the Aion 3.0 incident). Passes every token through untouched otherwise;
 * a source that finishes or throws on its own flows through unchanged.
 *
 * PURE + testable: no engine state, just the source generator and the timeout knobs. The
 * lost `next()` after a trip is fire-and-forget-swallowed, and the source is closed
 * fire-and-forget in `finally` — never awaited, so a source that stays wedged even after
 * the abort can't re-hang us here (which would defeat the whole watchdog).
 */
export async function* withStreamTimeouts(
  source: AsyncGenerator<string>,
  opts: StreamTimeoutOptions,
): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  const overallDeadline = Date.now() + opts.overallMs;
  let sawFirstToken = false;
  try {
    for (;;) {
      const overallBudget = overallDeadline - Date.now();
      const budget = sawFirstToken ? overallBudget : Math.min(opts.firstTokenMs, overallBudget);
      const next = iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, budget));
      });
      let result: IteratorResult<string> | "timeout";
      try {
        result = await Promise.race([next, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result === "timeout") {
        opts.onTimeout?.(sawFirstToken ? "overall" : "first_token");
        opts.onAbort();
        // The lost next() settles once the abort lands upstream — swallow it so it can't
        // surface as an unhandled rejection now that we've stopped reading.
        void next.then(
          () => {},
          () => {},
        );
        return;
      }
      if (result.done) return;
      sawFirstToken = true;
      yield result.value;
    }
  } finally {
    // Fire-and-forget close of the source — never blocking on it (a still-wedged provider
    // must not re-hang the watchdog); the abort above already unwinds it.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

/**
 * Run one chat exchange. Returns `chat_busy` if a reply is still streaming for this
 * chat (codebase-review A6 — without the lock, two concurrent submits each load +
 * drift the same state row and the finalizers land last-write-wins). On success the
 * returned generator streams reply tokens; when it is drained to completion — the
 * route keeps draining even after a client disconnect (docs/resilience.md §5) — the
 * reply persists, the post-turn fan-out runs, and the exchange lock releases. The
 * lock is released on every path (including an assembly throw before streaming).
 */
export async function submitChatMessage(input: SubmitChatMessageInput): Promise<SubmitChatMessageResult> {
  const { chatId, memoryGroupId, kind } = input;
  const { id: characterId, name: characterName } = input.character;
  const lockKey = `chat_exchange:${chatId}`;

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
    });
    chatLock = acquired?.held ?? null;
  } else {
    chatLock = tryKeyedLock(lockKey, () => chatLockGate);
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
    const sink = new DiagnosticCollector();

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
    let regenerateTarget: { id: string; content: string } | null = null;
    let effectiveKind: ChatExchangeKind = kind;
    /** For rerun: the assistant successors deleted this exchange (their memory is retracted). */
    let rerunDeletedAssistantIds: string[] = [];
    /** For rerun: whether the pre-exchange snapshot still applies (target was the last exchange's prompt). */
    let rerunSnapshotApplies = false;
    /** Attached photos on this exchange's prompting line (chat-image-input.plan.md). */
    let attachmentFiles: { id: string; path: string }[] = [];
    let attachmentDescriptions: string[] | null = null;
    /** Narrator-mode input (chat-supporting-cast.plan.md): the line is story narration, not the player's POV. */
    let narratorInput = kind === "send" && input.inputMode === "narrator";
    /**
     * For an action beat (chat-action-beats.plan.md): the tapped chip. Set for a fresh
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
        regenerateTarget = { id: target.id, content: target.content };
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
          return { ok: false, code: "invalid_rerun_target", message: resolved.message };
        }
        promptMessageId = resolved.target.id;
        playerContent = resolved.target.content;
        rerunDeletedAssistantIds = resolved.deletedAssistantIds;
        rerunSnapshotApplies = resolved.snapshotApplies;
        // Snipped user lines take their attached photos with them — player content,
        // never Gallery survivors. Fire-and-forget: the transcript rows are already gone.
        if (resolved.deletedIds.length) void deleteChatUploads(chatId, resolved.deletedIds);
        break;
      }
    }

    // --- Attached photos (chat-image-input.plan.md) --------------------------
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

    // --- State: load (or roll back), then drift -----------------------------
    // Regenerate restores the pre-exchange snapshot (spec §4.1) so the old take's
    // drift + pulse effects don't double-apply, and retracts the old take's
    // extracted memory (spec §4.3) so it can't prime the new one. A missing
    // snapshot degrades to no-rollback with a diagnostic — never a failed reply.
    // Restore the pre-exchange snapshot, or degrade to the current live state with a
    // diagnostic when no snapshot was recorded (F3). Shared by regenerate and an
    // applicable rerun. A found `state: null` means the anchor was `{}` — a first
    // exchange with no prior state — so drift re-seeds from the authored defaults below,
    // exactly as the original first exchange did.
    const restoreOrDegrade = async (): Promise<ChatState | null> => {
      const restored = await loadPreExchangeState(chatId, characterId);
      if (restored.found) return restored.state;
      sink.push(
        diag("warn", "chat_state.snapshot.missing", "no pre-exchange snapshot; regenerating without state rollback"),
      );
      return loadChatState(chatId, characterId, sink);
    };

    let storedState: ChatState | null;
    if (regenerateTarget) {
      storedState = await restoreOrDegrade();
      await reconcileMessageMemory(regenerateTarget.id, sink);
    } else if (kind === "rerun") {
      // Mirror regenerate's rollback when the target WAS the last exchange's prompt (its
      // only successor was the newest reply); otherwise the snapshot covers just one
      // exchange and can't roll back a reach-back rerun, so degrade to no rollback.
      if (rerunSnapshotApplies) {
        storedState = await restoreOrDegrade();
      } else {
        sink.push(
          diag(
            "warn",
            "chat_state.rerun.no_rollback",
            "rerun target is not the latest exchange's prompt; regenerating without state rollback",
          ),
        );
        storedState = await loadChatState(chatId, characterId, sink);
      }
      // Retract the extracted memory of every assistant reply this rerun deleted
      // (spec §4.3 — provenance), like regenerate does for the single old take.
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

    // --- The chat-wide scenario (followups ruling 8) --------------------------
    // Loaded once per exchange; regenerate/rerun roll it back with the state
    // (the clock tick, skip-note clear, scene merge and callback burn all undo —
    // but never the supporting cast; see rollbackScenario).
    let storedScenario = await loadChatScenario(chatId, sink);
    if (regenerateTarget || (kind === "rerun" && rerunSnapshotApplies)) {
      const anchor = await loadPreExchangeScenario(chatId);
      if (anchor) storedScenario = rollbackScenario(anchor, storedScenario);
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

    // The user's default player character (player-character.plan.md), so the
    // character addresses someone by name instead of a faceless "the user".
    const player = await resolvePlayerPersona(owner);

    // What the post-turn agents read as the player's turn: the message plus a
    // clearly-labeled note of what the attached photos showed — so a shown photo
    // can be classified (a gift, a confidence) and filed as ordinary perceived
    // facts. Prompt-side the photos ride their own tail block; never persisted.
    const describedPlayerContent = attachmentDescriptions?.length
      ? `${playerContent}\n\n[${player.name} attached ${attachmentDescriptions.length === 1 ? "a photo" : `${attachmentDescriptions.length} photos`} — as ${characterName} sees ${attachmentDescriptions.length === 1 ? "it" : "them"}: ${attachmentDescriptions.map((d, i) => `(${i + 1}) ${d}`).join(" ")}]`
      : playerContent;
    // Narrator-mode input (chat-supporting-cast.plan.md): label the player half so the
    // post-turn agents read it as authored story events, never the player's own
    // speech/act. Prompt-side the wrap is `wrapNarratorInput` on the history line.
    const agentPlayerContent =
      narratorInput && playerContent
        ? `[${player.name} wrote this as STORYTELLER NARRATION — story events, not ${player.name}'s own words or actions]\n${describedPlayerContent}`
        : describedPlayerContent;

    // --- Ensemble roster (multi-character-chat.plan.md slices 2–4) -----------
    // The members beyond the primary: load each one's state (seeding from their
    // authored defaults like a fresh 1-on-1), and tick ONLY present members —
    // presence gating the advance IS the away-freeze (ruling 6).
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
              const storedMember = (await loadChatState(chatId, member.characterId, sink)) ?? seedChatState(memberProfile);
              const resolved = await resolveSeededOutfit(storedMember, owner, memberProfile, sink);
              const state = driftChatState(resolved, memberProfile, { advance: resolved.presence === "present", clockMinutes: tickedClock });
              return {
                characterId: member.characterId,
                memoryGroupId: member.memoryGroupId,
                name: member.name,
                profile: memberProfile,
                state,
              };
            }),
        )
      : [];

    // --- RAG recall (spec §2): per-participant memory groups ------------------
    // 1-on-1 keeps the default k. An ensemble runs tier-1 legs only (ruling 5):
    // the primary always gets a leg; other members earn one while present and
    // recently active, each against their OWN group, with per-leg k tightened as
    // the active count grows — cost tracks the scene, not the roster.
    const activeOthers = others.filter(
      (o) => o.state.presence === "present" && o.state.quietExchanges < ENSEMBLE_QUIET_EXCHANGES,
    );
    const legLimit = ensembleActive ? Math.max(2, 5 - activeOthers.length) : undefined;
    // ONE embed for the whole turn (chat-agent-improvements slice 3): every retrieval leg
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
    const cueHint = playerContent ? detectChatCue(playerContent) : null;
    const intimateBeat = (cueHint?.intimate ?? false) || (driftedState.meters.arousal ?? 0) >= INTIMATE_AROUSAL_FLOOR;
    const recentReplies = history.filter((m) => m.role === "assistant").map((m) => m.content);

    // One-turn sense-targeted focus (scope guard): a smell/taste/touch/study beat aimed at
    // a body region / garment ⇒ assemble the authored sensory values into a focus block.
    const sensoryFocus = playerContent ? (detectSensoryFocus(playerContent) ?? undefined) : undefined;
    const firstExchange = !opening && !recentReplies.length;

    // --- Action beat (chat-action-beats.plan.md) -----------------------------
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

    // --- Perk targeting (followups ruling 12) --------------------------------
    // The "addressed" member: a group perk aims at whoever the player's message
    // names. The primary wins when named; otherwise the first PRESENT other
    // member named; nobody named ⇒ undefined (the perk falls to the lead).
    const addressedOther =
      ensembleActive && playerContent && !mentionsCharacter(playerContent, characterName, profile.aliases)
        ? others.find((o) => o.state.presence === "present" && mentionsCharacter(playerContent, o.name, o.profile.aliases))
        : undefined;

    // --- Selfie arming (chat-selfies.plan.md) --------------------------------
    // Request: the player asked for a photo (any register — their call). Offer:
    // APART-ONLY (owner ruling — the comms register is the "not in the same place"
    // signal) + warm regard + the cooldown ring. Either arms a one-turn license
    // line; the post-turn pulse decides whether the reply actually sent one.
    // Group scenes (ruling 12): a request routes to the addressed member —
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
    // Opener selfie (chat-initiative.plan.md slice 5): a warm reopen opener may
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

    // --- Memory callback (memory-callbacks.plan.md): the unprompted "remember when" cue ---
    // Gate first (pure, no cost), then pay one embedding + one query to pick an old,
    // milestone-boosted, topic-DISTANT episode. An offered callback burns into the ring
    // immediately — it rides this exchange's ordinary state write, so "another take"
    // rolls the burn back with the snapshot and the retake gets the same opportunity.
    // Group scenes (ruling 12): the memory belongs to ONE member — the addressed one,
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
        // The crowded-turn arms (chat-agent-improvements slice 4): the tail's flavor slot
        // is single-occupancy, and the callback is what yields — decided HERE, before the
        // ring burns, so a deferred callback is never spent unseen.
        hasAttachments: Boolean(attachmentDescriptions?.length),
        narratorInput,
        photoBeat: selfieRequested || selfieOfferEligible || openerSelfieEligible,
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
    // §8.4 v2 (chat-initiative.plan.md slice 2): an initiative opener may
    // acknowledge what shifted since the player last OPENED the chat — the
    // seen-cursor names which milestones are still fresh for her. One indexed
    // read, initiative beats only.
    const recentShift = initiativeOpener
      ? unseenMilestoneReason(driftedState.milestones, (await loadMilestonesSeenAt(chatId)) ?? new Date())
      : null;

    // Structured wardrobe (chat-wardrobe-parity): resolve the drifted worn state into its
    // rendered garment phrase + coverage-computed exposure — the ONE seam the prompt, scene
    // image, and look key share (reusing the session renderers, never re-forking them).
    const wardrobe = await resolveChatWardrobe(driftedState, owner, profile, sink);

    const promptInput: CharacterChatPromptInput = {
      name: characterName,
      profile,
      priorSummary: summaryState?.summary,
      memory,
      player: { name: player.name, persona: player.persona },
      state: promptStateSlice(driftedState, scenario, wardrobe),
      opening,
      narrationShape: narrationShapeId("chat"),
      // Chat scene memory: whether the setting changed this exchange (movement / time skip),
      // which flips the Scene block's directive from "don't re-establish" to "establish once".
      sceneChanged,
      // First exchange (no assistant reply yet; regenerating the first reply popped it above):
      // renders the one-turn establish-the-scene directive. Opening beats carry their own
      // scene-opening instruction instead.
      firstExchange,
      // The one-turn memory callback (memory-callbacks.plan.md), already ring-burned above.
      callback,
      // Attached photos (chat-image-input.plan.md): the vision read, injected as
      // seen-channel content the perception partition's rule 16 governs.
      attachments: attachmentDescriptions?.length ? { descriptions: attachmentDescriptions } : undefined,
      // One-turn selfie license (chat-selfies.plan.md), armed above; "opener" is
      // the initiative beat's register-conditional arm (chat-initiative slice 5).
      selfie: selfieRequested ? "request" : selfieOfferEligible ? "offer" : openerSelfieEligible ? "opener" : undefined,
      // One-turn cue invitation, now the continue-cue only (§8.4): a "has something to say"
      // continue threads its tapped open loop here so the character opens about exactly the
      // right thing. The sensory arms were superseded by `sensoryAllowance` below
      // (narrator-prompt-consolidation slice 4). Pre-slice-4 arm (rollback):
      //   cueInvite: cueHint ? chatCueInviteLine(cueHint, characterName) : <the continue arm below>
      cueInvite: initiativeOpener
        ? buildInitiativeCue({
            characterName,
            playerName: player.name,
            openLoops: driftedState.openLoops,
            drives: driftedState.drives,
            skipPending: Boolean(scenario.pendingSkipNote.trim()),
            // Slice-2/4 material: the unseen shift + the authored daily rhythm.
            recentShift,
            rhythm: formatScheduleRhythm(profile.schedule),
            // Slice 5: extraversion colors the opener's cadence (eager vs. reticent).
            extraversion: effectiveTraitValue(profile.traits, "social.extraversion"),
          })
        : effectiveKind === "continue" && input.cue?.trim()
          ? `There is unfinished business you might open about: "${input.cue.trim()}" — bring it up naturally, in your own voice, if the moment allows.`
          : undefined,
      // The deterministic per-turn sensory allowance (narrator-prompt-consolidation slice 4):
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
      // Derived-fact tail note (player-input-perception.plan.md slice 4): the shared span
      // parser reads the current message's markup and renders a comms/OOC one-liner. The
      // raw message is never touched — this only feeds the prompt tail.
      notationNote: playerContent
        ? chatNotationNote(playerContent, { name: characterName, player: player.name, knownNames: [characterName] })
        : undefined,
      // Narrator-mode input (chat-supporting-cast.plan.md): the one-turn tail note that
      // suspends the player-input perception rules for THIS message.
      narratorInput,
    };

    // The relationship matrix (relationship-model.plan.md): tier-1 pair lines for
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
        pairs,
        awayPairs,
        ...(selfieRequested
          ? { selfie: { kind: "request" as const, memberName: selfieTargetOther?.name ?? characterName } }
          : selfieOfferEligible
            ? { selfie: { kind: "offer" as const, memberName: characterName } }
            : {}),
        ...(ensembleCallback ? { callback: ensembleCallback } : {}),
        ...(sensoryFocus
          ? { sensoryFocus: { hint: sensoryFocus, memberName: addressedOther?.name ?? characterName } }
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
            state: promptStateSlice(driftedState, scenario, wardrobe),
            memory,
            presence: driftedState.presence,
            quietExchanges: driftedState.quietExchanges,
          },
          // Each present member resolves their OWN worn state (chat-wardrobe-parity) — same
          // owner library, so the shared loader keys their garments too.
          ...(await Promise.all(
            others.map(async (o) => ({
              name: o.name,
              profile: o.profile,
              state: promptStateSlice(o.state, scenario, await resolveChatWardrobe(o.state, owner, o.profile, sink)),
              memory: otherMemories.get(o.characterId),
              presence: o.state.presence,
              quietExchanges: o.state.quietExchanges,
            })),
          )),
        ]
      : undefined;

    // Prompt layout (narrator-prompt-consolidation slice 5, default `system_tail`): the
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
    if (ensemble) {
      const parts = buildChatPromptPartsForRoster(promptInput, ensemble, ensembleExtras);
      system = [parts.prefix, parts.tail].filter(Boolean).join("\n\n");
      modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
    } else if (chatPromptLayout() === "turn_context" && playerContent) {
      const parts = buildCharacterChatPromptParts(promptInput);
      system = parts.prefix;
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
      modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
    }

    const abortController = new AbortController();
    inflightReplyAborts.set(chatId, abortController);
    const gen = streamCharacterChat({
      system,
      history: modelHistory,
      name: characterName,
      model: input.model,
      signal: abortController.signal,
    });

    // --- Settle work (runs once the reply has fully streamed) ----------------
    const settle = async (full: string, stopped: boolean): Promise<void> => {
      // The action-beat chip id rides the reply meta so a later regenerate reproduces
      // the cue + deterministic effect (recovered from the target's meta above).
      const beatMeta = actionBeatId ? { actionBeat: actionBeatId } : {};
      const meta = stopped ? { ...beatMeta, stopped: true } : beatMeta;
      if (regenerateTarget) {
        // Update the row in place: the old take stays browsable, the new one is
        // active (spec §4.1). Row-existence is the guard — a delete landing
        // mid-stream makes this a no-op.
        const takes = await currentReplyTakes(chatId, regenerateTarget.id);
        if (takes === null) return; // row deleted mid-stream
        const next = pushReplyTake(takes, regenerateTarget.content, full, now.toISOString());
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

      if (opening) {
        // Opening beat: fold drift into the state — no fan-out, there was no
        // player act and barely any narrative to archive. Record the surfaced
        // bands so the first real turn doesn't re-announce them, clear the
        // one-shot skip note this beat just rendered (spec §8.1), and store the
        // rollback anchor so even an opening beat can be regenerated.
        try {
          const surfacedCues = splitStateCues(driftedState.meters, driftedState.surfacedCues).nextBands;
          await persistChatState(chatId, characterId, { ...driftedState, surfacedCues });
          await saveChatScenario(chatId, { ...scenario, pendingSkipNote: "" });
          await savePreExchangeSnapshot(chatId, characterId, storedState);
          await savePreExchangeScenario(chatId, preExchangeScenario);
        } catch (error) {
          log.error("engine.chat", "chat-state opening persist failed", { error: describeError(error) });
        }
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
          driftedState: ensembleActive ? { ...driftedState, quietExchanges: primaryQuiet } : driftedState,
          now,
          exchange: { player: agentPlayerContent, assistant: full },
          // The recap ledger grounds the memory scribe's fact names (chat-agent-improvements).
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
          // The ensemble context (multi-character-chat.plan.md): the roster line
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
        // Ensemble members settle their own turn: the presence-gated tick from
        // prompt time, a referenced-only pulse (regard/mood/mindNote/weather), a
        // personal note-taker pass for every PRESENT member (followups ruling 10 —
        // loops/outfit/attributes/drives folded into their own row), the
        // deterministic per-member folds (ruling 11 — milestones + arc samples for
        // everyone who pulsed), the archivist's confirmed presence transition, and
        // the recency stamp — saved under the same prompt-row guard as the primary.
        //
        // Members settle CONCURRENTLY (chat-agent-improvements slice 2): each member's
        // legs read only their own row and write only their own row, and the whole settle
        // runs while the exchange lock is held — so settling a full roster one member at a
        // time stacked up to four back-to-back agent round-trips inside the lock window,
        // and a fast-typing player ate a 409 `chat_busy` for the difference. Errors stay
        // per-member (each iteration keeps its own try/catch), so one member's failure
        // still can't cost another's state.
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
              characterName: member.name,
              assistantMessageId,
              now,
              clockMinutes: scenario.clockMinutes,
              selfieRequestTarget: isSelfieTarget,
              sink,
            });
            const confirmed = finalized.presenceChanges.find(
              (p) => p.name.trim().toLowerCase() === member.name.trim().toLowerCase(),
            )?.presence;
            const active =
              mentionsCharacter(agentPlayerContent, member.name, member.profile.aliases) ||
              spokeInReply(full, member.name);
            const quietExchanges = active ? 0 : memberState.quietExchanges + 1;
            await saveChatState({
              chatId,
              characterId: member.characterId,
              promptMessageId: promptMessageId ?? assistantMessageId,
              state: { ...memberState, ...(confirmed ? { presence: confirmed } : {}), quietExchanges },
            });
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
      } catch (error) {
        log.error("engine.chat", "chat-state finalize failed", { error: describeError(error) });
      }
      if (sink.items.length) {
        log.info("engine.chat", "chat-state diagnostics", { codes: sink.items.map((d) => d.code) });
      }
    };

    // Guard the model stream with the first-token + overall watchdogs (data-loss-rerun
    // fix): a wedged provider trips a timeout, which aborts the upstream call and lets
    // the exchange settle through the same stop path as a player Stop — so the chat lock
    // can never be held indefinitely by a hung generation. The trip reason is kept so
    // the settle can record a `timeout` reply failure instead of a silent pseudo-stop.
    let timedOut: "first_token" | "overall" | null = null;
    const guarded = withStreamTimeouts(gen, {
      firstTokenMs: CHAT_STREAM_FIRST_TOKEN_MS,
      overallMs: CHAT_STREAM_OVERALL_MS,
      onAbort: () => abortController.abort(),
      onTimeout: (reason) => {
        timedOut = reason;
        log.warn("engine.chat", "chat reply stream timed out", { chatId, reason });
      },
    });
    return { ok: true, stream: streamExchange(guarded, settle, abortController, () => timedOut) };
  }

  /**
   * Wrap the model stream so persistence + fan-out + lock release ride the
   * generator's own completion: the route (or any consumer) just drains it. A
   * model-stream failure keeps whatever accumulated (persisted if non-empty); a
   * player Stop (spec §4.2) is not a failure — the truncated prefix persists with
   * `meta.stopped`. An empty reply skips settle but records WHY it was empty
   * (`last_reply_failure` — the client's post-exchange refetch reads it for the
   * failure popup); the lock releases on every path.
   */
  async function* streamExchange(
    gen: AsyncGenerator<string>,
    settle: (full: string, stopped: boolean) => Promise<void>,
    abortController: AbortController,
    timedOut: () => "first_token" | "overall" | null,
  ): AsyncGenerator<string, void, unknown> {
    let full = "";
    let stopped = false;
    let streamError: { code: ChatReplyFailureCode; detail: string } | null = null;
    try {
      try {
        for await (const delta of gen) {
          full += delta;
          yield delta;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          stopped = true;
        } else {
          const classified = classifyProviderError(error);
          streamError = { code: classified.code, detail: classified.detail };
          log.warn("engine.chat", "reply stream failed", {
            chatId,
            code: classified.code,
            status: classified.status,
            error: classified.detail,
          });
        }
      }
      if (abortController.signal.aborted) stopped = true;
      if (full.trim()) {
        try {
          await settle(full, stopped);
        } catch (error) {
          log.error("engine.chat", "failed to persist assistant reply", { error: describeError(error) });
        }
      }
      // Record (or clear) the exchange's reply-failure verdict BEFORE the generator
      // returns — the route's drain, and so the client's refetch, wait on this.
      await saveReplyFailure(
        chatId,
        resolveReplyFailure({ hasText: Boolean(full.trim()), stopped, streamError, timedOut: timedOut() }),
        input.model ?? "",
      );
    } finally {
      inflightReplyAborts.delete(chatId);
      releaseChatLock();
    }
  }
}

/**
 * Resolve what a settled exchange records as its reply failure (PURE). Only an
 * exchange that produced NO text records one — a partial that persisted is a
 * visible reply. A watchdog trip aborts the same controller as a player Stop, so
 * the timeout reason outranks the stop flag; a genuine player Stop is not a
 * failure. A clean zero-token stream is its own class (`empty_reply`: the model
 * succeeded and said nothing). Null ⇒ clear any prior record.
 */
export function resolveReplyFailure(input: {
  hasText: boolean;
  stopped: boolean;
  streamError: { code: ChatReplyFailureCode; detail: string } | null;
  timedOut: "first_token" | "overall" | null;
}): { code: ChatReplyFailureCode; detail: string } | null {
  if (input.hasText) return null;
  if (input.streamError) return input.streamError;
  if (input.timedOut) {
    return {
      code: "timeout",
      detail:
        input.timedOut === "first_token"
          ? `no output within ${Math.round(CHAT_STREAM_FIRST_TOKEN_MS / 1000)}s`
          : `the reply ran past ${Math.round(CHAT_STREAM_OVERALL_MS / 1000)}s and was cut off`,
    };
  }
  if (input.stopped) return null;
  return { code: "empty_reply", detail: "" };
}

/**
 * Write — or with null, clear — `character_chats.last_reply_failure`. Never
 * throws: losing the record must not break the exchange settle or lock release
 * (docs/resilience.md — degraded defaults over failed turns).
 */
async function saveReplyFailure(
  chatId: string,
  failure: { code: ChatReplyFailureCode; detail: string } | null,
  model: string,
): Promise<void> {
  const record: ChatReplyFailure | null = failure
    ? { code: failure.code, detail: failure.detail.slice(0, 500), model, at: new Date().toISOString() }
    : null;
  try {
    await db().update(characterChats).set({ lastReplyFailure: record }).where(eq(characterChats.id, chatId));
  } catch (error) {
    log.error("engine.chat", "failed to record reply failure", { chatId, error: describeError(error) });
  }
}

/** Defensive parse of a user line's meta: attachments (chat-image-input.plan.md) + input mode. */
const messageAttachmentsMetaSchema = z.object({
  attachments: z
    .object({
      ids: z.array(z.string()).catch([]).default([]),
      descriptions: z.array(z.string()).optional(),
    })
    .optional(),
  /** Narrator-mode marker (chat-supporting-cast.plan.md §Narrator input). */
  inputMode: z.enum(["player", "narrator"]).optional().catch(undefined),
});

/** The prompting line's stored attachment ids + any persisted vision read + its input mode. */
async function loadMessageAttachments(
  chatId: string,
  messageId: string,
): Promise<{ ids: string[]; descriptions: string[] | null; narrator: boolean }> {
  const [row] = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  const parsed = parseOr(messageAttachmentsMetaSchema, row?.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  const ids = parsed.attachments?.ids ?? [];
  const descriptions = parsed.attachments?.descriptions;
  return {
    ids,
    descriptions: descriptions && descriptions.length === ids.length ? descriptions : null,
    narrator: parsed.inputMode === "narrator",
  };
}

/** Defensive parse of an assistant reply's meta: the action-beat chip id (regenerate recovery). */
const assistantReplyMetaSchema = z.object({
  actionBeat: chatActionIdSchema.optional().catch(undefined),
});

/** The newest message when it is an assistant reply — the only regenerable target. */
async function lastAssistantMessage(
  chatId: string,
): Promise<{ id: string; content: string; createdAt: Date; actionBeat?: ChatActionId } | null> {
  const [row] = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      createdAt: characterChatMessages.createdAt,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  if (!row || row.role !== "assistant") return null;
  const meta = parseOr(assistantReplyMetaSchema, row.meta ?? {}, {}, undefined, "character_chat_messages.meta");
  return { id: row.id, content: row.content, createdAt: row.createdAt, actionBeat: meta.actionBeat };
}

/** The message immediately before `target`, collision-safe on the (createdAt, id) tuple. */
async function messageBefore(
  chatId: string,
  target: { id: string; createdAt: Date },
): Promise<{ id: string; role: "user" | "assistant"; content: string } | null> {
  const [row] = await db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.chatId, chatId),
        ne(characterChatMessages.id, target.id),
        or(
          lt(characterChatMessages.createdAt, target.createdAt),
          and(eq(characterChatMessages.createdAt, target.createdAt), lt(characterChatMessages.id, target.id)),
        ),
      ),
    )
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(1);
  return row ?? null;
}

type RerunResolution =
  | { ok: false; message: string }
  | {
      ok: true;
      target: { id: string; content: string };
      deletedAssistantIds: string[];
      /** EVERY deleted successor id (both roles) — user lines' attachments clean up on these. */
      deletedIds: string[];
      snapshotApplies: boolean;
    };

/**
 * Resolve + snip a rerun target atomically (data-loss-rerun fix). In one transaction:
 * confirm the target row exists, is a `role: "user"` line, and belongs to this chat (else
 * `ok: false`, nothing modified — the delete only runs after validation passes), then
 * delete ONLY its successors — every row ordered after it on the `(created_at, id)` tuple
 * the transcript sorts by. The target row is left intact for the caller to reuse as the
 * prompt guard. Reports the deleted assistant successors (their extracted memory is
 * retracted upstream) and whether the pre-exchange snapshot still applies — true only
 * when the sole successor was the newest assistant reply, i.e. this rerun IS the last
 * exchange (so its rollback is exactly regenerate's; older reach-backs and continue beats
 * degrade to no rollback).
 *
 * "Successors" is computed by ORDERING in SQL (full `created_at` precision) and slicing
 * after the target's position — deliberately NOT by comparing `created_at` against a Date
 * read back into JS: `Date` truncates Postgres microseconds to milliseconds, so a
 * `created_at > $targetDate` predicate would re-select the target row itself (and other
 * same-millisecond rows), deleting the very line we mean to keep.
 */
async function resolveRerunTarget(chatId: string, targetMessageId: string | undefined): Promise<RerunResolution> {
  if (!targetMessageId) return { ok: false, message: "no target message id for the rerun" };
  return db().transaction(async (tx) => {
    const ordered = await tx
      .select({
        id: characterChatMessages.id,
        role: characterChatMessages.role,
        content: characterChatMessages.content,
      })
      .from(characterChatMessages)
      .where(eq(characterChatMessages.chatId, chatId))
      .orderBy(asc(characterChatMessages.createdAt), asc(characterChatMessages.id));
    const idx = ordered.findIndex((m) => m.id === targetMessageId);
    const target = idx === -1 ? undefined : ordered[idx];
    if (!target || target.role !== "user") {
      return { ok: false as const, message: "that message can't be rerun (not a player line in this conversation)" };
    }
    const successors = ordered.slice(idx + 1);
    const successorIds = successors.map((s) => s.id);
    if (successorIds.length > 0) {
      await tx.delete(characterChatMessages).where(inArray(characterChatMessages.id, successorIds));
    }
    const deletedAssistantIds = successors.filter((s) => s.role === "assistant").map((s) => s.id);
    const snapshotApplies = successors.length === 1 && successors[0]?.role === "assistant";
    return {
      ok: true as const,
      target: { id: target.id, content: target.content },
      deletedAssistantIds,
      deletedIds: successorIds,
      snapshotApplies,
    };
  });
}

/** The row's current takes, or null when the row vanished (delete raced the stream). */
async function currentReplyTakes(chatId: string, messageId: string): Promise<ReplyTakes | null> {
  const [row] = await db()
    .select({ takes: characterChatMessages.takes })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .limit(1);
  if (!row) return null;
  return parseOr(replyTakesSchema, row.takes, emptyReplyTakes(), undefined, "character_chat_messages.takes");
}

/** The chat's owner id (for persona resolution) — one indexed lookup. */
async function chatOwnerId(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) throw new Error(`chat ${chatId} vanished mid-exchange`);
  return row.ownerId;
}

/**
 * Persist the assistant reply. With a `promptMessageId` the insert is guarded —
 * only if the user line that prompted it still exists (atomic `INSERT … SELECT …
 * WHERE EXISTS`), so a chat delete or a single-message delete that lands while
 * the stream is still draining can't leave an orphan row. Beat replies
 * (open/continue) have no prompting line and insert unguarded. `id` is supplied
 * explicitly: it is the memory-provenance anchor (spec §4.3), minted before the
 * fan-out needs it.
 *
 * Exported as a test seam: a real mid-stream delete isn't deterministically
 * reproducible through the streaming Response, so the guard is covered directly.
 */
export async function persistAssistantReply(args: {
  id: string;
  chatId: string;
  speakerCharacterId: string;
  promptMessageId: string | null;
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const meta = JSON.stringify(args.meta ?? {});
  const guard = args.promptMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${args.promptMessageId})`
    : sql`true`;
  await db().execute(sql`
    insert into ${characterChatMessages} (id, chat_id, speaker_character_id, role, content, meta)
    select ${args.id}, ${args.chatId}, ${args.speakerCharacterId}, 'assistant', ${args.content}, ${meta}::jsonb
    where ${guard}
  `);
}

/**
 * Memory reconciliation for an edited assistant reply (spec §4.3): retract the
 * old extraction, then re-file the edited exchange's long-term memory
 * fire-and-forget — same resilience as the live fan-out (a degraded re-extract
 * just leaves the exchange unremembered, with the retraction already honest).
 * Only the MEMORY SCRIBE leg runs (chat-agent-improvements slice 1b): this path
 * rewrites no state row, so the continuity/character reads would be discarded.
 */
export async function reextractEditedReply(args: {
  chatId: string;
  messageId: string;
  memoryGroupId: string;
  characterId: string;
  characterName: string;
  playerName: string;
  content: string;
}): Promise<void> {
  const sink = new DiagnosticCollector();
  await reconcileMessageMemory(args.messageId, sink);
  const [row] = await db()
    .select({ id: characterChatMessages.id, createdAt: characterChatMessages.createdAt })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.id, args.messageId), eq(characterChatMessages.chatId, args.chatId)))
    .limit(1);
  if (!row) return;
  const prev = await messageBefore(args.chatId, row);
  const archivist = await runChatMemoryScribe({
    characterName: args.characterName,
    playerName: args.playerName,
    exchange: { player: prev?.role === "user" ? prev.content : "", assistant: args.content },
    sink,
  });
  await writeChatMemory({
    groupId: args.memoryGroupId,
    characterId: args.characterId,
    assistantMessageId: args.messageId,
    archivist: archivist.value,
    sink,
  });
  if (sink.items.length) {
    log.info("engine.chat", "edited-reply re-extraction diagnostics", { codes: sink.items.map((d) => d.code) });
  }
}

/**
 * The prompt builder's per-turn state slice from a drifted ChatState + the chat-wide scenario.
 * The `wardrobe` (chat-wardrobe-parity) supplies the RENDERED garment phrase + coverage-computed
 * exposure — the narrator sees the actual worn garments (subtype-led, occlusion-filtered), and
 * the exposure steer is coverage-accurate rather than the manual toggle.
 */
function promptStateSlice(
  state: ChatState,
  scenario: ChatScenario,
  wardrobe: ResolvedChatWardrobe,
): NonNullable<CharacterChatPromptInput["state"]> {
  return {
    meters: state.meters,
    regard: state.regard,
    familiarity: state.familiarity,
    relationship: state.relationship,
    conditions: state.conditions,
    mindNote: state.mindNote,
    premise: scenario.premise,
    surfacedCues: state.surfacedCues,
    outfit: wardrobe.garments,
    outfitExposed: wardrobe.exposed,
    activeSocialCards: scenario.activeSocialCards,
    attributeOverlays: state.attributeOverlays,
    // Persisted narrative trait overlays (character-fidelity slice 10) — resolved into the
    // prefix Disposition bands so the character's bounded evolution reaches the narrator.
    traitOverlays: state.traitOverlays,
    // Voice-exemplar ring (slice 8) — rendered as the "How you sound" few-shot block.
    voiceExemplars: state.voiceExemplars,
    // One-turn character-consistency corrective (slice 9): last exchange's slip note, if any.
    slipNote: state.lastMemoryTrace.characterSlip,
    openLoops: state.openLoops,
    skipNote: scenario.pendingSkipNote,
    sceneMemory: scenario.sceneMemory,
    supportingCast: scenario.supportingCast,
    feeling: state.feeling,
    drives: state.drives,
  };
}

/** The dev inspector's "what reaches the narrator" view (spec §5/§6.1). */
export interface ChatPromptPreview {
  prefix: string;
  tail: string;
  memory: { facts: string[]; episodes: string[] };
  memoryQueries: string[];
}

/**
 * Rebuild "what would reach the narrator now" for the dev inspector (spec §5 dev
 * affordance, §6.1): the same assembly as a live exchange — stored state (read-only
 * drift), rolling summary, persona, RAG recall — rendered into the §9 prompt parts,
 * without touching state, history, or the exchange lock. Reflects the POST-exchange
 * state (i.e. the NEXT turn's prompt), which is what comparing live play against the
 * eval fixtures wants.
 */
export async function previewChatPrompt(input: {
  chatId: string;
  memoryGroupId: string;
  character: { id: string; name: string; profile: unknown };
}): Promise<ChatPromptPreview> {
  const sink = new DiagnosticCollector();
  const profile = parseOr(
    characterProfileSchema,
    input.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const stored = await loadChatState(input.chatId, input.character.id, sink);
  const owner = await chatOwnerId(input.chatId);
  const scenario = (await loadChatScenario(input.chatId, sink)) ?? seedChatScenario(profile);
  const state = driftChatState(
    await resolveSeededOutfit(stored ?? seedChatState(profile), owner, profile, sink),
    profile,
    { clockMinutes: scenario.clockMinutes },
  );
  const summaryState = await loadChatSummary(input.chatId);
  const player = await resolvePlayerPersona(owner);
  const wardrobe = await resolveChatWardrobe(state, owner, profile, sink);
  const memory = await retrieveChatMemory({
    groupId: input.memoryGroupId,
    queries: state.memoryQueries,
    input: "",
    sink,
  });
  const parts = buildCharacterChatPromptParts({
    name: input.character.name,
    profile,
    priorSummary: summaryState?.summary,
    memory,
    player: { name: player.name, persona: player.persona },
    state: promptStateSlice(state, scenario, wardrobe),
    narrationShape: narrationShapeId("chat"),
  });
  return {
    prefix: parts.prefix,
    tail: parts.tail,
    memory: { facts: memory.facts, episodes: memory.episodes },
    memoryQueries: state.memoryQueries,
  };
}

/**
 * Hard-delete a conversation (character-chat-standalone.spec.md §1.4 — archive is
 * the everyday action; this is the one destructive verb). One transaction: the
 * chat row's FK cascades take the transcript, summary, participant rows, and
 * per-participant state; the scene-image prompt text is scrubbed (assets survive
 * in the Gallery, but their prompts embed chat lines — chat-keyed rows scrub
 * per-conversation; legacy pre-slice-9 rows have no chatId, so those still scrub
 * character-wide, hitting sibling conversations' legacy scenes too); and each
 * participant's memory group is purged **only when no other conversation
 * references it** — shared-history siblings keep the relationship's memory
 * alive (D7).
 */
export async function deleteChat(chat: { id: string; ownerId: string }): Promise<void> {
  const participants = await db()
    .select({ characterId: chatParticipants.characterId, memoryGroupId: chatParticipants.memoryGroupId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chat.id));

  // Chat-private assets (player uploads + the look/place render anchors) are chat
  // content, not Gallery assets: hard-delete them BEFORE the chat row goes (the FK
  // would SET NULL their chat_id and strand them invisibly — scenes deliberately
  // survive that way, these must not).
  await deleteChatAssets(chat.id, ["chat_upload", "chat_look", "chat_place"]);

  await db().transaction(async (tx) => {
    await tx.update(images).set({ prompt: "" }).where(eq(images.chatId, chat.id));
    for (const p of participants) {
      await tx
        .update(images)
        .set({ prompt: "" })
        .where(
          and(
            eq(images.ownerId, chat.ownerId),
            eq(images.kind, "scene"),
            eq(images.entityKind, "character"),
            eq(images.entityId, p.characterId),
            isNull(images.chatId),
          ),
        );
    }
    await tx.delete(characterChats).where(eq(characterChats.id, chat.id));
    for (const p of participants) {
      const [survivor] = await tx
        .select({ chatId: chatParticipants.chatId })
        .from(chatParticipants)
        .where(and(eq(chatParticipants.memoryGroupId, p.memoryGroupId), ne(chatParticipants.chatId, chat.id)))
        .limit(1);
      if (!survivor) await deleteChatMemory(p.memoryGroupId, tx);
    }
  });
}
