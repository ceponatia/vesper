import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startExchangeTrace } from "@/server/engine/chat-exchange-trace";
import { recordAgentFailure, recordAgentRun } from "@/server/ai/agent-failures";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";
import { characterChats, db, events } from "../db";
import { loadChatExchangeTraces } from "./chat-exchange-trace-log";

/**
 * Integration coverage for the exchange-trace read model (#637): writes
 * through the REAL recorder (`startExchangeTrace`, fire-and-forget `flush()`,
 * real `logEvent`) against the real database, then reads back through
 * `loadChatExchangeTraces` and checks the assembled trace — including a
 * correlated `agent_run` row written by the existing telemetry recorder.
 *
 * `flush()` / `recordAgentRun()` are fire-and-forget by design (the recorder
 * must never await a write on the caller's path), so this suite POLLS for the
 * row rather than sleeping a fixed amount — the same pattern
 * `identity-pack-lifecycle.int.test.ts` uses for its own fire-and-forget writer.
 *
 * Correlated rows and trace lookups are filtered in SQL by the selected
 * trace id(s), so a busy chat's newer, unrelated activity cannot crowd an
 * older selected trace's own rows out of a bounded scan window; two suites
 * below bulk-insert noise (one multi-row INSERT, not many round trips) past
 * the read model's private per-type caps, landing after the target's own
 * rows, and assert the target still surfaces. A further suite proves
 * ordering is by when each exchange STARTED, not by its last flush, so a
 * late part on an older trace cannot outrank a genuinely newer one.
 */

const ready = await probeIntegrationDb("chat-exchange-trace-log.int.test", "events");

let ownerId = "";

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

/** Poll until at least `minCount` rows of `type` exist for `chatId`, or give up. */
async function waitForEventRows(type: string, chatId: string, minCount: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await db()
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.type, type), eq(events.chatId, chatId)));
    if (rows.length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`events of type "${type}" for chat ${chatId} never reached ${minCount} row(s)`);
}

