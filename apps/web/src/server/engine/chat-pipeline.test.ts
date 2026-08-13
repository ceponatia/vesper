import { describe, expect, it } from "vitest";
import { CHAT_REPLY_TAKES_CAP } from "./constants";
import {
  emptyReplyTakes,
  pushReplyTake,
  replyTakesSchema,
  resolveReplyFailure,
  withStreamTimeouts,
  type ReplyTakes,
} from "./chat-pipeline";

// pushReplyTake (character-chat-standalone.spec.md §4.1) — the PURE takes-list
// core behind "another take": lazy seeding of the pre-regenerate reply, newest
// take active, and the CHAT_REPLY_TAKES_CAP eviction that never drops the
// active take. No DB — the persistence path is covered by chat.int.test.ts.

const NOW = "2026-07-02T12:00:00.000Z";

describe("pushReplyTake", () => {
  it("seeds the row's current content as the first browsable take on the first regenerate", () => {
    const next = pushReplyTake(emptyReplyTakes(), "the original reply", "the second take", NOW);
    expect(next.takes).toHaveLength(2);
    expect(next.takes[0]?.content).toBe("the original reply");
    expect(next.takes[1]?.content).toBe("the second take");
    expect(next.takes.map((t) => t.createdAt)).toEqual([NOW, NOW]);
  });

  it("marks the fresh take active", () => {
    const next = pushReplyTake(emptyReplyTakes(), "old", "new", NOW);
    expect(next.activeId).toBe(next.takes.at(-1)?.id);
    expect(next.takes.find((t) => t.id === next.activeId)?.content).toBe("new");
  });

  it("does not re-seed once takes exist — later regenerates append exactly one", () => {
    const first = pushReplyTake(emptyReplyTakes(), "take 1", "take 2", NOW);
    const second = pushReplyTake(first, "take 2", "take 3", NOW);
    expect(second.takes).toHaveLength(3);
    expect(second.takes.map((t) => t.content)).toEqual(["take 1", "take 2", "take 3"]);
    // The earlier takes keep their identities (they stay browsable).
    expect(second.takes.slice(0, 2).map((t) => t.id)).toEqual(first.takes.map((t) => t.id));
  });

  it("mints unique ids per take", () => {
    const first = pushReplyTake(emptyReplyTakes(), "a", "b", NOW);
    const second = pushReplyTake(first, "b", "c", NOW);
    const ids = second.takes.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("caps the list at CHAT_REPLY_TAKES_CAP, evicting the oldest entries first", () => {
    let takes: ReplyTakes = emptyReplyTakes();
    const contents: string[] = [];
    // Push well past the cap: seed + N fresh takes.
    for (let i = 1; i <= CHAT_REPLY_TAKES_CAP + 3; i++) {
      const current = contents.at(-1) ?? "seed";
      const fresh = `take ${i}`;
      takes = pushReplyTake(takes, current, fresh, NOW);
      contents.push(fresh);
      expect(takes.takes.length).toBeLessThanOrEqual(CHAT_REPLY_TAKES_CAP);
    }
    expect(takes.takes).toHaveLength(CHAT_REPLY_TAKES_CAP);
    // Only the newest CAP takes survive, in order.
    expect(takes.takes.map((t) => t.content)).toEqual(
      contents.slice(-CHAT_REPLY_TAKES_CAP).map((c) => c),
    );
  });

  it("never evicts the newest (active) take, even while trimming an over-cap list", () => {
    // An over-cap prior (e.g. a legacy row written before the cap tightened).
    const prior: ReplyTakes = {
      takes: Array.from({ length: CHAT_REPLY_TAKES_CAP + 2 }, (_, i) => ({
        id: `old-${i}`,
        content: `old ${i}`,
        createdAt: NOW,
      })),
      activeId: `old-${CHAT_REPLY_TAKES_CAP + 1}`,
    };
    const next = pushReplyTake(prior, "current", "fresh content", NOW);
    expect(next.takes).toHaveLength(CHAT_REPLY_TAKES_CAP);
    const active = next.takes.find((t) => t.id === next.activeId);
    expect(active?.content).toBe("fresh content");
    // Everything evicted came from the oldest end.
    expect(next.takes.map((t) => t.content)).toEqual([
      ...Array.from({ length: CHAT_REPLY_TAKES_CAP - 1 }, (_, i) => `old ${i + 3}`),
      "fresh content",
    ]);
  });
});

describe("replyTakesSchema", () => {
  it("parses the legacy empty-object column default into an empty takes list", () => {
    const parsed = replyTakesSchema.parse({});
    expect(parsed).toEqual({ takes: [], activeId: "" });
  });
});

// withStreamTimeouts (data-loss-rerun fix) — the PURE reply-stream watchdog: pass tokens
// through, but a wedged provider trips a first-token timeout or an overall cap, which
// aborts the upstream call so the exchange lock can never be held indefinitely.
describe("withStreamTimeouts", () => {
  /** Yields each token after `delayMs`; the wedged/slow provider stand-in. */
  async function* delayedSource(tokens: string[], delayMs: number): AsyncGenerator<string> {
    for (const token of tokens) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield token;
    }
  }
  /** Never yields; rejects on abort so the guarded stream's abort cleanly unwinds it. */
  async function* hangUntilAbort(signal: AbortSignal): AsyncGenerator<string> {
    await new Promise<void>((_, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  it("passes every token through untouched when the source keeps pace", async () => {
    const controller = new AbortController();
    let aborted = false;
    const guarded = withStreamTimeouts(delayedSource(["a", "b", "c"], 2), {
      firstTokenMs: 500,
      overallMs: 2000,
      onAbort: () => {
        aborted = true;
        controller.abort();
      },
    });
    const out: string[] = [];
    for await (const token of guarded) out.push(token);
    expect(out).toEqual(["a", "b", "c"]);
    expect(aborted).toBe(false); // finished on its own — no watchdog trip
  });

  it("trips the first-token watchdog when no token arrives in time, aborting the upstream call", async () => {
    const controller = new AbortController();
    const reasons: string[] = [];
    let aborted = false;
    const guarded = withStreamTimeouts(hangUntilAbort(controller.signal), {
      firstTokenMs: 20,
      overallMs: 1000,
      onAbort: () => {
        aborted = true;
        controller.abort(); // wired to the source's signal, exactly like the pipeline
      },
      onTimeout: (reason) => reasons.push(reason),
    });
    const out: string[] = [];
    for await (const token of guarded) out.push(token);
    expect(out).toEqual([]); // nothing streamed
    expect(aborted).toBe(true);
    expect(reasons).toEqual(["first_token"]);
  });

  it("trips the overall cap once tokens flow but never finish", async () => {
    const controller = new AbortController();
    const reasons: string[] = [];
    // A token every 10ms, effectively forever; the first arrives well within firstTokenMs,
    // but the whole stream is capped at 35ms.
    const guarded = withStreamTimeouts(delayedSource(Array<string>(100).fill("x"), 10), {
      firstTokenMs: 1000,
      overallMs: 35,
      onAbort: () => controller.abort(),
      onTimeout: (reason) => reasons.push(reason),
    });
    const out: string[] = [];
    for await (const token of guarded) out.push(token);
    expect(out.length).toBeGreaterThanOrEqual(1); // some tokens landed before the cap
    expect(out.length).toBeLessThan(100); // …but it was cut short
    expect(reasons).toEqual(["overall"]);
  });
});

// resolveReplyFailure (reply-failure surfacing) — the PURE verdict behind the
// client's "didn't reply" popup: only a zero-text exchange records a failure,
// the watchdog outranks the stop flag it shares an AbortController with, and a
// clean empty stream is its own class. The persistence half (saveReplyFailure)
// rides the exchange path covered by chat.int.test.ts.

describe("resolveReplyFailure", () => {
  const none = { hasText: false, stopped: false, streamError: null, timedOut: null } as const;

  it("clears the record whenever the exchange produced text — even a stopped or errored partial", () => {
    expect(resolveReplyFailure({ ...none, hasText: true })).toBeNull();
    expect(resolveReplyFailure({ ...none, hasText: true, stopped: true })).toBeNull();
    expect(
      resolveReplyFailure({ ...none, hasText: true, streamError: { code: "provider_error", detail: "boom" } }),
    ).toBeNull();
  });

  it("keeps the classified stream error verbatim", () => {
    expect(resolveReplyFailure({ ...none, streamError: { code: "no_credits", detail: "Payment required" } })).toEqual({
      code: "no_credits",
      detail: "Payment required",
    });
  });

  it("records a watchdog trip as timeout even though the abort also raised the stop flag", () => {
    const result = resolveReplyFailure({ ...none, stopped: true, timedOut: "first_token" });
    expect(result?.code).toBe("timeout");
    expect(result?.detail).toContain("no output within");
  });

  it("treats a genuine player Stop before the first token as no failure", () => {
    expect(resolveReplyFailure({ ...none, stopped: true })).toBeNull();
  });

  it("classifies a clean zero-token stream as empty_reply", () => {
    expect(resolveReplyFailure(none)).toEqual({ code: "empty_reply", detail: "" });
  });
});
