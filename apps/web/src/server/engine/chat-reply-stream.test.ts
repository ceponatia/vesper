import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NarratorCompletion } from "@/server/ai";
import type { ExchangeStageResult, ExchangeTrace } from "./chat-exchange-trace";
import { saveReplyFailure } from "./chat-reply-store";
import { stopChatReply, streamExchange } from "./chat-reply-stream";

vi.mock("./chat-reply-store", () => ({ saveReplyFailure: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => vi.clearAllMocks());

describe("reply stream lifecycle", () => {
  it("registers Stop before consumption and settles the stopped prefix once before releasing", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const settle = vi.fn(async () => { events.push("settle"); });
    const release = vi.fn(() => { events.push("release"); });
    async function* source() {
      yield "visible prefix";
      if (controller.signal.aborted) throw new Error("aborted");
      yield " unwanted suffix";
    }
    const stream = streamExchange(source(), {
      chatId: "stopped", abortController: controller, settle, release,
      completion: () => null, modelId: "test-model",
    });
    expect(stopChatReply("missing")).toBe(false);
    expect(stopChatReply("stopped")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(await stream.next()).toEqual({ value: "visible prefix", done: false });
    expect(await stream.next()).toEqual({ value: undefined, done: true });
    await stream.next();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("visible prefix", true);
    expect(saveReplyFailure).toHaveBeenCalledWith("stopped", null, "test-model");
    expect(release).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["settle", "release"]);
    expect(stopChatReply("stopped")).toBe(false);
  });

  it.each(["complete", "provider failure", "settle failure"])("keeps partial text and releases once after %s", async (outcome) => {
    const settle = vi.fn(async () => {
      if (outcome === "settle failure") throw new Error("persist failed");
    });
    const release = vi.fn();
    async function* source() {
      yield "prefix";
      if (outcome === "provider failure") throw new Error("provider failed");
    }
    const stream = streamExchange(source(), {
      chatId: outcome, abortController: new AbortController(), settle, release,
      completion: () => null, modelId: "test-model",
    });
    const tokens: string[] = [];
    for await (const token of stream) tokens.push(token);
    expect(tokens).toEqual(["prefix"]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("prefix", false);
    expect(saveReplyFailure).toHaveBeenCalledWith(outcome, null, "test-model");
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopChatReply(outcome)).toBe(false);
  });

  it("records an empty reply before release without settling", async () => {
    const settle = vi.fn();
    const release = vi.fn(() => {
      expect(saveReplyFailure).toHaveBeenCalledWith(
        "empty", { code: "empty_reply", detail: "" }, "test-model",
      );
    });
    async function* source(): AsyncGenerator<string> { yield* []; }
    const stream = streamExchange(source(), {
      chatId: "empty", abortController: new AbortController(), settle, release,
      completion: () => null, modelId: "test-model",
    });
    expect(await stream.next()).toEqual({ value: undefined, done: true });
    expect(settle).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopChatReply("empty")).toBe(false);
  });
});

/**
 * The one-token `length` stub reaches the stream before its finish is known — the
 * fragment is yielded like any delta — and is then withheld from settlement exactly
 * like an empty reply, with its verdict recorded before the lock releases so the
 * client's refetch reads it and retracts what it displayed.
 */
describe("the one-token length stub", () => {
  const ASMODEUS = "DarkArtsForge/Asmodeus-24B-v3";
  const stub: NarratorCompletion = {
    provider: "featherless",
    modelId: ASMODEUS,
    finishReason: "length",
    outputTokens: 1,
    maxOutputTokens: 1024,
    rawTextLength: 1,
    visibleTextLength: 1,
    visibleTextChars: 1,
    attempts: 1,
  };

  it("streams the fragment, never settles it, and records why before releasing", async () => {
    const settle = vi.fn();
    const release = vi.fn(() => {
      expect(saveReplyFailure).toHaveBeenCalledWith(
        "stub",
        expect.objectContaining({ code: "empty_reply", cause: "length_stub" }),
        ASMODEUS,
      );
    });
    async function* source() {
      yield "I";
    }
    const stream = streamExchange(source(), {
      chatId: "stub", abortController: new AbortController(), settle, release,
      completion: () => stub, modelId: "requested-model",
    });
    const tokens: string[] = [];
    for await (const token of stream) tokens.push(token);
    expect(tokens).toEqual(["I"]);
    expect(settle).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopChatReply("stub")).toBe(false);
  });

  it("settles a one-character reply that finished normally", async () => {
    const settle = vi.fn(async () => {});
    async function* source() {
      yield "I";
    }
    const stream = streamExchange(source(), {
      chatId: "one-char", abortController: new AbortController(), settle, release: vi.fn(),
      completion: () => ({ ...stub, finishReason: "stop" }), modelId: "requested-model",
    });
    for await (const token of stream) void token;
    expect(settle).toHaveBeenCalledWith("I", false);
    expect(saveReplyFailure).toHaveBeenCalledWith("one-char", null, ASMODEUS);
  });

  // Stop means "keep what I have": a partial the player stopped persists with
  // `meta.stopped` even when the generation's metadata reads as a stub.
  it("keeps a player Stop's partial whatever the metadata says", async () => {
    const controller = new AbortController();
    const settle = vi.fn(async () => {});
    async function* source() {
      yield "I";
      controller.abort();
    }
    const stream = streamExchange(source(), {
      chatId: "stub-stopped", abortController: controller, settle, release: vi.fn(),
      completion: () => stub, modelId: "requested-model",
    });
    for await (const token of stream) void token;
    expect(settle).toHaveBeenCalledWith("I", true);
    expect(saveReplyFailure).toHaveBeenCalledWith("stub-stopped", null, ASMODEUS);
  });
});

