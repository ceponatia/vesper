import { and, eq } from "drizzle-orm";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { characterChatState, db } from "../db";
import { log } from "../log";
import { reconcileMessageMemory } from "./chat-memory";
import { reextractExchangeMemory } from "./chat-message-edits";
import { messageAfter } from "./chat-reply-store";
import { repairChatSummaryForMessage } from "./chat-summary";
import { removeVoiceExemplarsForMessage, voiceExemplarsSchema, type VoiceExemplar } from "./chat-voice";

/**
 * Continuity repair after a transcript edit or delete.
 *
 * The transcript is not the only place a line's wording lives: the rolling
 * summary folds it into prose, the memory scribe files facts and an episode
 * against the exchange it belongs to, and the archivist may have kept it as a
 * voice exemplar on the state row. Rewriting or snipping the row alone leaves
 * those derivatives quoting the old text back into the next prompt, which is
 * exactly the poisoned context the edit was meant to remove. This module
 * rebuilds all three, in one pass, while the caller holds the chat exchange lock.
 *
 * Independent legs (docs/resilience.md §4): each step is wrapped, one failure is
 * recorded as an error diagnostic and the others still run. Nothing here throws
 * back at the route — the transcript write is already committed by the time this
 * runs, so a failed derivative is reported in the response envelope rather than
 * hidden behind a 500. Summary repair never restores stale prose: it goes through
 * `repairChatSummaryForMessage`, which decides coverage and re-folds under the
 * summary lock, and whose reset-then-refold leaves an empty summary and a null
 * watermark when the first fold degrades, which is the honest degraded state
 * (the verbatim window then carries the whole transcript).
 */

/** Whether the rolling summary had to be re-folded for this message. */
export type ChatContinuitySummaryOutcome = "rebuilt" | "unaffected" | "failed";
/** What happened to the memory extracted from this message. */
export type ChatContinuityMemoryOutcome = "reextracted" | "degraded" | "reconciled" | "unaffected" | "failed";
/** Whether any voice exemplar quoted this message. */
export type ChatContinuityVoiceOutcome = "scrubbed" | "unaffected" | "failed";

/** What the message routes report back about the repair (the response envelope's `continuity`). */
export interface ChatContinuityRepair {
  summary: ChatContinuitySummaryOutcome;
  memory: ChatContinuityMemoryOutcome;
  /**
   * Exemplars dropped from the LIVE rings across the roster's state rows. The
   * matching entries in each row's `preExchangeState` snapshot are dropped in
   * the same write (so "another take" cannot resurrect the line) but are not
   * counted again here.
   */
  voiceExemplarsRemoved: number;
  voice: ChatContinuityVoiceOutcome;
  /** Every diagnostic code the repair recorded, in order. */
  diagnostics: string[];
}

export interface ChatContinuityRepairInput {
  chatId: string;
  /** `edit` rewrote the line in place; `delete` removed it. */
  operation: "edit" | "delete";
  message: {
    id: string;
    role: "user" | "assistant";
    /** The row's timestamp from the guarded write's `returning()` — the watermark comparison's other half. */
    createdAt: Date;
    /** The wording BEFORE the write: the string every derivative must lose. */
    previousContent: string;
    /**
     * The wording AFTER the write; `null` when the line was deleted. The ONLY
     * text re-extraction may re-file — `previousContent` is what this repair
     * exists to make unreachable, so it never goes back to the scribe.
     */
    content: string | null;
  };
  /**
   * What the memory scribe needs to re-file a repaired exchange. Required for
   * BOTH roles: a player line's wording lives in the exchange anchored on the
   * reply that answered it, so editing or snipping one re-files that reply.
   *
   * The primary participant's group and character, as everywhere else in the
   * 1-on-1 shape — an ensemble reply spoken by another member is a pre-existing
   * limitation of the anchor, not of this repair.
   */
  memory: {
    memoryGroupId: string;
    characterId: string;
    characterName: string;
    playerName: string;
  };
  /** Optional observer; the repair keeps its own collector regardless (docs/resilience.md §2). */
  sink?: DiagnosticSink;
}

/**
 * What the memory leg must do about one edited or deleted line. `anchorId` is
 * always an ASSISTANT message id: chat memory is filed per EXCHANGE and stored
 * under the reply's id (docs/memory.md), so the reply is the only handle the
 * facts and the episode have.
 */
export type MemoryRepairPlan =
  /** Re-file the exchange anchored on this reply from the current transcript. */
  | { action: "reextract"; anchorId: string }
  /** Retract only — the anchor line itself is gone, so there is nothing to re-file. */
  | { action: "reconcile"; anchorId: string }
  /** No exchange used this line as either half; nothing was ever extracted from it. */
  | { action: "none" };

