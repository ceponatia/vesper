import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

// The recorder writes through `logEvent` (fire-and-forget). Mock it so the pure record —
// and the fact that a timeout records at all — can be asserted without a database.
const logged = vi.hoisted(() => ({ rows: [] as { type: string; payload: Record<string, unknown> }[] }));
vi.mock("../events", () => ({
  logEvent: (type: string, payload: Record<string, unknown>) => {
    logged.rows.push({ type, payload });
    return Promise.resolve();
  },
}));

import { buildAgentFailure } from "./agent-failures";
import { withGenerateTimeout } from "./generate-timeout";

describe("buildAgentFailure", () => {
  it("classifies the cause and caps the detail — WITHOUT clipping a truncation hint away first", () => {
    // The cause classifier must read the raw detail: if the cap ran first, a truncation hint
    // sitting past 300 chars would be lost and a fixable "cap too low" would read as
    // "the model is bad at JSON".
    const record = buildAgentFailure({
      legId: "chat_continuity",
      kind: "parse_failed",
      detail: `${"x".repeat(400)} Unexpected end of JSON input`,
      at: new Date("2026-07-14T12:00:00Z"),
    });
    expect(record.cause).toBe("output_cap_too_low");
    expect(record.detail.length).toBe(300);
    expect(record.at).toBe("2026-07-14T12:00:00.000Z");
  });

  it("carries the signals that make the suspected cause checkable", () => {
    const record = buildAgentFailure({
      legId: "chat_memory_scribe",
      kind: "timeout",
      chatId: "chat-1",
      messageId: "msg-1",
      modelId: "some/model",
      promptChars: 30_000,
      maxOutputTokens: 500,
      timeoutMs: 6000,
    });
    expect(record.cause).toBe("prompt_too_large");
    expect(record).toMatchObject({
      legId: "chat_memory_scribe",
      chatId: "chat-1",
      messageId: "msg-1",
      promptChars: 30_000,
      maxOutputTokens: 500,
      timeoutMs: 6000,
    });
  });
});

describe("withGenerateTimeout — a trip is recorded, not just logged", () => {
  it("records the timeout with its telemetry (the leg would otherwise fail invisibly)", async () => {
    logged.rows = [];
    const sink = new DiagnosticCollector();
    const controller = new AbortController();
    // A call that never settles — exactly the case the watchdog exists for.
    const never = new Promise<never>(() => {});

    const result = await withGenerateTimeout(
      never as never,
      controller,
      10,
      "chat_continuity.timeout",
      sink,
      { legId: "chat_continuity", chatId: "chat-1", modelId: "some/model", promptChars: 4000, maxOutputTokens: 400 },
    );

    expect(result).toEqual({ value: null, degraded: true });
    expect(controller.signal.aborted).toBe(true);
    expect(sink.items.map((d) => d.code)).toContain("chat_continuity.timeout");

    expect(logged.rows).toHaveLength(1);
    const row = logged.rows[0];
    expect(row?.type).toBe("agent_failure");
    expect(row?.payload).toMatchObject({
      legId: "chat_continuity",
      kind: "timeout",
      cause: "model_slow",
      chatId: "chat-1",
      timeoutMs: 10,
    });
  });

  it("derives the leg id from the timeout code when no telemetry is passed", async () => {
    logged.rows = [];
    const controller = new AbortController();
    await withGenerateTimeout(new Promise<never>(() => {}) as never, controller, 5, "chat_summary.fold.timeout");
    expect(logged.rows[0]?.payload).toMatchObject({ legId: "chat_summary.fold", kind: "timeout" });
  });

  it("records nothing when the call completes in time", async () => {
    logged.rows = [];
    const controller = new AbortController();
    const result = await withGenerateTimeout(
      Promise.resolve({ value: { ok: true }, degraded: false }),
      controller,
      1000,
      "chat_continuity.timeout",
    );
    expect(result).toEqual({ value: { ok: true }, degraded: false });
    expect(logged.rows).toHaveLength(0);
  });
});
