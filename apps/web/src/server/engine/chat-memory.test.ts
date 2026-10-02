import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { GenerateCheckedOptions, GenerateCheckedResult } from "../ai";

// Degradation contract: a failed callback retrieval —
// db down, embedding failure — is an ordinary turn with a diagnostic, never a
// failed reply. The memory module is mocked to throw like a down database would.
vi.mock("../memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory")>();
  return { ...actual, latestEpisodeNumber: () => Promise.reject(new Error("db down")) };
});

/** Every telemetry object a leg's call actually handed to `withGenerateTimeout` (#637 correlation). */
const telemetrySeen = vi.hoisted(() => ({ calls: [] as { legId?: string; traceId?: string }[] }));

// Out of demo mode (the global `AI_FAKE=1` setup would otherwise short-circuit
// every leg before it builds any telemetry at all) and with the model call
// itself stubbed, so these tests check ONLY the telemetry object each leg
// hands to `withGenerateTimeout` — never a real provider call, and never the
// `loadChatAgentReasoningProfile` DB read.
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return {
    ...actual,
    isDemoMode: () => false,
    loadChatAgentReasoningProfile: () => Promise.resolve("off" as const),
    // Returns the call's OWN degraded-fallback shape as a "successful" value —
    // real, schema-shaped data every leg already builds for its failure path —
    // rather than a bare `{}` that downstream folds were never written to see.
    generateChecked: <T,>(options: GenerateCheckedOptions<T>): Promise<GenerateCheckedResult<T>> =>
      Promise.resolve({ value: (options.fallback ? options.fallback() : ({} as T)), degraded: false }),
    withGenerateTimeout: <T,>(
      work: Promise<GenerateCheckedResult<T>>,
      _controller: AbortController,
      _timeoutMs: number,
      _timeoutCode: string,
      _sink: unknown,
      telemetry?: { legId?: string; traceId?: string },
    ): Promise<{ value: T | null; degraded: boolean }> => {
      telemetrySeen.calls.push({ legId: telemetry?.legId, traceId: telemetry?.traceId });
      return work.then((result) => ({ value: result.value, degraded: result.degraded })).catch(() => ({ value: null, degraded: true }));
    },
  };
});

import { retrieveChatCallback, runChatExtraction, runChatPersonalNotes } from "./chat-memory";

describe("retrieveChatCallback degradation", () => {
  it("degrades to null with chat_memory.callback.failed, never a throw", async () => {
    const sink = new DiagnosticCollector();
    const out = await retrieveChatCallback({
      groupId: "group-1",
      input: "hello there",
      milestones: [],
      usedRefs: [],
      sink,
    });
    expect(out).toBeNull();
    expect(sink.items.some((d) => d.code === "chat_memory.callback.failed")).toBe(true);
  });
});

describe("post-turn extraction legs thread the caller's traceId (#637)", () => {
  const exchange = { player: "hi there", assistant: "Mara waves back." };

  it("runChatExtraction hands every leg (memory, continuity, character) the same traceId", async () => {
    telemetrySeen.calls = [];
    await runChatExtraction({
      characterName: "Mara",
      playerName: "Theo",
      exchange,
      trace: { chatId: "chat-1", messageId: "msg-1", traceId: "trace-extract-1" },
    });
    expect(telemetrySeen.calls).toHaveLength(3);
    expect(telemetrySeen.calls.map((c) => c.legId).sort()).toEqual(
      ["chat_character_notes", "chat_continuity", "chat_memory_scribe"].sort(),
    );
    for (const call of telemetrySeen.calls) expect(call.traceId).toBe("trace-extract-1");
  });

  it("runChatExtraction leaves every leg's traceId absent when the caller has none", async () => {
    telemetrySeen.calls = [];
    await runChatExtraction({
      characterName: "Mara",
      playerName: "Theo",
      exchange,
      trace: { chatId: "chat-1", messageId: "msg-1" },
    });
    expect(telemetrySeen.calls).toHaveLength(3);
    for (const call of telemetrySeen.calls) expect(call.traceId).toBeUndefined();
  });

  it("runChatPersonalNotes (the ensemble member's own pass) threads the caller's traceId", async () => {
    telemetrySeen.calls = [];
    await runChatPersonalNotes({
      characterName: "Wren",
      playerName: "Theo",
      exchange,
      trace: { chatId: "chat-1", messageId: "msg-1", traceId: "trace-personal-1" },
    });
    expect(telemetrySeen.calls).toHaveLength(1);
    expect(telemetrySeen.calls[0]?.traceId).toBe("trace-personal-1");
  });
});