/**
 * The memory-repair matrix, kept pure so the whole thing is decided in one place
 * and unit-tested without a database.
 *
 * The scribe consumes an exchange — the player's line AND the reply — and files
 * the result under the reply's id. A player line therefore has a derivative
 * whenever a reply followed it, even though nothing is anchored on the player row
 * itself: editing "my name is Alice" to "Bob" must re-file that reply's
 * extraction, or the Alice fact stays retrievable. A player line with no reply yet
 * (the newest line, or one followed by another player line) was never extracted.
 */
export function planMemoryRepair(input: {
  message: { id: string; role: "user" | "assistant" };
  operation: "edit" | "delete";
  /** The next line on the `(createdAt, id)` tuple, read AFTER the write. */
  following: { id: string; role: "user" | "assistant" } | null;
}): MemoryRepairPlan {
  const { message, operation, following } = input;
  if (message.role === "assistant") {
    // Its own exchange's anchor: an edit re-files it from the new text, a delete
    // leaves no anchor to file anything under.
    return operation === "edit"
      ? { action: "reextract", anchorId: message.id }
      : { action: "reconcile", anchorId: message.id };
  }
  // A player line: the reply that answered it holds its derivative. The reply is
  // untouched by this write, so it is re-filed (never retracted-only) — from the
  // edited player text, or with no player half at all after a delete.
  return following?.role === "assistant" ? { action: "reextract", anchorId: following.id } : { action: "none" };
}

/**
 * Rebuild the model-facing derivatives of one edited/deleted message. Runs the
 * memory step, then the summary step, then the voice step; the caller holds the
 * chat exchange lock across all three.
 *
 * Voice is assistant-only: the ring quotes the character, not the player. Memory
 * and summary apply to BOTH roles. Memory follows the EXCHANGE anchor rather than
 * the edited row ({@link planMemoryRepair}) — chat memory is stored under an
 * assistant message id (docs/memory.md), but the extraction behind it read the
 * player's half too. Summary repair is role-blind for the same reason: the fold
 * reads the player's lines, so an edited user line at or before the watermark is
 * just as covered.
 */
export async function repairChatContinuityAfterEdit(input: ChatContinuityRepairInput): Promise<ChatContinuityRepair> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  const { chatId, operation, message } = input;
  const assistant = message.role === "assistant";

  let memory: ChatContinuityMemoryOutcome = "unaffected";
  try {
    // ONE extra query, and only for a player line — an assistant line anchors its
    // own exchange and never has to look forward. The tuple comparison answers
    // even though the row is already gone on a delete.
    const following = message.role === "user" ? await messageAfter(chatId, message) : null;
    const plan = planMemoryRepair({ message, operation, following });
    if (plan.action === "reextract") {
      const reply =
        plan.anchorId === message.id
          ? message.content === null
            ? null
            : { id: message.id, createdAt: message.createdAt, content: message.content }
          : following === null
            ? null
            : { id: following.id, createdAt: following.createdAt, content: following.content };
      if (reply === null) {
        // An edit that carried no new wording. Not reachable from either route, and
        // a committed write is the wrong place to throw: retract and say so.
        await reconcileMessageMemory(plan.anchorId, sink);
        memory = "reconciled";
        sink.push(
          diag(
            "error",
            "chat_continuity.memory.failed",
            "the re-extraction anchor carried no wording; the old memory is retracted and nothing replaced it",
            { path: "chat_memory", context: { chatId, messageId: message.id, anchorId: plan.anchorId, operation } },
          ),
        );
      } else {
        // Retracts the old extraction first, then re-files the exchange from the
        // CURRENT transcript. AWAITED: an immediate next send must not race a
        // retrieval that still holds the old facts.
        const { degraded } = await reextractExchangeMemory({ chatId, reply, ...input.memory, sink });
        memory = degraded ? "degraded" : "reextracted";
        if (degraded) {
          // The retraction stands and nothing replaced it, so this is NOT
          // "reextracted" — reporting it as such would be a positive claim the
          // exchange is remembered (docs/resilience.md §1).
          sink.push(
            diag(
              "warn",
              "chat_continuity.memory.degraded",
              "re-extraction degraded; the old memory is retracted and nothing replaced it",
              { path: "chat_memory", context: { chatId, messageId: message.id, anchorId: plan.anchorId, operation } },
            ),
          );
        }
      }
    } else if (plan.action === "reconcile") {
      await reconcileMessageMemory(plan.anchorId, sink);
      memory = "reconciled";
    }
  } catch (err) {
    memory = "failed";
    sink.push(
      diag("error", "chat_continuity.memory.failed", `memory reconciliation failed: ${errorText(err)}`, {
        path: "chat_memory",
        context: { chatId, messageId: message.id, operation },
      }),
    );
  }

  let summary: ChatContinuitySummaryOutcome = "unaffected";
  try {
    // Coverage is decided and acted on under the summary lock, so a fold that is
    // mid-model-call settles before the decision reads its watermark.
    const { rebuilt, folds } = await repairChatSummaryForMessage(chatId, message);
    if (rebuilt) {
      summary = "rebuilt";
      sink.push(
        diag("info", "chat_continuity.summary.rebuilt", `re-folded the rolling summary in ${folds} fold(s)`, {
          path: "chat_summary",
          context: { chatId, messageId: message.id, folds },
        }),
      );
    }
  } catch (err) {
    summary = "failed";
    sink.push(
      diag("error", "chat_continuity.summary.failed", `summary rebuild failed: ${errorText(err)}`, {
        path: "chat_summary",
        context: { chatId, messageId: message.id },
      }),
    );
  }

  let voice: ChatContinuityVoiceOutcome = "unaffected";
  let voiceExemplarsRemoved = 0;
  if (assistant) {
    try {
      const scrubbed = await scrubVoiceExemplars(chatId, { id: message.id, content: message.previousContent }, sink);
      voiceExemplarsRemoved = scrubbed.live;
      if (scrubbed.live || scrubbed.snapshot) {
        voice = "scrubbed";
        sink.push(
          diag("info", "chat_continuity.voice.scrubbed", `dropped ${scrubbed.live} live and ${scrubbed.snapshot} snapshot voice exemplar(s)`, {
            path: "character_chat_state.voice_exemplars",
            context: { chatId, messageId: message.id },
          }),
        );
      }
    } catch (err) {
      voice = "failed";
      sink.push(
        diag("error", "chat_continuity.voice.failed", `voice-exemplar scrub failed: ${errorText(err)}`, {
          path: "character_chat_state.voice_exemplars",
          context: { chatId, messageId: message.id },
        }),
      );
    }
  }

  const diagnostics = collected.items.map((d) => d.code);
  if (summary === "failed" || memory === "failed" || memory === "degraded" || voice === "failed") {
    log.warn("engine.chat", "continuity repair degraded after a transcript edit", {
      chatId,
      messageId: message.id,
      operation,
      summary,
      memory,
      voice,
      diagnostics,
    });
  }
  return { summary, memory, voiceExemplarsRemoved, voice, diagnostics };
}

