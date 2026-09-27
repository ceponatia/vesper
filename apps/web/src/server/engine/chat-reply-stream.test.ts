import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NarratorCompletion } from "@/server/ai";
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
