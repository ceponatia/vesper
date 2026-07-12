import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyCharacterProfile } from "@/contracts/world/profile";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, users } from "@/server/db";

// Codebase-review A7: a hard infra throw in the long-term memory write must not
// discard the exchange's state changes — `finalizeChatState` fences the write and
// still persists. AI_FAKE degrades the pulse/archivist legs; the memory module is
// mocked to throw like a down database would. Keyed on the conversation record
// (character-chat-standalone.spec.md §1.2): the state row is (chatId, characterId)
// and the memory write targets the participant's memory group.

process.env.AI_FAKE = "1";

vi.mock("./chat-memory", () => ({
  runChatArchivist: () => Promise.resolve({ value: null, degraded: true }),
  writeChatMemory: () => Promise.reject(new Error("memory infra down")),
}));

import { finalizeChatState, loadChatState, seedChatScenario, seedChatState } from "./chat-state";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_state limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[chat-memory-failure.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", chatId: "", memoryGroupId: "", messageId: "" };

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-memfail-int-${stamp}@test.local`, name: "Mem Fail Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  fixture.userId = user.id;
  const [character] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: "Wren", profile: {} })
    .returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;
  // The state row FKs the conversation + character, so seed a real chat with its
  // (v1 single) participant row carrying the memory group.
  const [chat] = await db().insert(characterChats).values({ ownerId: user.id }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  fixture.chatId = chat.id;
  fixture.memoryGroupId = newId();
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: character.id, memoryGroupId: fixture.memoryGroupId });
  const [message] = await db()
    .insert(characterChatMessages)
    .values({ chatId: chat.id, role: "user", content: "Hi" })
    .returning();
  if (!message) throw new Error("failed to create test message");
  fixture.messageId = message.id;
});

afterAll(async () => {
  if (!ready) return;
  // The chat row cascades state/messages/participants; characters and users FK it.
  await db().delete(characterChats).where(eq(characterChats.id, fixture.chatId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

describe("finalizeChatState under a memory-write failure", () => {
  it("persists the state anyway and records the diagnostic", async (t) => {
    if (!ready) return t.skip();
    const sink = new DiagnosticCollector();
    const now = new Date();
    await finalizeChatState({
      assistantMessageId: "int-test-assistant-msg",
      preExchangeState: null,
      chatId: fixture.chatId,
      characterId: fixture.characterId,
      memoryGroupId: fixture.memoryGroupId,
      promptMessageId: fixture.messageId,
      profile: emptyCharacterProfile(),
      characterName: "Wren",
      playerName: "You",
      driftedState: seedChatState(emptyCharacterProfile()),
      now,
      exchange: { player: "Hi", assistant: "Hello." },
      scenario: seedChatScenario(emptyCharacterProfile()),
      preExchangeScenario: null,
      sink,
    });

    // The memory throw was fenced: the state row still landed (persisted at all ⇒ the
    // finalizer's save ran despite the failed memory leg).
    const state = await loadChatState(fixture.chatId, fixture.characterId, sink);
    expect(state).not.toBeNull();
    expect(sink.items.map((d) => d.code)).toContain("chat_state.memory.write_failed");
  });
});
