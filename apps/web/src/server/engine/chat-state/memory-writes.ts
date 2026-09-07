import { diag } from "@/contracts";
import { writeChatMemory, type ChatExtractionResult } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";

type WriteFinalizationMemoryInput = Pick<
  FinalizeChatStateInput,
  "memoryGroupId"
  | "characterId"
  | "assistantMessageId"
  | "sink"
  | "extraMemoryWrites"
>;

export async function writeFinalizationMemory(
  input: WriteFinalizationMemoryInput,
  archivist: ChatExtractionResult,
) {
  // Write the extracted long-term memory (episode + facts) under the chat scope. Off the
  // reply path; degrades internally (a failed leg / embedding just adds a diagnostic) —
  // and additionally fenced here, because a hard infra throw in the memory write must
  // not cost the pulse's state changes: the caller can continue to state persistence.
  try {
    await writeChatMemory({
      groupId: input.memoryGroupId,
      characterId: input.characterId,
      assistantMessageId: input.assistantMessageId,
      archivist: archivist.value,
      sink: input.sink,
    });
  } catch (error) {
    input.sink?.push(
      diag(
        "warn",
        "chat_state.memory.write_failed",
        `long-term memory write failed; state still persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  // Every present ensemble witness files the same extraction under their OWN
  // group (ruling 5) — separately fenced so one member's failed write never
  // costs another's; the caller can continue to state persistence.
  const seenGroups = new Set([input.memoryGroupId]);
  for (const extra of input.extraMemoryWrites ?? []) {
    if (seenGroups.has(extra.groupId)) continue;
    seenGroups.add(extra.groupId);
    try {
      await writeChatMemory({
        groupId: extra.groupId,
        characterId: extra.characterId,
        assistantMessageId: input.assistantMessageId,
        archivist: archivist.value,
        sink: input.sink,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          "chat_state.memory.write_failed",
          `ensemble member memory write failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }


}
