import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { mergeChatExtractions, type ChatExtractionLegs } from "@/contracts/turns/chat-archivist";
import { emptyCharacterProfile } from "@/contracts/world/profile";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, users } from "@/server/db";

/**
 * Per-leg degradation (chat-agent-improvements.plan.md slice 1b). The whole point of
 * splitting the 13-field archivist into three focused legs is that ONE failing leg costs
 * only its own fields. The folds in `finalizeChatState` therefore key on the leg that owns
 * each field, not on a single whole-extraction flag:
 *
 * - a degraded CHARACTER leg keeps the standing open loops (an empty list must never wipe
 *   them — the pre-split rule, now keyed to the leg that actually reads loops);
 * - a degraded MEMORY leg drops the stale memory queries and flags the memory trace;
 * - a healthy leg's fields land regardless of what the other legs did.
 *
 * Drives `finalizeChatState` with a mocked extraction (AI_FAKE would degrade every leg),
 * following chat-memory-failure.int.test.ts.
 */

process.env.AI_FAKE = "1";

const mock = vi.hoisted(() => ({
  result: {
    value: null as ReturnType<typeof mergeChatExtractions> | null,
    degraded: false,
    legs: { memory: false, continuity: false, character: false } as ChatExtractionLegs,
  },
}));

vi.mock("./chat-memory", () => ({
  runChatExtraction: () => Promise.resolve(mock.result),
  writeChatMemory: () => Promise.resolve(),
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
      `[chat-extraction-legs.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
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
    .values({ email: `chat-legs-int-${stamp}@test.local`, name: "Legs Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  fixture.userId = user.id;
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Wren", profile: {} }).returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;
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
  await db().delete(characterChats).where(eq(characterChats.id, fixture.chatId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

/** Run one exchange through the finalizer with the given standing loops + mocked legs. */
async function settle(args: {
  standingLoops: readonly string[];
  legs: ChatExtractionLegs;
  value: ReturnType<typeof mergeChatExtractions> | null;
}) {
  mock.result = { value: args.value, degraded: args.legs.memory && args.legs.continuity && args.legs.character, legs: args.legs };
  const sink = new DiagnosticCollector();
  const profile = emptyCharacterProfile();
  await finalizeChatState({
    assistantMessageId: `int-legs-${newId()}`,
    preExchangeState: null,
    chatId: fixture.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    memoryGroupId: fixture.memoryGroupId,
    promptMessageId: fixture.messageId,
    profile,
    characterName: "Wren",
    playerName: "You",
    driftedState: { ...seedChatState(profile), openLoops: [...args.standingLoops] },
    now: new Date(),
    exchange: { player: "Hi", assistant: "Hello." },
    scenario: seedChatScenario(profile),
    preExchangeScenario: null,
    sink,
  });
  const state = await loadChatState(fixture.chatId, fixture.characterId, sink);
  if (!state) throw new Error("state row missing after finalize");
  return state;
}

describe("finalizeChatState — per-leg extraction degradation (slice 1b)", () => {
  it("a degraded CHARACTER leg keeps the standing open loops (an empty list never wipes them)", async (t) => {
    if (!ready) return t.skip();
    const state = await settle({
      standingLoops: ["hear how the toast goes"],
      legs: { memory: false, continuity: false, character: true },
      // The character leg contributed nothing; the others were healthy.
      value: mergeChatExtractions({
        memory: { episodeSummary: "They said hello.", facts: [], memoryQueries: ["the toast"] },
        continuity: null,
        character: null,
      }),
    });
    expect(state.openLoops).toEqual(["hear how the toast goes"]);
    // The healthy scribe's fields still landed — one leg's failure costs only its own.
    expect(state.memoryQueries).toEqual(["the toast"]);
    expect(state.lastMemoryTrace.episodeSummary).toBe("They said hello.");
    expect(state.lastMemoryTrace.degraded).toBe(false);
  });

  it("a HEALTHY character leg replaces the loops with its full re-emitted list", async (t) => {
    if (!ready) return t.skip();
    const state = await settle({
      standingLoops: ["hear how the toast goes"],
      legs: { memory: false, continuity: false, character: false },
      value: mergeChatExtractions({
        memory: null,
        continuity: null,
        character: {
          openLoops: ["show him the studio"],
          plans: [],
          driveUpdates: [],
          voiceExemplar: "",
          characterSlip: "",
          traitShifts: [],
        },
      }),
    });
    expect(state.openLoops).toEqual(["show him the studio"]);
  });

  it("a degraded MEMORY leg flags the memory trace and drops stale queries — without touching the loops", async (t) => {
    if (!ready) return t.skip();
    const state = await settle({
      standingLoops: ["hear how the toast goes"],
      legs: { memory: true, continuity: false, character: false },
      value: mergeChatExtractions({
        memory: null,
        continuity: null,
        character: {
          openLoops: ["show him the studio"],
          plans: [],
          driveUpdates: [],
          voiceExemplar: "",
          characterSlip: "",
          traitShifts: [],
        },
      }),
    });
    expect(state.lastMemoryTrace.degraded).toBe(true);
    expect(state.lastMemoryTrace.episodeSummary).toBe("");
    expect(state.memoryQueries).toEqual([]);
    // The character leg was healthy, so its loops landed even though memory failed.
    expect(state.openLoops).toEqual(["show him the studio"]);
  });
});
