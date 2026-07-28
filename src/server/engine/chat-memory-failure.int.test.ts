import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Codebase-review A7: a hard infra throw in the long-term memory write must not
// discard the exchange's state changes — `finalizeChatState` fences the write and
// still persists. AI_FAKE degrades the pulse/extraction legs; the memory module is
// mocked to throw like a down database would. Keyed on the conversation record
// (character-chat-standalone.spec.md §1.2): the state row is (chatId, characterId)
// and the memory write targets the participant's memory group.

// Every extraction leg down (chat-agent-improvements slice 1b) — the pre-split
// whole-archivist degrade — plus a rejecting `writeChatMemory`.
const mock = vi.hoisted(() => ({
  archivist: { value: null, degraded: true },
  legs: { memory: true, continuity: true, character: true },
  writeThrows: true,
}));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-memory-failure.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();
let chat: ChatSeat = { chatId: "", memoryGroupId: "", messageId: "" };

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-memfail-int", userName: "Mem Fail Int" });
  // The state row FKs the conversation + character, so seed a real chat with its
  // (v1 single) participant row carrying the memory group.
  chat = await newChat(fixture);
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

describe.runIf(ready)("finalizeChatState under a memory-write failure", () => {
  it("persists the state anyway and records the diagnostic", async () => {
    const { state, sink } = await settleChatExchange(fixture, {
      chat,
      assistantMessageId: "int-test-assistant-msg",
      preExchangeState: null,
      preExchangeScenario: null,
    });

    // The memory throw was fenced: the state row still landed (persisted at all ⇒ the
    // finalizer's save ran despite the failed memory leg).
    expect(state).not.toBeNull();
    expect(sink.items.map((d) => d.code)).toContain("chat_state.memory.write_failed");
  });
});
