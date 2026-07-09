import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { DiagnosticCollector } from "../diagnostics";
import {
  chatSceneMemorySchema,
  currentScenePlace,
  emptyChatSceneMemory,
  isEmptyChatSceneMemory,
  mergeSceneMemory,
  samePlaceName,
  SCENE_MEMORY_MAX_DETAILS,
  SCENE_MEMORY_MAX_PLACES,
  switchScenePlace,
  type ChatSceneMemory,
} from "./chat-scene-memory";

describe("switchScenePlace", () => {
  it("sets current and mints a stub place on first mention", () => {
    const next = switchScenePlace(emptyChatSceneMemory(), "the kitchen");
    expect(next.current).toBe("the kitchen");
    expect(next.places).toHaveLength(1);
    expect(next.places[0]).toEqual({ name: "the kitchen", details: [], connections: [] });
  });

  it("reuses an existing place (case-insensitive) instead of duplicating it", () => {
    const base: ChatSceneMemory = {
      current: "kitchen",
      places: [
        { name: "kitchen", details: [], connections: [] },
        { name: "Living Room", details: ["blue sofa"], connections: [] },
      ],
    };
    const next = switchScenePlace(base, "living ROOM");
    expect(next.places).toHaveLength(2); // no duplicate minted
    expect(next.current).toBe("Living Room"); // canonical stored casing
    expect(next.places.find((p) => p.name === "Living Room")?.details).toEqual(["blue sofa"]);
  });

  it("is a no-op when already at that place, and ignores a blank name", () => {
    const base = switchScenePlace(emptyChatSceneMemory(), "kitchen");
    expect(switchScenePlace(base, "kitchen")).toBe(base);
    expect(switchScenePlace(base, "   ")).toBe(base);
  });
});

describe("mergeSceneMemory", () => {
  it("accretes details + connections, deduping case-insensitively", () => {
    const base: ChatSceneMemory = {
      current: "kitchen",
      places: [{ name: "kitchen", details: ["blue tiles"], connections: [] }],
    };
    const merged = mergeSceneMemory(base, {
      current: "kitchen",
      timeOfDay: "evening",
      places: [{ name: "kitchen", details: ["Blue Tiles", "kettle on the stove"], connections: ["hall to the door"] }],
    });
    const place = currentScenePlace(merged);
    expect(place?.details).toEqual(["blue tiles", "kettle on the stove"]); // dedup keeps the first casing
    expect(place?.connections).toEqual(["hall to the door"]);
    expect(merged.timeOfDay).toBe("evening");
  });

  it("mints a new place from the proposal and can move current to it", () => {
    const base: ChatSceneMemory = { current: "kitchen", places: [{ name: "kitchen", details: [], connections: [] }] };
    const merged = mergeSceneMemory(base, { current: "garden", places: [{ name: "garden", details: ["rose trellis"], connections: [] }] });
    expect(merged.current).toBe("garden");
    expect(merged.places.map((p) => p.name)).toEqual(["kitchen", "garden"]);
  });

  it("keeps the prior time-of-day when the proposal omits it (an empty proposal is a no-op)", () => {
    const base: ChatSceneMemory = { current: "kitchen", timeOfDay: "morning", places: [] };
    expect(mergeSceneMemory(base, { places: [] })).toEqual(base);
  });

  it("caps details per place, oldest-out", () => {
    const many = Array.from({ length: SCENE_MEMORY_MAX_DETAILS + 3 }, (_, i) => `detail ${i}`);
    const merged = mergeSceneMemory(emptyChatSceneMemory(), {
      current: "room",
      places: [{ name: "room", details: many, connections: [] }],
    });
    const place = currentScenePlace(merged);
    expect(place?.details).toHaveLength(SCENE_MEMORY_MAX_DETAILS);
    expect(place?.details.at(-1)).toBe(`detail ${SCENE_MEMORY_MAX_DETAILS + 2}`); // newest kept
    expect(place?.details).not.toContain("detail 0"); // oldest evicted
  });

  it("caps the place list, never evicting the current place", () => {
    let memory = emptyChatSceneMemory();
    for (let i = 0; i < SCENE_MEMORY_MAX_PLACES + 4; i++) {
      memory = mergeSceneMemory(memory, { current: `place ${i}`, places: [{ name: `place ${i}`, details: [], connections: [] }] });
    }
    expect(memory.places).toHaveLength(SCENE_MEMORY_MAX_PLACES);
    // The most-recent current survives the cap even though it was added last.
    expect(memory.current).toBe(`place ${SCENE_MEMORY_MAX_PLACES + 3}`);
    expect(memory.places.some((p) => samePlaceName(p.name, memory.current))).toBe(true);
    // The oldest places were evicted.
    expect(memory.places.some((p) => p.name === "place 0")).toBe(false);
  });
});

describe("chatSceneMemorySchema parse boundary", () => {
  it("salvages a partially-malformed row via field-level .catch (places → [])", () => {
    const sink = new DiagnosticCollector();
    const out = parseOr(chatSceneMemorySchema, { places: "not-an-array" }, emptyChatSceneMemory(), sink, "scene_memory");
    // Field-level .catch salvages the row rather than nuking it — places falls back to [].
    expect(out.places).toEqual([]);
    expect(isEmptyChatSceneMemory(out)).toBe(true);
  });

  it("degrades a wholly-unparseable blob to empty memory AND records a diagnostic (parseOr boundary)", () => {
    const sink = new DiagnosticCollector();
    const out = parseOr(chatSceneMemorySchema, 42, emptyChatSceneMemory(), sink, "character_chat_state.scene_memory");
    expect(out).toEqual(emptyChatSceneMemory()); // degraded default
    expect(sink.items.some((d) => d.code === "parse.boundary_failed")).toBe(true); // + diagnostic
  });

  it("round-trips a valid memory and re-applies the per-place caps", () => {
    const raw = {
      current: "kitchen",
      timeOfDay: "dusk",
      places: [{ name: "kitchen", details: ["a", "a", "b"], connections: ["door", "door"] }],
    };
    const out = parseOr(chatSceneMemorySchema, raw, emptyChatSceneMemory());
    expect(out.current).toBe("kitchen");
    expect(out.places[0]?.details).toEqual(["a", "b"]); // dedup on parse
    expect(out.places[0]?.connections).toEqual(["door"]);
  });

  it("emptyChatSceneMemory is recognized as empty", () => {
    expect(isEmptyChatSceneMemory(emptyChatSceneMemory())).toBe(true);
    expect(isEmptyChatSceneMemory({ current: "kitchen", places: [] })).toBe(false);
  });
});
