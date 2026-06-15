import { describe, expect, it } from "vitest";
import {
  applyChunk,
  jobStatusSchema,
  mergeFeedTail,
  parseFeedPage,
  parseSessionStatus,
  prependOlder,
  type FeedMessage,
  type StreamSegment,
} from "./use-session";

function msg(over: Partial<FeedMessage> & { id: string }): FeedMessage {
  return {
    turnId: "t1",
    turnNumber: 1,
    seq: 0,
    role: "narrator",
    speaker: null,
    content: "…",
    createdAt: null,
    ...over,
  };
}

describe("parseFeedPage", () => {
  it("parses a keyed payload with explicit cursor and hasMore", () => {
    const page = parseFeedPage({
      messages: [
        { id: "m1", turnId: "t1", turnNumber: 1, seq: 0, role: "player", speaker: null, content: "hi" },
        { id: "m2", turnId: "t1", turnNumber: 1, seq: 1, role: "narrator", speaker: null, content: "prose" },
      ],
      hasMore: true,
      nextBefore: "m0",
    });
    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe("m0");
  });

  it("reads the messageId alias from the /feed route shape", () => {
    const page = parseFeedPage({
      messages: [{ messageId: "m1", turnId: "t1", turnNumber: 1, seq: 0, role: "player", speaker: null, content: "hi" }],
    });
    expect(page.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("accepts a bare array, deriving the cursor from the oldest row", () => {
    const page = parseFeedPage([
      { id: "a", turnId: "t1", turnNumber: 1, seq: 0, role: "narrator", content: "x" },
      { id: "b", turnId: "t2", turnNumber: 2, seq: 0, role: "narrator", content: "y" },
    ]);
    expect(page.nextBefore).toBe("a");
    expect(page.hasMore).toBe(false); // fewer than the page size
  });

  it("normalizes newest-first pages to chronological order", () => {
    const page = parseFeedPage([
      { id: "b", turnId: "t2", turnNumber: 5, seq: 0, role: "narrator", content: "later" },
      { id: "a", turnId: "t1", turnNumber: 1, seq: 0, role: "narrator", content: "earlier" },
    ]);
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("drops malformed rows instead of failing the page", () => {
    const page = parseFeedPage({
      messages: [
        { id: "ok", turnId: "t", turnNumber: 1, seq: 0, role: "system", content: "divider" },
        { content: "no id" },
        null,
        42,
      ],
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.role).toBe("system");
  });

  it("degrades garbage to an empty page", () => {
    expect(parseFeedPage(null)).toEqual({ messages: [], hasMore: false, nextBefore: null });
    expect(parseFeedPage("nope").messages).toEqual([]);
  });

  it("infers hasMore from a full page when the flag is absent", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({
      id: `m${i}`,
      turnId: "t",
      turnNumber: 1,
      seq: i,
      role: "narrator",
      content: "x",
    }));
    expect(parseFeedPage(rows).hasMore).toBe(true);
  });
});

describe("mergeFeedTail", () => {
  it("appends unseen tail rows without reordering loaded history", () => {
    const existing = [msg({ id: "a" }), msg({ id: "b" })];
    const tail = [msg({ id: "b" }), msg({ id: "c" }), msg({ id: "d" })];
    expect(mergeFeedTail(existing, tail).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("picks up edited content for rows already loaded", () => {
    const existing = [msg({ id: "a", content: "old" })];
    const merged = mergeFeedTail(existing, [msg({ id: "a", content: "edited" })]);
    expect(merged[0]?.content).toBe("edited");
  });

  it("returns the same reference when nothing changed", () => {
    const a = msg({ id: "a" });
    const existing = [a];
    expect(mergeFeedTail(existing, [a])).toBe(existing);
  });
});

describe("prependOlder", () => {
  it("prepends only rows not already loaded", () => {
    const existing = [msg({ id: "c" }), msg({ id: "d" })];
    const older = [msg({ id: "a" }), msg({ id: "b" }), msg({ id: "c" })];
    expect(prependOlder(existing, older).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the same reference for an empty/duplicate page", () => {
    const existing = [msg({ id: "a" })];
    expect(prependOlder(existing, [msg({ id: "a" })])).toBe(existing);
  });
});

describe("applyChunk", () => {
  it("appends deltas to the segment with the same index", () => {
    let segments: StreamSegment[] = [];
    segments = applyChunk(segments, { segmentIndex: 0, speaker: null, content: "The " });
    segments = applyChunk(segments, { segmentIndex: 0, speaker: null, content: "road." });
    expect(segments).toEqual([{ segmentIndex: 0, speaker: null, content: "The road." }]);
  });

  it("opens a new segment per index and keeps index order", () => {
    let segments: StreamSegment[] = [];
    segments = applyChunk(segments, { segmentIndex: 1, speaker: "Maya", content: "Hi." });
    segments = applyChunk(segments, { segmentIndex: 0, speaker: null, content: "She waves." });
    expect(segments.map((s) => s.segmentIndex)).toEqual([0, 1]);
    expect(segments[1]).toEqual({ segmentIndex: 1, speaker: "Maya", content: "Hi." });
  });
});

describe("parseSessionStatus", () => {
  it("parses a full payload with state-nested participant fields", () => {
    const status = parseSessionStatus({
      session: {
        title: "Night market",
        status: "ready",
        clockMinutes: 90,
        worldId: "w1",
        narrativeModel: "aion-labs/aion-2.0",
      },
      calendarStart: { year: 2024, month: 6, day: 1, hour: 8, minute: 0 },
      location: { id: "loc1", name: "Market", description: "Lanterns." },
      participants: [
        {
          id: "p1",
          displayName: "Maya",
          role: "companion",
          isUser: false,
          avatarImageId: "img1",
          locationId: "loc1",
          state: {
            activity: "browsing stalls",
            meters: { energy: 0.7, stress: 0.2 },
            conditions: [
              { id: "c1", label: "rain-soaked", severity: "minor" },
              { id: "c2", label: "tipsy", remainingMinutes: 40 },
            ],
          },
          wardrobe: [{ instanceId: "w-dress", name: "linen dress", visibility: "visible" }, "scarf"],
          wornFull: [
            { instanceId: "w-dress", name: "linen dress", visibility: "visible" },
            { id: "w-scarf", name: "scarf", visibility: "visible" },
            { name: "slip", visibility: "hidden" },
          ],
          held: [{ id: "i9", name: "paper fan", kind: "object" }, "coin purse"],
        },
      ],
      items: [
        { id: "i1", name: "satchel", kind: "container", locationId: "loc1" },
        { id: "i2", name: "coin purse", kind: "object", containerId: "i1" },
      ],
      threads: [{ id: "th1", title: "The missing letter", summary: "", status: "open" }],
      scene: { currentImageId: "scn2", gallery: ["scn1", "scn2"], gen: { interval: 4, status: "idle" } },
    });
    expect(status).not.toBeNull();
    expect(status?.title).toBe("Night market");
    expect(status?.worldId).toBe("w1");
    expect(status?.narrativeModel).toBe("aion-labs/aion-2.0");
    expect(status?.clockMinutes).toBe(90);
    expect(status?.calendarStart?.year).toBe(2024);
    expect(status?.location?.name).toBe("Market");
    const maya = status?.participants[0];
    expect(maya?.activity).toBe("browsing stalls");
    expect(maya?.meters.energy).toBe(0.7);
    expect(maya?.conditions[0]?.label).toBe("rain-soaked");
    expect(maya?.conditions[0]?.remainingMinutes).toBeNull(); // open-ended
    expect(maya?.conditions[1]?.remainingMinutes).toBe(40);
    expect(maya?.wardrobe).toEqual([
      { instanceId: "w-dress", name: "linen dress", visibility: "visible" },
      { name: "scarf", visibility: "visible" },
    ]);
    expect(maya?.wornFull).toEqual([
      { instanceId: "w-dress", name: "linen dress", visibility: "visible" },
      { instanceId: "w-scarf", name: "scarf", visibility: "visible" },
      { name: "slip", visibility: "hidden" },
    ]);
    expect(maya?.held).toEqual([
      { id: "i9", name: "paper fan", kind: "object" },
      { id: "", name: "coin purse", kind: "object" },
    ]);
    expect(status?.items[1]?.containerInstanceId).toBe("i1");
    expect(status?.scene.currentImageId).toBe("scn2");
    expect(status?.scene.gen.interval).toBe(4);
  });

  it("tolerates a minimal payload — everything degrades to renderable defaults", () => {
    const status = parseSessionStatus({});
    expect(status).toEqual({
      title: null,
      state: "ready",
      worldId: null,
      narrativeModel: null,
      agentModel: null,
      clockMinutes: 0,
      clockDelta: null,
      calendarStart: null,
      location: null,
      participants: [],
      items: [],
      threads: [],
      scene: { currentImageId: null, gallery: [], gen: { interval: 0, status: "idle" } },
    });
  });

  it("reads the latest turn's clock delta and drops absent/garbage ones", () => {
    const withDelta = parseSessionStatus({ clock: { minutes: 60, delta: { minutes: 20, cause: "shower" } } });
    expect(withDelta?.clockMinutes).toBe(60);
    expect(withDelta?.clockDelta).toEqual({ minutes: 20, cause: "shower" });
    // Old turns carry no delta; zero/garbage minutes never render.
    expect(parseSessionStatus({ clock: { minutes: 60 } })?.clockDelta).toBeNull();
    expect(parseSessionStatus({ clock: { minutes: 60, delta: { minutes: 0, cause: "scene" } } })?.clockDelta).toBeNull();
    expect(parseSessionStatus({ clock: { minutes: 60, delta: { cause: "travel" } } })?.clockDelta).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(parseSessionStatus(null)).toBeNull();
    expect(parseSessionStatus("x")).toBeNull();
  });

  it("reads the /status route shape: latestImageId and gallery nested in sceneGen", () => {
    const status = parseSessionStatus({
      session: { title: "T", status: "ready" },
      sceneGen: {
        interval: 4,
        status: "generating",
        latestImageId: "scn2",
        gallery: [
          { id: "scn1", createdAt: "2026-01-01T00:00:00Z", status: "ready" },
          { id: "scn2", createdAt: "2026-01-02T00:00:00Z", status: "ready" },
        ],
      },
    });
    expect(status?.scene.currentImageId).toBe("scn2");
    expect(status?.scene.gallery.map((g) => g.id)).toEqual(["scn1", "scn2"]);
    expect(status?.scene.gen).toEqual({ interval: 4, status: "generating" });
  });

  it("reads aliases: top-level clock minutes, runtime threads, scene as sceneGen state", () => {
    const status = parseSessionStatus({
      status: "processing",
      clock: { minutes: 245, calendarStart: { year: 2030, month: 1, day: 2 } },
      runtime: { storyThreads: [{ id: "t", title: "A debt", status: "cooling" }] },
      scene: { interval: 2, status: "generating" },
      cast: [{ id: "p9", name: "Rook", role: "npc" }],
    });
    expect(status?.state).toBe("processing");
    expect(status?.clockMinutes).toBe(245);
    expect(status?.calendarStart?.year).toBe(2030);
    expect(status?.threads[0]?.status).toBe("cooling");
    expect(status?.scene.gen).toEqual({ interval: 2, status: "generating" });
    expect(status?.participants[0]?.displayName).toBe("Rook");
  });

  it("falls back to the latest gallery image when no current image id is given", () => {
    const status = parseSessionStatus({ scene: { gallery: ["a", "b"] } });
    expect(status?.scene.currentImageId).toBe("b");
  });

  it("parses old payloads without wornFull/held/remainingMinutes unchanged", () => {
    // The pre-expanded-card payload shape (followups.phase2.md #4): the new
    // fields default to absent-but-renderable, nothing else shifts.
    const status = parseSessionStatus({
      participants: [
        {
          id: "p1",
          displayName: "Maya",
          role: "companion",
          state: { activity: "reading", conditions: [{ id: "c1", label: "soaked", severity: "minor" }] },
          wardrobe: [{ name: "linen dress", visibility: "visible" }],
        },
      ],
    });
    const maya = status?.participants[0];
    expect(maya?.wardrobe).toEqual([{ name: "linen dress", visibility: "visible" }]);
    expect(maya?.wornFull).toEqual([]);
    expect(maya?.held).toEqual([]);
    expect(maya?.conditions[0]).toEqual({ id: "c1", label: "soaked", severity: "minor", remainingMinutes: null });
  });

  it("drops malformed participants and items without failing the payload", () => {
    const status = parseSessionStatus({
      participants: [{ id: "ok", displayName: "Keeps" }, { displayName: "no id" }, 7],
      items: [{ name: "no id" }, { id: "i1", name: "lamp" }],
    });
    expect(status?.participants).toHaveLength(1);
    expect(status?.items).toHaveLength(1);
    expect(status?.items[0]?.kind).toBe("object");
  });
});

describe("jobStatusSchema", () => {
  it("parses the documented payload", () => {
    expect(jobStatusSchema.parse({ status: "processing", jobType: "post_turn" })).toEqual({
      status: "processing",
      jobType: "post_turn",
    });
  });

  it("degrades unknown states to ready and missing jobType to null", () => {
    expect(jobStatusSchema.parse({ status: "weird" })).toEqual({ status: "ready", jobType: null });
  });
});
