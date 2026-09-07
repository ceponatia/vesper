import { and, eq } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts";
import { characterChatMessages, db } from "../db";
import { log } from "../log";
import { messageBefore } from "./chat-reply-store";
import { reconcileMessageMemory, runChatMemoryScribe, writeChatMemory } from "./chat-memory";

/**
 * Memory reconciliation for an edited assistant reply: retract the
 * old extraction, then re-file the edited exchange's long-term memory
 * fire-and-forget — same resilience as the live fan-out (a degraded re-extract
 * just leaves the exchange unremembered, with the retraction already honest).
 * Only the MEMORY SCRIBE leg runs: this path
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
