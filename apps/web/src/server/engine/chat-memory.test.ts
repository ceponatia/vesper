import { describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

// Degradation contract: a failed callback retrieval —
// db down, embedding failure — is an ordinary turn with a diagnostic, never a
// failed reply. The memory module is mocked to throw like a down database would.
vi.mock("../memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory")>();
  return { ...actual, latestEpisodeNumber: () => Promise.reject(new Error("db down")) };
});

import { retrieveChatCallback } from "./chat-memory";

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
