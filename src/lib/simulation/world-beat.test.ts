import { describe, expect, it } from "vitest";
import { chatMessageSchema } from "@/lib/client/api";
import type { SimCalendarStart } from "./clock";
import { worldBeatText, WORLD_BEAT_KINDS } from "./world-beat";

/**
 * World-beat phrasing + transcript-row round-trip (world-ui.plan.md slice 2). Pure
 * — the phrasing composes the destination phrase with the shared `formatSimLanding`
 * stamp, and the schema check proves the `meta.worldBeat` marker survives the
 * transcript envelope both ways (present, absent, and a junk kind).
 */

// 2024-01-05 is a Friday (Jan 1 2024 = Monday) — a stable anchored landing.
const ANCHOR: SimCalendarStart = { year: 2024, month: 1, day: 5 };
const EIGHT_AM = 8 * 3_600;
const NINE_AM = 9 * 3_600;

describe("worldBeatText", () => {
  it("phrases a traveled beat with the article'd place and the anchorless stamp", () => {
    expect(worldBeatText({ kind: "traveled", storySecond: EIGHT_AM, anchor: null, destinationLabel: "town square" })).toBe(
      "You walk to the town square. · Day 1 · 8:00am (morning)",
    );
  });

  it("phrases 'home' bare (no article) — matching the travel chip idiom", () => {
    expect(worldBeatText({ kind: "traveled", storySecond: EIGHT_AM, anchor: null, destinationLabel: "home" })).toBe(
      "You walk home. · Day 1 · 8:00am (morning)",
    );
  });

  it("falls back to 'somewhere nearby' when the destination label is missing", () => {
    expect(worldBeatText({ kind: "traveled", storySecond: EIGHT_AM, anchor: null })).toBe(
      "You walk to somewhere nearby. · Day 1 · 8:00am (morning)",
    );
  });

  it("phrases a time-skipped beat through the anchored landing", () => {
    expect(worldBeatText({ kind: "time_skipped", storySecond: NINE_AM, anchor: ANCHOR })).toBe(
      "Time passes — it's now Friday, January 5 — 9:00am (morning).",
    );
  });

  it("phrases a scene-ended beat with the anchorless stamp", () => {
    expect(worldBeatText({ kind: "scene_ended", storySecond: EIGHT_AM, anchor: null })).toBe(
      "The scene ends. · Day 1 · 8:00am (morning)",
    );
  });

  it("covers every declared beat kind (no empty output)", () => {
    for (const kind of WORLD_BEAT_KINDS) {
      expect(worldBeatText({ kind, storySecond: EIGHT_AM, anchor: null, destinationLabel: "home" }).length).toBeGreaterThan(0);
    }
  });
});

describe("chatMessageSchema world-beat round-trip", () => {
  it("carries the worldBeat marker through the transcript envelope", () => {
    const parsed = chatMessageSchema.parse({
      id: "msg-beat",
      role: "assistant",
      content: "You walk to the town square. · Day 1 · 8:00am (morning)",
      meta: { simTurn: true, worldBeat: { kind: "time_skipped" } },
    });
    expect(parsed.meta.worldBeat?.kind).toBe("time_skipped");
  });

  it("is absent (null/undefined) on an ordinary reply row", () => {
    const parsed = chatMessageSchema.parse({ id: "msg-1", role: "assistant", content: "Hello." });
    expect(parsed.meta.worldBeat ?? null).toBeNull();
  });

  it("catches an unknown kind to the degraded default rather than rejecting the row", () => {
    const parsed = chatMessageSchema.parse({
      id: "msg-junk",
      role: "assistant",
      content: "…",
      meta: { worldBeat: { kind: "not-a-real-kind" } },
    });
    expect(parsed.meta.worldBeat?.kind).toBe("traveled");
  });
});
