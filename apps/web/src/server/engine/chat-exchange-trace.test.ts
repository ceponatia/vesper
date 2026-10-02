import { describe, expect, it, vi } from "vitest";

// The recorder writes through `logEvent` (fire-and-forget) — mock it so the pure
// row-building rule, and the fact that a flush writes at all, are assertable
// without a database (mirrors server/ai/agent-failures.test.ts).
const logged = vi.hoisted(() => ({ rows: [] as { type: string; payload: Record<string, unknown>; chatId: string | null; content: Record<string, unknown> }[] }));
vi.mock("../events", () => ({
  logEvent: (type: string, payload: Record<string, unknown>, opts?: { chatId?: string | null; content?: Record<string, unknown> }) => {
    logged.rows.push({ type, payload, chatId: opts?.chatId ?? null, content: opts?.content ?? {} });
    return Promise.resolve();
  },
}));

import {
  buildExchangeTraceEventRow,
  noopExchangeTrace,
  startExchangeTrace,
  type ExchangeTraceFlushDraft,
} from "./chat-exchange-trace";
import { exchangeCoverageEntrySchema, exchangeDiagnosticEntrySchema, exchangeStageEventSchema } from "@/contracts/turns/chat-exchange-trace";

function flushDraft(overrides: Partial<ExchangeTraceFlushDraft> = {}): ExchangeTraceFlushDraft {
  return { v: 1, traceId: "trace-1", part: 0, stages: [], coverage: [], diagnostics: [], ...overrides };
}

describe("buildExchangeTraceEventRow — the pure row-building rule", () => {
  it("strips a stage's free-text detail into a content key that cannot collide with the payload's own `stages`", () => {
    const stage = exchangeStageEventSchema.parse({ seq: 3, stage: "narrator.prompt", phase: "narrator", status: "success", detail: "a free-text note" });
    const { payload, content } = buildExchangeTraceEventRow(flushDraft({ stages: [stage] }));
    expect(payload.stages).toEqual([{ seq: 3, stage: "narrator.prompt", phase: "narrator", startedAt: "", durationMs: null, status: "success" }]);
    expect((payload.stages as unknown[])[0]).not.toHaveProperty("detail");
    expect(content).toEqual({ stageDetails: [{ seq: 3, detail: "a free-text note" }] });
    expect(Object.keys(payload)).not.toContain("stageDetails");
  });

  it("strips a coverage summary and a diagnostic message the same way, keyed by array index", () => {
    const coverage = exchangeCoverageEntrySchema.parse({ family: "history", status: "present", summary: "3 facts" });
    const diagnostic = exchangeDiagnosticEntrySchema.parse({ severity: "warn", code: "x.y", message: "something degraded" });
    const { payload, content } = buildExchangeTraceEventRow(flushDraft({ coverage: [coverage], diagnostics: [diagnostic] }));
    expect((payload.coverage as unknown[])[0]).not.toHaveProperty("summary");
    expect((payload.diagnostics as unknown[])[0]).not.toHaveProperty("message");
    expect(content).toEqual({
      coverageSummaries: [{ index: 0, summary: "3 facts" }],
      diagnosticMessages: [{ index: 0, message: "something degraded" }],
    });
  });

  it("omits every content key when nothing carries free text — a production row is indistinguishable from a scrubbed one", () => {
    const stage = exchangeStageEventSchema.parse({ seq: 0, stage: "state.load", phase: "admission", status: "success" });
    const { content } = buildExchangeTraceEventRow(flushDraft({ stages: [stage] }));
    expect(content).toEqual({});
  });

  it("carries the header patch and finish record through untouched (no text to split there)", () => {
    const { payload } = buildExchangeTraceEventRow(
      flushDraft({ header: { operation: "send" }, finish: { kind: "ok", endedAt: "t", durationMs: 10 } }),
    );
    expect(payload.header).toEqual({ operation: "send" });
    expect(payload.finish).toEqual({ kind: "ok", endedAt: "t", durationMs: 10 });
  });
});

