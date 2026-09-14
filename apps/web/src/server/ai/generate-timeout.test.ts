import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";

/**
 * `generateCheckedBounded` composes the real `generateChecked` ladder with
 * `withGenerateTimeout`'s race, so this suite scripts the underlying
 * `generateText` call directly (never resolving it to simulate a stalled
 * provider) and mocks `./agent-failures` so the recorded failure/run calls
 * are assertable without reaching into `../events`' payload shape — the same
 * two seams `generate-checked.test.ts` stubs, plus the failure recorder.
 */
const agentFailures = vi.hoisted(() => ({
  recordAgentFailure: vi.fn(),
  recordAgentRun: vi.fn(),
}));

vi.mock("./agent-failures", () => agentFailures);

vi.mock("./provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider")>();
  return {
    ...actual,
    isDemoMode: () => false,
    openrouter: () => ({ chat: (id: string) => ({ modelId: id }) }),
  };
});

/** One `generateText` stub per test, swapped in `beforeEach`; the module mock forwards to it. */
const generateTextImpl = vi.hoisted(() => ({
  run: undefined as ((options: Record<string, unknown>) => Promise<unknown>) | undefined,
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: (options: Record<string, unknown>) => generateTextImpl.run!(options),
  };
});

import { generateCheckedBounded } from "./generate-timeout";

const SCHEMA = z.object({ ok: z.boolean() });

beforeEach(() => {
  agentFailures.recordAgentFailure.mockClear();
  agentFailures.recordAgentRun.mockClear();
  generateTextImpl.run = undefined;
  vi.useRealTimers();
});

describe("generateCheckedBounded", () => {
  it("degrades a stalled call to the fallback within the budget, and records exactly one timeout failure", async () => {
    vi.useFakeTimers();
    // Never resolves — the provider call the deadline must abort and give up on.
    generateTextImpl.run = () => new Promise(() => {});
    const sink = new DiagnosticCollector();

    const pending = generateCheckedBounded(
      {
        schema: SCHEMA,
        system: "system",
        prompt: "prompt",
        modelId: "probe/model",
        code: "probe",
        sink,
        fallback: () => ({ ok: false }),
      },
      { timeoutMs: 5_000, timeoutCode: "probe.timeout" },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.value).toEqual({ ok: false });
    expect(result.degraded).toBe(true);
    expect(sink.items.filter((d) => d.code === "probe.timeout")).toHaveLength(1);
    expect(agentFailures.recordAgentFailure).toHaveBeenCalledTimes(1);
    expect(agentFailures.recordAgentFailure.mock.calls[0]?.[0]).toMatchObject({ kind: "timeout" });
    expect(agentFailures.recordAgentRun).not.toHaveBeenCalled();
  });

  it("a caller abort before resolution aborts the controller and returns the fallback without recording a success", async () => {
    // Resolves only if the request is ever actually aborted — otherwise it
    // hangs forever, so a controller that never aborts fails the test by timeout.
    generateTextImpl.run = (options) =>
      new Promise((_resolve, reject) => {
        const signal = options.abortSignal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const callerController = new AbortController();
    const sink = new DiagnosticCollector();

    const pending = generateCheckedBounded(
      {
        schema: SCHEMA,
        system: "system",
        prompt: "prompt",
        modelId: "probe/model",
        code: "probe",
        sink,
        signal: callerController.signal,
        fallback: () => ({ ok: false }),
      },
      // A generous budget: this test proves the CALLER abort wins, not the deadline.
      { timeoutMs: 60_000, timeoutCode: "probe.timeout" },
    );
    callerController.abort();
    const result = await pending;

    expect(result.value).toEqual({ ok: false });
    expect(result.degraded).toBe(true);
    // Silent by design (generateChecked's `abandoned()` contract): the caller
    // already owns this degrade, so nothing is recorded or diagnosed twice.
    expect(agentFailures.recordAgentRun).not.toHaveBeenCalled();
    expect(agentFailures.recordAgentFailure).not.toHaveBeenCalled();
    expect(sink.items).toHaveLength(0);
  });

  it("a normal resolution passes the value through unchanged", async () => {
    generateTextImpl.run = () => Promise.resolve({ text: '{"ok":true}', usage: {}, providerMetadata: undefined });

    const result = await generateCheckedBounded(
      {
        schema: SCHEMA,
        system: "system",
        prompt: "prompt",
        modelId: "probe/model",
        code: "probe",
        fallback: () => ({ ok: false }),
      },
      { timeoutMs: 5_000, timeoutCode: "probe.timeout" },
    );

    expect(result.value).toEqual({ ok: true });
    expect(result.degraded).toBe(false);
  });
});
