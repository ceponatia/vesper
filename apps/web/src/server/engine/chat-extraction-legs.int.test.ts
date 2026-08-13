import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mergeChatExtractions, type ChatArchivist, type ChatExtractionLegs } from "@/contracts/turns/chat-archivist";

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

const mock = vi.hoisted(() => ({
  archivist: { value: null as ChatArchivist | null, degraded: false },
  legs: { memory: false, continuity: false, character: false },
}));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import { seedChatState } from "./chat-state";
import {
  dropChatFixture,
  emptyChatFixture,
  HEALTHY_EXTRACTION_LEGS,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-extraction-legs.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();
let chat: ChatSeat = { chatId: "", memoryGroupId: "", messageId: "" };

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-legs-int", userName: "Legs Int" });
  chat = await newChat(fixture);
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** Run one exchange through the finalizer with the given standing loops + mocked legs. */
async function settle(args: {
  standingLoops: readonly string[];
  legs: ChatExtractionLegs;
  value: ChatArchivist | null;
}) {
  mock.archivist = {
    value: args.value,
    degraded: args.legs.memory && args.legs.continuity && args.legs.character,
  };
  mock.legs = args.legs;
  const { state } = await settleChatExchange(fixture, {
    chat,
    driftedState: { ...seedChatState(fixture.profile), openLoops: [...args.standingLoops] },
    preExchangeState: null,
    preExchangeScenario: null,
  });
  if (!state) throw new Error("state row missing after finalize");
  return state;
}

/** The character leg's full re-emitted note set — only `openLoops` varies across cases. */
const characterNotes = (openLoops: readonly string[]) => ({
  openLoops: [...openLoops],
  plans: [],
  driveUpdates: [],
  voiceExemplar: "",
  characterSlip: "",
  traitShifts: [],
});

describe.runIf(ready)("finalizeChatState — per-leg extraction degradation (slice 1b)", () => {
  it("a degraded CHARACTER leg keeps the standing open loops (an empty list never wipes them)", async () => {
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

  it("a HEALTHY character leg replaces the loops with its full re-emitted list", async () => {
    const state = await settle({
      standingLoops: ["hear how the toast goes"],
      legs: HEALTHY_EXTRACTION_LEGS,
      value: mergeChatExtractions({
        memory: null,
        continuity: null,
        character: characterNotes(["show him the studio"]),
      }),
    });
    expect(state.openLoops).toEqual(["show him the studio"]);
  });

  it("a degraded MEMORY leg flags the memory trace and drops stale queries — without touching the loops", async () => {
    const state = await settle({
      standingLoops: ["hear how the toast goes"],
      legs: { memory: true, continuity: false, character: false },
      value: mergeChatExtractions({
        memory: null,
        continuity: null,
        character: characterNotes(["show him the studio"]),
      }),
    });
    expect(state.lastMemoryTrace.degraded).toBe(true);
    expect(state.lastMemoryTrace.episodeSummary).toBe("");
    expect(state.memoryQueries).toEqual([]);
    // The character leg was healthy, so its loops landed even though memory failed.
    expect(state.openLoops).toEqual(["show him the studio"]);
  });
});
