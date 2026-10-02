import { describe, expect, it } from "vitest";
import {
  EXCHANGE_TRACE_SCHEMA_VERSION,
  assembleExchangeTrace,
  buildExchangeTraceJsonOutput,
  deriveExchangeHighlights,
  deriveExchangeOutcome,
  exchangeCoverageEntrySchema,
  exchangeDiagnosticEntrySchema,
  exchangeFinishRecordSchema,
  exchangeStageEventSchema,
  exchangeTraceJsonOutputSchema,
  mergeExchangeTraceHeaderPatch,
  parseExchangeTracePart,
  peekExchangeTracePartTraceId,
  type AssembledTrace,
  type ExchangeCoverageEntry,
  type ExchangeStageEvent,
  type ExchangeTraceHeaderPatch,
} from "./chat-exchange-trace";
import type { AgentFailure } from "./agent-failure";
import { compositionFallbackSchema, type CompositionFallback } from "./composition-fallback";

const stage = (overrides: Partial<ExchangeStageEvent> = {}): ExchangeStageEvent =>
  exchangeStageEventSchema.parse({ seq: 0, stage: "state.load", phase: "admission", status: "success", ...overrides });

const coverage = (overrides: Partial<ExchangeCoverageEntry> = {}): ExchangeCoverageEntry =>
  exchangeCoverageEntrySchema.parse({ family: "history", status: "present", ...overrides });

const fallback = (overrides: Partial<CompositionFallback> = {}): CompositionFallback =>
  compositionFallbackSchema.parse({ site: "travel", code: "drain_short", ...overrides });

function part(overrides: Record<string, unknown>): unknown {
  return { v: 1, traceId: "trace-1", part: 0, stages: [], coverage: [], diagnostics: [], ...overrides };
}

describe("closed vocabularies fail open at the trust boundary", () => {
  it("an unrecognized stage status degrades to failed, never a false success", () => {
    expect(exchangeStageEventSchema.parse({ seq: 0, stage: "x", phase: "admission", status: "nonsense" }).status).toBe(
      "failed",
    );
  });

  it("an unrecognized coverage status degrades to missing, never present", () => {
    expect(exchangeCoverageEntrySchema.parse({ family: "history", status: "nonsense" }).status).toBe("missing");
  });

  it("an unrecognized finish kind degrades to failed", () => {
    expect(exchangeFinishRecordSchema.parse({ kind: "nonsense" }).kind).toBe("failed");
  });

  it("open vocabularies accept any non-empty string and degrade garbage to unknown", () => {
    expect(exchangeStageEventSchema.parse({ seq: 0, stage: "some.future.stage", phase: "prepare", status: "success" }).stage).toBe(
      "some.future.stage",
    );
    expect(exchangeStageEventSchema.parse({ seq: 0, stage: "", phase: "prepare", status: "success" }).stage).toBe("unknown");
  });
});

describe("missing vs. valid-empty coverage", () => {
  it("present/empty/missing/suppressed/degraded are distinct, round-tripping statuses", () => {
    for (const status of ["present", "empty", "missing", "suppressed", "degraded"] as const) {
      expect(coverage({ status }).status).toBe(status);
    }
  });
});

describe("mergeExchangeTraceHeaderPatch", () => {
  it("a key present on the patch wins; a key absent leaves the base alone", () => {
    const base: ExchangeTraceHeaderPatch = { chatId: "chat-1", operation: "send" };
    const merged = mergeExchangeTraceHeaderPatch(base, { operation: "continue", lane: "successor" });
    expect(merged).toEqual({ chatId: "chat-1", operation: "continue", lane: "successor" });
  });

  it("an explicit null on a nullable field sets it, rather than being ignored", () => {
    const base: ExchangeTraceHeaderPatch = { promptMessageId: "msg-1" };
    const merged = mergeExchangeTraceHeaderPatch(base, { promptMessageId: null });
    expect(merged.promptMessageId).toBeNull();
  });

  it("sim/narrator merge field-by-field, never replacing the whole sub-object", () => {
    const base: ExchangeTraceHeaderPatch = { narrator: { modelId: "model/a" } };
    const merged = mergeExchangeTraceHeaderPatch(base, { narrator: { instructionHash: "abc" } });
    expect(merged.narrator).toEqual({ modelId: "model/a", instructionHash: "abc" });
  });
});

