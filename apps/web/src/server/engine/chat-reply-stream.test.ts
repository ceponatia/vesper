import { beforeEach, describe, expect, it, vi } from "vitest";
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
