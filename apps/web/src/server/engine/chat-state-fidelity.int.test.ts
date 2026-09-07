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
import { loadChatScenario, loadChatState, persistChatState } from "./chat-state/store";
import { loadPreExchangeState, savePreExchangeSnapshot } from "./chat-state/snapshots";
import { persistSurfaceTransferSettlement } from "./chat-state/surface-transfer";
import { seedChatState, type ChatState } from "./chat-state";
import {
  commitBodySurfaceDeposit,
  emptyBodySurfaceState,
  recordBodySurfaceTransferReceipt,
} from "@/contracts/state/body-surface";

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

/**
 * The conserved-transfer persistence boundary.
 *
 * Conservation requires source removal and destination deposition to commit
 * atomically under one idempotency key. The pure transaction in
 * `contracts/turns/chat-contact-transfer.ts` owns the conservation arithmetic and
 * proves it exhaustively; what it cannot prove is the half this file is for.
 * Skin lives in `character_chat_state.body_surface` and worn layers in
 * `character_chats.garments` — two rows, historically two independent
 * statements — so "the debit and the credit are one write" is a claim about
 * Postgres, and only Postgres can answer it.
 *
 * The failure is INJECTED rather than simulated: the receiving character id
 * names nobody, so its upsert violates the `character_id` foreign key AFTER the
 * primary row and the scenario have already been written inside the
 * transaction. A seam that ran those as independent statements would leave the
 * debit standing, the credit missing, and — worst of all — the transfer's
 * receipt persisted on the debited surface, which is exactly the state no retry
 * can detect and no retake can undo.
 */
describe.runIf(ready)("a transfer-bearing settle commits as one write", () => {
  const TRANSFER_KEY = "surface_transfer\u001fprobe\u001fdep:mud:hands:0";

  /** A surface that has been debited and carries the receipt saying so. */
  const debitedSurface = () => {
    const dirty = commitBodySurfaceDeposit(emptyBodySurfaceState(), {
      locationId: "hands",
      kind: "mud",
      amount: 4_000,
      atMinutes: 0,
    });
    const receipt = recordBodySurfaceTransferReceipt(dirty, {
      transferKey: TRANSFER_KEY,
      amount: 4_000,
      atMinutes: 0,
    });
    if (receipt.status !== "recorded") throw new Error("fixture did not record a receipt");
    return receipt.state;
  };

  it("rolls the debit AND its receipt back when the credited row cannot be written", async () => {
    const sink = new DiagnosticCollector();
    const baseline = seedChatState(richProfile());
    await persistChatState(chat.chatId, fixture.characterId, baseline);
    const scenario = await loadChatScenario(chat.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");

    await expect(
      persistSurfaceTransferSettlement({
        chatId: chat.chatId,
        characterId: fixture.characterId,
        promptMessageId: chat.messageId,
        state: { ...baseline, bodySurface: debitedSurface() },
        scenario,
        preExchangeState: baseline,
        preExchangeScenario: scenario,
        destination: {
          characterId: "nobody_at_all_0000000000",
          state: baseline,
          preExchangeState: baseline,
        },
      }),
    ).rejects.toThrow();

    const after = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(after?.bodySurface.deposits).toBeUndefined();
    expect(after?.bodySurface.transfers).toBeUndefined();
  });

  it("writes the debit, the layer store and both rollback anchors together when it succeeds", async () => {
    const sink = new DiagnosticCollector();
    const baseline = seedChatState(richProfile());
    await persistChatState(chat.chatId, fixture.characterId, baseline);
    const scenario = await loadChatScenario(chat.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");

    await persistSurfaceTransferSettlement({
      chatId: chat.chatId,
      characterId: fixture.characterId,
      promptMessageId: chat.messageId,
      state: { ...baseline, bodySurface: debitedSurface() },
      scenario,
      preExchangeState: baseline,
      preExchangeScenario: scenario,
    });

    const after = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(after?.bodySurface.deposits).toBeDefined();
    expect(after?.bodySurface.transfers?.[TRANSFER_KEY]).toMatchObject({ amount: 4_000 });
    // The anchor rides the same transaction, so a retake has something to
    // restore that predates the debit.
    const anchor = await loadPreExchangeState(chat.chatId, fixture.characterId);
    expect(anchor.found).toBe(true);
    expect(anchor.state?.bodySurface.transfers).toBeUndefined();
  });

  /**
   * The settlement runs on ONE guard decision, taken under a `for update` lock
   * on the prompting message before any write. Falsified against the six
   * independent `exists (select 1 from character_chat_messages …)` guards it
   * replaced: under READ COMMITTED each of those takes its own snapshot, so a
   * Clear/Reset landing mid-settlement let the first upsert apply, every later
   * write no-op, and the transaction COMMIT the difference — a debit with no
   * credit and no anchor to retake from. Kills equally the "just return
   * quietly" fix, which no caller could tell apart from a successful settle
   * while the settlement's diagnostics claimed material had moved.
   */
  it("writes nothing and rejects when the prompting message is already gone", async () => {
    const sink = new DiagnosticCollector();
    const baseline = seedChatState(richProfile());
    await persistChatState(chat.chatId, fixture.characterId, baseline);
    const scenario = await loadChatScenario(chat.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");

    await expect(
      persistSurfaceTransferSettlement({
        chatId: chat.chatId,
        characterId: fixture.characterId,
        // Names no row — the Clear/Reset already took the exchange this
        // settlement belongs to.
        promptMessageId: "deleted_prompt_message00",
        state: { ...baseline, bodySurface: debitedSurface() },
        scenario,
        preExchangeState: baseline,
        preExchangeScenario: scenario,
      }),
    ).rejects.toThrow();

    const after = await loadChatState(chat.chatId, fixture.characterId, sink);
    expect(after?.bodySurface.deposits).toBeUndefined();
    expect(after?.bodySurface.transfers).toBeUndefined();
  });
});
