import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { CHAT_VISION_FALLBACK, describeChatPhotos } from "./chat-vision";

// AI_FAKE=1 (src/test/setup.ts) ⇒ demo mode: the vision read must degrade to the
// in-fiction fallback + `chat_vision.describe_failed` — never an invented reading
// of an image nobody looked at, never a throw, never a failed exchange.
describe("describeChatPhotos degradation", () => {
  it("demo mode degrades every photo to the fallback line with the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const out = await describeChatPhotos({
      files: [
        { id: "a", path: "images/u/a.webp" },
        { id: "b", path: "images/u/b.webp" },
      ],
      sink,
    });
    expect(out.degraded).toBe(true);
    expect(out.descriptions).toEqual([CHAT_VISION_FALLBACK, CHAT_VISION_FALLBACK]);
    expect(sink.items.some((d) => d.code === "chat_vision.describe_failed")).toBe(true);
  });

  it("no files ⇒ empty and not degraded (an ordinary text turn)", async () => {
    const out = await describeChatPhotos({ files: [] });
    expect(out).toEqual({ descriptions: [], degraded: false });
  });
});