/**
 * The exchange trace's `narrator.stream` stage + `finish()` (#637). A fake
 * recorder (not the real `startExchangeTrace`, which would hit the database
 * through `logEvent` on `flush()`) that just captures what `streamExchange`
 * calls it with — this is a unit test of the stage/verdict WIRING, not of the
 * recorder itself (covered by `chat-exchange-trace.test.ts`) or of a live
 * exchange (covered by the pipeline's own int test).
 */
function fakeExchangeTrace(): ExchangeTrace & {
  stageEnds: { stage: string; phase: string; result?: ExchangeStageResult }[];
  finishes: { kind: string; failureCode?: string }[];
  flushCount: number;
} {
  const stageEnds: { stage: string; phase: string; result?: ExchangeStageResult }[] = [];
  const finishes: { kind: string; failureCode?: string }[] = [];
  const self = {
    traceId: "trace_test",
    stageEnds,
    finishes,
    flushCount: 0,
    annotate: () => {},
    begin: (stage: string, phase: string) => ({
      end: (result?: ExchangeStageResult) => stageEnds.push({ stage, phase, result }),
    }),
    record: () => {},
    time: async <T>(_stage: string, _phase: string, fn: () => Promise<T>) => fn(),
    coverage: () => {},
    diagnostics: () => {},
    finish: (f: { kind: string; failureCode?: string }) => finishes.push(f),
    flush: () => {
      self.flushCount += 1;
    },
  };
  return self;
}

describe("the exchange trace's narrator.stream stage and finish() verdict", () => {
  it("records success + finish ok on a clean completion", async () => {
    const trace = fakeExchangeTrace();
    const settle = vi.fn(async () => {});
    async function* source() {
      yield "a clean reply";
    }
    const stream = streamExchange(source(), {
      chatId: "clean", abortController: new AbortController(), settle, release: vi.fn(),
      completion: () => null, modelId: "test-model", exchangeTrace: trace,
    });
    for await (const token of stream) void token;
    expect(trace.stageEnds).toHaveLength(1);
    expect(trace.stageEnds[0]?.stage).toBe("narrator.stream");
    expect(trace.stageEnds[0]?.result?.status).toBe("success");
    expect(trace.finishes).toEqual([{ kind: "ok" }]);
    expect(trace.flushCount).toBeGreaterThanOrEqual(1);
  });

  it("records narrator.stream failed + finish failed with the failure code on a zero-text provider error", async () => {
    const trace = fakeExchangeTrace();
    const settle = vi.fn(async () => {});
    async function* source(): AsyncGenerator<string> {
      throw new Error("provider down before any token");
    }
    const stream = streamExchange(source(), {
      chatId: "dead-on-arrival", abortController: new AbortController(), settle, release: vi.fn(),
      completion: () => null, modelId: "test-model", exchangeTrace: trace,
    });
    for await (const token of stream) void token;
    expect(settle).not.toHaveBeenCalled();
    expect(trace.stageEnds).toHaveLength(1);
    expect(trace.stageEnds[0]?.stage).toBe("narrator.stream");
    expect(trace.stageEnds[0]?.result?.status).toBe("failed");
    expect(trace.stageEnds[0]?.result?.reason).toBe("unknown");
    expect(trace.finishes).toEqual([{ kind: "failed", failureCode: "unknown" }]);
    expect(trace.flushCount).toBeGreaterThanOrEqual(1);
  });

  it("records narrator.stream success/player_stop + finish stopped on a player Stop with no text kept", async () => {
    // The stage-status vocabulary is closed and has no "stopped" — a genuine
    // Stop is a clean `success` with `reason: "player_stop"` at the STAGE
    // level; the exchange-level `finish({kind:"stopped"})` is where "stopped"
    // actually lives.
    const trace = fakeExchangeTrace();
    const controller = new AbortController();
    const settle = vi.fn(async () => {});
    async function* source(): AsyncGenerator<string> {
      controller.abort();
      await Promise.resolve();
      throw new Error("aborted");
    }
    const stream = streamExchange(source(), {
      chatId: "stopped-empty", abortController: controller, settle, release: vi.fn(),
      completion: () => null, modelId: "test-model", exchangeTrace: trace,
    });
    for await (const token of stream) void token;
    expect(settle).not.toHaveBeenCalled();
    expect(trace.stageEnds[0]?.result?.status).toBe("success");
    expect(trace.stageEnds[0]?.result?.reason).toBe("player_stop");
    expect(trace.finishes).toEqual([{ kind: "stopped" }]);
  });

  it("flushes even when the recorder is a no-op (no exchangeTrace supplied)", async () => {
    // The default-noop path (every pre-#637 call site): nothing above asserts
    // on it directly, but a throwing default would break every existing test
    // in this file — so this just pins that omitting it stays legal.
    const settle = vi.fn(async () => {});
    async function* source() {
      yield "fine";
    }
    const stream = streamExchange(source(), {
      chatId: "no-trace", abortController: new AbortController(), settle, release: vi.fn(),
      completion: () => null, modelId: "test-model",
    });
    for await (const token of stream) void token;
    expect(settle).toHaveBeenCalledWith("fine", false);
  });
});
