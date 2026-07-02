import { describe, expect, it } from "vitest";
import { CHAT_REPLY_TAKES_CAP } from "./constants";
import { emptyReplyTakes, pushReplyTake, replyTakesSchema, type ReplyTakes } from "./chat-pipeline";

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