describe.skipIf(!ready)("chat exchange trace log (integration)", () => {
  let chatId = "";

  beforeAll(async () => {
    ownerId = (await seedTestUser("chat-exchange-trace-log-int")).id;
    const [chat] = await db().insert(characterChats).values({ ownerId }).returning({ id: characterChats.id });
    if (!chat) throw new Error("failed to create test chat");
    chatId = chat.id;
  });

  it("writes through the recorder and reads back one assembled trace with a correlated agent run", async () => {
    const trace = startExchangeTrace({
      chatId,
      operation: "send",
      authority: "legacy_chat",
      lane: "legacy_chat",
      promptMessageId: "msg-prompt",
    });
    const traceId = trace.traceId;

    trace.begin("state.load", "admission").end({ status: "success" });
    const narratorHandle = trace.begin("narrator.prompt", "narrator");
    narratorHandle.end({ status: "success", detail: "assembled 4 prompt units" });
    trace.coverage({ family: "history", status: "present", count: 3, summary: "3 recent turns" });
    trace.annotate({ replyMessageId: "msg-reply" });
    trace.finish({ kind: "ok" });
    trace.flush();
    await waitForEventRows("chat_trace", chatId, 1);

    recordAgentRun({ legId: "chat_memory_scribe", chatId, traceId, modelId: "test/model", latencyMs: 120, summary: "1 fact" });
    await waitForEventRows("agent_run", chatId, 1);

    const traces = await loadChatExchangeTraces({ chatId, limit: 1 });
    expect(traces).toHaveLength(1);
    const assembled = traces[0];
    expect(assembled?.traceId).toBe(traceId);
    expect(assembled?.unreadableParts).toBe(0);
    expect(assembled?.header).toMatchObject({
      traceId,
      chatId,
      operation: "send",
      authority: "legacy_chat",
      lane: "legacy_chat",
      promptMessageId: "msg-prompt",
      replyMessageId: "msg-reply",
    });
    expect(assembled?.stages.map((s) => s.stage)).toEqual(["state.load", "narrator.prompt"]);
    expect(assembled?.stages[0]).toMatchObject({ status: "success" });
    // The dev (non-production) content split round-trips through real jsonb storage.
    expect(assembled?.stages[1]).toMatchObject({ status: "success", detail: "assembled 4 prompt units" });
    expect(assembled?.coverage).toEqual([{ family: "history", status: "present", count: 3, summary: "3 recent turns" }]);
    expect(assembled?.finish).toMatchObject({ kind: "ok" });
    expect(assembled?.outcome).toBe("ok");
    expect(assembled?.agentRuns).toHaveLength(1);
    expect(assembled?.agentRuns[0]).toMatchObject({ legId: "chat_memory_scribe", traceId, modelId: "test/model" });
  });

  it("loadChatExchangeTraces by explicit traceId returns exactly that trace", async () => {
    const first = startExchangeTrace({ chatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    first.finish({ kind: "ok" });
    first.flush();
    const second = startExchangeTrace({ chatId, operation: "continue", authority: "legacy_chat", lane: "legacy_chat" });
    second.finish({ kind: "ok" });
    second.flush();
    // Both flushes are fire-and-forget; poll the read model itself (bounded) rather than the
    // raw row count, which is already satisfied by the first test's own rows on this chat.
    let traces = await loadChatExchangeTraces({ chatId, traceId: first.traceId });
    for (let attempt = 0; attempt < 400 && traces.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      traces = await loadChatExchangeTraces({ chatId, traceId: first.traceId });
    }
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe(first.traceId);
    expect(traces[0]?.header.operation).toBe("send");
  });

  it("loadChatExchangeTraces by messageId finds the trace whose header names it", async () => {
    const trace = startExchangeTrace({
      chatId,
      operation: "send",
      authority: "legacy_chat",
      lane: "legacy_chat",
      promptMessageId: "msg-findable-prompt",
    });
    trace.finish({ kind: "ok" });
    trace.flush();

    let traces: Awaited<ReturnType<typeof loadChatExchangeTraces>> = [];
    for (let attempt = 0; attempt < 400 && traces.length === 0; attempt += 1) {
      traces = await loadChatExchangeTraces({ chatId, messageId: "msg-findable-prompt" });
      if (traces.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe(trace.traceId);
  });

  it("returns [] for a chat with no trace rows, never throwing", async () => {
    const [emptyChat] = await db().insert(characterChats).values({ ownerId }).returning({ id: characterChats.id });
    if (!emptyChat) throw new Error("failed to create test chat");
    expect(await loadChatExchangeTraces({ chatId: emptyChat.id })).toEqual([]);
  });

  it("a correlated agent_failure older than many newer unrelated agent rows still surfaces (no crowding)", async () => {
    const trace = startExchangeTrace({ chatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const traceId = trace.traceId;
    // A clean finish — only the correlated failure below should degrade the outcome.
    trace.finish({ kind: "ok" });
    trace.flush();
    await waitForEventRows("chat_trace", chatId, 1);

    // The trace's OWN correlated failure, written BEFORE the noise below so it is genuinely the
    // older row (real inserts, real wall-clock `created_at` — not a faked timestamp).
    recordAgentFailure({ legId: "chat_memory_scribe", chatId, traceId, kind: "timeout", detail: "an old, real failure" });
    await waitForEventRows("agent_failure", chatId, 1);

    // Comfortably above the read model's private per-type scan cap (1000 agent_failure rows):
    // one bulk INSERT (fast — a single multi-row statement, not 1,050 round trips), every row
    // landing with a LATER created_at than the trace's own row above. Under the PRE-FIX
    // implementation (scan the newest 1000 agent_failure rows for the WHOLE CHAT, then filter by
    // traceId in app code), this noise would crowd the trace's own, older row out of the window
    // entirely and the correlation would silently read as healthy.
    const noiseCount = 1050;
    await db()
      .insert(events)
      .values(
        Array.from({ length: noiseCount }, (_, i) => ({
          type: "agent_failure",
          chatId,
          payload: { legId: "noise", kind: "timeout", cause: "model_slow", traceId: `noise-trace-${i}` },
        })),
      );

    const traces = await loadChatExchangeTraces({ chatId, traceId });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.agentFailures).toHaveLength(1);
    expect(traces[0]?.agentFailures[0]).toMatchObject({ legId: "chat_memory_scribe", traceId });
    // finish was "ok", but a correlated agent failure still degrades the outcome (the outcome table) —
    // the exact fallback-reads-as-healthy failure mode this fix closes.
    expect(traces[0]?.outcome).toBe("degraded");
  });

  it("an explicit traceId lookup finds a trace whose rows are older than many newer unrelated chat_trace rows", async () => {
    const trace = startExchangeTrace({
      chatId,
      operation: "send",
      authority: "legacy_chat",
      lane: "legacy_chat",
      promptMessageId: "msg-old-window",
    });
    const traceId = trace.traceId;
    trace.finish({ kind: "ok" });
    trace.flush();

    // Confirm it is findable BEFORE burying it under noise, so a failure below points at the
    // noise step rather than an ordinary fire-and-forget race.
    let found = await loadChatExchangeTraces({ chatId, traceId });
    for (let attempt = 0; attempt < 400 && found.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      found = await loadChatExchangeTraces({ chatId, traceId });
    }
    expect(found).toHaveLength(1);

    // Comfortably above TRACE_ROW_SCAN_CAP (2000): one bulk INSERT, every row landing with a
    // LATER created_at than the trace's own row above. Under the PRE-FIX implementation (scan the
    // newest 2000 chat_trace rows for the WHOLE CHAT, then group/filter by traceId in app code),
    // this noise would push the trace's own row out of the window and the lookup would return [].
    const noiseCount = 2050;
    await db()
      .insert(events)
      .values(
        Array.from({ length: noiseCount }, (_, i) => ({
          type: "chat_trace",
          chatId,
          payload: { v: 1, traceId: `noise-part-${i}`, part: 0, stages: [], coverage: [], diagnostics: [] },
        })),
      );

    const traces = await loadChatExchangeTraces({ chatId, traceId });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe(traceId);
    expect(traces[0]?.header.promptMessageId).toBe("msg-old-window");
  });

  it("orders by when each exchange STARTED, not by its last flush — a late part on an older trace must not outrank a genuinely newer one", async () => {
    const [orderingChat] = await db().insert(characterChats).values({ ownerId }).returning({ id: characterChats.id });
    if (!orderingChat) throw new Error("failed to create test chat");
    const orderingChatId = orderingChat.id;

    const older = startExchangeTrace({ chatId: orderingChatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    older.finish({ kind: "ok" });
    older.flush(); // `older`'s part 0 — its genuine start time.
    await waitForEventRows("chat_trace", orderingChatId, 1);

    const newer = startExchangeTrace({ chatId: orderingChatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    newer.finish({ kind: "ok" });
    newer.flush(); // `newer`'s part 0 — strictly later than `older`'s, by a real wall-clock gap.
    await waitForEventRows("chat_trace", orderingChatId, 2);

    // `older` now gets a LATE part (e.g. a post-turn job landing after the NEXT exchange already
    // started), so its own rows' `max(created_at)` is now AFTER `newer`'s part 0 — but `older`'s
    // `min(created_at)` (and its `header.startedAt`) are still from before `newer` ever started.
    older.record({ stage: "post_turn.shadow", phase: "post_turn", status: "success" });
    older.flush();
    await waitForEventRows("chat_trace", orderingChatId, 3);

    const traces = await loadChatExchangeTraces({ chatId: orderingChatId, limit: 2 });
    expect(traces.map((t) => t.traceId)).toEqual([newer.traceId, older.traceId]);
  });
});
