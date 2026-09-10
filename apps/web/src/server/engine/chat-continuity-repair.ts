import { and, eq } from "drizzle-orm";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { characterChatState, db } from "../db";
import { log } from "../log";
import { reconcileMessageMemory } from "./chat-memory";
import { reextractEditedReply } from "./chat-message-edits";
import { repairChatSummaryForMessage } from "./chat-summary";
import { removeVoiceExemplarsForMessage, voiceExemplarsSchema, type VoiceExemplar } from "./chat-voice";

/**
 * Continuity repair after a transcript edit or delete.
 *
 * The transcript is not the only place a line's wording lives: the rolling
 * summary folds it into prose, the memory scribe files facts and an episode
 * against it, and the archivist may have kept it as a voice exemplar on the
 * state row. Rewriting or snipping the row alone leaves those derivatives
 * quoting the old text back into the next prompt, which is exactly the poisoned
 * context the edit was meant to remove. This module rebuilds all three, in one
 * pass, while the caller holds the chat exchange lock.
 *
 * Independent legs (docs/resilience.md §4): each step is wrapped, one failure is
 * recorded as an error diagnostic and the others still run. Nothing here throws
 * back at the route — the transcript write is already committed by the time this
 * runs, so a failed derivative is reported in the response envelope rather than
 * hidden behind a 500. Summary repair never restores stale prose: it reuses
 * `rebuildChatSummary`, whose reset-then-refold leaves an empty summary and a
 * null watermark when the first fold degrades, which is the honest degraded
 * state (the verbatim window then carries the whole transcript).
 */

/** Whether the rolling summary had to be re-folded for this message. */
export type ChatContinuitySummaryOutcome = "rebuilt" | "unaffected" | "failed";
/** What happened to the memory extracted from this message. */
export type ChatContinuityMemoryOutcome = "reextracted" | "reconciled" | "unaffected" | "failed";
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
  };
  /**
   * Assistant EDIT only: what the memory scribe needs to re-file the edited
   * exchange after retracting the old extraction. Absent (or a user line) means
   * retract-only.
   */
  reextract?: {
    memoryGroupId: string;
    characterId: string;
    characterName: string;
    playerName: string;
    content: string;
  };
  /** Optional observer; the repair keeps its own collector regardless (docs/resilience.md §2). */
  sink?: DiagnosticSink;
}

/**
 * Rebuild the model-facing derivatives of one edited/deleted message. Runs the
 * memory step, then the summary step, then the voice step; the caller holds the
 * chat exchange lock across all three.
 *
 * Memory and voice are assistant-only: chat memory is anchored on assistant
 * message ids (docs/memory.md) and the voice ring quotes the character, not the
 * player. Summary repair applies to BOTH roles — the fold reads the player's
 * lines too, so an edited user line at or before the watermark is just as
 * covered.
 */
export async function repairChatContinuityAfterEdit(input: ChatContinuityRepairInput): Promise<ChatContinuityRepair> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  const { chatId, operation, message } = input;
  const assistant = message.role === "assistant";

  let memory: ChatContinuityMemoryOutcome = "unaffected";
  if (assistant) {
    try {
      if (operation === "edit" && input.reextract) {
        // Retracts the old extraction first, then re-files the scribe leg from
        // the edited text. AWAITED: an immediate next send must not race a
        // retrieval that still holds the old facts.
        await reextractEditedReply({ chatId, messageId: message.id, ...input.reextract });
        memory = "reextracted";
      } else {
        await reconcileMessageMemory(message.id, sink);
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
  if (summary === "failed" || memory === "failed" || voice === "failed") {
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