describe("parseExchangeTracePart", () => {
  it("hydrates dev-only stage detail / coverage summary / diagnostic message back onto the structured arrays", () => {
    const raw = part({
      stages: [{ seq: 3, stage: "narrator.prompt", phase: "narrator", status: "success" }],
      coverage: [{ family: "history", status: "present" }],
      diagnostics: [{ severity: "warn", code: "x.y" }],
      stageDetails: [{ seq: 3, detail: "a free-text note" }],
      coverageSummaries: [{ index: 0, summary: "3 facts" }],
      diagnosticMessages: [{ index: 0, message: "something degraded" }],
    });
    const parsed = parseExchangeTracePart(raw);
    expect(parsed?.stages[0]?.detail).toBe("a free-text note");
    expect(parsed?.coverage[0]?.summary).toBe("3 facts");
    expect(parsed?.diagnostics[0]?.message).toBe("something degraded");
  });

  it("a production row (no sibling content keys) hydrates with the text fields simply absent", () => {
    const raw = part({ stages: [{ seq: 0, stage: "state.load", phase: "admission", status: "success" }] });
    const parsed = parseExchangeTracePart(raw);
    expect(parsed?.stages[0]?.detail).toBeUndefined();
  });

  it("drops a row whose identity fields are structurally unsound", () => {
    expect(parseExchangeTracePart({ v: 1, traceId: "", part: 0, stages: [], coverage: [], diagnostics: [] })).toBeNull();
    expect(parseExchangeTracePart({ v: 2, traceId: "t", part: 0, stages: [], coverage: [], diagnostics: [] })).toBeNull();
    expect(parseExchangeTracePart("garbage")).toBeNull();
  });

  it("a corrupt but non-identity field (e.g. a garbled stages array) degrades instead of dropping the row", () => {
    const parsed = parseExchangeTracePart(part({ stages: "not-an-array" }));
    expect(parsed).not.toBeNull();
    expect(parsed?.stages).toEqual([]);
  });
});

describe("peekExchangeTracePartTraceId", () => {
  it("reads the traceId off an otherwise-unparseable value", () => {
    expect(peekExchangeTracePartTraceId({ traceId: "trace-9", part: "garbage" })).toBe("trace-9");
  });

  it("is null for anything without a usable traceId", () => {
    expect(peekExchangeTracePartTraceId({ traceId: 42 })).toBeNull();
    expect(peekExchangeTracePartTraceId("nope")).toBeNull();
    expect(peekExchangeTracePartTraceId(null)).toBeNull();
  });
});

describe("assembleExchangeTrace", () => {
  it("merges header patches in part order and sorts stages by seq across parts", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [
        part({ part: 0, header: { traceId: "trace-1", chatId: "chat-1", operation: "send", startedAt: "t0" }, stages: [
          { seq: 1, stage: "narrator.prompt", phase: "narrator", status: "success" },
        ] }),
        part({ part: 1, header: { replyMessageId: "msg-reply" }, stages: [
          { seq: 0, stage: "admission.lock", phase: "admission", status: "success" },
        ] }),
      ],
    });
    expect(trace.header).toMatchObject({ operation: "send", startedAt: "t0", replyMessageId: "msg-reply" });
    expect(trace.stages.map((s) => s.seq)).toEqual([0, 1]);
  });

  it("silently excludes a part belonging to a different trace, without counting it as unreadable", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [part({ traceId: "trace-OTHER" })],
    });
    expect(trace.unreadableParts).toBe(0);
    expect(trace.stages).toEqual([]);
  });

  it("drops a part that fails to parse and counts it, while keeping the trace's other valid parts", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [
        { traceId: "trace-1", part: "not-a-number", v: 1, stages: [], coverage: [], diagnostics: [] },
        part({ part: 0, stages: [{ seq: 0, stage: "state.load", phase: "admission", status: "success" }] }),
      ],
    });
    expect(trace.unreadableParts).toBe(1);
    expect(trace.stages).toHaveLength(1);
  });

  it("dedupes a re-flushed stage by seq, keeping the HIGHEST-part occurrence", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [
        // part 0: the stage flushed while still open — provisional, no durationMs.
        part({ part: 0, stages: [{ seq: 2, stage: "prepare.recall", phase: "prepare", durationMs: null }] }),
        // part 1: the same stage, now actually completed.
        part({ part: 1, stages: [{ seq: 2, stage: "prepare.recall", phase: "prepare", status: "success", durationMs: 120 }] }),
      ],
    });
    expect(trace.stages).toHaveLength(1);
    expect(trace.stages[0]).toMatchObject({ status: "success", durationMs: 120 });
  });

  it("a still-open stage flushed with no status reads as failed (the schema's own safe default), never success", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [part({ stages: [{ seq: 0, stage: "narrator.stream", phase: "narrator", durationMs: null }] })],
    });
    expect(trace.stages[0]).toMatchObject({ status: "failed", durationMs: null });
  });

  it("links a composition fallback to the stage that produced it via refs.rowIds, when linkable", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [
        part({
          stages: [
            { seq: 0, stage: "settle.finalize", phase: "settle", status: "degraded", refs: { rowIds: ["msg-1"] } },
          ],
        }),
      ],
      compositionFallbacks: [fallback({ messageId: "msg-1" })],
    });
    expect(trace.highlights.fallbackStages).toHaveLength(1);
    expect(trace.highlights.fallbackStages[0]?.stage?.stage).toBe("settle.finalize");
  });

  it("a fallback with no linkable stage still shows, with stage: null", () => {
    const trace = assembleExchangeTrace({
      traceId: "trace-1",
      chatId: "chat-1",
      parts: [part({})],
      compositionFallbacks: [fallback({ messageId: "msg-unseen" })],
    });
    expect(trace.highlights.fallbackStages[0]).toMatchObject({ stage: null });
  });
});