describe("startExchangeTrace", () => {
  it("mints a fresh, non-empty traceId per call", () => {
    const a = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const b = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    expect(a.traceId).not.toBe("");
    expect(a.traceId).not.toBe(b.traceId);
  });

  it("flush() writes part 0 with the full initial header, even with nothing else recorded", () => {
    logged.rows = [];
    const trace = startExchangeTrace({
      chatId: "chat-1",
      operation: "continue",
      authority: "legacy_chat",
      lane: "legacy_chat",
      promptMessageId: "msg-1",
    });
    trace.flush();
    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0]?.type).toBe("chat_trace");
    expect(logged.rows[0]?.chatId).toBe("chat-1");
    expect(logged.rows[0]?.payload).toMatchObject({
      v: 1,
      traceId: trace.traceId,
      part: 0,
      header: { traceId: trace.traceId, chatId: "chat-1", operation: "continue", promptMessageId: "msg-1" },
    });
  });

  it("flush() is idempotent — a second call with nothing new writes nothing", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.flush();
    expect(logged.rows).toHaveLength(1);
    trace.flush();
    expect(logged.rows).toHaveLength(1);
  });

  it("annotate() patches merge locally before the next flush, landing in whichever part is current", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.flush(); // part 0
    trace.annotate({ replyMessageId: "msg-reply" });
    trace.annotate({ narrator: { modelId: "model/a" } });
    trace.flush(); // part 1
    expect(logged.rows).toHaveLength(2);
    expect(logged.rows[1]?.payload).toMatchObject({ part: 1, header: { replyMessageId: "msg-reply", narrator: { modelId: "model/a" } } });
  });

  it("begin/end records a stage with a measured duration and increasing seq", async () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const h1 = trace.begin("state.load", "admission");
    h1.end({ status: "success" });
    const h2 = trace.begin("prepare.recall", "prepare");
    h2.end({ status: "degraded", reason: "partial" });
    trace.flush();
    const stages = logged.rows[0]?.payload.stages as { seq: number; stage: string; status: string }[];
    expect(stages.map((s) => s.seq)).toEqual([0, 1]);
    expect(stages[1]).toMatchObject({ stage: "prepare.recall", status: "degraded", reason: "partial" });
  });

  it("a begin() handle never ended is flushed as a provisional snapshot: durationMs null, status defaults to failed", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.begin("narrator.stream", "narrator");
    trace.flush();
    const stages = logged.rows[0]?.payload.stages as { durationMs: number | null; status: string }[];
    expect(stages[0]).toMatchObject({ durationMs: null, status: "failed" });
  });

  it("an open stage's provisional snapshot is written at most once per flush cycle (idempotent)", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.begin("narrator.stream", "narrator");
    trace.flush(); // part 0: provisional snapshot written
    trace.flush(); // part 1 would be empty — nothing new, so nothing writes
    expect(logged.rows).toHaveLength(1);
  });

  it("ending a stage AFTER its provisional flush corrects it on the next flush", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const handle = trace.begin("narrator.stream", "narrator");
    trace.flush(); // provisional: failed, durationMs null
    handle.end({ status: "success" });
    trace.flush(); // corrected
    expect(logged.rows).toHaveLength(2);
    const firstStage = (logged.rows[0]?.payload.stages as { status: string }[])[0];
    const secondStage = (logged.rows[1]?.payload.stages as { status: string; durationMs: number | null }[])[0];
    expect(firstStage?.status).toBe("failed");
    expect(secondStage?.status).toBe("success");
    expect(secondStage?.durationMs).not.toBeNull();
  });

  it("record() creates a complete, instantaneous stage (e.g. skipped) in one call", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.record({ stage: "jobs.scene_enqueue", phase: "post_turn", status: "skipped", reason: "flag_off" });
    trace.flush();
    const stages = logged.rows[0]?.payload.stages as { stage: string; status: string; reason: string }[];
    expect(stages[0]).toMatchObject({ stage: "jobs.scene_enqueue", status: "skipped", reason: "flag_off" });
  });

  it("time() is transparent: returns the value and records success", async () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const value = await trace.time("prepare.beats", "prepare", async () => 42, (v) => ({ count: v }));
    expect(value).toBe(42);
    trace.flush();
    const stages = logged.rows[0]?.payload.stages as { status: string; count: number }[];
    expect(stages[0]).toMatchObject({ status: "success", count: 42 });
  });

  it("time() rethrows the ORIGINAL error unchanged after recording the stage as failed", async () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const boom = new Error("boom");
    await expect(trace.time("prepare.beats", "prepare", async () => { throw boom; })).rejects.toBe(boom);
    trace.flush();
    const stages = logged.rows[0]?.payload.stages as { status: string; reason: string }[];
    expect(stages[0]).toMatchObject({ status: "failed", reason: "exception" });
  });

  it("coverage() and diagnostics() buffer and flush, diagnostics carrying the given seq", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.coverage({ family: "history", status: "missing", reason: "not_fetched" });
    trace.diagnostics([{ severity: "warn", code: "x.y", message: "oops" }], 7);
    trace.flush();
    expect(logged.rows[0]?.payload.coverage).toEqual([{ family: "history", status: "missing", reason: "not_fetched" }]);
    expect(logged.rows[0]?.payload.diagnostics).toEqual([{ severity: "warn", code: "x.y", seq: 7 }]);
    expect(logged.rows[0]?.content.diagnosticMessages).toEqual([{ index: 0, message: "oops" }]);
  });

  it("finish() measures durationMs from the trace's own start", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.finish({ kind: "ok" });
    trace.flush();
    const finish = logged.rows[0]?.payload.finish as { kind: string; durationMs: number };
    expect(finish.kind).toBe("ok");
    // Started and finished within this test: a small, non-negative duration —
    // generous enough to absorb CI jitter without being a meaningless >= 0 check.
    expect(finish.durationMs).toBeGreaterThanOrEqual(0);
    expect(finish.durationMs).toBeLessThan(5_000);
  });

  it("finish() carries a failureCode through when given one", () => {
    logged.rows = [];
    const trace = startExchangeTrace({ chatId: "chat-1", operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    trace.finish({ kind: "failed", failureCode: "timeout" });
    trace.flush();
    expect(logged.rows[0]?.payload.finish).toMatchObject({ kind: "failed", failureCode: "timeout" });
  });
});

describe("noopExchangeTrace", () => {
  it("every method is a no-op and traceId is empty, but time() still runs the work and propagates its result/error", async () => {
    const trace = noopExchangeTrace();
    expect(trace.traceId).toBe("");
    trace.annotate({ operation: "send" });
    trace.begin("x", "admission").end();
    trace.record({ stage: "x", phase: "admission" });
    trace.coverage({ family: "history", status: "present" });
    trace.diagnostics([{ severity: "info", code: "x", message: "m" }]);
    trace.finish({ kind: "ok" });
    trace.flush();

    await expect(trace.time("x", "admission", async () => 7)).resolves.toBe(7);
    const boom = new Error("boom");
    await expect(trace.time("x", "admission", async () => { throw boom; })).rejects.toBe(boom);
  });
});
