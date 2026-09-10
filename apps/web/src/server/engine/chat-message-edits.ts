import { DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts";
import { log } from "../log";
import { messageBefore } from "./chat-reply-store";
import { reconcileMessageMemory, runChatMemoryScribe, writeChatMemory } from "./chat-memory";

/**
 * Memory reconciliation for one exchange whose wording changed: retract the old
 * extraction anchored on `reply`, then re-file that exchange from the CURRENT
 * transcript. Chat memory is filed per exchange and stored under the assistant
 * message id, so this is the repair for an edited reply AND for an edited or
 * deleted player line — the reply that answered it is the anchor either way.
 *
 * Only the MEMORY SCRIBE leg runs: this path rewrites no state row, so the
 * continuity/character reads would be discarded.
 *
 * Degradation is the caller's to report. A degraded scribe (demo mode, timeout,
 * unparseable output) leaves the retraction standing with nothing re-filed, which
 * is honest but is NOT "re-extracted" — `degraded` says so, and the caller's
 * `sink` sees the scribe's own diagnostics (docs/resilience.md §2).
 */
export async function reextractExchangeMemory(args: {
  chatId: string;
  /** The assistant reply the exchange is anchored on, with its CURRENT wording. */
  reply: { id: string; createdAt: Date; content: string };
  memoryGroupId: string;
  characterId: string;
  characterName: string;
  playerName: string;
  /** Optional observer; this helper keeps its own collector regardless. */
  sink?: DiagnosticSink;
}): Promise<{ degraded: boolean }> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = args.sink ? teeSink(args.sink, collected) : collected;
  await reconcileMessageMemory(args.reply.id, sink);
  // The player half is read back from the transcript rather than carried in: after
  // a player-line edit it is the NEW wording, and after a delete there is no player
  // half at all (the preceding row is another reply, or nothing).
  const prev = await messageBefore(args.chatId, args.reply);
  const archivist = await runChatMemoryScribe({
    characterName: args.characterName,
    playerName: args.playerName,
    exchange: { player: prev?.role === "user" ? prev.content : "", assistant: args.reply.content },
    sink,
  });
  await writeChatMemory({
    groupId: args.memoryGroupId,
    characterId: args.characterId,
    assistantMessageId: args.reply.id,
    archivist: archivist.value,
    sink,
  });
  if (collected.items.length) {
    log.info("engine.chat", "exchange re-extraction diagnostics", { codes: collected.items.map((d) => d.code) });
  }
  return { degraded: archivist.degraded };
}