/**
 * Drop every exemplar sourced from this message across the chat's state rows —
 * the whole roster, because the primary holds the pick while an ensemble reply
 * may have been spoken by another member.
 *
 * Both the live ring and the `preExchangeState` snapshot's copy are scrubbed:
 * the snapshot is "another take"'s rollback target, so leaving it would let the
 * next retake resurrect the line. Each write is a NARROW column update — a
 * whole-row `persistChatState` would re-persist healed defaults for every other
 * column of a row this repair never read.
 */
async function scrubVoiceExemplars(
  chatId: string,
  message: { id: string; content: string },
  sink: DiagnosticSink,
): Promise<{ live: number; snapshot: number }> {
  const rows = await db()
    .select({
      characterId: characterChatState.characterId,
      voiceExemplars: characterChatState.voiceExemplars,
      preExchangeState: characterChatState.preExchangeState,
    })
    .from(characterChatState)
    .where(eq(characterChatState.chatId, chatId));

  let live = 0;
  let snapshot = 0;
  for (const row of rows) {
    const update: { voiceExemplars?: VoiceExemplar[]; preExchangeState?: Record<string, unknown> } = {};

    // A ring that will not parse degrades to "nothing to remove", which would
    // read as a positive claim that the line is gone (docs/resilience.md §1) —
    // so the failed parse is recorded rather than swallowed.
    const ring = parseOr(voiceExemplarsSchema, row.voiceExemplars, [], sink, "character_chat_state.voice_exemplars");
    const keptRing = removeVoiceExemplarsForMessage(ring, message);
    if (keptRing.removed > 0) {
      update.voiceExemplars = keptRing.kept;
      live += keptRing.removed;
    }

    const anchor = snapshotObject(row.preExchangeState);
    const anchorRing = anchor && Array.isArray(anchor.voiceExemplars)
      ? parseOr(voiceExemplarsSchema, anchor.voiceExemplars, [], sink, "pre_exchange_state.voiceExemplars")
      : null;
    if (anchor && anchorRing) {
      const keptAnchor = removeVoiceExemplarsForMessage(anchorRing, message);
      if (keptAnchor.removed > 0) {
        // Only the one key is replaced: the rest of the snapshot is carried
        // through as stored bytes, never re-parsed and re-serialized.
        update.preExchangeState = { ...anchor, voiceExemplars: keptAnchor.kept };
        snapshot += keptAnchor.removed;
      }
    }

    if (!update.voiceExemplars && !update.preExchangeState) continue;
    await db()
      .update(characterChatState)
      .set(update)
      .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, row.characterId)));
  }
  return { live, snapshot };
}

/** The stored snapshot as a plain object, or null for the `{}`/absent/array cases. */
function snapshotObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
