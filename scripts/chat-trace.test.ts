import { describe, expect, it } from "vitest";
import {
  assembleExchangeTrace,
  buildExchangeTraceJsonOutput,
  exchangeTraceJsonOutputSchema,
  type AssembledTrace,
} from "@/contracts/turns/chat-exchange-trace";
import {
  noTraceFoundMessage,
  parseArgs,
  renderTraceReport,
  selectorQuery,
  UsageError,
} from "./chat-trace";

/**
 * Pins the #637 CLI's two pure layers — argument parsing against the
 * exit-code table, and the report renderer — without a database. Fixture
 * traces are built through slice A's own `assembleExchangeTrace` over raw
 * `events.payload`-shaped parts (never a hand-shaped `AssembledTrace`
 * literal), so a change to the assembler's merge/outcome/highlights logic
 * shows up here instead of the test silently drifting from the real shape.
 */

// ---------------------------------------------------------------------------
// Fixtures — built through slice A's contract, not hand-shaped objects
// ---------------------------------------------------------------------------

interface RawPartOverrides {
  readonly header?: Record<string, unknown>;
  readonly stages?: unknown[];
  readonly coverage?: unknown[];
  readonly diagnostics?: unknown[];
  readonly finish?: unknown;
}

function buildTrace(traceId: string, chatId: string, overrides: RawPartOverrides = {}): AssembledTrace {
  const part: Record<string, unknown> = {
    v: 1,
    traceId,
    part: 0,
    header: {
      operation: "send",
      authority: "successor_shadow",
      lane: "successor",
      startedAt: "2026-10-01T00:00:00.000Z",
      promptMessageId: "msg_prompt",
      replyMessageId: "msg_reply",
      guardMessageId: null,
      ...overrides.header,
    },
    stages: overrides.stages ?? [],
    coverage: overrides.coverage ?? [],
    diagnostics: overrides.diagnostics ?? [],
  };
  if (overrides.finish !== undefined) part.finish = overrides.finish;
  return assembleExchangeTrace({ traceId, chatId, parts: [part] });
}

/** A trace exercising every marker the acceptance calls out: a degraded stage, a retried
 * stage, a failed stage (for highlights), missing + suppressed coverage, and a diagnostic. */
const populatedTrace = buildTrace("trace_full", "chat_1", {
  stages: [
    {
      seq: 0,
      stage: "admission.lock",
      phase: "admission",
      startedAt: "2026-10-01T00:00:00.000Z",
      durationMs: 5,
      status: "success",
    },
    {
      seq: 1,
      stage: "narrator.stream",
      phase: "narrator",
      startedAt: "2026-10-01T00:00:01.000Z",
      durationMs: 1200,
      status: "degraded",
      reason: "fallback_model",
      attempt: 2,
      model: { modelId: "test/model", provider: "openrouter" },
      inputChars: 500,
      outputChars: 800,
    },
    {
      seq: 2,
      stage: "settle.finalize",
      phase: "settle",
      startedAt: "2026-10-01T00:00:02.000Z",
      durationMs: 50,
      status: "retried",
      reason: "lock_contention",
      attempt: 2,
    },
    {
      seq: 3,
      stage: "settle.permission",
      phase: "settle",
      startedAt: "2026-10-01T00:00:03.000Z",
      durationMs: 10,
      status: "failed",
      reason: "write_conflict",
    },
  ],
  coverage: [
    { family: "memory.facts", status: "missing", reason: "no_facts_recorded" },
    { family: "scene", status: "suppressed", reason: "narrator_budget" },
    { family: "history", status: "present", count: 12 },
  ],
  diagnostics: [{ severity: "warn", code: "narrator_retry", path: "narrator.stream" }],
  finish: { kind: "failed", failureCode: "provider_error", endedAt: "2026-10-01T00:00:04.000Z", durationMs: 1500 },
});

/** No `finish` was ever recorded — must read as "incomplete", never "success". */
const incompleteTrace = buildTrace("trace_incomplete", "chat_1", {
  stages: [
    {
      seq: 0,
      stage: "admission.lock",
      phase: "admission",
      startedAt: "2026-10-01T00:00:00.000Z",
      durationMs: 3,
      status: "success",
    },
  ],
});