describe("deriveExchangeOutcome — the outcome table", () => {
  const base = { stages: [] as ExchangeStageEvent[], coverage: [] as ExchangeCoverageEntry[], diagnostics: [], agentFailures: [] as AgentFailure[], compositionFallbacks: [] as CompositionFallback[] };

  it("no finish record ⇒ incomplete, never ok", () => {
    expect(deriveExchangeOutcome({ ...base, finish: null }).outcome).toBe("incomplete");
  });

  it("finish failed ⇒ failed, carrying the failureCode", () => {
    const result = deriveExchangeOutcome({
      ...base,
      finish: exchangeFinishRecordSchema.parse({ kind: "failed", failureCode: "timeout" }),
    });
    expect(result).toEqual({ outcome: "failed", failureCode: "timeout" });
  });

  it("finish stopped ⇒ stopped", () => {
    expect(deriveExchangeOutcome({ ...base, finish: exchangeFinishRecordSchema.parse({ kind: "stopped" }) }).outcome).toBe(
      "stopped",
    );
  });

  it("finish ok with a degraded stage ⇒ degraded", () => {
    const result = deriveExchangeOutcome({
      ...base,
      stages: [stage({ status: "degraded" })],
      finish: exchangeFinishRecordSchema.parse({ kind: "ok" }),
    });
    expect(result.outcome).toBe("degraded");
  });

  it("finish ok with missing coverage ⇒ degraded", () => {
    const result = deriveExchangeOutcome({
      ...base,
      coverage: [coverage({ status: "missing" })],
      finish: exchangeFinishRecordSchema.parse({ kind: "ok" }),
    });
    expect(result.outcome).toBe("degraded");
  });

  it("finish ok with an error diagnostic ⇒ degraded", () => {
    const result = deriveExchangeOutcome({
      ...base,
      diagnostics: [exchangeDiagnosticEntrySchema.parse({ severity: "error", code: "x" })],
      finish: exchangeFinishRecordSchema.parse({ kind: "ok" }),
    });
    expect(result.outcome).toBe("degraded");
  });

  it("finish ok with a correlated agent failure ⇒ degraded", () => {
    const result = deriveExchangeOutcome({
      ...base,
      agentFailures: [{ legId: "x", kind: "timeout", cause: "model_slow", chatId: null, messageId: null, traceId: null, modelId: "", provider: null, promptChars: 0, maxOutputTokens: 0, timeoutMs: 0, latencyMs: 0, reasoningProfile: "off", reasoningEnabled: false, httpStatus: 0, detail: "", at: "" }],
      finish: exchangeFinishRecordSchema.parse({ kind: "ok" }),
    });
    expect(result.outcome).toBe("degraded");
  });

  it("finish ok with none of the above ⇒ ok", () => {
    const result = deriveExchangeOutcome({ ...base, finish: exchangeFinishRecordSchema.parse({ kind: "ok" }) });
    expect(result.outcome).toBe("ok");
  });
});

describe("deriveExchangeHighlights", () => {
  it("surfaces the first failed stage, degraded/retried stages, and missing/degraded/suppressed coverage", () => {
    const highlights = deriveExchangeHighlights({
      stages: [
        stage({ seq: 0, status: "degraded" }),
        stage({ seq: 1, status: "failed" }),
        stage({ seq: 2, status: "retried" }),
        stage({ seq: 3, status: "failed" }),
      ],
      coverage: [
        coverage({ family: "history", status: "missing" }),
        coverage({ family: "scene", status: "degraded" }),
        coverage({ family: "garments", status: "suppressed" }),
      ],
      compositionFallbacks: [],
    });
    expect(highlights.firstFailedStage?.seq).toBe(1);
    expect(highlights.degradedStages.map((s) => s.seq)).toEqual([0]);
    expect(highlights.retriedStages.map((s) => s.seq)).toEqual([2]);
    expect(highlights.missingCoverage.map((c) => c.family)).toEqual(["history"]);
    expect(highlights.degradedCoverage.map((c) => c.family)).toEqual(["scene"]);
    expect(highlights.suppressedCoverage.map((c) => c.family)).toEqual(["garments"]);
  });
});

describe("the versioned JSON output — pinned so the CLI and the inspector cannot drift", () => {
  it("builds schemaVersion 1 and validates against its own schema", () => {
    const trace: AssembledTrace = assembleExchangeTrace({ traceId: "trace-1", chatId: "chat-1", parts: [part({})] });
    const output = buildExchangeTraceJsonOutput("chat-1", [trace]);
    expect(output.schemaVersion).toBe(EXCHANGE_TRACE_SCHEMA_VERSION);
    expect(output.schemaVersion).toBe(1);
    expect(() => exchangeTraceJsonOutputSchema.parse(output)).not.toThrow();
    expect(exchangeTraceJsonOutputSchema.parse(output)).toEqual(output);
  });
});
