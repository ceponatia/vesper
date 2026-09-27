import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characterChats, characterChatState, db } from "@/server/db";
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
  loadChatScenario,
  loadChatState,
  persistChatState,
  persistChatTimeSkip,
  saveChatScenario,
} from "./chat-state/store";
import { loadPreExchangeState, savePreExchangeSnapshot } from "./chat-state/snapshots";
import { persistSurfaceTransferSettlement } from "./chat-state/surface-transfer";
import { driftChatState, seedChatState, type ChatState } from "./chat-state";
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
    { line: "Tell me you at least practiced the toast.", atClockMinutes: 30, sourceMessageId: null },
    { line: "No promises.", atClockMinutes: 60, sourceMessageId: null },
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

/**
 * The meters' story-time stamp (#299) is a persistence claim. Drift integrates
 * from the minute a row's meters hold at, so every write must carry that minute,
 * a never-stamped state (a fresh seed, an author's meter edit) must take its
 * chat's clock AS OF THE WRITE rather than minute 0 — or the first read would
 * drain the character across the chat's whole history — and the retake anchor
 * must carry it, or a retake would re-integrate a different interval than the
 * take it discards.
 */
describe.runIf(ready)("the meters' story-time stamp", () => {
  it("round-trips an explicit stamp and the sleep record through the row and the retake anchor", async () => {
    const stamped: ChatState = { ...seedChatState(richProfile()), metersAtMinutes: 120, lastSleepEndedAtMinutes: 60 };
    await persistChatState(chat.chatId, fixture.characterId, stamped);
    const loaded = await loadChatState(chat.chatId, fixture.characterId);
    expect(loaded?.metersAtMinutes).toBe(120);
    expect(loaded?.lastSleepEndedAtMinutes).toBe(60);
    await savePreExchangeSnapshot(chat.chatId, fixture.characterId, stamped);
    const anchor = (await loadPreExchangeState(chat.chatId, fixture.characterId)).state;
    expect(anchor?.metersAtMinutes).toBe(120);
    expect(anchor?.lastSleepEndedAtMinutes).toBe(60);
    // "No sleep on record" is a stored fact too, never healed into an invented wake time.
    await persistChatState(chat.chatId, fixture.characterId, { ...stamped, lastSleepEndedAtMinutes: null });
    expect((await loadChatState(chat.chatId, fixture.characterId))?.lastSleepEndedAtMinutes).toBeNull();
  });

  it("stamps a never-stamped state at its chat's clock as of the write", async () => {
    const later = await newChat(fixture);
    const scenario = await loadChatScenario(later.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");
    await saveChatScenario(later.chatId, { ...scenario, clockMinutes: 300 });
    await persistChatState(later.chatId, fixture.characterId, seedChatState(richProfile()));
    expect((await loadChatState(later.chatId, fixture.characterId))?.metersAtMinutes).toBe(300);
  });
});

/**
 * A time skip's clock and member rows are one write. The failure is INJECTED as
 * in the transfer suite above: the second member names nobody, so its upsert
 * violates the `character_id` foreign key AFTER the advanced scenario and the
 * first member's caught-up row were already written inside the transaction. A
 * skip that committed the clock first and the members one by one (its shape
 * before #299) would leave the clock nine story hours past a member still
 * stamped at the old boundary.
 */
describe.runIf(ready)("a time skip commits the clock and every member together", () => {
  it("rolls the advanced clock back with a member write that fails", async () => {
    const baseline: ChatState = { ...seedChatState(richProfile()), metersAtMinutes: 0 };
    await persistChatState(chat.chatId, fixture.characterId, baseline);
    const scenario = await loadChatScenario(chat.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");
    const skipped = { ...scenario, clockMinutes: scenario.clockMinutes + 540 };
    const caughtUp = driftChatState(baseline, richProfile(), {
      clockMinutes: skipped.clockMinutes,
      calendarStart: skipped.calendarStart,
    });

    await expect(
      persistChatTimeSkip(chat.chatId, skipped, [
        { characterId: fixture.characterId, state: caughtUp },
        { characterId: "nobody_at_all_0000000000", state: caughtUp },
      ]),
    ).rejects.toThrow();

    expect((await loadChatScenario(chat.chatId))?.clockMinutes).toBe(scenario.clockMinutes);
    const after = await loadChatState(chat.chatId, fixture.characterId);
    expect(after?.metersAtMinutes).toBe(0);
    expect(after?.meters).toEqual(baseline.meters);
  });

  it("writes the advanced clock and every member's caught-up row when it succeeds", async () => {
    const baseline: ChatState = { ...seedChatState(richProfile()), metersAtMinutes: 0 };
    await persistChatState(chat.chatId, fixture.characterId, baseline);
    const scenario = await loadChatScenario(chat.chatId);
    if (scenario === null) throw new Error("fixture has no scenario");
    const skipped = { ...scenario, clockMinutes: scenario.clockMinutes + 540 };
    const caughtUp = driftChatState(baseline, richProfile(), {
      clockMinutes: skipped.clockMinutes,
      calendarStart: skipped.calendarStart,
    });

    await persistChatTimeSkip(chat.chatId, skipped, [{ characterId: fixture.characterId, state: caughtUp }]);

    expect((await loadChatScenario(chat.chatId))?.clockMinutes).toBe(skipped.clockMinutes);
    const after = await loadChatState(chat.chatId, fixture.characterId);
    expect(after?.metersAtMinutes).toBe(skipped.clockMinutes);
    expect(after?.meters).toEqual(caughtUp.meters);
  });
});

/**
 * Migration 0149's hand-written backfill, replayed against staged rows.
 *
 * CI migrates a FRESH database, where the backfill finds no row to stamp, so
 * the statement that decides what every existing conversation's meters hold
 * at is otherwise never run against a pre-existing row. This replays the
 * statement exactly as the migration ships it — read from the file, never
 * re-typed, the replay pattern `image-model-seeds.int.test.ts` uses for the
 * image-registry migrations — beside rows staged the way the column's arrival
 * found them: stamps NULL, on chats standing at different clocks, plus one row
 * a current writer already stamped.
 *
 * The statement is global by design (every NULL row in the database); rows
 * other suites inserted without a stamp receive exactly what the migration
 * would have given them.
 */
describe.runIf(ready)("migration 0149 backfills each unstamped row from its own chat's clock", () => {
  const MIGRATION_FILE = "drizzle/0149_chat-meters-at-minutes.sql";

  /** 0149's shipped backfill, as the file carries it (its leading comment included). */
  async function backfillStatements(): Promise<string[]> {
    const sqlText = await readFile(path.join(process.cwd(), MIGRATION_FILE), "utf8");
    return sqlText
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.toUpperCase().includes('UPDATE "CHARACTER_CHAT_STATE"'));
  }

  async function replayBackfill(): Promise<void> {
    const statements = await backfillStatements();
    for (const statement of statements) await db().execute(sql.raw(statement));
  }

  async function stampsAndMeters(chatIds: readonly string[]) {
    const rows = await db()
      .select({
        chatId: characterChatState.chatId,
        metersAtMinutes: characterChatState.metersAtMinutes,
        meters: characterChatState.meters,
      })
      .from(characterChatState)
      .where(and(inArray(characterChatState.chatId, [...chatIds]), eq(characterChatState.characterId, fixture.characterId)));
    return new Map(rows.map((row) => [row.chatId, row]));
  }

  it("stamps every NULL row with its own chat's clock, leaves a stamped row and every meters value alone, and is a no-op on re-run", async () => {
    // A file this suite could not parse must fail before anything is staged.
    expect(await backfillStatements(), `${MIGRATION_FILE} must carry exactly one backfill UPDATE`).toHaveLength(1);

    const staged = [
      { clockMinutes: 300, metersAtMinutes: null, meters: { hygiene: 0.41, energy: 0.52 } },
      { clockMinutes: 1_440, metersAtMinutes: null, meters: { hygiene: 0.63, stress: 0.74 } },
      // Stamped by a current writer at a minute that is NOT its chat's clock — rewinding it would show.
      { clockMinutes: 500, metersAtMinutes: 123, meters: { hygiene: 0.85, mood: 0.5 } },
    ];
    const chatIds: string[] = [];
    for (const row of staged) {
      const seat = await newChat(fixture);
      chatIds.push(seat.chatId);
      await db().update(characterChats).set({ clockMinutes: row.clockMinutes }).where(eq(characterChats.id, seat.chatId));
      await db().insert(characterChatState).values({
        chatId: seat.chatId,
        characterId: fixture.characterId,
        meters: row.meters,
        metersAtMinutes: row.metersAtMinutes,
      });
    }

    await replayBackfill();
    const after = await stampsAndMeters(chatIds);
    for (const [index, row] of staged.entries()) {
      const chatId = chatIds[index];
      if (chatId === undefined) throw new Error("staged chat missing");
      const stored = after.get(chatId);
      expect(stored?.metersAtMinutes).toBe(row.metersAtMinutes ?? row.clockMinutes);
      expect(stored?.meters).toEqual(row.meters);
    }

    // Guarded on IS NULL: once stamped, a row is never re-stamped — even after
    // its chat's clock moves on.
    const firstChat = chatIds[0];
    if (firstChat === undefined) throw new Error("staged chat missing");
    await db().update(characterChats).set({ clockMinutes: 999 }).where(eq(characterChats.id, firstChat));
    await replayBackfill();
    const rerun = await stampsAndMeters(chatIds);
    expect(chatIds.map((chatId) => rerun.get(chatId)?.metersAtMinutes)).toEqual([300, 1_440, 123]);
  });
});

