import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";
import {
  loadChatState,
  loadPreExchangeState,
  persistChatState,
  savePreExchangeSnapshot,
  seedChatState,
  type ChatState,
} from "./chat-state";

// Character-fidelity slices 8 + 10: the voice-exemplar ring and the persisted narrative
// trait overlays are new (chatId, characterId) state columns. This int test proves they
// round-trip the jsonb boundary AND roll back with the pre-exchange snapshot — the same
// "another take" guarantee the callback/selfie rings already carry.

const ready = await probeIntegrationDb("chat-state-fidelity.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();
let chat: ChatSeat = { chatId: "", memoryGroupId: "", messageId: "" };

const richProfile = (): CharacterProfile => ({
  ...emptyCharacterProfile(),
  traits: [{ id: "temperament.warmth", value: 0, source: "creation" }],
});

const richState = (): ChatState => ({
  ...seedChatState(richProfile()),
  voiceExemplars: [
    { line: "Tell me you at least practiced the toast.", atClockMinutes: 30 },
    { line: "No promises.", atClockMinutes: 60 },
  ],
  traitOverlays: [{ id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" }],
});

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-fidelity-int", userName: "Fidelity Int", characterName: "Mara" });
  chat = await newChat(fixture);
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

describe.runIf(ready)("voice-exemplar ring + trait overlays persistence (slices 8 + 10)", () => {
  it("round-trips both columns through the jsonb boundary", async () => {
    const sink = new DiagnosticCollector();
    await persistChatState(chat.chatId, fixture.characterId, richState());
    const loaded = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(loaded?.voiceExemplars).toHaveLength(2);
    expect(loaded?.voiceExemplars[0]?.line).toBe("Tell me you at least practiced the toast.");
    expect(loaded?.traitOverlays).toEqual([
      { id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" },
    ]);
    expect(sink.items).toHaveLength(0);
  });

  it("rolls back the ring + overlays with the pre-exchange snapshot ('another take')", async () => {
    // The row exists; record the rich state as the rollback anchor, then diverge the live row.
    await persistChatState(chat.chatId, fixture.characterId, richState());
    await savePreExchangeSnapshot(chat.chatId, fixture.characterId, richState());
    await persistChatState(chat.chatId, fixture.characterId, {
      ...seedChatState(richProfile()),
      voiceExemplars: [],
      traitOverlays: [],
    });

    const rolled = await loadPreExchangeState(chat.chatId, fixture.characterId);
    expect(rolled.found).toBe(true);
    expect(rolled.state?.voiceExemplars).toHaveLength(2);
    expect(rolled.state?.traitOverlays).toEqual([
      { id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" },
    ]);
  });
});
