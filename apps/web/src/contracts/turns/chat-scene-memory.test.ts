import { describe, expect, it } from "vitest";
import { parseOr } from "@/lib/parse";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import {
  chatSceneMemorySchema,
  chatSceneSketchSchema,
  currentScenePlace,
  degradedChatSceneSketch,
  emptyChatSceneMemory,
  isEmptyChatSceneMemory,
  mergeSceneMemory,
  samePlaceName,
  SCENE_MEMORY_MAX_DETAILS,
  SCENE_MEMORY_MAX_PLACES,
  SCENE_SKETCH_MAX_CHARS,
  switchScenePlace,
  withPlaceImage,
  withPlaceSketch,
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
      places: [{ name: "kitchen", details: ["Blue Tiles", "kettle on the stove"], connections: ["hall to the door"] }],
    });
    const place = currentScenePlace(merged);
    expect(place?.details).toEqual(["blue tiles", "kettle on the stove"]); // dedup keeps the first casing
    expect(place?.connections).toEqual(["hall to the door"]);
  });

  it("mints a new place from the proposal and can move current to it", () => {
    const base: ChatSceneMemory = { current: "kitchen", places: [{ name: "kitchen", details: [], connections: [] }] };
    const merged = mergeSceneMemory(base, { current: "garden", places: [{ name: "garden", details: ["rose trellis"], connections: [] }] });
    expect(merged.current).toBe("garden");
    expect(merged.places.map((p) => p.name)).toEqual(["kitchen", "garden"]);
  });

  it("is a no-op on an empty proposal", () => {
    const base: ChatSceneMemory = { current: "kitchen", places: [] };
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
    expectCleanSink(sink); // the schema absorbed it — this never reached the boundary
  });

  it("degrades a wholly-unparseable blob to empty memory AND records a diagnostic (parseOr boundary)", () => {
    const sink = new DiagnosticCollector();
    const out = parseOr(chatSceneMemorySchema, 42, emptyChatSceneMemory(), sink, "character_chat_state.scene_memory");
    expect(out).toEqual(emptyChatSceneMemory()); // degraded default
    expectDiagnostic(sink, "parse.boundary_failed"); // + diagnostic
  });

  it("round-trips a valid memory and re-applies the per-place caps", () => {
    const raw = {
      current: "kitchen",
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

describe("withPlaceSketch", () => {
  const base: ChatSceneMemory = {
    current: "kitchen",
    places: [{ name: "kitchen", details: ["blue tiles"], connections: [] }],
  };

  it("writes a sketch onto its place (case-insensitive) and preserves it through mergeSceneMemory", () => {
    const sketched = withPlaceSketch(base, "Kitchen", "A narrow galley kitchen under a skylight.");
    expect(currentScenePlace(sketched)?.sketch).toBe("A narrow galley kitchen under a skylight.");
    // The archivist merge copies places field-by-field — the agent-written sketch must survive it.
    const merged = mergeSceneMemory(sketched, {
      places: [{ name: "kitchen", details: ["kettle on the stove"], connections: [] }],
    });
    expect(currentScenePlace(merged)?.sketch).toBe("A narrow galley kitchen under a skylight.");
    expect(currentScenePlace(merged)?.details).toContain("kettle on the stove");
  });

  it("first write wins; unknown places and blank sketches are identity no-ops (cheap CAS compare)", () => {
    const sketched = withPlaceSketch(base, "kitchen", "First.");
    expect(withPlaceSketch(sketched, "kitchen", "Second.")).toBe(sketched);
    expect(withPlaceSketch(base, "attic", "Anything.")).toBe(base);
    expect(withPlaceSketch(base, "kitchen", "   ")).toBe(base);
  });

  it("round-trips through the schema; an invalid sketch parses away instead of failing the row", () => {
    const sketched = withPlaceSketch(base, "kitchen", "A narrow galley kitchen.");
    const parsed = chatSceneMemorySchema.parse(JSON.parse(JSON.stringify(sketched)));
    expect(currentScenePlace(parsed)?.sketch).toBe("A narrow galley kitchen.");
    const bad = chatSceneMemorySchema.parse({ current: "kitchen", places: [{ name: "kitchen", sketch: 42 }] });
    expect(currentScenePlace(bad)).not.toBeNull();
    expect(currentScenePlace(bad)?.sketch).toBeUndefined();
  });
});

describe("chatSceneSketchSchema (the sketch agent's output boundary)", () => {
  it("trims and caps the sketch; a bad/empty result degrades to the no-write default", () => {
    expect(chatSceneSketchSchema.parse({ sketch: "  A room. " }).sketch).toBe("A room.");
    expect(chatSceneSketchSchema.parse({ sketch: "x".repeat(SCENE_SKETCH_MAX_CHARS + 50) }).sketch).toHaveLength(
      SCENE_SKETCH_MAX_CHARS,
    );
    expect(chatSceneSketchSchema.parse({}).sketch).toBe("");
    expect(chatSceneSketchSchema.parse({ sketch: 42 }).sketch).toBe("");
    expect(degradedChatSceneSketch()).toEqual({ sketch: "" });
  });
});

describe("withPlaceImage", () => {
  it("attaches an image to the named place once, by identity semantics", () => {
    const memory = { current: "kitchen", places: [{ name: "Kitchen", details: [], connections: [] }] };
    const parsed = chatSceneMemorySchema.parse(memory);
    const withImage = withPlaceImage(parsed, "kitchen", "img-1");
    expect(withImage.places[0]?.imageId).toBe("img-1");
    // Already imaged / unknown place / blank id ⇒ the SAME reference (the CAS bails).
    expect(withPlaceImage(withImage, "kitchen", "img-2")).toBe(withImage);
    expect(withPlaceImage(parsed, "attic", "img-1")).toBe(parsed);
    expect(withPlaceImage(parsed, "kitchen", "  ")).toBe(parsed);
  });

  it("the merge carries imageId through like the sketch", () => {
    const before = chatSceneMemorySchema.parse({
      current: "kitchen",
      places: [{ name: "kitchen", details: ["tiles"], connections: [], sketch: "warm tiles", imageId: "img-1" }],
    });
    const merged = mergeSceneMemory(before, { places: [{ name: "kitchen", details: ["copper pans"], connections: [] }] });
    expect(merged.places[0]?.imageId).toBe("img-1");
    expect(merged.places[0]?.sketch).toBe("warm tiles");
    expect(merged.places[0]?.details).toContain("copper pans");
  });
});