// ---------------------------------------------------------------------------
// parseArgs — the exit-code table's usage-error rows, row by row
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("requires --chat", () => {
    expect(() => parseArgs(["--latest"])).toThrow(UsageError);
    expect(() => parseArgs([])).toThrow(UsageError);
  });

  it("rejects --latest/--message/--trace combined with each other", () => {
    expect(() => parseArgs(["--chat", "chat_1", "--latest", "--trace", "t1"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--trace", "t1", "--message", "m1"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--latest", "--message", "m1"])).toThrow(UsageError);
  });

  it("rejects --limit combined with --latest or --trace", () => {
    expect(() => parseArgs(["--chat", "chat_1", "--latest", "--limit", "5"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--trace", "t1", "--limit", "5"])).toThrow(UsageError);
  });

  it("rejects a bad --limit, whether alone or capping --message", () => {
    expect(() => parseArgs(["--chat", "chat_1", "--limit", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--limit", "51"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--limit", "-1"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--limit", "2.5"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--limit", "abc"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--message", "m1", "--limit", "0"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--message", "m1", "--limit", "51"])).toThrow(UsageError);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--chat", "chat_1", "--bogus"])).toThrow(UsageError);
  });

  it("rejects a stray positional argument", () => {
    expect(() => parseArgs(["chat_1"])).toThrow(UsageError);
  });

  it("rejects a value flag missing its value", () => {
    expect(() => parseArgs(["--chat"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--message"])).toThrow(UsageError);
    expect(() => parseArgs(["--chat", "chat_1", "--message", "--json"])).toThrow(UsageError);
  });

  it("defaults to --latest when no selector is given", () => {
    expect(parseArgs(["--chat", "chat_1"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "latest" },
      json: false,
    });
  });

  it("accepts an explicit --latest the same as the default", () => {
    expect(parseArgs(["--chat", "chat_1", "--latest"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "latest" },
      json: false,
    });
  });

  it("parses --json, --trace, and a bare --limit", () => {
    expect(parseArgs(["--chat", "chat_1", "--json"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "latest" },
      json: true,
    });
    expect(parseArgs(["--chat", "chat_1", "--trace", "trace_1"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "trace", traceId: "trace_1" },
      json: false,
    });
    expect(parseArgs(["--chat", "chat_1", "--limit", "10"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "limit", limit: 10 },
      json: false,
    });
  });

  it("--message alone returns up to the default cap of 10", () => {
    expect(parseArgs(["--chat", "chat_1", "--message", "msg_1"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "message", messageId: "msg_1", limit: 10 },
      json: false,
    });
  });

  it("--message combined with --limit changes its cap (no longer a conflict)", () => {
    expect(parseArgs(["--chat", "chat_1", "--message", "msg_1", "--limit", "5"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "message", messageId: "msg_1", limit: 5 },
      json: false,
    });
    // Order of the two flags must not matter.
    expect(parseArgs(["--chat", "chat_1", "--limit", "50", "--message", "msg_1"])).toEqual({
      help: false,
      chatId: "chat_1",
      selector: { kind: "message", messageId: "msg_1", limit: 50 },
      json: false,
    });
  });

  it("--help short-circuits every other check, even a missing --chat", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--help", "--chat", "chat_1", "--bogus"])).toEqual({ help: true });
  });
});

// ---------------------------------------------------------------------------
// selectorQuery / noTraceFoundMessage
// ---------------------------------------------------------------------------

describe("selectorQuery", () => {
  it("maps each selector to the read model's query shape", () => {
    expect(selectorQuery("chat_1", { kind: "latest" })).toEqual({ chatId: "chat_1" });
    expect(selectorQuery("chat_1", { kind: "message", messageId: "m1", limit: 10 })).toEqual({
      chatId: "chat_1",
      messageId: "m1",
      limit: 10,
    });
    // --message's own limit threads through even when it differs from the default.
    expect(selectorQuery("chat_1", { kind: "message", messageId: "m1", limit: 50 })).toEqual({
      chatId: "chat_1",
      messageId: "m1",
      limit: 50,
    });
    expect(selectorQuery("chat_1", { kind: "trace", traceId: "t1" })).toEqual({ chatId: "chat_1", traceId: "t1" });
    expect(selectorQuery("chat_1", { kind: "limit", limit: 5 })).toEqual({ chatId: "chat_1", limit: 5 });
  });
});

describe("noTraceFoundMessage", () => {
  it("names the chat and the selector that found nothing", () => {
    expect(noTraceFoundMessage("chat_1", { kind: "latest" })).toContain("chat_1");
    expect(noTraceFoundMessage("chat_1", { kind: "trace", traceId: "t1" })).toContain("t1");
    expect(noTraceFoundMessage("chat_1", { kind: "message", messageId: "m1", limit: 10 })).toContain("m1");
    expect(noTraceFoundMessage("chat_1", { kind: "limit", limit: 5 })).toContain("chat_1");
  });
});

// ---------------------------------------------------------------------------
// renderTraceReport
// ---------------------------------------------------------------------------

describe("renderTraceReport", () => {
  it("reports no traces for an empty list", () => {
    expect(renderTraceReport("chat_1", [])).toBe("No traces for chat chat_1.");
  });

  it("marks degraded, retried, and failed stages, and shows each one's reason", () => {
    const report = renderTraceReport("chat_1", [populatedTrace]);
    expect(report).toContain("[DEGRADED]");
    expect(report).toContain("reason=fallback_model");
    expect(report).toContain("[RETRIED]");
    expect(report).toContain("reason=lock_contention");
    expect(report).toContain("[FAILED]");
    expect(report).toContain("reason=write_conflict");
    // The success-status stage carries no bracketed marker.
    expect(report).not.toContain("[SUCCESS]");
  });

  it("groups coverage by status with missing and suppressed shown, each with its reason", () => {
    const report = renderTraceReport("chat_1", [populatedTrace]);
    expect(report).toMatch(/coverage: missing \(1\)/);
    expect(report).toContain("memory.facts");
    expect(report).toContain("reason=no_facts_recorded");
    expect(report).toMatch(/coverage: suppressed \(1\)/);
    expect(report).toContain("scene");
    expect(report).toContain("reason=narrator_budget");
    // missing/degraded/suppressed precede present/empty in the rendered order.
    expect(report.indexOf("coverage: missing")).toBeLessThan(report.indexOf("coverage: present"));
    expect(report.indexOf("coverage: suppressed")).toBeLessThan(report.indexOf("coverage: present"));
  });

  it("surfaces the diagnostic and the highlights derived from the stages/coverage above", () => {
    const report = renderTraceReport("chat_1", [populatedTrace]);
    expect(report).toContain("[warn] narrator_retry");
    expect(report).toContain("path=narrator.stream");
    expect(report).toContain("degraded stages: narrator.stream");
    expect(report).toContain("retried stages: settle.finalize");
    expect(report).toContain("missing coverage: memory.facts");
    expect(report).toContain("suppressed coverage: scene");
    expect(report).toMatch(/first failed stage: settle\.permission/);
  });

  it("labels an incomplete trace as incomplete, never as success", () => {
    expect(incompleteTrace.outcome).toBe("incomplete");
    const report = renderTraceReport("chat_1", [incompleteTrace]);
    expect(report).toMatch(/outcome\s+incomplete/);
    expect(report).not.toMatch(/outcome\s+success/);
    expect(report).toMatch(/duration\s+n\/a/);
  });

  it("renders every acceptance section for each trace, in order", () => {
    const report = renderTraceReport("chat_1", [populatedTrace]);
    const order = ["trace id", "stages:", "coverage:", "agent runs:", "diagnostics", "highlights:"];
    const positions = order.map((marker) => report.indexOf(marker));
    let previous = -1;
    for (const position of positions) {
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
  });

  it("renders unknown stage ids and coverage families verbatim", () => {
    const weirdTrace = buildTrace("trace_weird", "chat_1", {
      stages: [
        {
          seq: 0,
          stage: "totally.unrecognized.stage",
          phase: "admission",
          startedAt: "2026-10-01T00:00:00.000Z",
          durationMs: 1,
          status: "success",
        },
      ],
      coverage: [{ family: "totally_unrecognized_family", status: "present", count: 1 }],
      finish: { kind: "ok", endedAt: "2026-10-01T00:00:01.000Z", durationMs: 1 },
    });
    const report = renderTraceReport("chat_1", [weirdTrace]);
    expect(report).toContain("totally.unrecognized.stage");
    expect(report).toContain("totally_unrecognized_family");
  });
});

// ---------------------------------------------------------------------------
// --json — must parse against slice A's own exported schema
// ---------------------------------------------------------------------------

describe("buildExchangeTraceJsonOutput", () => {
  it("produces a document that parses against the pinned schema", () => {
    const output = buildExchangeTraceJsonOutput("chat_1", [populatedTrace, incompleteTrace]);
    const parsed = exchangeTraceJsonOutputSchema.parse(output);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.chatId).toBe("chat_1");
    expect(parsed.traces).toHaveLength(2);
    expect(parsed.traces.map((trace) => trace.traceId)).toEqual(["trace_full", "trace_incomplete"]);
  });

  it("produces a valid, parseable document even for an empty trace list", () => {
    const output = buildExchangeTraceJsonOutput("chat_1", []);
    const parsed = exchangeTraceJsonOutputSchema.parse(output);
    expect(parsed).toEqual({ schemaVersion: 1, chatId: "chat_1", traces: [] });
  });
});
